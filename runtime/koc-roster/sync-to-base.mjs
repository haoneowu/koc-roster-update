import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR, readPrivateJson} from './checkpoint.mjs';
import {classifyRankedRows, normalizeText, pageFingerprint, ROSTER_SCOPE_KEY, ROSTER_SCOPE_LABEL} from './roster-domain.mjs';
import {ensureRosterFields, FEISHU_ROUTE, LarkBaseClient, listRosterIndex, syncRosterAddOnlyBatch,
  syncRosterBatch, validateRosterFields} from './lark-writer.mjs';

function parseArgs(argv) {
  const result = {stateDir:DEFAULT_STATE_DIR, limit:5, newOnly:false, full:false, dailyAddOnly:false, batchId:''};
  let limitProvided=false;
  for (let i=0;i<argv.length;i+=1) {
    const arg=argv[i];
    if (arg==='--state-dir') result.stateDir=path.resolve(argv[++i]);
    else if (arg==='--limit') { result.limit=Number(argv[++i]); limitProvided=true; }
    else if (arg==='--batch-id') result.batchId=String(argv[++i]||'');
    else if (arg==='--new-only') result.newOnly=true;
    else if (arg==='--full') result.full=true;
    else if (arg==='--daily-add-only') result.dailyAddOnly=true;
    else throw new Error('KOC_SYNC_ARGUMENT_UNSUPPORTED');
  }
  if (!result.batchId || !/^[A-Za-z0-9_-]{8,64}$/.test(result.batchId)) throw new Error('KOC_SYNC_BATCH_ID_REQUIRED');
  if (!Number.isInteger(result.limit) || result.limit<1 || result.limit>500) throw new Error('KOC_SYNC_LIMIT_INVALID');
  if ([result.full,result.newOnly,result.dailyAddOnly].filter(Boolean).length>1) throw new Error('KOC_SYNC_MODE_CONFLICT');
  if (result.dailyAddOnly && limitProvided) throw new Error('KOC_DAILY_LIMIT_UNSUPPORTED');
  if (!result.full && !result.dailyAddOnly && result.limit>5) throw new Error('KOC_SAMPLE_LIMIT_MAX_5');
  result.stateDir=path.resolve(result.stateDir);
  return result;
}

function assertCheckpointEvidence(checkpoint, {dailyAddOnly = false, full = false} = {}) {
  if (checkpoint.scopeKey!==ROSTER_SCOPE_KEY || checkpoint.scopeLabel!==ROSTER_SCOPE_LABEL) {
    throw new Error('KOC_SYNC_CHECKPOINT_SCOPE_MISMATCH');
  }
  const filterEvidence=checkpoint.filterEvidence||{};
  const selectedCategoryTagProof=filterEvidence.selectedCategoryTags?.length===1 &&
    /^达人分类\s*[:：]\s*萌宠\s*[-－‐‑–—>›→]\s*宠物猫$/.test(filterEvidence.selectedCategoryTags[0]);
  const categoryProof=selectedCategoryTagProof ||
    (filterEvidence.selectedControl?.length===1 && filterEvidence.categoryMenuCount===1 &&
      filterEvidence.categoryBreadcrumbs?.length<=1) ||
    (filterEvidence.selectedControl?.length===0 && filterEvidence.categoryBreadcrumbs?.length===1 &&
      filterEvidence.categoryMenuCount<=1);
  if (filterEvidence.selectedCategory!=='宠物猫' || filterEvidence.categoryButtonCount!==1 || !categoryProof ||
      filterEvidence.selectedBoardType!=='视频达人' || filterEvidence.selectedBoardControls?.length!==1 ||
      filterEvidence.selectedBoardControls[0]!=='视频达人' || filterEvidence.boardTabGroupCount!==1 ||
      filterEvidence.videoBoardTabCount!==1 || !filterEvidence.timeEvidence?.some(line=>/所选类目下达人近30天数据/.test(line)) ||
      filterEvidence.near30HasTradeControlCount!==1 || filterEvidence.near30HasTrade!==false) {
    throw new Error('KOC_SYNC_FILTER_EVIDENCE_MISSING');
  }
  if (checkpoint.sortEvidence?.verified!==true || checkpoint.sortEvidence?.direction!=='desc' ||
      checkpoint.sortEvidence?.uiDirection!=='desc' || checkpoint.sortEvidence?.metric!=='视频销售额') {
    throw new Error('KOC_SYNC_SORT_EVIDENCE_MISSING');
  }
  if ((dailyAddOnly||full) && normalizeText(checkpoint.failureReason)) {
    throw new Error('KOC_SYNC_CHECKPOINT_HAS_FAILURE_REASON');
  }
  if (full && (checkpoint.status!=='target_reached' || checkpoint.targetReached!==true)) {
    throw new Error('KOC_FULL_SYNC_REQUIRES_COMPLETE_TARGET');
  }
  if (dailyAddOnly) {
    const completeTop500=checkpoint.status==='target_reached' && checkpoint.targetReached===true;
    const completeSourceShortage=checkpoint.status==='source_exhausted' && checkpoint.sourceComplete===true &&
      checkpoint.targetReached!==true;
    if (checkpoint.targetCount!==500 || (!completeTop500 && !completeSourceShortage)) {
      throw new Error('KOC_DAILY_SOURCE_NOT_COMPLETE');
    }
    const filteredCandidateCount=classifyRankedRows(checkpoint.pages.flatMap(page=>page.rows)).eligible.length;
    if (completeTop500 && filteredCandidateCount<500) throw new Error('KOC_DAILY_TARGET_CLAIM_MISMATCH');
    if (completeSourceShortage && filteredCandidateCount>=500) throw new Error('KOC_DAILY_SOURCE_STATUS_MISMATCH');
  }
}

