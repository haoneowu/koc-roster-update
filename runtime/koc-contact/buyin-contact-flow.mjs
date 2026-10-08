import {CONTACT_MASK_REGEX_SOURCE, isMaskedContactValue} from './contact-reveal-state.mjs';

const FORMAL_RESULT_STRUCTURES = new Set(['TABLE_ID_COLUMN', 'FORMAL_RESULT_CARD']);
export const BUYIN_SEARCH_FAILURE_BRANCHES=Object.freeze([
  'not_started','awaiting_response','query_id_mismatch','search_budget_exhausted','no_exact_request','no_bound_response',
  'bound_response_not_parsed','duplicate_exact_requests','request_response_count_mismatch',
  'http_non_200','business_code_nonzero_or_missing','result_list_not_array','exact_id_uid_conflict','exact_id_match_zero',
  'exact_id_match_multiple','exact_result_not_selected','exact_result_uid_missing','visible_result_unverified',
  'visible_result_ambiguous','contact_marker_unresolved','contact_label_not_present','passed',
]);
const SEARCH_FAILURE_BRANCH_SET=new Set(BUYIN_SEARCH_FAILURE_BRANCHES);
const OPEN_DETAIL_EXECUTION_PHASES=new Set(['pre_guard','expected_uid','navigate','profile_poll','profile_wait',
  'actual_uid','profile_guard','profile_uid','post_guard','post_auth','post_result']);
const OPEN_DETAIL_EXCEPTION_CATEGORIES=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
const AUTH_COUNTER_KEYS = Object.freeze([
  'authRequiredResponseCount', 'authExpiredResponseCount', 'menuDeniedResponseCount',
  'authHttp401ResponseCount', 'authEnvelope401ResponseCount',
  'authMessageNotLoggedInResponseCount', 'authMessageExpiredResponseCount',
  'menuDeniedMessageResponseCount',
]);
const SAFE_REASONS = new Set([
  'RATE_LIMITED',
  'CONTACT_VALUE_VERIFIED',
  'CONTACT_CATEGORY_RESTRICTED',
  'UNRECOGNIZED_TRANSIENT_NOTICE',
  'UNRECOGNIZED_TRANSIENT_NOTICE',
  'AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_OR_PERMISSION_UNRESOLVED', 'RESPONSE_EVIDENCE_INCOMPLETE',
  'RESPONSE_ERROR_UNCLASSIFIED', 'MENU_PERMISSION_DENIED',
  'SECURITY_CHALLENGE', 'ROLE_SELECTION_REQUIRED', 'PUBLIC_LANDING', 'PAGE_NOT_READY',
  'BUSINESS_ROUTE_UNEXPECTED', 'SEARCH_CONTROL_NOT_UNIQUE', 'SEARCH_BUTTON_NOT_UNIQUE',
  'SEARCH_BUTTON_NOT_ACTIONABLE', 'SEARCH_QUERY_NOT_EMPTY', 'SEARCH_QUERY_MISMATCH',
  'SEARCH_SUGGESTION_UNVERIFIED', 'SEARCH_SUGGESTION_NOT_ACTIONABLE',
  'PREEXISTING_TARGET_AMBIGUOUS', 'TARGET_SEARCH_AMBIGUOUS','CONTACT_MARKER_UNRESOLVED',
  'WECHAT_NOT_PROVIDED',
  'TARGET_SEARCH_UNVERIFIED', 'TARGET_NOT_FOUND', 'CONTACT_LABEL_NOT_PRESENT', 'DETAIL_LINK_NOT_UNIQUE',
  'DETAIL_LINK_NOT_VERIFIED', 'DETAIL_NOT_OPENED', 'WECHAT_ROW_NOT_UNIQUE','WECHAT_ROW_NOT_READY',
  'REVEAL_CONTROL_NOT_UNIQUE', 'REVEAL_CONTROL_NOT_ACTIONABLE', 'REVEAL_UNCONFIRMED',
  'REVEAL_RECOVERY_REFRESH_UNAVAILABLE','REVEAL_LISTENER_INSTALL_FAILED','REVEAL_LISTENER_CLEANUP_FAILED',
  'EXECUTION_CONTEXT_CHANGED', 'TARGET_PAGE_CLOSED', 'BROWSER_CLOSE_FAILED', 'BROWSER_ERROR',
  'BACKGROUND_GUARD_FAILED',
  'BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
]);
const BACKGROUND_GUARD_REASONS = new Set([
  'BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
]);
const SAFE_RUNTIME_ERROR_TYPES = new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError']);

function reasonFromAuthState(state = {}) {
  if (state.hasChallenge) return 'SECURITY_CHALLENGE';
  if (state.menuPermissionDenied) return 'MENU_PERMISSION_DENIED';
  if (state.authExpiredPrompt) return 'AUTH_EXPIRED';
  if (state.authRequiredPrompt || state.loginPrompt || state.loginForm || state.loginEntryVisible) return 'AUTH_REQUIRED';
  if (state.route === 'ROLE_SELECT' || state.state === 'ROLE_SELECTION_REQUIRED') return 'ROLE_SELECTION_REQUIRED';
  if (state.route === 'OTHER_ORIGIN') return 'AUTH_OR_PERMISSION_UNRESOLVED';
  return '';
}

function reasonFromAuthEvidence(evidence = {}) {
  if (evidence.authPromptLatched === true) return 'AUTH_REQUIRED';
  const counts = evidence.counters ?? evidence;
  if (Number(counts.menuDeniedMessageResponseCount) > 0 || Number(counts.menuDeniedResponseCount) > 0) {
    return 'MENU_PERMISSION_DENIED';
  }
  if (Number(counts.authExpiredResponseCount) > 0 || Number(counts.authMessageExpiredResponseCount) > 0) {
    return 'AUTH_EXPIRED';
  }
  if (AUTH_COUNTER_KEYS.some(key => Number(counts[key]) > 0)) return 'AUTH_REQUIRED';
  return '';
}

function reasonFromNewAuthEvidence(before = {}, after = {}) {
  const oldCounts = before.counters ?? before;
  const newCounts = after.counters ?? after;
  if (after.authPromptLatched === true && before.authPromptLatched !== true) return 'AUTH_REQUIRED';
  const delta = {};
  for (const key of AUTH_COUNTER_KEYS) delta[key] = Math.max(0, Number(newCounts[key] ?? 0) - Number(oldCounts[key] ?? 0));
  return reasonFromAuthEvidence({counters:delta});
}

export function safeResponseEvidence(evidence = {}) {
  const counts=evidence.counters??evidence;
  const keys=['observedResponseCount','feedResponseCount','imResponseCount','otherResponseCount',
    'http2xxResponseCount','http4xxResponseCount','http5xxResponseCount','jsonResponseCount',
    'inspectedJsonResponseCount','uninspectedJsonResponseCount','jsonParseFailureCount',
    'nonzeroCodeResponseCount','unknownErrorResponseCount','targetFeedErrorCount'];
  const result=Object.fromEntries(keys.map(key=>[key,Math.max(0,Number(counts[key])||0)]));
  result.authPromptLatched=evidence.authPromptLatched===true;
  result.explicitAuthResponseCount=['authRequiredResponseCount','authExpiredResponseCount','menuDeniedResponseCount',
    'authHttp401ResponseCount','authEnvelope401ResponseCount',
    'authMessageNotLoggedInResponseCount','authMessageExpiredResponseCount','menuDeniedMessageResponseCount']
    .reduce((total,key)=>total+Math.max(0,Number(counts[key])||0),0);
  return result;
}

