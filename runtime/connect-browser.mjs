import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from './shared/child-process.mjs';
import {DATA_DIR,PLAYWRIGHT_SESSION} from './shared/config.mjs';
import {writePrivateJson} from './koc-roster/checkpoint.mjs';
import {playwrightCliArgs,playwrightCliEnv} from './koc-contact/playwright-cli-contract.mjs';
const configPath=path.join(DATA_DIR,'playwright-config.json');
await writePrivateJson(configPath,{saveSession:false});
try{
 const child=spawn('npx',playwrightCliArgs(`-s=${PLAYWRIGHT_SESSION}`,'attach','--extension=chrome',`--config=${configPath}`),{cwd:fileURLToPath(new URL('..',import.meta.url)),env:playwrightCliEnv(),stdio:'inherit'});
 child.on('error',()=>{console.error('KOC_BROWSER_CONNECT_FAILED');process.exitCode=1;});
 child.on('close',code=>{process.exitCode=code??1;});
}catch{console.error('KOC_BROWSER_CONNECT_FAILED');process.exitCode=1;}
