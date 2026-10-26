// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {syncFinishedPDF,syncCurrentFinishedPDF,approvedRenderings,checkFinishedPDF} from '../app/finished-pdf.js';
import {identify,newReview,sha256} from '../app/model.js';
import {stateHash} from '../app/completion-model.js';
import {ensureDataDirectory} from '../app/project-directory.js';
globalThis.crypto??=webcrypto;
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
class Dir{
  kind='directory';
  constructor(control={writes:[],steps:0},path=''){this.control=control;this.path=path;this.children=new Map();}
  tick(){if(++this.control.steps===this.control.failAt)throw Error('SYNTHETIC interrupted');}
  async getDirectoryHandle(n,{create=false}={}){let e=this.children.get(n);if(!e&&create){e=new Dir(this.control,this.path+n+'/');this.children.set(n,e);this.tick();}if(!e)throw new DOMException('Missing','NotFoundError');if(e.kind!=='directory')throw new DOMException('File','TypeMismatchError');return e;}
  async getFileHandle(n,{create=false}={}){let e=this.children.get(n);if(!e&&create){e={kind:'file',blob:new Blob(),getFile:async()=>e.blob,createWritable:async()=>{let b;return {write:async data=>{b=data;this.tick();},close:async()=>{e.blob=b;this.control.writes.push(this.path+n);this.tick();},abort:async()=>{}};}};this.children.set(n,e);this.tick();}if(!e)throw new DOMException('Missing','NotFoundError');if(e.kind!=='file')throw new DOMException('Directory','TypeMismatchError');return e;}
  async *entries(){yield* this.children;}
  async removeEntry(name){await this.control.beforeRemove?.(this.path,name);this.children.delete(name);this.tick();}
}
const projectId=crypto.randomUUID();
async function snapshot(specs){
  const records=[],objects=new Map();
  const asset=async blob=>{const info={size:blob.size,sha256:await sha256(await blob.arrayBuffer())};objects.set(info.sha256,blob);return info;};
  for(const [i,spec]of specs.entries()){
    const {value='first',status='resolved',time=i+1,workspace='round-'+value,storageRevision=i+1,history=true}=spec;
    const files={source:{name:'source.pdf',blob:new Blob(['%PDF source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF exact ',value])},ly:{name:'score.ly',blob:new Blob(['notes '+value])}};
    const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[0,0,100,100]}]);
    review.createdAt=review.updatedAt=`2026-10-23T00:00:${String(time).padStart(2,'0')}Z`;
    const reviewed={snapshotId,codeSha256:identity.ly.sha256,renderSha256:identity.rendered.sha256};
    const round={schema:'score-desk-returned-workspace',version:1,id:workspace,contentSnapshotId:snapshotId,codeSha256:identity.ly.sha256,renderSha256:identity.rendered.sha256,reported:[{id:'correction',number:1,state:status==='unchecked'?'open':status,decision:status==='unchecked'?null:{state:status,reviewed},comment:'Correct the note',explanation:'',associationId:null}]};
    if(spec.comment)round.reported.push({id:'comment',number:2,type:'comment',state:'open',decision:null,comment:'For my reference',associationId:null});
    if(spec.newFinding){review.findings=[{id:'new',number:1,type:'correction',page:1,state:'open',comment:'Another problem',strokes:[],bounds:null,color:'#ffd34d'}];review.nextNumber=2;}
    if(spec.wrongIdentity)round.reported[0].decision.reviewed.renderSha256='f'.repeat(64);
    const revisionId='revision-'+i,payloads={'rendered-original.pdf':await asset(files.rendered.blob),'annotations.json':await asset(new Blob([JSON.stringify(review)])),'returned-workspace.json':await asset(new Blob([JSON.stringify({returned:round})])),'completion-history.json':await asset(new Blob([JSON.stringify({revisionId,stateSha256:await stateHash(review,round),records:[]})]))};
    records.push({id:'record-'+i,workspaceId:workspace,revisionId,snapshotId,storageRevision,...(history?{history:true,createdAt:review.updatedAt}:{}),payloads});
  }
  return {manifest:{projectId,initialTranscriptionFilename:'SYNTHETIC - Moonlit Widget Sonata.pdf',records},objects};
}
const named=n=>String(n).padStart(4,'0')+' - SYNTHETIC - Moonlit Widget Sonata.pdf';
async function result(root){const d=await root.getDirectoryHandle('Latest'),names=[];for await(const[n]of d.entries())names.push(n);const receipt=JSON.parse(await(await(await(await root.getDirectoryHandle('.scorebrush')).getFileHandle('finished-pdf.json')).getFile()).text());const name=receipt.current?.name??receipt.pending?.name??names[0];return {names,text:await(await(await d.getFileHandle(name)).getFile()).text()};}
test('publishes exact approved bytes in one ordinary PDF, backfills history and leaves ordinary saves unchanged',async()=>{
  const root=new Dir(),s=await snapshot([{value:'first',comment:true},{value:'newer',status:'unchecked'}]);
  const published=await syncFinishedPDF(root,s);assert.equal(published.ready,true);assert.deepEqual(await result(root),{names:[named(1)],text:'%PDF exact first'});
  const writes=root.control.writes.length;assert.equal((await syncFinishedPDF(root,s)).written,0);assert.equal(root.control.writes.length,writes);
  assert.equal((await checkFinishedPDF(root,projectId)).state,'match');
  assert((await root.getDirectoryHandle('.scorebrush')).children.has('finished-pdf.json'));
});
test('edited original then removed original keeps valid suffix, exact approval and migration receipt without PDF writes',async()=>{
  const root=new Dir(),s=await snapshot([{value:'first'}]);await syncFinishedPDF(root,s);
  const versions=await root.getDirectoryHandle('Versions'),original=await versions.getFileHandle(named(1));original.blob=new Blob(['USER edited original']);
  await syncFinishedPDF(root,s);assert.equal(await original.blob.text(),'USER edited original');const suffix=await result(root);assert.match(suffix.names[0],/ \(2\)\.pdf$/);
  const data=await root.getDirectoryHandle('.scorebrush'),receipt=await(await(await data.getFileHandle('finished-pdf.json')).getFile()).text(),before=JSON.stringify(s.manifest);
  await versions.removeEntry(named(1));const writes=root.control.writes.length;
  for(let i=0;i<2;i++){assert.equal((await syncFinishedPDF(root,s)).written,0);assert.deepEqual(await result(root),suffix);assert.equal((await checkFinishedPDF(root,projectId)).path,'Latest/'+suffix.names[0]);}
  assert.equal(root.control.writes.length,writes);assert.equal(await(await(await data.getFileHandle('finished-pdf.json')).getFile()).text(),receipt);assert.equal(JSON.stringify(s.manifest),before);
  const names=[];for await(const[name]of versions.entries())names.push(name);assert.deepEqual(names,suffix.names);
  assert.equal(await(await(await versions.getFileHandle(suffix.names[0])).getFile()).text(),suffix.text);
});
test('newer working files, unchecked decisions, rejected corrections and new unresolved findings never replace the last approval',async()=>{
  const root=new Dir();await syncFinishedPDF(root,await snapshot([{value:'first'}]));
  for(const spec of [{value:'next',status:'unchecked'},{value:'next',status:'open'},{value:'next',newFinding:true},{value:'next',wrongIdentity:true}]){
    const s=await snapshot([{value:'first'},spec]);await syncFinishedPDF(root,s);assert.equal((await result(root)).text,'%PDF exact first');
  }
  await syncFinishedPDF(root,await snapshot([{value:'first'},{value:'next'}]));assert.deepEqual(await result(root),{names:[named(2)],text:'%PDF exact next'});
});
test('a blank or unchecked project has no finished PDF; ordinary notes do not promote an older approved rendering',async()=>{
  const root=new Dir(),s=await snapshot([{status:'unchecked'}]);assert.equal((await syncFinishedPDF(root,s)).ready,false);assert(!root.children.has('Latest'));
  const history=await snapshot([{value:'first',storageRevision:1,time:1},{value:'second',time:2},{value:'first',storageRevision:3,time:3,comment:true}]);
  assert.equal((await approvedRenderings(history)).at(-1).sha256,history.manifest.records[1].payloads['rendered-original.pdf'].sha256);await syncFinishedPDF(root,history);assert.equal((await result(root)).text,'%PDF exact second');
});
test('interrupted publication retains old or new exact bytes, resumes, and never produces a second PDF',async()=>{
  const old=await snapshot([{value:'first'}]),next=await snapshot([{value:'first'},{value:'second'}]);
  for(const first of [true,false]){
    const baseline=new Dir();await ensureDataDirectory(baseline);if(!first)await syncFinishedPDF(baseline,old);baseline.control.steps=0;await syncFinishedPDF(baseline,first?old:next);const steps=baseline.control.steps;
    for(let i=1;i<=steps;i++){
      const root=new Dir();await ensureDataDirectory(root);if(!first)await syncFinishedPDF(root,old);root.control.steps=0;root.control.failAt=i;
      await assert.rejects(syncFinishedPDF(root,first?old:next),/SYNTHETIC/);root.control.failAt=null;
      if(!first)assert(['%PDF exact first','%PDF exact second'].includes((await result(root)).text),'prior approved copy remains at checkpoint '+i);
      await syncFinishedPDF(root,first?old:next);assert.deepEqual(await result(root),{names:[named(first?1:2)],text:first?'%PDF exact first':'%PDF exact second'});
    }
    console.log('Latest interruption checkpoints:',first?'initial':'replacement',steps);
  }
});
test('unrelated PDF files and edited owned files stop publication without deleting or overwriting anything',async()=>{
  const s=await snapshot([{value:'first'}]);
  for(const name of ['personal.PDF','Finished.pdf','FINISHED.PDF',named(1),named(1).toUpperCase()]){
    const root=new Dir(),d=await root.getDirectoryHandle('Latest',{create:true}),f=await d.getFileHandle(name,{create:true});f.blob=new Blob(['USER PDF']);
    await assert.rejects(syncFinishedPDF(root,s),/does not own|existing/);assert.equal(await f.blob.text(),'USER PDF');assert.equal(d.children.size,1);
  }
  const root=new Dir();await syncFinishedPDF(root,s);const d=await root.getDirectoryHandle('Latest'),f=await d.getFileHandle(named(1));f.blob=new Blob(['USER EDIT']);
  await assert.rejects(syncFinishedPDF(root,await snapshot([{value:'first'},{value:'second'}])),/changed outside/);assert.equal(await f.blob.text(),'USER EDIT');assert.equal((await checkFinishedPDF(root,projectId)).state,'unavailable');
  d.children.delete(named(1));await syncFinishedPDF(root,s);assert.equal((await result(root)).text,'%PDF exact first');
});
test('file/directory collisions, foreign metadata, and corrupted retained bytes fail safely',async()=>{
  const s=await snapshot([{value:'first'}]),root=new Dir();(await root.getFileHandle('Latest',{create:true})).blob=new Blob(['PERSONAL']);await assert.rejects(syncFinishedPDF(root,s),/file named Latest/);
  const fresh=new Dir();await syncFinishedPDF(fresh,s);const journal=await(await fresh.getDirectoryHandle('.scorebrush')).getFileHandle('finished-pdf.json');journal.blob=new Blob(['{}']);await assert.rejects(syncFinishedPDF(fresh,s),/metadata conflicts/);assert.equal((await result(fresh)).text,'%PDF exact first');
  const broken=await snapshot([{value:'first'}]);broken.objects.set(broken.manifest.records[0].payloads['rendered-original.pdf'].sha256,new Blob(['%PDF exact WRONG']));await assert.rejects(syncFinishedPDF(new Dir(),broken),/identity|verification/);
});