export function safeSearchDiagnostics(value = {}) {
  const count=input=>Number.isInteger(input)&&input>=0&&input<=100000?input:null;
  const enumValue=(input,allowed,fallback)=>allowed.has(input)?input:fallback;
  const executionPhases=new Set(['argument_validation','page_guard','control_lookup','input_fill','button_readiness',
    'activation_guard','click_dispatch','response_wait','response_validation','visible_result','detail_link']);
  const exceptionCategories=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
  return {
    submittedAfterActivation:value.submittedAfterActivation===true,
    queryType:enumValue(value.queryType,new Set(['ID','NICKNAME']),'ID'),
    attemptCount:count(value.attemptCount)??0,
    fallbackReason:enumValue(value.fallbackReason,new Set(['','nickname_no_exact_stable_id','nickname_query_unverified']),''),
    feedRequestCount:count(value.feedRequestCount)??0,
    matchedRequestCount:count(value.matchedRequestCount)??0,
    matchedResponseCount:count(value.matchedResponseCount)??0,
    creatorIdQueryMatchesTarget:value.creatorIdQueryMatchesTarget===true,
    httpStatusCategory:enumValue(value.httpStatusCategory,new Set(['missing','2xx','4xx','5xx','other']),'missing'),
    businessCodeCategory:enumValue(value.businessCodeCategory,new Set(['missing','zero','nonzero']),'missing'),
    listCount:count(value.listCount),
    exactIdMatchCount:count(value.exactIdMatchCount)??0,
    awemeIdMatchesTarget:value.awemeIdMatchesTarget===true,
    feedResultIdMatchesTarget:value.feedResultIdMatchesTarget===true,
    selectedExactResultPresent:value.selectedExactResultPresent===true,
    uidFromExactResult:value.uidFromExactResult===true,
    visibleExactIdMatchCount:count(value.visibleExactIdMatchCount),
    visibleStableIdentityMatchCount:count(value.visibleStableIdentityMatchCount),
    matchedIdentityKeyKind:['UID','AWEME_ID','BOTH'].includes(value.matchedIdentityKeyKind)?value.matchedIdentityKeyKind:'',
    matchedIdentityAttributeNames:Array.isArray(value.matchedIdentityAttributeNames)
      ?value.matchedIdentityAttributeNames.filter(name=>['data-row-key','data-key','data-id','data-uid','id'].includes(name)).slice(0,5):[],
    matchedIdentityHrefParamNames:Array.isArray(value.matchedIdentityHrefParamNames)
      ?value.matchedIdentityHrefParamNames.filter(name=>['uid','aweme_id','author_id','id'].includes(name)).slice(0,4):[],
    contactLabelPresent:value.contactLabelPresent===true,
    contactMarkerState:['present','absent','unresolved'].includes(value.contactMarkerState)?value.contactMarkerState:'missing',
    contactMarkerAttributeNames:Array.isArray(value.contactMarkerAttributeNames)
      ?value.contactMarkerAttributeNames.filter(name=>/^(?:aria-label|title|data-[a-z0-9_-]{1,40})$/iu.test(name)).slice(0,12):[],
    uidPresent:value.uidPresent===true,
    failureBranch:enumValue(value.failureBranch,SEARCH_FAILURE_BRANCH_SET,'unknown'),
    ...(executionPhases.has(value.executionPhase)&&exceptionCategories.has(value.exceptionCategory)
      ?{executionPhase:value.executionPhase,exceptionCategory:value.exceptionCategory}:{}),
  };
}

export function safeOpenDetailDiagnostics(value={}) {
  return OPEN_DETAIL_EXECUTION_PHASES.has(value.executionPhase)&&
    OPEN_DETAIL_EXCEPTION_CATEGORIES.has(value.exceptionCategory)
    ?{executionPhase:value.executionPhase,exceptionCategory:value.exceptionCategory}:null;
}

function executionExceptionCategory(error) {
  const className=typeof error?.name==='string'?error.name:'';
  return ['TargetClosedError','PageClosedError','BrowserClosedError'].includes(className)
    ?'target_closed':['ProtocolError','WebSocketError','ConnectionError'].includes(className)?'protocol'
    :className==='TimeoutError'?'timeout':['ExecutionContextError','ExecutionContextDestroyedError'].includes(className)
      ?'execution_context':['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(className)
        ?'javascript':'other';
}

export function safeWorkerIdentityProof(value=null) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
      !['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED'].includes(value.type)||
      !Number.isInteger(value.exactIdMatchCount)||value.exactIdMatchCount<0||value.exactIdMatchCount>100000) return null;
  return {
    type:value.type,
    creatorIdMatchesTarget:typeof value.creatorIdMatchesTarget==='boolean'?value.creatorIdMatchesTarget:null,
    awemeIdMatchesTarget:typeof value.awemeIdMatchesTarget==='boolean'?value.awemeIdMatchesTarget:null,
    exactIdMatchCount:value.exactIdMatchCount,
    uidFromExactResult:typeof value.uidFromExactResult==='boolean'?value.uidFromExactResult:null,
    profileRouteUidMatchesExactResultUid:typeof value.profileRouteUidMatchesExactResultUid==='boolean'
      ?value.profileRouteUidMatchesExactResultUid:null,
    querySubmittedAfterActivation:typeof value.querySubmittedAfterActivation==='boolean'
      ?value.querySubmittedAfterActivation:null,
    requestResponseBound:typeof value.requestResponseBound==='boolean'?value.requestResponseBound:null,
    httpStatusCategory:['missing','2xx','4xx','5xx','other'].includes(value.httpStatusCategory)
      ?value.httpStatusCategory:'missing',
    businessCodeCategory:['missing','zero','nonzero'].includes(value.businessCodeCategory)
      ?value.businessCodeCategory:'missing',
    authEvidenceAbsent:typeof value.authEvidenceAbsent==='boolean'?value.authEvidenceAbsent:null,
  };
}

function buildWorkerIdentityProof({type,targetId,identityProof={},search={},profileRouteUidMatchesExactResultUid=false,
  authEvidenceAbsent=false}={}) {
  const exactIdMatchCount=search.exactIdMatchCount;
  const awemeIdMatchesTarget=exactIdMatchCount===1&&
    (typeof identityProof?.awemeId==='string'?identityProof.awemeId===targetId:search.awemeIdMatchesTarget===true);
  const requestResponseBound=search.matchedRequestCount===1&&search.matchedResponseCount===1&&
    (exactIdMatchCount===0 ? search.creatorIdQueryMatchesTarget===true :
      (identityProof?.responseBoundToRequest===true || (identityProof==null&&awemeIdMatchesTarget)));
  const uidFromExactResult=exactIdMatchCount===1&&
    (identityProof?.uidFromExactResult===true || (identityProof==null&&search.uidFromExactResult===true));
  const profileRouteMatches=profileRouteUidMatchesExactResultUid===true;
  const submittedAfterActivation=search.submittedAfterActivation===true;
  const httpStatusCategory=search.httpStatusCategory;
  const businessCodeCategory=search.businessCodeCategory;
  const completeEvidence=requestResponseBound&&submittedAfterActivation&&httpStatusCategory==='2xx'&&
    businessCodeCategory==='zero'&&authEvidenceAbsent===true;
  const creatorIdMatchesTarget=exactIdMatchCount===0
    ?search.queryType==='ID'&&search.creatorIdQueryMatchesTarget===true&&completeEvidence
    :type==='API_FEED_ID_MATCH'
      ?awemeIdMatchesTarget&&uidFromExactResult&&profileRouteMatches&&completeEvidence
      :awemeIdMatchesTarget&&uidFromExactResult&&completeEvidence;
  return safeWorkerIdentityProof({type,
    creatorIdMatchesTarget,
    awemeIdMatchesTarget,
    exactIdMatchCount,
    uidFromExactResult,
    profileRouteUidMatchesExactResultUid:profileRouteMatches,
    querySubmittedAfterActivation:submittedAfterActivation,
    requestResponseBound,
    httpStatusCategory,
    businessCodeCategory,
    authEvidenceAbsent});
}

