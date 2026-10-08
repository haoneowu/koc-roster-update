import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR,writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {runCanaryBatch,ORIGINAL_BATCH_ID,validateCanaryManifest} from './canary-batch.mjs';
import {PRODUCTION_STATE_DIR,loadOriginalQueue,createProductionAdapter} from './canary-production-adapter.mjs';
import {selectNextFunctionalTarget,validateFunctionalPilotCohorts} from './functional-target.mjs';
import {safeRuntimeReleaseReason,verifyKocRuntimeRelease} from './runtime-release.mjs';

const ENTRY_FILE=fileURLToPath(import.meta.url);
const SAFE_REASON=/^[A-Z][A-Z0-9_]{0,100}$/u;
const FUNCTIONAL_MODE='original500-one-target-dual-pilot';
const FUNCTIONAL_RECEIPT='functional-one-target-dual-pilot.json';
const REQUIRED_PILOT_COUNT=2;

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function safeReason(value){return typeof value==='string'&&SAFE_REASON.test(value)?value:'FUNCTIONAL_TARGET_FAILED';}

async function readPrivateJson(filePath,code,maxBytes=64*1024){
  let stat,bytes;
  try{stat=await fs.lstat(filePath);}catch{throw new Error(`${code}_UNAVAILABLE`);}
  if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>maxBytes)
    throw new Error(`${code}_UNSAFE`);
  try{bytes=await fs.readFile(filePath);}catch{throw new Error(`${code}_UNAVAILABLE`);}
  try{return {value:JSON.parse(bytes.toString('utf8')),sha256:sha256(bytes)};}
  catch{throw new Error(`${code}_INVALID`);}
}

async function ensurePrivateDirectory(directory){
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0))
    throw new Error('FUNCTIONAL_STATE_DIR_UNSAFE');
}

async function acquireProductionLock(stateDir){
  const lockPath=path.join(stateDir,'production.lock');
  let lock;
  try{lock=await fs.open(lockPath,'wx',0o600);}catch{throw new Error('FUNCTIONAL_PRODUCTION_LOCKED');}
  const ownerToken=randomUUID();
  try{
    await lock.writeFile(JSON.stringify({pid:process.pid,ownerToken,startedAt:new Date().toISOString(),
      mode:FUNCTIONAL_MODE}));
    await lock.sync();
  }catch(error){await lock.close().catch(()=>{});await fs.unlink(lockPath).catch(()=>{});throw error;}
  return async()=>{await lock.close();await fs.unlink(lockPath).catch(()=>{});};
}

function selectedEntry(state,manifest,target){
  const index=manifest.targets.findIndex(row=>row.creatorId===target.creatorId&&
    row.recordId===target.recordId&&row.sourceRank===target.sourceRank);
  if(index<0||!state||!Array.isArray(state.entries)||state.entries.length!==500)
    throw new Error('FUNCTIONAL_TARGET_CHECKPOINT_MAPPING_INVALID');
  return {index,entry:state.entries[index]};
}

function pilotMembersClosed(checkpoint,manifest,pilot){
  return Array.isArray(pilot?.targets)&&pilot.targets.length===50&&pilot.targets.every(target=>{
    const index=manifest.targets.findIndex(row=>row.creatorId===target.creatorId&&row.recordId===target.recordId&&
      row.sourceRank===target.sourceRank);
    const entry=index<0?null:checkpoint.entries[index];
    return entry?.state==='confirmed'&&['success','not_shown','no_match'].includes(entry.outcome)&&
      entry.readbackVerified===true;
  });
}

async function pilotLedgerClosed(stateDir,pilot,binding){
  let loaded;
  try { loaded=await readPrivateJson(path.join(stateDir,'pilot-cohorts',`${pilot.cohortId}.json`),
    'FUNCTIONAL_PILOT_LEDGER',4096); }
  catch { return false; }
  const ledger=loaded.value,gate=ledger?.performanceGate;
  return ledger?.schemaVersion===2&&ledger.cohortId===pilot.cohortId&&ledger.state==='complete'&&
    ledger.manifestSha256===binding?.sha256&&ledger.targetCount===50&&
    Number.isSafeInteger(ledger.cohortStartedAtMs)&&ledger.cohortStartedAtMs>=0&&
    gate&&['passed','failed'].includes(gate.status)&&typeof gate.passed==='boolean'&&
    gate.limitMs===600_000&&gate.targetCount===50&&gate.confirmedCount===50&&
    gate.readbackVerifiedCount===50&&gate.completed===true&&
    (gate.status==='passed'&&gate.passed===true&&gate.elapsedMs<=600_000||
      gate.status==='failed'&&gate.passed===false&&gate.elapsedMs>600_000);
}

