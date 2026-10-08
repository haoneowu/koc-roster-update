import {safeReadFailure} from '../koc-roster/async-read-client.mjs';
import {buildDailyAddContactManifest} from './daily-add-contact-batch.mjs';
import {CONTACT_PATCH_ALLOWLIST, normalizeText} from '../koc-roster/roster-domain.mjs';
import {FEISHU_ROUTE, listRosterIndex, patchContactRecord} from '../koc-roster/lark-writer.mjs';
import {patchCurrentContactAttempt} from './contact-patch-adapter.mjs';
import {isMaskedContactValue} from './contact-reveal-state.mjs';
import {BUYIN_SEARCH_FAILURE_BRANCHES,safeOpenDetailDiagnostics,safeRevealDiagnostics} from './buyin-contact-flow.mjs';
import {ORIGINAL_BATCH_ID, validateCanaryManifest} from './canary-batch.mjs';
import {
  exactContactCellEquals, exactNullableSourceCellEquals, exactNullableTextCellEquals, exactSourceCellEquals,
  exactTextCellEquals, sameCell,
} from './run-original-background-feishu-write.mjs';

const contexts = new WeakMap();
const consumedContexts = new WeakSet();
let centralWriterActive = false;

const CONTACT_FIELDS = new Set(CONTACT_PATCH_ALLOWLIST);
const PATCHED_CONTACT_FIELDS = new Set([
  '微信号', '本次联系方式状态', '联系方式最近尝试', '联系方式最近成功', '联系方式最近错误', '联系方式来源',
]);
const PRESERVE_ON_FAILURE = Object.freeze(['微信号', '联系方式最近成功', '联系方式来源']);
const REQUIRED_FIELD_NAMES = Object.freeze([
  'Text', '抖音号', '微信号', '本次联系方式状态', '联系方式最近尝试',
  '联系方式最近成功', '联系方式最近错误', '联系方式来源', '商务跟进状态', '商务备注',
]);
const TYPE_ALIASES = Object.freeze({
  Text: new Set(['text', '1']),
  抖音号: new Set(['text', '1']),
  微信号: new Set(['text', '1']),
  本次联系方式状态: new Set(['text', '1', 'single_select', 'singleselect', '3', 'select']),
  联系方式最近尝试: new Set(['datetime', 'date', '5']),
  联系方式最近成功: new Set(['datetime', 'date', '5']),
  联系方式最近错误: new Set(['text', '1']),
  联系方式来源: new Set(['url', 'text', '17', '1']),
});

const SAFE_FAILURE_REASONS = new Set([
  'CONTACT_VALUE_VERIFIED','ERROR_QUERY_UNVERIFIED','TARGET_NOT_FOUND', 'CONTACT_NOT_SHOWN', 'CONTACT_LABEL_NOT_PRESENT', 'CONTACT_CATEGORY_RESTRICTED',
  'UNRECOGNIZED_TRANSIENT_NOTICE','WECHAT_NOT_PROVIDED', 'AUTH_REQUIRED', 'AUTH_EXPIRED',
  'AUTH_OR_PERMISSION_UNRESOLVED','RESPONSE_EVIDENCE_INCOMPLETE','RESPONSE_ERROR_UNCLASSIFIED','PAGE_NOT_READY','BUSINESS_ROUTE_UNEXPECTED',
  'MENU_PERMISSION_DENIED', 'SECURITY_CHALLENGE', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'BROWSER_ERROR',
  'BROWSER_CLOSE_FAILED', 'CONTACT_PATCH_FAILED', 'CONTACT_PATCH_READBACK_FAILED', 'CONTACT_VALUE_MISSING',
  'TARGET_SEARCH_UNVERIFIED', 'TARGET_SEARCH_AMBIGUOUS', 'TARGET_PAGE_AMBIGUOUS', 'CONTACT_MARKER_UNRESOLVED',
  'DETAIL_LINK_NOT_VERIFIED', 'DETAIL_NOT_OPENED', 'TARGET_PAGE_CLOSED', 'BACKGROUND_TARGET_CONTEXT_MISMATCH',
  'BACKGROUND_TARGET_VISIBLE', 'BACKGROUND_PAGE_SET_CHANGED', 'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED',
  'BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED', 'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED',
  'BACKGROUND_TARGET_CLOSED', 'EXECUTION_CONTEXT_CHANGED', 'REVEAL_CONTROL_NOT_UNIQUE',
  'REVEAL_CONTROL_NOT_ACTIONABLE', 'REVEAL_UNCONFIRMED', 'UNKNOWN_ERROR',
]);
const SAFE_WRITER_CODES = new Set([
  'LARK_READBACK_MISMATCH', 'LARK_CLI_FAILED', 'LARK_EMPTY_RESPONSE', 'LARK_RESPONSE_NOT_JSON',
  'LARK_WRITE_OUTCOME_UNKNOWN', 'KOC_CONTACT_CREATOR_AND_RECORD_ID_REQUIRED', 'KOC_CONTACT_FIELD_NOT_ALLOWED',
  'KOC_CONTACT_SUCCESS_REQUIRES_VALUE_TIME_AND_SOURCE', 'KOC_CONTACT_SOURCE_INVALID', 'KOC_CONTACT_SOURCE_REQUIRED',
  'KOC_CONTACT_ATTEMPT_TIME_REQUIRED', 'KOC_CONTACT_VERIFIED_VALUE_REQUIRED', 'KOC_CONTACT_FAILURE_STATUS_INVALID',
  'KOC_CONTACT_FAILURE_CANNOT_CHANGE_SUCCESS_FIELD', 'KOC_CONTACT_FAILURE_REQUIRES_ATTEMPT_TIME',
  'KOC_CONTACT_RECORD_CREATOR_MISMATCH', 'KOC_CREATOR_WRITE_LOCK_TIMEOUT',
  'KOC_CONTACT_NULL_OR_UNDEFINED_VALUE',
]);
const SAFE_PARALLEL_CODES = new Set([
  'PARALLEL_WRITER_TARGET_MISMATCH', 'PARALLEL_PATCH_SCOPE_INVALID', 'PARALLEL_PREWRITE_READ_FAILED',
  'PARALLEL_PREWRITE_IDENTITY_MISMATCH', 'PARALLEL_PROTECTED_FIELDS_CHANGED', 'PARALLEL_PRIOR_CONTACT_CHANGED',
  'PARALLEL_SHARED_READBACK_UNVERIFIED', 'PARALLEL_PATCH_NOT_STARTED', 'PARALLEL_RECORD_PROJECTION_INVALID',
]);
const SAFE_CAPTURE_STAGES=new Set(['auth-check','id-search','open-detail','reveal','final-guard','complete',
  'driver-init','flow','wave-guard','wave-worker']);
const SAFE_SEARCH_EXECUTION_PHASES=new Set(['argument_validation','page_guard','control_lookup','input_fill',
  'button_readiness','activation_guard','click_dispatch','response_wait','response_validation','visible_result','detail_link']);
const SAFE_SEARCH_EXCEPTION_CATEGORIES=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
const SAFE_RUNTIME_ERROR_TYPES=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']);
const SAFE_PAGE_GUARD_REASONS=new Set(['PAGE_CONTEXT_CHANGED','PAGE_SET_UNAVAILABLE','PAGE_SET_CHANGED','PAGE_BINDING_CHANGED',
  'PAGE_STATE_UNAVAILABLE','WORKER_PAGE_VISIBLE','WORKER_PAGE_ROUTE_OR_ACCOUNT_CHANGED',
  'WORKER_PAGE_AUTH_RISK_OR_CONTEXT_CHANGED','PAGE_GUARD_ARGUMENTS_INVALID','UNOWNED_PAGE_CHANGED',
  'PAGE_CONTEXT_UNAVAILABLE','PAGE_CONTEXT_MISMATCH','PAGE_NOT_HIDDEN','PAGE_ACCOUNT_OR_ROUTE_UNVERIFIED',
  'PAGE_AUTH_RISK_OR_CONTEXT_UNVERIFIED','PAGE_SNAPSHOT_ARGUMENTS_INVALID','PAGE_SNAPSHOT_UNAVAILABLE',
  'PAGE_BINDINGS_INVALID','LOCATOR_PAGE_UNAVAILABLE','LOCATOR_PAGE_MISMATCH']);

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/u;
const safeCode = value => typeof value === 'string' && SAFE_CODE.test(value) ? value : 'UNKNOWN_ERROR';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(code) {
  throw new Error(`PARALLEL_${code}`);
}

