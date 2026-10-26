// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runReviewNoteEnter({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('review-note-enter: '+label);};
  const until=async predicate=>{const end=Date.now()+45000;while(!await page.evaluate(predicate)){if(Date.now()>end)throw Error('Correction editor did not settle');await new Promise(r=>setTimeout(r,30));}};
  const ready=()=>until(async()=>{const a=await import('./app.js');return document.body.dataset.ready==='true'&&Boolean(a.sessionStatus().snapshotId)&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending;});
  const scene=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),saved=await(await import('./storage.js')).getSaved(s.workspaceId);return {review:s.review,returned:s.returned,saved,selected:a.corrections.state().findingId,active:a.sessionStatus().active};});
  const select=async id=>{await page.evaluate(async id=>(await import('./app.js')).corrections.selectFinding(id),id);await ready();};
  const draft=async text=>{await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill(text);await ready();};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();
    await page.evaluate(async()=>{await(await import('./qa/comparison-fixture.js')).comparisonFixture({types:{2:'source_footnote',3:'comment'}});});await ready();
    const text='SYNTHETIC still wrong\nPreserve this pasted second line.';await draft(text);await page.locator('#roundExplanation').press('Enter');await ready();let s=await scene();
    log.push('REPRO '+JSON.stringify({editorVisible:await page.locator('#correctionResponse').isVisible(),text:await page.locator('#roundExplanation').inputValue(),decision:s.returned.reported[0].decision}));
    if(process.env.SCORE_DESK_FINDINGS_REPRO_ONLY){await page.locator('#sendCorrectionResponse').click();await ready();check(Boolean((await scene()).saved.returned.reported[0].decision),'Save correction commits the decision while the baseline Enter only edits text');return {name:'review-note-enter',assertions};}
    check(await page.locator('#correctionResponse').isHidden()&&s.saved.returned.reported[0].decision?.explanation===text&&s.selected==='comparison-2','Enter saves the exact multiline correction explanation and advances once');
    await select('comparison-2');await draft(text);await page.locator('#sendCorrectionResponse').click();await ready();const clicked=await scene();
    check(clicked.saved.returned.reported[1].decision.state===s.saved.returned.reported[0].decision.state&&JSON.stringify(clicked.saved.returned.reported[1].decision.reviewed)===JSON.stringify(s.saved.returned.reported[0].decision.reviewed)&&clicked.saved.returned.reported[1].decision.explanation===text,'Enter and clicking Save correction commit equivalent decision states, hashes and text');
    await select('comparison-2');await draft('SYNTHETIC modifier draft\nPasted line');const priorDecision=JSON.stringify((await scene()).returned.reported[1].decision);
    for(const key of ['Control+Enter','Meta+Enter']){await page.locator('#roundExplanation').press(key);await ready();check(JSON.stringify((await scene()).returned.reported[1].decision)===priorDecision&&!(await scene()).active,key+' in the explanation never dispatches the finding editor command');}
    await page.locator('#roundExplanation').fill('SYNTHETIC Shift+Enter correction\nPasted line');await page.locator('#roundExplanation').press('Shift+Enter');await ready();
    check(await page.locator('#correctionResponse').isHidden()&&(await scene()).saved.returned.reported[1].decision.explanation==='SYNTHETIC Shift+Enter correction\nPasted line','Shift+Enter saves the correction and preserves its pasted lines');
    await select('comparison-4');await draft('');await page.locator('#roundExplanation').press('Enter');await ready();
    check(await page.locator('#correctionResponse').isVisible()&&!(await scene()).returned.reported[3].decision,'empty explanation stays open without a decision');
    await page.locator('#roundExplanation').fill('SYNTHETIC draft retained after cancellation');await ready();await page.locator('#cancelCorrectionResponse').click();
    check(!(await scene()).returned.reported[3].decision,'cancelling keeps a draft without recording rejection');await page.locator('#stillCorrection').click();
    check(await page.locator('#roundExplanation').inputValue()==='SYNTHETIC draft retained after cancellation','cancelled correction draft is available when reopened');
    await page.locator('#roundExplanation').dispatchEvent('compositionstart');await page.locator('#roundExplanation').press('Enter');await page.locator('#roundExplanation').dispatchEvent('compositionend');
    await page.locator('#roundExplanation').dispatchEvent('keydown',{key:'Enter',isComposing:true});await page.locator('#roundExplanation').dispatchEvent('keydown',{key:'Enter',keyCode:229});await ready();
    check(!(await scene()).returned.reported[3].decision&&await page.locator('#correctionResponse').isVisible(),'IME confirmation does not save a correction');
    await page.evaluate(()=>document.getElementById('shortcutsDialog').showModal());await page.keyboard.press('Enter');if(await page.locator('#shortcutsDialog').isVisible())await page.locator('#closeShortcuts').click();
    check(!(await scene()).returned.reported[3].decision,'modal keyboard input cannot save a background correction');
    await page.locator('#roundExplanation').fill('SYNTHETIC failing correction\nKeep selection.');await ready();
    await page.evaluate(async()=>{const a=await import('./app.js');window.correctionPut=a.operations.putSaved;a.operations.putSaved=async()=>{throw Error('SYNTHETIC correction save failure');};document.getElementById('roundExplanation').setSelectionRange(3,11);});
    await page.locator('#roundExplanation').press('Enter');await until(async()=>!(await import('./app.js')).corrections.state().pending);s=await scene();
    check(!s.returned.reported[3].decision&&s.selected==='comparison-4'&&await page.locator('#roundExplanation').evaluate(el=>el===document.activeElement&&el.selectionStart===3&&el.selectionEnd===11&&el.value==='SYNTHETIC failing correction\nKeep selection.'),'failed correction save preserves exact editor text, caret, selection and decision state');
    await page.evaluate(async()=>{const a=await import('./app.js');window.correctionCalls=0;a.operations.putSaved=async(...args)=>{window.correctionCalls++;await new Promise(r=>window.releaseCorrection=r);return window.correctionPut(...args);};});
    await page.keyboard.down('Enter');await until(()=>Boolean(window.releaseCorrection));await page.keyboard.down('Enter');
    check(await page.evaluate(()=>window.correctionCalls===1)&&!(await scene()).returned.reported[3].decision,'slow saving and held Enter dispatch only one correction save');
    await page.evaluate(()=>window.releaseCorrection());await ready();await page.locator('#looksCorrect').focus();await page.keyboard.down('Enter');await page.keyboard.up('Enter');
    s=await scene();check(s.saved.returned.reported[3].decision.state!=='resolved'&&s.saved.returned.reported[3].decision.state!=='looks_correct'&&await page.evaluate(()=>window.correctionCalls===1),'completing Enter cannot activate Looks correct or save twice');
    await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.correctionPut;});await page.screenshot({path:resolve(evidence,'review-note-enter-saved.png')});
    return {name:'review-note-enter',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'review-note-enter-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'review-note-enter.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
