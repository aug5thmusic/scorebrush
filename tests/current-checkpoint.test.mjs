// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './fast-resume-fixture.mjs';
import {put,get,HistoryDirectory} from './history-memory.mjs';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {head,note,scene as capture,inspect} from './portable-history-fixture.mjs';
import {putSaved} from '../app/storage.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {makeTask,seal,responseRevision} from '../app/workflow.js';
import {retain} from '../app/handoff-store.js';
import {workspaceSeed} from '../app/returned.js';
import {taskForScene,rawFolderResponse} from '../app/folder-workspace.js';
import {bookmark} from '../app/comparison-model.js';
import {sha256} from '../app/model.js';
import {canonical,stateHash,createCompletion,prepareCompletionState,validateCompletionBundle} from '../app/completion-model.js';
installMemoryIndexedDB();
import {readRecovery,decodeRecovery,saveRecovery} from '../app/folder-recovery.js';
import {writeCurrentCheckpoint,verifyCurrentCheckpoint,readCurrentCheckpoint,acknowledgeCurrentCheckpoint,overlayCurrentCheckpoint} from '../app/current-checkpoint.js';
const mod={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(mod,mod.exports);globalThis.JSZip=mod.exports;
function edit(f,n=2){const scene={...f.scene,review:{...f.scene.review,updatedAt:new Date(1792900000000+n*1000).toISOString()},revisionId:crypto.randomUUID(),persistedRevision:n,projectId:f.record.projectId};return {scene,record:{...f.record,...scene,id:scene.workspaceId,storageRevision:n}};}
async function trace(directory,path='',reads=[]){for(const[name,entry]of directory.children){if(entry.kind==='directory')await trace(entry,path+name+'/',reads);else{const original=entry.getFile;entry.getFile=async()=>{reads.push(path+name);return original();};}}return reads;}
test('ordinary checkpoint replaces current metadata, preserves archive, and resumes exact local state',async()=>{
  const f=await fixture(),{scene,record}=edit(f),before=await(await get(f.directory,'.scorebrush/recovery/g-'+f.config.recoveryId+'/snapshot.json')).text();
  const result=await writeCurrentCheckpoint(f.directory,scene,f.config);assert(result.id);assert.equal(result.snapshot.fullHistoryAudited,false);assert.equal(result.snapshot.manifest.records.length,1);assert.deepEqual(f.directory.control.writes,['.scorebrush/current-review.json']);
  assert.equal(await(await get(f.directory,'.scorebrush/recovery/g-'+f.config.recoveryId+'/snapshot.json')).text(),before);
  assert(await verifyCurrentCheckpoint(f.directory,scene,record,{...f.config,currentCheckpointId:result.id}));
  assert.equal(await verifyCurrentCheckpoint(f.directory,{...scene,revisionId:crypto.randomUUID()},record,{...f.config,currentCheckpointId:result.id}),null);
});
test('a foreign newer checkpoint rejects an older local review even while its archive publication still verifies',async()=>{
  const f=await fixture(),foreign=edit(f),result=await writeCurrentCheckpoint(f.directory,foreign.scene,f.config),count=f.directory.control.writes.length;
  assert(await f.verify(),'the prior archive and READY still describe the original local review');
  await assert.rejects(verifyCurrentCheckpoint(f.directory,f.scene,f.record,f.config),error=>error.name==='RecoveryConflict');
  assert.equal(f.directory.control.writes.length,count,'conflict neither changes current work nor repairs the older publication');
  const own={...f.config,currentCheckpointId:result.id},pending=edit(f,3);
  assert.equal(await verifyCurrentCheckpoint(f.directory,pending.scene,pending.record,own),null,'an observed checkpoint may trail unsaved local edits');
  assert(await verifyCurrentCheckpoint(f.directory,foreign.scene,foreign.record,f.config),'exact state can acknowledge an identical checkpoint');
});

test('checkpoint shortcut defers legacy directories to verified migration without writing',async()=>{
  const f=await fixture(),{scene,record}=edit(f);
  const result=await writeCurrentCheckpoint(f.directory,scene,f.config);
  const data=f.directory.children.get('.scorebrush');
  f.directory.children.set('.score-desk',data);f.directory.children.delete('.scorebrush');
  f.directory.control.writes=[];
  assert.equal(await verifyCurrentCheckpoint(f.directory,scene,record,{...f.config,currentCheckpointId:result.id}),null);
  assert.deepEqual(f.directory.control.writes,[]);
  assert.equal(f.directory.children.get('.score-desk'),data);
  assert.equal(f.directory.children.has('.scorebrush'),false);
});

test('current checkpoints preserve a distinct committed local lineage under the owned folder identity',async()=>{
  let record=await head('SYNTHETIC checkpoint legacy lineage '+crypto.randomUUID());
  const folderId=crypto.randomUUID(),localId=record.projectId,directory=new HistoryDirectory(),paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
  assert.notEqual(folderId,localId);
  const archived=await saveRecovery(directory,capture(record),paths,{projectId:folderId});
  assert.equal(archived.snapshot.manifest.projectId,folderId);
  assert.equal(archived.snapshot.manifest.records.find(item=>item.id===record.id).projectId,localId);
  record=await putSaved({...record,revisionId:crypto.randomUUID(),review:{...record.review,updatedAt:'2030-01-01T00:00:00Z',findings:[note(0,'SYNTHETIC current lineage note')],nextNumber:2}},record.storageRevision);
  const scene=capture(record),config={directory,paths,recoveryId:archived.id,projectId:folderId,workspaceId:record.id,boundSnapshotId:record.review.snapshotId,sourceSha256:record.review.files.source.sha256};
  const written=await writeCurrentCheckpoint(directory,scene,config),selected={...config,currentCheckpointId:written.id};
  assert.equal(written.checkpoint.projectId,folderId);assert.equal(written.checkpoint.recordProjectId,localId);
  directory.control.writes.length=0;
  const reopened=await readCurrentCheckpoint(directory);assert.equal(reopened.id,written.id);
  assert(await verifyCurrentCheckpoint(directory,scene,record,selected),'exact local lineage B must resume under its committed folder A');
  const unrelated=crypto.randomUUID();assert.notEqual(unrelated,folderId);assert.notEqual(unrelated,localId);
  assert.equal(await verifyCurrentCheckpoint(directory,scene,{...record,projectId:unrelated},selected),null,'unrelated local lineage C cannot inherit the checkpoint proof');
  assert.equal(await verifyCurrentCheckpoint(directory,scene,{...record,projectId:folderId},selected),null,'the folder identity cannot substitute for the committed local lineage');
  assert.deepEqual(directory.control.writes,[],'reopen verification never rewrites either identity or autosaves');
});

test('one hundred decisions read no archive manifests or old objects after the first checkpoint',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),config={...f.config,currentCheckpointId:first.id},reads=await trace(f.directory);
  for(let n=3;n<103;n++){const result=await writeCurrentCheckpoint(f.directory,edit(f,n).scene,config);config.currentCheckpointId=result.id;}
  assert(!reads.some(path=>path.endsWith('/snapshot.json')),'archive metadata is pinned once per session');
  const current=f.snapshot.manifest.records[0],allowed=new Set(['annotations.json','source-original.pdf','rendered-original.pdf','lilypond/supplied.ly'].map(path=>current.payloads[path].sha256));
  assert(reads.filter(path=>path.includes('/objects/')).every(path=>allowed.has(path.split('/').at(-1))));
  assert.equal(f.directory.control.writes.length,101);assert(f.directory.control.writes.every(path=>path==='.scorebrush/current-review.json'));
});
test('checkpoint CAS rejects a stale writer without replacing saved current work',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),text=await(await get(f.directory,'.scorebrush/current-review.json')).text(),count=f.directory.control.writes.length;
  await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,f.config),/different changes/);assert.equal(await(await get(f.directory,'.scorebrush/current-review.json')).text(),text);assert.equal(f.directory.control.writes.length,count);
  const repeat=await writeCurrentCheckpoint(f.directory,first.checkpoint?{...edit(f).scene,review:first.checkpoint.review,revisionId:first.checkpoint.revisionId}:null,f.config);assert.equal(repeat.id,first.id);assert.equal(f.directory.control.writes.length,count);
});

