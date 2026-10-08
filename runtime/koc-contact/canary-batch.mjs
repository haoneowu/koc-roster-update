import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {validateRetryExclusions} from './retry-exclusions.mjs';

export const ORIGINAL_BATCH_ID = '20260923T152555Z';
const OUTCOMES = new Set(['success', 'not_shown', 'no_match', 'forbidden_by_platform', 'error', 'auth_blocked', 'risk_blocked']);
const TERMINAL = new Set(['success', 'not_shown', 'no_match', 'forbidden_by_platform']);
const fail = code => { throw new Error(`CANARY_${code}`); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length < 200;
// Batch attempts are UUIDs for newly generated work and bounded, filename-safe
// identifiers for imported legacy attempts. Reject whitespace, path separators, URL
// syntax, and control characters before retaining an attempt in checkpoint history.
const validAttemptId = value => typeof value === 'string' && value.length <= 128 &&
  /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/u.test(value);
const CHECKPOINT_ENTRY_KEYS = new Set(['state','attemptId','outcome','reason','newWeChat',
  'reviewedOldValue','readbackVerified','recoveryException','originalAttemptSourceVerified','parallelLease',
  'supersededAttempt']);
const CHECKPOINT_LEASE_KEYS = new Set(['workerId','laneId','laneIndex','pageBindingId','leaseUntil']);
const SAFE_REASON = /^[A-Z][A-Z0-9_]{0,79}$/u;

// Input is the original A receipt, not the cumulative library nor a fresh daily list.
// No source contact fields are consumed or retained.
export function buildCanaryManifest(receipt) {
  if (receipt?.batchId !== ORIGINAL_BATCH_ID || receipt.status !== 'complete' ||
      receipt.plannedCount !== 500 || receipt.completedCount !== 500) fail('SOURCE_NOT_VERIFIED');
  const byId = new Map();
  for (const row of receipt.plannedCreators || []) {
    if (!validId(row.creatorId) || !Number.isInteger(row.sourceRank) || row.sourceRank < 1) fail('SOURCE_ROW_INVALID');
    const previous = byId.get(row.creatorId);
    if (!previous || row.sourceRank < previous.sourceRank) byId.set(row.creatorId,
      {creatorId: row.creatorId, sourceRank: row.sourceRank});
  }
  if (byId.size !== 500) fail('SOURCE_COUNT_MISMATCH');
  const targets = [...byId.values()].sort((a,b) => a.sourceRank - b.sourceRank || a.creatorId.localeCompare(b.creatorId));
  const records = new Set();
  for (const row of targets) {
    const recordId = receipt.creatorRecordIds?.[row.creatorId];
    const evidence = (receipt.outcomes || []).filter(item => item.creatorId === row.creatorId);
    if (!validId(recordId) || records.has(recordId) || evidence.length !== 1 ||
        evidence[0].recordId !== recordId || evidence[0].readbackVerified !== true) fail('RECORD_MAPPING_UNVERIFIED');
    records.add(recordId);
    row.recordId = recordId;
  }
  return {version: 1, sourceBatchId: ORIGINAL_BATCH_ID, targets};
}

function validateManifest(manifest) {
  if (manifest?.version !== 1 || manifest.sourceBatchId !== ORIGINAL_BATCH_ID ||
      manifest.targets?.length !== 500) fail('MANIFEST_INVALID');
  if (manifest.kind !== undefined && manifest.kind !== 'qualified-source') fail('MANIFEST_INVALID');
  if (manifest.kind === 'qualified-source') {
    if (!/^[a-f0-9]{64}$/u.test(manifest.sourceCheckpointSha256 || '') ||
        !/^[a-f0-9]{64}$/u.test(manifest.sourceReceiptSha256 || '') ||
        !Array.isArray(manifest.excludedOldTargets)) fail('MANIFEST_INVALID');
    const excludedIds = new Set(), excludedRecords = new Set();
    for (const row of manifest.excludedOldTargets) {
      const keys = row && typeof row === 'object' && !Array.isArray(row)
        ? Object.keys(row).sort().join(',') : '';
      if (!row || typeof row !== 'object' || Array.isArray(row) ||
          !['creatorId,recordId','creatorId,recordId,sourceRank'].includes(keys) ||
          !validId(row.creatorId) || !validId(row.recordId) ||
          (Object.hasOwn(row,'sourceRank')&&(!Number.isInteger(row.sourceRank)||row.sourceRank<1)) ||
          excludedIds.has(row.creatorId) || excludedRecords.has(row.recordId)) fail('MANIFEST_INVALID');
      excludedIds.add(row.creatorId); excludedRecords.add(row.recordId);
    }
    if (manifest.targets.some(row => excludedIds.has(row.creatorId) || excludedRecords.has(row.recordId))) {
      fail('MANIFEST_INVALID');
    }
    if (new Set(manifest.targets.map(row => row.sourceRank)).size !== manifest.targets.length) fail('MANIFEST_INVALID');
  } else if (Object.hasOwn(manifest, 'excludedOldTargets') ||
      Object.hasOwn(manifest, 'sourceCheckpointSha256') || Object.hasOwn(manifest, 'sourceReceiptSha256')) {
    fail('MANIFEST_INVALID');
  }
  const ids = new Set(), records = new Set();
  let rank = 0;
  for (const row of manifest.targets) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).sort().join(',') !== 'creatorId,recordId,sourceRank' ||
        !validId(row.creatorId) || !validId(row.recordId) || ids.has(row.creatorId) || records.has(row.recordId) ||
        !Number.isInteger(row.sourceRank) || row.sourceRank < 1 || row.sourceRank < rank) fail('MANIFEST_INVALID');
    ids.add(row.creatorId); records.add(row.recordId); rank = row.sourceRank;
  }
}

