// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// All files and stores in these round trips are synthetic and in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview,clone,sha256} from '../app/model.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {prepareBackup,prepareCompletion} from '../app/completion.js';
import {makeTask,readPackage,readResponse,responseRevision,json,seal,fileInfo,localTaskDelivery,inspectZip} from '../app/workflow.js';
import {workspaceSeed,restoreReturnedBackup} from '../app/returned.js';
import {decodeRecovery} from '../app/folder-recovery.js';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {head,boundarySnapshot,legacyIndex,scene as portableScene,currentState,inspect as portableInspect,note} from './portable-history-fixture.mjs';
import {addPortableHistory,importPortableHistory} from '../app/portable-history.js';
import {LIMITS} from '../app/workflow.js';
import {buildProjectHistory} from '../app/project-history.js';
import {putSaved} from '../app/storage.js';
import {retainLegacyState} from '../app/qa/legacy-journal-fixture.js';

globalThis.crypto??=webcrypto;
installMemoryIndexedDB();
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
globalThis.fetch=async url=>new Response(await readFile(url));
const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
const files={source:{name:'source.pdf',blob:new Blob(['%PDF-synthetic source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF-synthetic original rendering'])},ly:{name:'score.ly',blob:new Blob(['% Synthetic notation\n{ c4 des4 }'])}};
const pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}],inspectPdf=async()=>pages;
const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,pages);
review.findings=[{id:'correction',number:1,page:1,comment:'Synthetic correction',type:'correction',state:'open',color:'#ffd34d',strokes:[],bounds:null},{id:'comment',number:2,page:1,comment:'Synthetic internal comment',type:'comment',state:'open',color:'#ffd34d',strokes:[],bounds:null}];review.nextNumber=3;
const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
async function packageMaker(review,files){const payloads=await makeRecovery(review,files);for(const f of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(f.number).padStart(3,'0')}-${f.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));}
const scene=()=>({review:clone(review),files,doc:{},returned:null,revisionId:crypto.randomUUID(),completions:[],workspaceId:snapshotId,persistedRevision:1});

test('ordinary backup round-trips exact inputs and notes without a completion declaration',async()=>{
  const current=scene(),before=JSON.stringify(current.review),result=await prepareBackup(current,()=>{},packageMaker),parsed=await readPackage(await zipFiles(result.payloads),inspectPdf);
  assert.equal(result.record,undefined);assert.equal(parsed.manifest.kind,'review-backup');assert.equal(parsed.manifest.completionId,undefined);
  assert.deepEqual(parsed.completionBundle.records,[]);assert.equal(parsed.completionBundle.revisionId,current.revisionId);assert.equal(parsed.review.updatedAt,current.review.updatedAt);assert.equal(result.payloads.has('completion-summary.txt'),false);
  assert.deepEqual(parsed.review.findings,current.review.findings);assert.equal(JSON.stringify(current.review),before);assert.deepEqual(current.completions,[]);
  for(const role of ['source','rendered','ly'])assert.equal(await sha256(await parsed.files[role].blob.arrayBuffer()),current.review.files[role].sha256);
});

test('new backups preserve imported legacy completion records exactly without adding another',async()=>{
  const old=scene(),legacy=await prepareCompletion(old,{scope:'partial',note:'Synthetic legacy scope',reviewer:'Synthetic legacy reviewer'},{id:crypto.randomUUID(),createdAt:new Date().toISOString()},()=>{},packageMaker);
  const imported=await readPackage(await zipFiles(legacy.payloads),inspectPdf),current={...old,review:imported.review,completions:imported.completionBundle.records};
  const first=await prepareBackup(current,()=>{},packageMaker),firstParsed=await readPackage(await zipFiles(first.payloads),inspectPdf);
  assert.deepEqual(firstParsed.completionBundle.records,[legacy.record]);assert.equal(firstParsed.manifest.completionId,undefined);
  current.review=clone(current.review);current.review.findings[0].comment+='; later edit';current.revisionId=crypto.randomUUID();
  const second=await prepareBackup(current,()=>{},packageMaker),secondParsed=await readPackage(await zipFiles(second.payloads),inspectPdf);
  assert.deepEqual(secondParsed.completionBundle.records,[legacy.record]);assert.equal(secondParsed.completionBundle.revisionId,current.revisionId);
  assert.equal(secondParsed.review.findings[0].comment,current.review.findings[0].comment);assert.equal(secondParsed.completionBundle.records[0].evidence.annotations.findings[0].comment,'Synthetic correction');
});

