// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runRevisionViews({browser,serve,evidence,root}){
 const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
 const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('revision-views: '+label);};page.on('pageerror',e=>errors.push(e.message));
 async function ready(){for(let n=0;n<500;n++){if(await page.evaluate(async()=>{const a=await import('./app.js');return document.body.dataset.ready==='true'&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true');}))return;await page.waitForTimeout(50);}throw Error('View not ready');}
 const state=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),r=await(await import('./storage.js')).getSaved(s.workspaceId);return {workspaceId:s.workspaceId,review:s.review,returned:s.returned,revisionId:s.revisionId,storageRevision:r.storageRevision};});
 const go=async id=>{await page.evaluate(async id=>(await import('./app.js')).corrections.selectFinding(id),id);await ready();};
 const open=async id=>{await page.evaluate(async id=>(await import('./app.js')).handoff.returnedUI.open(await(await import('./handoff-store.js')).retained(id)),id);await ready();};
 const view=()=>page.evaluate(()=>({page:document.querySelector('#renderedPage').value,zoom:document.querySelector('#renderedZoom').value,x:document.querySelector('#renderedScroll').scrollLeft,y:document.querySelector('#renderedScroll').scrollTop}));
 const equal=(a,b)=>a.page===b.page&&a.zoom===b.zoom&&Math.abs(a.x-b.x)<2&&Math.abs(a.y-b.y)<2;
 try{
  await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();
  const fixture=await page.evaluate(async()=>{const f=await import('./qa/comparison-fixture.js'),ids=await f.comparisonFixture({sourcePdf:'multipage.pdf'});await f.manyProblemsFixture(ids.issuedId);return ids;});await ready();
  const original=await state(),positions={};
  const leftPage=async number=>{await page.locator('#sourcePage').fill(String(number));await page.locator('#sourcePage').press('Tab');await ready();};
  await leftPage(3);await page.locator('#sourceZoom').selectOption('2');await ready();await page.locator('#sourceScroll').evaluate(el=>el.scrollTo(80,230));
  const beforeLeft=await page.locator('#sourceScroll').evaluate(el=>({x:el.scrollLeft,y:el.scrollTop}));
  await page.locator('#checkPrintedSource').click();await ready();
  check(await page.locator('#sourcePage').inputValue()==='3'&&await page.locator('#sourceCount').innerText()==='/ 4','source opens at the numeric page of the replaced comparison pane, not page 1');
  await leftPage(1);await page.locator('#checkPrintedSource').click();await ready();
  log.push('SOURCE RETURN '+JSON.stringify({beforeLeft,after:await page.locator('#sourceScroll').evaluate(el=>({x:el.scrollLeft,y:el.scrollTop,page:document.querySelector('#sourcePage').value,zoom:document.querySelector('#sourceZoom').value}))}));
  check(await page.locator('#sourcePage').inputValue()==='3'&&await page.locator('#sourceZoom').inputValue()==='2'&&await page.locator('#sourceScroll').evaluate((el,p)=>Math.abs(el.scrollTop-p.y)<2&&Math.abs(el.scrollLeft-p.x)<2,beforeLeft),'Back to correction restores page, zoom and scroll after source navigation');
  await leftPage(2);await page.locator('#checkPrintedSource').click();await ready();
  check(await page.locator('#sourcePage').inputValue()==='2','every explicit source check ignores the hidden remembered source page');
  await leftPage(4);await page.locator('#checkPrintedSource').click();await ready();
  check(await page.locator('#sourcePage').inputValue()==='2','repeated toggling restores the most recent comparison page');
  check(JSON.stringify(await state())===JSON.stringify(original),'source checks preserve exact revisions, associations, decisions and local history');

  await page.evaluate(async()=>(await import('./app.js')).applicationShell.execute('scroll-pages'));
  await leftPage(1);await page.locator('#sourceZoom').selectOption('0.5');await page.locator('#renderedZoom').selectOption('0.5');await page.locator('#renderedPage').fill('2');await page.locator('#renderedPage').dispatchEvent('change');await ready();await page.waitForTimeout(380);
  const wheelTurn=async(kind,deltaY)=>{await page.locator('#'+kind+'Scroll').evaluate((el,deltaY)=>el.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY})),deltaY);await ready();};
  const historyHash=await page.locator('#sourceViewer').getAttribute('data-render-sha256'),selected=await page.evaluate(async()=>(await import('./app.js')).corrections.state().findingId);
  await wheelTurn('source',100);check(await page.locator('#sourcePage').inputValue()==='2'&&await page.locator('#sourceViewer').getAttribute('data-render-sha256')===historyHash,'wheel turns the historical PDF without replacing its exact rendering identity');
  await wheelTurn('rendered',100);await page.waitForTimeout(220);
  check((await view()).page==='3'&&await page.evaluate(async id=>(await import('./app.js')).corrections.state().findingId===id,selected),'current PDF wheel turns preserve the selected correction and queue');
  await go('large-problem-50');await go(selected);
  check((await view()).page==='3','wheel page is remembered through the existing per-revision view preference');
  check(JSON.stringify(await state())===JSON.stringify(original),'historical and current wheel turns create no decision, training event, revision or local review save');
  await page.evaluate(async()=>(await import('./app.js')).applicationShell.execute('scroll-pages'));

  for(const [id,number,zoom,x,y] of [['large-problem-1','4','2',130,350],['large-problem-50','2','3',270,540],['large-problem-100','3','1.5',90,210]]){
   await go(id);await page.locator('#renderedPage').fill(number);await page.locator('#renderedPage').dispatchEvent('change');await ready();await page.locator('#renderedZoom').selectOption(zoom);await ready();await page.locator('#renderedScroll').evaluate((el,p)=>el.scrollTo(...p),[x,y]);positions[id]=await view();
  }
  for(const [id,position] of Object.entries(positions)){await go(id);check(equal(await view(),position),id+' restores its own last page, zoom and scroll');}
  check(JSON.stringify(await state())===JSON.stringify(original),'navigation adds no review save, history revision, annotation or approval');
  await page.reload();await ready();for(const [id,position] of Object.entries(positions)){await go(id);check(equal(await view(),position),id+' restores after restart');}
  await open(fixture.entryId);check((await view()).page==='1'&&(await view()).zoom==='fit','a new one-page PDF inherits no old pagination or zoom');
  await open(original.returned.responseId);await go('large-problem-50');check(equal(await view(),positions['large-problem-50']),'returning to the earlier exact revision recovers its preference');
  const failureBefore=await state();await page.evaluate(()=>{window.originalPreferenceWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('scorebrush-revision-view-v1:'))throw Error('SYNTHETIC full preference storage');return window.originalPreferenceWrite.call(this,k,v);};});
  await page.locator('#renderedZoom').selectOption('2');await ready();await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(50,160));const unsaved=await view();await go('large-problem-1');await go('large-problem-50');
  check(equal(await view(),unsaved),'unavailable preference storage keeps the current-session view without blocking navigation');
  check(JSON.stringify(await state())===JSON.stringify(failureBefore),'preference storage failure still changes no review state or decisions');
  await page.evaluate(()=>Storage.prototype.setItem=window.originalPreferenceWrite);
  await go('large-problem-1');await page.locator('#renderedPage').fill('2');await page.locator('#renderedPage').dispatchEvent('change');await ready();
  await page.locator('#reportAnotherError').click();await page.locator('#findingType').selectOption('comment');await page.locator('#comment').fill('SYNTHETIC unrelated page 2 comment');await page.locator('#saveFinding').click();await ready();
  const noteId=await page.evaluate(async()=>(await import('./app.js')).completion.capture().review.findings.find(f=>f.comment==='SYNTHETIC unrelated page 2 comment').id);
  await go('large-problem-1');await page.locator('#renderedPage').fill('4');await page.locator('#renderedPage').dispatchEvent('change');await ready();await page.locator('#renderedZoom').selectOption('2');await ready();await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(130,350));
  const correctionView=await view(),beforeNote=await state();
  // Switch immediately, before the debounced preference write fires.
  if(!await page.locator('#commentsPanel').isVisible())await page.locator('#comparisonFindings').click();await page.locator(`[data-finding-id="${noteId}"] .finding-open`).click();await ready();await page.waitForTimeout(200);
  check((await view()).page==='2','an unrelated note opens its own page');
  await page.evaluate(async()=>(await import('./app.js')).corrections.rememberView());
  const savedView=()=>page.evaluate(async()=>{const a=await import('./app.js');return (await import('./revision-views.js')).readRevisionView(a.completion.capture(),'large-problem-1');});
  check((await savedView()).page===4,'note selection flushes the correction view before navigation and pauses delayed/closing writes');
  await page.locator('#renderedPage').fill('3');await page.locator('#renderedPage').dispatchEvent('change');await ready();await page.locator('#saveFinding').click();await ready();await page.waitForTimeout(200);await page.evaluate(async()=>(await import('./app.js')).corrections.rememberView());
  check((await savedView()).page===4,'saving a note does not resume memory for the previous correction');
  await go('large-problem-1');check(equal(await view(),correctionView),'returning to the correction restores its page, zoom and scroll instead of the unrelated note');
  check(JSON.stringify(await state())===JSON.stringify(beforeNote),'opening and closing another note changes no decisions, revision identities or review history');
  if(!await page.locator('#commentsPanel').isVisible())await page.locator('#comparisonFindings').click();await page.locator(`[data-finding-id="${noteId}"] .finding-open`).click();await ready();await page.reload();await ready();await go('large-problem-1');
  check(equal(await view(),correctionView),'restart while viewing a note preserves the correction’s remembered position');
  await page.locator('#renderedPage').fill('3');await page.locator('#renderedPage').dispatchEvent('change');await ready();await go('large-problem-50');await go('large-problem-1');check((await view()).page==='3','memory resumes after explicitly selecting the correction');
  check(await page.locator('#correctionLocationStatus,#correctionAlignment,#locateCorrectedPassage,#correctionFilesButton,#correctionFiles,#renderedViewOptions').count()===0,'obsolete passage dialog, status and remember action are absent');
  await page.locator('#appMenuView').click();check(!/Brush & color|Current passage/.test(await page.locator('#menuView').innerText()),'View contains no toolbar-focus or passage-management commands');await page.keyboard.press('Escape');
  for(const [width,height] of [[1440,900],[900,620],[590,362],[390,844]]){
   await page.setViewportSize({width,height});await ready();check(await page.locator('#locateRegion').isVisible()&&await page.locator('#locateRegion').evaluate(el=>{const r=el.getBoundingClientRect();return el.closest('.correction-copy')&&r.right<=innerWidth&&r.bottom<=innerHeight;}),`Add note is beside the selected finding at ${width} × ${height}`);await page.screenshot({path:resolve(evidence,`revision-views-${width}.png`)});
  }
  check(errors.length===0,'no uncaught browser errors: '+errors.join('; '));return {name:'revision-views',assertions};
 }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'revision-views-failure.png')});throw error;}
 finally{await writeFile(resolve(evidence,'revision-views.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
