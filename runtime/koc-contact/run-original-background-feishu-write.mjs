import {BUYIN_ACCOUNT_MARKER} from '../shared/config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from '../shared/child-process.mjs';
import {fileURLToPath} from 'node:url';
import {DEFAULT_STATE_DIR, writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {classifyRankedRows, formatLarkDateTime, normalizeText, ROSTER_SCOPE_KEY} from '../koc-roster/roster-domain.mjs';
import {FEISHU_ROUTE, LarkBaseClient, findRosterRecordByCreatorId, listRosterIndex, patchContactRecord} from '../koc-roster/lark-writer.mjs';
import {formatContactFailureNote, patchCurrentContactAttempt} from './contact-patch-adapter.mjs';
import {ORIGINAL_BACKGROUND_SESSION, REVEAL_RECOVERY_CREATOR_ID, DEFAULT_DETAIL_TEMPLATE, persistencePreflightFromConfigPrintResult,
  runOriginalBackgroundContact} from './buyin-original-background-driver.mjs';
import {safeResponseEvidence, safeSearchDiagnostics, safeRevealDiagnostics, safeChannelDiagnostics, safeGuardDiagnostics,
  safeWorkerIdentityProof}
  from './buyin-contact-flow.mjs';

const DEFAULT_CREATOR_ID='';
const DEFAULT_EXPECTED_RECORD_ID='';
export const EXPLICIT_EXTRA_ROW=Object.freeze({creatorId:'LEGACY_EXTRA_DISABLED',recordId:'LEGACY_RECORD_DISABLED'});
const CREATOR_ID=String(process.env.KOC_CREATOR_ID||DEFAULT_CREATOR_ID).trim();
const EXPECTED_RECORD_ID=String(process.env.KOC_EXPECTED_RECORD_ID||
  (CREATOR_ID===DEFAULT_CREATOR_ID?DEFAULT_EXPECTED_RECORD_ID:'')).trim();
const EXTRA_ROW_CREATOR_ID=String(process.env.KOC_EXTRA_ROW_CREATOR_ID||'').trim();
const EXTRA_ROW_RECORD_ID=String(process.env.KOC_EXTRA_ROW_RECORD_ID||'').trim();
const ALLOW_EXISTING_WECHAT_REVERIFY=process.env.KOC_ALLOW_EXISTING_WECHAT_REVERIFY==='1';
const SOURCE_BATCH_ID=String(process.env.KOC_SOURCE_BATCH_ID||'').trim();
const EXPECTED_SOURCE_RANK=Number.isInteger(Number(process.env.KOC_EXPECTED_SOURCE_RANK))&&
  String(process.env.KOC_EXPECTED_SOURCE_RANK||'').trim()?Number(process.env.KOC_EXPECTED_SOURCE_RANK):
    CREATOR_ID===DEFAULT_CREATOR_ID?8:null;
const QUALIFIED_SOURCE_MANIFEST_PATH=String(process.env.KOC_QUALIFIED_SOURCE_MANIFEST||'').trim();
const QUALIFIED_SOURCE_MANIFEST_SHA256=String(process.env.KOC_QUALIFIED_SOURCE_MANIFEST_SHA256||'').trim();
const REVEAL_RECOVERY_PHASE=String(process.env.KOC_REVEAL_RECOVERY_PHASE||'single').trim();
const REVEAL_RECOVERY_OPERATION_ID=String(process.env.KOC_REVEAL_RECOVERY_OPERATION_ID||'').trim();
const REVEAL_RECOVERY_EXECUTION_ID=String(process.env.KOC_REVEAL_RECOVERY_EXECUTION_ID||'').trim();
const REVEAL_RECOVERY_PARENT_ATTEMPT_ID=String(process.env.KOC_REVEAL_RECOVERY_PARENT_ATTEMPT_ID||'').trim();
const REVEAL_RECOVERY_PRIOR_RECEIPT_PATH=String(process.env.KOC_REVEAL_RECOVERY_PRIOR_RECEIPT_PATH||'').trim();
const EXECUTION_OPERATION_ID=String(process.env.KOC_EXECUTION_OPERATION_ID||'').trim();
const SEARCH_ATTEMPT_LIMIT=Number(process.env.KOC_SEARCH_ATTEMPT_LIMIT??3);
const REVEAL_OBSERVATION_WINDOW_MS=Number(process.env.KOC_REVEAL_OBSERVATION_WINDOW_MS??5000);
const PRIVATE_TEMPLATE_PATH='';
export async function loadDetailTemplate({templatePath=PRIVATE_TEMPLATE_PATH,readFileFn=fs.readFile}={}){
  if(!templatePath)return DEFAULT_DETAIL_TEMPLATE;
  let value;
  try{value=(await readFileFn(templatePath,'utf8')).trim();}
  catch(error){
    if(error?.code==='ENOENT')return DEFAULT_DETAIL_TEMPLATE;
    throw new Error('B2_DETAIL_TEMPLATE_UNAVAILABLE');
  }
  if(!value)throw new Error('B2_DETAIL_TEMPLATE_INVALID');
  return value;
}
const CONTACT_FIELDS=new Set([
  '微信号','本次联系方式状态','联系方式最近尝试','联系方式最近成功','联系方式最近错误','联系方式来源',
]);
const PRESERVE_ON_FAILURE=['微信号','联系方式最近成功','联系方式来源'];
const DATETIME_FIELDS=new Set(['联系方式最近尝试','联系方式最近成功']);
const TEXT_COMPARISON_FIELDS=new Set(['抖音号','微信号','本次联系方式状态','联系方式最近错误','联系方式来源',
  '商务跟进状态','商务备注','抖音检索词']);
const SAFE_WRITER_ERROR_CODES=new Set(['KOC_CONTACT_CREATOR_AND_RECORD_ID_REQUIRED','KOC_CONTACT_RECORD_CREATOR_MISMATCH',
  'KOC_CONTACT_FIELD_NOT_ALLOWED','KOC_CONTACT_SOURCE_INVALID','KOC_CONTACT_SOURCE_REQUIRED',
  'KOC_CONTACT_VERIFIED_VALUE_REQUIRED','KOC_CREATOR_WRITE_LOCK_TIMEOUT','LARK_CLI_FAILED',
  'LARK_EMPTY_RESPONSE','LARK_RESPONSE_NOT_JSON','LARK_READBACK_MISMATCH',
  'LARK_JSON_TRANSPORT_ARGUMENT_INVALID','LARK_JSON_TRANSPORT_BODY_INVALID',
  'LARK_JSON_TRANSPORT_TEMP_PARENT_UNSAFE','LARK_JSON_TRANSPORT_TEMP_UNSAFE',
  'LARK_JSON_TRANSPORT_FILE_UNSAFE','LARK_JSON_TRANSPORT_COMMAND_FAILED',
  'LARK_JSON_TRANSPORT_PROJECTION_FAILED','LARK_JSON_TRANSPORT_PROJECTION_INVALID',
  'LARK_JSON_TRANSPORT_PROJECTION_LOGGED','LARK_JSON_TRANSPORT_PROJECTION_UNSAFE',
  'LARK_JSON_TRANSPORT_CLEANUP_FAILED',
  'B2_WRITER_TARGET_MISMATCH','B2_FAILURE_PATCH_SCOPE_MISMATCH',
  'B2_PROTECTED_FIELDS_CHANGED_BEFORE_FAILURE_WRITE','B2_PRIOR_CONTACT_CHANGED_BEFORE_FAILURE_WRITE',
  'B2_PRIOR_CONTACT_CHANGED_BEFORE_SUCCESS_WRITE',
  'B2_FAILURE_READBACK_UNVERIFIED','B2_RECORD_PROJECTION_INVALID','B2_RECORD_ID_READBACK_MISMATCH',
  'B2_CREATOR_ID_READBACK_MISMATCH']);
const AUTH_REASON_STATUS=new Map([
  ['CONTACT_CATEGORY_RESTRICTED','forbidden_by_platform'],
  ['AUTH_REQUIRED','login_required'],['AUTH_EXPIRED','login_required'],
  ['MENU_PERMISSION_DENIED','login_required'],
  ['SECURITY_CHALLENGE','captcha'],['TARGET_NOT_FOUND','not_found'],['WECHAT_NOT_PROVIDED','not_shown'],
  ['CONTACT_NOT_SHOWN','not_shown'],['CONTACT_LABEL_NOT_PRESENT','not_shown'],
]);
const SAFE_REASON_CODES=new Set([
  'AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED','RESPONSE_EVIDENCE_INCOMPLETE',
  'RESPONSE_ERROR_UNCLASSIFIED','MENU_PERMISSION_DENIED',
  'SECURITY_CHALLENGE','TARGET_SEARCH_UNVERIFIED','TARGET_SEARCH_AMBIGUOUS','CONTACT_MARKER_UNRESOLVED',
  'CONTACT_LABEL_NOT_PRESENT','CONTACT_NOT_SHOWN','CONTACT_CATEGORY_RESTRICTED','WECHAT_NOT_PROVIDED','TARGET_NOT_FOUND','WECHAT_ROW_NOT_READY','DETAIL_LINK_NOT_VERIFIED',
  'DETAIL_NOT_OPENED','TARGET_PAGE_AMBIGUOUS','WECHAT_ROW_NOT_UNIQUE','REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE',
  'REVEAL_UNCONFIRMED','BACKGROUND_GUARD_FAILED','EXECUTION_CONTEXT_CHANGED','TARGET_PAGE_CLOSED',
  'REVEAL_RECOVERY_REFRESH_UNAVAILABLE',
  'PAGE_NOT_READY','B2_REVEAL_RECOVERY_PRIOR_RECEIPT_INVALID','B2_REVEAL_RECOVERY_CONTINUATION_NOT_RESERVED',
  'REVEAL_LISTENER_INSTALL_FAILED','REVEAL_LISTENER_CLEANUP_FAILED',
  'BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
  'BROWSER_ERROR','BROWSER_CLOSE_FAILED','CONTACT_PATCH_FAILED','CONTACT_PATCH_READBACK_FAILED',
  'CONTACT_VALUE_VERIFIED','CONTACT_VALUE_MISSING','INVALID_ARGUMENTS','INVALID_DETAIL_TEMPLATE',
]);
let currentPhase='auth';
let authPreflightSummary=null;

function parseJsonOutput(output) {
  const text=String(output||'').trim();
  try{return JSON.parse(text);}catch{}
  const result=text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/u)?.[1]?.trim();
  if(result){try{return JSON.parse(result);}catch{}}
  for(const line of text.split(/\r?\n/u).reverse())try{return JSON.parse(line);}catch{}
  return null;
}

