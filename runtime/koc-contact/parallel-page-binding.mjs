import {createHash} from 'node:crypto';

const ALLOWED_ROUTES = new Set(['BUSINESS_LIST', 'PROFILE']);
const STATE_FIELDS = Object.freeze([
  'route', 'hidden', 'accountMarkerVisible', 'authSignal', 'challengeSignal',
  'documentToken', 'navigationToken', 'pageContextMatches',
]);

const fail = code => { throw new Error(`PARALLEL_${code}`); };

function safePageState(value = {}) {
  return Object.fromEntries(STATE_FIELDS.map(key => {
    const current=value[key]??null;
    if (['documentToken','navigationToken'].includes(key) && current!==null) {
      const fingerprint=createHash('sha256').update(String(current)).digest('hex');
      return [key,`sha256:${fingerprint}`];
    }
    return [key,current];
  }));
}

export async function bindWorkerPages({context, pages = context?.pages?.(), lanes, inspectPage, laneLimit=5} = {}) {
  if (![5,10].includes(laneLimit) || !context || typeof context.pages !== 'function' || !Array.isArray(pages) ||
      !Array.isArray(lanes) || !lanes.length || typeof inspectPage !== 'function') fail('PAGE_BINDINGS_INVALID');
  const workers = new Set();
  const laneIndexes = new Set();
  const pageIndexes = new Set();
  const pageRefs = new Set();
  const bindings = [];
  for (const lane of lanes) {
    if (!lane || typeof lane.workerId !== 'string' || !lane.workerId ||
        !Number.isInteger(lane.laneIndex) || lane.laneIndex < 0 || lane.laneIndex >= laneLimit ||
        !Number.isInteger(lane.pageIndex) || lane.pageIndex < 0 || lane.pageIndex >= pages.length ||
        workers.has(lane.workerId) || laneIndexes.has(lane.laneIndex) || pageIndexes.has(lane.pageIndex)) {
      fail('PAGE_BINDING_DUPLICATE_OR_INVALID');
    }
    const page = pages[lane.pageIndex];
    if (!page || (typeof page !== 'object' && typeof page !== 'function') || pageRefs.has(page)) fail('PAGE_BINDING_DUPLICATE_OR_INVALID');
    let pageContext;
    try { pageContext = page.context(); } catch { fail('PAGE_CONTEXT_UNAVAILABLE'); }
    if (pageContext !== context) fail('PAGE_CONTEXT_MISMATCH');
    let state;
    try { state = await inspectPage(page); } catch { fail('PAGE_STATE_UNAVAILABLE'); }
    if (state?.hidden !== true) fail('PAGE_NOT_HIDDEN');
    if (!ALLOWED_ROUTES.has(state?.route) || state?.accountMarkerVisible !== true) fail('PAGE_ACCOUNT_OR_ROUTE_UNVERIFIED');
    if (state?.authSignal !== false || state?.challengeSignal !== false || state?.pageContextMatches !== true) {
      fail('PAGE_AUTH_RISK_OR_CONTEXT_UNVERIFIED');
    }
    workers.add(lane.workerId);
    laneIndexes.add(lane.laneIndex);
    pageIndexes.add(lane.pageIndex);
    pageRefs.add(page);
    bindings.push({workerId:lane.workerId,laneIndex:lane.laneIndex,pageIndex:lane.pageIndex,page,
      initialState:safePageState(state)});
  }
  return bindings;
}

