// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runUiPolish({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('ui-polish: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const painted=()=>page.waitForFunction(()=>document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false');
  const model=()=>page.evaluate(async()=>{const a=await import('./app.js');return JSON.stringify({review:a.completion.capture().review,revision:a.sessionStatus().revision});});
  const hover=async()=>{const paper=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox();const x=Math.max(paper.x,scroll.x)+90,y=Math.max(paper.y,scroll.y)+100;await page.mouse.move(x,y);return {x,y};};
  const preview=()=>page.locator('#brushPreview').evaluate(el=>({hidden:el.hidden,width:el.getBoundingClientRect().width,color:el.style.getPropertyValue('--brush-color'),events:getComputedStyle(el).pointerEvents,parent:el.parentElement.tagName}));
  const contrast=(selector='.workspace-maximize[aria-pressed=true]')=>page.locator(selector).evaluate(el=>{
    const luminance=value=>{const c=value.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];};
    const s=getComputedStyle(el),a=luminance(s.color),b=luminance(s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','multipage.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open'));await painted();
    check(await page.locator('#hide').getAttribute('aria-label')==='Hide marks'&&await page.locator('#toggleComments').innerText()==='Findings pane','mark visibility and the Findings pane have distinct names');
    check(await page.locator('#closeComments').getAttribute('aria-label')==='Collapse Findings pane'&&await page.locator('#closeComments svg path').getAttribute('d')!==await page.locator('#deleteFinding svg path').getAttribute('d'),'pane collapse has a distinct chevron while delete retains its X');
    for(const id of ['sourcePage','renderedPage']){
      await page.locator('#'+id).focus();check(await page.locator('#'+id).evaluate(el=>{const s=getComputedStyle(el),ctx=document.createElement('canvas').getContext('2d');ctx.font=s.font;return s.appearance==='textfield'&&el.clientWidth-parseFloat(s.paddingLeft)-parseFloat(s.paddingRight)>=ctx.measureText('888').width;}),id+' has room for three digits without built-in number spinners, including on focus');
    }
    await page.locator('#navigate').hover();check(await contrast('#navigate')>=4.5,'selected Navigate keeps readable white text on a dark background when hovered');
    await hover();check((await preview()).hidden,'Navigate mode has no drawing preview');
    await page.locator('#newFinding').click();await page.locator('#draw').hover();check(await contrast('#draw')>=4.5,'selected Draw also keeps readable text when hovered');await page.locator('#renderedZoom').selectOption('1');await painted();await page.locator('#autoColor').uncheck();await page.locator('#highlightColor').selectOption('#65d6a3');
    await page.locator('#brush').evaluate(el=>{el.value='12';el.dispatchEvent(new Event('input',{bubbles:true}));});
    const before=await model(),pixels=await page.locator('#overlay').evaluate(el=>el.toDataURL());await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);
    let p=await preview();check(Math.abs(p.width-12)<.1&&p.color==='#65d6a3','brush preview matches the actual width and color at 100%, including high-DPI screens');
    check(p.events==='none'&&p.parent==='BODY'&&await page.locator('#overlay').evaluate(el=>el.toDataURL())===pixels&&await model()===before,'hover preview intercepts no input and changes neither annotation pixels nor saved review data');
    await page.locator('#renderedZoom').selectOption('2');await painted();await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);
    check(Math.abs((await preview()).width-24)<.1,'brush preview scales with PDF zoom rather than device pixel ratio');
    await page.locator('#brush').evaluate(el=>{el.value='24';el.dispatchEvent(new Event('input',{bubbles:true}));});await page.waitForFunction(()=>Math.abs(document.querySelector('#brushPreview').getBoundingClientRect().width-48)<.1);
    check(Math.abs((await preview()).width-48)<.1,'changing brush width updates a stationary pointer preview');await page.screenshot({path:resolve(evidence,'brush-preview-desktop.png')});
    const point=await hover();await page.mouse.down();check((await preview()).hidden,'brush preview hides during contact so it does not obscure the real stroke');await page.mouse.move(point.x+35,point.y+8,{steps:4});await page.mouse.up();
    await page.waitForFunction(()=>document.querySelectorAll('#findings .finding').length===1);await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);
    check(await page.locator('#editTitle').innerText()==='Finding 1 · Page 1','active finding uses the compact page heading');
    const stroke=await page.evaluate(async()=>{const a=await import('./app.js');return a.completion.capture().review.findings[0].strokes[0];});check(stroke.width===24&&stroke.color==='#65d6a3','actual drawing still uses the width and color shown by the preview');
    await page.locator('#highlightColor').selectOption('#74b9ff');await page.locator('#autoColor').check();await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);check((await preview()).color==='#74b9ff','continuing an existing finding previews its actual color even when cycling is enabled');
    await page.locator('#hide').check();await hover();check((await preview()).hidden,'Hide marks also hides the brush preview');await page.locator('#hide').uncheck();
    await page.locator('#renderedPage').fill('2');await page.locator('#renderedPage').press('Enter');await page.locator('#renderedPage').blur();await painted();await hover();check((await preview()).hidden,'a finding cannot preview drawing on a different page');
    await page.locator('#renderedPage').fill('1');await page.locator('#renderedPage').blur();await painted();await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);
    await page.locator('#overlay').dispatchEvent('pointermove',{pointerType:'touch',pointerId:14,buttons:0,clientX:point.x,clientY:point.y});check((await preview()).hidden,'touch input does not leave a false hover cursor');
    await hover();await page.waitForFunction(()=>!document.querySelector('#brushPreview').hidden);await menuCommand(page,'File','files');check((await preview()).hidden,'opening a dialog clears the drawing preview');await page.locator('#closeWorkspace').click();
    await page.locator('#navigate').click();await hover();check((await preview()).hidden&&await page.locator('#overlay').evaluate(el=>getComputedStyle(el).cursor)==='grab','leaving Draw restores the normal navigation cursor');
    await page.locator('#saveFinding').click();
    for(const kind of ['source','rendered']){
      await page.locator('#'+kind+'Maximize').click();await page.waitForFunction(kind=>document.body.dataset.workspaceMax===kind,kind);await page.mouse.move(100,30);
      check(await contrast()>=3,kind+' maximize icon remains visible in its selected state');await page.locator('#'+kind+'Maximize').hover();check(await contrast()>=3,kind+' selected maximize icon remains visible on hover');await page.locator('#'+kind+'Maximize').click();
    }
    await page.setViewportSize({width:1024,height:768});await page.locator('.finding-open').first().click();await painted();
    check(await page.locator('#editor').evaluate(el=>el.scrollWidth<=el.clientWidth)&&await page.locator('#editTitle').evaluate(el=>el.getBoundingClientRect().y===el.parentElement.querySelector('.finding-type').getBoundingClientRect().y||Math.abs(el.getBoundingClientRect().top-el.parentElement.querySelector('.finding-type').getBoundingClientRect().top)<12),'compact title and type stay in one usable tablet editor header');
    check(await page.locator('.finding-meta').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=11),'finding metadata remains legible at the compact size');await page.screenshot({path:resolve(evidence,'ui-polish-tablet.png')});
    check(errors.length===0,'visual refinements produce no uncaught browser errors: '+errors.join('; '));
    return {name:'ui-polish',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'ui-polish-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'ui-polish.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