async function legacyFinished(root,s,{pending=false}={}){
  const owned=await ensureDataDirectory(root),latest=await root.getDirectoryHandle('Latest',{create:true}),candidates=await approvedRenderings(s);
  const {blob,...approval}=candidates[0];
  (await latest.getFileHandle('Finished.pdf',{create:true})).blob=blob;
  (await owned.getFileHandle('finished-pdf.json',{create:true})).blob=new Blob([JSON.stringify({schema:'scorebrush-finished-pdf',version:1,projectId,name:'Finished.pdf',current:pending?null:approval,pending:pending?approval:null})]);
}
test('legacy Finished.pdf migration commits a verified numbered pair before retiring only the owned old path',async()=>{
  const s=await snapshot([{value:'first'},{value:'newer',status:'unchecked'}]),base=new Dir();await legacyFinished(base,s);base.control.steps=0;await syncFinishedPDF(base,s);const steps=base.control.steps;
  for(const pending of [false,true])for(let i=1;i<=steps;i++){
    const root=new Dir();await legacyFinished(root,s,{pending});root.control.steps=0;root.control.failAt=i;
    root.control.beforeRemove=async(path,name)=>{
      if(path!=='Latest/')return;
      assert.equal(name,'Finished.pdf');const receipt=JSON.parse(await(await(await(await root.getDirectoryHandle('.scorebrush')).getFileHandle('finished-pdf.json')).getFile()).text());
      assert.equal(receipt.version,2);assert.equal(receipt.current.name,named(1));assert.equal(receipt.pending,null);
      const latest=await root.getDirectoryHandle('Latest');assert.equal(await(await(await latest.getFileHandle(named(1))).getFile()).text(),'%PDF exact first');
    };
    await assert.rejects(syncFinishedPDF(root,s),/SYNTHETIC/);root.control.failAt=null;
    const latest=await root.getDirectoryHandle('Latest'),texts=[];for await(const[,e]of latest.entries())texts.push(await(await e.getFile()).text());
    assert(texts.includes('%PDF exact first'),'approved bytes survive checkpoint '+i);
    await syncFinishedPDF(root,s);assert.deepEqual(await result(root),{names:[named(1)],text:'%PDF exact first'});
    const version=await(await(await(await root.getDirectoryHandle('Versions')).getFileHandle(named(1))).getFile()).text();assert.equal(version,'%PDF exact first');
    assert.equal((await checkFinishedPDF(root,projectId)).path,'Latest/'+named(1));
  }
  console.log('Legacy Latest migration checkpoints:',steps,'x two receipt states');
});
test('migration preserves unrelated, edited and case-colliding PDFs and refuses readiness until matching copies exist',async()=>{
  const s=await snapshot([{value:'first'}]);
  for(const collision of [named(1),named(1).toUpperCase(),'personal.PDF']){
    const root=new Dir();await legacyFinished(root,s);const dir=await root.getDirectoryHandle('Latest');(await dir.getFileHandle(collision,{create:true})).blob=new Blob(['USER OWNED']);
    await assert.rejects(syncFinishedPDF(root,s),/does not own/);assert.equal(await(await(await dir.getFileHandle('Finished.pdf')).getFile()).text(),'%PDF exact first');assert.equal(await(await(await dir.getFileHandle(collision)).getFile()).text(),'USER OWNED');
  }
  const root=new Dir();await legacyFinished(root,s);const dir=await root.getDirectoryHandle('Latest');(await dir.getFileHandle('Finished.pdf')).blob=new Blob(['USER EDIT']);
  await assert.rejects(syncFinishedPDF(root,s),/changed outside/);assert.equal(dir.children.size,1);
  await dir.removeEntry('Finished.pdf');await syncFinishedPDF(root,s);
  const versions=await root.getDirectoryHandle('Versions');await versions.removeEntry(named(1));assert.equal((await checkFinishedPDF(root,projectId)).state,'unavailable');
  await syncFinishedPDF(root,s);assert.equal((await checkFinishedPDF(root,projectId)).state,'match');assert.equal((await result(root)).names.length,1);
});