test('checkpoint identity is durably prepared before replacement and a failed preparation leaves the file unchanged',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),config={...f.config,currentCheckpointId:first.id};
  const before=await(await get(f.directory,'.scorebrush/current-review.json')).text(),writes=f.directory.control.writes.length;let prepared=false;
  await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,config,{beforeWrite:async id=>{
    assert.match(id,/^[a-f0-9]{64}$/);assert.notEqual(id,first.id);
    assert.equal(await(await get(f.directory,'.scorebrush/current-review.json')).text(),before);
    prepared=true;throw Error('SYNTHETIC settings commit failed');
  }}),/settings commit failed/);
  assert(prepared);assert.equal(await(await get(f.directory,'.scorebrush/current-review.json')).text(),before);assert.equal(f.directory.control.writes.length,writes);
});

test('restart after file commit but before acknowledgement preserves a newer local edit and still rejects a foreign writer',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config);let durable={...f.config,currentCheckpointId:first.id},newer;
  f.directory.control.beforeClose=async path=>{if(path.endsWith('current-review.json'))newer=edit(f,4);};
  const second=await writeCurrentCheckpoint(f.directory,edit(f,3).scene,durable,{beforeWrite:async id=>{durable={...durable,pendingCheckpointId:id};}});
  f.directory.control.beforeClose=null;
  assert.equal(durable.currentCheckpointId,first.id);assert.equal(durable.pendingCheckpointId,second.id);
  assert.equal(await verifyCurrentCheckpoint(f.directory,newer.scene,newer.record,durable),null,'known in-flight checkpoint may trail the newer locally saved edit');
  const resumed=await writeCurrentCheckpoint(f.directory,newer.scene,durable);
  assert.equal(resumed.checkpoint.revisionId,newer.scene.revisionId);assert.deepEqual(resumed.checkpoint.review,newer.scene.review);
  const foreign=await writeCurrentCheckpoint(f.directory,edit(f,5).scene,{...durable,currentCheckpointId:resumed.id,pendingCheckpointId:null});
  await assert.rejects(verifyCurrentCheckpoint(f.directory,newer.scene,newer.record,durable),/different changes/);
  await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,6).scene,durable),/different changes/);
  assert.equal((await readCurrentCheckpoint(f.directory)).id,foreign.id,'pending intent never grants permission to overwrite an unrelated checkpoint');
});

