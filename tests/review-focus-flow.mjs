// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {fixtureBlob} from '../app/qa/fixtures.js';

// Seed through the shipped model/task/response validators. The same test runs
// against browser source and an untouched extracted ZIP (which excludes QA).
export async function seedReviewFocus(page,{candidatePdf='rendered.pdf'}={}){
  const inputs=Object.fromEntries(await Promise.all(['source.pdf','multipage.pdf','rendered.pdf','score.ly'].map(async name=>[name,[...new Uint8Array(await(await fixtureBlob(name)).arrayBuffer())]])));
  await page.evaluate(async ({inputs,candidatePdf})=>{
    const {identify,newReview}=await import('./model.js'),{makeTask,readResponse,responseRevision,json,fileInfo}=await import('./workflow.js');
    const {zipFiles}=await import('./export.js'),{retain}=await import('./handoff-store.js'),{handoff}=await import('./app.js'),pdfjs=await import('./vendor/pdf.mjs');
    const blob=name=>new Blob([new Uint8Array(inputs[name])],{type:name.endsWith('.pdf')?'application/pdf':'text/plain'});
    const files={source:{name:'SYNTHETIC-source.pdf',blob:blob('source.pdf')},rendered:{name:'SYNTHETIC-before.pdf',blob:blob('multipage.pdf')},ly:{name:'SYNTHETIC.ly',blob:blob('score.ly')}};
    const {identity,snapshotId}=await identify(files),doc=await pdfjs.getDocument({data:new Uint8Array(await files.rendered.blob.arrayBuffer()),isEvalSupported:false}).promise,pages=[];
    for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}
    const review=newReview(identity,snapshotId,pages);
    review.findings=[1,2,3,4].map(number=>({id:'focus-'+number,number,page:number,color:'#ffd34d',comment:'SYNTHETIC keyboard correction '+number,state:'open',strokes:[],bounds:null}));review.nextNumber=5;
    const issued=await makeTask(review,files,doc,'page',()=>{});await doc.destroy();await retain(issued);
    const after=blob(candidatePdf),code=new Blob(['% SYNTHETIC focus revision '+crypto.randomUUID()]),response=JSON.parse(await issued.payloads.get('response-template.json').text());
    response.code={status:'changed',path:'proposed.ly'};response.rendering={status:'supplied',path:'proposed.pdf',producer:'SYNTHETIC keyboard test',compiler:null};response.files={'proposed.ly':await fileInfo(code),'proposed.pdf':await fileInfo(after)};
    response.results.forEach(f=>{f.status='changed';f.explanation='SYNTHETIC claimed correction for keyboard verification.';});
    const entry=responseRevision(await readResponse(await zipFiles(new Map([['response.json',json(response)],['proposed.ly',code],['proposed.pdf',after]])),async()=>issued));await retain(entry);await handoff.returnedUI.open(entry);
  },{inputs,candidatePdf});
}

export async function focusReady(page){
  const end=Date.now()+90000;
  while(!await page.evaluate(async()=>{const a=await import('./app.js'),s=a.sessionStatus();return document.body.dataset.ready==='true'&&!s.busy&&!s.dirty&&!a.corrections.state().pending&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false'&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true');})){
    if(Date.now()>end)throw Error('Review did not settle: '+await page.locator('body').innerText());await new Promise(r=>setTimeout(r,80));
  }
}

