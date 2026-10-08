import {assertFeishuRoute,BUYIN_ACCOUNT_MARKER,DATA_DIR,PLAYWRIGHT_SESSION} from '../shared/config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {withRetryAfter} from './daily-retry-after.mjs';
import {randomUUID} from 'node:crypto';
import {spawnSync,spawn} from '../shared/child-process.mjs';
import {buildDailyAddContactManifest,runDailyAddContactBatch} from './daily-add-contact-batch.mjs';
import {PRODUCTION_STATE_DIR} from './canary-production-adapter.mjs';
import {prepareWriteContext,commitCapturedAttempt} from './parallel-production-adapter.mjs';
import {buildOriginalBackgroundWaveCode} from './original-background-wave.mjs';
import {buildReadOnlyPageSnapshotCode,selectParallelPages,projectParallelCaptureReceipt} from './run-canary-parallel-production.mjs';
import {prepareOriginalBackgroundContact,exactTextCellValue} from './run-original-background-feishu-write.mjs';
import {normalizeCanaryResult} from './canary-batch.mjs';
import {AsyncReadLarkBaseClient} from '../koc-roster/async-read-client.mjs';
import {FEISHU_ROUTE} from '../koc-roster/lark-writer.mjs';
import {writePrivateJson} from '../koc-roster/checkpoint.mjs';
export const SOURCE_ROOT=DATA_DIR;
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function loadDailyInventorySources(){
 const bundles=[];bundles.issues=[];
 for(const name of (await fs.readdir(SOURCE_ROOT)).filter(n=>/^\d{8}T\d{6}Z\.write-receipt\.json$/.test(n)).sort()){
  const sourceReceipt=await read(path.join(SOURCE_ROOT,name));
  if(sourceReceipt.mode!=='daily-add-only')continue;
  const batch=sourceReceipt.batchId;
  if(name!==`${batch}.write-receipt.json`)throw Error('SOURCE_BATCH_MISMATCH');
  const dailySource={sourceReceipt,sourceCheckpoint:await read(path.join(SOURCE_ROOT,`${batch}.checkpoint.json`))};
  let manifest;try{manifest=buildDailyAddContactManifest(dailySource);}catch(e){bundles.issues.push({sourceBatchId:batch,reason:/^[A-Z_]+$/.test(e.message)?e.message:"SOURCE_VALIDATION_FAILED",plannedCount:sourceReceipt.plannedCount??null});continue;}
  const cpPath=path.join(PRODUCTION_STATE_DIR,'daily-add-only',batch,'checkpoint.json');
  await runDailyAddContactBatch({manifest,checkpointPath:cpPath,prepareOnly:true});
  bundles.push({manifest,dailySource,cpPath,sourceRows:dailySource.sourceCheckpoint.pages.flatMap(p=>p.rows)});
 }
 return bundles;
}
export async function pendingDailyTargets(bundles){
 const targets=[];
 for(const b of bundles){const cp=await read(b.cpPath);
  b.manifest.targets.forEach((t,index)=>{const prior=cp.entries[index];
   if(prior.state!=='confirmed')targets.push({...t,index,sourceBatchId:b.manifest.sourceBatchId,prior});
  });
 }
 return targets;
}
function parseOutput(s){const m=s.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);if(!m)throw Error('CLI_RESULT_UNPARSED');return JSON.parse(m[1]);}
function cli(code){return new Promise((resolve,reject)=>{
 const p=spawn('npx',['--no-install','@playwright/cli@0.1.21',`-s=${PLAYWRIGHT_SESSION}`,'run-code',code],{cwd:path.resolve(import.meta.dirname,'..'),stdio:['ignore','pipe','pipe']});let out='';
 const timer=setTimeout(()=>p.kill('SIGTERM'),300000);p.stdout.on('data',x=>{out+=x;if(out.length>12e6)p.kill('SIGTERM');});p.stderr.resume();
 p.on('error',()=>{clearTimeout(timer);reject(Error('CLI_SPAWN_FAILED'));});p.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error('CLI_FAILED');resolve(parseOutput(out));}catch(e){reject(e);}});
});}
/** No new driver or writer: this is the successful ten-lane pilot's adapter, with variable inventory. */
export async function createProductionAdapter({bundles,dir,state,save}){
 const client=new AsyncReadLarkBaseClient({route:FEISHU_ROUTE});let indexQueue=Promise.resolve();
 const list=client.listRecordsPage.bind(client);client.listRecordsPage=(...args)=>{const job=indexQueue.then(()=>list(...args));indexQueue=job.catch(()=>{});return job;};
 let initialized=false,schema,detailTemplate,pages;
 const bundle=t=>{const b=bundles.find(b=>b.manifest.sourceBatchId===t.sourceBatchId);if(!b||!same(b.manifest.targets[t.index],{creatorId:t.creatorId,recordId:t.recordId,sourceRank:t.sourceRank}))throw Error('INVENTORY_SOURCE_CHANGED');return b;};
 async function init(required){assertFeishuRoute();if(!BUYIN_ACCOUNT_MARKER)throw Error('KOC_BUYIN_ACCOUNT_NOT_CONFIGURED');if(initialized){if(pages.length<required)throw Error("INVENTORY_PAGES_NOT_READY");return;}
  const auth=spawnSync('lark-cli',['auth','status','--profile',FEISHU_ROUTE.profile,'--verify','--json'],{encoding:'utf8',timeout:30000});
  const verified=o=>o&&typeof o==='object'&&(o.verified===true&&o.identity==='user'||Object.values(o).some(verified));
  if(auth.status!==0||!verified(JSON.parse(auth.stdout)))throw Error('LARK_AUTH_UNVERIFIED');
  ({detailTemplate}=await prepareOriginalBackgroundContact());schema=await client.listFields();
  pages=selectParallelPages(await cli(buildReadOnlyPageSnapshotCode()));
  if(pages.length<required)throw Error('INVENTORY_PAGES_NOT_READY');
  initialized=true;
 }
 const verify=async()=>{
  const verificationStarted=Date.now();const rows=[];
  for(const t of state.targets){const b=bundle(t),cp=await read(b.cpPath),e=cp.entries[t.index],l=state.entries[state.targets.indexOf(t)];
   const raw=await client.getRecord(t.recordId,['抖音号','本次联系方式状态','微信号']);const d=raw.data??raw;
   const f=d.record?.fields??Object.fromEntries(d.fields.map((n,i)=>[n,d.data[0][i]]));
   const expected={success:'found',not_shown:'not_shown',no_match:'not_found',forbidden_by_platform:'forbidden_by_platform'}[e.outcome];
   let contactMatches=true;if(e.outcome==='success'){const c=await read(path.join(dir,`${e.attemptId}.capture.json`));contactMatches=exactTextCellValue(f['微信号'])===c.attempt.contactValue;}
   rows.push({sourceBatchId:t.sourceBatchId,sourceRank:t.sourceRank,verified:(d.record_id_list?.[0]??d.record?.record_id)===t.recordId&&exactTextCellValue(f['抖音号'])===t.creatorId&&exactTextCellValue(f['本次联系方式状态'])===expected&&e.state==='confirmed'&&e.readbackVerified===true&&l.complete&&l.attemptId===e.attemptId&&contactMatches});
  }
  await writePrivateJson(path.join(dir,'independent-readback.json'),{observedAt:new Date().toISOString(),rows,allVerified:rows.every(r=>r.verified),profile:FEISHU_ROUTE.profile,identity:'user'});
  state.timing.finalReadbackMs=(state.timing.finalReadbackMs||0)+Date.now()-verificationStarted;return rows.every(r=>r.verified);
 };
 let prepared;
 const preflight=async targets=>{
  await init(targets.length);prepared=await Promise.all(targets.map(async(t,laneIndex)=>{
   const b=bundle(t),cp=await read(b.cpPath),prior=cp.entries[t.index];
   if(!same(prior,t.prior))throw Error('TARGET_CHECKPOINT_CHANGED');
   const request={creatorId:t.creatorId,recordId:t.recordId,sourceRank:t.sourceRank,sourceBatchId:t.sourceBatchId,attemptId:randomUUID()};
   const context=await prepareWriteContext(request,{manifest:b.manifest,dailySource:b.dailySource,client,schema:{...schema,verified:true},authContext:{verifiedUser:true,profile:FEISHU_ROUTE.profile,as:'user',host:FEISHU_ROUTE.host},verifySourceMember:({target,sourceBatchId})=>({...target,sourceBatchId,verified:true}),verifyCurrentMember:({target,indexEntry})=>indexEntry.creatorId===target.creatorId&&indexEntry.recordId===target.recordId,allowExistingWeChatReverify:true});
   const source=b.sourceRows.find(r=>r.creatorId===t.creatorId&&r.sourceRank===t.sourceRank);if(!source)throw Error('SOURCE_ROW_MISSING');
   const index=state.targets.indexOf(t);state.entries[index]={...state.entries[index],attemptId:request.attemptId};
   return {t,b,request,context,index,worker:{...request,creatorName:source.creatorName,workerId:`daily-${laneIndex}`,laneIndex,pageIndex:pages[laneIndex].pageIndex}};
  }));await save(state);
 };
 return {verify,preflight,capacity:async()=>{await init(1);return Math.min(10,pages.length);},executeWave:async targets=>{
  if(!prepared||prepared.length!==targets.length||prepared.some((p,i)=>p.t!==targets[i]))throw Error('INVENTORY_PREFLIGHT_REQUIRED');
  const capturedAt=Date.now();const result=await cli(withRetryAfter(buildOriginalBackgroundWaveCode({workers:prepared.map(p=>p.worker),policy:{laneLimit:10,sourceBatchIds:bundles.map(b=>b.manifest.sourceBatchId)},detailTemplate,accountMarker:BUYIN_ACCOUNT_MARKER})));
  state.timing.captureMs=(state.timing.captureMs||0)+Date.now()-capturedAt;
  const limited=Array.isArray(result?.workers)?result.workers.find(w=>w?.reason==='RATE_LIMITED'&&prepared.some(p=>p.request.attemptId===w.attemptId&&p.t.recordId===w.recordId&&p.t.creatorId===w.creatorId)):null;
  if(limited){const i=state.targets.findIndex(t=>t.recordId===limited.recordId);state.cooldown={index:i,lastProbeAt:Date.now(),nextEligibleAt:Math.max(Date.now()+300000,result.platformRetryAfterAt||0)};await save(state);}
  await validateAndPersistDailyWave({prepared,result,dir});
  const outputs=[];
  for(const p of prepared){const w=result.workers.find(w=>w.attemptId===p.request.attemptId);
   // The full wave was validated and its safe evidence persisted before this write loop.
   await writePrivateJson(path.join(dir,`${p.request.attemptId}.capture.json`),{descriptor:p.request,receipt:projectParallelCaptureReceipt(w.receipt),attempt:w.attempt});
   state.entries[p.index]={attemptId:p.request.attemptId,state:'uncertain',complete:false,writeState:'uncertain'};await save(state);
   const before=await read(p.b.cpPath);if(!same(before.entries[p.t.index],p.t.prior))throw Error('CHECKPOINT_CHANGED_BEFORE_WRITE');
   const intent={state:'in_flight',attemptId:p.request.attemptId,supersededAttempt:p.t.prior};before.entries[p.t.index]=intent;await writePrivateJson(p.b.cpPath,before);
   const writeAt=Date.now(),out=await commitCapturedAttempt(p.context,{descriptor:p.request,receipt:projectParallelCaptureReceipt(w.receipt),attempt:w.attempt});
   await writePrivateJson(path.join(dir,`${p.request.attemptId}.json`),{target:p.request,result:out.result,receipt:out.receipt});
   const cp=await read(p.b.cpPath);if(!same(cp.entries[p.t.index],intent))throw Error('CHECKPOINT_CHANGED_AFTER_WRITE');
   const entry=normalizeCanaryResult(out.result,p.request.attemptId,p.t);
   cp.entries[p.t.index]={...entry,...(['error','blocked'].includes(p.t.prior.state)?{supersededAttempt:p.t.prior}:{})};
   await writePrivateJson(p.b.cpPath,cp);const check=await read(p.b.cpPath);if(!same(check.entries[p.t.index],cp.entries[p.t.index]))throw Error('CHECKPOINT_READBACK_FAILED');
   p.t.prior=check.entries[p.t.index];state.timing.writeReadbackMs=(state.timing.writeReadbackMs||0)+Date.now()-writeAt;
   const complete=out.result.writeState==='verified'&&['success','not_shown','no_match','forbidden_by_platform'].includes(out.result.outcome);
   const row={...out.result,...(w.reason==='RATE_LIMITED'?{reason:'RATE_LIMITED',retryAfterAt:result.platformRetryAfterAt||0}:{}),attemptId:p.request.attemptId,complete,state:complete?'confirmed':out.result.writeState==='uncertain'?'uncertain':'failed'};
   state.entries[p.index]=row;outputs.push(row);await save(state);
   console.log(JSON.stringify({event:'row_readback',sourceBatchId:p.t.sourceBatchId,sourceRank:p.t.sourceRank,outcome:row.outcome,reason:row.reason,complete}));
  }
  return outputs;
 }};
}

