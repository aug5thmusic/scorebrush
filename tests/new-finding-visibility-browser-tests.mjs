// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runNewFindingVisibility({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('new-finding-visibility: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const state=()=>page.evaluate(async()=>{
    const a=await import('./app.js'),s=a.completion.capture(),saved=await(await import('./storage.js')).getSaved(s.workspaceId);
    return {...a.sessionStatus(),review:s.review,returned:s.returned,revisionId:s.revisionId,savedRevision:saved.storageRevision,writes:window.findingVisibilityWrites};
  });
  const unchanged=(a,b)=>JSON.stringify([a.review,a.returned,a.revisionId,a.savedRevision,a.writes])===JSON.stringify([b.review,b.returned,b.revisionId,b.savedRevision,b.writes]);
  async function ready(){
    const end=Date.now()+60000;
    while(!await page.evaluate(async()=>{const a=await import('./app.js'),s=a.sessionStatus();return !s.busy&&!s.dirty&&!a.corrections.state().pending&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true');})){
      if(Date.now()>end)throw Error('Finding workspace did not settle');await new Promise(r=>setTimeout(r,50));
    }
  }
  const escape=async()=>{await page.locator('#overlay').focus();await page.keyboard.press('Escape');};
  async function hideMarks(){if(!await page.locator('#hide').isChecked()){if(await page.locator('#hide').isVisible())await page.locator('#hide').check();else await menuCommand(page,'View','marks');}}
  const pixels=id=>page.locator('#'+id).evaluate(el=>!el.hidden&&el.getContext('2d').getImageData(0,0,el.width,el.height).data.some((value,index)=>index%4===3&&value));
  async function menus(hidden){
    await page.waitForFunction(hidden=>document.querySelector('[data-command="marks"]').getAttribute('aria-checked')===String(hidden),hidden);
    return page.evaluate(async hidden=>{const a=await import('./app.js');return document.querySelector('#hide').checked===hidden&&a.applicationShell.states().marks.checked===hidden;},hidden);
  }
  async function draw(){
    const box=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox(),x=Math.max(box.x,scroll.x)+100,y=Math.max(box.y,scroll.y)+100;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+40,y+8,{steps:5});await page.mouse.up();
  }
  async function exercise(label,start,{historical=false}={}){
    await ready();await hideMarks();check(await menus(true),label+': toolbar and View menu initially agree that marks are hidden');
    const before=await state();await start();const prepared=await state();
    check(prepared.prepared&&!prepared.active&&prepared.mode==='draw'&&!prepared.marksHidden&&await menus(false),label+': starting reveals marks and updates drawing, toolbar and shared menu state');
    if(historical)check(await pixels('historicalOverlay'),label+': original marks are restored on their historical rendering');
    await escape();const canceled=await state();
    check(!canceled.prepared&&!canceled.active&&unchanged(before,canceled),label+': immediate cancellation preserves findings, counters, decisions and saved revision without writing');
    // Also catch an accidentally scheduled autosave, without postponing the
    // immediate cancellation assertion above (the normal debounce is 350 ms).
    await page.waitForTimeout(450);check(unchanged(before,await state()),label+': cancellation does not schedule an empty finding save');
    await hideMarks();await start();await draw();const marked=await state();
    check(marked.review.findings.length===before.review.findings.length+1&&marked.review.findings.at(-1).strokes.length===1&&await pixels('overlay'),label+': the first mouse stroke immediately creates a visible finding');
    await page.locator('#saveFinding').click();await ready();
  }
  const entryPoints=[['toolbar',()=>page.locator('#newFinding').click()],['N shortcut',async()=>{await page.locator('#overlay').focus();await page.keyboard.press('n');}],['Edit menu',()=>menuCommand(page,'Edit','new-finding')]];
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','multipage.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open'));await ready();
    await page.evaluate(async()=>{const a=await import('./app.js'),put=a.operations.putSaved;window.findingVisibilityWrites=0;a.operations.putSaved=(...args)=>{window.findingVisibilityWrites++;return put(...args);};});
    for(const [label,start]of entryPoints)await exercise('Proofread '+label,start);
    await page.locator('#hide').check();const beforeSelection=await state(),id=beforeSelection.review.findings[0].id;
    await page.locator(`[data-finding-id="${id}"] .finding-open`).click();await ready();
    check((await state()).active===id&&await menus(true)&&!await pixels('overlay')&&unchanged(beforeSelection,await state()),'selecting an existing finding keeps marks hidden and does not change saved data');
    await page.locator('#doneNext').click();await ready();
    check((await state()).prepared&&await menus(false)&&await pixels('overlay'),'Done & next also reveals marks when preparing a new finding');await escape();

    // A canceled pointer gesture must not consume a finding number or color.
    await page.locator('#hide').check();const beforeGesture=await state();await page.locator('#newFinding').click();
    await page.locator('#overlay').dispatchEvent('pointerdown',{pointerId:71,isPrimary:true,pointerType:'mouse',button:0,buttons:1,clientX:200,clientY:300});
    check((await state()).gesture,'a new finding accepts a pointer gesture after revealing marks');
    await page.locator('#overlay').dispatchEvent('pointercancel',{pointerId:71,isPrimary:true,pointerType:'mouse',button:0,buttons:0});await escape();
    check(!(await state()).gesture&&unchanged(beforeGesture,await state()),'canceling a new stroke and finding saves no empty record or number/color change');
    await page.screenshot({path:resolve(evidence,'new-finding-proofread.png')});

    await page.evaluate(async()=>await(await import('./qa/comparison-fixture.js')).comparisonFixture());await ready();
    // Review Changes hides its drawing toolbar until annotation starts, so use
    // its visible commands, plus the shared N shortcut and Edit menu.
    for(const [label,start]of [...entryPoints.slice(1),['Report another error',()=>page.locator('#reportAnotherError').click()],['Add note',()=>page.locator('#locateRegion').click()]])await exercise('Review Changes '+label,start,{historical:true});
    await hideMarks();const beforeNote=await state(),noteId=beforeNote.returned.reported[0].associationId;
    await page.locator('#showRegion').click();await ready();
    check((await state()).active===noteId&&await menus(true)&&!await pixels('overlay')&&!await pixels('historicalOverlay')&&unchanged(beforeNote,await state()),'Show note retains Hide marks and the exact existing association without creating or changing a finding');
    await escape();await page.locator('[data-reported-id="comparison-2"] .finding-open').click();await ready();
    check(await menus(true)&&!await pixels('historicalOverlay'),'selecting an existing reported correction also retains hidden historical marks');
    await page.screenshot({path:resolve(evidence,'new-finding-review.png')});
    check(errors.length===0,'all creation and selection paths finish without uncaught browser errors: '+errors.join('; '));
    return {name:'new-finding-visibility',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'new-finding-visibility-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'new-finding-visibility.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
