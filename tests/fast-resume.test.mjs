// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {identify} from '../app/model.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fixture} from './fast-resume-fixture.mjs';
import {captureResumeProof,verifyFastResume as productionFastResume} from '../app/fast-resume.js';
import {verifySavedFolder} from '../app/folder-workspace.js';
import {get,put,HistoryDirectory} from './history-memory.mjs';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {evidence,head,scene as capture,note,inspect} from './portable-history-fixture.mjs';
import {readRecovery,saveRecovery} from '../app/folder-recovery.js';
import {syncProjectHistory} from '../app/project-history.js';
import {preparePdfOutput,syncPdfVersions} from '../app/pdf-versions.js';
import {syncFinishedPDF} from '../app/finished-pdf.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {putSaved} from '../app/storage.js';
import {retain} from '../app/handoff-store.js';
import {makeTask,responseRevision,seal,fileInfo} from '../app/workflow.js';
import {workspaceSeed} from '../app/returned.js';
import {taskForScene,rawFolderResponse,writeLatestTask} from '../app/folder-workspace.js';
installMemoryIndexedDB();
async function createResumeProof(selected,scene,record,options={}){
  const snapshot=await readRecovery(selected.directory);if(!snapshot)return null;let publication;
  if(!await verifySavedFolder(selected,scene,record,snapshot,options,{onVerified:value=>{publication=value;}}))return null;
  return captureResumeProof(selected,scene,record,snapshot,{pdfVersions:publication?.pdfVersions});
}
const verifyFastResume=(selected,scene,record,proof,options={})=>productionFastResume(selected,scene,record,proof,options,verifySavedFolder);
const mod={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(mod,mod.exports);globalThis.JSZip=mod.exports;
async function ready(f){const proof=await createResumeProof(f.config,f.scene,f.record);assert(proof);f.directory.control.writes.length=0;return {proof,verify:(scene=f.scene,record=f.record,config=f.config)=>verifyFastResume(config,scene,record,proof)};}
async function legacy(f){const old=await evidence(f.record,'SYNTHETIC independent older historical evidence'),manifest=structuredClone(f.snapshot.manifest);manifest.id=crypto.randomUUID();manifest.parent=f.snapshot.manifest.id;manifest.sequence++;manifest.legacyEvidence=[old.bundle];
  for(const [path,blob]of old.payloads){const info=old.bundle.payloads[path];f.snapshot.objects.set(info.sha256,blob);await put(f.directory,'.scorebrush/recovery/objects/'+info.sha256,blob);}f.snapshot.manifest=manifest;f.config.recoveryId=manifest.id;await f.commit(manifest);const versions=await syncPdfVersions(f.directory,f.snapshot);await syncProjectHistory(f.directory,f.snapshot,{pdfVersions:versions.versions});return old;
}
async function trace(dir,prefix='',reads=[]){for(const[name,entry]of dir.children){const path=prefix+name;if(entry.kind==='directory')await trace(entry,path+'/',reads);else{const original=entry.getFile;entry.getFile=async()=>{reads.push(path);return original();};}}return reads;}
test('known unchanged publication verifies only its required current closure and performs zero writes',async()=>{
  const f=await fixture(),old=await legacy(f),{verify}=await ready(f),reads=await trace(f.directory),result=await verify();assert(result);assert.equal(result.fullHistoryAudited,false);assert(!Object.hasOwn(result,'snapshot'));assert.deepEqual(f.directory.control.writes,[]);
  assert(!reads.some(path=>path.endsWith('/'+old.bundle.payloads['annotations.json'].sha256)),'unused historical annotation bytes are not read');
  for(const name of Object.values(f.config.paths))await put(f.directory,name,new Blob(['SYNTHETIC newer mutable input']));assert(await verify());
});
test('missing or changed current and derived bytes cannot pass the fast proof',async()=>{
  const f=await fixture(),{verify}=await ready(f),current=f.snapshot.manifest.records[0];
  const names=['.scorebrush/recovery/objects/'+current.payloads['annotations.json'].sha256,'.scorebrush/recovery/objects/'+current.payloads['source-original.pdf'].sha256,'.scorebrush/latest/READY.json','.scorebrush/latest/task.json','.scorebrush/latest/lilypond/supplied.ly','REVIEW_THIS.md','History.json','.scorebrush/history-index.json','.scorebrush/pdf-names.json','Versions/0001 - Etude.pdf'];
  for(const path of names){const bytes=await get(f.directory,path);await put(f.directory,path,new Blob(['SYNTHETIC changed bytes']));let accepted=false;try{accepted=Boolean(await verify());}catch{}assert.equal(accepted,false,path);await put(f.directory,path,bytes);}assert(await verify());assert.deepEqual(f.directory.control.writes,[]);
});
test('all existing Versions copies and owned collisions retain their existing guarantees',async()=>{
  const f=await fixture(),{verify}=await ready(f);for(const n of ['extra.pdf','EXTRA.pdf','Caf\u00e9.pdf','Cafe\u0301.pdf'])await put(f.directory,'Versions/'+n,new Blob(['SYNTHETIC unrelated']));assert(await verify());
  await put(f.directory,'Versions/0001 - ETUDE.pdf',new Blob(['SYNTHETIC alias']));await assert.rejects(verify(),/ambiguous owned filename/);assert.deepEqual(f.directory.control.writes,[]);
});
test('pending state, additive evidence and changed current state invalidate the proof',async()=>{
  const f=await fixture(),{verify}=await ready(f);assert.equal(await verify(f.scene,f.record,{...f.config,pendingHead:f.config.head,pendingStamp:f.scene.stamp}),null);
  const extra=await evidence(f.record,'SYNTHETIC later import');assert.equal(await verify(f.scene,{...f.record,retainedLegacyEvidence:[extra]}),null);assert.equal(await verify(f.scene,{...f.record,retainedHandoffEvidence:[{bundle:{id:'new evidence'},payloads:new Map()}]}),null);
  for(const mutate of [s=>s.revisionId=crypto.randomUUID(),s=>s.review.updatedAt='2030-01-01T00:00:00Z',s=>s.persistedRevision++]){const scene=structuredClone(f.scene);mutate(scene);assert.equal(await verify(scene),null);}assert.deepEqual(f.directory.control.writes,[]);
});
test('changed generation, competing head and changed bytes under the same generation cannot reuse proof',async()=>{
  for(const mode of ['new','fork','same-id']){const f=await fixture(),{verify}=await ready(f),child=structuredClone(f.snapshot.manifest);if(mode==='same-id')child.createdAt='2030-01-01T00:00:00Z';else{child.id=crypto.randomUUID();child.parent=f.snapshot.manifest.id;child.sequence++;}await f.commit(child);if(mode==='fork')await f.commit({...child,id:crypto.randomUUID()});let accepted=false;try{accepted=Boolean(await verify());}catch{}assert.equal(accepted,false,mode);assert.deepEqual(f.directory.control.writes,[]);}
});
test('deferred historical corruption is detected by the unchanged full recovery path',async()=>{
  const f=await fixture(),old=await legacy(f),{verify,proof}=await ready(f),hash=old.bundle.payloads['annotations.json'].sha256;await put(f.directory,'.scorebrush/recovery/objects/'+hash,new Blob(['SYNTHETIC historical corruption']));assert(await verify(),'current publication proof does not assert historical integrity');const full=await readRecovery(f.directory);assert.notEqual(full.manifest.id,proof.generationId);assert(full.damaged.includes(proof.generationId));assert.deepEqual(f.directory.control.writes,[]);
});
const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
async function packageMaker(review,files){const payloads=await makeRecovery(review,files);for(const f of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(f.number).padStart(3,'0')}-${f.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));}
async function approvedFixture(){let original=await head('SYNTHETIC fast resume approved fixture '+crypto.randomUUID());const review=structuredClone(original.review);review.findings=[note(0,'SYNTHETIC correction')];review.nextNumber=2;original=await putSaved({...original,review,revisionId:crypto.randomUUID()},original.storageRevision);
  const issued=await makeTask(original.review,original.files,{},'120',()=>{},packageMaker);await retain(issued);const files={...original.files,rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC corrected rendering'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC corrected code'])}};
  const parsed=await rawFolderResponse(issued,files,{zip:zipFiles}),response=responseRevision(parsed);await retain(response);const seed=await workspaceSeed(response,issued,inspect),finding=seed.returned.reported[0];finding.state='resolved';finding.decision={state:'resolved',reviewed:{snapshotId:seed.review.snapshotId,codeSha256:seed.returned.codeSha256,renderSha256:seed.returned.renderSha256}};
  const record=await putSaved({...seed,id:seed.returned.id,projectId:original.projectId,parentWorkspaceId:original.id,revisionId:crypto.randomUUID(),completions:[]},null),scene={...capture(record),stamp:{snapshotId:record.review.snapshotId,workspaceId:record.id,revision:1}},task=await taskForScene(scene,{packageMaker}),directory=new HistoryDirectory(),paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
  const saved=await saveRecovery(directory,scene,paths,{head:task}),versions=await syncPdfVersions(directory,saved.snapshot);await syncProjectHistory(directory,saved.snapshot,{pdfVersions:versions.versions});await syncFinishedPDF(directory,saved.snapshot,{pdfVersions:versions.versions});const published=await writeLatestTask(directory,task,paths);
  const config={directory,paths,projectId:saved.projectId,recoveryId:saved.id,sourceSha256:scene.review.files.source.sha256,boundSnapshotId:scene.review.snapshotId,workspaceId:scene.workspaceId,head:published.entry,headStamp:scene.stamp};return {directory,scene,record,config,snapshot:saved.snapshot};
}
test('approved Latest bytes, receipt and the structure of every older Versions copy stay mandatory',async()=>{
  const f=await approvedFixture(),{verify,proof}=await ready(f);assert(proof.finished);assert.equal(proof.pdfVersions.length,2,'fixture includes an older owned Versions copy');assert(await verify());
  const paths=['Latest/'+proof.finished.name,'.scorebrush/finished-pdf.json',...proof.pdfVersions.map(v=>v.path)];for(const path of paths){const bytes=await get(f.directory,path);await put(f.directory,path,new Blob([new Uint8Array(bytes.size+1).fill(88)]));let accepted=false;try{accepted=Boolean(await verify());}catch{}assert.equal(accepted,false,path);await put(f.directory,path,bytes);}assert(await verify());assert.deepEqual(f.directory.control.writes,[]);
});