function publicResult({state,entry,runtimeRelease,reason}){
  return {mode:FUNCTIONAL_MODE,state,reason:reason||entry?.reason||undefined,
    outcome:entry?.outcome||null,targetCount:1,processedUnique:entry?.state!=='pending',
    readbackVerified:entry?.readbackVerified===true,newWeChat:entry?.newWeChat===true,
    reviewedOldValue:entry?.reviewedOldValue===true,runtimeRelease};
}

export async function runSingleTargetProduction({sourceManifestPath,pilotManifestPaths,enableRun=false,
  resumeBlocked=false,dependencies:providedDependencies={}}={}){
  let runtimeRelease;
  try{
    runtimeRelease=await (providedDependencies.verifyRuntimeRelease||verifyKocRuntimeRelease)();
    if(runtimeRelease?.passed!==true)throw new Error('KOC_RUNTIME_RELEASE_VERIFICATION_FAILED');
  }catch(error){
    return {state:'preflight_not_ready',reason:safeRuntimeReleaseReason(error),runtimeReleaseVerified:false};
  }
  if(typeof sourceManifestPath!=='string'||!sourceManifestPath.trim()||
      !Array.isArray(pilotManifestPaths)||pilotManifestPaths.length!==REQUIRED_PILOT_COUNT||
      pilotManifestPaths.some(filePath=>typeof filePath!=='string'||!filePath.trim()))
    return {state:'preflight_not_ready',reason:'FUNCTIONAL_MANIFEST_PATHS_REQUIRED',runtimeRelease};
  if(resumeBlocked&&!enableRun)
    return {state:'preflight_not_ready',reason:'FUNCTIONAL_RESUME_REQUIRES_RUN',runtimeRelease};
  if(!enableRun)return {state:'preflight_not_run',reason:'FUNCTIONAL_TARGET_RUN_FLAG_REQUIRED',runtimeRelease};

  const dependencies={stateDir:PRODUCTION_STATE_DIR,sourceStateDir:DEFAULT_STATE_DIR,
    checkpointPath:path.join(PRODUCTION_STATE_DIR,'checkpoint.json'),
    loadOriginalQueue:options=>loadOriginalQueue(options),
    loadPilotManifest:filePath=>readPrivateJson(path.resolve(filePath),'FUNCTIONAL_PILOT_MANIFEST'),
    runCanaryBatch,createProductionAdapter,writePrivateJson,
    ...providedDependencies};
  const stateDir=path.resolve(dependencies.stateDir);
  const checkpointPath=path.resolve(dependencies.checkpointPath);
  if(path.dirname(checkpointPath)!==stateDir)
    return {state:'preflight_not_ready',reason:'FUNCTIONAL_CHECKPOINT_PATH_INVALID',runtimeRelease};
  try{await ensurePrivateDirectory(stateDir);}catch(error){
    return {state:'preflight_not_ready',reason:safeReason(error?.message),runtimeRelease};
  }
  let releaseLock;
  try{releaseLock=await acquireProductionLock(stateDir);}catch(error){
    return {state:'preflight_not_ready',reason:safeReason(error?.message),runtimeRelease};
  }

  try{
    const source=await dependencies.loadOriginalQueue({sourceManifestPath,sourceStateDir:dependencies.sourceStateDir});
    const manifest=source?.manifest;
    if(manifest?.kind!=='qualified-source'||manifest.sourceBatchId!==ORIGINAL_BATCH_ID||manifest.targets?.length!==500)
      throw new Error('FUNCTIONAL_SOURCE_MANIFEST_INVALID');
    try{validateCanaryManifest(manifest);}catch{throw new Error('FUNCTIONAL_SOURCE_MANIFEST_INVALID');}
    const sourceManifestSha256=source?.migration?.sourceManifestSha256;
    if(!/^[a-f0-9]{64}$/u.test(sourceManifestSha256||''))
      throw new Error('FUNCTIONAL_SOURCE_MANIFEST_UNVERIFIED');
    const pilotLoaded=[];
    for(const filePath of pilotManifestPaths)
      pilotLoaded.push(await dependencies.loadPilotManifest(path.resolve(filePath)));
    const pilots=pilotLoaded.map(item=>item?.value||item?.manifest);
    const pilotManifestBindings=pilotLoaded.map((item,index)=>({cohortId:pilots[index]?.cohortId,sha256:item?.sha256}))
      .sort((a,b)=>String(a.cohortId).localeCompare(String(b.cohortId)));
    if(pilotManifestBindings.some(item=>!/^[a-f0-9]{64}$/u.test(item.sha256||'')))
      throw new Error('FUNCTIONAL_PILOT_MANIFEST_UNVERIFIED');
    const pilotScope=validateFunctionalPilotCohorts({manifest,pilots});
    const excludedIds=new Set(pilotScope.targetCreatorIds);
    let resumeReceipt=null;
    if(resumeBlocked){
      resumeReceipt=(await readPrivateJson(path.join(stateDir,FUNCTIONAL_RECEIPT),
        'FUNCTIONAL_TARGET_RECEIPT')).value;
      if(resumeReceipt?.version!==2||resumeReceipt.mode!==FUNCTIONAL_MODE||
          resumeReceipt.sourceManifestSha256!==sourceManifestSha256||
          JSON.stringify(resumeReceipt.pilotManifests)!==JSON.stringify(pilotManifestBindings)||
          !resumeReceipt.target||excludedIds.has(resumeReceipt.target.creatorId))
        throw new Error('FUNCTIONAL_TARGET_RESUME_SCOPE_INVALID');
    }

    const migration=source.migration?{...source.migration,
      sidecarPath:path.join(stateDir,`qualified-excluded-${sourceManifestSha256.slice(0,20)}.json`)}:null;
    await dependencies.runCanaryBatch({manifest,targetCount:500,checkpointPath,initialResults:source.initialResults||[],
      reviewedRecovery:source.reviewedRecovery||null,migration,prepareOnly:true});
    let checkpoint=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    for(let index=0;index<pilots.length;index+=1){
      if(!pilotMembersClosed(checkpoint,manifest,pilots[index])||
          !await pilotLedgerClosed(stateDir,pilots[index],pilotManifestBindings.find(binding=>
            binding.cohortId===pilots[index].cohortId)))
        return {state:'functional_target_unavailable',reason:'FUNCTIONAL_PRIOR_COHORT_OPEN',targetCount:0,runtimeRelease};
    }
    let target;
    if(resumeBlocked){
      target=manifest.targets.find(row=>row.creatorId===resumeReceipt.target.creatorId&&
        row.recordId===resumeReceipt.target.recordId&&row.sourceRank===resumeReceipt.target.sourceRank);
      if(!target)throw new Error('FUNCTIONAL_TARGET_RESUME_MAPPING_INVALID');
      const {entry}=selectedEntry(checkpoint,manifest,target);
      if(entry.state==='confirmed')return publicResult({state:'functional_target_already_resolved',entry,runtimeRelease});
      if(!['blocked','uncertain','in_flight'].includes(entry.state))
        throw new Error('FUNCTIONAL_TARGET_RESUME_STATE_INVALID');
    }else{
      target=selectNextFunctionalTarget({manifest,entries:checkpoint.entries,pilots});
      if(!target)return {state:'functional_target_unavailable',reason:'FUNCTIONAL_TARGET_NONE_PENDING_OUTSIDE_PILOT',
        targetCount:0,runtimeRelease};
    }

    const targetIndex=manifest.targets.findIndex(row=>row.creatorId===target.creatorId&&row.recordId===target.recordId);
    const unresolvedIndex=checkpoint.entries.findIndex((entry,index)=>
      ['in_flight','uncertain'].includes(entry.state)&&!(resumeBlocked&&index===targetIndex));
    if(unresolvedIndex>=0)
      return {state:'functional_target_unavailable',reason:'FUNCTIONAL_UNKNOWN_ATTEMPT_REQUIRES_RECONCILIATION',
        targetCount:0,runtimeRelease};

    const adapter=dependencies.createProductionAdapter({stateDir,
      sourceStateDir:dependencies.sourceStateDir,sourceManifestPath,
      sourceManifestSha256,searchAttemptLimit:3,searchAttemptCreatorIds:[target.creatorId]});
    await dependencies.runCanaryBatch({manifest,targetCount:500,checkpointPath,initialResults:source.initialResults||[],
      reviewedRecovery:source.reviewedRecovery||null,migration,executeOne:adapter.executeOne,
      reconcileOne:adapter.reconcileOne,targetCreatorIds:[target.creatorId],resumeBlocked});
    checkpoint=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    const {entry}=selectedEntry(checkpoint,manifest,target);
    await dependencies.writePrivateJson(path.join(stateDir,FUNCTIONAL_RECEIPT),{
      version:2,mode:FUNCTIONAL_MODE,sourceBatchId:manifest.sourceBatchId,
      sourceManifestSha256,pilotManifests:pilotManifestBindings,target,state:entry.state,outcome:entry.outcome||null,
      reason:entry.reason||null,attemptId:entry.attemptId||null,
      readbackVerified:entry.readbackVerified===true,updatedAt:new Date().toISOString()});
    const terminal=entry.state==='confirmed'&&['success','not_shown','no_match'].includes(entry.outcome);
    return publicResult({state:terminal?'functional_target_complete':entry.state,entry,runtimeRelease});
  }catch(error){
    const reason=safeReason(error?.message);
    return {state:'functional_target_failed',reason,runtimeRelease,checkpointPreserved:true};
  }finally{await releaseLock();}
}

