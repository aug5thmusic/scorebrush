// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {identify,newReview,sha256} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {addCompletionHistory} from '../app/completion.js';
import {fileInfo,json,LIMITS} from '../app/workflow.js';
import {buildProjectHistory,syncProjectHistory,readPublishedHistory,checkProjectHistory} from '../app/project-history.js';
import {canonical} from '../app/completion-model.js';
import {ensureDataDirectory} from '../app/project-directory.js';
import {HistoryDirectory,put,get} from './history-memory.mjs';
globalThis.crypto??=webcrypto;
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
const projectId=crypto.randomUUID(),pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}];
const source=new Blob(['%PDF SYNTHETIC source']),rendered=new Blob(['%PDF SYNTHETIC rendering']);
const note=(text,type='correction')=>({id:'stable-note',number:1,page:1,comment:text,type,state:'open',color:'#ffd34d',strokes:[{width:4,color:'#ffd34d',opacity:.35,points:[[12,24],[30,40]]}],bounds:[10,22,32,42]});
async function snapshot(specs){
  const objects=new Map(),records=[];let predecessor=null;
  for(const [i,spec]of specs.entries()){
    const files={source:{name:'Source.pdf',blob:source},rendered:{name:spec.rename??'Initial transcription.pdf',blob:spec.pdf??rendered},ly:{name:'Selected.ly',blob:new Blob([spec.code??'SYNTHETIC code 1'])}};
    const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,pages);
    review.createdAt=review.updatedAt=new Date(Date.UTC(2026,9,24,12,0,i)).toISOString();
    review.findings=spec.findings??(spec.deleted?[]:[note(spec.text??'Exact original text',spec.type)]);review.nextNumber=review.findings.length+1;
    const revisionId=crypto.randomUUID(),payloads={};
    const packed=await addCompletionHistory(await makeRecovery(review,files),review,null,revisionId,[],{preserveRevision:true});
    for(const [path,blob]of packed){const info=await fileInfo(blob);objects.set(info.sha256,blob);payloads[path]=info;}
    const id='review-event:'+crypto.randomUUID();
    records.push({id,history:true,workspaceId:snapshotId,snapshotId,revisionId,storageRevision:i+1,createdAt:review.updatedAt,parentHistoryId:predecessor,historyCoverage:spec.legacy?'legacy-retained-state':'durable-save',payloads});
    predecessor=id;
  }
  const last=records.at(-1),current=last.snapshotId;
  records.push({...last,id:current,history:false,historyId:last.id});
  return {manifest:{id:crypto.randomUUID(),sequence:specs.length,projectId,sourceSha256:(await fileInfo(source)).sha256,initialTranscriptionFilename:'Initial transcription.pdf',current,records,handoffs:[]},objects};
}
async function resolveMetadata(index,snapshot,id){const object=index.objects.find(o=>o.id===id);assert(object,'metadata object exists');const blob=snapshot.objects.get(object.sha256);assert.equal(await sha256(await blob.arrayBuffer()),object.sha256);return JSON.parse(await blob.text());}
async function folder(snapshot){const root=new HistoryDirectory();await ensureDataDirectory(root);for(const [hash,blob]of snapshot.objects)await put(root,'.scorebrush/recovery/objects/'+hash,blob);return root;}
async function withRepeatedHistoricalReview(){
  const s=await snapshot([{}]),record=s.manifest.records[0],review=JSON.parse(await s.objects.get(record.payloads['annotations.json'].sha256).text()),id=crypto.randomUUID();
  const originalFiles=Object.fromEntries(['source','rendered','ly'].map((role,index)=>[role,{...review.files[role],path:['source-original.pdf','rendered-original.pdf','lilypond/supplied.ly'][index]}]));
  const task={id,baseline:{snapshotId:review.snapshotId,codeSha256:review.files.ly.sha256,renderSha256:review.files.rendered.sha256},findings:Array.from({length:180},(_,n)=>({id:'historical-'+n,historicalContext:{annotations:'annotations.json',originalFiles}}))};
  const blob=json(task),info=await fileInfo(blob);s.objects.set(info.sha256,blob);
  const bundle={id,kind:'task',payloads:{...record.payloads,'task.json':info}};s.manifest.handoffs.push(bundle);
  return {s,task,bundle};
}