test('generation or READY changing during the proof cannot authorize readiness',async()=>{
  for(const mode of ['generation','ready']){const f=await fixture(),{verify}=await ready(f);let fired=false;const versions=await f.directory.getDirectoryHandle('Versions'),file=await versions.getFileHandle('0001 - Etude.pdf'),original=file.getFile;
    file.getFile=async()=>{if(!fired){fired=true;if(mode==='generation')await f.commit({...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:2});else{const path='.scorebrush/latest/READY.json',ready=JSON.parse(await(await get(f.directory,path)).text());ready.generationId=crypto.randomUUID();await put(f.directory,path,new Blob([JSON.stringify(ready)]));}}return original();};
    assert.equal(await verify(),null,mode);assert(fired);assert.deepEqual(f.directory.control.writes,[]);
  }
});

test('valid new handoff evidence already present before proof creation requires publication',async()=>{
  const f=await fixture(),task=await makeTask(f.record.review,f.record.files,{instructions:'SYNTHETIC additional handoff evidence'},'120',()=>{},makeRecovery),payloads={};for(const[path,blob]of task.payloads)payloads[path]=await fileInfo(blob);
  const record={...f.record,retainedHandoffEvidence:[{bundle:{id:task.id,kind:'task',payloads},payloads:task.payloads}]};assert(!f.snapshot.manifest.handoffs.some(h=>h.id===task.id));assert.equal(await createResumeProof(f.config,f.scene,record),null);assert.deepEqual(f.directory.control.writes,[]);
});
test('existing empty approval receipt follows the full-proof repair path',async()=>{
  const f=await fixture(),{verify}=await ready(f);await put(f.directory,'.scorebrush/finished-pdf.json',new Blob([JSON.stringify({schema:'scorebrush-finished-pdf',version:2,projectId:f.config.projectId,current:null,pending:null,retiring:[]})]));assert.equal(await createResumeProof(f.config,f.scene,f.record),null);assert.equal(await verify(),null);assert.deepEqual(f.directory.control.writes,[]);
});
test('an imported older rendering keeps the full proof presentation order independently of ordinal numbers',async()=>{
  const f=await fixture(),files={...f.record.files,rendered:{name:'SYNTHETIC earlier rendering.pdf',blob:new Blob(['%PDF SYNTHETIC older imported rendering'])}},identified=await identify(files),review={...structuredClone(f.record.review),files:identified.identity,snapshotId:identified.snapshotId,createdAt:'2000-01-01T00:00:00Z',updatedAt:'2000-01-01T00:00:00Z'},payloads=await makeRecovery(review,files),declarations={};
  for(const[path,blob]of payloads){const info=await fileInfo(blob);declarations[path]=info;f.snapshot.objects.set(info.sha256,blob);await put(f.directory,'.scorebrush/recovery/objects/'+info.sha256,blob);}
  const manifest={...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:2,legacyEvidence:[{id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,missingData:[]}]};f.snapshot.manifest=manifest;manifest.pdfOutput=await preparePdfOutput(f.directory,f.snapshot);await f.commit(manifest);f.config.recoveryId=manifest.id;
  const versions=await syncPdfVersions(f.directory,f.snapshot);assert.deepEqual(versions.versions.map(v=>v.number),[2,1]);await syncProjectHistory(f.directory,f.snapshot,{pdfVersions:versions.versions});const {verify,proof}=await ready(f);assert.deepEqual(proof.pdfVersions.map(v=>v.number),[2,1]);assert(await verify());assert.deepEqual(f.directory.control.writes,[]);
});

