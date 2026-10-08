import {BUYIN_ACCOUNT_MARKER} from '../shared/config.mjs';
import {backgroundStateRuntimeSource,readBackgroundState} from './native-background-state.mjs';
import {
  bindWorkerPages, capturePageSetSnapshot, createPageScopedProxy, verifyPageWaveSnapshot,
} from './parallel-page-binding.mjs';
import {
  buildOriginalBackgroundCode, ORIGINAL_BACKGROUND_SESSION,
} from './buyin-original-background-driver.mjs';
import {ORIGINAL_BATCH_ID} from './canary-batch.mjs';

const WORKER_ID = /^[A-Za-z0-9_-]{1,80}$/u;
const RECORD_ID = /^[A-Za-z0-9_-]{1,160}$/u;
const ATTEMPT_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const CREATOR_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const SAFE_REASONS = new Set([
  'RATE_LIMITED',
  'CONTACT_VALUE_VERIFIED','AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED','RESPONSE_EVIDENCE_INCOMPLETE','RESPONSE_ERROR_UNCLASSIFIED',
  'MENU_PERMISSION_DENIED','SECURITY_CHALLENGE','ROLE_SELECTION_REQUIRED','BUSINESS_ROUTE_UNEXPECTED',
  'PAGE_NOT_READY','SEARCH_CONTROL_NOT_UNIQUE','SEARCH_QUERY_MISMATCH','SEARCH_BUTTON_NOT_UNIQUE',
  'SEARCH_BUTTON_NOT_ACTIONABLE','TARGET_SEARCH_UNVERIFIED','TARGET_SEARCH_AMBIGUOUS','TARGET_NOT_FOUND',
  'CONTACT_LABEL_NOT_PRESENT','CONTACT_MARKER_UNRESOLVED','DETAIL_LINK_NOT_VERIFIED','DETAIL_NOT_OPENED',
  'CONTACT_CATEGORY_RESTRICTED',
  'UNRECOGNIZED_TRANSIENT_NOTICE',
  'TARGET_PAGE_AMBIGUOUS','WECHAT_ROW_NOT_UNIQUE','WECHAT_ROW_NOT_READY','WECHAT_NOT_PROVIDED',
  'REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE','REVEAL_UNCONFIRMED',
  'REVEAL_RECOVERY_REFRESH_UNAVAILABLE','REVEAL_LISTENER_INSTALL_FAILED','REVEAL_LISTENER_CLEANUP_FAILED',
  'BACKGROUND_GUARD_FAILED','EXECUTION_CONTEXT_CHANGED','TARGET_PAGE_CLOSED','BACKGROUND_TARGET_CONTEXT_MISMATCH',
  'BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED','BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED',
  'BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED','BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED',
  'BACKGROUND_TARGET_CLOSED','BROWSER_ERROR','BROWSER_CLOSE_FAILED',
]);
const AUTH_REASONS = new Set(['AUTH_REQUIRED','AUTH_EXPIRED']);
const IDENTITY_TYPES = new Set(['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED']);
const HTTP_CATEGORIES = new Set(['2xx','4xx','5xx','other']);
const BUSINESS_CODE_CATEGORIES = new Set(['zero','nonzero','missing']);
const CAPTURE_STAGES = new Set(['auth-check','id-search','open-detail','reveal','final-guard','complete',
  'driver-init','flow','wave-guard','wave-worker']);
const RUNTIME_ERROR_TYPES=new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']);
const SEARCH_EXECUTION_PHASES=new Set(['argument_validation','page_guard','control_lookup','input_fill','button_readiness',
  'activation_guard','click_dispatch','response_wait','response_validation','visible_result','detail_link']);
const SEARCH_EXCEPTION_CATEGORIES=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
const OPEN_DETAIL_EXECUTION_PHASES=new Set(['pre_guard','expected_uid','navigate','profile_poll','profile_wait',
  'actual_uid','profile_guard','profile_uid','post_guard','post_auth','post_result']);
const OPEN_DETAIL_EXCEPTION_CATEGORIES=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);

function fail(code) { throw new Error(`PARALLEL_${code}`); }

function validateWorkers(workers,policy={laneLimit:5,sourceBatchIds:[ORIGINAL_BATCH_ID]}) {
  if(![5,10].includes(policy?.laneLimit)||!Array.isArray(policy.sourceBatchIds)||!policy.sourceBatchIds.length||policy.sourceBatchIds.some(id=>!/^\d{8}T\d{6}Z$/.test(id)))fail('WAVE_POLICY_INVALID');
  if (!Array.isArray(workers) || workers.length < 1 || workers.length > policy.laneLimit) fail('WORKERS_REQUIRED');
  const ids=new Set(),lanes=new Set(),pages=new Set(),attempts=new Set();
  return workers.map(worker=>{
    if (!worker || typeof worker!=='object' || Array.isArray(worker) ||
        !WORKER_ID.test(worker.workerId||'') || !Number.isInteger(worker.laneIndex) ||
        worker.laneIndex<0 || worker.laneIndex>=policy.laneLimit || !Number.isInteger(worker.pageIndex) || worker.pageIndex<0 ||
        !CREATOR_ID.test(String(worker.creatorId||'')) || !RECORD_ID.test(String(worker.recordId||'')) ||
        !policy.sourceBatchIds.includes(worker.sourceBatchId) || !Number.isInteger(worker.sourceRank) ||
        worker.sourceRank<1 || !Number.isSafeInteger(worker.sourceRank) || !ATTEMPT_ID.test(worker.attemptId||'') ||
        typeof worker.creatorName!=='string' || worker.creatorName.length>100 ||
        /[\u0000-\u001f\u007f]/u.test(worker.creatorName) || ids.has(worker.workerId) ||
        lanes.has(worker.laneIndex) || pages.has(worker.pageIndex) || attempts.has(worker.attemptId)) {
      fail('WORKER_BINDING_DUPLICATE_OR_INVALID');
    }
    ids.add(worker.workerId); lanes.add(worker.laneIndex); pages.add(worker.pageIndex); attempts.add(worker.attemptId);
    return {workerId:worker.workerId,laneIndex:worker.laneIndex,pageIndex:worker.pageIndex,
      creatorId:String(worker.creatorId),creatorName:worker.creatorName,recordId:String(worker.recordId),
      sourceBatchId:worker.sourceBatchId,sourceRank:worker.sourceRank,attemptId:worker.attemptId};
  });
}

