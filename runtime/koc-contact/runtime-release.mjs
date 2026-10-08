import {createHash} from 'node:crypto';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const MODULE_DIR=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT=path.resolve(MODULE_DIR,'..');
const MANIFEST_NAME='koc-contact/runtime-release.json';
const PIN_NAME='koc-contact/runtime-release-pin.json';
const SAFE_ERROR=/^KOC_RUNTIME_RELEASE_[A-Z0-9_]+$/u;
const ALLOWED_EXTERNAL_RUNTIME_FILES=new Set([
  '../koc-fresh-runtime/src/lark-json-file-transport.mjs',
]);

function sha256(value){return createHash('sha256').update(value).digest('hex');}
function fail(code){throw new Error(code);}
const SUPPORTED_NODE_MAJOR=26;

async function readJson(file,reason){
  try{return JSON.parse(await readFile(file,'utf8'));}
  catch{fail(reason);}
}

async function boundedFilePath(root,relative,missingCode='KOC_RUNTIME_RELEASE_FILE_MISSING'){
  const candidate=safeRelativeFile(root,relative);
  let actual;
  try{actual=await realpath(candidate);}
  catch{fail(missingCode);}
  if(actual===root||!actual.startsWith(`${root}${path.sep}`))fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
  return actual;
}

function safeRelativeFile(root,relative){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||
    relative.split(/[\\/]/u).some(part=>part==='..'||part===''))fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
  const resolved=path.resolve(root,relative);
  if(resolved!==root&&!resolved.startsWith(`${root}${path.sep}`))fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
  return resolved;
}

/** Check the installed release pin, manifest, package version, Node major and every runtime source hash. */
export async function verifyKocRuntimeRelease({root=DEFAULT_ROOT}={}){
  const absoluteRoot=path.resolve(root);
  let resolvedRoot;
  try{resolvedRoot=await realpath(absoluteRoot);}
  catch{fail('KOC_RUNTIME_RELEASE_MANIFEST_MISSING');}
  const manifestPath=await boundedFilePath(resolvedRoot,MANIFEST_NAME,'KOC_RUNTIME_RELEASE_MANIFEST_MISSING');
  const pinPath=await boundedFilePath(resolvedRoot,PIN_NAME,'KOC_RUNTIME_RELEASE_PIN_MISSING');
  let manifestBytes;
  try{manifestBytes=await readFile(manifestPath);}
  catch{fail('KOC_RUNTIME_RELEASE_MANIFEST_MISSING');}
  const manifestSha256=sha256(manifestBytes);
  const pin=await readJson(pinPath,'KOC_RUNTIME_RELEASE_PIN_MISSING');
  if(!/^[a-f0-9]{64}$/u.test(pin?.manifestSha256||'')||pin.manifestSha256!==manifestSha256)
    fail('KOC_RUNTIME_RELEASE_PIN_MISMATCH');
  let manifest;
  try{manifest=JSON.parse(manifestBytes.toString('utf8'));}
  catch{fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');}
  if(manifest?.formatVersion!==1||typeof manifest.runtimeReleaseVersion!=='string'||
    typeof manifest.skillVersion!=='string'||!Number.isInteger(manifest.supportedNodeMajor)||
    !Array.isArray(manifest.entrypoints)||manifest.entrypoints.length<1||
    !manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files)||
    Object.keys(manifest.files).length<1)fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
  const packagePath=await boundedFilePath(resolvedRoot,'package.json','KOC_RUNTIME_RELEASE_PACKAGE_INVALID');
  const packageJson=await readJson(packagePath,
    'KOC_RUNTIME_RELEASE_PACKAGE_INVALID');
  if(packageJson?.version!==manifest.packageVersion)fail('KOC_RUNTIME_RELEASE_PACKAGE_MISMATCH');
  const nodeMajor=Number(process.versions.node.split('.')[0]);
  if(manifest.supportedNodeMajor!==SUPPORTED_NODE_MAJOR||nodeMajor!==SUPPORTED_NODE_MAJOR)
    fail('KOC_RUNTIME_RELEASE_NODE_UNSUPPORTED');
  const files=Object.entries(manifest.files).sort(([left],[right])=>left.localeCompare(right));
  for(const [relative,expected] of files){
    if(!/^[a-f0-9]{64}$/u.test(expected||''))fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
    const filePath=await boundedFilePath(resolvedRoot,relative);
    let contents;
    try{contents=await readFile(filePath);}
    catch{fail('KOC_RUNTIME_RELEASE_FILE_MISSING');}
    if(sha256(contents)!==expected)fail('KOC_RUNTIME_RELEASE_FILE_HASH_MISMATCH');
  }
  const externalFiles=manifest.externalFiles??{};
  if(!externalFiles||typeof externalFiles!=='object'||Array.isArray(externalFiles))
    fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
  for(const [relative,expected] of Object.entries(externalFiles)){
    if(!ALLOWED_EXTERNAL_RUNTIME_FILES.has(relative)||!/^[a-f0-9]{64}$/u.test(expected||''))
      fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
    const filePath=path.resolve(resolvedRoot,relative);
    const allowedPath=path.resolve(resolvedRoot,'../koc-fresh-runtime/src/lark-json-file-transport.mjs');
    let actual;
    try{actual=await realpath(filePath);}
    catch{fail('KOC_RUNTIME_RELEASE_FILE_MISSING');}
    if(filePath!==allowedPath||actual!==filePath)fail('KOC_RUNTIME_RELEASE_MANIFEST_INVALID');
    let contents;
    try{contents=await readFile(filePath);}
    catch{fail('KOC_RUNTIME_RELEASE_FILE_MISSING');}
    if(sha256(contents)!==expected)fail('KOC_RUNTIME_RELEASE_FILE_HASH_MISMATCH');
  }
  return {passed:true,runtimeReleaseVersion:manifest.runtimeReleaseVersion,skillVersion:manifest.skillVersion,
    packageVersion:manifest.packageVersion,nodeVersion:process.versions.node,manifestSha256,
    filesChecked:files.length+Object.keys(externalFiles).length};
}

export function safeRuntimeReleaseReason(error){
  const reason=String(error?.message||'');
  return SAFE_ERROR.test(reason)?reason:'KOC_RUNTIME_RELEASE_VERIFICATION_FAILED';
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyKocRuntimeRelease().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{
    process.stdout.write(`${JSON.stringify({passed:false,reason:safeRuntimeReleaseReason(error)})}\n`);
    process.exitCode=1;
  });
}
