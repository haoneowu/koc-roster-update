import {DATA_DIR,feishuBaseUrl} from '../shared/config.mjs';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from '../shared/child-process.mjs';
import {fileURLToPath} from 'node:url';

const resultKeys=['success','not_shown','no_match','forbidden_by_platform','technicalFailure','unknownWrite','pending'];
export function summarizeResults(entries){
 const counts=Object.fromEntries(resultKeys.map(k=>[k,0]));
 for(const e of entries){
  if(e.complete===true&&e.writeState==='verified'&&e.readbackVerified===true&&resultKeys.slice(0,4).includes(e.outcome))counts[e.outcome]++;
  else if(e.state==='uncertain'||e.writeState==='uncertain')counts.unknownWrite++;
  else if(e.state==='failed'||['error','blocked'].includes(e.outcome))counts.technicalFailure++;
  else counts.pending++;
 }return counts;
}
export async function readSourceUpdate(root){
 const names=(await fs.readdir(root)).filter(n=>/^\d{8}T\d{6}Z\.checkpoint\.json$/.test(n)).sort();
 if(!names.length)return {state:'unknown'};
 const name=names.at(-1),batch=name.split('.')[0],base=await fs.realpath(root);
 const read=async n=>{const f=path.join(root,n);if(path.dirname(await fs.realpath(f))!==base)throw Error('source escapes root');return JSON.parse(await fs.readFile(f,'utf8'))};
 const checkpoint=await read(name);let receipt;try{receipt=await read(batch+'.write-receipt.json')}catch{return {state:'unknown',observedAt:checkpoint.finishedAt||checkpoint.startedAt}};
 if(receipt.batchId!==batch||receipt.mode!=='daily-add-only')throw Error('invalid source receipt');
 const total=receipt.plannedCount,completed=receipt.readbackVerifiedCount;
 if(![total,completed].every(n=>Number.isInteger(n)&&n>=0)||completed>total)throw Error('invalid source counts');
 const done=receipt.status==='complete'&&completed===total&&receipt.unknownWriteCount===0;
 const selected=receipt.sourceEvidence?.sourceRankedRows;
 const added=Math.min(completed,(receipt.createdCount||0)+(receipt.recoveredWriteCount||0));
 return {state:done?'completed':'unknown',completed,total,added,...(Number.isInteger(selected)&&selected>=0?{selected}:{}),observedAt:receipt.finishedAt||receipt.startedAt};
}

export async function readLiveRun(root){
 const base=path.join(root,'daily-inventory');
 const pointer=JSON.parse(await fs.readFile(path.join(base,'active.json'),'utf8'));
 if(!/^run-[0-9TZ-]+$/.test(pointer.id))throw Error('invalid active run');
 const dir=path.join(base,pointer.id),realBase=await fs.realpath(base),realDir=await fs.realpath(dir);
 if(path.dirname(realDir)!==realBase)throw Error('run escapes root');
 const ledgerPath=path.join(realDir,'ledger.json');if(path.dirname(await fs.realpath(ledgerPath))!==realDir)throw Error('ledger escapes run');
 const ledger=JSON.parse(await fs.readFile(ledgerPath,'utf8')),stat=await fs.stat(ledgerPath);
 if(!Array.isArray(ledger.entries))throw Error('invalid ledger');
 const completed=ledger.entries.filter(e=>e.complete===true&&e.writeState==='verified'&&e.readbackVerified===true).length;
 const inFlight=ledger.entries.filter(e=>e.state==='in_flight').length;
 let running=false;try{const lock=JSON.parse(await fs.readFile(path.join(root,'contact-canary-original-20260923/production.lock'),'utf8'));if(lock.mode==='daily-inventory'&&Number.isSafeInteger(lock.pid)&&lock.pid>0){process.kill(lock.pid,0);running=true}}catch{}
 const run={results:summarizeResults(ledger.entries),state:running?(ledger.cooldown?'cooldown':'running'):'paused',actualLanes:running?Math.min(inFlight,10):0,targetLanes:10,completed,total:ledger.entries.length,inFlight,observedAt:stat.mtime.toISOString()};
 if(ledger.status==='complete'&&completed===run.total){const receipt=JSON.parse(await fs.readFile(path.join(realDir,'independent-readback.json'),'utf8'));if(receipt.allVerified===true){run.state='completed';run.readbackVerified=true;run.actualLanes=0}}
 if(ledger.cooldown&&Number.isFinite(ledger.cooldown.nextEligibleAt))run.nextProbeAt=ledger.cooldown.nextEligibleAt;
 if(!running&&ledger.lastStop?.reason==='PARALLEL_CURRENT_INDEX_UNVERIFIED')run.reasonCode='BASE_READ_UNAVAILABLE';
 return run;
}