function findVerifiedUser(payload) {
  const queue=[payload];
  const visited=new Set();
  while(queue.length){
    const value=queue.shift();
    if(!value||typeof value!=='object'||visited.has(value))continue;
    visited.add(value);
    if(!Array.isArray(value)&&value.verified===true&&String(value.identity||'').toLowerCase()==='user')return true;
    for(const child of Array.isArray(value)?value:Object.values(value))if(child&&typeof child==='object')queue.push(child);
  }
  return false;
}

function canonical(value) {
  if(value===undefined||value===null)return null;
  if(Array.isArray(value))return value.map(canonical);
  if(typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}

export function sameCell(field,left,right) {
  if(field==='本次联系方式状态'){
    const a=exactTextCellValue(left), b=exactTextCellValue(right);
    return a!==null&&b!==null&&a===b;
  }
  if(DATETIME_FIELDS.has(field)){
    const normalizeDate=value=>{
      if(value===null||value===undefined||value==='')return '';
      let input=value;
      for(let depth=0;depth<6;depth++){
        if(Array.isArray(input)){
          if(input.length===0)return '';
          if(input.length!==1)return null;
          input=input[0];continue;
        }
        if(input&&typeof input==='object'){
          if('value'in input){input=input.value;continue;}
          if('timestamp'in input){input=input.timestamp;continue;}
          if('date'in input){input=input.date;continue;}
          return null;
        }
        break;
      }
      if(input===null||input===undefined||input==='')return '';
      if(typeof input==='string'){
        const trimmed=input.trim();
        if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(trimmed))input=`${trimmed.replace(' ','T')}:00+08:00`;
        else if(/^\d+$/u.test(trimmed))input=Number(trimmed);
      }
      const date=new Date(input);
      return Number.isFinite(date.getTime())?formatLarkDateTime(date):null;
    };
    const normalizedLeft=normalizeDate(left);
    const normalizedRight=normalizeDate(right);
    return normalizedLeft!==null&&normalizedRight!==null&&normalizedLeft===normalizedRight;
  }
  if(TEXT_COMPARISON_FIELDS.has(field)){
    const normalizeTextCell=value=>{
      const text=textCell(value);
      if(field!=='联系方式来源')return text;
      const markdown=text.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/u);
      return markdown?markdown[1]:text;
    };
    return normalizeTextCell(left)===normalizeTextCell(right);
  }
  return JSON.stringify(canonical(left))===JSON.stringify(canonical(right));
}

export function exactTextCellValue(value) {
  for(let depth=0;depth<5;depth++){
    if(typeof value==='string')return value;
    if(Array.isArray(value)){
      if(value.length!==1)return null;
      value=value[0];
      continue;
    }
    if(value&&typeof value==='object'){
      if('value'in value){value=value.value;continue;}
      if('text'in value){value=value.text;continue;}
    }
    return null;
  }
  return null;
}

export function exactTextCellEquals(cell,expected) {
  return typeof expected==='string'&&exactTextCellValue(cell)===expected;
}

export function exactNullableTextCellEquals(left,right) {
  return exactTextCellValue(left)===exactTextCellValue(right);
}

// Contact comparison unwraps only known one-cell containers and preserves every
// character; whitespace, case, and Unicode differences remain mismatches.
export function exactContactCellEquals(cell,pageValue) {
  return typeof pageValue==='string'&&pageValue.length>0&&exactTextCellEquals(cell,pageValue);
}

export function exactSourceCellValue(value) {
  const text=exactTextCellValue(value);
  if(text===null)return null;
  const markdown=text.match(/^\[[^\]]*\]\((https?:\/\/[^)]+)\)$/u);
  return markdown?markdown[1]:text;
}

export function exactSourceCellEquals(cell,expectedUrl) {
  return typeof expectedUrl==='string'&&exactSourceCellValue(cell)===expectedUrl;
}

export function exactNullableSourceCellEquals(left,right) {
  const actual=exactSourceCellValue(left),expected=exactSourceCellValue(right);
  return actual===null&&expected===null||actual!==null&&actual===expected;
}

export function matchesB2ContactPatchReadback({current,patch,creatorId,recordId}) {
  if(current?.recordId!==recordId||exactTextCellValue(current?.fields?.['抖音号'])!==creatorId)return false;
  const entries=Object.entries(patch||{});
  if(!entries.length)return false;
  return entries.every(([name,value])=>name==='微信号'
    ?exactContactCellEquals(current.fields[name],value)
    :name==='联系方式来源'?exactSourceCellEquals(current.fields[name],value)
    :sameCell(name,current.fields[name],value));
}

export function compareFailureAttemptPatchReadback(current,patch) {
  const fields=patch||{};
  return {
    statusMatches:Object.hasOwn(fields,'本次联系方式状态')&&
      sameCell('本次联系方式状态',current?.fields?.['本次联系方式状态'],fields['本次联系方式状态']),
    attemptTimeMatches:Object.hasOwn(fields,'联系方式最近尝试')&&
      sameCell('联系方式最近尝试',current?.fields?.['联系方式最近尝试'],fields['联系方式最近尝试']),
    errorCodeMatches:Object.hasOwn(fields,'联系方式最近错误')&&
      sameCell('联系方式最近错误',current?.fields?.['联系方式最近错误'],fields['联系方式最近错误']),
  };
}

function textCell(value) {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'value'in value)value=value.value;
  if(Array.isArray(value))value=value.map(item=>item?.text??item?.value??item?.name??'').join(', ');
  if(value&&typeof value==='object')value=value.text??value.name??'';
  return normalizeText(value);
}

function fieldRows(payload) {
  const data=payload?.data??payload;
  return Array.isArray(data?.fields)?data.fields:(data?.fields?.items??data?.fields?.fields??[]);
}

function recordProjection(payload) {
  const data=payload?.data??payload;
  if(Array.isArray(data?.data)&&Array.isArray(data?.fields)){
    const cells=data.data[0]||[];
    return {recordId:data.record_id_list?.[0]??'',fields:Object.fromEntries(data.fields.map((name,index)=>[name,cells[index]??null]))};
  }
  if(data?.record?.fields)return {recordId:data.record.record_id??data.record.recordId??'',fields:data.record.fields};
  if(data?.fields&&!Array.isArray(data.fields))return {recordId:data.record_id??data.recordId??'',fields:data.fields};
  throw new Error('B2_RECORD_PROJECTION_INVALID');
}

function projectionEqual(left,right,names) {
  return names.every(name=>sameCell(name,left?.[name],right?.[name]));
}

function normalizedReason(reason) { return SAFE_REASON_CODES.has(reason)?reason:'BROWSER_ERROR'; }