test('ordinary backup preserves returned decisions, internal comments, and the exact earlier task/render',async()=>{
  const issued=await makeTask(review,files,{},'page',()=>{},packageMaker),response=JSON.parse(await issued.payloads.get('response-template.json').text());
  const code=new Blob(['% Synthetic changed notation\n{ c4 d4 }']),rendered=new Blob(['%PDF-synthetic changed rendering']);
  response.code={status:'changed',path:'corrected.ly'};response.rendering={status:'supplied',path:'corrected.pdf',producer:'Synthetic test',compiler:null};
  response.files={'corrected.ly':await fileInfo(code),'corrected.pdf':await fileInfo(rendered)};
  response.results.forEach(f=>{f.status=f.id==='comment'?'unchanged_with_reason':'changed';f.explanation='Synthetic response';});
  const store=new Map([[issued.id,issued]]),lookup=async id=>store.get(id),accepted=await readResponse(await zipFiles(new Map([['response.json',json(response)],['corrected.ly',code],['corrected.pdf',rendered]])),lookup),entry=responseRevision(accepted);store.set(entry.id,entry);
  const seed=await workspaceSeed(entry,issued,inspectPdf),finding=seed.returned.reported.find(f=>f.id==='correction');finding.state='resolved';finding.explanation='Checked synthetic correction';finding.decision={state:finding.state,explanation:finding.explanation,reviewed:{snapshotId:seed.review.snapshotId,codeSha256:seed.returned.codeSha256,renderSha256:seed.returned.renderSha256}};
  const current={...scene(),...seed,workspaceId:seed.returned.id},result=await prepareBackup(current,()=>{},packageMaker,{lookup});
  const restored=await restoreReturnedBackup(await readPackage(await zipFiles(result.payloads),inspectPdf),inspectPdf);
  assert.equal(JSON.stringify(restored.seed.returned.reported),JSON.stringify(seed.returned.reported));assert.deepEqual(restored.seed.completionBundle.records,[]);assert.equal(restored.seed.completionBundle.revisionId,current.revisionId);
  assert.equal(restored.seed.returned.reported.find(f=>f.id==='comment').type,'comment');
  for(const [path,blob]of issued.payloads)assert.equal(await sha256(await restored.issued.payloads.get(path).arrayBuffer()),await sha256(await blob.arrayBuffer()),path);
  assert.equal(await restored.seed.files.rendered.blob.text(),await rendered.text());assert.equal(await restored.issued.files.rendered.blob.text(),await files.rendered.blob.text());
  // Folder delivery adds a prompt preamble without changing the task identity.
  // A backup may embed that delivery while the journal retains the original
  // task. Decoding must not replace the journal's exact immutable payloads.
  const delivery=await localTaskDelivery(issued);delivery.payloads.set('PROMPT.txt',new Blob(['SYNTHETIC folder delivery preamble.\n',delivery.payloads.get('PROMPT.txt')]));
  await seal(delivery.payloads,JSON.parse(await delivery.payloads.get('manifest.json').text()));store.set(issued.id,delivery);
  const deliveredBackup=await prepareBackup(current,()=>{},packageMaker,{lookup}),objects=new Map();
  async function declarations(payloads){const result={};for(const[path,blob]of payloads){const info=await fileInfo(blob);objects.set(info.sha256,blob);result[path]=info;}return result;}
  const snapshot={manifest:{sourceSha256:review.files.source.sha256,current:current.workspaceId,
    records:[{id:current.workspaceId,snapshotId:current.review.snapshotId,revisionId:current.revisionId,payloads:await declarations(deliveredBackup.payloads)}],
    handoffs:[{id:issued.id,kind:'task',payloads:await declarations(issued.payloads)},{id:entry.id,kind:'response',taskId:issued.id,createdAt:entry.createdAt,payloads:await declarations(entry.payloads)}]},objects};
  const index=await buildProjectHistory(snapshot),indexed=index.revisions.find(r=>r.id===current.workspaceId);
  const resolveMetadata=async id=>{const o=index.objects.find(o=>o.id===id);assert(o);return JSON.parse(await snapshot.objects.get(o.sha256).text());};
  assert.deepEqual((await resolveMetadata(indexed.metadata.returned)).returned,seed.returned);
  assert.deepEqual((await resolveMetadata(indexed.metadata.annotations)).findings,seed.review.findings);
  assert.equal((await resolveMetadata(indexed.metadata.completion)).revisionId,current.revisionId);
  assert.deepEqual((await resolveMetadata(index.handoffs.find(h=>h.id===issued.id).metadataId)),JSON.parse(await issued.payloads.get('task.json').text()));
  const declared=(await resolveMetadata(indexed.packageManifestId)).payloads;for(const [path,info]of Object.entries(declared)){assert(index.objects.some(o=>o.sha256===info.sha256&&o.size===info.size),path);}
  const decoded=await decodeRecovery(snapshot,inspectPdf),original=decoded.entries.find(e=>e.id===issued.id);
  assert.equal(decoded.entryVariants.find(e=>e.id===issued.id).payloads.get('PROMPT.txt').size,delivery.payloads.get('PROMPT.txt').size);
  assert.deepEqual(decoded.records[0].retainedHandoffEvidence.map(e=>e.bundle.id),[issued.id,entry.id]);
  assert.notEqual(await delivery.payloads.get('PROMPT.txt').text(),await issued.payloads.get('PROMPT.txt').text());
  assert.equal(original.payloads.size,issued.payloads.size);
  for(const[path,blob]of issued.payloads)assert.equal((await fileInfo(original.payloads.get(path))).sha256,(await fileInfo(blob)).sha256,'immutable recovery task '+path);
});

