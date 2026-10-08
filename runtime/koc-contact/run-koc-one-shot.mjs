import {spawn} from '../shared/child-process.mjs';
import {stat} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {runSyncToBase} from '../koc-roster/sync-to-base.mjs';
import {DEFAULT_STATE_DIR} from '../koc-roster/checkpoint.mjs';
import * as canaryProduction from './run-canary-production.mjs';
import {runDailyAddContactsPending} from './run-daily-add-contact-production.mjs';
import {classifyKocError,notifyKocError} from './error-alert.mjs';
import {safeRuntimeReleaseReason,verifyKocRuntimeRelease} from './runtime-release.mjs';

const {runProductionCanary}=canaryProduction;
const SAFE_CODE=/^[A-Z][A-Z0-9_]{0,100}$/u;
const safeCode=value=>SAFE_CODE.test(value||'')?value:'KOC_ONE_SHOT_FAILED';
const AUTH_RECOVERY_REASONS=new Set(['AUTH_REQUIRED','AUTH_EXPIRED']);
const FAILED_SYNC_STATES=new Set(['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial']);
const SOURCE_BATCH_ID=/^\d{8}T\d{6}Z$/u;
const SHA256=/^[a-f0-9]{64}$/u;
export const AUTH_RECOVERY_WAIT_MS=5*60*1000;
const CAPTURE_RUNNER=fileURLToPath(new URL('../koc-roster/capture-source.mjs',import.meta.url));
const DEFAULT_ERROR_ALERT_STATE_PATH=path.join(DEFAULT_STATE_DIR,'koc-error-alert-state.json');
const ALERTABLE_BINDING_CODES=new Set(['BROWSER_BINDING_MISSING','PAGE_BINDING_MISSING','TARGET_PAGE_CLOSED',
  'TARGET_PAGE_AMBIGUOUS','BACKGROUND_TARGET_CLOSED','BACKGROUND_TARGET_VISIBLE','EXECUTION_CONTEXT_CHANGED']);

function summaryRecords(summary){
  if(!summary||typeof summary!=='object'||Array.isArray(summary))return [];
  const result=[],queue=[summary],seen=new Set();
  while(queue.length){
    const item=queue.shift();
    if(!item||typeof item!=='object'||Array.isArray(item)||seen.has(item))continue;
    seen.add(item);result.push(item);
    for(const key of ['original','extra','sync','contacts','source','summary','current','row','batches']){
      const nested=item[key];
      if(Array.isArray(nested))queue.push(...nested);
      else if(nested&&typeof nested==='object')queue.push(nested);
    }
  }
  return result;
}

/** Map only persisted, machine-verifiable one-shot summaries into alert evidence. */
export function buildKocErrorIncident({mode='',summary}={}){
  const sourceMode=['capture','list-integrated','daily-integrated'].includes(mode);
  const contactMode=['daily-contact','daily-integrated','original-contact'].includes(mode);
  for(const item of summaryRecords(summary)){
    const reason=typeof item.errorCode==='string'?item.errorCode:
      typeof item.reason==='string'?item.reason:'';
    const code=SAFE_CODE.test(reason)?reason:'UNKNOWN_ERROR';
    const outcome=String(item.outcome||item.state||'').toLowerCase();
    const sourceBatchId=SOURCE_BATCH_ID.test(item.sourceBatchId||'')?item.sourceBatchId:
      SOURCE_BATCH_ID.test(summary?.sourceBatchId||'')?summary.sourceBatchId:'';
    const checkpointPreserved=item.checkpointPreserved===true;
    const platform=sourceMode&&code==='KOC_SOURCE_LOGIN_REQUIRED'?'ChanMama':contactMode?'Buyin':'unknown';
    const unknownWrite=item.writeState==='uncertain'||item.writeOutcome==='unknown'||outcome==='uncertain';
    const authFailureVerified=checkpointPreserved&&(
      sourceMode&&code==='KOC_SOURCE_LOGIN_REQUIRED'||
      contactMode&&['AUTH_REQUIRED','AUTH_EXPIRED'].includes(code)&&
        (outcome==='auth_blocked'||item.state==='auth_blocked'));
    const browserBindingMissingVerified=checkpointPreserved&&contactMode&&
      (item.state==='environment_paused'||item.state==='error'||item.outcome==='error')&&
      ALERTABLE_BINDING_CODES.has(code);
    const cliConnectionTimeoutVerified=checkpointPreserved&&code==='CLI_CONNECTION_TIMEOUT'&&
      (item.cliConnectionTimeoutVerified===true||sourceMode||contactMode);
    const incident={platform,outcome,errorCode:code,reason:code,
      authFailureVerified,browserBindingMissingVerified,cliConnectionTimeoutVerified,
      transientFailureVerified:item.transientFailureVerified===true,
      attemptsExhausted:item.attemptsExhausted===true,
      writeState:unknownWrite?'uncertain':item.writeState,
      writeOutcome:unknownWrite?'unknown':item.writeOutcome,
      sourceBatchId,targetCount:Number.isInteger(item.targetCount)?item.targetCount:null,
      attemptId:typeof item.attemptId==='string'?item.attemptId:''};
    if(classifyKocError(incident).shouldAlert)return incident;
  }
  return null;
}

