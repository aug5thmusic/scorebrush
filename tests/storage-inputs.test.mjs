// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {head} from './portable-history-fixture.mjs';
import {putSaved,getSaved,getSavedState,restoreMissing,workspaceHistory,archiveSavedVersion,listSaved} from '../app/storage.js';
const databases=installMemoryIndexedDB(),rows=()=>databases.get('private-score-desk-local-v1');
const edited=row=>({...row,revisionId:crypto.randomUUID(),review:{...row.review,updatedAt:new Date().toISOString()}});

test('ordinary saves and version events share one exact input set without Blob-bearing head writes',async()=>{
  let row=await head('SYNTHETIC shared inputs '+crypto.randomUUID());
  const first=rows().get(row.id),key=first.inputFilesId,input=structuredClone(rows().get(key));
  assert(key?.startsWith('score-inputs:'));assert.equal(first.files,undefined);
  for(let i=0;i<5;i++)row=await putSaved(edited(row),row.storageRevision);
  assert.equal(rows().get(row.id).inputFilesId,key);assert.equal(rows().get(row.id).files,undefined);assert.deepEqual(rows().get(key),input);
  const event=await archiveSavedVersion(row.id,row.storageRevision,{resultingSnapshotId:'a'.repeat(64),resultingRenderSha256:'b'.repeat(64)});
  assert.equal(rows().get(event).inputFilesId,key);assert.equal(rows().get(event).files,undefined);
  for(const read of [await getSaved(row.id),await getSavedState(row.id),(await workspaceHistory(row.id))[0]]){
    assert.equal(read.inputFilesId,undefined);for(const role of ['source','rendered','ly'])assert.deepEqual(await read.files[role].blob.arrayBuffer(),await row.files[role].blob.arrayBuffer());
  }
  assert(!(await listSaved()).some(item=>item.id===key));
});

test('legacy inline inputs migrate atomically, retaining old history bytes and public shape',async()=>{
  const row=await head('SYNTHETIC inline inputs '+crypto.randomUUID()),legacy={...row},event={...legacy,id:'review-event:'+crypto.randomUUID(),kind:'review-event',workspaceId:row.id};
  rows().set(row.id,structuredClone(legacy));rows().set(event.id,structuredClone(event));
  assert.equal(JSON.stringify(await getSaved(row.id)),JSON.stringify(legacy));
  const saved=await putSaved(edited(row),row.storageRevision);
  assert.equal(saved.storageRevision,row.storageRevision+1);assert.equal(rows().get(row.id).files,undefined);
  assert.equal(JSON.stringify(await getSaved(row.id)),JSON.stringify(saved));
  assert.deepEqual(rows().get(event.id),event,'old history is never rewritten');
});

test('missing input references fail closed and a changed input cannot borrow a declared digest',async()=>{
  const row=await head('SYNTHETIC lost inputs '+crypto.randomUUID()),before=structuredClone(rows().get(row.id));rows().delete(before.inputFilesId);
  for(const action of [()=>getSaved(row.id),()=>getSavedState(row.id),()=>putSaved(edited(row),row.storageRevision)])await assert.rejects(action(),/inputs are missing or inconsistent/);
  assert.deepEqual(rows().get(row.id),before);
  const good=await head('SYNTHETIC differing bytes '+crypto.randomUUID()),count=rows().size;
  await assert.rejects(putSaved({...edited(good),files:{...good.files,source:{...good.files.source,blob:new Blob(['tampered'])}}},good.storageRevision),/inputs/);
  assert.equal(rows().size,count);
});

test('failed head migration rolls back input additions and exact recovery remains idempotent',async()=>{
  const row=await head('SYNTHETIC rollback inputs '+crypto.randomUUID()),key=rows().get(row.id).inputFilesId;rows().delete(key);rows().set(row.id,structuredClone(row));
  const before=structuredClone(rows().get(row.id)),count=rows().size,copy=globalThis.structuredClone;let injected=false;
  globalThis.structuredClone=value=>{if(!injected&&value?.id===row.id&&value.inputFilesId){injected=true;throw Error('SYNTHETIC full storage');}return copy(value);};
  try{await assert.rejects(putSaved(edited(row),row.storageRevision),/SYNTHETIC full storage/);}finally{globalThis.structuredClone=copy;}
  assert(injected);assert.equal(rows().size,count);assert.deepEqual(rows().get(row.id),before);
  const imported={...row,id:'SYNTHETIC restored '+crypto.randomUUID()},second={...imported,id:'SYNTHETIC shared restore '+crypto.randomUUID()};await restoreMissing([imported,second]);const after=rows().size;await restoreMissing([imported,second]);assert.equal(rows().size,after);assert.deepEqual((await getSaved(imported.id)).files,imported.files);assert.equal(rows().get(imported.id).inputFilesId,rows().get(second.id).inputFilesId);
});
