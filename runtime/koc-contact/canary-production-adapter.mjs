import fs from 'node:fs/promises';
import {revealCategoryRestrictionEvidence} from './buyin-contact-flow.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from '../shared/child-process.mjs';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR, writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {LarkBaseClient,FEISHU_ROUTE} from '../koc-roster/lark-writer.mjs';
import {exactTextCellValue,sameCell} from './run-original-background-feishu-write.mjs';
import {patchCurrentContactAttempt} from './contact-patch-adapter.mjs';
import {buildCanaryManifest, ORIGINAL_BATCH_ID, validateCanaryManifest} from './canary-batch.mjs';
import {classifyRankedRows, pageFingerprint, ROSTER_SCOPE_KEY, ROSTER_SCOPE_LABEL} from '../koc-roster/roster-domain.mjs';

export const PRODUCTION_STATE_DIR=path.join(DEFAULT_STATE_DIR,'contact-canary-original-20260923');
export const EXTRA_TARGET=Object.freeze({creatorId:'LEGACY_EXTRA_DISABLED',recordId:'LEGACY_RECORD_DISABLED',
  sourceBatchId:ORIGINAL_BATCH_ID,sourceRank:null,extraAuthorized:true});
const LEGACY_QUALIFICATION_SCOPE_KEY='chanmama|萌宠|宠物猫|视频达人|近30天|视频销售额:desc|merchant-filter:v3';
const ROW_RUNNER=fileURLToPath(new URL('./run-original-background-feishu-write.mjs',import.meta.url));
const SAFE_CODE=/^[A-Z][A-Z0-9_]{0,100}$/u;
const safeCode=value=>SAFE_CODE.test(value||'')?value:'UNCLASSIFIED_ERROR';
const bools=(o,keys)=>keys.every(k=>o?.[k]===true);
const authReasons=new Set(['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED','LARK_USER_TOKEN_NEEDS_REFRESH','LARK_USER_IDENTITY_NOT_VERIFIED']);
const riskReasons=new Set(['SECURITY_CHALLENGE','RATE_LIMITED','QUOTA_EXCEEDED']);
const SAFE_PREFLIGHT_PHASES=new Set(['recovery_preflight','feishu_auth','schema','source_checkpoint',
  'record_mapping','browser_and_write']);
const SAFE_ERROR_TYPES=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']);
const sha256=value=>createHash('sha256').update(value).digest('hex');
const validDigest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);

async function readPrivateSourceBytes(filePath,code,maxBytes=32*1024*1024) {
  let stat;
  try { stat=await fs.lstat(filePath); } catch { throw new Error(`CANARY_${code}_UNAVAILABLE`); }
  if (!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>maxBytes) {
    throw new Error(`CANARY_${code}_UNSAFE`);
  }
  try { return await fs.readFile(filePath); } catch { throw new Error(`CANARY_${code}_UNAVAILABLE`); }
}

function parseJson(bytes,code) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`CANARY_${code}_INVALID`); }
}

function sourceRowsFromCheckpoint(checkpoint,sourceBatchId) {
  if (!checkpoint||checkpoint.batchId!==sourceBatchId||
      ![ROSTER_SCOPE_KEY,LEGACY_QUALIFICATION_SCOPE_KEY].includes(checkpoint.scopeKey)||
      checkpoint.scopeLabel!==ROSTER_SCOPE_LABEL||!Array.isArray(checkpoint.pages)||!checkpoint.pages.length||
      !['target_reached','source_exhausted'].includes(checkpoint.status)||checkpoint.sortEvidence?.verified!==true||
      (checkpoint.status==='target_reached'&&checkpoint.targetReached!==true)||
      (checkpoint.status==='source_exhausted'&&checkpoint.sourceComplete!==true)) {
    throw new Error('CANARY_SOURCE_MANIFEST_CHECKPOINT_INVALID');
  }
  const rows=[];
  for (let index=0;index<checkpoint.pages.length;index+=1) {
    const page=checkpoint.pages[index];
    if (page?.page!==index+1||!Array.isArray(page.rows)||!page.rows.length||
        page.fingerprint!==pageFingerprint(page.rows)) throw new Error('CANARY_SOURCE_MANIFEST_CHECKPOINT_INVALID');
    rows.push(...page.rows);
  }
  if (checkpoint.rawRowCount!==undefined&&checkpoint.rawRowCount!==rows.length) {
    throw new Error('CANARY_SOURCE_MANIFEST_CHECKPOINT_INVALID');
  }
  return rows;
}

function normalizeRecordIndex(index) {
  const rows=index instanceof Map?[...index.entries()].map(([creatorId,value])=>
    typeof value==='string'?{creatorId,recordId:value}:{creatorId,...value}):
    Array.isArray(index)?index:
      index&&typeof index==='object'?Object.entries(index).map(([creatorId,value])=>
        typeof value==='string'?{creatorId,recordId:value}:{creatorId,...value}):null;
  if (!rows) throw new Error('CANARY_QUALIFIED_BASE_INDEX_INVALID');
  const byCreatorId=new Map(),recordIds=new Set();
  for (const row of rows) {
    const creatorId=typeof row?.creatorId==='string'?row.creatorId.trim():'';
    const recordId=typeof row?.recordId==='string'?row.recordId.trim():'';
    if (!creatorId||!recordId) throw new Error('CANARY_QUALIFIED_BASE_INDEX_INVALID');
    if (byCreatorId.has(creatorId)) throw new Error('CANARY_QUALIFIED_BASE_INDEX_DUPLICATE_CREATOR');
    if (recordIds.has(recordId)) throw new Error('CANARY_QUALIFIED_BASE_INDEX_DUPLICATE_RECORD');
    byCreatorId.set(creatorId,recordId);recordIds.add(recordId);
  }
  return byCreatorId;
}