export function safeRevealDiagnostics(value={}) {
  const count=input=>Number.isInteger(input)&&input>=0&&input<=100?input:null;
  const timelinePhases=new Set(['pre_click','click_result','poll','poll_error']);
  const safeCategory=input=>['none_or_unrecognized','contact_success_notice','auth_notice','risk_notice']
    .includes(input)?input:'none_or_unrecognized';
  const feedbackCategories=new Set(['contact_category_restricted','auth_notice','risk_notice','unrecognized_notice']);
  const feedbackSurfaces=new Set(['aria-live','role-alert','role-status','visible-leaf']);
  const safeIso=value=>{
    if(typeof value!=='string')return null;
    const date=new Date(value);
    return Number.isFinite(date.getTime())&&date.toISOString()===value?value:null;
  };
  const feedbackClassification=category=>({
    contact_category_restricted:{diagnosticCode:'CONTACT_CATEGORY_RESTRICTED',
      errorReason:'CONTACT_CATEGORY_RESTRICTED',redactedText:'[REDACTED]'},
    auth_notice:{diagnosticCode:'AUTH_REQUIRED',errorReason:'AUTH_REQUIRED',redactedText:'[REDACTED]'},
    risk_notice:{diagnosticCode:'SECURITY_CHALLENGE',errorReason:'SECURITY_CHALLENGE',redactedText:'[REDACTED]'},
    unrecognized_notice:{diagnosticCode:'UNRECOGNIZED_TRANSIENT_NOTICE',
      errorReason:'UNRECOGNIZED_TRANSIENT_NOTICE',redactedText:'[REDACTED]'},
  })[category];
  const safeFeedbackEvent=event=>{
    const classification=feedbackClassification(event?.category);
    if(!classification)return null;
    return {category:event.category,
      originalText:null,
      ...(safeIso(event.observedAt)?{observedAt:event.observedAt}:{}),
      elapsedMs:Number.isInteger(event.elapsedMs)&&event.elapsedMs>=0&&event.elapsedMs<=30000?event.elapsedMs:null,
      afterAction:event.afterAction===true,targetBound:event.targetBound===true,
      surface:feedbackSurfaces.has(event.surface)?event.surface:'visible-leaf',
      redactedText:classification.redactedText,
      classification:{status:'error',diagnosticCode:classification.diagnosticCode,
        errorReason:classification.errorReason}};
  };
  const safeToastObservation=value=>{
    if(!value||typeof value!=='object')return undefined;
    const installed=value.observer?.installed===true;
    const installAttemptAt=safeIso(value.observer?.installAttemptedAt);
    const installedAt=safeIso(value.observer?.installedAt);
    const actionAt=safeIso(value.window?.actionAt);
    const completedAt=safeIso(value.window?.completedAt);
    const limitMs=[5000,20000].includes(value.window?.limitMs)?value.window.limitMs:null;
    const observedMs=actionAt&&completedAt?Date.parse(completedAt)-Date.parse(actionAt):null;
    const durationBound=Number.isInteger(observedMs)&&!!limitMs&&observedMs>=limitMs&&observedMs<=limitMs+1000;
    const installBound=!!installAttemptAt&&!!installedAt&&!!actionAt&&
      Date.parse(installAttemptAt)<=Date.parse(installedAt)&&Date.parse(installedAt)<=Date.parse(actionAt);
    const rawEvents=Array.isArray(value.toast?.events)?value.toast.events:[];
    const events=rawEvents.slice(0,20).flatMap(event=>{
      const eventAt=safeIso(event?.observedAt);
      if(!eventAt||!actionAt||!completedAt||Date.parse(eventAt)<Date.parse(actionAt)||
          Date.parse(eventAt)>Date.parse(completedAt)||event?.afterAction!==true||event?.targetBound!==true)return [];
      const safe=safeFeedbackEvent(event);
      return safe?[safe]:[];
    });
    const eventSetBound=rawEvents.length<=20&&events.length===rawEvents.length;
    const succeeded=value.window?.observationSucceeded===true&&installed&&installBound&&durationBound&&
      value.target?.identityPairVerified===true&&value.observer?.boundToTargetPage===true&&eventSetBound;
    const safeStatus=succeeded?(events.length?'observed':'observed_none'):'unobserved';
    const installFailureCode=['PAGE_OBSERVER_UNAVAILABLE','OBSERVER_INSTALL_FAILED','PAGE_CONTEXT_CHANGED']
      .includes(value.observer?.installFailureCode)?value.observer.installFailureCode:null;
    return {action:'expand',target:{identityPairVerified:value.target?.identityPairVerified===true},
      observer:{installAttemptedAt:installAttemptAt,installed,
        installedAt:installed?installedAt:null,
        installFailureCode:installed?null:installFailureCode||'OBSERVER_INSTALL_FAILED',
        pageBindingFailureCode:installed&&value.observer?.pageBindingFailureCode==='PAGE_CONTEXT_CHANGED'
          ?'PAGE_CONTEXT_CHANGED':null,
        boundToTargetPage:value.observer?.boundToTargetPage===true},
      window:{actionAt,completedAt,
        limitMs,observedMs:Number.isInteger(observedMs)&&observedMs>=0&&observedMs<=30000?observedMs:null,
        observationSucceeded:succeeded},
      toast:{status:safeStatus,present:safeStatus==='unobserved'?null:safeStatus==='observed',events}};
  };
  const classifyAttempt=signal=>{
    const samples=Array.isArray(signal?.timelineSamples)?signal.timelineSamples:[];
    if(signal?.clickEventObserved===false)return 'click_event_not_observed';
    if(samples.some(sample=>sample?.readOutcome==='error'))return 'field_read_error';
    const unmasked=samples.find(sample=>sample?.masked===false);
    if(unmasked){
      if(unmasked.labelMatched!==true||unmasked.nonMaskedValue!==true||unmasked.unmaskedTextPresent!==true)
        return 'unmasked_but_unreadable';
      return Number.isInteger(unmasked.elapsedMs)&&unmasked.elapsedMs>5000
        ?'late_reveal_after_5s':'revealed_during_wait';
    }
    return Number.isInteger(signal?.waitWindowMs)&&Number.isInteger(signal?.waitWindowLimitMs)&&
      signal.waitWindowMs>=signal.waitWindowLimitMs&&signal.domState==='masked'
      ?'no_reveal_observed':'unresolved';
  };
  const branches=new Set(['','initial_label_unverified','post_click_label_unverified',
    'post_click_row_changed','post_click_masked_timeout','nonmasked_value_unverified',
    'post_click_response_rejected','click_unknown','auth_interruption','risk_interruption',
    'identity_or_guard_interruption','listener_setup_failed','listener_cleanup_failed','readiness_timeout',
    'contact_category_restricted','unrecognized_transient_notice']);
  const executionPhases=new Set(['initial_guard','locator_counts','channel_probe','row_inspection','eye_control',
    'pre_click_check','observer_setup','click_dispatch','reveal_poll','feedback_cleanup','post_reveal_guard',
    'post_reveal_identity']);
  const exceptionCategories=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
  const attempts=Array.isArray(value.attemptSignals)?value.attemptSignals.slice(0,5).map(signal=>({
    requestCount:signal?.requestCount===null?null:Number.isInteger(signal?.requestCount)&&signal.requestCount>=0&&signal.requestCount<=20
      ?signal.requestCount:null,
    responseCount:signal?.responseCount===null?null:Number.isInteger(signal?.responseCount)&&signal.responseCount>=0&&signal.responseCount<=20
      ?signal.responseCount:null,
    endpointClass:['none','other_same_origin','other_cross_origin','ambiguous'].includes(signal?.endpointClass)
      ?signal.endpointClass:'none',
    httpStatusCategory:['missing','2xx','4xx','5xx','other','multiple'].includes(signal?.httpStatusCategory)
      ?signal.httpStatusCategory:'missing',
    businessCodeCategory:['missing','zero','nonzero','multiple'].includes(signal?.businessCodeCategory)
      ?signal.businessCodeCategory:'missing',
    correlationState:['unobserved','no_request','zero_observed_requests','request_no_response','ambiguous_multiple',
      'single_other_endpoint','response_http_error','response_business_error','response_2xx_zero_code',
      'response_unclassified'].includes(signal?.correlationState)
      ?signal.correlationState:'unobserved',
    elapsedMs:Number.isInteger(signal?.elapsedMs)&&signal.elapsedMs>=0&&signal.elapsedMs<=30000
      ?signal.elapsedMs:null,
    waitWindowMs:Number.isInteger(signal?.waitWindowMs)&&signal.waitWindowMs>=0&&signal.waitWindowMs<=30000
      ?signal.waitWindowMs:null,
    waitWindowLimitMs:[5000,20000].includes(signal?.waitWindowLimitMs)?signal.waitWindowLimitMs:null,
    clickDispatchMs:Number.isInteger(signal?.clickDispatchMs)&&signal.clickDispatchMs>=0&&signal.clickDispatchMs<=30000
      ?signal.clickDispatchMs:null,
    clickEventObserved:typeof signal?.clickEventObserved==='boolean'?signal.clickEventObserved:null,
    evidenceClass:classifyAttempt(signal),
    timelineSamples:Array.isArray(signal?.timelineSamples)?signal.timelineSamples.slice(0,103).map(sample=>({
      phase:timelinePhases.has(sample?.phase)?sample.phase:'poll',
      elapsedMs:Number.isInteger(sample?.elapsedMs)&&sample.elapsedMs>=0&&sample.elapsedMs<=30000?sample.elapsedMs:null,
      rowCount:count(sample?.rowCount),
      labelMatched:typeof sample?.labelMatched==='boolean'?sample.labelMatched:null,
      masked:typeof sample?.masked==='boolean'?sample.masked:null,
      unmaskedTextPresent:sample?.unmaskedTextPresent===true,
      nonMaskedValue:sample?.nonMaskedValue===true,
      readOutcome:['ok','error','not_run'].includes(sample?.readOutcome)?sample.readOutcome:'not_run',
      notificationCategory:safeCategory(sample?.notificationCategory),
      profileUidConfirmed:sample?.profileUidConfirmed===true,
      pageVisibility:['hidden','visible','prerender'].includes(sample?.pageVisibility)?sample.pageVisibility:'unknown',
    })):[],
    domState:['masked','nonmasked','unresolved'].includes(signal?.domState)?signal.domState:'unresolved',
    notificationCategory:['none_or_unrecognized','contact_success_notice','auth_notice','risk_notice']
      .includes(signal?.notificationCategory)?signal.notificationCategory:'none_or_unrecognized',
    notificationBaselineCategory:['none_or_unrecognized','contact_success_notice','auth_notice','risk_notice']
      .includes(signal?.notificationBaselineCategory)?signal.notificationBaselineCategory:'none_or_unrecognized',
    transientFeedbackEvents:Array.isArray(signal?.transientFeedbackEvents)
      ?signal.transientFeedbackEvents.slice(0,20).filter(event=>feedbackCategories.has(event?.category))
        .map(safeFeedbackEvent).filter(Boolean):[],
    ...(safeToastObservation(signal?.feedbackObservation)
      ?{feedbackObservation:safeToastObservation(signal.feedbackObservation)}:{}),
    observationState:['observed','unobserved'].includes(signal?.observationState)?signal.observationState:'unobserved',
    orphanResponseCount:Number.isInteger(signal?.orphanResponseCount)&&signal.orphanResponseCount>=0&&
      signal.orphanResponseCount<=20?signal.orphanResponseCount:0,
  })):[];
  return {failureBranch:branches.has(value.failureBranch)?value.failureBranch:'',
    ...(executionPhases.has(value.executionPhase)?{executionPhase:value.executionPhase}:{}),
    ...(exceptionCategories.has(value.exceptionCategory)?{exceptionCategory:value.exceptionCategory}:{}),
    contactItemCount:count(value.contactItemCount),visibleContactItemCount:count(value.visibleContactItemCount),
    wechatLocatorCount:count(value.wechatLocatorCount),visibleWechatLocatorCount:count(value.visibleWechatLocatorCount),
    eyeControlCount:count(value.eyeControlCount),
    eyeActivationCount:Number.isInteger(value.eyeActivationCount)&&value.eyeActivationCount>=0&&value.eyeActivationCount<=5
      ?value.eyeActivationCount:0,
    clickIssued:value.clickIssued===true,
    clickAttemptCount:Number.isInteger(value.clickAttemptCount)&&value.clickAttemptCount>=0&&value.clickAttemptCount<=5
      ?value.clickAttemptCount:0,
    recoveryPhase:['single','first','refreshed','rebaseline'].includes(value.recoveryPhase)?value.recoveryPhase:'single',
    recoveryOperationId:typeof value.recoveryOperationId==='string'&&
      /^[A-Za-z0-9._-]{1,80}$/u.test(value.recoveryOperationId)?value.recoveryOperationId:'',
    recoveryExecutionId:typeof value.recoveryExecutionId==='string'&&
      /^[A-Za-z0-9._-]{1,80}$/u.test(value.recoveryExecutionId)?value.recoveryExecutionId:'',
    recoveryParentAttemptId:typeof value.recoveryParentAttemptId==='string'&&
      /^[A-Za-z0-9._-]{1,80}$/u.test(value.recoveryParentAttemptId)?value.recoveryParentAttemptId:'',
    priorReceiptVerified:value.priorReceiptVerified===true,
    reservedClickCount:Number.isInteger(value.reservedClickCount)&&value.reservedClickCount>=0&&value.reservedClickCount<=2
      ?value.reservedClickCount:0,
    reservedRefreshCount:Number.isInteger(value.reservedRefreshCount)&&[0,1].includes(value.reservedRefreshCount)
      ?value.reservedRefreshCount:0,
    refreshCount:Number.isInteger(value.refreshCount)&&[0,1].includes(value.refreshCount)?value.refreshCount:0,
    pageReloaded:value.pageReloaded===true,rebaselinePassed:value.rebaselinePassed===true,
    attemptSignals:attempts,
    clickState:['not_issued','issued','unknown'].includes(value.clickState)?value.clickState:'unknown',
    labelMatched:value.labelMatched===true,
    finalState:['masked','nonmasked','unresolved'].includes(value.finalState)?value.finalState:'unresolved'};
}

