// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

// Called by the supported pdf-wheel-zoom suite on its disposable multipage PDFs.
export async function checkPageScrolling({page,check,evidence,painted,view,model,hover,zoom,delayRender,releaseRender}){
  const idle=()=>page.waitForTimeout(380);
  const go=async(kind,number)=>{await page.locator('#'+kind+'Page').fill(String(number));await page.locator('#'+kind+'Page').dispatchEvent('change');await painted(kind);};
  const emit=(kind,deltas)=>page.locator('#'+kind+'Scroll').evaluate((el,deltas)=>deltas.map(delta=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:64,...delta});el.dispatchEvent(e);return e.defaultPrevented;}),deltas);
  const saved=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),record=await a.operations.getSaved(s.workspaceId);return JSON.stringify({review:record.review,returned:record.returned,revisionId:record.revisionId,storageRevision:record.storageRevision});});
  await page.evaluate(async()=>{const a=await import('./app.js');await a.saveNow();window.pageScrollWrites=0;window.pageScrollChanges=0;window.pageScrollOriginalPut=a.operations.putSaved;a.operations.putSaved=(...args)=>{window.pageScrollWrites++;return window.pageScrollOriginalPut(...args);};document.addEventListener('score-desk-change',()=>window.pageScrollChanges++);});
  const before=await model(),beforeSaved=await saved();
  check(await page.evaluate(async()=>!(await import('./app.js')).applicationShell.states()['scroll-pages'].checked),'Scroll between pages defaults off');
  await zoom('source','0.5');await idle();await hover('source');await page.mouse.wheel(0,120);await page.waitForTimeout(80);
  check((await view('source')).page==='1','disabled preference leaves a fully visible page unchanged');
  await menuCommand(page,'View','scroll-pages');await page.locator('#appMenuView').click();
  check(await page.locator('[data-command=scroll-pages]').getAttribute('role')==='menuitemcheckbox'&&await page.locator('[data-command=scroll-pages]').getAttribute('aria-checked')==='true','View exposes a checked accessible Scroll between pages item');
  await page.screenshot({path:resolve(evidence,'scroll-between-pages-menu.png')});await page.keyboard.press('Escape');
  for(const kind of ['source','rendered']){
    await zoom(kind,'0.5');await go(kind,2);await idle();
    const otherKind=kind==='source'?'rendered':'source',other=await view(otherKind);
    check(await page.locator('#'+kind+'Scroll').evaluate(el=>el.scrollHeight<=el.clientHeight+2),kind+' synthetic page is fully visible');
    await hover(kind);await page.mouse.wheel(0,120);await page.waitForTimeout(60);await painted(kind);
    check((await view(kind)).page==='3'&&(await view(kind)).y===0,kind+' ordinary wheel turns a visible page forward to its top');
    check(JSON.stringify(await view(otherKind))===JSON.stringify(other),kind+' wheel changes only its hovered pane');
    await emit(kind,Array.from({length:20},()=>({deltaY:90})));await page.waitForTimeout(50);
    check((await view(kind)).page==='3',kind+' momentum cannot skip another page');
    await idle();await emit(kind,[{deltaY:-1,deltaMode:2}]);await painted(kind);
    check((await view(kind)).page==='2',kind+' page-mode input turns backward');
    await zoom(kind,'2');await go(kind,2);await page.locator('#'+kind+'Scroll').evaluate(el=>el.scrollTop=200);await idle();await hover(kind);await page.mouse.wheel(0,130);await page.waitForTimeout(80);
    check((await view(kind)).page==='2'&&(await view(kind)).y>200,kind+' tall page scrolls normally within the page');
    await page.locator('#'+kind+'Scroll').evaluate(el=>el.scrollTop=el.scrollHeight);await emit(kind,[{deltaY:800}]);
    check((await view(kind)).page==='2',kind+' gesture tail reaching the bottom never turns');
    await idle();await emit(kind,[{deltaY:4,deltaMode:1}]);await painted(kind);
    check((await view(kind)).page==='3'&&(await view(kind)).y===0,kind+' fresh line-mode input at bottom turns forward to top');
    await idle();await emit(kind,[{deltaY:-64}]);await painted(kind);
    check((await view(kind)).page==='2'&&await page.locator('#'+kind+'Scroll').evaluate(el=>Math.abs(el.scrollTop-(el.scrollHeight-el.clientHeight))<2),kind+' backward navigation lands at the previous tall page bottom');
  }
  await zoom('rendered','0.5');await go('rendered',2);await idle();
  await emit('rendered',Array.from({length:100},()=>({deltaY:.8})));check((await view('rendered')).page==='2','small jitter never accumulates into a turn');
  await idle();await emit('rendered',[{deltaX:120,deltaY:20},{deltaY:200}]);check((await view('rendered')).page==='2','horizontal gesture cannot turn through its vertical tail');
  await idle();await emit('rendered',[{deltaY:40},{deltaY:-90},{deltaY:-90}]);check((await view('rendered')).page==='2','direction reversal needs an idle boundary');
  await idle();await emit('rendered',Array.from({length:8},()=>({deltaY:8})));await painted('rendered');check((await view('rendered')).page==='3','precision deltas accumulate into one deliberate turn');
  for(const [number,deltaY]of [[1,-300],[4,300]]){await go('rendered',number);await idle();await emit('rendered',[{deltaY}]);check((await view('rendered')).page===String(number),'document boundary at page '+number+' does not wrap');}
  await go('rendered',2);await idle();await menuCommand(page,'Help','shortcuts');const modalFocus=await page.evaluate(()=>document.activeElement.id);await emit('rendered',[{deltaY:100}]);
  check((await view('rendered')).page==='2'&&await page.locator('#shortcutsDialog').isVisible()&&await page.evaluate(id=>document.activeElement.id===id,modalFocus),'a modal suppresses page turns without changing dialog focus');await page.locator('#closeShortcuts').click();
  await idle();await page.locator('#renderedScroll').evaluate(el=>{const input=document.createElement('input');el.append(input);input.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:100}));input.remove();});check((await view('rendered')).page==='2','wheel over a form control inside the pane cannot turn');
  for(const modifier of ['shiftKey','altKey','metaKey']){await idle();await emit('rendered',[{deltaY:100,[modifier]:true}]);check((await view('rendered')).page==='2',modifier+' wheel does not turn pages');}
  await idle();await page.evaluate(()=>document.body.inert=true);await emit('rendered',[{deltaY:100}]);check((await view('rendered')).page==='2','inert guarded-close interface cannot turn pages');await page.evaluate(()=>document.body.inert=false);
  await delayRender();await page.locator('#renderedZoom').selectOption('0.75');await page.waitForFunction(()=>window.zoomDelayStarted);await idle();await emit('rendered',[{deltaY:100}]);
  check((await view('rendered')).page==='2','a pending non-wheel page render suppresses page turns');await releaseRender();await painted('rendered');await zoom('rendered','0.5');
  await page.locator('#draw').click();await idle();await hover('rendered',100,80);await page.mouse.down();
  await emit('rendered',[{deltaY:100}]);
  check((await view('rendered')).page==='2'&&await page.evaluate(async()=>(await import('./app.js')).sessionStatus().gesture),'wheel leaves an in-progress drawing and its page intact');
  await page.locator('#overlay').dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();await page.locator('#navigate').click();
  await idle();await delayRender();await emit('rendered',[{deltaY:100}]);await page.waitForFunction(()=>window.zoomDelayStarted);
  for(let i=0;i<3;i++){await page.waitForTimeout(270);await emit('rendered',[{deltaY:150}]);}
  check((await view('rendered')).page==='3','slow rendering serializes wheel turns even across idle gaps');await releaseRender();await painted('rendered');
  await emit('rendered',[{deltaY:150}]);check((await view('rendered')).page==='3','render completion still requires a new gesture and cooldown');
  await idle();await emit('rendered',[{deltaY:-100}]);await painted('rendered');check((await view('rendered')).page==='2','a fresh gesture works after the slow render settles');
  // Start another wheel render, then supersede it with explicit page navigation.
  await idle();await delayRender();await emit('rendered',[{deltaY:-100}]);await page.waitForFunction(()=>window.zoomDelayStarted);await go('rendered',4);await releaseRender();await page.waitForTimeout(60);
  check((await view('rendered')).page==='4'&&(await view('rendered')).y===0,'a superseded wheel render cannot reposition an explicit later page');
  await menuCommand(page,'View','scroll-pages');await idle();await go('rendered',2);await emit('rendered',[{deltaY:100}]);check((await view('rendered')).page==='2','turning the preference off immediately restores ordinary wheel behavior');
  check(await model()===before&&await saved()===beforeSaved&&await page.evaluate(()=>window.pageScrollWrites===0&&window.pageScrollChanges===0),'page turns and preference changes produce zero review saves or substantive change events and preserve exact durable data');
  await page.evaluate(async()=>(await import('./app.js')).operations.putSaved=window.pageScrollOriginalPut);
  await menuCommand(page,'View','scroll-pages');await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await painted('source');await painted('rendered');
  check(await page.evaluate(async()=>(await import('./app.js')).applicationShell.states()['scroll-pages'].checked),'enabled interface preference persists across reopening the saved project');
  await menuCommand(page,'View','scroll-pages');await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await painted('source');await painted('rendered');
  check(await page.evaluate(async()=>!(await import('./app.js')).applicationShell.states()['scroll-pages'].checked),'disabled interface preference also persists');
  // Leave enabled for the suite's Ctrl+wheel, focus, slow zoom and comparison checks.
  await menuCommand(page,'View','scroll-pages');await idle();
}