function textCell(value) {
  let current = value;
  for (let depth = 0; depth < 6; depth += 1) {
    if (Array.isArray(current)) {
      current = current.map(item => {
        if (!isObject(item)) return item ?? '';
        return item.text ?? item.value ?? item.name ?? '';
      }).join(', ');
      continue;
    }
    if (isObject(current)) {
      if ('value' in current) { current = current.value; continue; }
      if ('text' in current) { current = current.text; continue; }
      if ('name' in current) { current = current.name; continue; }
    }
    break;
  }
  return normalizeText(current);
}

function recordProjection(payload) {
  const data = payload?.data ?? payload;
  if (Array.isArray(data?.data) && Array.isArray(data?.fields)) {
    const row = data.data[0] || [];
    return {recordId: data.record_id_list?.[0] ?? '',
      fields: Object.fromEntries(data.fields.map((name, index) => [name, row[index] ?? null]))};
  }
  if (data?.record?.fields) return {recordId: data.record.record_id ?? data.record.recordId ?? '', fields: data.record.fields};
  if (data?.fields && !Array.isArray(data.fields)) return {recordId: data.record_id ?? data.recordId ?? '', fields: data.fields};
  throw new Error('PARALLEL_RECORD_PROJECTION_INVALID');
}

function fieldList(schema) {
  const payload = schema?.data ?? schema;
  const values = Array.isArray(payload) ? payload :
    Array.isArray(payload?.fields) ? payload.fields :
      Array.isArray(payload?.items) ? payload.items : null;
  if (!values) fail('SCHEMA_UNVERIFIED');
  const fields = [];
  const seen = new Set();
  for (const value of values) {
    const name = typeof value === 'string' ? value : String(value?.field_name ?? value?.name ?? '');
    if (!name || seen.has(name)) fail('SCHEMA_INVALID');
    seen.add(name);
    fields.push({name, multiple:value?.multiple, type: typeof value === 'string' ? '' : String(value?.type ?? value?.field_type ?? value?.type_name ?? '').toLowerCase()});
  }
  for (const name of REQUIRED_FIELD_NAMES) if (!seen.has(name)) fail('SCHEMA_REQUIRED_FIELD_MISSING');
  const byName = new Map(fields.map(field => [field.name, field]));
  for (const [name, accepted] of Object.entries(TYPE_ALIASES)) {
    const actual = byName.get(name)?.type;
    if (name==='本次联系方式状态'&&actual==='select'&&byName.get(name).multiple!==false) fail('SCHEMA_REQUIRED_FIELD_TYPE_MISMATCH');
    if (actual && !accepted.has(actual)) fail('SCHEMA_REQUIRED_FIELD_TYPE_MISMATCH');
  }
  return fields;
}

function assertManifest(manifest) {
  try { validateCanaryManifest(manifest); }
  catch { fail('MANIFEST_INVALID'); }
  if (manifest?.version !== 1 || manifest?.sourceBatchId !== ORIGINAL_BATCH_ID ||
      !Array.isArray(manifest.targets) || manifest.targets.length !== 500) fail('MANIFEST_INVALID');
  const creatorIds = new Set();
  const recordIds = new Set();
  const sourceRanks = new Set();
  for (const target of manifest.targets) {
    if (!target || typeof target.creatorId !== 'string' || !target.creatorId.trim() ||
        typeof target.recordId !== 'string' || !target.recordId.trim() ||
        !Number.isInteger(target.sourceRank) || target.sourceRank < 1 ||
        creatorIds.has(target.creatorId) || recordIds.has(target.recordId) || sourceRanks.has(target.sourceRank)) {
      fail('MANIFEST_INVALID');
    }
    creatorIds.add(target.creatorId);
    recordIds.add(target.recordId);
    sourceRanks.add(target.sourceRank);
  }
}

function verifierMatches(value, target, sourceBatchId) {
  if (value === true) return true;
  return value?.verified === true && value.creatorId === target.creatorId &&
    value.recordId === target.recordId && value.sourceBatchId === sourceBatchId &&
    value.sourceRank === target.sourceRank;
}

function canonical(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function cellsMatch(name, actual, expected) {
  if (name === '微信号') {
    return typeof expected === 'string' && expected.length > 0
      ? exactContactCellEquals(actual, expected)
      : exactNullableTextCellEquals(actual, expected);
  }
  if (name === '联系方式来源') {
    return exactNullableSourceCellEquals(actual, expected);
  }
  return sameCell(name, actual, expected);
}

function exactProtectedMatch(fields, baseline, names) {
  return names.every(name => cellsMatch(name, fields?.[name], baseline[name]));
}

function identityVerifiedAuth(authContext) {
  const profile = authContext?.profile ?? authContext?.route?.profile;
  const as = authContext?.as ?? authContext?.identity ?? authContext?.route?.as;
  const host = authContext?.host ?? authContext?.route?.host;
  return authContext?.verifiedUser === true && profile === FEISHU_ROUTE.profile && as === FEISHU_ROUTE.as &&
    host === FEISHU_ROUTE.host;
}

function clearAttemptSecrets(capture) {
  const attempt = capture?.attempt;
  if (!attempt || typeof attempt !== 'object') return;
  for (const key of ['contactValue', 'contactSourceUrl']) {
    try { attempt[key] = ''; } catch { /* The caller may have frozen the capture. */ }
  }
}

function receiptFor(result, context, details = {}) {
  const failureExpected = details.failureExpected && typeof details.failureExpected === 'object'
    ? Object.freeze({
        status: ['not_found', 'not_shown', 'login_required', 'captcha', 'error', 'forbidden_by_platform'].includes(details.failureExpected.status)
          ? details.failureExpected.status : 'error',
        checkedAt: typeof details.failureExpected.checkedAt === 'string' &&
          /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/u.test(details.failureExpected.checkedAt)
          ? details.failureExpected.checkedAt : '',
        errorReason: safeFailureReason(details.failureExpected.errorReason),
        actualStoredError: details.failureExpected.actualStoredError === '' ? '' :
          safeFailureReason(details.failureExpected.actualStoredError),
      }) : null;
  return Object.freeze({
    mode: 'parallel_production_contact_write',
    route: Object.freeze({host: FEISHU_ROUTE.host, profile: FEISHU_ROUTE.profile, as: FEISHU_ROUTE.as}),
    creatorId: context.creatorId,
    recordId: context.recordId,
    sourceBatchId: context.sourceBatchId,
    sourceRank: context.sourceRank,
    attemptId: context.attemptId,
    outcome: result.outcome,
    writeState: result.writeState,
    reason: result.reason,
    sourceMemberVerified: details.sourceMemberVerified === true,
    currentIndexVerified: details.currentIndexVerified === true,
    recordMappingVerified: details.recordMappingVerified === true,
    baselineFieldCount: context.baselineFieldCount,
    hadWeChatBefore: context.hadWeChatBefore,
    writerInvoked: details.writerInvoked === true,
    writeSubmitted: details.writeSubmitted === true,
    sharedWriterReadbackVerified: details.sharedWriterReadbackVerified === true,
    sharedWriterStage: details.sharedWriterStage || 'not_started',
    sharedWriterErrorCode: details.sharedWriterErrorCode || '',
    outerReadbackVerified: details.outerReadbackVerified === true,
    sameRecordReadback: details.sameRecordReadback === true,
    sameCreatorIdReadback: details.sameCreatorIdReadback === true,
    protectedFieldsUnchanged: details.protectedFieldsUnchanged === true,
    oldContactPreserved: details.oldContactPreserved === true,
    channelDiagnostics: safeChannelDiagnostics(details.channelDiagnostics),
    patchFieldCount: Number.isInteger(details.patchFieldCount) ? details.patchFieldCount : 0,
    fieldReadbackMatches: Object.freeze({
      wechatValue: details.fieldReadbackMatches?.wechatValue === true,
      contactStatus: details.fieldReadbackMatches?.contactStatus === true,
      contactAttemptTime: details.fieldReadbackMatches?.contactAttemptTime === true,
      contactLastSuccess: details.fieldReadbackMatches?.contactLastSuccess === true,
      contactError: details.fieldReadbackMatches?.contactError === true,
      contactSource: details.fieldReadbackMatches?.contactSource === true,
    }),
    failureExpected,
    ...(details.captureValidationDiagnostics?{captureValidationDiagnostics:details.captureValidationDiagnostics}:{}),
    ...(details.captureExecutionDiagnostics?{captureExecutionDiagnostics:details.captureExecutionDiagnostics}:{}),
    recoveryMode: details.recoveryMode || '',
    contactValueEmitted: false,
    contactSourceUrlEmitted: false,
  });
}

function projectCaptureExecutionDiagnostics(capture){
  const receipt=capture?.receipt||{},guard=receipt.pageGuardDiagnostics||{},search=receipt.searchDiagnostics||{};
  const revealDiagnostics=receipt.revealDiagnosticsObserved===true
    ?safeRevealDiagnostics(receipt.revealDiagnostics):null;
  const boundedCount=value=>Number.isInteger(value)&&value>=0&&value<=100000?value:-1;
  const reason=SAFE_FAILURE_REASONS.has(receipt.reason)?receipt.reason:'UNKNOWN_ERROR';
  return Object.freeze({stage:SAFE_CAPTURE_STAGES.has(receipt.stage)?receipt.stage:'unknown',
    status:['completed','stopped'].includes(receipt.status)?receipt.status:'stopped',
    reason,
    runtimeErrorType:SAFE_RUNTIME_ERROR_TYPES.has(receipt.runtimeErrorType)?receipt.runtimeErrorType:
      reason==='BROWSER_ERROR'?'OTHER':'',
    pageGuardDiagnostics:{passed:guard.passed===true,
      reason:SAFE_PAGE_GUARD_REASONS.has(guard.reason)?guard.reason:'unknown',
      workerCount:Number.isInteger(guard.workerCount)&&guard.workerCount>=0&&guard.workerCount<=5?guard.workerCount:-1,
      pageCount:Number.isInteger(guard.pageCount)&&guard.pageCount>=0&&guard.pageCount<=100?guard.pageCount:-1},
    searchDiagnostics:{queryType:['ID','NICKNAME'].includes(search.queryType)?search.queryType:'ID',
      attemptCount:boundedCount(search.attemptCount),matchedRequestCount:boundedCount(search.matchedRequestCount),
      matchedResponseCount:boundedCount(search.matchedResponseCount),
      failureBranch:BUYIN_SEARCH_FAILURE_BRANCHES.includes(search.failureBranch)?search.failureBranch:'unknown',
      ...(SAFE_SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&
        SAFE_SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)
        ?{executionPhase:search.executionPhase,exceptionCategory:search.exceptionCategory}:{})},
    ...(safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)
      ?{openDetailDiagnostics:safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)}:{}),
    ...(revealDiagnostics?{revealDiagnostics}:{})});
}

