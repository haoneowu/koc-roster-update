import {createHash} from 'node:crypto';
import {access,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const MODULE_DIR=path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT=path.resolve(MODULE_DIR,'..');
const SUPPORTED_NODE_MAJOR=26;

function sha256(value){return createHash('sha256').update(value).digest('hex');}

const DEFAULT_RUNTIME_ENTRIES=Object.freeze([
  'bootstrap-background.mjs',
  'initialize-base.mjs',
  'connect-browser.mjs',
  'capture-source-session.mjs',
  'koc-contact/readiness-live-server.mjs',
  'koc-contact/readiness-live-probe.mjs',
  'koc-contact/run-daily-inventory.mjs',
  'koc-contact/run-koc-one-shot.mjs',
  'koc-contact/run-canary-single-target-production.mjs',
  'koc-contact/run-canary-parallel-production.mjs',
  'koc-roster/capture-source.mjs',
  'koc-contact/update-runtime-release.mjs',
]);
const ALLOWED_EXTERNAL_RUNTIME_FILES=Object.freeze(new Set([
  '../koc-fresh-runtime/src/lark-json-file-transport.mjs',
]));

function inside(root,file){return file===root||file.startsWith(`${root}${path.sep}`);}

function skipTrivia(source,start){
  let index=start;
  while(index<source.length){
    if(/\s/u.test(source[index])){index++;continue;}
    if(source.startsWith('//',index)){
      const end=source.indexOf('\n',index+2);
      index=end<0?source.length:end+1;
      continue;
    }
    if(source.startsWith('/*',index)){
      const end=source.indexOf('*/',index+2);
      if(end<0)return source.length;
      index=end+2;
      continue;
    }
    break;
  }
  return index;
}

function readQuotedLiteral(source,start){
  const quote=source[start];
  let index=start+1;
  while(index<source.length){
    if(source[index]==='\\')return null;
    if(source[index]===quote)return {value:source.slice(start+1,index),end:index+1};
    if(source[index]==='\n'||source[index]==='\r')return null;
    index++;
  }
  return null;
}

function dynamicImportSpecifiers(source){
  const specifiers=[];

  function scanCode(start,stopAtTemplateBrace=false){
    let index=start;
    let braceDepth=0;
    while(index<source.length){
      const character=source[index];
      if(character==='/'&&source[index+1]==='/'){
        const end=source.indexOf('\n',index+2);
        index=end<0?source.length:end+1;
        continue;
      }
      if(character==='/'&&source[index+1]==='*'){
        const end=source.indexOf('*/',index+2);
        if(end<0)return source.length;
        index=end+2;
        continue;
      }
      if(character==='\''||character==='"'){
        let end=index+1;
        while(end<source.length){
          if(source[end]==='\\'){end+=2;continue;}
          if(source[end]===character){end++;break;}
          end++;
        }
        index=end;
        continue;
      }
      if(character==='`'){
        index++;
        while(index<source.length){
          if(source[index]==='\\'){index+=2;continue;}
          if(source[index]==='`'){index++;break;}
          if(source[index]==='$'&&source[index+1]==='{'){
            index=scanCode(index+2,true);
            continue;
          }
          index++;
        }
        continue;
      }
      if(stopAtTemplateBrace&&character==='}'){
        if(braceDepth===0)return index+1;
        braceDepth--;
        index++;
        continue;
      }
      if(stopAtTemplateBrace&&character==='{'){
        braceDepth++;
        index++;
        continue;
      }
      if(/[A-Za-z_$]/u.test(character)){
        const startIdentifier=index++;
        while(index<source.length&&/[A-Za-z0-9_$]/u.test(source[index]))index++;
        if(source.slice(startIdentifier,index)!=='import')continue;
        const open=skipTrivia(source,index);
        if(source[open]!=='(')continue;
        const argument=skipTrivia(source,open+1);
        if(source[argument]!=='\''&&source[argument]!=='"')
          throw new Error('KOC_RUNTIME_RELEASE_DYNAMIC_IMPORT_UNRESOLVED');
        const literal=readQuotedLiteral(source,argument);
        if(!literal)throw new Error('KOC_RUNTIME_RELEASE_DYNAMIC_IMPORT_UNRESOLVED');
        const afterLiteral=skipTrivia(source,literal.end);
        if(source[afterLiteral]!==')'&&source[afterLiteral]!==',')
          throw new Error('KOC_RUNTIME_RELEASE_DYNAMIC_IMPORT_UNRESOLVED');
        specifiers.push(literal.value);
        continue;
      }
      index++;
    }
    return index;
  }

  scanCode(0);
  return specifiers;
}

async function runtimeModuleGraph(root,entrypoints){
  const files=new Set(['package.json']);
  const externalFiles=new Set();
  try{await access(path.join(root,'package-lock.json'));files.add('package-lock.json');}catch{}
  const pending=[...entrypoints];
  while(pending.length){
    const relative=pending.pop();
    if(files.has(relative))continue;
    const absolute=path.resolve(root,relative);
    if(!inside(root,absolute)||absolute===root||!['.mjs','.js','.json'].includes(path.extname(absolute))||
      absolute.endsWith('.test.mjs'))throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
    const actual=await realpath(absolute);
    if(!inside(root,actual)||actual===root)throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
    const source=await readFile(absolute,'utf8');
    files.add(relative);
    const dependencies=new Set();
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/gu)){
      if(match[1].startsWith('.'))dependencies.add(match[1]);
    }
    for(const match of source.matchAll(/new\s+URL\(\s*['"]([^'"]+\.mjs)['"]/gu)){
      if(match[1].startsWith('.'))dependencies.add(match[1]);
    }
    for(const specifier of dynamicImportSpecifiers(source)){
      if(!specifier.startsWith('.'))
        throw new Error('KOC_RUNTIME_RELEASE_DYNAMIC_IMPORT_UNSUPPORTED');
      dependencies.add(specifier);
    }
    for(const dependency of dependencies){
      const targetUrl=new URL(dependency,pathToFileURL(absolute));
      if(targetUrl.protocol!=='file:')throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
      const target=path.resolve(fileURLToPath(targetUrl));
      const targetRelative=path.relative(root,target).split(path.sep).join('/');
      if(!inside(root,target)){
        if(!ALLOWED_EXTERNAL_RUNTIME_FILES.has(targetRelative))
          throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
        const actual=await realpath(target);
        if(actual!==target||!target.endsWith('.mjs'))
          throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
        const externalSource=await readFile(actual,'utf8');
        const externalHasRelativeImports=[
          ...externalSource.matchAll(/(?:\bfrom\s*|\bimport\s*)['"]([^'"]+)['"]/gu),
          ...externalSource.matchAll(/new\s+URL\(\s*['"]([^'"]+\.mjs)['"]/gu),
        ].some(match=>match[1].startsWith('.'));
        if(externalHasRelativeImports||dynamicImportSpecifiers(externalSource).length)
          throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
        externalFiles.add(targetRelative);
        continue;
      }
      if(target===root)throw new Error('KOC_RUNTIME_RELEASE_ENTRY_INVALID');
      pending.push(targetRelative);
    }
  }
  return {files:[...files].sort(),externalFiles:[...externalFiles].sort()};
}

async function writeAtomically(file,contents){
  const temporary=`${file}.${process.pid}.tmp`;
  await writeFile(temporary,contents,{mode:0o644,flag:'wx'});
  await rename(temporary,file);
}

/** Build a local, SHA-pinned release manifest for all KOC runtime modules. */
export async function updateKocRuntimeRelease({root=DEFAULT_ROOT,skillVersion='0.6.2',
  date=new Date().toISOString().slice(0,10),runtimeEntries=DEFAULT_RUNTIME_ENTRIES,
  changeSummary='Preserve retry provenance, use a canonical Buyin detail route for missing temporary templates, and report fixed-session preflight failures safely.'}={}){
  if(Number(process.versions.node.split('.')[0])!==SUPPORTED_NODE_MAJOR)
    throw new Error('KOC_RUNTIME_RELEASE_NODE_UNSUPPORTED');
  const resolvedRoot=await realpath(path.resolve(root));
  const packagePath=path.join(resolvedRoot,'package.json');
  const packageJson=JSON.parse(await readFile(packagePath,'utf8'));
  if(typeof changeSummary!=='string'||!changeSummary.trim())throw new Error('KOC_RUNTIME_RELEASE_CHANGE_SUMMARY_INVALID');
  if(!/^\d+\.\d+\.\d+$/u.test(packageJson.version||'')||!/^\d+\.\d+\.\d+$/u.test(skillVersion))
    throw new Error('KOC_RUNTIME_RELEASE_VERSION_INVALID');
  const runtimeGraph=await runtimeModuleGraph(resolvedRoot,runtimeEntries);
  const files={};
  for(const relative of runtimeGraph.files){
    files[relative]=sha256(await readFile(path.join(resolvedRoot,relative)));
  }
  const externalFiles={};
  for(const relative of runtimeGraph.externalFiles){
    externalFiles[relative]=sha256(await readFile(path.resolve(resolvedRoot,relative)));
  }
  const manifest={formatVersion:1,title:'KOC Runtime Release',owner:'APU Workshop',status:'production_candidate',
    updated:date,runtimeReleaseVersion:packageJson.version,packageVersion:packageJson.version,
    skillVersion,supportedNodeMajor:SUPPORTED_NODE_MAJOR,
    entrypoints:[...runtimeEntries],files,externalFiles,
    changeLog:[{date,summary:changeSummary.trim()}]};
  const manifestBytes=`${JSON.stringify(manifest,null,2)}\n`;
  const manifestSha256=sha256(manifestBytes);
  await writeAtomically(path.join(resolvedRoot,'koc-contact/runtime-release.json'),manifestBytes);
  await writeAtomically(path.join(resolvedRoot,'koc-contact/runtime-release-pin.json'),
    `${JSON.stringify({manifestSha256},null,2)}\n`);
  return {passed:true,runtimeReleaseVersion:manifest.runtimeReleaseVersion,skillVersion,
    packageVersion:packageJson.version,nodeVersion:process.versions.node,manifestSha256,filesChecked:Object.keys(files).length};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv.slice(2).includes('--write')){
    process.stdout.write(`${JSON.stringify({passed:false,reason:'KOC_RUNTIME_RELEASE_WRITE_FLAG_REQUIRED'})}\n`);
    process.exitCode=2;
  }else updateKocRuntimeRelease().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{
    const reason=/^KOC_RUNTIME_RELEASE_[A-Z0-9_]+$/u.test(String(error?.message||''))?
      error.message:'KOC_RUNTIME_RELEASE_UPDATE_FAILED';
    process.stdout.write(`${JSON.stringify({passed:false,reason})}\n`);process.exitCode=1;
  });
}