export function failureNoteForReceipt(receipt={}) {
  const reason=normalizedReason(receipt.reason);
  const response=safeResponseEvidence(receipt.responseEvidence);
  const search=safeSearchDiagnostics(receipt.searchDiagnostics);
  const reveal=safeRevealDiagnostics(receipt.revealDiagnostics);
  const guard=safeGuardDiagnostics(receipt.guardDiagnostics);
  const responseObserved=receipt.responseEvidenceObserved===true||response.observedResponseCount>0||
    response.uninspectedJsonResponseCount>0||response.unknownErrorResponseCount>0||
    response.explicitAuthResponseCount>0||response.authPromptLatched===true;
  const searchObserved=receipt.searchDiagnosticsObserved===true||search.attemptCount>0||
    search.submittedAfterActivation===true||search.feedRequestCount>0||search.matchedRequestCount>0||
    search.matchedResponseCount>0||search.exactIdMatchCount>0;
  const revealObserved=receipt.revealDiagnosticsObserved===true||reveal.eyeActivationCount>0||
    reveal.clickAttemptCount>0||reveal.attemptSignals.length>0||reveal.failureBranch!=='';
  const guardObserved=receipt.guardDiagnosticsObserved===true||guard.reason!==''||guard.targetClosed||
    guard.targetContextMatches||guard.targetHidden||guard.pageSetStable||guard.otherPagesStable||
    guard.profileUidConfirmed||guard.authHealthy||guard.errorFree;
  const explicitAuth=['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED'].includes(reason)||
    receipt.authFailureSeen===true||response.authPromptLatched===true||response.explicitAuthResponseCount>0;
  const risk=reason==='SECURITY_CHALLENGE';
  const causeCode=explicitAuth?'EXPLICIT_AUTH_SIGNAL':risk?'RISK_SIGNAL':
    reason==='RESPONSE_EVIDENCE_INCOMPLETE'?'RESPONSE_INSPECTION_GAP':
      reason==='RESPONSE_ERROR_UNCLASSIFIED'?'UNCLASSIFIED_RESPONSE':
        reason==='PAGE_NOT_READY'?'PAGE_NOT_READY':
          reason==='BACKGROUND_TARGET_VISIBLE'||guard.reason==='BACKGROUND_TARGET_VISIBLE'?'BACKGROUND_GUARD':
            reason==='REVEAL_UNCONFIRMED'?'REVEAL_UNCONFIRMED':
              reason==='BROWSER_ERROR'?'TOOL_FAILURE':
                reason==='AUTH_OR_PERMISSION_UNRESOLVED'?'PAGE_STATE_UNRESOLVED':'UNKNOWN';
  return {
    stage:/^[a-z][a-z0-9-]{0,31}$/u.test(String(receipt.stage||''))?receipt.stage:'unknown',
    diagnosticCode:reason,
    causeStatus:explicitAuth||risk?'confirmed':'pending',
    causeCode,
    observation:{
      responseEvidenceObserved:responseObserved,
      observedResponseCount:response.observedResponseCount,
      jsonResponseCount:response.jsonResponseCount,
      inspectedJsonResponseCount:response.inspectedJsonResponseCount,
      uninspectedJsonCount:response.uninspectedJsonResponseCount,
      unknownErrorCount:response.unknownErrorResponseCount,
      explicitAuthResponseCount:response.explicitAuthResponseCount,
      authPromptLatched:response.authPromptLatched,
      searchDiagnosticsObserved:searchObserved,
      searchSubmitted:search.submittedAfterActivation,
      feedRequestCount:search.feedRequestCount,
      revealDiagnosticsObserved:revealObserved,
      eyeActivationCount:reveal.eyeActivationCount,
      clickAttemptCount:reveal.clickAttemptCount,
      finalRevealState:reveal.finalState,
      guardDiagnosticsObserved:guardObserved,
      guardReason:guard.reason,
      runtimeErrorType:receipt.runtimeErrorType,
    },
  };
}

function safeWriterErrorCode(error) {
  const prefix=String(error?.message||'').split(':',1)[0];
  if(SAFE_WRITER_ERROR_CODES.has(prefix))return prefix;
  return /^(?:B2|KOC|LARK)_[A-Z0-9_]{1,80}$/u.test(prefix)?prefix:'UNKNOWN_WRITER_ERROR';
}

export function failureStatusFor(reason) {
  return AUTH_REASON_STATUS.get(reason)||'error';
}

export function isExplicitExtraRowAuthorized({creatorId,recordId,extraCreatorId,extraRecordId,
  manifestMatchCount,top500Contains=false}={}) {
  return creatorId===EXPLICIT_EXTRA_ROW.creatorId&&recordId===EXPLICIT_EXTRA_ROW.recordId&&
    extraCreatorId===EXPLICIT_EXTRA_ROW.creatorId&&extraRecordId===EXPLICIT_EXTRA_ROW.recordId&&
    manifestMatchCount===0&&top500Contains===false;
}

export function validateQualifiedSourceTarget({manifest,sourceBatchId,creatorId,recordId,sourceRank}={}) {
  if(manifest?.kind!=='qualified-source'||manifest.sourceBatchId!==sourceBatchId||!Array.isArray(manifest.targets))
    throw new Error('B2_SOURCE_MANIFEST_UNVERIFIED');
  const matches=manifest.targets.filter(target=>target?.creatorId===creatorId);
  if(matches.length!==1)throw new Error('B2_CREATOR_OUTSIDE_APPROVED_LIST');
  const target=matches[0];
  if(target.recordId!==recordId)throw new Error('B2_RECORD_MAPPING_UNVERIFIED');
  if(target.sourceRank!==sourceRank)throw new Error('B2_CREATOR_OUTSIDE_APPROVED_LIST');
  return target;
}

export function validateExistingWeChatReverify({hadWeChatBefore,allowExistingWeChatReverify=false}={}) {
  if(hadWeChatBefore===true&&allowExistingWeChatReverify!==true)throw new Error('B2_TARGET_CONTACT_NOT_EMPTY');
  return hadWeChatBefore===true;
}

export function validateB2RevealRecoveryReservation({phase='single',creatorId,sourceRank,recordId='',sourceBatchId='',
  operationId='',reservedClickCount=0,reservedRefreshCount=0,priorReceipt=null,
  continuationReservedByOwner=false,executionId='',parentAttemptId=''}={}) {
  if(phase==='single')return {phase:'single',reservation:null};
  if(!['refreshed','rebaseline'].includes(phase)||creatorId!==REVEAL_RECOVERY_CREATOR_ID||sourceRank!==70||
      !/^[A-Za-z0-9._-]{1,80}$/u.test(String(operationId))||reservedClickCount!==2||reservedRefreshCount!==1){
    throw new Error('B2_REVEAL_RECOVERY_RESERVATION_INVALID');
  }
  if(phase==='rebaseline'){
    const diagnostic=priorReceipt?.browser?.revealDiagnostics;
    const clickWasNotAttempted=diagnostic?.clickAttemptCount===0&&diagnostic?.clickIssued!==true&&
      ['not_issued','unknown'].includes(diagnostic?.clickState)&&priorReceipt?.browser?.stage==='driver-init'&&
      Array.isArray(diagnostic?.attemptSignals)&&diagnostic.attemptSignals.length===0;
    const parentReceiptMatches=priorReceipt?.sourceBatchId===sourceBatchId&&priorReceipt?.creatorId===creatorId&&
      priorReceipt?.recordId===recordId&&priorReceipt?.sourceRank===70&&priorReceipt?.outsideOriginal500===false&&
      priorReceipt?.status==='attempt_failed_old_contact_preserved'&&
      priorReceipt?.browser?.reason==='AUTH_OR_PERMISSION_UNRESOLVED'&&
      priorReceipt?.failureAttemptExpected?.errorReason==='AUTH_OR_PERMISSION_UNRESOLVED'&&
      priorReceipt?.write?.failureStatusRecorded===true&&priorReceipt?.write?.oldWeChatPreserved===true&&
      priorReceipt?.write?.failureWriterStage==='verified'&&diagnostic?.recoveryPhase==='refreshed'&&
      diagnostic?.recoveryOperationId===operationId&&diagnostic?.reservedClickCount===2&&
      diagnostic?.reservedRefreshCount===1&&diagnostic?.refreshCount===1&&diagnostic?.pageReloaded===true&&
      diagnostic?.rebaselinePassed===false&&clickWasNotAttempted;
    if(!continuationReservedByOwner)throw new Error('B2_REVEAL_RECOVERY_CONTINUATION_NOT_RESERVED');
    if(!parentReceiptMatches||!/^[-A-Za-z0-9._]{1,80}$/u.test(String(executionId))||
        !/^[-A-Za-z0-9._]{1,80}$/u.test(String(parentAttemptId)))
      throw new Error('B2_REVEAL_RECOVERY_PRIOR_RECEIPT_INVALID');
  }
  const reservation={reserved:true,operationId:String(operationId),
    clickCount:reservedClickCount,refreshCount:reservedRefreshCount};
  if(phase==='rebaseline')Object.assign(reservation,{priorReceiptVerified:true,priorRefreshCount:1,
    priorClickAttemptCount:0,executionId:String(executionId),parentAttemptId:String(parentAttemptId)});
  return {phase,reservation};
}

async function readPriorRevealRecoveryReceipt() {
  const root=path.resolve(DEFAULT_STATE_DIR);
  const candidate=path.resolve(REVEAL_RECOVERY_PRIOR_RECEIPT_PATH||'.');
  const prefix=`koc-contact-${SOURCE_BATCH_ID}-rank-70-${CREATOR_ID}-`;
  if(!path.isAbsolute(REVEAL_RECOVERY_PRIOR_RECEIPT_PATH)||path.dirname(candidate)!==root||
      !path.basename(candidate).startsWith(prefix)||!path.basename(candidate).endsWith('.json'))
    throw new Error('B2_REVEAL_RECOVERY_PRIOR_RECEIPT_INVALID');
  try{
    const stat=await fs.lstat(candidate);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)
      throw new Error('B2_REVEAL_RECOVERY_PRIOR_RECEIPT_INVALID');
    return JSON.parse(await fs.readFile(candidate,'utf8'));
  }catch{
    throw new Error('B2_REVEAL_RECOVERY_PRIOR_RECEIPT_INVALID');
  }
}