// Only this allowlisted result is persisted. Raw receipts, values, UID, source URLs,
// free-text errors, and credentials never enter the batch checkpoint or report.
function normalizeResult(result, attemptId, target) {
  const reason = typeof result?.reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(result.reason)
    ? {reason: result.reason} : {};
  const uncertain = () => ({state: 'uncertain', attemptId, ...reason});
  if (!result || result.attemptId !== attemptId || !OUTCOMES.has(result.outcome) ||
      !['verified', 'not_written', 'uncertain'].includes(result.writeState)) return uncertain();
  if(result.outcome==='forbidden_by_platform'&&result.reason!=='CONTACT_CATEGORY_RESTRICTED')return uncertain();
  const blocked = ['auth_blocked','risk_blocked'].includes(result.outcome);
  const recoveryException = target?.creatorId === 'LEGACY_RECOVERY_DISABLED' && target.recordId === 'LEGACY_RECOVERY_RECORD_DISABLED' &&
    target.sourceRank === 12 && result.outcome === 'not_shown' &&
    result.reviewedRecoveryAccepted === true && result.originalAttemptSourceVerified === false;
  const verified = result.writeState === 'verified' && result.recordMappingVerified === true &&
    result.readbackVerified === true && (result.originalAttemptSourceVerified === true || recoveryException) &&
    result.protectedFieldsUnchanged === true;
  if (!verified && !((blocked || result.outcome === 'error') && result.writeState === 'not_written')) return uncertain();
  if (result.outcome === 'success' && (typeof result.hadWeChatBefore !== 'boolean' || result.currentValueVerified !== true))
    return uncertain();
  return {state: blocked ? 'blocked' : result.outcome === 'error' ? 'error' : 'confirmed', attemptId,
    outcome: result.outcome, ...reason,
    newWeChat: result.outcome === 'success' && !result.hadWeChatBefore,
    reviewedOldValue: result.outcome === 'success' && result.hadWeChatBefore,
    ...(recoveryException ? {recoveryException: true, originalAttemptSourceVerified: false} : {}),
    readbackVerified: verified};
}

function normalizeNoMatchRecheckOption(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'creatorId,expectedAttemptId,recordId' ||
      !validId(value.creatorId) || !validId(value.recordId) || !validAttemptId(value.expectedAttemptId)) {
    fail('NO_MATCH_RECHECK_INVALID');
  }
  return Object.freeze({creatorId: value.creatorId, recordId: value.recordId,
    expectedAttemptId: value.expectedAttemptId});
}

function safeNoMatchEntry(entry) {
  return {
    state: 'confirmed',
    outcome: 'no_match',
    attemptId: entry.attemptId,
    ...(typeof entry.reason === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(entry.reason)
      ? {reason: entry.reason} : {}),
    newWeChat: false,
    reviewedOldValue: false,
    readbackVerified: true,
  };
}

function safeNoMatchEntryValid(entry, expectedAttemptId) {
  const allowedKeys = new Set(['state', 'outcome', 'attemptId', 'reason', 'newWeChat',
    'reviewedOldValue', 'readbackVerified']);
  return entry && typeof entry === 'object' && !Array.isArray(entry) &&
    Object.keys(entry).every(key => allowedKeys.has(key)) &&
    entry.state === 'confirmed' && entry.outcome === 'no_match' &&
    validAttemptId(entry.attemptId) && entry.attemptId === expectedAttemptId && entry.newWeChat === false &&
    entry.reviewedOldValue === false && entry.readbackVerified === true &&
    (!Object.hasOwn(entry, 'reason') || typeof entry.reason === 'string' && SAFE_REASON.test(entry.reason));
}