function validateBuilderInput({workers,detailTemplate,accountMarker,policy}={}) {
  if (typeof detailTemplate!=='string' || !detailTemplate || typeof accountMarker!=='string' || !accountMarker) {
    fail('WAVE_CONFIG_INVALID');
  }
  const targets=validateWorkers(workers,policy);
  const runnerCodes=targets.map(worker=>buildOriginalBackgroundCode({
    session:ORIGINAL_BACKGROUND_SESSION,creatorId:worker.creatorId,creatorName:worker.creatorName,
    detailTemplate,accountMarker,
  }));
  return {targets,runnerCodes};
}

function safeCode(value,fallback='BROWSER_ERROR') {
  return typeof value==='string' && SAFE_REASONS.has(value) ? value : fallback;
}

function safeCount(value,fallback=-1) {
  return Number.isInteger(value) && value>=0 && value<=100000 ? value : fallback;
}

function projectIdentityProof(value) {
  const proof=value && typeof value==='object' && !Array.isArray(value) ? value : {};
  const type=IDENTITY_TYPES.has(proof.type) ? proof.type : '';
  return {
    type,
    creatorIdMatchesTarget:typeof proof.creatorIdMatchesTarget==='boolean'?proof.creatorIdMatchesTarget:null,
    awemeIdMatchesTarget:typeof proof.awemeIdMatchesTarget==='boolean'?proof.awemeIdMatchesTarget:null,
    exactIdMatchCount:safeCount(proof.exactIdMatchCount),
    uidFromExactResult:typeof proof.uidFromExactResult==='boolean'?proof.uidFromExactResult:null,
    profileRouteUidMatchesExactResultUid:typeof proof.profileRouteUidMatchesExactResultUid==='boolean'
      ?proof.profileRouteUidMatchesExactResultUid:null,
    querySubmittedAfterActivation:typeof proof.querySubmittedAfterActivation==='boolean'
      ?proof.querySubmittedAfterActivation:null,
    requestResponseBound:typeof proof.requestResponseBound==='boolean'?proof.requestResponseBound:null,
    httpStatusCategory:HTTP_CATEGORIES.has(proof.httpStatusCategory)?proof.httpStatusCategory:'other',
    businessCodeCategory:BUSINESS_CODE_CATEGORIES.has(proof.businessCodeCategory)?proof.businessCodeCategory:'missing',
    authEvidenceAbsent:typeof proof.authEvidenceAbsent==='boolean'?proof.authEvidenceAbsent:null,
  };
}

function queryProofMatches(proof,count) {
  return proof.type==='API_FEED_QUERY_VERIFIED' && proof.creatorIdMatchesTarget===true &&
    proof.exactIdMatchCount===count && proof.querySubmittedAfterActivation===true &&
    proof.requestResponseBound===true && proof.httpStatusCategory==='2xx' &&
    proof.businessCodeCategory==='zero' && proof.authEvidenceAbsent===true &&
    (count===0 ? proof.uidFromExactResult===false && proof.awemeIdMatchesTarget===false :
      proof.uidFromExactResult===true && proof.awemeIdMatchesTarget===true);
}

function projectChannelDiagnostics(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.observedReady!==true||
      ['profileUidConfirmed','contextStable','targetHidden','authHealthy'].some(key=>value[key]!==true)) return null;
  const keys=['contactItemCount','visibleContactItemCount','wechatLocatorCount','visibleWechatLocatorCount',
    'phoneLocatorCount','visiblePhoneLocatorCount','stableSamples'];
  const counters={};
  for(const key of keys){
    const count=value[key];
    if(!Number.isInteger(count)||count<0||count>10000)return null;
    counters[key]=count;
  }
  return {observedReady:true,profileUidConfirmed:true,contextStable:true,targetHidden:true,authHealthy:true,...counters};
}