test('backup rejects replaced input bytes and supports cancellation before producing a package',async()=>{
  const current=scene();current.files={...files,ly:{...files.ly,blob:new Blob(['Different synthetic bytes'])}};
  let called=false;await assert.rejects(prepareBackup(current,()=>{},async()=>{called=true;}),/Current input bytes changed/);assert.equal(called,false);
  const controller=new AbortController(),stop=new Error('Synthetic cancellation');
  await assert.rejects(prepareBackup(scene(),()=>{},async(...args)=>{assert.equal(args[5].signal,controller.signal);controller.abort(stop);return packageMaker(...args);},{signal:controller.signal}),error=>error===stop);
});

test('compact exports preserve large metadata and legacy v1 imports enforce the exact 25 MiB limit',async()=>{
  for(const offset of [-1,0,1]){
    const record=await head('boundary '+offset),snapshot=await boundarySnapshot(record,LIMITS.json+offset),before=await currentState(record.id);
    const base=await prepareBackup(portableScene(record),()=>{},makeRecovery),original=[...base.payloads.keys()];
    const exported=await addPortableHistory(base,portableScene(record),{baseSnapshot:snapshot});
    assert.equal(JSON.parse(await exported.payloads.get('History.json').text()).version,2);
    assert(exported.payloads.get('History.json').size<LIMITS.json/4,'large original notes do not inflate the compact index');
    assert.equal(await importPortableHistory(await readPackage(await zipFiles(exported.payloads),portableInspect),portableInspect),record.id);
    const legacy=await legacyIndex(exported);assert.equal(legacy.size,LIMITS.json+offset);
    const v1={...exported,payloads:new Map(exported.payloads)};v1.payloads.set('History.json',legacy);await seal(v1.payloads,JSON.parse(await v1.payloads.get('manifest.json').text()));
    if(offset>0){
      await assert.rejects(importPortableHistory(await readPackage(await zipFiles(v1.payloads),portableInspect),portableInspect),/History\.json exceeds.*25 MiB.*No history was discarded/);
      const padded=exported.payloads.get('History.json');exported.payloads.set('History.json',new Blob([padded,' '.repeat(LIMITS.json+1-padded.size)]));await seal(exported.payloads,JSON.parse(await exported.payloads.get('manifest.json').text()));
      await assert.rejects(importPortableHistory(await readPackage(await zipFiles(exported.payloads),portableInspect),portableInspect),/History\.json exceeds/);
    }else{
      const zip=await zipFiles(v1.payloads),parsed=await readPackage(zip,portableInspect);assert.equal(await importPortableHistory(parsed,portableInspect),record.id);
      console.log('Legacy portable history boundary round-trip:',legacy.size,'index bytes;',zip.size,'ZIP bytes');
    }
    assert.deepEqual([...base.payloads.keys()],original,'generation does not mutate the base backup');
    const after=await currentState(record.id);assert.deepEqual(after.journal,before.journal);assert.deepEqual({...after.head,retainedLegacyEvidence:undefined},{...before.head,retainedLegacyEvidence:undefined});
  }
});

