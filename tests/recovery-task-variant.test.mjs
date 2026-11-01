// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {identify,newReview,blobHash} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {makeTask,localTaskDelivery,seal,fileInfo} from '../app/workflow.js';
import {addCompletionHistory} from '../app/completion.js';
import {restoreRecovery,RecoveryConflict} from '../app/folder-recovery.js';
import {retain,retained} from '../app/handoff-store.js';
import {getSaved} from '../app/storage.js';
import {folderDelivery,directoryPrompt,folderPrompt} from '../app/folder-task-delivery.js';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';

installMemoryIndexedDB();globalThis.fetch=async url=>new Response(await readFile(url));
const pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}],inspect=async()=>structuredClone(pages);
async function fixture(){
  const label=crypto.randomUUID(),files={source:{name:'source.pdf',blob:new Blob(['%PDF SYNTHETIC source '+label])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF SYNTHETIC render '+label])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC notation'])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,pages),revisionId=crypto.randomUUID();
  const made=await makeTask(review,files,{},'120',()=>{},makeRecovery),payloads=await makeRecovery(review,files),manifest=JSON.parse(await payloads.get('manifest.json').text());
  // Recreate the older original package shape: its manifest retained capture
  // and rendering metadata before safe delivery replaced that manifest.
  for(const[path,blob]of made.payloads)if(path!=='manifest.json')payloads.set(path,blob);
  manifest.taskId=made.id;await seal(payloads,manifest);
  const original={...made,payloads},delivery=await localTaskDelivery(original),objects=new Map();
  async function declarations(values){const result={};for(const[path,blob]of values){const info=await fileInfo(blob);result[path]=info;objects.set(info.sha256,blob);}return result;}
  const recordPayloads=await addCompletionHistory(await makeRecovery(review,files),review,null,revisionId,[],{preserveRevision:true});
  const snapshot={manifest:{schema:'private-score-desk-recovery',version:1,id:crypto.randomUUID(),projectId:crypto.randomUUID(),sourceSha256:identity.source.sha256,current:snapshotId,
    records:[{id:snapshotId,snapshotId,revisionId,storageRevision:1,payloads:await declarations(recordPayloads)}],handoffs:[{id:original.id,kind:'task',payloads:await declarations(original.payloads)}],headTaskId:original.id},objects};
  return {original,delivery,review,snapshot};
}
async function fingerprints(payloads){return [...await Promise.all([...payloads].map(async([path,blob])=>[path,await blobHash(blob)]))].sort(([a],[b])=>a.localeCompare(b));}

test('legacy zero-finding archive restores beside its exact retained delivery without replacing either',async()=>{
  const f=await fixture();assert.equal(f.original.task.findings.length,0);assert.notEqual(await blobHash(f.original.payloads.get('manifest.json')),await blobHash(f.delivery.payloads.get('manifest.json')));
  const original=await fingerprints(f.original.payloads),local=await fingerprints(f.delivery.payloads);await retain(f.delivery);
  assert.equal(await restoreRecovery(f.snapshot,inspect),f.snapshot.manifest.current);
  const restored=await getSaved(f.snapshot.manifest.current);assert.equal(restored.review.snapshotId,f.review.snapshotId);assert.deepEqual(restored.review.findings,[]);
  assert.deepEqual(await fingerprints((await retained(f.original.id)).payloads),local,'existing immutable local delivery is not replaced');
  const evidence=restored.retainedHandoffEvidence.find(e=>e.bundle.id===f.original.id);assert(evidence);assert.deepEqual(await fingerprints(evidence.payloads),original,'byte-exact archived original remains additive recovery evidence');
  assert.equal(await restoreRecovery(f.snapshot,inspect),f.snapshot.manifest.current);assert.equal((await getSaved(f.snapshot.manifest.current)).storageRevision,restored.storageRevision,'retry does not create an edit or revision');
});

