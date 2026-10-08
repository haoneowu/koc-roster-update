import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR,writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {ORIGINAL_BATCH_ID,runCanaryBatch,summarizeCanary,validateCanaryManifest} from './canary-batch.mjs';
import {PRODUCTION_STATE_DIR,EXTRA_TARGET,loadOriginalQueue,createProductionAdapter} from './canary-production-adapter.mjs';
import {loadRetryExclusions} from './retry-exclusions.mjs';

// Keep the environment circuit breaker narrower than the full safe-reason list:
// identity, contact availability and permission failures have their own handling.
const ENVIRONMENT_FAILURE_REASONS=new Set([
  'BACKGROUND_GUARD_FAILED','TARGET_PAGE_CLOSED','TARGET_PAGE_AMBIGUOUS','EXECUTION_CONTEXT_CHANGED',
  'BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
]);
const SHA256=/^[a-f0-9]{64}$/u;
export function nextEnvironmentErrorCount(previous,reason){
  return ENVIRONMENT_FAILURE_REASONS.has(reason)?previous+1:0;
}

export const ONE_SHOT_RESULT_CONTRACT_VERSION=1;
export function buildProductionSummary({state,extra,targetCount,event='pass_finished'}){
  const report=summarizeCanary(state,targetCount);
  const entries=state.entries.slice(0,targetCount);
  const extraResult=extra?.result||{};
  const all=[...entries,...(extra?[{...extraResult,state:extra.state}]:[])];
  const uncertain=all.some(e=>['uncertain','in_flight'].includes(e.state));
  const blocked=all.find(e=>e.state==='blocked');
  const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null;
  let outcome='partial',reason;
  if(event==='prepared')outcome='prepared';
  else if(uncertain)reason='WRITE_OUTCOME_UNCERTAIN';
  else if(blocked){outcome=blocked.outcome==='risk_blocked'?'risk_blocked':'auth_blocked';reason=code(blocked.reason)||'BLOCKED_REASON_UNVERIFIED';}
  else if(report.firstRoundFilled&&extra?.state==='confirmed')outcome='completed';
  else if(event==='environment_paused')reason='ENVIRONMENT_CIRCUIT_PAUSED';
  else if(event==='boundary_paused')reason='BOUNDARY_PAUSED';
  else {const error=all.find(e=>e.state==='error');reason=code(error?.reason)||'BATCH_INCOMPLETE';}
  const exitState=outcome==='prepared'?'prepared':uncertain?'uncertain':outcome==='completed'?'complete':
    ['auth_blocked','risk_blocked'].includes(outcome)?outcome:
    ['boundary_paused','environment_paused'].includes(event)?event:'pass_finished';
  return {mode:'original-contact',state:exitState,...(reason?{reason}:{}),sourceBatchId:'20260923T152555Z',
    checkpointPreserved:true,targetCount,original:report,
    extra:{state:extra?.state||'pending',outcome:extraResult.outcome||null,
      readbackVerified:extraResult.readbackVerified===true,reason:code(extraResult.reason)}};
}

async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}

export async function runProductionCanary(options={}){
  const hasSourceManifest=options.sourceManifestPath!==undefined;
  const hasSourceManifestSha=options.sourceManifestSha256!==undefined;
  if(!hasSourceManifest||!hasSourceManifestSha)throw new Error('CANARY_SOURCE_MANIFEST_PROOF_REQUIRED');
  if(typeof options.sourceManifestPath!=='string'||!options.sourceManifestPath.trim()||!SHA256.test(options.sourceManifestSha256))
    throw new Error('CANARY_SOURCE_MANIFEST_PROOF_INVALID');
  const dependencies=options.dependencies||{};
  const stateDir=path.resolve(dependencies.stateDir||PRODUCTION_STATE_DIR);
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  const lockPath=path.join(stateDir,'production.lock');
  const lock=await fs.open(lockPath,'wx',0o600);
  try{
    await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));await lock.sync();
    return await runUnlocked({...options,stateDir,dependencies});
  }finally{await lock.close();await fs.unlink(lockPath);}
}

export async function processExtraTarget({extra,adapter,resumeBlocked=false,retryErrors=false,save}){
  if(extra.state==='confirmed'||(extra.state==='error'&&!retryErrors)||(extra.state==='blocked'&&!resumeBlocked))return extra;
  const reconcile=['in_flight','uncertain'].includes(extra.state);
  const attemptId=reconcile?extra.attemptId:randomUUID();
  if(!reconcile){extra={...EXTRA_TARGET,attemptId,state:'in_flight'};await save(extra);}
  const request={...EXTRA_TARGET,attemptId};
  const result=await (reconcile?adapter.reconcileOne(request):adapter.executeOne(request));
  const state=result.writeState==='uncertain'?'uncertain':
    ['auth_blocked','risk_blocked'].includes(result.outcome)?'blocked':
    result.outcome==='error'?'error':result.writeState==='verified'?'confirmed':'uncertain';
  extra={...EXTRA_TARGET,attemptId,state,result};await save(extra);return extra;
}

