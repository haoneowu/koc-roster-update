import test from 'node:test';
import assert from 'node:assert/strict';
import {createInventory,runInventory} from './daily-inventory.mjs';
const targets=n=>Array.from({length:n},(_,i)=>({creatorId:`id${i}`,recordId:`rec${i}`,sourceRank:i+1,sourceBatchId:'day1'}));
test('daily inventory handles 0, 3 and 73 objects without a 50 cap, skips completed on resume',async()=>{
 for(const n of [0,3,73]){
  const state=createInventory(targets(n));const waves=[];
  const adapter={executeWave:async rows=>{waves.push(rows.length);return rows.map(()=>({complete:true,writeState:'verified',readbackVerified:true}));},verify:async()=>true};
  await runInventory(state,adapter,{save:async()=>{}});
  assert.equal(state.status,'complete');assert.equal(state.entries.filter(e=>e.complete).length,n);
  assert.ok(waves.every(n=>n<=10));assert.equal(waves.reduce((a,b)=>a+b,0),n);
  await runInventory(state,adapter,{save:async()=>{}});assert.equal(waves.reduce((a,b)=>a+b,0),n);
 }
});
test('rate limiting waits five minutes, persists across ticks, probes only failed original then resumes',async()=>{
 let clock=1000;const state=createInventory(targets(12),clock),calls=[];let count=0;
 const adapter={executeWave:async rows=>{calls.push(rows.map(t=>t.sourceRank));return rows.map((t,i)=> ++count===1?{complete:false,writeState:'not_written',reason:'RATE_LIMITED'}:{complete:true,writeState:'verified',readbackVerified:true});},verify:async()=>true};
 await runInventory(state,adapter,{save:async()=>{},now:()=>clock,tick:true});
 assert.equal(state.status,'cooldown');assert.equal(calls.length,1);assert.equal(state.cooldown.nextEligibleAt,301000);
 clock=300999;await runInventory(state,adapter,{save:async()=>{},now:()=>clock,tick:true});assert.equal(calls.length,1);
 clock=301000;await runInventory(state,adapter,{save:async()=>{},now:()=>clock,tick:true});
 assert.deepEqual(calls[1],[1]);assert.equal(state.status,'complete');assert.deepEqual(calls[2],[11,12]);
});
test('longer platform delay wins; multiple limited targets resume after one successful probe',async()=>{
 let clock=1000,first=true;const state=createInventory(targets(3),clock),calls=[];
 const adapter={executeWave:async rows=>{calls.push(rows.length);if(first){first=false;return rows.map(()=>({complete:false,writeState:'not_written',reason:'RATE_LIMITED',retryAfterAt:901000}));}return rows.map(()=>({complete:true,writeState:'verified',readbackVerified:true}));},verify:async()=>true};
 await runInventory(state,adapter,{save:async()=>{},now:()=>clock,tick:true});assert.equal(state.cooldown.nextEligibleAt,901000);
 clock=901000;await runInventory(state,adapter,{save:async()=>{},now:()=>clock,tick:true});assert.equal(state.status,'complete');assert.deepEqual(calls,[3,1,2]);
});
test('unknown writes and interrupted work never replay; incomplete readback cannot mark success',async()=>{
 const state=createInventory(targets(3));state.entries[0]={state:'in_flight',complete:false};state.entries[1]={state:'uncertain',complete:false};let called=[];
 await runInventory(state,{executeWave:async rows=>{called=rows;return [{complete:true,writeState:'uncertain',readbackVerified:false}];},verify:async()=>true},{save:async()=>{}});
 assert.deepEqual(called.map(r=>r.sourceRank),[3]);assert.equal(state.entries[2].complete,false);assert.notEqual(state.status,'complete');
});
test('execution is persisted in-flight before dispatch, and interruption cannot repeat on resume',async()=>{
 const state=createInventory(targets(1));let saved=false;
 const adapter={executeWave:async()=>{assert.equal(saved,true);assert.equal(state.entries[0].state,'in_flight');throw Error('INTERRUPTED');},verify:async()=>true};
 await assert.rejects(runInventory(state,adapter,{save:async()=>{saved=true;}}));
 let calls=0;await runInventory(state,{executeWave:async()=>{calls++;},verify:async()=>true},{save:async()=>{}});assert.equal(calls,0);
});
test('auth blocks further dispatch, and uncertain cooldown probe is never replayed',async()=>{
 const s=createInventory(targets(12));let calls=0;
 await runInventory(s,{executeWave:async rows=>{calls++;return rows.map(()=>({complete:false,writeState:'not_written',reason:'AUTH_REQUIRED'}));},verify:async()=>true},{save:async()=>{}});
 assert.equal(calls,1);assert.equal(s.status,'blocked');
 const u=createInventory(targets(1));u.entries[0]={complete:false,state:'uncertain'};u.cooldown={index:0,nextEligibleAt:0};
 await runInventory(u,{executeWave:async()=>{throw Error('MUST_NOT_REPLAY');}},{save:async()=>{},tick:true});assert.equal(u.status,'blocked');
});
test('restart after probe commit clears stale cooldown without replaying confirmed target',async()=>{
 const s=createInventory(targets(2));s.entries=[{state:'confirmed',complete:true,writeState:'verified',readbackVerified:true},{state:'failed',complete:false,writeState:'not_written',reason:'RATE_LIMITED'}];s.cooldown={index:0,nextEligibleAt:0};let ranks=[];
 await runInventory(s,{executeWave:async rows=>{ranks.push(...rows.map(r=>r.sourceRank));return rows.map(()=>({complete:true,writeState:'verified',readbackVerified:true}));},verify:async()=>true},{save:async()=>{}});
 assert.deepEqual(ranks,[2]);assert.equal(s.status,'complete');
});
test('non-rate probe failure keeps the channel gated across restart until that probe succeeds',async()=>{
 const s=createInventory(targets(12));s.cooldown={index:0,nextEligibleAt:0};let clock=1000,calls=[];
 const adapter={executeWave:async rows=>{calls.push(rows.length);return rows.map(()=>({complete:false,writeState:'not_written',reason:'PAGE_NOT_READY'}));},verify:async()=>true};
 await runInventory(s,adapter,{save:async()=>{},now:()=>clock,tick:true});
 assert.ok(s.cooldown);await runInventory(s,adapter,{save:async()=>{},now:()=>clock,tick:true});assert.deepEqual(calls,[1]);
 clock+=300000;await runInventory(s,adapter,{save:async()=>{},now:()=>clock,tick:true,retryFailures:true});assert.deepEqual(calls,[1,1]);
});
test('read-only preflight failure leaves inventory retryable and dispatches nothing',async()=>{
 const s=createInventory(targets(3));let calls=0;
 await assert.rejects(runInventory(s,{preflight:async()=>{throw Error('PAGES_NOT_READY');},executeWave:async()=>{calls++;}},{save:async()=>{}}));
 assert.ok(s.entries.every(e=>e.state==='pending'));assert.equal(calls,0);
});
test('unverified source inventory remains explicit even when all admitted targets finish',async()=>{
 const s=createInventory([]);s.sourceIssues=[{sourceBatchId:'legacy',reason:'SOURCE_SCOPE_VERSION_MISMATCH'}];
 await runInventory(s,{verify:async()=>true},{save:async()=>{}});assert.equal(s.status,'source_review_required');
});
test('verified capacity below ten drains original inventory without exceeding usable pages',async()=>{
 const state=createInventory(targets(6)),waves=[];
 await runInventory(state,{capacity:async()=>2,preflight:async rows=>{assert.ok(rows.length<=2);},executeWave:async rows=>{waves.push(rows.map(t=>t.sourceRank));return rows.map(()=>({complete:true,writeState:'verified',readbackVerified:true}));},verify:async()=>true},{save:async()=>{},laneLimit:2});
 assert.deepEqual(waves,[[1,2],[3,4],[5,6]]);assert.equal(state.status,'complete');
});
test('zero or invalid capacity stops before dispatch and preserves pending entries',async()=>{
 for(const capacity of [0,NaN,11]){const state=createInventory(targets(2));let dispatched=false;
 await assert.rejects(runInventory(state,{capacity:async()=>capacity,executeWave:async()=>{dispatched=true;}},{save:async()=>{}}),/INVENTORY_PAGES_NOT_READY/);
 assert.equal(dispatched,false);assert.ok(state.entries.every(e=>e.state==='pending'));
 }
});

test('default ten-lane run does not silently shrink to two',async()=>{
 const s=createInventory(targets(12));let called=false;
 await assert.rejects(runInventory(s,{capacity:async()=>2,executeWave:async()=>{called=true;}},{save:async()=>{}}),/INVENTORY_TEN_LANES_NOT_READY/);
 assert.equal(called,false);assert.ok(s.entries.every(e=>e.state==='pending'));
});
test('cooldown probe needs only one valid page even with ten-lane default',async()=>{
 const s=createInventory(targets(1));s.cooldown={index:0,nextEligibleAt:0};let count=0;
 await runInventory(s,{capacity:async()=>1,executeWave:async rows=>{count+=rows.length;return rows.map(()=>({complete:true,writeState:'verified',readbackVerified:true}));},verify:async()=>true},{save:async()=>{}});assert.equal(count,1);
});
