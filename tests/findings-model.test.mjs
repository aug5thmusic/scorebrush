// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {findingRows,sortFindingRows,findingRowKey} from '../app/findings-model.js';
test('reported findings merge current associations without editing saved records or decisions',()=>{
  const review={findings:[{id:'a',number:5,type:'source_footnote',page:2,comment:'Current note',state:'open'},{id:'b',number:6,type:'comment',state:'open'},{id:'c',number:7,state:'open'}]},returned={reported:[{id:'r',number:1,type:'correction',associationId:'a',comment:'Original note',state:'resolved',decision:{state:'resolved'}},{id:'s',number:2,type:'comment',comment:'Old comment',state:'open'},{id:'t',number:3,type:'source_footnote',state:'corrected_pending_review',origin:{page:4}}]};
  const before=JSON.stringify({review,returned}),rows=findingRows(review,returned);
  assert.equal(rows.length,5);assert.equal(rows[0].annotation.id,'a');assert.equal(rows[0].finding.type,'source_footnote');assert.equal(rows[0].finding.comment,'Original note');assert.equal(rows[0].status,'Looks correct');assert.equal(rows[1].status,'Logged');assert.equal(rows[2].status,'Unchecked');assert.equal(rows[2].finding.page,4);assert.equal(rows[3].status,'Logged');assert.equal(rows[4].annotation.id,'c');assert.equal(JSON.stringify({review,returned}),before);
});
test('associated comments remain logged even with an earlier decision; broken associations keep the report',()=>{
  const rows=findingRows({findings:[{id:'a',type:'comment'}]},{reported:[{id:'r',associationId:'a',type:'correction',decision:{state:'resolved'}},{id:'s',associationId:'missing',state:'open',decision:{state:'needs_source_clarification'}}]});
  assert.equal(rows.length,2);assert.equal(rows[0].status,'Logged');assert.equal(rows[1].status,'Source unclear');assert.equal(rows[1].annotation,undefined);
});
test('numeric order includes all types, keeps associated identities, and never mutates input/export order',()=>{
  const review={findings:[{id:'annotation',number:20,type:'source_footnote',state:'open'},{id:'a12',number:12,type:'comment',state:'open'},{id:'a2',number:2,type:'correction',state:'open'}]},returned={reported:[{id:'r11',number:11,type:'source_footnote',associationId:'annotation',state:'open'},{id:'r13',number:13,type:'comment',state:'open'}]};
  const original=JSON.stringify({review,returned}),rows=findingRows(review,returned),keys=rows.map(findingRowKey);
  assert.deepEqual(sortFindingRows(rows).map(r=>r.finding.number),[13,12,11,2]);
  assert.deepEqual(sortFindingRows(rows,'oldest').map(r=>r.finding.number),[2,11,12,13]);
  assert.equal(sortFindingRows(rows)[2].annotation.id,'annotation');
  assert.deepEqual(rows.map(findingRowKey),keys);assert.equal(JSON.stringify({review,returned}),original);
});
test('ties use stable IDs in both directions and do not depend on incoming order or dates',()=>{
  const rows=findingRows({findings:[{id:'z',number:12,state:'open'},{id:'a',number:12,state:'open'}]},{reported:[{id:'b',number:12,state:'open'}]});
  const expected=['annotation:a','annotation:z','reported:b'];
  for(const order of ['newest','oldest'])for(const input of [rows,[...rows].reverse()])assert.deepEqual(sortFindingRows(input,order).map(findingRowKey),expected);
  assert(rows.every(r=>!Object.hasOwn(r.finding,'createdAt')));
});