test('36-state/120-note history round-trips without duplicated research metadata',async()=>{
  let record=await retainLegacyState(await head('SYNTHETIC large history'));
  for(let n=0;n<36;n++){const review=structuredClone(record.review);review.findings=Array.from({length:120},(_,i)=>note(i,n+':'+i+':'+('SYNTHETIC note text ').repeat(180)));review.nextNumber=121;record=await retainLegacyState(await putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision));}
  const before=await currentState(record.id),result=await addPortableHistory(await prepareBackup(portableScene(record),()=>{},makeRecovery),portableScene(record));
  const index=JSON.parse(await result.payloads.get('History.json').text());assert.equal(index.version,2);assert.equal(index.events.length,37);
  assert(result.payloads.get('History.json').size<LIMITS.json/10);assert((await legacyIndex(result)).size>LIMITS.json);
  for(const event of index.events){const object=index.objects.find(o=>o.id===event.metadata.annotations);const annotations=JSON.parse(await result.payloads.get(object.path).text());assert.deepEqual(annotations.findings,before.journal.find(r=>r.id===event.id).review.findings);}
  const parsed=await readPackage(await zipFiles(result.payloads),portableInspect);assert.equal(await importPortableHistory(parsed,portableInspect),record.id);
  assert.deepEqual(await currentState(record.id),before);assert.equal(before.journal.length,37);
});

test('nested portable ZIPs restore below and at 5,000 entries; overflow fails before returning a backup',async()=>{
  for(const target of [LIMITS.count-1,LIMITS.count,LIMITS.count+1]){
    const record=await head('ZIP entries '+target),s=portableScene(record),before=await currentState(record.id);
    const base=await prepareBackup(s,()=>{},makeRecovery),probe=await addPortableHistory(base,s);
    // Unique nested parents expose implicit directory entries, even for tiny
    // files. These are manifest-declared synthetic companion payloads.
    for(let i=0;i<target-probe.payloads.size;i++)base.payloads.set(`synthetic/branch-${i}/nested/evidence.txt`,new Blob(['SYNTHETIC '+i]));
    const unchanged=new Map(base.payloads);
    if(target>LIMITS.count){
      let exported;await assert.rejects(async()=>{exported=await addPortableHistory(base,s);},/exceeds backup capacity.*no older history was discarded/);
      assert.equal(exported,undefined);
    }else{
      const exported=await addPortableHistory(base,s);assert.equal(exported.payloads.size,target);
      const zip=await zipFiles(exported.payloads),entries=inspectZip(await zip.arrayBuffer());
      assert.equal(entries.length,target);assert(entries.every(e=>!e.directory),'no implicit parents consume the entry budget');
      const parsed=await readPackage(zip,portableInspect);assert.equal(await importPortableHistory(parsed,portableInspect),record.id);
      for(const [path,blob]of exported.payloads)assert.deepEqual(await fileInfo(parsed.payloads.get(path)),await fileInfo(blob),path);
      console.log('Nested portable ZIP round-trip:',target,'payloads and entries;',zip.size,'ZIP bytes');
      if(target===LIMITS.count){
        const oversized=new Map(exported.payloads);oversized.set('synthetic/extra/deep/evidence.txt',new Blob(['SYNTHETIC overflow']));
        await seal(oversized,JSON.parse(await oversized.get('manifest.json').text()));
        await assert.rejects(readPackage(await zipFiles(oversized),portableInspect),/excessive ZIP directory/,'importer retains its hard 5,000-entry bound');
      }
    }
    assert.deepEqual(base.payloads,unchanged);assert.deepEqual(await currentState(record.id),before,'entry capacity never changes or prunes saved history');
  }
});

