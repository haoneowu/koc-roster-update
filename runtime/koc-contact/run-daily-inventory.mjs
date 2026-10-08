import fs from 'node:fs/promises';
import path from 'node:path';
import {safeReadFailure} from '../koc-roster/async-read-client.mjs';
import {createInventory,runInventory} from './daily-inventory.mjs';
import {loadDailyInventorySources,pendingDailyTargets,createProductionAdapter,SOURCE_ROOT} from './daily-inventory-production.mjs';
import {PRODUCTION_STATE_DIR} from './canary-production-adapter.mjs';
import {writePrivateJson} from '../koc-roster/checkpoint.mjs';
import {verifyKocRuntimeRelease} from './runtime-release.mjs';
process.umask(0o077);
const args=new Set(process.argv.slice(2));
const allowed=new Set(['--prepare','--run','--tick','--retry-failures','--new','--help','--diagnostic-two-lanes']);
if(args.has('--help')){console.log('run-daily-inventory.mjs --prepare | --run [--tick] [--retry-failures] [--new] [--diagnostic-two-lanes]\nDaily verified add-only inventory, up to 10 lanes, no 50 cap. --tick yields during persisted cooldown; --run waits and probes every 5 minutes. --new only after prior run complete.');process.exit(0);}
if([...args].some(a=>!allowed.has(a))||args.has('--prepare')===args.has('--run')){console.log(JSON.stringify({reason:'USE_PREPARE_OR_RUN'}));process.exit(2);}
const base=path.join(SOURCE_ROOT,'daily-inventory'),active=path.join(base,'active.json');let lock,state,save;
try{
 await verifyKocRuntimeRelease();await fs.mkdir(base,{recursive:true,mode:0o700});await fs.mkdir(PRODUCTION_STATE_DIR,{recursive:true,mode:0o700});
 lock=await fs.open(path.join(PRODUCTION_STATE_DIR,'production.lock'),'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,mode:'daily-inventory',startedAt:new Date().toISOString()}));
 let pointer;try{pointer=JSON.parse(await fs.readFile(active,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(pointer&&!/^run-[0-9T-Z-]+$/.test(pointer.id))throw Error('INVENTORY_POINTER_INVALID');
 let dir=pointer&&path.join(base,pointer.id);
 if(dir)state=JSON.parse(await fs.readFile(path.join(dir,'ledger.json'),'utf8'));
 if(args.has('--new')&&state&&!(['complete','source_review_required'].includes(state.status)&&state.entries.every(e=>e.complete)))throw Error('INVENTORY_PREVIOUS_UNFINISHED');
 const bundles=await loadDailyInventorySources();
 if(!state||args.has('--new')){
  dir=path.join(base,`run-${new Date().toISOString().replace(/[:.]/g,'-')}`);await fs.mkdir(dir,{mode:0o700});
  state=createInventory(await pendingDailyTargets(bundles));state.sourceIssues=bundles.issues;
  state.entries=state.targets.map(t=>({state:['in_flight','uncertain'].includes(t.prior.state)?'uncertain':'pending',complete:false}));
  await writePrivateJson(path.join(dir,'ledger.json'),state);await writePrivateJson(active,{id:path.basename(dir)});
 }
 state.sourceIssues=bundles.issues;
 save=s=>writePrivateJson(path.join(dir,'ledger.json'),s);
 if(args.has('--run')){
  const adapter=await createProductionAdapter({bundles,dir,state,save});
  await runInventory(state,adapter,{save,tick:args.has('--tick'),retryFailures:args.has('--retry-failures'),laneLimit:args.has('--diagnostic-two-lanes')?2:10,notify:progress=>console.log(JSON.stringify(progress))});
 }
 console.log(JSON.stringify({status:state.status,targetCount:state.targets.length,completed:state.entries.filter(e=>e.complete).length,remaining:state.entries.filter(e=>!e.complete).length,unknown:state.entries.filter(e=>['uncertain','in_flight'].includes(e.state)).length,sourceIssues:state.sourceIssues??[],nextEligibleAt:state.cooldown?.nextEligibleAt??null,timing:state.timing,wallElapsedMs:Date.now()-state.startedAtMs,ledger:path.join(dir,'ledger.json')}));
 if(args.has('--run')&&state.status!=='complete'&&state.status!=='cooldown')process.exitCode=2;
}catch(e){
 const reason=e.code==='EEXIST'?'PRODUCTION_OWNER_LOCKED':/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'DAILY_INVENTORY_RUNTIME_FAILED';
 if(state&&save){state.lastStop={at:new Date().toISOString(),reason,...(e.readFailure?{readFailure:safeReadFailure(e)}:{}),...(e.waveFailure?{waveFailure:e.waveFailure}:{})};await save(state);}
 console.log(JSON.stringify({status:'blocked',reason}));process.exitCode=1;
}finally{if(lock){await lock.close();await fs.unlink(path.join(PRODUCTION_STATE_DIR,'production.lock'));}}
