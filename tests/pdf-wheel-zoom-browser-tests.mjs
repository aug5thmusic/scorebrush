// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import {checkPageScrolling} from './pdf-page-scroll-browser-checks.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runPdfWheelZoom({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('pdf-wheel-zoom: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const painted=kind=>page.waitForFunction(kind=>document.querySelector('#'+kind+'Paper').getAttribute('aria-busy')==='false',kind);
  const model=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return JSON.stringify({review:s.review,returned:s.returned,revisionId:s.revisionId});});
  const view=kind=>page.evaluate(kind=>{const e=document.querySelector('#'+kind+'Scroll'),p=document.querySelector('#'+kind+'Paper').getBoundingClientRect();return {zoom:document.querySelector('#'+kind+'Zoom').value,page:document.querySelector('#'+kind+'Page').value,x:e.scrollLeft,y:e.scrollTop,width:p.width,height:p.height};},kind);
  const hover=async(kind,dx=160,dy=180)=>{const b=await page.locator('#'+kind+'Scroll').boundingBox(),point={x:b.x+Math.min(dx,b.width-35),y:b.y+Math.min(dy,b.height-35)};await page.mouse.move(point.x,point.y);return point;};
  const pointOnPage=(kind,point,base=612)=>page.locator('#'+kind+'Paper').evaluate((el,{point,base})=>{const b=el.getBoundingClientRect(),scale=b.width/base;return [(point.x-b.left)/scale,(point.y-b.top)/scale];},{point,base});
  const samePoint=(a,b)=>a.every((value,index)=>Math.abs(value-b[index])<1.5);
  const wheel=async(kind,delta=-100,{wait=true,point}={})=>{if(point)await page.mouse.move(point.x,point.y);else await hover(kind);await page.keyboard.down('Control');await page.mouse.wheel(0,delta);await page.keyboard.up('Control');if(wait){await page.waitForTimeout(40);await painted(kind);}};
  const zoom=async(kind,value)=>{await page.locator('#'+kind+'Zoom').selectOption(value);await painted(kind);};
  const delayRender=()=>page.evaluate(async()=>{const doc=(await import('./app.js')).completion.capture().doc,original=doc.getPage;window.zoomDoc=doc;window.zoomOriginalGetPage=original;window.zoomDelayStarted=false;const gate=new Promise(resolve=>window.releaseZoom=resolve);doc.getPage=async function(...args){if(!window.zoomDelayStarted){window.zoomDelayStarted=true;await gate;}return original.apply(this,args);};});
  const releaseRender=()=>page.evaluate(()=>{window.releaseZoom();window.zoomDoc.getPage=window.zoomOriginalGetPage;});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','multipage.pdf'],['renderedFile','multipage.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-wheel-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open'));await painted('source');await painted('rendered');
    check(await page.locator('#sourceZoom,#renderedZoom').evaluateAll(selects=>selects.every(select=>[...select.options].map(option=>option.textContent).join(',')==='Fit width,50%,75%,100%,125%,150%,200%,300%')),'both dropdowns expose Fit width and numeric PDF zoom steps from 50% through 300%');
    await checkPageScrolling({page,check,evidence,painted,view,model,hover,zoom,delayRender,releaseRender});
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC note: keep my focus and review bytes.');await page.locator('#comment').evaluate(el=>el.setSelectionRange(8,12));
    const originalModel=await model(),other=await view('rendered'),browserSize=await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale}));
    const fit=await view('source');await wheel('source',100);
    check((await view('source')).width<fit.width&&(await view('source')).zoom==='0.75','wheel-down from actual Fit width selects the nearest smaller level');
    check(JSON.stringify(await view('rendered'))===JSON.stringify(other),'hovered source zoom leaves rendered zoom and scroll unchanged');
    check(await page.locator('#comment').evaluate(el=>document.activeElement===el&&el.selectionStart===8&&el.selectionEnd===12),'Ctrl+wheel uses pointer location while preserving the note focus and caret');
    check(await model()===originalModel,'wheel zoom does not edit findings, notes, review identity or decisions');
    await zoom('source','1');await zoom('rendered','1');
    await page.locator('#sourceScroll').evaluate(el=>el.scrollTo(60,180));await page.waitForTimeout(50);
    const sourcePoint=await hover('source'),beforeSource=await pointOnPage('source',sourcePoint),renderedBefore=await view('rendered');await wheel('source',-100,{point:sourcePoint});
    check((await view('source')).zoom==='1.25'&&samePoint(beforeSource,await pointOnPage('source',sourcePoint)),'zoom-in keeps the source passage underneath the mouse');
    check(JSON.stringify(await view('rendered'))===JSON.stringify(renderedBefore),'source zoom never changes the rendered pane');
    await wheel('source',100,{point:sourcePoint});check((await view('source')).zoom==='1'&&samePoint(beforeSource,await pointOnPage('source',sourcePoint)),'zoom-out keeps the same source passage under the mouse');
    await page.locator('#sourceZoom').focus();await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(60,160));await page.waitForTimeout(50);
    const renderedPoint=await hover('rendered'),beforeRendered=await pointOnPage('rendered',renderedPoint),sourceBefore=await view('source');await wheel('rendered',-100,{point:renderedPoint});
    check((await view('rendered')).zoom==='1.25'&&samePoint(beforeRendered,await pointOnPage('rendered',renderedPoint)),'rendered zoom anchors under the pointer even when the other pane control owns focus');
    check(JSON.stringify(await view('source'))===JSON.stringify(sourceBefore),'rendered zoom leaves the source pane untouched');
    await zoom('rendered','2');await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(0,80));await hover('rendered');await page.mouse.wheel(0,160);await page.waitForTimeout(120);
    check((await view('rendered')).zoom==='2'&&(await view('rendered')).y>80,'ordinary mousewheel retains normal PDF scrolling without changing zoom');
    check(JSON.stringify(await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale})))===JSON.stringify(browserSize),'Ctrl+wheel over a PDF prevents browser page zoom');
    check(await page.locator('#renderedScroll').evaluate(el=>{const e=new WheelEvent('wheel',{ctrlKey:true,deltaY:100,bubbles:true,cancelable:true});el.dispatchEvent(e);return e.defaultPrevented;}),'PDF wheel events explicitly prevent the browser zoom default');await painted('rendered');
    check(await page.locator('header').evaluate(el=>{const e=new WheelEvent('wheel',{ctrlKey:true,deltaY:100,bubbles:true,cancelable:true});el.dispatchEvent(e);return !e.defaultPrevented;}),'Ctrl+wheel outside PDF panes keeps its normal browser behavior');
    for(const kind of ['source','rendered'])for(const [value,delta]of [['3',-100],['0.5',100]]){
      await zoom(kind,value);const untouched=await view(kind==='source'?'rendered':'source');await wheel(kind,delta);
      check((await view(kind)).zoom==='fit',kind+' zoom beyond '+Number(value)*100+'% returns to Fit width');
      check(JSON.stringify(await view(kind==='source'?'rendered':'source'))===JSON.stringify(untouched),'returning '+kind+' to Fit width leaves the other PDF unchanged');
    }
    await page.setViewportSize({width:900,height:768});await page.waitForTimeout(220);await zoom('source','fit');
    const narrowFit=await view('source');check(narrowFit.width/612<.5,'a narrow desktop pane can fit a PDF below the numeric 50% minimum');
    await wheel('source',100);await wheel('source',100);
    check((await view('source')).zoom==='fit'&&Math.abs((await view('source')).width-narrowFit.width)<1,'zoom-out from sub-50% Fit width stays fitted without jumping to a larger numeric level');
    await wheel('source',-100);check((await view('source')).zoom==='0.5','zoom-in from sub-50% Fit width enters the numeric range at 50%');
    await wheel('source',100);check((await view('source')).zoom==='fit','zoom-out from 50% returns to the smaller fitted scale');
    await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(220);await painted('source');await painted('rendered');
    await zoom('rendered','3');await delayRender();await wheel('rendered',-100,{wait:false});await page.waitForFunction(()=>window.zoomDelayStarted);await wheel('rendered',-100,{wait:false});await painted('rendered');await releaseRender();await page.waitForTimeout(80);
    check((await view('rendered')).zoom==='1','a rapid wheel step after returning to Fit width uses its pending fitted scale');
    await zoom('rendered','1');await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(40,120));await page.waitForTimeout(50);const burstPoint=await hover('rendered'),beforeBurst=await pointOnPage('rendered',burstPoint);
    await delayRender();await wheel('rendered',-100,{wait:false,point:burstPoint});await page.waitForFunction(()=>window.zoomDelayStarted);await wheel('rendered',-100,{wait:false,point:burstPoint});await wheel('rendered',-100,{wait:false,point:burstPoint});await painted('rendered');await releaseRender();await page.waitForTimeout(80);
    check((await view('rendered')).zoom==='2'&&samePoint(beforeBurst,await pointOnPage('rendered',burstPoint)),'rapid wheel input settles at its latest zoom and preserves its pointer anchor despite a delayed earlier render');
    await zoom('rendered','1.5');await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(40,100));await delayRender();await wheel('rendered',-100,{wait:false});await page.waitForFunction(()=>window.zoomDelayStarted);await page.mouse.wheel(0,140);await page.waitForTimeout(100);const latestScroll=(await view('rendered')).y;await releaseRender();await painted('rendered');
    check(Math.abs((await view('rendered')).y-latestScroll)<2,'later ordinary scrolling cancels a pending zoom anchor rather than snapping back');
    await zoom('rendered','1');await delayRender();await wheel('rendered',-100,{wait:false});await page.waitForFunction(()=>window.zoomDelayStarted);await page.locator('#renderedPage').fill('2');await page.locator('#renderedPage').blur();await painted('rendered');await releaseRender();await page.waitForTimeout(80);
    check((await view('rendered')).page==='2'&&(await view('rendered')).y===0,'a page change wins over a delayed wheel zoom and its old scroll anchor');
    check(await model()===originalModel,'zooming, bounds and delayed renders preserve the complete review data');
    await page.screenshot({path:resolve(evidence,'pdf-wheel-zoom.png')});
    await page.evaluate(async()=>{const a=await import('./app.js');await a.saveNow();window.zoomOriginalPut=a.operations.putSaved;a.operations.putSaved=async(...args)=>{await new Promise(resolve=>window.releaseZoomSave=resolve);return window.zoomOriginalPut(...args);};});
    await page.locator('#comment').fill('SYNTHETIC busy save for wheel protection.');await page.locator('#saveFinding').click();await page.waitForFunction(()=>Boolean(window.releaseZoomSave));
    const busyView=await view('rendered'),busyPoint=await hover('rendered');await wheel('rendered',-100,{wait:false,point:busyPoint});await page.waitForTimeout(80);
    check(JSON.stringify(await view('rendered'))===JSON.stringify(busyView)&&JSON.stringify(await page.evaluate(()=>({width:innerWidth,dpr:devicePixelRatio,scale:visualViewport.scale})))===JSON.stringify(browserSize),'Ctrl+wheel over an inert busy PDF changes neither PDF zoom nor browser zoom');
    check(await page.evaluate(point=>{const e=new WheelEvent('wheel',{ctrlKey:true,deltaY:-100,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true});document.body.dispatchEvent(e);return e.defaultPrevented;},busyPoint),'busy protection catches wheel events retargeted away from inert scrollers');
    await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.zoomOriginalPut;window.releaseZoomSave();});await page.waitForFunction(()=>!document.querySelector('main').inert);
    await delayRender();await wheel('rendered',-100,{wait:false});await page.waitForFunction(()=>window.zoomDelayStarted);
    await page.evaluate(async()=>{await (await import('./app.js')).saveNow();await (await import('./qa/comparison-fixture.js')).comparisonFixture();});await page.waitForFunction(()=>document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await painted('source');await painted('rendered');await releaseRender();await page.waitForTimeout(80);
    check(await page.locator('#statusControl').getAttribute('data-state')!=='attention','replacing a document discards a delayed wheel render without surfacing a stale failure');
    const comparisonModel=await model();await zoom('source','1');await zoom('rendered','1.5');await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(80,60));await page.waitForTimeout(50);
    const rotatedPoint=await hover('rendered',160,150),beforeRotated=await pointOnPage('rendered',rotatedPoint,740),beforePrevious=await view('source');await wheel('rendered',-100,{point:rotatedPoint});
    check((await view('rendered')).zoom==='2'&&samePoint(beforeRotated,await pointOnPage('rendered',rotatedPoint,740)),'cropped and rotated current PDFs retain the cursor passage during comparison zoom');
    check(JSON.stringify(await view('source'))===JSON.stringify(beforePrevious),'comparison zoom changes only the hovered current PDF');
    await wheel('source',-100);check((await view('source')).zoom==='1.25'&&(await view('rendered')).zoom==='2','the historical PDF also supports its own wheel zoom');
    check(await model()===comparisonModel,'comparison wheel zoom creates no decisions or saved locations');
    await zoom('rendered','3');await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(100,120));await page.waitForTimeout(250);
    check(await page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture(),position=(await import('./revision-views.js')).readRevisionView(s,'comparison-1');return position?.zoom===3&&!s.returned.locations?.['comparison-1'];}),'300% is automatically remembered separately from review records');
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await painted('rendered');
    const restored=await view('rendered');check(restored.zoom==='3'&&Math.abs(restored.x-100)<2&&Math.abs(restored.y-120)<2,'reopening the saved comparison restores its 300% bookmark and passage');
    await page.addInitScript(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('scorebrush-revision-view-v1:'))localStorage.removeItem(key);});
    for(const legacyZoom of [.25,4]){
      const legacyModel=await page.evaluate(async value=>{const a=await import('./app.js'),storage=await import('./storage.js'),s=a.completion.capture();await a.saveNow();const record=await storage.getSaved(s.workspaceId);record.returned.locations??={};record.returned.locations['comparison-1']=(await import('./comparison-model.js')).bookmark('comparison-1',s.review,{page:1,point:[100,120],zoom:value});await storage.putSaved(record,record.storageRevision);return JSON.stringify({review:record.review,returned:record.returned,revisionId:record.revisionId});},legacyZoom);
      await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await painted('rendered');
      check((await view('rendered')).zoom==='fit','a historical '+legacyZoom*100+'% comparison bookmark opens using Fit width');
      const persisted=await page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture(),record=await(await import('./storage.js')).getSaved(s.workspaceId);return {review:record.review,returned:record.returned,revisionId:record.revisionId};});
      assert.deepEqual(persisted,JSON.parse(legacyModel),'legacy bookmark restoration must preserve its stored review values');
      check(true,'restoring the historical '+legacyZoom*100+'% bookmark preserves its exact stored location, review and revision identity');
      const current=JSON.parse(await model()),expected=JSON.parse(legacyModel);
      check(JSON.stringify(current.returned)===JSON.stringify(expected.returned)&&current.revisionId===expected.revisionId,'the displayed historical '+legacyZoom*100+'% bookmark keeps the same comparison and revision identity');
    }
    check(errors.length===0,'wheel zoom produces no uncaught browser errors: '+errors.join('; '));
    return {name:'pdf-wheel-zoom',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'pdf-wheel-zoom-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'pdf-wheel-zoom.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