function dailySourceFingerprint(checkpoint, sourceTop500) {
  const stableEvidence={version:1,status:checkpoint.status,targetCount:checkpoint.targetCount,
    targetReached:checkpoint.targetReached===true,sourceComplete:checkpoint.sourceComplete===true,
    capturedAt:checkpoint.pages[0].capturedAt||checkpoint.startedAt||'',
    rankedRowsFingerprint:pageFingerprint(sourceTop500)};
  return createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex');
}

function fullSourceFingerprint(checkpoint, rawRows) {
  const stableEvidence={version:1,status:checkpoint.status,targetCount:checkpoint.targetCount,
    targetReached:checkpoint.targetReached===true,sourceComplete:checkpoint.sourceComplete===true,
    capturedAt:checkpoint.pages[0].capturedAt||checkpoint.startedAt||'',
    rankedRowsFingerprint:pageFingerprint(rawRows)};
  return createHash('sha256').update(JSON.stringify(stableEvidence)).digest('hex');
}

async function readPriorReceipt(receiptPath) {
  try { await fs.access(receiptPath); return await readPrivateJson(receiptPath); }
  catch (error) { if (error?.code==='ENOENT') return null; throw error; }
}

function publicResult(result, {args, schema, classification, selected, replay, receiptPath}) {
  return {passed:true,mode:args.full?'full':args.newOnly?'new_sample':args.dailyAddOnly?'daily_add_only':'sample',
    route:`${FEISHU_ROUTE.profile}/${FEISHU_ROUTE.as}`,baseToken:FEISHU_ROUTE.baseToken,tableId:FEISHU_ROUTE.tableId,
    batchId:args.batchId,selectedRows:selected.length,excludedMerchants:classification.excluded.length,
    heldForReview:classification.review.length,preexistingRows:classification.existing.length,
    replay,createdFields:schema.created,createdCount:result.createdCount,updatedCount:result.updatedCount,
    skippedExistingCount:result.skippedExistingCount??0,reconciledCount:result.reconciledCount,
    recoveredWriteCount:result.recoveredWriteCount,readbackVerified:result.readbackVerifiedCount,
    zeroAdditions:result.zeroAdditions??false,receiptPath};
}

