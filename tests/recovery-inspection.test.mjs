// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {identify,newReview,blobHash} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {addCompletionHistory} from '../app/completion.js';
import {decodeRecovery} from '../app/folder-recovery.js';
globalThis.crypto??=webcrypto;
const pages=[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}];
test('one decode inspects exact PDF pairs once while preserving code, names and all revision identities',async()=>{
 const source=new Blob(['%PDF SYNTHETIC shared source']),rendered=new Blob(['%PDF SYNTHETIC shared rendering']),objects=new Map(),records=[];let sourceSha256;
 for(let i=0;i<9;i++){
  const files={source:{name:i%2?'renamed-source.pdf':'source.pdf',blob:source},rendered:{name:'rendered.pdf',blob:i===8?new Blob(['%PDF SYNTHETIC changed rendering']):rendered},ly:{name:'code-'+i+'.ly',blob:new Blob(['% SYNTHETIC code-only revision '+i])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,pages),revisionId=crypto.randomUUID();sourceSha256=identity.source.sha256;const payloads=await addCompletionHistory(await makeRecovery(review,files),review,null,revisionId,[],{preserveRevision:true}),declared={};
  for(const [path,blob]of payloads){const sha256=await blobHash(blob);declared[path]={sha256,size:blob.size};objects.set(sha256,blob);}records.push({id:snapshotId,snapshotId,revisionId,storageRevision:1,payloads:declared,expected:identity});
 }
 const snapshot={manifest:{id:crypto.randomUUID(),projectId:crypto.randomUUID(),sourceSha256,current:records.at(-1).id,records:records.map(({expected,...r})=>r),handoffs:[]},objects};let calls=0;
 const eight=await decodeRecovery({...snapshot,manifest:{...snapshot.manifest,current:records[7].id,records:snapshot.manifest.records.slice(0,8)}},async()=>{calls++;return structuredClone(pages);});assert.equal(eight.records.length,8);assert.equal(calls,1,'all eight code-only revisions inspect the identical PDF pair once');calls=0;
 const decoded=await decodeRecovery(snapshot,async()=>{calls++;return structuredClone(pages);});assert.equal(calls,2,'eight identical PDF pairs share one inspection, changed PDF gets another');assert.equal(decoded.records.length,9);
 for(const expected of records){const actual=decoded.records.find(r=>r.id===expected.id);assert.equal(actual.revisionId,expected.revisionId);assert.equal(actual.review.snapshotId,expected.snapshotId);assert.deepEqual(actual.review.files,expected.expected);}
 const tampered={...snapshot,objects:new Map(objects)},hash=records[8].payloads['rendered-original.pdf'].sha256;tampered.objects.set(hash,new Blob(['%PDF SYNTHETIC tampering']));await assert.rejects(decodeRecovery(tampered,async()=>pages));
});
