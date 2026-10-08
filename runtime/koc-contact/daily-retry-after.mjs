/** Read only the standard Retry-After header on official Buyin responses; never retain payloads. */
export async function observeRetryAfter(page,execute){
 const watched=page.context().pages(),pending=[];let nextEligibleAt=0;
 const listener=response=>{pending.push((async()=>{try{
  if(!String(response.url()).startsWith('https://buyin.jinritemai.com/'))return;
  const value=await response.headerValue('retry-after');if(!value)return;
  const at=/^\d+(\.\d+)?$/.test(value.trim())?Date.now()+Number(value)*1000:Date.parse(value);
  if(Number.isFinite(at)&&at>Date.now())nextEligibleAt=Math.max(nextEligibleAt,at);
 }catch{}})());};
 for(const p of watched)p.on('response',listener);
 try{const result=await execute(page);await Promise.all(pending);return {...result,platformRetryAfterAt:nextEligibleAt};}
 finally{for(const p of watched)p.off('response',listener);}
}
export function withRetryAfter(code){return `async (page) => (${observeRetryAfter.toString()})(page, (${code}))`;}