/** Validate the complete live creatorId→recordId index proof before qualified migration. */
export function verifyQualifiedRecordIndex({targets,index}={}) {
  if (!Array.isArray(targets)||targets.length!==500) throw new Error('CANARY_QUALIFIED_BASE_INDEX_TARGETS_INVALID');
  const byCreatorId=normalizeRecordIndex(index);
  for (const target of targets) {
    if (byCreatorId.get(target.creatorId)!==target.recordId) {
      throw new Error('CANARY_QUALIFIED_BASE_INDEX_MAPPING_MISMATCH');
    }
  }
  return {verified:true,targetCount:targets.length,targetPairsSha256:sha256(JSON.stringify(targets))};
}

/** Build a private qualification manifest; recordIndex must come from a read-only current Base index. */
export function buildQualifiedSourceManifest({checkpoint,receipt,recordIndex,checkpointBytes,receiptBytes}={}) {
  if (!receipt||receipt.batchId!==ORIGINAL_BATCH_ID) throw new Error('CANARY_SOURCE_MANIFEST_RECEIPT_INVALID');
  const rows=sourceRowsFromCheckpoint(checkpoint,ORIGINAL_BATCH_ID);
  let oldManifest;
  try { oldManifest=buildCanaryManifest(receipt); } catch { throw new Error('CANARY_SOURCE_MANIFEST_RECEIPT_INVALID'); }
  let classification;
  try { classification=classifyRankedRows(rows,{existingIds:Object.keys(receipt.creatorRecordIds||{})}); }
  catch { throw new Error('CANARY_SOURCE_MANIFEST_DUPLICATE_SOURCE'); }
  if (classification.duplicates.length||new Set(rows.map(row=>row.sourceRank)).size!==rows.length) {
    throw new Error('CANARY_SOURCE_MANIFEST_DUPLICATE_SOURCE');
  }
  const rankedRows=[...classification.eligible,...classification.existing]
    .sort((a,b)=>a.sourceRank-b.sourceRank||a.creatorId.localeCompare(b.creatorId)).slice(0,500);
  if (rankedRows.length!==500) throw new Error('CANARY_SOURCE_MANIFEST_MAPPING_INCOMPLETE');
  const byCreatorId=normalizeRecordIndex(recordIndex);
  const receiptOutcomes=new Map();
  for (const outcome of receipt.outcomes||[]) {
    if (!receiptOutcomes.has(outcome.creatorId)) receiptOutcomes.set(outcome.creatorId,[]);
    receiptOutcomes.get(outcome.creatorId).push(outcome);
  }
  const targets=[],supplementalTargets=[];
  for (const row of rankedRows) {
    const recordId=receipt.creatorRecordIds?.[row.creatorId];
    const evidence=receiptOutcomes.get(row.creatorId)||[];
    const indexRecordId=byCreatorId.get(row.creatorId);
    if (!indexRecordId) throw new Error('CANARY_QUALIFIED_BASE_INDEX_MAPPING_MISSING');
    if (recordId&&evidence.length===1&&evidence[0].recordId===recordId&&evidence[0].readbackVerified===true) {
      if (recordId!==indexRecordId) throw new Error('CANARY_QUALIFIED_BASE_INDEX_MAPPING_MISMATCH');
      targets.push({creatorId:row.creatorId,recordId,sourceRank:row.sourceRank});
      continue;
    }
    if (recordId!==undefined||evidence.length!==0) throw new Error('CANARY_SOURCE_MANIFEST_RECEIPT_MAPPING_UNVERIFIED');
    targets.push({creatorId:row.creatorId,recordId:indexRecordId,sourceRank:row.sourceRank});
    supplementalTargets.push({creatorId:row.creatorId,recordId:indexRecordId,sourceRank:row.sourceRank});
  }
  const targetPairs=new Set(targets.map(row=>`${row.creatorId}\u0000${row.recordId}`));
  const excludedOldTargets=oldManifest.targets.filter(target=>!targetPairs.has(`${target.creatorId}\u0000${target.recordId}`));
  const sourceExcluded=new Set(classification.excluded.map(row=>row.creatorId));
  if (excludedOldTargets.some(target=>!sourceExcluded.has(target.creatorId))) {
    throw new Error('CANARY_SOURCE_MANIFEST_EXCLUSION_UNVERIFIED');
  }
  const checkpointSourceBytes=checkpointBytes??Buffer.from(JSON.stringify(checkpoint));
  const receiptSourceBytes=receiptBytes??Buffer.from(JSON.stringify(receipt));
  const manifest={version:1,kind:'qualified-source',sourceBatchId:ORIGINAL_BATCH_ID,
    sourceCheckpointSha256:sha256(checkpointSourceBytes),sourceReceiptSha256:sha256(receiptSourceBytes),
    targetPairsSha256:sha256(JSON.stringify(targets)),targets,supplementalTargets,excludedOldTargets};
  validateCanaryManifest(manifest);
  return manifest;
}