function errorEpisodeKey(mode,incident,classification){
  const scope=incident.sourceBatchId||`target-${incident.targetCount??'unknown'}`;
  const attempt=classification.category==='unknown_write'?incident.attemptId||'unknown-attempt':'';
  return ['koc',mode,incident.platform,scope,classification.category,classification.code,attempt].join(':');
}

function createOneShotErrorAlerter({mode,config={enabled:false,recipient:''},transport,
  statePath=DEFAULT_ERROR_ALERT_STATE_PATH,notify=notifyKocError}={}){
  const attemptedEpisodes=new Set();
  const onSummary=async summary=>{
    try{
      const incident=buildKocErrorIncident({mode,summary});
      if(!incident)return;
      const classification=classifyKocError(incident);
      if(!classification.shouldAlert||config?.enabled!==true)return;
      const incidentKey=errorEpisodeKey(mode,incident,classification);
      if(attemptedEpisodes.has(incidentKey))return;
      attemptedEpisodes.add(incidentKey);
      await notify({incident,incidentKey,statePath,config,transport});
    }catch{/* An alert failure must never alter business execution or trigger a retry. */}
  };
  return {onProgress:onSummary,finish:async result=>{await onSummary(result);return result;}};
}

export function oneShotHelpText(){
  return [
    'KOC one-shot entry',
    '',
    'Modes:',
    '  capture          Capture a source batch only (--target 1..500, default 500)',
    '  sync-daily        Add-only sync an existing source batch (--batch-id required)',
    '  list-integrated   Capture once and add-only sync that same batch; never starts contact work',
    '  daily-contact     Process daily receipts (--batch-id optional; omitted means all eligible receipts)',
    '  daily-integrated  Capture, add-only sync, then contact the same captured batch (--target 1..500)',
    '  original-contact  Supplement the qualified original list (--target-count 100|200|500, default 100)',
    '',
    'Contact options: --retry-errors, --resume-blocked, --prepare (daily-contact/original-contact only)',
    'Qualified source: original-contact requires --source-manifest <private-file> and --source-manifest-sha256 <64 lowercase hex>.',
    'Source resume: --resume-source-batch-id resumes the exact existing capture checkpoint (capture/list-integrated/daily-integrated only).',
    'Auth recovery: only original Chrome AUTH_REQUIRED/AUTH_EXPIRED results prompt; wait is capped at 5 minutes.',
    'Use --help to print this text without starting a business operation.',
  ].join('\n');
}