test('deleted new copies and interrupted zero-byte creations cannot retire the surviving old approval',async()=>{
  const s=await snapshot([{value:'first'}]),root=new Dir();await legacyFinished(root,s);
  root.control.beforeRemove=async path=>{if(path==='Latest/')throw Error('SYNTHETIC cleanup interruption');};
  await assert.rejects(syncFinishedPDF(root,s),/SYNTHETIC/);delete root.control.beforeRemove;
  const latest=await root.getDirectoryHandle('Latest');await latest.removeEntry(named(1));
  // Fail after the new zero-byte handle is created during repair.
  const original=latest.getFileHandle.bind(latest);let once=true;
  latest.getFileHandle=async(name,options)=>{const out=await original(name,options);if(name===named(1)&&options?.create&&once){once=false;throw Error('SYNTHETIC creation interruption');}return out;};
  await assert.rejects(syncFinishedPDF(root,s),/SYNTHETIC/);
  assert.equal(await(await(await latest.getFileHandle('Finished.pdf')).getFile()).text(),'%PDF exact first');
  latest.getFileHandle=original;await syncFinishedPDF(root,s);assert.deepEqual(await result(root),{names:[named(1)],text:'%PDF exact first'});
  const legacy=new Dir();await legacyFinished(legacy,s,{pending:true});const dir=await legacy.getDirectoryHandle('Latest');(await dir.getFileHandle('Finished.pdf')).blob=new Blob();
  await syncFinishedPDF(legacy,s);assert.deepEqual(await result(legacy),{names:[named(1)],text:'%PDF exact first'});
});