test('restart before the prepared replacement commits accepts the previous checkpoint or an initially absent file',async()=>{
  for(const existing of [false,true]){
    const f=await fixture(),first=existing?await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config):null;let durable={...f.config,currentCheckpointId:first?.id??null};
    f.directory.control.beforeClose=async path=>{if(path.endsWith('current-review.json'))throw Error('SYNTHETIC process exit before close');};
    await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,durable,{beforeWrite:async id=>{durable={...durable,pendingCheckpointId:id};}}),/process exit/);
    assert.match(durable.pendingCheckpointId,/^[a-f0-9]{64}$/);f.directory.control.beforeClose=null;
    assert.equal((await readCurrentCheckpoint(f.directory))?.id??null,first?.id??null);
    const newer=edit(f,4);assert.equal(await verifyCurrentCheckpoint(f.directory,newer.scene,newer.record,durable),null);
    const saved=await writeCurrentCheckpoint(f.directory,newer.scene,durable);assert.equal(saved.checkpoint.revisionId,newer.scene.revisionId);
  }
});

test('a retry interrupted before close retains the previously pending checkpoint as its durable predecessor',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config);let durable={...f.config,currentCheckpointId:first.id};
  const prepare=async(id,previousId)=>{durable={...durable,currentCheckpointId:previousId,pendingCheckpointId:id};};
  const second=await writeCurrentCheckpoint(f.directory,edit(f,3).scene,durable,{beforeWrite:prepare});
  assert.equal(durable.currentCheckpointId,first.id);assert.equal(durable.pendingCheckpointId,second.id);
  f.directory.control.beforeClose=async path=>{if(path.endsWith('current-review.json'))throw Error('SYNTHETIC second interruption');};
  await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,4).scene,durable,{beforeWrite:prepare}),/second interruption/);
  assert.equal(durable.currentCheckpointId,second.id,'retry preparation promotes the verified disk ID before replacing the pending ID');
  assert.notEqual(durable.pendingCheckpointId,second.id);f.directory.control.beforeClose=null;
  const latest=edit(f,5);assert.equal(await verifyCurrentCheckpoint(f.directory,latest.scene,latest.record,durable),null);
  assert.equal((await writeCurrentCheckpoint(f.directory,latest.scene,durable,{beforeWrite:prepare})).checkpoint.revisionId,latest.scene.revisionId);
});
test('current input corruption and a changed archive commitment reject before checkpoint publication',async()=>{
  for(const mode of ['input','commit']){const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),count=f.directory.control.writes.length;
    if(mode==='input'){const info=f.snapshot.manifest.records[0].payloads['rendered-original.pdf'];await put(f.directory,'.scorebrush/recovery/objects/'+info.sha256,new Blob([new Uint8Array(info.size)]));}
    else await f.commit({...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.config.recoveryId,sequence:2});
    await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,{...f.config,currentCheckpointId:first.id}));assert.equal(f.directory.control.writes.length,count);
  }
});
test('interruption preserves the prior checkpoint; edit during atomic close returns the committed ID as superseded',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),before=await(await get(f.directory,'.scorebrush/current-review.json')).text(),config={...f.config,currentCheckpointId:first.id};
  f.directory.control.beforeClose=async path=>{if(path.endsWith('current-review.json'))throw Error('SYNTHETIC interrupted close');};await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,config),/interrupted/);assert.equal(await(await get(f.directory,'.scorebrush/current-review.json')).text(),before);
  let current=true;f.directory.control.beforeClose=async path=>{if(path.endsWith('current-review.json'))current=false;};const result=await writeCurrentCheckpoint(f.directory,edit(f,3).scene,config,{isCurrent:()=>current});assert(result.superseded);assert.equal(JSON.parse(await(await get(f.directory,'.scorebrush/current-review.json')).text()).id,result.id);
});
test('full recovery overlays current state in memory and retirement requires exact archive coverage',async()=>{
  const f=await fixture(),{scene}=edit(f),result=await writeCurrentCheckpoint(f.directory,scene,f.config);
  await assert.rejects(acknowledgeCurrentCheckpoint(f.directory,f.snapshot,{expectedId:result.id}),/different changes/);
  const overlay=await overlayCurrentCheckpoint(f.snapshot,result),decoded=await decodeRecovery(overlay,async()=>scene.review.pages),record=decoded.records.find(item=>item.id===scene.workspaceId);assert.equal(record.revisionId,scene.revisionId);assert.deepEqual(record.review,scene.review);assert.equal(f.snapshot.manifest.records[0].revisionId,f.scene.revisionId,'raw archive object is not changed');
  const manifest={...overlay.manifest,id:crypto.randomUUID(),parent:f.config.recoveryId,sequence:2};for(const[hash,blob]of overlay.objects)await put(f.directory,'.scorebrush/recovery/objects/'+hash,blob);await f.commit(manifest);const archived=await readRecovery(f.directory);
  await acknowledgeCurrentCheckpoint(f.directory,archived,{expectedId:result.id});assert.equal(await readCurrentCheckpoint(f.directory),null);assert(JSON.parse(await(await get(f.directory,'.scorebrush/current-review.json')).text()).retired);
});

