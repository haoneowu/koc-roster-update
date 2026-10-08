import {BUYIN_ACCOUNT_MARKER} from '../shared/config.mjs';
import {backgroundStateRuntimeSource,readBackgroundState} from './native-background-state.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn, spawnSync} from '../shared/child-process.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR, writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {FEISHU_ROUTE} from '../koc-roster/lark-writer.mjs';
import {AsyncReadLarkBaseClient} from '../koc-roster/async-read-client.mjs';
import {ORIGINAL_BATCH_ID, normalizeCanaryResult, runCanaryBatch, summarizeCanary, validCheckpointEntry} from './canary-batch.mjs';
import {PRODUCTION_STATE_DIR, loadOriginalQueue, loadQualifiedSourceManifest, createProductionAdapter,
  verifyQualifiedRecordIndex} from './canary-production-adapter.mjs';
import {prepareWriteContext, commitCapturedAttempt} from './parallel-production-adapter.mjs';
import {reconcileParallelFailureReadback} from './parallel-production-adapter.mjs';
import {PARALLEL_PILOT_MAX_WALL_MS, PARALLEL_SHARD_COUNT, planParallelShards, runParallelBatch} from './parallel-coordinator.mjs';
import {assertWorkerIdentity} from './parallel-page-binding.mjs';
import {ORIGINAL_BACKGROUND_SESSION,DEFAULT_DETAIL_TEMPLATE} from './buyin-original-background-driver.mjs';
import {BUYIN_SEARCH_FAILURE_BRANCHES,safeOpenDetailDiagnostics,safeRevealDiagnostics} from './buyin-contact-flow.mjs';
import {safeRuntimeReleaseReason,verifyKocRuntimeRelease} from './runtime-release.mjs';
import {DEFAULT_RETRY_EXCLUSION_PATH,loadRetryExclusions,validateRetryExclusions} from './retry-exclusions.mjs';

export const PARALLEL_ACCOUNT_MARKER = BUYIN_ACCOUNT_MARKER;
export const PARALLEL_FEISHU_HOST = FEISHU_ROUTE.host;
export const PARALLEL_TEMPLATE_PATH = '';
const ENTRY_FILE = fileURLToPath(import.meta.url);
const CONTACT_ATTEMPT_DIR = 'attempts';
const REQUIRED_SCHEMA_FIELDS = Object.freeze([
  'Text','抖音号','微信号','本次联系方式状态','联系方式最近尝试','联系方式最近成功',
  '联系方式最近错误','联系方式来源','商务跟进状态','商务备注',
]);
const OUTCOMES = new Set(['success','not_shown','no_match','forbidden_by_platform','error','auth_blocked','risk_blocked']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const SAFE_ATTEMPT_REASON = new Set([
  'RESPONSE_EVIDENCE_INCOMPLETE','RESPONSE_ERROR_UNCLASSIFIED',
  'CONTACT_VALUE_VERIFIED','CONTACT_VALUE_MISSING','CONTACT_NOT_SHOWN','CONTACT_LABEL_NOT_PRESENT','CONTACT_CATEGORY_RESTRICTED',
  'UNRECOGNIZED_TRANSIENT_NOTICE','CONTACT_MARKER_UNRESOLVED',
  'TARGET_NOT_FOUND','TARGET_SEARCH_UNVERIFIED','TARGET_SEARCH_AMBIGUOUS','SEARCH_CONTROL_NOT_UNIQUE','SEARCH_QUERY_MISMATCH',
  'SEARCH_BUTTON_NOT_UNIQUE','SEARCH_BUTTON_NOT_ACTIONABLE','AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED',
  'MENU_PERMISSION_DENIED','ROLE_SELECTION_REQUIRED','BUSINESS_ROUTE_UNEXPECTED','PAGE_NOT_READY','SECURITY_CHALLENGE',
  'RATE_LIMITED','QUOTA_EXCEEDED','BROWSER_ERROR','BROWSER_CLOSE_FAILED','CONTACT_PATCH_FAILED','CONTACT_PATCH_READBACK_FAILED',
  'DETAIL_NOT_OPENED','DETAIL_LINK_NOT_VERIFIED','TARGET_PAGE_CLOSED','TARGET_PAGE_AMBIGUOUS','WECHAT_ROW_NOT_UNIQUE',
  'WECHAT_ROW_NOT_READY','WECHAT_NOT_PROVIDED','REVEAL_UNCONFIRMED','REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE',
  'BACKGROUND_GUARD_FAILED','BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED','EXECUTION_CONTEXT_CHANGED','ERROR_QUERY_UNVERIFIED','UNKNOWN_ERROR',
]);
const SEARCH_FAILURE_BRANCHES = new Set(BUYIN_SEARCH_FAILURE_BRANCHES);
const SUCCESS_PROOF_STATUSES = new Set(['complete','incomplete','unavailable']);
const SUCCESS_PROOF_GROUPS = new Set(['capture_input','capture_receipt','capture_attempt','receipt_completion',
  'identity_binding','search_identity','reveal_state','background_guard','found_contact']);
const CAPTURE_STAGES = new Set(['auth-check','id-search','open-detail','reveal','final-guard','complete',
  'driver-init','flow','wave-guard','wave-worker']);
const SEARCH_EXECUTION_PHASES=new Set(['argument_validation','page_guard','control_lookup','input_fill',
  'button_readiness','activation_guard','click_dispatch','response_wait','response_validation','visible_result','detail_link']);
const SEARCH_EXCEPTION_CATEGORIES=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
const PAGE_GUARD_REASONS=new Set(['PAGE_CONTEXT_CHANGED','PAGE_SET_UNAVAILABLE','PAGE_SET_CHANGED','PAGE_BINDING_CHANGED',
  'PAGE_STATE_UNAVAILABLE','WORKER_PAGE_VISIBLE','WORKER_PAGE_ROUTE_OR_ACCOUNT_CHANGED',
  'WORKER_PAGE_AUTH_RISK_OR_CONTEXT_CHANGED','PAGE_GUARD_ARGUMENTS_INVALID','UNOWNED_PAGE_CHANGED',
  'PAGE_CONTEXT_UNAVAILABLE','PAGE_CONTEXT_MISMATCH','PAGE_NOT_HIDDEN','PAGE_ACCOUNT_OR_ROUTE_UNVERIFIED',
  'PAGE_AUTH_RISK_OR_CONTEXT_UNVERIFIED','PAGE_SNAPSHOT_ARGUMENTS_INVALID','PAGE_SNAPSHOT_UNAVAILABLE',
  'PAGE_BINDINGS_INVALID','LOCATOR_PAGE_UNAVAILABLE','LOCATOR_PAGE_MISMATCH']);
for (const reason of [...PAGE_GUARD_REASONS]) PAGE_GUARD_REASONS.add(`INITIAL_${reason}`);
const RUNTIME_ERROR_TYPES=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']);
const SAFE_SHARED_WRITER_CODES=new Set(['LARK_READBACK_MISMATCH','LARK_CLI_FAILED','LARK_EMPTY_RESPONSE',
  'LARK_RESPONSE_NOT_JSON','LARK_WRITE_OUTCOME_UNKNOWN','KOC_CONTACT_CREATOR_AND_RECORD_ID_REQUIRED',
  'KOC_CONTACT_FIELD_NOT_ALLOWED','KOC_CONTACT_SUCCESS_REQUIRES_VALUE_TIME_AND_SOURCE','KOC_CONTACT_SOURCE_INVALID',
  'KOC_CONTACT_SOURCE_REQUIRED','KOC_CONTACT_ATTEMPT_TIME_REQUIRED','KOC_CONTACT_VERIFIED_VALUE_REQUIRED',
  'KOC_CONTACT_FAILURE_STATUS_INVALID','KOC_CONTACT_FAILURE_CANNOT_CHANGE_SUCCESS_FIELD',
  'KOC_CONTACT_FAILURE_REQUIRES_ATTEMPT_TIME','KOC_CONTACT_RECORD_CREATOR_MISMATCH','KOC_CREATOR_WRITE_LOCK_TIMEOUT',
  'KOC_CONTACT_NULL_OR_UNDEFINED_VALUE','PARALLEL_WRITER_TARGET_MISMATCH','PARALLEL_PATCH_SCOPE_INVALID',
  'PARALLEL_PREWRITE_READ_FAILED','PARALLEL_PREWRITE_IDENTITY_MISMATCH','PARALLEL_PROTECTED_FIELDS_CHANGED',
  'PARALLEL_PRIOR_CONTACT_CHANGED','PARALLEL_SHARED_READBACK_UNVERIFIED','PARALLEL_PATCH_NOT_STARTED',
  'PARALLEL_RECORD_PROJECTION_INVALID','UNKNOWN_WRITE_ERROR']);
const safeEnum = (value, allowed, fallback='') => allowed.has(value) ? value : fallback;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function safeReason(value, fallback='PARALLEL_CAPTURE_FAILED') {
  return typeof value === 'string' && SAFE_CODE.test(value) &&
    (value.startsWith('PARALLEL_') || value.startsWith('CANARY_') || value.startsWith('RETRY_EXCLUSION_') ||
      SAFE_ATTEMPT_REASON.has(value)) ? value : fallback;
}

export function normalizeParallelSafeReason(value,fallback='PARALLEL_CAPTURE_FAILED') {
  return safeReason(value,fallback);
}

function schemaFields(schema) {
  const data = schema?.data ?? schema;
  const fields = Array.isArray(data) ? data : Array.isArray(data?.fields) ? data.fields :
    Array.isArray(data?.items) ? data.items : Array.isArray(data?.field_list) ? data.field_list : null;
  if (!fields) return null;
  return fields.map(field => typeof field === 'string' ? {name:field,type:''} : ({
    name:String(field?.field_name ?? field?.name ?? ''),
    type:String(field?.type ?? field?.field_type ?? field?.type_name ?? '').toLowerCase(),
    ...(typeof field?.multiple==='boolean'?{multiple:field.multiple}:{}),
  }));
}

function schemaReady(schema) {
  const fields = schemaFields(schema);
  if (!fields) return {ready:false,fieldCount:0};
  const names = new Set(fields.map(field=>field.name));
  return {ready:REQUIRED_SCHEMA_FIELDS.every(name=>names.has(name)),fieldCount:fields.length};
}

function parseJsonOutputWithStatus(output) {
  const text = String(output || '').trim();
  if (!text) return {parsed:false,value:null};
  try { return {parsed:true,value:JSON.parse(text)}; } catch {}
  const markerIndex = text.lastIndexOf('### Result');
  if (markerIndex >= 0) {
    const payload = text.slice(markerIndex + '### Result'.length).trimStart();
    const nextMarker = payload.search(/\r?\n### /u);
    try { return {parsed:true,value:JSON.parse((nextMarker < 0 ? payload : payload.slice(0,nextMarker)).trim())}; } catch {}
  }
  for (const line of text.split(/\r?\n/u).reverse()) {
    try { return {parsed:true,value:JSON.parse(line)}; } catch {}
  }
  return {parsed:false,value:null};
}

function parseJsonOutput(output) {
  return parseJsonOutputWithStatus(output).value;
}

function findVerifiedUser(payload) {
  const queue=[payload], visited=new Set();
  let tokenStatus='';
  while (queue.length) {
    const value=queue.shift();
    if (!value || typeof value!=='object' || visited.has(value)) continue;
    visited.add(value);
    if (!Array.isArray(value) && String(value.identity || '').toLowerCase()==='user' && typeof value.tokenStatus==='string') {
      tokenStatus=value.tokenStatus;
    }
    if (!Array.isArray(value) && value.verified===true && String(value.identity || '').toLowerCase()==='user') {
      return {verifiedUser:true,tokenStatus:tokenStatus || String(value.tokenStatus || 'unknown')};
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) if (child && typeof child==='object') queue.push(child);
  }
  return {verifiedUser:false,tokenStatus};
}

function readAuthStatus({invoke=spawnSync}={}) {
  const result=invoke('lark-cli',['auth','status','--profile',FEISHU_ROUTE.profile,'--verify','--json'],{
    encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe'],
  });
  const parsed=parseJsonOutput(result?.stdout);
  const user=findVerifiedUser(parsed);
  return {verifiedUser:!result?.error&&result?.status===0&&user.verifiedUser===true,
    tokenStatus:user.tokenStatus || 'unknown',profile:FEISHU_ROUTE.profile,as:FEISHU_ROUTE.as,
    host:PARALLEL_FEISHU_HOST};
}

async function inspectExistingPages(cliPage) {
  const ORIGIN='https://buyin.jinritemai.com';
  const LIST_PATH='/dashboard/servicehall/daren-square';
  const PROFILE_PATH='/dashboard/servicehall/daren-profile';
  const ACCOUNT_MARKER=BUYIN_ACCOUNT_MARKER;
  const context=cliPage?.context?.();
  if (!context || typeof context.pages!=='function') return {contextAvailable:false,pages:[]};
  const pages=context.pages();
  const summaries=[];
  for (let pageIndex=0;pageIndex<pages.length;pageIndex+=1) {
    const target=pages[pageIndex];
    let route='OTHER_ORIGIN',hidden=false,accountMarkerVisible=false,authSignal=null,challengeSignal=null;
    try {
      const href=String(target.url() || '');
      if (href===ORIGIN || href.startsWith(`${ORIGIN}/`)) {
        const facts=await target.evaluate(({listPath,profilePath,accountMarker})=>{
          const visible=element=>!!element&&element.getClientRects().length>0&&
            getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
          const route=location.pathname===listPath?'BUSINESS_LIST':
            location.pathname===profilePath||location.pathname.startsWith(`${profilePath}/`)?'PROFILE':'OTHER';
          let marker=false,auth=false,challenge=false;
          for (const node of document.querySelectorAll('body *')) {
            if (!visible(node)||node.children.length) continue;
            const text=String(node.innerText||node.textContent||'').trim();
            if (text===accountMarker) marker=true;
            if (/用户未登录|尚未登录|请先登录|当前未登录|未登录|登录(?:信息|状态)?已(?:过期|失效)|登录已过期|当前账号没有菜单权限|没有菜单权限/u.test(text)) auth=true;
            if (/安全验证|完成验证|滑块|验证码/u.test(text)) challenge=true;
          }
          return {route,hidden:document.visibilityState==='hidden',accountMarkerVisible:marker,authSignal:auth,challengeSignal:challenge};
        },{listPath:LIST_PATH,profilePath:PROFILE_PATH,accountMarker:ACCOUNT_MARKER});
        route=facts.route;hidden=(await readBackgroundState(target,facts.hidden?{visibility:'hidden',timeOrigin:Number(facts.documentToken)||0}:undefined)).hidden;accountMarkerVisible=facts.accountMarkerVisible;
        authSignal=facts.authSignal;challengeSignal=facts.challengeSignal;
      }
      summaries.push({pageIndex,route,hidden,accountMarkerVisible,authSignal,challengeSignal,contextAvailable:true});
    } catch {
      summaries.push({pageIndex,route:'UNAVAILABLE',hidden:false,accountMarkerVisible:false,
        authSignal:null,challengeSignal:null,contextAvailable:false});
    }
  }
  return {contextAvailable:true,pages:summaries};
}

export function buildReadOnlyPageSnapshotCode() {
  return `async page=>{const BUYIN_ACCOUNT_MARKER=${JSON.stringify(BUYIN_ACCOUNT_MARKER)};${backgroundStateRuntimeSource()}return (${inspectExistingPages.toString()})(page);}`;
}

function runCliCode({code,session=ORIGINAL_BACKGROUND_SESSION,timeoutMs=120000,spawnProcess=spawn}={}) {
  return new Promise(resolve=>{
    let child;
    try {
      child=spawnProcess('npx',['--no-install','@playwright/cli',`-s=${session}`,'run-code',code],{
        cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,DEBUG:'',PWDEBUG:''},
        stdio:['ignore','pipe','pipe'],
      });
    } catch { resolve({status:null,stdout:'',overflow:false,timedOut:false}); return; }
    let stdout='',overflow=false,settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>{try{child.kill('SIGTERM');}catch{}finish({status:null,stdout:'',overflow:false,timedOut:true});},timeoutMs);
    child.stdout?.on('data',chunk=>{
      if (stdout.length+chunk.length<=8*1024*1024) stdout+=chunk;
      else overflow=true;
    });
    child.stderr?.resume();
    child.on('error',()=>finish({status:null,stdout:'',overflow:false,timedOut:false}));
    child.on('close',status=>finish({status,stdout,overflow,timedOut:false}));
  });
}

