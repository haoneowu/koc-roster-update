import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from './shared/child-process.mjs';
import {BUYIN_ACCOUNT_MARKER,PLAYWRIGHT_SESSION} from './shared/config.mjs';
import {buildReadOnlyPageSnapshotCode,selectParallelPages} from './koc-contact/run-canary-parallel-production.mjs';
import {playwrightCliArgs} from './koc-contact/playwright-cli-contract.mjs';

// Create only our own missing background targets. Never navigate an existing tab,
// fake visibility, focus a tab, or click any contact control.
export async function bootstrapBackground(page,{inspect,select,accountMarker,count=10,wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=30}={}){
 if(!accountMarker||count!==10)throw Error('KOC_BACKGROUND_CONFIGURATION_REQUIRED');
 const initial=await inspect(page),existing=select(initial);
 if(existing.length>=count)return {passed:true,created:0,ready:existing.length};
 if(!initial.pages?.some(p=>['BUSINESS_LIST','PROFILE'].includes(p.route)&&p.accountMarkerVisible===true&&p.authSignal===false&&p.challengeSignal===false))throw Error('KOC_BUYIN_LOGIN_REQUIRED');
 let cdp;try{cdp=await page.context().browser().newBrowserCDPSession();}catch{throw Error('KOC_BACKGROUND_CDP_UNAVAILABLE');}
 const targets=[];
 try{
  for(let i=existing.length;i<count;i++){
   const result=await cdp.send('Target.createTarget',{url:'https://buyin.jinritemai.com/dashboard/servicehall/daren-square',background:true});
   if(typeof result?.targetId!=='string')throw Error('KOC_BACKGROUND_TARGET_CREATE_FAILED');targets.push(result.targetId);
  }
  for(let attempt=0;attempt<attempts;attempt++){
   const ready=select(await inspect(page));
   if(ready.length>=count)return {passed:true,created:targets.length,ready:ready.length};
   if(attempt<attempts-1)await wait(1000);
  }
  throw Error('KOC_BACKGROUND_PAGES_NOT_VERIFIED');
 }catch(error){for(const targetId of targets)try{await cdp.send('Target.closeTarget',{targetId});}catch{}throw error;}
 finally{try{await cdp.detach();}catch{}}
}
export function buildBootstrapCode(){
 return `async page=>{const inspect=${buildReadOnlyPageSnapshotCode()};const select=${selectParallelPages.toString()};return (${bootstrapBackground.toString()})(page,{inspect,select,accountMarker:${JSON.stringify(BUYIN_ACCOUNT_MARKER)}});}`;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  if(process.argv.length>2||!BUYIN_ACCOUNT_MARKER)throw Error('KOC_BACKGROUND_CONFIGURATION_REQUIRED');
  const result=spawnSync('npx',playwrightCliArgs(`-s=${PLAYWRIGHT_SESSION}`,'run-code',buildBootstrapCode()),{encoding:'utf8',maxBuffer:2*1024*1024,timeout:60000});
  const match=String(result.stdout||'').match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
  if(result.status!==0||!match)throw Error('KOC_BACKGROUND_BOOTSTRAP_FAILED');
  const data=JSON.parse(match[1]);if(data.passed!==true||data.ready<10)throw Error('KOC_BACKGROUND_PAGES_NOT_VERIFIED');
  console.log(JSON.stringify({passed:true,created:data.created,ready:data.ready}));
 }catch(error){console.log(JSON.stringify({passed:false,reason:/^KOC_[A-Z_]+$/.test(error.message)?error.message:'KOC_BACKGROUND_BOOTSTRAP_FAILED',nextAction:'Check Chrome extension connection and Buyin login; if browser CDP is unavailable, open ten Buyin business tabs manually and leave them in the background.'}));process.exitCode=1;}
}