function safeAuthPreflightOnce() {
  const result=spawnSync('lark-cli',['auth','status','--profile',FEISHU_ROUTE.profile,'--verify','--json'],{
    encoding:'utf8',maxBuffer:2*1024*1024,timeout:30000,stdio:['ignore','pipe','pipe'],
  });
  const parsed=parseJsonOutput(result.stdout);
  const findUserTokenStatus=payload=>{
    const queue=[payload],visited=new Set();
    while(queue.length){
      const value=queue.shift();
      if(!value||typeof value!=='object'||visited.has(value))continue;
      visited.add(value);
      if(!Array.isArray(value)&&String(value.identity||'').toLowerCase()==='user'&&
          typeof value.tokenStatus==='string')return value.tokenStatus;
      for(const child of Array.isArray(value)?value:Object.values(value))if(child&&typeof child==='object')queue.push(child);
    }
    return '';
  };
  let reason='';
  if(result.error||result.status!==0)reason='LARK_AUTH_STATUS_FAILED';
  else if(!parsed)reason='LARK_AUTH_STATUS_RESPONSE_INVALID';
  else if(!findVerifiedUser(parsed))reason=findUserTokenStatus(parsed)==='needs_refresh'
    ?'LARK_USER_TOKEN_NEEDS_REFRESH':'LARK_USER_IDENTITY_NOT_VERIFIED';
  return {verifiedUser:!reason,reason,statusCategory:reason||'verified_user',
    tokenStatus:findUserTokenStatus(parsed)==='needs_refresh'?'needs_refresh':
      findUserTokenStatus(parsed)==='valid'?'valid':'unknown'};
}

function safeAuthPreflight() {
  const first=safeAuthPreflightOnce();
  if(first.verifiedUser||!['LARK_AUTH_STATUS_FAILED','LARK_AUTH_STATUS_RESPONSE_INVALID'].includes(first.statusCategory)){
    return {...first,attempts:1};
  }
  const retry=safeAuthPreflightOnce();
  return {...retry,attempts:2,firstAttemptCategory:first.statusCategory};
}

function checkConfigPrint() {
  const result=spawnSync('npx',['--no-install','@playwright/cli',`-s=${ORIGINAL_BACKGROUND_SESSION}`,'config-print'],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',maxBuffer:2*1024*1024,
    timeout:20000,stdio:['ignore','pipe','pipe'],env:{...process.env,DEBUG:'',PWDEBUG:''},
  });
  return persistencePreflightFromConfigPrintResult(result);
}

export async function prepareOriginalBackgroundContact({templatePath=PRIVATE_TEMPLATE_PATH,readFileFn=fs.readFile,
  configPrintFn=checkConfigPrint}={}) {
  const detailTemplate=await loadDetailTemplate({templatePath,readFileFn});
  const persistencePreflight=await configPrintFn();
  return {detailTemplate,persistencePreflight};
}

export function assertContactSchema(fields){
 const types={Text:['text','1'],'抖音号':['text','1'],'微信号':['text','1'],
 '本次联系方式状态':['text','1','single_select','singleselect','select','3'],
 '联系方式最近尝试':['datetime','date','5'],'联系方式最近成功':['datetime','date','5'],
 '联系方式最近错误':['text','1'],'联系方式来源':['text','url','1','17']};
 const byName=new Map();
 for(const f of fields){const name=f.field_name??f.name;if(byName.has(name))throw Error('B2_SCHEMA_MISMATCH');byName.set(name,f);}
 for(const [name,allowed] of Object.entries(types)){const f=byName.get(name);if(!f||!allowed.includes(String(f.type??f.field_type??f.type_name).toLowerCase()))throw Error('B2_SCHEMA_MISMATCH');}
 if(!byName.has('商务跟进状态')||!byName.has('商务备注'))throw Error('B2_SCHEMA_MISMATCH');
 return true;
}