export function parseOneShotArgs(argv){
  if(argv.length===1&&argv[0]==='--help')return {help:true};
  const provided=new Set();
  const args={mode:'',batchId:'',resumeSourceBatchId:'',sourceManifestPath:'',sourceManifestSha256:'',
    targetCount:100,target:500,retryErrors:false,resumeBlocked:false,prepareOnly:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--mode'){provided.add(arg);args.mode=String(argv[++i]||'');}
    else if(arg==='--batch-id'){provided.add(arg);args.batchId=String(argv[++i]||'');}
    else if(arg==='--resume-source-batch-id'){provided.add(arg);args.resumeSourceBatchId=String(argv[++i]||'');}
    else if(arg==='--source-manifest'){provided.add(arg);args.sourceManifestPath=String(argv[++i]||'');}
    else if(arg==='--source-manifest-sha256'){provided.add(arg);args.sourceManifestSha256=String(argv[++i]||'');}
    else if(arg==='--target-count'){provided.add(arg);args.targetCount=Number(argv[++i]);}
    else if(arg==='--target'){provided.add(arg);args.target=Number(argv[++i]);}
    else if(arg==='--retry-errors'){provided.add(arg);args.retryErrors=true;}
    else if(arg==='--resume-blocked'){provided.add(arg);args.resumeBlocked=true;}
    else if(arg==='--prepare'){provided.add(arg);args.prepareOnly=true;}
    else throw new Error('KOC_ONE_SHOT_ARGUMENT_UNSUPPORTED');
  }
    if(!['capture','sync-daily','list-integrated','daily-contact','daily-integrated','original-contact'].includes(args.mode))
    throw new Error('KOC_ONE_SHOT_MODE_REQUIRED');
  if(args.batchId&&!/^[A-Za-z0-9_-]{8,64}$/.test(args.batchId))throw new Error('KOC_ONE_SHOT_BATCH_ID_INVALID');
  if(args.resumeSourceBatchId&&!SOURCE_BATCH_ID.test(args.resumeSourceBatchId))throw new Error('KOC_ONE_SHOT_SOURCE_BATCH_ID_INVALID');
  if(provided.has('--source-manifest')!==provided.has('--source-manifest-sha256'))
    throw new Error('KOC_ONE_SHOT_SOURCE_MANIFEST_PAIR_REQUIRED');
  if(provided.has('--source-manifest')&&(!args.sourceManifestPath.trim()||!SHA256.test(args.sourceManifestSha256)))
    throw new Error('KOC_ONE_SHOT_SOURCE_MANIFEST_INVALID');
  if(['sync-daily'].includes(args.mode)&&!args.batchId)throw new Error('KOC_ONE_SHOT_BATCH_ID_REQUIRED');
  if(![100,200,500].includes(args.targetCount))throw new Error('KOC_ONE_SHOT_TARGET_COUNT_INVALID');
  if(!Number.isInteger(args.target)||args.target<1||args.target>500)throw new Error('KOC_ONE_SHOT_SOURCE_TARGET_INVALID');
  const contactModes=new Set(['daily-contact','original-contact']);
  if(provided.has('--batch-id')&&!['sync-daily','daily-contact'].includes(args.mode)||
    provided.has('--target-count')&&args.mode!=='original-contact'||
    provided.has('--target')&&!['capture','list-integrated','daily-integrated'].includes(args.mode)||
    provided.has('--resume-source-batch-id')&&!['capture','list-integrated','daily-integrated'].includes(args.mode)||
    ['--source-manifest','--source-manifest-sha256'].some(flag=>provided.has(flag)&&args.mode!=='original-contact')||
    ['--retry-errors','--resume-blocked','--prepare'].some(flag=>provided.has(flag)&&!contactModes.has(args.mode)))
    throw new Error('KOC_ONE_SHOT_OPTION_MODE_MISMATCH');
  return args;
}

function parseLastJson(stdout){
  for(const line of String(stdout||'').trim().split(/\r?\n/u).reverse())try{return JSON.parse(line);}catch{}
  return null;
}