export async function runSyncToBase(args, {client:providedClient} = {}) {
  if (!args?.batchId || !/^[A-Za-z0-9_-]{8,64}$/.test(args.batchId)) throw new Error('KOC_SYNC_BATCH_ID_REQUIRED');
  args={...args,limit:args.limit??5};
  if ([args.full===true,args.newOnly===true,args.dailyAddOnly===true].filter(Boolean).length>1) {
    throw new Error('KOC_SYNC_MODE_CONFLICT');
  }
  if (!args.full && !args.dailyAddOnly && (!Number.isInteger(args.limit) || args.limit<1 || args.limit>5)) {
    throw new Error('KOC_SAMPLE_LIMIT_MAX_5');
  }
  if (args.newOnly && args.limit<3) throw new Error('KOC_NEW_SAMPLE_REQUIRES_AT_LEAST_3_ROWS');
  const stateDir=path.resolve(args.stateDir||DEFAULT_STATE_DIR);
  const checkpointPath=path.join(stateDir,`${args.batchId}.checkpoint.json`);
  const checkpoint=await readPrivateJson(checkpointPath);
  if (checkpoint.batchId!==args.batchId || !Array.isArray(checkpoint.pages) || !checkpoint.pages.length ||
      checkpoint.pages.some((page,index)=>page.page!==index+1 || !Array.isArray(page.rows) || !page.rows.length)) {
    throw new Error('KOC_SYNC_CHECKPOINT_INVALID');
  }
  assertCheckpointEvidence(checkpoint,{dailyAddOnly:args.dailyAddOnly===true,full:args.full===true});
  const receiptPath=path.join(stateDir,`${args.batchId}.write-receipt.json`);
  const priorReceipt=await readPriorReceipt(receiptPath);
  if (priorReceipt && (args.dailyAddOnly ? priorReceipt.mode!=='daily-add-only' :
      priorReceipt.mode==='daily-add-only' || priorReceipt.fullSnapshot!==!!args.full)) {
    throw new Error('KOC_SYNC_PRIOR_RECEIPT_MODE_MISMATCH');
  }
  if (priorReceipt && (priorReceipt.scopeKey!==checkpoint.scopeKey || priorReceipt.scope!==checkpoint.scopeLabel)) {
    throw new Error('KOC_SYNC_PRIOR_RECEIPT_SCOPE_MISMATCH');
  }
  if (args.full && priorReceipt && (!Array.isArray(priorReceipt.plannedCreators)||priorReceipt.plannedCreators.length!==500)) {
    throw new Error('KOC_FULL_PRIOR_RECEIPT_INVALID');
  }

  const rawRows=checkpoint.pages.flatMap(page=>page.rows);
  const fullFingerprint=args.full?fullSourceFingerprint(checkpoint,rawRows):'';
  if (args.full && priorReceipt) {
    if (priorReceipt.status!=='complete') {
      throw new Error('KOC_FULL_INTERRUPTED_REPLAY_REQUIRES_NEW_BATCH');
    }
    const fingerprintWasStored=typeof priorReceipt.sourceEvidence?.sourceFingerprint==='string';
    if (fingerprintWasStored && priorReceipt.sourceEvidence.sourceFingerprint!==fullFingerprint) {
      throw new Error('KOC_FULL_REPLAY_SOURCE_MISMATCH');
    }
    const rowsById=new Map(rawRows.map(row=>[normalizeText(row.creatorId),row]));
    for (const item of priorReceipt.plannedCreators) {
      const row=rowsById.get(normalizeText(item.creatorId));
      if (!row) throw new Error('KOC_SYNC_REPLAY_ROW_MISSING');
      if (!Number.isInteger(item.sourceRank)||item.sourceRank!==row.sourceRank) {
        throw new Error('KOC_FULL_REPLAY_PLAN_MISMATCH');
      }
    }
    return {passed:true,mode:'full',route:`${FEISHU_ROUTE.profile}/${FEISHU_ROUTE.as}`,
      baseToken:FEISHU_ROUTE.baseToken,tableId:FEISHU_ROUTE.tableId,batchId:args.batchId,
      selectedRows:500,replay:true,alreadyCompleted:true,createdFields:[],createdCount:0,updatedCount:0,
      skippedExistingCount:0,reconciledCount:0,recoveredWriteCount:0,readbackVerified:0,
      previousReadbackVerified:priorReceipt.readbackVerifiedCount??0,sourceFingerprintVerified:fingerprintWasStored,
      zeroAdditions:false,receiptPath};
  }
  const client=providedClient||new LarkBaseClient({route:FEISHU_ROUTE});
  const schema=args.dailyAddOnly?await validateRosterFields(client):await ensureRosterFields(client);
  const existingIndex=await listRosterIndex(client);
  const classification=classifyRankedRows(rawRows,{existingIds:[...existingIndex.keys()]});
  let selected;
  let replay=false;
  if (args.dailyAddOnly) {
    const rankedCandidates=[...classification.eligible,...classification.existing].sort((a,b)=>a.sourceRank-b.sourceRank);
    const sourceTop500=rankedCandidates.slice(0,500);
    const sourceTop500ById=new Map(sourceTop500.map(row=>[normalizeText(row.creatorId),row]));
    const top500Fingerprint=dailySourceFingerprint(checkpoint,sourceTop500);
    if (priorReceipt) {
      if (!Array.isArray(priorReceipt.plannedCreators)) throw new Error('KOC_DAILY_PRIOR_RECEIPT_INVALID');
      if (priorReceipt.sourceEvidence?.top500Fingerprint!==top500Fingerprint) {
        throw new Error('KOC_DAILY_REPLAY_SOURCE_MISMATCH');
      }
      selected=priorReceipt.plannedCreators.map(item=>{
        const row=sourceTop500ById.get(normalizeText(item.creatorId));
        if (!row) return undefined;
        if (!Number.isInteger(item.sourceRank)||item.sourceRank!==row.sourceRank) {
          throw new Error('KOC_DAILY_REPLAY_PLAN_MISMATCH');
        }
        return row;
      });
      if (selected.some(row=>!row)) throw new Error('KOC_DAILY_REPLAY_ROW_MISSING');
      replay=true;
    } else {
      selected=sourceTop500.filter(row=>!existingIndex.has(normalizeText(row.creatorId)));
    }
    const verificationStatus=checkpoint.status==='target_reached'
      ? '已核验完整当期Top500' : '已核验来源耗尽；不足当期Top500';
    const result=await syncRosterAddOnlyBatch(client,selected,{batchId:args.batchId,
      capturedAt:checkpoint.pages[0].capturedAt||checkpoint.startedAt,receiptPath,stateDir,priorReceipt,
      verificationStatus,scopeKey:checkpoint.scopeKey,scope:checkpoint.scopeLabel,
      sourceEvidence:{status:checkpoint.status,targetCount:checkpoint.targetCount,targetReached:checkpoint.targetReached===true,
        sourceComplete:checkpoint.sourceComplete===true,sourceRankedRows:sourceTop500.length,
        filteredCandidateCount:rankedCandidates.length,top500Fingerprint}});
    return {...publicResult(result,{args,schema,classification,selected,replay,receiptPath}),
      sourceStatus:checkpoint.status,sourceRankedRows:sourceTop500.length,
      filteredCandidateCount:rankedCandidates.length};
  }

  if (priorReceipt?.plannedCreators?.length) {
    const rowsById=new Map(rawRows.map(row=>[normalizeText(row.creatorId),row]));
    selected=priorReceipt.plannedCreators.map(item=>rowsById.get(normalizeText(item.creatorId)));
    if (selected.some(row=>!row)) throw new Error('KOC_SYNC_REPLAY_ROW_MISSING');
    replay=true;
  } else if (args.full) {
    if (classification.eligible.length+classification.existing.length<500) throw new Error('KOC_FULL_SYNC_REQUIRES_500_ELIGIBLE_UNIQUE');
    selected=[...classification.eligible,...classification.existing].sort((a,b)=>a.sourceRank-b.sourceRank).slice(0,500);
  } else if (args.newOnly) {
    selected=classification.eligible.slice(0,args.limit);
    if (selected.length<3) throw new Error('KOC_NEW_SAMPLE_REQUIRES_AT_LEAST_3_ROWS');
  } else {
    selected=[...classification.eligible,...classification.existing].sort((a,b)=>a.sourceRank-b.sourceRank).slice(0,args.limit);
  }
  if (!selected.length) throw new Error('KOC_SYNC_NO_ELIGIBLE_ROWS');
  const preserveCreatorIds=args.full?classification.review.map(row=>normalizeText(row.creatorId)).filter(Boolean):[];
  const result=await syncRosterBatch(client,selected,{batchId:args.batchId,
    capturedAt:checkpoint.pages[0].capturedAt||checkpoint.startedAt,
    fullSnapshot:args.full,expectedNewOnly:args.newOnly&&!replay,receiptPath,stateDir,
    scopeKey:checkpoint.scopeKey,scope:checkpoint.scopeLabel,preserveCreatorIds,
    sourceEvidence:args.full?{sourceFingerprint:fullFingerprint}:undefined});
  return publicResult(result,{args,schema,classification,selected,replay,receiptPath});
}

async function main() {
  process.umask(0o077);
  const args=parseArgs(process.argv.slice(2));
  console.log(JSON.stringify(await runSyncToBase(args)));
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const reason=/^(?:KOC_|LARK_)/.test(error?.message||'')?error.message.split(':')[0]:'KOC_SYNC_FAILED';
    console.log(JSON.stringify({passed:false,reason}));
    process.exitCode=1;
  }
}