function validateNoMatchRecheckHistory(history, manifest) {
  if (!Array.isArray(history)) return false;
  const seen = new Set();
  for (const item of history) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'creatorId,expectedAttemptId,kind,originalEntry,recordId' ||
        item.kind !== 'confirmed_no_match_recheck' || !validId(item.creatorId) || !validId(item.recordId) ||
        !validAttemptId(item.expectedAttemptId) || !safeNoMatchEntryValid(item.originalEntry, item.expectedAttemptId)) return false;
    const manifestTarget = manifest.targets.find(target => target.creatorId === item.creatorId);
    if (!manifestTarget || manifestTarget.recordId !== item.recordId) return false;
    const key = `${item.creatorId}\u0000${item.recordId}\u0000${item.expectedAttemptId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function recheckHistoryContains(state, creatorId, recordId, expectedAttemptId = null) {
  return state.recheckHistory.some(item => item.creatorId === creatorId && item.recordId === recordId &&
    (expectedAttemptId === null || item.expectedAttemptId === expectedAttemptId));
}

export function validCheckpointEntry(entry, depth=0) {
  if(depth>32)return false;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).some(key => !CHECKPOINT_ENTRY_KEYS.has(key)) ||
      !['pending','confirmed','error','blocked','in_flight','uncertain'].includes(entry.state)) return false;
  const legacyContactBlocked=entry.state==='blocked'&&entry.outcome==='contact_access_unavailable'&&
    entry.reason==='CONTACT_REVEAL_FAILED'&&entry.newWeChat===false&&entry.reviewedOldValue===false&&
    entry.readbackVerified===false;
  const legacyNotFound=entry.state==='confirmed'&&entry.outcome==='not_found'&&entry.newWeChat===false&&
    entry.reviewedOldValue===false&&entry.readbackVerified===true&&entry.originalAttemptSourceVerified===true;
  if (Object.hasOwn(entry, 'attemptId') && !validAttemptId(entry.attemptId)) return false;
  if (Object.hasOwn(entry, 'reason') && (typeof entry.reason !== 'string' || !SAFE_REASON.test(entry.reason))) return false;
  for (const key of ['newWeChat','reviewedOldValue','readbackVerified','recoveryException',
    'originalAttemptSourceVerified']) {
    if (Object.hasOwn(entry, key) && typeof entry[key] !== 'boolean') return false;
  }
  if (Object.hasOwn(entry, 'outcome') && !OUTCOMES.has(entry.outcome)&&!legacyContactBlocked&&!legacyNotFound) return false;
  if (['in_flight','uncertain','blocked','error'].includes(entry.state) && !validAttemptId(entry.attemptId)) return false;
  if (entry.state === 'confirmed' &&
      (![...TERMINAL, 'error'].includes(entry.outcome)&&!legacyNotFound || entry.readbackVerified !== true)) return false;
  if (entry.state === 'error' && entry.outcome !== 'error') return false;
  if (entry.state === 'blocked' && !['auth_blocked','risk_blocked'].includes(entry.outcome)&&!legacyContactBlocked) return false;
  if(Object.hasOwn(entry,'supersededAttempt')){
    const prior=entry.supersededAttempt;
    if(depth===32||!validCheckpointEntry(prior,depth+1)||!['confirmed','error','blocked'].includes(prior.state))return false;
  }
  if (Object.hasOwn(entry, 'parallelLease')) {
    const lease = entry.parallelLease;
    if (!lease || typeof lease !== 'object' || Array.isArray(lease) ||
        Object.keys(lease).some(key => !CHECKPOINT_LEASE_KEYS.has(key)) ||
        typeof lease.workerId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(lease.workerId) ||
        typeof lease.laneId !== 'string' || !/^lane-[1-5]$/u.test(lease.laneId) ||
        !Number.isInteger(lease.laneIndex) || lease.laneIndex < 0 || lease.laneIndex > 4 ||
        lease.laneId !== `lane-${lease.laneIndex + 1}` || !Number.isInteger(lease.pageBindingId) ||
        lease.pageBindingId < 0 || typeof lease.leaseUntil !== 'string' ||
        !Number.isFinite(Date.parse(lease.leaseUntil))) return false;
  }
  return true;
}

function validCheckpointState(state, manifest) {
  return state?.version === 1 && state.sourceBatchId === manifest.sourceBatchId &&
    state.manifestDigest === fingerprint(manifest) && state.entries?.length === 500 &&
    !state.entries.some(entry => !validCheckpointEntry(entry)) &&
    (state.recheckHistory === undefined || validateNoMatchRecheckHistory(state.recheckHistory, manifest));
}

function pairKey(target) { return `${target.creatorId}\u0000${target.recordId}`; }

function validReceiptHistorySnapshot(snapshot,target,sourceBatchId) {
  const snapshotKeys=['attemptId','completedAt','creatorId','recordId','result','sourceBatchId','sourceRank','status'];
  const resultKeys=new Set(['outcome','writeState','reason','recordMappingVerified','readbackVerified',
    'originalAttemptSourceVerified','protectedFieldsUnchanged','hadWeChatBefore','currentValueVerified',
    'recoveryMode','sharedWriterReadbackVerified']);
  const booleanKeys=['recordMappingVerified','readbackVerified','originalAttemptSourceVerified',
    'protectedFieldsUnchanged','hadWeChatBefore','currentValueVerified','sharedWriterReadbackVerified'];
  return snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)&&
    Object.keys(snapshot).sort().join(',')===snapshotKeys.sort().join(',')&&
    snapshot.sourceBatchId===sourceBatchId&&snapshot.creatorId===target.creatorId&&
    snapshot.recordId===target.recordId&&snapshot.sourceRank===target.sourceRank&&
    (snapshot.attemptId===null||validAttemptId(snapshot.attemptId))&&
    (snapshot.completedAt===null||typeof snapshot.completedAt==='string'&&snapshot.completedAt.length<=128&&
      /^\d{4}-\d\d-\d\dT[^\r\n\u0000]+$/u.test(snapshot.completedAt))&&
    (snapshot.status===null||typeof snapshot.status==='string'&&/^[A-Za-z0-9_]{1,100}$/u.test(snapshot.status))&&
    snapshot.result&&typeof snapshot.result==='object'&&!Array.isArray(snapshot.result)&&
    Object.keys(snapshot.result).every(key=>resultKeys.has(key))&&
    OUTCOMES.has(snapshot.result.outcome)&&['verified','not_written','uncertain'].includes(snapshot.result.writeState)&&
    booleanKeys.every(key=>!Object.hasOwn(snapshot.result,key)||typeof snapshot.result[key]==='boolean')&&
    (!Object.hasOwn(snapshot.result,'reason')||typeof snapshot.result.reason==='string'&&
      SAFE_REASON.test(snapshot.result.reason))&&
      (!Object.hasOwn(snapshot.result,'recoveryMode')||snapshot.result.recoveryMode==='outer_same_attempt_readback_verified');
}

function redactExcludedAttemptIds(entry) {
  const aliases=new Map();
  const alias=value=>{
    if(typeof value!=='string')return value;
    if(!aliases.has(value))aliases.set(value,`excluded-attempt-${aliases.size+1}`);
    return aliases.get(value);
  };
  const checkpointEntry=structuredClone(entry.checkpointEntry);
  if(typeof checkpointEntry.attemptId==='string')checkpointEntry.attemptId=alias(checkpointEntry.attemptId);
  const checkpointHistory=entry.checkpointHistory.map(item=>{
    const copy=structuredClone(item);
    if(typeof copy.expectedAttemptId==='string')copy.expectedAttemptId=alias(copy.expectedAttemptId);
    if(typeof copy.originalEntry?.attemptId==='string')copy.originalEntry.attemptId=alias(copy.originalEntry.attemptId);
    return copy;
  });
  const receiptHistory=entry.receiptHistory.map(item=>{
    const copy=structuredClone(item);
    if(typeof copy.snapshot?.attemptId==='string')copy.snapshot.attemptId=alias(copy.snapshot.attemptId);
    return copy;
  });
  const safe={...entry,checkpointEntry,checkpointHistory,receiptHistory};
  if(entry.importedResult){
    safe.importedResult=structuredClone(entry.importedResult);
    if(typeof safe.importedResult.attemptId==='string')safe.importedResult.attemptId=alias(safe.importedResult.attemptId);
  }
  return safe;
}

function prepareMigration({state, previousManifest, manifest, excludedTargets, importedExcludedResults,
  receiptHistory, sourceManifestSha256, sidecarPath}) {
  validateManifest(previousManifest);
  if (manifest.kind !== 'qualified-source' || !path.isAbsolute(sidecarPath) ||
      !/^[a-f0-9]{64}$/u.test(sourceManifestSha256 || '')) fail('MIGRATION_INVALID');

  const oldByPair = new Map(previousManifest.targets.map((target,index) => [pairKey(target), {target,index}]));
  const newByPair = new Map(manifest.targets.map((target,index) => [pairKey(target), {target,index}]));
  const excludedByPair = new Map();
  for (const target of excludedTargets) {
    const key = pairKey(target);
    if (excludedByPair.has(key) || !oldByPair.has(key) || newByPair.has(key)) fail('MIGRATION_EXCLUSION_INVALID');
    excludedByPair.set(key, target);
  }
  for (const key of oldByPair.keys()) {
    if (!newByPair.has(key) && !excludedByPair.has(key)) fail('MIGRATION_OLD_TARGET_UNACCOUNTED');
  }
  for (const key of excludedByPair.keys()) {
    if (!oldByPair.has(key)) fail('MIGRATION_UNKNOWN_EXCLUSION');
  }

  const oldState = state || {entries: previousManifest.targets.map(() => ({state:'pending'})), recheckHistory: []};
  if (state && !validCheckpointState(state, previousManifest)) fail('MIGRATION_OLD_CHECKPOINT_INVALID');
  const oldHistory = oldState.recheckHistory || [];
  const nextEntries = manifest.targets.map(target => {
    const old = oldByPair.get(pairKey(target));
    return old ? structuredClone(oldState.entries[old.index]) : {state:'pending'};
  });
  const retainedHistory = [], excludedHistoryByPair = new Map();
  for (const item of oldHistory) {
    const key = pairKey(item);
    if (newByPair.has(key)) retainedHistory.push(structuredClone(item));
    else {
      if (!excludedByPair.has(key)) fail('MIGRATION_HISTORY_UNACCOUNTED');
      if (!excludedHistoryByPair.has(key)) excludedHistoryByPair.set(key, []);
      excludedHistoryByPair.get(key).push(structuredClone(item));
    }
  }
  const excludedImportedByPair = new Map();
  for (const item of importedExcludedResults) {
    const key = pairKey(item);
    if (!excludedByPair.has(key) || excludedImportedByPair.has(key)) fail('MIGRATION_IMPORTED_RESULT_INVALID');
    const old = oldByPair.get(key);
    const attemptId = item.result?.attemptId;
    if (!validAttemptId(attemptId)) fail('MIGRATION_IMPORTED_RESULT_INVALID');
    const safe = normalizeResult(item.result, attemptId, old.target);
    if (safe.state === 'uncertain') fail('MIGRATION_IMPORTED_RESULT_UNVERIFIED');
    excludedImportedByPair.set(key, safe);
  }

  if (!Array.isArray(receiptHistory)) fail('MIGRATION_RECEIPT_HISTORY_INVALID');
  const receiptHistoryByPair = new Map(), receiptFiles = new Set();
  for (const reference of receiptHistory) {
    const key = pairKey(reference || {});
    const old = oldByPair.get(key);
    if (!old || reference.sourceRank !== old.target.sourceRank ||
        typeof reference.receiptFile !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/u.test(reference.receiptFile) ||
        reference.receiptFile === '.' || reference.receiptFile === '..' ||
        !/^[a-f0-9]{64}$/u.test(reference.receiptSha256 || '') || receiptFiles.has(reference.receiptFile) ||
        !validReceiptHistorySnapshot(reference.receiptSnapshot,old.target,previousManifest.sourceBatchId)) {
      fail('MIGRATION_RECEIPT_HISTORY_INVALID');
    }
    receiptFiles.add(reference.receiptFile);
    if (!receiptHistoryByPair.has(key)) receiptHistoryByPair.set(key, []);
    receiptHistoryByPair.get(key).push({receiptFile:reference.receiptFile,receiptSha256:reference.receiptSha256,
      snapshot:structuredClone(reference.receiptSnapshot)});
  }

  const excluded = [...excludedByPair.entries()].map(([key,target]) => {
    const old = oldByPair.get(key);
    return {target: structuredClone(old.target), checkpointEntry: structuredClone(oldState.entries[old.index]),
      checkpointHistory: excludedHistoryByPair.get(key) || [],
      receiptHistory: receiptHistoryByPair.get(key) || [],
      ...(excludedImportedByPair.has(key) ? {importedResult: excludedImportedByPair.get(key)} : {})};
  }).map(redactExcludedAttemptIds);
  const sidecar = {version:1, kind:'qualified-source-excluded-history', sourceBatchId:previousManifest.sourceBatchId,
    oldManifestDigest:fingerprint(previousManifest), newManifestDigest:fingerprint(manifest), sourceManifestSha256,
    sourceCheckpointSha256:manifest.sourceCheckpointSha256,sourceReceiptSha256:manifest.sourceReceiptSha256,
    checkpointExisted:!!state, entries:excluded};
  const sidecarBytes = `${JSON.stringify(sidecar, null, 2)}\n`;
  const sidecarSha256 = createHash('sha256').update(sidecarBytes).digest('hex');
  return {state:{version:1,sourceBatchId:manifest.sourceBatchId,manifestDigest:fingerprint(manifest),
      sourceManifestSha256,recheckHistory:retainedHistory,entries:nextEntries,
      migration:{oldManifestDigest:fingerprint(previousManifest),sidecarSha256}},
    sidecarPath,sidecar,sidecarBytes,sidecarSha256};
}

export function summarizeCanary(state, targetCount) {
  const entries = state.entries.slice(0, targetCount);
  const count = test => entries.filter(test).length;
  return {targetCount, processedUnique: count(e => e.state !== 'pending'),
    newWeChat: count(e => e.newWeChat === true), reviewedOldValue: count(e => e.reviewedOldValue === true),
    notShown: count(e => e.outcome === 'not_shown'), noMatch: count(e => e.outcome === 'no_match'),
    platformRestricted: count(e => e.outcome === 'forbidden_by_platform'),
    errorsOrBlocked: count(e => ['error','auth_blocked','risk_blocked'].includes(e.outcome)),
    remainingUnprocessed: count(e => e.state === 'pending'),
    readbackUncertain: count(e => ['uncertain','in_flight'].includes(e.state)),
    firstRoundFilled: entries.length === targetCount && entries.every(e => e.state === 'confirmed' && TERMINAL.has(e.outcome))};
}

// Adapter binds same-attempt comparison evidence to the opaque attemptId.
// Immediate comparison can remain entirely in the controlled process. Cross-process
// recovery uses an already authorized private evidence mechanism, if available;
// this contract does NOT require new plaintext contact persistence. Without usable
// original evidence reconciliation stays uncertain; a fresh source is no substitute.
// Same checkpoint supports the 100 -> 200 -> 500 prefixes. Only the browser owner
// invokes this; no CLI, browser access, writer implementation or scheduling here.
export async function runCanaryBatch({manifest, targetCount = 100, checkpointPath, executeOne,
  reconcileOne, resumeBlocked = false, reviewedRecovery = null, initialResults = [],
  prepareOnly = false, retryErrors = false, onProgress, shouldContinue, targetCreatorIds = null,
  recheckNoMatch: rawNoMatchRecheck = null, migration: migrationOption = null,retryExclusions=[]}) {
  validateManifest(manifest);
  const excludedCreators=new Set(validateRetryExclusions({manifest,exclusions:retryExclusions})
    .map(exclusion=>exclusion.creatorId));
  let migrationInput = null;
  if (migrationOption !== null) {
    if (!migrationOption || typeof migrationOption !== 'object' || Array.isArray(migrationOption) ||
        !migrationOption.previousManifest || typeof migrationOption.previousManifest !== 'object' ||
        typeof migrationOption.sidecarPath !== 'string' || !path.isAbsolute(migrationOption.sidecarPath) ||
        !/^[a-f0-9]{64}$/u.test(migrationOption.sourceManifestSha256 || '') ||
        Object.hasOwn(migrationOption,'receiptHistory')&&!Array.isArray(migrationOption.receiptHistory) ||
        Object.hasOwn(migrationOption,'importedExcludedResults')&&!Array.isArray(migrationOption.importedExcludedResults)) {
      fail('MIGRATION_INVALID');
    }
    validateManifest(migrationOption.previousManifest);
    if (manifest.kind !== 'qualified-source') fail('MIGRATION_INVALID');
    migrationInput = {previousManifest:migrationOption.previousManifest,
      excludedTargets:manifest.excludedOldTargets,
      importedExcludedResults:Array.isArray(migrationOption.importedExcludedResults)
        ? migrationOption.importedExcludedResults : [],
      receiptHistory:Array.isArray(migrationOption.receiptHistory) ? migrationOption.receiptHistory : [],
      sourceManifestSha256:migrationOption.sourceManifestSha256,
      sidecarPath:migrationOption.sidecarPath};
  }
  const noMatchRecheck = normalizeNoMatchRecheckOption(rawNoMatchRecheck);
  if(targetCreatorIds!==null&&!Array.isArray(targetCreatorIds))fail('TARGET_FILTER_INVALID');
  const targetSet=targetCreatorIds===null?null:new Set(targetCreatorIds);
  if(targetSet&&(!Array.isArray(targetCreatorIds)||targetSet.size!==targetCreatorIds.length||
      targetCreatorIds.some(id=>!manifest.targets.slice(0,targetCount).some(t=>t.creatorId===id))))fail('TARGET_FILTER_INVALID');
  if (![100,200,500].includes(targetCount) || typeof checkpointPath !== 'string' || !path.isAbsolute(checkpointPath) || (!prepareOnly && typeof executeOne !== 'function') || !Array.isArray(initialResults)) fail('ARGUMENTS');
  const seeds = [], excludedSeeds = [];
  for (const seed of initialResults) {
    const index = manifest.targets.findIndex(t => t.creatorId === seed?.creatorId && t.recordId === seed?.recordId);
    if (index >= 0) {
      if (!validAttemptId(seed.result?.attemptId)) fail('INITIAL_RESULT_INVALID');
      seeds.push({index, entry: normalizeResult(seed.result, seed.result.attemptId, manifest.targets[index])});
      continue;
    }
    const oldTarget = migrationInput?.previousManifest.targets.find(t =>
      t.creatorId === seed?.creatorId && t.recordId === seed?.recordId);
    const isExcluded = oldTarget && manifest.excludedOldTargets.some(target =>
      target.creatorId === oldTarget.creatorId && target.recordId === oldTarget.recordId);
    if (!isExcluded || !validAttemptId(seed.result?.attemptId)) fail('INITIAL_RESULT_INVALID');
    excludedSeeds.push({creatorId:oldTarget.creatorId,recordId:oldTarget.recordId,result:seed.result});
  }
  if (new Set(seeds.map(s => s.index)).size !== seeds.length) fail('INITIAL_RESULT_DUPLICATE');
  await fs.mkdir(path.dirname(checkpointPath), {recursive: true, mode: 0o700});
  const lockPath = `${checkpointPath}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); }
  catch { fail('CHECKPOINT_LOCKED'); }
  try {
    await lock.writeFile(JSON.stringify({pid: process.pid, acquiredAt: new Date().toISOString()}));
    await lock.sync();
    const manifestDigest = fingerprint(manifest);
    let state;
    try { state = JSON.parse(await fs.readFile(checkpointPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') fail('CHECKPOINT_UNREADABLE'); }
    if (state && state.manifestDigest !== manifestDigest && migrationInput) {
      const prepared = prepareMigration({state, ...migrationInput, manifest,
        importedExcludedResults:[...migrationInput.importedExcludedResults,...excludedSeeds]});
      let existingSidecar;
      try { existingSidecar = await fs.readFile(prepared.sidecarPath); }
      catch (error) { if (error.code !== 'ENOENT') fail('MIGRATION_SIDECAR_UNREADABLE'); }
      if (existingSidecar && !existingSidecar.equals(Buffer.from(prepared.sidecarBytes))) fail('MIGRATION_SIDECAR_MISMATCH');
      if (!existingSidecar) await writePrivateJson(prepared.sidecarPath, prepared.sidecar);
      state = prepared.state;
    } else if (state) {
      if (!validCheckpointState(state, manifest)) fail('CHECKPOINT_MISMATCH');
      if (state.recheckHistory === undefined) state.recheckHistory = [];
      if (migrationInput) {
        const sidecar = state.migration;
        if (!sidecar || sidecar.oldManifestDigest !== fingerprint(migrationInput.previousManifest)) {
          fail('MIGRATION_SIDECAR_MISSING');
        }
        let sidecarBytes;
        try { sidecarBytes = await fs.readFile(migrationInput.sidecarPath); }
        catch { fail('MIGRATION_SIDECAR_MISSING'); }
        if (createHash('sha256').update(sidecarBytes).digest('hex') !== sidecar.sidecarSha256) {
          fail('MIGRATION_SIDECAR_MISMATCH');
        }
      }
    } else {
      state = {version: 1, sourceBatchId: manifest.sourceBatchId, manifestDigest,
        ...(migrationInput ? {sourceManifestSha256:migrationInput.sourceManifestSha256} : {}),
        recheckHistory: [], entries: manifest.targets.map(() => ({state: 'pending'}))};
      // Only the previously reviewed B2 recovery can seed this special exception.
      // It is a recheck of an existing value, never a new-contact count. Original
      // exact-source readback remains explicitly unverified in its own receipt.
      if (reviewedRecovery) {
        const i = manifest.targets.findIndex(t => t.creatorId === 'LEGACY_REVIEWED_CREATOR_DISABLED' && t.recordId === 'LEGACY_REVIEWED_RECORD_DISABLED');
        const v = reviewedRecovery.verification || {};
        if (i < 0 || reviewedRecovery.creatorId !== 'LEGACY_REVIEWED_CREATOR_DISABLED' ||
            reviewedRecovery.recordId !== 'LEGACY_REVIEWED_RECORD_DISABLED' ||
            reviewedRecovery.status !== 'readback_reconciled_after_commit' ||
            reviewedRecovery.externalWritePerformed !== false ||
            !['recordMappingVerified','sameCreatorIdReadback','wechatValueMatched','currentAttemptMatchesOriginalRun',
              'nonContactFieldsUnchanged','humanFieldsUnchanged','comparisonCompleted','freshIdentityProof','browserValueProof']
              .every(k => v[k] === true)) fail('RECOVERY_UNVERIFIED');
        state.entries[i] = {state: 'confirmed', outcome: 'success', newWeChat: false,
          reviewedOldValue: true, readbackVerified: true, recoveryException: true,
          originalAttemptSourceVerified: false};
      }
      if (migrationInput) {
        const prepared = prepareMigration({state:null, ...migrationInput, manifest,
          importedExcludedResults:[...migrationInput.importedExcludedResults,...excludedSeeds]});
        let existingSidecar;
        try { existingSidecar = await fs.readFile(prepared.sidecarPath); }
        catch (error) { if (error.code !== 'ENOENT') fail('MIGRATION_SIDECAR_UNREADABLE'); }
        if (existingSidecar && !existingSidecar.equals(Buffer.from(prepared.sidecarBytes))) fail('MIGRATION_SIDECAR_MISMATCH');
        if (!existingSidecar) await writePrivateJson(prepared.sidecarPath, prepared.sidecar);
        state = prepared.state;
      }
    }
    if (noMatchRecheck) {
      const index = manifest.targets.findIndex(target => target.creatorId === noMatchRecheck.creatorId &&
        target.recordId === noMatchRecheck.recordId);
      if (index < 0) fail('NO_MATCH_RECHECK_TARGET_MISMATCH');
      if (index >= targetCount || targetSet && !targetSet.has(noMatchRecheck.creatorId)||
          excludedCreators.has(noMatchRecheck.creatorId)) {
        fail('NO_MATCH_RECHECK_OUT_OF_SCOPE');
      }
      if (!recheckHistoryContains(state, noMatchRecheck.creatorId, noMatchRecheck.recordId,
          noMatchRecheck.expectedAttemptId)) {
        const previous = state.entries[index];
        if (previous.state !== 'confirmed' || previous.outcome !== 'no_match') {
          fail('NO_MATCH_RECHECK_NOT_ELIGIBLE');
        }
        if (previous.attemptId !== noMatchRecheck.expectedAttemptId) fail('NO_MATCH_RECHECK_ATTEMPT_MISMATCH');
        if (!prepareOnly) {
          state.recheckHistory.push({
            kind: 'confirmed_no_match_recheck',
            creatorId: noMatchRecheck.creatorId,
            recordId: noMatchRecheck.recordId,
            expectedAttemptId: noMatchRecheck.expectedAttemptId,
            originalEntry: safeNoMatchEntry(previous),
          });
          state.entries[index] = {state: 'pending'};
        }
      }
    }
    // Older v1 checkpoints may have called verified errors confirmed. They are
    // processed attempts, but never completed source extraction.
    for (const entry of state.entries) {
      if (entry.state === 'confirmed' && entry.outcome === 'error') entry.state = 'error';
    }
    for (const seed of seeds) {
      const target = manifest.targets[seed.index];
      if (state.entries[seed.index].state === 'pending' &&
          !recheckHistoryContains(state, target.creatorId, target.recordId)) {
        state.entries[seed.index] = seed.entry;
      }
    }
    await writePrivateJson(checkpointPath, state);
    if (prepareOnly) return summarizeCanary(state, targetCount);
    const progress = async index => {
      if (typeof onProgress === 'function') {
        try { await onProgress({index, report: summarizeCanary(state, targetCount)}); }
        catch { /* A reporting failure never changes a committed attempt or replays it. */ }
      }
    };
    for (let i = 0; i < targetCount; i++) {
      if(targetSet&&!targetSet.has(manifest.targets[i].creatorId))continue;
      if(excludedCreators.has(manifest.targets[i].creatorId))continue;
      let entry = state.entries[i];
      if (entry.state === 'confirmed' || (entry.state === 'error' && !retryErrors)) continue;
      const target = manifest.targets[i];
      // Check only at an idle single-record boundary; never cancel an action in flight.
      if (typeof shouldContinue === 'function' &&
          await shouldContinue({index: i, report: summarizeCanary(state, targetCount)}) === false) break;
      if (['in_flight','uncertain'].includes(entry.state)) {
        let result;
        if (typeof reconcileOne === 'function') {
          try { result = await reconcileOne({...target, sourceBatchId: manifest.sourceBatchId, attemptId: entry.attemptId}); }
          catch { /* Never copy a thrown message; it may include personal data. */ }
        }
        entry = normalizeResult(result, entry.attemptId, target);
        state.entries[i] = entry;
        await writePrivateJson(checkpointPath, state);
        await progress(i);
        if (entry.state === 'blocked') break;
        continue;
      }
      if (entry.state === 'blocked' && !resumeBlocked) break;
      const attemptId = randomUUID();
      const supersededAttempt=['blocked','error'].includes(entry.state)?structuredClone(entry):null;
      state.entries[i] = {state: 'in_flight', attemptId,
        ...(supersededAttempt?{supersededAttempt}:{})};
      await writePrivateJson(checkpointPath, state); // crash after this is an uncertain write, never a retry
      let result;
      try { result = await executeOne({...target, sourceBatchId: manifest.sourceBatchId, attemptId}); }
      catch { /* conservative unknown outcome; reconcile before any re-execution */ }
      state.entries[i] = {...normalizeResult(result, attemptId, target),
        ...(supersededAttempt?{supersededAttempt}:{})};
      await writePrivateJson(checkpointPath, state);
      await progress(i);
      if (state.entries[i].state === 'blocked') break;
    }
    return summarizeCanary(state, targetCount);
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

// The parallel coordinator reuses the same scope and evidence gates as the
// sequential path; transport and leasing do not change completion semantics.
export {validateManifest as validateCanaryManifest, normalizeResult as normalizeCanaryResult};
