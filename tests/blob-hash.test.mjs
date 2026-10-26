// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {blobHash,sha256} from '../app/model.js';
globalThis.crypto??=webcrypto;
test('owned immutable Blob bytes are hashed once, including concurrent requests',async()=>{
  const blob=new Blob(['SYNTHETIC immutable input']),read=blob.arrayBuffer.bind(blob);let reads=0;
  blob.arrayBuffer=()=>{reads++;return read();};
  const hashes=await Promise.all([blobHash(blob),blobHash(blob),blobHash(blob)]);
  assert.equal(reads,1);assert(hashes.every(hash=>hash===hashes[0]));assert.equal(hashes[0],await sha256(await read()));
});
test('disk-backed File reads never use an earlier digest',async()=>{
  const file=new File(['SYNTHETIC first'], 'source.pdf');let reads=0;
  file.arrayBuffer=async()=>new TextEncoder().encode(++reads===1?'first':'changed').buffer;
  assert.notEqual(await blobHash(file),await blobHash(file));assert.equal(reads,2);
});
test('failed byte reads can be retried, and distinct blobs keep distinct identities',async()=>{
  const blob=new Blob(['SYNTHETIC']),read=blob.arrayBuffer.bind(blob);let failed=true;
  blob.arrayBuffer=()=>failed?Promise.reject(Error('SYNTHETIC read failed')):read();
  await assert.rejects(blobHash(blob),/read failed/);failed=false;
  assert.notEqual(await blobHash(blob),await blobHash(new Blob(['different bytes'])));
});
