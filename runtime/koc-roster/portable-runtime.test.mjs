import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {resolveCommand} from '../shared/child-process.mjs';
import {assertFeishuRoute,FEISHU_ROUTE} from '../shared/config.mjs';
import {LarkBaseClient} from './lark-writer.mjs';
import {AsyncReadLarkBaseClient} from './async-read-client.mjs';
import {buildReadOnlyPageSnapshotCode} from '../koc-contact/run-canary-parallel-production.mjs';
import {verifyKocRuntimeRelease} from '../koc-contact/runtime-release.mjs';
const route={profile:'test-profile',as:'user',host:'example.feishu.cn',baseToken:'test-base',tableId:'test-table'};
test('release pin validates every portable production dependency',async()=>{
 const result=await verifyKocRuntimeRelease();assert.equal(result.passed,true);
});
test('route requires an explicit user profile, host and resource before any reads or writes',async()=>{
 for(const key of ['profile','host','baseToken','tableId'])assert.throws(()=>assertFeishuRoute({...route,[key]:''}),/NOT_CONFIGURED/);
 assert.throws(()=>assertFeishuRoute({...route,as:'bot'}),/NOT_CONFIGURED/);
 let invoked=false;
 const client=new LarkBaseClient({route:{...route,profile:''},invoke:()=>{invoked=true;}});
 assert.throws(()=>client.listFields(),/NOT_CONFIGURED/);
 const asyncClient=new AsyncReadLarkBaseClient({route:{...route,profile:''},readInvoke:()=>{invoked=true;}});
 await assert.rejects(asyncClient.listFields(),/NOT_CONFIGURED/);assert.equal(invoked,false);
});
test('configured route is applied explicitly to real copied Base client',()=>{
 const client=new LarkBaseClient({route,invoke:(exe,args)=>{assert.equal(exe,'lark-cli');assert.ok(args.includes('test-profile'));assert.ok(args.includes('user'));assert.ok(args.includes('test-base'));return {status:0,stdout:'{"ok":true}'};}});
 assert.deepEqual(client.listFields(),{ok:true});
});
test('Windows npm shims resolve to Node JS entrypoints without shell or argument corruption',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'koc shim '));
 try{
  await fs.mkdir(path.join(dir,'node_modules','test-cli'),{recursive:true});
  const entry=path.join(dir,'node_modules','test-cli','cli.js');await fs.writeFile(entry,'');
  await fs.writeFile(path.join(dir,'lark-cli.cmd'),'@"%~dp0\\node_modules\\test-cli\\cli.js" %*');
  const args=['--json','{"字段":"值 & %PATH% $(x)"}'];
  const resolved=resolveCommand('lark-cli',args,{platform:'win32',env:{PATH:dir}});
  assert.equal(resolved.command,process.execPath);assert.deepEqual(resolved.args,[entry,...args]);
  await fs.writeFile(path.join(dir,'lark-cli.cmd'),'@"%dp0%\\node_modules\\test-cli\\cli.js" %*');
  assert.deepEqual(resolveCommand('lark-cli',args,{platform:'win32',env:{PATH:dir}}),resolved);
  assert.throws(()=>resolveCommand('lark-cli',[],{platform:'win32',env:{PATH:''}}),/ENTRYPOINT_NOT_FOUND/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('serialized page inspection carries config into isolated CLI realm',async()=>{
 const inspect=vm.runInNewContext('('+buildReadOnlyPageSnapshotCode()+')');
 const result=await inspect({context:()=>({pages:()=>[]})});
 assert.equal(result.contextAvailable,true);assert.equal(result.pages.length,0);
});
test('portable module graph has no external private runtime dependencies',async()=>{
 const root=fileURLToPath(new URL('..',import.meta.url));
 const manifest=JSON.parse(await fs.readFile(path.join(root,'koc-contact/runtime-release.json'),'utf8'));
 assert.deepEqual(manifest.externalFiles,{});assert.ok(manifest.files['shared/lark-json-file-transport.mjs']);assert.ok(manifest.files['capture-source-session.mjs']);
});

test('long browser programs use private files and cleanup on sync and async completion',async()=>{
 const {spawnSync,spawn,execFile,prepareRunCode}=await import('../shared/child-process.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'koc-long-code-'));
 const longCode='async page=>{/*'+ 'private-test-marker'.repeat(12000)+'*/return 1}';
 const fixture=path.join(dir,'fake-cli.mjs');
 await fs.writeFile(fixture,`import fs from 'node:fs';const a=process.argv.slice(2);if(a[0]!=='run-code'||a[1]!=='--filename')process.exit(3);const f=a[2];console.log(JSON.stringify({file:f,length:fs.readFileSync(f,'utf8').length,argsLength:a.join(' ').length}));`);
 try{
  const prepared=prepareRunCode(['run-code',longCode],{dataDir:dir});assert.equal(await fs.readFile(prepared.file,'utf8'),longCode);prepared.cleanup();await assert.rejects(fs.stat(prepared.file));
  const check=async output=>{const r=JSON.parse(output);assert.equal(r.length,longCode.length);assert.ok(r.argsLength<1000);await assert.rejects(fs.stat(r.file));};
  const result=spawnSync(process.execPath,[fixture,'run-code',longCode],{encoding:'utf8'});assert.equal(result.status,0);await check(result.stdout);
  const output=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fixture,'run-code',longCode]);let out='';p.stdout.on('data',c=>out+=c);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(Error('child failed')));});await check(output);
  const out=await new Promise((resolve,reject)=>execFile(process.execPath,[fixture,'run-code',longCode],{encoding:'utf8'},(e,out)=>e?reject(e):resolve(out)));await check(out);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('source capture launches the configured Chrome executable and keeps headless mode',async()=>{
 const {launchSourceBrowser}=await import('./capture-source.mjs');
 const called=[];const browserType={launch:async options=>{called.push(options);return 'browser';}};
 assert.equal(await launchSourceBrowser(browserType,{CHROME_PATH:'C:\\Program Files\\Chrome\\chrome.exe'}),'browser');
 await launchSourceBrowser(browserType,{});
 assert.deepEqual(called,[{executablePath:'C:\\Program Files\\Chrome\\chrome.exe',headless:true},{channel:'chrome',headless:true}]);
});
test('new Base initializer creates only missing fields and verifies readback; never repairs mismatched types',async()=>{
 const {initializeBase,PORTABLE_BASE_FIELDS}=await import('../initialize-base.mjs');
 const {assertContactSchema}=await import('../koc-contact/run-original-background-feishu-write.mjs');
 const fields=[{name:'Text',type:'text'},{name:'手工字段',type:'text'}],created=[];
 const client={listFields:()=>({fields}),createField:d=>{fields.push(structuredClone(d));created.push(d.name);return {created:true};}};
 const plan=await initializeBase({client});assert.equal(plan.mode,'plan');assert.equal(created.length,0);assert.equal(plan.missing.length,22);
 const result=await initializeBase({client,apply:true});assert.equal(result.fieldsVerified,23);assert.equal(created.length,22);
 assert.equal(assertContactSchema(fields),true);assert.ok(fields.some(f=>f.name==='手工字段'));
 assert.equal((await initializeBase({client,apply:true})).created.length,0);
 fields.find(f=>f.name==='微信号').type='number';await assert.rejects(initializeBase({client,apply:true}),/TYPE_MISMATCH/);
 assert.throws(()=>assertContactSchema(fields),/SCHEMA_MISMATCH/);
});
test('readiness Base URL accepts only configured Feishu/Larksuite resource coordinates',async()=>{
 const {feishuBaseUrl}=await import('../shared/config.mjs');
 assert.equal(feishuBaseUrl({host:'example.feishu.cn',baseToken:'base123',tableId:'table123'}),'https://example.feishu.cn/base/base123?table=table123');
 for(const host of ['example.feishu.cn.evil.test','feishu.cn','https://example.feishu.cn','user@example.feishu.cn','example.larksuite.com/path'])assert.equal(feishuBaseUrl({host,baseToken:'base123',tableId:'table123'}),null);
});

test('background bootstrap creates only missing targets and verifies all ten without foreground fallback',async()=>{
 const {bootstrapBackground}=await import('../bootstrap-background.mjs');
 const calls=[];let ready=2;const auth={route:'BUSINESS_LIST',accountMarkerVisible:true,authSignal:false,challengeSignal:false};
 const cdp={send:async(name,args)=>{calls.push([name,args]);if(name==='Target.createTarget'){ready++;return {targetId:String(ready)};}},detach:async()=>{}};
 const page={context:()=>({browser:()=>({newBrowserCDPSession:async()=>cdp})})};
 const options={inspect:async()=>({pages:[auth]}),select:()=>Array(ready).fill({}),accountMarker:'test-shop',wait:async()=>{}};
 assert.deepEqual(await bootstrapBackground(page,options),{passed:true,created:8,ready:10});
 assert.ok(calls.every(([name,args])=>name==='Target.createTarget'&&args.background===true));
 const count=calls.length;assert.equal((await bootstrapBackground(page,options)).created,0);assert.equal(calls.length,count);
 ready=0;calls.length=0;await assert.rejects(bootstrapBackground(page,{...options,select:()=>[],attempts:1}),/NOT_VERIFIED/);
 assert.equal(calls.filter(([name])=>name==='Target.closeTarget').length,10);
 ready=0;await assert.rejects(bootstrapBackground({context:()=>({browser:()=>({})})},options),/CDP_UNAVAILABLE/);
});