function captureSource({target=500,resumeBatchId=''}={}){
  return new Promise((resolve,reject)=>{
    const captureArgs=[CAPTURE_RUNNER,'--target',String(target)];
    if(resumeBatchId)captureArgs.push('--resume',resumeBatchId);
    const child=spawn(process.execPath,captureArgs,{
      cwd:fileURLToPath(new URL('..',import.meta.url)),
      env:{...process.env,DEBUG:'',PWDEBUG:''},stdio:['ignore','pipe','pipe']});
    let stdout='',tooMuch=false;
    child.stdout.on('data',chunk=>{if(stdout.length+chunk.length<2*1024*1024)stdout+=chunk;else tooMuch=true;});
    child.stderr.resume();
    child.on('error',()=>reject(new Error('KOC_ONE_SHOT_SOURCE_START_FAILED')));
    child.on('close',async code=>{
      const result=tooMuch?null:parseLastJson(stdout);
      if(code!==0||result?.passed!==true||!SOURCE_BATCH_ID.test(result?.summary?.batchId||'')){
        const error=new Error(safeCode(result?.reason||'KOC_ONE_SHOT_SOURCE_FAILED'));
        const failedBatchId=SOURCE_BATCH_ID.test(result?.batchId||'')?result.batchId:resumeBatchId;
        if(failedBatchId){
          error.sourceBatchId=failedBatchId;
          try{
            const checkpoint=await stat(path.join(DEFAULT_STATE_DIR,`${failedBatchId}.checkpoint.json`));
            error.checkpointPreserved=checkpoint.isFile()&&(process.platform==='win32'||(checkpoint.mode&0o077)===0);
          }catch{error.checkpointPreserved=false;}
        }
        return reject(error);
      }
      resolve({batchId:result.summary.batchId,source:result.summary});
    });
  });
}