async function inspectPagesWithCli({invoke=runCliCode,session=ORIGINAL_BACKGROUND_SESSION}={}) {
  const response=await invoke({code:buildReadOnlyPageSnapshotCode(),session,timeoutMs:30000});
  if (response?.overflow===true || response?.status!==0) return {contextAvailable:false,pages:[]};
  const parsed=isObject(response?.result) ? response.result : parseJsonOutput(response?.stdout);
  if (!isObject(parsed) || !Array.isArray(parsed.pages)) return {contextAvailable:false,pages:[]};
  return {contextAvailable:parsed.contextAvailable===true,pages:parsed.pages.map((page,index)=>({
    pageIndex:Number.isInteger(page?.pageIndex)?page.pageIndex:index,
    route:safeEnum(page?.route,new Set(['BUSINESS_LIST','PROFILE','OTHER','OTHER_ORIGIN','UNAVAILABLE']),'UNAVAILABLE'),
    hidden:page?.hidden===true,accountMarkerVisible:page?.accountMarkerVisible===true,
    authSignal:typeof page?.authSignal==='boolean'?page.authSignal:null,
    challengeSignal:typeof page?.challengeSignal==='boolean'?page.challengeSignal:null,
    contextAvailable:page?.contextAvailable===true,
  }))};
}

export function selectParallelPages(snapshot) {
  if (snapshot?.contextAvailable!==true || !Array.isArray(snapshot.pages)) return [];
  const usable=snapshot.pages.filter(page=>Number.isInteger(page?.pageIndex)&&page.pageIndex>=0&&
    ['BUSINESS_LIST','PROFILE'].includes(page.route)&&page.hidden===true&&
    page.accountMarkerVisible===true&&page.authSignal===false&&page.challengeSignal===false&&
    page.contextAvailable!==false);
  const byIndex=new Map();
  for (const page of usable) if (!byIndex.has(page.pageIndex)) byIndex.set(page.pageIndex,page);
  return [...byIndex.values()].sort((a,b)=>(a.route==='BUSINESS_LIST'?0:1)-(b.route==='BUSINESS_LIST'?0:1)||a.pageIndex-b.pageIndex);
}

function parseRecord(payload) {
  const data=payload?.data ?? payload;
  if (Array.isArray(data?.data)&&Array.isArray(data?.fields)) return {
    recordId:data.record_id_list?.[0]||'',
    fields:Object.fromEntries(data.fields.map((name,index)=>[name,data.data[0]?.[index]??null])),
  };
  if (data?.record?.fields) return {recordId:data.record.record_id??data.record.recordId??'',fields:data.record.fields};
  if (data?.fields&&!Array.isArray(data.fields)) return {recordId:data.record_id??data.recordId??'',fields:data.fields};
  return null;
}

function parseRecordItems(payload) {
  const data=payload?.data??payload;
  if (Array.isArray(data?.data)&&Array.isArray(data?.fields)) return data.data.map((cells,index)=>({
    recordId:data.record_id_list?.[index]||'',
    fields:Object.fromEntries(data.fields.map((name,fieldIndex)=>[name,cells?.[fieldIndex]??null])),
  }));
  const records=data?.records??data?.items??data?.record_list;
  return Array.isArray(records)?records.map(record=>({
    recordId:record?.record_id??record?.recordId??'',fields:record?.fields??{},
  })):null;
}

function normalizedCell(value) {
  if (Array.isArray(value)) return value.map(item=>String(item?.text??item?.value??item?.name??'')).join(',').trim();
  if (value&&typeof value==='object') return String(value.text??value.value??value.name??'').trim();
  return String(value??'').trim();
}

async function readCurrentCreatorRecordIndex(client) {
  if (!client||typeof client.listRecordsPage!=='function') throw new Error('CANARY_QUALIFIED_BASE_INDEX_UNAVAILABLE');
  const rows=[];let offset=0;const limit=200;
  while (true) {
    const payload=await client.listRecordsPage({offset,limit,fieldNames:['抖音号']});
    const data=payload?.data??payload,records=parseRecordItems(payload);
    if (!records) throw new Error('CANARY_QUALIFIED_BASE_INDEX_INVALID');
    for (const record of records) {
      const creatorId=normalizedCell(record.fields?.['抖音号']);
      if (!creatorId) continue;
      if (!record.recordId) throw new Error('CANARY_QUALIFIED_BASE_INDEX_RECORD_ID_MISSING');
      rows.push({creatorId,recordId:record.recordId});
    }
    const hasMore=data?.has_more??data?.hasMore;
    if (hasMore===false||!records.length||(hasMore===undefined&&records.length<limit)) break;
    offset+=records.length;
    if (offset>100000) throw new Error('CANARY_QUALIFIED_BASE_INDEX_PAGINATION_LIMIT');
  }
  return rows;
}

async function loadVerifiedSourceRows({sourceStateDir=DEFAULT_STATE_DIR,sourceManifestPath}={}) {
  if (sourceManifestPath!==undefined) {
    const qualified=await loadQualifiedSourceManifest({sourceStateDir,sourceManifestPath});
    const rows=qualified.sourceRows;
    return {rows,receipt:qualified.receipt,manifestFileSha256:qualified.manifestFileSha256,
      verifySourceMember:({target,sourceBatchId})=>{
        const member=qualified.manifest.targets.find(row=>row.creatorId===target.creatorId&&row.recordId===target.recordId);
        return member&&member.sourceRank===target.sourceRank&&sourceBatchId===qualified.manifest.sourceBatchId
          ?{verified:true,creatorId:target.creatorId,recordId:target.recordId,sourceBatchId,sourceRank:target.sourceRank}:false;
      }};
  }
  const file=path.join(sourceStateDir,`${ORIGINAL_BATCH_ID}.write-receipt.json`);
  const receipt=JSON.parse(await fs.readFile(file,'utf8'));
  if (receipt.batchId!==ORIGINAL_BATCH_ID||receipt.status!=='complete'||receipt.plannedCount!==500||receipt.completedCount!==500) {
    throw new Error('PARALLEL_SOURCE_CHECKPOINT_UNVERIFIED');
  }
  const names=new Map();
  for (const row of receipt.plannedCreators||[]) {
    if (typeof row?.creatorId==='string'&&Number.isInteger(row.sourceRank)&&!names.has(row.creatorId)) {
      names.set(row.creatorId,{creatorId:row.creatorId,sourceRank:row.sourceRank,
        creatorName:typeof row.creatorName==='string'?row.creatorName:''});
    }
  }
  const outcomes=new Map();
  for (const outcome of receipt.outcomes||[]) {
    if (!outcomes.has(outcome.creatorId)) outcomes.set(outcome.creatorId,[]);
    outcomes.get(outcome.creatorId).push(outcome);
  }
  return {rows:[...names.values()],receipt,verifySourceMember:({target,sourceBatchId})=>{
    const row=names.get(target.creatorId),mapped=receipt.creatorRecordIds?.[target.creatorId];
    const evidence=outcomes.get(target.creatorId)||[];
    return row?.sourceRank===target.sourceRank&&mapped===target.recordId&&evidence.length===1&&
      evidence[0].recordId===target.recordId&&evidence[0].readbackVerified===true&&sourceBatchId===ORIGINAL_BATCH_ID
      ?{verified:true,creatorId:target.creatorId,recordId:target.recordId,sourceBatchId,sourceRank:target.sourceRank}:false;
  }};
}

function projectChannelDiagnostics(value) {
  const keys=['contactItemCount','visibleContactItemCount','wechatLocatorCount','visibleWechatLocatorCount',
    'phoneLocatorCount','visiblePhoneLocatorCount','stableSamples'];
  const proofs=['profileUidConfirmed','contextStable','targetHidden','authHealthy'];
  if (!isObject(value)||value.observedReady!==true||proofs.some(key=>value[key]!==true)) return null;
  const counters={};
  for (const key of keys) {
    if (!Number.isInteger(value[key])||value[key]<0||value[key]>10000) return null;
    counters[key]=value[key];
  }
  return {observedReady:true,profileUidConfirmed:true,contextStable:true,targetHidden:true,authHealthy:true,...counters};
}

export function projectParallelCaptureReceipt(receipt) {
  const captureReceiptInputAvailable=isObject(receipt);
  receipt=captureReceiptInputAvailable?receipt:{};
  const safeBoolean=value=>typeof value==='boolean'?value:null;
  const search=receipt.searchDiagnostics||{};
  const response=receipt.responseEvidence||{};
  const guard=receipt.guardDiagnostics||{};
  const revealDiagnostics=safeRevealDiagnostics(receipt.revealDiagnostics);
  const searchKeys=['submittedAfterActivation','queryType','attemptCount','fallbackReason','matchedRequestCount',
    'matchedResponseCount','httpStatusCategory','businessCodeCategory','exactIdMatchCount','uidPresent',
    'visibleStableIdentityMatchCount','feedResultIdMatchesTarget','selectedExactResultPresent','matchedIdentityKeyKind',
    'contactMarkerState','failureBranch'];
  const searchDiagnostics=Object.fromEntries(searchKeys.map(key=>[key,
    ['submittedAfterActivation','uidPresent','feedResultIdMatchesTarget','selectedExactResultPresent'].includes(key)
      ?safeBoolean(search[key]):
      key==='matchedRequestCount'||key==='matchedResponseCount'||key==='exactIdMatchCount'||
        key==='visibleStableIdentityMatchCount'
        ?Number.isInteger(search[key])&&search[key]>=0&&search[key]<=100000?search[key]:-1:
          key==='attemptCount'?Number.isInteger(search[key])?search[key]:0:
          key==='queryType'?safeEnum(search[key],new Set(['ID','NICKNAME']),'ID'):
            key==='matchedIdentityKeyKind'?safeEnum(search[key],new Set(['UID','AWEME_ID','BOTH','NONE','MISSING']),'MISSING'):
            key==='fallbackReason'?safeEnum(search[key],new Set(['','nickname_no_exact_stable_id','nickname_query_unverified']),''):
              key==='httpStatusCategory'?safeEnum(search[key],new Set(['missing','2xx','4xx','5xx','other']),'missing'):
                key==='businessCodeCategory'?safeEnum(search[key],new Set(['missing','zero','nonzero']),'missing'):
                  key==='contactMarkerState'?safeEnum(search[key],new Set(['present','absent','unresolved','missing']),'missing'):
                    key==='failureBranch'?safeEnum(search[key],SEARCH_FAILURE_BRANCHES,'unknown'):'' ]));
  if(SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)){
    searchDiagnostics.executionPhase=search.executionPhase;
    searchDiagnostics.exceptionCategory=search.exceptionCategory;
  }
  const allowedReceiptKeys=['status','sameContext','samePage','authFailureSeen','formalIdMatch','profileOpened',
    'wechatRowUnique','revealed','labelMatched','nonMaskedValue','finalBackgroundGuard','errorFree'];
  const safe={mode:'parallel_worker_capture',captureReceiptInputAvailable,
    ...(revealDiagnostics?{revealDiagnostics}:{}),
    stage:safeEnum(receipt.stage,CAPTURE_STAGES,'unknown'),
    identityProof:receipt.identityProof==='API_FEED_ID_MATCH'
    ?'API_FEED_ID_MATCH':'',reason:safeReason(receipt.reason,'UNKNOWN_ERROR'),
    runtimeErrorType:safeEnum(receipt.runtimeErrorType,RUNTIME_ERROR_TYPES,''),
    ...(['recovery_readiness','navigate_list','wait_business_ready'].includes(receipt.initDiagnostics?.executionPhase)?{initDiagnostics:{executionPhase:receipt.initDiagnostics.executionPhase,navigationTimedOut:receipt.initDiagnostics.navigationTimedOut===true,listRouteAfterTimeout:receipt.initDiagnostics.listRouteAfterTimeout===true}}:{}),
    ...(safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)
      ?{openDetailDiagnostics:safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)}:{}),
    responseEvidence:{authPromptLatched:typeof response.authPromptLatched==='boolean'?response.authPromptLatched:null,
      explicitAuthResponseCount:Number.isInteger(response.explicitAuthResponseCount)
        ?Math.max(0,Math.min(100000,response.explicitAuthResponseCount)):null},searchDiagnostics,
    channelDiagnostics:projectChannelDiagnostics(receipt.channelDiagnostics),
    guardDiagnostics:{targetClosed:safeBoolean(guard.targetClosed),targetContextMatches:safeBoolean(guard.targetContextMatches),
      targetHidden:safeBoolean(guard.targetHidden),pageSetStable:safeBoolean(guard.pageSetStable),
      otherPagesStable:safeBoolean(guard.otherPagesStable),
      otherPageNavigationChanged:safeBoolean(guard.otherPageNavigationChanged),
      otherPageVisibilityChanged:safeBoolean(guard.otherPageVisibilityChanged),
      otherPageDocumentChanged:safeBoolean(guard.otherPageDocumentChanged),
      profileUidConfirmed:safeBoolean(guard.profileUidConfirmed),authHealthy:safeBoolean(guard.authHealthy),
      errorFree:safeBoolean(guard.errorFree),
      reason:safeReason(guard.reason,'')},
  };
  for (const key of allowedReceiptKeys) {
    if (key==='status') safe.status=safeEnum(receipt.status,new Set(['completed','stopped']),'stopped');
    else safe[key]=safeBoolean(receipt[key]);
  }
  return safe;
}

function projectIdentityProof(value) {
  if (!isObject(value)) return null;
  const types=new Set(['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED']);
  const proofBoolean=field=>typeof value[field]==='boolean'?value[field]:null;
  return {
    type:safeEnum(value.type,types,''),
    creatorIdMatchesTarget:proofBoolean('creatorIdMatchesTarget'),
    awemeIdMatchesTarget:proofBoolean('awemeIdMatchesTarget'),
    exactIdMatchCount:Number.isInteger(value.exactIdMatchCount)?value.exactIdMatchCount:-1,
    uidFromExactResult:proofBoolean('uidFromExactResult'),
    profileRouteUidMatchesExactResultUid:proofBoolean('profileRouteUidMatchesExactResultUid'),
    querySubmittedAfterActivation:proofBoolean('querySubmittedAfterActivation'),
    requestResponseBound:proofBoolean('requestResponseBound'),
    httpStatusCategory:safeEnum(value.httpStatusCategory,new Set(['2xx','4xx','5xx','other']),'other'),
    businessCodeCategory:safeEnum(value.businessCodeCategory,new Set(['zero','nonzero','missing']),'missing'),
    authEvidenceAbsent:proofBoolean('authEvidenceAbsent'),
  };
}

function projectAttempt(attempt) {
  const captureAttemptInputAvailable=isObject(attempt);
  attempt=captureAttemptInputAvailable?attempt:{};
  const status=safeEnum(attempt.contactStatus,new Set(['found','not_shown','not_found','login_required','captcha','error','forbidden_by_platform']),'error');
  const contactValue=typeof attempt.contactValue==='string'?attempt.contactValue:'';
  const contactSourceUrl=typeof attempt.contactSourceUrl==='string'?attempt.contactSourceUrl:
    typeof attempt.sourceURL==='string'?attempt.sourceURL:'';
  const errorReason=status==='found'&&typeof attempt.errorReason==='string'&&attempt.errorReason.trim()===''
    ?'':safeReason(attempt.errorReason,'UNKNOWN_ERROR');
  return {captureAttemptInputAvailable,contactStatus:status,contactValue,contactSourceUrl,
    contactCheckedAt:typeof attempt.contactCheckedAt==='string'?attempt.contactCheckedAt:'',
    errorReason};
}

function clearAttempt(capture) {
  const attempt=capture?.attempt;
  if (!attempt || typeof attempt!=='object') return;
  for (const key of ['contactValue','contactSourceUrl','sourceURL']) try { attempt[key]=''; } catch {}
}

function sourceRowFor(target,sourceRows) {
  const row=sourceRows.find(item=>item.creatorId===target.creatorId&&item.sourceRank===target.sourceRank);
  return {creatorName:typeof row?.creatorName==='string'?row.creatorName:''};
}

function projectPageGuardDiagnostics(value={}) {
  return {passed:value.passed===true,
    reason:safeEnum(value.reason,PAGE_GUARD_REASONS,'unknown'),
    workerCount:Number.isInteger(value.workerCount)&&value.workerCount>=0&&value.workerCount<=5?value.workerCount:-1,
    pageCount:Number.isInteger(value.pageCount)&&value.pageCount>=0&&value.pageCount<=100?value.pageCount:-1};
}

