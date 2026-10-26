// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {focusReady} from './review-focus-flow.mjs';

// Additional exact-round navigation checks run inside the supported summary suite.
export async function exerciseReviewLoop(page,check,evidence){
  const ready=()=>focusReady(page),until=fn=>page.waitForFunction(fn,null,{timeout:30000});
  const state=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return {selected:a.corrections.state().findingId,review:s.review,returned:s.returned,revisionId:s.revisionId,saved:await(await import('./storage.js')).getSaved(s.workspaceId)};});
  const close=async()=>{if(await page.locator('#roundSummary').isVisible()){await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();}};
  const seed=async types=>{await close();await page.evaluate(async types=>await(await import('./qa/comparison-fixture.js')).comparisonFixture({types}),types);await until(async()=>{const a=await import('./app.js');return !a.sessionStatus().busy&&!a.sessionStatus().dirty;});if(await page.evaluate(async()=>Boolean((await import('./app.js')).corrections.state().key)))await ready();};
  const draft=async text=>{await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill(text);await ready();};
  const go=async id=>{await close();await page.evaluate(async id=>await(await import('./app.js')).corrections.selectFinding(id),id);await ready();};
  const openSummary=async()=>{await until(()=>document.querySelector('#roundSummary').open);};
  await seed({2:'source_footnote',3:'comment'});
  await page.locator('#skipCorrection').focus();await page.keyboard.down('x');await ready();await page.keyboard.down('x');
  check((await state()).selected==='comparison-2'&&(await state()).returned.reported.every(f=>!f.decision),'held Next advances exactly once without deciding');await page.keyboard.up('x');
  await page.locator('#skipCorrection').dblclick({delay:60});await ready();
  check((await state()).selected==='comparison-4'&&await page.locator('#roundSummary').isHidden(),'double-click Next cannot advance and also open the end summary');
  await page.keyboard.down('x');await ready();await page.waitForTimeout(80);check(await page.locator('#roundSummary').isHidden(),'last-item Next waits for its input release');
  await page.keyboard.up('x');await openSummary();
  check(await page.locator('#roundSummaryTitle').innerText()==='Keep reviewing'&&await page.locator('#roundSummaryText').innerText()==='3 corrections still need checking.'&&await page.evaluate(()=>document.activeElement.id==='roundSummaryTitle'),'last-item Next shows the true unchecked count with neutral focus');
  await page.locator('#reviewUnchecked').dispatchEvent('click',{detail:1});check((await state()).selected==='comparison-4','finishing input cannot click through into Review remaining');
  await page.waitForTimeout(550);await page.locator('#reviewUnchecked').click();await ready();check((await state()).selected==='comparison-1','Review remaining revisits an earlier unchecked finding');

  const text='SYNTHETIC verified rejection\nKeep this exact second line.';await draft(text);const before=await state();
  await page.evaluate(async()=>{const a=await import('./app.js');window.loopGet=a.operations.getSaved;a.operations.getSaved=async()=>{throw Error('SYNTHETIC read-back failure');};});
  await page.locator('#roundExplanation').press('Enter');await ready();
  check((await state()).selected===before.selected&&await page.locator('#correctionResponse').isVisible()&&await page.locator('#roundExplanation').evaluate((el,text)=>el.value===text&&el===document.activeElement,text)&&await page.locator('#roundSummary').isHidden(),'failed decision read-back preserves the current editor, exact text and focus without advancing or summarizing');
  check((await state()).saved.returned.reported[0].decision.explanation===text,'a committed-but-unverified save remains durable for recovery');
  await page.evaluate(async()=>{const a=await import('./app.js');a.operations.getSaved=async(...args)=>{await new Promise(r=>window.releaseLoopVerify=r);return window.loopGet(...args);};});
  await page.keyboard.down('Enter');await until(()=>Boolean(window.releaseLoopVerify));await page.keyboard.down('Enter');
  check((await state()).selected==='comparison-1','navigation waits for local decision read-back');
  await page.evaluate(async()=>{(await import('./app.js')).operations.getSaved=window.loopGet;window.releaseLoopVerify();});await ready();
  check((await state()).selected==='comparison-2'&&(await state()).returned.reported.filter(f=>f.decision).length===1,'verified retry advances exactly once to the next correction');
  await page.keyboard.down('Enter');await ready();check(!(await state()).returned.reported[1].decision,'held editor Enter cannot approve the newly focused finding');await page.keyboard.up('Enter');
  await draft('SYNTHETIC unclear footnote source');await page.locator('#needsClarification').check();await ready();await page.locator('#sendCorrectionResponse').dblclick({delay:60});await ready();
  check((await state()).selected==='comparison-4'&&(await state()).saved.returned.reported[1].decision.state==='needs_source_clarification'&&!(await state()).returned.reported[3].decision,'source clarification saves against the exact revision and advances once despite a double-click');
  await page.locator('#looksCorrect').click();await ready();await openSummary();
  check(await page.locator('#roundSummaryTitle').innerText()==='Another correction round','final approval after rejection and clarification automatically opens another round');await close();
  await page.locator('#looksCorrect').click();await ready();await page.waitForTimeout(100);check(await page.locator('#roundSummary').isHidden(),'repeated terminal decisions do not replay an acknowledged exact-round outcome');
  await page.locator('#skipCorrection').click();await openSummary();check(await page.locator('#roundSummaryTitle').innerText()==='Another correction round','explicit final Next reopens an acknowledged outcome');await close();
  const saved=await state();await page.reload();await ready();await page.waitForTimeout(100);check(await page.locator('#roundSummary').isHidden(),'restart does not replay an acknowledged outstanding outcome');assert.deepEqual((await state()).returned,saved.returned);

  for(const clarify of [false,true]){
    await seed({2:'comment',3:'comment'});await page.locator('#looksCorrect').click();await ready();
    await draft(clarify?'SYNTHETIC final source clarification':'SYNTHETIC final rejected correction');if(clarify){await page.locator('#needsClarification').check();await ready();}
    await page.locator('#roundExplanation').focus();await page.keyboard.down('Enter');await ready();await page.waitForTimeout(80);check(await page.locator('#roundSummary').isHidden(),`${clarify?'clarification':'rejection'} summary waits for finishing Enter release`);
    await page.keyboard.up('Enter');await openSummary();await until(()=>!document.querySelector('#sendRemaining').hidden&&!document.querySelector('#sendRemaining').disabled);
    check(await page.locator('#roundSummaryTitle').innerText()==='Another correction round'&&await page.locator('#roundSummaryText').innerText()==='Some corrections still need work. Copy the prompt and send it to your AI for another round of corrections.',`final ${clarify?'clarification':'rejection'} automatically gives the requested next-round direction`);
    const task=await page.evaluate(async()=>{const t=(await import('./app.js')).corrections.summaryTask();return {task:t.task,prompt:await t.payloads.get('PROMPT.txt').text()};}),s=await state();
    check(task.task.findings.map(f=>f.id).join(',')==='comparison-2,comparison-3,comparison-4'&&task.task.findings[2].reviewer.explanation===s.returned.reported[3].explanation,'next task excludes the approved correction and retains comments and the latest exact explanation');
    check(s.saved.returned.reported[3].decision.state===(clarify?'needs_source_clarification':'open')&&s.saved.returned.reported[3].decision.reviewed.snapshotId===s.review.snapshotId&&s.saved.returned.reported[3].decision.reviewed.codeSha256===s.review.files.ly.sha256&&s.saved.returned.reported[3].decision.reviewed.renderSha256===s.review.files.rendered.sha256,'durable final decision refers to the exact code/render/snapshot');
    await page.waitForTimeout(550);await page.locator('#sendRemaining').click();check(await page.locator('#nextAIPrompt').inputValue()===task.prompt&&(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')===task.prompt,'displayed, copied and saved next prompts are identical');
    await page.screenshot({path:resolve(evidence,clarify?'navigation-clarification-summary.png':'navigation-rejection-summary.png')});
    await close();
  }
  await seed({1:'comment',2:'comment',3:'comment',4:'comment'});
  await page.evaluate(async()=>(await import('./app.js')).corrections.showSummary());
  check(await page.locator('#roundSummaryTitle').innerText()==='Review complete'&&await page.locator('#sendRemaining').isHidden()&&(await state()).returned.reported.every(f=>!f.decision),'comments-only round creates neither unresolved corrections nor invented approvals');await close();
}
