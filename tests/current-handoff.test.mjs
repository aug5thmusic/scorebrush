// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fast-resume-fixture.mjs';
import {put,get} from './history-memory.mjs';
import {json,seal,localTaskDelivery,fileInfo,makeTask,responseRevision,hydrateTaskPayloads} from '../app/workflow.js';
import {writeCurrentCheckpoint,withCurrentCheckpoint} from '../app/current-checkpoint.js';
import {checkpointPublication,readCurrentHandoff,retainCurrentHandoff,currentEvidenceToken,createHistoricalAssetResolver} from '../app/current-handoff.js';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {head,evidence,note,scene as capture} from './portable-history-fixture.mjs';
import {HistoryDirectory} from './history-memory.mjs';
import {getSavedState,restoreMissing} from '../app/storage.js';
import {saveRecovery} from '../app/folder-recovery.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {workspaceSeed} from '../app/returned.js';
import {taskForScene,rawFolderResponse} from '../app/folder-workspace.js';
import {readFile} from 'node:fs/promises';
const zipModule={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(zipModule,zipModule.exports);globalThis.JSZip=zipModule.exports;
const databases=installMemoryIndexedDB();

async function prepared(){
  const f=await fixture(),result=await writeCurrentCheckpoint(f.directory,f.scene,f.config);
  const ready=JSON.parse(await(await get(f.directory,'.scorebrush/latest/READY.json')).text());ready.currentReview=checkpointPublication(result);
  await put(f.directory,'.scorebrush/latest/READY.json',json(ready));
  const options={paths:f.config.paths,inspectPdf:async()=>structuredClone(f.scene.review.pages)};
  f.directory.control.writes.length=0;return {...f,result,ready,options};
}
async function latest(f,name,value){await put(f.directory,'.scorebrush/latest/'+name,value);}

test('current task uses exact stored prompt and ignores unrelated archive objects',async()=>{
  const f=await prepared(),objects=await(await(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');
  for(let n=0;n<4500;n++){
    const name=(n+1).toString(16).padStart(64,'0');
    objects.children.set(name,{kind:'file',name,getFile:async()=>{throw Error('Unrelated historical object was read');}});
  }
  const result=await readCurrentHandoff(f.directory,f.result,f.options);
  assert.equal(result.entry.id,f.config.head.id);
  assert.equal(result.entry.prompt,await(await get(f.directory,'.scorebrush/latest/PROMPT.txt')).text());
  assert.equal(result.entry.payloads.get('manifest.json').size,(await get(f.directory,'.scorebrush/latest/manifest.json')).size);
  assert.equal(f.result.snapshot.fullHistoryAudited,false);
  assert.deepEqual(f.directory.control.writes,[]);
});

test('current task shares verified equal-content Blobs without skipping per-path reads or changing MIME types',async()=>{
  const f=await prepared(),manifest=JSON.parse(await(await get(f.directory,'.scorebrush/latest/manifest.json')).text()),payloads=new Map();
  for(const path of Object.keys(manifest.payloads))payloads.set(path,await get(f.directory,'.scorebrush/latest/'+path));
  const sourceBytes=await payloads.get('source-original.pdf').arrayBuffer(),copies=['historical/source-copy-one.pdf','historical/source-copy-two.pdf'],otherType='historical/source-other-type.pdf';
  payloads.set('source-original.pdf',new Blob([sourceBytes],{type:'application/pdf'}));
  for(const path of copies)payloads.set(path,new Blob([sourceBytes],{type:'application/pdf'}));
  payloads.set(otherType,new Blob([sourceBytes],{type:'application/octet-stream'}));
  await seal(payloads,manifest);
  for(const [path,blob]of payloads)await latest(f,path,blob);
  await latest(f,'READY.json',json({...f.ready,manifestSha256:(await fileInfo(payloads.get('manifest.json'))).sha256}));

  const reads=new Map(),byteReads=new Map();
  for(const path of Object.keys(manifest.payloads)){
    const parts=('.scorebrush/latest/'+path).split('/');let directory=f.directory;
    for(const part of parts.slice(0,-1))directory=await directory.getDirectoryHandle(part);
    const handle=await directory.getFileHandle(parts.at(-1));
    handle.getFile=async()=>{reads.set(path,(reads.get(path)??0)+1);const blob=handle.blob;return {size:blob.size,type:blob.type,arrayBuffer:async()=>{byteReads.set(path,(byteReads.get(path)??0)+1);return blob.arrayBuffer();}};};
  }
  const first=(await readCurrentHandoff(f.directory,f.result,f.options)).entry,source=first.payloads.get('source-original.pdf');
  for(const path of copies)assert.equal(first.payloads.get(path),source,'same content and MIME must share one owned Blob: '+path);
  assert.equal(first.files.source.blob,source,'input hydration must reuse the same verified payload object');
  assert.notEqual(first.payloads.get(otherType),source);assert.equal(first.payloads.get(otherType).type,'application/octet-stream');assert.equal(source.type,'application/pdf');
  assert.deepEqual(new Uint8Array(await first.payloads.get(otherType).arrayBuffer()),new Uint8Array(sourceBytes));
  assert.deepEqual([...first.payloads.keys()].sort(),[...payloads.keys()].sort(),'all paths and payload bytes remain represented');
  const cloned=structuredClone(first);for(const path of copies)assert.equal(cloned.payloads.get(path),cloned.files.source.blob,'structured-clone persistence retains graph sharing');
  for(const path of Object.keys(manifest.payloads)){assert.equal(reads.get(path),1,'every declared path was freshly opened');assert.equal(byteReads.get(path),1,'every declared path supplied its own bytes');}

  const second=(await readCurrentHandoff(f.directory,f.result,f.options)).entry;
  assert.notEqual(second.payloads.get(copies[0]),first.payloads.get(copies[0]),'reuse cannot cross read operations');
  assert.equal(second.payloads.get(copies[0]),second.files.source.blob);
  for(const path of Object.keys(manifest.payloads)){assert.equal(reads.get(path),2);assert.equal(byteReads.get(path),2,'a later operation reads each path again');}
  await latest(f,copies[1],new Blob([new Uint8Array(sourceBytes.byteLength).fill(88)],{type:'application/pdf'}));
  await assert.rejects(readCurrentHandoff(f.directory,f.result,f.options),/missing or changed: historical\/source-copy-two\.pdf/);
  assert.equal(byteReads.get(copies[1]),3,'a known duplicate still reads and rejects its newly corrupted same-size bytes');
});

test('absent, invalidated and valid stale pins expose no current prompt',async()=>{
  const f=await prepared();
  for(const currentReview of [undefined,{...f.ready.currentReview,id:'a'.repeat(64)}]){
    await latest(f,'READY.json',json({...f.ready,currentReview}));
    assert.equal(await readCurrentHandoff(f.directory,f.result,f.options),null);
  }
  await latest(f,'READY.json',json({...f.ready,ready:false}));assert.equal(await readCurrentHandoff(f.directory,f.result,f.options),null);
  await latest(f,'READY.json',json({...f.ready,currentReview:{...f.ready.currentReview,storageRevision:0}}));
  await assert.rejects(readCurrentHandoff(f.directory,f.result,f.options),/identity is invalid/);
});

test('matching current pin does not hide changed task bytes, paths or baseline',async()=>{
  for(const damage of ['payload','paths','baseline']){
    const f=await prepared();
    if(damage==='payload'){const original=await get(f.directory,'.scorebrush/latest/PROMPT.txt');await latest(f,'PROMPT.txt',new Blob([new Uint8Array(original.size).fill(88)]));}
    if(damage==='paths')await latest(f,'READY.json',json({...f.ready,paths:{...f.ready.paths,ly:'other.ly'}}));
    if(damage==='baseline')await latest(f,'READY.json',json({...f.ready,baseline:{...f.ready.baseline,renderSha256:'a'.repeat(64)}}));
    await assert.rejects(readCurrentHandoff(f.directory,f.result,f.options),/changed|paths differ|different score inputs/);
  }
});

test('task validation rereads READY and the checkpoint after PDF validation',async()=>{
  for(const changed of ['ready','checkpoint']){
    const f=await prepared();
    const inspectPdf=async()=>{
      if(changed==='ready')await latest(f,'READY.json',json({...f.ready,generationId:'SYNTHETIC another publication'}));
      else await writeCurrentCheckpoint(f.directory,{...f.scene,revisionId:crypto.randomUUID(),persistedRevision:2},{...f.config,currentCheckpointId:f.result.id});
      return structuredClone(f.scene.review.pages);
    };
    await assert.rejects(readCurrentHandoff(f.directory,f.result,{...f.options,inspectPdf}),error=>error.name==='RecoveryConflict');
  }
});

test('publication lock checks exact checkpoint before and after its callback',async()=>{
  const f=await prepared();let calls=0;
  assert.equal(await withCurrentCheckpoint(f.directory,f.result,async assertCurrent=>{calls++;assert.equal((await assertCurrent()).id,f.result.id);return 'SYNTHETIC saved';}),'SYNTHETIC saved');
  assert.equal(calls,1);
  const newer=await writeCurrentCheckpoint(f.directory,{...f.scene,revisionId:crypto.randomUUID(),persistedRevision:2},{...f.config,currentCheckpointId:f.result.id});
  await assert.rejects(withCurrentCheckpoint(f.directory,f.result,()=>{calls++;}),error=>error.name==='RecoveryConflict');assert.equal(calls,1);
  await assert.rejects(withCurrentCheckpoint(f.directory,newer,async()=>{await put(f.directory,'.scorebrush/current-review.json',json({...newer.checkpoint,id:'a'.repeat(64)}));}),/does not match its identity/);
});


test('retained task permits its folder prompt projection but rejects same-ID changed context bytes',async()=>{
  const f=await prepared(),original=await localTaskDelivery(f.config.head);
  assert.equal(await retainCurrentHandoff(f.config.head,{lookup:async()=>original,write:async()=>assert.fail('must preserve retained original')}),original);
  const payloads=new Map(original.payloads);payloads.set('historical/previous-rendering.pdf',new Blob(['%PDF SYNTHETIC original context']));
  await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
  const prior={...original,payloads},changedPayloads=new Map(payloads);changedPayloads.set('historical/previous-rendering.pdf',new Blob(['%PDF SYNTHETIC changed context']));
  await seal(changedPayloads,JSON.parse(await changedPayloads.get('manifest.json').text()));
  await assert.rejects(retainCurrentHandoff({...prior,payloads:changedPayloads},{lookup:async()=>prior,write:async()=>assert.fail('must preserve retained original')}),/different original bytes/);
  assert.equal(await prior.payloads.get('historical/previous-rendering.pdf').text(),'%PDF SYNTHETIC original context');
});

test('additive equal-revision evidence requires archive coverage; matching immutable token avoids cloning evidence again',async()=>{
  const record=await head('SYNTHETIC handoff evidence '+crypto.randomUUID()),scene=capture(record),directory=new HistoryDirectory(),paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
  const archived=await saveRecovery(directory,scene,paths),config={recoveryId:archived.id,projectId:archived.projectId,workspaceId:record.id,sourceSha256:record.review.files.source.sha256,paths};
  const token=await currentEvidenceToken(directory,config,scene);assert.equal(token.retainedEvidenceId,null);
  const retainedEvidence=await evidence(record,'SYNTHETIC added by equal-revision backup');
  await restoreMissing([{...record,retainedLegacyEvidence:[retainedEvidence]}]);
  const imported=await getSavedState(record.id);assert.equal(imported.revisionId,record.revisionId);assert.equal(imported.storageRevision,record.storageRevision);assert(imported.retainedEvidenceId);
  assert.equal(await currentEvidenceToken(directory,{...config,archivedEvidenceToken:token},scene,{record:imported}),null);
  const published=await saveRecovery(directory,scene,paths,{expected:archived.id}),next={...config,recoveryId:published.id};
  const covered=await currentEvidenceToken(directory,next,scene);assert.equal(covered.retainedEvidenceId,imported.retainedEvidenceId);
  const rows=databases.get('private-score-desk-local-v1'),sidecar=rows.get(imported.retainedEvidenceId);
  rows.set(imported.retainedEvidenceId,{...sidecar,get retainedLegacyEvidence(){throw Error('Repeated sidecar clone');}});
  try{assert.deepEqual(await currentEvidenceToken(directory,{...next,archivedEvidenceToken:covered},scene),covered);}
  finally{rows.set(imported.retainedEvidenceId,sidecar);}
});


async function historicalAssetFixture(){
  const f=await fixture(),old=new Blob(['%PDF SYNTHETIC older retained rendering']),info=await fileInfo(old),payloads=new Map(f.config.head.payloads);
  payloads.set('historical/previous-rendering.pdf',old);await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
  const declarations={};for(const [path,blob]of payloads){const descriptor=await fileInfo(blob);declarations[path]=descriptor;await put(f.directory,'.scorebrush/recovery/objects/'+descriptor.sha256,blob);}
  const manifest=structuredClone(f.snapshot.manifest);manifest.handoffs.find(bundle=>bundle.id===f.config.head.id).payloads=declarations;await f.commit(manifest);
  const result=await writeCurrentCheckpoint(f.directory,f.scene,f.config),objects=await(await(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');
  return {...f,result,old,info,objects};
}

test('historical resolver reads only exact required old bytes once per send and reuses verified current bytes',async()=>{
  const f=await historicalAssetFixture(),entry=f.objects.children.get(f.info.sha256),getFile=entry.getFile;let reads=0;entry.getFile=async()=>{reads++;return getFile();};
  const resolve=createHistoricalAssetResolver(f.directory,f.result),current=f.result.checkpoint.review.files.source;
  assert.equal(await resolve(current),f.result.files.source.blob);assert.equal(reads,0);
  const first=await resolve(f.info);assert.equal(await first.text(),await f.old.text());assert.notEqual(first,f.old);assert.equal(await resolve(f.info),first);assert.equal(reads,1);
  await assert.rejects(resolve({...f.info,size:f.info.size+1}),/sizes disagree/);assert.equal(reads,1);
  await createHistoricalAssetResolver(f.directory,f.result)(f.info);assert.equal(reads,2,'next send rereads exact disk bytes');
});

test('historical resolver never hides missing, corrupt, undeclared or differently pinned archive inputs',async()=>{
  for(const damage of ['missing','corrupt','undeclared','anchor','project','current']){
    const f=await historicalAssetFixture();let result=f.result,info=f.info;
    if(damage==='missing')f.objects.children.delete(info.sha256);
    if(damage==='corrupt')f.objects.children.get(info.sha256).blob=new Blob([new Uint8Array(info.size).fill(88)]);
    if(damage==='undeclared')info={...info,sha256:'a'.repeat(64)};
    if(damage==='anchor')result={...result,checkpoint:{...result.checkpoint,baseManifestSha256:'a'.repeat(64)}};
    if(damage==='project')result={...result,checkpoint:{...result.checkpoint,projectId:crypto.randomUUID()}};
    if(damage==='current'){info=result.checkpoint.review.files.source;result={...result,files:{...result.files,source:{...result.files.source,blob:new Blob([new Uint8Array(info.size).fill(88)])}}};}
    await assert.rejects(createHistoricalAssetResolver(f.directory,result)(info),error=>error.name==='RecoveryConflict'||/missing or changed|not declared|does not match/.test(error.message));
  }
});


test('historical task references use their exact committed declaration and cannot borrow a cached asset',async()=>{
  const f=await historicalAssetFixture(),resolve=createHistoricalAssetResolver(f.directory,f.result),ref={taskId:f.config.head.id,path:'historical/previous-rendering.pdf'};
  assert.equal(await(await resolve(null,ref)).text(),await f.old.text());
  await assert.rejects(resolve(null,{...ref,taskId:crypto.randomUUID()}),/does not declare/);
  await assert.rejects(resolve(null,{...ref,path:'historical/missing.png'}),/does not declare/);
  await assert.rejects(resolve({...f.info,size:f.info.size+1},ref),/does not declare/);
  await assert.rejects(resolve(null,{...ref,path:'../outside.png'}),/reference is invalid/);
});

test('new retained task inserts without a read; duplicate compares, while operational failure remains a failure',async()=>{
  const f=await prepared(),entry=f.config.head;let reads=0,writes=0;
  const lookup=async()=>{reads++;return entry;};
  assert.equal(await retainCurrentHandoff(entry,{insertFirst:true,lookup,write:async()=>{writes++;}}),entry);assert.equal(reads,0);assert.equal(writes,1);
  assert.equal(await retainCurrentHandoff(entry,{insertFirst:true,lookup,write:async()=>{throw new DOMException('SYNTHETIC duplicate','ConstraintError');}}),entry);assert.equal(reads,1);
  const failure=new DOMException('SYNTHETIC interrupted storage','AbortError');
  await assert.rejects(retainCurrentHandoff(entry,{insertFirst:true,lookup,write:async()=>{throw failure;}}),error=>error===failure);assert.equal(reads,1);
});

test('two follow-ups substitute exact old inputs, images and inherited annotations without mutating issued evidence',async()=>{
  const f=await fixture(),review=structuredClone(f.scene.review);review.findings=[note(0,'SYNTHETIC historical correction')];review.nextNumber=2;
  const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
  const packageMaker=async(review,files)=>{const payloads=await makeRecovery(review,files);for(const finding of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(finding.number).padStart(3,'0')}-${finding.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));};
  let issued=await makeTask(review,f.scene.files,{},'120',()=>{},packageMaker);const store=new Map([[issued.id,issued]]),lookup=async id=>store.get(id),calls=[];
  for(let round=1;round<=2;round++){
    const files={...f.scene.files,rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC follow-up '+round])}},parsed=await rawFolderResponse(issued,files,{zip:zipFiles}),response=responseRevision(parsed);store.set(response.id,response);
    const seed=await workspaceSeed(response,issued,async()=>structuredClone(f.scene.review.pages)),originalPayloads=new Map(issued.payloads),originalFiles={...issued.files},originalTask=JSON.stringify(issued.task),byHash=new Map();
    for(const blob of issued.payloads.values())byHash.set((await fileInfo(blob)).sha256,blob);
    const declarations=JSON.parse(await issued.payloads.get('manifest.json').text()).payloads,owned=new Map();
    const resolveHistorical=async(info,ref={})=>{calls.push({round,...ref});if(ref.path){assert.equal(ref.taskId,issued.id);info=declarations[ref.path];}assert(info);if(!owned.has(info.sha256)){const original=byHash.get(info.sha256);assert(original);assert.equal(original.size,info.size);owned.set(info.sha256,new Blob([await original.arrayBuffer()]));}return owned.get(info.sha256);};
    const next=await taskForScene({...seed,doc:{}},{lookup,packageMaker,resolveHistorical});await hydrateTaskPayloads(next.payloads,async()=>structuredClone(f.scene.review.pages));
    assert.equal(JSON.stringify(issued.task),originalTask);for(const [path,blob]of originalPayloads)assert.equal(issued.payloads.get(path),blob);for(const role of ['source','rendered','ly'])assert.equal(issued.files[role],originalFiles[role]);
    assert.equal(await next.payloads.get('historical/previous-rendering.pdf').text(),await issued.files.rendered.blob.text());assert.notEqual(next.payloads.get('historical/previous-rendering.pdf'),issued.files.rendered.blob);
    const context=next.task.findings[0].historicalContext;assert.equal(await next.payloads.get(context.clean).text(),await png.text());assert(calls.some(call=>call.round===round&&call.path?.endsWith('-clean.png')));
    if(round===2)assert(calls.some(call=>call.round===2&&call.path?.startsWith('historical/annotations/')),'second round resolves exact inherited annotation bytes');
    store.set(next.id,next);issued=next;
  }
});
