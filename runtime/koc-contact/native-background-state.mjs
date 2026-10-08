/** Native background evidence is a second observation channel, never a fake visibility getter. */
export async function readBackgroundState(page, observedDocument) {
  const before=observedDocument??await page.evaluate(()=>({visibility:document.visibilityState,timeOrigin:performance.timeOrigin}));
  const href=page.url();
  if(before.visibility==='hidden'||!href.startsWith('https://buyin.jinritemai.com/'))
    return {visibility:before.visibility,hidden:before.visibility==='hidden',documentTimeOrigin:before.timeOrigin,source:'document'};
  const binding=await page.evaluate(()=>{
    const key='__kocNativeBackgroundBindingV1';
    if(!Object.prototype.hasOwnProperty.call(window,key))Object.defineProperty(window,key,{value:crypto.randomUUID(),configurable:false,writable:false});
    return window[key];
  });
  try{
    const bindings=readBackgroundState.nativeBindings??=new WeakMap();
    const knownTabId=bindings.get(page);
    const hint=Number.isInteger(knownTabId)?`&tabId=${knownTabId}`:'';
    const response=await page.request.get(`http://127.0.0.1:38473/evidence?binding=${encodeURIComponent(binding)}${hint}`,{timeout:4000});
    if(response.status()!==200)throw Error('NATIVE_BACKGROUND_UNAVAILABLE');
    const proof=await response.json();
    const after=await page.evaluate(()=>({binding:window.__kocNativeBackgroundBindingV1,timeOrigin:performance.timeOrigin}));
    if(proof.binding!==binding||after.binding!==binding||after.timeOrigin!==before.timeOrigin||page.url()!==href||
      !Number.isInteger(proof.tabId)||!Number.isInteger(proof.windowId)||typeof proof.active!=='boolean'||
      !['normal','minimized','maximized','fullscreen'].includes(proof.windowState)||
      !Number.isFinite(proof.observedAt)||Date.now()-proof.observedAt<0||Date.now()-proof.observedAt>2500)
      throw Error('NATIVE_BACKGROUND_UNVERIFIED');
    const prior=bindings.get(page);
    if(prior&&prior!==proof.tabId)throw Error('NATIVE_BACKGROUND_BINDING_CHANGED');
    bindings.set(page,proof.tabId);
    const hidden=!proof.active||proof.windowState==='minimized';
    return {visibility:hidden?'hidden':'visible',hidden,documentTimeOrigin:before.timeOrigin,source:'chrome_native',nativeTabId:proof.tabId,nativeWindowId:proof.windowId};
  }catch{
    return {visibility:before.visibility,hidden:false,documentTimeOrigin:before.timeOrigin,source:'native_unavailable'};
  }
}
export const backgroundStateRuntimeSource=()=>`const readBackgroundState=${readBackgroundState.toString()};`;