test('a completed current review publishes its numbered PDF without enumerating archive objects or old reviews',async()=>{
  const root=new Dir(),archive=await snapshot([{value:'first'},{value:'next',status:'unchecked'}]);
  await syncFinishedPDF(root,archive);
  const data=await root.getDirectoryHandle('.scorebrush'),objects=await(await data.getDirectoryHandle('recovery',{create:true})).getDirectoryHandle('objects',{create:true});
  const old=archive.manifest.records[0].payloads['rendered-original.pdf'];(await objects.getFileHandle(old.sha256,{create:true})).blob=archive.objects.get(old.sha256);
  objects.entries=async function*(){throw Error('Must not enumerate historical objects');};
  const current=await snapshot([{value:'next',time:3,history:false}]);current.manifest.pdfOutput=JSON.parse(await(await(await data.getFileHandle('pdf-names.json')).getFile()).text()).output;
  const publication=await syncCurrentFinishedPDF(root,current);assert.equal(publication.ready,true);
  assert.deepEqual(await result(root),{names:[named(2)],text:'%PDF exact next'});
  const writes=root.control.writes.length;await syncCurrentFinishedPDF(root,current);assert.equal(root.control.writes.length,writes,'unchanged completion does not republish');
});
test('current checkpoint never publishes an incomplete review or overwrites a modified numbered version',async()=>{
  const root=new Dir(),base=await snapshot([{value:'next',status:'unchecked'}]);
  assert.equal((await syncCurrentFinishedPDF(root,base)).ready,false);assert.equal(root.control.writes.length,0);
  const complete=await snapshot([{value:'next',time:2}]);await syncFinishedPDF(root,complete);
  complete.manifest.pdfOutput=JSON.parse(await(await(await(await root.getDirectoryHandle('.scorebrush')).getFileHandle('pdf-names.json')).getFile()).text()).output;
  const versions=await root.getDirectoryHandle('Versions'),pdf=await versions.getFileHandle(named(1));pdf.blob=new Blob(['USER changed PDF']);
  await assert.rejects(syncCurrentFinishedPDF(root,complete),/numbered PDF could not be verified/);
  assert.equal(await pdf.blob.text(),'USER changed PDF');assert.equal((await result(root)).text,'%PDF exact next');
});