function verifyQualifiedSource(checkpoint,receipt,manifest) {
  const rows=sourceRowsFromCheckpoint(checkpoint,manifest.sourceBatchId);
  let oldManifest;
  try { oldManifest=buildCanaryManifest(receipt); } catch { throw new Error('CANARY_SOURCE_MANIFEST_RECEIPT_INVALID'); }
  let classification;
  try { classification=classifyRankedRows(rows,{existingIds:Object.keys(receipt.creatorRecordIds||{})}); }
  catch { throw new Error('CANARY_SOURCE_MANIFEST_DUPLICATE_SOURCE'); }
  if (classification.duplicates.length||new Set(rows.map(row=>row.sourceRank)).size!==rows.length) {
    throw new Error('CANARY_SOURCE_MANIFEST_DUPLICATE_SOURCE');
  }
  const sourceById=new Map([...classification.eligible,...classification.existing].map(row=>[row.creatorId,row]));
  const outcomesById=new Map();
  for (const outcome of receipt.outcomes||[]) {
    if (!outcomesById.has(outcome.creatorId)) outcomesById.set(outcome.creatorId,[]);
    outcomesById.get(outcome.creatorId).push(outcome);
  }
  const rankedRows=[...classification.eligible,...classification.existing]
    .sort((a,b)=>a.sourceRank-b.sourceRank||a.creatorId.localeCompare(b.creatorId)).slice(0,500);
  if (rankedRows.length!==500||!Array.isArray(manifest.supplementalTargets)||!validDigest(manifest.targetPairsSha256)) {
    throw new Error('CANARY_SOURCE_MANIFEST_MAPPING_INCOMPLETE');
  }
  if (manifest.targetPairsSha256!==sha256(JSON.stringify(manifest.targets))) {
    throw new Error('CANARY_SOURCE_MANIFEST_TARGET_PAIR_DIGEST_MISMATCH');
  }
  const supplementsById=new Map();
  for (const target of manifest.supplementalTargets) {
    if (!target||typeof target.creatorId!=='string'||typeof target.recordId!=='string'||
        !Number.isInteger(target.sourceRank)||supplementsById.has(target.creatorId)) {
      throw new Error('CANARY_SOURCE_MANIFEST_SUPPLEMENTAL_MAPPING_INVALID');
    }
    supplementsById.set(target.creatorId,target);
  }
  const mapped=[];
  for (let index=0;index<rankedRows.length;index+=1) {
    const row=rankedRows[index];
    const manifestTarget=manifest.targets[index];
    if (manifestTarget?.creatorId!==row.creatorId||manifestTarget.sourceRank!==row.sourceRank) {
      throw new Error('CANARY_SOURCE_MANIFEST_RANKING_MISMATCH');
    }
    const recordId=receipt.creatorRecordIds?.[row.creatorId];
    const evidence=outcomesById.get(row.creatorId)||[];
    const supplement=supplementsById.get(row.creatorId);
    if (recordId&&evidence.length===1&&evidence[0].recordId===recordId&&evidence[0].readbackVerified===true) {
      if (supplement||manifestTarget.recordId!==recordId) throw new Error('CANARY_SOURCE_MANIFEST_RANKING_MISMATCH');
      mapped.push({creatorId:row.creatorId,recordId,sourceRank:row.sourceRank});
      continue;
    }
    if (recordId!==undefined||evidence.length!==0||!supplement||supplement.recordId!==manifestTarget.recordId||
        supplement.sourceRank!==row.sourceRank) throw new Error('CANARY_SOURCE_MANIFEST_RECEIPT_MAPPING_UNVERIFIED');
    mapped.push({creatorId:row.creatorId,recordId:manifestTarget.recordId,sourceRank:row.sourceRank});
  }
  if (supplementsById.size!==mapped.filter(row=>supplementsById.has(row.creatorId)).length||
      new Set(mapped.map(row=>row.recordId)).size!==mapped.length||mapped.length!==500) {
    throw new Error('CANARY_SOURCE_MANIFEST_MAPPING_INCOMPLETE');
  }
  const expected=mapped;
  const sameTargets=(left,right)=>left.length===right.length&&left.every((row,index)=>
    row.creatorId===right[index]?.creatorId&&row.recordId===right[index]?.recordId&&
    row.sourceRank===right[index]?.sourceRank);
  if (!sameTargets(manifest.targets,expected)) throw new Error('CANARY_SOURCE_MANIFEST_RANKING_MISMATCH');

  const excludedPairs=new Map(manifest.excludedOldTargets.map(row=>[`${row.creatorId}\u0000${row.recordId}`,row]));
  const targetPairs=new Set(manifest.targets.map(row=>`${row.creatorId}\u0000${row.recordId}`));
  const excludedSourceIds=new Set(classification.excluded.map(row=>row.creatorId));
  for (const target of oldManifest.targets) {
    const key=`${target.creatorId}\u0000${target.recordId}`;
    if (!targetPairs.has(key)) {
      if (!excludedPairs.has(key)||!excludedSourceIds.has(target.creatorId)) {
        throw new Error('CANARY_SOURCE_MANIFEST_EXCLUSION_UNVERIFIED');
      }
    } else if (excludedPairs.has(key)) throw new Error('CANARY_SOURCE_MANIFEST_EXCLUSION_INVALID');
  }
  for (const [key,target] of excludedPairs) {
    if (!oldManifest.targets.some(old=>`${old.creatorId}\u0000${old.recordId}`===key)||
        !excludedSourceIds.has(target.creatorId)) throw new Error('CANARY_SOURCE_MANIFEST_EXCLUSION_UNVERIFIED');
  }
  const rowsForRunner=manifest.targets.map(target=>{
    const source=sourceById.get(target.creatorId);
    return {...target,creatorName:typeof source?.creatorName==='string'?source.creatorName:''};
  });
  return {oldManifest,receipt,rows:rowsForRunner};
}