function projectCaptureExecutionDiagnostics(value={}) {
  const search=value.searchDiagnostics||{};
  const revealDiagnostics=isObject(value.revealDiagnostics)?safeRevealDiagnostics(value.revealDiagnostics):null;
  return {stage:safeEnum(value.stage,CAPTURE_STAGES,'unknown'),
    status:safeEnum(value.status,new Set(['completed','stopped']),'stopped'),
    reason:safeReason(value.reason,'UNKNOWN_ERROR'),
    runtimeErrorType:safeEnum(value.runtimeErrorType,RUNTIME_ERROR_TYPES,''),
    pageGuardDiagnostics:projectPageGuardDiagnostics(value.pageGuardDiagnostics),
    searchDiagnostics:{queryType:safeEnum(search.queryType,new Set(['ID','NICKNAME']),'ID'),
      attemptCount:Number.isInteger(search.attemptCount)&&search.attemptCount>=0&&search.attemptCount<=3?search.attemptCount:0,
      matchedRequestCount:Number.isInteger(search.matchedRequestCount)&&search.matchedRequestCount>=0&&search.matchedRequestCount<=3
        ?search.matchedRequestCount:0,
      matchedResponseCount:Number.isInteger(search.matchedResponseCount)&&search.matchedResponseCount>=0&&search.matchedResponseCount<=3
        ?search.matchedResponseCount:0,
      failureBranch:safeEnum(search.failureBranch,SEARCH_FAILURE_BRANCHES,'unknown'),
      ...(SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)
        ?{executionPhase:search.executionPhase,exceptionCategory:search.exceptionCategory}:{})},
    ...(['recovery_readiness','navigate_list','wait_business_ready'].includes(value.initDiagnostics?.executionPhase)?{initDiagnostics:{executionPhase:value.initDiagnostics.executionPhase,navigationTimedOut:value.initDiagnostics.navigationTimedOut===true,listRouteAfterTimeout:value.initDiagnostics.listRouteAfterTimeout===true}}:{}),
    ...(safeOpenDetailDiagnostics(value.openDetailDiagnostics)
      ?{openDetailDiagnostics:safeOpenDetailDiagnostics(value.openDetailDiagnostics)}:{}),
    ...(revealDiagnostics?{revealDiagnostics}:{})};
}

function rawWorkerResult({worker,claim,context,preflightFailure=false}) {
  const base={workerId:claim.workerId,laneIndex:claim.laneIndex,attemptId:claim.attemptId,
    creatorId:claim.target.creatorId,recordId:claim.target.recordId,sourceBatchId:ORIGINAL_BATCH_ID,
    sourceRank:claim.target.sourceRank};
  if (preflightFailure) return {...base,preflightFailure:true,outcome:'error',writeState:'not_written',
    reason:preflightFailure,pageGuardPassed:false};
  if (!worker || worker.workerId!==claim.workerId||worker.laneIndex!==claim.laneIndex||
      worker.attemptId!==claim.attemptId||worker.creatorId!==claim.target.creatorId||
      worker.recordId!==claim.target.recordId||worker.sourceBatchId!==ORIGINAL_BATCH_ID||
      worker.sourceRank!==claim.target.sourceRank||!OUTCOMES.has(worker.outcome)) {
    return {...base,outcome:'error',writeState:'not_written',reason:'PARALLEL_CAPTURE_BINDING_INVALID',pageGuardPassed:false};
  }
  const guard=isObject(worker.pageGuard)?worker.pageGuard:{};
  const capture={descriptor:{creatorId:claim.target.creatorId,recordId:claim.target.recordId,
    sourceBatchId:ORIGINAL_BATCH_ID,sourceRank:claim.target.sourceRank,attemptId:claim.attemptId},
    receipt:{...projectParallelCaptureReceipt(worker.receipt),pageGuardDiagnostics:projectPageGuardDiagnostics(guard)},
    attempt:projectAttempt(worker.attempt)};
  const timing=isObject(worker.timing)?worker.timing:{};
  const identityProof=projectIdentityProof(worker.identityProof ?? worker.receipt?.workerIdentityProof);
  const row={...base,outcome:worker.outcome,reason:normalizeParallelSafeReason(worker.reason,'UNKNOWN_ERROR'),
    recordMappingVerified:context?.recordMappingVerified===true,
    originalAttemptSourceVerified:context?.sourceMemberVerified===true,
    pageGuardPassed:guard.passed===true,identityProof,writeIntent:capture,
    workerTiming:{waveId:typeof timing.waveId==='string'?timing.waveId:'',
      startedAtMs:Number.isFinite(timing.startedAtMs)?timing.startedAtMs:-1,
      finishedAtMs:Number.isFinite(timing.finishedAtMs)?timing.finishedAtMs:-1}};
  for (const key of ['contactValue','contactSourceUrl','sourceURL']) try { worker.attempt[key]=''; } catch {}
  let invalidReason='';
  if (row.pageGuardPassed!==true) invalidReason='PARALLEL_PAGE_GUARD_UNVERIFIED';
  else try { assertWorkerIdentity({target:{...claim.target,attemptId:claim.attemptId},result:row}); }
  catch { invalidReason='PARALLEL_IDENTITY_PROOF_UNVERIFIED'; }
  if (invalidReason) {
    clearAttempt(capture);
    return {...base,outcome:'error',writeState:'not_written',reason:invalidReason,pageGuardPassed:false,
      captureDiagnostics:projectCaptureExecutionDiagnostics(capture.receipt)};
  }
  return row;
}

async function writeAttemptRecord({attemptsDir,claim,record}) {
  await writePrivateJson(path.join(attemptsDir,`${claim.attemptId}.json`),{
    version:1,creatorId:claim.target.creatorId,recordId:claim.target.recordId,
    sourceBatchId:ORIGINAL_BATCH_ID,sourceRank:claim.target.sourceRank,attemptId:claim.attemptId,
    workerId:claim.workerId,startedAt:record?.startedAt||new Date().toISOString(),
    ...(record||{}),
  });
}

function safeResultForDisk(result,attemptId) {
  const outcome=OUTCOMES.has(result?.outcome)?result.outcome:'error';
  const writeState=['verified','not_written','uncertain'].includes(result?.writeState)?result.writeState:'uncertain';
  const safe={attemptId,outcome,writeState,reason:safeReason(result?.reason,'PARALLEL_RESULT_UNVERIFIED'),
    recordMappingVerified:result?.recordMappingVerified===true,readbackVerified:result?.readbackVerified===true,
    originalAttemptSourceVerified:result?.originalAttemptSourceVerified===true,
    protectedFieldsUnchanged:result?.protectedFieldsUnchanged===true};
  if (outcome==='success') {
    safe.hadWeChatBefore=typeof result?.hadWeChatBefore==='boolean'?result.hadWeChatBefore:null;
    safe.currentValueVerified=result?.currentValueVerified===true;
  }
  if (result?.reviewedRecoveryAccepted===true) safe.reviewedRecoveryAccepted=true;
  return safe;
}

export function safeAttemptReceipt(receipt) {
  if (!isObject(receipt)) return null;
  const out={};
  for (const key of ['mode','creatorId','recordId','sourceBatchId','sourceRank','attemptId','outcome','writeState',
    'reason','sourceMemberVerified','currentIndexVerified','recordMappingVerified','baselineFieldCount','hadWeChatBefore',
    'writerInvoked','writeSubmitted','sharedWriterReadbackVerified','sharedWriterStage','sharedWriterErrorCode',
    'outerReadbackVerified','sameRecordReadback','sameCreatorIdReadback','protectedFieldsUnchanged','oldContactPreserved',
    'patchFieldCount','recoveryMode','contactValueEmitted','contactSourceUrlEmitted']) {
    const value=receipt[key];
    if (typeof value==='string') out[key]=key==='sharedWriterErrorCode'
      ?(SAFE_SHARED_WRITER_CODES.has(value)?value:'')
      :key.toLowerCase().includes('reason')||key.toLowerCase().includes('errorcode')?safeReason(value,''):value;
    else if (typeof value==='boolean'||Number.isInteger(value)) out[key]=value;
  }
  if (isObject(receipt.failureExpected)) out.failureExpected={
    status:safeEnum(receipt.failureExpected.status,new Set(['found','not_shown','not_found','login_required','captcha','error','forbidden_by_platform']),'error'),
    checkedAt:typeof receipt.failureExpected.checkedAt==='string'?receipt.failureExpected.checkedAt:'',
    errorReason:safeReason(receipt.failureExpected.errorReason,'UNKNOWN_ERROR'),
    actualStoredError:safeReason(receipt.failureExpected.actualStoredError,'UNKNOWN_ERROR'),
  };
  if (isObject(receipt.captureValidationDiagnostics)) out.captureValidationDiagnostics=
    safeCaptureValidationDiagnostics(receipt.captureValidationDiagnostics);
  if (isObject(receipt.captureExecutionDiagnostics)) out.captureExecutionDiagnostics=
    projectCaptureExecutionDiagnostics(receipt.captureExecutionDiagnostics);
  if (isObject(receipt.fieldReadbackMatches)) out.fieldReadbackMatches=Object.fromEntries(
    ['wechatValue','contactStatus','contactAttemptTime','contactLastSuccess','contactError','contactSource']
      .map(key=>[key,receipt.fieldReadbackMatches[key]===true]));
  if (isObject(receipt.waveExecutionDiagnostics)) {
    const diagnostics=projectWaveExecutionDiagnostics(receipt.waveExecutionDiagnostics);
    if (diagnostics) out.waveExecutionDiagnostics=diagnostics;
  }
  return out;
}

function projectWaveExecutionDiagnostics(value) {
  const responseStates=new Set(['ok','failed','unavailable','overflow','timeout']);
  const payloadStates=new Set(['not_attempted','workers_array','workers_missing','unparsed']);
  if (!isObject(value)||!responseStates.has(value.responseState)||!payloadStates.has(value.payloadState)||
      !Number.isInteger(value.expectedWorkerCount)||value.expectedWorkerCount<0||value.expectedWorkerCount>5||
      !Number.isInteger(value.returnedWorkerCount)||value.returnedWorkerCount<0||value.returnedWorkerCount>5||
      !Number.isInteger(value.matchedWorkerCount)||value.matchedWorkerCount<0||
      value.matchedWorkerCount>value.expectedWorkerCount) return null;
  return {responseState:value.responseState,payloadState:value.payloadState,
    expectedWorkerCount:value.expectedWorkerCount,returnedWorkerCount:value.returnedWorkerCount,
    matchedWorkerCount:value.matchedWorkerCount,
    ...(value.failureCategory==='session_not_open'?{failureCategory:'session_not_open'}:{})};
}

function waveExecutionDiagnostics({response,payloadState,descriptors,workers}) {
  const responseState=response?.timedOut===true?'timeout':response?.overflow===true?'overflow':response?.status===0?'ok':
    Number.isInteger(response?.status)?'failed':'unavailable';
  const expectedIds=new Set(descriptors.map(descriptor=>descriptor.attemptId));
  const returnedIds=new Set(workers.filter(worker=>typeof worker?.attemptId==='string')
    .map(worker=>worker.attemptId).filter(attemptId=>expectedIds.has(attemptId)));
  return projectWaveExecutionDiagnostics({responseState,payloadState,
    expectedWorkerCount:Math.min(5,descriptors.length),returnedWorkerCount:Math.min(5,workers.length),
    matchedWorkerCount:Math.min(5,returnedIds.size),
    ...(responseState==='failed'&&/The browser '[^'\n]+' is not open, please run open first/u.test(String(response?.stdout||''))
      ?{failureCategory:'session_not_open'}:{})});
}

function safeCaptureValidationDiagnostics(value) {
  const response=value.responseEvidence||{},search=value.searchDiagnostics||{},guard=value.guardDiagnostics||{};
  const validationCodes=new Set(['SUCCESS_CAPTURE_PROOF_INVALID','ERROR_QUERY_UNVERIFIED','NOT_SHOWN_QUERY_UNVERIFIED',
    'NO_MATCH_QUERY_UNVERIFIED','CATEGORY_RESTRICTION_EVIDENCE_INVALID','FAILURE_STATUS_INVALID',
    'FAILURE_RECEIPT_STATUS_INVALID','FAILURE_CAPTURE_HAS_CONTACT_VALUE','FAILURE_ATTEMPT_TIME_MISSING',
    'FAILURE_AUTH_EVIDENCE_INVALID','FAILURE_RISK_EVIDENCE_INVALID']);
  const count=(input,max=100000)=>Number.isInteger(input)&&input>=0&&input<=max?input:0;
  const boolean=value=>typeof value==='boolean'?value:null;
  const reason=input=>input===''?'':safeReason(input,'UNKNOWN_ERROR');
  const safe={validationCode:safeEnum(value.validationCode,validationCodes,'UNKNOWN_VALIDATION_FAILURE'),
    stage:safeEnum(value.stage,CAPTURE_STAGES,'unknown'),
    attemptStatus:safeEnum(value.attemptStatus,new Set(['found','not_shown','not_found','login_required','captcha','error','forbidden_by_platform']),'error'),
    attemptErrorReason:reason(value.attemptErrorReason),
    receiptStatus:safeEnum(value.receiptStatus,new Set(['completed','stopped','unknown']),'unknown'),
    receiptReason:reason(value.receiptReason),
    identityProof:safeEnum(value.identityProof,new Set(['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED']),''),
    sameContext:boolean(value.sameContext),samePage:boolean(value.samePage),authFailureSeen:boolean(value.authFailureSeen),
    formalIdMatch:boolean(value.formalIdMatch),profileOpened:boolean(value.profileOpened),
    responseEvidence:{authPromptLatched:typeof response.authPromptLatched==='boolean'?response.authPromptLatched:null,
      explicitAuthResponseCount:count(response.explicitAuthResponseCount)},
    searchDiagnostics:{submittedAfterActivation:boolean(search.submittedAfterActivation),
      queryType:safeEnum(search.queryType,new Set(['ID','NICKNAME']),'ID'),attemptCount:count(search.attemptCount,3),
      matchedRequestCount:count(search.matchedRequestCount,3),matchedResponseCount:count(search.matchedResponseCount,3),
      visibleStableIdentityMatchCount:Number.isInteger(search.visibleStableIdentityMatchCount)&&
        search.visibleStableIdentityMatchCount>=0&&search.visibleStableIdentityMatchCount<=100000
        ?search.visibleStableIdentityMatchCount:-1,
      httpStatusCategory:safeEnum(search.httpStatusCategory,new Set(['missing','2xx','4xx','5xx','other']),'missing'),
      businessCodeCategory:safeEnum(search.businessCodeCategory,new Set(['missing','zero','nonzero']),'missing'),
      exactIdMatchCount:count(search.exactIdMatchCount),uidPresent:boolean(search.uidPresent),
      feedResultIdMatchesTarget:boolean(search.feedResultIdMatchesTarget),
      selectedExactResultPresent:boolean(search.selectedExactResultPresent),
      matchedIdentityKeyKind:safeEnum(search.matchedIdentityKeyKind,new Set(['UID','AWEME_ID','BOTH','NONE','MISSING']),'MISSING'),
      contactMarkerState:safeEnum(search.contactMarkerState,new Set(['present','absent','unresolved','missing']),'missing'),
      failureBranch:safeEnum(search.failureBranch,SEARCH_FAILURE_BRANCHES,'unknown'),
      ...(SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)
        ?{executionPhase:search.executionPhase,exceptionCategory:search.exceptionCategory}:{})},
    guardDiagnostics:{targetClosed:boolean(guard.targetClosed),targetContextMatches:boolean(guard.targetContextMatches),
      targetHidden:boolean(guard.targetHidden),pageSetStable:boolean(guard.pageSetStable),
      otherPagesStable:boolean(guard.otherPagesStable),
      otherPageNavigationChanged:boolean(guard.otherPageNavigationChanged),
      otherPageVisibilityChanged:boolean(guard.otherPageVisibilityChanged),
      otherPageDocumentChanged:boolean(guard.otherPageDocumentChanged),
      profileUidConfirmed:boolean(guard.profileUidConfirmed),authHealthy:boolean(guard.authHealthy),
      errorFree:boolean(guard.errorFree),reason:reason(guard.reason)}};
  if (isObject(value.successProofDiagnostics)) {
    const proof=value.successProofDiagnostics;
    safe.successProofDiagnostics={
      status:safeEnum(proof.status,SUCCESS_PROOF_STATUSES,'unavailable'),
      unmetProofGroups:Array.isArray(proof.unmetProofGroups)
        ?[...new Set(proof.unmetProofGroups.filter(group=>SUCCESS_PROOF_GROUPS.has(group)))].slice(0,9):[],
    };
  }
  return safe;
}

