// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runFocusShortcuts({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('focus-shortcuts: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const state=()=>page.evaluate(async()=>{const a=await import('./app.js');return {...a.sessionStatus(),review:a.completion.capture().review,focus:document.activeElement.id};});
  const focused=id=>page.locator('#'+id).evaluate(el=>document.activeElement===el);
  const settled=()=>page.waitForFunction(async()=>!(await import('./app.js')).sessionStatus().busy&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false');
  const escape=async()=>{await page.locator('#overlay').focus();await page.keyboard.press('Escape');};
  const scorePoint=async()=>{const box=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox();return {x:Math.max(box.x,scroll.x)+100,y:Math.max(box.y,scroll.y)+100};};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','multipage.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open'));await settled();
    const color=page.locator('#highlightColor');
    await color.click();check(await color.evaluate(el=>document.activeElement===el&&el.matches(':open')),'opening Color keeps the native picker and its focus available');
    const oldColor=await color.inputValue();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    check(await focused('overlay')&&await color.inputValue()!==oldColor,'committing a changed native Color option returns focus to the score');
    await page.keyboard.press('n');check((await state()).prepared&&await focused('comment'),'N starts a finding immediately after choosing Color');await escape();
    const sameColor=await color.inputValue();await color.click();await page.keyboard.press('Enter');
    check(await focused('overlay')&&await color.inputValue()===sameColor,'committing the unchanged Color choice also returns focus');
    await page.keyboard.press('n');check((await state()).prepared&&await focused('comment'),'N works after an unchanged Color choice');await escape();

    await color.focus();const beforeArrows=await color.inputValue();await page.keyboard.press('ArrowDown');
    check(await focused('highlightColor')&&await color.inputValue()!==beforeArrows&&!(await state()).prepared,'closed-select arrow navigation changes Color without stealing keyboard focus');
    await page.keyboard.press('n');check(await focused('highlightColor')&&!(await state()).prepared,'native select type-ahead does not create a finding');
    await page.keyboard.press('Enter');check(await color.evaluate(el=>document.activeElement===el&&el.matches(':open')),'Enter can open the native select from the keyboard');
    await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');check(await focused('overlay'),'Enter commits a keyboard-opened picker and restores score hotkeys');
    await page.keyboard.press('n');await page.locator('#comment').fill('SYNTHETIC note kept while closing a picker');const active=(await state()).active;
    await color.click();await page.keyboard.press('Escape');
    check(await focused('overlay')&&(await state()).active===active&&await page.locator('#comment').inputValue()==='SYNTHETIC note kept while closing a picker','Escape closes Color and restores score focus without clearing the active finding');

    await page.locator('#brush').focus();const width=Number(await page.locator('#brush').inputValue());await page.keyboard.press('ArrowRight');
    check(await focused('brush')&&Number(await page.locator('#brush').inputValue())===width+1,'brush arrow-key adjustment retains native slider behavior');
    await page.keyboard.press('n');check((await state()).prepared&&await focused('comment'),'N works while the brush slider has focus');await escape();
    await page.locator('#autoColor').focus();const cycling=await page.locator('#autoColor').isChecked();await page.keyboard.press('Space');
    check(await focused('autoColor')&&await page.locator('#autoColor').isChecked()!==cycling,'Space retains native checkbox behavior');
    await page.keyboard.press('n');check((await state()).prepared&&await focused('comment'),'N works while a toolbar checkbox has focus');
    await page.locator('#comment').pressSequentially('ndv');const typed=await state();
    check(await focused('comment')&&await page.locator('#comment').inputValue()==='ndv'&&typed.active&&typed.mode==='draw','letters in a genuine note remain text instead of commands');
    await page.locator('#renderedPage').focus();await page.keyboard.press('n');
    check(await focused('renderedPage')&&(await state()).active===typed.active&&!(await state()).prepared,'page-number editing remains an input context rather than running letter commands');

    await page.locator('#navigate').click();await color.focus();const point=await scorePoint();await page.mouse.click(point.x,point.y);
    check(await focused('overlay'),'clicking the rendered score releases an option that was left keyboard-focused');
    await page.keyboard.press('n');check((await state()).prepared&&await focused('comment'),'N works after returning from an option to the score');
    await page.locator('#brush').focus();await page.locator('#overlay').dispatchEvent('pointerdown',{pointerId:71,isPrimary:true,pointerType:'mouse',button:0,buttons:1,clientX:point.x,clientY:point.y});
    await page.locator('#overlay').dispatchEvent('pointercancel',{pointerId:71,isPrimary:true,pointerType:'mouse',button:0,buttons:0,clientX:point.x,clientY:point.y});
    check(await focused('brush')&&!(await state()).gesture,'a cancelled stroke does not move focus from the previous control');

    await page.locator('#comment').fill('SYNTHETIC preserve note caret');await page.locator('#comment').evaluate(el=>el.setSelectionRange(10,14));const noteId=(await state()).active;
    await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+30,point.y+5);await page.mouse.up();
    check(await page.locator('#comment').evaluate(el=>document.activeElement===el&&el.selectionStart===10&&el.selectionEnd===14),'adding a stroke preserves the active note caret');
    const wholeAnnotation=structuredClone((await state()).review.findings.find(f=>f.id===noteId));await page.keyboard.press('Control+z');const undone=await state();
    check(!undone.review.findings.some(f=>f.id===noteId)&&!undone.active&&await page.locator('#comment').inputValue()==='','Ctrl+Z in the focused note removes the complete new annotation and its mark together');
    await page.keyboard.press('Control+Shift+z');const redone=await state();
    check(redone.active===noteId&&JSON.stringify(redone.review.findings.find(f=>f.id===noteId))===JSON.stringify(wholeAnnotation)&&await page.locator('#comment').inputValue()===wholeAnnotation.comment,'Ctrl+Shift+Z restores the complete note, mark and identity after a keyboard Undo');

    await menuCommand(page,'File','files');if(!await page.locator('#handoffHistoryPanel').evaluate(el=>el.open))await page.locator('#handoffHistoryPanel>summary').click();await page.locator('#saved').click();await page.keyboard.press('Enter');
    check(await focused('saved')&&await page.locator('#workspaceDialog').evaluate(el=>el.open),'committing a dialog select keeps focus inside its dialog');
    const beforeDialog=await state();await page.keyboard.press('n');
    check((await state()).active===beforeDialog.active&&await page.locator('#workspaceDialog').evaluate(el=>el.open),'dialog focus prevents background command shortcuts');
    await page.locator('#closeWorkspace').click();
    check(errors.length===0,'focus handling produces no uncaught browser errors: '+errors.join('; '));
    return {name:'focus-shortcuts',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'focus-shortcuts-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'focus-shortcuts.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