async function main() {
  if(!CREATOR_ID||!EXPECTED_RECORD_ID||!SOURCE_BATCH_ID)throw Error('KOC_TARGET_CONFIGURATION_REQUIRED');
  currentPhase='recovery_preflight';
  if(EXECUTION_OPERATION_ID&&!/^[-A-Za-z0-9._]{1,80}$/u.test(EXECUTION_OPERATION_ID))
    throw new Error('B2_OPERATION_ID_INVALID');
  const priorRecoveryReceipt=REVEAL_RECOVERY_PHASE==='rebaseline'
    ?await readPriorRevealRecoveryReceipt():null;
  const recoveryPlan=validateB2RevealRecoveryReservation({phase:REVEAL_RECOVERY_PHASE,
    creatorId:CREATOR_ID,sourceRank:EXPECTED_SOURCE_RANK,recordId:EXPECTED_RECORD_ID,sourceBatchId:SOURCE_BATCH_ID,
    operationId:REVEAL_RECOVERY_OPERATION_ID,
    reservedClickCount:Number(process.env.KOC_REVEAL_RECOVERY_RESERVED_CLICK_COUNT||0),
    reservedRefreshCount:Number(process.env.KOC_REVEAL_RECOVERY_RESERVED_REFRESH_COUNT||0),
    priorReceipt:priorRecoveryReceipt,
    continuationReservedByOwner:process.env.KOC_REVEAL_RECOVERY_CONTINUATION_RESERVED==='1',
    executionId:REVEAL_RECOVERY_EXECUTION_ID,parentAttemptId:REVEAL_RECOVERY_PARENT_ATTEMPT_ID});
  currentPhase='feishu_auth';
  authPreflightSummary=safeAuthPreflight();
  if(!authPreflightSummary.verifiedUser)throw new Error(authPreflightSummary.reason);
  currentPhase='schema';
  const client=new LarkBaseClient({route:FEISHU_ROUTE});
  const schema=fieldRows(client.listFields());
  const fieldNames=schema.map(item=>String(item?.field_name??item?.name??'')).filter(Boolean);
  assertContactSchema(schema);

  currentPhase='source_checkpoint';
  let qualifiedSource=null;
  if(QUALIFIED_SOURCE_MANIFEST_PATH||QUALIFIED_SOURCE_MANIFEST_SHA256){
    if(!QUALIFIED_SOURCE_MANIFEST_PATH||!/^[a-f0-9]{64}$/u.test(QUALIFIED_SOURCE_MANIFEST_SHA256))
      throw new Error('B2_SOURCE_MANIFEST_UNVERIFIED');
    const {loadQualifiedSourceManifest}=await import('./canary-production-adapter.mjs');
    try{
      qualifiedSource=await loadQualifiedSourceManifest({sourceManifestPath:QUALIFIED_SOURCE_MANIFEST_PATH,
        sourceStateDir:DEFAULT_STATE_DIR});
    }catch{throw new Error('B2_SOURCE_MANIFEST_UNVERIFIED');}
    if(qualifiedSource.manifestFileSha256!==QUALIFIED_SOURCE_MANIFEST_SHA256)
      throw new Error('B2_SOURCE_MANIFEST_UNVERIFIED');
    validateQualifiedSourceTarget({manifest:qualifiedSource.manifest,sourceBatchId:SOURCE_BATCH_ID,
      creatorId:CREATOR_ID,recordId:EXPECTED_RECORD_ID,sourceRank:EXPECTED_SOURCE_RANK});
  }
  const sourceCheckpoint=await (await import('../koc-roster/checkpoint.mjs'))
    .readPrivateJson(path.join(DEFAULT_STATE_DIR,`${SOURCE_BATCH_ID}.checkpoint.json`));
  if(sourceCheckpoint.batchId!==SOURCE_BATCH_ID||
      (qualifiedSource?(!['target_reached','source_exhausted'].includes(sourceCheckpoint.status)):
        (sourceCheckpoint.status!=='target_reached'||sourceCheckpoint.targetReached!==true||
          sourceCheckpoint.scopeKey!==ROSTER_SCOPE_KEY))){
    throw new Error('B2_SOURCE_CHECKPOINT_UNVERIFIED');
  }
  const sourceWriteReceipt=qualifiedSource?.receipt||await (await import('../koc-roster/checkpoint.mjs'))
    .readPrivateJson(path.join(DEFAULT_STATE_DIR,`${SOURCE_BATCH_ID}.write-receipt.json`));
  if(!qualifiedSource&&(sourceWriteReceipt.batchId!==SOURCE_BATCH_ID||sourceWriteReceipt.status!=='complete'||
      sourceWriteReceipt.scopeKey!==ROSTER_SCOPE_KEY||sourceWriteReceipt.contactDataIncluded!==false||
      !Array.isArray(sourceWriteReceipt.plannedCreators)||sourceWriteReceipt.plannedCreators.length!==500||
      !sourceWriteReceipt.creatorRecordIds||typeof sourceWriteReceipt.creatorRecordIds!=='object')){
    throw new Error('B2_SOURCE_MANIFEST_UNVERIFIED');
  }
  currentPhase='record_mapping';
  const currentIndex=await listRosterIndex(client);
  const rawRows=qualifiedSource?qualifiedSource.sourceRows:sourceCheckpoint.pages.flatMap(page=>page.rows);
  const sourceRow=rawRows.find(row=>normalizeText(row.creatorId)===CREATOR_ID);
  if(['refreshed','rebaseline'].includes(recoveryPlan.phase)&&sourceRow?.sourceRank!==70)
    throw new Error('B2_REVEAL_RECOVERY_RESERVATION_INVALID');
  const qualifiedTarget=qualifiedSource?validateQualifiedSourceTarget({manifest:qualifiedSource.manifest,
    sourceBatchId:SOURCE_BATCH_ID,creatorId:CREATOR_ID,recordId:EXPECTED_RECORD_ID,
    sourceRank:EXPECTED_SOURCE_RANK}):null;
  const manifestMatches=qualifiedTarget?[qualifiedTarget]:
    sourceWriteReceipt.plannedCreators.filter(item=>normalizeText(item.creatorId)===CREATOR_ID);
  const manifestMatch=manifestMatches.length===1?manifestMatches[0]:null;
  let top500Contains=qualifiedTarget!==null;
  if(!qualifiedSource){
    const classified=classifyRankedRows(rawRows,{existingIds:[...currentIndex.keys()]});
    top500Contains=[...classified.eligible,...classified.existing].sort((a,b)=>a.sourceRank-b.sourceRank)
      .slice(0,500).some(row=>normalizeText(row.creatorId)===CREATOR_ID);
  }
  const explicitExtraRow=isExplicitExtraRowAuthorized({creatorId:CREATOR_ID,recordId:EXPECTED_RECORD_ID,
    extraCreatorId:EXTRA_ROW_CREATOR_ID,extraRecordId:EXTRA_ROW_RECORD_ID,
    manifestMatchCount:manifestMatches.length,top500Contains});
  const sourceBatchMember=qualifiedTarget!==null&&qualifiedSource
    ?!!sourceRow&&qualifiedTarget.sourceRank===sourceRow.sourceRank
    :!!sourceRow&&!!manifestMatch&&manifestMatch.sourceRank===sourceRow.sourceRank&&
      (!Number.isInteger(EXPECTED_SOURCE_RANK)||sourceRow.sourceRank===EXPECTED_SOURCE_RANK)&&top500Contains;
  if(!sourceBatchMember&&!explicitExtraRow)throw new Error('B2_CREATOR_OUTSIDE_APPROVED_LIST');

  const target=findRosterRecordByCreatorId(client,CREATOR_ID);
  const indexedTarget=currentIndex.get(CREATOR_ID);
  const manifestRecordId=String(qualifiedTarget?.recordId||sourceWriteReceipt.creatorRecordIds[CREATOR_ID]||'');
  const sourceOutcome=(Array.isArray(sourceWriteReceipt.outcomes)?sourceWriteReceipt.outcomes:[])
    .filter(item=>normalizeText(item.creatorId)===CREATOR_ID);
  if(!target?.recordId||target.recordId!==indexedTarget?.recordId||
      (sourceBatchMember&&(target.recordId!==manifestRecordId||(!qualifiedSource&&(sourceOutcome.length!==1||
        sourceOutcome[0].recordId!==target.recordId||sourceOutcome[0].readbackVerified!==true))||
        (qualifiedSource&&!qualifiedTarget)))||
      (explicitExtraRow&&target.recordId!==EXPLICIT_EXTRA_ROW.recordId)||
      (EXPECTED_RECORD_ID&&target.recordId!==EXPECTED_RECORD_ID))throw new Error('B2_RECORD_MAPPING_UNVERIFIED');
  const protectedNames=fieldNames.filter(name=>!CONTACT_FIELDS.has(name));
  const initial=recordProjection(client.getRecord(target.recordId,fieldNames));
  if(initial.recordId!==target.recordId)throw new Error('B2_RECORD_ID_READBACK_MISMATCH');
  if(textCell(initial.fields['抖音号'])!==CREATOR_ID)throw new Error('B2_CREATOR_ID_READBACK_MISMATCH');
  const hadWeChatBefore=normalizeText(textCell(initial.fields['微信号']))!=='';
  validateExistingWeChatReverify({hadWeChatBefore,allowExistingWeChatReverify:ALLOW_EXISTING_WECHAT_REVERIFY});
  const baselineProtected=Object.fromEntries(protectedNames.map(name=>[name,canonical(initial.fields[name])]));
  const baselinePreserve=Object.fromEntries(PRESERVE_ON_FAILURE.map(name=>[name,canonical(initial.fields[name])]));

  const runStartedAt=new Date().toISOString();
  const facts={writerInvoked:false,sharedWriterReadbackVerified:false,postReadbackVerified:false,
    nonContactFieldsUnchanged:false,humanFieldsUnchanged:false,apiUpdatedFlag:false,
    failureStatusRecorded:false,oldWeChatPreserved:false,lastSuccessPreserved:false,sourcePreserved:false,
    failureWriterInvoked:false,failureWriteSubmitted:false,failureWriterStage:'not_started',failureWriterErrorCode:'',
    failureWriterReadbackDiagnostic:null,failurePatchStatusMatches:false,failureReadableReasonMatches:false,
    failurePatchAttemptTimeMatches:false,failurePatchErrorCodeMatches:false,
    failureSharedReadbackCount:0,failureSharedPayloadCompared:false,
    failureSharedPayloadStatusMatches:false,failureSharedPayloadAttemptTimeMatches:false,
    failureSharedPayloadErrorCodeMatches:false,failureSharedPayloadReadableReasonMatches:false,
    failureSharedWriterStage:'not_started',failureAttemptExpected:null,
    sameCreatorIdReadback:false,sourceScopeVerified:true,recordMappingVerified:true,hadWeChatBefore,
    sharedWriterStage:'not_started',sharedWriterErrorCode:'',readbackDiagnostic:null};
  let expectedPatch=null;

  async function readCurrent() {
    const current=recordProjection(client.getRecord(target.recordId,fieldNames));
    return current;
  }

  function currentMatchesPatch(current,patch) {
    return matchesB2ContactPatchReadback({current,patch,creatorId:CREATOR_ID,recordId:target.recordId});
  }

  async function writeFailureAttempt(failureAttempt) {
    const status=String(failureAttempt?.contactStatus||'');
    const expectedReadableReason=formatContactFailureNote(failureAttempt?.failureNote);
    const failureWriter=async({creatorId,recordId,fields})=>{
      facts.failureWriterInvoked=true;
      facts.failureWriterStage='validate';
      if(creatorId!==CREATOR_ID||recordId!==target.recordId)throw new Error('B2_WRITER_TARGET_MISMATCH');
      if('微信号'in fields||'联系方式最近成功'in fields||'联系方式来源'in fields)throw new Error('B2_FAILURE_PATCH_SCOPE_MISMATCH');
      const before=await readCurrent();
      if(!projectionEqual(before.fields,baselineProtected,protectedNames))throw new Error('B2_PROTECTED_FIELDS_CHANGED_BEFORE_FAILURE_WRITE');
      if(!projectionEqual(before.fields,baselinePreserve,PRESERVE_ON_FAILURE))throw new Error('B2_PRIOR_CONTACT_CHANGED_BEFORE_FAILURE_WRITE');
      facts.failureWriteSubmitted=true;
      facts.failureWriterStage='submitted';
      let sharedReadbackCount=0;
      const observedClient={recordLockDir:client.recordLockDir,
        async getRecord(...args){
          const payload=await client.getRecord(...args);
          sharedReadbackCount++;
          facts.failureSharedReadbackCount=sharedReadbackCount;
          facts.failureSharedWriterStage=sharedReadbackCount===1?'id_lookup':'readback_compare';
          if(sharedReadbackCount>1){
            const projection=recordProjection(payload);
            const comparison=compareFailureAttemptPatchReadback(projection,fields);
            facts.failureSharedPayloadCompared=true;
            facts.failureSharedPayloadStatusMatches=comparison.statusMatches;
            facts.failureSharedPayloadAttemptTimeMatches=comparison.attemptTimeMatches;
            facts.failureSharedPayloadErrorCodeMatches=comparison.errorCodeMatches;
            facts.failureSharedPayloadReadableReasonMatches=expectedReadableReason
              ?comparison.errorCodeMatches:false;
          }
          return payload;
        },
        async upsertRecord(...args){
          facts.failureSharedWriterStage='upsert';
          return client.upsertRecord(...args);
        }};
      try{await patchContactRecord({creatorId,recordId,fields},observedClient);}
      catch(error){
        facts.failureWriterErrorCode=safeWriterErrorCode(error);
        const diagnostic=error?.readbackDiagnostic;
        if(diagnostic&&Object.keys(fields).includes(diagnostic.field)){
          const type=value=>['string','number','boolean','array','object'].includes(value)?value:'null';
          facts.failureWriterReadbackDiagnostic={field:diagnostic.field,
            expectedType:type(diagnostic.expectedType),actualType:type(diagnostic.actualType),
            semanticMatches:diagnostic.semanticMatches===true};
        }
      }
      facts.failureWriterStage='readback';
      const after=await readCurrent();
      const outerComparison=compareFailureAttemptPatchReadback(after,fields);
      facts.failurePatchStatusMatches=outerComparison.statusMatches;
      facts.failurePatchAttemptTimeMatches=outerComparison.attemptTimeMatches;
      facts.failurePatchErrorCodeMatches=outerComparison.errorCodeMatches;
      facts.failureReadableReasonMatches=expectedReadableReason?outerComparison.errorCodeMatches:false;
      const statusReadback=facts.failurePatchStatusMatches&&facts.failurePatchAttemptTimeMatches&&
        facts.failurePatchErrorCodeMatches&&(!expectedReadableReason||facts.failureReadableReasonMatches);
      const protectedMatches=projectionEqual(after.fields,baselineProtected,protectedNames);
      facts.sameCreatorIdReadback=textCell(after.fields['抖音号'])===CREATOR_ID;
      facts.nonContactFieldsUnchanged=protectedMatches;
      facts.humanFieldsUnchanged=projectionEqual(after.fields,baselineProtected,['商务跟进状态','商务备注']);
      facts.oldWeChatPreserved=exactNullableTextCellEquals(after.fields['微信号'],baselinePreserve['微信号']);
      facts.lastSuccessPreserved=sameCell('联系方式最近成功',after.fields['联系方式最近成功'],baselinePreserve['联系方式最近成功']);
      facts.sourcePreserved=exactNullableSourceCellEquals(after.fields['联系方式来源'],
        baselinePreserve['联系方式来源']);
      facts.failureStatusRecorded=statusReadback;
      if(!statusReadback||!protectedMatches||!facts.sameCreatorIdReadback||!facts.humanFieldsUnchanged||
          !facts.oldWeChatPreserved||!facts.lastSuccessPreserved||!facts.sourcePreserved){
        facts.failureWriterStage='readback_unverified';
        throw new Error('B2_FAILURE_READBACK_UNVERIFIED');
      }
      facts.failureWriterStage='verified';
      return {updated:true,status,fieldNames:Object.keys(fields),resultFlag:true};
    };
    try {
      return await patchCurrentContactAttempt({creatorId:CREATOR_ID,recordId:target.recordId,
        attempt:failureAttempt,writer:failureWriter});
    } catch(error) {
      facts.failureWriterErrorCode=facts.failureWriterErrorCode||safeWriterErrorCode(error);
      if(facts.failureWriterStage==='not_started')facts.failureWriterStage='rejected_before_writer';
      throw error;
    }
  }

  async function writeVerified(patchRequest) {
    const {creatorId,recordId,fields}=patchRequest;
    if(creatorId!==CREATOR_ID||recordId!==target.recordId)throw new Error('B2_WRITER_TARGET_MISMATCH');
    const names=Object.keys(fields||{});
    if(!names.length||names.some(name=>!CONTACT_FIELDS.has(name)))throw new Error('B2_PATCH_FIELD_SCOPE_MISMATCH');
    const before=await readCurrent();
    if(textCell(before.fields['抖音号'])!==CREATOR_ID||
        !projectionEqual(before.fields,baselineProtected,protectedNames))throw new Error('B2_PROTECTED_FIELDS_CHANGED_BEFORE_WRITE');
    if(!projectionEqual(before.fields,baselinePreserve,PRESERVE_ON_FAILURE))
      throw new Error('B2_PRIOR_CONTACT_CHANGED_BEFORE_SUCCESS_WRITE');
    expectedPatch=Object.fromEntries(names.map(name=>[name,fields[name]]));
    facts.writerInvoked=true;
    let shared;
    try {
      facts.sharedWriterStage='validate';
      let sharedReadCount=0;
      const observedClient={recordLockDir:client.recordLockDir,
        async getRecord(...args){
          sharedReadCount++;
          facts.sharedWriterStage=sharedReadCount===1?'id_lookup':'readback';
          const payload=await client.getRecord(...args);
          if(sharedReadCount===2)facts.sharedWriterStage='compare';
          return payload;
        },
        async upsertRecord(...args){facts.sharedWriterStage='upsert';return client.upsertRecord(...args);}};
      shared=await patchContactRecord({creatorId,recordId,fields},observedClient);
      facts.sharedWriterStage='complete';
      facts.apiUpdatedFlag=shared.resultFlag===true;
      facts.sharedWriterReadbackVerified=shared.updated===true;
    } catch(error) {
      // The patch API may have committed before a transport/readback error. Reconcile once by reading;
      // never repeat an uncertain update blindly.
      const message=String(error?.message||'');
      const code=message.split(':',1)[0];
      facts.sharedWriterErrorCode=SAFE_WRITER_ERROR_CODES.has(code)?code:'UNKNOWN_WRITER_ERROR';
      const diagnostic=error?.readbackDiagnostic;
      if(diagnostic&&names.includes(diagnostic.field)){
        const type=value=>['string','number','boolean','array','object'].includes(value)?value:'null';
        facts.readbackDiagnostic={field:diagnostic.field,expectedType:type(diagnostic.expectedType),
          actualType:type(diagnostic.actualType),semanticMatches:diagnostic.semanticMatches===true};
      }
    }
    const after=await readCurrent();
    const patchMatches=currentMatchesPatch(after,expectedPatch);
    const protectedMatches=projectionEqual(after.fields,baselineProtected,protectedNames);
    facts.sameCreatorIdReadback=textCell(after.fields['抖音号'])===CREATOR_ID;
    facts.postReadbackVerified=patchMatches;
    facts.nonContactFieldsUnchanged=protectedMatches;
    facts.humanFieldsUnchanged=projectionEqual(after.fields,baselineProtected,['商务跟进状态','商务备注']);
    if(!patchMatches||!protectedMatches)throw new Error('B2_PATCH_READBACK_UNVERIFIED');
    return {updated:true,status:normalizeText(fields['本次联系方式状态']),fieldNames:names,
      resultFlag:facts.apiUpdatedFlag};
  }

  currentPhase='browser_and_write';
  const {detailTemplate,persistencePreflight}=await prepareOriginalBackgroundContact();
  const result=await runOriginalBackgroundContact({session:ORIGINAL_BACKGROUND_SESSION,creatorId:CREATOR_ID,
    creatorName:['refreshed','rebaseline'].includes(recoveryPlan.phase)?'':
      sourceRow?.creatorName||process.env.KOC_CREATOR_NAME||'',
    recordId:target.recordId,accountMarker:BUYIN_ACCOUNT_MARKER,detailTemplate,
    persistencePreflight,writer:writeVerified,revealRecoveryPhase:recoveryPlan.phase,
    revealRecoveryReservation:recoveryPlan.reservation,searchAttemptLimit:SEARCH_ATTEMPT_LIMIT,
    revealObservationWindowMs:REVEAL_OBSERVATION_WINDOW_MS});

  if(result.receipt.status==='completed'&&result.writeback.updated===true){
    // The injected writer already re-read the full row and checked all non-contact and human fields.
  } else if(result.writeback.status==='not_written') {
    const reason=normalizedReason(result.receipt.reason);
    const status=failureStatusFor(reason);
    const failureNote=['error','login_required','captcha'].includes(status)
      ?failureNoteForReceipt(result.receipt):null;
    const failureAttempt={contactStatus:status,
      contactCheckedAt:result.attempt?.contactCheckedAt||runStartedAt,errorReason:reason,failureNote};
    facts.failureAttemptExpected={status,checkedAt:failureAttempt.contactCheckedAt,errorReason:reason,
      readableReason:formatContactFailureNote(failureNote)};
    try { await writeFailureAttempt(failureAttempt); }
    catch { /* Keep the browser failure and the safe write/readback diagnostics. */ }
  }

  const safe=buildSafeB2Receipt({result,facts,sourceRow:sourceBatchMember?sourceRow:null,
    recordId:target.recordId,explicitExtraRow,operationId:EXECUTION_OPERATION_ID});
  const completedStamp=new Date().toISOString().replace(/[:.]/gu,'-');
  const sourceLabel=explicitExtraRow?'extra-row':`rank-${sourceRow.sourceRank}`;
  const receiptPath=path.join(DEFAULT_STATE_DIR,
    `koc-contact-${SOURCE_BATCH_ID}-${sourceLabel}-${CREATOR_ID}-${completedStamp}.json`);
  await writePrivateJson(receiptPath,safe);
  process.stdout.write(`${JSON.stringify({...safe,authPreflight:authPreflightSummary,receiptPath})}\n`);
  if(safe.status==='verification_incomplete')process.exitCode=1;
}