export async function loadQualifiedSourceManifest({sourceManifestPath,sourceStateDir=DEFAULT_STATE_DIR}={}) {
  if (typeof sourceManifestPath!=='string'||!sourceManifestPath.trim()) throw new Error('CANARY_SOURCE_MANIFEST_PATH_REQUIRED');
  const resolved=path.resolve(sourceManifestPath);
  const manifestBytes=await readPrivateSourceBytes(resolved,'SOURCE_MANIFEST',1024*1024);
  const manifest=parseJson(manifestBytes,'SOURCE_MANIFEST');
  try { validateCanaryManifest(manifest); } catch { throw new Error('CANARY_SOURCE_MANIFEST_INVALID'); }
  if (manifest.kind!=='qualified-source'||!validDigest(manifest.sourceCheckpointSha256)||
      !validDigest(manifest.sourceReceiptSha256)) throw new Error('CANARY_SOURCE_MANIFEST_INVALID');
  const checkpointBytes=await readPrivateSourceBytes(path.join(sourceStateDir,`${manifest.sourceBatchId}.checkpoint.json`),
    'SOURCE_MANIFEST_CHECKPOINT');
  const receiptBytes=await readPrivateSourceBytes(path.join(sourceStateDir,`${manifest.sourceBatchId}.write-receipt.json`),
    'SOURCE_MANIFEST_RECEIPT');
  if (sha256(checkpointBytes)!==manifest.sourceCheckpointSha256||sha256(receiptBytes)!==manifest.sourceReceiptSha256) {
    throw new Error('CANARY_SOURCE_MANIFEST_STALE');
  }
  const checkpoint=parseJson(checkpointBytes,'SOURCE_MANIFEST_CHECKPOINT');
  const receipt=parseJson(receiptBytes,'SOURCE_MANIFEST_RECEIPT');
  const verified=verifyQualifiedSource(checkpoint,receipt,manifest);
  return {...verified,manifest,manifestFileSha256:sha256(manifestBytes),
    sourceRows:verified.rows,sourceCheckpointSha256:manifest.sourceCheckpointSha256,
    sourceReceiptSha256:manifest.sourceReceiptSha256};
}

export function translateSingleReceipt(receipt,request,{historical=false}={}) {
  const base={attemptId:request.attemptId};
  if(receipt?.status==='preflight_failed'){
    const reason=safeCode(receipt.reason);
    return {...base,outcome:authReasons.has(reason)?'auth_blocked':riskReasons.has(reason)?'risk_blocked':'error',
      writeState:receipt.externalWritePerformed===false?'not_written':'uncertain',reason,
      ...(SAFE_PREFLIGHT_PHASES.has(receipt.phase)?{phase:receipt.phase}:{}),
      ...(SAFE_ERROR_TYPES.has(receipt.errorType)?{errorType:receipt.errorType}:{})};
  }
  if(receipt?.creatorId!==request.creatorId||receipt?.recordId!==request.recordId||
    receipt?.sourceBatchId!==request.sourceBatchId)return {...base,outcome:'error',writeState:'uncertain',reason:'RECEIPT_TARGET_MISMATCH'};
  const w=receipt.write||{},b=receipt.browser||{},s=b.searchDiagnostics||{};
  const protectedOK=bools(w,['sameCreatorIdReadback','nonContactFieldsUnchanged','humanFieldsUnchanged']);
  const baseline=typeof receipt.hadWeChatBefore==='boolean'?receipt.hadWeChatBefore:
    typeof w.hadWeChatBefore==='boolean'?w.hadWeChatBefore:
    // This one historical successful sample used the then-mandatory empty-contact guard;
    // supervisor reviewed its real receipt and accepted it as the second new value.
    historical&&request.creatorId==='li719395528'&&receipt.completedAt==='2026-09-24T07:19:09.588Z'?false:null;
  const browserComplete=bools(b,['formalIdMatch','profileOpened','wechatRowUnique','revealed','nonMaskedValue',
    'finalBackgroundGuard','errorFree'])&&b.identityProof==='API_FEED_ID_MATCH'&&
    s.submittedAfterActivation===true&&s.exactIdMatchCount===1&&s.uidPresent===true&&
    s.contactMarkerState==='present'&&s.failureBranch==='passed';
  const outerRecovery=receipt.status==='verification_incomplete'&&protectedOK&&browserComplete&&
    bools(w,['writerInvoked','postReadbackVerified'])&&w.sharedWriterReadbackVerified===false&&
    ['compare','readback'].includes(w.sharedWriterStage)&&w.sharedWriterErrorCode==='LARK_READBACK_MISMATCH'&&
    w.failureWriterInvoked!==true&&w.failureWriteSubmitted!==true&&typeof baseline==='boolean';
  if((receipt.status==='updated_readback_verified'&&protectedOK&&browserComplete&&
    bools(w,['writerInvoked','sharedWriterReadbackVerified','postReadbackVerified'])&&typeof baseline==='boolean')||outerRecovery){
    return {...base,outcome:'success',writeState:'verified',recordMappingVerified:true,readbackVerified:true,
      originalAttemptSourceVerified:true,protectedFieldsUnchanged:true,hadWeChatBefore:baseline,currentValueVerified:true,
      ...(outerRecovery?{recoveryMode:'outer_same_attempt_readback_verified',sharedWriterReadbackVerified:false}:{}),
      reason:'CONTACT_VALUE_VERIFIED'};
  }
  const reason=safeCode(b.reason);
  let outcome=authReasons.has(reason)?'auth_blocked':riskReasons.has(reason)?'risk_blocked':'error';
  const validQuery=s.submittedAfterActivation===true&&s.httpStatusCategory==='2xx'&&s.businessCodeCategory==='zero'&&
    b.responseEvidence?.authPromptLatched!==true&&(b.responseEvidence?.explicitAuthResponseCount||0)===0;
  if(validQuery&&s.exactIdMatchCount===1&&s.contactMarkerState==='absent'&&
    ['CONTACT_NOT_SHOWN','CONTACT_LABEL_NOT_PRESENT'].includes(reason))outcome='not_shown';
  const channel=b.channelDiagnostics||{};
  const phoneOnly=channel.observedReady===true&&
    bools(channel,['profileUidConfirmed','contextStable','targetHidden','authHealthy'])&&
    Number.isInteger(channel.contactItemCount)&&
    channel.contactItemCount>0&&channel.visibleContactItemCount===channel.contactItemCount&&
    channel.wechatLocatorCount===0&&channel.visibleWechatLocatorCount===0&&
    channel.phoneLocatorCount===channel.contactItemCount&&
    channel.visiblePhoneLocatorCount===channel.contactItemCount&&
    Number.isInteger(channel.stableSamples)&&channel.stableSamples>=3;
  if(validQuery&&reason==='WECHAT_NOT_PROVIDED'&&b.identityProof==='API_FEED_ID_MATCH'&&
    b.formalIdMatch===true&&b.profileOpened===true&&s.exactIdMatchCount===1&&s.uidPresent===true&&
    s.contactMarkerState==='present'&&s.failureBranch==='passed'&&phoneOnly)outcome='not_shown';
  if(validQuery&&s.exactIdMatchCount===0&&reason==='TARGET_NOT_FOUND')outcome='no_match';
  const failureVerified=protectedOK&&bools(w,['failureStatusRecorded','oldWeChatPreserved','lastSuccessPreserved','sourcePreserved'])&&
    bools(w,['failurePatchStatusMatches','failurePatchAttemptTimeMatches','failurePatchErrorCodeMatches']);
  if(failureVerified&&reason==='CONTACT_CATEGORY_RESTRICTED'&&receipt.failureAttemptExpected?.status==='forbidden_by_platform'&&validQuery&&b.formalIdMatch===true&&b.profileOpened===true&&revealCategoryRestrictionEvidence(b.revealDiagnostics))outcome='forbidden_by_platform';
  if(failureVerified)return {...base,outcome,writeState:'verified',recordMappingVerified:true,readbackVerified:true,
    originalAttemptSourceVerified:true,protectedFieldsUnchanged:true,reason};
  const submitted=w.writerInvoked===true||w.failureWriteSubmitted===true;
  return {...base,outcome,writeState:submitted?'uncertain':'not_written',reason};
}