test('repeated historical references validate each exact annotation object once and retain every payload',async()=>{
  const {s,bundle}=await withRepeatedHistoricalReview(),copy=globalThis.structuredClone;let copies=0,index;
  globalThis.structuredClone=value=>{if(value?.schema==='score-desk-review')copies++;return copy(value);};
  try{index=await buildProjectHistory(s);}finally{globalThis.structuredClone=copy;}
  assert.equal(copies,1,'180 historical contexts sharing immutable bytes must not clone the complete review 180 times');
  const historical=index.revisions.filter(r=>r.kind==='historical-task-evidence');assert.equal(historical.length,1);
  assert.equal(historical[0].metadata.annotations,'sha256:'+bundle.payloads['annotations.json'].sha256);
  assert.deepEqual(Object.keys(index.handoffs[0].payloads).sort(),Object.keys(bundle.payloads).sort());
  for(const info of Object.values(bundle.payloads))assert(index.objects.some(object=>object.sha256===info.sha256&&object.size===info.size));
  const legacy=await buildProjectHistory(s,{version:1});
  assert.equal(canonical(legacy.revisions.find(r=>r.kind==='historical-task-evidence').annotations),canonical(JSON.parse(await s.objects.get(bundle.payloads['annotations.json'].sha256).text())));
});

test('history validation never trusts a shared snapshot ID or a previous build',async()=>{
  const {s,task,bundle}=await withRepeatedHistoricalReview();await buildProjectHistory(s);
  const invalid=JSON.parse(await s.objects.get(bundle.payloads['annotations.json'].sha256).text());invalid.findings[0].bounds=[0,0,0,0];
  const blob=json(invalid),info=await fileInfo(blob);s.objects.set(info.sha256,blob);bundle.payloads['historical/other.json']=info;
  task.findings.at(-1).historicalContext={...task.findings.at(-1).historicalContext,annotations:'historical/other.json'};
  const taskBlob=json(task),taskInfo=await fileInfo(taskBlob);s.objects.set(taskInfo.sha256,taskBlob);bundle.payloads['task.json']=taskInfo;
  await assert.rejects(buildProjectHistory(s),/stroke bounding box differs/,'distinct annotation bytes with the same snapshot must still be validated');
  const next=await withRepeatedHistoricalReview(),legacy=await buildProjectHistory(next.s,{version:1});
  legacy.revisions[0].annotations.findings[0].bounds=[0,0,0,0];
  await assert.rejects(buildProjectHistory(next.s),/stroke bounding box differs/,'a prior successful build cannot suppress subsequent validation');
});