export function buildSafeB2Receipt({result,facts,sourceRow=null,recordId=EXPECTED_RECORD_ID,explicitExtraRow=false,
  operationId=''}) {
  const completedBrowserChain=result.receipt.identityProof==='API_FEED_ID_MATCH'&&
    result.receipt.formalIdMatch&&result.receipt.profileOpened&&result.receipt.wechatRowUnique&&
    result.receipt.revealed&&result.receipt.nonMaskedValue&&result.receipt.finalBackgroundGuard&&result.receipt.errorFree;
  const writerReadbackVerified=facts.sharedWriterReadbackVerified&&facts.postReadbackVerified;
  const success=completedBrowserChain&&facts.writerInvoked&&writerReadbackVerified&&
    facts.nonContactFieldsUnchanged&&facts.humanFieldsUnchanged&&facts.sameCreatorIdReadback;
  const failureRecorded=result.writeback.status==='not_written'&&facts.failureWriterInvoked&&
    facts.failureWriteSubmitted&&facts.failureStatusRecorded&&
    facts.oldWeChatPreserved&&facts.lastSuccessPreserved&&facts.sourcePreserved&&
    facts.nonContactFieldsUnchanged&&facts.humanFieldsUnchanged&&facts.sameCreatorIdReadback;
  const safeLocatorCount=value=>Number.isInteger(value)&&value>=0&&value<=100?value:null;
  return {mode:'one_creator_original_background_feishu_write',creatorId:CREATOR_ID,
    ...(typeof operationId==='string'&&/^[-A-Za-z0-9._]{1,80}$/u.test(operationId)?{operationId}:{}),
    recordAlias:'candidate_record_1',recordId:recordId||'',sourceBatchId:SOURCE_BATCH_ID,
    sourceMode:explicitExtraRow?'explicit_extra_row':'original_500',outsideOriginal500:explicitExtraRow===true,
    sourceRank:explicitExtraRow?null:Number.isInteger(sourceRow?.sourceRank)?sourceRow.sourceRank:EXPECTED_SOURCE_RANK,
    hadWeChatBefore:typeof facts.hadWeChatBefore==='boolean'?facts.hadWeChatBefore:null,
    failureAttemptExpected:result.writeback.status==='not_written'&&facts.failureAttemptExpected&&
      typeof facts.failureAttemptExpected.checkedAt==='string'?{
        status:['found','not_shown','not_found','login_required','captcha','error','forbidden_by_platform'].includes(facts.failureAttemptExpected.status)
          ?facts.failureAttemptExpected.status:'error',
        checkedAt:facts.failureAttemptExpected.checkedAt,
        errorReason:normalizedReason(facts.failureAttemptExpected.errorReason),
        readableReason:typeof facts.failureAttemptExpected.readableReason==='string'
          ?facts.failureAttemptExpected.readableReason.slice(0,512):''}:null,
    route:{profile:FEISHU_ROUTE.profile,as:FEISHU_ROUTE.as},
    status:success?'updated_readback_verified':failureRecorded?'attempt_failed_old_contact_preserved':'verification_incomplete',
    browser:{status:result.receipt.status,stage:result.receipt.stage,reason:result.receipt.reason,
      identityProof:result.receipt.identityProof,formalIdMatch:result.receipt.formalIdMatch,
      profileOpened:result.receipt.profileOpened,wechatRowUnique:result.receipt.wechatRowUnique,
      revealed:result.receipt.revealed,nonMaskedValue:result.receipt.nonMaskedValue,
      finalBackgroundGuard:result.receipt.finalBackgroundGuard,errorFree:result.receipt.errorFree,
      responseEvidence:safeResponseEvidence(result.receipt.responseEvidence),
      responseEvidenceObserved:result.receipt.responseEvidenceObserved===true,
      guardDiagnostics:safeGuardDiagnostics(result.receipt.guardDiagnostics),
      guardDiagnosticsObserved:result.receipt.guardDiagnosticsObserved===true,
      searchDiagnostics:safeSearchDiagnostics(result.receipt.searchDiagnostics),
      searchDiagnosticsObserved:result.receipt.searchDiagnosticsObserved===true,
      workerIdentityProof:safeWorkerIdentityProof(result.receipt.workerIdentityProof),
      revealDiagnostics:safeRevealDiagnostics(result.receipt.revealDiagnostics),
      revealDiagnosticsObserved:result.receipt.revealDiagnosticsObserved===true,
      channelDiagnostics:safeChannelDiagnostics(result.receipt.channelDiagnostics),
      runtimeErrorType:['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']
        .includes(result.receipt.runtimeErrorType)?result.receipt.runtimeErrorType:'',
      locatorDiagnostics:{contactItemCount:safeLocatorCount(result.receipt.contactItemCount),
        visibleContactItemCount:safeLocatorCount(result.receipt.visibleContactItemCount),
        wechatLocatorCount:safeLocatorCount(result.receipt.wechatLocatorCount),
        visibleWechatLocatorCount:safeLocatorCount(result.receipt.visibleWechatLocatorCount),
        eyeControlCount:safeLocatorCount(result.receipt.eyeControlCount)},
      failureClass:result.execution.failureClass},
    write:{writerInvoked:facts.writerInvoked,sharedWriterReadbackVerified:facts.sharedWriterReadbackVerified,
      postReadbackVerified:facts.postReadbackVerified,apiUpdatedFlag:facts.apiUpdatedFlag,
      sharedWriterStage:facts.sharedWriterStage,
      sharedWriterErrorCode:facts.sharedWriterErrorCode,
      readbackDiagnostic:facts.readbackDiagnostic,
      failureStatusRecorded:facts.failureStatusRecorded,oldWeChatPreserved:facts.oldWeChatPreserved,
      failureWriterInvoked:facts.failureWriterInvoked===true,
      failureWriteSubmitted:facts.failureWriteSubmitted===true,
      failureWriterStage:/^(?:not_started|validate|submitted|readback|readback_unverified|verified|rejected_before_writer)$/u
        .test(facts.failureWriterStage||'')?facts.failureWriterStage:'unknown',
      failureWriterErrorCode:/^(?:B2|KOC|LARK)_[A-Z0-9_]{1,80}$/u.test(facts.failureWriterErrorCode||'')
        ?facts.failureWriterErrorCode:'',
      failureWriterReadbackDiagnostic:facts.failureWriterReadbackDiagnostic&&
        ['本次联系方式状态','联系方式最近尝试','联系方式最近错误'].includes(facts.failureWriterReadbackDiagnostic.field)
        ?facts.failureWriterReadbackDiagnostic:null,
      failurePatchStatusMatches:facts.failurePatchStatusMatches===true,
      failurePatchAttemptTimeMatches:facts.failurePatchAttemptTimeMatches===true,
      failurePatchErrorCodeMatches:facts.failurePatchErrorCodeMatches===true,
      failureReadableReasonMatches:facts.failureReadableReasonMatches===true,
      failureSharedReadbackCount:Number.isInteger(facts.failureSharedReadbackCount)
        ?Math.max(0,Math.min(100,facts.failureSharedReadbackCount)):0,
      failureSharedPayloadCompared:facts.failureSharedPayloadCompared===true,
      failureSharedPayloadStatusMatches:facts.failureSharedPayloadStatusMatches===true,
      failureSharedPayloadAttemptTimeMatches:facts.failureSharedPayloadAttemptTimeMatches===true,
      failureSharedPayloadErrorCodeMatches:facts.failureSharedPayloadErrorCodeMatches===true,
      failureSharedPayloadReadableReasonMatches:facts.failureSharedPayloadReadableReasonMatches===true,
      failureSharedWriterStage:/^(?:not_started|id_lookup|upsert|readback_compare)$/u.test(facts.failureSharedWriterStage||'')
        ?facts.failureSharedWriterStage:'unknown',
      lastSuccessPreserved:facts.lastSuccessPreserved,sourcePreserved:facts.sourcePreserved,
      sameCreatorIdReadback:facts.sameCreatorIdReadback,nonContactFieldsUnchanged:facts.nonContactFieldsUnchanged,
      humanFieldsUnchanged:facts.humanFieldsUnchanged,contactValueEmitted:false},
    completedAt:new Date().toISOString()};
}

