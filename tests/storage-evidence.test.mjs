// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {createCompletion} from '../app/completion-model.js';
import {head,evidence,note} from './portable-history-fixture.mjs';
import {getSaved,getSavedState,putSaved,restoreMissing,savedRecords,listSaved,workspaceHistory,archiveSavedVersion,recoveryIdentity} from '../app/storage.js';
const databases=installMemoryIndexedDB(),databaseName='private-score-desk-local-v1',rows=()=>databases.get(databaseName);
const light=record=>Object.fromEntries(Object.entries(record).filter(([key])=>!['retainedLegacyEvidence','retainedHandoffEvidence','retainedEvidenceId'].includes(key)));
const ids=()=>[...rows().keys()].filter(id=>id.startsWith('retained-evidence:'));
const edited=record=>({...light(record),review:{...record.review,findings:[note(0,'SYNTHETIC lightweight edit')],nextNumber:2},revisionId:crypto.randomUUID()});
async function seeded(){const record=await head('SYNTHETIC evidence normalization '+crypto.randomUUID()),legacy=await evidence(record,'SYNTHETIC retained package'),handoff={bundle:{id:crypto.randomUUID(),kind:'task',payloads:{}},payloads:new Map()};rows().set(record.id,{...record,retainedLegacyEvidence:[legacy],retainedHandoffEvidence:[handoff]});return {record:await getSaved(record.id),legacy,handoff};}

test('first edit atomically normalizes inline evidence, subsequent edits keep a lightweight head and hydrate exact packages',async()=>{
  const f=await seeded(),before=ids().length,saved=await putSaved(edited(f.record),f.record.storageRevision),raw=rows().get(saved.id);
  assert.equal(ids().length,before+1);assert(raw.retainedEvidenceId);assert.equal(raw.retainedLegacyEvidence,undefined);assert.equal(raw.retainedHandoffEvidence,undefined);
  const full=await getSaved(saved.id);assert.equal(full.retainedEvidenceId,undefined);assert.deepEqual(full.retainedLegacyEvidence,[f.legacy]);assert.deepEqual(full.retainedHandoffEvidence,[f.handoff]);
  const state=await getSavedState(saved.id);assert.equal(state.retainedLegacyEvidence,undefined);assert.equal(recoveryIdentity(state),recoveryIdentity(full));
  const second=await putSaved({...edited(full),revisionId:crypto.randomUUID()},saved.storageRevision);assert.equal(rows().get(saved.id).retainedEvidenceId,raw.retainedEvidenceId);assert.equal(ids().length,before+1);assert.equal(second.storageRevision,saved.storageRevision+1);
  assert((await listSaved()).every(row=>!row.id.startsWith('retained-evidence:')));assert.deepEqual((await savedRecords()).find(row=>row.id===saved.id).retainedLegacyEvidence,[f.legacy]);assert.equal((await workspaceHistory(saved.id)).length,0);
});

test('equal-head recovery merges retained evidence atomically without mutating older sidecars or revision identity',async()=>{
  const f=await seeded(),saved=await putSaved(edited(f.record),f.record.storageRevision),before=rows().get(saved.id),oldId=before.retainedEvidenceId,old=structuredClone(rows().get(oldId)),full=await getSaved(saved.id),extra=await evidence(full,'SYNTHETIC additional recovered package');
  await restoreMissing([{...full,retainedLegacyEvidence:[extra]}]);const after=await getSaved(saved.id),newId=rows().get(saved.id).retainedEvidenceId;
  assert.notEqual(newId,oldId);assert.deepEqual(rows().get(oldId),old);assert.equal(after.storageRevision,saved.storageRevision);assert.equal(recoveryIdentity(after),recoveryIdentity(full));assert.deepEqual(after.retainedLegacyEvidence.map(e=>e.bundle.id).sort(),[f.legacy.bundle.id,extra.bundle.id].sort());assert.deepEqual(after.retainedHandoffEvidence,full.retainedHandoffEvidence);
  const count=ids().length;await restoreMissing([{...full,retainedLegacyEvidence:[extra]}]);assert.equal(ids().length,count);
});

