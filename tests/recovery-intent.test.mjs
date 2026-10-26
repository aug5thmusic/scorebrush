// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {HistoryDirectory,put} from './history-memory.mjs';
import {head,note,scene} from './portable-history-fixture.mjs';
import {putSaved} from '../app/storage.js';
import {saveRecovery,readRecovery,reconcileRecoveryIntent} from '../app/folder-recovery.js';
import {json,fileInfo} from '../app/workflow.js';
globalThis.crypto??=webcrypto;globalThis.fetch=async url=>new Response(await readFile(url));
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});installMemoryIndexedDB();
const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
async function edit(record,text){const review=structuredClone(record.review);review.findings=[note(0,text)];review.nextNumber=2;return putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision);}
async function fixture(existing=true){let record=await head('SYNTHETIC durable archive '+crypto.randomUUID());const directory=new HistoryDirectory();const saved=existing?await saveRecovery(directory,scene(record),paths):null;let durable={recoveryId:saved?.id??null,projectId:saved?.projectId??record.projectId};return {directory,record,get durable(){return durable;},save:(record,fail=false)=>saveRecovery(directory,scene(record),paths,{expected:durable.recoveryId,projectId:durable.projectId,pendingRecoveryIntent:durable.pendingRecoveryIntent,beforeCommit:async intent=>{durable={...durable,recoveryId:intent.parent,projectId:intent.projectId,pendingRecoveryIntent:structuredClone(intent)};if(fail)throw Error('SYNTHETIC before COMMIT');}})};}

test('initial and later archive intents survive failure before COMMIT and newer local work',async()=>{
 for(const existing of [false,true]){const f=await fixture(existing),record=await edit(f.record,'first');const prior=f.durable.recoveryId;await assert.rejects(f.save(record,true),/before COMMIT/);assert.equal((await readRecovery(f.directory))?.manifest.id??null,prior);assert.match(f.durable.pendingRecoveryIntent.manifestSha256,/^[a-f0-9]{64}$/);const newer=await edit(record,'newer');const saved=await f.save(newer);assert.equal(saved.snapshot.manifest.parent,prior);assert.equal(saved.snapshot.manifest.records.find(r=>r.id===newer.id).revisionId,newer.revisionId);assert.equal(reconcileRecoveryIntent(await readRecovery(f.directory),f.durable).pendingRecoveryIntent,null);}
});
test('exact unacknowledged publication preserves newer edits across a repeatedly interrupted retry',async()=>{
 const f=await fixture(),first=await edit(f.record,'first'),committed=await f.save(first),original=f.durable.recoveryId;assert.notEqual(original,committed.id);
 const second=await edit(first,'newer decision');await assert.rejects(f.save(second,true),/before COMMIT/);assert.equal(f.durable.recoveryId,committed.id,'verified previous intent is the new durable parent');assert.notEqual(f.durable.pendingRecoveryIntent.id,committed.id);
 const latest=await edit(second,'latest decision'),saved=await f.save(latest);assert.equal(saved.snapshot.manifest.parent,committed.id);assert.equal(saved.snapshot.manifest.records.find(r=>r.id===latest.id).revisionId,latest.revisionId);assert.equal(reconcileRecoveryIntent(await readRecovery(f.directory),f.durable).recoveryId,saved.id);
});
test('a foreign generation cannot inherit an intent even with the same project and exact local state',async()=>{
 const f=await fixture(),r=await edit(f.record,'owned'),owned=await f.save(r);const foreign=await saveRecovery(f.directory,scene(r),paths,{expected:owned.id,projectId:owned.projectId});assert.notEqual(foreign.id,owned.id);await assert.rejects(f.save(r),e=>e.name==='RecoveryConflict');assert.throws(()=>reconcileRecoveryIntent(foreign.snapshot,f.durable),e=>e.name==='RecoveryConflict');assert.equal((await readRecovery(f.directory)).manifest.id,foreign.id);
});
test('modified committed manifest or malformed intent cannot be acknowledged by matching ID alone',async()=>{
 const f=await fixture(),r=await edit(f.record,'owned'),saved=await f.save(r),snapshot=await readRecovery(f.directory);
 for(const change of [i=>i.manifestSha256='f'.repeat(64),i=>i.projectId=crypto.randomUUID(),i=>i.parent=crypto.randomUUID(),i=>i.workspaceId='foreign',i=>i.sourceSha256='f'.repeat(64)]){const bad=structuredClone(f.durable);change(bad.pendingRecoveryIntent);assert.throws(()=>reconcileRecoveryIntent(snapshot,bad),e=>e.name==='RecoveryConflict');}
 const manifest={...snapshot.manifest,createdAt:'2030-01-01T00:00:00Z'},blob=json(manifest);await put(f.directory,'.scorebrush/recovery/g-'+saved.id+'/snapshot.json',blob);await put(f.directory,'.scorebrush/recovery/g-'+saved.id+'/COMMIT.json',json({schema:manifest.schema,version:1,id:saved.id,manifestSha256:(await fileInfo(blob)).sha256}));await assert.rejects(f.save(r),e=>e.name==='RecoveryConflict');
});
test('exact successor intent cannot hide a missing or empty acknowledged parent commitment',async()=>{
 for(const mode of ['missing','empty']){const f=await fixture(),r=await edit(f.record,'owned'),saved=await f.save(r),parent=f.durable.recoveryId;const parentDirectory=await(await(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('g-'+parent);
  if(mode==='missing')await parentDirectory.removeEntry('COMMIT.json');else await put(f.directory,'.scorebrush/recovery/g-'+parent+'/COMMIT.json',new Blob());
  const observed=await readRecovery(f.directory);assert.equal(observed.manifest.id,saved.id);assert(observed.incomplete.includes(parent));assert.throws(()=>reconcileRecoveryIntent(observed,f.durable),e=>e.name==='RecoveryConflict');await assert.rejects(f.save(r),e=>e.name==='RecoveryConflict');
 }
});