function projectRevealDiagnostics(value) {
  const eventCategories=new Set(['contact_category_restricted','auth_notice','risk_notice','unrecognized_notice']);
  const surfaces=new Set(['aria-live','role-alert','role-status','visible-leaf']);
  const attempts=Array.isArray(value?.attemptSignals)?value.attemptSignals.slice(0,5).map(signal=>({
    clickEventObserved:signal?.clickEventObserved===true,
    domState:['masked','nonmasked','unresolved'].includes(signal?.domState)?signal.domState:'unresolved',
    transientFeedbackEvents:Array.isArray(signal?.transientFeedbackEvents)
      ?signal.transientFeedbackEvents.slice(0,20).filter(event=>eventCategories.has(event?.category)).map(event=>({
        category:event.category,
        elapsedMs:Number.isInteger(event.elapsedMs)&&event.elapsedMs>=0&&event.elapsedMs<=30000?event.elapsedMs:null,
        afterAction:event.afterAction===true,targetBound:event.targetBound===true,
        surface:surfaces.has(event.surface)?event.surface:'visible-leaf',
      })):[],
  })):[];
  return {labelMatched:typeof value?.labelMatched==='boolean'?value.labelMatched:null,
    failureBranch:['contact_category_restricted','auth_interruption','risk_interruption',
    'identity_or_guard_interruption','listener_setup_failed','listener_cleanup_failed'].includes(value?.failureBranch)
      ?value.failureBranch:'',
    finalState:['masked','nonmasked','unresolved'].includes(value?.finalState)?value.finalState:'unresolved',
    attemptSignals:attempts};
}

function stableSearchDiagnostics(search) {
  return search?.exactIdMatchCount===1&&search?.uidPresent===true&&
    ['UID','AWEME_ID','BOTH'].includes(search?.matchedIdentityKeyKind);
}

function verifiedCategoryRestriction(receipt,search,proof,verifiedPositiveQuery,reveal,attempt) {
  const response=receipt?.responseEvidence||{};
  const targetBoundToast=reveal.attemptSignals.some(signal=>signal.clickEventObserved&&signal.domState==='masked'&&
    signal.transientFeedbackEvents.some(event=>event.category==='contact_category_restricted'&&
      event.afterAction&&event.targetBound&&Number.isInteger(event.elapsedMs)));
  return receipt?.status==='stopped'&&receipt?.reason==='CONTACT_CATEGORY_RESTRICTED'&&
    ['error','forbidden_by_platform'].includes(attempt?.contactStatus)&&attempt?.errorReason==='CONTACT_CATEGORY_RESTRICTED'&&
    !attempt?.contactValue&&!attempt?.contactSourceUrl&&
    receipt?.identityProof==='API_FEED_ID_MATCH'&&receipt?.sameContext===true&&receipt?.samePage===true&&
    receipt?.authFailureSeen===false&&response.authPromptLatched===false&&response.explicitAuthResponseCount===0&&
    receipt?.formalIdMatch===true&&receipt?.profileOpened===true&&verifiedPositiveQuery&&
    proof?.type==='API_FEED_ID_MATCH'&&stableSearchDiagnostics(search)&&
    ['ID','NICKNAME'].includes(search?.queryType)&&search?.contactMarkerState==='present'&&
    search?.failureBranch==='passed'&&reveal.failureBranch==='contact_category_restricted'&&
    reveal.finalState==='masked'&&targetBoundToast;
}