test('missing sidecars reject full reads, lightweight readback and edits instead of silently losing evidence',async()=>{
  const f=await seeded(),saved=await putSaved(edited(f.record),f.record.storageRevision),before=structuredClone(rows().get(saved.id));rows().delete(before.retainedEvidenceId);
  for(const action of [()=>getSaved(saved.id),()=>getSavedState(saved.id),()=>putSaved(edited(saved),saved.storageRevision)])await assert.rejects(action(),/evidence is missing or inconsistent/);
  assert.deepEqual(rows().get(saved.id),before);
});

test('incoming pointers cannot borrow another workspace evidence and malformed import errors settle without partial rows',async()=>{
  const f=await seeded(),saved=await putSaved(edited(f.record),f.record.storageRevision),pointer=rows().get(saved.id).retainedEvidenceId,count=rows().size;
  const foreign={...light(saved),id:'SYNTHETIC foreign workspace '+crypto.randomUUID(),retainedEvidenceId:pointer};await assert.rejects(restoreMissing([foreign]),/evidence/);assert.equal(rows().size,count);assert.equal(rows().has(foreign.id),false);
  await restoreMissing([{...foreign,retainedLegacyEvidence:[f.legacy]}]);assert.notEqual(rows().get(foreign.id).retainedEvidenceId,pointer);assert.deepEqual((await getSaved(foreign.id)).retainedLegacyEvidence,[f.legacy]);
});

test('completed-version archives contain no sidecar link and preserve the exact independently hydrated evidence',async()=>{
  const f=await seeded(),saved=await putSaved(edited(f.record),f.record.storageRevision),before=await getSaved(saved.id),id=await archiveSavedVersion(saved.id,saved.storageRevision,{resultingSnapshotId:'a'.repeat(64),resultingRenderSha256:'b'.repeat(64)}),event=await getSaved(id);
  assert.equal(rows().get(id).retainedEvidenceId,undefined);assert.equal(event.retainedLegacyEvidence,undefined);assert.equal(recoveryIdentity(event),recoveryIdentity(before));assert.deepEqual((await getSaved(saved.id)).retainedLegacyEvidence,before.retainedLegacyEvidence);
});


test('malformed evidence during completion registry callbacks rejects and rolls back the whole transaction',async()=>{
  const record=await head('SYNTHETIC completion rollback '+crypto.randomUUID()),completion=await createCompletion({...record,workspaceId:record.id,persistedRevision:record.storageRevision},{scope:'partial',note:'SYNTHETIC partial review',reviewer:''},{id:crypto.randomUUID(),createdAt:new Date().toISOString()}),before=structuredClone(rows().get(record.id)),count=rows().size;
  await assert.rejects(putSaved({...edited(record),retainedLegacyEvidence:{invalid:true},completions:[completion]},record.storageRevision,completion),/evidence is missing or inconsistent/);
  assert.deepEqual(rows().get(record.id),before);assert.equal(rows().size,count);assert.equal(rows().has('completion:'+completion.id),false);
});

test('an interrupted head write cannot leave a partial sidecar migration',async()=>{
  const f=await seeded(),before=structuredClone(rows().get(f.record.id)),count=rows().size,original=globalThis.structuredClone;let injected=false;
  globalThis.structuredClone=value=>{if(!injected&&value?.id===f.record.id&&value.retainedEvidenceId){injected=true;throw new DOMException('SYNTHETIC storage capacity failure','QuotaExceededError');}return original(value);};
  try{await assert.rejects(putSaved(edited(f.record),f.record.storageRevision),/SYNTHETIC storage capacity/);}finally{globalThis.structuredClone=original;}
  assert(injected);assert.deepEqual(rows().get(f.record.id),before);assert.equal(rows().size,count);
});
