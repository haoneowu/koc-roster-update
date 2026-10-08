import {assertFeishuRoute} from '../shared/config.mjs';
import {execFile} from '../shared/child-process.mjs';
import {LarkBaseClient} from './lark-writer.mjs';

const TRANSIENT_CODES=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH']);
const READ_OPERATIONS=new Set(['+field-list','+record-list','+record-get','+record-history-list']);
const SAFE_CAUSES=new Set([...TRANSIENT_CODES,'RATE_LIMITED','LARK_READ_TIMEOUT','LARK_CLI_EXIT',
  'LARK_API_ERROR','LARK_CLI_FAILED','LARK_EMPTY_RESPONSE','LARK_RESPONSE_NOT_JSON',
  'LARK_DUPLICATE_EXISTING_CREATOR_ID','LARK_EXISTING_CREATOR_RECORD_ID_MISSING','LARK_RECORD_PAGINATION_LIMIT']);

// Never attach child-process Error/cmd or raw output: these may contain contact data.
export function safeReadFailure(error) {
  const source=error?.readFailure??{};
  const causeCode=SAFE_CAUSES.has(source.causeCode)?source.causeCode:
    SAFE_CAUSES.has(error?.message)?error.message:'UNKNOWN_ERROR';
  const safe={causeCode};
  if(READ_OPERATIONS.has(source.operation))safe.operation=source.operation;
  for(const key of ['offset','exitCode','platformCode']) {
    if(Number.isSafeInteger(source[key])&&source[key]>=0)safe[key]=source[key];
  }
  if(['SIGTERM','SIGKILL','SIGINT'].includes(source.signal))safe.signal=source.signal;
  if(source.attempts===1||source.attempts===2)safe.attempts=source.attempts;
  return safe;
}
function parseOutput(stdout) {
  const text=String(stdout||'').trim();
  if(!text)throw new Error('LARK_EMPTY_RESPONSE');
  try{return JSON.parse(text);}catch{}
  for(const line of text.split(/\r?\n/).reverse())try{return JSON.parse(line);}catch{}
  throw new Error('LARK_RESPONSE_NOT_JSON');
}
function failure(error,payload,args,attempts,parseError) {
  const platformCode=[payload?.error?.code,payload?.code].find(v=>Number.isSafeInteger(v)&&v!==0);
  const timeout=error?.killed===true&&error?.signal==='SIGTERM';
  const rateLimited=platformCode===429||platformCode===99991400||payload?.status===429||payload?.error?.status===429;
  const explicitApiFailure=platformCode!==undefined||payload?.ok===false||Boolean(payload?.error);
  const transient=!explicitApiFailure&&(timeout||TRANSIENT_CODES.has(error?.code));
  const causeCode=rateLimited?'RATE_LIMITED':platformCode!==undefined?'LARK_API_ERROR':
    transient&&timeout?'LARK_READ_TIMEOUT':transient?error.code:error?'LARK_CLI_EXIT':parseError?.message??'LARK_API_ERROR';
  const diagnostic={causeCode,operation:args[1],attempts};
  const offsetAt=args.indexOf('--offset');
  if(offsetAt>=0)diagnostic.offset=Number(args[offsetAt+1]);
  if(Number.isSafeInteger(error?.code))diagnostic.exitCode=error.code;
  if(error?.signal)diagnostic.signal=error.signal;
  if(platformCode!==undefined)diagnostic.platformCode=platformCode;
  const result=new Error(error?'LARK_CLI_FAILED':parseError?.message??'LARK_CLI_FAILED');
  result.readFailure=safeReadFailure({readFailure:diagnostic});
  return {error:result,retryable:rateLimited||transient};
}

// Reads have one bounded retry; mutation dispatch remains unchanged.
export class AsyncReadLarkBaseClient extends LarkBaseClient {
  constructor({readInvoke=execFile,retryWait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),...options}={}) {
    super(options);this.readInvoke=readInvoke;this.retryWait=retryWait;
  }
  call(args) {
    if(args[0]!=='base'||!READ_OPERATIONS.has(args[1]))return super.call(args);
    return this.readWithRetry(args);
  }
  async readWithRetry(args) {
    assertFeishuRoute(this.route);
    const fullArgs=[...args,'--profile',this.route.profile,'--as',this.route.as,'--format','json'];
    for(let attempts=1;attempts<=2;attempts++) {
      const {error,stdout}=await new Promise(resolve=>{
        try{this.readInvoke(this.executable,fullArgs,{encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000},
          (error,stdout)=>resolve({error,stdout}));}catch(error){resolve({error,stdout:''});}
      });
      let payload,parseError;try{payload=parseOutput(stdout);}catch(e){parseError=e;}
      const apiFailure=payload?.ok===false||payload?.error||Number.isSafeInteger(payload?.code)&&payload.code!==0;
      if(!error&&!parseError&&!apiFailure)return payload;
      const failed=failure(error,payload,args,attempts,parseError);
      if(attempts===2||!failed.retryable)throw failed.error;
      await this.retryWait(failed.error.readFailure.causeCode==='RATE_LIMITED'?1000:250);
    }
  }
}
