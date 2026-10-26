// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {isDeepStrictEqual as same} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runAnnotationUndo({browser,serve,evidence,root}){
 const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
 const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('annotation-undo: '+label);};
 page.on('pageerror',e=>errors.push(e.message));
 const until=async predicate=>{const end=Date.now()+60000;while(!await page.evaluate(predicate)){if(Date.now()>end)throw Error('Annotation state did not settle: '+await page.locator('body').innerText());await new Promise(r=>setTimeout(r,35));}};
 const ready=()=>until(async()=>{const a=await import('./app.js'),s=a.sessionStatus();return document.body.dataset.ready==='true'&&!s.busy&&!s.dirty&&!a.corrections.state().pending&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true');});
 const state=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),saved=s.workspaceId?await(await import('./storage.js')).getSavedState(s.workspaceId):null;return {review:s.review,returned:s.returned,status:a.sessionStatus(),saved};});
 const select=async id=>{await page.locator(`[data-finding-id="${id}"] .finding-open`).click();await ready();};
 const undo=async()=>{await page.keyboard.press('Control+z');await ready();};
 const redo=async()=>{await page.keyboard.press('Control+Shift+z');await ready();};
 const stroke=async(offset=0)=>{
  await page.locator('#draw').click();const overlay=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox();
  const x=Math.max(overlay.x,scroll.x)+75,y=Math.max(overlay.y,scroll.y)+100+offset;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+80,y+6,{steps:5});await page.mouse.up();await ready();
 };
 const save=async()=>{await page.locator('#saveFinding').click();await ready();};
 const note=async text=>{await page.locator('#newFinding').click();await page.locator('#comment').pressSequentially(text);};
 try{
  await page.goto(server.url);await until(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();
  await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
  await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','rendered.pdf'],['lyFile','score.ly']]){const transfer=new DataTransfer();transfer.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
  await page.locator('#load').click();await ready();const empty=await state();
  await page.evaluate(async()=>{const a=await import('./app.js'),put=a.operations.putSaved;window.undoWriteCount=0;a.operations.putSaved=(...args)=>{window.undoWriteCount++;return put(...args);};});
  await page.locator('#newFinding').click();
  for(const letter of 'SYN'){await page.locator('#comment').pressSequentially(letter);await page.waitForTimeout(450);}
  check(await page.evaluate(()=>window.undoWriteCount===0),'typing at 450ms per key does not write each draft character');
  await page.locator('#comment').pressSequentially('THETIC long annotation: '+Array(8).fill('check this note').join(' '));await ready();
  check(await page.evaluate(()=>window.undoWriteCount===1),'one draft autosave follows a pause in typing');
  const midway=await state();check(midway.saved.review.findings[0].comment.length>80,'a long note autosaves before Save note without exhausting creation history');
  await stroke();await page.locator('#comment').focus();await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' after autosave');await stroke(35);
  const first=(await state()).review.findings[0];check(first.strokes.length===2,'one annotation contains the typed note and both real pointer strokes');
  await page.locator('#overlay').press('Enter');await ready();await undo();let s=await state();
  check(s.review.findings.length===0&&s.review.nextNumber===empty.review.nextNumber&&same(s.review.preferences,empty.review.preferences),'one Ctrl+Z removes the whole saved annotation, both marks, number and color allocation');
  check(s.saved.review.findings.length===0,'whole-annotation Undo is durably saved, even after intermediate autosaves');
  await redo();s=await state();check(same(s.review.findings[0],first)&&same(s.saved.review.findings[0],first),'one Ctrl+Shift+Z restores the exact annotation identity, text, strokes and saved state');

  await select(first.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' revised text');await ready();await stroke(65);await page.locator('#findingType').selectOption('source_footnote');await page.locator('.finding-options>summary').click();await page.locator('#findingState').selectOption('needs_source_clarification');await save();const revised=(await state()).review.findings[0];
  await menuCommand(page,'Edit','undo');await ready();check(same((await state()).review.findings[0],first),'Edit menu Undo restores an old annotation before text, mark, type and state changes');
  await page.locator('#redo').click();await ready();check(same((await state()).review.findings[0],revised),'toolbar Redo reapplies the complete old-annotation edit');

  await select(first.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' branch to undo');await undo();
  check(same((await state()).review.findings[0],revised),'Ctrl+Z while typing restores the whole prior annotation, not one letter');
  await page.locator('#comment').dispatchEvent('input');await page.locator('#findingType').dispatchEvent('change');await page.locator('#findingState').dispatchEvent('change');
  check(await page.locator('#redo').isEnabled(),'same-value note, type and state events do not invalidate Redo');
  await page.keyboard.press('Control+y');await ready();const redone=(await state()).review.findings[0];
  check(redone.comment.endsWith(' branch to undo'),'Ctrl+Y restores the complete edit while the note field is active');
  await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' new edit');await undo();
  check(same((await state()).review.findings[0],redone),'editing after Redo starts a new annotation action');
  await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' replacement branch');
  check(await page.locator('#redo').isDisabled(),'a real new edit after Undo invalidates the obsolete Redo branch');await save();

  await page.locator('#newFinding').click();const beforeCancel=await state();
  const box=await page.locator('#renderedScroll').boundingBox();await page.mouse.move(box.x+85,box.y+120);await page.mouse.down();await page.mouse.move(box.x+130,box.y+125,{steps:3});await page.keyboard.press('Escape');await page.mouse.up();
  s=await state();check(s.review.findings.length===beforeCancel.review.findings.length&&s.status.undoLength===beforeCancel.status.undoLength&&s.review.nextNumber===beforeCancel.review.nextNumber,'cancelling an unfinished pointer stroke adds no annotation or undo action');
  await page.keyboard.press('Escape');

  await note('SYNTHETIC first unsaved editor');const a=(await state()).review.findings.at(-1);
  await note('SYNTHETIC second editor');await save();const b=(await state()).review.findings.at(-1);
  await undo();check((await state()).review.findings.some(f=>f.id===a.id)&&!(await state()).review.findings.some(f=>f.id===b.id),'New finding closes the previous annotation action without requiring an explicit Save');
  await undo();check(!(await state()).review.findings.some(f=>f.id===a.id),'the next Undo removes the preceding complete annotation');
  await redo();await redo();check(same((await state()).review.findings.slice(-2),[a,b]),'two Redo actions restore the two separate annotation sessions');

  await select(a.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' first visit');const visit=(await state()).review.findings.find(f=>f.id===a.id);
  await select(b.id);await select(a.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' second visit');await stroke();await save();
  await undo();check(same((await state()).review.findings.find(f=>f.id===a.id),visit),'switching away and back creates a distinct edit action for the old annotation');
  await undo();check(same((await state()).review.findings.find(f=>f.id===a.id),a),'a second Undo restores the annotation before its first visit');
  await redo();await redo();
  await select(a.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' kept on Escape');
  const leaveWrites=await page.evaluate(()=>window.undoWriteCount);await page.locator('#comment').press('Escape');
  await page.waitForFunction(n=>window.undoWriteCount>n,leaveWrites,{timeout:1000});await ready();const escaped=(await state()).review.findings.find(f=>f.id===a.id);
  check((await state()).saved.review.findings.find(f=>f.id===a.id).comment===escaped.comment,'leaving an edited annotation flushes it immediately instead of waiting for the typing delay');
  await select(a.id);await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' after reopening editor');await save();await undo();
  check(same((await state()).review.findings.find(f=>f.id===a.id),escaped),'Escape keeps the autosaved annotation but closes its edit action');
  await select(a.id);await page.locator('#deleteFinding').click();await page.locator('#confirmDelete').click();await ready();await undo();
  check(same((await state()).review.findings.find(f=>f.id===a.id),escaped),'Undo deletion restores the complete annotation and marks');
  await redo();check(!(await state()).review.findings.some(f=>f.id===a.id),'Redo deletion removes the complete annotation again');

  await select(b.id);const beforeFailure=(await state()).review.findings.find(f=>f.id===b.id);
  await page.evaluate(async()=>{const a=await import('./app.js');window.undoOriginalPut=a.operations.putSaved;a.operations.putSaved=async()=>{throw Error('SYNTHETIC failed annotation save');};});
  await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' first failed save');await page.locator('#saveFinding').click();
  await until(async()=>{const s=(await import('./app.js')).sessionStatus();return !s.busy&&s.saveFailed;});
  check((await state()).status.active===b.id,'failed Save note keeps the current annotation edit open');
  await page.evaluate(async()=>(await import('./app.js')).operations.putSaved=window.undoOriginalPut);
  await page.locator('#comment').press('End');await page.locator('#comment').pressSequentially(' retry continuation');await stroke();await save();await undo();
  check(same((await state()).review.findings.find(f=>f.id===b.id),beforeFailure),'one Undo after successful retry reverts the whole edit, including work before the failed save');

  await page.locator('#newFinding').click();const beforePending=(await state()).review.findings;
  await page.evaluate(async()=>{const a=await import('./app.js'),put=a.operations.putSaved;let once=true;a.operations.putSaved=async(...args)=>{if(once){once=false;await new Promise(r=>window.releaseUndoSave=r);}return put(...args);};window.undoRestorePut=()=>a.operations.putSaved=put;});
  await page.locator('#comment').pressSequentially('SYNTHETIC save in flight');await until(()=>Boolean(window.releaseUndoSave));
  await page.locator('#comment').pressSequentially(' more text');await page.keyboard.press('Control+z');
  check(same((await state()).review.findings,beforePending),'Undo removes the entire live annotation while an earlier draft save is in flight');
  await page.evaluate(()=>{window.releaseUndoSave();window.undoRestorePut();});await ready();
  check(same((await state()).saved.review.findings,beforePending),'the delayed earlier save cannot resurrect an annotation after Undo');
  await redo();check((await state()).review.findings.at(-1).comment==='SYNTHETIC save in flight more text','Redo after the delayed save restores every character together');await save();

  await page.evaluate(async()=>{window.undoComparison=await(await import('./qa/comparison-fixture.js')).comparisonFixture();});await ready();
  await page.evaluate(async()=>(await import('./app.js')).corrections.selectFinding('comparison-1'));await ready();await page.locator('#locateRegion').click();
  await page.locator('#comment').pressSequentially('SYNTHETIC associated correction');await stroke();await stroke(35);await save();
  s=await state();const linked=s.review.findings.at(-1),report=s.returned.reported.find(f=>f.id==='comparison-1');check(report.associationId===linked.id,'the complete annotation is associated with the reviewed finding');
  await page.evaluate(async()=>(await import('./app.js')).corrections.selectFinding('comparison-1'));await ready();await page.locator('#looksCorrect').click();await ready();const approved=(await state()).returned.reported.find(f=>f.id==='comparison-1').decision;
  check(approved?.state==='resolved','the separate human approval was recorded before annotation Undo');
  await page.keyboard.press('Control+z');await ready();s=await state();
  check(!s.review.findings.some(f=>f.id===linked.id)&&s.returned.reported.find(f=>f.id==='comparison-1').associationId===null,'one Undo removes the returned annotation and its association together');
  check(same(s.returned.reported.find(f=>f.id==='comparison-1').decision,approved),'undoing an annotation cannot roll back its human approval');
  await redo();s=await state();check(same(s.review.findings.find(f=>f.id===linked.id),linked)&&s.returned.reported.find(f=>f.id==='comparison-1').associationId===linked.id&&same(s.returned.reported.find(f=>f.id==='comparison-1').decision,approved),'Redo restores the exact returned annotation and association without changing the approval');
  check(same(s.saved.review.findings,s.review.findings)&&same(s.saved.returned,s.returned),'restored marks, links and human decisions are saved together');
  await page.reload();await ready();s=await state();check(same(s.review.findings.find(f=>f.id===linked.id),linked)&&same(s.returned.reported.find(f=>f.id==='comparison-1').decision,approved),'reopening preserves the final annotation and approval');
  check(errors.length===0,'annotation history checks have no uncaught browser errors: '+errors.join('; '));
  return {name:'annotation-undo',assertions};
 }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'annotation-undo-failure.png')});throw error;}
 finally{await writeFile(resolve(evidence,'annotation-undo.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