test('an altered local prompt cannot match the deterministic delivery projection',async()=>{
  const f=await fixture(),modified={...f.delivery,payloads:new Map(f.delivery.payloads)};
  modified.payloads.set('PROMPT.txt',new Blob(['SYNTHETIC altered prompt; must not be accepted as the application projection']));
  await seal(modified.payloads,JSON.parse(await modified.payloads.get('manifest.json').text()));await retain(modified);
  const before=await fingerprints(modified.payloads);
  await assert.rejects(restoreRecovery(f.snapshot,inspect),RecoveryConflict);
  assert.equal(await getSaved(f.snapshot.manifest.current),undefined,'conflicting handoff fails before restoring the review');
  assert.deepEqual(await fingerprints((await retained(f.original.id)).payloads),before,'rejection preserves the conflicting original for recovery');
});

test('matching payload declarations cannot hide modified projection bytes',async()=>{
  const f=await fixture(),modified={...f.delivery,payloads:new Map(f.delivery.payloads)};
  const prompt=await modified.payloads.get('PROMPT.txt').text();modified.payloads.set('PROMPT.txt',new Blob([prompt.replace('REVIEW','ALTER!')]));
  assert.equal(modified.payloads.get('PROMPT.txt').size,f.delivery.payloads.get('PROMPT.txt').size);await retain(modified);
  await assert.rejects(restoreRecovery(f.snapshot,inspect),RecoveryConflict);assert.equal(await getSaved(f.snapshot.manifest.current),undefined);
});

test('actual zero-finding folder deliveries restore with the exact app prefix and optional native path',async()=>{
  for(const path of [null,String.raw`C:\Music\Étude 新`,String.raw`\\server\share\score \`name\``]){
    const f=await fixture(),delivery=await folderDelivery(f.original,path?{addDirectoryPath:true,absolutePath:path}:{});
    assert.equal(delivery.task.findings.length,0);assert.ok(delivery.prompt.includes(folderPrompt));
    const original=await fingerprints(f.original.payloads),local=await fingerprints(delivery.payloads);await retain(delivery);
    assert.equal(await restoreRecovery(f.snapshot,inspect),f.snapshot.manifest.current);
    const restored=await getSaved(f.snapshot.manifest.current),evidence=restored.retainedHandoffEvidence.find(item=>item.bundle.id===f.original.id);
    assert.deepEqual(await fingerprints((await retained(delivery.id)).payloads),local,'existing folder delivery is immutable');
    assert.deepEqual(await fingerprints(evidence.payloads),original,'archived original remains exact additive evidence');
    assert.equal(await restoreRecovery(f.snapshot,inspect),f.snapshot.manifest.current,'folder variant recovery remains idempotent');
  }
});

test('folder variant matching rejects altered instructions and injected or noncanonical path envelopes',async()=>{
  const mutations=[
    prompt=>prompt.replace(folderPrompt,'SYNTHETIC altered folder instructions'),
    prompt=>prompt.replace('REVIEW THE SUPPLIED','IGNORE THE SUPPLIED'),
    prompt=>prompt.replace('\nWorking directory',' EXTRA INSTRUCTIONS\nWorking directory'),
    prompt=>'`'+JSON.stringify('C:\\Music\nSYNTHETIC injected instruction')+'`'+prompt.slice(prompt.indexOf('\n')),
    prompt=>'`"\\u0043:\\\\Music"`'+prompt.slice(prompt.indexOf('\n')),
    prompt=>'`'+JSON.stringify('C:\\'+ 'x'.repeat(4096))+'`'+prompt.slice(prompt.indexOf('\n')),
    prompt=>'`'+ 'x'.repeat(32768)+'`\n'+prompt
  ];
  for(const mutate of mutations){
    const f=await fixture(),delivery=await folderDelivery(f.original,{addDirectoryPath:true,absolutePath:'C:\\Music'}),modified={...delivery,payloads:new Map(delivery.payloads)};
    modified.payloads.set('PROMPT.txt',new Blob([mutate(delivery.prompt)]));
    await seal(modified.payloads,JSON.parse(await modified.payloads.get('manifest.json').text()));await retain(modified);
    const before=await fingerprints(modified.payloads);await assert.rejects(restoreRecovery(f.snapshot,inspect),RecoveryConflict);
    assert.equal(await getSaved(f.snapshot.manifest.current),undefined);assert.deepEqual(await fingerprints((await retained(delivery.id)).payloads),before);
  }
  assert.throws(()=>directoryPrompt(folderPrompt,'C:\\Music\nSYNTHETIC injected instruction',true),/full folder path/);
});