function resultFor(context, outcome, writeState, reason, flags = {}) {
  return Object.freeze({
    attemptId: context.attemptId,
    outcome,
    writeState,
    reason: safeCode(reason),
    recordMappingVerified: flags.recordMappingVerified === true,
    readbackVerified: flags.readbackVerified === true,
    originalAttemptSourceVerified: flags.originalAttemptSourceVerified === true,
    protectedFieldsUnchanged: flags.protectedFieldsUnchanged === true,
    ...(outcome === 'success' ? {
      hadWeChatBefore: context.hadWeChatBefore,
      currentValueVerified: flags.currentValueVerified === true,
    } : {}),
  });
}

function invalidCapture(context, reason, capture=null) {
  const result = resultFor(context, 'error', 'not_written', reason);
  return {result, receipt: receiptFor(result, context,{...(capture?{
    captureValidationDiagnostics:captureValidationDiagnostics(capture,reason),
    captureExecutionDiagnostics:projectCaptureExecutionDiagnostics(capture)}:{})})};
}

function hasNoAuthEvidence(receipt) {
  const response = receipt?.responseEvidence || {};
  return receipt?.authFailureSeen !== true && response.authPromptLatched !== true &&
    response.explicitAuthResponseCount === 0;
}

function queryWasSuccessful(search, receipt) {
  return hasNoAuthEvidence(receipt) && receipt?.sameContext === true && receipt?.samePage === true &&
    search?.submittedAfterActivation === true &&
    Number.isInteger(search?.attemptCount) && search.attemptCount >= 1 && search.attemptCount <= 3 &&
    search?.matchedRequestCount === 1 && search?.matchedResponseCount === 1 &&
    search?.httpStatusCategory === '2xx' && search?.businessCodeCategory === 'zero';
}

function stableIdentitySearch(search) {
  return search?.exactIdMatchCount === 1 && search?.uidPresent === true &&
    ['UID', 'AWEME_ID', 'BOTH'].includes(search?.matchedIdentityKeyKind);
}

const CHANNEL_DIAGNOSTIC_FIELDS = Object.freeze([
  'contactItemCount', 'visibleContactItemCount', 'wechatLocatorCount', 'visibleWechatLocatorCount',
  'phoneLocatorCount', 'visiblePhoneLocatorCount', 'stableSamples',
]);
const CHANNEL_DIAGNOSTIC_PROOFS = Object.freeze([
  'profileUidConfirmed', 'contextStable', 'targetHidden', 'authHealthy',
]);
const MAX_CHANNEL_DIAGNOSTIC_VALUE = 10000;

function safeChannelDiagnostics(value) {
  if (!isObject(value) || value.observedReady !== true) return null;
  if (!CHANNEL_DIAGNOSTIC_PROOFS.every(name => value[name] === true)) return null;
  const counters = {};
  for (const name of CHANNEL_DIAGNOSTIC_FIELDS) {
    const count = value[name];
    if (!Number.isInteger(count) || count < 0 || count > MAX_CHANNEL_DIAGNOSTIC_VALUE) return null;
    counters[name] = count;
  }
  return Object.freeze({
    observedReady: true,
    profileUidConfirmed: true,
    contextStable: true,
    targetHidden: true,
    authHealthy: true,
    ...counters,
  });
}

function verifiedPhoneOnlyAbsence(capture, search, receipt) {
  const attempt = capture?.attempt || {};
  const diagnostics = safeChannelDiagnostics(receipt?.channelDiagnostics);
  if (attempt.errorReason !== 'WECHAT_NOT_PROVIDED' || receipt?.reason !== 'WECHAT_NOT_PROVIDED' || !diagnostics) return null;
  const {
    contactItemCount, visibleContactItemCount, wechatLocatorCount, visibleWechatLocatorCount,
    phoneLocatorCount, visiblePhoneLocatorCount, stableSamples,
  } = diagnostics;
  const allVisiblePhoneOnly = contactItemCount > 0 && contactItemCount === visibleContactItemCount &&
    contactItemCount === phoneLocatorCount && contactItemCount === visiblePhoneLocatorCount &&
    wechatLocatorCount === 0 && visibleWechatLocatorCount === 0 && stableSamples >= 3;
  const identityBoundProfile = receipt?.identityProof === 'API_FEED_ID_MATCH' &&
    receipt?.formalIdMatch === true && receipt?.profileOpened === true && stableIdentitySearch(search);
  return queryWasSuccessful(search, receipt) && ['ID', 'NICKNAME'].includes(search?.queryType) &&
    identityBoundProfile && allVisiblePhoneOnly ? diagnostics : null;
}

function verifiedCategoryRestriction(capture, search, receipt, reason) {
  if (reason !== 'CONTACT_CATEGORY_RESTRICTED' || receipt?.reason !== reason ||
      receipt?.status !== 'stopped' || receipt?.identityProof !== 'API_FEED_ID_MATCH' ||
      receipt?.formalIdMatch !== true || receipt?.profileOpened !== true ||
      receipt?.revealed === true || receipt?.nonMaskedValue === true || (receipt?.labelMatched !== true && receipt?.revealDiagnostics?.labelMatched !== true) ||
      !queryWasSuccessful(search, receipt) || !stableIdentitySearch(search) ||
      !['ID', 'NICKNAME'].includes(search?.queryType) || search?.contactMarkerState !== 'present' ||
      search?.failureBranch !== 'passed') return false;
  const reveal = receipt?.revealDiagnostics;
  if (reveal?.failureBranch !== 'contact_category_restricted' || reveal?.finalState !== 'masked' ||
      !Array.isArray(reveal?.attemptSignals)) return false;
  return reveal.attemptSignals.some(signal => signal?.clickEventObserved === true && signal?.domState === 'masked' &&
    Array.isArray(signal?.transientFeedbackEvents) && signal.transientFeedbackEvents.some(event =>
      event?.category === 'contact_category_restricted' && event?.afterAction === true &&
      event?.targetBound === true && Number.isInteger(event?.elapsedMs) && event.elapsedMs >= 0 &&
      event.elapsedMs <= 30_000));
}