export async function runKocOneShot(args,{capture=captureSource,sync=runSyncToBase,
  dailyContacts=runDailyAddContactsPending,originalContacts=runProductionCanary,
  productionDependencies={},
  waitForAuthentication=waitForUserAuthentication,authRecoveryWaitMs=AUTH_RECOVERY_WAIT_MS,
  errorAlertConfig={enabled:false,recipient:''},errorAlertTransport,
  errorAlertStatePath=DEFAULT_ERROR_ALERT_STATE_PATH,notifyError=notifyKocError}={}){
  const alerts=createOneShotErrorAlerter({mode:args.mode,config:errorAlertConfig,transport:errorAlertTransport,
    statePath:errorAlertStatePath,notify:notifyError});
  const finish=alerts.finish;
  switch(args.mode){
    case 'capture':{
      try{return await finish(await capture({target:args.target,resumeBatchId:args.resumeSourceBatchId}));}
      catch(error){return await finish(sourceCaptureFailureResult('capture',args.target,error,args.resumeSourceBatchId));}
    }
    case 'sync-daily':return await finish(await sync({batchId:args.batchId,dailyAddOnly:true}));
    case 'list-integrated':{
      let captured;
      try{captured=await capture({target:args.target,resumeBatchId:args.resumeSourceBatchId});}
      catch(error){return await finish(sourceCaptureFailureResult('list-integrated',args.target,error,args.resumeSourceBatchId));}
      let synchronized;
      try{
        synchronized=await sync({batchId:captured.batchId,dailyAddOnly:true});
      }catch(error){
        return await finish(syncFailureResult('list-integrated',captured,null,error));
      }
      if(!syncSucceeded(synchronized,captured.batchId))
        return await finish(syncFailureResult('list-integrated',captured,synchronized));
      return await finish({mode:'list-integrated',sourceBatchId:captured.batchId,source:captured.source,sync:synchronized});
    }
    case 'daily-contact':{
      const options={batchId:args.batchId,retryErrors:args.retryErrors,
        resumeBlocked:args.resumeBlocked,prepareOnly:args.prepareOnly,onProgress:alerts.onProgress};
      const result=await dailyContacts(options);
      return await finish(await recoverAuthOnce({mode:args.mode,result,reason:findAuthBlock(result)?.reason,
        sourceBatchId:findAuthBlock(result)?.sourceBatchId||args.batchId,
        targetCount:findAuthBlock(result)?.targetCount,
        checkpointPreserved:findAuthBlock(result)?.checkpointPreserved===true,
        waitForAuthentication,authRecoveryWaitMs,
        resume:sourceBatchId=>dailyContacts({...options,batchId:sourceBatchId,resumeBlocked:true,
          prepareOnly:false}),
        resumeCommand:sourceBatchId=>dailyContactResumeCommand(sourceBatchId)}));
    }
    case 'original-contact':{
      if(originalContacts===runProductionCanary&&canaryProduction.ONE_SHOT_RESULT_CONTRACT_VERSION!==1)
        throw new Error('KOC_ONE_SHOT_ORIGINAL_RUNNER_CONTRACT_MISSING');
      if(originalContacts===runProductionCanary&&(!args.sourceManifestPath||!SHA256.test(args.sourceManifestSha256)))
        throw new Error('KOC_ONE_SHOT_SOURCE_MANIFEST_REQUIRED');
      const options={targetCount:args.targetCount,sourceManifestPath:args.sourceManifestPath,
        sourceManifestSha256:args.sourceManifestSha256,retryErrors:args.retryErrors,
        resumeBlocked:args.resumeBlocked,prepareOnly:args.prepareOnly,onProgress:alerts.onProgress};
      const runOriginalContacts=originalContacts===runProductionCanary
        ?runOptions=>runProductionCanary({...runOptions,dependencies:productionDependencies})
        :originalContacts;
      const result=await runOriginalContacts(options);
      if(result===undefined&&args.prepareOnly)return finish({passed:true,mode:args.mode,prepared:true,
        targetCount:args.targetCount,checkpointCreated:true});
      return await finish(await recoverAuthOnce({mode:args.mode,result,reason:findAuthBlock(result)?.reason,
        sourceBatchId:findAuthBlock(result)?.sourceBatchId,
        targetCount:findAuthBlock(result)?.targetCount||args.targetCount,
        checkpointPreserved:findAuthBlock(result)?.checkpointPreserved===true,
        waitForAuthentication,authRecoveryWaitMs,
        resume:()=>runOriginalContacts({...options,resumeBlocked:true,prepareOnly:false}),
        resumeCommand:()=>originalContactResumeCommand(args.targetCount,args.sourceManifestPath,args.sourceManifestSha256)}));
    }
    case 'daily-integrated':{
      let captured;
      try{captured=await capture({target:args.target,resumeBatchId:args.resumeSourceBatchId});}
      catch(error){return await finish(sourceCaptureFailureResult('daily-integrated',args.target,error,args.resumeSourceBatchId));}
      let synchronized;
      try{
        synchronized=await sync({batchId:captured.batchId,dailyAddOnly:true});
      }catch(error){
        return await finish(syncFailureResult('daily-integrated',captured,null,error));
      }
      if(!syncSucceeded(synchronized,captured.batchId))
        return await finish(syncFailureResult('daily-integrated',captured,synchronized));
      const options={batchId:captured.batchId,retryErrors:args.retryErrors,
        resumeBlocked:args.resumeBlocked,prepareOnly:args.prepareOnly,onProgress:alerts.onProgress};
      const initialContacts=await dailyContacts(options);
      const block=findAuthBlock(initialContacts);
      const contacts=await recoverAuthOnce({mode:args.mode,result:initialContacts,reason:block?.reason,
        sourceBatchId:block?.sourceBatchId||captured.batchId,targetCount:block?.targetCount,
        checkpointPreserved:block?.checkpointPreserved===true,waitForAuthentication,authRecoveryWaitMs,
        resume:sourceBatchId=>dailyContacts({...options,batchId:sourceBatchId,resumeBlocked:true,
          prepareOnly:false}),
        resumeCommand:sourceBatchId=>dailyContactResumeCommand(sourceBatchId)});
      return await finish({mode:'daily-integrated',sourceBatchId:captured.batchId,source:captured.source,
        sync:synchronized,contacts});
    }
    default:throw new Error('KOC_ONE_SHOT_MODE_REQUIRED');
  }
}

function findAuthBlock(result){
  const candidates=[result,...(Array.isArray(result?.batches)?result.batches:[])];
  return candidates.find(item=>(item?.outcome==='auth_blocked'||item?.state==='auth_blocked')&&
    AUTH_RECOVERY_REASONS.has(item.reason)&&/^[A-Za-z0-9_-]{8,64}$/u.test(item.sourceBatchId||'')&&
    item.checkpointPreserved===true)||null;
}

function dailyContactResumeCommand(batchId){
  if(!batchId)return 'npm run koc:one-shot -- --mode daily-contact --batch-id <batch-id> --resume-blocked';
  return `npm run koc:one-shot -- --mode daily-contact --batch-id ${batchId} --resume-blocked`;
}