function classifyRawResult(raw,worker) {
  const receipt=raw?.receipt && typeof raw.receipt==='object' && !Array.isArray(raw.receipt) ? raw.receipt : {};
  const reason=safeCode(receipt.reason);
  const proof=projectIdentityProof(receipt.workerIdentityProof);
  const rawAttempt=raw?.attempt && typeof raw.attempt==='object' && !Array.isArray(raw.attempt) ? raw.attempt : {};
  const search=receipt.searchDiagnostics||{};
  const channelDiagnostics=projectChannelDiagnostics(receipt.channelDiagnostics);
  const revealDiagnostics=projectRevealDiagnostics(receipt.revealDiagnostics);
  const proofTypeMatchesQuery=search.queryType==='NICKNAME'?proof.type==='API_FEED_ID_MATCH':
    search.queryType==='ID'&&['API_FEED_ID_MATCH','API_FEED_QUERY_VERIFIED'].includes(proof.type);
  const verifiedPositiveQuery=proofTypeMatchesQuery&&proof.creatorIdMatchesTarget===true&&
    proof.awemeIdMatchesTarget===true&&proof.exactIdMatchCount===1&&proof.uidFromExactResult&&
    proof.profileRouteUidMatchesExactResultUid&&proof.querySubmittedAfterActivation&&proof.requestResponseBound&&
    proof.httpStatusCategory==='2xx'&&proof.businessCodeCategory==='zero'&&proof.authEvidenceAbsent;
  const successfulReceipt=receipt.status==='completed' && reason==='CONTACT_VALUE_VERIFIED' &&
    receipt.identityProof==='API_FEED_ID_MATCH' && receipt.sameContext===true && receipt.samePage===true &&
    receipt.authFailureSeen===false && receipt.formalIdMatch===true && receipt.profileOpened===true &&
    receipt.wechatRowUnique===true && receipt.revealed===true && receipt.labelMatched===true &&
    receipt.nonMaskedValue===true && receipt.finalBackgroundGuard===true && receipt.errorFree===true &&
    receipt.guardDiagnostics?.targetClosed===false && receipt.guardDiagnostics?.targetContextMatches===true &&
    receipt.guardDiagnostics?.targetHidden===true && receipt.guardDiagnostics?.pageSetStable===true &&
    receipt.guardDiagnostics?.profileUidConfirmed===true && receipt.guardDiagnostics?.authHealthy===true &&
    receipt.guardDiagnostics?.errorFree===true && receipt.guardDiagnostics?.reason==='' &&
    verifiedPositiveQuery &&
    rawAttempt.contactStatus==='found' && typeof rawAttempt.contactValue==='string' && rawAttempt.contactValue.length>0 &&
    typeof rawAttempt.contactSourceUrl==='string' && rawAttempt.contactSourceUrl.length>0;
  let outcome='error';
  if (successfulReceipt) outcome='success';
  else if (AUTH_REASONS.has(reason)) outcome='auth_blocked';
  else if (reason==='SECURITY_CHALLENGE') outcome='risk_blocked';
  else if (reason==='TARGET_NOT_FOUND' && queryProofMatches(proof,0) &&
      search.queryType==='ID'&&search.failureBranch==='exact_id_match_zero') outcome='no_match';
  else if (reason==='CONTACT_LABEL_NOT_PRESENT' && queryProofMatches(proof,1) &&
      search.contactMarkerState==='absent'&&['passed','contact_label_not_present'].includes(search.failureBranch)) {
    outcome='not_shown';
  } else if (reason==='WECHAT_NOT_PROVIDED' && receipt.identityProof==='API_FEED_ID_MATCH'&&
      receipt.formalIdMatch===true&&receipt.profileOpened===true&&verifiedPositiveQuery&&
      ['ID','NICKNAME'].includes(search.queryType)&&stableSearchDiagnostics(search)&&search.contactMarkerState==='present'&&
      search.failureBranch==='passed'&&channelDiagnostics&&channelDiagnostics.contactItemCount>0&&
      channelDiagnostics.contactItemCount===channelDiagnostics.visibleContactItemCount&&
      channelDiagnostics.contactItemCount===channelDiagnostics.phoneLocatorCount&&
      channelDiagnostics.contactItemCount===channelDiagnostics.visiblePhoneLocatorCount&&
      channelDiagnostics.wechatLocatorCount===0&&channelDiagnostics.visibleWechatLocatorCount===0&&
      channelDiagnostics.stableSamples>=3) outcome='not_shown';
  else if (!SAFE_REASONS.has(reason)) outcome='error';
  const categoryRestrictionVerified=reason==='CONTACT_CATEGORY_RESTRICTED'&&
    verifiedCategoryRestriction(receipt,search,proof,verifiedPositiveQuery,revealDiagnostics,rawAttempt);
  if(categoryRestrictionVerified)outcome='forbidden_by_platform';
  const identityProof=['success','not_shown','no_match'].includes(outcome)||categoryRestrictionVerified
    ? proof : projectIdentityProof(null);
  const attempt={contactStatus:outcome==='success'?'found':outcome==='not_shown'?'not_shown':
      outcome==='no_match'?'not_found':outcome==='auth_blocked'?'login_required':
        outcome==='risk_blocked'?'captcha':outcome==='forbidden_by_platform'?'forbidden_by_platform':'error',
    contactValue:outcome==='success'?rawAttempt.contactValue:'',
    contactCheckedAt:typeof rawAttempt.contactCheckedAt==='string'?rawAttempt.contactCheckedAt:'',
    contactSourceUrl:outcome==='success'?rawAttempt.contactSourceUrl:'',
    errorReason:outcome==='success'?'':reason};
  const response=receipt.responseEvidence||{};
  const guard=receipt.guardDiagnostics||{};
  const allowedBooleans=['sameContext','samePage','authFailureSeen','formalIdMatch','profileOpened',
    'wechatRowUnique','revealed','labelMatched','nonMaskedValue','finalBackgroundGuard','errorFree'];
  const safeReceipt={mode:'parallel_worker_capture',status:receipt.status==='completed'?'completed':'stopped',
    stage:CAPTURE_STAGES.has(receipt.stage)?receipt.stage:'unknown',reason,
    runtimeErrorType:RUNTIME_ERROR_TYPES.has(receipt.runtimeErrorType)?receipt.runtimeErrorType:'',
    identityProof:receipt.identityProof==='API_FEED_ID_MATCH'?'API_FEED_ID_MATCH':'',
    ...(['recovery_readiness','navigate_list','wait_business_ready'].includes(receipt.initDiagnostics?.executionPhase)?{initDiagnostics:{executionPhase:receipt.initDiagnostics.executionPhase,navigationTimedOut:receipt.initDiagnostics.navigationTimedOut===true,listRouteAfterTimeout:receipt.initDiagnostics.listRouteAfterTimeout===true}}:{}),
    ...(OPEN_DETAIL_EXECUTION_PHASES.has(receipt.openDetailDiagnostics?.executionPhase)&&
      OPEN_DETAIL_EXCEPTION_CATEGORIES.has(receipt.openDetailDiagnostics?.exceptionCategory)
      ?{openDetailDiagnostics:{executionPhase:receipt.openDetailDiagnostics.executionPhase,
        exceptionCategory:receipt.openDetailDiagnostics.exceptionCategory}}:{}),
    workerIdentityProof:identityProof,
    searchDiagnostics:{submittedAfterActivation:search.submittedAfterActivation===true,
      queryType:['ID','NICKNAME'].includes(search.queryType)?search.queryType:'ID',
      attemptCount:safeCount(search.attemptCount,0),
      fallbackReason:['','nickname_no_exact_stable_id','nickname_query_unverified'].includes(search.fallbackReason)
        ?search.fallbackReason:'',
      matchedRequestCount:safeCount(search.matchedRequestCount),matchedResponseCount:safeCount(search.matchedResponseCount),
      visibleStableIdentityMatchCount:safeCount(search.visibleStableIdentityMatchCount),
      httpStatusCategory:HTTP_CATEGORIES.has(search.httpStatusCategory)?search.httpStatusCategory:'missing',
      businessCodeCategory:BUSINESS_CODE_CATEGORIES.has(search.businessCodeCategory)?search.businessCodeCategory:'missing',
      exactIdMatchCount:safeCount(search.exactIdMatchCount,0),uidPresent:search.uidPresent===true,
      feedResultIdMatchesTarget:search.feedResultIdMatchesTarget===true,
      selectedExactResultPresent:search.selectedExactResultPresent===true,
      matchedIdentityKeyKind:['UID','AWEME_ID','BOTH','NONE','MISSING'].includes(search.matchedIdentityKeyKind)
        ?search.matchedIdentityKeyKind:'MISSING',
      contactMarkerState:['present','absent','unresolved','missing'].includes(search.contactMarkerState)
        ?search.contactMarkerState:'missing',failureBranch:/^[a-z_]{1,48}$/u.test(search.failureBranch||'')
          ?search.failureBranch:'unknown',
      ...(SEARCH_EXECUTION_PHASES.has(search.executionPhase)&&SEARCH_EXCEPTION_CATEGORIES.has(search.exceptionCategory)
        ?{executionPhase:search.executionPhase,exceptionCategory:search.exceptionCategory}:{})},
    responseEvidence:{authPromptLatched:response.authPromptLatched===true,
      explicitAuthResponseCount:safeCount(response.explicitAuthResponseCount,0)},
    revealDiagnostics,
    channelDiagnostics,
    guardDiagnostics:{targetClosed:guard.targetClosed===true,targetContextMatches:guard.targetContextMatches===true,
      targetHidden:guard.targetHidden===true,pageSetStable:guard.pageSetStable===true,
      otherPagesStable:guard.otherPagesStable===true,
      otherPageNavigationChanged:typeof guard.otherPageNavigationChanged==='boolean'?guard.otherPageNavigationChanged:null,
      otherPageVisibilityChanged:typeof guard.otherPageVisibilityChanged==='boolean'?guard.otherPageVisibilityChanged:null,
      otherPageDocumentChanged:typeof guard.otherPageDocumentChanged==='boolean'?guard.otherPageDocumentChanged:null,
      profileUidConfirmed:guard.profileUidConfirmed===true,
      authHealthy:guard.authHealthy===true,errorFree:guard.errorFree===true,
      reason:safeCode(guard.reason,'')},
  };
  for (const key of allowedBooleans) safeReceipt[key]=receipt[key]===true;
  return {outcome,reason,receipt:safeReceipt,attempt,identityProof};
}

