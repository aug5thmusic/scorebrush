// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Self-contained geometry fixture; no dependency on another suite's storage.
import {fixtureBlob} from './fixtures.js';
import {identify,newReview,bounds,clone} from '../model.js';
import {makeTask,readResponse,responseRevision,json,fileInfo,finalizeTask} from '../workflow.js';
import {zipFiles} from '../export.js';
import {retain,retained} from '../handoff-store.js';
import {handoff,completion} from '../app.js';
import {followupTask} from '../returned.js';
import * as pdfjs from '../vendor/pdf.mjs';
export async function comparisonFixture({types={},sourcePdf='source.pdf'}={}){
  const files={source:{name:'SIMULATED-source.pdf',blob:await fixtureBlob(sourcePdf)},rendered:{name:'SIMULATED-before.pdf',blob:await fixtureBlob('multipage.pdf')},ly:{name:'SIMULATED.ly',blob:await fixtureBlob('score.ly')}};
  const {identity,snapshotId}=await identify(files),doc=await pdfjs.getDocument({data:new Uint8Array(await files.rendered.blob.arrayBuffer()),isEvalSupported:false}).promise;
  const pages=[];for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}
  const review=newReview(identity,snapshotId,pages);
  review.findings=[1,2,3,4].map((number)=>{const strokes=number===2?[]:[{points:[[70,650],[150,650]],width:12,color:'#ffd34d',opacity:.35}];return {id:'comparison-'+number,number,page:number,color:'#ffd34d',comment:number===4?Array(12).fill('SIMULATED longer report: compare the printed notes and articulation in this passage.').join('\n'):number===1?'SIMULATED report: The last note in bar 2 should be E. Keep the printed slur.':number===2?'SIMULATED text-only comment':'SIMULATED marked problem '+number,state:'open',strokes,bounds:bounds(strokes)};});for(const finding of review.findings)if(types[finding.number])finding.type=types[finding.number];review.nextNumber=5;
  const issued=await makeTask(review,files,doc,'page',()=>{});await doc.destroy();await retain(issued);
  const pdf=await PDFLib.PDFDocument.load(await (await fixtureBlob('rendered.pdf')).arrayBuffer());pdf.getPages()[0].setCropBox(12,24,580,740);pdf.getPages()[0].setRotation(PDFLib.degrees(90));
  const after=new Blob([await pdf.save()],{type:'application/pdf'}),code=new Blob(['% SYNTHETIC changed code; no music\n']);
  const template=JSON.parse(await issued.payloads.get('response-template.json').text());
  template.code={status:'changed',path:'proposed.ly'};template.rendering={status:'supplied',path:'proposed.pdf',producer:'SIMULATED comparison fixture',compiler:null};template.files={'proposed.ly':await fileInfo(code),'proposed.pdf':await fileInfo(after)};template.results.forEach(f=>{f.status=types[review.findings.find(r=>r.id===f.id)?.number]==='comment'?'unchanged_with_reason':'changed';f.explanation='SIMULATED change claim; verify visually.';});
  async function entryFor(response,pdfBlob){const payloads=new Map([['response.json',json(response)],['proposed.ly',code],['proposed.pdf',pdfBlob]]);const parsed=await readResponse(await zipFiles(payloads),async()=>issued),entry=responseRevision(parsed);await retain(entry);return entry;}
  const entry=await entryFor(template,after);await handoff.returnedUI.open(entry);
  const other=clone(template);other.rendering.producer='SIMULATED parallel candidate';const otherPdf=await fixtureBlob('source.pdf');other.files['proposed.pdf']=await fileInfo(otherPdf);const second=await entryFor(other,otherPdf);
  const followup=await followupTask(completion.capture(),'page',()=>{});await retain(followup);
  async function unchanged(task){const r=JSON.parse(await task.payloads.get('response-template.json').text());r.code={status:'unchanged',path:null};r.rendering={status:'pending',path:null,producer:'SIMULATED',compiler:null};r.files={};r.results.forEach(f=>{f.status='unchanged_with_reason';f.explanation='SIMULATED historical context';});const e=responseRevision(await readResponse(await zipFiles(new Map([['response.json',json(r)]])),async()=>task));await retain(e);return e;}
  const older=await unchanged(followup);
  const cropOnly=clone(followup);cropOnly.id=crypto.randomUUID();cropOnly.task.id=cropOnly.id;
  for(const f of cropOnly.task.findings){delete f.historicalContext.originalFiles;delete f.historicalContext.annotations;}
  await finalizeTask(cropOnly);await retain(cropOnly);const crop=await unchanged(cropOnly);
  return {entryId:entry.id,secondId:second.id,olderId:older.id,cropId:crop.id,issuedId:issued.id,baseline:identity.rendered.sha256,source:identity.source.sha256,after:template.files['proposed.pdf'].sha256};
}

// A real local task/response with 100 distinct text reports exercises browsing
// at scale without relying on another browser suite or a mocked UI adapter.
export async function manyProblemsFixture(issuedId){
  const previous=await retained(issuedId),review=clone(previous.review);
  const descriptions=['Check the violin accidental against the print','The piano slur ends one note too early','Check the rest duration in the lower staff','The printed dynamic is missing'];
  review.findings=Array.from({length:100},(_,i)=>({id:`large-problem-${i+1}`,number:i+1,page:i%4+1,color:'#ffd34d',comment:`SIMULATED bar ${i+1}: ${descriptions[i%4]}.`,state:'open',strokes:[],bounds:null}));review.nextNumber=101;
  const doc=await pdfjs.getDocument({data:new Uint8Array(await previous.files.rendered.blob.arrayBuffer()),isEvalSupported:false}).promise;
  const issued=await makeTask(review,previous.files,doc,'page',()=>{});await doc.destroy();await retain(issued);
  const response=JSON.parse(await issued.payloads.get('response-template.json').text());response.code={status:'unchanged',path:null};response.rendering={status:'pending',path:null,producer:'SIMULATED scale fixture',compiler:null};response.files={};response.results.forEach(result=>{result.status='unchanged_with_reason';result.explanation='SIMULATED navigation fixture; no musical review.';});
  const entry=responseRevision(await readResponse(await zipFiles(new Map([['response.json',json(response)]])),async()=>issued));await retain(entry);await handoff.returnedUI.open(entry);
}