test('external checkpoint edits retaining the same ID cannot be adopted or overwritten',async()=>{
  const f=await fixture(),first=await writeCurrentCheckpoint(f.directory,edit(f).scene,f.config),value=JSON.parse(await(await get(f.directory,'.scorebrush/current-review.json')).text());value.review.updatedAt='2040-01-01T00:00:00Z';await put(f.directory,'.scorebrush/current-review.json',new Blob([JSON.stringify(value)]));const before=f.directory.control.writes.length;
  await assert.rejects(readCurrentCheckpoint(f.directory),/identity/);await assert.rejects(writeCurrentCheckpoint(f.directory,edit(f,3).scene,{...f.config,currentCheckpointId:first.id}),/identity/);assert.equal(f.directory.control.writes.length,before);
});

const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
async function packageMaker(review,files){const payloads=await makeRecovery(review,files);for(const finding of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(finding.number).padStart(3,'0')}-${finding.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));}
async function returnedFixture(){
  let original=await head('SYNTHETIC mutable checkpoint '+crypto.randomUUID()),review=structuredClone(original.review);review.findings=[note(0,'SYNTHETIC original correction')];review.nextNumber=2;original=await putSaved({...original,review,revisionId:crypto.randomUUID()},original.storageRevision);
  const issued=await makeTask(original.review,original.files,{},'120',()=>{},packageMaker);await retain(issued);
  const files={...original.files,rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC newly rendered version'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC changed LilyPond'])}},parsed=await rawFolderResponse(issued,files,{zip:zipFiles}),response=responseRevision(parsed);await retain(response);
  const seed=await workspaceSeed(response,issued,inspect),record=await putSaved({...seed,id:seed.returned.id,projectId:original.projectId,parentWorkspaceId:original.id,revisionId:crypto.randomUUID(),completions:[]},null),scene=capture(record),task=await taskForScene(scene,{packageMaker}),directory=new HistoryDirectory(),paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'},saved=await saveRecovery(directory,scene,paths,{head:task});
  return {record,scene,directory,snapshot:saved.snapshot,config:{directory,paths,recoveryId:saved.id,projectId:saved.projectId,workspaceId:record.id,boundSnapshotId:record.review.snapshotId,sourceSha256:record.review.files.source.sha256}};
}
test('returned decisions, new associated annotations, draft text and display bookmarks save without mutating original finding evidence',async()=>{
  const f=await returnedFixture(),scene={...f.scene,review:structuredClone(f.scene.review),returned:structuredClone(f.scene.returned),revisionId:crypto.randomUUID(),persistedRevision:f.scene.persistedRevision+1},finding=scene.returned.reported[0],added=note(7,'SYNTHETIC new annotation');scene.review.findings.push(added);scene.review.nextNumber=9;scene.review.updatedAt='2030-01-01T00:00:00Z';
  finding.associationId=added.id;finding.explanation='SYNTHETIC reviewer explanation';finding.draftKind='needs_correction';finding.state='resolved';finding.decision={state:'resolved',explanation:finding.explanation,at:'2030-01-01T00:00:00Z',reviewed:{snapshotId:scene.review.snapshotId,codeSha256:scene.review.files.ly.sha256,renderSha256:scene.review.files.rendered.sha256}};scene.returned.locations={[finding.id]:bookmark(finding.id,scene.review,{page:1,zoom:1,point:[50,60]})};
  const result=await writeCurrentCheckpoint(f.directory,scene,f.config),read=await readCurrentCheckpoint(f.directory);assert.deepEqual(JSON.parse(JSON.stringify(read.checkpoint.returned)),JSON.parse(JSON.stringify(scene.returned)));const overlay=await overlayCurrentCheckpoint(f.snapshot,result),decoded=await decodeRecovery(overlay,inspect);assert.deepEqual(decoded.records.find(item=>item.id===scene.workspaceId).review,scene.review);
  for(const mutate of [s=>s.returned.reported[0].comment='SYNTHETIC changed original text',s=>s.returned.reported[0].agent={status:'unreviewed',explanation:'forged'},s=>s.returned.reported[0].decision.reviewed.renderSha256='a'.repeat(64),s=>s.returned.locations[finding.id].candidate.snapshotId='a'.repeat(64)]){const bad=structuredClone(scene);mutate(bad);bad.revisionId=crypto.randomUUID();await assert.rejects(writeCurrentCheckpoint(f.directory,bad,{...f.config,currentCheckpointId:result.id}));}
});