function clearSensitiveAttempt(attempt) {
  if (!attempt || typeof attempt!=='object') return;
  attempt.contactValue='';
  attempt.contactSourceUrl='';
}

function outputFailure(worker,reason,waveId,startedAtMs,finishedAtMs,workerCount=0,pageCount=0) {
  const identityProof=projectIdentityProof(null);
  return {workerId:worker.workerId,laneIndex:worker.laneIndex,pageIndex:worker.pageIndex,
    creatorId:worker.creatorId,recordId:worker.recordId,sourceBatchId:worker.sourceBatchId,
    sourceRank:worker.sourceRank,attemptId:worker.attemptId,outcome:'error',reason:'BROWSER_ERROR',
    receipt:{mode:'parallel_worker_capture',status:'stopped',stage:'wave-guard',reason:'BROWSER_ERROR',
      workerIdentityProof:identityProof},
    attempt:{contactStatus:'error',contactValue:'',contactCheckedAt:'',contactSourceUrl:'',errorReason:'BROWSER_ERROR'},
    identityProof,
    pageGuard:{passed:false,reason,workerCount,pageCount},timing:{waveId,startedAtMs,finishedAtMs}};
}

/**
 * Execute one worker per explicitly owned hidden Page. The worker flows may
 * overlap across pages; each flow retains its own sequential browser actions.
 * A single wave-level before/after guard protects unowned pages and converts
 * any global guard failure into a no-write result for every worker.
 */
