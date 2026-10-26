// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {candidateIdentity,bookmark,savedLocation,validateLocations,comparisonContext,aiExplanation,currentAssociation,commentReference} from '../app/comparison-model.js';
import {identify,newReview,sha256} from '../app/model.js';
import {fixtureBlob} from '../app/qa/fixtures.js';
globalThis.crypto??=webcrypto;
const files={source:{name:'source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:'after.pdf',blob:await fixtureBlob('rendered.pdf')},ly:{name:'input.ly',blob:await fixtureBlob('score.ly')}};
const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[12,24,592,764],rotation:90,userUnit:1}]);
const position={page:1,point:[110,420],zoom:1.5};
test('location identity checks code, PDF and snapshot independently and accepts old packages without locations',()=>{
  const location=bookmark('f',review,position);assert(savedLocation(location,'f',review));
  for(const key of Object.keys(candidateIdentity(review)))assert.equal(savedLocation({...location,candidate:{...location.candidate,[key]:'0'.repeat(64)}},'f',review),null);
  assert.equal(savedLocation(location,'another-finding',review),null);
  assert.deepEqual(validateLocations(undefined,{reported:[{id:'f'}]},review),{});
  assert.throws(()=>validateLocations({g:location},{reported:[{id:'f'}]},review));
  assert.throws(()=>bookmark('f',review,{...position,page:2}));
  assert.throws(()=>bookmark('f',review,{...position,point:[0,0]}));
  assert.throws(()=>bookmark('f',review,{...position,point:[NaN,0]}));
  assert.throws(()=>bookmark('f',review,{...position,zoom:10000}));
});
test('an unavailable or mismatched earlier PDF never receives historical coordinates',async()=>{
  const old=await fixtureBlob('multipage.pdf'),hash=await sha256(await old.arrayBuffer());
  const finding={id:'f',number:1,page:null,comment:'Earlier report',historicalContext:{renderSha256:hash,page:4,marked:'marked.png',clean:'clean.png',originalFiles:{rendered:{path:'old.pdf',sha256:hash}}}};
  const issued={files,review,task:{version:2,baseline:{renderSha256:review.files.rendered.sha256},findings:[finding]},payloads:new Map([['old.pdf',files.rendered.blob],['marked.png',new Blob(['crop'])]])};
  let context=await comparisonContext(issued,finding);assert(context.earlier);assert.equal(context.original,null);assert.equal(context.baseline.blob,files.rendered.blob);assert.equal(context.crops.length,2);
  issued.payloads.set('old.pdf',old);issued.payloads.set('wrong.json',new Blob([JSON.stringify(review)]));finding.historicalContext.annotations='wrong.json';
  await assert.rejects(comparisonContext(issued,finding),/do not match/);
});
test('AI location hints do not produce confirmed bookmarks or baseline coordinates',async()=>{
  const finding={id:'f',number:1,page:1,comment:'Text only',location:{position},candidateLocation:position,agent:{location:position}};
  const issued={files,review,task:{version:1,baseline:{renderSha256:review.files.rendered.sha256},findings:[finding]},payloads:new Map()};
  const context=await comparisonContext(issued,finding);assert.deepEqual(context.baseline.marks,[]);assert.equal(context.page,1);assert.equal(savedLocation(finding.location,'f',review),null);
});

test('only actual explanation text is presented; protocol placeholders remain unchanged',()=>{
  for(const explanation of ['', '  ', 'No explanation supplied.', 'No per-finding AI explanation supplied.', 'Loaded updated local files; no per-finding AI explanation was supplied. Compare and decide.', 'REPLACE with your source-checked response.', 'Internal comment retained; no score change or correction approval requested.', 'N/A', 'Done.', 'Fixed', 'No explanation provided.']){
    const result={explanation};assert.equal(aiExplanation(result),'');assert.equal(result.explanation,explanation);
  }
  assert.equal(aiExplanation({explanation:'  Changed E to F.  '}),'Changed E to F.');
  assert.equal(aiExplanation({explanation:'<b>Kept the slur.</b>'}),'<b>Kept the slur.</b>');
});
test('current association requires this exact snapshot, code and rendering',()=>{
  const mark={id:'current',page:1,strokes:[]},current={...review,findings:[mark]};
  const round={contentSnapshotId:review.snapshotId,codeSha256:review.files.ly.sha256,renderSha256:review.files.rendered.sha256,reported:[{id:'original',associationId:'current'}]};
  assert.equal(currentAssociation(round,'original',current),mark);
  for(const key of ['contentSnapshotId','codeSha256','renderSha256'])assert.equal(currentAssociation({...round,[key]:'different'},'original',current),null);
  assert.equal(currentAssociation(round,'missing',current),null);
});
test('comment references prefer marked evidence and distinguish text-only from missing history',async()=>{
  const mark={id:'comment',number:1,page:1,strokes:[{points:[[30,50],[60,50]],width:5}]};
  const marked=new Blob(['marked']),clean=new Blob(['clean']);
  const issued={files,review:{...review,findings:[mark]},task:{version:1,baseline:{renderSha256:review.files.rendered.sha256}},payloads:new Map([['findings/001-comment-marked.png',marked],['findings/001-comment-clean.png',clean]])};
  let context=await commentReference(issued,mark);assert.equal(context.marked,marked);assert.equal(context.mark,mark);assert(!context.textOnly);assert.equal(context.asset.blob,files.rendered.blob);
  mark.strokes=[];context=await commentReference(issued,mark);assert(context.textOnly);assert.equal(context.marked,null);assert.equal(context.asset,null);
  const legacy={...mark,historicalContext:{renderSha256:'a'.repeat(64),page:2,marked:'marked.png',clean:'clean.png'}};issued.task.version=2;issued.payloads=new Map([['marked.png',clean],['clean.png',clean]]);
  context=await commentReference(issued,legacy);assert(context.textOnly);assert.equal(context.page,2);assert.equal(context.asset,null);
  issued.payloads.clear();context=await commentReference(issued,legacy);assert(!context.textOnly);assert.equal(context.marked,undefined);assert.equal(context.asset,null);
});
