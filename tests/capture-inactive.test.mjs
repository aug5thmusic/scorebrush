// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// This stage's capture core must remain disconnected until integration is reviewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,relative,dirname,sep} from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url)),app=resolve(root,'app');
const inactive=new Set(['capture-format.js','capture-store.js','capture-adapter.js','capture-publication.js','capture-folder.js','capture-repair.js','capture-pool.js']);
const core=new Set(['capture-format.js','capture-store.js']);
const adapterDependencies=new Set(['capture-format.js','capture-store.js','model.js','completion-model.js','comparison-model.js','project-identity.js']);
const additions=['app/capture-format.js','app/capture-store.js','app/capture-adapter.js','app/capture-publication.js','app/capture-folder.js','app/capture-repair.js','app/capture-pool.js','tests/capture-format.test.mjs','tests/capture-core-browser-tests.mjs','tests/capture-adapter-browser-tests.mjs','tests/capture-publication-browser-tests.mjs','tests/capture-repair-browser-tests.mjs','tests/capture-pool-browser-tests.mjs','tests/capture-reader-2e-browser-tests.mjs','tests/capture-inactive.test.mjs'];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const relativeApp=path=>relative(app,path).split(sep).join('/');

// Recognize the literal import/worker forms used by this first-party source.
// Unknown executable loaders fail closed rather than being omitted from the graph.
function dependencies(source,name){
  const refs=[];
  for(const match of source.matchAll(/\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?['"]([^'"\n]+)['"]/g))refs.push(match[1]);
  for(const match of source.matchAll(/\bimport\s*\(/g)){
    const call=source.slice(match.index),literal=call.match(/^import\s*\(\s*(['"])([^'"\n]+)\1\s*\)/);
    assert(literal,`${name}: nonliteral dynamic import needs an explicit audit`);refs.push(literal[2]);
  }
  for(const match of source.matchAll(/\bimportScripts\s*\(/g)){
    const call=source.slice(match.index),literal=call.match(/^importScripts\s*\(\s*(['"])([^'"\n]+)\1\s*\)/);
    assert(literal,`${name}: nonliteral worker import needs an explicit audit`);refs.push(literal[2]);
  }
  for(const match of source.matchAll(/\bnew\s+(?:SharedWorker|Worker)\s*\(/g)){
    const call=source.slice(match.index),literal=call.match(/^new\s+(?:SharedWorker|Worker)\s*\(\s*new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/);
    assert(literal,`${name}: unknown worker entry needs an explicit audit`);refs.push(literal[2]);
  }
  assert(!/\b(?:eval|Function)\s*\(|\bserviceWorker\b|createElement\s*\(\s*['"]script['"]/.test(source),`${name}: executable loader requires an explicit audit`);
  if(name==='pdf-resources.js'){
    assert(source.includes("const resource=path=>new URL('./vendor/'+path,import.meta.url).href;"),'PDF resource helper remains confined to bundled vendor assets');
    assert(source.includes("pdfWorkerUrl=resource('pdf.worker.mjs')"),'PDF worker remains the bundled literal worker');
    refs.push('./vendor/pdf.worker.mjs');
  }
  return [...new Set(refs)];
}

test('ordinary startup and proofreading import graph cannot reach the inactive capture core',async t=>{
  const html=await readFile(resolve(app,'index.html'),'utf8');
  const entries=[...html.matchAll(/<script\b[^>]*\bsrc=['"]([^'"]+)['"][^>]*>\s*<\/script>/gi)].map(m=>m[1]);
  assert.deepEqual(entries,['startup.js','vendor/pdf-lib.min.js','vendor/jszip.min.js','app.js']);
  assert.equal([...html.matchAll(/<script\b/gi)].length,entries.length,'no unaccounted inline entry');
  const inventory=JSON.parse(await readFile(resolve(root,'third-party/vendor-inventory.json'),'utf8'));
  const pinned=new Map(inventory.files.map(row=>[row.file,row]));
  const pending=entries.map(path=>resolve(app,path)),seen=new Set(),edges=[];
  while(pending.length){
    const path=pending.pop(),name=relativeApp(path);
    assert(!name.startsWith('../')&&!name.startsWith('/'),'entry stays inside app');
    if(seen.has(name))continue;seen.add(name);
    assert(!inactive.has(name),`capture is reachable through ${name}`);
    const bytes=await readFile(path),source=bytes.toString('utf8');
    if(name.startsWith('vendor/')){
      const pin=pinned.get('app/'+name);assert(pin,`vendor executable lacks pinned inventory: ${name}`);
      assert.equal(bytes.length,pin.bytes);assert.equal(digest(bytes),pin.sha256,`vendor executable unchanged: ${name}`);
      continue;
    }
    assert(!/capture-(?:format|store|adapter|publication|folder|repair|pool)\.js/.test(source),`${name} must not mention a capture module`);
    for(const ref of dependencies(source,name)){
      assert(ref.startsWith('./')||ref.startsWith('../'),`${name}: imports must remain local`);
      const target=resolve(dirname(path),ref);edges.push([name,relativeApp(target)]);pending.push(target);
    }
  }
  for(const name of ['app.js','startup.js','storage.js','findings-model.js','evidence-worker.js','vendor/pdf.worker.mjs'])assert(seen.has(name),`graph includes ${name}`);
  // Also protect disconnected first-party modules from creating a future hidden bridge.
  for(const name of await readdir(app))if(name.endsWith('.js')&&!inactive.has(name)){
    const source=await readFile(resolve(app,name),'utf8');
    assert(!/capture-(?:format|store|adapter|publication|folder|repair|pool)\.js/.test(source),`${name}: inactive capture import/reference`);
    dependencies(source,name);
  }
  t.diagnostic(JSON.stringify({entries,reachableFiles:seen.size,edges:edges.length,inactiveReachable:false}));
});

test('production storage opener remains the exact version-5 implementation',async()=>{
  const bytes=await readFile(resolve(app,'storage.js'));
  assert.equal(digest(bytes),'788662614aded76cf5b3dc94a7c30cf6bc7d298bb9512683beff5082654e2b76','inactive stage must not change the production opener or persistence');
  assert.match(bytes.toString('utf8'),/indexedDB\.open\('private-score-desk-local-v1',5\)/);
});

test('capture modules import without opening storage or installing browser hooks',async()=>{
  const touched=[],saved=new Map();
  for(const name of ['indexedDB','document','window','localStorage','sessionStorage']){
    saved.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    Object.defineProperty(globalThis,name,{configurable:true,get(){touched.push(name);throw new Error('Unexpected import-time browser access: '+name);}});
  }
  try{
    for(const name of inactive){
      const source=await readFile(resolve(app,name),'utf8');
      assert(!/indexedDB\s*\.\s*open\s*\(/.test(source),`${name} may not hide a database opener`);
      const allowed=name==='capture-adapter.js'?adapterDependencies:name==='capture-folder.js'?new Set(['capture-format.js','capture-publication.js','capture-repair.js','capture-pool.js']):name==='capture-pool.js'?new Set(['capture-format.js']):name==='capture-repair.js'?new Set(['capture-format.js','capture-store.js','capture-publication.js']):name==='capture-publication.js'?new Set(['capture-format.js','capture-store.js','capture-adapter.js']):core;
      for(const ref of dependencies(source,name))assert(allowed.has(relativeApp(resolve(app,ref))),`${name} has an unreviewed dependency`);
      await import(new URL('../app/'+name,import.meta.url));
    }
    assert.deepEqual(touched,[]);
  }finally{
    for(const [name,descriptor]of saved){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
  }
});

test('new maintained files have narrow export entries and first-party license headers',async()=>{
  const reviewed=JSON.parse(await readFile(resolve(root,'public-source-files.json'),'utf8')).files;
  const git=await readFile(resolve(root,'.gitignore'),'utf8');
  for(const path of additions){
    assert.equal(reviewed.filter(value=>value===path).length,1,`one reviewed export entry: ${path}`);
    assert(git.split('\n').includes('!/'+path),`one literal git allowlist entry: ${path}`);
    const source=await readFile(resolve(root,path),'utf8');
    assert(source.startsWith('// SPDX-License-Identifier: AGPL-3.0-or-later\n// Copyright (C) 2026 Auggie (@aug5thmusic).\n// Additional permissions: see LICENSING.md at the source root.\n'),`license header: ${path}`);
    assert(!source.includes('\r'),`first-party LF bytes: ${path}`);
  }
});
