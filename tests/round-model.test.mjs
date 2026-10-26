// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewRound,reviewSummary,automaticRoundOutcome} from '../app/round-model.js';
const reviewed={snapshotId:'snapshot',codeSha256:'code',renderSha256:'render'};
const review={snapshotId:'snapshot',files:{ly:{sha256:'code'},rendered:{sha256:'render'}},findings:[]};
const round={contentSnapshotId:'snapshot',codeSha256:'code',renderSha256:'render',reported:[]};
const report=(id,state='open',type='correction')=>({id,state,type,decision:{state,reviewed}});
test('unchecked takes priority over outstanding and approved corrections; comments never need approval',()=>{
 const r={...round,reported:[report('a','resolved'),report('b'),{id:'c',state:'open'}, {id:'note',type:'comment',state:'open'}]};
 assert.deepEqual(reviewRound(review,r),{state:'unchecked',unchecked:['c'],outstanding:['b'],approved:1,comments:1});
});
test('approval requires a matching saved decision and exact snapshot, code and rendering',()=>{
 for(const mismatch of ['snapshotId','codeSha256','renderSha256']){
  const f=report('a','resolved');f.decision={...f.decision,reviewed:{...reviewed,[mismatch]:'other'}};
  assert.equal(reviewRound(review,{...round,reported:[f]}).state,'unchecked');
 }
 assert.equal(reviewRound(review,{...round,renderSha256:'other',reported:[report('a','resolved')]}).state,'unchecked');
 assert.equal(reviewRound(review,{...round,reported:[{...report('a','resolved'),state:'open'}]}).state,'unchecked');
});
test('current associations count once and their explicit comment type is respected',()=>{
 const r={...review,findings:[{id:'anchor',state:'open',type:'comment'},{id:'new',state:'open',type:'source_footnote'}]};
 assert.deepEqual(reviewRound(r,{...round,reported:[{...report('original'),associationId:'anchor'}]}),{state:'outstanding',unchecked:[],outstanding:['new'],approved:0,comments:1});
});
test('new unresolved findings prevent completion after every reported correction was approved',()=>{
 assert.equal(reviewRound({...review,findings:[{id:'new',state:'open'}]},{...round,reported:[report('a','resolved')]}).state,'outstanding');
 assert.equal(reviewRound({...review,findings:[{id:'new',state:'resolved'},{id:'note',type:'comment',state:'open'}]},{...round,reported:[report('a','resolved')]}).state,'resolved');
});
test('summary is read-only and comments-only rounds complete without invented correction approvals',()=>{
 const r={...round,reported:[{id:'note',type:'comment',state:'open'}]},before=structuredClone(r);
 assert.deepEqual(reviewRound(review,r),{state:'resolved',unchecked:[],outstanding:[],approved:0,comments:1});assert.deepEqual(r,before);
});

test('automatic summary boundaries separate queue ends from exact round outcomes',()=>{
 for(const state of ['unchecked','outstanding','resolved']){
  assert.equal(automaticRoundOutcome({state}),state==='unchecked'?null:state);
  assert.equal(automaticRoundOutcome({state},{atEnd:true}),state);
 }
});
test('source clarification and rejected footnotes need another round after all exact decisions',()=>{
 const r={...round,reported:[report('yes','resolved'),report('no','open','source_footnote'),report('unclear','needs_source_clarification'),{id:'comment',type:'comment'}]};
 assert.deepEqual(reviewRound(review,r),{state:'outstanding',unchecked:[],outstanding:['no','unclear'],approved:1,comments:1});
});

test('status summaries read exact live decisions without traversing marks or retained evidence',()=>{
 const mark={id:'new',type:'source_footnote',state:'open'},finding=report('reported','resolved');
 for(const value of [mark,finding])for(const field of ['strokes','bounds','comment','historicalContext'])Object.defineProperty(value,field,{enumerable:true,get(){throw new Error('Presentation must not read '+field);}});
 const r={...review,findings:[mark]},returned={...round,id:'returned',reported:[finding]};
 let summary=reviewSummary(r,returned,{workspaceId:'workspace',revisionId:'revision-one'});
 assert.deepEqual(summary.round,{state:'outstanding',unchecked:[],outstanding:['new'],approved:1,comments:0});
 assert.deepEqual(summary.review,{snapshotId:'snapshot',files:{ly:{sha256:'code'},rendered:{sha256:'render'}}});
 mark.state='resolved';finding.decision.reviewed={...reviewed,renderSha256:'different'};
 summary=reviewSummary(r,returned,{workspaceId:'workspace',revisionId:'revision-two'});
 assert.equal(summary.revisionId,'revision-two');assert.equal(summary.round.state,'unchecked');assert.deepEqual(summary.round.unchecked,['reported']);
 assert.equal(summary.round.approved,1);
});

test('presentation snapshots own their scalar projections and do not cache absence or mutable decisions',()=>{
 const r={...review,files:{ly:{sha256:'code'},rendered:{sha256:'render'}},findings:[{id:'new',state:'open'}]},returned={...round,id:'returned',reported:[]};
 const first=reviewSummary(r,returned,{workspaceId:'workspace',revisionId:'revision'});
 first.review.files.ly.sha256='changed only in presentation';first.returned.id='changed only in presentation';first.round.outstanding.length=0;
 const second=reviewSummary(r,returned,{workspaceId:'workspace',revisionId:'revision'});
 assert.equal(second.review.files.ly.sha256,'code');assert.equal(second.returned.id,'returned');assert.deepEqual(second.round.outstanding,['new']);
 assert.deepEqual(reviewSummary(null,null,{workspaceId:null,revisionId:'empty'}),{workspaceId:null,revisionId:'empty',review:null,returned:null,round:null});
});
