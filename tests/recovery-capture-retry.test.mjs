// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {HistoryDirectory,get,put} from './history-memory.mjs';
import {head as unarchivedHead,scene,note,inspect} from './portable-history-fixture.mjs';
import {retainLegacyState} from '../app/qa/legacy-journal-fixture.js';
const head=async label=>retainLegacyState(await unarchivedHead(label));
import {putSaved,workspaceHistory,recoveryIdentity} from '../app/storage.js';
import {retain} from '../app/handoff-store.js';
import {makeRecovery} from '../app/export.js';
import {identify,newReview} from '../app/model.js';
import {json,fileInfo,LIMITS} from '../app/workflow.js';
import * as recovery from '../app/folder-recovery.js';

globalThis.crypto??=webcrypto;
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,fn)=>fn()}}});
installMemoryIndexedDB();
const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
async function objects(dir){return(await(await dir.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');}
async function inventory(dir){return [...(await objects(dir)).children].map(([id,f])=>({id,size:f.blob.size})).sort((a,b)=>a.id.localeCompare(b.id));}
async function edit(record,n){const review=structuredClone(record.review);review.findings=[note(0,'SYNTHETIC durable correction '+n)];review.nextNumber=2;return retainLegacyState(await putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision));}
async function restart(){return import('../app/folder-recovery.js?retry='+crypto.randomUUID());}
async function later(fn){const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:['2030-01-02T03:04:05Z']));}static now(){return 1893553445000;}};try{return await fn();}finally{globalThis.Date=OriginalDate;}}
function failPublication(dir){dir.control.beforeClose=path=>{if(path.endsWith('/COMMIT.json'))throw Error('SYNTHETIC failed before COMMIT');};}

test('failed first save/restart reuses capture objects and preserves separate equal legacy saves',async()=>{
  let current=await head('first-save deterministic capture');current=await edit(current,1);
  const backupIds=[crypto.randomUUID(),crypto.randomUUID()];
  for(const id of backupIds)await retain({id,kind:'review-backup',createdAt:'2026-10-01T00:00:00Z',review:current.review,files:current.files});
  const dir=new HistoryDirectory();failPublication(dir);
  await assert.rejects(recovery.saveRecovery(dir,scene(current),paths),/SYNTHETIC failed/);
  const first=await inventory(dir);assert.equal(await recovery.readRecovery(dir),null);
  await later(async()=>{const fresh=await restart();await assert.rejects(fresh.saveRecovery(dir,scene(current),paths),/SYNTHETIC failed/);});
  assert.deepEqual(await inventory(dir),first,'a failed restart must not create new object identities');
  dir.control.beforeClose=null;
  const saved=await later(async()=>{const fresh=await restart();return fresh.saveRecovery(dir,scene(current),paths);});
  assert.deepEqual(await inventory(dir),first);
  assert.equal(saved.snapshot.manifest.records.length,3,'head and two genuine journal states, no retry-created legacy duplicates');
  assert.deepEqual(saved.snapshot.manifest.legacyEvidence.map(b=>b.legacyRecordId).sort(),backupIds.sort(),'equal review/time captures retain both original IDs');
  const manifests=await Promise.all(saved.snapshot.manifest.legacyEvidence.map(async b=>JSON.parse(await saved.snapshot.objects.get(b.payloads['manifest.json'].sha256).text())));
  assert.equal(new Set(manifests.map(m=>m.recoveryCapture.id)).size,2);assert(manifests.every(m=>m.createdAt==='2026-10-01T00:00:00Z'));
});