export function revealCategoryRestrictionEvidence(diagnostics={}) {
  if(diagnostics?.failureBranch!=='contact_category_restricted'||diagnostics?.finalState!=='masked')return false;
  return Array.isArray(diagnostics?.attemptSignals)&&diagnostics.attemptSignals.some(signal=>
    signal?.clickEventObserved===true&&signal?.domState==='masked'&&
    signal?.feedbackObservation?.action==='expand'&&
    signal.feedbackObservation.target?.identityPairVerified===true&&
    signal.feedbackObservation.observer?.installed===true&&
    signal.feedbackObservation.observer?.boundToTargetPage===true&&
    signal.feedbackObservation.window?.observationSucceeded===true&&
    signal.feedbackObservation.toast?.status==='observed'&&
    signal.feedbackObservation.toast?.present===true&&
    Array.isArray(signal?.transientFeedbackEvents)&&signal.transientFeedbackEvents.some(event=>
      event?.category==='contact_category_restricted'&&event.afterAction===true&&event.targetBound===true&&
      event?.classification?.diagnosticCode==='CONTACT_CATEGORY_RESTRICTED'&&
      event?.classification?.errorReason==='CONTACT_CATEGORY_RESTRICTED'));
}

export function safeChannelDiagnostics(value={}) {
  const count=input=>Number.isInteger(input)&&input>=0&&input<=100?input:null;
  return {observedReady:value.observedReady===true,profileUidConfirmed:value.profileUidConfirmed===true,
    contextStable:value.contextStable===true,targetHidden:value.targetHidden===true,authHealthy:value.authHealthy===true,
    visibleContactItemCount:count(value.visibleContactItemCount),visibleWechatRowCount:count(value.visibleWechatRowCount),
    visibleOtherChannelCount:count(value.visibleOtherChannelCount),unclassifiedRowCount:count(value.unclassifiedRowCount),
    contactItemCount:count(value.contactItemCount),wechatLocatorCount:count(value.wechatLocatorCount),
    visibleWechatLocatorCount:count(value.visibleWechatLocatorCount),phoneLocatorCount:count(value.phoneLocatorCount),
    visiblePhoneLocatorCount:count(value.visiblePhoneLocatorCount),
    stableSamples:Number.isInteger(value.stableSamples)&&value.stableSamples>=0&&value.stableSamples<=100
      ?value.stableSamples:0};
}