const WAVE_GUARD_CODES=new Set(['PAGE_CONTEXT_CHANGED','PAGE_SET_UNAVAILABLE','PAGE_SET_CHANGED','PAGE_BINDING_CHANGED',
 'PAGE_STATE_UNAVAILABLE','WORKER_PAGE_VISIBLE','WORKER_PAGE_ROUTE_OR_ACCOUNT_CHANGED',
 'WORKER_PAGE_AUTH_RISK_OR_CONTEXT_CHANGED','PAGE_GUARD_ARGUMENTS_INVALID','UNOWNED_PAGE_CHANGED',
 'PAGE_CONTEXT_UNAVAILABLE','PAGE_CONTEXT_MISMATCH','PAGE_NOT_HIDDEN','PAGE_ACCOUNT_OR_ROUTE_UNVERIFIED',
 'PAGE_AUTH_RISK_OR_CONTEXT_UNVERIFIED','PAGE_SNAPSHOT_ARGUMENTS_INVALID','PAGE_SNAPSHOT_UNAVAILABLE',
 'PAGE_BINDINGS_INVALID','LOCATOR_PAGE_UNAVAILABLE','LOCATOR_PAGE_MISMATCH','PAGE_GUARD_FAILED',
 'WAVE_RUNTIME_ARGUMENTS_INVALID','PAGE_BINDING_DUPLICATE_OR_INVALID']);