function dailySyncResumeCommand(batchId){
  return `npm run koc:one-shot -- --mode sync-daily --batch-id ${batchId}`;
}

function syncSucceeded(result,expectedBatchId){
  if(!result||typeof result!=='object'||Array.isArray(result)||result.passed!==true||
      result.mode!=='daily_add_only'||result.batchId!==expectedBatchId)return false;
  return !FAILED_SYNC_STATES.has(result.state)&&!FAILED_SYNC_STATES.has(result.outcome)&&
    !(result.errorsOrBlocked>0)&&!(result.readbackUncertain>0)&&!(result.pendingBatchCount>0)&&
    !(result.remainingUnprocessed>0);
}

function syncFailureResult(mode,captured,result,error){
  let syncSummary;
  if(error)syncSummary={passed:false,reason:safeCode(error?.message?.split(':')[0]||'KOC_ONE_SHOT_SYNC_FAILED')};
  else if(result&&typeof result==='object'&&!Array.isArray(result))syncSummary={...result,passed:false,
    reason:safeCode(result.reason||'KOC_ONE_SHOT_SYNC_NOT_CONFIRMED')};
  else syncSummary={passed:false,reason:'KOC_ONE_SHOT_SYNC_NOT_CONFIRMED'};
  return {passed:false,mode,sourceBatchId:captured.batchId,source:captured.source,sync:syncSummary,
    resumeCommand:dailySyncResumeCommand(captured.batchId)};
}

function sourceCaptureFailureResult(mode,target,error,fallbackBatchId=''){
  const batchId=SOURCE_BATCH_ID.test(error?.sourceBatchId||'')?error.sourceBatchId:
    SOURCE_BATCH_ID.test(fallbackBatchId)?fallbackBatchId:'';
  const checkpointPreserved=error?.checkpointPreserved===true;
  return {passed:false,mode,reason:safeCode(error?.message?.split(':')[0]||'KOC_ONE_SHOT_SOURCE_FAILED'),
    ...(batchId?{sourceBatchId:batchId}:{}),checkpointPreserved,
    ...(batchId&&checkpointPreserved?{resumeCommand:sourceResumeCommand(mode,target,batchId)}:{})};
}

function sourceResumeCommand(mode,target,batchId){
  return `npm run koc:one-shot -- --mode ${mode} --target ${target} --resume-source-batch-id ${batchId}`;
}