function successProofAssessment(capture) {
  if (!isObject(capture)) return {status:'unavailable',unmetProofGroups:['capture_input']};
  if (capture.receipt?.captureReceiptInputAvailable === false) {
    return {status:'unavailable',unmetProofGroups:['capture_receipt']};
  }
  if (!isObject(capture.receipt)) return {status:'unavailable',unmetProofGroups:['capture_receipt']};
  if (capture.attempt?.captureAttemptInputAvailable === false) {
    return {status:'unavailable',unmetProofGroups:['capture_attempt']};
  }
  if (!isObject(capture.attempt)) return {status:'unavailable',unmetProofGroups:['capture_attempt']};
  const receipt = capture.receipt;
  const search = receipt.searchDiagnostics || {};
  const guard = receipt.guardDiagnostics || {};
  const attempt = capture.attempt;
  const unmetProofGroups = [];
  if (receipt.status !== 'completed' || receipt.reason !== 'CONTACT_VALUE_VERIFIED') {
    unmetProofGroups.push('receipt_completion');
  }
  if (receipt.identityProof !== 'API_FEED_ID_MATCH' || receipt.formalIdMatch !== true ||
      receipt.profileOpened !== true) unmetProofGroups.push('identity_binding');
  if (receipt.sameContext !== true || receipt.samePage !== true || !hasNoAuthEvidence(receipt) ||
      !queryWasSuccessful(search, receipt) || !stableIdentitySearch(search) ||
      search.contactMarkerState !== 'present' || search.failureBranch !== 'passed') {
    unmetProofGroups.push('search_identity');
  }
  if (receipt.wechatRowUnique !== true || receipt.revealed !== true || receipt.labelMatched !== true ||
      receipt.nonMaskedValue !== true || receipt.finalBackgroundGuard !== true || receipt.errorFree !== true) {
    unmetProofGroups.push('reveal_state');
  }
  if (guard.targetClosed !== false || guard.targetContextMatches !== true || guard.targetHidden !== true ||
      guard.pageSetStable !== true || guard.otherPagesStable !== true ||
      guard.otherPageNavigationChanged !== false || guard.otherPageVisibilityChanged !== false ||
      guard.otherPageDocumentChanged !== false || guard.profileUidConfirmed !== true ||
      guard.authHealthy !== true || guard.errorFree !== true || guard.reason !== '') {
    unmetProofGroups.push('background_guard');
  }
  if (attempt.contactStatus !== 'found' || typeof attempt.contactValue !== 'string' ||
      !/[a-z0-9]/iu.test(attempt.contactValue) || isMaskedContactValue(attempt.contactValue) ||
      typeof attempt.contactSourceUrl !== 'string' || attempt.contactSourceUrl.length === 0 ||
      normalizeText(attempt.contactCheckedAt) === '' || normalizeText(attempt.errorReason) !== '') {
    unmetProofGroups.push('found_contact');
  }
  return {status:unmetProofGroups.length?'incomplete':'complete',unmetProofGroups};
}

function completeSuccessProof(capture) {
  return successProofAssessment(capture).status === 'complete';
}

function failureKind(capture) {
  const receipt = capture?.receipt || {};
  const search = receipt.searchDiagnostics || {};
  const attempt = capture?.attempt || {};
  const status = normalizeText(attempt.contactStatus).toLowerCase().replaceAll('-', '_');
  if (!['stopped', 'completed'].includes(receipt.status)) return {valid: false, reason: 'FAILURE_RECEIPT_STATUS_INVALID'};
  if (attempt.contactValue || attempt.contactSourceUrl) return {valid: false, reason: 'FAILURE_CAPTURE_HAS_CONTACT_VALUE'};
  if (!normalizeText(attempt.contactCheckedAt)) return {valid: false, reason: 'FAILURE_ATTEMPT_TIME_MISSING'};
  if (status === 'login_required') {
    const reason = safeFailureReason(attempt.errorReason);
    const authSignal = receipt.authFailureSeen === true || receipt.responseEvidence?.authPromptLatched === true ||
      (Number.isInteger(receipt.responseEvidence?.explicitAuthResponseCount) && receipt.responseEvidence.explicitAuthResponseCount > 0);
    return authSignal && ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'MENU_PERMISSION_DENIED'].includes(reason)
      ? {valid: true, blocked: 'auth_blocked', reason} : {valid: false, reason: 'FAILURE_AUTH_EVIDENCE_INVALID'};
  }
  if (status === 'captcha') {
    const reason = safeFailureReason(attempt.errorReason);
    return reason === 'SECURITY_CHALLENGE' && receipt.reason === 'SECURITY_CHALLENGE'
      ? {valid: true, blocked: 'risk_blocked', reason} : {valid: false, reason: 'FAILURE_RISK_EVIDENCE_INVALID'};
  }
  if (status === 'not_found') {
    return queryWasSuccessful(search, receipt) && search.queryType === 'ID' &&
      search.exactIdMatchCount === 0 && search.uidPresent === false &&
      search.failureBranch === 'exact_id_match_zero'
      ? {valid: true, outcome: 'no_match', reason: 'TARGET_NOT_FOUND'}
      : {valid: false, reason: 'NO_MATCH_QUERY_UNVERIFIED'};
  }
  if (status === 'not_shown') {
    const reason = safeFailureReason(attempt.errorReason);
    const marker = search.contactMarkerState === 'absent' &&
      ['passed', 'contact_label_not_present'].includes(search.failureBranch);
    const phoneOnlyDiagnostics = reason === 'WECHAT_NOT_PROVIDED'
      ? verifiedPhoneOnlyAbsence(capture, search, receipt) : null;
    const legacyNotShown = queryWasSuccessful(search, receipt) && receipt.identityProof === 'API_FEED_ID_MATCH' &&
      receipt.formalIdMatch === true && stableIdentitySearch(search) && marker &&
      ['CONTACT_NOT_SHOWN', 'CONTACT_LABEL_NOT_PRESENT'].includes(reason);
    if (phoneOnlyDiagnostics) {
      return {valid: true, outcome: 'not_shown', reason, channelDiagnostics: phoneOnlyDiagnostics};
    }
    return legacyNotShown
      ? {valid: true, outcome: 'not_shown', reason}
      : {valid: false, reason: 'NOT_SHOWN_QUERY_UNVERIFIED'};
  }
  if (status === 'forbidden_by_platform' || status === 'error') {
    const reason = safeFailureReason(attempt.errorReason);
    if (reason === 'CONTACT_CATEGORY_RESTRICTED' && !verifiedCategoryRestriction(capture, search, receipt, reason)) {
      return {valid: false, reason: 'CATEGORY_RESTRICTION_EVIDENCE_INVALID'};
    }
    if(status==='forbidden_by_platform'&&reason!=='CONTACT_CATEGORY_RESTRICTED')return {valid:false,reason:'CATEGORY_RESTRICTION_EVIDENCE_INVALID'};
    if(reason==='CONTACT_CATEGORY_RESTRICTED')return {valid:true,outcome:'forbidden_by_platform',reason};
    return queryWasSuccessful(search, receipt) && receipt.identityProof === 'API_FEED_ID_MATCH' &&
      receipt.formalIdMatch === true && stableIdentitySearch(search) &&
      search.failureBranch !== 'exact_id_match_zero'
      ? {valid: true, outcome: 'error', reason}
      : {valid: false, reason: 'ERROR_QUERY_UNVERIFIED'};
  }
  return {valid: false, reason: 'FAILURE_STATUS_INVALID'};
}

function safeWriterCode(error) {
  const prefix = String(error?.message || '').split(':', 1)[0];
  if (SAFE_WRITER_CODES.has(prefix) || SAFE_PARALLEL_CODES.has(prefix)) return prefix;
  return 'UNKNOWN_WRITE_ERROR';
}

function safeFailureReason(value) {
  const code = safeCode(value);
  return SAFE_FAILURE_REASONS.has(code) ? code : 'UNKNOWN_ERROR';
}

