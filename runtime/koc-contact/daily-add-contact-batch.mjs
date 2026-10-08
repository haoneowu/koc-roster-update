import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {withRecordProcessLock} from '../koc-roster/lark-writer.mjs';
import {classifyRankedRows, dedupeRankedRows, normalizeText, pageFingerprint, ROSTER_SCOPE_KEY, ROSTER_SCOPE_LABEL} from '../koc-roster/roster-domain.mjs';

const SUCCESS_OUTCOMES=new Set(['created','recovered_after_uncertain_write','reconciled_same_batch']);
const CONTACT_OUTCOMES=new Set(['success','not_shown','no_match','forbidden_by_platform','error','auth_blocked','risk_blocked']);
const CONTACT_TERMINAL=new Set(['success','not_shown','no_match','forbidden_by_platform']);
const fail=code=>{throw new Error(`DAILY_CONTACT_${code}`);};
const isId=value=>typeof value==='string'&&value.length>0&&value.length<200;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

const LEGACY_SCOPE_KEY=ROSTER_SCOPE_KEY.replace('merchant-filter:v4','merchant-filter:v3');
// Frozen v3 eligibility is used ONLY to verify an existing source fingerprint.
// Actual contact targets must additionally pass today's classifier below.
function legacyEligible(rows) {
 return dedupeRankedRows(rows).unique.filter(row=>{
  if(!row.creatorId||!row.creatorName||!row.sourceProfileUrl)return false;
  const subjects=Object.values(row.subjectEvidence||{}),types=Object.values(row.creatorSubjectEvidence||{}),business=Object.values(row.businessEvidence||{});
  const text=[row.creatorName,...subjects].join(' ');
  if(/旗舰店|专卖店|厂家直销/.test(text)||[...types,...business].some(v=>/^(?:店铺|商家|品牌方|商户|店铺号)$/.test(normalizeText(v))))return false;
  if(/有限公司|有限责任公司|集团|企业号|企业账号|工厂|供应链|官方账号|官方号|品牌号|自营/.test(text)||business.some(v=>/商家|店铺|企业|工厂|供应链|品牌方|商户|官方|自营/.test(v)))return false;
  return true;
 });
}
function sourceTop500Fingerprint(checkpoint, rows) {
  const classification=checkpoint.scopeKey===LEGACY_SCOPE_KEY?{eligible:legacyEligible(rows),existing:[]}:classifyRankedRows(rows);
  const ranked=[...classification.eligible,...classification.existing].sort((a,b)=>a.sourceRank-b.sourceRank);
  const top500=ranked.slice(0,500);
  const stableEvidence={version:1,status:checkpoint.status,targetCount:checkpoint.targetCount,
    targetReached:checkpoint.targetReached===true,sourceComplete:checkpoint.sourceComplete===true,
    capturedAt:checkpoint.pages[0]?.capturedAt||checkpoint.startedAt||'',
    rankedRowsFingerprint:pageFingerprint(top500)};
  return {top500,rankedCount:ranked.length,fingerprint:createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex')};
}

/** Build only the contact targets whose daily add-only Base writes were read back. */
export function buildDailyAddContactManifest({sourceReceipt,sourceCheckpoint}) {
  if(!sourceReceipt||sourceReceipt.mode!=='daily-add-only'||sourceReceipt.dailyAddOnly!==true||
      sourceReceipt.status!=='complete'||sourceReceipt.contactDataIncluded!==false||
      !isId(sourceReceipt.batchId)||![ROSTER_SCOPE_KEY,LEGACY_SCOPE_KEY].includes(sourceReceipt.scopeKey)||
      sourceReceipt.scope!==ROSTER_SCOPE_LABEL||!Array.isArray(sourceReceipt.plannedCreators)||
      !Array.isArray(sourceReceipt.outcomes)||!sourceReceipt.creatorRecordIds||
      typeof sourceReceipt.creatorRecordIds!=='object'||
      sourceReceipt.plannedCount!==sourceReceipt.plannedCreators.length||
      sourceReceipt.completedCount!==sourceReceipt.plannedCount) fail('SOURCE_RECEIPT_UNVERIFIED');
  if(!sourceCheckpoint||sourceCheckpoint.batchId!==sourceReceipt.batchId||
      sourceCheckpoint.scopeKey!==sourceReceipt.scopeKey||sourceCheckpoint.scopeLabel!==ROSTER_SCOPE_LABEL||
      !Array.isArray(sourceCheckpoint.pages)||!sourceCheckpoint.pages.length||
      !['target_reached','source_exhausted'].includes(sourceCheckpoint.status)||
      sourceReceipt.sourceEvidence?.status!==sourceCheckpoint.status||
      sourceReceipt.sourceEvidence?.targetCount!==500||
      sourceReceipt.sourceEvidence?.targetReached!==(sourceCheckpoint.targetReached===true)||
      sourceReceipt.sourceEvidence?.sourceComplete!==(sourceCheckpoint.sourceComplete===true)) fail('SOURCE_CHECKPOINT_UNVERIFIED');
  const completeTop500=sourceCheckpoint.status==='target_reached'&&sourceCheckpoint.targetReached===true;
  const completeExhausted=sourceCheckpoint.status==='source_exhausted'&&sourceCheckpoint.sourceComplete===true&&
    sourceCheckpoint.targetReached!==true;
  if(!completeTop500&&!completeExhausted) fail('SOURCE_NOT_COMPLETE');

  const rawRows=sourceCheckpoint.pages.flatMap(page=>page.rows||[]);
  const {top500,rankedCount,fingerprint}=sourceTop500Fingerprint(sourceCheckpoint,rawRows);
  if(sourceReceipt.sourceEvidence?.top500Fingerprint!==fingerprint||
      sourceReceipt.sourceEvidence?.sourceRankedRows!==top500.length||
      sourceReceipt.sourceEvidence?.filteredCandidateCount!==rankedCount) fail('SOURCE_FINGERPRINT_MISMATCH');
  const rowsById=new Map();
  for(const row of top500){
    const id=normalizeText(row.creatorId);
    if(!id)continue;
    if(rowsById.has(id))fail('SOURCE_ID_CONFLICT');
    rowsById.set(id,row);
  }
  const plannedIds=new Set();
  for(const row of sourceReceipt.plannedCreators){
    if(!isId(row?.creatorId)||!Number.isInteger(row.sourceRank)||row.sourceRank<1||plannedIds.has(row.creatorId))
      fail('SOURCE_PLAN_INVALID');
    plannedIds.add(row.creatorId);
  }
  const targets=[],recordIds=new Set();
  for(const item of sourceReceipt.plannedCreators){
    const sourceRow=rowsById.get(item.creatorId);
    if(!sourceRow||sourceRow.sourceRank!==item.sourceRank||
        !top500.some(row=>normalizeText(row.creatorId)===item.creatorId&&row.sourceRank===item.sourceRank))
      fail('SOURCE_ROW_MISMATCH');
    if(classifyRankedRows([sourceRow]).eligible.length!==1)fail('CURRENT_TARGET_INELIGIBLE');
    const outcomes=sourceReceipt.outcomes.filter(row=>row?.creatorId===item.creatorId);
    if(outcomes.length!==1) fail('SOURCE_OUTCOME_AMBIGUOUS');
    const outcome=outcomes[0];
    if(outcome.sourceRank!==item.sourceRank) fail('SOURCE_OUTCOME_MISMATCH');
    // A planned row can lose an add-only race and be skipped. Contact work is admitted
    // only for a verified create/recovery/reconciliation with the same mapped record.
    if(!SUCCESS_OUTCOMES.has(outcome.outcome)) continue;
    const recordId=sourceReceipt.creatorRecordIds[item.creatorId];
    if(outcome.readbackVerified!==true||!isId(recordId)||outcome.recordId!==recordId||recordIds.has(recordId))
      fail('RECORD_MAPPING_UNVERIFIED');
    recordIds.add(recordId);
    targets.push({creatorId:item.creatorId,recordId,sourceRank:item.sourceRank});
  }
  targets.sort((a,b)=>a.sourceRank-b.sourceRank||a.creatorId.localeCompare(b.creatorId));
  return {version:1,mode:'daily-add-only',sourceBatchId:sourceReceipt.batchId,targets,
    sourceFingerprint:fingerprint};
}

function normalizedContactResult(result,attemptId,target) {
  const reason=typeof result?.reason==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(result.reason)?{reason:result.reason}:{};
  const uncertain=()=>({state:'uncertain',attemptId,...reason});
  if(!result||result.attemptId!==attemptId||!CONTACT_OUTCOMES.has(result.outcome)||
      !['verified','not_written','uncertain'].includes(result.writeState))return uncertain();
  if(result.outcome==='forbidden_by_platform'&&result.reason!=='CONTACT_CATEGORY_RESTRICTED')return uncertain();
  const blocked=['auth_blocked','risk_blocked'].includes(result.outcome);
  const verified=result.writeState==='verified'&&result.recordMappingVerified===true&&
    result.readbackVerified===true&&result.originalAttemptSourceVerified===true&&result.protectedFieldsUnchanged===true;
  if(!verified&&!((blocked||result.outcome==='error')&&result.writeState==='not_written'))
    return {...uncertain(),...(blocked?{sessionBlocked:true,blockedOutcome:result.outcome}:{})};
  if(result.outcome==='success'&&(typeof result.hadWeChatBefore!=='boolean'||result.currentValueVerified!==true))return uncertain();
  return {state:blocked?'blocked':result.outcome==='error'?'error':'confirmed',attemptId,
    outcome:result.outcome,...reason,newWeChat:result.outcome==='success'&&!result.hadWeChatBefore,
    reviewedOldValue:result.outcome==='success'&&result.hadWeChatBefore,
    readbackVerified:verified};
}

export function summarizeDailyAddContacts(state) {
  const entries=state.entries||[];
  const count=fn=>entries.filter(fn).length;
  return {sourceBatchId:state.sourceBatchId,targetCount:entries.length,
    processedUnique:count(e=>e.state!=='pending'),newWeChat:count(e=>e.newWeChat===true),
    reviewedOldValue:count(e=>e.reviewedOldValue===true),notShown:count(e=>e.outcome==='not_shown'),
    noMatch:count(e=>e.outcome==='no_match'),errorsOrBlocked:count(e=>['error','auth_blocked','risk_blocked'].includes(e.outcome)),
    remainingUnprocessed:count(e=>e.state==='pending'),readbackUncertain:count(e=>['uncertain','in_flight'].includes(e.state)),
    complete:entries.every(e=>e.state==='confirmed'&&CONTACT_TERMINAL.has(e.outcome)),
    sessionBlocked:state.sessionBlock?.outcome||null};
}

/** Durable per-source-batch queue; uncertain writes are reconciled before any retry. */
export async function runDailyAddContactBatch({manifest,checkpointPath,executeOne,reconcileOne,
  retryErrors=false,resumeBlocked=false,prepareOnly=false,onProgress,shouldContinue}={}) {
  if(manifest?.version!==1||manifest.mode!=='daily-add-only'||!isId(manifest.sourceBatchId)||
      !Array.isArray(manifest.targets)||manifest.targets.length>500||
      manifest.targets.some(t=>!isId(t.creatorId)||!isId(t.recordId)||!Number.isInteger(t.sourceRank)||t.sourceRank<1)||
      new Set(manifest.targets.map(t=>t.creatorId)).size!==manifest.targets.length||
      new Set(manifest.targets.map(t=>t.recordId)).size!==manifest.targets.length||
      typeof checkpointPath!=='string'||!path.isAbsolute(checkpointPath)||
      (!prepareOnly&&typeof executeOne!=='function')) fail('ARGUMENTS');
  await fs.mkdir(path.dirname(checkpointPath),{recursive:true,mode:0o700});
  return await withRecordProcessLock(`daily-add-contact-checkpoint:${path.resolve(checkpointPath)}`,async()=>{
    const manifestDigest=digest(manifest);
    let state;
    try{state=JSON.parse(await fs.readFile(checkpointPath,'utf8'));}catch(error){if(error.code!=='ENOENT')fail('CHECKPOINT_UNREADABLE');}
    if(state){
      if(state.version!==1||state.mode!=='daily-add-only'||state.sourceBatchId!==manifest.sourceBatchId||
          state.manifestDigest!==manifestDigest||state.entries?.length!==manifest.targets.length||
          state.entries.some(e=>!e||!['pending','confirmed','error','blocked','in_flight','uncertain'].includes(e.state)||
            (e.state==='confirmed'&&(!CONTACT_TERMINAL.has(e.outcome)&&e.outcome!=='error'||e.readbackVerified!==true))||
            (e.state==='error'&&e.outcome!=='error')||(['in_flight','uncertain','blocked','error'].includes(e.state)&&!isId(e.attemptId))))
        fail('CHECKPOINT_MISMATCH');
    }else{
      state={version:1,mode:'daily-add-only',sourceBatchId:manifest.sourceBatchId,manifestDigest,
        entries:manifest.targets.map(()=>({state:'pending'}))};
      await writePrivateJson(checkpointPath,state);
    }
    if(resumeBlocked&&state.sessionBlock){delete state.sessionBlock;await writePrivateJson(checkpointPath,state);}
    const publish=async index=>{
      if(typeof onProgress==='function')try{
        const entry=state.entries[index]||{};
        await onProgress({index,report:summarizeDailyAddContacts(state),mode:'daily-contact',
          event:'row_checkpointed',state:entry.state,outcome:entry.outcome||'',reason:entry.reason||'',
          writeState:['uncertain','in_flight'].includes(entry.state)?'uncertain':undefined,
          sourceBatchId:state.sourceBatchId,targetCount:state.entries.length,checkpointPreserved:true,
          attemptId:entry.attemptId||''});
      }catch{}
    };
    if(prepareOnly)return summarizeDailyAddContacts(state);
    for(let i=0;i<manifest.targets.length;i++){
      let entry=state.entries[i];
      if(entry.state==='confirmed'||(entry.state==='error'&&!retryErrors))continue;
      if(typeof shouldContinue==='function'&&await shouldContinue({index:i,report:summarizeDailyAddContacts(state)})===false)break;
      const target=manifest.targets[i];
      if(['in_flight','uncertain'].includes(entry.state)){
        let result;try{result=typeof reconcileOne==='function'?await reconcileOne({...target,sourceBatchId:manifest.sourceBatchId,attemptId:entry.attemptId}):null;}catch{}
        state.entries[i]=normalizedContactResult(result,entry.attemptId,target);
        if(state.entries[i].sessionBlocked)state.sessionBlock={outcome:state.entries[i].blockedOutcome,
          reason:state.entries[i].reason||'UNCLASSIFIED_ERROR'};
        await writePrivateJson(checkpointPath,state);await publish(i);
        if(state.entries[i].state==='blocked'||(state.sessionBlock&&!resumeBlocked))break;
        continue;
      }
      if(state.sessionBlock&&!resumeBlocked)break;
      if(entry.state==='blocked'&&!resumeBlocked)break;
      const attemptId=randomUUID();
      state.entries[i]={state:'in_flight',attemptId};await writePrivateJson(checkpointPath,state);
      let result;try{result=await executeOne({...target,sourceBatchId:manifest.sourceBatchId,attemptId});}catch{}
      state.entries[i]=normalizedContactResult(result,attemptId,target);
      if(state.entries[i].sessionBlocked)state.sessionBlock={outcome:state.entries[i].blockedOutcome,
        reason:state.entries[i].reason||'UNCLASSIFIED_ERROR'};
      if(['auth_blocked','risk_blocked'].includes(result?.outcome))state.sessionBlock={outcome:result.outcome,
        reason:state.entries[i].reason||'UNCLASSIFIED_ERROR'};
      await writePrivateJson(checkpointPath,state);await publish(i);
      if(state.entries[i].state==='blocked'||(state.sessionBlock&&!resumeBlocked))break;
    }
    return summarizeDailyAddContacts(state);
  });
}