function safeReceiptHistorySnapshot(receipt,target,historyIndex) {
  const originalAttemptId=typeof receipt.attemptId==='string'&&receipt.attemptId.length<200?receipt.attemptId:null;
  const importAttemptId=`history-${target.sourceRank}-${historyIndex}`;
  const translated=translateSingleReceipt(receipt,{...target,sourceBatchId:ORIGINAL_BATCH_ID,attemptId:importAttemptId},
    {historical:true});
  const result={outcome:translated.outcome,writeState:translated.writeState};
  for(const key of ['reason','recordMappingVerified','readbackVerified','originalAttemptSourceVerified',
    'protectedFieldsUnchanged','hadWeChatBefore','currentValueVerified','recoveryMode','sharedWriterReadbackVerified']){
    const value=translated[key];
    if(typeof value==='boolean'||key==='reason'&&typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(value)||
        key==='recoveryMode'&&value==='outer_same_attempt_readback_verified')result[key]=value;
  }
  const completedAt=typeof receipt.completedAt==='string'&&receipt.completedAt.length<=128&&
    /^\d{4}-\d\d-\d\dT[^\r\n\u0000]+$/u.test(receipt.completedAt)?receipt.completedAt:null;
  const receiptStatuses=new Set(['attempt_failed_old_contact_preserved','not_shown_readback_reconciled',
    'preflight_failed','updated_readback_verified','verification_incomplete']);
  const status=receiptStatuses.has(receipt.status)?receipt.status:null;
  return {sourceBatchId:ORIGINAL_BATCH_ID,creatorId:target.creatorId,recordId:target.recordId,
    sourceRank:target.sourceRank,attemptId:originalAttemptId,completedAt,
    status,result};
}

async function correctedRank20(request,stateDir){
  if(request.creatorId!=='LEGACY_CORRECTION_DISABLED'||request.recordId!=='LEGACY_CORRECTION_RECORD_DISABLED')return null;
  const name='koc-contact-corrected-20260923T152555Z-rank-20-LEGACY_CORRECTION_DISABLED-2026-09-24T07-31-32-043Z.json';
  const r=JSON.parse(await fs.readFile(path.join(stateDir,name),'utf8'));
  if(r.creatorId!==request.creatorId||r.recordId!==request.recordId||r.status!=='corrected_readback_verified'||
    !bools(r.correction,['writerInvoked','patchSubmitted','sameAttemptTimePreserved'])||
    !bools(r.correction.outerReadback,['recordIdMatches','creatorIdMatches','statusMatches','attemptTimeMatches','errorCodeMatches','otherFieldsUnchanged']))return null;
  return {attemptId:request.attemptId,outcome:'error',writeState:'verified',reason:'AUTH_OR_PERMISSION_UNRESOLVED',
    recordMappingVerified:true,readbackVerified:true,originalAttemptSourceVerified:true,protectedFieldsUnchanged:true};
}

