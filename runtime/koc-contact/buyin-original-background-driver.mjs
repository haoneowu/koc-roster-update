import {BUYIN_ACCOUNT_MARKER,PLAYWRIGHT_SESSION} from '../shared/config.mjs';
import {backgroundStateRuntimeSource} from './native-background-state.mjs';
import {spawnSync} from '../shared/child-process.mjs';
import {fileURLToPath} from 'node:url';
import {CONTACT_PATCH_TARGET_CREATOR_ID, patchCurrentContactAttempt} from './contact-patch-adapter.mjs';
import {BUYIN_SEARCH_FAILURE_BRANCHES,sameContextBuyinContactRuntimeSource, safeResponseEvidence, safeSearchDiagnostics,
  safeOpenDetailDiagnostics,safeRevealDiagnostics, safeChannelDiagnostics, safeGuardDiagnostics, safeWorkerIdentityProof}
  from './buyin-contact-flow.mjs';
import {inspectVisibleBuyinIdRows} from './buyin-id-result.mjs';
import {isMaskedContactValue} from './contact-reveal-state.mjs';
import {playwrightCliArgs,playwrightCliEnv} from './playwright-cli-contract.mjs';

export const ORIGINAL_BACKGROUND_SESSION = PLAYWRIGHT_SESSION;
export const REVEAL_RECOVERY_CREATOR_ID='LEGACY_REVEAL_DISABLED';
const ORIGIN = 'https://buyin.jinritemai.com';
const LIST_URL = `${ORIGIN}/dashboard/servicehall/daren-square`;
const LIST_PATH = '/dashboard/servicehall/daren-square';
const PROFILE_PATH = '/dashboard/servicehall/daren-profile';
export const DEFAULT_DETAIL_TEMPLATE = `${ORIGIN}${PROFILE_PATH}?uid=template`;
const FEED_PATH = '/square_pc_api/square/search_feed_author';
const SEARCH_PLACEHOLDER = '搜达人昵称、抖音号、带货品牌、主推类目';
const ACCOUNT_MARKER = BUYIN_ACCOUNT_MARKER;
const READ_ONLY_CONTACT_FIELD_NAMES=['本次联系方式状态','联系方式最近尝试','联系方式最近成功',
  '联系方式最近错误','联系方式来源','微信号'];
const SAFE_RUNTIME_ERROR_TYPES = new Set(['Error','TypeError','ReferenceError','RangeError','SyntaxError','TimeoutError','OTHER']);
const SAFE_REASONS = new Set([
  'RATE_LIMITED',
  'CONTACT_VALUE_VERIFIED',
  'CONTACT_CATEGORY_RESTRICTED',
  'UNRECOGNIZED_TRANSIENT_NOTICE',
  'AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED','RESPONSE_EVIDENCE_INCOMPLETE',
  'RESPONSE_ERROR_UNCLASSIFIED','MENU_PERMISSION_DENIED',
  'SECURITY_CHALLENGE','ROLE_SELECTION_REQUIRED','BUSINESS_ROUTE_UNEXPECTED','PAGE_NOT_READY',
  'SEARCH_CONTROL_NOT_UNIQUE','SEARCH_QUERY_MISMATCH','SEARCH_BUTTON_NOT_UNIQUE',
  'SEARCH_BUTTON_NOT_ACTIONABLE','TARGET_SEARCH_UNVERIFIED','TARGET_SEARCH_AMBIGUOUS',
  'TARGET_NOT_FOUND','CONTACT_LABEL_NOT_PRESENT','CONTACT_MARKER_UNRESOLVED',
  'DETAIL_LINK_NOT_VERIFIED','DETAIL_NOT_OPENED','TARGET_PAGE_AMBIGUOUS','WECHAT_ROW_NOT_UNIQUE','WECHAT_ROW_NOT_READY',
  'WECHAT_NOT_PROVIDED',
  'REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE','REVEAL_UNCONFIRMED',
  'REVEAL_RECOVERY_REFRESH_UNAVAILABLE','REVEAL_LISTENER_INSTALL_FAILED','REVEAL_LISTENER_CLEANUP_FAILED',
  'BACKGROUND_GUARD_FAILED','EXECUTION_CONTEXT_CHANGED','TARGET_PAGE_CLOSED',
  'BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE','BACKGROUND_PAGE_SET_CHANGED',
  'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED','BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED',
  'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED',
  'BROWSER_ERROR','BROWSER_CLOSE_FAILED','CONTACT_PATCH_FAILED','CONTACT_PATCH_READBACK_FAILED',
]);
let originalBackgroundRunActive=false;

/** Convert the existing same-Page feedback observer result into a bounded,
 * allowlisted diagnosis record. Raw notice text is never copied to a receipt. */
export function adaptBuyinToastObservation({installAttemptedAt,installedAt=null,observerInstalled=false,
  installFailureCode=null,pageBindingFailureCode=null,observerBound=false,targetIdentityPairVerified=false,
  actionAt=null,completedAt,
  windowLimitMs,events=[]}={}) {
  const parse=value=>{
    if(typeof value!=='string')return null;
    const time=new Date(value);
    return Number.isFinite(time.getTime())&&time.toISOString()===value?time:null;
  };
  const installAttempt=parse(installAttemptedAt),installed=parse(installedAt),action=parse(actionAt),completed=parse(completedAt);
  const limitValid=Number.isInteger(windowLimitMs)&&[5000,20000].includes(windowLimitMs);
  const observerReady=observerInstalled===true&&!!installAttempt&&!!installed&&installed>=installAttempt&&
    (!action||installed<=action)&&installFailureCode===null;
  const observedMs=action&&completed&&completed>=action?completed.getTime()-action.getTime():null;
  const targetBound=observerBound===true&&targetIdentityPairVerified===true;
  const observationSucceeded=observerReady&&targetBound&&!!action&&!!completed&&limitValid&&
    observedMs>=windowLimitMs&&observedMs<=windowLimitMs+1000;
  const categoryDefinitions={
    contact_category_restricted:{diagnosticCode:'CONTACT_CATEGORY_RESTRICTED',
      errorReason:'CONTACT_CATEGORY_RESTRICTED',redactedText:'[REDACTED]'},
    auth_notice:{diagnosticCode:'AUTH_REQUIRED',errorReason:'AUTH_REQUIRED',redactedText:'[REDACTED]'},
    risk_notice:{diagnosticCode:'SECURITY_CHALLENGE',errorReason:'SECURITY_CHALLENGE',redactedText:'[REDACTED]'},
    unrecognized_notice:{diagnosticCode:'UNRECOGNIZED_TRANSIENT_NOTICE',
      errorReason:'UNRECOGNIZED_TRANSIENT_NOTICE',redactedText:'[REDACTED]'},
  };
  const surfaces=new Set(['aria-live','role-alert','role-status','visible-leaf']);
  const safeEvents=observationSucceeded&&Array.isArray(events)?events.slice(0,20).flatMap(event=>{
    const definition=categoryDefinitions[event?.category];
    const observed=parse(event?.observedAt);
    if(!definition||!observed||observed<action||observed>completed||event?.afterAction!==true||
        event?.targetBound!==true)return [];
    return [{category:event.category,observedAt:event.observedAt,
      elapsedMs:observed.getTime()-action.getTime(),afterAction:true,targetBound:true,
      surface:surfaces.has(event.surface)?event.surface:'visible-leaf',originalText:null,
      redactedText:definition.redactedText,
      classification:{status:'error',diagnosticCode:definition.diagnosticCode,errorReason:definition.errorReason}}];
  }):[];
  const safeInstallFailure=observerInstalled===true?null:
    ['PAGE_OBSERVER_UNAVAILABLE','OBSERVER_INSTALL_FAILED','PAGE_CONTEXT_CHANGED'].includes(installFailureCode)
      ?installFailureCode:'OBSERVER_INSTALL_FAILED';
  const safeTimestamp=value=>parse(value)?value:null;
  const toastStatus=!observationSucceeded?'unobserved':safeEvents.length?'observed':'observed_none';
  return {
    action:'expand',
    target:{identityPairVerified:targetIdentityPairVerified===true},
    observer:{installAttemptedAt:safeTimestamp(installAttemptedAt),installed:observerInstalled===true,
      installedAt:observerInstalled===true?safeTimestamp(installedAt):null,
      installFailureCode:safeInstallFailure,
      pageBindingFailureCode:observerInstalled===true&&pageBindingFailureCode==='PAGE_CONTEXT_CHANGED'
        ?'PAGE_CONTEXT_CHANGED':null,
      boundToTargetPage:observerBound===true},
    window:{actionAt:safeTimestamp(actionAt),completedAt:safeTimestamp(completedAt),
      limitMs:limitValid?windowLimitMs:null,observedMs,observationSucceeded},
    toast:{status:toastStatus,present:toastStatus==='unobserved'?null:toastStatus==='observed',events:safeEvents},
  };
}