export function safeGuardDiagnostics(value={}){
  const reasons=new Set(['BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
    'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
    'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED','DETAIL_LINK_NOT_VERIFIED',
    'AUTH_OR_PERMISSION_UNRESOLVED','AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED',
    'SECURITY_CHALLENGE','BROWSER_ERROR','BACKGROUND_GUARD_FAILED']);
  return {targetClosed:value.targetClosed===true,targetContextMatches:value.targetContextMatches===true,
    targetHidden:value.targetHidden===true,pageSetStable:value.pageSetStable===true,
    otherPagesStable:value.otherPagesStable===true,otherPageNavigationChanged:value.otherPageNavigationChanged===true,
    otherPageVisibilityChanged:value.otherPageVisibilityChanged===true,otherPageDocumentChanged:value.otherPageDocumentChanged===true,
    profileUidConfirmed:value.profileUidConfirmed===true,authHealthy:value.authHealthy===true,errorFree:value.errorFree===true,
    reason:reasons.has(value.reason)?value.reason:''};
}

function contactStatusFor(reason) {
  if (['AUTH_REQUIRED', 'AUTH_EXPIRED', 'MENU_PERMISSION_DENIED'].includes(reason)) {
    return 'login_required';
  }
  if (reason === 'SECURITY_CHALLENGE') return 'captcha';
  if (reason === 'CONTACT_LABEL_NOT_PRESENT' || reason === 'WECHAT_NOT_PROVIDED') return 'not_shown';
  if (reason === 'TARGET_NOT_FOUND') return 'not_found';
  if (reason === 'CONTACT_CATEGORY_RESTRICTED') return 'forbidden_by_platform';
  return 'error';
}

function safeReason(value) {
  return SAFE_REASONS.has(value) ? value : 'BROWSER_ERROR';
}

function safeRuntimeErrorType(error) {
  return SAFE_RUNTIME_ERROR_TYPES.has(error?.name) ? error.name : 'OTHER';
}

function isValidProfileHref(value) {
  if(typeof value!=='string')return false;
  const hashIndex=value.indexOf('#');
  const withoutHash=hashIndex<0?value:value.slice(0,hashIndex);
  const queryIndex=withoutHash.indexOf('?');
  const path=queryIndex<0?withoutHash:withoutHash.slice(0,queryIndex);
  const query=queryIndex<0?'':withoutHash.slice(queryIndex+1);
  if(!/^https:\/\/buyin\.jinritemai\.com\/dashboard\/servicehall\/daren-profile(?:\/.*)?$/u.test(path))return false;
  const uidFields=query.split('&').filter(field=>field.split('=',1)[0]==='uid');
  if(uidFields.length!==1)return false;
  const encoded=uidFields[0].slice(uidFields[0].indexOf('=')+1);
  try{return decodeURIComponent(encoded.replaceAll('+',' ')).trim().length>0;}catch{return false;}
}

function hasVerifiedApiFeedIdentity(match, creatorId) {
  const proof = match?.identityProof;
  return match?.resultStructure === 'API_FEED_ID_MATCH' && match?.formalMatch === true &&
    match?.exactMatches === 1 && proof?.submittedAfterActivation === true &&
    proof?.requestIdMatched === true && typeof proof?.requestIdFieldPath === 'string' &&
    proof.requestIdFieldPath.length > 0 && proof?.responseBoundToRequest === true &&
    proof?.httpStatus === 200 && proof?.envelopeCode === 0 && Number.isInteger(proof?.listCount) &&
    proof.listCount >= 1 && proof?.exactIdMatchCount === 1 &&
      proof?.awemeId === creatorId &&
      proof?.uidFromExactResult === true && proof?.detailUrlBoundToRecordUid === true &&
    proof?.domResultCount === 1 && ['UID','AWEME_ID','BOTH'].includes(proof?.domIdentityKeyKind) &&
    proof?.domIdentityBoundToCurrentFeedItem === true &&
    isValidProfileHref(match?.detailHref);
}

function requireVerifiedContactMarker(state,labelPresent) {
  if(!['present','absent'].includes(state))throw new Error('CONTACT_MARKER_UNRESOLVED');
  if(state==='absent'){
    if(labelPresent===true)throw new Error('CONTACT_MARKER_UNRESOLVED');
    throw new Error('CONTACT_LABEL_NOT_PRESENT');
  }
  if(labelPresent!==true)throw new Error('CONTACT_MARKER_UNRESOLVED');
}

function emptyReceipt(stage, reason, values = {}) {
  return {
    mode:'same_context_contact_e2e',
    status:'stopped',
    stage,
    reason:safeReason(reason),
    sameContext:false,
    samePage:false,
    authFailureSeen:false,
    formalIdMatch:false,
    profileOpened:false,
    wechatRowUnique:false,
    revealed:false,
    identityProof:'',
    workerIdentityProof:null,
    labelMatched:false,
    nonMaskedValue:false,
    contactItemCount:null,
    visibleContactItemCount:null,
    wechatLocatorCount:null,
    visibleWechatLocatorCount:null,
    eyeControlCount:null,
    revealDiagnostics:safeRevealDiagnostics(),
    channelDiagnostics:safeChannelDiagnostics(),
    finalBackgroundGuard:false,
    errorFree:false,
    responseEvidence:safeResponseEvidence(),responseEvidenceObserved:false,
    searchDiagnostics:safeSearchDiagnostics(),
    searchDiagnosticsObserved:false,
    revealDiagnosticsObserved:false,guardDiagnosticsObserved:false,
    guardDiagnostics:safeGuardDiagnostics(),
    ...values,
  };
}

function stopped(stage, reason, now, receiptValues = {}) {
  const fixedReason = safeReason(reason);
  return {
    receipt:emptyReceipt(stage, fixedReason, receiptValues),
    attempt:{contactStatus:contactStatusFor(fixedReason), contactCheckedAt:now().toISOString(), errorReason:fixedReason},
  };
}

function assertSameTargets(driver, context, page) {
  if (driver.context !== context || driver.page !== page) throw new Error('EXECUTION_CONTEXT_CHANGED');
}

async function verifyNoAuthEvidence(driver, baseline, {allowInitialEvidence = false} = {}) {
  const [state, evidence] = await Promise.all([driver.inspectAuthState(), driver.readAuthEvidence()]);
  const currentReason = reasonFromAuthState(state);
  if (currentReason) throw new Error(currentReason);
  const evidenceReason = allowInitialEvidence ? reasonFromAuthEvidence(evidence) : reasonFromNewAuthEvidence(baseline, evidence);
  if (evidenceReason) throw new Error(evidenceReason);
  return {state,evidence};
}