export function parseSingleTargetArgs(argv){
  const args={sourceManifestPath:'',pilotManifestPaths:[],enableRun:false,resumeBlocked:false,help:false};
  const seen=new Set();
  for(const arg of argv){
    if(arg==='--help'){args.help=true;continue;}
    if(arg==='--run'){if(seen.has('--run'))throw new Error('FUNCTIONAL_OPTION_DUPLICATE');seen.add('--run');args.enableRun=true;continue;}
    if(arg==='--resume-blocked'){if(seen.has('--resume-blocked'))throw new Error('FUNCTIONAL_OPTION_DUPLICATE');seen.add('--resume-blocked');args.resumeBlocked=true;continue;}
    const match=arg.match(/^--(source-manifest|pilot-manifest)=(.+)$/u);
    if(!match)throw new Error('FUNCTIONAL_ARGUMENT_INVALID');
    if(match[1]==='source-manifest'){
      if(seen.has(match[1]))throw new Error('FUNCTIONAL_OPTION_DUPLICATE');
      seen.add(match[1]);args.sourceManifestPath=match[2];
    }else{
      args.pilotManifestPaths.push(match[2]);
      if(args.pilotManifestPaths.length>REQUIRED_PILOT_COUNT)throw new Error('FUNCTIONAL_ARGUMENT_INVALID');
    }
  }
  if(args.help)return args;
  if(!args.sourceManifestPath||args.pilotManifestPaths.length!==REQUIRED_PILOT_COUNT||args.resumeBlocked&&!args.enableRun)
    throw new Error('FUNCTIONAL_ARGUMENT_INVALID');
  return args;
}

if(process.argv[1]&&path.resolve(process.argv[1])===ENTRY_FILE){
  process.umask(0o077);
  try{
    const args=parseSingleTargetArgs(process.argv.slice(2));
    if(args.help){process.stdout.write('Qualified original-500 single-target functional run\n--source-manifest=<private-qualified-manifest> --pilot-manifest=<frozen-50-v1> --pilot-manifest=<frozen-50-v2> --run [--resume-blocked]\n');}
    else runSingleTargetProduction(args).then(result=>{
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if(!['functional_target_complete','functional_target_unavailable','functional_target_already_resolved',
        'preflight_not_run'].includes(result.state))process.exitCode=1;
    }).catch(error=>{
      process.stdout.write(`${JSON.stringify({state:'functional_target_failed',reason:safeReason(error?.message)})}\n`);
      process.exitCode=1;
    });
  }catch(error){
    process.stdout.write(`${JSON.stringify({state:'functional_target_failed',reason:safeReason(error?.message)})}\n`);
    process.exitCode=1;
  }
}