const CAPTURE_VALIDATION_CODES=new Set([
  'SUCCESS_CAPTURE_PROOF_INVALID','ERROR_QUERY_UNVERIFIED','NOT_SHOWN_QUERY_UNVERIFIED','NO_MATCH_QUERY_UNVERIFIED',
  'CATEGORY_RESTRICTION_EVIDENCE_INVALID','FAILURE_STATUS_INVALID','FAILURE_RECEIPT_STATUS_INVALID',
  'FAILURE_CAPTURE_HAS_CONTACT_VALUE','FAILURE_ATTEMPT_TIME_MISSING','FAILURE_AUTH_EVIDENCE_INVALID',
  'FAILURE_RISK_EVIDENCE_INVALID',
]);
const CAPTURE_STATUSES=new Set(['found','not_shown','not_found','login_required','captcha','error','forbidden_by_platform']);
const CAPTURE_RECEIPT_STATUSES=new Set(['completed','stopped']);
const CAPTURE_IDENTITY_PROOFS=new Set(['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED']);
const CAPTURE_QUERY_TYPES=new Set(['ID','NICKNAME']);
const CAPTURE_HTTP_CATEGORIES=new Set(['missing','2xx','4xx','5xx','other']);
const CAPTURE_BUSINESS_CATEGORIES=new Set(['missing','zero','nonzero']);
const CAPTURE_IDENTITY_KINDS=new Set(['UID','AWEME_ID','BOTH','NONE','MISSING']);
const CAPTURE_MARKER_STATES=new Set(['present','absent','unresolved','missing']);
const CAPTURE_FAILURE_BRANCHES=new Set(BUYIN_SEARCH_FAILURE_BRANCHES);
const CAPTURE_STAGES=new Set(['auth-check','id-search','open-detail','reveal','final-guard','complete',
  'driver-init','flow','wave-guard','wave-worker']);

function captureValidationDiagnostics(capture,validationReason) {
  const attempt=capture?.attempt||{},receipt=capture?.receipt||{};
  const response=receipt.responseEvidence||{},search=receipt.searchDiagnostics||{},guard=receipt.guardDiagnostics||{};
  const count=(value,maximum=100000)=>Number.isInteger(value)&&value>=0&&value<=maximum?value:0;
  const booleanOrNull=value=>typeof value==='boolean'?value:null;
  const reasonOrEmpty=value=>value===''?'':safeFailureReason(value);
  const successProofDiagnostics=validationReason==='SUCCESS_CAPTURE_PROOF_INVALID'
    ?successProofAssessment(capture):null;
  return Object.freeze({
    validationCode:CAPTURE_VALIDATION_CODES.has(validationReason)?validationReason:'UNKNOWN_VALIDATION_FAILURE',
    stage:CAPTURE_STAGES.has(receipt.stage)?receipt.stage:'unknown',
    attemptStatus:CAPTURE_STATUSES.has(attempt.contactStatus)?attempt.contactStatus:'error',
    attemptErrorReason:reasonOrEmpty(attempt.errorReason),
    receiptStatus:CAPTURE_RECEIPT_STATUSES.has(receipt.status)?receipt.status:'unknown',
    receiptReason:reasonOrEmpty(receipt.reason),
    identityProof:CAPTURE_IDENTITY_PROOFS.has(receipt.identityProof)?receipt.identityProof:'',
    sameContext:booleanOrNull(receipt.sameContext),samePage:booleanOrNull(receipt.samePage),
    authFailureSeen:booleanOrNull(receipt.authFailureSeen),formalIdMatch:booleanOrNull(receipt.formalIdMatch),
    profileOpened:booleanOrNull(receipt.profileOpened),
    responseEvidence:{authPromptLatched:typeof response.authPromptLatched==='boolean'?response.authPromptLatched:null,
      explicitAuthResponseCount:count(response.explicitAuthResponseCount)},
    searchDiagnostics:{submittedAfterActivation:booleanOrNull(search.submittedAfterActivation),
      queryType:CAPTURE_QUERY_TYPES.has(search.queryType)?search.queryType:'ID',attemptCount:count(search.attemptCount,3),
      matchedRequestCount:count(search.matchedRequestCount,3),matchedResponseCount:count(search.matchedResponseCount,3),
      visibleStableIdentityMatchCount:Number.isInteger(search.visibleStableIdentityMatchCount)&&
        search.visibleStableIdentityMatchCount>=0&&search.visibleStableIdentityMatchCount<=100000
        ?search.visibleStableIdentityMatchCount:-1,
      httpStatusCategory:CAPTURE_HTTP_CATEGORIES.has(search.httpStatusCategory)?search.httpStatusCategory:'missing',
      businessCodeCategory:CAPTURE_BUSINESS_CATEGORIES.has(search.businessCodeCategory)?search.businessCodeCategory:'missing',
      exactIdMatchCount:count(search.exactIdMatchCount),uidPresent:booleanOrNull(search.uidPresent),
      feedResultIdMatchesTarget:booleanOrNull(search.feedResultIdMatchesTarget),
      selectedExactResultPresent:booleanOrNull(search.selectedExactResultPresent),
      matchedIdentityKeyKind:CAPTURE_IDENTITY_KINDS.has(search.matchedIdentityKeyKind)?search.matchedIdentityKeyKind:'MISSING',
      contactMarkerState:CAPTURE_MARKER_STATES.has(search.contactMarkerState)?search.contactMarkerState:'missing',
      failureBranch:CAPTURE_FAILURE_BRANCHES.has(search.failureBranch)?search.failureBranch:'unknown',
      ...(SAFE_SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&
        SAFE_SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)
        ?{executionPhase:search.executionPhase,exceptionCategory:search.exceptionCategory}:{})},
    guardDiagnostics:{targetClosed:booleanOrNull(guard.targetClosed),targetContextMatches:booleanOrNull(guard.targetContextMatches),
      targetHidden:booleanOrNull(guard.targetHidden),pageSetStable:booleanOrNull(guard.pageSetStable),
      otherPagesStable:booleanOrNull(guard.otherPagesStable),otherPageNavigationChanged:booleanOrNull(guard.otherPageNavigationChanged),
      otherPageVisibilityChanged:booleanOrNull(guard.otherPageVisibilityChanged),
      otherPageDocumentChanged:booleanOrNull(guard.otherPageDocumentChanged),
      profileUidConfirmed:booleanOrNull(guard.profileUidConfirmed),authHealthy:booleanOrNull(guard.authHealthy),
      errorFree:booleanOrNull(guard.errorFree),reason:reasonOrEmpty(guard.reason)},
    ...(successProofDiagnostics?{successProofDiagnostics}:{}),
  });
}

function descriptorFromRequest(request) {
  return Object.freeze({
    creatorId: normalizeText(request?.creatorId),
    recordId: normalizeText(request?.recordId),
    sourceBatchId: normalizeText(request?.sourceBatchId),
    sourceRank: request?.sourceRank,
    attemptId: normalizeText(request?.attemptId),
  });
}

function descriptorsMatch(actual, expected) {
  return actual?.creatorId === expected.creatorId && actual?.recordId === expected.recordId &&
    actual?.sourceBatchId === expected.sourceBatchId && actual?.sourceRank === expected.sourceRank &&
    actual?.attemptId === expected.attemptId;
}

/**
 * Build one opaque, one-use write context for an already captured manifest member.
 *
 * options = {manifest, authContext, schema, client, verifySourceMember,
 *   verifyCurrentMember, allowExistingWeChatReverify=false}
 * authContext is a verified `{verifiedUser:true, profile:FEISHU_ROUTE.profile, as:'user', host:FEISHU_ROUTE.host}`.
 * schema is a verified `{verified:true, fields:[...]}` or equivalent field array.
 * The two read-only verifier callbacks must return true or a matching verified
 * descriptor. The live roster index and full target row are always read here too.
 */
