/** Save only an explicitly selected authorized ChanMama page session locally. */
import path from 'node:path';
import {spawnSync} from './shared/child-process.mjs';
import {DATA_DIR,PLAYWRIGHT_SESSION} from './shared/config.mjs';
import {writePrivateJson} from './koc-roster/checkpoint.mjs';
const code=`async page=>{const origin='https://www.chanmama.com';const pages=page.context().pages().filter(p=>new URL(p.url()).origin===origin);if(pages.length!==1)throw Error('SOURCE_PAGE_MISSING_OR_AMBIGUOUS');const p=pages[0];if(await p.locator('input[type=password]:visible').count())throw Error('LOGIN_REQUIRED');return {origin,cookies:await p.context().cookies(origin),storage:await p.evaluate(()=>({local:Object.fromEntries(Object.entries(localStorage)),session:Object.fromEntries(Object.entries(sessionStorage))}))};}`;
try{
 const r=spawnSync('npx',['--no-install','@playwright/cli@0.1.21',`-s=${PLAYWRIGHT_SESSION}`,'run-code',code],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:30000});
 if(r.status!==0)throw Error('SOURCE_SESSION_CAPTURE_FAILED');
 const match=String(r.stdout).match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/);
 if(!match)throw Error('SOURCE_SESSION_CAPTURE_INVALID');
 const data=JSON.parse(match[1]);if(data.origin!=='https://www.chanmama.com'||!Array.isArray(data.cookies)||!data.storage?.local)throw Error('SOURCE_SESSION_CAPTURE_INVALID');
 await writePrivateJson(path.join(DATA_DIR,'auth','www.chanmama.com.json'),data);
 console.log(JSON.stringify({saved:true,origin:data.origin}));
}catch{console.log(JSON.stringify({saved:false,reason:'SOURCE_SESSION_CAPTURE_FAILED'}));process.exitCode=1;}
