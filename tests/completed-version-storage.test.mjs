// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {head,note} from './portable-history-fixture.mjs';
import {putSaved,getSaved,workspaceHistory,workspaceHistories,archiveSavedVersion,recoveryIdentity} from '../app/storage.js';
import {fileInfo} from '../app/workflow.js';
installMemoryIndexedDB();
const boundary=async label=>({resultingSnapshotId:(await fileInfo(new Blob(['SYNTHETIC snapshot '+label]))).sha256,resultingRenderSha256:(await fileInfo(new Blob(['%PDF SYNTHETIC result '+label]))).sha256});
async function write(row){const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('private-score-desk-local-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});await new Promise((resolve,reject)=>{const tx=db.transaction('reviews','readwrite');tx.objectStore('reviews').put(row);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}
async function edit(record,text){return putSaved({...record,review:{...record.review,findings:[note(0,text)],nextNumber:2},revisionId:crypto.randomUUID()},record.storageRevision);}

test('one history scan groups selected workspaces without mixing unrelated project events',async()=>{
  const rows=[];for(let n=0;n<3;n++){
    const row=await head('SYNTHETIC grouped history '+crypto.randomUUID());rows.push(row);
    await archiveSavedVersion(row.id,row.storageRevision,await boundary('group '+n));
  }
  const result=await workspaceHistories([rows[0].id,rows[2].id,'missing']);
  assert.equal(result.has(rows[1].id),false);assert.deepEqual(result.get('missing'),[]);
  for(const row of [rows[0],rows[2]])assert.deepEqual(result.get(row.id),await workspaceHistory(row.id));
});

test('ordinary durable edits update the CAS head without creating permanent version history',async()=>{
  let record=await head('SYNTHETIC ordinary decisions '+crypto.randomUUID());
  for(let i=0;i<12;i++){record=await edit(record,'SYNTHETIC current correction '+i);assert.equal(recoveryIdentity(await getSaved(record.id)),recoveryIdentity(record));assert.equal((await workspaceHistory(record.id)).length,0);}
  assert.equal(record.storageRevision,13);assert.equal(record.historyId,null);
  await assert.rejects(putSaved({...record,revisionId:crypto.randomUUID()},record.storageRevision-1),{name:'StorageConflictError'});assert.equal((await workspaceHistory(record.id)).length,0);
});

test('completed new-render boundary archives exactly once without changing content or storage revision',async()=>{
  let record=await head('SYNTHETIC completed version '+crypto.randomUUID());record=await edit(record,'SYNTHETIC completed corrections');const target=await boundary('first '+crypto.randomUUID()),before=structuredClone(record);
  const ids=await Promise.all([archiveSavedVersion(record.id,record.storageRevision,target),archiveSavedVersion(record.id,record.storageRevision,target)]);assert.equal(ids[0],ids[1]);
  const history=await workspaceHistory(record.id);assert.equal(history.length,1);assert.equal(history[0].id,ids[0]);assert.equal(history[0].resultingSnapshotId,target.resultingSnapshotId);assert.equal(history[0].resultingRenderSha256,target.resultingRenderSha256);assert.equal(recoveryIdentity(history[0]),recoveryIdentity(before));
  const current=await getSaved(record.id);assert.equal(current.storageRevision,before.storageRevision);assert.equal(recoveryIdentity(current),recoveryIdentity(before));assert.equal(current.historyId,ids[0]);
  assert.equal(await archiveSavedVersion(record.id,current.storageRevision,{resultingSnapshotId:current.review.snapshotId,resultingRenderSha256:current.review.files.rendered.sha256}),null);assert.equal((await workspaceHistory(record.id)).length,1,'code-only or unchanged render must not create an archive');
  await assert.rejects(archiveSavedVersion(record.id,current.storageRevision-1,target),{name:'StorageConflictError'});
});

test('existing per-edit events remain byte-exact while later edits preserve their predecessor and only new renders append',async()=>{
  let record=await head('SYNTHETIC old history '+crypto.randomUUID());const id='review-event:'+crypto.randomUUID(),legacy={...structuredClone(record),id,kind:'review-event',workspaceId:record.id,historyId:id,parentHistoryId:null,createdAt:'2026-01-01T00:00:00Z',historyCoverage:'durable-save'};
  await write(legacy);await write({...record,historyId:id});record=await edit(await getSaved(record.id),'SYNTHETIC uncompleted correction');
  assert.equal(record.historyId,null);assert.equal(record.historyPredecessorId,id);assert.deepEqual(await workspaceHistory(record.id),[legacy]);
  const next=await archiveSavedVersion(record.id,record.storageRevision,await boundary('second '+crypto.randomUUID())),history=await workspaceHistory(record.id);assert.equal(history.length,2);assert.deepEqual(history[0],legacy);assert.equal(history[1].id,next);assert.equal(history[1].parentHistoryId,id);
  record=await edit(await getSaved(record.id),'SYNTHETIC next current edit');assert.equal(record.historyPredecessorId,next);assert.equal(record.historyId,null);assert.equal((await workspaceHistory(record.id)).length,2);
});

test('invalid archive identities and conflicting deterministic evidence cannot alter the current head',async()=>{
  const record=await head('SYNTHETIC conflicting completed version '+crypto.randomUUID());await assert.rejects(archiveSavedVersion(record.id,record.storageRevision,{resultingSnapshotId:'bad',resultingRenderSha256:'bad'}),/identities/);
  const target=await boundary('conflict '+crypto.randomUUID()),id=await archiveSavedVersion(record.id,record.storageRevision,target),current=await getSaved(record.id),event=(await workspaceHistory(record.id))[0];await write({...event,resultingRenderSha256:'0'.repeat(64)});
  await assert.rejects(archiveSavedVersion(record.id,current.storageRevision,target),{name:'StorageConflictError'});assert.deepEqual(await getSaved(record.id),current);assert.equal((await workspaceHistory(record.id))[0].id,id);
});

test('retrying an earlier completed boundary cannot rewind the head from a later archive',async()=>{
  const record=await head('SYNTHETIC archive retry '+crypto.randomUUID()),a=await boundary('A '+crypto.randomUUID()),b=await boundary('B '+crypto.randomUUID());
  const first=await archiveSavedVersion(record.id,record.storageRevision,a),second=await archiveSavedVersion(record.id,record.storageRevision,b);assert.notEqual(first,second);
  assert.equal(await archiveSavedVersion(record.id,record.storageRevision,a),first);assert.equal((await getSaved(record.id)).historyId,second);
  const events=await workspaceHistory(record.id);assert.equal(events.length,2);assert.equal(events.find(e=>e.id===second).parentHistoryId,first);
});

