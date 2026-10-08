import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DEFAULT_STATE_DIR} from '../koc-roster/checkpoint.mjs';

export const DEFAULT_RETRY_EXCLUSION_PATH=path.join(DEFAULT_STATE_DIR,'execution-controls','retry-exclusions.json');

const ROOT_KEYS='exclusions,status,title,updatedAt,version';
const ENTRY_KEYS='creatorId,currentBaseSameRecordNameVerified,eligibleForRetry,gridRow,reasonCode,recordId,sourcePairVerified,sourceRank';
const ALLOWED_REASON_CODES=new Set(['SHOP_OR_MERCHANT_EXCLUDED']);
const fail=code=>{throw new Error(`RETRY_EXCLUSION_${code}`);};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validToken=value=>typeof value==='string'&&value.length>0&&value.length<=200&&
  value.trim()===value&&!/[\u0000-\u001f\u007f]/u.test(value);

/** Validate private exclusion entries against the exact immutable source manifest. */
export function validateRetryExclusions({manifest,exclusions=[]}={}) {
  if(!Array.isArray(manifest?.targets)||!Array.isArray(exclusions)||exclusions.length>100)fail('INVALID');
  const seenCreators=new Set(),seenRecords=new Set(),seenRanks=new Set();
  const validated=[];
  for(const exclusion of exclusions){
    if(!isObject(exclusion)||Object.keys(exclusion).sort().join(',')!==ENTRY_KEYS||
      !validToken(exclusion.creatorId)||!validToken(exclusion.recordId)||
      !Number.isSafeInteger(exclusion.sourceRank)||exclusion.sourceRank<1||
      !Number.isSafeInteger(exclusion.gridRow)||exclusion.gridRow<1||
      !ALLOWED_REASON_CODES.has(exclusion.reasonCode)||exclusion.eligibleForRetry!==false||
      exclusion.sourcePairVerified!==true||exclusion.currentBaseSameRecordNameVerified!==true||
      seenCreators.has(exclusion.creatorId)||seenRecords.has(exclusion.recordId)||seenRanks.has(exclusion.sourceRank)) {
      fail('INVALID');
    }
    const exactMatches=manifest.targets.filter(target=>target.creatorId===exclusion.creatorId&&
      target.recordId===exclusion.recordId&&target.sourceRank===exclusion.sourceRank);
    const creatorMatches=manifest.targets.filter(target=>target.creatorId===exclusion.creatorId);
    const recordMatches=manifest.targets.filter(target=>target.recordId===exclusion.recordId);
    if(exactMatches.length!==1||creatorMatches.length!==1||recordMatches.length!==1||
      creatorMatches[0]!==exactMatches[0]||recordMatches[0]!==exactMatches[0])fail('MAPPING_MISMATCH');
    seenCreators.add(exclusion.creatorId);seenRecords.add(exclusion.recordId);seenRanks.add(exclusion.sourceRank);
    validated.push(Object.freeze({...exclusion}));
  }
  return Object.freeze(validated);
}

/** Read a private retry-exclusion sidecar, rejecting unsafe files and stale source mappings. */
export async function loadRetryExclusions({filePath=DEFAULT_RETRY_EXCLUSION_PATH,manifest}={}) {
  if(typeof filePath!=='string'||!path.isAbsolute(filePath))fail('FILE_PATH_INVALID');
  let handle;
  try{
    const noFollow=fsConstants.O_NOFOLLOW||0;
    handle=await fs.open(filePath,fsConstants.O_RDONLY|noFollow);
  }catch{fail('FILE_UNAVAILABLE');}
  try{
    const stat=await handle.stat();
    if(!stat.isFile()||(process.platform!=='win32'&&(stat.mode&0o077)!==0)||stat.size>128*1024)fail('FILE_UNSAFE');
    let sidecar;
    try{sidecar=JSON.parse(await handle.readFile('utf8'));}catch{fail('INVALID');}
    if(!isObject(sidecar)||Object.keys(sidecar).sort().join(',')!==ROOT_KEYS||sidecar.version!==1||
      sidecar.status!=='active'||typeof sidecar.title!=='string'||!sidecar.title.trim()||
      typeof sidecar.updatedAt!=='string'||!Number.isFinite(Date.parse(sidecar.updatedAt)))fail('INVALID');
    return validateRetryExclusions({manifest,exclusions:sidecar.exclusions});
  }finally{
    await handle.close();
  }
}