test('checkpoint preparation and each fresh disk read hash the current state once without reusing a changed annotation',async()=>{
  const f=await fixture(),{scene}=edit(f);scene.review={...scene.review,findings:[note(0,'SYNTHETIC first note')],nextNumber:2};
  const annotations=structuredClone(scene.review);delete annotations.createdAt;delete annotations.updatedAt;
  const expected=Buffer.from(canonical({annotations,returned:null})),subtle=crypto.subtle,original=subtle.digest.bind(subtle);let stateDigests=0;
  subtle.digest=async(algorithm,bytes)=>{const view=bytes instanceof ArrayBuffer?new Uint8Array(bytes):new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength);if(Buffer.from(view).equals(expected))stateDigests++;return original(algorithm,bytes);};
  let first;
  try{
    first=await writeCurrentCheckpoint(f.directory,scene,f.config);assert.equal(stateDigests,1,'one computed state digest belongs to the captured preparation');
    const restored=await readCurrentCheckpoint(f.directory);assert.equal(restored.id,first.id);assert.equal(stateDigests,2,'fresh disk contents require a new state digest');
    assert.deepEqual(JSON.parse(await restored.snapshot.objects.get(restored.snapshot.manifest.records[0].payloads['completion-history.json'].sha256).text()).stateSha256,first.stateSha256);
  }finally{subtle.digest=original;}
  scene.review.findings[0].comment='SYNTHETIC changed note';scene.revisionId=crypto.randomUUID();scene.persistedRevision++;
  const second=await writeCurrentCheckpoint(f.directory,scene,{...f.config,currentCheckpointId:first.id});
  assert.notEqual(second.stateSha256,first.stateSha256);assert.notEqual(second.id,first.id);
  assert.equal((await readCurrentCheckpoint(f.directory)).checkpoint.review.findings[0].comment,scene.review.findings[0].comment);
});

