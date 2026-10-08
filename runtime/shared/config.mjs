import os from 'node:os';
import path from 'node:path';
export const DATA_DIR=path.resolve(process.env.KOC_DATA_DIR||path.join(process.env.APPDATA|| (process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support'):process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local','share')),'KOC Roster Update'));
export const BUYIN_ACCOUNT_MARKER=process.env.KOC_BUYIN_ACCOUNT_MARKER||'';
export const PLAYWRIGHT_SESSION=process.env.KOC_PLAYWRIGHT_SESSION||'koc-roster';
export const FEISHU_ROUTE=Object.freeze({profile:process.env.KOC_FEISHU_PROFILE||'',as:process.env.KOC_FEISHU_IDENTITY||'user',host:process.env.KOC_FEISHU_HOST||'',baseToken:process.env.KOC_FEISHU_BASE_TOKEN||'',tableId:process.env.KOC_FEISHU_TABLE_ID||''});
export function assertFeishuRoute(route=FEISHU_ROUTE){
 if(!route.profile||!route.baseToken||!route.tableId||route.as!=='user'||!route.host||!/^[-a-zA-Z0-9.]+$/.test(route.host))throw Error('KOC_FEISHU_ROUTE_NOT_CONFIGURED');
 return route;
}

export function feishuBaseUrl(route=FEISHU_ROUTE){
 if(!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:feishu\.cn|larksuite\.com)$/i.test(route.host||'')||!/^[-A-Za-z0-9]+$/.test(route.baseToken||'')||!/^[-A-Za-z0-9]+$/.test(route.tableId||''))return null;
 return `https://${route.host}/base/${encodeURIComponent(route.baseToken)}?table=${encodeURIComponent(route.tableId)}`;
}