export async function runOriginalBackgroundWave({page,workers,workerRunners,helpers,
  policy,inspectPage:inspectPageOverride,now=()=>Date.now(),waveId:waveIdOverride}={}) {
  const targets=validateWorkers(workers,policy);
  const bindingHelpers=helpers||{bindWorkerPages,capturePageSetSnapshot,createPageScopedProxy,verifyPageWaveSnapshot};
  const startedAtMs=now();
  const waveId=typeof waveIdOverride==='string'&&/^[A-Za-z0-9_-]{1,80}$/u.test(waveIdOverride)
    ?waveIdOverride:`wave-${startedAtMs}-${Math.random().toString(36).slice(2,8)}`;
  let context=null,pages=[],before=null,bindings=[],inspectPage=null;
  const descriptorFailure=(reason)=>targets.map(worker=>outputFailure(worker,reason,waveId,startedAtMs,now(),0,pages.length));
  try {
    if (!page || typeof page.context!=='function' || !Array.isArray(workerRunners) ||
        workerRunners.length!==targets.length || workerRunners.some(runner=>typeof runner!=='function')) {
      fail('WAVE_RUNTIME_ARGUMENTS_INVALID');
    }
    context=page.context();
    if (!context || typeof context.pages!=='function') fail('PAGE_CONTEXT_UNAVAILABLE');
    pages=context.pages();
    if (!Array.isArray(pages)) fail('PAGE_SET_UNAVAILABLE');
    if (targets.some(worker=>worker.pageIndex>=pages.length)) fail('PAGE_BINDING_DUPLICATE_OR_INVALID');
    inspectPage=inspectPageOverride||createPageInspector(context);
    before=await bindingHelpers.capturePageSetSnapshot({context,inspectPage});
    bindings=await bindingHelpers.bindWorkerPages({context,pages,lanes:targets.map(({workerId,laneIndex,pageIndex})=>
      ({workerId,laneIndex,pageIndex})),inspectPage,laneLimit:policy?.laneLimit??5});
    const initialGuard=await bindingHelpers.verifyPageWaveSnapshot({before,context,bindings,inspectPage});
    if (!initialGuard.ok) {
      const reason=`INITIAL_${initialGuard.reason||'PAGE_GUARD_FAILED'}`;
      return {workers:targets.map(worker=>outputFailure(worker,reason,waveId,startedAtMs,now(),
        initialGuard.workerCount??targets.length,initialGuard.pageCount??pages.length))};
    }
    let results=await Promise.all(targets.map(async(worker,index)=>{
      const workerStartedAt=now();
      let classified;
      try {
        const scoped=bindingHelpers.createPageScopedProxy(bindings[index].page);
        const raw=await workerRunners[index](scoped.page);
        classified=classifyRawResult(raw,worker);
      } catch {
        classified={outcome:'error',reason:'BROWSER_ERROR',receipt:{mode:'parallel_worker_capture',status:'stopped',
          stage:'wave-worker',reason:'BROWSER_ERROR',workerIdentityProof:projectIdentityProof(null)},
          attempt:{contactStatus:'error',contactValue:'',
          contactCheckedAt:'',contactSourceUrl:'',errorReason:'BROWSER_ERROR'},
          identityProof:projectIdentityProof(null)};
      }
      const finishedAtMs=now();
      return {workerId:worker.workerId,laneIndex:worker.laneIndex,pageIndex:worker.pageIndex,
        creatorId:worker.creatorId,recordId:worker.recordId,sourceBatchId:worker.sourceBatchId,
        sourceRank:worker.sourceRank,attemptId:worker.attemptId,outcome:classified.outcome,
        reason:classified.reason,receipt:classified.receipt,attempt:classified.attempt,
        identityProof:classified.identityProof,
        pageGuard:{passed:true,reason:'',workerCount:targets.length,pageCount:pages.length},
        timing:{waveId,startedAtMs:workerStartedAt,finishedAtMs}};
    }));
    const waveGuard=await bindingHelpers.verifyPageWaveSnapshot({before,context,bindings,inspectPage});
    const finishedAtMs=now();
    if (!waveGuard.ok) {
      const safeGuardReason=/^[A-Z][A-Z0-9_]{0,79}$/u.test(waveGuard.reason||'')
        ?waveGuard.reason:'PAGE_GUARD_FAILED';
      results=results.map(result=>{
        clearSensitiveAttempt(result.attempt);
        return {...result,outcome:'error',reason:'BROWSER_ERROR',
          receipt:{...result.receipt,status:'stopped',reason:'BROWSER_ERROR',
            workerIdentityProof:projectIdentityProof(null)},
          identityProof:projectIdentityProof(null),
          pageGuard:{passed:false,reason:safeGuardReason,workerCount:waveGuard.workerCount||targets.length,
            pageCount:waveGuard.pageCount||pages.length},
          timing:{...result.timing,finishedAtMs}};
      });
    } else {
      results=results.map(result=>({...result,pageGuard:{passed:true,reason:'',
        workerCount:waveGuard.workerCount,pageCount:waveGuard.pageCount},
        timing:{...result.timing,finishedAtMs}}));
    }
    return {workers:results};
  } catch(error) {
    const message=String(error?.message||'');
    const reason=/^PARALLEL_[A-Z0-9_]+$/u.test(message)?message.slice('PARALLEL_'.length):'PAGE_GUARD_FAILED';
    return {workers:descriptorFailure(reason)};
  }
}

