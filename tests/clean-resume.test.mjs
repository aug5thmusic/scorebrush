// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {makeTask,json,fileInfo} from '../app/workflow.js';
import {addCompletionHistory} from '../app/completion.js';
import {verifySavedFolder,writeLatestTask} from '../app/folder-workspace.js';
import {readRecovery,recoveryIsCurrent} from '../app/folder-recovery.js';
import {preparePdfOutput,syncPdfVersions} from '../app/pdf-versions.js';
import {syncProjectHistory} from '../app/project-history.js';
import {HistoryDirectory,put,get} from './history-memory.mjs';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
async function fixture(){
  const directory=new HistoryDirectory(),files={source:{name:'source.pdf',blob:new Blob(['%PDF SYNTHETIC source'])},rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC rendering'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC captured code'])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]),revisionId=crypto.randomUUID(),projectId=crypto.randomUUID(),workspaceId=snapshotId;
  const scene={review,files,returned:null,completions:[],workspaceId,revisionId,persistedRevision:1,stamp:{snapshotId,workspaceId:null,revision:1}};
  const record={...scene,id:workspaceId,storageRevision:1,projectId};
  const head=await makeTask(review,files,{},'120',()=>{},makeRecovery),objects=new Map();
  async function store(payloads){const result={};for(const [path,blob]of payloads){const info=await fileInfo(blob);objects.set(info.sha256,blob);result[path]=info;await put(directory,'.scorebrush/recovery/objects/'+info.sha256,blob);}return result;}
  const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'},id=crypto.randomUUID();
  const manifest={schema:'private-score-desk-recovery',version:1,id,projectId,parent:null,sequence:1,createdAt:review.createdAt,sourceSha256:identity.source.sha256,initialTranscriptionFilename:'Etude.pdf',paths,current:workspaceId,
    records:[{id:workspaceId,snapshotId,revisionId,storageRevision:1,payloads:await store(await addCompletionHistory(await makeRecovery(review,files),review,null,revisionId,[],{preserveRevision:true}))}],
    handoffs:[{id:head.id,kind:'task',payloads:await store(head.payloads)}],headTaskId:head.id,historyBackfillVersion:1,legacyEvidence:[]};
  await put(directory,'.scorebrush/OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  manifest.pdfOutput=await preparePdfOutput(directory,{manifest,objects});
  async function commit(value){const blob=json(value);await put(directory,'.scorebrush/recovery/g-'+value.id+'/snapshot.json',blob);await put(directory,'.scorebrush/recovery/g-'+value.id+'/COMMIT.json',json({schema:value.schema,version:1,id:value.id,manifestSha256:(await fileInfo(blob)).sha256}));}
  await commit(manifest);const snapshot=await readRecovery(directory),versions=await syncPdfVersions(directory,snapshot);await syncProjectHistory(directory,snapshot,{pdfVersions:versions.versions});
  const published=await writeLatestTask(directory,head,paths),config={directory,paths,head:published.entry,headStamp:{...scene.stamp,revision:99},workspaceId,boundSnapshotId:snapshotId,sourceSha256:identity.source.sha256,projectId,recoveryId:id};
  const verify=(s=scene,r=record,c=config,recovery=snapshot,options={})=>verifySavedFolder(c,s,r,recovery,options);
  directory.control.writes.length=0;return {directory,scene,record,config,snapshot,verify,commit};
}
test('clean proof ignores the session counter, reads no mutable inputs and writes nothing',async()=>{
  const f=await fixture();assert(await f.verify());
  for(const name of Object.values(f.config.paths))await put(f.directory,name,new Blob(['SYNTHETIC newer external bytes']));
  assert(await f.verify({...f.scene,stamp:{...f.scene.stamp,revision:1000}}));assert.deepEqual(f.directory.control.writes,[]);
});
test('unrelated NFC/NFD and case collisions remain clean; owned collisions fail without false repair',async()=>{
  const f=await fixture();
  for(const name of ['Caf\u00e9.pdf','Cafe\u0301.pdf','extra.pdf','EXTRA.pdf'])await put(f.directory,'Versions/'+name,new Blob(['USER '+name]));
  for(let i=0;i<2;i++){assert(await f.verify());assert.equal((await syncPdfVersions(f.directory,f.snapshot)).written,0);assert(await f.verify());}
  assert.deepEqual(f.directory.control.writes,[]);
  await put(f.directory,'Versions/0001 - ETUDE.pdf',new Blob(['USER alias']));
  await assert.rejects(f.verify(),/ambiguous owned filename/);await assert.rejects(syncPdfVersions(f.directory,f.snapshot),/ambiguous owned filename/);
  assert.equal(await(await get(f.directory,'Versions/0001 - ETUDE.pdf')).text(),'USER alias');assert.deepEqual(f.directory.control.writes,[]);
  await(await f.directory.getDirectoryHandle('Versions')).removeEntry('0001 - ETUDE.pdf');assert(await f.verify());assert(await f.verify());
});
test('additional matching-head legacy evidence requires publication even with an unchanged current revision',async()=>{
  const f=await fixture(),bundle=f.snapshot.manifest.records[0],legacy={...bundle,id:'legacy-package:'+bundle.payloads['manifest.json'].sha256};
  const richer={...f.record,retainedLegacyEvidence:[{bundle:legacy,payloads:new Map(Object.entries(bundle.payloads).map(([path,info])=>[path,f.snapshot.objects.get(info.sha256)]))}]};
  assert.equal(await f.verify(f.scene,richer),null);assert(await f.verify());assert.deepEqual(f.directory.control.writes,[]);
});
test('durable workspace/revision/state/asset equality is required even when the old session stamp matches',async()=>{
  const f=await fixture();f.config.headStamp=f.scene.stamp;
  for(const change of [s=>s.workspaceId='other',s=>s.revisionId=crypto.randomUUID(),s=>s.persistedRevision=2,s=>s.review.updatedAt='2026-10-20T00:00:00Z',s=>s.review.findings.push({id:'new',comment:'unsaved'}),s=>s.completions.push({id:'pending'}),s=>s.files.ly.blob=new Blob(['different code'])]){
    const scene=structuredClone(f.scene);change(scene);assert.equal(await f.verify(scene),null);
  }
  assert.equal(await f.verify(f.scene,{...f.record,projectId:crypto.randomUUID()}),null);
  assert.equal(await f.verify(f.scene,f.record,{...f.config,pendingHead:f.config.head,pendingStamp:f.scene.stamp}),null);
  assert.equal(await f.verify(f.scene,f.record,f.config,null),null);assert.deepEqual(f.directory.control.writes,[]);
});
test('READY, manifest, exact handoff assets, pointer and prompt settings must all match',async()=>{
  const f=await fixture();
  for(const path of ['.scorebrush/latest/READY.json','.scorebrush/latest/manifest.json','.scorebrush/latest/task.json','.scorebrush/latest/annotations.json','.scorebrush/latest/lilypond/supplied.ly','.scorebrush/latest/source-original.pdf','REVIEW_THIS.md']){
    const original=await get(f.directory,path);await put(f.directory,path,new Blob(['SYNTHETIC damaged output']));assert.equal(await f.verify(),null,path);await put(f.directory,path,original);
  }
  assert.equal(await f.verify(f.scene,f.record,f.config,f.snapshot,{addDirectoryPath:true,absolutePath:'C:\\SYNTHETIC changed settings'}),null);
  assert(await f.verify());assert.deepEqual(f.directory.control.writes,[]);
});
test('missing index, legacy names and pending publications explicitly require repair',async()=>{
  const f=await fixture();
  for(const [path,modify]of [['.scorebrush/history-index.json',r=>{r.pending=r.current;}],['.scorebrush/pdf-names.json',r=>{r.output.basename='Old title';}]]){
    const original=await get(f.directory,path),value=JSON.parse(await original.text());modify(value);await put(f.directory,path,json(value));assert.equal(await f.verify(),null,path);await put(f.directory,path,original);
  }
  const index=await get(f.directory,'History.json');f.directory.children.delete('History.json');assert.equal(await f.verify(),null);await put(f.directory,'History.json',index);
  const versions=await f.directory.getDirectoryHandle('Versions'),copy=versions.children.get('0001 - Etude.pdf');versions.children.delete('0001 - Etude.pdf');assert.equal(await f.verify(),null);versions.children.set('0001 - Etude.pdf',copy);
  assert(await f.verify());assert.deepEqual(f.directory.control.writes,[]);
});
test('a new recovery commit or divergent branch cannot be accepted using an earlier proof',async()=>{
  const f=await fixture(),child={...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:2};await f.commit(child);
  assert.equal(await recoveryIsCurrent(f.directory,f.snapshot),false);assert.equal(await f.verify(),null);
  await f.commit({...child,id:crypto.randomUUID()});await assert.rejects(f.verify(),/different saved workspace|another|changed|conflict/i);
  assert.deepEqual(f.directory.control.writes,[]);
});
