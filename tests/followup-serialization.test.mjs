// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview,bounds,blobHash} from '../app/model.js';
import {makeTask,seal} from '../app/workflow.js';
import {makeRecovery} from '../app/export.js';
import {followupTask,workspaceSeed} from '../app/returned.js';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
const inspect=async()=>[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}];
const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
function finding(number){
  const strokes=[{width:4,color:'#ffd34d',opacity:.35,points:Array.from({length:200},(_,n)=>[40+n,60+number])}];
  return {id:'synthetic-'+number,number,page:1,type:'comment',comment:'SYNTHETIC retained observation '+number,state:'open',color:'#ffd34d',strokes,bounds:bounds(strokes)};
}
async function packageMaker(review,files){
  const payloads=await makeRecovery(review,files);
  for(const f of review.findings)for(const kind of ['marked','clean'])payloads.set(`findings/${String(f.number).padStart(3,'0')}-${f.id}-${kind}.png`,png);
  return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
}
async function fixture(){
  const files={source:{name:'source.pdf',blob:new Blob(['%PDF SYNTHETIC source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF SYNTHETIC render'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC first code'])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,await inspect());
  review.findings=Array.from({length:20},(_,n)=>finding(n+1));review.nextNumber=21;
  const issued=await makeTask(review,files,{},'120',()=>{},packageMaker);
  const response={schema:'score-desk-response',version:1,taskId:issued.id,baseline:issued.task.baseline,code:{status:'changed',path:'proposed.ly'},rendering:{status:'supplied',path:'proposed.pdf',producer:'SYNTHETIC',compiler:null},results:issued.task.findings.map(f=>({id:f.id,status:'unreviewed',explanation:'SYNTHETIC unchanged comment',codeLocation:''}))};
  const entry={id:crypto.randomUUID(),kind:'response',taskId:issued.id,createdAt:new Date().toISOString(),response,payloads:new Map([['proposed.ly',new Blob(['% SYNTHETIC second code'])],['proposed.pdf',files.rendered.blob]]),findings:issued.task.findings.map(f=>({id:f.id,state:'open'}))};
  const seed=await workspaceSeed(entry,issued,inspect);seed.review.findings=[finding(21),finding(22)];seed.review.nextNumber=23;
  return {scene:{...seed,doc:{}},issued,entry,lookup:async id=>id===issued.id?issued:id===entry.id?entry:null};
}

test('follow-up serializes each exact historical review once per operation while preserving all contexts',async()=>{
  const f=await fixture(),reviews=[f.issued.review,f.scene.review],expected=reviews.map(review=>JSON.stringify(review,null,2)+'\n'),counts=new Map(reviews.map(review=>[review,0])),stringify=JSON.stringify;
  let result;
  JSON.stringify=function(value,...args){if(counts.has(value))counts.set(value,counts.get(value)+1);return stringify.call(this,value,...args);};
  try{result=await followupTask(f.scene,'120',()=>{},packageMaker,{lookup:f.lookup});}finally{JSON.stringify=stringify;}
  assert.deepEqual([...counts.values()],[1,1],'many findings sharing a review must not repeatedly serialize its complete geometry');
  assert.equal(result.task.findings.length,22);
  for(const [index,review]of reviews.entries()){
    const group=result.task.findings.filter(item=>item.historicalContext.renderSha256===review.files.rendered.sha256&&item.historicalContext.originalFiles.ly.sha256===review.files.ly.sha256);
    assert.equal(group.length,index===0?20:2);
    const paths=new Set(group.map(item=>item.historicalContext.annotations));assert.equal(paths.size,1);
    const blob=result.payloads.get([...paths][0]);assert.equal(await blob.text(),expected[index]);
    assert.equal((JSON.parse(await result.payloads.get('manifest.json').text())).payloads[[...paths][0]].sha256,await blobHash(blob));
  }
  for(const item of result.task.findings)for(const kind of ['marked','clean'])assert.equal(await blobHash(result.payloads.get(item.historicalContext[kind])),await blobHash(png));
});

test('follow-up annotation reuse is local to one operation and captures later edits separately',async()=>{
  const f=await fixture(),first=await followupTask(f.scene,'120',()=>{},packageMaker,{lookup:f.lookup});
  const before=first.task.findings.find(item=>item.id==='synthetic-21').historicalContext.annotations,old=await first.payloads.get(before).text();
  f.scene.review.findings[0].comment='SYNTHETIC newer note after first export';
  const second=await followupTask(f.scene,'120',()=>{},packageMaker,{lookup:f.lookup}),after=second.task.findings.find(item=>item.id==='synthetic-21').historicalContext.annotations;
  assert.notEqual(after,before);assert.equal(await first.payloads.get(before).text(),old);
  assert.equal(JSON.parse(await second.payloads.get(after).text()).findings[0].comment,f.scene.review.findings[0].comment);
  const oldHistorical=first.task.findings.find(item=>item.id==='synthetic-1').historicalContext.annotations,newHistorical=second.task.findings.find(item=>item.id==='synthetic-1').historicalContext.annotations;
  assert.equal(await first.payloads.get(oldHistorical).text(),await second.payloads.get(newHistorical).text(),'unchanged prior revision remains byte-identical');
});
