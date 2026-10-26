// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {fixture} from './fast-resume-fixture.mjs';
import {put} from './history-memory.mjs';
import {json,fileInfo} from '../app/workflow.js';
import {readRecovery,decodeRecovery} from '../app/folder-recovery.js';
const mod={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(mod,mod.exports);globalThis.JSZip=mod.exports;
async function twoGenerations(){
  const f=await fixture(),blob=new Blob(['SYNTHETIC latest-only diagnostic object '+crypto.randomUUID()]),info=await fileInfo(blob),manifest={...structuredClone(f.snapshot.manifest),id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:f.snapshot.manifest.sequence+1};
  manifest.records.push({id:'SYNTHETIC-latest-only',payloads:{'annotations.json':info}});
  await put(f.directory,'.scorebrush/recovery/objects/'+info.sha256,blob);await f.commit(manifest);
  const objects=await(await(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');
  return {...f,blob,info,newest:manifest,objects};
}
for(const failure of ['NotReadableError','RangeError','OperationError'])test('operational '+failure+' on valid latest bytes must not fall back as corruption',async()=>{
  const f=await twoGenerations(),entry=await f.objects.getFileHandle(f.info.sha256),read=entry.getFile,digest=crypto.subtle.digest,operation=failure==='RangeError'?new RangeError('SYNTHETIC transient allocation failure'):new DOMException('SYNTHETIC transient read or crypto failure',failure);
  try{
    if(failure==='NotReadableError')entry.getFile=async()=>{throw operation;};
    if(failure==='RangeError')entry.getFile=async()=>({size:f.blob.size,arrayBuffer:async()=>{throw operation;}});
    if(failure==='OperationError')crypto.subtle.digest=async function(algorithm,data){if(data.byteLength===f.blob.size&&new TextDecoder().decode(data).startsWith('SYNTHETIC latest-only'))throw operation;return digest.call(this,algorithm,data);};
    let caught;try{await readRecovery(f.directory);}catch(error){caught=error;}
    assert(caught,'a valid older fallback must not hide an operational error');
    const chain=[caught,caught.cause,caught.cause?.cause].filter(Boolean);assert(chain.some(e=>e===operation||e.name===failure),failure+' cause must remain available');
    assert(!chain.some(e=>e.name==='RecoveryDataError'),'operational failures are not classified as damaged bytes');
    assert(JSON.stringify(caught).includes(f.newest.id)||caught.message.includes(f.newest.id),'generation context must be reported');
    assert(JSON.stringify(caught).includes(f.info.sha256)||caught.message.includes(f.info.sha256),'failing object path must be reported');
    assert.deepEqual(f.directory.control.writes,[]);
  }finally{entry.getFile=read;crypto.subtle.digest=digest;}
  assert.equal((await readRecovery(f.directory)).manifest.id,f.newest.id,'retry can read the same valid latest generation');
});
for(const damage of ['missing','hash','schema'])test('confirmed '+damage+' corruption preserves explicit generation/path/reason fallback diagnostics',async()=>{
  const f=await twoGenerations();
  if(damage==='missing')await f.objects.removeEntry(f.info.sha256);
  if(damage==='hash')await put(f.directory,'.scorebrush/recovery/objects/'+f.info.sha256,new Blob([new Uint8Array(f.blob.size).fill(88)]));
  if(damage==='schema'){f.newest.version=999;await f.commit(f.newest);}
  const recovered=await readRecovery(f.directory);assert.equal(recovered.manifest.id,f.snapshot.manifest.id);assert.deepEqual(recovered.damaged,[f.newest.id]);
  assert.equal(recovered.damageDetails?.length,1);const detail=recovered.damageDetails[0],text=JSON.stringify(detail);
  assert(text.includes(f.newest.id));assert(typeof detail.code==='string'&&detail.code.length);assert(text.includes(damage==='schema'?'snapshot.json':f.info.sha256),'diagnostic must identify the failing metadata or object');assert.deepEqual(f.directory.control.writes,[]);
});

test('metadata text allocation failure remains operational after its exact hash passes',async()=>{
  const f=await twoGenerations(),generation=await(await(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('g-'+f.newest.id),file=await generation.getFileHandle('snapshot.json'),blob=await file.getFile(),failure=new RangeError('SYNTHETIC snapshot text allocation');
  file.getFile=async()=>({size:blob.size,arrayBuffer:()=>blob.arrayBuffer(),text:async()=>{throw failure;}});
  let caught;try{await readRecovery(f.directory);}catch(error){caught=error;}assert(caught);const chain=[caught,caught.cause,caught.cause?.cause].filter(Boolean);
  assert(chain.some(error=>error===failure||error.name==='RangeError'));assert(!chain.some(error=>error.name==='RecoveryDataError'));
  const diagnostic=JSON.stringify(caught)+' '+caught.message;assert(diagnostic.includes(f.newest.id));assert(diagnostic.includes('snapshot.json'));assert.deepEqual(f.directory.control.writes,[]);
});

for(const field of ['projectId','sourceSha256','assetHash'])test('malformed object-valued '+field+' is schema damage, not an operational TypeError',async()=>{
  const f=await twoGenerations();if(field==='assetHash')f.newest.records.at(-1).payloads['annotations.json'].sha256={};else f.newest[field]={};await f.commit(f.newest);
  const recovered=await readRecovery(f.directory);assert.equal(recovered.manifest.id,f.snapshot.manifest.id);assert.deepEqual(recovered.damaged,[f.newest.id]);assert.equal(recovered.damageDetails.length,1);assert(recovered.damageDetails[0].code);assert.deepEqual(f.directory.control.writes,[]);
});

test('a mixed corrupt-and-operational read batch preserves the operational failure instead of falling back',async()=>{
  const f=await twoGenerations(),second=new Blob(['SYNTHETIC second latest-only operational object']),info=await fileInfo(second);
  f.newest.records.at(-1).payloads['second.json']=info;await put(f.directory,'.scorebrush/recovery/objects/'+info.sha256,second);await f.commit(f.newest);
  await put(f.directory,'.scorebrush/recovery/objects/'+f.info.sha256,new Blob([new Uint8Array(f.blob.size).fill(88)]));
  const handle=await f.objects.getFileHandle(info.sha256),failure=new DOMException('SYNTHETIC sibling read unavailable','NotReadableError');handle.getFile=async()=>{throw failure;};
  await assert.rejects(readRecovery(f.directory),error=>error.name==='NotReadableError'&&error.recoveryContext.generationId===f.newest.id&&error.recoveryContext.sha256===info.sha256);
  assert.deepEqual(f.directory.control.writes,[]);
});

test('full read and decode publish bounded progress while retaining exact failing record context',async()=>{
  const f=await fixture(),reads=[];await readRecovery(f.directory,{onProgress:p=>reads.push(p)});
  const counted=reads.filter(p=>p.phase==='read');assert(counted.length>=2);assert.equal(counted[0].done,0);assert.equal(counted.at(-1).done,counted.at(-1).total);assert(counted.every(p=>p.generationId===f.snapshot.manifest.id&&p.done<=p.total));
  const stages=[],inspect=async()=>[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}];
  const decoded=await decodeRecovery(f.snapshot,inspect,{onProgress:p=>stages.push(p)});assert.equal(decoded.records.length,1);assert.equal(stages.at(-1).done,stages.at(-1).total);assert(stages.at(-1).total>=2);
  const failure=new RangeError('SYNTHETIC PDF allocation failure');await assert.rejects(decodeRecovery(f.snapshot,async()=>{throw failure;}),error=>error===failure&&error.recoveryContext.generationId===f.snapshot.manifest.id&&error.recoveryContext.phase==='decode'&&error.recoveryContext.recordId===f.snapshot.manifest.headTaskId);
  let current=true,inspections=0;await assert.rejects(decodeRecovery(f.snapshot,async()=>{inspections++;return inspect();},{isCurrent:()=>current,onProgress:p=>{if(p.done===1)current=false;}}),/superseded/);assert.equal(inspections,1);assert.deepEqual(f.directory.control.writes,[]);
});