export function publicStatus(s){
 const validDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
 if(!s||!validDate(s.checkedAt)||!Number.isInteger(s.validForSeconds)||s.validForSeconds<1||s.validForSeconds>3600||!['unknown','missing','ready'].includes(s.component)||!['unknown','missing','granted'].includes(s.base?.read)||!['unknown','missing','granted'].includes(s.base?.write)||!['chann','buyin'].every(k=>['unknown','logged_out','logged_in','authorized'].includes(s.sites?.[k]?.state)))throw Error('invalid status');
 const out={schemaVersion:1,checkedAt:s.checkedAt,validForSeconds:s.validForSeconds,sites:{chann:{state:s.sites?.chann?.state},buyin:{state:s.sites?.buyin?.state}},component:s.component,base:{read:s.base?.read,write:s.base?.write}};
 if(s.connectionState==='disconnected')out.connectionState='disconnected';
 if(s.sourceUpdate){const a=s.sourceUpdate;const fields=['completed','total','added','selected'];if(!['completed','running','unknown'].includes(a.state)||fields.some(k=>a[k]!==undefined&&(!Number.isInteger(a[k])||a[k]<0))||a.completed>a.total||a.state==='completed'&&(a.completed!==a.total||a.total===undefined)||a.observedAt!==undefined&&!validDate(a.observedAt))throw Error('invalid source update');out.sourceUpdate=Object.fromEntries(['state',...fields,'observedAt'].filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));}
 if(s.run){const r=s.run;if(r.inFlight!==undefined&&(!Number.isInteger(r.inFlight)||r.inFlight<0))throw Error('invalid in-flight count');if(!['running','cooldown','paused','completed'].includes(r.state)||![r.actualLanes,r.targetLanes,r.completed,r.total].every(Number.isInteger)||r.targetLanes!==10||r.actualLanes<0||r.actualLanes>10||r.completed<0||r.total<r.completed||r.observedAt!==undefined&&!validDate(r.observedAt)||r.nextProbeAt!==undefined&&!(typeof r.nextProbeAt==='number'&&Number.isFinite(r.nextProbeAt)||validDate(r.nextProbeAt))||r.readbackVerified!==undefined&&typeof r.readbackVerified!=='boolean')throw Error('invalid run');out.run=Object.fromEntries(['state','actualLanes','targetLanes','completed','total','nextProbeAt','readbackVerified','observedAt','inFlight'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));if(r.results){if(resultKeys.some(k=>!Number.isInteger(r.results[k])||r.results[k]<0)||resultKeys.reduce((n,k)=>n+r.results[k],0)!==r.total)throw Error('invalid result counts');out.run.results=Object.fromEntries(resultKeys.map(k=>[k,r.results[k]]));}if(r.reasonCode)out.run.reason={BROWSER_CAPACITY_UNAVAILABLE:'十路后台页面尚未全部就绪，助手正在恢复',BASE_READ_UNAVAILABLE:'飞书名单读取暂未完成',AUTH_REQUIRED:'请完成对应网站登录',RATE_LIMITED:'平台暂时限制查询'}[r.reasonCode]||'助手正在核查待处理事项';}
 return out;
}
export function createReadinessServer({statusPath,htmlPath,probePath=path.join(import.meta.dirname,'readiness-live-probe.mjs'),port=18765,refresh,inventoryRoot=path.dirname(statusPath)}={}){
 let inflight;const origin=`http://127.0.0.1:${port}`;
 const run=()=>{if(!inflight)inflight=Promise.resolve().then(()=>refresh?refresh():new Promise((resolve,reject)=>{const c=spawn(process.execPath,[probePath],{stdio:'ignore',env:{...process.env,KOC_READINESS_STATUS_PATH:statusPath}});const timer=setTimeout(()=>{c.kill('SIGTERM');reject(Error('probe timeout'));},60000);c.on('error',e=>{clearTimeout(timer);reject(e)});c.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('probe failed'))})})).finally(()=>{inflight=null});return inflight};
 const server=http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");const send=(n,x,type='application/json')=>{res.writeHead(n,{'Content-Type':type});res.end(type==='application/json'?JSON.stringify(x):x)};
 if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'local access only'});
 try{if(req.method==='GET'&&req.url==='/'){return send(200,await fs.readFile(htmlPath,'utf8'),'text/html; charset=utf-8')}
 if(req.method==='GET'&&req.url==='/status'){const snapshot=JSON.parse(await fs.readFile(statusPath,'utf8'));try{snapshot.run=await readLiveRun(inventoryRoot)}catch{}try{snapshot.sourceUpdate=await readSourceUpdate(inventoryRoot)}catch{snapshot.sourceUpdate={state:'unknown'}}return send(200,{...publicStatus(snapshot),baseUrl:feishuBaseUrl()});}
 if(req.method==='POST'&&req.url==='/refresh'){if(req.headers.origin!==origin||req.headers['x-koc-refresh']!=='1')return send(403,{error:'same-origin refresh required'});await run();return send(200,{ok:true})}
 return send(404,{error:'not found'});
 }catch{return send(503,{error:'检查暂未完成，请重试'})}});
 let interval;server.on('listening',()=>{run().catch(()=>{});interval=setInterval(()=>run().catch(()=>{}),30000);interval.unref()});server.on('close',()=>clearInterval(interval));return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const statusPath=process.env.KOC_READINESS_STATUS_PATH||path.join(DATA_DIR,'readiness-live.json');
 const htmlPath=process.env.KOC_READINESS_HTML_PATH||fileURLToPath(new URL('../../assets/readiness.html',import.meta.url));
 createReadinessServer({statusPath,htmlPath}).listen(18765,'127.0.0.1',()=>console.log('KOC readiness: http://127.0.0.1:18765'));
}