test('research JSON retains exact three-file identities, text/type/deletion states, geometry and explicit legacy gaps',async()=>{
  const s=await snapshot([{},{text:'Edited exact text',type:'source_footnote'},{deleted:true},{code:'SYNTHETIC code 2',rename:'Same bytes renamed.pdf',type:'comment',legacy:true}]);
  const index=await buildProjectHistory(s,{pdfVersions:[{number:1,path:'Versions/0001 - Initial transcription.pdf',sha256:(await fileInfo(rendered)).sha256,size:rendered.size}]});
  assert.equal(index.project.id,projectId);assert.equal(index.project.initialTranscriptionFilename,'Initial transcription.pdf');
  assert.equal(index.events.length,4);assert.equal(index.project.latestApprovedRevision,null);
  assert.equal(index.version,2);const reviews=await Promise.all(index.revisions.map(r=>resolveMetadata(index,s,r.metadata.annotations)));
  assert.equal(reviews[0].findings[0].comment,'Exact original text');assert.equal(reviews[1].findings[0].type,'source_footnote');
  assert.deepEqual(index.events[2].changes.deleted,['stable-note']);
  assert.deepEqual(reviews[0].findings[0].strokes,[note('').strokes[0]]);
  assert.match(index.coverage.pageMapping,/independent/);assert.deepEqual(reviews[0].pages,pages);
  assert(index.revisions.every(r=>!Object.hasOwn(r,'annotations')&&!Object.hasOwn(r,'findings')));
  assert(index.events.every(e=>!Object.hasOwn(e,'decisionStates')));
  assert.notEqual(index.revisions[0].assetIds.ly,index.revisions[3].assetIds.ly);
  assert.equal(index.revisions[0].assetIds.rendered,index.revisions[3].assetIds.rendered);
  assert.deepEqual(index.assets.find(a=>a.roles.includes('rendered')).originalFilenames,['Initial transcription.pdf','Same bytes renamed.pdf']);
  assert.equal(index.revisions[3].capturedAt,null);assert(index.revisions[3].missingData.includes('earlier-durable-edits-not-completely-recorded'));
  const root=await folder(s);
  for(const object of index.objects){const blob=await get(root,object.path);assert.equal(blob.size,object.size);assert.equal(await sha256(await blob.arrayBuffer()),object.sha256);}
  const portable=await buildProjectHistory(s,{objectRoot:'workspace-history/recovery/objects/'});
  assert(portable.objects.every(o=>o.path==='workspace-history/recovery/objects/'+o.sha256));
  assert.deepEqual(portable.revisions.map(r=>r.metadata),index.revisions.map(r=>r.metadata));
  const legacy=await buildProjectHistory(s,{version:1});assert.equal(legacy.version,1);assert.deepEqual(legacy.revisions.map(r=>JSON.parse(JSON.stringify(r.annotations))),reviews);
  for(const revision of index.revisions){const completion=await resolveMetadata(index,s,revision.metadata.completion);assert.equal(completion.revisionId,revision.revisionId);assert.deepEqual(completion.records,[]);}
});
test('unchanged publication performs no writes and detects edited or unrelated History.json',async()=>{
  const s=await snapshot([{}]),root=await folder(s);assert.equal((await syncProjectHistory(root,s)).written,1);
  const writes=root.control.writes.length;assert.equal((await syncProjectHistory(root,s)).written,0);assert.equal(root.control.writes.length,writes);
  assert.equal((await readPublishedHistory(root,projectId)).project.current.revisionId,s.manifest.records[0].revisionId);
  await put(root,'History.json',new Blob(['USER MODIFIED']));await assert.rejects(syncProjectHistory(root,s),/modified outside/);assert.equal(await(await get(root,'History.json')).text(),'USER MODIFIED');
  for(const name of ['History.json','history.json']){const other=await folder(s);await put(other,name,new Blob(['USER OWNED']));await assert.rejects(syncProjectHistory(other,s),/not owned|conflicts/);assert.equal(await(await get(other,name)).text(),'USER OWNED');}
  const collision=await folder(s);await collision.getDirectoryHandle('History.json',{create:true});await assert.rejects(syncProjectHistory(collision,s),/conflicts/);
});
test('every interrupted create/write/close keeps old or new complete index and retries idempotently',async()=>{
  const old=await snapshot([{}]),next=await snapshot([{}, {code:'SYNTHETIC second code'}]);
  for(const first of [true,false]){
    const base=await folder(next);if(!first)await syncProjectHistory(base,old);base.control.steps=0;await syncProjectHistory(base,first?old:next);const steps=base.control.steps;
    for(let step=1;step<=steps;step++){
      const root=await folder(next);if(!first)await syncProjectHistory(root,old);root.control.steps=0;root.control.failAt=step;
      await assert.rejects(syncProjectHistory(root,first?old:next),/SYNTHETIC/);root.control.failAt=null;
      try{const file=await get(root,'History.json');if(file.size){const value=JSON.parse(await file.text());assert([old.manifest.id,next.manifest.id].includes(value.committedGeneration.id));}}catch(e){if(e.name!=='NotFoundError')throw e;}
      await syncProjectHistory(root,first?old:next);
      assert.equal(JSON.parse(await(await get(root,'History.json')).text()).committedGeneration.id,(first?old:next).manifest.id);
    }
    console.log('History.json interruption checkpoints:',first?'initial':'replacement',steps);
  }
});
test('concurrent edits, corrupt objects, unsafe references and foreign receipts preserve the last valid index',async()=>{
  const old=await snapshot([{}]),next=await snapshot([{}, {text:'Next state'}]),root=await folder(next);await syncProjectHistory(root,old);
  const original=await(await get(root,'History.json')).text(),bad={...next,objects:new Map(next.objects)},hash=next.manifest.records[0].payloads['lilypond/supplied.ly'].sha256;
  bad.objects.set(hash,new Blob(['CORRUPT']));await assert.rejects(syncProjectHistory(root,bad),/missing or changed/);assert.equal(await(await get(root,'History.json')).text(),original);
  await assert.rejects(buildProjectHistory(next,{objectRoot:'../escape/'}),/safe object root/);
  await assert.rejects(buildProjectHistory(next,{pdfVersions:[{number:1,path:'../escape.pdf',sha256:hash}]}),/unsafe visible/);
  root.control.beforeClose=async path=>{if(path==='.scorebrush/history-index.json'){delete root.control.beforeClose;await put(root,'History.json',new Blob(['CONCURRENT USER EDIT']));}};
  await assert.rejects(syncProjectHistory(root,next),/changed during publication/);assert.equal(await(await get(root,'History.json')).text(),'CONCURRENT USER EDIT');
  await put(root,'.scorebrush/history-index.json',json({schema:'foreign'}));await assert.rejects(syncProjectHistory(root,next),/ownership metadata/);
});