function makeQueueSnapshot({manifest,state,targetCount,extraRowState='pending'}) {
  const rows=manifest.targets.slice(0,targetCount).map((target,index)=>({...target,...state.entries[index]}));
  const report=summarizeCanary(state,targetCount);
  return {version:1,sourceBatchId:manifest.sourceBatchId,targetCount,updatedAt:new Date().toISOString(),report,
    extraRow:{state:extraRowState,countsTowardOriginal:false},queue:rows,
    confirmed:rows.filter(row=>row.state==='confirmed').map(row=>row.creatorId),
    unprocessed:rows.filter(row=>row.state==='pending').map(row=>row.creatorId),
    errors:rows.filter(row=>row.state==='error').map(row=>row.creatorId),
    uncertain:rows.filter(row=>['uncertain','in_flight'].includes(row.state)).map(row=>row.creatorId)};
}

async function acquireLock(lockPath,ownerToken) {
  let handle;
  try { handle=await fs.open(lockPath,'wx',0o600); }
  catch { throw new Error(lockPath.endsWith('production.lock')?'PARALLEL_PRODUCTION_LOCKED':'PARALLEL_CHECKPOINT_LOCKED'); }
  try {
    await handle.writeFile(JSON.stringify({pid:process.pid,ownerToken,acquiredAt:new Date().toISOString()}));
    await handle.sync();
  } catch (error) {
    await handle.close();
    try { await fs.unlink(lockPath); } catch {}
    throw error;
  }
  return handle;
}

async function releaseLock(lockPath,handle,ownerToken) {
  if (!handle) return;
  try { await handle.close(); } catch {}
  try {
    const record=JSON.parse(await fs.readFile(lockPath,'utf8'));
    if (record.ownerToken===ownerToken) await fs.unlink(lockPath);
  } catch {}
}

async function ownsLockFile(lockPath,handle,ownerToken) {
  if (!handle) return false;
  try {
    await handle.stat();
    const record=JSON.parse(await fs.readFile(lockPath,'utf8'));
    return record.ownerToken===ownerToken;
  } catch { return false; }
}

function safeParallelReport(report) {
  if (!isObject(report)) return {state:'runner_failed',reason:'PARALLEL_RUN_FAILED'};
  const output={state:safeEnum(report.state,new Set(['parallel_finished','parallel_stopped','parallel_paused',
    'parallel_performance_failed','parallel_batch_finished','pilot_passed','pilot_failed','pilot_unavailable']),'runner_failed'),
    targetCount:[100,200,500].includes(report.targetCount)?report.targetCount:100,
    shardCount:5,activeLaneCount:Number.isInteger(report.activeLaneCount)?report.activeLaneCount:0,
    processedCount:Number.isInteger(report.processedCount)?report.processedCount:0,
    pendingCount:Number.isInteger(report.pendingCount)?report.pendingCount:0,
    confirmedCount:Number.isInteger(report.confirmedCount)?report.confirmedCount:0,
    errorCount:Number.isInteger(report.errorCount)?report.errorCount:0,
    uncertainCount:Number.isInteger(report.uncertainCount)?report.uncertainCount:0,
    remaining:Number.isInteger(report.remaining)?report.remaining:0};
  if (SAFE_CODE.test(report.reason||'')) output.reason=report.reason;
  if (typeof report.cohortId==='string'&&/^original500-unprocessed-50-[0-9]{8}-v[1-9][0-9]*$/u.test(report.cohortId)) {
    output.cohortId=report.cohortId;
  }
  if (Number.isInteger(report.cohortTargetCount)&&report.cohortTargetCount>=0&&report.cohortTargetCount<=50) {
    output.cohortTargetCount=report.cohortTargetCount;
  }
  if (isObject(report.batch)) output.batch={
    targetCount:Number.isInteger(report.batch.targetCount)?report.batch.targetCount:0,
    processedCount:Number.isInteger(report.batch.processedCount)?report.batch.processedCount:0,
    confirmedCount:Number.isInteger(report.batch.confirmedCount)?report.batch.confirmedCount:0,
    errorCount:Number.isInteger(report.batch.errorCount)?report.batch.errorCount:0,
    uncertainCount:Number.isInteger(report.batch.uncertainCount)?report.batch.uncertainCount:0,
    workerCount:Number.isInteger(report.batch.workerCount)?report.batch.workerCount:0,
  };
  if (typeof report.pilotManifestSha256==='string'&&/^[a-f0-9]{64}$/u.test(report.pilotManifestSha256)) {
    output.pilotManifestSha256=report.pilotManifestSha256;
  }
  if (isObject(report.pilot)) output.pilot={passed:report.pilot.passed===true,
    distinctTargets:report.pilot.distinctTargets===true,parallelOverlap:report.pilot.parallelOverlap===true,
    targetCount:Number.isInteger(report.pilot.targetCount)?report.pilot.targetCount:0,
    confirmedCount:Number.isInteger(report.pilot.confirmedCount)?report.pilot.confirmedCount:0,
    elapsedMs:Number.isFinite(report.pilot.elapsedMs)?report.pilot.elapsedMs:0,
    workerMs:Number.isFinite(report.pilot.workerMs)?report.pilot.workerMs:0,
    writerMs:Number.isFinite(report.pilot.writerMs)?report.pilot.writerMs:0,
    serialBaselineMs:Number.isFinite(report.pilot.serialBaselineMs)?report.pilot.serialBaselineMs:0,
    confirmedPerMinute:Number.isFinite(report.pilot.confirmedPerMinute)?report.pilot.confirmedPerMinute:0,
    speedup:Number.isFinite(report.pilot.speedup)?report.pilot.speedup:0};
  if (isObject(report.cohort)) output.cohort={
    targetCount:Number.isInteger(report.cohort.targetCount)?report.cohort.targetCount:0,
    processedCount:Number.isInteger(report.cohort.processedCount)?report.cohort.processedCount:0,
    confirmedCount:Number.isInteger(report.cohort.confirmedCount)?report.cohort.confirmedCount:0,
    newlyConfirmedCount:Number.isInteger(report.cohort.newlyConfirmedCount)?report.cohort.newlyConfirmedCount:0,
    errorCount:Number.isInteger(report.cohort.errorCount)?report.cohort.errorCount:0,
    uncertainCount:Number.isInteger(report.cohort.uncertainCount)?report.cohort.uncertainCount:0,
    remaining:Number.isInteger(report.cohort.remaining)?report.cohort.remaining:0,
    wallMs:Number.isFinite(report.cohort.wallMs)?report.cohort.wallMs:0,
    workerMs:Number.isFinite(report.cohort.workerMs)?report.cohort.workerMs:0,
    writerMs:Number.isFinite(report.cohort.writerMs)?report.cohort.writerMs:0,
    serialEquivalentMs:Number.isFinite(report.cohort.serialEquivalentMs)?report.cohort.serialEquivalentMs:0,
    estimatedSpeedup:Number.isFinite(report.cohort.estimatedSpeedup)?report.cohort.estimatedSpeedup:0,
    confirmedPerMinute:Number.isFinite(report.cohort.confirmedPerMinute)?report.cohort.confirmedPerMinute:0,
    overlapEvidenceWaves:Number.isInteger(report.cohort.overlapEvidenceWaves)?report.cohort.overlapEvidenceWaves:0,
    measuredWorkerWaves:Number.isInteger(report.cohort.measuredWorkerWaves)?report.cohort.measuredWorkerWaves:0,
    allMeasuredWavesOverlapped:report.cohort.allMeasuredWavesOverlapped===true,
    fiveLane:isObject(report.cohort.fiveLane)?{
      processedCount:Number.isInteger(report.cohort.fiveLane.processedCount)?report.cohort.fiveLane.processedCount:0,
      confirmedCount:Number.isInteger(report.cohort.fiveLane.confirmedCount)?report.cohort.fiveLane.confirmedCount:0,
      errorCount:Number.isInteger(report.cohort.fiveLane.errorCount)?report.cohort.fiveLane.errorCount:0,
      uncertainCount:Number.isInteger(report.cohort.fiveLane.uncertainCount)?report.cohort.fiveLane.uncertainCount:0,
      wallMs:Number.isFinite(report.cohort.fiveLane.wallMs)?report.cohort.fiveLane.wallMs:0,
      workerMs:Number.isFinite(report.cohort.fiveLane.workerMs)?report.cohort.fiveLane.workerMs:0,
      writerMs:Number.isFinite(report.cohort.fiveLane.writerMs)?report.cohort.fiveLane.writerMs:0,
      serialEquivalentMs:Number.isFinite(report.cohort.fiveLane.serialEquivalentMs)?report.cohort.fiveLane.serialEquivalentMs:0,
      confirmedPerMinute:Number.isFinite(report.cohort.fiveLane.confirmedPerMinute)?report.cohort.fiveLane.confirmedPerMinute:0,
      estimatedSpeedup:Number.isFinite(report.cohort.fiveLane.estimatedSpeedup)?report.cohort.fiveLane.estimatedSpeedup:0,
      overlapEvidenceWaves:Number.isInteger(report.cohort.fiveLane.overlapEvidenceWaves)?report.cohort.fiveLane.overlapEvidenceWaves:0,
      measuredWorkerWaves:Number.isInteger(report.cohort.fiveLane.measuredWorkerWaves)?report.cohort.fiveLane.measuredWorkerWaves:0,
      allMeasuredWavesOverlapped:report.cohort.fiveLane.allMeasuredWavesOverlapped===true,
    }:undefined,
    baselineKind:report.cohort.baselineKind==='same_cohort_serial_equivalent'?'same_cohort_serial_equivalent':''};
    const laneMetrics=value=>({
    workerCount:Number.isInteger(value.workerCount)?value.workerCount:0,
    processedCount:Number.isInteger(value.processedCount)?value.processedCount:0,
    confirmedCount:Number.isInteger(value.confirmedCount)?value.confirmedCount:0,
    errorCount:Number.isInteger(value.errorCount)?value.errorCount:0,
    uncertainCount:Number.isInteger(value.uncertainCount)?value.uncertainCount:0,
    wallMs:Number.isFinite(value.wallMs)?value.wallMs:0,
    workerMs:Number.isFinite(value.workerMs)?value.workerMs:0,
    writerMs:Number.isFinite(value.writerMs)?value.writerMs:0,
    serialEquivalentMs:Number.isFinite(value.serialEquivalentMs)?value.serialEquivalentMs:0,
    confirmedPerMinute:Number.isFinite(value.confirmedPerMinute)?value.confirmedPerMinute:0,
    estimatedSpeedup:Number.isFinite(value.estimatedSpeedup)?value.estimatedSpeedup:0,
    overlapEvidenceWaves:Number.isInteger(value.overlapEvidenceWaves)?value.overlapEvidenceWaves:0,
    measuredWorkerWaves:Number.isInteger(value.measuredWorkerWaves)?value.measuredWorkerWaves:0,
    allMeasuredWavesOverlapped:value.allMeasuredWavesOverlapped===true,
  });
  if (isObject(report.cohort?.continuation)) output.cohort.continuation=laneMetrics(report.cohort.continuation);
  if (isObject(report.cohort?.fiveLane)) output.cohort.fiveLane=laneMetrics(report.cohort.fiveLane);
  if (isObject(report.cohort?.performanceGate)) output.cohort.performanceGate={
    status:safeEnum(report.cohort.performanceGate.status,new Set(['incomplete','passed','failed']),'incomplete'),
    passed:report.cohort.performanceGate.passed===true,
    elapsedMs:Number.isFinite(report.cohort.performanceGate.elapsedMs)?report.cohort.performanceGate.elapsedMs:0,
    limitMs:Number.isInteger(report.cohort.performanceGate.limitMs)?report.cohort.performanceGate.limitMs:0,
    targetCount:Number.isInteger(report.cohort.performanceGate.targetCount)?report.cohort.performanceGate.targetCount:0,
    confirmedCount:Number.isInteger(report.cohort.performanceGate.confirmedCount)?report.cohort.performanceGate.confirmedCount:0,
    readbackVerifiedCount:Number.isInteger(report.cohort.performanceGate.readbackVerifiedCount)
      ?report.cohort.performanceGate.readbackVerifiedCount:0,
    completed:report.cohort.performanceGate.completed===true,
  };
  return output;
}

async function defaultDependencies() {
  const client=new AsyncReadLarkBaseClient({route:FEISHU_ROUTE});
  return {
    stateDir:PRODUCTION_STATE_DIR,sourceStateDir:DEFAULT_STATE_DIR,
    loadOriginalQueue:({sourceManifestPath}={})=>loadOriginalQueue({sourceManifestPath,sourceStateDir:DEFAULT_STATE_DIR}),
    loadSourceRows:({sourceManifestPath}={})=>loadVerifiedSourceRows({sourceManifestPath,sourceStateDir:DEFAULT_STATE_DIR}),
    verifyAuth:()=>readAuthStatus(),
    readSchema:()=>client.listFields(),
    inspectPages:()=>inspectPagesWithCli(),
    createClient:()=>client,
    verifyQualifiedBaseIndex:async({targets})=>verifyQualifiedRecordIndex({targets,
      index:await readCurrentCreatorRecordIndex(client)}),
    loadDetailTemplate:async()=>DEFAULT_DETAIL_TEMPLATE,
    getWaveBuilder:async()=>{
      const wave=await import('./original-background-wave.mjs');
      return typeof wave.buildOriginalBackgroundWaveCode==='function'?wave.buildOriginalBackgroundWaveCode:null;
    },
    invokeWaveCli:args=>runCliCode(args),
    createProductionAdapter:options=>createProductionAdapter(options),
    prepareWriteContext:(request,options)=>prepareWriteContext(request,options),
    commitCapturedAttempt:(context,capture)=>commitCapturedAttempt(context,capture),
    prepareCheckpoint:({manifest,targetCount,checkpointPath,initialResults,reviewedRecovery,migration})=>
      runCanaryBatch({manifest,targetCount,checkpointPath,initialResults,reviewedRecovery,migration,prepareOnly:true}),
    newAttemptId:randomUUID,
  };
}

function scopeValid(manifest) {
  return manifest?.version===1&&manifest.sourceBatchId===ORIGINAL_BATCH_ID&&manifest.targets?.length===500&&
    manifest.targets.every(target=>target.extraAuthorized!==true&&target.creatorId!=='LEGACY_EXTRA_DISABLED'&&target.recordId!=='LEGACY_RECORD_DISABLED');
}

export function validatePilotCohort(pilot,manifest) {
  const mixed=pilot?.entryPolicy==='40_pending_10_recovery';
  if (!isObject(pilot)||pilot.schemaVersion!==1||
      !/^original500-unprocessed-50-[0-9]{8}-v[1-9][0-9]*$/u.test(pilot.cohortId||'')||
      pilot.sourceBatchId!==ORIGINAL_BATCH_ID||pilot.sourceCount!==500||pilot.targetCount!==50||
      pilot.shardAlgorithm!==(mixed?'fixed cohort explicit lanes':'sha256(creatorId) ascending across original500; index mod 5')||
      !Array.isArray(pilot.targets)||pilot.targets.length!==50) {
    throw new Error('PARALLEL_PILOT_MANIFEST_INVALID');
  }
  const sourceById=new Map(manifest.targets.map(target=>[target.creatorId,target]));
  const ids=new Set(),records=new Set(),laneCounts=Array(5).fill(0);
  const sorted=manifest.targets.slice().sort((a,b)=>createHash('sha256').update(a.creatorId).digest('hex').localeCompare(
    createHash('sha256').update(b.creatorId).digest('hex'))||a.creatorId.localeCompare(b.creatorId));
  const laneById=new Map(sorted.map((target,index)=>[target.creatorId,index%5]));
  for (const row of pilot.targets) {
    if (!isObject(row)||Object.keys(row).length!==(mixed?4:3)||
        (mixed&&(!Number.isInteger(row.laneIndex)||row.laneIndex<0||row.laneIndex>4))||
        typeof row.creatorId!=='string'||typeof row.recordId!=='string'||!Number.isInteger(row.sourceRank)||
        ids.has(row.creatorId)||records.has(row.recordId)) throw new Error('PARALLEL_PILOT_MANIFEST_INVALID');
    const source=sourceById.get(row.creatorId);
    if (!source||source.recordId!==row.recordId||source.sourceRank!==row.sourceRank) {
      throw new Error('PARALLEL_PILOT_TARGET_MAPPING_INVALID');
    }
    if(mixed)laneById.set(row.creatorId,row.laneIndex);
    ids.add(row.creatorId);records.add(row.recordId);laneCounts[laneById.get(row.creatorId)]+=1;
  }
  const remainingDistribution=!mixed&&pilot.laneDistribution==='remaining_source';
  if(pilot.laneDistribution!==undefined&&!remainingDistribution)throw new Error('PARALLEL_PILOT_MANIFEST_INVALID');
  if (laneCounts.some(count=>remainingDistribution?count<1:count!==10)) throw new Error('PARALLEL_PILOT_SHARDS_UNBALANCED');
  if(mixed&&(!Array.isArray(pilot.recoveryAttempts)||pilot.recoveryAttempts.length!==10||
      new Set(pilot.recoveryAttempts.map(r=>r.creatorId)).size!==10||pilot.recoveryAttempts.some(r=>
        !ids.has(r.creatorId)||typeof r.attemptId!=='string'||!r.attemptId)))throw new Error('PARALLEL_PILOT_MANIFEST_INVALID');
  if(!mixed&&pilot.entryPolicy!==undefined)throw new Error('PARALLEL_PILOT_MANIFEST_INVALID');
  return {cohortId:pilot.cohortId,targetCreatorIds:[...ids],laneCounts,
    ...(mixed?{laneAssignments:Object.fromEntries([...ids].map(id=>[id,laneById.get(id)])),recoveryAttempts:pilot.recoveryAttempts}: {})};
}