export async function selectOriginalBackgroundPage({current,pages,origin,listPath,profilePath,pageState,
  requireCurrentPage=false,allowCurrentNotReady=false}={}) {
  const availablePages=Array.isArray(pages)?pages:[];
  const closed=page=>typeof page?.isClosed==='function'&&page.isClosed();
  const routePath=page=>{
    const href=String(page?.url?.()||'');
    if(href===origin)return '/';
    if(!href.startsWith(`${origin}/`))return '';
    return href.slice(origin.length).split(/[?#]/u)[0].replace(/\/+$/u,'')||'/';
  };
  const validPaths=new Set([listPath,profilePath].map(value=>String(value||'').replace(/\/+$/u,'')));
  const candidates=availablePages.filter(page=>!closed(page)&&validPaths.has(routePath(page)));
  const stateFor=async page=>{
    if(typeof pageState!=='function')return {};
    try{return await pageState(page)||{};}catch{return {};}
  };
  const facts=new Map();
  for(const candidate of candidates)facts.set(candidate,await stateFor(candidate));
  if(requireCurrentPage){
    const state=facts.get(current)||{};
    const route=routePath(current)===listPath?'BUSINESS_LIST':routePath(current)===profilePath?'PROFILE':'';
    const explicitBlock=state.hasChallenge||state.menuPermissionDenied||state.authRequiredPrompt||
      state.authExpiredPrompt||state.loginEntryVisible||state.loginForm;
    const readyEnough=state.accountMarkerVisible===true||allowCurrentNotReady===true;
    if(!current||closed(current)||!availablePages.includes(current))return {page:null,reason:'TARGET_PAGE_CLOSED',
      candidateCount:candidates.length,usableHiddenCandidateCount:0,selectionMode:''};
    if(state.hidden!==true)return {page:null,reason:'BACKGROUND_TARGET_VISIBLE',
      candidateCount:candidates.length,usableHiddenCandidateCount:0,selectionMode:''};
    if(!route||state.route!==route||explicitBlock||!readyEnough){
      const reason=state.hasChallenge?'SECURITY_CHALLENGE':state.menuPermissionDenied?'MENU_PERMISSION_DENIED':
        state.authExpiredPrompt?'AUTH_EXPIRED':state.authRequiredPrompt||state.loginEntryVisible||state.loginForm
          ?'AUTH_REQUIRED':'AUTH_OR_PERMISSION_UNRESOLVED';
      return {page:null,reason,candidateCount:candidates.length,usableHiddenCandidateCount:0,selectionMode:''};
    }
    return {page:current,reason:'',candidateCount:candidates.length,usableHiddenCandidateCount:1,
      selectionMode:'current_hidden_page_recovery'};
  }
  const usableHidden=candidates.filter(candidate=>{
    const state=facts.get(candidate)||{};
    const route=routePath(candidate)===listPath?'BUSINESS_LIST':'PROFILE';
    return state.hidden===true&&state.route===route&&state.accountMarkerVisible===true&&
      !state.hasChallenge&&!state.menuPermissionDenied&&!state.authRequiredPrompt&&
      !state.authExpiredPrompt&&!state.loginEntryVisible&&!state.loginForm;
  });
  const boundHiddenPage=usableHidden.find(candidate=>routePath(candidate)===listPath)||usableHidden[0]||null;
  let page=null,reason='',selectionMode='';
  if(!current||closed(current)||!availablePages.includes(current)){
    if(boundHiddenPage){page=boundHiddenPage;selectionMode='same_run_live_page_binding_after_current_closed';}
    else reason='TARGET_PAGE_CLOSED';
  }
  else if(usableHidden.includes(current)){page=current;selectionMode='current_hidden_page';}
  else if(boundHiddenPage){
    page=boundHiddenPage;selectionMode='same_run_live_page_binding';
  }else if(candidates.length===0)reason='TARGET_PAGE_CLOSED';
  else if(candidates.some(candidate=>(facts.get(candidate)||{}).hidden===true)){
    const observed=[...facts.values()];
    if(observed.some(state=>state.hasChallenge))reason='SECURITY_CHALLENGE';
    else if(observed.some(state=>state.menuPermissionDenied))reason='MENU_PERMISSION_DENIED';
    else if(observed.some(state=>state.authExpiredPrompt))reason='AUTH_EXPIRED';
    else if(observed.some(state=>state.authRequiredPrompt||state.loginEntryVisible||state.loginForm))reason='AUTH_REQUIRED';
    else reason=observed.some(state=>state.readinessTimedOut)?'PAGE_NOT_READY':'AUTH_OR_PERMISSION_UNRESOLVED';
  }else {
    reason=candidates.length?'BACKGROUND_TARGET_VISIBLE':'TARGET_PAGE_CLOSED';
  }
  return {page,reason,candidateCount:candidates.length,usableHiddenCandidateCount:usableHidden.length,selectionMode};
}

export function classifyBackgroundGuardDiagnostics({targetClosed=false,targetContextMatches=true,targetHidden=true,
  pageSetStable=true,otherPageNavigationChanged=false,otherPageVisibilityChanged=false,
  otherPageDocumentChanged=false,profileUidConfirmed=true,authHealthy=true,errorFree=true}={}){
  const otherPagesStable=pageSetStable&&!otherPageNavigationChanged&&!otherPageVisibilityChanged&&!otherPageDocumentChanged;
  const reason=targetClosed?'BACKGROUND_TARGET_CLOSED':!targetContextMatches?'BACKGROUND_TARGET_CONTEXT_MISMATCH':
    !targetHidden?'BACKGROUND_TARGET_VISIBLE':!pageSetStable?'BACKGROUND_PAGE_SET_CHANGED':
    otherPageNavigationChanged?'BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED':
    otherPageVisibilityChanged?'BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED':
    otherPageDocumentChanged?'BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED':
    !profileUidConfirmed?'DETAIL_LINK_NOT_VERIFIED':!authHealthy?'AUTH_OR_PERMISSION_UNRESOLVED':
    !errorFree?'BROWSER_ERROR':'';
  return {targetClosed:targetClosed===true,targetContextMatches:targetContextMatches===true,
    targetHidden:targetHidden===true,pageSetStable:pageSetStable===true,otherPagesStable,
    otherPageNavigationChanged:otherPageNavigationChanged===true,
    otherPageVisibilityChanged:otherPageVisibilityChanged===true,
    otherPageDocumentChanged:otherPageDocumentChanged===true,
    profileUidConfirmed:profileUidConfirmed===true,authHealthy:authHealthy===true,errorFree:errorFree===true,reason};
}

// Parse a request body and return the single field path whose value exactly
// equals the submitted ID. Substring matches and ambiguous duplicate fields fail.
export function exactIdRequestField(postData, expectedId) {
  if (typeof postData !== 'string' || !postData || typeof expectedId !== 'string' || !expectedId) return '';
  let body;
  try { body = JSON.parse(postData); } catch { return ''; }
  const paths = [];
  let visited = 0;
  const visit = (value,path,depth) => {
    if (depth > 8 || ++visited > 500 || paths.length > 1) return;
    if (value === null || typeof value !== 'object') {
      if ((typeof value === 'string' || typeof value === 'number') && String(value) === expectedId) paths.push(path);
      return;
    }
    if (Array.isArray(value)) {
      for (let index=0; index<value.length; index++) visit(value[index],`${path}[${index}]`,depth+1);
      return;
    }
    for (const [key,child] of Object.entries(value)) visit(child,`${path}.${key}`,depth+1);
  };
  visit(body,'$',0);
  return paths.length === 1 ? paths[0] : '';
}

// This function is serialized into one official CLI run-code call. It receives
// the caller's existing Page and derives its context; it never creates or closes
// a browser, context, or page.
async function createOriginalBackgroundBuyinDriver(current, config, selectPage) {
  const ORIGIN='https://buyin.jinritemai.com';
  const LIST_URL=`${ORIGIN}/dashboard/servicehall/daren-square`;
  const LIST_PATH='/dashboard/servicehall/daren-square';
  const PROFILE_PATH='/dashboard/servicehall/daren-profile';
  const FEED_PATH='/square_pc_api/square/search_feed_author';
  const SEARCH_PLACEHOLDER='搜达人昵称、抖音号、带货品牌、主推类目';
  const MASK_SOURCE='[*＊•·●]|^[—–-]+$|^…+$|^(?:暂无|未展示|未显示|已隐藏|隐藏|保密|无|未知|无数据|N\\/A)$';
  const isMaskedValue=value=>{const text=String(value??'').trim();return !text||new RegExp(MASK_SOURCE,'i').test(text);};
  const creatorId=String(config.creatorId||'');
  const creatorName=String(config.creatorName||'');
  const revealRecoveryPhase=config.revealRecoveryPhase||'single';
  const recoveryReservation=config.revealRecoveryReservation||null;
  const recoveryOperationId=recoveryReservation?.operationId||'';
  const recoveryExecutionId=recoveryReservation?.executionId||'';
  const recoveryParentAttemptId=recoveryReservation?.parentAttemptId||'';
  const recoveryParentReceiptVerified=recoveryReservation?.priorReceiptVerified===true;
  const recoveryReservedClickCount=Number.isInteger(recoveryReservation?.clickCount)?recoveryReservation.clickCount:0;
  const recoveryReservedRefreshCount=Number.isInteger(recoveryReservation?.refreshCount)?recoveryReservation.refreshCount:0;
  const openDetailExecutionPhases=new Set(['pre_guard','expected_uid','navigate','profile_poll','profile_wait',
    'actual_uid','profile_guard','profile_uid','post_guard','post_auth','post_result']);
  let openDetailExecutionPhase='';
  const setOpenDetailExecutionPhase=phase=>{
    openDetailExecutionPhase=openDetailExecutionPhases.has(phase)?phase:'';
  };
  let recoveryRefreshCount=revealRecoveryPhase==='rebaseline'?1:0;
  let recoveryPageReloaded=revealRecoveryPhase==='rebaseline';
  let recoveryRebaselinePassed=false;
  let preflightRevealedContact=null;
  const originPath=href=>String(href||'').startsWith(`${ORIGIN}/`)
    ? String(href).slice(ORIGIN.length).split(/[?#]/u)[0] : '';
  const isVisible=element=>!!element&&element.getClientRects().length>0&&
    getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
  const context=current?.context?.();
  const pages=context?.pages?.()||[];
  if (!context||pages.length===0) throw new Error('TARGET_PAGE_CLOSED');
  const knownPages=pages.slice();
  const pendingResponses=new Set();
  const responseCounts={authRequiredResponseCount:0,authExpiredResponseCount:0,menuDeniedResponseCount:0,
    authHttp401ResponseCount:0,authEnvelope401ResponseCount:0,authMessageNotLoggedInResponseCount:0,
    authMessageExpiredResponseCount:0,menuDeniedMessageResponseCount:0,
    observedResponseCount:0,feedResponseCount:0,imResponseCount:0,otherResponseCount:0,
    http2xxResponseCount:0,http4xxResponseCount:0,http5xxResponseCount:0,
    jsonResponseCount:0,inspectedJsonResponseCount:0,uninspectedJsonResponseCount:0,
    jsonParseFailureCount:0,nonzeroCodeResponseCount:0,unknownErrorResponseCount:0,targetFeedErrorCount:0};
  let authPromptLatched=false;
  let listenersInstalled=false;
  let formalSearchSubmitted=false;
  let activationAt=0;
  let matchedRequestCount=0;
  let matchedResponseCount=0;
  let requestIdFieldPath='';
  let activeQueryValue='';
  let activeQueryKind='ID';
  let activeSearchToken=0;
  let searchAttemptCount=0;
  let activeSearchTargetErrorCount=0;
  let selectedUidFromExactResult='';
  let selectedFeedItem=null;
  let linkedProfileUid='';
  let feedResponse=null;
  let feedMonitoringActive=false;
  const searchDiagnostics={submittedAfterActivation:false,queryType:'ID',attemptCount:0,fallbackReason:'',
    executionPhase:'',exceptionCategory:'',
    creatorIdQueryMatchesTarget:false,
    feedRequestCount:0,matchedRequestCount:0,
    matchedResponseCount:0,httpStatusCategory:'missing',businessCodeCategory:'missing',listCount:null,
    exactIdMatchCount:0,awemeIdMatchesTarget:false,feedResultIdMatchesTarget:false,selectedExactResultPresent:false,
    uidFromExactResult:false,
    visibleExactIdMatchCount:null,visibleStableIdentityMatchCount:null,
    matchedIdentityKeyKind:'',matchedIdentityAttributeNames:[],matchedIdentityHrefParamNames:[],
    contactLabelPresent:false,contactMarkerState:'missing',contactMarkerAttributeNames:[],
    uidPresent:false,failureBranch:'not_started'};
  const matchedRequests=new WeakMap();

  const inspectPage=async target=>target.evaluate(({origin,accountMarker,searchPlaceholder,listPath,profilePath})=>{
    const visible=element=>!!element&&element.getClientRects().length>0&&
      getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
    const route=location.origin!==origin?'OTHER_ORIGIN':location.pathname===listPath?'BUSINESS_LIST':
      location.pathname===profilePath||location.pathname.startsWith(`${profilePath}/`)?'PROFILE':'OTHER';
    let hasChallenge=false,menuPermissionDenied=false,authRequiredPrompt=false,authExpiredPrompt=false;
    let accountMarkerVisible=false;
    for(const node of document.querySelectorAll('body *')){
      if(!visible(node)||node.children.length)continue;
      const text=String(node.innerText||node.textContent||'').trim();
      if(/安全验证|完成验证|滑块|验证码/u.test(text))hasChallenge=true;
      if(/当前账号没有菜单权限|没有菜单权限/u.test(text))menuPermissionDenied=true;
      if(/用户未登录|尚未登录|请先登录|当前未登录|未登录/u.test(text))authRequiredPrompt=true;
      if(/登录(?:信息|状态)?已(?:过期|失效)|登录已过期/u.test(text))authExpiredPrompt=true;
      if(text===accountMarker)accountMarkerVisible=true;
    }
    const searchControlVisible=[...document.querySelectorAll('input')].some(input=>visible(input)&&
      input.getAttribute('placeholder')===searchPlaceholder);
    const loginEntryVisible=[...document.querySelectorAll('button,a,[role="button"]')].some(node=>visible(node)&&
      /^(?:登录|重新登录|扫码登录|手机号登录|立即登录)$/u.test(String(node.innerText||node.getAttribute('aria-label')||'').trim()));
    const loginForm=[...document.querySelectorAll('input')].some(input=>visible(input)&&input.type==='password');
    const routeReason=route==='OTHER_ORIGIN'?'AUTH_OR_PERMISSION_UNRESOLVED':'';
    const state=hasChallenge?'SECURITY_CHALLENGE':menuPermissionDenied?'MENU_PERMISSION_DENIED':
      authExpiredPrompt?'AUTH_EXPIRED':authRequiredPrompt||loginEntryVisible||loginForm?'AUTH_REQUIRED':
      routeReason?routeReason:route==='BUSINESS_LIST'&&searchControlVisible&&accountMarkerVisible?'BUSINESS_READY':route;
    return {route,state,hasChallenge,menuPermissionDenied,authRequiredPrompt,authExpiredPrompt,
      loginEntryVisible,loginForm,searchControlVisible,accountMarkerVisible,
      businessReady:route==='BUSINESS_LIST'&&searchControlVisible&&accountMarkerVisible};
  },{origin:ORIGIN,accountMarker:config.accountMarker,searchPlaceholder:SEARCH_PLACEHOLDER,
    listPath:LIST_PATH,profilePath:PROFILE_PATH});

  // Define inspectPage before invoking the selector: the selector calls this
  // callback while enumerating live Page objects, so it must not close over a
  // still-uninitialized const binding.
  const recoveryMode=['refreshed','rebaseline'].includes(revealRecoveryPhase);
  const addRecoveryFailureDiagnostics=error=>{
    if(!recoveryMode||!error||error.safeRevealDiagnostics)return error;
    const reason=String(error.message||'');
    const failureBranch=['AUTH_REQUIRED','AUTH_EXPIRED','AUTH_OR_PERMISSION_UNRESOLVED',
      'MENU_PERMISSION_DENIED'].includes(reason)?'auth_interruption':
      reason==='SECURITY_CHALLENGE'?'risk_interruption':reason==='PAGE_NOT_READY'?'readiness_timeout':
      'identity_or_guard_interruption';
    error.safeRevealDiagnostics={failureBranch,recoveryPhase:revealRecoveryPhase,recoveryOperationId,
      recoveryExecutionId,recoveryParentAttemptId,recoveryParentReceiptVerified,
      reservedClickCount:recoveryReservedClickCount,reservedRefreshCount:recoveryReservedRefreshCount,
      refreshCount:recoveryRefreshCount,pageReloaded:recoveryPageReloaded,
      rebaselinePassed:false,clickAttemptCount:0,eyeActivationCount:0,clickIssued:false,
      clickState:'not_issued',attemptSignals:[]};
    return error;
  };
  const selected=await selectPage({current,pages,origin:ORIGIN,listPath:LIST_PATH,profilePath:PROFILE_PATH,
    requireCurrentPage:recoveryMode,allowCurrentNotReady:recoveryMode,
    pageState:async candidate=>{
      const deadline=Date.now()+20000;
      while(true){
        const facts={...await inspectPage(candidate),
          hidden:await readBackgroundState(candidate).then(facts=>facts.hidden)};
        const explicitBlock=facts.hasChallenge||facts.menuPermissionDenied||facts.authRequiredPrompt||
          facts.authExpiredPrompt||facts.loginEntryVisible||facts.loginForm;
        if(recoveryMode||explicitBlock||!facts.hidden||!['BUSINESS_LIST','PROFILE'].includes(facts.route)||
            facts.accountMarkerVisible)return facts;
        const remaining=deadline-Date.now();
        if(remaining<=0)return {...facts,readinessTimedOut:true};
        await candidate.waitForTimeout(Math.min(150,remaining));
      }
    }});
  if(!selected?.page)throw new Error(selected?.reason||'TARGET_PAGE_CLOSED');
  const page=selected.page;

  const pageSnapshot=async target=>{
    const facts=await readBackgroundState(target);
    return {href:target.url(),visibility:facts.visibility,documentTimeOrigin:facts.documentTimeOrigin};
  };
  const otherBaselines=new Map();
  for(const other of pages.filter(candidate=>candidate!==page)) otherBaselines.set(other,await pageSnapshot(other));
  const initialVisibility=await readBackgroundState(page).then(facts=>facts.visibility);
  if(initialVisibility!=='hidden')throw addRecoveryFailureDiagnostics(new Error('BACKGROUND_TARGET_VISIBLE'));
  const initialFacts=await inspectPage(page);
  const initialExplicitBlock=initialFacts.hasChallenge||initialFacts.menuPermissionDenied||
    initialFacts.authRequiredPrompt||initialFacts.authExpiredPrompt||initialFacts.loginEntryVisible||initialFacts.loginForm;
  if(!['BUSINESS_LIST','PROFILE'].includes(initialFacts.route)||initialExplicitBlock||
      (!initialFacts.accountMarkerVisible&&!recoveryMode)){
    throw addRecoveryFailureDiagnostics(new Error(initialFacts.state==='BUSINESS_READY'||initialFacts.route==='PROFILE'
      ?'AUTH_OR_PERMISSION_UNRESOLVED':initialFacts.state||'BUSINESS_ROUTE_UNEXPECTED'));
  }

  const authFailureFromEnvelope=(status,envelope)=>{
    if(status===401){responseCounts.authHttp401ResponseCount++;return;}
    if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))return;
    const messages=[envelope.message,envelope.msg].filter(value=>typeof value==='string')
      .map(value=>value.slice(0,2048)).join(' ').slice(0,4096);
    if(/登录(?:信息|状态)?已(?:过期|失效)|登录已过期/u.test(messages))responseCounts.authMessageExpiredResponseCount++;
    if(/用户未登录|尚未登录|请先登录|当前未登录|未登录/u.test(messages))responseCounts.authMessageNotLoggedInResponseCount++;
    if(/当前账号没有菜单权限|没有菜单权限/u.test(messages))responseCounts.menuDeniedMessageResponseCount++;
    if(String(envelope.status_code??'').trim()==='401')responseCounts.authEnvelope401ResponseCount++;
    const code=[envelope.code,envelope.status_code,envelope.error_code].find(value=>
      ['string','number'].includes(typeof value)&&!['','0','200','ok','success'].includes(String(value).trim().toLowerCase()));
    if(code!==undefined){responseCounts.unknownErrorResponseCount++;responseCounts.nonzeroCodeResponseCount++;}
  };
  const onResponse=response=>{
    const task=(async()=>{
      const request=response.request();
      const requestUrl=String(request.url()||'');
      const resourceType=request.resourceType();
      if(!['fetch','xhr'].includes(resourceType)||!requestUrl.startsWith(`${ORIGIN}/`))return;
      const status=response.status();
      const path=originPath(requestUrl);
      responseCounts.observedResponseCount++;
      if(path===FEED_PATH)responseCounts.feedResponseCount++;
      else if(/\/(?:im|message|chat)(?:\/|_|$)/iu.test(path))responseCounts.imResponseCount++;
      else responseCounts.otherResponseCount++;
      if(status>=200&&status<300)responseCounts.http2xxResponseCount++;
      else if(status>=400&&status<500)responseCounts.http4xxResponseCount++;
      else if(status>=500)responseCounts.http5xxResponseCount++;
      if(status>=400)responseCounts.unknownErrorResponseCount++;
      if(path===FEED_PATH)return;
      if(status===401){authFailureFromEnvelope(status,null);return;}
      const headers=response.headers()||{};
      const contentType=String(headers['content-type']||'').toLowerCase();
      const contentLength=Number(headers['content-length']);
      if(!contentType.includes('json')){
        return;
      }
      responseCounts.jsonResponseCount++;
      if(!Number.isInteger(contentLength)||contentLength<0||contentLength>8192){
        responseCounts.uninspectedJsonResponseCount++;return;
      }
      const envelope=await response.json().catch(()=>null);
      if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)){
        responseCounts.jsonParseFailureCount++;return;
      }
      responseCounts.inspectedJsonResponseCount++;
      authFailureFromEnvelope(status,envelope);
    })();
    pendingResponses.add(task);
    void task.finally(()=>pendingResponses.delete(task));
  };
  const onRequest=request=>{
    const requestUrl=String(request.url()||'');
    if(!requestUrl.startsWith(`${ORIGIN}/`)||originPath(requestUrl)!==FEED_PATH||request.method()!=='POST')return;
    if(!formalSearchSubmitted||!activeSearchToken||Date.now()<activationAt)return;
    searchDiagnostics.feedRequestCount++;
    const fieldPath=exactIdRequestField(request.postData()||'',activeQueryValue);
    if(!fieldPath)return;
    matchedRequestCount++;
    searchDiagnostics.matchedRequestCount=matchedRequestCount;
    requestIdFieldPath=fieldPath;
    matchedRequests.set(request,activeSearchToken);
  };
  const onFeedResponse=response=>{
    if(!feedMonitoringActive)return;
    const request=response.request();
    if(matchedRequests.get(request)!==activeSearchToken)return;
    matchedResponseCount++;
    searchDiagnostics.matchedResponseCount=matchedResponseCount;
    if(matchedResponseCount!==1)return;
    const task=(async()=>{
      const status=response.status();
      searchDiagnostics.httpStatusCategory=status>=200&&status<300?'2xx':status>=400&&status<500?'4xx':
        status>=500?'5xx':'other';
      responseCounts.jsonResponseCount++;
      responseCounts.inspectedJsonResponseCount++;
      let envelope=null;
      try{envelope=await response.json();}catch{}
      if(!envelope||typeof envelope!=='object'||Array.isArray(envelope))responseCounts.jsonParseFailureCount++;
      authFailureFromEnvelope(status,envelope);
      const code=typeof envelope?.code==='number'?envelope.code:
        typeof envelope?.code==='string'&&/^\d+$/u.test(envelope.code)?Number(envelope.code):null;
      const list=envelope?.data?.list;
      searchDiagnostics.businessCodeCategory=code===0?'zero':code===null?'missing':'nonzero';
      searchDiagnostics.listCount=Array.isArray(list)?Math.min(list.length,100000):null;
      const exactItems=Array.isArray(list)?list.filter(candidate=>String(candidate?.author_base?.aweme_id??'')===creatorId):[];
      searchDiagnostics.exactIdMatchCount=Math.min(exactItems.length,100000);
      const uniqueExactItem=exactItems.length===1?exactItems[0]:null;
      const exactUids=exactItems.map(candidate=>candidate?.author_base?.uid);
      const validExactUids=exactUids.filter(uid=>typeof uid==='string'&&!!uid.trim()&&uid===uid.trim());
      const exactUidConflict=exactItems.length>1&&
        (validExactUids.length!==exactItems.length||new Set(validExactUids).size>1);
      const uniqueExactUid=uniqueExactItem?.author_base?.uid||
        (exactItems.length>1&&!exactUidConflict?validExactUids[0]:undefined);
      const exactId=exactItems.length===1;
      const uid=uniqueExactUid;
      const validUid=typeof uid==='string'&&!!uid.trim()&&uid===uid.trim();
      searchDiagnostics.uidPresent=validUid;
      searchDiagnostics.awemeIdMatchesTarget=exactItems.length===1&&
        String(uniqueExactItem?.author_base?.aweme_id??'')===creatorId;
      searchDiagnostics.uidFromExactResult=exactItems.length===1&&validUid;
      if(status!==200||code!==0||!Array.isArray(list)||(!exactId&&!(activeQueryKind==='NICKNAME'&&exactItems.length>1&&!exactUidConflict))||
          !validUid){
        responseCounts.targetFeedErrorCount++;
        activeSearchTargetErrorCount++;
        feedResponse={httpStatus:status,envelopeCode:code,listCount:Array.isArray(list)?list.length:null,
          exactIdMatchCount:exactItems.length,uidPresent:searchDiagnostics.uidPresent,
          identityConflict:exactUidConflict,awemeId:exactId?creatorId:'',item:null};
      }else{
        selectedFeedItem=exactItems.length===1?{uid}:null;
        feedResponse={httpStatus:status,envelopeCode:code,listCount:list.length,exactIdMatchCount:exactItems.length,
          exactItemCount:exactItems.length,identityConflict:false,uidPresent:searchDiagnostics.uidPresent,awemeId:creatorId};
      }
    })();
    pendingResponses.add(task);
    void task.finally(()=>pendingResponses.delete(task));
  };
  const removeListeners=async()=>{
    if(!listenersInstalled)return;
    try{page.off('request',onRequest);}catch{}
    try{page.off('response',onResponse);}catch{}
    try{page.off('response',onFeedResponse);}catch{}
    listenersInstalled=false;
  };
  page.on('request',onRequest);
  page.on('response',onResponse);
  page.on('response',onFeedResponse);
  listenersInstalled=true;

  const flushResponses=async(timeoutMs=5000)=>{
    const until=Date.now()+timeoutMs;
    while(pendingResponses.size){
      const remaining=until-Date.now();
      if(remaining<=0){
        const error=new Error('RESPONSE_EVIDENCE_INCOMPLETE');
        error.safeResponseEvidence={counters:{...responseCounts},authPromptLatched};
        throw error;
      }
      await page.waitForTimeout(Math.min(40,remaining));
    }
  };
  const inspectAuthState=async()=>{
    const facts=await inspectPage(page);
    if(facts.hasChallenge||facts.menuPermissionDenied||facts.authRequiredPrompt||facts.authExpiredPrompt||
        facts.loginEntryVisible||facts.loginForm)authPromptLatched=true;
    return {...facts,state:facts.state,accountMarkerVisible:facts.accountMarkerVisible,
      searchControlVisible:facts.searchControlVisible};
  };
  const readAuthEvidence=async()=>{
    await flushResponses();
    return {counters:{...responseCounts},authPromptLatched};
  };
  const inspectFailureAuthEvidence=async()=>{
    const state=await inspectAuthState();
    return {state,evidence:{counters:{...responseCounts},authPromptLatched},
      unresolved:pendingResponses.size>0};
  };
  const readSearchDiagnostics=async()=>{
    try{await flushResponses(3000);}catch{}
    return {...searchDiagnostics,submittedAfterActivation:formalSearchSubmitted&&activationAt>0,
      matchedRequestCount,matchedResponseCount};
  };
  const inspectBackgroundGuard=async(extra={})=>{
    let nowPages=[];
    try{nowPages=context.pages();}catch{}
    let targetClosed=false;
    try{targetClosed=typeof page.isClosed==='function'&&page.isClosed();}catch{targetClosed=true;}
    const targetContextMatches=(()=>{try{return context===page.context();}catch{return false;}})();
    const pageSetStable=nowPages.length===knownPages.length&&nowPages.every((candidate,index)=>candidate===knownPages[index]);
    let targetHidden=false;
    if(!targetClosed&&nowPages.includes(page)){
      try{targetHidden=await readBackgroundState(page).then(facts=>facts.hidden);}catch{}
    }
    let otherPageNavigationChanged=false,otherPageVisibilityChanged=false,otherPageDocumentChanged=false;
    if(pageSetStable){
      for(const [other,before] of otherBaselines){
        try{
          const after=await pageSnapshot(other);
          if(after.href!==before.href)otherPageNavigationChanged=true;
          if(after.visibility!==before.visibility)otherPageVisibilityChanged=true;
          if(after.documentTimeOrigin!==before.documentTimeOrigin)otherPageDocumentChanged=true;
        }catch{otherPageDocumentChanged=true;}
      }
    }
    return classifyBackgroundGuardDiagnostics({targetClosed,targetContextMatches,targetHidden,pageSetStable,
      otherPageNavigationChanged,otherPageVisibilityChanged,otherPageDocumentChanged,
      profileUidConfirmed:extra.profileUidConfirmed!==false,authHealthy:extra.authHealthy!==false,
      errorFree:extra.errorFree!==false});
  };
  const currentOtherPagesStable=async()=> (await inspectBackgroundGuard()).otherPagesStable;
  const assertBackground=async()=>{
    const diagnostics=await inspectBackgroundGuard();
    if(diagnostics.reason){
      const error=new Error(diagnostics.reason);error.safeGuardDiagnostics=diagnostics;throw error;
    }
  };
  const assertProfileUid=async()=>{
    if(context!==page.context()||!selectedUidFromExactResult||linkedProfileUid!==selectedUidFromExactResult){
      throw new Error('DETAIL_LINK_NOT_VERIFIED');
    }
    const facts=await inspectPage(page);
    if(facts.route!=='PROFILE')throw new Error('DETAIL_NOT_OPENED');
    const actualUid=await page.evaluate(()=>new window.URL(location.href).searchParams.get('uid'));
    if(actualUid!==selectedUidFromExactResult||actualUid!==linkedProfileUid){
      throw new Error('DETAIL_LINK_NOT_VERIFIED');
    }
    await assertBackground();
    return true;
  };
  const assertHealthy=async expectedRoute=>{
    await flushResponses();
    const facts=await inspectAuthState();
    if(facts.hasChallenge)throw new Error('SECURITY_CHALLENGE');
    if(facts.menuPermissionDenied)throw new Error('MENU_PERMISSION_DENIED');
    if(facts.authExpiredPrompt)throw new Error('AUTH_EXPIRED');
    if(facts.authRequiredPrompt||facts.loginEntryVisible||facts.loginForm)throw new Error('AUTH_REQUIRED');
    if(!facts.accountMarkerVisible)throw new Error('AUTH_OR_PERMISSION_UNRESOLVED');
    if(facts.route!==expectedRoute)throw new Error(expectedRoute==='PROFILE'?'DETAIL_NOT_OPENED':'BUSINESS_ROUTE_UNEXPECTED');
    const authKeys=['authRequiredResponseCount','authExpiredResponseCount','menuDeniedResponseCount',
      'authHttp401ResponseCount','authEnvelope401ResponseCount','authMessageNotLoggedInResponseCount',
      'authMessageExpiredResponseCount','menuDeniedMessageResponseCount'];
    if(authPromptLatched||authKeys.some(key=>responseCounts[key]>0))throw new Error('AUTH_REQUIRED');
    await assertBackground();
    return facts;
  };
  const locatorEvidenceError=(reason,evidence={})=>{
    const error=new Error(reason);
    const safeEvidence={};
    for(const [key,count] of Object.entries(evidence)){
      if(['contactItemCount','visibleContactItemCount','wechatLocatorCount','visibleWechatLocatorCount','eyeControlCount']
          .includes(key))safeEvidence[key]=Number.isInteger(count)&&count>=0&&count<=100?count:null;
    }
    error.safeEvidence=safeEvidence;
    return error;
  };
  const waitForBusinessReady=async(timeoutMs=60000)=>{
    const until=Date.now()+timeoutMs;
    while(Date.now()<until){
      const facts=await inspectPage(page);
      if(facts.hasChallenge||facts.menuPermissionDenied||facts.authRequiredPrompt||facts.authExpiredPrompt||
          facts.loginEntryVisible||facts.loginForm)throw new Error(facts.state);
      if(facts.route==='BUSINESS_LIST'&&facts.businessReady&&facts.accountMarkerVisible){
        await assertBackground();return facts;
      }
      await page.waitForTimeout(120);
    }
    throw new Error('PAGE_NOT_READY');
  };
  const waitForRecoveryRouteReady=async(timeoutMs=15000)=>{
    const until=Date.now()+timeoutMs;
    let lastReadyRoute='',stableReadySamples=0;
    while(Date.now()<until){
      const facts=await inspectPage(page);
      if(facts.hasChallenge)throw new Error('SECURITY_CHALLENGE');
      if(facts.menuPermissionDenied)throw new Error('MENU_PERMISSION_DENIED');
      if(facts.authExpiredPrompt)throw new Error('AUTH_EXPIRED');
      if(facts.authRequiredPrompt||facts.loginEntryVisible||facts.loginForm)throw new Error('AUTH_REQUIRED');
      if(!['BUSINESS_LIST','PROFILE'].includes(facts.route))throw new Error('BUSINESS_ROUTE_UNEXPECTED');
      const ready=facts.accountMarkerVisible===true&&
        (facts.route==='PROFILE'||facts.route==='BUSINESS_LIST'&&facts.businessReady===true);
      if(ready){
        stableReadySamples=facts.route===lastReadyRoute?stableReadySamples+1:1;
        lastReadyRoute=facts.route;
        if(stableReadySamples>=2){await assertBackground();return facts;}
      }else{lastReadyRoute='';stableReadySamples=0;}
      await page.waitForTimeout(150);
    }
    throw new Error('PAGE_NOT_READY');
  };
  const readPreflightRevealedContact=async()=>{
    const facts=await inspectPage(page);
    if(facts.route!=='PROFILE')return;
    const preflight=await page.evaluate(()=>{
      const visible=element=>!!element&&element.getClientRects().length>0&&
        getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
      const rows=[...document.querySelectorAll('div.index-module__contact-item___ny9bn')]
        .filter(row=>visible(row)&&/^[\u3400-\u9fff\s]*微信(?:号码|账号|号)?\s*[:：]/u.test(
          String(row.querySelector(':scope > span')?.innerText||'').trim()));
      if(rows.length!==1)return {rowCount:rows.length,uid:new window.URL(location.href).searchParams.get('uid')||''};
      const text=String(rows[0].querySelector(':scope > span')?.innerText||'').trim();
      const match=text.match(/^[\u3400-\u9fff\s]*微信(?:号码|账号|号)?\s*[:：]\s*(\S[\s\S]*)$/u);
      const value=match?.[1]?.trim()||'';
      const masked=!value||/[*＊•●]|暂无|未提供|未填写|查看|点击|加载|获取|申请/u.test(value);
      return {rowCount:1,labelMatched:!!match,masked,nonMaskedValue:!!match&&/[A-Za-z0-9]/u.test(value)&&!masked,
        value,uid:new window.URL(location.href).searchParams.get('uid')||''};
    });
    if(preflight?.rowCount===1&&preflight.labelMatched===true&&preflight.masked===false&&
        preflight.nonMaskedValue===true&&typeof preflight.value==='string'&&preflight.value&&preflight.uid){
      preflightRevealedContact={value:preflight.value,uid:preflight.uid};
    }
  };

  let ip='recovery_readiness';
  let it=false;
  let il=false;
  const readInitDiagnostics=()=>({executionPhase:ip,navigationTimedOut:it,
    listRouteAfterTimeout:il});
  try{
    if(recoveryMode)await waitForRecoveryRouteReady();
    if(revealRecoveryPhase==='refreshed')await readPreflightRevealedContact();
    if(revealRecoveryPhase==='rebaseline'){
      recoveryRebaselinePassed=false;
      await waitForRecoveryRouteReady();
    }
    if(revealRecoveryPhase==='refreshed'&&!preflightRevealedContact){
      if(recoveryReservation?.reserved!==true||recoveryReservation?.refreshCount!==1||
          recoveryReservation?.clickCount!==2||!recoveryOperationId){
        throw new Error('INVALID_ARGUMENTS');
      }
      await assertBackground();
      if(typeof page.reload!=='function')throw new Error('REVEAL_RECOVERY_REFRESH_UNAVAILABLE');
      recoveryRefreshCount=1;recoveryPageReloaded=true;
      try{
        await page.reload({waitUntil:'domcontentloaded',timeout:20000});
        await waitForRecoveryRouteReady();
      }catch(error){
        throw addRecoveryFailureDiagnostics(error);
      }
    }
    if(originPath(page.url())!==LIST_PATH){
      await assertBackground();
      ip='navigate_list';
      try{
        await page.goto(LIST_URL,{waitUntil:'domcontentloaded',timeout:20000});
      }catch(error){
        if(error?.name!=='TimeoutError')throw error;
        it=true;
        il=originPath(page.url())===LIST_PATH;
        if(!il)throw error;
        // Navigation can commit before DOMContentLoaded times out. The existing
        // business readiness and background checks remain the acceptance gate.
        await assertBackground();
      }
    }
    ip='wait_business_ready';
    await waitForBusinessReady();
  }catch(error){
    error.safeInitDiagnostics=readInitDiagnostics();
    addRecoveryFailureDiagnostics(error);
    await removeListeners();
    throw error;
  }

  return {
    context,page,
    readInitDiagnostics,
    async inspectAuthState(){return inspectAuthState();},
    async readAuthEvidence(){return readAuthEvidence();},
    async inspectFailureAuthEvidence(){return inspectFailureAuthEvidence();},
    async readSearchDiagnostics(){return readSearchDiagnostics();},
    async searchExactId(queryId,queryType='ID'){
      let executionPhase='argument_validation';
      const setExecutionPhase=phase=>{executionPhase=phase;searchDiagnostics.executionPhase=phase;};
      searchDiagnostics.executionPhase='argument_validation';searchDiagnostics.exceptionCategory='';
      if(!['ID','NICKNAME'].includes(queryType)||
          (queryType==='ID'&&queryId!==creatorId)||(queryType==='NICKNAME'&&queryId!==creatorName)){
        searchDiagnostics.failureBranch='query_id_mismatch';throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      if(searchAttemptCount>=config.searchAttemptLimit){searchDiagnostics.failureBranch='search_budget_exhausted';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      searchAttemptCount++;
      const fallbackReason=searchDiagnostics.fallbackReason;
      Object.assign(searchDiagnostics,{submittedAfterActivation:false,queryType,attemptCount:searchAttemptCount,
        creatorIdQueryMatchesTarget:queryType==='ID'&&queryId===creatorId,
        fallbackReason,feedRequestCount:0,matchedRequestCount:0,matchedResponseCount:0,
        httpStatusCategory:'missing',businessCodeCategory:'missing',listCount:null,exactIdMatchCount:0,
        awemeIdMatchesTarget:false,feedResultIdMatchesTarget:false,selectedExactResultPresent:false,uidFromExactResult:false,
        visibleExactIdMatchCount:null,visibleStableIdentityMatchCount:null,matchedIdentityKeyKind:'',
        matchedIdentityAttributeNames:[],matchedIdentityHrefParamNames:[],contactLabelPresent:false,
        contactMarkerState:'missing',contactMarkerAttributeNames:[],uidPresent:false,failureBranch:'not_started'});
      searchDiagnostics.executionPhase='';searchDiagnostics.exceptionCategory='';
      activeQueryValue=String(queryId);
      activeQueryKind=queryType;
      activeSearchToken++;
      activeSearchTargetErrorCount=0;
      matchedRequestCount=0;matchedResponseCount=0;requestIdFieldPath='';
      feedResponse=null;selectedUidFromExactResult='';selectedFeedItem=null;
      setExecutionPhase('page_guard');
      await assertHealthy('BUSINESS_LIST');
      setExecutionPhase('control_lookup');
      const search=page.getByPlaceholder(SEARCH_PLACEHOLDER,{exact:true});
      if(await search.count()!==1||await search.filter({visible:true}).count()!==1)throw new Error('SEARCH_CONTROL_NOT_UNIQUE');
      setExecutionPhase('input_fill');
      if(await search.inputValue()!=='')await search.fill('');
      await search.fill(activeQueryValue);
      if(await search.inputValue()!==activeQueryValue)throw new Error('SEARCH_QUERY_MISMATCH');
      setExecutionPhase('button_readiness');
      const button=page.getByRole('button',{name:'搜索',exact:true});
      const until=Date.now()+20000;
      let ready=false;
      while(Date.now()<until){
        const count=await button.count();
        if(count===1&&await button.filter({visible:true}).count()===1&&await button.isEnabled()){
          ready=true;break;
        }
        await page.waitForTimeout(120);
      }
      if(!ready)throw new Error('SEARCH_BUTTON_NOT_ACTIONABLE');
      if(await button.count()!==1)throw new Error('SEARCH_BUTTON_NOT_UNIQUE');
      setExecutionPhase('activation_guard');
      feedMonitoringActive=true;
      formalSearchSubmitted=true;
      activationAt=Date.now();
      searchDiagnostics.submittedAfterActivation=true;
      searchDiagnostics.failureBranch='awaiting_response';
      await assertBackground();
      let result;
      try{
        setExecutionPhase('click_dispatch');
        await button.evaluate(element=>element.click());
        setExecutionPhase('response_wait');
        const feedDeadline=Date.now()+20000;
        while(!feedResponse&&Date.now()<feedDeadline)await page.waitForTimeout(120);
        result=feedResponse;
      }finally{feedMonitoringActive=false;}
      if(!result){
        searchDiagnostics.failureBranch=matchedRequestCount===0?'no_exact_request':
          matchedResponseCount===0?'no_bound_response':'bound_response_not_parsed';
        throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      setExecutionPhase('response_validation');
      await flushResponses();
      if(result.httpStatus===429||result.envelopeCode===11001){searchDiagnostics.failureBranch='business_code_nonzero_or_missing';throw new Error('RATE_LIMITED');}
      await assertHealthy('BUSINESS_LIST');
      if(matchedRequestCount!==1||matchedResponseCount!==1||!requestIdFieldPath){
        searchDiagnostics.failureBranch=matchedRequestCount>1?'duplicate_exact_requests':
          matchedRequestCount===0?'no_exact_request':matchedResponseCount===0?'no_bound_response':'request_response_count_mismatch';
        throw new Error(matchedRequestCount>1?'TARGET_SEARCH_AMBIGUOUS':'TARGET_SEARCH_UNVERIFIED');
      }
      if(result.httpStatus!==200){searchDiagnostics.failureBranch='http_non_200';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      if(result.envelopeCode!==0){searchDiagnostics.failureBranch='business_code_nonzero_or_missing';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      if(result.listCount===null){searchDiagnostics.failureBranch='result_list_not_array';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      if(result.identityConflict===true){searchDiagnostics.failureBranch='exact_id_uid_conflict';throw new Error('TARGET_SEARCH_AMBIGUOUS');}
      if(result.exactIdMatchCount===0){searchDiagnostics.failureBranch='exact_id_match_zero';throw new Error('TARGET_NOT_FOUND');}
      if(result.exactIdMatchCount>1){searchDiagnostics.failureBranch='exact_id_match_multiple';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      if(!result.uidPresent){searchDiagnostics.failureBranch='exact_result_uid_missing';throw new Error('TARGET_SEARCH_UNVERIFIED');}
      searchDiagnostics.feedResultIdMatchesTarget=result.awemeId===creatorId;
      searchDiagnostics.selectedExactResultPresent=!!selectedFeedItem;
      if(!searchDiagnostics.feedResultIdMatchesTarget||!searchDiagnostics.selectedExactResultPresent){
        searchDiagnostics.failureBranch='exact_result_not_selected';
        throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      await assertHealthy('BUSINESS_LIST');
      setExecutionPhase('visible_result');
      const uid=selectedUidFromExactResult||selectedFeedItem?.uid;
      if(typeof uid!=='string'||!uid.trim()){
        searchDiagnostics.failureBranch='exact_result_uid_missing';throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      const visibleResultDeadline=Date.now()+5000;
      let visibleResult=null;
      do{
        visibleResult=await inspectVisibleBuyinIdRows(page,creatorId,SEARCH_PLACEHOLDER,
          {includeContactMarker:true,expectedUid:uid});
        const visibleCount=Number.isInteger(visibleResult?.exactMatches)?visibleResult.exactMatches:0;
        searchDiagnostics.visibleStableIdentityMatchCount=visibleCount;
        searchDiagnostics.visibleExactIdMatchCount=['AWEME_ID','BOTH'].includes(visibleResult?.matchedIdentityKeyKind)
          ?visibleCount:0;
        searchDiagnostics.matchedIdentityKeyKind=visibleResult?.matchedIdentityKeyKind||'';
        searchDiagnostics.matchedIdentityAttributeNames=Array.isArray(visibleResult?.matchedIdentityAttributeNames)
          ?visibleResult.matchedIdentityAttributeNames:[];
        searchDiagnostics.matchedIdentityHrefParamNames=Array.isArray(visibleResult?.matchedIdentityHrefParamNames)
          ?visibleResult.matchedIdentityHrefParamNames:[];
        searchDiagnostics.contactLabelPresent=visibleResult?.contactLabelPresent===true;
        searchDiagnostics.contactMarkerState=visibleResult?.contactMarkerState||'missing';
        searchDiagnostics.contactMarkerAttributeNames=Array.isArray(visibleResult?.contactMarkerAttributeNames)
          ?visibleResult.contactMarkerAttributeNames:[];
        if(visibleCount>0)break;
        await page.waitForTimeout(120);
      }while(Date.now()<visibleResultDeadline);
      if(searchDiagnostics.visibleStableIdentityMatchCount===0){
        searchDiagnostics.failureBranch='visible_result_unverified';
        throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      if(searchDiagnostics.visibleStableIdentityMatchCount!==1){
        searchDiagnostics.failureBranch='visible_result_ambiguous';
        throw new Error('TARGET_SEARCH_AMBIGUOUS');
      }
      if(!['UID','AWEME_ID','BOTH'].includes(searchDiagnostics.matchedIdentityKeyKind)){
        searchDiagnostics.failureBranch='visible_result_unverified';
        throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      if(!['present','absent'].includes(searchDiagnostics.contactMarkerState)){
        searchDiagnostics.failureBranch='contact_marker_unresolved';
        throw new Error('CONTACT_MARKER_UNRESOLVED');
      }
      if(searchDiagnostics.contactMarkerState==='absent'&&searchDiagnostics.contactLabelPresent!==true){
        searchDiagnostics.failureBranch='contact_label_not_present';
        throw new Error('CONTACT_LABEL_NOT_PRESENT');
      }
      if(searchDiagnostics.contactMarkerState==='present'&&searchDiagnostics.contactLabelPresent!==true){
        searchDiagnostics.failureBranch='contact_marker_unresolved';
        throw new Error('CONTACT_MARKER_UNRESOLVED');
      }
      setExecutionPhase('detail_link');
      const detailHref=await page.evaluate(({templateHref,resolvedUid})=>{
        const url=new window.URL(templateHref,location.origin);
        if(url.origin!=='https://buyin.jinritemai.com'||url.pathname!=='/dashboard/servicehall/daren-profile'||
            url.username||url.password||url.searchParams.getAll('uid').length!==1)throw new Error('DETAIL_LINK_NOT_VERIFIED');
        url.searchParams.set('uid',resolvedUid);
        return url.href;
      },{templateHref:config.detailTemplate,resolvedUid:uid});
      selectedUidFromExactResult=uid;
      selectedFeedItem=null;
      searchDiagnostics.failureBranch='passed';
      searchDiagnostics.executionPhase='';searchDiagnostics.exceptionCategory='';
      const identityProof={submittedAfterActivation:formalSearchSubmitted&&activationAt>0,
        requestIdMatched:true,requestIdFieldPath,responseBoundToRequest:true,httpStatus:result.httpStatus,
        envelopeCode:result.envelopeCode,listCount:result.listCount,exactIdMatchCount:result.exactIdMatchCount,
        awemeId:result.awemeId,
        domResultCount:searchDiagnostics.visibleStableIdentityMatchCount,
        domIdentityKeyKind:searchDiagnostics.matchedIdentityKeyKind,
        domIdentityBoundToCurrentFeedItem:true,
        contactMarkerState:searchDiagnostics.contactMarkerState,
        uidFromExactResult:true,
        detailUrlBoundToRecordUid:true};
      return {formalMatch:true,exactMatches:1,resultStructure:'API_FEED_ID_MATCH',identityProof,
        detailHref,detailLinkCount:0,contactLabelPresent:true};
    },
    async searchCreator({creatorId:requestedId=creatorId,creatorName:requestedName=creatorName}={}){
      if(requestedId!==creatorId||String(requestedName||'').trim()!==creatorName){
        searchDiagnostics.failureBranch='query_id_mismatch';throw new Error('TARGET_SEARCH_UNVERIFIED');
      }
      const normalNicknameFallbackBranches=new Set(['exact_id_match_zero','exact_id_match_multiple','exact_result_uid_missing']);
      const transientBranches=new Set(['no_exact_request','no_bound_response','bound_response_not_parsed']);
      const captureUnknownSearchException=error=>{
        const className=typeof error?.name==='string'?error.name:'';
        searchDiagnostics.exceptionCategory=['TargetClosedError','PageClosedError','BrowserClosedError'].includes(className)
          ?'target_closed':['ProtocolError','WebSocketError','ConnectionError'].includes(className)?'protocol'
          :className==='TimeoutError'?'timeout':['ExecutionContextError','ExecutionContextDestroyedError'].includes(className)
            ?'execution_context':['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(className)
              ?'javascript':'other';
        searchDiagnostics.executionPhase=searchDiagnostics.executionPhase||'argument_validation';
      };
      const isTransient=()=>transientBranches.has(searchDiagnostics.failureBranch)||
        (searchDiagnostics.failureBranch==='http_non_200'&&['5xx','other'].includes(searchDiagnostics.httpStatusCategory));
      const hasNickname=!!creatorName;
      if(hasNickname){
        let nicknameRetryUsed=false;
        while(true){
          try{return await this.searchExactId(creatorName,'NICKNAME');}
          catch(error){
            captureUnknownSearchException(error);
            if(error?.message==='TARGET_SEARCH_AMBIGUOUS'||searchDiagnostics.failureBranch==='exact_id_uid_conflict')throw error;
            const normalMiss=(error?.message==='TARGET_NOT_FOUND'&&searchDiagnostics.failureBranch==='exact_id_match_zero')||
              (error?.message==='TARGET_SEARCH_UNVERIFIED'&&normalNicknameFallbackBranches.has(searchDiagnostics.failureBranch));
            if(normalMiss){searchDiagnostics.fallbackReason='nickname_no_exact_stable_id';break;}
            if(error?.message==='TARGET_SEARCH_UNVERIFIED'&&isTransient()&&!nicknameRetryUsed&&searchAttemptCount<2){
              nicknameRetryUsed=true;
              await page.waitForTimeout(200);
              continue;
            }
            if(error?.message==='TARGET_SEARCH_UNVERIFIED'&&isTransient()&&nicknameRetryUsed){
              searchDiagnostics.fallbackReason='nickname_query_unverified';break;
            }
            throw error;
          }
        }
      }
      while(searchAttemptCount<config.searchAttemptLimit){
        try{return await this.searchExactId(creatorId,'ID');}
        catch(error){
          captureUnknownSearchException(error);
          if(error?.message!=='TARGET_SEARCH_UNVERIFIED'||!isTransient()||searchAttemptCount>=config.searchAttemptLimit)throw error;
          await page.waitForTimeout(searchAttemptCount===1?200:500);
        }
      }
      throw new Error('TARGET_SEARCH_UNVERIFIED');
    },
    async openMatchedProfile(match){
      if(match?.resultStructure!=='API_FEED_ID_MATCH'||match?.identityProof?.uidFromExactResult!==true||
          match?.identityProof?.detailUrlBoundToRecordUid!==true)throw new Error('DETAIL_LINK_NOT_VERIFIED');
      setOpenDetailExecutionPhase('pre_guard');
      await assertHealthy('BUSINESS_LIST');
      setOpenDetailExecutionPhase('expected_uid');
      const expectedUid=await page.evaluate(href=>new window.URL(href,location.origin).searchParams.get('uid'),match.detailHref);
      if(!expectedUid||expectedUid!==selectedUidFromExactResult)throw new Error('DETAIL_LINK_NOT_VERIFIED');
      setOpenDetailExecutionPhase('navigate');
      await page.goto(match.detailHref,{waitUntil:'domcontentloaded',timeout:20000});
      const until=Date.now()+20000;
      let facts=null;
      while(Date.now()<until){
        setOpenDetailExecutionPhase('profile_poll');
        facts=await inspectPage(page);
        if(facts.route==='PROFILE'&&facts.accountMarkerVisible)break;
        setOpenDetailExecutionPhase('profile_wait');
        await page.waitForTimeout(120);
      }
      if(facts?.route!=='PROFILE'||!facts.accountMarkerVisible)throw new Error('DETAIL_NOT_OPENED');
      setOpenDetailExecutionPhase('actual_uid');
      const actualUid=await page.evaluate(()=>new window.URL(location.href).searchParams.get('uid'));
      if(actualUid!==expectedUid||actualUid!==selectedUidFromExactResult)throw new Error('DETAIL_LINK_NOT_VERIFIED');
      linkedProfileUid=actualUid;
      setOpenDetailExecutionPhase('profile_guard');
      await assertHealthy('PROFILE');
      setOpenDetailExecutionPhase('profile_uid');
      await assertProfileUid();
      if(['refreshed','rebaseline'].includes(revealRecoveryPhase))recoveryRebaselinePassed=true;
      return {opened:true,route:'PROFILE',profileRouteUidMatchesExactResultUid:true};
    },
    setOpenDetailExecutionPhase,
    async readOpenDetailExecutionPhase(){return openDetailExecutionPhase;},
    async revealWechat(){
      let executionPhase='initial_guard';
      const runReveal=async()=>{
      await assertHealthy('PROFILE');
      await assertProfileUid();
      executionPhase='locator_counts';
      const contactItems=page.locator('div.index-module__contact-item___ny9bn');
      const wechatRows=contactItems.filter({hasText:/^[\u3400-\u9fff\s]*微信(?:号码|账号|号)?\s*[:：]/u});
      const visibleWechatRows=wechatRows.filter({visible:true});
      if(contactItems.page()!==page||wechatRows.page()!==page||visibleWechatRows.page()!==page)
        throw new Error('EXECUTION_CONTEXT_CHANGED');
      const locatorDiagnostics={contactItemCount:0,visibleContactItemCount:0,wechatLocatorCount:0,
        visibleWechatLocatorCount:0};
      let latestChannelDiagnostics=null;
      const readChannelDiagnostics=async()=>{
        executionPhase='channel_probe';
        let previousSignature='',stableSamples=0,last={contactItemCount:0,visibleContactItemCount:0,categories:[]};
        for(let sampleIndex=0;sampleIndex<3;sampleIndex++){
          await assertHealthy('PROFILE');
          await assertProfileUid();
          const observed=await page.evaluate(({selector})=>{
            const visible=element=>!!element&&element.getClientRects().length>0&&
              getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
            const items=[...document.querySelectorAll(selector)];
            const shown=items.filter(visible);
            const categories=shown.map(row=>{
              const labelSpan=[...row.children].find(child=>child.tagName==='SPAN')||row.querySelector(':scope > span');
              const text=String(labelSpan?.innerText||'').trim();
              const label=text.split(/[：:]/u,1)[0].trim();
              if(/微信/u.test(label))return 'wechat';
              if(['达人手机号','手机号','手机号码'].includes(label))return 'phone';
              return 'unknown';
            });
            return {contactItemCount:items.length,visibleContactItemCount:shown.length,categories};
          },{selector:'div.index-module__contact-item___ny9bn',contactChannelProbe:true});
          const categories=Array.isArray(observed?.categories)
            ?observed.categories.filter(value=>['phone','wechat','unknown'].includes(value)):[];
          last={contactItemCount:Number.isInteger(observed?.contactItemCount)?observed.contactItemCount:0,
            visibleContactItemCount:Number.isInteger(observed?.visibleContactItemCount)?observed.visibleContactItemCount:0,
            categories};
          const signature=JSON.stringify(last);
          stableSamples=signature===previousSignature?stableSamples+1:1;
          previousSignature=signature;
          if(sampleIndex<2)await page.waitForTimeout(200);
        }
        const labelCounts={phone:last.categories.filter(value=>value==='phone').length,
          wechat:last.categories.filter(value=>value==='wechat').length,
          unknown:last.categories.filter(value=>value==='unknown').length};
        const locatorCounts=await readCurrentLocatorDiagnostics();
        let profileUidConfirmed=false,contextStable=false,targetHidden=false,authHealthy=false;
        try{
          await assertHealthy('PROFILE');
          await assertProfileUid();
          const guard=await inspectBackgroundGuard();
          profileUidConfirmed=guard.profileUidConfirmed===true;
          contextStable=guard.targetContextMatches===true&&guard.pageSetStable===true&&guard.otherPagesStable===true;
          targetHidden=guard.targetHidden===true;
          authHealthy=guard.authHealthy===true&&guard.errorFree===true;
          if(guard.reason)throw new Error(guard.reason);
        }catch(error){
          error.safeChannelDiagnostics={observedReady:false,profileUidConfirmed,contextStable,targetHidden,authHealthy,
            contactItemCount:last.contactItemCount,visibleContactItemCount:last.visibleContactItemCount,
            wechatLocatorCount:locatorCounts.wechatLocatorCount,visibleWechatLocatorCount:locatorCounts.visibleWechatLocatorCount,
            phoneLocatorCount:labelCounts.phone,visiblePhoneLocatorCount:labelCounts.phone,unclassifiedRowCount:labelCounts.unknown,
            visibleWechatRowCount:labelCounts.wechat,visibleOtherChannelCount:labelCounts.phone,stableSamples};
          throw error;
        }
        const observedReady=last.contactItemCount>0&&last.visibleContactItemCount===last.contactItemCount&&
          last.categories.length===last.visibleContactItemCount&&labelCounts.unknown===0;
        return {observedReady,profileUidConfirmed,contextStable,targetHidden,authHealthy,
          contactItemCount:last.contactItemCount,visibleContactItemCount:last.visibleContactItemCount,
          wechatLocatorCount:locatorCounts.wechatLocatorCount,visibleWechatLocatorCount:locatorCounts.visibleWechatLocatorCount,
          phoneLocatorCount:labelCounts.phone,visiblePhoneLocatorCount:labelCounts.phone,
          visibleWechatRowCount:labelCounts.wechat,visibleOtherChannelCount:labelCounts.phone,
          unclassifiedRowCount:labelCounts.unknown,stableSamples};
      };
      const readCurrentLocatorDiagnostics=async()=>{
        const current={...locatorDiagnostics};
        try{current.contactItemCount=await contactItems.count();}catch{}
        try{current.visibleContactItemCount=await contactItems.filter({visible:true}).count();}catch{}
        try{current.wechatLocatorCount=await wechatRows.count();}catch{}
        try{current.visibleWechatLocatorCount=await visibleWechatRows.count();}catch{}
        return current;
      };
      let clickIssued=false,eyeActivationCount=0,clickAttemptCount=0,eyeControlCount=null;
      const attemptSignals=[];
      const revealError=async(failureBranch,currentState)=>{
        const counts=await readCurrentLocatorDiagnostics();
        const error=new Error('REVEAL_UNCONFIRMED');
        const finalState=currentState?.labelMatched!==true?'unresolved':
          currentState?.masked===true?'masked':currentState?.nonMaskedValue===true?'nonmasked':'unresolved';
        error.safeRevealDiagnostics={failureBranch,...counts,eyeControlCount,
          eyeActivationCount,clickIssued,clickAttemptCount,recoveryPhase:revealRecoveryPhase,
          refreshCount:recoveryRefreshCount,pageReloaded:recoveryPageReloaded,
          rebaselinePassed:recoveryRebaselinePassed,recoveryOperationId,
          recoveryExecutionId,recoveryParentAttemptId,priorReceiptVerified:recoveryParentReceiptVerified,
          reservedClickCount:recoveryReservedClickCount,reservedRefreshCount:recoveryReservedRefreshCount,attemptSignals,
          clickState:clickIssued?'issued':clickAttemptCount>0?'unknown':'not_issued',
          labelMatched:currentState?.labelMatched===true,finalState};
        error.safeEvidence={...counts,eyeControlCount};
        return error;
      };
      for(let attempt=0;attempt<100;attempt++){
        executionPhase='locator_counts';
        await assertHealthy('PROFILE');
        await assertProfileUid();
        locatorDiagnostics.contactItemCount=await contactItems.count();
        locatorDiagnostics.visibleContactItemCount=await contactItems.filter({visible:true}).count();
        locatorDiagnostics.wechatLocatorCount=await wechatRows.count();
        locatorDiagnostics.visibleWechatLocatorCount=await visibleWechatRows.count();
        if(locatorDiagnostics.visibleWechatLocatorCount>1)
          throw locatorEvidenceError('WECHAT_ROW_NOT_UNIQUE',locatorDiagnostics);
        if(locatorDiagnostics.visibleWechatLocatorCount===1)break;
        if(attempt===0&&locatorDiagnostics.visibleContactItemCount>0){
          latestChannelDiagnostics=await readChannelDiagnostics();
          const channel=latestChannelDiagnostics;
          if(channel.observedReady&&channel.profileUidConfirmed&&channel.contextStable&&channel.targetHidden&&
              channel.authHealthy&&channel.contactItemCount>0&&
              channel.visibleContactItemCount===channel.contactItemCount&&
              channel.wechatLocatorCount===0&&channel.visibleWechatLocatorCount===0&&
              channel.phoneLocatorCount===channel.contactItemCount&&
              channel.visiblePhoneLocatorCount===channel.contactItemCount&&channel.unclassifiedRowCount===0&&
              channel.stableSamples>=3){
            const error=new Error('WECHAT_NOT_PROVIDED');error.safeChannelDiagnostics=channel;throw error;
          }
        }
        if(attempt<99)await page.waitForTimeout(150);
      }
      executionPhase='row_inspection';
      if(locatorDiagnostics.visibleWechatLocatorCount!==1){
        if(locatorDiagnostics.visibleContactItemCount>0){
          latestChannelDiagnostics=await readChannelDiagnostics();
          const channel=latestChannelDiagnostics;
          if(channel.observedReady&&channel.profileUidConfirmed&&channel.contextStable&&channel.targetHidden&&
              channel.authHealthy&&channel.contactItemCount>0&&
              channel.visibleContactItemCount===channel.contactItemCount&&
              channel.wechatLocatorCount===0&&channel.visibleWechatLocatorCount===0&&
              channel.phoneLocatorCount===channel.contactItemCount&&
              channel.visiblePhoneLocatorCount===channel.contactItemCount&&channel.unclassifiedRowCount===0&&
              channel.stableSamples>=3){
            const error=new Error('WECHAT_NOT_PROVIDED');error.safeChannelDiagnostics=channel;throw error;
          }
        }
        const error=locatorEvidenceError('WECHAT_ROW_NOT_READY',locatorDiagnostics);
        if(latestChannelDiagnostics)error.safeChannelDiagnostics=latestChannelDiagnostics;
        throw error;
      }
      const field=visibleWechatRows;
      const inspect=async()=>field.evaluate(element=>{
        const text=element.querySelector(':scope > span')?.innerText?.trim()||'';
        const match=text.match(/^[\u3400-\u9fff\s]*微信(?:号码|账号|号)?\s*[:：]\s*(\S[\s\S]*)$/u);
        const value=match?.[1]?.trim()||'';
        const maskPattern=/[＊*•·●]|暂无|未提供|未填写|查看|点击|加载|获取|申请/u;
        const masked=value?maskPattern.test(value):!text||maskPattern.test(text);
        const nonMaskedValue=!!match&&/[A-Za-z0-9]/u.test(value)&&
          !/[＊*•●]|暂无|未提供|未填写|查看|点击|加载|获取|申请/u.test(value);
        return {rowCount:1,labelMatched:!!match,masked,unmaskedTextPresent:!!text&&!masked,nonMaskedValue,contactValue:value};
      });
      let state=await inspect();
      await assertProfileUid();
      if(state.rowCount!==1)throw new Error('WECHAT_ROW_NOT_UNIQUE');
      if(state.labelMatched!==true)throw await revealError('initial_label_unverified',state);
      state.masked=state.masked===true||!!state.contactValue&&isMaskedValue(state.contactValue);
      state.nonMaskedValue=state.nonMaskedValue&&!isMaskedValue(state.contactValue);
      if(state.masked&&revealRecoveryPhase==='refreshed'&&preflightRevealedContact&&
          preflightRevealedContact.uid===selectedUidFromExactResult&&
          selectedUidFromExactResult===linkedProfileUid&&preflightRevealedContact.value&&
          !isMaskedValue(preflightRevealedContact.value)){
        state={...state,masked:false,nonMaskedValue:true,contactValue:preflightRevealedContact.value};
      }
      if(state.masked){
        executionPhase='eye_control';
        const eye=field.locator('span.index-module__contact-item-btn___tZUqf');
        const eyeCount=await eye.count();
        eyeControlCount=eyeCount;
        if(eye.page()!==page||eyeCount!==1){
          if(eye.page()!==page)throw new Error('EXECUTION_CONTEXT_CHANGED');
          throw locatorEvidenceError('REVEAL_CONTROL_NOT_UNIQUE',{eyeControlCount:eyeCount,
            ...locatorDiagnostics});
        }
        const actionable=await eye.evaluate(element=>{
          const rect=element.getBoundingClientRect();
          const center=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
          return rect.width>0&&rect.height>0&&getComputedStyle(element).visibility==='visible'&&
            element.getAttribute('aria-disabled')!=='true'&&!element.hasAttribute('disabled')&&
            (center===element||element.contains(center));
        });
        if(!actionable)throw new Error('REVEAL_CONTROL_NOT_ACTIONABLE');
        const maxClicks=['refreshed','rebaseline'].includes(revealRecoveryPhase)?2:1;
        const readNotificationCategory=async()=>{
          executionPhase='pre_click_check';
          const category=await page.evaluate(()=>{
          const visible=element=>!!element&&element.getClientRects().length>0&&
            getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
          const texts=[...document.querySelectorAll('body *')].filter(node=>visible(node)&&!node.children.length)
            .map(node=>String(node.innerText||node.textContent||'').trim()).filter(Boolean).slice(-120);
          if(texts.some(text=>/安全验证|验证码|滑块|操作频繁|风险|异常操作/u.test(text)))return 'risk_notice';
          if(texts.some(text=>/当前账号没有菜单权限|没有菜单权限|用户未登录|尚未登录|请先登录|登录.*(?:过期|失效)/u.test(text)))return 'auth_notice';
          if(texts.some(text=>/获取成功|展示成功|已显示|操作成功/u.test(text)))return 'contact_success_notice';
          return 'none_or_unrecognized';
          });
          return ['none_or_unrecognized','contact_success_notice','auth_notice','risk_notice'].includes(category)
            ?category:'none_or_unrecognized';
        };
        const feedbackObserverKey='__kocContactFeedbackObserverV1';
        const classifyFeedbackText=text=>{
          const normalized=String(text??'').normalize('NFKC').replace(/[\s，,。！？!?；;：:、]/gu,'');
          if(/安全验证|验证码|滑块|操作频繁|风险|异常操作/u.test(normalized))return 'risk_notice';
          if(/当前账号没有菜单权限|没有菜单权限|用户未登录|尚未登录|请先登录|登录.*(?:过期|失效)/u.test(normalized))
            return 'auth_notice';
          if(normalized==='本周仅支持查看匹配类目达人联系方式达人主营类目不属于店铺类目'||
              normalized==='本周仅支持查看匹配类目达人的联系方式达人主推类目不属于店铺类目')
            return 'contact_category_restricted';
          return '';
        };
        const installTransientFeedbackObserver=async()=>page.evaluate(key=>{
          if(!document.body||typeof MutationObserver!=='function')return {installed:false,
            errorCode:'PAGE_OBSERVER_UNAVAILABLE'};
          const previous=window[key];
          try{previous?.observer?.disconnect();}catch{}
          const feedbackEvents=[];
          const classify=text=>{
            const normalized=String(text??'').normalize('NFKC').replace(/[\s，,。！？!?；;：:、]/gu,'');
            if(/安全验证|验证码|滑块|操作频繁|风险|异常操作/u.test(normalized))return 'risk_notice';
            if(/当前账号没有菜单权限|没有菜单权限|用户未登录|尚未登录|请先登录|登录.*(?:过期|失效)/u.test(normalized))
              return 'auth_notice';
            if(normalized==='本周仅支持查看匹配类目达人联系方式达人主营类目不属于店铺类目'||
              normalized==='本周仅支持查看匹配类目达人的联系方式达人主推类目不属于店铺类目')
              return 'contact_category_restricted';
            return '';
          };
          const visible=element=>!!element&&element.getClientRects().length>0&&
            getComputedStyle(element).visibility!=='hidden'&&getComputedStyle(element).display!=='none';
          const surfaceFor=element=>{
            const region=element.closest('[aria-live],[role="alert"],[role="status"]');
            if(region?.hasAttribute('aria-live'))return 'aria-live';
            if(region?.getAttribute('role')==='alert')return 'role-alert';
            if(region?.getAttribute('role')==='status')return 'role-status';
            return 'visible-leaf';
          };
          const processMutations=records=>{
            for(const record of records){
              const mutationTarget=record.target?.nodeType===Node.ELEMENT_NODE?record.target:record.target?.parentElement;
              const mutationTargetVisible=visible(mutationTarget);
              const roots=record.type==='characterData'?[record.target?.parentElement]:
                Array.from(record.addedNodes||[]);
              for(const root of roots){
                if(!root)continue;
                const elements=root.nodeType===Node.TEXT_NODE?[root.parentElement]:root.nodeType===Node.ELEMENT_NODE
                  ?[root,...root.querySelectorAll('*')]:[];
                for(const element of elements){
                  if(!element||element.children.length||(!visible(element)&&
                      !(record.type==='childList'&&!element.isConnected&&mutationTargetVisible)))continue;
                  const surface=surfaceFor(element);
                  const classified=classify(element.innerText||element.textContent||'');
                  if(!classified&&surface==='visible-leaf')continue;
                  const category=classified||'unrecognized_notice';
                  const observedAt=performance.now();
                  const last=feedbackEvents.at(-1);
                  if(last?.category===category&&last?.surface===surface&&observedAt-last.observedAt<50)continue;
                  feedbackEvents.push({category,observedAt,observedAtIso:new Date().toISOString(),surface});
                  if(feedbackEvents.length>20)feedbackEvents.shift();
                }
              }
            }
          };
          const observer=new MutationObserver(processMutations);
          observer.observe(document.body,{childList:true,subtree:true,characterData:true});
          const installedAt=new Date().toISOString();
          window[key]={observer,feedbackEvents,processMutations,documentRef:document,
            locationHref:String(location.href),uid:new URL(location.href).searchParams.get('uid')||'',
            clickAt:null,actionAt:null,installedAt};
          return {installed:true,installedAt};
        },feedbackObserverKey);
        const collectTransientFeedbackEvents=async()=>{const hidden=(await readBackgroundState(page)).hidden;return page.evaluate(({key,hidden})=>{
          const feedbackState=window[key];
          const completedAt=new Date().toISOString();
          if(!feedbackState)return {installed:false,boundToTargetPage:false,action:'expand',
            installedAt:null,actionAt:null,completedAt,events:[]};
          const feedbackEvents=feedbackState.feedbackEvents;
          try{feedbackState.processMutations(feedbackState.observer.takeRecords());}
          finally{feedbackState.observer.disconnect();}
          const currentUid=new URL(location.href).searchParams.get('uid')||'';
          const targetBound=feedbackState.documentRef===document&&!!feedbackState.uid&&
            currentUid===feedbackState.uid&&String(location.href)===feedbackState.locationHref&&
            hidden===true;
          const result=feedbackEvents.slice(0,20).map(event=>({category:event.category,
            elapsedMs:Number.isFinite(event.observedAt)?Math.max(0,Math.min(30000,Math.round(event.observedAt-
              (feedbackState.clickAt??event.observedAt)))):null,
            observedAt:event.observedAtIso,
            afterAction:Number.isFinite(feedbackState.clickAt)&&event.observedAt>=feedbackState.clickAt,
            targetBound,surface:event.surface}));
          delete window[key];
          return {installed:true,boundToTargetPage:targetBound,action:'expand',
            installedAt:feedbackState.installedAt,actionAt:feedbackState.actionAt,
            completedAt:new Date().toISOString(),events:result};
        },{key:feedbackObserverKey,hidden});};
        const normalizeTransientFeedbackEvents=(collection,clickObserved)=>Array.isArray(collection?.events)
          ?collection.events.slice(0,20).flatMap(event=>{
          const surface=['aria-live','role-alert','role-status','visible-leaf'].includes(event?.surface)
            ?event.surface:'visible-leaf';
          const classified=['contact_category_restricted','auth_notice','risk_notice']
            .includes(event?.category)?event.category:classifyFeedbackText(event?.text);
          const category=classified||(['aria-live','role-alert','role-status'].includes(surface)
            ?'unrecognized_notice':'');
          if(!category)return [];
          return [{category,elapsedMs:Number.isInteger(event?.elapsedMs)&&event.elapsedMs>=0&&event.elapsedMs<=30000
            ?event.elapsedMs:null,afterAction:event?.afterAction===true&&clickObserved===true,
            targetBound:event?.targetBound===true,observedAt:typeof event?.observedAt==='string'?event.observedAt:null,
            surface}];
        }):[];
        for(let attemptIndex=0;attemptIndex<maxClicks&&state.masked;attemptIndex++){
          executionPhase='pre_click_check';
          await assertBackground();
          await assertHealthy('PROFILE');
          await assertProfileUid();
          const notificationBaselineCategory=await readNotificationCategory();
          if(notificationBaselineCategory==='auth_notice'||notificationBaselineCategory==='risk_notice'){
            const error=new Error(notificationBaselineCategory==='auth_notice'?'AUTH_REQUIRED':'SECURITY_CHALLENGE');
            const branch=notificationBaselineCategory==='auth_notice'?'auth_interruption':'risk_interruption';
            error.safeRevealDiagnostics=(await revealError(branch,state)).safeRevealDiagnostics;
            throw error;
          }
          const startedAt=Date.now();
          const requests=new Map(),responses=[],pendingSignals=[];
          let captureState='unobserved',orphanResponseCount=0,notificationCategory='none_or_unrecognized';
          let requestListenerInstalled=false,responseListenerInstalled=false,cleanupFailed=false;
          let clickUnknown=false,clickEventObserved=null,clickStartedAt=null,clickDispatchMs=null,
            clickActionAt=null,passiveWaitStartedAt=null,passiveWaitEndedAt=null,terminalError=null,terminalBranch='';
          let feedbackObserverAttempted=false,feedbackObserverInstalled=false,feedbackObserverCleanupFailed=false;
          let feedbackObserverInstallAttemptedAt=null,feedbackObserverInstalledAt=null;
          let feedbackObserverInstallFailureCode=null,feedbackCollectionFailureCode=null;
          let feedbackCollection=null,feedbackObservation=null;
          let transientFeedbackEvents=[];
          let waitWindowMs=0;
          const timelineSamples=[];
          const recordTimelineSample=async(phase,currentState,readOutcome,observedNotification,profileUidConfirmed)=>{
            if(timelineSamples.length>=103)return;
            let pageVisibility='unknown';
            try{const visibility=await readBackgroundState(page).then(facts=>facts.visibility);
              if(['hidden','visible','prerender'].includes(visibility))pageVisibility=visibility;}catch{}
            timelineSamples.push({phase,elapsedMs:Math.max(0,Math.min(30000,Date.now()-startedAt)),
              rowCount:Number.isInteger(currentState?.rowCount)?currentState.rowCount:null,
              labelMatched:typeof currentState?.labelMatched==='boolean'?currentState.labelMatched:null,
              masked:typeof currentState?.masked==='boolean'?currentState.masked:null,
              unmaskedTextPresent:currentState?.unmaskedTextPresent===true,
              nonMaskedValue:currentState?.nonMaskedValue===true,
              readOutcome:['ok','error'].includes(readOutcome)?readOutcome:'not_run',
              notificationCategory:observedNotification,profileUidConfirmed:profileUidConfirmed===true,pageVisibility});
          };
          const requestListener=request=>{
            try{
              const resourceType=String(request.resourceType?.()||'unknown');
              let originMatched=null;
              try{originMatched=String(request.url?.()||'').startsWith(`${ORIGIN}/`);}catch{}
              requests.set(request,{originMatched,resourceTypeCategory:
                ['fetch','xhr'].includes(resourceType)?'fetch_xhr':'other'});
            }catch{captureState='unobserved';}
          };
          const responseListener=response=>{
            const task=(async()=>{
              try{
                const request=response.request?.();
                if(!requests.has(request)){orphanResponseCount++;return;}
                const status=Number(response.status?.());
                let businessCodeCategory='missing';
                const headers=response.headers?.()||{};
                const contentType=String(headers['content-type']||'').toLowerCase();
                const contentLength=Number(headers['content-length']);
                if(contentType.includes('json')&&Number.isInteger(contentLength)&&contentLength>=0&&contentLength<=8192){
                  try{
                    const payload=await response.json();
                    const raw=payload&&typeof payload==='object'
                      ?payload.code??payload.status_code??payload.error_code:undefined;
                    if(raw===0||String(raw??'').trim()==='0')businessCodeCategory='zero';
                    else if(raw!==undefined&&raw!==null&&String(raw).trim()!=='')businessCodeCategory='nonzero';
                  }catch{}
                }
                responses.push({status:Number.isFinite(status)?status:null,businessCodeCategory,
                  originMatched:requests.get(request).originMatched});
              }catch{captureState='unobserved';}
            })();
            pendingSignals.push(task);
          };
          try{
            executionPhase='observer_setup';
            page.on('request',requestListener);requestListenerInstalled=true;
            page.on('response',responseListener);responseListenerInstalled=true;
            captureState='observed';
            feedbackObserverAttempted=true;
            feedbackObserverInstallAttemptedAt=new Date(Date.now()).toISOString();
            const feedbackInstall=await installTransientFeedbackObserver();
            feedbackObserverInstalled=feedbackInstall?.installed===true;
            feedbackObserverInstalledAt=feedbackObserverInstalled&&typeof feedbackInstall?.installedAt==='string'
              ?feedbackInstall.installedAt:null;
            feedbackObserverInstallFailureCode=feedbackObserverInstalled?null:
              ['PAGE_OBSERVER_UNAVAILABLE','OBSERVER_INSTALL_FAILED'].includes(feedbackInstall?.errorCode)
                ?feedbackInstall.errorCode:'OBSERVER_INSTALL_FAILED';
            if(!feedbackObserverInstalled)throw new Error('REVEAL_LISTENER_INSTALL_FAILED');
            await recordTimelineSample('pre_click',state,'ok',notificationBaselineCategory,true);
            clickAttemptCount++;eyeActivationCount++;
            executionPhase='click_dispatch';
            clickStartedAt=Date.now();
            try{
              const clickResult=await eye.evaluate(element=>{
              let observed=false;
              let actionAt=null;
              const onClick=event=>{
                if(event.target===element||element.contains(event.target)){
                  observed=true;
                  const feedbackState=element.ownerDocument.defaultView.__kocContactFeedbackObserverV1;
                  if(feedbackState){feedbackState.clickAt=performance.now();
                    feedbackState.actionAt=new Date().toISOString();actionAt=feedbackState.actionAt;}
                }
              };
              element.addEventListener('click',onClick,true);
              try{element.click();}finally{element.removeEventListener('click',onClick,true);}
              return {observed,actionAt};
              });
              clickEventObserved=clickResult?.observed===true;
              clickActionAt=clickEventObserved&&typeof clickResult?.actionAt==='string'
                ?clickResult.actionAt:null;
              clickIssued=clickEventObserved===true;
            }
            catch{clickUnknown=true;}
            clickDispatchMs=Math.max(0,Math.min(30000,Date.now()-clickStartedAt));
            await recordTimelineSample('click_result',state,'not_run',notificationBaselineCategory,true);
            if(!clickUnknown){
              passiveWaitStartedAt=Date.now();
              const until=passiveWaitStartedAt+config.revealObservationWindowMs;
              do{
                executionPhase='reveal_poll';
                let readSucceeded=false,profileUidConfirmed=false;
                try{
                  await page.waitForTimeout(200);
                  await assertHealthy('PROFILE');
                  await assertProfileUid();
                  profileUidConfirmed=true;
                  state=await inspect();
                  readSucceeded=true;
                  await assertProfileUid();
                  state.masked=state.masked===true||!!state.contactValue&&isMaskedValue(state.contactValue);
                  state.nonMaskedValue=state.nonMaskedValue&&!isMaskedValue(state.contactValue);
                  if(state.rowCount!==1){
                    await recordTimelineSample('poll',state,'ok',notificationCategory,profileUidConfirmed);
                    terminalBranch='post_click_row_changed';break;
                  }
                  notificationCategory=await readNotificationCategory();
                  await recordTimelineSample('poll',state,'ok',notificationCategory,profileUidConfirmed);
                  if(state.labelMatched!==true){terminalBranch='post_click_label_unverified';break;}
                  if(notificationCategory==='auth_notice'&&notificationBaselineCategory!=='auth_notice'){
                    terminalError=new Error('AUTH_REQUIRED');break;
                  }
                  if(notificationCategory==='risk_notice'&&notificationBaselineCategory!=='risk_notice'){
                    terminalError=new Error('SECURITY_CHALLENGE');break;
                  }
                  if(state.nonMaskedValue)break;
                }catch(error){
                  await recordTimelineSample('poll_error',state,readSucceeded?'ok':profileUidConfirmed?'error':'not_run',
                    notificationCategory,profileUidConfirmed);
                  terminalError=error;break;
                }
              }while(Date.now()<until);
              if(clickEventObserved===true){
                const actionTime=Date.parse(clickActionAt||'');
                const boundedEnd=(Number.isFinite(actionTime)?actionTime:clickStartedAt)+config.revealObservationWindowMs;
                const remaining=Math.max(0,boundedEnd-Date.now());
                if(remaining>0){
                  try{await page.waitForTimeout(remaining);}
                  catch(error){terminalError=terminalError||error;}
                }
              }
              passiveWaitEndedAt=Date.now();
            }
          }catch(error){terminalError=error;
          }finally{
            executionPhase='feedback_cleanup';
            if(passiveWaitStartedAt!==null)waitWindowMs=Math.max(0,Math.min(30000,
              (passiveWaitEndedAt??Date.now())-passiveWaitStartedAt));
            if(requestListenerInstalled)try{page.off('request',requestListener);}catch{
              try{page.off('request',requestListener);}catch{cleanupFailed=true;}
            }
            if(responseListenerInstalled)try{page.off('response',responseListener);}catch{
              try{page.off('response',responseListener);}catch{cleanupFailed=true;}
            }
            if(feedbackObserverAttempted){
              try{
                feedbackCollection=await collectTransientFeedbackEvents();
                transientFeedbackEvents=normalizeTransientFeedbackEvents(feedbackCollection,clickEventObserved);
              }
              catch{
                feedbackObserverCleanupFailed=true;
                feedbackCollectionFailureCode='PAGE_CONTEXT_CHANGED';
                try{
                  feedbackCollection=await collectTransientFeedbackEvents();
                  transientFeedbackEvents=normalizeTransientFeedbackEvents(feedbackCollection,clickEventObserved);
                }
                catch{feedbackObserverCleanupFailed=true;feedbackCollectionFailureCode='PAGE_CONTEXT_CHANGED';}
              }
            }
            if(pendingSignals.length)await Promise.allSettled(pendingSignals);
          }
          let feedbackTargetGuardPassed=false;
          if(clickEventObserved===true&&feedbackCollection?.boundToTargetPage===true){
            try{
              executionPhase='post_reveal_guard';
              await assertBackground();
              await assertHealthy('PROFILE');
              await assertProfileUid();
              feedbackTargetGuardPassed=true;
            }catch(error){terminalError=error;}
          }
          if(clickEventObserved===true&&feedbackObserverInstalled&&
              feedbackCollection?.boundToTargetPage!==true&&!terminalError){
            terminalError=new Error('EXECUTION_CONTEXT_CHANGED');
          }
          transientFeedbackEvents=transientFeedbackEvents.map(event=>({...event,
            targetBound:event.targetBound&&feedbackTargetGuardPassed}));
          const targetIdentityPairVerified=!!selectedUidFromExactResult&&
            selectedUidFromExactResult===linkedProfileUid&&feedbackTargetGuardPassed;
          const observationCompletedAt=feedbackCollection?.completedAt||new Date(Date.now()).toISOString();
          feedbackObservation=adaptBuyinToastObservation({
            installAttemptedAt:feedbackObserverInstallAttemptedAt,
            installedAt:feedbackObserverInstalledAt,
            observerInstalled:feedbackObserverInstalled,
            installFailureCode:feedbackObserverInstallFailureCode||
              (feedbackObserverInstalled?null:feedbackObserverAttempted?'OBSERVER_INSTALL_FAILED':'PAGE_OBSERVER_UNAVAILABLE'),
            pageBindingFailureCode:feedbackCollectionFailureCode||
              (feedbackObserverInstalled&&feedbackCollection?.boundToTargetPage===false?'PAGE_CONTEXT_CHANGED':null),
            observerBound:feedbackCollection?.boundToTargetPage===true&&feedbackTargetGuardPassed,
            targetIdentityPairVerified,
            actionAt:feedbackCollection?.actionAt||clickActionAt||null,
            completedAt:observationCompletedAt,
            windowLimitMs:config.revealObservationWindowMs,
            events:transientFeedbackEvents,
          });
          transientFeedbackEvents=feedbackObservation.toast.events.map(event=>({
            category:event.category,elapsedMs:event.elapsedMs,afterAction:event.afterAction,
            targetBound:event.targetBound,surface:event.surface,observedAt:event.observedAt,
            diagnosticCode:event.classification.diagnosticCode,errorReason:event.classification.errorReason,
            redactedText:event.redactedText,
          }));
          if(!terminalError&&transientFeedbackEvents.some(event=>event.afterAction&&event.targetBound&&
              event.category==='risk_notice'))terminalError=new Error('SECURITY_CHALLENGE');
          if(!terminalError&&transientFeedbackEvents.some(event=>event.afterAction&&event.targetBound&&
              event.category==='auth_notice'))terminalError=new Error('AUTH_REQUIRED');
          if(!terminalError&&transientFeedbackEvents.some(event=>event.afterAction&&event.targetBound&&
              event.category==='unrecognized_notice'))terminalError=new Error('UNRECOGNIZED_TRANSIENT_NOTICE');
          const requestCount=requests.size,responseCount=responses.length;
          const statusCategories=[...new Set(responses.map(item=>item.status===null?'missing':
            item.status>=200&&item.status<300?'2xx':item.status>=400&&item.status<500?'4xx':
              item.status>=500&&item.status<600?'5xx':'other'))];
          const codeCategories=[...new Set(responses.map(item=>item.businessCodeCategory))];
          const endpointClass=requestCount===0?'none':requestCount>1?'ambiguous':
            requests.values().next().value.originMatched===true?'other_same_origin':
              requests.values().next().value.originMatched===false?'other_cross_origin':'ambiguous';
          let correlationState='unobserved',observationState=captureState==='observed'?'observed':'unobserved';
          if(orphanResponseCount>0&&responseCount===0)observationState='unobserved';
          if(observationState==='observed'&&requestCount===0)correlationState='zero_observed_requests';
          else if(observationState==='observed'&&requestCount>0&&responseCount===0)correlationState='request_no_response';
          else if(observationState==='observed'&&(requestCount!==1||responseCount!==1))correlationState='ambiguous_multiple';
          else if(observationState==='observed'&&responseCount===1)correlationState='single_other_endpoint';
          attemptSignals.push({requestCount:observationState==='unobserved'?null:requestCount,
            responseCount:observationState==='unobserved'?null:responseCount,endpointClass,
            httpStatusCategory:statusCategories.length===0?'missing':statusCategories.length>1?'multiple':statusCategories[0],
            businessCodeCategory:codeCategories.length===0?'missing':codeCategories.length>1?'multiple':codeCategories[0],
            correlationState,elapsedMs:Math.max(0,Math.min(10000,Date.now()-startedAt)),
            waitWindowMs,waitWindowLimitMs:config.revealObservationWindowMs,clickDispatchMs,
            clickEventObserved,timelineSamples,
            domState:state.nonMaskedValue?'nonmasked':state.masked?'masked':'unresolved',
            notificationCategory,notificationBaselineCategory,transientFeedbackEvents,feedbackObservation,
            observationState,orphanResponseCount});
          if(clickUnknown)throw await revealError('click_unknown',state);
          if(!requestListenerInstalled||!responseListenerInstalled){
            const error=new Error('REVEAL_LISTENER_INSTALL_FAILED');
            error.safeRevealDiagnostics=(await revealError('listener_setup_failed',state)).safeRevealDiagnostics;
            throw error;
          }
          if(!feedbackObserverInstalled){
            const error=new Error('REVEAL_LISTENER_INSTALL_FAILED');
            error.safeRevealDiagnostics=(await revealError('listener_setup_failed',state)).safeRevealDiagnostics;
            throw error;
          }
          if(cleanupFailed){
            const error=new Error('REVEAL_LISTENER_CLEANUP_FAILED');
            error.safeRevealDiagnostics=(await revealError('listener_cleanup_failed',state)).safeRevealDiagnostics;
            throw error;
          }
          if(feedbackObserverCleanupFailed){
            const error=new Error('REVEAL_LISTENER_CLEANUP_FAILED');
            error.safeRevealDiagnostics=(await revealError('listener_cleanup_failed',state)).safeRevealDiagnostics;
            throw error;
          }
          if(terminalBranch)throw await revealError(terminalBranch,state);
          if(terminalError){
            const branch=terminalError.message==='AUTH_REQUIRED'||terminalError.message==='AUTH_EXPIRED'||
              terminalError.message==='MENU_PERMISSION_DENIED'?'auth_interruption':
              terminalError.message==='SECURITY_CHALLENGE'?'risk_interruption':
              terminalError.message==='UNRECOGNIZED_TRANSIENT_NOTICE'?'unrecognized_transient_notice':
                'identity_or_guard_interruption';
            const diagnostic=await revealError(branch,state);
            terminalError.safeRevealDiagnostics=diagnostic.safeRevealDiagnostics;
            throw terminalError;
          }
          if(state.masked===true&&state.labelMatched===true&&clickEventObserved===true&&
              transientFeedbackEvents.some(event=>event.category==='contact_category_restricted'&&
                event.afterAction&&event.targetBound)){
            const diagnostic=await revealError('contact_category_restricted',state);
            const error=new Error('CONTACT_CATEGORY_RESTRICTED');
            error.safeRevealDiagnostics=diagnostic.safeRevealDiagnostics;
            throw error;
          }
        }
      }
      if(state.masked)throw await revealError('post_click_masked_timeout',state);
      if(state.nonMaskedValue!==true||!state.contactValue)
        throw await revealError('nonmasked_value_unverified',state);
      executionPhase='post_reveal_identity';
      await assertProfileUid();
      return {rowCount:1,labelMatched:true,masked:false,nonMaskedValue:true,revealed:true,
        ...locatorDiagnostics,
        contactValue:state.contactValue,sourceUrl:page.url(),eyeActivationCount,
        revealDiagnostics:{...locatorDiagnostics,eyeControlCount,eyeActivationCount,clickIssued,
          clickAttemptCount,recoveryPhase:revealRecoveryPhase,refreshCount:recoveryRefreshCount,
          pageReloaded:recoveryPageReloaded,rebaselinePassed:recoveryRebaselinePassed,
          recoveryOperationId,recoveryExecutionId,recoveryParentAttemptId,
          priorReceiptVerified:recoveryParentReceiptVerified,reservedClickCount:recoveryReservedClickCount,
          reservedRefreshCount:recoveryReservedRefreshCount,attemptSignals,
          clickState:clickIssued?'issued':'not_issued',labelMatched:true,finalState:'nonmasked'}};
      };
      try{return await runReveal();}
      catch(error){
        const message=typeof error?.message==='string'?error.message:'';
        const knownRevealCodes=new Set(['EXECUTION_CONTEXT_CHANGED','WECHAT_ROW_NOT_UNIQUE','WECHAT_ROW_NOT_READY',
          'WECHAT_NOT_PROVIDED','REVEAL_CONTROL_NOT_UNIQUE','REVEAL_CONTROL_NOT_ACTIONABLE','REVEAL_UNCONFIRMED',
          'REVEAL_RECOVERY_REFRESH_UNAVAILABLE','REVEAL_LISTENER_INSTALL_FAILED','REVEAL_LISTENER_CLEANUP_FAILED',
          'AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED','SECURITY_CHALLENGE',
          'UNRECOGNIZED_TRANSIENT_NOTICE','CONTACT_CATEGORY_RESTRICTED','DETAIL_LINK_NOT_VERIFIED',
          'BACKGROUND_GUARD_FAILED','BACKGROUND_TARGET_CONTEXT_MISMATCH','BACKGROUND_TARGET_VISIBLE',
          'BACKGROUND_PAGE_SET_CHANGED','BACKGROUND_OTHER_PAGE_NAVIGATION_CHANGED',
          'BACKGROUND_OTHER_PAGE_VISIBILITY_CHANGED','BACKGROUND_OTHER_PAGE_DOCUMENT_CHANGED','BACKGROUND_TARGET_CLOSED']);
        if(!knownRevealCodes.has(message)&&!error?.safeRevealDiagnostics){
          const className=typeof error?.name==='string'?error.name:'';
          const exceptionCategory=['TargetClosedError','PageClosedError','BrowserClosedError'].includes(className)
            ?'target_closed':['ProtocolError','WebSocketError','ConnectionError'].includes(className)?'protocol'
            :className==='TimeoutError'?'timeout':['ExecutionContextError','ExecutionContextDestroyedError'].includes(className)
              ?'execution_context':['Error','TypeError','ReferenceError','RangeError','SyntaxError'].includes(className)
                ?'javascript':'other';
          const existing=error?.safeRevealDiagnostics&&typeof error.safeRevealDiagnostics==='object'
            ?error.safeRevealDiagnostics:{};
          try{error.safeRevealDiagnostics={...existing,executionPhase,exceptionCategory};}catch{}
        }
        throw error;
      }
    },
    async readFinalGuard(){
      await flushResponses();
      let profileUidConfirmed=false;
      try{await assertProfileUid();profileUidConfirmed=true;}
      catch{}
      let facts={};
      try{facts=await inspectPage(page);}catch{}
      const authKeys=['authRequiredResponseCount','authExpiredResponseCount','menuDeniedResponseCount',
        'authHttp401ResponseCount','authEnvelope401ResponseCount','authMessageNotLoggedInResponseCount',
        'authMessageExpiredResponseCount','menuDeniedMessageResponseCount'];
      const authHealthy=facts.route==='PROFILE'&&!authPromptLatched&&!facts.hasChallenge&&!facts.menuPermissionDenied&&
        !facts.authRequiredPrompt&&!facts.authExpiredPrompt&&facts.accountMarkerVisible&&
        authKeys.every(key=>responseCounts[key]===0);
      const errorFree=activeSearchTargetErrorCount===0;
      const diagnostics=await inspectBackgroundGuard({profileUidConfirmed,authHealthy,errorFree});
      const reason=diagnostics.reason;
      return {targetHidden:diagnostics.targetHidden,otherPagesStable:diagnostics.otherPagesStable,
        authHealthy,errorFree,reason,guardDiagnostics:{...diagnostics,reason}};
    },
    async close(){
      await removeListeners();
    },
  };
}

function validateConfig({session=ORIGINAL_BACKGROUND_SESSION,creatorId,creatorName='',
  accountMarker=ACCOUNT_MARKER,detailTemplate='',revealRecoveryPhase='single',revealRecoveryReservation=null,
  searchAttemptLimit=3,revealObservationWindowMs=5000}) {
  const stableId=String(creatorId??'').trim();
  const stableName=String(creatorName??'').normalize('NFC').trim();
  if(session!==ORIGINAL_BACKGROUND_SESSION||! /^[A-Za-z0-9._-]{1,128}$/u.test(stableId)||
      stableName.length>100||/[\u0000-\u001f\u007f]/u.test(stableName)||!ACCOUNT_MARKER||accountMarker!==ACCOUNT_MARKER||
      !['single','refreshed','rebaseline'].includes(revealRecoveryPhase)||
      !Number.isInteger(searchAttemptLimit)||searchAttemptLimit<1||searchAttemptLimit>3||
      ![5000,20000].includes(revealObservationWindowMs))throw new Error('INVALID_ARGUMENTS');
  if(['refreshed','rebaseline'].includes(revealRecoveryPhase)&&(stableId!==REVEAL_RECOVERY_CREATOR_ID||stableName!==''||
      revealRecoveryReservation?.reserved!==true||revealRecoveryReservation?.refreshCount!==1||
      revealRecoveryReservation?.clickCount!==2||typeof revealRecoveryReservation?.operationId!=='string'||
      !/^[A-Za-z0-9._-]{1,80}$/u.test(revealRecoveryReservation.operationId)))throw new Error('INVALID_ARGUMENTS');
  if(revealRecoveryPhase==='rebaseline'&&(revealRecoveryReservation?.priorReceiptVerified!==true||
      revealRecoveryReservation?.priorRefreshCount!==1||revealRecoveryReservation?.priorClickAttemptCount!==0||
      !/^[A-Za-z0-9._-]{1,80}$/u.test(String(revealRecoveryReservation?.executionId||''))||
      !/^[A-Za-z0-9._-]{1,80}$/u.test(String(revealRecoveryReservation?.parentAttemptId||''))))
    throw new Error('INVALID_ARGUMENTS');
  if(revealRecoveryPhase==='single'&&revealRecoveryReservation!==null)throw new Error('INVALID_ARGUMENTS');
  let url;
  try{url=new URL(detailTemplate);}catch{throw new Error('INVALID_DETAIL_TEMPLATE');}
  if(url.protocol!=='https:'||url.origin!==ORIGIN||url.pathname!==PROFILE_PATH||url.username||url.password||
      url.searchParams.getAll('uid').length!==1||!url.searchParams.get('uid'))throw new Error('INVALID_DETAIL_TEMPLATE');
  return {session,creatorId:stableId,creatorName:stableName,accountMarker,revealRecoveryPhase,searchAttemptLimit,
    revealObservationWindowMs,
    revealRecoveryReservation,
    detailTemplate:url.href};
}

const PERSISTENCE_PREFLIGHT_MAX_AGE_MS=5*60*1000;

export function persistencePreflightFromEffectiveConfigReceipt(receipt,{session=ORIGINAL_BACKGROUND_SESSION}={}) {
  const verifiedAt=Date.parse(receipt?.endedAt||'');
  const age=Date.now()-verifiedAt;
  if(session!==ORIGINAL_BACKGROUND_SESSION||receipt?.exitSuccess!==true||receipt?.parsed!==true||
      receipt?.saveSessionDisabled!==true||receipt?.rawConfigEmitted!==false||
      receipt?.rawConfigSaved!==false||!Number.isFinite(verifiedAt)||age < -30000||
      age>PERSISTENCE_PREFLIGHT_MAX_AGE_MS){
    throw new Error('ORIGINAL_BACKGROUND_PERSISTENCE_UNVERIFIED');
  }
  return Object.freeze({session,saveSessionDisabled:true,evidenceSource:'effective_config_print',
    rawConfigEmitted:false,rawConfigSaved:false,verifiedAt:receipt.endedAt});
}

export function persistencePreflightFromConfigPrintResult(child,{session=ORIGINAL_BACKGROUND_SESSION}={}) {
  if(child?.error||child?.status!==0||typeof child?.stdout!=='string'){
    const output=`${String(child?.stdout||'')}\n${String(child?.stderr||'')}`;
    if(/The browser\s+['"][^'"]+['"]\s+is not open, please run open first/iu.test(output))
      throw new Error('ORIGINAL_BACKGROUND_SESSION_NOT_OPEN');
    throw new Error('ORIGINAL_BACKGROUND_PERSISTENCE_UNVERIFIED');
  }
  let config;
  try{
    const resultJson=child.stdout.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/u)?.[1]?.trim();
    config=JSON.parse(resultJson||'null');
  }catch{}
  if(!config||typeof config!=='object'||Array.isArray(config)){
    throw new Error('ORIGINAL_BACKGROUND_PERSISTENCE_UNVERIFIED');
  }
  return persistencePreflightFromEffectiveConfigReceipt({
    endedAt:new Date().toISOString(),exitSuccess:true,parsed:true,
    saveSessionDisabled:!config.saveSession,rawConfigEmitted:false,rawConfigSaved:false,
  },{session});
}

function validatePersistencePreflight(preflight,session) {
  const verifiedAt=Date.parse(preflight?.verifiedAt||'');
  const age=Date.now()-verifiedAt;
  if(preflight?.session!==session||preflight?.saveSessionDisabled!==true||
      preflight?.evidenceSource!=='effective_config_print'||preflight?.rawConfigEmitted!==false||
      preflight?.rawConfigSaved!==false||!Number.isFinite(verifiedAt)||age < -30000||
      age>PERSISTENCE_PREFLIGHT_MAX_AGE_MS){
    throw new Error('ORIGINAL_BACKGROUND_PERSISTENCE_UNVERIFIED');
  }
}

export function buildOriginalBackgroundCode(input) {
  const config=validateConfig(input);
  const flow=sameContextBuyinContactRuntimeSource();
  return `async page => {const exactIdRequestField=${exactIdRequestField.toString()};`+
    `const inspectVisibleBuyinIdRows=${inspectVisibleBuyinIdRows.toString()};`+
    `const selectOriginalBackgroundPage=${selectOriginalBackgroundPage.toString()};`+
    `const classifyBackgroundGuardDiagnostics=${classifyBackgroundGuardDiagnostics.toString()};`+
    `const safeRevealDiagnostics=${safeRevealDiagnostics.toString()};`+
    `const adaptBuyinToastObservation=${adaptBuyinToastObservation.toString()};`+
    backgroundStateRuntimeSource()+
    `const createOriginalBackgroundBuyinDriver=${createOriginalBackgroundBuyinDriver.toString()};`+
    `const runSameContextBuyinContact=${flow};`+
    `const config=${JSON.stringify(config)};`+
    `const remoteSafeReasons=new Set(${JSON.stringify([...SAFE_REASONS])});`+
    `const remoteSafeErrorTypes=new Set(${JSON.stringify([...SAFE_RUNTIME_ERROR_TYPES])});`+
    `let driver;let stage='driver-init';try{driver=await createOriginalBackgroundBuyinDriver(page,config,selectOriginalBackgroundPage);`+
    `stage='flow';const result=await runSameContextBuyinContact({driver,creatorId:config.creatorId,creatorName:config.creatorName});`+
    `return {...result,receipt:{...result.receipt,initDiagnostics:driver.readInitDiagnostics()}};}`+
    `catch(error){try{await driver?.close?.();}catch{}const reason=remoteSafeReasons.has(error?.message)?error.message:'BROWSER_ERROR';`+
    `const errorType=remoteSafeErrorTypes.has(error?.name)?error.name:'OTHER',di=error.safeInitDiagnostics;`+
    `return {receipt:{mode:'original_background_contact_e2e',status:'stopped',stage,reason,`+
    `runtimeErrorType:errorType,initDiagnostics:{`+
    `executionPhase:['recovery_readiness','navigate_list','wait_business_ready'].includes(di?.executionPhase)?di.executionPhase:'unknown',`+
    `navigationTimedOut:di?.navigationTimedOut===true,listRouteAfterTimeout:di?.listRouteAfterTimeout===true},`+
    `sameContext:false,samePage:false,authFailureSeen:['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED'].includes(reason),`+
    `formalIdMatch:false,profileOpened:false,wechatRowUnique:false,revealed:false,identityProof:'',workerIdentityProof:null,`+
    `labelMatched:false,nonMaskedValue:false,finalBackgroundGuard:false,errorFree:false,`+
      `revealDiagnostics:safeRevealDiagnostics(error?.safeRevealDiagnostics||{}),`+
    `guardDiagnostics:error?.safeGuardDiagnostics||{}},`+
    `execution:{failureClass:'RUN_CODE_RUNTIME_ERROR',stage,errorType},`+
    `attempt:{contactStatus:['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED'].includes(reason)?'login_required':'error',`+
    `contactCheckedAt:new Date().toISOString(),errorReason:reason}}}}`;
}

// Read-only acceptance for the exact-ID request/response boundary. This probe
// stops after searchExactId succeeds and never opens a profile or touches contact rows.
export function buildOriginalBackgroundSearchProbeCode(input) {
  const config=validateConfig(input);
  return `async page=>{const exactIdRequestField=${exactIdRequestField.toString()};`+
    `const inspectVisibleBuyinIdRows=${inspectVisibleBuyinIdRows.toString()};`+
    `const selectOriginalBackgroundPage=${selectOriginalBackgroundPage.toString()};`+
    `const classifyBackgroundGuardDiagnostics=${classifyBackgroundGuardDiagnostics.toString()};`+
    `const adaptBuyinToastObservation=${adaptBuyinToastObservation.toString()};`+
    backgroundStateRuntimeSource()+
    `const createOriginalBackgroundBuyinDriver=${createOriginalBackgroundBuyinDriver.toString()};`+
    `const SEARCH_FAILURE_BRANCH_SET=new Set(${JSON.stringify(BUYIN_SEARCH_FAILURE_BRANCHES)});`+
    `const safeSearchDiagnostics=${safeSearchDiagnostics.toString()};`+
    `const safeResponseEvidence=${safeResponseEvidence.toString()};`+
    `const config=${JSON.stringify(config)};`+
    `const safeReasons=new Set(${JSON.stringify([...SAFE_REASONS])});`+
    `let driver;let stage='driver-init';let status='stopped';let reason='';let exactStableIdVerified=false;`+
    `let searchDiagnostics=safeSearchDiagnostics();let responseEvidence=safeResponseEvidence();`+
    `try{driver=await createOriginalBackgroundBuyinDriver(page,config,selectOriginalBackgroundPage);stage='id-search';`+
    `const match=await driver.searchExactId(config.creatorId);`+
    `searchDiagnostics=safeSearchDiagnostics(await driver.readSearchDiagnostics());`+
    `responseEvidence=safeResponseEvidence(await driver.readAuthEvidence());`+
    `const proof=match?.identityProof||{};exactStableIdVerified=match?.formalMatch===true&&match?.exactMatches===1&&`+
    `proof?.awemeId===config.creatorId&&proof?.exactIdMatchCount===1&&proof?.uidFromExactResult===true;`+
    `status=exactStableIdVerified?'matched':'stopped';reason=exactStableIdVerified?'':'TARGET_SEARCH_UNVERIFIED';`+
    `}catch(error){const candidate=String(error?.message||'');reason=safeReasons.has(candidate)?candidate:'BROWSER_ERROR';`+
    `try{if(driver){searchDiagnostics=safeSearchDiagnostics(await driver.readSearchDiagnostics());`+
    `responseEvidence=safeResponseEvidence(await driver.readAuthEvidence());}}catch{}}`+
    `let listenerCleanupVerified=false;try{await driver?.close?.();listenerCleanupVerified=!!driver;}catch{}`+
    `return{mode:'id_search_read_only',status,stage,reason,exactStableIdVerified,listenerCleanupVerified,`+
    `searchDiagnostics,responseEvidence};}`;
}

function safeReceipt(receipt={},completed=false) {
  const booleanKeys=['sameContext','samePage','authFailureSeen','formalIdMatch','profileOpened','wechatRowUnique',
    'revealed','labelMatched','nonMaskedValue','finalBackgroundGuard','errorFree'];
  const counts=receipt.responseEvidence||{};
  const counterKeys=['observedResponseCount','feedResponseCount','imResponseCount','otherResponseCount',
    'http2xxResponseCount','http4xxResponseCount','http5xxResponseCount','jsonResponseCount',
    'inspectedJsonResponseCount','uninspectedJsonResponseCount','jsonParseFailureCount',
    'nonzeroCodeResponseCount','unknownErrorResponseCount','targetFeedErrorCount'];
  const responseEvidence=Object.fromEntries(counterKeys.map(key=>{
    const value=Number(counts[key]);
    return [key,Number.isFinite(value)?Math.min(100000,Math.max(0,Math.floor(value))):0];
  }));
  responseEvidence.authPromptLatched=counts.authPromptLatched===true;
  responseEvidence.explicitAuthResponseCount=Number.isFinite(Number(counts.explicitAuthResponseCount))
    ?Math.min(100000,Math.max(0,Math.floor(Number(counts.explicitAuthResponseCount)))):0;
  const search=receipt.searchDiagnostics||{};
  const safeLocatorCount=value=>Number.isInteger(value)&&value>=0&&value<=100?value:null;
  const safeSearchCount=value=>Number.isInteger(value)&&value>=0&&value<=100000?value:null;
  const branchValues=new Set(['not_started','awaiting_response','query_id_mismatch','search_budget_exhausted','no_exact_request',
    'no_bound_response','bound_response_not_parsed','duplicate_exact_requests','request_response_count_mismatch',
    'http_non_200','business_code_nonzero_or_missing','result_list_not_array','exact_id_uid_conflict','exact_id_match_zero',
    'exact_id_match_multiple','exact_result_not_selected','exact_result_uid_missing',
    'visible_result_unverified','visible_result_ambiguous','contact_label_not_present',
    'contact_marker_unresolved','passed']);
  const identityAttributeNames=new Set(['data-row-key','data-key','data-id','data-uid','id']);
  const hrefParamNames=new Set(['uid','aweme_id','author_id','id']);
  const safeSearchDiagnostics={submittedAfterActivation:search.submittedAfterActivation===true,
    queryType:['ID','NICKNAME'].includes(search.queryType)?search.queryType:'ID',
    creatorIdQueryMatchesTarget:search.creatorIdQueryMatchesTarget===true,
    attemptCount:safeSearchCount(search.attemptCount)??0,
    fallbackReason:['','nickname_no_exact_stable_id','nickname_query_unverified'].includes(search.fallbackReason)
      ?search.fallbackReason:'',
    feedRequestCount:safeSearchCount(search.feedRequestCount)??0,
    matchedRequestCount:safeSearchCount(search.matchedRequestCount)??0,
    matchedResponseCount:safeSearchCount(search.matchedResponseCount)??0,
    httpStatusCategory:['missing','2xx','4xx','5xx','other'].includes(search.httpStatusCategory)?search.httpStatusCategory:'missing',
    businessCodeCategory:['missing','zero','nonzero'].includes(search.businessCodeCategory)?search.businessCodeCategory:'missing',
    listCount:safeSearchCount(search.listCount),
    exactIdMatchCount:safeSearchCount(search.exactIdMatchCount)??0,
    awemeIdMatchesTarget:search.awemeIdMatchesTarget===true,
    feedResultIdMatchesTarget:search.feedResultIdMatchesTarget===true,
    selectedExactResultPresent:search.selectedExactResultPresent===true,
    uidFromExactResult:search.uidFromExactResult===true,
    visibleExactIdMatchCount:safeSearchCount(search.visibleExactIdMatchCount),
    visibleStableIdentityMatchCount:safeSearchCount(search.visibleStableIdentityMatchCount),
    matchedIdentityKeyKind:['UID','AWEME_ID','BOTH'].includes(search.matchedIdentityKeyKind)?search.matchedIdentityKeyKind:'',
    matchedIdentityAttributeNames:Array.isArray(search.matchedIdentityAttributeNames)
      ?search.matchedIdentityAttributeNames.filter(name=>identityAttributeNames.has(name)).slice(0,5):[],
    matchedIdentityHrefParamNames:Array.isArray(search.matchedIdentityHrefParamNames)
      ?search.matchedIdentityHrefParamNames.filter(name=>hrefParamNames.has(name)).slice(0,4):[],
    contactLabelPresent:search.contactLabelPresent===true,
    contactMarkerState:['present','absent','unresolved'].includes(search.contactMarkerState)?search.contactMarkerState:'missing',
    contactMarkerAttributeNames:Array.isArray(search.contactMarkerAttributeNames)
      ?search.contactMarkerAttributeNames.filter(name=>/^(?:aria-label|title|data-[a-z0-9_-]{1,40})$/iu.test(name)).slice(0,12):[],
    uidPresent:search.uidPresent===true,
    failureBranch:branchValues.has(search.failureBranch)?search.failureBranch:'unknown'};
  const searchExecutionPhases=new Set(['argument_validation','page_guard','control_lookup','input_fill',
    'button_readiness','activation_guard','click_dispatch','response_wait','response_validation','visible_result','detail_link']);
  const searchExceptionCategories=new Set(['target_closed','protocol','timeout','execution_context','javascript','other']);
  if(searchExecutionPhases.has(search.executionPhase)&&searchExceptionCategories.has(search.exceptionCategory)){
    safeSearchDiagnostics.executionPhase=search.executionPhase;
    safeSearchDiagnostics.exceptionCategory=search.exceptionCategory;
  }
  const guardDiagnostics=safeGuardDiagnostics(receipt.guardDiagnostics);
  return {
    mode:'original_background_contact_e2e',
    status:completed?'completed':'stopped',
    stage:/^[a-z-]{1,32}$/u.test(receipt.stage||'')?receipt.stage:'unknown',
    reason:completed&&receipt.reason==='CONTACT_VALUE_VERIFIED'?'CONTACT_VALUE_VERIFIED':
      receipt.reason==='CONTACT_VALUE_VERIFIED'?'BACKGROUND_GUARD_FAILED':
      SAFE_REASONS.has(receipt.reason)?receipt.reason:'BROWSER_ERROR',
    runtimeErrorType:SAFE_RUNTIME_ERROR_TYPES.has(receipt.runtimeErrorType)?receipt.runtimeErrorType:'',
    failureAuthEvidenceUnresolved:receipt.failureAuthEvidenceUnresolved===true,
    contactItemCount:safeLocatorCount(receipt.contactItemCount),
    visibleContactItemCount:safeLocatorCount(receipt.visibleContactItemCount),
    wechatLocatorCount:safeLocatorCount(receipt.wechatLocatorCount),
    visibleWechatLocatorCount:safeLocatorCount(receipt.visibleWechatLocatorCount),
    eyeControlCount:safeLocatorCount(receipt.eyeControlCount),
    identityProof:receipt.identityProof==='API_FEED_ID_MATCH'?'API_FEED_ID_MATCH':'',
    workerIdentityProof:safeWorkerIdentityProof(receipt.workerIdentityProof),
    responseEvidence,
    responseEvidenceObserved:receipt.responseEvidenceObserved===true,
    searchDiagnostics:safeSearchDiagnostics,
    searchDiagnosticsObserved:receipt.searchDiagnosticsObserved===true,
    ...(safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)
      ?{openDetailDiagnostics:safeOpenDetailDiagnostics(receipt.openDetailDiagnostics)}:{}),
    revealDiagnostics:safeRevealDiagnostics(receipt.revealDiagnostics),
    revealDiagnosticsObserved:receipt.revealDiagnosticsObserved===true,
    channelDiagnostics:safeChannelDiagnostics(receipt.channelDiagnostics),
    guardDiagnostics,
    guardDiagnosticsObserved:receipt.guardDiagnosticsObserved===true,
    ...Object.fromEntries(booleanKeys.map(key=>[key,receipt[key]===true])),
  };
}

function validCompletedRemoteResult(result) {
  const receipt=result?.receipt||{};
  const guard=receipt.guardDiagnostics||{};
  return result?.attempt?.contactStatus==='found'&&typeof result.attempt.contactValue==='string'&&
    /[a-z0-9]/iu.test(result.attempt.contactValue)&&!isMaskedContactValue(result.attempt.contactValue)&&
    typeof result.attempt.contactSourceUrl==='string'&&
    receipt.status==='completed'&&receipt.reason==='CONTACT_VALUE_VERIFIED'&&
    receipt.identityProof==='API_FEED_ID_MATCH'&&receipt.sameContext===true&&receipt.samePage===true&&
    receipt.authFailureSeen===false&&receipt.errorFree===true&&receipt.formalIdMatch===true&&
    receipt.profileOpened===true&&receipt.wechatRowUnique===true&&
    receipt.revealed===true&&receipt.labelMatched===true&&receipt.nonMaskedValue===true&&
    receipt.finalBackgroundGuard===true&&guard.targetClosed===false&&guard.targetContextMatches===true&&
    guard.targetHidden===true&&guard.pageSetStable===true&&guard.otherPagesStable===true&&
    guard.profileUidConfirmed===true&&guard.authHealthy===true&&guard.errorFree===true&&guard.reason===''&&
    result.attempt.errorReason==='';
}

function parseControlledCliResult(child) {
  const stdout=String(child?.stdout||'');
  const marker='### Result';
  const markerIndex=stdout.indexOf(marker);
  if(markerIndex<0)return {markerObserved:false,parsed:false,result:null};
  const payload=stdout.slice(markerIndex+marker.length).trimStart();
  const nextMarker=payload.search(/\r?\n### /u);
  const json=(nextMarker<0?payload:payload.slice(0,nextMarker)).trim();
  try{
    const result=JSON.parse(json);
    if(!result||typeof result!=='object'||Array.isArray(result))return {markerObserved:true,parsed:false,result:null};
    return {markerObserved:true,parsed:true,result};
  }catch{return {markerObserved:true,parsed:false,result:null};}
}

function safeCliExecution(child,parsed) {
  const errorCode=child?.error?.code;
  const safeErrorCodes=new Set(['ENOENT','EACCES','EPERM','ETIMEDOUT','ENOBUFS','EAGAIN']);
  const spawnErrorCode=safeErrorCodes.has(errorCode)?errorCode:errorCode?'OTHER':null;
  const signal=['SIGTERM','SIGKILL','SIGINT','SIGABRT'].includes(child?.signal)?child.signal:
    child?.signal?'OTHER':null;
  const text=`${String(child?.stderr||'')}\n${String(child?.stdout||'')}`;
  const remote=parsed.result?.execution;
  const remoteErrorType=SAFE_RUNTIME_ERROR_TYPES.has(remote?.errorType)
    ?remote.errorType:SAFE_RUNTIME_ERROR_TYPES.has(parsed.result?.receipt?.runtimeErrorType)
      ?parsed.result.receipt.runtimeErrorType:'';
  let failureClass='NONE';
  if(errorCode==='ETIMEDOUT')failureClass='TIMEOUT';
  else if(['ENOENT','EACCES','EPERM'].includes(errorCode))failureClass='CLI_UNAVAILABLE';
  else if(/npm ERR!|command not found|Cannot find package ['"]?@playwright\/cli|Cannot find module ['"]?@playwright\/cli/iu.test(text)){
    failureClass='CLI_UNAVAILABLE';
  }else if(!parsed.parsed&&/SyntaxError|Unexpected token|Invalid or unexpected token|Unexpected end of input/iu.test(text)){
    failureClass='RUN_CODE_COMPILE_ERROR';
  }else if(parsed.markerObserved&&!parsed.parsed){
    failureClass='RESULT_INVALID';
  }else if(remote?.failureClass==='RUN_CODE_RUNTIME_ERROR'||
      (parsed.result?.receipt?.reason==='BROWSER_ERROR'&&remoteErrorType)){
    failureClass='RUN_CODE_RUNTIME_ERROR';
  }else if(child?.status!==0){
    failureClass=parsed.parsed?'RUN_CODE_RUNTIME_ERROR':
      /ReferenceError|TypeError|RangeError|UnhandledPromiseRejection/iu.test(text)
        ?'RUN_CODE_RUNTIME_ERROR':'UNKNOWN';
  }else if(!parsed.markerObserved||!parsed.parsed){
    failureClass='RESULT_INVALID';
  }
  const stageCandidate=remote?.stage||parsed.result?.receipt?.stage;
  const stage=typeof stageCandidate==='string'&&/^[a-z-]{1,32}$/u.test(stageCandidate)?stageCandidate:'unknown';
  return {failureClass,source:child?.error?'spawn_error':child?.status===0?'child_result':'nonzero_child_exit',
    exitStatus:Number.isInteger(child?.status)?child.status:null,signal,spawnErrorCode,
    resultMarkerObserved:parsed.markerObserved,resultParsed:parsed.parsed,stage,remoteErrorType};
}

export async function runOriginalBackgroundSearchProbe({session=ORIGINAL_BACKGROUND_SESSION,
  creatorId,accountMarker=ACCOUNT_MARKER,detailTemplate,spawn=spawnSync,persistencePreflight}={}) {
  validatePersistencePreflight(persistencePreflight,session);
  const config=validateConfig({session,creatorId,accountMarker,detailTemplate});
  const code=buildOriginalBackgroundSearchProbeCode(config);
  let child;
  try{
    child=spawn('npx',playwrightCliArgs(`-s=${config.session}`,'run-code',code),{
      cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',maxBuffer:4*1024*1024,
      timeout:90000,stdio:['ignore','pipe','pipe'],env:playwrightCliEnv()});
  }catch(error){child={status:null,error:{code:error?.code}};}
  const parsed=parseControlledCliResult(child);
  const execution=safeCliExecution(child,parsed);
  if(execution.failureClass!=='NONE')return {mode:'id_search_read_only',status:'runner_failed',
    reason:'BROWSER_ERROR',stage:execution.stage,exactStableIdVerified:false,
    listenerCleanupVerified:false,execution,
    searchDiagnostics:safeSearchDiagnostics(),responseEvidence:safeResponseEvidence()};
  const result=parsed.result||{};
  const reason=SAFE_REASONS.has(result.reason)?result.reason:'';
  const searchDiagnostics=safeSearchDiagnostics(result.searchDiagnostics);
  const responseEvidence=safeResponseEvidence(result.responseEvidence);
  const exactStableIdVerified=result.status==='matched'&&result.exactStableIdVerified===true&&
    searchDiagnostics.failureBranch==='passed'&&searchDiagnostics.exactIdMatchCount===1&&
    searchDiagnostics.uidPresent===true;
  return {mode:'id_search_read_only',status:exactStableIdVerified?'matched':'stopped',
    reason:exactStableIdVerified?'':reason||'TARGET_SEARCH_UNVERIFIED',
    stage:/^(?:driver-init|id-search)$/u.test(result.stage)?result.stage:'unknown',
    exactStableIdVerified,listenerCleanupVerified:result.listenerCleanupVerified===true,
    searchDiagnostics,responseEvidence,execution};
}

function failedCliOutcome(parsed,execution) {
  const result=parsed.result||{};
  if(result.attempt){
    result.attempt.contactValue='';
    result.attempt.contactSourceUrl='';
  }
  return {receipt:safeReceipt(result.receipt,false),execution,
    writeback:{updated:false,status:'not_written',fieldNames:[]}};
}

function safeWriterSummary(value={}) {
  return {updated:value.updated===true,status:value.status==='found'?'found':'unknown',
    fieldNames:Array.isArray(value.fieldNames)?value.fieldNames.filter(name=>
      ['本次联系方式状态','联系方式最近尝试','联系方式最近成功','联系方式最近错误','联系方式来源','微信号'].includes(name)):[]};
}

// The raw value is captured from the CLI child and handed directly to the
// existing narrow writer. Neither this function nor its return value emits it.
export async function runOriginalBackgroundContact({session=ORIGINAL_BACKGROUND_SESSION,
  creatorId,creatorName='',recordId,accountMarker=ACCOUNT_MARKER,
  detailTemplate,writer,readOnlyVerifier,spawn=spawnSync,persistencePreflight,
  revealRecoveryPhase='single',revealRecoveryReservation=null,searchAttemptLimit=3,revealObservationWindowMs=5000}={}) {
  if(originalBackgroundRunActive)throw new Error('ORIGINAL_BACKGROUND_ALREADY_RUNNING');
  originalBackgroundRunActive=true;
  try{
    if((typeof writer!=='function')===(typeof readOnlyVerifier!=='function')){
      throw new Error('KOC_CONTACT_SINK_CONFIGURATION_INVALID');
    }
    if(!String(recordId||'').trim())throw new Error('KOC_CONTACT_RECORD_ID_REQUIRED');
    validatePersistencePreflight(persistencePreflight,session);
    const config=validateConfig({session,creatorId,creatorName,accountMarker,detailTemplate,
      revealRecoveryPhase,revealRecoveryReservation,searchAttemptLimit,revealObservationWindowMs});
    const code=buildOriginalBackgroundCode(config);
    let child;
    try{
      child=spawn('npx',playwrightCliArgs(`-s=${config.session}`,'run-code',code),{
        cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',maxBuffer:4*1024*1024,
        timeout:90000,stdio:['ignore','pipe','pipe'],env:playwrightCliEnv()});
    }catch(error){child={status:null,error:{code:error?.code}};}
    const parsed=parseControlledCliResult(child);
    const cliExecution=safeCliExecution(child,parsed);
    if(cliExecution.failureClass!=='NONE')return failedCliOutcome(parsed,cliExecution);
    const execution=parsed.result;
    const completed=validCompletedRemoteResult(execution);
    const receipt=safeReceipt(execution?.receipt,completed);
    if(!completed){
      if(execution?.attempt){execution.attempt.contactValue='';execution.attempt.contactSourceUrl='';}
      return {receipt,execution:cliExecution,writeback:{updated:false,status:'not_written',fieldNames:[]}};
    }
    const attempt=execution.attempt;
    let writeback;
    let readbackFacts=null;
    if(typeof readOnlyVerifier==='function'){
      try{
        await patchCurrentContactAttempt({creatorId,recordId,attempt,writer:async input=>{
          readbackFacts=await readOnlyVerifier(input);
          return {updated:true,status:'found',fieldNames:Object.keys(input.fields||[])};
        }});
      }catch{
        readbackFacts={...(readbackFacts||{}),comparisonCompleted:false};
      }finally{
        if(execution?.attempt){execution.attempt.contactValue='';execution.attempt.contactSourceUrl='';}
      }
      const allowedFacts=['recordMappingVerified','sameCreatorIdReadback','wechatValueMatched',
        'currentAttemptMatchesOriginalRun','sourceIsBuyinProfile','storedSourceUidMatchesFreshPage',
        'nonContactFieldsUnchanged','humanFieldsUnchanged','readOnlyComparisonInvoked',
        'externalWritePerformed','comparisonCompleted'];
      const safeFacts=Object.fromEntries(allowedFacts.map(key=>[key,readbackFacts?.[key]===true]));
      return {receipt,execution:cliExecution,
        writeback:{updated:false,status:'readback_only',fieldNames:READ_ONLY_CONTACT_FIELD_NAMES.slice()},
        readback:safeFacts};
    }
    try{
      writeback=await patchCurrentContactAttempt({creatorId,recordId,attempt,writer});
    }catch{
      return {receipt:{...receipt,status:'stopped',reason:'CONTACT_PATCH_FAILED'},
        execution:cliExecution,writeback:{updated:false,status:'write_failed',fieldNames:[]}};
    }finally{
      if(execution?.attempt){execution.attempt.contactValue='';execution.attempt.contactSourceUrl='';}
    }
    const summary=safeWriterSummary(writeback);
    if(!summary.updated)return {receipt:{...receipt,status:'stopped',reason:'CONTACT_PATCH_READBACK_FAILED'},
      execution:cliExecution,writeback:{...summary,status:'readback_unconfirmed'}};
    return {receipt,execution:cliExecution,writeback:summary};
  }finally{
    originalBackgroundRunActive=false;
  }
}

const MEMORY_ACCEPTANCE_RECORD_ID='memory-only-acceptance';
const MEMORY_ACCEPTANCE_FIELDS=[
  '本次联系方式状态','联系方式最近尝试','联系方式最近成功','联系方式最近错误','联系方式来源','微信号',
].sort();

// A one-ID validation entrypoint with no injectable business writer. Its only
// sink computes safe facts in memory and discards the contact value on return.
export async function runOriginalBackgroundMemoryAcceptance({session=ORIGINAL_BACKGROUND_SESSION,
  creatorId=CONTACT_PATCH_TARGET_CREATOR_ID,accountMarker=ACCOUNT_MARKER,
  detailTemplate,persistencePreflight,spawn=spawnSync,searchAttemptLimit=3,revealObservationWindowMs=5000}={}) {
  let evidence={sinkInvoked:false,creatorIdMatched:false,memoryRecordSentinel:false,
    fieldsAllowlisted:false,contactStatusFound:false,contactValuePresent:false,
    contactValueNonMasked:false,sourceHostVerified:false};
  const memoryOnlySink=async({creatorId:receivedCreatorId,recordId,fields})=>{
    const keys=Object.keys(fields||{}).sort();
    const value=fields?.['微信号'];
    let sourceHostVerified=false;
    try{sourceHostVerified=new URL(fields?.['联系方式来源']).origin===ORIGIN;}catch{}
    evidence={sinkInvoked:true,creatorIdMatched:receivedCreatorId===String(creatorId||'').trim(),
      memoryRecordSentinel:recordId===MEMORY_ACCEPTANCE_RECORD_ID,
      fieldsAllowlisted:keys.length===MEMORY_ACCEPTANCE_FIELDS.length&&
        keys.every((field,index)=>field===MEMORY_ACCEPTANCE_FIELDS[index]),
      contactStatusFound:fields?.['本次联系方式状态']==='found',
      contactValuePresent:typeof value==='string'&&value.trim().length>0,
      contactValueNonMasked:typeof value==='string'&&/[a-z0-9]/iu.test(value)&&!isMaskedContactValue(value),
      sourceHostVerified};
    const accepted=Object.values(evidence).every(Boolean);
    return {updated:false,status:accepted?'found':'unknown',fieldNames:keys};
  };
  const result=await runOriginalBackgroundContact({session,creatorId,recordId:MEMORY_ACCEPTANCE_RECORD_ID,
    accountMarker,detailTemplate,persistencePreflight,spawn,writer:memoryOnlySink,searchAttemptLimit,revealObservationWindowMs});
  const extractionVerified=result.receipt.status==='stopped'&&
    result.receipt.reason==='CONTACT_PATCH_READBACK_FAILED'&&Object.values(evidence).every(Boolean);
  const receipt=extractionVerified
    ?{...result.receipt,status:'completed',reason:'CONTACT_VALUE_VERIFIED'}:result.receipt;
  return {status:extractionVerified?'extraction_verified':'stopped',receipt,execution:result.execution,
    acceptance:{sink:'volatile_memory_only',...evidence,
      externalWriteStatus:'not_attempted',externalWritePerformed:false,realFeishuReadback:false,
      runnerDoesNotEnableTracing:true,customResultLoggingDisabled:true,
      externalTraceStatus:'unknown'}};
}