async function runUnlocked({targetCount=100,prepareOnly=false,retryErrors=false,resumeBlocked=false,shouldContinue,
  onProgress,targetCreatorIds=null,recheckNoMatch=null,searchAttemptLimit=3,stateDir=PRODUCTION_STATE_DIR,
  sourceManifestPath,sourceManifestSha256,dependencies={},retryExclusionPath}={}){
  if(![100,200,500].includes(targetCount))throw new Error('CANARY_TARGET_INVALID');
  if(!Number.isInteger(searchAttemptLimit)||searchAttemptLimit<1||searchAttemptLimit>3)
    throw new Error('CANARY_SEARCH_ATTEMPT_LIMIT_INVALID');
  const checkpointPath=path.join(stateDir,'checkpoint.json');
  const queuePath=path.join(stateDir,'queue.json');
  const extraPath=path.join(stateDir,'extra-authorized-row.json');
  const loadQueue=dependencies.loadOriginalQueue||loadOriginalQueue;
  const sourceStateDir=dependencies.sourceStateDir||DEFAULT_STATE_DIR;
  const source=await loadQueue({stateDir:sourceStateDir,sourceManifestPath,sourceManifestSha256,sourceStateDir});
  const {manifest,initialResults,reviewedRecovery}=source;
  try{validateCanaryManifest(manifest);}catch{throw new Error('CANARY_SOURCE_MANIFEST_INVALID');}
  if(manifest?.kind!=='qualified-source'||manifest.sourceBatchId!==ORIGINAL_BATCH_ID||manifest.targets?.length!==500)
    throw new Error('CANARY_SOURCE_MANIFEST_INVALID');
  if(source?.migration?.sourceManifestSha256!==sourceManifestSha256||!source.migration.previousManifest)
    throw new Error('CANARY_SOURCE_MANIFEST_SHA256_MISMATCH');
  try{validateCanaryManifest(source.migration.previousManifest);}catch{throw new Error('CANARY_SOURCE_MANIFEST_INVALID');}
  const migration={...source.migration,
    sidecarPath:path.join(stateDir,`qualified-excluded-${sourceManifestSha256.slice(0,20)}.json`)};
  const retryExclusions=await loadRetryExclusions({filePath:retryExclusionPath||dependencies.retryExclusionPath,manifest});
  if(searchAttemptLimit<3){
    const targetSet=Array.isArray(targetCreatorIds)?new Set(targetCreatorIds):null;
    const prefixIds=new Set(manifest.targets.slice(0,targetCount).map(target=>target.creatorId));
    if(!targetSet||targetSet.size===0||targetSet.size!==targetCreatorIds.length||
        [...targetSet].some(id=>!prefixIds.has(id)))throw new Error('CANARY_SEARCH_ATTEMPT_SCOPE_INVALID');
  }
  const makeAdapter=dependencies.createProductionAdapter||createProductionAdapter;
  const adapter=makeAdapter({stateDir,searchAttemptLimit,
    sourceStateDir,sourceManifestPath,sourceManifestSha256,
    searchAttemptCreatorIds:searchAttemptLimit<3?targetCreatorIds:[]});
  await runCanaryBatch({manifest,targetCount,checkpointPath,initialResults,reviewedRecovery,prepareOnly:true,
    retryExclusions,migration});
  async function publish(event='checkpoint',index=null){
    const state=await readJson(checkpointPath);
    const rows=manifest.targets.slice(0,targetCount).map((target,i)=>({...target,...state.entries[i]}));
    const report=summarizeCanary(state,targetCount);
    await writePrivateJson(queuePath,{version:1,sourceBatchId:manifest.sourceBatchId,targetCount,
      updatedAt:new Date().toISOString(),report,queue:rows,
      confirmed:rows.filter(r=>r.state==='confirmed').map(r=>r.creatorId),
      unprocessed:rows.filter(r=>r.state==='pending').map(r=>r.creatorId),
      errors:rows.filter(r=>r.state==='error').map(r=>r.creatorId),
      uncertain:rows.filter(r=>['uncertain','in_flight'].includes(r.state)).map(r=>r.creatorId)});
    const extra=await readJson(extraPath);
    const extraSummary=extra?{state:extra.state,outcome:extra.result?.outcome||null,
      newWeChat:extra.result?.outcome==='success'&&extra.result?.hadWeChatBefore===false,
      reviewedOldValue:extra.result?.outcome==='success'&&extra.result?.hadWeChatBefore===true,
      readbackVerified:extra.result?.readbackVerified===true,reason:extra.result?.reason||null}:{state:'pending'};
    process.stdout.write(JSON.stringify({event,index,original:report,extra:extraSummary})+'\n');
    return report;
  }
  if(!await readJson(extraPath))await writePrivateJson(extraPath,{...EXTRA_TARGET,state:'pending'});
  await publish(prepareOnly?'prepared':'started');
  const summary=async event=>buildProductionSummary({state:await readJson(checkpointPath),extra:await readJson(extraPath),targetCount,event});
  if(prepareOnly)return summary('prepared');
  // The explicitly requested view row is additional to all 100 original targets.
  const extra=await processExtraTarget({extra:await readJson(extraPath),adapter,resumeBlocked,retryErrors,
    save:value=>writePrivateJson(extraPath,value)});
  await publish('extra_row');
  if(typeof onProgress==='function')try{await onProgress({mode:'original-contact',event:'extra_row_checkpointed',
    state:extra.state,outcome:extra.result?.outcome||'',reason:extra.result?.reason||'',
    writeState:extra.result?.writeState,sourceBatchId:manifest.sourceBatchId,targetCount,
    checkpointPreserved:true,attemptId:extra.attemptId||''});}catch{}
  if(extra.state==='blocked')return summary('extra_row');
  let consecutiveEnvironmentErrors=0,environmentPaused=false;
  await runCanaryBatch({manifest,targetCount,checkpointPath,executeOne:adapter.executeOne,reconcileOne:adapter.reconcileOne,
    retryErrors,resumeBlocked,targetCreatorIds,recheckNoMatch,retryExclusions,migration,
    shouldContinue:async args=>!environmentPaused&&(!shouldContinue||await shouldContinue(args)!==false),
    onProgress:async({index})=>{
      const state=await readJson(checkpointPath);
      const entry=state.entries[index]||{};
      const reason=entry.reason;
      consecutiveEnvironmentErrors=nextEnvironmentErrorCount(consecutiveEnvironmentErrors,reason);
      environmentPaused=consecutiveEnvironmentErrors>=3;
      await publish('row',index);
      if(typeof onProgress==='function')try{await onProgress({mode:'original-contact',
        event:environmentPaused?'environment_paused':'row_checkpointed',
        state:environmentPaused?'environment_paused':entry.state,
        outcome:entry.outcome||'',reason:reason||'',
        writeState:['uncertain','in_flight'].includes(entry.state)?'uncertain':undefined,
        sourceBatchId:manifest.sourceBatchId,targetCount,checkpointPreserved:true,
        attemptId:entry.attemptId||''});}catch{}
    }});
  const event=environmentPaused?'environment_paused':shouldContinue&&await shouldContinue()===false?'boundary_paused':'pass_finished';
  await publish(event);
  return summary(event);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let stopRequested=false;
  process.on('SIGUSR1',()=>{stopRequested=true;});
  const args=process.argv.slice(2);
  const targetArg=args.find(a=>a.startsWith('--target='));
  const sourceManifestIndex=args.indexOf('--source-manifest');
  const sourceManifestShaIndex=args.indexOf('--source-manifest-sha256');
  const sourceManifestPath=sourceManifestIndex>=0?args[sourceManifestIndex+1]:undefined;
  const sourceManifestSha256=sourceManifestShaIndex>=0?args[sourceManifestShaIndex+1]:undefined;
  const proofError=sourceManifestPath===undefined||sourceManifestSha256===undefined
    ?'CANARY_SOURCE_MANIFEST_PROOF_REQUIRED'
    :typeof sourceManifestPath!=='string'||!sourceManifestPath.trim()||!SHA256.test(sourceManifestSha256)
      ?'CANARY_SOURCE_MANIFEST_PROOF_INVALID':'';
  if(proofError){
    process.stdout.write(`${JSON.stringify({event:'batch_process_error',reason:proofError,checkpointPreserved:false})}\n`);
    process.exitCode=1;
  }else runProductionCanary({targetCount:targetArg?Number(targetArg.split('=')[1]):100,
    sourceManifestPath,sourceManifestSha256,prepareOnly:args.includes('--prepare'),
    retryErrors:args.includes('--retry-errors'),resumeBlocked:args.includes('--resume-blocked'),
    shouldContinue:()=>!stopRequested}).catch(()=>{
    // Never forward errors from a child/CLI or file containing business values.
    process.stdout.write(JSON.stringify({event:'batch_process_error',reason:'CANARY_RUN_FAILED',checkpointPreserved:true})+'\n');
    process.exitCode=1;
  });
}