export async function prepareWriteContext(request, options = {}) {
  const descriptor = descriptorFromRequest(request);
  if (!descriptor.creatorId || !descriptor.recordId || descriptor.sourceBatchId !== options.manifest?.sourceBatchId ||
      !Number.isInteger(descriptor.sourceRank) || !descriptor.attemptId) fail('TARGET_DESCRIPTOR_INVALID');
  const {manifest, authContext, schema, client, verifySourceMember, verifyCurrentMember} = options;
  if(manifest?.mode==='daily-add-only') {
    if(!options.dailySource)fail('DAILY_SOURCE_UNVERIFIED');
    const verified=buildDailyAddContactManifest(options.dailySource);
    if(JSON.stringify(verified)!==JSON.stringify(manifest))fail('DAILY_MANIFEST_MISMATCH');
  } else assertManifest(manifest);
  if (!identityVerifiedAuth(authContext)) fail('AUTH_ROUTE_UNVERIFIED');
  if (schema?.verified !== true && authContext?.schemaVerified !== true) fail('SCHEMA_UNVERIFIED');
  if (!client || typeof client.listRecordsPage !== 'function' || typeof client.getRecord !== 'function' ||
      typeof client.upsertRecord !== 'function') fail('CLIENT_INVALID');
  if (typeof verifySourceMember !== 'function' || typeof verifyCurrentMember !== 'function') fail('READ_ONLY_VERIFIERS_REQUIRED');

  const manifestTarget = manifest.targets.find(target => target.creatorId === descriptor.creatorId);
  if (!manifestTarget || manifestTarget.recordId !== descriptor.recordId ||
      manifestTarget.sourceRank !== descriptor.sourceRank) fail('TARGET_NOT_IN_MANIFEST');
  let sourceMember;
  try { sourceMember = await verifySourceMember({manifest, target: {...manifestTarget}, sourceBatchId: manifest.sourceBatchId}); }
  catch { fail('SOURCE_MEMBER_UNVERIFIED'); }
  if (!verifierMatches(sourceMember, manifestTarget, manifest.sourceBatchId)) fail('SOURCE_MEMBER_UNVERIFIED');

  const fields = fieldList(schema);
  const fieldNames = fields.map(field => field.name);
  let currentIndex;
  try { currentIndex = await listRosterIndex(client); }
  catch (cause) {
    const error=new Error('PARALLEL_CURRENT_INDEX_UNVERIFIED');
    error.readFailure=safeReadFailure(cause);
    throw error;
  }
  const indexed = currentIndex.get(descriptor.creatorId);
  if (!indexed || indexed.recordId !== descriptor.recordId) fail('CURRENT_INDEX_TARGET_MISMATCH');
  let currentMember;
  try {
    currentMember = await verifyCurrentMember({target: {...manifestTarget}, indexEntry: {creatorId: indexed.creatorId, recordId: indexed.recordId}});
  } catch { fail('CURRENT_MEMBER_UNVERIFIED'); }
  if (!verifierMatches(currentMember, manifestTarget, manifest.sourceBatchId)) fail('CURRENT_MEMBER_UNVERIFIED');

  let initial;
  try { initial = recordProjection(await client.getRecord(descriptor.recordId, fieldNames)); }
  catch { fail('TARGET_RECORD_READ_FAILED'); }
  if (initial.recordId !== descriptor.recordId) fail('TARGET_RECORD_ID_MISMATCH');
  if (!exactTextCellEquals(initial.fields?.['抖音号'], descriptor.creatorId)) fail('TARGET_CREATOR_ID_MISMATCH');

  const protectedNames = fieldNames.filter(name => !PATCHED_CONTACT_FIELDS.has(name));
  const baselineProtected = Object.fromEntries(protectedNames.map(name => [name, canonical(initial.fields?.[name] ?? null)]));
  const baselinePreserve = Object.fromEntries(PRESERVE_ON_FAILURE.map(name => [name, canonical(initial.fields?.[name] ?? null)]));
  const hadWeChatBefore = textCell(initial.fields?.['微信号']) !== '';
  if (hadWeChatBefore && options.allowExistingWeChatReverify !== true) fail('EXISTING_CONTACT_REVERIFY_NOT_AUTHORIZED');

  const opaque = Object.freeze({
    kind: 'parallel-contact-write-context-v1',
    ...descriptor,
    sourceMemberVerified: true,
    currentIndexVerified: true,
    recordMappingVerified: true,
    baselineFieldCount: protectedNames.length,
    hadWeChatBefore,
  });
  contexts.set(opaque, {
    descriptor,
    client,
    fieldNames,
    protectedNames,
    baselineProtected,
    baselinePreserve,
    hadWeChatBefore,
    sourceMemberVerified: true,
    currentIndexVerified: true,
  });
  return opaque;
}

function deriveHumanFieldsUnchanged(fields, baseline) {
  return exactProtectedMatch(fields, baseline, ['商务跟进状态', '商务备注']);
}

/**
 * Consume a captured attempt exactly once and write it through the shared roster
 * writer. Calls must be made serially by the central writer owner; overlapping
 * calls fail closed with PARALLEL_CENTRAL_WRITER_BUSY.
 *
 * Returns `{result, receipt}`. `result` is safe for normalizeCanaryResult and the
 * receipt contains only identity, status, and boolean/count diagnostics.
 */
