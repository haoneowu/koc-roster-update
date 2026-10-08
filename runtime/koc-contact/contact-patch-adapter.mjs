import {patchContactRecord} from '../koc-roster/lark-writer.mjs';
import {formatLarkDateTime, normalizeText} from '../koc-roster/roster-domain.mjs';

export const CONTACT_PATCH_TARGET_CREATOR_ID = 'LEGACY_TARGET_DISABLED';

const FAILURE_STATUSES = new Set(['not_found', 'not_shown', 'login_required', 'captcha', 'error', 'forbidden_by_platform']);
const FIXED_ERROR_CODES = new Set([
  'AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_OR_PERMISSION_UNRESOLVED', 'RESPONSE_EVIDENCE_INCOMPLETE',
  'RESPONSE_ERROR_UNCLASSIFIED', 'PAGE_NOT_READY', 'MENU_PERMISSION_DENIED',
  'SECURITY_CHALLENGE', 'TARGET_SEARCH_UNVERIFIED', 'TARGET_SEARCH_AMBIGUOUS', 'TARGET_PAGE_AMBIGUOUS',
  'WECHAT_NOT_PROVIDED',
  'CONTACT_MARKER_UNRESOLVED', 'CONTACT_LABEL_NOT_PRESENT', 'CONTACT_CATEGORY_RESTRICTED',
  'REVEAL_UNCONFIRMED', 'CONTACT_VALUE_MISSING', 'TARGET_PAGE_CLOSED', 'POPUP_NOT_OPENED',
  'BACKGROUND_GUARD_FAILED','BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE',
  'BACKGROUND_PAGE_SET_CHANGED','BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED',
  'BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED','BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
  'DETAIL_LINK_NOT_UNIQUE','DETAIL_LINK_NOT_VERIFIED','DETAIL_NOT_OPENED',
  'WECHAT_ROW_NOT_READY','WECHAT_ROW_NOT_UNIQUE','REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE',
  'EXECUTION_CONTEXT_CHANGED','BROWSER_CLOSE_FAILED','INVALID_ARGUMENTS','INVALID_DETAIL_TEMPLATE',
  'TOTAL_TIMEOUT', 'TIMEOUT', 'BROWSER_ERROR', 'RECEIPT_WRITE_FAILED',
  'KOC_CONTACT_LIST_EVIDENCE_REQUIRED', 'UNKNOWN_ERROR',
]);

function normalizedStatus(attempt) {
  return normalizeText(attempt?.contactStatus ?? attempt?.status)
    .toLocaleLowerCase('en-US').replaceAll('-', '_');
}

function requiredTimestamp(value) {
  const timestamp=normalizeText(value);
  if (!timestamp) throw new Error('KOC_CONTACT_ATTEMPT_TIME_REQUIRED');
  // A plain Lark datetime is a China-local wall time. Pin the timezone before
  // parsing so another machine timezone cannot shift it during reconciliation.
  const localMatch=timestamp.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}(?:\.\d{1,3})?))?$/u);
  const parseable=localMatch
    ?`${localMatch[1]}T${localMatch[2]}:${localMatch[3]?.split('.')[0]??'00'}+08:00`
    :timestamp;
  return formatLarkDateTime(parseable);
}

function verifiedBuyinSource(value) {
  const source = normalizeText(value);
  if (!source) throw new Error('KOC_CONTACT_SOURCE_REQUIRED');
  let url;
  try { url = new URL(source); } catch { throw new Error('KOC_CONTACT_SOURCE_INVALID'); }
  if (url.protocol !== 'https:' || url.hostname !== 'buyin.jinritemai.com') {
    throw new Error('KOC_CONTACT_SOURCE_INVALID');
  }
  return url.toString();
}

function fixedErrorCode(status, rawReason) {
  if (status === 'not_found') return 'TARGET_NOT_FOUND';
  if (status === 'not_shown') {
    const reason=normalizeText(rawReason);
    return ['CONTACT_LABEL_NOT_PRESENT','WECHAT_NOT_PROVIDED'].includes(reason)
      ?reason:'CONTACT_NOT_SHOWN';
  }
  if (status === 'login_required') return 'AUTH_REQUIRED';
  if (status === 'captcha') return 'SECURITY_CHALLENGE';
  if(status==='forbidden_by_platform'&&rawReason!=='CONTACT_CATEGORY_RESTRICTED')throw new Error('KOC_CONTACT_ATTEMPT_STATUS_INVALID');
  const reason = normalizeText(rawReason);
  return FIXED_ERROR_CODES.has(reason) ? reason : 'UNKNOWN_ERROR';
}

const FAILURE_CAUSE_TEXT=Object.freeze({
  EXPLICIT_AUTH_SIGNAL:'已观察到明确认证或权限信号',
  RISK_SIGNAL:'已观察到安全验证信号',
  RESPONSE_INSPECTION_GAP:'未观察到明确认证拒绝，响应证据不完整，根因待查',
  UNCLASSIFIED_RESPONSE:'服务响应错误尚未分类，根因待查',
  PAGE_NOT_READY:'业务页就绪条件未满足，根因待查',
  BACKGROUND_GUARD:'后台可见性保护触发，根因待查',
  REVEAL_UNCONFIRMED:'未能验证联系方式已展开；这不代表没有联系方式，根因待查',
  TOOL_FAILURE:'浏览器工具步骤失败，根因待查',
  PAGE_STATE_UNRESOLVED:'页面身份或路由证据不足，不据此判定登录失效，根因待查',
  UNKNOWN:'目前证据不足以确认根因',
});

