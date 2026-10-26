// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readRevisionView,rememberRevisionView} from '../app/revision-views.js';

test('view preferences isolate workspace, finding and every exact revision component without editing review data',()=>{
  const values=new Map();globalThis.localStorage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const scene={workspaceId:'synthetic-project',review:{snapshotId:'snapshot-A',files:{ly:{sha256:'code-A'},rendered:{sha256:'pdf-A'}},pages:[{view:[12,24,592,764],rotation:90}]}};
  const original=structuredClone(scene),position={page:1,zoom:3,point:[180,240]};
  assert(rememberRevisionView(scene,'finding-A',position));assert.deepEqual(readRevisionView(scene,'finding-A'),position);
  assert.equal(readRevisionView(scene,'finding-B'),null);
  const variants=[{...scene,workspaceId:'other-project'},...['snapshot','code','pdf'].map(kind=>{const changed=structuredClone(scene);if(kind==='snapshot')changed.review.snapshotId+='new';else changed.review.files[kind==='code'?'ly':'rendered'].sha256+='new';return changed;})];
  for(const changed of variants)assert.equal(readRevisionView(changed,'finding-A'),null);
  for(const bad of [{...position,page:2},{...position,zoom:5},{...position,point:[11,240]},{...position,point:[Infinity,240]}])assert.equal(rememberRevisionView(scene,'finding-A',bad),false);
  assert.deepEqual(scene,original);assert.deepEqual(readRevisionView(scene,'finding-A'),position);
  const name=[...values.keys()][0];values.set(name,'broken JSON');assert.deepEqual(readRevisionView(scene,'finding-A'),position);
  values.set(name.replace('synthetic-project','foreign-project'),JSON.stringify({version:1,findingId:'finding-A',candidate:{snapshotId:'wrong'},position}));assert.equal(readRevisionView({...scene,workspaceId:'foreign-project'},'finding-A'),null);
});
test('unavailable preference storage keeps navigation in memory without a review save or exception',()=>{
  globalThis.localStorage={getItem(){throw Error('denied');},setItem(){throw Error('full');}};
  const scene={workspaceId:'memory-only',review:{snapshotId:'A',files:{ly:{sha256:'B'},rendered:{sha256:'C'}},pages:[{view:[0,0,600,800]}]}};
  const position={page:1,zoom:'fit',point:[100,200]};
  assert.equal(rememberRevisionView(scene,'finding',position),false);assert.deepEqual(readRevisionView(scene,'finding'),position);
});
