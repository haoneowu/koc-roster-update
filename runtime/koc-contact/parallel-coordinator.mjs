import {createHash, randomUUID} from 'node:crypto';
import {ORIGINAL_BATCH_ID, validateCanaryManifest, normalizeCanaryResult, validCheckpointEntry} from './canary-batch.mjs';
import {assertWorkerIdentity} from './parallel-page-binding.mjs';
import {validateRetryExclusions} from './retry-exclusions.mjs';

export const PARALLEL_SHARD_COUNT = 5;
export const PARALLEL_PILOT_MAX_WALL_MS = 600_000;
const TARGET_COUNTS = new Set([100,200,500]);
const OUTCOMES = new Set(['success','not_shown','no_match','forbidden_by_platform','error','auth_blocked','risk_blocked']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const ENTRY_KEYS = new Set(['state','attemptId','outcome','reason','newWeChat','reviewedOldValue',
  'readbackVerified','recoveryException','originalAttemptSourceVerified','parallelLease','supersededAttempt']);
const LEASE_KEYS = new Set(['workerId','laneId','laneIndex','pageBindingId','leaseUntil']);
const CHECKPOINT_KEYS = new Set(['version','sourceBatchId','manifestDigest','entries','recheckHistory',
  'sourceManifestSha256','migration']);
const RECHECK_HISTORY_KEYS = 'creatorId,expectedAttemptId,kind,originalEntry,recordId';
const RECHECK_ENTRY_KEYS = new Set(['state','outcome','attemptId','reason','newWeChat',
  'reviewedOldValue','readbackVerified']);
const fail = code => { throw new Error(`PARALLEL_${code}`); };
const safeReason = value => typeof value === 'string' && SAFE_CODE.test(value) ? value : '';
const validCheckpointId = value => typeof value === 'string' && value.length > 0 && value.length < 200;

function safeRecheckEntryValid(entry,expectedAttemptId) {
  return entry&&typeof entry==='object'&&!Array.isArray(entry)&&
    Object.keys(entry).every(key=>RECHECK_ENTRY_KEYS.has(key))&&
    entry.state==='confirmed'&&entry.outcome==='no_match'&&entry.attemptId===expectedAttemptId&&
    entry.newWeChat===false&&entry.reviewedOldValue===false&&entry.readbackVerified===true&&
    (!Object.hasOwn(entry,'reason')||typeof entry.reason==='string'&&SAFE_CODE.test(entry.reason));
}

function validRecheckHistory(history,manifest) {
  if (!Array.isArray(history)) return false;
  const seen=new Set();
  for (const item of history) {
    if (!item||typeof item!=='object'||Array.isArray(item)||
        Object.keys(item).sort().join(',')!==RECHECK_HISTORY_KEYS||
        item.kind!=='confirmed_no_match_recheck'||!validCheckpointId(item.creatorId)||
        !validCheckpointId(item.recordId)||!validCheckpointId(item.expectedAttemptId)||
        !safeRecheckEntryValid(item.originalEntry,item.expectedAttemptId)) return false;
    const target=manifest.targets.find(row=>row.creatorId===item.creatorId);
    if (!target||target.recordId!==item.recordId) return false;
    const key=`${item.creatorId}\u0000${item.recordId}\u0000${item.expectedAttemptId}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validQualifiedMigrationState(manifest,state) {
  const qualified=manifest?.kind==='qualified-source';
  const hasSourceManifestSha=Object.hasOwn(state,'sourceManifestSha256');
  const hasMigration=Object.hasOwn(state,'migration');
  if (qualified!==hasSourceManifestSha) return false;
  if (hasSourceManifestSha&&!/^[a-f0-9]{64}$/u.test(state.sourceManifestSha256||'')) return false;
  if (!hasMigration) return true;
  const migration=state.migration;
  return qualified&&hasSourceManifestSha&&migration&&typeof migration==='object'&&!Array.isArray(migration)&&
    Object.keys(migration).sort().join(',')==='oldManifestDigest,sidecarSha256'&&
    /^[a-f0-9]{64}$/u.test(migration.oldManifestDigest||'')&&
    /^[a-f0-9]{64}$/u.test(migration.sidecarSha256||'');
}

function stableHash(creatorId) {
  return createHash('sha256').update(creatorId).digest('hex');
}

function validateManifestAndState(manifest,state,targetCount) {
  try { validateCanaryManifest(manifest); } catch { fail('SOURCE_OR_CHECKPOINT_INVALID'); }
  const manifestDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  if (!state || state.version !== 1 || state.sourceBatchId !== ORIGINAL_BATCH_ID ||
      state.manifestDigest !== manifestDigest || !Array.isArray(state.entries) ||
      state.entries.length !== 500 || !TARGET_COUNTS.has(targetCount)) fail('SOURCE_OR_CHECKPOINT_INVALID');
  if (Object.keys(state).some(key=>!CHECKPOINT_KEYS.has(key)) || !validQualifiedMigrationState(manifest,state) ||
      state.recheckHistory!==undefined&&!validRecheckHistory(state.recheckHistory,manifest)) {
    fail('CHECKPOINT_SCHEMA_UNSAFE');
  }
  if (manifest.targets.some(target => target.extraAuthorized === true)) fail('MANIFEST_EXTRA_ROW_PRESENT');
  for (const entry of state.entries) {
    if (!entry || !['pending','confirmed','error','blocked','in_flight','uncertain'].includes(entry.state)) {
      fail('CHECKPOINT_ENTRY_INVALID');
    }
    if (Object.keys(entry).some(key=>!ENTRY_KEYS.has(key))) fail('CHECKPOINT_SCHEMA_UNSAFE');
    if (Object.hasOwn(entry,'supersededAttempt')&&!validCheckpointEntry(entry)) fail('CHECKPOINT_SCHEMA_UNSAFE');
    const legacyContactBlocked=entry.state==='blocked'&&entry.outcome==='contact_access_unavailable'&&validCheckpointEntry(entry);
    const legacyNotFound=entry.state==='confirmed'&&entry.outcome==='not_found'&&validCheckpointEntry(entry);
    if (entry.reason !== undefined && !safeReason(entry.reason)) fail('CHECKPOINT_REASON_INVALID');
    if (['in_flight','uncertain','error','blocked'].includes(entry.state) &&
        (typeof entry.attemptId !== 'string' || !entry.attemptId)) fail('CHECKPOINT_ATTEMPT_MISSING');
    if (entry.state==='confirmed' && (!['success','not_shown','no_match','forbidden_by_platform'].includes(entry.outcome)&&!legacyNotFound || entry.readbackVerified!==true)) {
      fail('CHECKPOINT_ENTRY_INVALID');
    }
    if (entry.state==='error' && entry.outcome!=='error') fail('CHECKPOINT_ENTRY_INVALID');
    if (entry.state==='blocked' && !['auth_blocked','risk_blocked'].includes(entry.outcome)&&!legacyContactBlocked) fail('CHECKPOINT_ENTRY_INVALID');
    if (entry.parallelLease !== undefined) {
      const lease=entry.parallelLease;
      if (!lease || typeof lease!=='object' || Array.isArray(lease) ||
          Object.keys(lease).some(key=>!LEASE_KEYS.has(key)) ||
          typeof lease.workerId!=='string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(lease.workerId) ||
          typeof lease.laneId!=='string' || !/^lane-[1-5]$/u.test(lease.laneId) ||
          !Number.isInteger(lease.laneIndex) || lease.laneIndex<0 || lease.laneIndex>=PARALLEL_SHARD_COUNT ||
          lease.laneId!==`lane-${lease.laneIndex+1}` || !Number.isInteger(lease.pageBindingId) ||
          lease.pageBindingId<0 || typeof lease.leaseUntil!=='string' || !Number.isFinite(Date.parse(lease.leaseUntil))) {
        fail('CHECKPOINT_LEASE_INVALID');
      }
    }
  }
}

function entryEligible(entry,{retryErrors,resumeBlocked}) {
  return entry.state === 'pending' || (retryErrors && entry.state === 'error') ||
    (resumeBlocked && entry.state === 'blocked');
}

// Shard assignment is derived from the whole requested manifest prefix, so a
// creator never changes lanes when another entry is completed or retried.
function selectedTargetIndexes(manifest,targetCount,targetCreatorIds) {
  const prefix=manifest.targets.slice(0,targetCount);
  if (targetCreatorIds===undefined) return new Set(prefix.map((_,index)=>index));
  if (!Array.isArray(targetCreatorIds)||targetCreatorIds.length===0||
      targetCreatorIds.some(id=>typeof id!=='string'||!id)||
      new Set(targetCreatorIds).size!==targetCreatorIds.length) fail('TARGET_SELECTION_INVALID');
  const indexes=new Set();
  for (const creatorId of targetCreatorIds) {
    const index=prefix.findIndex(target=>target.creatorId===creatorId);
    if (index<0) fail('TARGET_SELECTION_INVALID');
    indexes.add(index);
  }
  return indexes;
}

export function planParallelShards({manifest,state,targetCount=100,retryErrors=false,resumeBlocked=false,
  targetCreatorIds,retryExclusions=[],laneAssignments}={}) {
  validateManifestAndState(manifest,state,targetCount);
  const excludedCreators=new Set(validateRetryExclusions({manifest,exclusions:retryExclusions})
    .map(exclusion=>exclusion.creatorId));
  const selected=selectedTargetIndexes(manifest,targetCount,targetCreatorIds);
  const prefix = manifest.targets.slice(0,targetCount);
  const sorted = manifest.targets.slice().sort((a,b) => stableHash(a.creatorId).localeCompare(stableHash(b.creatorId)) ||
    a.creatorId.localeCompare(b.creatorId));
  const laneForId = new Map();
  sorted.forEach((target,index) => laneForId.set(target.creatorId,index % PARALLEL_SHARD_COUNT));
  if(laneAssignments!==undefined){
    if(!laneAssignments||typeof laneAssignments!=='object'||Array.isArray(laneAssignments)||
      Object.entries(laneAssignments).some(([id,lane])=>!laneForId.has(id)||!Number.isInteger(lane)||lane<0||lane>=5)||
      [...selected].some(index=>!Object.hasOwn(laneAssignments,manifest.targets[index].creatorId)))fail('TARGET_SELECTION_INVALID');
    for(const [id,lane] of Object.entries(laneAssignments))laneForId.set(id,lane);
  }
  const shards = Array.from({length:PARALLEL_SHARD_COUNT},(_,laneIndex)=>({
    laneIndex,laneId:`lane-${laneIndex+1}`,targets:[],
  }));
  const eligibleIds = new Set();
  for (let index=0; index<prefix.length; index+=1) {
    if (!selected.has(index)) continue;
    const target = prefix[index];
    if (excludedCreators.has(target.creatorId)) continue;
    const entry = state.entries[index];
    if (!entryEligible(entry,{retryErrors,resumeBlocked})) continue;
    const laneIndex = laneForId.get(target.creatorId);
    if (!Number.isInteger(laneIndex)) fail('TARGET_NOT_IN_SHARD_PLAN');
    const priorLease = entry.parallelLease;
    if (priorLease?.laneIndex !== undefined && priorLease.laneIndex !== laneIndex) fail('OWNER_SHARD_MISMATCH');
    shards[laneIndex].targets.push({index,target});
    eligibleIds.add(target.creatorId);
  }
  if (eligibleIds.size !== shards.reduce((sum,shard)=>sum+shard.targets.length,0)) fail('SHARD_DUPLICATE');
  return shards;
}

function cloneCheckpoint(state) {
  return JSON.parse(JSON.stringify(state));
}

function unwrapAdapterResult(result) {
  return result && typeof result==='object' && result.result && typeof result.result==='object'
    ?result.result:result;
}

function checkpointEntryFromResult(result,attemptId,lease,target) {
  let normalized;
  try { normalized = normalizeCanaryResult(unwrapAdapterResult(result),attemptId,target); }
  catch { normalized = {state:'uncertain',attemptId,reason:'PARALLEL_RESULT_UNVERIFIED'}; }
  // All write, protection, same-attempt, and readback gates remain owned by the
  // original canary normalizer. This adds only scheduling metadata.
  return {...normalized,parallelLease:lease};
}

function uncertainEntry(attemptId,lease,reason='PARALLEL_OUTCOME_UNKNOWN') {
  return {state:'uncertain',attemptId,reason,parallelLease:lease};
}

function serializedQueue() {
  let tail = Promise.resolve();
  return task => {
    const result = tail.then(task);
    tail = result.catch(()=>{});
    return result;
  };
}

function validateWorkers(workers,autoScaleToFive,minWorkerCount=2) {
  if (!Array.isArray(workers) || workers.length < (autoScaleToFive?PARALLEL_SHARD_COUNT:minWorkerCount)) fail('WORKERS_REQUIRED');
  const ids=new Set(),lanes=new Set(),pages=new Set();
  for (const worker of workers) {
    if (!worker || typeof worker.workerId!=='string' || !worker.workerId ||
        !Number.isInteger(worker.laneIndex) || worker.laneIndex<0 || worker.laneIndex>=PARALLEL_SHARD_COUNT ||
        !Number.isInteger(worker.pageBindingId) || worker.pageBindingId<0 ||
        !/^[A-Za-z0-9_-]{1,80}$/u.test(worker.workerId) ||
        ids.has(worker.workerId) || lanes.has(worker.laneIndex) || pages.has(worker.pageBindingId)) fail('WORKER_BINDING_DUPLICATE_OR_INVALID');
    ids.add(worker.workerId);lanes.add(worker.laneIndex);pages.add(worker.pageBindingId);
  }
  return new Map(workers.map(worker=>[worker.laneIndex,worker]));
}

async function persist(state,persistCheckpoint) {
  await persistCheckpoint(cloneCheckpoint(state));
}

function validatePageResult(raw,claim) {
  const bound=raw && raw.workerId===claim.workerId && raw.laneIndex===claim.laneIndex &&
    raw.attemptId===claim.attemptId && raw.creatorId===claim.target.creatorId &&
    raw.recordId===claim.target.recordId && raw.sourceBatchId===ORIGINAL_BATCH_ID &&
    raw.sourceRank===claim.target.sourceRank && OUTCOMES.has(raw.outcome);
  if (!bound) return false;
  if (raw.preflightFailure===true) {
    return raw.outcome==='error' && raw.writeState==='not_written' &&
      (raw.writeIntent===null || raw.writeIntent===undefined) && raw.pageGuardPassed!==true && !!safeReason(raw.reason);
  }
  return raw.preflightFailure!==true && raw.pageGuardPassed===true;
}

function intervalTiming(raw) {
  const timing=raw?.workerTiming;
  if (!timing || typeof timing.waveId!=='string' || !timing.waveId ||
      !Number.isFinite(timing.startedAtMs) || !Number.isFinite(timing.finishedAtMs) ||
      timing.startedAtMs<0 || timing.finishedAtMs<timing.startedAtMs) return null;
  return timing;
}

function workerWaveTiming(results) {
  const timings=results.map(result=>intervalTiming(result.raw));
  const valid=timings.length>=2&&timings.every(Boolean)&&timings.every(item=>item.waveId===timings[0].waveId);
  let overlaps=false;
  if (valid) for (let left=0;left<timings.length&&!overlaps;left+=1) {
    for (let right=left+1;right<timings.length;right+=1) {
      if (Math.max(timings[left].startedAtMs,timings[right].startedAtMs)<
          Math.min(timings[left].finishedAtMs,timings[right].finishedAtMs)) { overlaps=true;break; }
    }
  }
  return {measured:valid,overlaps};
}

function pilotMetrics({results,elapsedMs,writerMs}) {
  const timings=results.map(result=>intervalTiming(result.raw));
  const valid=[2,5].includes(timings.length)&&timings.every(Boolean)&&timings.every(t=>t.waveId===timings[0].waveId);
  const overlaps=workerWaveTiming(results).overlaps;
  const workerMs=valid?timings.reduce((sum,item)=>sum+item.finishedAtMs-item.startedAtMs,0):0;
  const serialBaselineMs=workerMs+writerMs;
  const speedup=elapsedMs>0?serialBaselineMs/elapsedMs:0;
  const confirmedCount=results.filter(result=>result.entry?.state==='confirmed').length;
  return {timingMeasured:valid,parallelOverlap:!!overlaps,targetCount:results.length,confirmedCount,
    elapsedMs,workerMs,writerMs,serialBaselineMs,
    confirmedPerMinute:elapsedMs>0?Number((confirmedCount*60000/elapsedMs).toFixed(3)):0,
    speedup:Number.isFinite(speedup)?Number(speedup.toFixed(3)):0};
}

export async function runParallelBatch({manifest,checkpointState,targetCount=100,workers,targetCreatorIds,
  batchTargetCreatorIds,laneAssignments,
  runPageWave,commitOne,reconcileOne,persistCheckpoint,ownerIsIdle,assertLockOwnership,initialLaneCount=2,
  autoScaleToFive=true,retryErrors=false,resumeBlocked=false,singleLaneKnownFailureResume=false,
  retryExclusions=[],
  singleLaneBatchContinuation=false,
  completeBatchAtCurrentWorkers=false,
  onProgress,shouldContinue,newAttemptId=randomUUID,
  now=Date.now,leaseMs=5*60*1000,cohortStartedAtMs,performanceLimitMs}={}) {
  validateManifestAndState(manifest,checkpointState,targetCount);
  const selectedIndexes=selectedTargetIndexes(manifest,targetCount,targetCreatorIds);
  const excludedCreators=new Set(validateRetryExclusions({manifest,exclusions:retryExclusions})
    .map(exclusion=>exclusion.creatorId));
  for(const index of [...selectedIndexes])if(excludedCreators.has(manifest.targets[index].creatorId))selectedIndexes.delete(index);
  if (typeof runPageWave!=='function'||typeof commitOne!=='function'||
      typeof reconcileOne!=='function'||typeof persistCheckpoint!=='function'||
      typeof assertLockOwnership!=='function'||
      typeof ownerIsIdle!=='function'||typeof newAttemptId!=='function'||typeof now!=='function' ||
      !Number.isInteger(leaseMs)||leaseMs<1000||![2,5].includes(initialLaneCount)) fail('RUNNER_ARGUMENTS_INVALID');
  const workerByLane=validateWorkers(workers,autoScaleToFive,singleLaneBatchContinuation?1:2);
  if(initialLaneCount===5&&(workers.length!==5||!autoScaleToFive))fail('RUNNER_ARGUMENTS_INVALID');
  const assertLocks=async()=>{
    let proof;
    try { proof=await assertLockOwnership(); } catch { fail('CHECKPOINT_LOCK_REQUIRED'); }
    if (proof?.productionLockHeld!==true||proof?.checkpointLockHeld!==true) fail('CHECKPOINT_LOCK_REQUIRED');
  };
  await assertLocks();
  const state=checkpointState;
  const initialConfirmedCount=[...selectedIndexes].filter(index=>state.entries[index].state==='confirmed').length;
  const save=serializedQueue();
  const persistCurrent=()=>save(async()=>{await assertLocks();await persist(state,persistCheckpoint);});
  const writerQueue=serializedQueue();
  const reconciled=[];
  const progressCounts=()=>{
    const entries=[...selectedIndexes].map(index=>state.entries[index]);
    const count=predicate=>entries.filter(predicate).length;
    return {processedCount:count(entry=>entry.state!=='pending'),pendingCount:count(entry=>entry.state==='pending'),
      confirmedCount:count(entry=>entry.state==='confirmed'),errorCount:count(entry=>entry.state==='error'||entry.state==='blocked'),
      uncertainCount:count(entry=>entry.state==='uncertain'||entry.state==='in_flight'),cohortTargetCount:entries.length};
  };
  const continueAtBoundary=async phase=>{
    if (typeof shouldContinue!=='function') return true;
    try { return await shouldContinue({phase,targetCount,...progressCounts()})!==false; }
    catch { return false; }
  };
  const emitProgress=async phase=>{
    if (typeof onProgress!=='function') return;
    try { await onProgress({phase,targetCount,...progressCounts()}); } catch { /* Reporting never changes checkpoint state. */ }
  };
  const usedAttemptIds=new Set();
  for (const entry of state.entries) {
    if (typeof entry.attemptId!=='string') continue;
    if (usedAttemptIds.has(entry.attemptId)) fail('CHECKPOINT_ATTEMPT_DUPLICATE');
    usedAttemptIds.add(entry.attemptId);
  }

  // Never assign an in-flight/unknown attempt to another lane until the prior
  // owner is known idle and the same attempt has been reconciled read-only.
  for (const index of selectedIndexes) {
    const entry=state.entries[index];
    if (!['in_flight','uncertain'].includes(entry.state)) continue;
    const lease=entry.parallelLease;
    const target=manifest.targets[index];
    if (!lease || await ownerIsIdle({workerId:lease.workerId,laneId:lease.laneId,
      attemptId:entry.attemptId,target})!==true) continue;
    let reconciledResult;
    try { reconciledResult=await reconcileOne({target,attemptId:entry.attemptId,
      workerId:lease.workerId,laneId:lease.laneId,readOnly:true}); }
    catch { reconciledResult=null; }
    const next=checkpointEntryFromResult(reconciledResult,entry.attemptId,lease,target);
    state.entries[index]=next;
    reconciled.push(index);
    await persistCurrent();
  }

  if (completeBatchAtCurrentWorkers && (!Array.isArray(batchTargetCreatorIds)||autoScaleToFive)) {
    fail('RUNNER_ARGUMENTS_INVALID');
  }
  let shards=planParallelShards({manifest,state,targetCount,retryErrors,resumeBlocked,
    targetCreatorIds:batchTargetCreatorIds??targetCreatorIds,retryExclusions,laneAssignments});
  const nonempty=shards.filter(shard=>shard.targets.length>0);
  const selectedInitial=[...selectedIndexes].map(index=>state.entries[index]);
  const onlyKnownRetryableStates=selectedInitial.some(entry=>entry.state==='error'||entry.state==='blocked')&&
    selectedInitial.every(entry=>entry.state==='confirmed'||entry.state==='error'&&retryErrors||
      entry.state==='blocked'&&resumeBlocked);
  const singleLaneRetry=singleLaneKnownFailureResume===true&&onlyKnownRetryableStates&&
    targetCreatorIds!==undefined&&autoScaleToFive===true&&workers.length===PARALLEL_SHARD_COUNT&&nonempty.length===1;
  if(singleLaneKnownFailureResume===true&&!singleLaneRetry)fail('RUNNER_ARGUMENTS_INVALID');
  if (singleLaneBatchContinuation) {
    const activeCohortLanes=planParallelShards({manifest,state,targetCount,retryErrors,resumeBlocked,
      targetCreatorIds,retryExclusions,laneAssignments}).filter(shard=>shard.targets.length>0);
    const validTail=Array.isArray(targetCreatorIds)&&targetCreatorIds.length===50&&
      Array.isArray(batchTargetCreatorIds)&&batchTargetCreatorIds.length>0&&workers.length===1&&
      !autoScaleToFive&&completeBatchAtCurrentWorkers&&initialConfirmedCount>0&&
      batchTargetCreatorIds.every(id=>targetCreatorIds.includes(id))&&
      activeCohortLanes.length===1&&nonempty.length===1&&
      nonempty[0].laneIndex===activeCohortLanes[0].laneIndex&&workerByLane.has(nonempty[0].laneIndex);
    if (!validTail) fail('PILOT_SINGLE_LANE_TAIL_INVALID');
  }
  if (nonempty.length<2&&!singleLaneRetry&&!singleLaneBatchContinuation) return {state:'pilot_unavailable',targetCount,shardCount:PARALLEL_SHARD_COUNT,
    nonemptyShardCount:nonempty.length,reconciledCount:reconciled.length,activeLaneCount:0,
    reason:'PARALLEL_TWO_NONEMPTY_SHARDS_REQUIRED'};
  const pilotShards=singleLaneRetry||singleLaneBatchContinuation?[]:nonempty.slice(0,initialLaneCount);
  if (pilotShards.some(shard=>!workerByLane.has(shard.laneIndex))) return {state:'pilot_unavailable',
    targetCount,shardCount:PARALLEL_SHARD_COUNT,nonemptyShardCount:nonempty.length,
    reconciledCount:reconciled.length,activeLaneCount:0,reason:'PARALLEL_WORKER_FOR_NONEMPTY_SHARD_MISSING'};
  if (!await continueAtBoundary(singleLaneBatchContinuation?'before_tail':'before_pilot')) return {state:'parallel_paused',targetCount,
    shardCount:PARALLEL_SHARD_COUNT,nonemptyShardCount:nonempty.length,
    reconciledCount:reconciled.length,activeLaneCount:0,reason:'PARALLEL_STOP_REQUESTED',...progressCounts()};
  const claimsByLane=new Map();
  const claimFrom=(shard,worker)=>{
    const item=shard.targets[0];
    const current=state.entries[item.index];
    if (!entryEligible(current,{retryErrors,resumeBlocked}) || ['in_flight','uncertain'].includes(current.state)) return null;
    const prior=current.parallelLease;
    if (prior && prior.laneIndex!==shard.laneIndex) fail('OWNER_SHARD_MISMATCH');
    const attemptId=newAttemptId();
    if (typeof attemptId!=='string'||!attemptId||usedAttemptIds.has(attemptId)) fail('ATTEMPT_ID_INVALID_OR_DUPLICATE');
    usedAttemptIds.add(attemptId);
    const startedAtMs=now();
    const lease={workerId:worker.workerId,laneId:shard.laneId,laneIndex:shard.laneIndex,
      pageBindingId:worker.pageBindingId,leaseUntil:new Date(startedAtMs+leaseMs).toISOString()};
    state.entries[item.index]={state:'in_flight',attemptId,parallelLease:lease};
    return {...item,attemptId,workerId:worker.workerId,laneId:shard.laneId,laneIndex:shard.laneIndex,
      pageBindingId:worker.pageBindingId,lease};
  };
  for (const shard of pilotShards) {
    const worker=workerByLane.get(shard.laneIndex);
    if (!worker) return {state:'pilot_unavailable',targetCount,shardCount:PARALLEL_SHARD_COUNT,
      nonemptyShardCount:nonempty.length,reconciledCount:reconciled.length,activeLaneCount:0,
      reason:'PARALLEL_WORKER_FOR_NONEMPTY_SHARD_MISSING'};
    const claim=claimFrom(shard,worker);
    if (claim) claimsByLane.set(shard.laneIndex,{shard,worker,claim,cursor:1});
  }
  if (!singleLaneRetry&&!singleLaneBatchContinuation&&claimsByLane.size!==initialLaneCount) return {state:'pilot_unavailable',targetCount,shardCount:PARALLEL_SHARD_COUNT,
    nonemptyShardCount:nonempty.length,reconciledCount:reconciled.length,activeLaneCount:0,
    reason:'PARALLEL_TWO_TARGETS_NOT_CLAIMABLE'};
  await persistCurrent();

  let report={state:singleLaneRetry||singleLaneBatchContinuation?'parallel_running':'pilot_running',targetCount,shardCount:PARALLEL_SHARD_COUNT,
    eligibleCount:nonempty.reduce((sum,shard)=>sum+shard.targets.length,0),
    nonemptyShardCount:nonempty.length,reconciledCount:reconciled.length,
    activeLaneCount:singleLaneRetry||singleLaneBatchContinuation?1:initialLaneCount,
    committedCount:0,errorCount:0,uncertainCount:0};

  const runWave=async(laneClaims)=>{
    const claims=laneClaims.map(item=>item.claim);
    const waveStartedAt=now();
    let rawResults;
    try { rawResults=await runPageWave({claims}); }
    catch {
      for (const claim of claims) state.entries[claim.index]=uncertainEntry(claim.attemptId,claim.lease);
      await persistCurrent();
      return {ok:false,results:[],elapsedMs:Math.max(0,now()-waveStartedAt),writerMs:0,
        timingMeasured:false,parallelOverlap:false};
    }
    if (!Array.isArray(rawResults)||rawResults.length!==claims.length) {
      for (const claim of claims) state.entries[claim.index]=uncertainEntry(claim.attemptId,claim.lease,'PARALLEL_RESULT_SET_INVALID');
      await persistCurrent();
      return {ok:false,results:[],elapsedMs:Math.max(0,now()-waveStartedAt),writerMs:0,
        timingMeasured:false,parallelOverlap:false};
    }
    const byAttempt=new Map();
    for (const raw of rawResults) {
      if (!raw || typeof raw.attemptId!=='string' || byAttempt.has(raw.attemptId)) {
        for (const claim of claims) state.entries[claim.index]=uncertainEntry(claim.attemptId,claim.lease,'PARALLEL_RESULT_SET_INVALID');
        await persistCurrent();
        return {ok:false,results:[],elapsedMs:Math.max(0,now()-waveStartedAt),writerMs:0,
          timingMeasured:false,parallelOverlap:false};
      }
      byAttempt.set(raw.attemptId,raw);
    }
    let writerMs=0;
    const outcomes=[];
    let stop=false;
    for (let claimIndex=0;claimIndex<claims.length;claimIndex+=1) {
      const claim=claims[claimIndex];
      const raw=byAttempt.get(claim.attemptId);
      if (!validatePageResult(raw,claim)) {
        if (raw) raw.writeIntent=null;
        const entry=checkpointEntryFromResult({attemptId:claim.attemptId,outcome:'error',
          writeState:'not_written',reason:'PARALLEL_PAGE_RESULT_MISMATCH'},claim.attemptId,claim.lease,claim.target);
        state.entries[claim.index]=entry;
        await persistCurrent();
        outcomes.push({claim,raw,entry,pageVerified:false,writeVerified:false,writeMs:0});
        stop=true;
      } else {
        try { assertWorkerIdentity({target:{...claim.target,attemptId:claim.attemptId},result:raw}); }
        catch (error) {
          raw.writeIntent=null;
          const entry=checkpointEntryFromResult({attemptId:claim.attemptId,outcome:'error',
            writeState:'not_written',reason:safeReason(error?.message)||'PARALLEL_IDENTITY_UNVERIFIED'},
            claim.attemptId,claim.lease,claim.target);
          state.entries[claim.index]=entry;
          await persistCurrent();
          outcomes.push({claim,raw,entry,pageVerified:false,writeVerified:false,writeMs:0});
          stop=true;
        }
        if (!stop && (raw.writeIntent===null || raw.writeIntent===undefined)) {
          const canRecordWithoutWriter=['error','auth_blocked','risk_blocked'].includes(raw.outcome) &&
            raw.writeState==='not_written';
          let entry=canRecordWithoutWriter
            ?checkpointEntryFromResult(raw,claim.attemptId,claim.lease,claim.target)
            :checkpointEntryFromResult({attemptId:claim.attemptId,outcome:'error',writeState:'not_written',
              reason:'PARALLEL_WRITE_INTENT_MISSING'},claim.attemptId,claim.lease,claim.target);
          if (entry.state==='uncertain' && await ownerIsIdle({workerId:claim.workerId,laneId:claim.laneId,
            attemptId:claim.attemptId,target:claim.target})===true) {
            let recovered=null;
            try { recovered=await reconcileOne({target:claim.target,attemptId:claim.attemptId,
              workerId:claim.workerId,laneId:claim.laneId,readOnly:true}); } catch {}
            entry=checkpointEntryFromResult(recovered,claim.attemptId,claim.lease,claim.target);
          }
          raw.writeIntent=null;
          state.entries[claim.index]=entry;
          await persistCurrent();
          outcomes.push({claim,raw,entry,pageVerified:raw.preflightFailure!==true&&raw.pageGuardPassed===true,
            writeVerified:false,writeMs:0});
          if (!canRecordWithoutWriter || entry.state==='uncertain'||entry.state==='blocked') stop=true;
        }
        if (!stop && raw.writeIntent!==null && raw.writeIntent!==undefined) {
          const writeStartedAt=now();
          let writeResult;
          try {
            writeResult=await writerQueue(()=>commitOne({target:claim.target,attemptId:claim.attemptId,
              workerId:claim.workerId,laneId:claim.laneId,writeIntent:raw.writeIntent}));
          } catch { writeResult=null; }
          const writeMs=Math.max(0,now()-writeStartedAt);
          writerMs+=writeMs;
          raw.writeIntent=null;
          let entry=checkpointEntryFromResult(writeResult,claim.attemptId,claim.lease,claim.target);
          if (entry.state!=='uncertain' && entry.outcome!==raw.outcome) {
            entry=uncertainEntry(claim.attemptId,claim.lease,'PARALLEL_OUTCOME_MISMATCH');
          }
          if (entry.state==='uncertain') {
            let recovered=null;
            if (await ownerIsIdle({workerId:claim.workerId,laneId:claim.laneId,
              attemptId:claim.attemptId,target:claim.target})===true) {
              try { recovered=await reconcileOne({target:claim.target,attemptId:claim.attemptId,
                workerId:claim.workerId,laneId:claim.laneId,readOnly:true}); } catch {}
            }
            entry=checkpointEntryFromResult(recovered,claim.attemptId,claim.lease,claim.target);
            if (entry.state!=='uncertain' && entry.outcome!==raw.outcome&&recovered?.parallelAttemptNotWritten!==true) {
              entry=uncertainEntry(claim.attemptId,claim.lease,'PARALLEL_OUTCOME_MISMATCH');
            }
          }
          state.entries[claim.index]=entry;
          await persistCurrent();
          outcomes.push({claim,raw,entry,pageVerified:true,writeVerified:entry.state==='confirmed',writeMs});
          if (entry.state==='uncertain'||entry.state==='blocked') stop=true;
        }
      }
      if (stop) {
        // These remaining claims completed page inspection but never reached the
        // central writer. Mark them as known not written and discard each intent.
        for (const remaining of claims.slice(claimIndex+1)) {
          const untouched=byAttempt.get(remaining.attemptId);
          if (untouched) untouched.writeIntent=null;
          const entry=checkpointEntryFromResult({attemptId:remaining.attemptId,outcome:'error',
            writeState:'not_written',reason:'PARALLEL_WAVE_HALTED'},remaining.attemptId,remaining.lease,remaining.target);
          state.entries[remaining.index]=entry;
          outcomes.push({claim:remaining,raw:untouched,entry,pageVerified:validatePageResult(untouched,remaining),
            writeVerified:false,writeMs:0});
        }
        if (claims.length>claimIndex+1) await persistCurrent();
        break;
      }
    }
    const overlap=workerWaveTiming(outcomes.map(item=>({raw:item.raw})));
    return {ok:!stop,results:outcomes,elapsedMs:Math.max(0,now()-waveStartedAt),writerMs,
      timingMeasured:overlap.measured,parallelOverlap:overlap.overlaps};
  };

  if (performanceLimitMs!==undefined&&(!Number.isInteger(performanceLimitMs)||performanceLimitMs<1||
      selectedIndexes.size!==50||!Number.isFinite(cohortStartedAtMs)||cohortStartedAtMs<0)) {
    fail('PERFORMANCE_GATE_ARGUMENTS_INVALID');
  }
  const cohortStartedAt=Number.isFinite(cohortStartedAtMs)?cohortStartedAtMs:now();
  let pilotTiming={timingMeasured:false,parallelOverlap:false,workerMs:0,writerMs:0,
    serialBaselineMs:0,speedup:0,confirmedPerMinute:0};
  if(!singleLaneRetry&&!singleLaneBatchContinuation){
    const pilotResult=await runWave([...claimsByLane.values()]);
    const uniqueTargets=new Set([...claimsByLane.values()].map(({claim})=>claim.target.creatorId)).size===initialLaneCount &&
      new Set([...claimsByLane.values()].map(({claim})=>claim.target.recordId)).size===initialLaneCount &&
      new Set([...claimsByLane.values()].map(({worker})=>worker.pageBindingId)).size===initialLaneCount;
    pilotTiming=pilotMetrics({results:pilotResult.results,elapsedMs:pilotResult.elapsedMs,writerMs:pilotResult.writerMs});
    const pilotPassed=pilotResult.ok&&uniqueTargets&&pilotResult.results.length===initialLaneCount&&
      pilotResult.results.every(item=>item.pageVerified&&item.writeVerified&&item.entry.readbackVerified===true)&&
      pilotTiming.parallelOverlap;
    report={...report,pilot:{passed:pilotPassed,distinctTargets:uniqueTargets,...pilotTiming},
      committedCount:pilotResult.results.filter(item=>item.entry.state==='confirmed').length,
      errorCount:pilotResult.results.filter(item=>item.entry.state==='error'||item.entry.state==='blocked').length,
      uncertainCount:pilotResult.results.filter(item=>item.entry.state==='uncertain'||item.entry.state==='in_flight').length};
    await emitProgress('pilot_complete');
    if (!pilotPassed) return {...report,state:'pilot_failed',activeLaneCount:initialLaneCount,
      reason:pilotResult.ok?'PARALLEL_PILOT_ACCEPTANCE_FAILED':'PARALLEL_PILOT_WAVE_FAILED'};
    if (!autoScaleToFive&&!completeBatchAtCurrentWorkers) return {...report,state:'pilot_passed',activeLaneCount:initialLaneCount};
  }
  if (!singleLaneRetry&&!singleLaneBatchContinuation&&!await continueAtBoundary('before_scale')) return {...report,state:'parallel_paused',
    activeLaneCount:initialLaneCount,reason:'PARALLEL_STOP_REQUESTED',...progressCounts()};

  const continuationStartedAt=now();
  let fiveLaneProcessedCount=0,fiveLaneConfirmedCount=0,fiveLaneErrorCount=0,fiveLaneUncertainCount=0;
  let fiveLaneWorkerMs=0,fiveLaneWriterMs=0,fiveLaneMeasuredWorkerWaves=0,fiveLaneOverlapEvidenceWaves=0;
  report={...report,state:'parallel_running',activeLaneCount:workerByLane.size};
  shards=planParallelShards({manifest,state,targetCount,retryErrors,resumeBlocked,
    targetCreatorIds:batchTargetCreatorIds??targetCreatorIds,retryExclusions,laneAssignments});
  const cursors=new Map(shards.map(shard=>[shard.laneIndex,0]));
  let stop=false;
  let pauseRequested=false;
  let cohortWorkerMs=pilotTiming.workerMs;
  let cohortWriterMs=pilotTiming.writerMs;
  let measuredWorkerWaves=pilotTiming.timingMeasured?1:0;
  let overlapEvidenceWaves=pilotTiming.parallelOverlap?1:0;
  while (!stop) {
    if (!await continueAtBoundary('before_wave')) { stop=true;pauseRequested=true;break; }
    const laneClaims=[];
    for (const shard of shards) {
      const worker=workerByLane.get(shard.laneIndex);
      if (!worker) continue;
      let cursor=cursors.get(shard.laneIndex)||0;
      while (cursor<shard.targets.length) {
        const item=shard.targets[cursor++];
        const entry=state.entries[item.index];
        if (!entryEligible(entry,{retryErrors,resumeBlocked}) || ['in_flight','uncertain'].includes(entry.state)) continue;
        const previousLease=entry.parallelLease;
        if (previousLease && previousLease.laneIndex!==shard.laneIndex) fail('OWNER_SHARD_MISMATCH');
        const attemptId=newAttemptId();
        if (typeof attemptId!=='string'||!attemptId||usedAttemptIds.has(attemptId)) fail('ATTEMPT_ID_INVALID_OR_DUPLICATE');
        usedAttemptIds.add(attemptId);
        const startedAtMs=now();
        const lease={workerId:worker.workerId,laneId:shard.laneId,laneIndex:shard.laneIndex,
          pageBindingId:worker.pageBindingId,leaseUntil:new Date(startedAtMs+leaseMs).toISOString()};
        state.entries[item.index]={state:'in_flight',attemptId,parallelLease:lease};
        laneClaims.push({shard,worker,claim:{...item,attemptId,workerId:worker.workerId,laneId:shard.laneId,
          laneIndex:shard.laneIndex,pageBindingId:worker.pageBindingId,lease}});
        break;
      }
      cursors.set(shard.laneIndex,cursor);
    }
    if (!laneClaims.length) break;
    await persistCurrent();
    const wave=await runWave(laneClaims);
    cohortWriterMs+=wave.writerMs;
    if (wave.timingMeasured) measuredWorkerWaves+=1;
    if (wave.parallelOverlap) overlapEvidenceWaves+=1;
    cohortWorkerMs+=wave.results.reduce((sum,item)=>{
      const timing=intervalTiming(item.raw);
      return sum+(timing?Math.max(0,timing.finishedAtMs-timing.startedAtMs):0);
    },0);
    fiveLaneProcessedCount+=wave.results.length;
    fiveLaneConfirmedCount+=wave.results.filter(item=>item.entry.state==='confirmed').length;
    fiveLaneErrorCount+=wave.results.filter(item=>item.entry.state==='error'||item.entry.state==='blocked').length;
    fiveLaneUncertainCount+=wave.results.filter(item=>item.entry.state==='uncertain'||item.entry.state==='in_flight').length;
    fiveLaneWorkerMs+=wave.results.reduce((sum,item)=>{
      const timing=intervalTiming(item.raw);
      return sum+(timing?Math.max(0,timing.finishedAtMs-timing.startedAtMs):0);
    },0);
    fiveLaneWriterMs+=wave.writerMs;
    if (wave.timingMeasured) fiveLaneMeasuredWorkerWaves+=1;
    if (wave.parallelOverlap) fiveLaneOverlapEvidenceWaves+=1;
    report.committedCount+=wave.results.filter(item=>item.entry.state==='confirmed').length;
    report.errorCount+=wave.results.filter(item=>item.entry.state==='error'||item.entry.state==='blocked').length;
    report.uncertainCount+=wave.results.filter(item=>item.entry.state==='uncertain'||item.entry.state==='in_flight').length;
    await emitProgress('wave_complete');
    if (!wave.ok) stop=true;
  }
  const selectedEntries=[...selectedIndexes].map(index=>state.entries[index]);
  const remaining=selectedEntries.filter(entry=>
    ['pending','in_flight','uncertain','blocked','error'].includes(entry.state)).length;
  const cohortWallMs=Math.max(0,now()-cohortStartedAt);
  const continuationWallMs=Math.max(0,now()-continuationStartedAt);
  const serialEquivalentMs=cohortWorkerMs+cohortWriterMs;
  const confirmedCount=selectedEntries.filter(entry=>entry.state==='confirmed').length;
  const readbackVerifiedCount=selectedEntries.filter(entry=>entry.state==='confirmed'&&entry.readbackVerified===true).length;
  const newlyConfirmedCount=Math.max(0,confirmedCount-initialConfirmedCount);
  const cohortComplete=selectedEntries.length===50&&confirmedCount===50&&readbackVerifiedCount===50&&remaining===0;
  const performanceGate=performanceLimitMs===undefined?undefined:{
    status:cohortWallMs>performanceLimitMs?'failed':cohortComplete?'passed':'incomplete',
    passed:cohortComplete&&cohortWallMs<=performanceLimitMs,
    elapsedMs:cohortWallMs,limitMs:performanceLimitMs,targetCount:selectedEntries.length,
    confirmedCount,readbackVerifiedCount,completed:cohortComplete,
  };
  const fiveLaneSerialEquivalentMs=fiveLaneWorkerMs+fiveLaneWriterMs;
  report={...report,cohort:{targetCount:selectedEntries.length,processedCount:selectedEntries.filter(entry=>entry.state!=='pending').length,
    confirmedCount,newlyConfirmedCount,errorCount:selectedEntries.filter(entry=>entry.state==='error'||entry.state==='blocked').length,
    uncertainCount:selectedEntries.filter(entry=>entry.state==='uncertain'||entry.state==='in_flight').length,remaining,
    wallMs:cohortWallMs,workerMs:cohortWorkerMs,writerMs:cohortWriterMs,serialEquivalentMs,
    estimatedSpeedup:cohortWallMs>0?Number((serialEquivalentMs/cohortWallMs).toFixed(3)):0,
    confirmedPerMinute:cohortWallMs>0?Number((newlyConfirmedCount*60000/cohortWallMs).toFixed(3)):0,
    overlapEvidenceWaves,measuredWorkerWaves,
    allMeasuredWavesOverlapped:measuredWorkerWaves>0&&overlapEvidenceWaves===measuredWorkerWaves,
    ...(completeBatchAtCurrentWorkers&&!autoScaleToFive?{continuation:{workerCount:workerByLane.size,
      processedCount:fiveLaneProcessedCount,confirmedCount:fiveLaneConfirmedCount,
      errorCount:fiveLaneErrorCount,uncertainCount:fiveLaneUncertainCount,wallMs:continuationWallMs,
      workerMs:fiveLaneWorkerMs,writerMs:fiveLaneWriterMs,serialEquivalentMs:fiveLaneSerialEquivalentMs,
      confirmedPerMinute:continuationWallMs>0?Number((fiveLaneConfirmedCount*60000/continuationWallMs).toFixed(3)):0,
      estimatedSpeedup:continuationWallMs>0?Number((fiveLaneSerialEquivalentMs/continuationWallMs).toFixed(3)):0,
      overlapEvidenceWaves:fiveLaneOverlapEvidenceWaves,measuredWorkerWaves:fiveLaneMeasuredWorkerWaves,
      allMeasuredWavesOverlapped:fiveLaneMeasuredWorkerWaves>0&&
        fiveLaneOverlapEvidenceWaves===fiveLaneMeasuredWorkerWaves}}:{fiveLane:{processedCount:fiveLaneProcessedCount,
      confirmedCount:fiveLaneConfirmedCount,errorCount:fiveLaneErrorCount,uncertainCount:fiveLaneUncertainCount,
      wallMs:continuationWallMs,workerMs:fiveLaneWorkerMs,writerMs:fiveLaneWriterMs,
      serialEquivalentMs:fiveLaneSerialEquivalentMs,
      confirmedPerMinute:continuationWallMs>0?Number((fiveLaneConfirmedCount*60000/continuationWallMs).toFixed(3)):0,
      estimatedSpeedup:continuationWallMs>0?Number((fiveLaneSerialEquivalentMs/continuationWallMs).toFixed(3)):0,
      overlapEvidenceWaves:fiveLaneOverlapEvidenceWaves,measuredWorkerWaves:fiveLaneMeasuredWorkerWaves,
      allMeasuredWavesOverlapped:fiveLaneMeasuredWorkerWaves>0&&
        fiveLaneOverlapEvidenceWaves===fiveLaneMeasuredWorkerWaves}}),
    baselineKind:'same_cohort_serial_equivalent'}};
  const performanceFailed=performanceGate?.status==='failed';
  const batchEntries=batchTargetCreatorIds===undefined?null:batchTargetCreatorIds.map(id=>{
    const index=manifest.targets.findIndex(target=>target.creatorId===id);
    return index<0?null:state.entries[index];
  }).filter(Boolean);
  const batchReport=batchEntries?{targetCount:batchEntries.length,processedCount:batchEntries.filter(entry=>entry.state!=='pending').length,
    confirmedCount:batchEntries.filter(entry=>entry.state==='confirmed').length,
    errorCount:batchEntries.filter(entry=>entry.state==='error'||entry.state==='blocked').length,
    uncertainCount:batchEntries.filter(entry=>entry.state==='uncertain'||entry.state==='in_flight').length,
    workerCount:workerByLane.size}:null;
  const finalState=performanceFailed?'parallel_performance_failed':pauseRequested?'parallel_paused':stop?'parallel_stopped':
    batchReport&&!cohortComplete?'parallel_batch_finished':'parallel_finished';
  return {...report,...(batchReport?{batch:batchReport}:{}),state:finalState,
    ...(performanceFailed?{reason:'PARALLEL_COHORT_EXCEEDED_10_MINUTES'}:{}),
    ...(performanceGate?{cohort:{...report.cohort,performanceGate}}:{}),remaining,
    activeLaneCount:workerByLane.size};
}