test('250-state/1,989-finding backup restores with exactly 4,998 ZIP entries',async()=>{
  let record=await retainLegacyState(await head('SYNTHETIC ZIP entry overhead'));
  for(let n=0;n<248;n++){const review=structuredClone(record.review);review.findings=[note(0,'SYNTHETIC earlier '+n)];review.nextNumber=2;record=await retainLegacyState(await putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision));}
  const review=structuredClone(record.review);review.findings=Array.from({length:1989},(_,i)=>note(i,'SYNTHETIC current '+i));review.nextNumber=1990;
  record=await retainLegacyState(await putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision));
  const before=await currentState(record.id),s=portableScene(record),exported=await addPortableHistory(await prepareBackup(s,()=>{},packageMaker),s);
  assert.equal(before.journal.length,250);assert.equal(exported.payloads.size,4998);
  const zip=await zipFiles(exported.payloads),entries=inspectZip(await zip.arrayBuffer());assert.equal(entries.length,4998);assert(entries.every(e=>!e.directory));
  const parsed=await readPackage(zip,portableInspect);assert.equal(await importPortableHistory(parsed,portableInspect),record.id);
  assert.deepEqual(parsed.review.findings,review.findings);assert.deepEqual(await currentState(record.id),before);
});


test('frozen v1 transfer from the previously packaged app restores exact revisions and upgrades to v2',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/history-v1-transfer.json',import.meta.url),'utf8'));
  const payloads=new Map(fixture.payloads.map(([path,text])=>[path,new Blob([text])]));
  assert.equal(JSON.parse(await payloads.get('History.json').text()).version,1);
  const parsed=await readPackage(await zipFiles(payloads),portableInspect);assert.equal(await importPortableHistory(parsed,portableInspect),fixture.workspaceId);
  const restored=await currentState(fixture.workspaceId);assert.deepEqual(restored.journal.map(r=>r.id).sort(),[...fixture.eventIds].sort());
  assert.deepEqual(restored.journal.map(r=>r.revisionId).sort(),[...fixture.revisionIds].sort());
  assert.equal(restored.head.review.findings[0].comment,'SYNTHETIC later correction');
  const exported=await addPortableHistory(await prepareBackup(portableScene(restored.head),()=>{},makeRecovery),portableScene(restored.head));
  const index=JSON.parse(await exported.payloads.get('History.json').text());assert.equal(index.version,2);assert.deepEqual(index.events.map(e=>e.id).sort(),[...fixture.eventIds].sort());
  // A structurally plausible index must still match the validated original
  // objects; changing a metadata link cannot relabel code as annotations.
  index.revisions[0].metadata.annotations=index.revisions[0].assetIds.ly;exported.payloads.set('History.json',json(index));await seal(exported.payloads,JSON.parse(await exported.payloads.get('manifest.json').text()));
  await assert.rejects(importPortableHistory(await readPackage(await zipFiles(exported.payloads),portableInspect),portableInspect),/research index differs/);
  assert.deepEqual(await currentState(fixture.workspaceId),restored);
});