export async function commitCapturedAttempt(context, capture) {
  if (centralWriterActive) {
    clearAttemptSecrets(capture);
    throw new Error('PARALLEL_CENTRAL_WRITER_BUSY');
  }
  if (!context || !contexts.has(context)) {
    const descriptor = context && typeof context === 'object' ? context : {};
    if (descriptor.kind === 'parallel-contact-write-context-v1' && consumedContexts.has(context)) {
      clearAttemptSecrets(capture);
      throw new Error('PARALLEL_CONTEXT_ALREADY_CONSUMED');
    }
    clearAttemptSecrets(capture);
    throw new Error('PARALLEL_CONTEXT_INVALID');
  }
  centralWriterActive = true;
  const state = contexts.get(context);
  consumedContexts.add(context);
  contexts.delete(context);

  let expectedPatch = null;
  let writeSubmitted = false;
  let writerInvoked = false;
  let sharedWriterReadbackVerified = false;
  let sharedWriterStage = 'not_started';
  let sharedWriterErrorCode = '';
  let outerReadbackVerified = false;
  let sameRecordReadback = false;
  let sameCreatorIdReadback = false;
  let protectedFieldsUnchanged = false;
  let oldContactPreserved = false;
  let humanFieldsUnchanged = false;
  let patchKind = '';
  let derivedOutcome = 'error';
  let derivedReason = 'CAPTURE_UNVERIFIED';
  let channelDiagnostics = null;
  let captureExecutionDiagnostics;

  try {
    captureExecutionDiagnostics=projectCaptureExecutionDiagnostics(capture);
    const captureDescriptor = capture?.descriptor;
    if (!descriptorsMatch(captureDescriptor, state.descriptor)) return invalidCapture(context, 'CAPTURE_DESCRIPTOR_MISMATCH',capture);

    const attempt = capture?.attempt;
    let currentFailure = null;
    if (attempt?.contactStatus === 'found') {
      if (!completeSuccessProof(capture)) return invalidCapture(context, 'SUCCESS_CAPTURE_PROOF_INVALID',capture);
      derivedOutcome = 'success';
      derivedReason = 'CONTACT_VALUE_VERIFIED';
      patchKind = 'success_contact';
    } else {
      currentFailure = failureKind(capture);
      if (!currentFailure.valid) return invalidCapture(context, currentFailure.reason,capture);
      channelDiagnostics = currentFailure.channelDiagnostics || null;
      if (currentFailure.blocked) {
        const blocked = resultFor(context, currentFailure.blocked, 'not_written', currentFailure.reason);
        return {result: blocked, receipt: receiptFor(blocked, context, {
          sourceMemberVerified: true, currentIndexVerified: true, recordMappingVerified: true, channelDiagnostics,
          captureExecutionDiagnostics,
        })};
      }
      derivedOutcome = currentFailure.outcome;
      derivedReason = currentFailure.reason;
      patchKind = 'failure_system_fields';
    }

    let patchFailureReason = '';
    const writer = async ({creatorId, recordId, fields}) => {
      if (creatorId !== state.descriptor.creatorId || recordId !== state.descriptor.recordId) {
        throw new Error('PARALLEL_WRITER_TARGET_MISMATCH');
      }
      const patchNames = Object.keys(fields || {});
      const expectedNames = patchKind === 'success_contact'
        ? ['微信号', '本次联系方式状态', '联系方式最近尝试', '联系方式最近成功', '联系方式最近错误', '联系方式来源']
        : ['本次联系方式状态', '联系方式最近尝试', '联系方式最近错误'];
      if (patchNames.length !== expectedNames.length || expectedNames.some(name => !patchNames.includes(name)) ||
          patchNames.some(name => !CONTACT_FIELDS.has(name))) throw new Error('PARALLEL_PATCH_SCOPE_INVALID');

      sharedWriterStage = 'prewrite_readback';
      let before;
      try { before = recordProjection(await state.client.getRecord(recordId, state.fieldNames)); }
      catch { throw new Error('PARALLEL_PREWRITE_READ_FAILED'); }
      if (before.recordId !== recordId || !exactTextCellEquals(before.fields?.['抖音号'], creatorId)) {
        throw new Error('PARALLEL_PREWRITE_IDENTITY_MISMATCH');
      }
      if (!exactProtectedMatch(before.fields, state.baselineProtected, state.protectedNames)) {
        throw new Error('PARALLEL_PROTECTED_FIELDS_CHANGED');
      }
      if (!exactProtectedMatch(before.fields, state.baselinePreserve, PRESERVE_ON_FAILURE)) {
        throw new Error('PARALLEL_PRIOR_CONTACT_CHANGED');
      }

      expectedPatch = Object.fromEntries(patchNames.map(name => [name, fields[name]]));
      writerInvoked = true;
      sharedWriterStage = 'shared_writer';
      let sharedGetCount = 0;
      const observedClient = {
        recordLockDir: state.client.recordLockDir,
        async getRecord(...args) {
          sharedGetCount += 1;
          sharedWriterStage = sharedGetCount === 1 ? 'id_lookup' : sharedGetCount === 2 ? 'compare' : 'readback';
          return state.client.getRecord(...args);
        },
        async upsertRecord(...args) {
          writeSubmitted = true;
          sharedWriterStage = 'upsert';
          return state.client.upsertRecord(...args);
        },
      };
      try {
        const shared = await patchContactRecord({creatorId, recordId, fields}, observedClient);
        sharedWriterReadbackVerified = shared?.updated === true;
        sharedWriterStage = 'complete';
        if (!sharedWriterReadbackVerified) throw new Error('PARALLEL_SHARED_READBACK_UNVERIFIED');
        return shared;
      } catch (error) {
        sharedWriterErrorCode = safeWriterCode(error);
        sharedWriterStage = sharedGetCount >= 2 ? 'readback' : writeSubmitted ? 'upsert' : 'shared_writer_failed';
        throw error;
      }
    };

    try {
      const writeAttempt = attempt.contactStatus === 'found' ? attempt : {
        contactStatus: derivedOutcome === 'forbidden_by_platform' ? 'forbidden_by_platform' : attempt.contactStatus,
        contactCheckedAt: attempt.contactCheckedAt,
        errorReason: safeFailureReason(attempt.errorReason),
      };
      await patchCurrentContactAttempt({creatorId: state.descriptor.creatorId,
        recordId: state.descriptor.recordId, attempt: writeAttempt, writer});
    } catch (error) {
      patchFailureReason = safeWriterCode(error);
      if (!sharedWriterErrorCode) sharedWriterErrorCode = patchFailureReason;
    }

    if (!writerInvoked || !expectedPatch) {
      const reason = patchFailureReason || 'PARALLEL_PATCH_NOT_STARTED';
      const result = resultFor(context, 'error', 'not_written', reason, {
        recordMappingVerified: true,
        originalAttemptSourceVerified: state.sourceMemberVerified,
        protectedFieldsUnchanged: false,
      });
      return {result, receipt: receiptFor(result, context, {
        sourceMemberVerified: state.sourceMemberVerified,
        currentIndexVerified: state.currentIndexVerified,
        recordMappingVerified: true,
        writerInvoked,
        writeSubmitted,
        sharedWriterReadbackVerified,
        sharedWriterStage,
        sharedWriterErrorCode,
        patchFieldCount: 0,
        channelDiagnostics,
        captureExecutionDiagnostics,
      })};
    }

    const failureExpected = patchKind === 'failure_system_fields' ? {
      status: expectedPatch['本次联系方式状态'],
      checkedAt: expectedPatch['联系方式最近尝试'],
      errorReason: safeFailureReason(attempt.errorReason),
      actualStoredError: expectedPatch['联系方式最近错误'],
    } : null;
    let after;
    try { after = recordProjection(await state.client.getRecord(state.descriptor.recordId, state.fieldNames)); }
    catch {
      const uncertain = resultFor(context, 'error', writeSubmitted ? 'uncertain' : 'not_written',
        writeSubmitted ? 'WRITE_OUTCOME_UNKNOWN' : (patchFailureReason || 'OUTER_READBACK_FAILED'));
      return {result: uncertain, receipt: receiptFor(uncertain, context, {
        sourceMemberVerified: state.sourceMemberVerified,
        currentIndexVerified: state.currentIndexVerified,
        recordMappingVerified: true,
        writerInvoked,
        writeSubmitted,
        sharedWriterReadbackVerified,
        sharedWriterStage,
        sharedWriterErrorCode,
        patchFieldCount: Object.keys(expectedPatch).length,
        failureExpected: failureExpected ? {...failureExpected, actualStoredError: ''} : null,
        channelDiagnostics,
        captureExecutionDiagnostics,
      })};
    }

    sameRecordReadback = after.recordId === state.descriptor.recordId;
    sameCreatorIdReadback = sameRecordReadback && exactTextCellEquals(after.fields?.['抖音号'], state.descriptor.creatorId);
    protectedFieldsUnchanged = sameCreatorIdReadback &&
      exactProtectedMatch(after.fields, state.baselineProtected, state.protectedNames);
    humanFieldsUnchanged = sameCreatorIdReadback &&
      deriveHumanFieldsUnchanged(after.fields, state.baselineProtected);
    oldContactPreserved = patchKind === 'failure_system_fields' && sameCreatorIdReadback &&
      exactProtectedMatch(after.fields, state.baselinePreserve, PRESERVE_ON_FAILURE);
    const patchMatches = sameRecordReadback && Object.entries(expectedPatch)
      .every(([name, value]) => cellsMatch(name, after.fields?.[name], value));
    const fieldReadbackMatches = {
      wechatValue: sameCreatorIdReadback && (patchKind === 'success_contact'
        ? cellsMatch('微信号', after.fields?.['微信号'], expectedPatch['微信号'])
        : cellsMatch('微信号', after.fields?.['微信号'], state.baselinePreserve['微信号'])),
      contactStatus: sameCreatorIdReadback && Object.hasOwn(expectedPatch, '本次联系方式状态') &&
        cellsMatch('本次联系方式状态', after.fields?.['本次联系方式状态'], expectedPatch['本次联系方式状态']),
      contactAttemptTime: sameCreatorIdReadback && Object.hasOwn(expectedPatch, '联系方式最近尝试') &&
        cellsMatch('联系方式最近尝试', after.fields?.['联系方式最近尝试'], expectedPatch['联系方式最近尝试']),
      contactLastSuccess: sameCreatorIdReadback && (patchKind === 'success_contact'
        ? cellsMatch('联系方式最近成功', after.fields?.['联系方式最近成功'], expectedPatch['联系方式最近成功'])
        : cellsMatch('联系方式最近成功', after.fields?.['联系方式最近成功'], state.baselinePreserve['联系方式最近成功'])),
      contactError: sameCreatorIdReadback && Object.hasOwn(expectedPatch, '联系方式最近错误') &&
        cellsMatch('联系方式最近错误', after.fields?.['联系方式最近错误'], expectedPatch['联系方式最近错误']),
      contactSource: sameCreatorIdReadback && (patchKind === 'success_contact'
        ? cellsMatch('联系方式来源', after.fields?.['联系方式来源'], expectedPatch['联系方式来源'])
        : cellsMatch('联系方式来源', after.fields?.['联系方式来源'], state.baselinePreserve['联系方式来源'])),
    };
    outerReadbackVerified = patchMatches && sameCreatorIdReadback && protectedFieldsUnchanged && humanFieldsUnchanged &&
      (patchKind === 'success_contact' || oldContactPreserved);

    if (outerReadbackVerified && sharedWriterReadbackVerified && !patchFailureReason) {
      const result = resultFor(context, derivedOutcome, 'verified', derivedReason, {
        recordMappingVerified: true,
        readbackVerified: true,
        originalAttemptSourceVerified: state.sourceMemberVerified,
        protectedFieldsUnchanged: true,
        currentValueVerified: patchKind === 'success_contact',
      });
      return {result, receipt: receiptFor(result, context, {
        sourceMemberVerified: state.sourceMemberVerified,
        currentIndexVerified: state.currentIndexVerified,
        recordMappingVerified: true,
        writerInvoked,
        writeSubmitted,
        sharedWriterReadbackVerified,
        sharedWriterStage,
        sharedWriterErrorCode,
        outerReadbackVerified,
        sameRecordReadback,
        sameCreatorIdReadback,
        protectedFieldsUnchanged,
        oldContactPreserved,
        patchFieldCount: Object.keys(expectedPatch).length,
        fieldReadbackMatches,
        failureExpected: failureExpected ? {...failureExpected,
          actualStoredError: fieldReadbackMatches.contactError ? failureExpected.actualStoredError : ''} : null,
        channelDiagnostics,
        captureExecutionDiagnostics,
      })};
    }

    if (outerReadbackVerified && writeSubmitted && sharedWriterErrorCode === 'LARK_READBACK_MISMATCH' &&
        ['success_contact','failure_system_fields'].includes(patchKind)) {
      const result = resultFor(context, derivedOutcome, 'verified', derivedReason, {
        recordMappingVerified: true,
        readbackVerified: true,
        originalAttemptSourceVerified: state.sourceMemberVerified,
        protectedFieldsUnchanged: true,
        currentValueVerified: patchKind === 'success_contact',
      });
      return {result, receipt: receiptFor(result, context, {
        sourceMemberVerified: state.sourceMemberVerified,
        currentIndexVerified: state.currentIndexVerified,
        recordMappingVerified: true,
        writerInvoked,
        writeSubmitted,
        sharedWriterReadbackVerified: false,
        sharedWriterStage,
        sharedWriterErrorCode,
        outerReadbackVerified: true,
        sameRecordReadback,
        sameCreatorIdReadback,
        protectedFieldsUnchanged: true,
        oldContactPreserved,
        patchFieldCount: Object.keys(expectedPatch).length,
        fieldReadbackMatches,
        failureExpected: failureExpected ? {...failureExpected,
          actualStoredError: fieldReadbackMatches.contactError ? failureExpected.actualStoredError : ''} : null,
        channelDiagnostics,
        captureExecutionDiagnostics,
        recoveryMode: 'outer_same_attempt_readback_verified',
      })};
    }

    const reason = writeSubmitted ? 'WRITE_OUTCOME_UNKNOWN' : (patchFailureReason || 'OUTER_READBACK_UNVERIFIED');
    const result = resultFor(context, 'error', writeSubmitted ? 'uncertain' : 'not_written', reason, {
      recordMappingVerified: true,
      readbackVerified: false,
      originalAttemptSourceVerified: state.sourceMemberVerified,
      protectedFieldsUnchanged,
    });
    return {result, receipt: receiptFor(result, context, {
      sourceMemberVerified: state.sourceMemberVerified,
      currentIndexVerified: state.currentIndexVerified,
      recordMappingVerified: true,
      writerInvoked,
      writeSubmitted,
      sharedWriterReadbackVerified,
      sharedWriterStage,
      sharedWriterErrorCode,
      outerReadbackVerified,
      sameRecordReadback,
      sameCreatorIdReadback,
      protectedFieldsUnchanged,
      oldContactPreserved,
      patchFieldCount: Object.keys(expectedPatch).length,
      fieldReadbackMatches,
      failureExpected: failureExpected ? {...failureExpected,
        actualStoredError: fieldReadbackMatches.contactError ? failureExpected.actualStoredError : ''} : null,
      channelDiagnostics,
      captureExecutionDiagnostics,
    })};
  } catch (error) {
    const reason = safeWriterCode(error);
    const result = resultFor(context, 'error', writeSubmitted ? 'uncertain' : 'not_written',
      writeSubmitted ? 'WRITE_OUTCOME_UNKNOWN' : reason);
    return {result, receipt: receiptFor(result, context, {
      sourceMemberVerified: state.sourceMemberVerified,
      currentIndexVerified: state.currentIndexVerified,
      recordMappingVerified: true,
      writerInvoked,
      writeSubmitted,
      sharedWriterReadbackVerified,
      sharedWriterStage,
      sharedWriterErrorCode: sharedWriterErrorCode || reason,
      outerReadbackVerified,
      sameRecordReadback,
      sameCreatorIdReadback,
      protectedFieldsUnchanged,
      oldContactPreserved,
      patchFieldCount: expectedPatch ? Object.keys(expectedPatch).length : 0,
      channelDiagnostics,
      captureExecutionDiagnostics,
    })};
  } finally {
    expectedPatch = null;
    clearAttemptSecrets(capture);
    state.baselineProtected = null;
    state.baselinePreserve = null;
    state.fieldNames = null;
    state.protectedNames = null;
    centralWriterActive = false;
  }
}