function pilotLaneMap(manifest,laneAssignments) {
  if(laneAssignments)return new Map(Object.entries(laneAssignments));
  const ordered=manifest.targets.slice().sort((a,b)=>createHash('sha256').update(a.creatorId).digest('hex').localeCompare(
    createHash('sha256').update(b.creatorId).digest('hex'))||a.creatorId.localeCompare(b.creatorId));
  return new Map(ordered.map((target,index)=>[target.creatorId,index%PARALLEL_SHARD_COUNT]));
}

function selectPilotBatchTargets({cohort,manifest,state,batchSize,workerLimit,retryErrors,resumeBlocked,
  retryExclusions=[]}) {
  if (!Number.isInteger(batchSize)||batchSize<1||batchSize>50||
      ![1,2,5].includes(workerLimit)||batchSize%workerLimit!==0) {
    throw new Error('PARALLEL_PILOT_BATCH_INVALID');
  }
  const excludedCreators=new Set(validateRetryExclusions({manifest,exclusions:retryExclusions})
    .map(exclusion=>exclusion.creatorId));
  const laneById=pilotLaneMap(manifest,cohort.laneAssignments);
  const lanes=Array.from({length:PARALLEL_SHARD_COUNT},()=>[]);
  for (const creatorId of cohort.targetCreatorIds) {
    if(excludedCreators.has(creatorId))continue;
    const index=manifest.targets.findIndex(target=>target.creatorId===creatorId);
    if (index<0) throw new Error('PARALLEL_PILOT_TARGET_MAPPING_INVALID');
    const entry=state.entries[index];
    const eligible=entry.state==='pending'||entry.state==='error'&&retryErrors||entry.state==='blocked'&&resumeBlocked;
    if (eligible) lanes[laneById.get(creatorId)].push({creatorId,sourceRank:manifest.targets[index].sourceRank,
      error:entry.state==='error'||entry.state==='blocked'});
  }
  for (const lane of lanes) lane.sort((a,b)=>Number(b.error)-Number(a.error)||a.sourceRank-b.sourceRank||
    a.creatorId.localeCompare(b.creatorId));
  const candidates=lanes.map((targets,laneIndex)=>({laneIndex,targets,
    hasRetryable:targets.some(target=>target.error),firstRank:targets[0]?.sourceRank??Number.MAX_SAFE_INTEGER}))
    .filter(lane=>lane.targets.length>0)
    .sort((a,b)=>Number(b.hasRetryable)-Number(a.hasRetryable)||a.firstRank-b.firstRank||a.laneIndex-b.laneIndex)
    .slice(0,workerLimit);
  const perLane=batchSize/workerLimit;
  return candidates.flatMap(lane=>lane.targets.slice(0,perLane).map(target=>target.creatorId));
}

async function readPilotManifest(filePath) {
  if (typeof filePath!=='string'||!filePath.trim()) throw new Error('PARALLEL_PILOT_MANIFEST_PATH_INVALID');
  const resolved=path.resolve(filePath);
  let stat,bytes;
  try { stat=await fs.lstat(resolved); } catch { throw new Error('PARALLEL_PILOT_MANIFEST_UNAVAILABLE'); }
  if (!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>64*1024) {
    throw new Error('PARALLEL_PILOT_MANIFEST_UNSAFE');
  }
  try { bytes=await fs.readFile(resolved); } catch { throw new Error('PARALLEL_PILOT_MANIFEST_UNAVAILABLE'); }
  let manifest;
  try { manifest=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('PARALLEL_PILOT_MANIFEST_INVALID'); }
  return {manifest,sha256:createHash('sha256').update(bytes).digest('hex')};
}

function pilotLedgerPath(stateDir,cohortId) {
  if (!/^original500-unprocessed-50-[0-9]{8}-v[1-9][0-9]*$/u.test(cohortId||'')) {
    throw new Error('PARALLEL_PILOT_LEDGER_ID_INVALID');
  }
  return path.join(stateDir,'pilot-cohorts',`${cohortId}.json`);
}

async function readPilotLedger(filePath) {
  let stat,bytes;
  try { stat=await fs.lstat(filePath); }
  catch (error) { if (error?.code==='ENOENT') return null; throw new Error('PARALLEL_PILOT_LEDGER_UNAVAILABLE'); }
  if (!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>4096) {
    throw new Error('PARALLEL_PILOT_LEDGER_UNSAFE');
  }
  try { bytes=await fs.readFile(filePath); } catch { throw new Error('PARALLEL_PILOT_LEDGER_UNAVAILABLE'); }
  let ledger;
  try { ledger=JSON.parse(bytes.toString('utf8')); } catch { throw new Error('PARALLEL_PILOT_LEDGER_INVALID'); }
  const v1Keys=['schemaVersion','sourceBatchId','cohortId','manifestSha256','targetCount','state','updatedAt'];
  const v2Keys=[...v1Keys,'cohortStartedAtMs','performanceGate'];
  const keys=ledger?.schemaVersion===1?v1Keys:ledger?.schemaVersion===2?v2Keys:[];
  const validGate=ledger?.performanceGate===null||isObject(ledger?.performanceGate)&&
    Object.keys(ledger.performanceGate).sort().join(',')===['status','passed','elapsedMs','limitMs','targetCount',
      'confirmedCount','readbackVerifiedCount','completed'].sort().join(',')&&
    ['incomplete','passed','failed','unverified'].includes(ledger.performanceGate.status)&&
    typeof ledger.performanceGate.passed==='boolean'&&Number.isFinite(ledger.performanceGate.elapsedMs)&&
    Number.isInteger(ledger.performanceGate.limitMs)&&ledger.performanceGate.limitMs===PARALLEL_PILOT_MAX_WALL_MS&&
    ledger.performanceGate.targetCount===50&&Number.isInteger(ledger.performanceGate.confirmedCount)&&
    ledger.performanceGate.confirmedCount>=0&&ledger.performanceGate.confirmedCount<=50&&
    Number.isInteger(ledger.performanceGate.readbackVerifiedCount)&&ledger.performanceGate.readbackVerifiedCount>=0&&
    ledger.performanceGate.readbackVerifiedCount<=50&&typeof ledger.performanceGate.completed==='boolean'&&
    ledger.performanceGate.elapsedMs>=0&&(
      ledger.performanceGate.status==='passed'&&ledger.performanceGate.passed&&ledger.performanceGate.completed&&
        ledger.performanceGate.elapsedMs<=PARALLEL_PILOT_MAX_WALL_MS&&ledger.performanceGate.confirmedCount===50&&
        ledger.performanceGate.readbackVerifiedCount===50||
      ledger.performanceGate.status==='failed'&&!ledger.performanceGate.passed&&
        ledger.performanceGate.elapsedMs>PARALLEL_PILOT_MAX_WALL_MS&&(
          ledger.performanceGate.completed&&ledger.performanceGate.confirmedCount===50&&
            ledger.performanceGate.readbackVerifiedCount===50||
          !ledger.performanceGate.completed&&ledger.performanceGate.confirmedCount<50&&
            ledger.performanceGate.readbackVerifiedCount<=ledger.performanceGate.confirmedCount)||
      ledger.performanceGate.status==='incomplete'&&!ledger.performanceGate.passed&&!ledger.performanceGate.completed||
      ledger.performanceGate.status==='unverified'&&!ledger.performanceGate.passed&&ledger.performanceGate.completed);
  if (!isObject(ledger)||Object.keys(ledger).sort().join(',')!==keys.sort().join(',')||
      ![1,2].includes(ledger.schemaVersion)||ledger.sourceBatchId!==ORIGINAL_BATCH_ID||
      !/^original500-unprocessed-50-[0-9]{8}-v[1-9][0-9]*$/u.test(ledger.cohortId||'')||
      !/^[a-f0-9]{64}$/u.test(ledger.manifestSha256||'')||ledger.targetCount!==50||
      !['running','partial','complete'].includes(ledger.state)||!Number.isFinite(Date.parse(ledger.updatedAt))||
      ledger.schemaVersion===2&&(!Number.isSafeInteger(ledger.cohortStartedAtMs)||ledger.cohortStartedAtMs<0||!validGate)) {
    throw new Error('PARALLEL_PILOT_LEDGER_INVALID');
  }
  return ledger;
}

