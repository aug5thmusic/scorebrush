// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {zipFiles} from '../app/export.js';
import {LIMITS,validateExportPayloads,validateExportZip} from '../app/package-limits.js';
import {inspectZip,readZip} from '../app/workflow.js';

const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
const zero=new Blob(),large=new Blob([new Uint8Array(LIMITS.file)]);

test('STORE size preflight matches real nested ZIP serialization and import',async()=>{
  const payloads=new Map([['manifest.json',new Blob(['{}'])],['score/input/source.pdf',new Blob(['SYNTHETIC PDF bytes'])],['score/input/music.ly',new Blob(['% SYNTHETIC notation'])]]);
  const estimate=validateExportPayloads(payloads),zip=await zipFiles(payloads),parsed=await readZip(zip);
  assert.equal(zip.size,estimate.zipBytes);assert.equal(inspectZip(await zip.arrayBuffer()).length,payloads.size);
  for(const[path,blob]of payloads)assert.equal(await parsed.get(path).text(),await blob.text());
});

test('three individually supported 90 MiB files fail before serialization or byte reads',async()=>{
  let reads=0;const payload=new Blob([large.slice(0,90*1024*1024)]);payload.arrayBuffer=()=>{reads++;throw Error('Must reject before reading bytes');};
  const payloads=new Map(['source.pdf','rendered.pdf','score.ly'].map(path=>[path,payload]));
  await assert.rejects(zipFiles(payloads),/256 MB import limit/);assert.equal(reads,0);
});

test('STORE limit includes headers and accepts the exact final-byte boundary',()=>{
  const payloads=new Map([['a.pdf',large],['b.pdf',large],['c.ly',zero]]),headers=22+[...payloads.keys()].reduce((n,path)=>n+76+2*path.length,0);
  const remainder=LIMITS.zip-2*large.size-headers;
  payloads.set('c.ly',large.slice(0,remainder));assert.equal(validateExportPayloads(payloads).zipBytes,LIMITS.zip);
  payloads.set('c.ly',large.slice(0,remainder+1));assert.throws(()=>validateExportPayloads(payloads),/including ZIP headers/);
});

test('export enforces the importer entry, path, and individual-file boundaries',async()=>{
  const payloads=new Map(Array.from({length:LIMITS.count},(_,i)=>[`branch-${i}/score.ly`,zero]));
  const zip=await zipFiles(payloads);assert.equal(inspectZip(await zip.arrayBuffer()).length,LIMITS.count);
  payloads.set('extra.ly',zero);await assert.rejects(zipFiles(payloads),/5,000-file/);
  for(const entries of [[['../score.ly',zero]],[['score.ly',zero],['SCORE.ly',zero]],[['a//b.ly',zero]],[['score.ly',new Blob([large,'x'])]]])await assert.rejects(zipFiles(new Map(entries)),/unsafe|duplicate|100 MB/);
});

test('JSON roles are bounded before any backup or task archive is generated',async()=>{
  for(const [path,limit]of [['manifest.json',2*1024*1024],['history/task/manifest.json',2*1024*1024],['response.json',2*1024*1024],['annotations.json',LIMITS.json],['History.json',LIMITS.json],['task.json',LIMITS.json],['returned-workspace.json',LIMITS.json]]){
    assert.doesNotThrow(()=>validateExportPayloads(new Map([[path,large.slice(0,limit)]])),path+' exact boundary');
    await assert.rejects(zipFiles(new Map([[path,large.slice(0,limit+1)]])),/JSON import limit/,path+' overflow');
  }
});

test('final serialized archive is checked independently of preflight',async()=>{
  const oversized=new Blob([large,large,large]);assert.throws(()=>validateExportZip(oversized),/256 MB/);
  const real=globalThis.JSZip;
  globalThis.JSZip=class{file(){} async generateAsync(){return oversized;}};
  try{await assert.rejects(zipFiles(new Map([['score.ly',new Blob(['SYNTHETIC'])]])),/256 MB/);}finally{globalThis.JSZip=real;}
});