test('optional proof capture rejects cancellation and a competing publication without writing',async()=>{
  for(const mode of ['cancel','generation']){
    const f=await fixture(),versions=await(await import('../app/pdf-versions.js')).checkPdfVersions(f.directory,f.snapshot),history=await f.directory.getFileHandle('History.json'),getFile=history.getFile;
    let current=true,fired=false;
    history.getFile=async()=>{if(!fired){fired=true;if(mode==='cancel')current=false;else await f.commit({...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:f.snapshot.manifest.sequence+1});}return getFile();};
    const proof=await captureResumeProof(f.config,f.scene,f.record,f.snapshot,{pdfVersions:versions,isCurrent:()=>current});
    assert.equal(proof,null,mode);assert(fired);assert.deepEqual(f.directory.control.writes,[]);
  }
});

test('same-size older Versions edits are deferred only by the current proof; full versions and current outputs still validate bytes',async()=>{
  const f=await approvedFixture(),{verify,proof}=await ready(f),current=f.snapshot.manifest.records.find(r=>r.id===f.snapshot.manifest.current),currentHash=current.payloads['rendered-original.pdf'].sha256;
  const old=proof.pdfVersions.find(v=>v.sha256!==currentHash);assert(old,'fixture must have an older rendering');
  const original=await get(f.directory,old.path);await put(f.directory,old.path,new Blob([new Uint8Array(original.size).fill(88)]));
  const fast=await verify();assert(fast);assert.equal(fast.fullHistoryAudited,false);
  const {checkPdfVersions}=await import('../app/pdf-versions.js');assert.equal(await checkPdfVersions(f.directory,f.snapshot),null,'full history validation must freshly hash every older Versions copy');
  await put(f.directory,old.path,original);
  const required=[proof.pdfVersions.find(v=>v.sha256===currentHash).path,'Latest/'+proof.finished.name];
  for(const path of required){const bytes=await get(f.directory,path);await put(f.directory,path,new Blob([new Uint8Array(bytes.size).fill(89)]));assert.equal(await verify(),null,path);await put(f.directory,path,bytes);}
  assert(await verify());assert.deepEqual(f.directory.control.writes,[]);
});
