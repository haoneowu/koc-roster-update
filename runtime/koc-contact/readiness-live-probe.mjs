import {BUYIN_ACCOUNT_MARKER,DATA_DIR,PLAYWRIGHT_SESSION} from '../shared/config.mjs';
/** Read-only business readiness probe. No contacts, credentials or target IDs in output. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from '../shared/child-process.mjs';
import {promisify} from 'node:util';
import {AsyncReadLarkBaseClient} from '../koc-roster/async-read-client.mjs';
import {FEISHU_ROUTE} from '../koc-roster/lark-writer.mjs';
const exec=promisify(execFile),root=DATA_DIR;
const out=process.env.KOC_READINESS_STATUS_PATH||path.join(root,'readiness-live.json');
const s={schemaVersion:1,checkedAt:new Date().toISOString(),validForSeconds:90,sites:{chann:{state:'unknown'},buyin:{state:'unknown'}},component:'unknown',base:{read:'unknown',write:'unknown'}};
// A lost control connection must not erase a known logout. Live page evidence replaces it.
try{const previous=JSON.parse(await fs.readFile(out,'utf8'));for(const k of ['chann','buyin'])if(previous.sites?.[k]?.state==='logged_out')s.sites[k]={...previous.sites[k]};}catch{}
await Promise.allSettled([
(async()=>{
 const code=`async page => await Promise.all(page.context().pages().map(async p=>{const u=p.url();if(!u.includes('chanmama.com')&&!u.includes('buyin.jinritemai.com'))return null;return await p.evaluate(()=>{const t=document.body?.innerText||'';return {site:location.host.includes('chanmama')?'chann':'buyin',loginRequired:/扫码登录|请先登录|立即登录/.test(t),hidden:document.hidden,loggedIn:location.host.includes('chanmama')?(/退出登录|个人中心|会员中心|我的收藏/.test(t)||(!/扫码登录|请先登录|立即登录/.test(t)&&Array.from(document.querySelectorAll("button")).some(b=>b.innerText.includes("导出数据")&&!b.disabled))):(${JSON.stringify(BUYIN_ACCOUNT_MARKER)}!==''&&t.includes(${JSON.stringify(BUYIN_ACCOUNT_MARKER)}))};}).catch(()=>null)}))`;
 let stdout;try{({stdout}=await exec('npx',['--no-install','@playwright/cli@0.1.21',`-s=${PLAYWRIGHT_SESSION}`,'run-code',code],{cwd:path.resolve(import.meta.dirname,'..'),timeout:20000,maxBuffer:2e6}));}catch(error){if(/browser .*not open|not connected|connection.*closed/i.test(String(error.stdout||'')+' '+String(error.stderr||'')+' '+error.message))s.connectionState='disconnected';return;}
 const m=stdout.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);if(!m)return;const rows=JSON.parse(m[1]);s.component='ready';s.backgroundPages=rows.filter(r=>r?.site==='buyin'&&r.loggedIn&&r.hidden).length;
 for(const k of ['chann','buyin']){const r=rows.filter(r=>r?.site===k);s.sites[k].state=r.some(r=>r.loggedIn)?'authorized':r.some(r=>r.loginRequired)?'logged_out':s.sites[k].state;}
})(),
(async()=>{const client=new AsyncReadLarkBaseClient({route:FEISHU_ROUTE});const r=await client.listRecordsPage({limit:1,fieldNames:['抖音号']});if(r.ok===false)throw Error('READ_FAILED');s.base.read='granted';})()
]);
try{
 const a=JSON.parse(await fs.readFile(path.join(root,'daily-inventory/active.json'),'utf8'));
 if(!/^run-[0-9T-Z-]+$/.test(a.id))throw Error('INVALID');
 const p=path.join(root,'daily-inventory',a.id,'ledger.json'),l=JSON.parse(await fs.readFile(p,'utf8')),st=await fs.stat(p),complete=l.entries.filter(e=>e.complete),active=l.entries.filter(e=>e.state==='in_flight');
 // A successful protected write/readback is evidence of write capability, never a preflight test write.
 if(complete.some(e=>e.writeState==='verified'&&e.readbackVerified))s.base.write='granted';
 let running=false;try{const lock=JSON.parse(await fs.readFile(path.join(root,'contact-canary-original-20260923/production.lock'),'utf8'));process.kill(lock.pid,0);running=true;}catch{}
 s.run={state:l.status==='complete'?'completed':running?(l.cooldown?'cooldown':'running'):'paused',actualLanes:running?active.length:0,targetLanes:10,completed:complete.length,total:l.entries.length,observedAt:st.mtime.toISOString()};
 if(s.run.state==='completed')s.run.readbackVerified=JSON.parse(await fs.readFile(path.join(root,'daily-inventory',a.id,'independent-readback.json'),'utf8')).allVerified===true;
 if(l.cooldown)s.run.nextProbeAt=l.cooldown.nextEligibleAt;
 if(l.lastStop?.reason==='PARALLEL_CURRENT_INDEX_UNVERIFIED'&&s.base.read!=='granted')s.run.reasonCode='BASE_READ_UNAVAILABLE';else if(!running&&s.backgroundPages<Math.min(10,l.entries.length-complete.length))s.run.reasonCode='BROWSER_CAPACITY_UNAVAILABLE';
}catch{}
delete s.backgroundPages;
await fs.mkdir(path.dirname(out),{recursive:true,mode:0o700});await fs.writeFile(out+'.tmp',JSON.stringify(s),{mode:0o600});await fs.rename(out+'.tmp',out);