test('completion preparation owns its inputs and preserves the legacy state digest including returned changes',async()=>{
  const f=await returnedFixture(),review=structuredClone(f.scene.review),returned=structuredClone(f.scene.returned),before=structuredClone({review,returned});
  const pending=prepareCompletionState(review,returned,f.scene.revisionId,[]);
  review.updatedAt='2035-01-01T00:00:00Z';returned.reported[0].explanation='SYNTHETIC changed while preparation was pending';
  const prepared=await pending;assert.deepEqual(prepared.review,before.review);assert.deepEqual(prepared.returned,before.returned);
  const annotations=structuredClone(before.review),round=structuredClone(before.returned);delete annotations.createdAt;delete annotations.updatedAt;delete round.id;delete round.recoveredFrom;
  assert.equal(prepared.bundle.stateSha256,await sha256(new TextEncoder().encode(canonical({annotations,returned:round}))),'existing state identities stay byte-compatible');
  const next=await prepareCompletionState(review,returned,f.scene.revisionId,[]);assert.notEqual(next.bundle.stateSha256,prepared.bundle.stateSha256);
  assert.equal(next.bundle.stateSha256,await stateHash(review,returned));
  await assert.rejects(validateCompletionBundle(prepared.bundle,review,returned),/hashes/,'a bundle cannot supply a trusted digest for changed returned content');
});

test('prepared completion records retain exact evidence and still reject changed annotations, findings, totals and hashes',async()=>{
  const f=await fixture(),{scene}=edit(f);scene.review={...scene.review,findings:[note(0,'SYNTHETIC completed note')],nextNumber:2};
  const record=await createCompletion(scene,{scope:'partial',note:'SYNTHETIC bounded review',reviewer:'Synthetic'},{id:crypto.randomUUID(),createdAt:'2030-01-01T00:00:00Z'});
  const prepared=await prepareCompletionState(scene.review,null,scene.revisionId,[record]);
  assert.deepEqual(prepared.bundle.records,[record]);assert.notEqual(prepared.bundle.records[0],record);
  const completed=await writeCurrentCheckpoint(f.directory,{...scene,completions:[record]},f.config);
  assert.equal(JSON.stringify((await readCurrentCheckpoint(f.directory)).checkpoint.completions),JSON.stringify([record]),'disk parsing preserves every completion field and its ordering');
  const before=await(await get(f.directory,'.scorebrush/current-review.json')).text();
  for(const mutate of [r=>r.evidence.annotations.findings[0].comment='SYNTHETIC changed evidence',r=>r.evidence.annotations.updatedAt='2040-01-01T00:00:00Z',r=>r.findings[0].comment='SYNTHETIC changed finding',r=>r.totals.all++,r=>r.hashes.annotations='a'.repeat(64),r=>r.hashes.state='b'.repeat(64)]){
    const bad=structuredClone(record);mutate(bad);
    await assert.rejects(prepareCompletionState(scene.review,null,scene.revisionId,[bad]),/hashes/);
    await assert.rejects(writeCurrentCheckpoint(f.directory,{...scene,completions:[bad]},{...f.config,currentCheckpointId:completed.id}),/hashes/);
    assert.equal(await(await get(f.directory,'.scorebrush/current-review.json')).text(),before,'invalid completion must not replace the current checkpoint');
  }
});

test('a resealed checkpoint ID cannot hide a stale state hash for annotation or returned content',async()=>{
  for(const mode of ['annotation','returned']){
    const f=mode==='returned'?await returnedFixture():await fixture(),scene=mode==='returned'?f.scene:edit(f).scene;
    if(mode==='annotation')scene.review={...scene.review,findings:[note(0,'SYNTHETIC original annotation')],nextNumber:2};
    const first=await writeCurrentCheckpoint(f.directory,scene,f.config),value=JSON.parse(await(await get(f.directory,'.scorebrush/current-review.json')).text());
    if(mode==='annotation')value.review.findings[0].comment='SYNTHETIC tampered annotation';else value.returned.reported[0].explanation='SYNTHETIC tampered returned explanation';
    value.id=await sha256(new TextEncoder().encode(canonical(Object.fromEntries(Object.entries(value).filter(([key])=>!['id','retired','archivedBy'].includes(key))))));
    assert.notEqual(value.id,first.id);await put(f.directory,'.scorebrush/current-review.json',new Blob([JSON.stringify(value)]));
    await assert.rejects(readCurrentCheckpoint(f.directory),/hashes/,'disk state must be recomputed even after outer identity was changed to match');
  }
});