function shellQuote(value){
 const text=String(value);
 // Display only safe cross-platform double-quoted paths. Unusual shell expansion
 // characters require copying the path into configuration, never a generated command.
 if(/["`$%\r\n]/u.test(text))return '"REENTER_MANIFEST_PATH"';
 return `"${text}"`;
}

function originalContactResumeCommand(targetCount,sourceManifestPath,sourceManifestSha256){
  const sourceArgs=sourceManifestPath&&SHA256.test(sourceManifestSha256)
    ?` --source-manifest ${shellQuote(sourceManifestPath)} --source-manifest-sha256 ${sourceManifestSha256}`:'';
  return `npm run koc:one-shot -- --mode original-contact --target-count ${targetCount}`+
    `${sourceArgs} --resume-blocked`;
}

async function recoverAuthOnce({mode,result,reason,sourceBatchId,targetCount,checkpointPreserved,
  waitForAuthentication,authRecoveryWaitMs,resume,resumeCommand}){
  if(!AUTH_RECOVERY_REASONS.has(reason)||!checkpointPreserved)return result;
  const safeContext={mode,reason,sourceBatchId:sourceBatchId||null,targetCount:targetCount||null,
    checkpointPreserved:true,resumeCommand:resumeCommand(sourceBatchId)};
  const wait=await waitForAuthentication({mode,reason,sourceBatchId:sourceBatchId||null,
    timeoutMs:authRecoveryWaitMs});
  if(wait?.status!=='user_returned')return {
    passed:false,outcome:'auth_blocked',...safeContext,
    resumable:true,
    authRecovery:{status:wait?.status==='timeout'?'timed_out':wait?.status==='non_interactive'?'non_interactive':'not_resumed',
      waitTimeoutMs:authRecoveryWaitMs,resumable:true},
  };
  const resumed=await resume(sourceBatchId);
  const remainingBlock=findAuthBlock(resumed);
  if(!remainingBlock&&resumed&&typeof resumed==='object')return {...resumed,
    authRecovery:{status:'resume_attempted',previousReason:reason,sourceBatchId:sourceBatchId||null}};
  if(!remainingBlock)return resumed;
  return {passed:false,outcome:'auth_blocked',mode,reason:remainingBlock.reason,
    sourceBatchId:remainingBlock.sourceBatchId,targetCount:remainingBlock.targetCount||targetCount||null,
    checkpointPreserved:remainingBlock.checkpointPreserved===true,
    resumeCommand:resumeCommand(remainingBlock.sourceBatchId),
    authRecovery:{status:'still_blocked',resumable:remainingBlock.checkpointPreserved===true}};
}

async function waitForUserAuthentication({mode,reason,timeoutMs}){
  if(!process.stdin.isTTY||!process.stderr.isTTY)return {status:'non_interactive'};
  const input=createInterface({input:process.stdin,output:process.stderr,terminal:true});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    await input.question(`原 Chrome 返回 ${reason}。请在现有 Chrome 会话完成登录，完成后回到此终端按 Enter 继续 ${mode}；最多等待 ${Math.ceil(timeoutMs/1000)} 秒。`,
      {signal:controller.signal});
    return {status:'user_returned'};
  }catch(error){
    return {status:error?.name==='AbortError'?'timeout':'cancelled'};
  }finally{
    clearTimeout(timer);input.close();
  }
}

export function oneShotResultExitCode(result,{mode='',prepareOnly=false}={}){
  if(result===undefined||result===null)return 1;
  if(result?.passed===false||result?.sync?.passed===false||result?.contacts?.passed===false||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.outcome)||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.state)||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.contacts?.outcome)||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.contacts?.state)||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.sync?.state)||
    ['auth_blocked','risk_blocked','error','uncertain','environment_paused','partial'].includes(result?.sync?.outcome)||
    result?.state==='pass_finished'&&Boolean(result?.reason))return 1;
  if(prepareOnly)return 0;
  const summaries=[result,result?.original,result?.extra,result?.contacts,result?.contacts?.original,
    result?.contacts?.extra,...(Array.isArray(result?.batches)?result.batches:[]),
    ...(Array.isArray(result?.contacts?.batches)?result.contacts.batches:[])].filter(Boolean);
  if(summaries.some(item=>(item.errorsOrBlocked||0)>0||(item.readbackUncertain||0)>0||
    (item.pendingBatchCount||0)>0||(item.remainingUnprocessed||0)>0))return 1;
  return 0;
}

export async function runOneShotCli(args,{run=runKocOneShot,write=line=>console.log(line),
  verifyRelease=verifyKocRuntimeRelease}={}){
  let runtimeRelease;
  try{
    runtimeRelease=await verifyRelease();
    if(runtimeRelease?.passed!==true)throw new Error('KOC_RUNTIME_RELEASE_VERIFICATION_FAILED');
  }catch(error){
    write(JSON.stringify({passed:false,reason:safeRuntimeReleaseReason(error)}));
    return 1;
  }
  const result=await run(args);
  const summary=result===undefined?{passed:false,reason:'KOC_ONE_SHOT_FINAL_SUMMARY_MISSING'}:result;
  const output=summary&&typeof summary==='object'&&!Array.isArray(summary)
    ?{...summary,runtimeRelease}:{passed:false,reason:'KOC_ONE_SHOT_FINAL_SUMMARY_INVALID',runtimeRelease};
  write(JSON.stringify(output));
  return oneShotResultExitCode(result,args);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.umask(0o077);const args=parseOneShotArgs(process.argv.slice(2));
    if(args.help){console.log(oneShotHelpText());process.exitCode=0;}
    else process.exitCode=await runOneShotCli(args);
  }catch(error){
    const reason=safeCode(error?.message?.split(':')[0]||'KOC_ONE_SHOT_FAILED');
    console.log(JSON.stringify({passed:false,reason}));process.exitCode=1;
  }
}