async function inspectFailureAuthEvidence(driver, baseline) {
  if (!driver || typeof driver.inspectAuthState !== 'function' || typeof driver.readAuthEvidence !== 'function') {
    return {reason:'',evidence:null,unresolved:true};
  }
  try {
    const observation=typeof driver.inspectFailureAuthEvidence==='function'
      ?await driver.inspectFailureAuthEvidence()
      :await (async()=>{
        const [state,evidence]=await Promise.all([driver.inspectAuthState(),driver.readAuthEvidence()]);
        return {state,evidence,unresolved:false};
      })();
    if(observation?.unresolved)return {reason:'AUTH_OR_PERMISSION_UNRESOLVED',
      evidence:observation.evidence||null,unresolved:true};
    const stateReason=reasonFromAuthState(observation?.state);
    const reason=stateReason|| (baseline===null
      ?reasonFromAuthEvidence(observation?.evidence)
      :reasonFromNewAuthEvidence(baseline,observation?.evidence));
    return {reason,evidence:observation?.evidence||null,unresolved:false};
  } catch {
    return {reason:'AUTH_OR_PERMISSION_UNRESOLVED',evidence:null,unresolved:true};
  }
}

/**
 * One owned browser context and page perform the entire authorized target path.
 * The injected driver is also the offline test seam; the CLI driver is responsible
 * for page locators, current-page auth observation, and the shared response tracker.
 */
