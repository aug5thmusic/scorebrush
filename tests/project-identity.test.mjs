// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {identify,newReview} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {prepareBackup} from '../app/completion.js';
import {makeTask,localTaskDelivery,readPackagePayloads,hydrateTaskPayloads,json,seal} from '../app/workflow.js';
import {projectWorkspaceId,validateWorkspaceIdentity} from '../app/project-identity.js';
import {readFile} from 'node:fs/promises';
globalThis.fetch=async url=>new Response(await readFile(url));
const files={source:{name:'source.pdf',blob:new Blob(['synthetic source'])},rendered:{name:'rendered.pdf',blob:new Blob(['synthetic rendering'])},ly:{name:'score.ly',blob:new Blob(['{ c4 }'])}};
const pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}],inspect=async()=>pages;
const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,pages);
const scene=()=>{const projectId=crypto.randomUUID();return {projectId,workspaceId:projectWorkspaceId(projectId,snapshotId),review,files,revisionId:crypto.randomUUID(),completions:[],returned:null,initialTranscriptionFilename:'original-title.pdf',parentWorkspaceId:null};};
// Frozen format admission from the pre-project reader. It intentionally has no
// knowledge of workspace metadata: silently accepting v1 was the regression.
async function oldVersion1Reader(payloads){
  const m=JSON.parse(await payloads.get('manifest.json').text());
  const legacy=m.schema==='score-desk-package'&&m.version===1,clean=m.schema==='score-desk-input'&&m.version===1;
  if(!legacy&&!clean)throw new Error('This package format is not supported.');
  return {snapshotId:m.snapshotId};
}
test('backup metadata round trips distinct logical projects over identical content',async()=>{
  const a=scene(),b=scene();assert.notEqual(a.workspaceId,b.workspaceId);
  for(const current of [a,b]){
    const {payloads}=await prepareBackup(current,()=>{},makeRecovery),parsed=await readPackagePayloads(payloads,inspect);
    assert.equal(parsed.workspace.id,current.workspaceId);assert.equal(parsed.workspace.projectId,current.projectId);
    assert.equal(parsed.workspace.initialTranscriptionFilename,'original-title.pdf');assert.equal(parsed.review.snapshotId,snapshotId);
    assert.equal(parsed.completionBundle.revisionId,current.revisionId);
  }
});
test('legacy hash-key backups remain readable without inventing new identities',async()=>{
  const parsed=await readPackagePayloads(await makeRecovery(review,files),inspect);
  assert.equal(parsed.workspace,null);assert.equal(parsed.review.snapshotId,snapshotId);
  const projectId=crypto.randomUUID();assert.equal(validateWorkspaceIdentity({id:snapshotId,projectId},snapshotId).id,snapshotId);
});
test('project-scoped task identity survives validated local delivery and cannot claim different bytes',async()=>{
  const current=scene(),task=await makeTask(review,files,null,'120',()=>{},makeRecovery,current);
  const hydrated=await hydrateTaskPayloads(task.payloads,inspect);assert.equal(hydrated.task.workspace.id,current.workspaceId);
  const mutated=structuredClone(task.task);mutated.workspace.id=projectWorkspaceId(current.projectId,'a'.repeat(64));
  const payloads=new Map(task.payloads);payloads.set('task.json',json(mutated));await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
  await assert.rejects(()=>hydrateTaskPayloads(payloads,inspect),/project identity/);
});
test('backup identity rejects cross-project scoped keys, returned disguises and unsupported fields',async()=>{
  const current=scene(),other=scene();
  assert.throws(()=>validateWorkspaceIdentity({id:current.workspaceId,projectId:other.projectId},snapshotId),/project identity/);
  assert.throws(()=>validateWorkspaceIdentity({...current, id:current.workspaceId},snapshotId),/project identity/);
  const {payloads}=await prepareBackup(current,()=>{},makeRecovery),manifest=JSON.parse(await payloads.get('manifest.json').text());
  manifest.workspace.id='returned:synthetic:received';payloads.set('manifest.json',json(manifest));
  await assert.rejects(()=>readPackagePayloads(payloads,inspect),/workspace differs/);
});
test('old readers fail closed on scoped backup and task packages while legacy v1 stays readable',async()=>{
  const current=scene(),backup=await prepareBackup(current,()=>{},makeRecovery),task=await makeTask(review,files,null,'120',()=>{},makeRecovery,current);
  for(const payloads of [backup.payloads,task.payloads]){
    assert.equal(JSON.parse(await payloads.get('manifest.json').text()).version,2);
    await assert.rejects(()=>oldVersion1Reader(payloads),/format is not supported/);
    assert.equal((await readPackagePayloads(payloads,inspect)).workspace.id,current.workspaceId);
  }
  const legacy=await makeRecovery(review,files),legacyTask=await makeTask(review,files,null,'120',()=>{},makeRecovery);
  for(const payloads of [legacy,legacyTask.payloads]){
    assert.equal(JSON.parse(await payloads.get('manifest.json').text()).version,1);
    assert.equal((await oldVersion1Reader(payloads)).snapshotId,snapshotId);
    assert.equal((await readPackagePayloads(payloads,inspect)).workspace,null);
  }
});
test('v2 rejects missing or invalid project provenance without falling back to the content key',async()=>{
  const payloads=await makeRecovery(review,files),manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.version=2;
  for(const workspace of [undefined,null,{id:snapshotId,projectId:'not-a-project'},{id:snapshotId}]){
    manifest.workspace=workspace;payloads.set('manifest.json',json(manifest));
    await assert.rejects(()=>readPackagePayloads(payloads,inspect),/project workspace identity|project identity/);
  }
  manifest.version=3;await assert.rejects(()=>readPackagePayloads(new Map(payloads).set('manifest.json',json(manifest)),inspect),/format is not supported/);
});
test('task provenance requires exact schema, baseline and manifest task agreement',async()=>{
  const current=scene(),entry=await makeTask(review,files,null,'120',()=>{},makeRecovery,current);
  const variants=[task=>{task.schema='untrusted';},task=>{task.id='another-id';},task=>{task.baseline.sourceSha256='a'.repeat(64);},task=>{task.findings=null;},task=>{task.shared=true;}];
  for(const mutate of variants){
    const task=structuredClone(entry.task);mutate(task);const payloads=new Map(entry.payloads);payloads.set('task.json',json(task));await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
    await assert.rejects(()=>readPackagePayloads(payloads,inspect),/task identity|connected project/);
  }
  const payloads=new Map(entry.payloads),manifest=JSON.parse(await payloads.get('manifest.json').text()),other=scene();
  manifest.workspace={id:other.workspaceId,projectId:other.projectId};payloads.set('manifest.json',json(manifest));
  await assert.rejects(()=>readPackagePayloads(payloads,inspect),/Task project identity differs/);
});
test('task imports preserve ordinary project ownership and represent returned tasks as scoped baseline branches',async()=>{
  const current=scene(),legacyCurrent={...current,workspaceId:snapshotId};
  for(const source of [current,legacyCurrent]){
    const entry=await makeTask(review,files,null,'120',()=>{},makeRecovery,source),parsed=await readPackagePayloads(entry.payloads,inspect);
    assert.equal(parsed.workspace.id,source.workspaceId);assert.equal(parsed.workspace.projectId,source.projectId);
  }
  const returnedScene={...current,workspaceId:'returned:synthetic-response:received'},entry=await makeTask(review,files,null,'120',()=>{},makeRecovery,returnedScene);
  entry.task.version=2;const delivery=await localTaskDelivery(entry),parsed=await readPackagePayloads(delivery.payloads,inspect);
  assert.equal(parsed.workspace.id,projectWorkspaceId(current.projectId,snapshotId));
  assert.equal(parsed.workspace.projectId,current.projectId);assert.equal(parsed.workspace.parentWorkspaceId,returnedScene.workspaceId);
  assert.equal(parsed.workspace.initialTranscriptionFilename,current.initialTranscriptionFilename);
  assert.equal((await hydrateTaskPayloads(delivery.payloads,inspect)).task.workspace.id,returnedScene.workspaceId,'immutable task origin is preserved separately from its import branch');
  await assert.rejects(()=>oldVersion1Reader(delivery.payloads),/format is not supported/);
});