function createPageInspector(context) {
  return async function inspectPage(page) {
    let href='';
    try {
      href=String(page.url()||'');
      const businessOrigin=href==='https://buyin.jinritemai.com'||
        href.startsWith('https://buyin.jinritemai.com/');
      const facts=await page.evaluate(({businessOrigin,listPath,profilePath,accountMarker})=>{
        const hidden=document.visibilityState==='hidden';
        const documentToken=String(Number(performance.timeOrigin)||0);
        if(!businessOrigin)return {hidden,documentToken,accountMarkerVisible:false,authSignal:false,challengeSignal:false};
        const visible=element=>!!element&&element.getClientRects().length>0&&
          getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
        let accountMarkerVisible=false,authSignal=false,challengeSignal=false;
        for(const node of document.querySelectorAll('body *')){
          if(!visible(node)||node.children.length)continue;
          const text=String(node.innerText||node.textContent||'').trim();
          if(text===accountMarker)accountMarkerVisible=true;
          if(/用户未登录|尚未登录|请先登录|当前未登录|未登录|登录(?:信息|状态)?已(?:过期|失效)|登录已过期|当前账号没有菜单权限|没有菜单权限/u.test(text))authSignal=true;
          if(/安全验证|完成验证|滑块|验证码/u.test(text))challengeSignal=true;
        }
        const route=location.pathname===listPath?'BUSINESS_LIST':
          location.pathname===profilePath||location.pathname.startsWith(`${profilePath}/`)?'PROFILE':'OTHER';
        return {route,hidden,documentToken,accountMarkerVisible,authSignal,challengeSignal};
      },{businessOrigin,listPath:'/dashboard/servicehall/daren-square',
        profilePath:'/dashboard/servicehall/daren-profile',accountMarker:BUYIN_ACCOUNT_MARKER});
      return {route:businessOrigin?facts.route:'OTHER_ORIGIN',hidden:(await readBackgroundState(page,facts.hidden?{visibility:'hidden',timeOrigin:Number(facts.documentToken)||0}:undefined)).hidden===true,
        accountMarkerVisible:facts.accountMarkerVisible===true,authSignal:facts.authSignal===true,
        challengeSignal:facts.challengeSignal===true,documentToken:facts.documentToken,navigationToken:href,
        pageContextMatches:page.context()===context};
    } catch { fail('PAGE_STATE_UNAVAILABLE'); }
  };
}

function buildBindingHelperSource() {
  const stateFields="Object.freeze(['route','hidden','accountMarkerVisible','authSignal','challengeSignal','documentToken','navigationToken','pageContextMatches'])";
  return `(()=>{const STATE_FIELDS=${stateFields};const ALLOWED_ROUTES=new Set(['BUSINESS_LIST','PROFILE']);`+
    `const fail=code=>{throw new Error('PARALLEL_'+code)};`+
    `const safePageState=value=>Object.fromEntries(STATE_FIELDS.map(key=>[key,value?.[key]??null]));`+
    `return {bindWorkerPages:${bindWorkerPages.toString()},capturePageSetSnapshot:${capturePageSetSnapshot.toString()},`+
    `createPageScopedProxy:${createPageScopedProxy.toString()},verifyPageWaveSnapshot:${verifyPageWaveSnapshot.toString()}};})()`;
}

function buildRuntimeSource() {
  const constants=`const ORIGINAL_BATCH_ID=${JSON.stringify(ORIGINAL_BATCH_ID)};`+
    `const WORKER_ID=/${WORKER_ID.source}/u;const RECORD_ID=/${RECORD_ID.source}/u;`+
    `const ATTEMPT_ID=/${ATTEMPT_ID.source}/u;const CREATOR_ID=/${CREATOR_ID.source}/u;`+
    `const SAFE_REASONS=new Set(${JSON.stringify([...SAFE_REASONS])});`+
    `const AUTH_REASONS=new Set(${JSON.stringify([...AUTH_REASONS])});`+
    `const IDENTITY_TYPES=new Set(${JSON.stringify([...IDENTITY_TYPES])});`+
    `const HTTP_CATEGORIES=new Set(${JSON.stringify([...HTTP_CATEGORIES])});`+
    `const BUSINESS_CODE_CATEGORIES=new Set(${JSON.stringify([...BUSINESS_CODE_CATEGORIES])});`+
    `const CAPTURE_STAGES=new Set(${JSON.stringify([...CAPTURE_STAGES])});`+
    `const RUNTIME_ERROR_TYPES=new Set(${JSON.stringify([...RUNTIME_ERROR_TYPES])});`+
    `const SEARCH_EXECUTION_PHASES=new Set(${JSON.stringify([...SEARCH_EXECUTION_PHASES])});`+
    `const SEARCH_EXCEPTION_CATEGORIES=new Set(${JSON.stringify([...SEARCH_EXCEPTION_CATEGORIES])});`+
    `const OPEN_DETAIL_EXECUTION_PHASES=new Set(${JSON.stringify([...OPEN_DETAIL_EXECUTION_PHASES])});`+
    `const OPEN_DETAIL_EXCEPTION_CATEGORIES=new Set(${JSON.stringify([...OPEN_DETAIL_EXCEPTION_CATEGORIES])});`;
  const functions=[fail,validateWorkers,safeCode,safeCount,projectIdentityProof,queryProofMatches,
    projectChannelDiagnostics,projectRevealDiagnostics,stableSearchDiagnostics,verifiedCategoryRestriction,
    classifyRawResult,clearSensitiveAttempt,outputFailure,createPageInspector,runOriginalBackgroundWave];
  return `const BUYIN_ACCOUNT_MARKER=${JSON.stringify(BUYIN_ACCOUNT_MARKER)};`+backgroundStateRuntimeSource()+constants+functions.map(fn=>`${fn.toString()};`).join('\n');
}

function runnerConfigFromCode(code) {
  const startMarker='const config=';
  const endMarker=';const remoteSafeReasons=';
  const start=code.indexOf(startMarker);
  const end=code.indexOf(endMarker,start+startMarker.length);
  if(start<0||end<0)fail('RUNNER_CONFIG_TEMPLATE_INVALID');
  try{return JSON.parse(code.slice(start+startMarker.length,end));}
  catch{fail('RUNNER_CONFIG_TEMPLATE_INVALID');}
}