async function priorCohortClosure({cohort,pilotManifestPath,manifest,state,stateDir,retryExclusions=[]}) {
  const excluded=new Set(validateRetryExclusions({manifest,exclusions:retryExclusions}).map(item=>item.creatorId));
  const verifiedResult=entry=>validCheckpointEntry(entry)&&entry.state==='confirmed'&&
    ['success','not_shown','no_match','forbidden_by_platform','not_found'].includes(entry.outcome)&&entry.readbackVerified===true;
  const match=cohort.cohortId.match(/^(original500-unprocessed-50-\d{8})-v([1-9]\d*)$/u);
  if (!match) return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED'};
  const currentVersion=Number(match[2]);
  if (currentVersion===1) return {ready:true};
  if (typeof pilotManifestPath!=='string'||!pilotManifestPath.trim())
    return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED'};
  const directory=path.dirname(path.resolve(pilotManifestPath));
  for (let version=1;version<currentVersion;version+=1) {
    const cohortId=`${match[1]}-v${version}`;
    const manifestFile=path.join(directory,`${cohortId}.json`);
    const ledgerFile=pilotLedgerPath(stateDir,cohortId);
    let ledger;
    try { ledger=await readPilotLedger(ledgerFile); }
    catch { return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED',priorCohortId:cohortId}; }
    let manifestExists=false;
    try { await fs.lstat(manifestFile); manifestExists=true; }
    catch (error) { if (error?.code!=='ENOENT') return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED',priorCohortId:cohortId}; }
    if (!manifestExists) {
      if (ledger) return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED',priorCohortId:cohortId};
      continue;
    }
    let priorPayload;
    try { priorPayload=await readPilotManifest(manifestFile); }
    catch { return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED',priorCohortId:cohortId}; }
    let prior;
    try { prior=validatePilotCohort(priorPayload.manifest,manifest); }
    catch { return {ready:false,reason:'PARALLEL_PRIOR_COHORT_EVIDENCE_UNVERIFIED',priorCohortId:cohortId}; }
    const indexes=prior.targetCreatorIds.map(id=>manifest.targets.findIndex(target=>target.creatorId===id));
    const entries=indexes.map(index=>index<0?null:state.entries[index]);
    const allFresh=entries.length===50&&entries.every(entry=>entry?.state==='pending');
    if (!ledger&&allFresh) continue;
    const complete=ledger?.cohortId===cohortId&&ledger.manifestSha256===priorPayload.sha256&&
      ledger.state==='complete'&&entries.length===50&&entries.every(verifiedResult);
    // A verified merchant exclusion closes data scope, never a collection or performance result.
    // Preserve the original ledger/clock; uncertain and in-flight writes cannot be excluded away.
    const dataScopeClosed=ledger?.cohortId===cohortId&&ledger.manifestSha256===priorPayload.sha256&&
      entries.length===50&&prior.targetCreatorIds.some(id=>excluded.has(id))&&
      entries.every((entry,index)=>verifiedResult(entry)||
        excluded.has(prior.targetCreatorIds[index])&&['pending','error','blocked'].includes(entry?.state));
    if (!complete&&!dataScopeClosed) return {ready:false,reason:'PARALLEL_PRIOR_COHORT_OPEN',priorCohortId:cohortId};
  }
  return {ready:true};
}

async function writePilotLedger(filePath,{cohortId,manifestSha256,state,cohortStartedAtMs,performanceGate=null}) {
  if (!['running','partial','complete'].includes(state)||
      !/^original500-unprocessed-50-[0-9]{8}-v[1-9][0-9]*$/u.test(cohortId||'')||
      !/^[a-f0-9]{64}$/u.test(manifestSha256||'')||!Number.isSafeInteger(cohortStartedAtMs)||cohortStartedAtMs<0||
      performanceGate!==null&&(!isObject(performanceGate)||
        !['incomplete','passed','failed','unverified'].includes(performanceGate.status)||
        typeof performanceGate.passed!=='boolean'||!Number.isFinite(performanceGate.elapsedMs)||performanceGate.elapsedMs<0||
        performanceGate.limitMs!==PARALLEL_PILOT_MAX_WALL_MS||performanceGate.targetCount!==50||
        !Number.isInteger(performanceGate.confirmedCount)||performanceGate.confirmedCount<0||performanceGate.confirmedCount>50||
        !Number.isInteger(performanceGate.readbackVerifiedCount)||performanceGate.readbackVerifiedCount<0||
        performanceGate.readbackVerifiedCount>50||typeof performanceGate.completed!=='boolean'||(
          performanceGate.status==='passed'&&(!performanceGate.passed||!performanceGate.completed||
            performanceGate.elapsedMs>PARALLEL_PILOT_MAX_WALL_MS||performanceGate.confirmedCount!==50||
            performanceGate.readbackVerifiedCount!==50)||
          performanceGate.status==='failed'&&(performanceGate.passed||
            performanceGate.elapsedMs<=PARALLEL_PILOT_MAX_WALL_MS||(
              performanceGate.completed&&(performanceGate.confirmedCount!==50||
                performanceGate.readbackVerifiedCount!==50)||
              !performanceGate.completed&&(performanceGate.confirmedCount>=50||
                performanceGate.readbackVerifiedCount>performanceGate.confirmedCount)))||
          performanceGate.status==='incomplete'&&(performanceGate.passed||performanceGate.completed)||
          performanceGate.status==='unverified'&&(performanceGate.passed||!performanceGate.completed)))) {
    throw new Error('PARALLEL_PILOT_LEDGER_INVALID');
  }
  await writePrivateJson(filePath,{schemaVersion:2,sourceBatchId:ORIGINAL_BATCH_ID,cohortId,manifestSha256,
    targetCount:50,state,cohortStartedAtMs,performanceGate,updatedAt:new Date().toISOString()});
}

function pilotPerformanceGate({entries,cohortStartedAtMs,nowMs,reportedGate=null,previousGate=null}) {
  const confirmedCount=entries.filter(entry=>entry?.state==='confirmed').length;
  const readbackVerifiedCount=entries.filter(entry=>entry?.state==='confirmed'&&entry?.readbackVerified===true).length;
  const completed=entries.length===50&&confirmedCount===50&&readbackVerifiedCount===50;
  const elapsedMs=Math.max(0,nowMs-cohortStartedAtMs,
    Number.isFinite(reportedGate?.elapsedMs)?reportedGate.elapsedMs:0,
    previousGate?.status==='failed'&&Number.isFinite(previousGate.elapsedMs)?previousGate.elapsedMs:0);
  const failed=previousGate?.status==='failed'||reportedGate?.status==='failed'||
    elapsedMs>PARALLEL_PILOT_MAX_WALL_MS;
  if(failed)return {status:'failed',passed:false,elapsedMs,limitMs:PARALLEL_PILOT_MAX_WALL_MS,targetCount:50,
    confirmedCount,readbackVerifiedCount,completed};
  if(previousGate?.status==='passed'&&completed&&previousGate.elapsedMs<=PARALLEL_PILOT_MAX_WALL_MS) {
    return {status:'passed',passed:true,elapsedMs:previousGate.elapsedMs,limitMs:PARALLEL_PILOT_MAX_WALL_MS,
      targetCount:50,confirmedCount,readbackVerifiedCount,completed:true};
  }
  if(reportedGate?.status==='passed'&&completed&&elapsedMs<=PARALLEL_PILOT_MAX_WALL_MS) {
    return {status:'passed',passed:true,elapsedMs,limitMs:PARALLEL_PILOT_MAX_WALL_MS,targetCount:50,
      confirmedCount,readbackVerifiedCount,completed:true};
  }
  if(previousGate?.status==='unverified'&&completed) return {status:'unverified',passed:false,elapsedMs,
    limitMs:PARALLEL_PILOT_MAX_WALL_MS,targetCount:50,confirmedCount,readbackVerifiedCount,completed:true};
  return {status:'incomplete',passed:false,elapsedMs,limitMs:PARALLEL_PILOT_MAX_WALL_MS,targetCount:50,
    confirmedCount,readbackVerifiedCount,completed:false};
}

function sourceNameMap(sourceRows) {
  const map=new Map();
  for (const row of sourceRows) {
    if (!row||typeof row.creatorId!=='string'||!Number.isInteger(row.sourceRank)||map.has(row.creatorId)) continue;
    map.set(row.creatorId,{sourceRank:row.sourceRank,creatorName:typeof row.creatorName==='string'?row.creatorName:''});
  }
  return map;
}

function authReady(auth) {
  return auth?.verifiedUser===true&&auth.profile===FEISHU_ROUTE.profile&&auth.as===FEISHU_ROUTE.as&&
    auth.host===PARALLEL_FEISHU_HOST&&auth.tokenStatus!=='needs_refresh';
}

async function preflight({targetCount,dependencies,sourceManifestPath}) {
  if (![100,200,500].includes(targetCount)) return {ready:false,reason:'PARALLEL_TARGET_COUNT_INVALID'};
  let source,sourceIndex,schema,auth,pages,template='',waveBuilder=null;
  try { source=await dependencies.loadOriginalQueue({sourceManifestPath}); }
  catch (error) { return {ready:false,reason:safeReason(error?.message,'PARALLEL_SOURCE_CHECKPOINT_UNVERIFIED')}; }
  if (!scopeValid(source?.manifest)) return {ready:false,reason:'PARALLEL_ORIGINAL_SCOPE_UNVERIFIED'};
  try { sourceIndex=await dependencies.loadSourceRows({sourceManifestPath}); }
  catch (error) { return {ready:false,reason:safeReason(error?.message,'PARALLEL_SOURCE_ROWS_UNVERIFIED')}; }
  if (!sourceIndex?.receipt||!Array.isArray(sourceIndex.rows)||
      source.migration&&sourceIndex.manifestFileSha256!==source.migration.sourceManifestSha256) {
    return {ready:false,reason:'PARALLEL_SOURCE_ROWS_UNVERIFIED'};
  }
  try { auth=await dependencies.verifyAuth(); } catch { auth=null; }
  if (!authReady(auth)) return {ready:false,reason:auth?.tokenStatus==='needs_refresh'
    ?'PARALLEL_USER_TOKEN_NEEDS_REFRESH':'PARALLEL_AUTH_ROUTE_UNVERIFIED',source,sourceIndex,auth};
  let qualifiedBaseIndex=null;
  if (sourceManifestPath) {
    try {
      qualifiedBaseIndex=await dependencies.verifyQualifiedBaseIndex?.({targets:source.manifest.targets});
    } catch { qualifiedBaseIndex=null; }
    if (qualifiedBaseIndex?.verified!==true||qualifiedBaseIndex.targetCount!==500||
        !/^[a-f0-9]{64}$/u.test(qualifiedBaseIndex.targetPairsSha256||'')||
        qualifiedBaseIndex.targetPairsSha256!==source.manifest.targetPairsSha256) {
      return {ready:false,reason:'PARALLEL_QUALIFIED_BASE_INDEX_UNVERIFIED',source,sourceIndex,auth};
    }
  }
  let schemaResponse;
  try { schemaResponse=await dependencies.readSchema(); } catch { schemaResponse=null; }
  schema={verified:schemaResponse?.verified===true||!!schemaFields(schemaResponse),fields:schemaFields(schemaResponse)||[]};
  const schemaStatus=schemaReady(schema);
  if (!schemaStatus.ready) return {ready:false,reason:'PARALLEL_SCHEMA_UNVERIFIED',source,sourceIndex,auth,
    schemaFieldCount:schemaStatus.fieldCount};
  try { pages=await dependencies.inspectPages(); } catch { pages={contextAvailable:false,pages:[]}; }
  const eligiblePages=selectParallelPages(pages);
  try { template=await dependencies.loadDetailTemplate(); } catch {}
  try { waveBuilder=await dependencies.getWaveBuilder(); } catch {}
  return {ready:true,source,sourceIndex,auth,schema,pages,eligiblePages,template,qualifiedBaseIndex,
    waveBuilder,templateReady:typeof template==='string'&&template.length>0,
    builderReady:typeof waveBuilder==='function',schemaFieldCount:schemaStatus.fieldCount};
}

function chooseWorkers({manifest,state,targetCount,retryErrors,resumeBlocked,eligiblePages,targetCreatorIds,retryExclusions,laneAssignments,
  singleLaneResume=false,singleLaneBatchContinuation=false,workerLimit}) {
  const shards=planParallelShards({manifest,state,targetCount,retryErrors,resumeBlocked,targetCreatorIds,retryExclusions,laneAssignments});
  const nonempty=shards.filter(shard=>shard.targets.length>0);
  if(singleLaneResume&&nonempty.length===1&&eligiblePages.length>=PARALLEL_SHARD_COUNT){
    return {workers:eligiblePages.slice(0,PARALLEL_SHARD_COUNT).map((page,laneIndex)=>({
      workerId:`koc-worker-${laneIndex+1}`,laneIndex,pageBindingId:page.pageIndex,pageIndex:page.pageIndex,route:page.route})),
      autoScaleToFive:true,singleLaneResume:true,reason:''};
  }
  const limit=workerLimit??(eligiblePages.length>=5?5:2);
  if (singleLaneBatchContinuation) {
    if(limit!==1||nonempty.length!==1||eligiblePages.length<1)return {workers:[],autoScaleToFive:false,
      singleLaneBatchContinuation:true,reason:'PARALLEL_PILOT_SINGLE_LANE_TAIL_REQUIRED'};
    const page=eligiblePages[0],laneIndex=nonempty[0].laneIndex;
    return {workers:[{workerId:`koc-worker-${laneIndex+1}`,laneIndex,pageBindingId:page.pageIndex,
      pageIndex:page.pageIndex,route:page.route}],autoScaleToFive:false,singleLaneBatchContinuation:true,reason:''};
  }
  if (![2,5].includes(limit)||nonempty.length<limit||eligiblePages.length<limit) return {workers:[],
    autoScaleToFive:false,reason:limit===5?'PARALLEL_FIVE_PAGE_COHORT_REQUIRED':'PARALLEL_TWO_PAGE_PILOT_REQUIRED'};
  const autoScaleToFive=limit===5;
  const selectedPages=eligiblePages.slice(0,limit);
  const selectedLanes=autoScaleToFive?[0,1,2,3,4]:nonempty.slice(0,limit).map(shard=>shard.laneIndex);
  const workers=selectedPages.map((page,index)=>({workerId:`koc-worker-${selectedLanes[index]+1}`,
    laneIndex:selectedLanes[index],pageBindingId:page.pageIndex,pageIndex:page.pageIndex,route:page.route}));
  return {workers,autoScaleToFive,singleLaneResume:false,reason:''};
}

async function readParallelAttemptRecord({attemptsDir,target,attemptId}) {
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(attemptId||'')) return null;
  let saved;
  try {
    const file=path.join(attemptsDir,`${attemptId}.json`);
    const stat=await fs.lstat(file);
    if (!stat.isFile()||stat.isSymbolicLink()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>64*1024) return null;
    saved=JSON.parse(await fs.readFile(file,'utf8'));
  } catch { return null; }
  const result=saved?.result,receipt=saved?.receipt;
  const matchesTarget=(value)=>value?.creatorId===target.creatorId&&value?.recordId===target.recordId&&
    value?.sourceBatchId===target.sourceBatchId&&value?.sourceRank===target.sourceRank&&value?.attemptId===attemptId;
  if (!matchesTarget(saved)||!matchesTarget(receipt)||receipt?.mode!=='parallel_production_contact_write') return null;
  return saved;
}

async function readParallelNotWrittenAttempt({attemptsDir,target,attemptId}) {
  const saved=await readParallelAttemptRecord({attemptsDir,target,attemptId});
  if(!saved)return null;
  const {result,receipt}=saved;
  if (saved?.state!=='write_finished'||result?.attemptId!==attemptId||
      receipt.mode!=='parallel_production_contact_write'||result.outcome!=='error'||result.writeState!=='not_written'||
      receipt.outcome!=='error'||receipt.writeState!=='not_written'||receipt.writerInvoked!==false||
      receipt.writeSubmitted!==false||receipt.contactValueEmitted!==false||receipt.contactSourceUrlEmitted!==false) return null;
  return {attemptId,outcome:'error',writeState:'not_written',parallelAttemptNotWritten:true,
    reason:safeReason(result.reason,'PARALLEL_ATTEMPT_NOT_WRITTEN')};
}

async function reconcileParallelFailureAttempt({attemptsDir,target,attemptId,client}) {
  const saved=await readParallelAttemptRecord({attemptsDir,target,attemptId});
  const recovered=await reconcileParallelFailureReadback({saved,
    target:{...target,attemptId},client});
  if(!recovered)return null;
  try{await writePrivateJson(path.join(attemptsDir,`${attemptId}.json`),{...saved,
    reconciliation:{kind:recovered.recoveryMode,verifiedAt:new Date().toISOString(),sameRecord:true,
      creatorIdentity:true,statusMatches:true,attemptTimeMatches:true,errorMatches:true,
      historyVerified:recovered.historyVerified===true,oldContactStillBlank:true,readbackOnly:true}});}catch{return null;}
  return recovered;
}

async function reconcileLegacyUnknowns({manifest,state,targetCount,targetCreatorIds,adapter,persistCheckpoint,ownerIdle,
  attemptsDir,client,excludedCreatorIds=[]}) {
  let changed=0;
  const selected=targetCreatorIds===undefined?null:new Set(targetCreatorIds);
  for (let index=0;index<targetCount;index+=1) {
    if (selected&&!selected.has(manifest.targets[index]?.creatorId)) continue;
    if(excludedCreatorIds.includes(manifest.targets[index]?.creatorId))continue;
    const entry=state.entries[index];
    if (!['in_flight','uncertain'].includes(entry.state)||!entry.attemptId) continue;
    if (!await ownerIdle({attemptId:entry.attemptId,target:manifest.targets[index],legacy:!entry.parallelLease})) continue;
    const target={...manifest.targets[index],sourceBatchId:manifest.sourceBatchId};
    let result=await readParallelNotWrittenAttempt({attemptsDir,target,attemptId:entry.attemptId});
    if (!result) result=await reconcileParallelFailureAttempt({attemptsDir,target,attemptId:entry.attemptId,client});
    if (!result) try { result=await adapter.reconcileOne({...target,attemptId:entry.attemptId,readOnly:true}); } catch {}
    state.entries[index]=normalizeCanaryResult(result,entry.attemptId,manifest.targets[index]);
    await persistCheckpoint(structuredClone(state));
    changed+=1;
  }
  return changed;
}

/** `sourceManifestPath` selects a private, digest-bound qualified source manifest; omission keeps the original-500 path. */
export async function runParallelProduction({targetCount=100,enableRun=false,retryErrors=false,resumeBlocked=false,
  pilotManifestPath,pilotManifest,pilotBatchSize,pilotWorkerLimit,fixedBatchCreatorIds,sourceManifestPath,shouldContinue,
  retryExclusionPath=DEFAULT_RETRY_EXCLUSION_PATH,
  dependencies:providedDependencies={}}={}) {
  if(fixedBatchCreatorIds!==undefined&&!pilotManifestPath&&!pilotManifest)
    return {state:'preflight_not_ready',reason:'PARALLEL_FIXED_BATCH_REQUIRES_COHORT'};
  if (sourceManifestPath!==undefined&&
      (typeof sourceManifestPath!=='string'||!sourceManifestPath.trim())) {
    return {state:'preflight_not_ready',reason:'PARALLEL_SOURCE_MANIFEST_PATH_INVALID',
      runRequired:!enableRun,runtimeReleaseVerified:false};
  }
  let runtimeRelease;
  try {
    runtimeRelease=await (providedDependencies.verifyRuntimeRelease||verifyKocRuntimeRelease)();
    if (runtimeRelease?.passed!==true) throw new Error('KOC_RUNTIME_RELEASE_VERIFICATION_FAILED');
  } catch (error) {
    return {state:'preflight_not_ready',reason:safeRuntimeReleaseReason(error),runRequired:!enableRun,
      runtimeReleaseVerified:false};
  }
  const defaults=await defaultDependencies();
  const dependencies={...defaults,...providedDependencies};
  const now=typeof dependencies.now==='function'?dependencies.now:Date.now;
  const stateDir=path.resolve(providedDependencies.stateDir||defaults.stateDir);
  const checkpointPath=path.resolve(providedDependencies.checkpointPath||path.join(stateDir,'checkpoint.json'));
  if (path.dirname(checkpointPath)!==stateDir) return {state:'preflight_not_ready',reason:'PARALLEL_CHECKPOINT_PATH_INVALID'};
  const checked=await preflight({targetCount,dependencies,sourceManifestPath});
  if (!checked.ready) return {state:'preflight_not_ready',reason:checked.reason,runRequired:!enableRun};
  if (!checked.builderReady) return {state:'runner_not_ready',reason:'PARALLEL_WAVE_BUILDER_NOT_READY'};
  if (!checked.templateReady) return {state:'runner_not_ready',reason:'PARALLEL_DETAIL_TEMPLATE_NOT_READY'};
  let retryExclusions;
  try {
    retryExclusions=await (dependencies.loadRetryExclusions||loadRetryExclusions)(
      {filePath:retryExclusionPath,manifest:checked.source.manifest});
  } catch(error) {
    return {state:'preflight_not_ready',reason:safeReason(error?.message,'RETRY_EXCLUSION_INVALID'),
      runRequired:!enableRun};
  }
  const excludedCreatorIds=retryExclusions.map(exclusion=>exclusion.creatorId);
  let cohort=null,pilotManifestSha256='';
  if (pilotManifestPath!==undefined||pilotManifest!==undefined) {
    if (pilotManifestPath!==undefined&&pilotManifest!==undefined) return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_MANIFEST_INVALID'};
    if (targetCount!==500) return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_REQUIRES_ORIGINAL_500'};
    try {
      let payload=pilotManifest;
      if (pilotManifestPath!==undefined) {
        const loaded=await readPilotManifest(pilotManifestPath);
        payload=loaded.manifest;pilotManifestSha256=loaded.sha256;
      } else {
        pilotManifestSha256=createHash('sha256').update(JSON.stringify(pilotManifest)).digest('hex');
      }
      cohort=validatePilotCohort(payload,checked.source.manifest);
    } catch (error) {
      return {state:'preflight_not_ready',reason:safeReason(error?.message,'PARALLEL_PILOT_MANIFEST_INVALID')};
    }
    if(!(Number.isInteger(pilotBatchSize)&&pilotBatchSize>0&&pilotBatchSize<50)&&
        cohort.targetCreatorIds.some(creatorId=>excludedCreatorIds.includes(creatorId))) {
      return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_CONTAINS_EXCLUDED_TARGET',
        runRequired:!enableRun,targetCount,cohortId:cohort.cohortId,cohortTargetCount:cohort.targetCreatorIds.length};
    }
    if ((pilotBatchSize!==undefined||pilotWorkerLimit!==undefined)&&
        (!Number.isInteger(pilotBatchSize)||pilotBatchSize<1||pilotBatchSize>50||
          ![1,2,5].includes(pilotWorkerLimit)||pilotBatchSize%pilotWorkerLimit!==0)) {
      return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_BATCH_INVALID',targetCount,
        cohortId:cohort.cohortId};
    }
    if(fixedBatchCreatorIds!==undefined){
      const laneMap=pilotLaneMap(checked.source.manifest,cohort.laneAssignments),counts=new Map();
      const valid=Array.isArray(fixedBatchCreatorIds)&&fixedBatchCreatorIds.length===pilotBatchSize&&
        new Set(fixedBatchCreatorIds).size===pilotBatchSize&&fixedBatchCreatorIds.every(id=>
          cohort.targetCreatorIds.includes(id)&&!excludedCreatorIds.includes(id));
      if(valid)for(const id of fixedBatchCreatorIds)counts.set(laneMap.get(id),(counts.get(laneMap.get(id))||0)+1);
      if(!valid||counts.size!==pilotWorkerLimit||[...counts.values()].some(n=>n!==pilotBatchSize/pilotWorkerLimit))
        return {state:'preflight_not_ready',reason:'PARALLEL_FIXED_BATCH_INVALID'};
    }
    const requiredPilotPages=pilotWorkerLimit??5;
    if (checked.eligiblePages.length<requiredPilotPages) return {state:'preflight_not_ready',
      reason:requiredPilotPages===5?'PARALLEL_FIVE_PAGE_COHORT_REQUIRED':
        requiredPilotPages===1?'PARALLEL_ONE_PAGE_TAIL_REQUIRED':'PARALLEL_TWO_PAGE_PILOT_REQUIRED',
      targetCount,cohortTargetCount:cohort.targetCreatorIds.length,eligibleHiddenPageCount:checked.eligiblePages.length,
      pagesNeeded:Math.max(0,requiredPilotPages-checked.eligiblePages.length),cohortId:cohort.cohortId};
  }
  const preflightPageRequirement=cohort&&pilotWorkerLimit===1?1:2;
  if (!enableRun) return {state:checked.eligiblePages.length>=preflightPageRequirement?'preflight_ready':'preflight_not_ready',
    ...(checked.eligiblePages.length>=preflightPageRequirement?{}:{reason:preflightPageRequirement===1
      ?'PARALLEL_ONE_PAGE_TAIL_REQUIRED':'PARALLEL_TWO_PAGE_PILOT_REQUIRED'}),
    runRequired:true,targetCount,sourceBatchId:ORIGINAL_BATCH_ID,sourceCount:checked.source.manifest.targets.length,
    authVerified:true,profile:FEISHU_ROUTE.profile,as:FEISHU_ROUTE.as,host:PARALLEL_FEISHU_HOST,
    schemaFieldCount:checked.schemaFieldCount,eligibleHiddenPageCount:checked.eligiblePages.length,
    pagesNeededForFive:Math.max(0,5-checked.eligiblePages.length),
    nicknameSourceRows:checked.sourceIndex.rows.filter(row=>typeof row.creatorName==='string'&&row.creatorName.trim()).length,
    waveBuilderReady:checked.builderReady,templateReady:checked.templateReady,
    runtimeRelease,
    ...(checked.qualifiedBaseIndex?{qualifiedBaseIndexVerified:true}:{}),
    ...(cohort?{cohortId:cohort.cohortId,cohortTargetCount:cohort.targetCreatorIds.length,
      cohortLaneCounts:cohort.laneCounts}: {})};
  const executionPageRequirement=cohort&&pilotWorkerLimit===1?1:2;
  if (checked.eligiblePages.length<executionPageRequirement) return {state:'preflight_not_ready',
    reason:executionPageRequirement===1?'PARALLEL_ONE_PAGE_TAIL_REQUIRED':'PARALLEL_TWO_PAGE_PILOT_REQUIRED',
    eligibleHiddenPageCount:checked.eligiblePages.length};

  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  const statePaths={stateDir,checkpointPath,queuePath:path.join(stateDir,'queue.json'),
    attemptsDir:path.join(stateDir,CONTACT_ATTEMPT_DIR),extraPath:path.join(stateDir,'extra-authorized-row.json')};
  const ownerToken=randomUUID();
  const productionLockPath=path.join(stateDir,'production.lock');
  const checkpointLockPath=`${checkpointPath}.lock`;
  let productionLock=null,checkpointLock=null,checkpointState=null,adapter=null;
  let pilotLedgerFile='',pilotLedger=null,cohortStartedAtMs,pilotLedgerWritten=false;
  let singleLaneResume=false,singleLaneBatchContinuation=false,batchTargetCreatorIds;
  let waveActive=false;
  const contextsByAttempt=new Map();
  const capturesByAttempt=new Map();
  const attemptMeta=new Map();
  const sourceRows=checked.sourceIndex.rows;
  const sourceNames=sourceNameMap(sourceRows);
  const manifest=checked.source.manifest;
  const createClient=dependencies.createClient||(()=>new AsyncReadLarkBaseClient({route:FEISHU_ROUTE}));
  const client=createClient();
  const authContext={verifiedUser:true,profile:FEISHU_ROUTE.profile,as:FEISHU_ROUTE.as,host:PARALLEL_FEISHU_HOST};
  const sourceVerifier=checked.sourceIndex.verifySourceMember;
  const currentVerifier=async({target,indexEntry})=>{
    if (!client||typeof client.getRecord!=='function') return false;
    const current=parseRecord(await client.getRecord(target.recordId,['Text','抖音号']));
    if (!current||current.recordId!==target.recordId) return false;
    const text=current.fields?.['抖音号'];
    const id=typeof text==='string'?text:String(text?.text??text?.value??'');
    return id.trim()===target.creatorId&&indexEntry.creatorId===target.creatorId&&indexEntry.recordId===target.recordId
      ?{verified:true,creatorId:target.creatorId,recordId:target.recordId,sourceBatchId:manifest.sourceBatchId,
        sourceRank:target.sourceRank}:false;
  };

  try {
    productionLock=await acquireLock(productionLockPath,ownerToken);
    await fs.mkdir(statePaths.attemptsDir,{recursive:true,mode:0o700});
    const checkpointMigration=checked.source.migration?{...checked.source.migration,
      sidecarPath:path.join(stateDir,`qualified-excluded-${checked.source.migration.sourceManifestSha256.slice(0,20)}.json`)}:null;
    await dependencies.prepareCheckpoint({manifest,targetCount,checkpointPath,initialResults:checked.source.initialResults||[],
      reviewedRecovery:checked.source.reviewedRecovery||null,migration:checkpointMigration});
    checkpointLock=await acquireLock(checkpointLockPath,ownerToken);
    checkpointState=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    adapter=dependencies.createProductionAdapter({stateDir,sourceStateDir:dependencies.sourceStateDir||DEFAULT_STATE_DIR,
      sourceManifestPath,sourceManifestSha256:checked.source.migration?.sourceManifestSha256});

    if (cohort) {
      const prior=await priorCohortClosure({cohort,pilotManifestPath,manifest,state:checkpointState,stateDir,retryExclusions});
      if (!prior.ready) return {state:'preflight_not_ready',reason:prior.reason,targetCount,
        cohortId:cohort.cohortId,cohortTargetCount:cohort.targetCreatorIds.length,
        ...(prior.priorCohortId?{priorCohortId:prior.priorCohortId}:{})};
    }

    const writeCheckpoint=async snapshot=>{
      if (!productionLock||!checkpointLock) throw new Error('PARALLEL_LOCK_OWNERSHIP_LOST');
      await writePrivateJson(checkpointPath,snapshot);
      await publishQueue(snapshot,'checkpoint');
    };
    async function publishQueue(state,event) {
      const extra=await readExtraState(statePaths.extraPath);
      const queue=makeQueueSnapshot({manifest,state,targetCount,extraRowState:extra.state});
      await writePrivateJson(statePaths.queuePath,{...queue,event});
    }
    const assertLockOwnership=async()=>{
      const [productionLockHeld,checkpointLockHeld]=await Promise.all([
        ownsLockFile(productionLockPath,productionLock,ownerToken),
        ownsLockFile(checkpointLockPath,checkpointLock,ownerToken),
      ]);
      return {productionLockHeld,checkpointLockHeld};
    };
    const ownerIsIdle=async()=>{
      if (waveActive) return false;
      const ownership=await assertLockOwnership();
      return ownership.productionLockHeld===true&&ownership.checkpointLockHeld===true;
    };
    const targetCreatorIds=cohort?.targetCreatorIds;
    await reconcileLegacyUnknowns({manifest,state:checkpointState,targetCount,targetCreatorIds,adapter,
      persistCheckpoint:writeCheckpoint,ownerIdle:ownerIsIdle,attemptsDir:statePaths.attemptsDir,client,
      excludedCreatorIds});

    if (targetCreatorIds) {
      const selectedIndexes=targetCreatorIds.map(id=>manifest.targets.findIndex(target=>target.creatorId===id));
      if (selectedIndexes.some(index=>index<0)) return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_TARGET_MAPPING_INVALID',
        targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      const selectedEntries=selectedIndexes.map(index=>checkpointState.entries[index]);
      if (selectedEntries.some(entry=>['uncertain','in_flight'].includes(entry.state))) {
        return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_TARGET_STATE_UNRESOLVED',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
      if (selectedEntries.some(entry=>entry.state==='error'&&!retryErrors||entry.state==='blocked'&&!resumeBlocked)) {
        return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_RETRY_FLAGS_REQUIRED',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
      singleLaneResume=selectedEntries.some(entry=>entry.state==='error'||entry.state==='blocked')&&
        selectedEntries.every(entry=>entry.state==='confirmed'||entry.state==='error'&&retryErrors||
          entry.state==='blocked'&&resumeBlocked);
      pilotLedgerFile=pilotLedgerPath(stateDir,cohort.cohortId);
      try { pilotLedger=await readPilotLedger(pilotLedgerFile); }
      catch (error) { return {state:'preflight_not_ready',reason:safeReason(error?.message,'PARALLEL_PILOT_LEDGER_INVALID'),
        targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length}; }
      if (pilotLedger&&(pilotLedger.cohortId!==cohort.cohortId||pilotLedger.manifestSha256!==pilotManifestSha256)) {
        return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_COHORT_CHANGED',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
      const mixedStartValid=cohort.recoveryAttempts&&retryErrors&&resumeBlocked&&
        selectedEntries.filter(e=>e.state==='pending').length===40&&cohort.recoveryAttempts.every(recovery=>{
          const entry=checkpointState.entries[manifest.targets.findIndex(t=>t.creatorId===recovery.creatorId)];
          return ['error','blocked'].includes(entry.state)&&entry.attemptId===recovery.attemptId;
        });
      if (!pilotLedger&&!mixedStartValid&&(cohort.recoveryAttempts||selectedEntries.some(entry=>entry.state!=='pending'))) {
        return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_COHORT_NOT_FRESH',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
      if (selectedEntries.every(entry=>entry.state==='confirmed')) {
        if (!pilotLedger) return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_COHORT_NOT_FRESH',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
        const previousGate=pilotLedger.performanceGate||{status:'unverified',passed:false,elapsedMs:0,
          limitMs:PARALLEL_PILOT_MAX_WALL_MS,targetCount:50,confirmedCount:50,readbackVerifiedCount:50,completed:true};
        const ledgerStartedAt=Number.isSafeInteger(pilotLedger.cohortStartedAtMs)?pilotLedger.cohortStartedAtMs:now();
        const gateNeedsRefresh=previousGate.completed!==true||previousGate.confirmedCount!==50||previousGate.readbackVerifiedCount!==50;
        const existingGate=gateNeedsRefresh?pilotPerformanceGate({entries:selectedEntries,cohortStartedAtMs:ledgerStartedAt,
          nowMs:now(),previousGate}):previousGate;
        if (pilotLedger.state!=='complete'||pilotLedger.schemaVersion!==2||gateNeedsRefresh) await writePilotLedger(pilotLedgerFile,{cohortId:cohort.cohortId,
          manifestSha256:pilotManifestSha256,state:'complete',cohortStartedAtMs:ledgerStartedAt,performanceGate:existingGate});
        await publishQueue(checkpointState,'pilot_cohort_complete');
        const state=existingGate.status==='failed'?'pilot_performance_failed':
          existingGate.status==='passed'?'cohort_already_complete':'pilot_performance_unverified';
        return {state,...(state==='pilot_performance_failed'?{reason:'PARALLEL_COHORT_EXCEEDED_10_MINUTES'}:{}),
          targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length,
          confirmedCount:selectedEntries.length,performanceGate:existingGate};
      }
      if (pilotLedger?.state==='complete') return {state:'preflight_not_ready',
        reason:'PARALLEL_PILOT_LEDGER_CHECKPOINT_MISMATCH',targetCount,cohortId:cohort.cohortId,
        cohortTargetCount:targetCreatorIds.length};
      if (pilotLedger?.schemaVersion===1&&selectedEntries.some(entry=>entry.state!=='pending')) {
        return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_TIMING_HISTORY_MISSING',targetCount,
          cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
      if (pilotBatchSize!==undefined) {
        const activeLanes=planParallelShards({manifest,state:checkpointState,targetCount,retryErrors,resumeBlocked,
          targetCreatorIds,retryExclusions,laneAssignments:cohort.laneAssignments}).filter(shard=>shard.targets.length>0);
        if (activeLanes.length===1&&pilotWorkerLimit!==1) return {state:'preflight_not_ready',
          reason:'PARALLEL_PILOT_SINGLE_LANE_TAIL_REQUIRED',targetCount,cohortId:cohort.cohortId,
          cohortTargetCount:targetCreatorIds.length};
        if (pilotWorkerLimit===1) {
          if (!pilotLedger||selectedEntries.every(entry=>entry.state==='pending')||activeLanes.length!==1) {
            return {state:'preflight_not_ready',reason:'PARALLEL_PILOT_SINGLE_LANE_TAIL_REQUIRED',targetCount,
              cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
          }
          singleLaneBatchContinuation=true;
        }
      }
      cohortStartedAtMs=pilotLedger?.schemaVersion===2?pilotLedger.cohortStartedAtMs:now();
      if (!pilotLedger) {
        try {
          pilotLedger=await readPilotLedger(pilotLedgerFile);
          if (pilotLedger) throw new Error('PARALLEL_PILOT_COHORT_CHANGED');
          await writePilotLedger(pilotLedgerFile,{cohortId:cohort.cohortId,
            manifestSha256:pilotManifestSha256,state:'running',cohortStartedAtMs});
          pilotLedger={schemaVersion:2,cohortId:cohort.cohortId,manifestSha256:pilotManifestSha256,state:'running',
            cohortStartedAtMs,performanceGate:null};
        } catch (error) {
          return {state:'preflight_not_ready',reason:safeReason(error?.message,'PARALLEL_PILOT_LEDGER_WRITE_FAILED'),
            targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
        }
      } else if (pilotLedger.schemaVersion===1) {
        try {
          await writePilotLedger(pilotLedgerFile,{cohortId:cohort.cohortId,manifestSha256:pilotManifestSha256,
            state:pilotLedger.state,cohortStartedAtMs,performanceGate:null});
          pilotLedger={...pilotLedger,schemaVersion:2,cohortStartedAtMs,performanceGate:null};
        } catch (error) {
          return {state:'preflight_not_ready',reason:safeReason(error?.message,'PARALLEL_PILOT_LEDGER_WRITE_FAILED'),
            targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
        }
      }
      if (pilotBatchSize!==undefined) {
        try { batchTargetCreatorIds=fixedBatchCreatorIds?[...fixedBatchCreatorIds]:selectPilotBatchTargets({cohort,manifest,state:checkpointState,
          batchSize:pilotBatchSize,workerLimit:pilotWorkerLimit,retryErrors,resumeBlocked,retryExclusions}); }
        catch (error) { return {state:'preflight_not_ready',reason:safeReason(error?.message,'PARALLEL_PILOT_BATCH_INVALID'),
          targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length}; }
        if (!batchTargetCreatorIds.length) return {state:'pilot_unavailable',reason:'PARALLEL_PILOT_BATCH_EMPTY',
          targetCount,cohortId:cohort.cohortId,cohortTargetCount:targetCreatorIds.length};
      }
    }

    const workerTargetCreatorIds=batchTargetCreatorIds??targetCreatorIds;
    const plan=chooseWorkers({manifest,state:checkpointState,targetCount,retryErrors,resumeBlocked,laneAssignments:cohort?.laneAssignments,
      eligiblePages:checked.eligiblePages,targetCreatorIds:workerTargetCreatorIds,retryExclusions,
      singleLaneResume:singleLaneResume&&!singleLaneBatchContinuation,
      singleLaneBatchContinuation,
      workerLimit:pilotWorkerLimit});
    const minimumWorkerCount=singleLaneResume||singleLaneBatchContinuation?1:2;
    if (plan.workers.length<minimumWorkerCount) return {state:'pilot_unavailable',reason:plan.reason,targetCount,
      ...(cohort?{cohortId:cohort.cohortId,cohortTargetCount:cohort.targetCreatorIds.length}:{})};
    const workerByLane=new Map(plan.workers.map(worker=>[worker.laneIndex,worker]));
    const captureOneWave=async({claims})=>{
      waveActive=true;
      const prepared=[];
      const failures=new Map();
      try {
        await Promise.all(claims.map(async claim => {
          const startedAt=new Date().toISOString();
          attemptMeta.set(claim.attemptId,{startedAt,claim});
          try { await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim,record:{startedAt,state:'preparing'}}); }
          catch {
            failures.set(claim.attemptId,'PARALLEL_ATTEMPT_PERSIST_FAILED');
            return;
          }
          try {
            const request={...claim.target,sourceBatchId:manifest.sourceBatchId,attemptId:claim.attemptId};
            const context=await dependencies.prepareWriteContext(request,{manifest,authContext,schema:checked.schema,
              client,verifySourceMember:sourceVerifier,verifyCurrentMember:currentVerifier,
              allowExistingWeChatReverify:true});
            contextsByAttempt.set(claim.attemptId,context);
            await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim,record:{startedAt,state:'context_prepared'}});
            const worker=workerByLane.get(claim.laneIndex);
            if (!worker||worker.pageBindingId!==claim.pageBindingId) throw new Error('PARALLEL_WORKER_PAGE_BINDING_INVALID');
            const source=sourceNames.get(claim.target.creatorId);
            prepared.push({claim,context,worker,creatorName:source?.sourceRank===claim.target.sourceRank?source.creatorName:''});
          } catch (error) {
            contextsByAttempt.delete(claim.attemptId);
            const reason=safeReason(error?.message,'PARALLEL_TARGET_PREFLIGHT_FAILED');
            failures.set(claim.attemptId,reason);
            await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim,
              record:{startedAt,state:'preflight_failed',result:{attemptId:claim.attemptId,outcome:'error',
                writeState:'not_written',reason,preWritePerformed:true,writerInvoked:false}}});
          }
        }));
        const claimOrder=new Map(claims.map((claim,index)=>[claim.attemptId,index]));
        prepared.sort((a,b)=>claimOrder.get(a.claim.attemptId)-claimOrder.get(b.claim.attemptId));
        let outputWorkers=[],waveResponse=null,wavePayloadState='not_attempted',sentDescriptors=[];
        if (prepared.length) {
          const descriptors=prepared.map(({claim,worker,creatorName})=>({workerId:claim.workerId,
            laneIndex:claim.laneIndex,pageIndex:worker.pageIndex,creatorId:claim.target.creatorId,
            creatorName,recordId:claim.target.recordId,sourceBatchId:manifest.sourceBatchId,
            sourceRank:claim.target.sourceRank,attemptId:claim.attemptId}));
          let code;
          try { code=await checked.waveBuilder({workers:descriptors,detailTemplate:checked.template,
            accountMarker:PARALLEL_ACCOUNT_MARKER}); } catch { code=''; }
          if (typeof code==='string'&&code.length>0) {
            sentDescriptors=descriptors;
            waveResponse=await dependencies.invokeWaveCli({code,session:ORIGINAL_BACKGROUND_SESSION,timeoutMs:180000});
            if (waveResponse?.timedOut!==true&&waveResponse?.overflow!==true&&waveResponse?.status===0) {
              const hasResult=Object.hasOwn(waveResponse,'result');
              const parsedResult=hasResult?{parsed:true,value:waveResponse.result}:
                parseJsonOutputWithStatus(waveResponse?.stdout);
              if (Array.isArray(parsedResult.value?.workers)) {
                outputWorkers=parsedResult.value.workers;
                wavePayloadState='workers_array';
              } else wavePayloadState=parsedResult.parsed?'workers_missing':'unparsed';
            }
          }
        }
        const waveDiagnostics=waveExecutionDiagnostics({response:waveResponse,payloadState:wavePayloadState,
          descriptors:sentDescriptors,workers:outputWorkers});
        const byAttempt=new Map();
        for (const worker of outputWorkers) {
          if (!worker||typeof worker.attemptId!=='string'||byAttempt.has(worker.attemptId)) continue;
          byAttempt.set(worker.attemptId,worker);
        }
        const preparedByAttempt=new Map(prepared.map(item=>[item.claim.attemptId,item]));
        const rows=[];
        for (const claim of claims) {
          const prepFailure=failures.get(claim.attemptId);
          if (prepFailure) {
            rows.push({workerId:claim.workerId,laneIndex:claim.laneIndex,attemptId:claim.attemptId,
              creatorId:claim.target.creatorId,recordId:claim.target.recordId,sourceBatchId:manifest.sourceBatchId,
              sourceRank:claim.target.sourceRank,preflightFailure:true,outcome:'error',writeState:'not_written',
              reason:prepFailure});
            continue;
          }
          const {context}=preparedByAttempt.get(claim.attemptId)||{};
          const worker=byAttempt.get(claim.attemptId);
          if (!worker) {
            contextsByAttempt.delete(claim.attemptId);
            rows.push({workerId:claim.workerId,laneIndex:claim.laneIndex,attemptId:claim.attemptId,
              creatorId:claim.target.creatorId,recordId:claim.target.recordId,sourceBatchId:manifest.sourceBatchId,
              sourceRank:claim.target.sourceRank,outcome:'error',writeState:'not_written',
              reason:'PARALLEL_CAPTURE_RESULT_INVALID',pageGuardPassed:false});
            await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim,
              record:{startedAt:attemptMeta.get(claim.attemptId)?.startedAt,state:'capture_result_invalid',
                result:{attemptId:claim.attemptId,outcome:'error',writeState:'not_written',
                  reason:'PARALLEL_CAPTURE_RESULT_INVALID',writerInvoked:false},
                receipt:safeAttemptReceipt({waveExecutionDiagnostics:waveDiagnostics})}});
            continue;
          }
          const raw=rawWorkerResult({worker,claim,context});
          rows.push(raw);
          if (raw.writeIntent) capturesByAttempt.set(claim.attemptId,raw.writeIntent);
          if (raw.writeIntent===undefined) {
            contextsByAttempt.delete(claim.attemptId);
            await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim,
              record:{startedAt:attemptMeta.get(claim.attemptId)?.startedAt,state:'capture_rejected',
                result:{attemptId:claim.attemptId,outcome:'error',writeState:'not_written',
                  reason:safeReason(raw.reason,'PARALLEL_CAPTURE_RESULT_INVALID'),writerInvoked:false},
                ...(raw.captureDiagnostics?{receipt:projectCaptureExecutionDiagnostics(raw.captureDiagnostics)}:{})}});
          }
        }
        for (const worker of outputWorkers) if (worker?.attempt&&typeof worker.attempt==='object') {
          for (const key of ['contactValue','contactSourceUrl','sourceURL']) try { worker.attempt[key]=''; } catch {}
        }
        return rows;
      } catch {
        for (const claim of claims) contextsByAttempt.delete(claim.attemptId);
        throw new Error('PARALLEL_CAPTURE_WAVE_FAILED');
      } finally {
        waveActive=false;
      }
    };

    const reconcileOne=async({target,attemptId,readOnly=true}={})=>{
      if (!adapter||typeof adapter.reconcileOne!=='function'||readOnly!==true) return null;
      const knownNotWritten=await readParallelNotWrittenAttempt({attemptsDir:statePaths.attemptsDir,
        target:{...target,sourceBatchId:manifest.sourceBatchId},attemptId});
      if (knownNotWritten) return knownNotWritten;
      const verifiedFailure=await reconcileParallelFailureAttempt({attemptsDir:statePaths.attemptsDir,
        target:{...target,sourceBatchId:manifest.sourceBatchId},attemptId,client});
      if(verifiedFailure)return verifiedFailure;
      try { return await adapter.reconcileOne({...target,sourceBatchId:manifest.sourceBatchId,attemptId,readOnly:true}); }
      catch { return null; }
    };
    const commitOne=async({target,attemptId,workerId,laneId,writeIntent}={})=>{
      const context=contextsByAttempt.get(attemptId);
      contextsByAttempt.delete(attemptId);
      capturesByAttempt.delete(attemptId);
      if (!context||!writeIntent) {
        clearAttempt(writeIntent);
        return {attemptId,outcome:'error',writeState:'not_written',reason:'PARALLEL_CONTEXT_UNAVAILABLE',
          recordMappingVerified:false,originalAttemptSourceVerified:false,protectedFieldsUnchanged:false};
      }
      let committed;
      try { committed=await dependencies.commitCapturedAttempt(context,writeIntent); }
      catch {
        clearAttempt(writeIntent);
        const result={attemptId,outcome:'error',writeState:'uncertain',reason:'PARALLEL_WRITE_OUTCOME_UNKNOWN',
          recordMappingVerified:true,originalAttemptSourceVerified:true,protectedFieldsUnchanged:false};
        const meta=attemptMeta.get(attemptId);
        await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim:{target,attemptId,workerId},
          record:{startedAt:meta?.startedAt,state:'write_outcome_unknown',finishedAt:new Date().toISOString(),
            result:safeResultForDisk(result,attemptId),receipt:null}});
        return result;
      } finally { clearAttempt(writeIntent); }
      const result=committed?.result||{attemptId,outcome:'error',writeState:'uncertain',reason:'PARALLEL_WRITE_OUTCOME_UNKNOWN'};
      const safeResult=safeResultForDisk(result,attemptId);
      const meta=attemptMeta.get(attemptId);
      await writeAttemptRecord({attemptsDir:statePaths.attemptsDir,claim:{target,attemptId,workerId},
        record:{startedAt:meta?.startedAt,state:'write_finished',finishedAt:new Date().toISOString(),
          result:safeResult,receipt:safeAttemptReceipt(committed?.receipt)}});
      attemptMeta.delete(attemptId);
      return result;
    };

    const report=await runParallelBatch({manifest,checkpointState,targetCount,workers:plan.workers,targetCreatorIds,
      batchTargetCreatorIds,laneAssignments:cohort?.laneAssignments,
      runPageWave:captureOneWave,commitOne,reconcileOne,persistCheckpoint:writeCheckpoint,
      ownerIsIdle,assertLockOwnership,initialLaneCount:cohort?.laneAssignments&&plan.workers.length===5?5:2,autoScaleToFive:plan.autoScaleToFive,
      completeBatchAtCurrentWorkers:pilotBatchSize!==undefined&&!plan.autoScaleToFive&&[1,2].includes(pilotWorkerLimit),
      retryErrors,resumeBlocked,retryExclusions,singleLaneKnownFailureResume:plan.singleLaneResume===true,
      singleLaneBatchContinuation:plan.singleLaneBatchContinuation===true,cohortStartedAtMs,
      performanceLimitMs:cohort&&!cohort.targetCreatorIds.some(id=>excludedCreatorIds.includes(id))
        ?PARALLEL_PILOT_MAX_WALL_MS:undefined,
      shouldContinue:async context=>!shouldContinue||await shouldContinue(context)!==false,now,
      onProgress:async progress=>{
        const fresh=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
        await publishQueue(fresh,progress.phase||'progress');
        for (const capture of capturesByAttempt.values()) clearAttempt(capture);
        capturesByAttempt.clear();
      }});
    const safe=safeParallelReport({...report,...(cohort?{cohortId:cohort.cohortId,
      cohortTargetCount:cohort.targetCreatorIds.length,pilotManifestSha256}:{})});
    const finalState=JSON.parse(await fs.readFile(checkpointPath,'utf8'));
    await publishQueue(finalState,safe.state);
    if (cohort&&pilotLedgerFile) {
      const selectedEntries=cohort.targetCreatorIds.map(id=>finalState.entries[
        manifest.targets.findIndex(target=>target.creatorId===id)]);
      const ledgerState=selectedEntries.length===50&&selectedEntries.every(entry=>entry.state==='confirmed')
        ?'complete':'partial';
      const gate=report.cohort?.performanceGate;
      const performanceGate=pilotPerformanceGate({entries:selectedEntries,cohortStartedAtMs,
        nowMs:now(),reportedGate:gate,previousGate:pilotLedger?.performanceGate});
      await writePilotLedger(pilotLedgerFile,{cohortId:cohort.cohortId,manifestSha256:pilotManifestSha256,
        state:ledgerState,cohortStartedAtMs,performanceGate});
      pilotLedgerWritten=true;
      safe.cohort={...(safe.cohort||{}),performanceGate};
    }
    return {...safe,runtimeRelease};
  } finally {
    for (const capture of capturesByAttempt.values()) clearAttempt(capture);
    capturesByAttempt.clear();contextsByAttempt.clear();attemptMeta.clear();
    if(!pilotLedgerWritten&&cohort&&pilotLedgerFile&&Number.isSafeInteger(cohortStartedAtMs)&&
        productionLock&&checkpointLock) {
      try {
        const ownership=await Promise.all([ownsLockFile(productionLockPath,productionLock,ownerToken),
          ownsLockFile(checkpointLockPath,checkpointLock,ownerToken)]);
        if(ownership.every(Boolean)) {
          let finalCheckpoint=checkpointState;
          try { finalCheckpoint=JSON.parse(await fs.readFile(checkpointPath,'utf8')); } catch {}
          if(Array.isArray(finalCheckpoint?.entries)) {
            const selectedEntries=cohort.targetCreatorIds.map(id=>{
              const index=manifest.targets.findIndex(target=>target.creatorId===id);
              return index<0?null:finalCheckpoint.entries[index];
            });
            if(selectedEntries.length===50&&selectedEntries.every(isObject)) {
              let nowMs;
              try { nowMs=now(); } catch { nowMs=Date.now(); }
              if(!Number.isFinite(nowMs))nowMs=Date.now();
              const performanceGate=pilotPerformanceGate({entries:selectedEntries,cohortStartedAtMs,nowMs,
                previousGate:pilotLedger?.performanceGate});
              const ledgerState=selectedEntries.every(entry=>entry.state==='confirmed')?'complete':'partial';
              await writePilotLedger(pilotLedgerFile,{cohortId:cohort.cohortId,manifestSha256:pilotManifestSha256,
                state:ledgerState,cohortStartedAtMs,performanceGate});
              pilotLedgerWritten=true;
            }
          }
        }
      } catch { /* Preserve the original return/exception; the fallback never releases another owner's lock. */ }
    }
    await releaseLock(checkpointLockPath,checkpointLock,ownerToken);
    await releaseLock(productionLockPath,productionLock,ownerToken);
  }
}

