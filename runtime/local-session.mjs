// v0.2.0 — initialize per-origin state once; preserve subsequent site refreshes.
const isRecord = value => value !== null && typeof value === 'object' &&
 [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Pass this result to browser.newContext({storageState: ...}). Unlike an init
// script, Playwright's initial state does not replay old localStorage on navigation.
export function createStorageState(saved, expectedOrigin) {
 let url;
 try { url = new URL(expectedOrigin); } catch { throw Error('SESSION_ORIGIN_INVALID'); }
 if (!['http:', 'https:'].includes(url.protocol) || url.origin !== expectedOrigin ||
     !isRecord(saved) || saved.origin !== expectedOrigin) throw Error('SESSION_ORIGIN_INVALID');
 if (!isRecord(saved.storage) || !isRecord(saved.storage.local) ||
     Object.values(saved.storage.local).some(value => typeof value !== 'string')) {
  throw Error('LOCAL_STORAGE_INVALID');
 }
 if (!Array.isArray(saved.cookies)) throw Error('SESSION_COOKIES_INVALID');
 const cookies = saved.cookies.map(cookie => {
  if (!isRecord(cookie) || typeof cookie.name !== 'string' || !cookie.name ||
      typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' ||
      typeof cookie.path !== 'string' || !cookie.path.startsWith('/') || 'url' in cookie) {
   throw Error('SESSION_COOKIE_INVALID');
  }
  const domain = cookie.domain.toLowerCase();
  const parent = domain.startsWith('.') ? domain.slice(1) : null;
  if (domain !== url.hostname && !(parent && (url.hostname === parent ||
      url.hostname.endsWith(`.${parent}`)))) throw Error('SESSION_COOKIE_SCOPE_INVALID');
  return {...cookie};
 });
 return {cookies, origins: [{origin: expectedOrigin,
  localStorage: Object.entries(saved.storage.local).map(([name, value]) => ({name, value}))}]};
}

export async function restoreSession(context,saved,expectedOrigin) {
 if(saved.origin!==expectedOrigin || !saved.storage || typeof saved.storage!=='object' || Array.isArray(saved.storage))throw Error('SESSION_ORIGIN_INVALID');
 if(Object.values(saved.storage).some(v=>typeof v!=='string'))throw Error('SESSION_VALUE_INVALID');
 await context.addInitScript(({origin,storage})=>{
  if(location.origin!==origin || sessionStorage.length) return;
  for(const [key,value]of Object.entries(storage))sessionStorage.setItem(key,value);
 },saved);
}