function safeCount(value) {
  const count=Number(value);
  return Number.isInteger(count)&&count>=0&&count<=100000?count:0;
}

function safeBool(value) { return value===true?'是':'否'; }

export function formatContactFailureNote(note) {
  if(!note||typeof note!=='object'||Array.isArray(note))return '';
  const stage=/^[a-z][a-z0-9-]{0,31}$/u.test(String(note.stage||''))?note.stage:'unknown';
  const code=FIXED_ERROR_CODES.has(note.diagnosticCode)?note.diagnosticCode:'UNKNOWN_ERROR';
  const observation=note.observation&&typeof note.observation==='object'?note.observation:{};
  const observedResponses=safeCount(observation.observedResponseCount);
  const jsonResponses=safeCount(observation.jsonResponseCount);
  const inspectedJson=safeCount(observation.inspectedJsonResponseCount);
  const uninspected=safeCount(observation.uninspectedJsonCount);
  const unknown=safeCount(observation.unknownErrorCount);
  const explicitAuth=safeCount(observation.explicitAuthResponseCount);
  const responseText=observation.responseEvidenceObserved===true
    ?`观察响应=${observedResponses}，JSON响应=${jsonResponses}，已检查JSON=${inspectedJson}，未检查JSON=${uninspected}，未分类响应=${unknown}`
    :'响应计数=未取得';
  const authText=observation.responseEvidenceObserved===true
    ?`认证提示=${safeBool(observation.authPromptLatched)}，显式认证响应=${explicitAuth}`
    :'认证响应计数=未取得';
  const searchText=observation.searchDiagnosticsObserved===true
    ?`搜索提交=${safeBool(observation.searchSubmitted)}，feed请求=${safeCount(observation.feedRequestCount)}`
    :'搜索/feed观察=未取得';
  const tail=[
    `眼睛激活=${safeCount(observation.eyeActivationCount)}`,
    `点击尝试=${safeCount(observation.clickAttemptCount)}`,
    `展开状态=${observation.revealDiagnosticsObserved===true&&['masked','unresolved','nonmasked'].includes(observation.finalRevealState)
      ?observation.finalRevealState:'not_observed'}`,
    `后台守卫=${observation.guardDiagnosticsObserved===true
      ?(/^[A-Z0-9_]{0,64}$/u.test(String(observation.guardReason||''))?(observation.guardReason||'未触发'):'未触发')
      :'未取得'}`,
    `工具错误类型=${['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER'].includes(observation.runtimeErrorType)
      ?observation.runtimeErrorType:'未观察到'}`,
  ].join('，');
  const actual=`${responseText}，${authText}，${searchText}，${tail}`;
  const causeStatus=note.causeStatus==='confirmed'?'已证':'待验证';
  const cause=FAILURE_CAUSE_TEXT[note.causeCode]||FAILURE_CAUSE_TEXT.UNKNOWN;
  return `步骤=${stage}；诊断码=${code}；实际观察=${actual}；原因(${causeStatus})=${cause}。`;
}

/**
 * Convert one current, already validated contact attempt into the narrow B-field
 * patch accepted by koc-roster/lark-writer.mjs. Historical merged rows are not
 * accepted here: callers must pass the current attempt separately.
 */
export async function patchCurrentContactAttempt({
  creatorId,
  recordId,
  attempt,
  writer = patchContactRecord,
}) {
  const id = normalizeText(creatorId);
  const rid = normalizeText(recordId);
  if (!id) throw new Error('KOC_CONTACT_CREATOR_ID_REQUIRED');
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id)) throw new Error('KOC_CONTACT_CREATOR_ID_INVALID');
  if (!rid) throw new Error('KOC_CONTACT_RECORD_ID_REQUIRED');
  if (typeof writer !== 'function') throw new Error('KOC_CONTACT_WRITER_REQUIRED');

  const status = normalizedStatus(attempt);
  const attemptedAt = requiredTimestamp(attempt?.contactCheckedAt ?? attempt?.lastContactAttemptAt);
  let fields;

  if (status === 'found') {
    const contactValue = normalizeText(attempt?.contactValue);
    if (!contactValue) throw new Error('KOC_CONTACT_VERIFIED_VALUE_REQUIRED');
    const source = verifiedBuyinSource(attempt?.contactSourceUrl ?? attempt?.sourceUrl);
    fields = {
      '本次联系方式状态': 'found',
      '联系方式最近尝试': attemptedAt,
      '联系方式最近成功': attemptedAt,
      '联系方式最近错误': '',
      '联系方式来源': source,
      '微信号': contactValue,
    };
  } else {
    if (!FAILURE_STATUSES.has(status)) throw new Error('KOC_CONTACT_ATTEMPT_STATUS_INVALID');
    fields = {
      '本次联系方式状态': status,
      '联系方式最近尝试': attemptedAt,
      '联系方式最近错误': formatContactFailureNote(attempt?.failureNote) || fixedErrorCode(status, attempt?.errorReason),
    };
  }

  return writer({creatorId:id, recordId:rid, fields});
}