/**
 * Reconcile a legacy uncertain failure-status patch only from its saved safe
 * attempt proof plus a fresh same-record read. This path never reads or writes
 * a contact value and never retries the attempt.
 */
export async function reconcileParallelFailureReadback({saved,target,client}={}) {
  const receipt=saved?.receipt;
  const expected=receipt?.failureExpected;
  const flags=['wechatValue','contactStatus','contactAttemptTime','contactLastSuccess','contactError','contactSource'];
  const matchesTarget=value=>value?.creatorId===target?.creatorId&&value?.recordId===target?.recordId&&
    value?.sourceBatchId===target?.sourceBatchId&&value?.sourceRank===target?.sourceRank&&
    value?.attemptId===target?.attemptId;
  if (!target||!client||typeof client.getRecord!=='function'||typeof client.recordHistoryList!=='function'||
      saved?.state!=='write_finished'||
      !matchesTarget(saved)||!matchesTarget(receipt)||receipt.mode!=='parallel_production_contact_write'||
      saved.result?.attemptId!==target.attemptId||saved.result?.outcome!=='error'||
      saved.result?.writeState!=='uncertain'||receipt.outcome!=='error'||receipt.writeState!=='uncertain'||
      receipt.writerInvoked!==true||receipt.writeSubmitted!==true||receipt.sharedWriterReadbackVerified!==false||
      receipt.outerReadbackVerified!==true||receipt.sameRecordReadback!==true||receipt.sameCreatorIdReadback!==true||
      receipt.recordMappingVerified!==true||receipt.sourceMemberVerified!==true||receipt.currentIndexVerified!==true||
      receipt.protectedFieldsUnchanged!==true||receipt.oldContactPreserved!==true||receipt.hadWeChatBefore!==false||
      !isObject(receipt.fieldReadbackMatches)||flags.some(flag=>receipt.fieldReadbackMatches[flag]!==true)||
      !expected||!['not_shown','not_found'].includes(expected.status)||
      typeof expected.checkedAt!=='string'||!/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:?\d\d)?$/u.test(expected.checkedAt)||
      !SAFE_FAILURE_REASONS.has(expected.errorReason)||!SAFE_FAILURE_REASONS.has(expected.actualStoredError)) return null;
  try {
    const startedAtMs=Date.parse(saved.startedAt),finishedAtMs=Date.parse(saved.finishedAt);
    if (!Number.isFinite(startedAtMs)||!Number.isFinite(finishedAtMs)||finishedAtMs<startedAtMs) return null;
    const patch=await patchCurrentContactAttempt({creatorId:target.creatorId,recordId:target.recordId,
      attempt:{contactStatus:expected.status,contactCheckedAt:expected.checkedAt,errorReason:expected.errorReason},
      writer:async ({fields})=>fields});
    if (!sameCell('联系方式最近错误',patch['联系方式最近错误'],expected.actualStoredError)) return null;
    const current=recordProjection(await client.getRecord(target.recordId,[
      '抖音号','微信号','本次联系方式状态','联系方式最近尝试','联系方式最近错误']));
    if (current.recordId!==target.recordId||!exactTextCellEquals(current.fields?.['抖音号'],target.creatorId)||
        textCell(current.fields?.['微信号'])!==''||
        !sameCell('本次联系方式状态',current.fields?.['本次联系方式状态'],patch['本次联系方式状态'])||
        !sameCell('联系方式最近尝试',current.fields?.['联系方式最近尝试'],patch['联系方式最近尝试'])||
        !sameCell('联系方式最近错误',current.fields?.['联系方式最近错误'],expected.actualStoredError)) return null;
    const historyPayload=await client.recordHistoryList({recordId:target.recordId,pageSize:50});
    const historyData=historyPayload?.data??historyPayload;
    const historyItems=Array.isArray(historyData?.items)?historyData.items:
      Array.isArray(historyData?.history)?historyData.history:[];
    const expectedFields=['本次联系方式状态','联系方式最近尝试','联系方式最近错误'];
    const startSecond=Math.floor(startedAtMs/1000),finishSecond=Math.ceil(finishedAtMs/1000);
    const matchingHistory=historyItems.filter(item=>{
      if(item?.activity_type!=='update'||!Number.isFinite(item?.create_time)||
          item.create_time<startSecond||item.create_time>finishSecond||!Array.isArray(item?.field_changes)||
          item.field_changes.length!==expectedFields.length) return false;
      const byName=new Map();
      for(const change of item.field_changes){
        const name=change?.field_name;
        if(typeof name!=='string'||byName.has(name)) return false;
        byName.set(name,change);
      }
      return byName.size===expectedFields.length&&expectedFields.every(name=>{
        const change=byName.get(name);
        return change&&sameCell(name,change.after,patch[name])&&!sameCell(name,change.before,patch[name]);
      });
    });
    if(matchingHistory.length!==1) return null;
    return {attemptId:target.attemptId,outcome:expected.status==='not_found'?'no_match':'not_shown',
      writeState:'verified',reason:expected.errorReason,recordMappingVerified:true,readbackVerified:true,
      originalAttemptSourceVerified:true,protectedFieldsUnchanged:true,
      historyVerified:true,recoveryMode:'fresh_same_attempt_failure_readback_verified'};
  } catch { return null; }
}