export async function runSameContextBuyinContact({driver, creatorId, creatorName='',
  now = () => new Date()} = {}) {
  let stage = 'auth-check';
  let result;
  let matchedIdentityProof=null;
  let profileRouteUidMatchesExactResultUid=false;
  const context = driver?.context;
  const page = driver?.page;
  const targetId = String(creatorId ?? '').trim();
  let evidenceBaseline = null;
  const receiptValues = {sameContext:false,samePage:false,authFailureSeen:false,
    responseEvidence:safeResponseEvidence(),responseEvidenceObserved:false,
    searchDiagnostics:safeSearchDiagnostics(),searchDiagnosticsObserved:false,
    revealDiagnosticsObserved:false,guardDiagnosticsObserved:false};

  try {
    if (!driver || !context || !page || typeof driver.close !== 'function' ||
        typeof driver.inspectAuthState !== 'function' || typeof driver.readAuthEvidence !== 'function' ||
        typeof driver.searchExactId !== 'function' || typeof driver.openMatchedProfile !== 'function' ||
        typeof driver.revealWechat !== 'function') throw new Error('BROWSER_ERROR');
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(targetId)) throw new Error('TARGET_SEARCH_UNVERIFIED');

    const initial = await verifyNoAuthEvidence(driver, {}, {allowInitialEvidence:true});
    evidenceBaseline = initial.evidence;
    receiptValues.responseEvidence=safeResponseEvidence(initial.evidence);
    receiptValues.responseEvidenceObserved=true;
    receiptValues.sameContext = driver.context === context;
    receiptValues.samePage = driver.page === page;
    if (!initial.state.businessReady || initial.state.route !== 'BUSINESS_LIST' ||
        initial.state.accountMarkerVisible !== true || initial.state.searchControlVisible !== true) {
      throw new Error(reasonFromAuthState(initial.state) || 'BUSINESS_ROUTE_UNEXPECTED');
    }

    stage = 'id-search';
    const nameQuery=String(creatorName??'').normalize('NFC').trim();
    const match=typeof driver.searchCreator==='function'
      ?await driver.searchCreator({creatorId:targetId,creatorName:nameQuery})
      :await driver.searchExactId(targetId);
    matchedIdentityProof=match?.identityProof||null;
    const searchEvidence=await driver.readSearchDiagnostics?.();
    if(searchEvidence){
      receiptValues.searchDiagnostics=safeSearchDiagnostics(searchEvidence);
      receiptValues.searchDiagnosticsObserved=true;
    }
    assertSameTargets(driver, context, page);
    await verifyNoAuthEvidence(driver, evidenceBaseline);
    const apiFeedMatch = match?.resultStructure === 'API_FEED_ID_MATCH';
    if (apiFeedMatch) {
      if (!hasVerifiedApiFeedIdentity(match, targetId)) {
        throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      receiptValues.identityProof = 'API_FEED_ID_MATCH';
      receiptValues.formalIdMatch = true;
      requireVerifiedContactMarker(match?.identityProof?.contactMarkerState,match?.contactLabelPresent);
    } else {
      if (!match || match.formalMatch !== true || match.exactMatches !== 1 ||
          !FORMAL_RESULT_STRUCTURES.has(match.resultStructure)) throw new Error('TARGET_SEARCH_UNVERIFIED');
      requireVerifiedContactMarker(match.contactMarkerState,match.contactLabelPresent);
      if (match.detailLinkCount !== 1) throw new Error('DETAIL_LINK_NOT_UNIQUE');
      if (!isValidProfileHref(match.detailHref)) throw new Error('DETAIL_LINK_NOT_VERIFIED');
      receiptValues.identityProof = match.resultStructure;
    }
    receiptValues.formalIdMatch = true;
    const searchAuthEvidence=await driver.readAuthEvidence();
    receiptValues.responseEvidence=safeResponseEvidence(searchAuthEvidence);
    receiptValues.responseEvidenceObserved=searchAuthEvidence!==undefined&&searchAuthEvidence!==null;

    stage = 'open-detail';
    const profile = await driver.openMatchedProfile(match);
    driver.setOpenDetailExecutionPhase?.('post_guard');
    assertSameTargets(driver, context, page);
    driver.setOpenDetailExecutionPhase?.('post_auth');
    await verifyNoAuthEvidence(driver, evidenceBaseline);
    driver.setOpenDetailExecutionPhase?.('post_result');
    if (profile?.route !== 'PROFILE' || profile?.opened !== true) throw new Error('DETAIL_NOT_OPENED');
    profileRouteUidMatchesExactResultUid=profile?.profileRouteUidMatchesExactResultUid===true;
    receiptValues.profileOpened = true;

    stage = 'reveal';
    const contact = await driver.revealWechat();
    receiptValues.channelDiagnostics=safeChannelDiagnostics(contact?.channelDiagnostics);
    receiptValues.revealDiagnostics=safeRevealDiagnostics(contact?.revealDiagnostics||{
      contactItemCount:contact?.contactItemCount,visibleContactItemCount:contact?.visibleContactItemCount,
      wechatLocatorCount:contact?.wechatLocatorCount,visibleWechatLocatorCount:contact?.visibleWechatLocatorCount,
      eyeControlCount:contact?.eyeControlCount,eyeActivationCount:contact?.eyeActivationCount,
      labelMatched:contact?.labelMatched,finalState:contact?.masked===false?'nonmasked':'unresolved'});
    receiptValues.revealDiagnosticsObserved=true;
    assertSameTargets(driver, context, page);
    await verifyNoAuthEvidence(driver, evidenceBaseline);
    for(const key of ['contactItemCount','visibleContactItemCount','wechatLocatorCount',
      'visibleWechatLocatorCount','eyeControlCount']){
      const count=contact?.[key];
      if(Number.isInteger(count)&&count>=0&&count<=100)receiptValues[key]=count;
    }
    if (contact?.rowCount !== 1) throw new Error('WECHAT_ROW_NOT_UNIQUE');
    receiptValues.wechatRowUnique = true;
    const value = String(contact?.contactValue ?? '').trim();
    if (contact?.revealed !== true || isMaskedContactValue(value)) throw new Error('REVEAL_UNCONFIRMED');
    if (!isValidProfileHref(contact?.sourceUrl ?? match.detailHref)) throw new Error('DETAIL_LINK_NOT_VERIFIED');

    if (apiFeedMatch) {
      if (contact?.labelMatched !== true || contact?.masked !== false || contact?.nonMaskedValue !== true ||
          !/[a-z0-9]/iu.test(value)) throw new Error('REVEAL_UNCONFIRMED');
      receiptValues.labelMatched = true;
      receiptValues.nonMaskedValue = true;

      stage = 'final-guard';
      const finalGuard = await driver.readFinalGuard?.();
      receiptValues.guardDiagnostics=safeGuardDiagnostics(finalGuard?.guardDiagnostics);
      const guard=receiptValues.guardDiagnostics;
      let finalEvidence=null;
      try {
        finalEvidence=await driver.readAuthEvidence();
        receiptValues.responseEvidence=safeResponseEvidence(finalEvidence);
      } catch {
        receiptValues.failureAuthEvidenceUnresolved=true;
      }
      const finalEvidenceReason=finalEvidence
        ?reasonFromNewAuthEvidence(evidenceBaseline,finalEvidence):'';
      if(finalEvidenceReason){
        const error=new Error(finalEvidenceReason);error.safeGuardDiagnostics=receiptValues.guardDiagnostics;throw error;
      }
      const rawReason=finalGuard?.reason||finalGuard?.guardDiagnostics?.reason;
      const specificReason=rawReason?safeReason(rawReason):'';
      if (BACKGROUND_GUARD_REASONS.has(specificReason)) {
        const error=new Error(specificReason);error.safeGuardDiagnostics=receiptValues.guardDiagnostics;throw error;
      }
      assertSameTargets(driver, context, page);
      await verifyNoAuthEvidence(driver, evidenceBaseline);
      if (!finalGuard || finalGuard.targetHidden !== true || finalGuard.otherPagesStable !== true ||
          finalGuard.authHealthy !== true || finalGuard.errorFree !== true||
          guard.targetClosed!==false||guard.targetContextMatches!==true||guard.targetHidden!==true||
          guard.pageSetStable!==true||guard.profileUidConfirmed!==true||guard.authHealthy!==true||
          guard.errorFree!==true||guard.reason!=='') {
        const reason=rawReason?safeReason(rawReason):'BACKGROUND_GUARD_FAILED';
        const error=new Error(reason);error.safeGuardDiagnostics=receiptValues.guardDiagnostics;throw error;
      }
      receiptValues.finalBackgroundGuard = true;
    }

    receiptValues.responseEvidence=safeResponseEvidence(await driver.readAuthEvidence());
    receiptValues.workerIdentityProof=buildWorkerIdentityProof({type:'API_FEED_ID_MATCH',targetId,
      identityProof:matchedIdentityProof,search:receiptValues.searchDiagnostics,
      profileRouteUidMatchesExactResultUid,
      authEvidenceAbsent:receiptValues.authFailureSeen===false&&receiptValues.failureAuthEvidenceUnresolved!==true&&
        receiptValues.responseEvidence.authPromptLatched!==true&&receiptValues.responseEvidence.explicitAuthResponseCount===0});

    result = {
      receipt:{
        ...emptyReceipt('complete','CONTACT_VALUE_VERIFIED'),
        mode:apiFeedMatch ? 'original_background_contact_e2e' : 'same_context_contact_e2e',
        status:'completed',
        sameContext:true,
        samePage:true,
        authFailureSeen:false,
        formalIdMatch:true,
        profileOpened:true,
        wechatRowUnique:true,
        revealed:true,
        identityProof:receiptValues.identityProof,
        workerIdentityProof:receiptValues.workerIdentityProof,
        labelMatched:apiFeedMatch ? true : contact?.labelMatched === true,
        nonMaskedValue:apiFeedMatch ? true : !isMaskedContactValue(value),
        finalBackgroundGuard:receiptValues.finalBackgroundGuard,
        errorFree:apiFeedMatch ? receiptValues.finalBackgroundGuard : false,
        responseEvidence:receiptValues.responseEvidence,
        responseEvidenceObserved:receiptValues.responseEvidenceObserved,
        guardDiagnostics:receiptValues.guardDiagnostics,
        guardDiagnosticsObserved:receiptValues.guardDiagnosticsObserved,
        searchDiagnostics:receiptValues.searchDiagnostics,
        searchDiagnosticsObserved:receiptValues.searchDiagnosticsObserved,
        revealDiagnostics:receiptValues.revealDiagnostics,
        revealDiagnosticsObserved:receiptValues.revealDiagnosticsObserved,
        channelDiagnostics:receiptValues.channelDiagnostics,
      },
      attempt:{
        contactStatus:'found',
        contactValue:value,
        contactCheckedAt:now().toISOString(),
        contactSourceUrl:contact.sourceUrl ?? match.detailHref,
        errorReason:'',
      },
    };
  } catch (error) {
    let reason = safeReason(error?.message);
    if(stage==='open-detail'&&reason==='BROWSER_ERROR'){
      try{
        receiptValues.openDetailDiagnostics=safeOpenDetailDiagnostics({
          executionPhase:await driver?.readOpenDetailExecutionPhase?.(),
          exceptionCategory:executionExceptionCategory(error),
        });
      }catch{}
    }
    if(error?.safeResponseEvidence){
      receiptValues.responseEvidence=safeResponseEvidence(error.safeResponseEvidence);
      receiptValues.responseEvidenceObserved=true;
    }
    if (reason!=='RATE_LIMITED'&&!BACKGROUND_GUARD_REASONS.has(reason)&&
        !['AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED','MENU_PERMISSION_DENIED','SECURITY_CHALLENGE']
      .includes(reason)) {
      const observation=await inspectFailureAuthEvidence(driver,evidenceBaseline);
      if(observation.evidence){
        receiptValues.responseEvidence=safeResponseEvidence(observation.evidence);
        receiptValues.responseEvidenceObserved=true;
      }
      receiptValues.failureAuthEvidenceUnresolved=observation.unresolved===true;
      if (observation.reason&&!(observation.unresolved===true&&
          ['RESPONSE_EVIDENCE_INCOMPLETE','RESPONSE_ERROR_UNCLASSIFIED'].includes(reason)))
        reason=safeReason(observation.reason);
    }
    try{
      const searchEvidence=await driver?.readSearchDiagnostics?.();
      if(searchEvidence){
        receiptValues.searchDiagnostics=safeSearchDiagnostics(searchEvidence);
        receiptValues.searchDiagnosticsObserved=true;
        const safeSearch=receiptValues.searchDiagnostics;
        if(safeSearch.submittedAfterActivation&&safeSearch.matchedRequestCount===1&&
            safeSearch.matchedResponseCount===1&&safeSearch.httpStatusCategory==='2xx'&&
            safeSearch.businessCodeCategory==='zero'&&safeSearch.exactIdMatchCount===1&&
            safeSearch.uidPresent&&safeSearch.visibleStableIdentityMatchCount===1&&
            ['UID','AWEME_ID','BOTH'].includes(safeSearch.matchedIdentityKeyKind)){
          receiptValues.formalIdMatch=true;
          receiptValues.identityProof='API_FEED_ID_MATCH';
        }
      }
    }catch{}
    if(error?.safeGuardDiagnostics){
      receiptValues.guardDiagnostics=safeGuardDiagnostics(error.safeGuardDiagnostics);
      receiptValues.guardDiagnosticsObserved=true;
    }
    if(error?.safeRevealDiagnostics){
      receiptValues.revealDiagnostics=safeRevealDiagnostics(error.safeRevealDiagnostics);
      receiptValues.revealDiagnosticsObserved=true;
    }
    if(reason==='CONTACT_CATEGORY_RESTRICTED'&&
        !revealCategoryRestrictionEvidence(receiptValues.revealDiagnostics))reason='REVEAL_UNCONFIRMED';
    if(error?.safeChannelDiagnostics)receiptValues.channelDiagnostics=safeChannelDiagnostics(error.safeChannelDiagnostics);
    const proofSearch=receiptValues.searchDiagnostics??safeSearchDiagnostics();
    const responseEvidence=receiptValues.responseEvidence??safeResponseEvidence();
    const authEvidenceAbsent=receiptValues.authFailureSeen===false&&receiptValues.failureAuthEvidenceUnresolved!==true&&
      responseEvidence.authPromptLatched!==true&&responseEvidence.explicitAuthResponseCount===0;
    const noMatchQuery=reason==='TARGET_NOT_FOUND'&&proofSearch.queryType==='ID'&&
      proofSearch.failureBranch==='exact_id_match_zero'&&proofSearch.exactIdMatchCount===0&&
      proofSearch.creatorIdQueryMatchesTarget===true;
    const exactResultQuery=reason==='CONTACT_LABEL_NOT_PRESENT'&&proofSearch.exactIdMatchCount===1&&
      proofSearch.awemeIdMatchesTarget===true&&proofSearch.uidFromExactResult===true;
    const channel=receiptValues.channelDiagnostics;
    const verifiedPhoneOnlyChannel=reason==='WECHAT_NOT_PROVIDED'&&
      channel?.observedReady===true&&channel.profileUidConfirmed===true&&channel.contextStable===true&&
      channel.targetHidden===true&&channel.authHealthy===true&&channel.contactItemCount>0&&
      channel.contactItemCount===channel.visibleContactItemCount&&
      channel.contactItemCount===channel.phoneLocatorCount&&
      channel.contactItemCount===channel.visiblePhoneLocatorCount&&
      channel.wechatLocatorCount===0&&channel.visibleWechatLocatorCount===0&&
      channel.unclassifiedRowCount===0&&channel.stableSamples>=3;
    const queryTargetBound=proofSearch.queryType==='ID'
      ?proofSearch.creatorIdQueryMatchesTarget===true
      :proofSearch.queryType==='NICKNAME';
    const verifiedPhoneOnlyIdentity=receiptValues.profileOpened===true&&
      profileRouteUidMatchesExactResultUid===true&&receiptValues.formalIdMatch===true&&
      receiptValues.identityProof==='API_FEED_ID_MATCH'&&queryTargetBound&&
      proofSearch.submittedAfterActivation===true&&
      proofSearch.matchedRequestCount===1&&proofSearch.matchedResponseCount===1&&
      proofSearch.httpStatusCategory==='2xx'&&proofSearch.businessCodeCategory==='zero'&&
      proofSearch.exactIdMatchCount===1&&proofSearch.awemeIdMatchesTarget===true&&
      proofSearch.uidFromExactResult===true&&proofSearch.contactMarkerState==='present'&&
      proofSearch.failureBranch==='passed'&&matchedIdentityProof?.awemeId===targetId&&
      matchedIdentityProof?.uidFromExactResult===true&&matchedIdentityProof?.responseBoundToRequest===true;
    const verifiedCategoryRestriction=revealCategoryRestrictionEvidence(receiptValues.revealDiagnostics)&&
      receiptValues.profileOpened===true&&profileRouteUidMatchesExactResultUid===true&&
      receiptValues.formalIdMatch===true&&receiptValues.identityProof==='API_FEED_ID_MATCH'&&queryTargetBound&&
      proofSearch.submittedAfterActivation===true&&proofSearch.matchedRequestCount===1&&
      proofSearch.matchedResponseCount===1&&proofSearch.httpStatusCategory==='2xx'&&
      proofSearch.businessCodeCategory==='zero'&&proofSearch.exactIdMatchCount===1&&
      proofSearch.awemeIdMatchesTarget===true&&proofSearch.uidFromExactResult===true&&
      proofSearch.contactMarkerState==='present'&&proofSearch.failureBranch==='passed'&&
      matchedIdentityProof?.awemeId===targetId&&matchedIdentityProof?.uidFromExactResult===true&&
      matchedIdentityProof?.responseBoundToRequest===true;
    if(authEvidenceAbsent&&(noMatchQuery||exactResultQuery)){
      receiptValues.workerIdentityProof=buildWorkerIdentityProof({type:'API_FEED_QUERY_VERIFIED',targetId,
        identityProof:matchedIdentityProof,search:proofSearch,authEvidenceAbsent});
    }else if(authEvidenceAbsent&&verifiedPhoneOnlyChannel&&verifiedPhoneOnlyIdentity){
      receiptValues.workerIdentityProof=buildWorkerIdentityProof({type:'API_FEED_ID_MATCH',targetId,
        identityProof:matchedIdentityProof,search:proofSearch,
        profileRouteUidMatchesExactResultUid,authEvidenceAbsent});
    }else if(authEvidenceAbsent&&reason==='CONTACT_CATEGORY_RESTRICTED'&&verifiedCategoryRestriction){
      receiptValues.workerIdentityProof=buildWorkerIdentityProof({type:'API_FEED_ID_MATCH',targetId,
        identityProof:matchedIdentityProof,search:proofSearch,
        profileRouteUidMatchesExactResultUid,authEvidenceAbsent});
    }
    if(reason==='BROWSER_ERROR')receiptValues.runtimeErrorType=safeRuntimeErrorType(error);
    for(const key of ['contactItemCount','visibleContactItemCount','wechatLocatorCount',
      'visibleWechatLocatorCount','eyeControlCount']){
      const count=error?.safeEvidence?.[key];
      if(Number.isInteger(count)&&count>=0&&count<=100)receiptValues[key]=count;
    }
    if (['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED'].includes(reason)){
      receiptValues.authFailureSeen = true;
    }
    result = stopped(stage, reason, now, receiptValues);
  }

  try { await driver?.close?.(); }
  catch {
    result = stopped(stage, 'BROWSER_CLOSE_FAILED', now, {...receiptValues,sameContext:false,samePage:false});
  }
  return result;
}