export function buildSafeB2ReadbackReconciliation({previousReceipt,result,facts}) {
  const receipt=result?.receipt||{};
  const search=receipt.searchDiagnostics||{};
  const response=receipt.responseEvidence||{};
  const freshIdentityProof=receipt.identityProof==='API_FEED_ID_MATCH'&&
    receipt.formalIdMatch===true&&receipt.profileOpened===true&&receipt.sameContext===true&&
    receipt.samePage===true&&search.submittedAfterActivation===true&&
    search.exactIdMatchCount===1&&search.uidPresent===true&&search.failureBranch==='passed';
  const browserValueProof=receipt.status==='completed'&&receipt.wechatRowUnique===true&&
    receipt.revealed===true&&receipt.labelMatched===true&&receipt.nonMaskedValue===true&&
    receipt.finalBackgroundGuard===true&&receipt.errorFree===true&&receipt.authFailureSeen===false&&
    response.authPromptLatched!==true&&response.explicitAuthResponseCount===0;
  const verification=Object.fromEntries([
    'recordMappingVerified','sameCreatorIdReadback','wechatValueMatched','currentAttemptMatchesOriginalRun',
    'sourceIsBuyinProfile','storedSourceUidMatchesFreshPage','nonContactFieldsUnchanged',
    'humanFieldsUnchanged','readOnlyComparisonInvoked','externalWritePerformed','comparisonCompleted',
  ].map(name=>[name,facts?.[name]===true]));
  const priorRunValid=previousReceipt?.creatorId===CREATOR_ID&&
    previousReceipt?.recordAlias==='candidate_record_1'&&
    previousReceipt?.status==='verification_incomplete'&&
    previousReceipt?.browser?.reason==='CONTACT_PATCH_FAILED'&&
    previousReceipt?.write?.writerInvoked===true&&
    previousReceipt?.write?.sharedWriterReadbackVerified!==true&&
    previousReceipt?.write?.postReadbackVerified!==true;
  const priorSearch=previousReceipt?.browser?.searchDiagnostics||{};
  const priorRunIdentityProof=previousReceipt?.browser?.identityProof==='API_FEED_ID_MATCH'&&
    previousReceipt?.browser?.formalIdMatch===true&&previousReceipt?.browser?.profileOpened===true&&
    previousReceipt?.browser?.wechatRowUnique===true&&previousReceipt?.browser?.revealed===true&&
    previousReceipt?.browser?.nonMaskedValue===true&&previousReceipt?.browser?.finalBackgroundGuard===true&&
    previousReceipt?.browser?.errorFree===true&&priorSearch.submittedAfterActivation===true&&
    priorSearch.exactIdMatchCount===1&&priorSearch.uidPresent===true&&priorSearch.failureBranch==='passed';
  const success=priorRunValid&&freshIdentityProof&&browserValueProof&&
    priorRunIdentityProof&&
    verification.recordMappingVerified&&verification.sameCreatorIdReadback&&
    verification.wechatValueMatched&&verification.currentAttemptMatchesOriginalRun&&
    verification.sourceIsBuyinProfile&&
    verification.nonContactFieldsUnchanged&&verification.humanFieldsUnchanged&&
    verification.readOnlyComparisonInvoked&&verification.comparisonCompleted&&
    !verification.externalWritePerformed;
  return {mode:'one_creator_original_background_readback_reconciliation',creatorId:CREATOR_ID,
    recordAlias:'candidate_record_1',recordId:EXPECTED_RECORD_ID,
    identityBasis:'stable_creator_id',
    route:{profile:FEISHU_ROUTE.profile,as:FEISHU_ROUTE.as},
    status:success?'readback_reconciled_after_commit':'verification_incomplete',
    previousRun:{status:previousReceipt?.status||'unknown',reason:previousReceipt?.browser?.reason||'',
      originalWriterReadbackVerified:previousReceipt?.write?.sharedWriterReadbackVerified===true&&
        previousReceipt?.write?.postReadbackVerified===true,identityLinkVerified:priorRunIdentityProof},
    freshBrowser:{status:receipt.status||'unknown',stage:receipt.stage||'unknown',reason:receipt.reason||'',
      identityProof:receipt.identityProof==='API_FEED_ID_MATCH'?'API_FEED_ID_MATCH':'',
      sameContext:receipt.sameContext===true,samePage:receipt.samePage===true,
      formalIdMatch:receipt.formalIdMatch===true,profileOpened:receipt.profileOpened===true,
      wechatRowUnique:receipt.wechatRowUnique===true,revealed:receipt.revealed===true,
      labelMatched:receipt.labelMatched===true,nonMaskedValue:receipt.nonMaskedValue===true,
      authFailureSeen:receipt.authFailureSeen===true,finalBackgroundGuard:receipt.finalBackgroundGuard===true,
      errorFree:receipt.errorFree===true,
      searchDiagnostics:safeSearchDiagnostics(receipt.searchDiagnostics),
      responseEvidence:safeResponseEvidence(receipt.responseEvidence)},
    verification:{...verification,freshIdentityProof,browserValueProof,
      contactValueEmitted:false,rawUidEmitted:false,digestEmitted:false},
    externalWritePerformed:false,completedAt:new Date().toISOString()};
}

