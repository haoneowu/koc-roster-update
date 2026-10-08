import * as child from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DATA_DIR} from './config.mjs';

// npm's Windows .cmd shims cannot be executed by execFile. Resolve their JS
// entrypoint and invoke Node directly; never interpolate arguments into a shell.
export function resolveCommand(command,args=[],{platform=process.platform,env=process.env}={}){
 if(platform!=='win32'||path.resolve(command)===path.resolve(process.execPath))return {command,args};
 const paths=path.isAbsolute(command)?['']:String(env.PATH||env.Path||'').split(';');
 for(const dir of paths){
  const shim=dir?path.join(dir,command.replace(/\.cmd$/i,'')+'.cmd'):command;
  let source;try{source=fs.readFileSync(shim,'utf8');}catch{continue;}
  const match=source.match(/"%(?:~dp0|dp0%)\\?([^"\r\n]+\.(?:[cm]?js))"/i);
  if(match){const entry=path.resolve(path.dirname(shim),match[1].replaceAll('\\',path.sep));if(fs.existsSync(entry))return {command:process.execPath,args:[entry,...args]};}
 }
 if(/^(npx|npm|lark-cli)(\.cmd)?$/i.test(command))throw Error('KOC_WINDOWS_CLI_ENTRYPOINT_NOT_FOUND');
 return {command,args};
}
function localCommand(command,args){
 const name=command==='lark-cli'?'@larksuite/cli':command==='npx'&&args?.[0]==='--no-install'&&/^@playwright\/cli(?:@|$)/.test(args?.[1]||'')?'@playwright/cli':null;
 if(name){
  const packagePath=fileURLToPath(new URL(`../../node_modules/${name}/package.json`,import.meta.url));
  try{const pkg=JSON.parse(fs.readFileSync(packagePath,'utf8'));const bin=typeof pkg.bin==='string'?pkg.bin:Object.values(pkg.bin||{})[0];const entry=path.resolve(path.dirname(packagePath),bin);if(fs.existsSync(entry))return {command:process.execPath,args:[entry,...(command==='npx'?args.slice(2):args)]};}catch{}
 }
 return resolveCommand(command,args);
}
// Browser programs can exceed Windows' 32767-character command-line ceiling.
// Put code in a private file on every platform; never put program text in argv.
export function prepareRunCode(args,{dataDir=DATA_DIR}={}){
 const index=args.indexOf('run-code');
 if(index<0||typeof args[index+1]!=='string'||args[index+1].startsWith('--'))return {args,cleanup(){}};
 const root=path.join(dataDir,'cli-programs');fs.mkdirSync(root,{recursive:true,mode:0o700});
 const dir=fs.mkdtempSync(path.join(root,'run-'));fs.chmodSync(dir,0o700);
 const file=path.join(dir,'program.js');
 let cleaned=false;const cleanup=()=>{if(cleaned)return;cleaned=true;process.removeListener('exit',cleanup);try{fs.rmSync(dir,{recursive:true,force:true});}catch{}};
 try{fs.writeFileSync(file,args[index+1],{flag:'wx',mode:0o600});process.once('exit',cleanup);}
 catch(error){cleanup();throw error;}
 return {args:[...args.slice(0,index+1),'--filename',file,...args.slice(index+2)],cleanup,file};
}
function prepare(command,args){const c=localCommand(command,args);const code=prepareRunCode(c.args);return {...c,args:code.args,cleanup:code.cleanup};}
export function spawn(command,args,options){const c=prepare(command,args);try{const p=child.spawn(c.command,c.args,options);p.once('close',c.cleanup);p.once('error',c.cleanup);return p;}catch(error){c.cleanup();throw error;}}
export function spawnSync(command,args,options){const c=prepare(command,args);try{return child.spawnSync(c.command,c.args,options);}finally{c.cleanup();}}
export function execFile(command,args,options,callback){const c=prepare(command,args);try{return child.execFile(c.command,c.args,options,(...result)=>{c.cleanup();callback?.(...result);});}catch(error){c.cleanup();throw error;}}
execFile[promisify.custom]=(command,args,options)=>new Promise((resolve,reject)=>{execFile(command,args,options,(error,stdout,stderr)=>{if(error){error.stdout=stdout;error.stderr=stderr;reject(error);}else resolve({stdout,stderr});});});