export async function exerciseReviewFocus(page,start,check,screenshot){
  await seedReviewFocus(page);await focusReady(page);
  const state=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return {selected:a.corrections.state().findingId,returned:s.returned,review:s.review,revisionId:s.revisionId,workspaceId:s.workspaceId};});
  const active=()=>page.evaluate(()=>document.activeElement?.id);
  const decisions=s=>s.returned.reported.filter(f=>f.decision).length;
  const test=(ok,label)=>check(ok,start+': '+label);
  const selector={row:'[data-reported-id="focus-1"] .finding-open',button:'#stillCorrection',score:'#overlay'}[start];
  await page.locator(selector).focus();
  assert(await page.locator(selector).evaluate(el=>el===document.activeElement),'initial focus '+start);
  await page.evaluate(async()=>{const a=await import('./app.js');window.focusTestRow=document.querySelector('[data-reported-id="focus-1"] .finding-open');window.focusTestPut=a.operations.putSaved;window.releaseFocusDecision=null;a.operations.putSaved=async(...args)=>{await new Promise(r=>window.releaseFocusDecision=r);return window.focusTestPut(...args);};});
  await page.keyboard.down('c');await page.waitForFunction(()=>Boolean(window.releaseFocusDecision));
  await page.keyboard.down('c');await page.keyboard.press('w');await page.keyboard.press('x');
  test((await state()).selected==='focus-1'&&decisions(await state())===0&&await page.locator('#correctionResponse').isHidden(),'delayed save neither advances nor accepts other shortcuts');
  await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.focusTestPut;window.releaseFocusDecision();});await focusReady(page);
  test((await state()).selected==='focus-2'&&decisions(await state())===1&&await active()==='looksCorrect','C saves, advances once and focuses Looks correct');
  test(await page.evaluate(()=>!window.focusTestRow.isConnected),'the old Findings row was actually replaced');
  await page.keyboard.down('c');await focusReady(page);
  test((await state()).selected==='focus-2'&&decisions(await state())===1,'held C stays suppressed across the save and focus transfer');await page.keyboard.up('c');
  await page.keyboard.press('w');
  test(await active()==='roundExplanation'&&decisions(await state())===1,'W immediately opens the editor without a click or rejection');
  await page.keyboard.type('cwx');await focusReady(page);
  test((await state()).selected==='focus-2'&&decisions(await state())===1&&await page.locator('#roundExplanation').inputValue()==='cwx','typing C/W/X remains text');
  await page.keyboard.press('Escape');await page.keyboard.press('c');await focusReady(page);
  test((await state()).selected==='focus-3'&&decisions(await state())===2&&await active()==='looksCorrect','C continues from the editor return without restoring focus manually');
  await page.keyboard.press('x');await focusReady(page);
  test((await state()).selected==='focus-4'&&decisions(await state())===2&&await active()==='skipCorrection','X advances without approval and retains correction-control focus');
  const geometry=await page.locator('.correction-actions').boundingBox();await page.keyboard.press('c');await focusReady(page);
  await page.waitForFunction(()=>document.querySelector('#roundSummary').open);test((await state()).selected==='focus-4'&&decisions(await state())===3&&await active()==='roundSummaryTitle','final C saves then focuses the neutral Keep reviewing heading');
  test(!(await state()).returned.reported[2].decision&&await page.locator('#roundSummaryTitle').innerText()==='Keep reviewing'&&JSON.stringify(geometry)===JSON.stringify(await page.locator('.correction-actions').boundingBox()),'an earlier unchecked correction prevents automatic completion and controls remain stationary');
  if(screenshot)await screenshot('final-'+start);
  await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();await page.keyboard.press('w');test(await active()==='roundExplanation'&&decisions(await state())===3,'W also works immediately after the final approval');
  await page.keyboard.press('Escape');await page.keyboard.press('x');await focusReady(page);
  await page.waitForFunction(()=>document.querySelector('#roundSummary').open);test((await state()).selected==='focus-4'&&decisions(await state())===3&&await active()==='roundSummaryTitle','final X explicitly reopens Keep reviewing without another decision');await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();

  // Failure starts with a row too, so a rebuilt/detached source cannot hide
  // behind the successful approval case. Retry must require no refocusing.
  await page.evaluate(async()=>await(await import('./app.js')).corrections.selectFinding('focus-3'));await focusReady(page);
  await page.locator('[data-reported-id="focus-3"] .finding-open').focus();const before=await state();
  await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=async()=>{throw Error('SYNTHETIC decision save failure');};});
  await page.keyboard.press('c');await page.waitForFunction(()=>document.querySelector('#correctionNotice').textContent.includes('SYNTHETIC decision save failure'));await focusReady(page);
  test((await state()).selected==='focus-3'&&JSON.stringify((await state()).returned)===JSON.stringify(before.returned)&&await active()==='looksCorrect','failed save preserves the decision and selection and focuses retry');
  await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.focusTestPut;});await page.keyboard.press('c');await focusReady(page);
  test(decisions(await state())===4&&['looksCorrect','roundSummaryTitle'].includes(await active()),'C retries without a click and keeps focus in the controls or immediate completion dialog');
  test(await page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),saved=await(await import('./storage.js')).getSaved(s.workspaceId);return JSON.stringify(saved.returned)===JSON.stringify(s.returned)&&saved.revisionId===s.revisionId&&s.returned.reported.every(f=>f.decision.reviewed.snapshotId===s.returned.contentSnapshotId&&f.decision.reviewed.renderSha256===s.returned.renderSha256);}), 'all decisions are durably saved against the exact revision');
  await page.waitForFunction(()=>document.querySelector('#roundSummary').open);
  test(await page.locator('#roundSummaryTitle').innerText()==='Review complete'&&await active()==='roundSummaryTitle','the last unchecked approval automatically opens completion after saving and focuses its neutral heading');
  await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();
  return state();
}
