import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from '../shared/child-process.mjs';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR,readPrivateJson,writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {runDailyAddContactBatch,buildDailyAddContactManifest} from './daily-add-contact-batch.mjs';
import {PRODUCTION_STATE_DIR,createProductionAdapter} from './canary-production-adapter.mjs';

const ROW_RUNNER=fileURLToPath(new URL('./run-original-background-feishu-write.mjs',import.meta.url));
const DAILY_STATE_DIR=path.join(PRODUCTION_STATE_DIR,'daily-add-only');
const SAFE_CODE=/^[A-Z][A-Z0-9_]{0,100}$/u;
const safeCode=value=>SAFE_CODE.test(value||'')?value:'UNCLASSIFIED_ERROR';

async function readJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error?.code==='ENOENT')return null;throw error;}}

function runDailyRow(request){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[ROW_RUNNER],{cwd:fileURLToPath(new URL('..',import.meta.url)),
      env:{...process.env,DEBUG:'',PWDEBUG:'',KOC_SOURCE_MODE:'daily-add-only',
        KOC_CREATOR_ID:request.creatorId,KOC_EXPECTED_RECORD_ID:request.recordId,
        KOC_SOURCE_BATCH_ID:request.sourceBatchId,
        KOC_EXPECTED_SOURCE_RANK:String(request.sourceRank),KOC_ALLOW_EXISTING_WECHAT_REVERIFY:'1',
        KOC_EXTRA_ROW_CREATOR_ID:'',KOC_EXTRA_ROW_RECORD_ID:''},stdio:['ignore','pipe','pipe']});
    let stdout='',overflow=false;
    child.stdout.on('data',chunk=>{if(stdout.length+chunk.length<2*1024*1024)stdout+=chunk;else overflow=true;});
    child.stderr.resume();
    child.on('error',()=>resolve(null));
    child.on('close',()=>{
      if(overflow)return resolve(null);
      for(const line of stdout.trim().split(/\r?\n/u).reverse())try{return resolve(JSON.parse(line));}catch{}
      resolve(null);
    });
  });
}

async function acquireBrowserQueueLock(){
  await fs.mkdir(PRODUCTION_STATE_DIR,{recursive:true,mode:0o700});
  const lockPath=path.join(PRODUCTION_STATE_DIR,'production.lock');
  let lock;try{lock=await fs.open(lockPath,'wx',0o600);}catch{throw new Error('DAILY_CONTACT_BROWSER_QUEUE_LOCKED');}
  await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),mode:'daily-add-only'}));
  await lock.sync();
  return async()=>{await lock.close();await fs.unlink(lockPath);};
}

function sourceWriteReceiptNames(files){return files.filter(name=>/^\d{8}T\d{6}Z\.write-receipt\.json$/u.test(name)).sort();}

export async function runDailyAddContactsPending({stateDir=DEFAULT_STATE_DIR,productionStateDir=DAILY_STATE_DIR,
  batchId='',retryErrors=false,resumeBlocked=false,prepareOnly=false,onProgress,shouldContinue}={}){
  stateDir=path.resolve(stateDir);productionStateDir=path.resolve(productionStateDir);
  const names=batchId?[`${batchId}.write-receipt.json`]:sourceWriteReceiptNames(await fs.readdir(stateDir));
  const bundles=[];
  for(const name of names){
    const receipt=await readJson(path.join(stateDir,name));
    if(receipt?.mode!=='daily-add-only')continue;
    const sourceCheckpoint=await readPrivateJson(path.join(stateDir,`${receipt.batchId}.checkpoint.json`));
    bundles.push({receipt,manifest:buildDailyAddContactManifest({sourceReceipt:receipt,sourceCheckpoint})});
  }
  const seenCreators=new Set(),seenRecords=new Set();
  for(const bundle of bundles)for(const target of bundle.manifest.targets){
    if(seenCreators.has(target.creatorId)||seenRecords.has(target.recordId))throw new Error('DAILY_CONTACT_CROSS_BATCH_DUPLICATE_TARGET');
    seenCreators.add(target.creatorId);seenRecords.add(target.recordId);
  }
  if(!bundles.length)return {mode:'daily-add-only',batches:[],pendingBatchCount:0,noPendingDailyReceipts:true};
  if(prepareOnly){
    const prepared=[];
    for(const {manifest} of bundles){
      const checkpointPath=path.join(productionStateDir,manifest.sourceBatchId,'checkpoint.json');
      const summary=await runDailyAddContactBatch({manifest,checkpointPath,prepareOnly:true});
      prepared.push(summary);
    }
    return {mode:'daily-add-only',batches:prepared,pendingBatchCount:prepared.filter(x=>!x.complete).length,prepared:true};
  }
  const release=await acquireBrowserQueueLock();
  try{
    const adapter=createProductionAdapter({stateDir:productionStateDir,sourceStateDir:stateDir,invoke:runDailyRow});
    const results=[];
    for(const {manifest} of bundles){
      const checkpointPath=path.join(productionStateDir,manifest.sourceBatchId,'checkpoint.json');
      const summary=await runDailyAddContactBatch({manifest,checkpointPath,executeOne:adapter.executeOne,
        reconcileOne:adapter.reconcileOne,retryErrors,resumeBlocked,onProgress,shouldContinue});
      results.push(summary);
      if(!summary.complete||summary.errorsOrBlocked||summary.readbackUncertain)break;
    }
    await writePrivateJson(path.join(productionStateDir,'latest-summary.json'),{
      mode:'daily-add-only',updatedAt:new Date().toISOString(),batches:results.map(r=>({sourceBatchId:r.sourceBatchId,
        targetCount:r.targetCount,processedUnique:r.processedUnique,newWeChat:r.newWeChat,
        reviewedOldValue:r.reviewedOldValue,notShown:r.notShown,noMatch:r.noMatch,
        errorsOrBlocked:r.errorsOrBlocked,remainingUnprocessed:r.remainingUnprocessed,
        readbackUncertain:r.readbackUncertain,complete:r.complete}))});
    return {mode:'daily-add-only',batches:results,pendingBatchCount:results.filter(r=>!r.complete).length};
  }finally{await release();}
}

function parseArgs(argv){
  const args={batchId:'',retryErrors:false,resumeBlocked:false,prepareOnly:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--batch-id')args.batchId=String(argv[++i]||'');
    else if(arg==='--retry-errors')args.retryErrors=true;
    else if(arg==='--resume-blocked')args.resumeBlocked=true;
    else if(arg==='--prepare')args.prepareOnly=true;
    else throw new Error('DAILY_CONTACT_ARGUMENT_UNSUPPORTED');
  }
  if(args.batchId&&!/^[A-Za-z0-9_-]{8,64}$/.test(args.batchId))throw new Error('DAILY_CONTACT_BATCH_ID_INVALID');
  return args;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.umask(0o077);const args=parseArgs(process.argv.slice(2));
    console.log(JSON.stringify(await runDailyAddContactsPending(args)));
  }catch(error){
    console.log(JSON.stringify({passed:false,reason:safeCode(error?.message?.split(':')[0]||'DAILY_CONTACT_FAILED')}));
    process.exitCode=1;
  }
}