export function buildReviewedB2RecoveryReceipt({previousReceipt,reconciliationReceipt,reviewedAt=new Date().toISOString()}) {
  const priorSearch=previousReceipt?.browser?.searchDiagnostics||{};
  const priorIdentity=previousReceipt?.browser?.identityProof==='API_FEED_ID_MATCH'&&
    previousReceipt?.browser?.formalIdMatch===true&&previousReceipt?.browser?.profileOpened===true&&
    previousReceipt?.browser?.wechatRowUnique===true&&previousReceipt?.browser?.revealed===true&&
    previousReceipt?.browser?.nonMaskedValue===true&&previousReceipt?.browser?.finalBackgroundGuard===true&&
    previousReceipt?.browser?.errorFree===true&&priorSearch.submittedAfterActivation===true&&
    priorSearch.exactIdMatchCount===1&&priorSearch.uidPresent===true&&priorSearch.failureBranch==='passed';
  const verification=reconciliationReceipt?.verification||{};
  const priorWriteFailed=previousReceipt?.creatorId===CREATOR_ID&&
    previousReceipt?.recordAlias==='candidate_record_1'&&previousReceipt?.status==='verification_incomplete'&&
    previousReceipt?.browser?.reason==='CONTACT_PATCH_FAILED'&&previousReceipt?.write?.writerInvoked===true&&
    previousReceipt?.write?.sharedWriterReadbackVerified!==true&&previousReceipt?.write?.postReadbackVerified!==true;
  const freshIdentity=verification.freshIdentityProof===true&&reconciliationReceipt?.freshBrowser?.identityProof==='API_FEED_ID_MATCH'&&
    reconciliationReceipt?.freshBrowser?.formalIdMatch===true&&
    reconciliationReceipt?.freshBrowser?.searchDiagnostics?.exactIdMatchCount===1&&
    reconciliationReceipt?.freshBrowser?.searchDiagnostics?.uidPresent===true;
  const browserValue=verification.browserValueProof===true&&reconciliationReceipt?.freshBrowser?.status==='completed'&&
    reconciliationReceipt?.freshBrowser?.finalBackgroundGuard===true&&
    reconciliationReceipt?.freshBrowser?.errorFree===true;
  const sameIdReadback=['recordMappingVerified','sameCreatorIdReadback','wechatValueMatched',
    'currentAttemptMatchesOriginalRun','sourceIsBuyinProfile','nonContactFieldsUnchanged',
    'humanFieldsUnchanged','readOnlyComparisonInvoked','comparisonCompleted']
    .every(name=>verification[name]===true);
  const noWrite=verification.externalWritePerformed===false&&reconciliationReceipt?.externalWritePerformed===false;
  const success=priorWriteFailed&&priorIdentity&&freshIdentity&&browserValue&&sameIdReadback&&noWrite;
  return {...reconciliationReceipt,identityBasis:'stable_creator_id',
    status:success?'readback_reconciled_after_commit':'verification_incomplete',
    previousRun:{...reconciliationReceipt?.previousRun,identityLinkVerified:priorIdentity,
      status:previousReceipt?.status||'unknown',reason:previousReceipt?.browser?.reason||'',
      originalWriterReadbackVerified:previousReceipt?.write?.sharedWriterReadbackVerified===true&&
        previousReceipt?.write?.postReadbackVerified===true},
    verification:{...verification,storedSourceUidMatchesFreshPage:verification.storedSourceUidMatchesFreshPage===true,
      originalAttemptSourceExactReadback:'not_retroactively_verified',
      crossRunSourceUidDifferenceIsNotAnIdentityGate:success},
    revision:{reviewedAt,reason:'Independent reviewer confirmed each run must bind the stable creator ID to that run’s exact result UID; cross-run UID string equality is informational.',
      derivedFrom:'koc-contact-b2-LEGACY_REVIEWED_CREATOR_DISABLED-20260924.json and koc-contact-b2-LEGACY_REVIEWED_CREATOR_DISABLED-20260924-reconciliation.json',
      originalFailureReceiptPreserved:true,originalRecoveryReceiptPreserved:true},
    externalWritePerformed:false,contactValueEmitted:false,rawUidEmitted:false,digestEmitted:false};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(async error=>{
  const allowed=new Set(['FEISHU_AUTH_NOT_VERIFIED','B2_SCHEMA_MISMATCH','B2_SOURCE_CHECKPOINT_UNVERIFIED',
    'B2_SOURCE_MANIFEST_UNVERIFIED','B2_CREATOR_OUTSIDE_APPROVED_LIST','B2_RECORD_MAPPING_UNVERIFIED',
    'B2_RECORD_ID_READBACK_MISMATCH','B2_TARGET_CONTACT_NOT_EMPTY',
    'B2_CREATOR_ID_READBACK_MISMATCH','B2_RECORD_PROJECTION_INVALID',
    'B2_DETAIL_TEMPLATE_INVALID','B2_DETAIL_TEMPLATE_UNAVAILABLE','ORIGINAL_BACKGROUND_SESSION_NOT_OPEN',
    'ORIGINAL_BACKGROUND_PERSISTENCE_UNVERIFIED']);
  const message=String(error?.message||'');
  const prefix=message.split(':',1)[0];
  const reason=allowed.has(message)?message:
    (/^(?:B2|LARK|KOC)_[A-Z0-9_]+$/u.test(prefix)?prefix:'B2_PREFLIGHT_FAILED');
  const errorType=['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError'].includes(error?.name)
    ?error.name:'OTHER';
  const output={mode:'one_creator_original_background_feishu_write',status:'preflight_failed',phase:currentPhase,reason,
    errorType,authPreflight:authPreflightSummary,externalWritePerformed:false,contactValueEmitted:false};
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode=1;
});
