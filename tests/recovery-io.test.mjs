// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {File} from 'node:buffer';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {HistoryDirectory,get,put} from './history-memory.mjs';
import {head,scene,note} from './portable-history-fixture.mjs';
import {putSaved} from '../app/storage.js';
import {makeRecovery} from '../app/export.js';
import {json,fileInfo} from '../app/workflow.js';
import {saveRecovery,readRecovery} from '../app/folder-recovery.js';

globalThis.crypto??=webcrypto;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,fn)=>fn()}}});installMemoryIndexedDB();
const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(label){let record=await head(label);for(let n=0;n<12;n++){const review=structuredClone(record.review);review.findings=[note(0,'SYNTHETIC retained note '+n)];review.nextNumber=2;record=await putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision);}const directory=new HistoryDirectory(),first=await saveRecovery(directory,scene(record),paths),objects=await(await(await directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');return {record,directory,first,objects};}
function trace(objects,latency=3){const stats={active:0,maximum:0,started:0,finished:0};for(const entry of objects.children.values()){const original=entry.getFile;entry.getFile=async()=>{stats.started++;stats.maximum=Math.max(stats.maximum,++stats.active);try{await delay(latency);return await original();}finally{stats.active--;stats.finished++;}};}return stats;}

test('recovery bounds parallel disk reads and reports completed verification progress',async()=>{
  const {record,directory,first,objects}=await fixture('bounded I/O'),stats=trace(objects),progress=[];
  const saved=await saveRecovery(directory,scene(record),paths,{expected:first.id,onProgress:p=>progress.push(p)});
  assert(stats.maximum>1&&stats.maximum<=4);assert.equal(stats.active,0);assert.equal(stats.started,stats.finished);
  for(const phase of ['budget','records','verify','commit']){const points=progress.filter(p=>p.phase===phase);assert(points.length);assert.equal(points.at(-1).done,points.at(-1).total);assert(points.every((p,n)=>!n||p.done>=points[n-1].done));}
  assert.equal((await readRecovery(directory)).manifest.id,saved.id);
});

for(const phase of ['budget','verify'])test('cancel during '+phase+' stops after its current batch and drains all reads',async()=>{
  const {record,directory,first,objects}=await fixture('cancel '+phase),stats=trace(objects,8);let current=true,readsAtPhase=0;
  const before=await(await get(directory,'.scorebrush/recovery/g-'+first.id+'/COMMIT.json')).text();
  await assert.rejects(saveRecovery(directory,scene(record),paths,{expected:first.id,isCurrent:()=>current,onProgress:p=>{if(p.phase===phase&&p.done===0)readsAtPhase=stats.started;if(p.phase===phase&&p.done>0)current=false;}}),/superseded/);
  assert(stats.started-readsAtPhase>0&&stats.started-readsAtPhase<=4);assert.equal(stats.active,0);assert.equal(stats.started,stats.finished);
  const stopped=stats.started;await delay(25);assert.equal(stats.started,stopped,'no background reads may start after cancellation rejects');
  assert.equal(await(await get(directory,'.scorebrush/recovery/g-'+first.id+'/COMMIT.json')).text(),before);assert.equal((await readRecovery(directory)).manifest.id,first.id);
});

test('fresh final verification catches same-size tampering after a cached snapshot',async()=>{
  const {record,directory,first,objects}=await fixture('fresh read tamper'),hash=first.snapshot.manifest.records[0].payloads['source-original.pdf'].sha256,entry=objects.children.get(hash),original=entry.blob;
  const commitPath='.scorebrush/recovery/g-'+first.id+'/COMMIT.json',before=await(await get(directory,commitPath)).text();let changed=false;
  await assert.rejects(saveRecovery(directory,scene(record),paths,{expected:first.id,onProgress:p=>{if(p.phase==='verify'&&!changed){changed=true;entry.blob=new Blob([new Uint8Array(original.size).fill(88)]);}}}),/asset write verification failed/);
  assert.equal(await(await get(directory,commitPath)).text(),before);entry.blob=original;assert.equal((await readRecovery(directory)).manifest.id,first.id);
});

test('legacy disk Files become owned verified Blobs before derived publication',async()=>{
  const {record,directory,first,objects}=await fixture('legacy owned bytes'),old=structuredClone(first.snapshot.manifest);delete old.historyBackfillVersion;
  const oldBlob=json(old);await put(directory,'.scorebrush/recovery/g-'+old.id+'/snapshot.json',oldBlob);await put(directory,'.scorebrush/recovery/g-'+old.id+'/COMMIT.json',json({schema:old.schema,version:1,id:old.id,manifestSha256:(await fileInfo(oldBlob)).sha256}));
  const review=structuredClone(record.review);review.findings=[note(0,'SYNTHETIC older disk-backed finding')];
  for(const blob of(await makeRecovery(review,record.files)).values()){const info=await fileInfo(blob);await put(directory,'.scorebrush/recovery/objects/'+info.sha256,new File([blob],info.sha256));}
  const saved=await saveRecovery(directory,scene(record),paths,{expected:first.id});assert.equal(saved.snapshot.manifest.legacyEvidence.length,1);
  assert([...saved.snapshot.objects.values()].every(blob=>Object.prototype.toString.call(blob)==='[object Blob]'));
  const legacy=saved.snapshot.manifest.legacyEvidence[0],hash=legacy.payloads['annotations.json'].sha256,protectedBytes=await saved.snapshot.objects.get(hash).text();objects.children.get(hash).blob=new File(['SYNTHETIC external replacement'],hash);
  assert.equal(await saved.snapshot.objects.get(hash).text(),protectedBytes,'post-verification disk replacement cannot change published snapshot bytes');
});


test('oversized replaced assets reject before reading their bytes',async()=>{
  const {record,directory,first,objects}=await fixture('oversized changed asset'),hash=first.snapshot.manifest.records[0].payloads['source-original.pdf'].sha256,entry=objects.children.get(hash),original=entry.blob;let reads=0;
  const oversized={size:original.size+100000000,arrayBuffer:async()=>{reads++;throw Error('Oversized bytes should never be read');}};
  await assert.rejects(saveRecovery(directory,scene(record),paths,{expected:first.id,onProgress:p=>{if(p.phase==='verify')entry.blob=oversized;}}),/asset write verification failed/);assert.equal(reads,0);
  await assert.rejects(readRecovery(directory),/No complete valid/);assert.equal(reads,0);entry.blob=original;
});

test('an earlier invalid legacy size cannot poison a later valid package sharing the object',async()=>{
  const {record,directory,first}=await fixture('legacy cache independent sizes'),old=structuredClone(first.snapshot.manifest);delete old.historyBackfillVersion;
  const oldBlob=json(old);await put(directory,'.scorebrush/recovery/g-'+old.id+'/snapshot.json',oldBlob);await put(directory,'.scorebrush/recovery/g-'+old.id+'/COMMIT.json',json({schema:old.schema,version:1,id:old.id,manifestSha256:(await fileInfo(oldBlob)).sha256}));
  const review=structuredClone(record.review);review.findings=[note(0,'SYNTHETIC valid legacy state after malformed metadata')];const payloads=await makeRecovery(review,record.files),validManifest=payloads.get('manifest.json'),bad=JSON.parse(await validManifest.text());bad.payloads['annotations.json'].size++;
  const wrong=json(bad),wrongInfo=await fileInfo(wrong);await put(directory,'.scorebrush/recovery/objects/'+wrongInfo.sha256,wrong);
  for(const blob of payloads.values()){const info=await fileInfo(blob);await put(directory,'.scorebrush/recovery/objects/'+info.sha256,blob);}
  const saved=await saveRecovery(directory,scene(record),paths,{expected:first.id}),expected='legacy-package:'+(await fileInfo(validManifest)).sha256;
  assert(saved.snapshot.manifest.legacyEvidence.some(b=>b.id===expected),'the later valid original package remains indexed');
});


test('in-flight cancellation waits for every started peer before rejecting',async()=>{
  const {record,directory,first,objects}=await fixture('in-flight drain');let current=true,active=0,started=0,settled=false,releasePeers,firstCancelled;
  const peers=new Promise(resolve=>releasePeers=resolve),cancelled=new Promise(resolve=>firstCancelled=resolve),restore=[];
  for(const [index,entry]of [...objects.children.values()].entries()){
    const original=entry.getFile;restore.push(()=>entry.getFile=original);
    entry.getFile=async()=>{started++;active++;try{if(index===0){await delay(5);current=false;firstCancelled();}else await peers;return await original();}finally{active--;}};
  }
  const pending=saveRecovery(directory,scene(record),paths,{expected:first.id,isCurrent:()=>current});pending.then(()=>settled=true,()=>settled=true);
  await cancelled;await delay(15);assert.equal(started,4);assert.equal(active,3);assert.equal(settled,false,'rejection must wait for still-running peers');
  releasePeers();await assert.rejects(pending,/superseded/);assert.equal(active,0);assert.equal(started,4);
  const stopped=started;await delay(20);assert.equal(started,stopped);for(const undo of restore)undo();assert.equal((await readRecovery(directory)).manifest.id,first.id);
});
