// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {annotationSnapshot,blobHash} from '../app/model.js';
import {strictJSON,readPackagePayloads,readResponsePayloads} from '../app/workflow.js';
globalThis.crypto??=webcrypto;

test('undo shares immutable coordinates while preserving independent editable metadata',()=>{
  const review={preferences:{color:'yellow'},findings:[{id:'a',comment:'before',bounds:[0,0,1,1],strokes:[{color:'yellow',width:4,points:[[0,0],[1,1]]}]}]};
  const before=structuredClone(review),undo=annotationSnapshot(review);
  assert.deepEqual(undo,before);
  assert.equal(JSON.stringify(undo),JSON.stringify(before),'snapshot preserves serialized field order');
  assert.equal(undo.findings[0].strokes[0].points,review.findings[0].strokes[0].points);
  review.findings[0].comment='after';review.findings[0].bounds[0]=5;
  review.findings[0].strokes[0].color='blue';review.preferences.color='blue';
  review.findings[0].strokes.push({color:'blue',width:4,points:[[2,2]]});
  assert.deepEqual(undo,before,'typing, recolouring and adding strokes cannot alter Undo');
  const redo=annotationSnapshot(review);undo.findings[0].comment='new branch';
  assert.equal(redo.findings[0].comment,'after');
  assert.throws(()=>undo.findings[0].strokes[0].points[0][0]=99,TypeError);
  assert.throws(()=>undo.findings[0].strokes[0].points.push([9,9]),TypeError);
  assert.deepEqual(structuredClone(redo),redo,'shared frozen geometry remains persistable');
});

test('owned Blob digests are reused but File digests always read fresh bytes',async()=>{
  for(const [blob,expected]of [[new Blob(['SYNTHETIC']),1],[new File(['SYNTHETIC'],'input.pdf'),2]]){
    const read=blob.arrayBuffer.bind(blob);let reads=0;
    blob.arrayBuffer=()=>{reads++;return read();};
    const first=await blobHash(blob);assert.equal(await blobHash(blob),first);assert.equal(reads,expected);
  }
});

test('direct recovery payload maps retain ZIP path ambiguity and missing-byte rejection',async()=>{
  for(const paths of [['Task.json','task.json'],['../escape'],['folder/../escape'],['a\\b']]){
    const payloads=new Map(paths.map(path=>[path,new Blob(['{}'])]));
    await assert.rejects(readPackagePayloads(payloads,()=>[]),/unsafe or duplicate path/);
    await assert.rejects(readResponsePayloads(payloads),/unsafe or duplicate path/);
  }
  const missing=new Map([['manifest.json',undefined]]);
  await assert.rejects(readPackagePayloads(missing,()=>[]),/limits/);
});

test('fast numeric JSON scanning retains duplicate, escape, grammar and nesting checks',()=>{
  for(const text of ['null','true','false','-0','1.2e-3','[1,-2,3.25,1e20,0]','{"a": [1, {"b":"\\u0061\\n"}]}',' \r\n\t{"nested":{"x":1},"x":2} ']){
    assert.equal(JSON.stringify(strictJSON(text)),JSON.stringify(JSON.parse(text)));
  }
  assert.equal(Object.getPrototypeOf(strictJSON('{"a":1}')),null);
  assert.equal(strictJSON('\ufeff\u00a0{"a":1}').a,1,'retain existing support for BOM/whitespace in Windows-generated metadata');
  for(const text of ['{"a":1,"a":2}','{"a":1,"\\u0061":2}','{"nested":{"a":1,"a":1}}','{"__proto__":{}}','01','1.','1e','+1','NaN','[1,]','{"a":1,}','"\\q"','[true false]','true false'])assert.throws(()=>strictJSON(text),undefined,text);
  assert.throws(()=>strictJSON('['.repeat(62)+'0'+']'.repeat(62)),/nesting/);
});
