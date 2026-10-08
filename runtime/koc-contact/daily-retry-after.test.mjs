import test from 'node:test';
import assert from 'node:assert/strict';
import {withRetryAfter} from './daily-retry-after.mjs';
test('generated wrapper preserves longer platform Retry-After without retaining response data',async()=>{
 let callback,removed=false;
 const page={context:()=>({pages:()=>[page]}),on:(_,f)=>callback=f,off:(_,f)=>{removed=f===callback;},fire:()=>callback({url:()=> 'https://buyin.jinritemai.com/test',headerValue:async()=> '900'})};
 const result=await (0,eval)(`(${withRetryAfter('async page => {page.fire();return {workers:[]};}')})`)(page);
 assert.ok(result.platformRetryAfterAt>Date.now()+890000);assert.deepEqual(Object.keys(result).sort(),['platformRetryAfterAt','workers']);assert.equal(removed,true);
});
