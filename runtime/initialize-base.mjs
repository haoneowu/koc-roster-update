import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {LarkBaseClient,REQUIRED_FIELD_DEFINITIONS,validateRosterFields} from './koc-roster/lark-writer.mjs';
const text=name=>({name,type:'text',style:{type:'plain'}});
const date=name=>({name,type:'datetime',style:{format:'yyyy-MM-dd HH:mm'}});
export const PORTABLE_BASE_FIELDS=Object.freeze([
 ...['Text','抖音号','蝉妈妈来源','采集批次','榜单验证状态'].map(text),
 ...REQUIRED_FIELD_DEFINITIONS,
 text('微信号'),text('本次联系方式状态'),date('联系方式最近尝试'),date('联系方式最近成功'),text('商务跟进状态'),text('商务备注'),
]);
function rows(payload){const data=payload?.data??payload;return Array.isArray(data)?data:data?.fields??data?.items??[];}
function index(payload){const result=new Map();for(const f of rows(payload)){const name=f.name??f.field_name;if(result.has(name))throw Error('LARK_DUPLICATE_FIELD_NAME');result.set(name,f);}return result;}
function compatibleField(definition,present){
 if(!present)return false;
 const type=String(present.type??present.field_type??present.type_name).toLowerCase();
 if(definition.name==='本次联系方式状态')return ['text','1','single_select','singleselect','3','select'].includes(type)&&
  (type!=='select'||present.multiple===false);
 return type===definition.type;
}
export async function initializeBase({client=new LarkBaseClient(),apply=false,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 const existing=index(await client.listFields());const missing=[];
 for(const definition of PORTABLE_BASE_FIELDS){const present=existing.get(definition.name);if(!present){missing.push(definition);continue;}if(!compatibleField(definition,present))throw Error('KOC_BASE_SCHEMA_TYPE_MISMATCH');}
 if(!apply)return {passed:missing.length===0,mode:'plan',missing:missing.map(f=>({name:f.name,type:f.type})),required:PORTABLE_BASE_FIELDS};
 for(const definition of missing)await client.createField(definition);
 let complete=false;
 for(let attempt=0;attempt<3;attempt++){const after=index(await client.listFields());complete=PORTABLE_BASE_FIELDS.every(d=>compatibleField(d,after.get(d.name)));if(complete)break;if(attempt<2)await wait(250*(attempt+1));}
 if(!complete)throw Error('KOC_BASE_SCHEMA_READBACK_FAILED');
 await validateRosterFields(client);
 return {passed:true,mode:'apply',created:missing.map(f=>f.name),fieldsVerified:PORTABLE_BASE_FIELDS.length};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.slice(2).some(a=>a!=='--apply'))throw Error('KOC_BASE_SCHEMA_ARGUMENT_INVALID');console.log(JSON.stringify(await initializeBase({apply:process.argv.includes('--apply')})));}
 catch(e){console.log(JSON.stringify({passed:false,reason:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'KOC_BASE_SCHEMA_FAILED'}));process.exitCode=1;}
}