test('a presentation rename updates only visible PDF paths within the same committed generation',async()=>{
  const s=await snapshot([{}]),root=await folder(s),hash=(await fileInfo(rendered)).sha256;
  const old=[{number:7,path:'Versions/0007 - Revision 7.pdf',sha256:hash,size:rendered.size}];
  await syncProjectHistory(root,s,{pdfVersions:old});const before=await readPublishedHistory(root,projectId);
  const next=[{...old[0],path:'Versions/0007 - SYNTHETIC - Moonlit Widget Sonata (2).pdf'}];
  assert.equal((await syncProjectHistory(root,s,{pdfVersions:next})).written,1);const after=await readPublishedHistory(root,projectId);
  assert.equal(after.committedGeneration.id,before.committedGeneration.id);assert.deepEqual(after.events,before.events);
  assert.deepEqual(after.revisions.map(r=>[r.id,r.revisionId,r.assetIds]),before.revisions.map(r=>[r.id,r.revisionId,r.assetIds]));
  assert.equal(after.revisions[0].pdfVersions[0].number,7);assert.equal(after.revisions[0].pdfVersions[0].path,next[0].path);
});


test('an owned v1 index upgrades once in the same generation and then passes clean proof',async()=>{
  const s=await snapshot([{text:'Original retained note'},{text:'Later exact retained note'}]),root=await folder(s);
  const legacy=json(await buildProjectHistory(s,{version:1})),info=await fileInfo(legacy);
  await put(root,'History.json',legacy);
  await put(root,'.scorebrush/history-index.json',json({schema:'scorebrush-history-publication',version:1,projectId,name:'History.json',
    current:{...info,generation:s.manifest.id,sequence:s.manifest.sequence,presentationSha256:(await fileInfo(new Blob([canonical([])]))).sha256},pending:null}));
  assert.equal((await readPublishedHistory(root,projectId)).version,1);assert.equal(await checkProjectHistory(root,s,[]),false);
  const before=JSON.stringify(s.manifest),objects=new Map(s.objects);
  assert.equal((await syncProjectHistory(root,s)).written,1);assert.equal((await readPublishedHistory(root,projectId)).version,2);
  assert.equal(await checkProjectHistory(root,s,[]),true);const writes=root.control.writes.length;
  assert.equal((await syncProjectHistory(root,s)).written,0);assert.equal(root.control.writes.length,writes);
  assert.equal(JSON.stringify(s.manifest),before);assert.deepEqual(s.objects,objects);
  const index=await readPublishedHistory(root,projectId);
  for(const revision of index.revisions){const annotations=await resolveMetadata(index,s,revision.metadata.annotations);assert.equal(annotations.snapshotId,revision.snapshotId);}
});

test('928 captured states retain exact metadata references in a compact research index',async()=>{
  const specs=Array.from({length:928},(_,n)=>({text:'SYNTHETIC durable note '+n+' '+('retained '.repeat(400))}));
  const s=await snapshot(specs),index=await buildProjectHistory(s),blob=json(index);
  assert.equal(index.events.length,928);assert.equal(index.revisions.length,929);assert(blob.size<LIMITS.json/2);
  const ids=new Set();for(const [n,event]of index.events.entries()){
    ids.add(event.id);assert.equal(event.parentEventId,n?index.events[n-1].id:null);
    const annotations=await resolveMetadata(index,s,event.metadata.annotations);assert.equal(annotations.findings[0].comment,specs[n].text);
    const completion=await resolveMetadata(index,s,event.metadata.completion);assert.equal(completion.revisionId,event.revisionId);
  }
  assert.equal(ids.size,928);console.log('Compact research index:',index.events.length,'events;',blob.size,'bytes;',index.objects.length,'exact objects');
});

test('completed-review events expose their resulting rendering identities without changing legacy event output',async()=>{
  const s=await snapshot([{text:'SYNTHETIC existing legacy edit'},{text:'SYNTHETIC completed review'}]),legacy=await buildProjectHistory(s),completed=s.manifest.records[1];
  completed.resultingSnapshotId='a'.repeat(64);completed.resultingRenderSha256='b'.repeat(64);
  for(const version of [1,2]){
    const index=await buildProjectHistory(s,{version}),revision=index.revisions.find(r=>r.id===completed.id),event=index.events.find(r=>r.id===completed.id);
    assert.equal(revision.kind,'completed-review');assert.equal(event.kind,'completed-review');assert.equal(event.resultingSnapshotId,completed.resultingSnapshotId);assert.equal(event.resultingRenderSha256,completed.resultingRenderSha256);assert.equal(revision.resultingSnapshotId,event.resultingSnapshotId);
    assert.equal(index.events[0].resultingSnapshotId,undefined);assert.equal(index.revisions[0].kind,'durable-edit');
  }
  assert.deepEqual((await buildProjectHistory(s)).events[0],legacy.events[0],'existing retained events keep their exact published representation');
  for(const mutate of [r=>delete r.resultingSnapshotId,r=>r.resultingRenderSha256='invalid',r=>r.resultingRenderSha256=r.payloads['rendered-original.pdf'].sha256]){
    const invalid={...s,manifest:structuredClone(s.manifest)};mutate(invalid.manifest.records[1]);await assert.rejects(buildProjectHistory(invalid),/completed-review rendering identity/);
  }
});