async function readExtraState(file) {
  try {
    const data=JSON.parse(await fs.readFile(file,'utf8'));
    if (data.creatorId==='LEGACY_EXTRA_DISABLED'&&data.recordId==='LEGACY_RECORD_DISABLED') {
      return {state:safeEnum(data.state,new Set(['pending','in_flight','confirmed','error','blocked','uncertain']),'unknown')};
    }
  } catch {}
  return {state:'pending'};
}

if (process.argv[1]&&path.resolve(process.argv[1])===ENTRY_FILE) {
  let stopRequested=false;
  process.on('SIGUSR1',()=>{stopRequested=true;});
  const args=process.argv.slice(2);
  const targetArg=args.find(arg=>arg.startsWith('--target='));
  const pilotManifestArg=args.find(arg=>arg.startsWith('--pilot-manifest='));
  const pilotBatchArgs=args.filter(arg=>arg==='--pilot-batch-size'||arg.startsWith('--pilot-batch-size='));
  const pilotWorkerArgs=args.filter(arg=>arg==='--pilot-worker-limit'||arg.startsWith('--pilot-worker-limit='));
  const pilotBatchSize=pilotBatchArgs.length===1&&pilotBatchArgs[0].includes('=')
    ?Number(pilotBatchArgs[0].split('=').slice(1).join('=')):pilotBatchArgs.length?Number.NaN:undefined;
  const pilotWorkerLimit=pilotWorkerArgs.length===1&&pilotWorkerArgs[0].includes('=')
    ?Number(pilotWorkerArgs[0].split('=').slice(1).join('=')):pilotWorkerArgs.length?Number.NaN:undefined;
  // `--source-manifest=<path>` opts into digest-verified qualified migration; omission keeps the original 500.
  // An explicit but empty, bare, or repeated option is invalid and must not select the legacy queue.
  const sourceManifestArgs=args.filter(arg=>arg==='--source-manifest'||arg.startsWith('--source-manifest='));
  const sourceManifestPath=sourceManifestArgs.length===0?undefined:
    sourceManifestArgs.length===1&&sourceManifestArgs[0].startsWith('--source-manifest=')
      ?sourceManifestArgs[0].slice('--source-manifest='.length):'';
  runParallelProduction({targetCount:targetArg?Number(targetArg.split('=')[1]):100,
    enableRun:args.includes('--run'),retryErrors:args.includes('--retry-errors'),
    resumeBlocked:args.includes('--resume-blocked'),
    pilotManifestPath:pilotManifestArg?pilotManifestArg.slice('--pilot-manifest='.length):undefined,
    pilotBatchSize,pilotWorkerLimit,
    sourceManifestPath,
    shouldContinue:()=>!stopRequested})
    .then(result=>process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error=>{
      process.stdout.write(`${JSON.stringify({state:'runner_failed',reason:safeReason(error?.message,'PARALLEL_RUN_FAILED')})}\n`);
      process.exitCode=1;
    });
}