export async function loadOriginalQueue({stateDir=DEFAULT_STATE_DIR,sourceManifestPath,sourceStateDir=stateDir}={}) {
  let receipt,manifest,qualified=null;
  if (sourceManifestPath!==undefined) {
    qualified=await loadQualifiedSourceManifest({sourceManifestPath,sourceStateDir});
    receipt=qualified.receipt;
    manifest=qualified.manifest;
  } else {
    receipt=JSON.parse(await fs.readFile(path.join(stateDir,`${ORIGINAL_BATCH_ID}.write-receipt.json`),'utf8'));
    manifest=buildCanaryManifest(receipt);
  }
  const latest=new Map();
  const receiptHistory=[];
  const importTargets=qualified
    ?[...new Map([...qualified.oldManifest.targets,...manifest.targets].map(target=>
      [`${target.creatorId}\u0000${target.recordId}`,target])).values()]
    :manifest.targets;
  const importPairs=new Set(importTargets.map(target=>`${target.creatorId}\u0000${target.recordId}`));
  const excludedPairs=new Set(qualified?manifest.excludedOldTargets.map(target=>`${target.creatorId}\u0000${target.recordId}`):[]);
  for(const name of (await fs.readdir(stateDir)).filter(n=>n.startsWith(`koc-contact-${ORIGINAL_BATCH_ID}-rank-`)&&n.endsWith('.json'))){
    const bytes=await fs.readFile(path.join(stateDir,name));
    const r=JSON.parse(bytes.toString('utf8'));
    const key=`${r.creatorId}\u0000${r.recordId}`;
    if(!importPairs.has(key))continue;
    if(excludedPairs.has(key)){
      const target=qualified.oldManifest.targets.find(item=>item.creatorId===r.creatorId&&item.recordId===r.recordId);
      if(!target||r.sourceRank!==target.sourceRank)throw new Error('CANARY_EXCLUDED_RECEIPT_HISTORY_IDENTITY_MISMATCH');
      receiptHistory.push({creatorId:r.creatorId,recordId:r.recordId,sourceRank:r.sourceRank,
        receiptFile:name,receiptSha256:sha256(bytes),
        receiptSnapshot:safeReceiptHistorySnapshot(r,target,receiptHistory.length+1)});
    }
    if(!latest.has(key)||r.completedAt>latest.get(key).receipt.completedAt)latest.set(key,{receipt:r,name});
  }
  const initialResults=[];
  for(const target of importTargets){
    const found=latest.get(`${target.creatorId}\u0000${target.recordId}`);if(!found)continue;
    const request={...target,sourceBatchId:ORIGINAL_BATCH_ID,attemptId:`import-${target.sourceRank}`};
    initialResults.push({...target,result:translateSingleReceipt(found.receipt,request,{historical:true}),receiptFile:found.name});
  }
  let recovery=null;
  try { recovery=JSON.parse(await fs.readFile(path.join(stateDir,'koc-contact-b2-LEGACY_REVIEWED_CREATOR_DISABLED-20260924-reconciliation-reviewed.json'),'utf8')); }
  catch (error) { if (!qualified || error?.code!=='ENOENT') throw error; }
  const limitedPath=path.join(stateDir,'koc-contact-reconciled-2026-09-24T07-18-00-029Z.json');
  let limited=null;
  try { limited=JSON.parse(await fs.readFile(limitedPath,'utf8')); }
  catch (error) { if (!qualified || error?.code!=='ENOENT') throw error; }
  if(limited?.creatorId==='LEGACY_RECOVERY_DISABLED'&&limited.recordId==='LEGACY_RECOVERY_RECORD_DISABLED'&&
    limited.status==='not_shown_readback_reconciled'&&
    bools(limited.observed,['recordIdMatches','creatorIdMatches','statusMatches','errorMatches',
      'attemptTimestampValid','attemptMinuteMatchesOriginalReceiptCompletion','lastSuccessPreserved','sourcePreserved',
      'nonContactFieldsUnchanged','humanFieldsUnchanged'])&&limited.browserAttempt?.contactMarkerState==='absent'){
    const index=initialResults.findIndex(r=>r.creatorId===limited.creatorId);
    const seed={creatorId:limited.creatorId,recordId:limited.recordId,result:{attemptId:'import-reviewed-rank12',
      outcome:'not_shown',writeState:'verified',recordMappingVerified:true,readbackVerified:true,
      protectedFieldsUnchanged:true,originalAttemptSourceVerified:false,reviewedRecoveryAccepted:true,
      reason:'CONTACT_NOT_SHOWN'}};
    if(index>=0)initialResults[index]=seed;else initialResults.push(seed);
  }
  let corrected=null;
  try { corrected=await correctedRank20({creatorId:'LEGACY_CORRECTION_DISABLED',recordId:'LEGACY_CORRECTION_RECORD_DISABLED',attemptId:'import-20'},stateDir); }
  catch (error) { if (!qualified || error?.code!=='ENOENT') throw error; }
  const correctedIndex=initialResults.findIndex(r=>r.creatorId==='LEGACY_CORRECTION_DISABLED');
  if(corrected&&correctedIndex>=0)initialResults[correctedIndex].result=corrected;
  return {manifest,initialResults,reviewedRecovery:recovery,
    ...(qualified ? {migration:{previousManifest:qualified.oldManifest,sourceManifestSha256:qualified.manifestFileSha256,
      receiptHistory}} : {})};
}

async function spawnOne(request){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[ROW_RUNNER],{cwd:fileURLToPath(new URL('..',import.meta.url)),
      env:{...process.env,DEBUG:'',PWDEBUG:'',KOC_CREATOR_ID:request.creatorId,KOC_EXPECTED_RECORD_ID:request.recordId,
        KOC_SOURCE_BATCH_ID:request.sourceBatchId,KOC_EXPECTED_SOURCE_RANK:request.sourceRank===null?'':String(request.sourceRank),
        KOC_QUALIFIED_SOURCE_MANIFEST:request.qualifiedSourceManifestPath||'',
        KOC_QUALIFIED_SOURCE_MANIFEST_SHA256:request.qualifiedSourceManifestSha256||'',
        KOC_ALLOW_EXISTING_WECHAT_REVERIFY:'1',
        KOC_SEARCH_ATTEMPT_LIMIT:String(request.searchAttemptLimit??3),
        KOC_EXTRA_ROW_CREATOR_ID:request.extraAuthorized?request.creatorId:'',
        KOC_EXTRA_ROW_RECORD_ID:request.extraAuthorized?request.recordId:''},stdio:['ignore','pipe','pipe']});
    let stdout='',overflow=false;
    child.stdout.on('data',chunk=>{if(stdout.length+chunk.length<2*1024*1024)stdout+=chunk;else overflow=true;});
    child.stderr.resume(); // never forward raw child output or stderr
    child.on('error',()=>resolve(null));
    child.on('close',()=>{
      if(overflow)return resolve(null);
      let receipt=null;
      for(const line of stdout.trim().split(/\r?\n/u).reverse())try{receipt=JSON.parse(line);break;}catch{}
      resolve(receipt);
    });
  });
}