// The official Playwright CLI evaluates one self-contained function in its own
// runtime. This source bundle keeps the public flow as the same implementation
// in both local tests and the injected-page runner.
export function sameContextBuyinContactRuntimeSource() {
  const maskSource = isMaskedContactValue.toString()
    .replaceAll('CONTACT_MASK_REGEX_SOURCE', JSON.stringify(CONTACT_MASK_REGEX_SOURCE));
  const functions = [reasonFromAuthState, reasonFromAuthEvidence, reasonFromNewAuthEvidence, safeResponseEvidence,
    safeSearchDiagnostics,safeOpenDetailDiagnostics,executionExceptionCategory,safeWorkerIdentityProof,buildWorkerIdentityProof,
    safeRevealDiagnostics,revealCategoryRestrictionEvidence,safeChannelDiagnostics,safeGuardDiagnostics,
    contactStatusFor, safeReason, safeRuntimeErrorType, isValidProfileHref, hasVerifiedApiFeedIdentity,
    requireVerifiedContactMarker, emptyReceipt,
    stopped, assertSameTargets, verifyNoAuthEvidence, inspectFailureAuthEvidence,
    runSameContextBuyinContact];
  const constants = [
    `const FORMAL_RESULT_STRUCTURES=new Set(${JSON.stringify([...FORMAL_RESULT_STRUCTURES])});`,
    `const SEARCH_FAILURE_BRANCH_SET=new Set(${JSON.stringify([...SEARCH_FAILURE_BRANCH_SET])});`,
    `const OPEN_DETAIL_EXECUTION_PHASES=new Set(${JSON.stringify([...OPEN_DETAIL_EXECUTION_PHASES])});`,
    `const OPEN_DETAIL_EXCEPTION_CATEGORIES=new Set(${JSON.stringify([...OPEN_DETAIL_EXCEPTION_CATEGORIES])});`,
    `const AUTH_COUNTER_KEYS=Object.freeze(${JSON.stringify(AUTH_COUNTER_KEYS)});`,
    `const SAFE_REASONS=new Set(${JSON.stringify([...SAFE_REASONS])});`,
    `const BACKGROUND_GUARD_REASONS=new Set(${JSON.stringify([...BACKGROUND_GUARD_REASONS])});`,
    `const SAFE_RUNTIME_ERROR_TYPES=new Set(${JSON.stringify([...SAFE_RUNTIME_ERROR_TYPES])});`,
    `const isMaskedContactValue=${maskSource};`,
  ];
  return `(function(){${constants.join('\n')}\n${functions.map(fn => `${fn.toString()};`).join('\n')}\nreturn runSameContextBuyinContact;})()`;
}