test('928-state migration retries within 2500-object / 383-MiB initial occupancy without losing evidence',async()=>{
  let current=await head('928-state bounded retry');for(let n=1;n<176;n++)current=await edit(current,n);
  const dir=new HistoryDirectory(),first=await recovery.saveRecovery(dir,scene(current),paths);
  const old=structuredClone(first.snapshot.manifest);delete old.historyBackfillVersion;
  const oldBlob=json(old);await put(dir,'.scorebrush/recovery/g-'+old.id+'/snapshot.json',oldBlob);
  await put(dir,'.scorebrush/recovery/g-'+old.id+'/COMMIT.json',json({schema:old.schema,version:old.version,id:old.id,manifestSha256:(await fileInfo(oldBlob)).sha256}));
  const legacyIds=[];
  for(let n=0;n<199;n++){
    const review=structuredClone(current.review);review.findings=[note(0,'SYNTHETIC old retained correction '+n)];
    for(const [path,blob]of await makeRecovery(review,current.files)){const info=await fileInfo(blob);await put(dir,'.scorebrush/recovery/objects/'+info.sha256,blob);if(path==='manifest.json')legacyIds.push('legacy-package:'+info.sha256);}
  }
  const store=await objects(dir),initial=await inventory(dir);
  for(let n=initial.length;n<2500;n++)await put(dir,'.scorebrush/recovery/objects/'+n.toString(16).padStart(64,'0'),new Blob(['SYNTHETIC orphan '+n]));
  // Budget-only orphan: no giant allocation and never declared by a manifest.
  // File System Access exposes .size independently; the physical budget must
  // count this evidence even though recovery never reads its unreferenced bytes.
  const padding=store.children.get((2499).toString(16).padStart(64,'0')),beforePadding=await inventory(dir),occupancy=383*1024*1024;
  padding.blob={size:occupancy-beforePadding.reduce((n,b)=>n+b.size,0)+padding.blob.size};
  const before=await inventory(dir);assert.equal(before.length,2500);assert.equal(before.reduce((n,b)=>n+b.size,0),occupancy);
  for(let n=176;n<728;n++)current=await edit(current,n);
  const expected=[current,...await workspaceHistory(current.id)];
  failPublication(dir);await assert.rejects(recovery.saveRecovery(dir,scene(current),paths,{expected:first.id}),/SYNTHETIC failed/);
  const failed=await inventory(dir);assert.equal((await recovery.readRecovery(dir)).manifest.id,first.id);
  dir.control.beforeClose=null;
  const saved=await later(async()=>{const fresh=await restart();return fresh.saveRecovery(dir,scene(current),paths,{expected:first.id});});
  assert.deepEqual(await inventory(dir),failed,'retry after module restart reuses every content-addressed object');
  const snapshot=await recovery.readRecovery(dir);let inspections=0;const decoded=await recovery.decodeRecovery(snapshot,async files=>{inspections++;return inspect(files);});
  assert.equal(inspections,1,'hundreds of notes on the same immutable score require one PDF inspection');
  assert.equal(snapshot.manifest.records.length+snapshot.manifest.legacyEvidence.length,928);
  assert.deepEqual(snapshot.manifest.legacyEvidence.map(b=>b.id).sort(),legacyIds.sort());
  assert.deepEqual(decoded.records.map(r=>({id:r.id,identity:recoveryIdentity(r),parent:r.parentHistoryId??null})).sort((a,b)=>a.id.localeCompare(b.id)),expected.map(r=>({id:r.id,identity:recoveryIdentity(r),parent:r.parentHistoryId??null})).sort((a,b)=>a.id.localeCompare(b.id)));
  assert(before.every(b=>failed.some(a=>a.id===b.id&&a.size===b.size)));
  assert(failed.length<=LIMITS.count);assert(failed.reduce((n,b)=>n+b.size,0)<LIMITS.total);
  // Crossing the unchanged byte budget must leave the new complete commit.
  padding.blob={size:LIMITS.total};const over=await inventory(dir);
  await assert.rejects(recovery.saveRecovery(dir,scene(current),paths,{expected:saved.id}),e=>e.name==='HistoryCapacityError'&&e.message.includes('storage exceeds'));
  assert.deepEqual(await inventory(dir),over);assert.equal((await recovery.readRecovery(dir)).manifest.id,saved.id);
  console.log('SYNTHETIC migration occupancy',JSON.stringify({initialObjects:before.length,initialBytes:occupancy,finalObjects:failed.length,finalBytes:failed.reduce((n,b)=>n+b.size,0),retainedStates:928}));
});