function readCurrentAttempt(request){
  const payload=new LarkBaseClient({route:FEISHU_ROUTE}).getRecord(request.recordId,
    ['抖音号','本次联系方式状态','联系方式最近尝试','联系方式最近错误']);
  const d=payload?.data??payload;
  if(Array.isArray(d.data)&&Array.isArray(d.fields))return {recordId:d.record_id_list?.[0]||'',
    fields:Object.fromEntries(d.fields.map((name,i)=>[name,d.data[0]?.[i]??null]))};
  if(d.record?.fields)return {recordId:d.record.record_id??d.record.recordId??'',fields:d.record.fields};
  if(d.fields&&!Array.isArray(d.fields))return {recordId:d.record_id??d.recordId??'',fields:d.fields};
  throw new Error('CANARY_READBACK_PROJECTION_INVALID');
}

export function createProductionAdapter({stateDir=PRODUCTION_STATE_DIR,sourceStateDir=DEFAULT_STATE_DIR,
  sourceManifestPath,sourceManifestSha256,invoke=spawnOne,readAttempt=readCurrentAttempt,
  searchAttemptLimit=3,searchAttemptCreatorIds=[]}={}) {
  if(!Number.isInteger(searchAttemptLimit)||searchAttemptLimit<1||searchAttemptLimit>3||
      !Array.isArray(searchAttemptCreatorIds)||new Set(searchAttemptCreatorIds).size!==searchAttemptCreatorIds.length||
      searchAttemptCreatorIds.some(id=>typeof id!=='string'||!id.length||id.length>=200)||
      (searchAttemptLimit<3&&searchAttemptCreatorIds.length===0))throw new Error('CANARY_SEARCH_ATTEMPT_SCOPE_INVALID');
  if(sourceManifestPath!==undefined&&
      (typeof sourceManifestPath!=='string'||!sourceManifestPath.trim())) {
    throw new Error('CANARY_SOURCE_MANIFEST_PATH_REQUIRED');
  }
  const searchAttemptCreatorSet=new Set(searchAttemptCreatorIds);
  const qualifiedManifestPromise=sourceManifestPath!==undefined
    ?loadQualifiedSourceManifest({sourceManifestPath,sourceStateDir}) : null;
  async function qualifiedRequestVerified(request) {
    if (!qualifiedManifestPromise) return true;
    let loaded;
    try { loaded=await qualifiedManifestPromise; } catch { return false; }
    if (sourceManifestSha256&&loaded.manifestFileSha256!==sourceManifestSha256) return false;
    try {
      const currentBytes=await readPrivateSourceBytes(path.resolve(sourceManifestPath),'SOURCE_MANIFEST',1024*1024);
      if (sha256(currentBytes)!==loaded.manifestFileSha256) return false;
      const [checkpointBytes,receiptBytes]=await Promise.all([
        readPrivateSourceBytes(path.join(sourceStateDir,`${loaded.manifest.sourceBatchId}.checkpoint.json`),
          'SOURCE_MANIFEST_CHECKPOINT'),
        readPrivateSourceBytes(path.join(sourceStateDir,`${loaded.manifest.sourceBatchId}.write-receipt.json`),
          'SOURCE_MANIFEST_RECEIPT'),
      ]);
      if (sha256(checkpointBytes)!==loaded.sourceCheckpointSha256||
          sha256(receiptBytes)!==loaded.sourceReceiptSha256) return false;
    } catch { return false; }
    const exactAuthorizedExtra=request.extraAuthorized===true&&request.creatorId===EXTRA_TARGET.creatorId&&
      request.recordId===EXTRA_TARGET.recordId&&request.sourceBatchId===EXTRA_TARGET.sourceBatchId&&
      request.sourceRank===EXTRA_TARGET.sourceRank;
    return request.sourceBatchId===loaded.manifest.sourceBatchId&&(exactAuthorizedExtra||
      loaded.manifest.targets.some(target=>target.creatorId===request.creatorId&&target.recordId===request.recordId&&
        target.sourceRank===request.sourceRank));
  }
  const attemptPath=id=>{
    if(!/^[A-Za-z0-9_-]{1,100}$/u.test(id))throw new Error('CANARY_ATTEMPT_ID_INVALID');
    return path.join(stateDir,'attempts',`${id}.json`);
  };
  async function saveDerived(request,result,receiptFile){
    if(result.recoveryMode!=='outer_same_attempt_readback_verified')return;
    await writePrivateJson(path.join(stateDir,'reconciliations',`${request.attemptId}.json`),{
      creatorId:request.creatorId,recordId:request.recordId,sourceBatchId:request.sourceBatchId,attemptId:request.attemptId,
      receiptFile,result,originalReceiptPreserved:true,externalWritePerformed:false,
      evidenceBasis:'same_attempt_original_six_field_patch_exact_contact_source_and_semantic_dates_with_identity_and_protection',
      reconciledAt:new Date().toISOString()});
  }
  async function executeOne(request){
    if (!await qualifiedRequestVerified(request)) return {attemptId:request.attemptId,outcome:'error',
      writeState:'not_written',reason:'CANARY_SOURCE_MANIFEST_TARGET_MISMATCH'};
    const file=attemptPath(request.attemptId);
    const saved={version:1,creatorId:request.creatorId,recordId:request.recordId,sourceBatchId:request.sourceBatchId,
      sourceRank:request.sourceRank,attemptId:request.attemptId,startedAt:new Date().toISOString()};
    await writePrivateJson(file,saved);
    const invokeRequest={...request,
      ...(searchAttemptCreatorSet.has(request.creatorId)?{searchAttemptLimit}:{}),
      ...(sourceManifestPath!==undefined?{qualifiedSourceManifestPath:sourceManifestPath,
        qualifiedSourceManifestSha256:sourceManifestSha256||''}:{})};
    const receipt=await invoke(invokeRequest);
    const result=translateSingleReceipt(receipt,request);
    const receiptFile=typeof receipt?.receiptPath==='string'&&path.dirname(receipt.receiptPath)===sourceStateDir
      ?path.basename(receipt.receiptPath):null;
    await writePrivateJson(file,{...saved,finishedAt:new Date().toISOString(),receiptFile,result});
    await saveDerived(request,result,receiptFile);
    return result;
  }
  async function reconcileOne(request){
    if (!await qualifiedRequestVerified(request)) return {attemptId:request.attemptId,outcome:'error',
      writeState:'uncertain',reason:'CANARY_SOURCE_MANIFEST_TARGET_MISMATCH'};
    if(request.attemptId==='import-20')return await correctedRank20(request,sourceStateDir);
    let saved;
    try{saved=JSON.parse(await fs.readFile(attemptPath(request.attemptId),'utf8'));}catch{return {attemptId:request.attemptId,outcome:'error',writeState:'uncertain',reason:'ORIGINAL_ATTEMPT_EVIDENCE_UNAVAILABLE'};}
    if(saved.creatorId!==request.creatorId||saved.recordId!==request.recordId||saved.sourceBatchId!==request.sourceBatchId)
      return {attemptId:request.attemptId,outcome:'error',writeState:'uncertain',reason:'ORIGINAL_ATTEMPT_TARGET_MISMATCH'};
    if(saved.result?.writeState==='verified')return saved.result;
    // Read ONLY the already emitted, safe original-run receipt. Never resubmit or
    // re-open a profile to reconstruct an unknown original contact/source value.
    const candidates=(await fs.readdir(sourceStateDir)).filter(n=>(n.startsWith(`koc-contact-${request.sourceBatchId}-rank-`)||n.startsWith(`koc-contact-${request.sourceBatchId}-extra-row-`))&&n.endsWith('.json'));
    const matches=[];
    for(const name of candidates){
      const r=JSON.parse(await fs.readFile(path.join(sourceStateDir,name),'utf8'));
      if(r.creatorId===request.creatorId&&r.recordId===request.recordId&&r.completedAt>=saved.startedAt&&
        (!saved.finishedAt||r.completedAt<=saved.finishedAt))matches.push({...r,_receiptFile:name});
    }
    if(matches.length===1){
      const translated=translateSingleReceipt(matches[0],request);
      if(translated.writeState==='verified'){await saveDerived(request,translated,matches[0]._receiptFile);return translated;}
    }
    // Current authorized Feishu readback, restricted to attempt-system fields.
    // Without exact original expected time AND same-attempt protection evidence,
    // current status alone never proves an unknown contact/source write committed.
    const r=matches.length===1?matches[0]:null;
    const expected=r?.failureAttemptExpected;
    let expectedFields=null;
    if(expected&&expected.status!=='found')try{
      // Reuse the original pure transformation: raw failure reason is not always
      // the stored fixed error code (e.g. an unlisted reason becomes UNKNOWN_ERROR).
      // The injected writer only returns fields; it cannot perform a write.
      expectedFields=await patchCurrentContactAttempt({creatorId:request.creatorId,recordId:request.recordId,
        attempt:{contactStatus:expected.status,contactCheckedAt:expected.checkedAt,errorReason:expected.errorReason},
        writer:async patch=>patch.fields});
      // The receipt's exact submitted safe error text takes precedence over a
      // newer mapper. Mapping changes must never rewrite historical evidence.
      if(typeof expected.actualStoredError==='string'&&expected.actualStoredError.length<=500&&
        !/[\r\n\u0000]/u.test(expected.actualStoredError)){
        expectedFields['联系方式最近错误']=expected.actualStoredError;
      }
    }catch{}
    let diagnostic={readOnlyPerformed:false,identityMatches:false,expectedAttemptAvailable:false,
      statusMatches:false,attemptTimeMatches:false,errorMatches:false,protectionEvidenceAvailable:false};
    try{
      const current=await readAttempt(request);
      const fields=current.fields||{};
      diagnostic={readOnlyPerformed:true,
        identityMatches:current.recordId===request.recordId&&exactTextCellValue(fields['抖音号'])===request.creatorId,
        expectedAttemptAvailable:expectedFields!==null,
        statusMatches:expectedFields!==null&&exactTextCellValue(fields['本次联系方式状态'])===expectedFields['本次联系方式状态'],
        attemptTimeMatches:expectedFields!==null&&sameCell('联系方式最近尝试',fields['联系方式最近尝试'],expectedFields['联系方式最近尝试']),
        errorMatches:expectedFields!==null&&exactTextCellValue(fields['联系方式最近错误'])===expectedFields['联系方式最近错误'],
        protectionEvidenceAvailable:bools(r?.write,['sameCreatorIdReadback','nonContactFieldsUnchanged','humanFieldsUnchanged',
          'oldWeChatPreserved','lastSuccessPreserved','sourcePreserved'])};
    }catch{ /* read-only failure remains isolated, with no raw CLI error copied */ }
    await writePrivateJson(attemptPath(request.attemptId),{...saved,reconciliation:diagnostic});
    if(Object.values(diagnostic).every(v=>v===true)&&r?.write?.writerInvoked!==true){
      const refreshed={...r,write:{...r.write,failureStatusRecorded:true,failurePatchStatusMatches:true,
        failurePatchAttemptTimeMatches:true,failurePatchErrorCodeMatches:true}};
      return translateSingleReceipt(refreshed,request);
    }
    return {attemptId:request.attemptId,outcome:'error',writeState:'uncertain',reason:'ORIGINAL_ATTEMPT_READBACK_UNCONFIRMED'};
  }
  return {executeOne,reconcileOne};
}