// The scoped proxy prevents one worker's internal peer-page guard from treating
// another explicitly owned worker Page as an unrelated page. A wave-level guard
// must still check all actual context pages after Promise.all completes.
export function createPageScopedProxy(page) {
  if (!page || typeof page.context !== 'function') fail('PAGE_CONTEXT_UNAVAILABLE');
  let actualContext;
  try { actualContext = page.context(); } catch { fail('PAGE_CONTEXT_UNAVAILABLE'); }
  if (!actualContext || typeof actualContext.pages !== 'function') fail('PAGE_CONTEXT_UNAVAILABLE');
  let scopedPage;
  const scopedContext = new Proxy(actualContext, {
    get(target, property) {
      if (property === 'pages') return () => [scopedPage];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const locatorProxies=new WeakMap();
  const wrapLocator=locator=>{
    if (!locator || (typeof locator!=='object' && typeof locator!=='function')) return locator;
    const cached=locatorProxies.get(locator);
    if (cached) return cached;
    let pageMethod;
    try { pageMethod=Reflect.get(locator,'page',locator); } catch { fail('LOCATOR_PAGE_UNAVAILABLE'); }
    if (typeof pageMethod!=='function') return locator;
    let owner;
    try { owner=Reflect.apply(pageMethod,locator,[]); } catch { fail('LOCATOR_PAGE_UNAVAILABLE'); }
    if (owner!==page && owner!==scopedPage) fail('LOCATOR_PAGE_MISMATCH');
    const proxy=new Proxy(locator,{
      get(target,property){
        if (property==='page') return ()=>{
          let actual;
          try { actual=Reflect.apply(Reflect.get(target,'page',target),target,[]); }
          catch { fail('LOCATOR_PAGE_UNAVAILABLE'); }
          if (actual!==page && actual!==scopedPage) fail('LOCATOR_PAGE_MISMATCH');
          return scopedPage;
        };
        const value=Reflect.get(target,property,target);
        if (typeof value!=='function') return value;
        return (...args)=>wrapLocator(Reflect.apply(value,target,args));
      },
    });
    locatorProxies.set(locator,proxy);
    return proxy;
  };
  scopedPage = new Proxy(page, {
    get(target, property) {
      if (property === 'context') return () => scopedContext;
      const value = Reflect.get(target, property, target);
      if (typeof value!=='function') return value;
      return (...args)=>wrapLocator(Reflect.apply(value,target,args));
    },
  });
  return {page:scopedPage,context:scopedContext};
}

export async function capturePageSetSnapshot({context, inspectPage} = {}) {
  if (!context || typeof context.pages !== 'function' || typeof inspectPage !== 'function') fail('PAGE_SNAPSHOT_ARGUMENTS_INVALID');
  let pages;
  try { pages = context.pages(); } catch { fail('PAGE_SNAPSHOT_UNAVAILABLE'); }
  if (!Array.isArray(pages) || pages.some(page => !page)) fail('PAGE_SNAPSHOT_UNAVAILABLE');
  const states = [];
  for (const page of pages) {
    try { states.push(safePageState(await inspectPage(page))); }
    catch { fail('PAGE_SNAPSHOT_UNAVAILABLE'); }
  }
  return {context,pages:pages.slice(),states};
}

export async function verifyPageWaveSnapshot({before,context,bindings,inspectPage} = {}) {
  if (!before?.context || !Array.isArray(before.pages) || !Array.isArray(before.states) ||
      !context || !Array.isArray(bindings) || typeof inspectPage !== 'function') fail('PAGE_GUARD_ARGUMENTS_INVALID');
  if (context !== before.context) return {ok:false,reason:'PAGE_CONTEXT_CHANGED',workerCount:bindings.length};
  let afterPages;
  try { afterPages = context.pages(); } catch { return {ok:false,reason:'PAGE_SET_UNAVAILABLE',workerCount:bindings.length}; }
  if (!Array.isArray(afterPages) || afterPages.length !== before.pages.length ||
      afterPages.some((page,index) => page !== before.pages[index])) {
    return {ok:false,reason:'PAGE_SET_CHANGED',workerCount:bindings.length};
  }
  const ownedPages = new Set(bindings.map(binding => binding.page));
  let bindingChanged = ownedPages.size !== bindings.length;
  for (const binding of bindings) {
    try { if (binding.page.context() !== context) bindingChanged = true; }
    catch { bindingChanged = true; }
  }
  if (bindingChanged) {
    return {ok:false,reason:'PAGE_BINDING_CHANGED',workerCount:bindings.length};
  }
  for (let index=0; index<afterPages.length; index+=1) {
    let current;
    try { current = safePageState(await inspectPage(afterPages[index])); }
    catch { return {ok:false,reason:'PAGE_STATE_UNAVAILABLE',workerCount:bindings.length}; }
    const previous = before.states[index];
    if (ownedPages.has(afterPages[index])) {
      if (current.hidden !== true) return {ok:false,reason:'WORKER_PAGE_VISIBLE',workerCount:bindings.length};
      if (!ALLOWED_ROUTES.has(current.route) || current.accountMarkerVisible !== true) {
        return {ok:false,reason:'WORKER_PAGE_ROUTE_OR_ACCOUNT_CHANGED',workerCount:bindings.length};
      }
      if (current.authSignal !== false || current.challengeSignal !== false || current.pageContextMatches !== true) {
        return {ok:false,reason:'WORKER_PAGE_AUTH_RISK_OR_CONTEXT_CHANGED',workerCount:bindings.length};
      }
      continue;
    }
    for (const key of STATE_FIELDS) {
      if (!Object.is(current[key],previous[key])) return {ok:false,reason:'UNOWNED_PAGE_CHANGED',workerCount:bindings.length};
    }
  }
  return {ok:true,reason:'',workerCount:bindings.length,pageCount:afterPages.length};
}

export function assertWorkerIdentity({target,result} = {}) {
  const proof = result?.identityProof;
  const outcomes=new Set(['success','not_shown','no_match','forbidden_by_platform','error','auth_blocked','risk_blocked']);
  if (!target || typeof target.creatorId !== 'string' || typeof target.recordId !== 'string' ||
      !result || result.creatorId !== target.creatorId || result.recordId !== target.recordId ||
      result.attemptId !== target.attemptId || !outcomes.has(result.outcome) ||
      (result.sourceBatchId!==undefined && result.sourceBatchId!=='20260923T152555Z') ||
      (result.sourceRank!==undefined && result.sourceRank!==target.sourceRank)) fail('WORKER_ATTEMPT_BINDING_UNVERIFIED');

  // Positive contact capture needs the full exact-ID → UID → detail-record chain.
  if (result.outcome==='success') {
    const creatorMatches=proof?.creatorIdMatchesTarget===true && proof?.awemeIdMatchesTarget===true;
    const detailBound=proof?.profileRouteUidMatchesExactResultUid===true;
    if ((proof?.type!=='API_FEED_ID_MATCH' && result.resultStructure!=='API_FEED_ID_MATCH') ||
        !creatorMatches || proof.exactIdMatchCount!==1 ||
        proof.uidFromExactResult!==true || !detailBound || result.recordMappingVerified!==true) {
      fail('WORKER_IDENTITY_CHAIN_UNVERIFIED');
    }
  }

  // A no-match is a verified negative query, never an exact positive match. A
  // not-shown result must still point to the exact target ID and its feed UID.
  if (result.outcome==='not_shown' || result.outcome==='no_match' || result.outcome==='forbidden_by_platform') {
    const count=result.outcome==='no_match'?0:1;
    const queryProof=proof && proof.creatorIdMatchesTarget===true &&
      proof.awemeIdMatchesTarget===(count===1) && ['API_FEED_QUERY_VERIFIED','API_FEED_ID_MATCH'].includes(proof.type) &&
      proof.querySubmittedAfterActivation===true && proof.requestResponseBound===true &&
      proof.httpStatusCategory==='2xx' && proof.businessCodeCategory==='zero' &&
      proof.authEvidenceAbsent===true && proof.exactIdMatchCount===count &&
      (result.outcome==='no_match' ? proof.uidFromExactResult===false : proof.uidFromExactResult===true);
    if (!queryProof || result.recordMappingVerified!==true) fail('WORKER_NEGATIVE_QUERY_UNVERIFIED');
  }
  return true;
}