test('backfill retains changed bytes that claim the same local capture identity',async()=>{
  const current=await head('untrusted capture identity'),dir=new HistoryDirectory(),review=structuredClone(current.review);
  review.findings=[note(0,'SYNTHETIC different evidence claiming a known capture')];review.nextNumber=2;
  const payloads=await makeRecovery(review,current.files),manifest=JSON.parse(await payloads.get('manifest.json').text());
  manifest.recoveryCapture={kind:'workspace',id:current.id,revisionId:current.revisionId};
  manifest.createdAt=current.review.updatedAt;payloads.set('manifest.json',json(manifest));
  let evidenceId;
  for(const [path,blob]of payloads){const info=await fileInfo(blob);await put(dir,'.scorebrush/recovery/objects/'+info.sha256,blob);if(path==='manifest.json')evidenceId='legacy-package:'+info.sha256;}
  await put(dir,'.scorebrush/OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  const saved=await recovery.saveRecovery(dir,scene(current),paths),legacy=saved.snapshot.manifest.legacyEvidence;
  assert.deepEqual(legacy.map(b=>b.id),[evidenceId]);
  const annotations=JSON.parse(await saved.snapshot.objects.get(legacy[0].payloads['annotations.json'].sha256).text());
  assert.equal(annotations.findings[0].comment,review.findings[0].comment);
  assert.equal((await recovery.decodeRecovery(saved.snapshot,inspect)).records.find(r=>!r.kind).review.findings.length,0);
});


test('PDF inspection reuse distinguishes same-name changed bytes and page geometry',async()=>{
  const first=await head('inspection bytes and pages'),files={...first.files,rendered:{...first.files.rendered,blob:new Blob(['%PDF SYNTHETIC distinct multipage rendering'])}};
  const identified=await identify(files),pages=[...(await inspect()),{page:2,view:[0,0,700,900],rotation:0,userUnit:1}],review=newReview(identified.identity,identified.snapshotId,pages);
  const second=await putSaved({id:identified.snapshotId,files,review,revisionId:crypto.randomUUID(),completions:[],projectId:first.projectId,parentWorkspaceId:first.id},null);
  const dir=new HistoryDirectory(),saved=await recovery.saveRecovery(dir,scene(second),paths);let calls=0;
  const decoded=await recovery.decodeRecovery(saved.snapshot,async selected=>{calls++;return (await selected.rendered.blob.text()).includes('multipage')?pages:inspect();});
  assert.equal(calls,2);assert.equal(decoded.records.find(r=>r.id===first.id).review.pages.length,1);assert.equal(decoded.records.find(r=>r.id===second.id).review.pages.length,2);
  assert.equal(decoded.records.find(r=>r.id===second.id).review.pages[1].view[2],700);
});


test('PDF inspection cache keeps annotation validation and rejected inspections isolated',async()=>{
  const current=await head('inspection validation isolation'),dir=new HistoryDirectory(),{snapshot}=await recovery.saveRecovery(dir,scene(current),paths);
  await assert.rejects(recovery.decodeRecovery(snapshot,async()=>{throw Error('SYNTHETIC inspector failure');}),/SYNTHETIC inspector failure/);
  let calls=0;await recovery.decodeRecovery(snapshot,async files=>{calls++;return inspect(files);});assert.equal(calls,1,'a rejected previous decode does not poison the next call');
  const damaged=structuredClone(snapshot),record=damaged.manifest.records.find(r=>r.history),annotations=JSON.parse(await damaged.objects.get(record.payloads['annotations.json'].sha256).text());
  annotations.pages[0].view[2]++;
  const annotationBlob=json(annotations),info=await fileInfo(annotationBlob);damaged.objects.set(info.sha256,annotationBlob);record.payloads['annotations.json']=info;
  const manifest=JSON.parse(await damaged.objects.get(record.payloads['manifest.json'].sha256).text());manifest.payloads['annotations.json']=info;
  const manifestBlob=json(manifest),manifestInfo=await fileInfo(manifestBlob);damaged.objects.set(manifestInfo.sha256,manifestBlob);record.payloads['manifest.json']=manifestInfo;
  calls=0;await assert.rejects(recovery.decodeRecovery(damaged,async files=>{calls++;return inspect(files);}),/geometry|markings do not match/);assert.equal(calls,1,'cached PDF geometry does not skip validation of a later annotation record');
});

