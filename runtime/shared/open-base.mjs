import path from 'node:path';
import {spawn} from 'node:child_process';

export function baseOpenCommand(url,{platform=process.platform,environment=process.env}={}){
 let parsed;try{parsed=new URL(url);}catch{throw Error('KOC_BASE_URL_INVALID');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||
  !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:feishu\.cn|larksuite\.com)$/i.test(parsed.hostname)||
  !/^\/base\/[-A-Za-z0-9]+$/.test(parsed.pathname)||!/^\?table=[-A-Za-z0-9]+$/.test(parsed.search)||parsed.hash)
  throw Error('KOC_BASE_URL_INVALID');
 if(platform==='darwin')return {command:'/usr/bin/open',args:[parsed.href]};
 if(platform==='win32')return {command:path.win32.join(environment.SystemRoot||'C:\\Windows','System32','rundll32.exe'),args:['url.dll,FileProtocolHandler',parsed.href]};
 return {command:'xdg-open',args:[parsed.href]};
}
export function openBaseInBrowser(url,{spawnProcess=spawn,...options}={}){
 const {command,args}=baseOpenCommand(url,options);
 return new Promise((resolve,reject)=>{
  let child;try{child=spawnProcess(command,args,{shell:false,stdio:'ignore',windowsHide:true});}catch{reject(Error('KOC_BASE_OPEN_FAILED'));return;}
  child.once('error',()=>reject(Error('KOC_BASE_OPEN_FAILED')));
  child.once('close',code=>code===0?resolve():reject(Error('KOC_BASE_OPEN_FAILED')));
 });
}
