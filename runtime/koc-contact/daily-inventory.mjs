/** Durable scheduling; adapters reuse the existing browser and protected writer. */
export function createInventory(targets,now=Date.now()) {
 if(new Set(targets.map(t=>t.creatorId)).size!==targets.length||new Set(targets.map(t=>t.recordId)).size!==targets.length)throw Error('INVENTORY_IDENTITY_CONFLICT');
 return {version:1,startedAtMs:now,status:'ready',targets,entries:targets.map(()=>({state:'pending',complete:false})),events:[],timing:{executionMs:0,cooldownMs:0}};
}
export async function runInventory(state,adapter,{save,now=Date.now,tick=false,sleep=ms=>new Promise(r=>setTimeout(r,ms)),retryFailures=false,laneLimit=10,notify=()=>{}}={}) {
 if(!Number.isInteger(laneLimit)||laneLimit<1||laneLimit>10)throw Error("INVENTORY_LANE_LIMIT_INVALID");
 const attempted=new Set();
 const releaseCooldown=()=>{delete state.cooldown;for(let i=0;i<state.entries.length;i++)if(!state.entries[i].complete&&state.entries[i].reason==='RATE_LIMITED'&&state.entries[i].state==='failed'&&state.entries[i].writeState!=='uncertain'){state.entries[i].state='pending';attempted.delete(i);}};
 while(true){
  let indexes;
  if(state.cooldown){
   if(state.entries[state.cooldown.index]?.complete){releaseCooldown();await save(state);continue;}
   if(state.cooldown.requiresDiagnosis&&!retryFailures){state.status='blocked';await save(state);return state;}
   if(['in_flight','uncertain'].includes(state.entries[state.cooldown.index]?.state)){state.status='blocked';await save(state);return state;}
   const wait=state.cooldown.nextEligibleAt-now();
   if(wait>0){state.status='cooldown';await save(state);notify({event:'progress',phase:'cooldown',actualLanes:0,targetLanes:10,nextProbeAt:state.cooldown.nextEligibleAt,completed:state.entries.filter(e=>e.complete).length,total:state.targets.length,message:'平台提示操作频繁，已保留结果；间隔至少5分钟后单条探测，平台要求更长等待时优先遵循。'});if(tick)return state;
    const start=now();await sleep(Math.min(wait,60000));state.timing.cooldownMs+=now()-start;continue;}
   indexes=[state.cooldown.index];
  }else indexes=state.entries.map((e,i)=>({e,i})).filter(({e,i})=>!e.complete&&!attempted.has(i)&&(e.state==='pending'||retryFailures&&e.state==='failed')).slice(0,laneLimit).map(x=>x.i);
  if(!indexes.length)break;
  const capacity=adapter.capacity?await adapter.capacity():10;
  if(!Number.isInteger(capacity)||capacity<1||capacity>10)throw Error('INVENTORY_PAGES_NOT_READY');
  if(capacity<indexes.length)throw Error(laneLimit===10?"INVENTORY_TEN_LANES_NOT_READY":"INVENTORY_PAGES_NOT_READY");
  if(adapter.preflight)await adapter.preflight(indexes.map(i=>state.targets[i]));
  for(const i of indexes)attempted.add(i);
  for(const i of indexes)state.entries[i]={...state.entries[i],state:'in_flight',complete:false};await save(state);
  notify({event:"progress",phase:state.cooldown?"probe":"running",actualLanes:indexes.length,targetLanes:10,mode:laneLimit===10?"standard":"diagnostic",completed:state.entries.filter(e=>e.complete).length,total:state.targets.length});
  const start=now();const results=await adapter.executeWave(indexes.map(i=>state.targets[i]));state.timing.executionMs+=now()-start;
  if(!Array.isArray(results)||results.length!==indexes.length)throw Error('INVENTORY_RESULTS_INCOMPLETE');
  for(let j=0;j<indexes.length;j++){const r=results[j];const complete=r.complete===true&&r.writeState==='verified'&&r.readbackVerified===true;state.entries[indexes[j]]={...r,complete,state:complete?'confirmed':r.writeState==='uncertain'?'uncertain':'failed'};}
  if(results.some(r=>['AUTH_REQUIRED','AUTH_EXPIRED','MENU_PERMISSION_DENIED','SECURITY_CHALLENGE','ROLE_SELECTION_REQUIRED'].includes(r.reason))){state.status='blocked';await save(state);return state;}
  const limited=results.findIndex(r=>r.reason==='RATE_LIMITED');
  if(limited>=0){const r=results[limited];state.cooldown={index:indexes[limited],lastProbeAt:now(),nextEligibleAt:Math.max(now()+300000,Number(r.retryAfterAt)||0)};state.status='cooldown';state.events.push({at:now(),type:'rate_limited',...state.cooldown});await save(state);if(tick)return state;continue;}
  if(state.cooldown){if(!state.entries[indexes[0]].complete){state.cooldown.requiresDiagnosis=true;state.cooldown.nextEligibleAt=Math.max(state.cooldown.nextEligibleAt,now()+300000);state.status='blocked';await save(state);return state;}
   releaseCooldown();}
  await save(state);
 }
 state.status=state.entries.every(e=>e.complete)&&await adapter.verify(state)?(state.sourceIssues?.length?'source_review_required':'complete'):'incomplete';await save(state);return state;
}