for(const code of [...WAVE_GUARD_CODES])WAVE_GUARD_CODES.add(`INITIAL_${code}`);
const boundedCount=(value,max)=>Number.isInteger(value)&&value>=0&&value<=max?value:-1;

/** Validate the whole captured wave before any capture/checkpoint/Base mutation.
 * Only abortedBeforeWrite=true proves this invocation never reached the writer;
 * a successful validation receipt is not evidence that later writes did not occur.
 */
export async function validateAndPersistDailyWave({prepared,result,dir}) {
 const workers=Array.isArray(result?.workers)?result.workers:[];
 const rows=prepared.map(p=>{
  const candidates=workers.filter(w=>w?.attemptId===p.request.attemptId);
  const w=candidates.length===1?candidates[0]:null;
  const keys=['creatorId','recordId','sourceBatchId','sourceRank','attemptId'];
  const binding=Object.fromEntries(keys.map(key=>[key,Boolean(w&&w[key]===p.request[key])]));
  for(const key of ['workerId','laneIndex','pageIndex'])binding[key]=Boolean(w&&w[key]===p.worker[key]);
  const bindingVerified=candidates.length===1&&Object.values(binding).every(Boolean);
  const guard=w?.pageGuard;
  return {expected:Object.fromEntries(keys.map(key=>[key,p.request[key]])),
   workerId:p.worker.workerId,laneIndex:p.worker.laneIndex,pageIndex:p.worker.pageIndex,
   candidateCount:candidates.length,binding,bindingVerified,
   pageGuard:{passed:guard?.passed===true,reason:guard?.reason===''?'':WAVE_GUARD_CODES.has(guard?.reason)?guard.reason:'unknown',
    workerCount:boundedCount(guard?.workerCount,10),pageCount:boundedCount(guard?.pageCount,100)},
   receipt:projectParallelCaptureReceipt(w?.receipt)};
 });
 const complete=Array.isArray(result?.workers)&&workers.length===prepared.length;
 const validationPassed=complete&&rows.every(r=>r.bindingVerified&&r.pageGuard.passed);
 const reason=!complete?'WAVE_INCOMPLETE':validationPassed?'':'WORKER_BINDING_OR_GUARD_FAILED';
 const attemptId=prepared[0]?.request?.attemptId;
 if(typeof attemptId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(attemptId))throw Error('WAVE_EVIDENCE_ATTEMPT_INVALID');
 const evidenceFile=`wave-${attemptId}.evidence.json`;
 const evidence={version:1,observedAt:new Date().toISOString(),phase:'capture_validation_before_write',
  validationPassed,abortedBeforeWrite:!validationPassed,reason,expectedCount:prepared.length,returnedCount:workers.length,workers:rows};
 await writePrivateJson(path.join(dir,evidenceFile),evidence);
 if(!validationPassed){const error=Error(reason);error.waveFailure={reason,phase:evidence.phase,abortedBeforeWrite:true,
   expectedCount:prepared.length,returnedCount:workers.length,evidenceFile};throw error;}
 return prepared.map(p=>workers.find(w=>w.attemptId===p.request.attemptId));
}