function parameterizeRunnerCode(code,config) {
  const declaration=`const config=${JSON.stringify(config)};`;
  if(!code.startsWith('async page => {')||!code.includes(declaration))fail('RUNNER_CONFIG_TEMPLATE_INVALID');
  return code.replace(declaration,'').replace('async page => {','async (page, config) => {');
}

function compactGeneratedCode(source) {
  const chunks=[];
  const identifierStart=/[\p{ID_Start}_$]/u,identifierPart=/[\p{ID_Continue}_$]/u;
  const whitespace=/\s/u,digit=/[0-9]/u;
  const joinedPunctuators=new Set(['++','--','**','=>','==','!=','<=','>=','&&','||','??','?.',
    '+=','-=','*=','/=','%=','&=','|=','^=','<<','>>','>>>','**=','&&=','||=','??=','===','!==',
    '...','//','/*','..']);
  const regexMayStartAfter=new Set(['(','[','{',',',';',':','=','!','?','+','-','*','%','&','|','^',
    '~','<','>','=>','return','throw','case','delete','void','typeof','instanceof','in','of','yield',
    'await','else','do']);
  const lineBreakSensitive=new Set(['return','throw','break','continue','yield','async']);
  let index=0,lastToken='',lastChar='';
  const append=(value,token=value)=>{
    if(!value)return;
    chunks.push(value);
    lastToken=token;
    lastChar=value.at(-1);
  };

  while(index<source.length){
    const character=source[index];
    if(character==='\''||character==='"'){
      const start=index++,quote=character;
      while(index<source.length){
        if(source[index]==='\\'){index+=2;continue;}
        if(source[index++]===quote)break;
      }
      append(source.slice(start,index),'literal');
      continue;
    }
    if(character==='`'){
      const start=index++;
      while(index<source.length){
        if(source[index]==='\\'){index+=2;continue;}
        if(source[index++]==='`')break;
      }
      append(source.slice(start,index),'literal');
      continue;
    }
    if(character==='/'&&source[index+1]==='/'){
      chunks.push(' ');
      while(index<source.length&&source[index]!=='\n'&&source[index]!=='\r')index++;
      continue;
    }
    if(character==='/'&&source[index+1]==='*'){
      chunks.push(' ');
      index+=2;
      while(index<source.length&&!source.startsWith('*/',index))index++;
      index=Math.min(source.length,index+2);
      continue;
    }
    if(whitespace.test(character)){
      let hasLineBreak=false;
      while(index<source.length&&whitespace.test(source[index])){
        if(source[index]==='\n'||source[index]==='\r')hasLineBreak=true;
        index++;
      }
      const next=source[index]||'';
      const needsTokenSpace=(identifierPart.test(lastChar)||digit.test(lastChar))&&
        (identifierPart.test(next)||digit.test(next));
      const needsNumericSpace=digit.test(lastChar)&&next==='.'||lastChar==='.'&&digit.test(next);
      const needsPunctuationSpace=lastChar&&next&&joinedPunctuators.has(lastChar+next);
      const needsLineBreak=hasLineBreak&&(lineBreakSensitive.has(lastToken)||
        (['+','-'].includes(next)&&source[index+1]===next));
      if(needsLineBreak)append('\n',' ');
      else if(needsTokenSpace||needsNumericSpace||needsPunctuationSpace)append(' ',' ');
      continue;
    }
    if(character==='/'){
      if(!lastToken||regexMayStartAfter.has(lastToken)){
        const start=index++;
        let inCharacterClass=false;
        while(index<source.length){
          if(source[index]==='\\'){index+=2;continue;}
          if(source[index]==='[')inCharacterClass=true;
          else if(source[index]===']')inCharacterClass=false;
          else if(source[index]==='/'&&!inCharacterClass){
            index++;
            while(index<source.length&&/[A-Za-z]/u.test(source[index]))index++;
            break;
          }
          index++;
        }
        append(source.slice(start,index),'literal');
        continue;
      }
    }
    if(identifierStart.test(character)){
      const start=index++;
      while(index<source.length&&identifierPart.test(source[index]))index++;
      append(source.slice(start,index));
      continue;
    }
    if(digit.test(character)){
      const start=index++;
      while(index<source.length&&/[A-Za-z0-9_.$]/u.test(source[index]))index++;
      append(source.slice(start,index));
      continue;
    }
    index++;
    append(character,character);
  }
  return chunks.join('');
}

/** Build the one-call Playwright CLI function consumed by the batch loader. */
export function buildOriginalBackgroundWaveCode(input) {
  const {targets,runnerCodes}=validateBuilderInput(input);
  const runnerConfigs=runnerCodes.map(runnerConfigFromCode);
  const runnerTemplate=parameterizeRunnerCode(runnerCodes[0],runnerConfigs[0]);
  const code=`async page=>{${buildRuntimeSource()}const helpers=${buildBindingHelperSource()};`+
    `const workers=${JSON.stringify(targets)};const workerConfigs=${JSON.stringify(runnerConfigs)};`+
    `const workerRunner=(${runnerTemplate});`+
    `const workerRunners=workers.map((worker,index)=>workerPage=>workerRunner(workerPage,workerConfigs[index]));`+
    `return await runOriginalBackgroundWave({page,workers,workerRunners,helpers,policy:${JSON.stringify(input.policy)}});}`;
  return compactGeneratedCode(code);
}

export {projectIdentityProof};
