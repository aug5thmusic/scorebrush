// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// HTML/native loading handoff contract. All contexts are disposable.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runStartupPaint({browser,serve,evidence,root}){
 const server=await serve(root),log=[];let assertions=0;
 const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('startup-paint: '+label);};
 const context=await browser.newContext();
 await context.addInitScript(()=>{
  window.startupPaintProbe={messages:[],frames:[]};
  window.chrome??={};window.chrome.webview={postMessage:message=>startupPaintProbe.messages.push(message),addEventListener(){}};
  window.scoreBrushNativeStartup={version:1,pixelScale:1};
  const raf=window.requestAnimationFrame.bind(window);window.startupPaintProbe.realRaf=raf;
  window.requestAnimationFrame=callback=>{startupPaintProbe.frames.push(callback);return startupPaintProbe.frames.length;};
 });
 const page=await context.newPage();let release;
 const gate=new Promise(resolve=>release=resolve);await page.route('**/app.js',async route=>{await gate;await route.continue();});
 try{
  await page.goto(server.url,{waitUntil:'commit'});
  await page.waitForFunction(()=>window.scoreBrushStartup&&window.startupPaintProbe.frames.length>0,null,{polling:20});
  const paints=()=>page.evaluate(()=>startupPaintProbe.messages.filter(m=>m.op==='startup-painted').length);
  check(await paints()===0,'parsing startup does not release the native splash');
  await page.evaluate(()=>startupPaintProbe.frames.shift()(performance.now()));
  check(await paints()===0,'the first animation callback still keeps the native splash');
  await page.evaluate(()=>startupPaintProbe.frames.shift()(performance.now()));
  check(await paints()===1,'a second frame acknowledges that HTML has had a paint opportunity');
  check(await page.locator('#startupScreen').isVisible()&&!await page.evaluate(()=>document.body.dataset.ready==='true'),'painting the loading screen does not mark the app ready');
  const style=await page.locator('#startupScreen').evaluate(el=>({background:getComputedStyle(el).backgroundColor,font:getComputedStyle(el).fontFamily}));
  check(style.background==='rgb(248, 247, 251)'&&style.font.includes('Segoe UI'),'loading retains the opaque native background and system font');
  await page.evaluate(()=>{window.dispatchEvent(new Event('scorebrush-desktop-host'));startupPaintProbe.frames.shift()(performance.now());startupPaintProbe.frames.shift()(performance.now());window.requestAnimationFrame=startupPaintProbe.realRaf;});
  check(await paints()===2,'a late desktop host receives a fresh painted-frame acknowledgement');
  release();await page.waitForLoadState('domcontentloaded');await page.unroute('**/app.js');await page.waitForFunction(()=>document.body.dataset.ready==='true',null,{polling:20});
  check(await page.locator('#startupScreen').isHidden()&&await page.locator('#workspaceDialog').isVisible(),'normal readiness still transitions to Welcome');
  await page.screenshot({path:resolve(evidence,'startup-paint-ready.png')});
  const failure=await context.newPage();await failure.route('**/app.js',route=>route.abort());await failure.goto(server.url,{waitUntil:'domcontentloaded'});
  await failure.waitForFunction(()=>window.scoreBrushStartup&&document.querySelector('#startupScreen').dataset.state==='error',null,{polling:20});
  await failure.evaluate(()=>{startupPaintProbe.frames.shift()(performance.now());startupPaintProbe.frames.shift()(performance.now());window.requestAnimationFrame=startupPaintProbe.realRaf;});
  check(await failure.evaluate(()=>startupPaintProbe.messages.some(m=>m.op==='startup-painted')&&!startupPaintProbe.messages.some(m=>m.op==='ready')),'module failure can reveal a painted error without falsely enabling native commands');
  check(await failure.locator('#startupScreen').isVisible()&&(await failure.locator('#startupError').innerText()).includes('complete ZIP'),'failed loading leaves the existing recovery instruction visible');
  await failure.screenshot({path:resolve(evidence,'startup-paint-error.png')});await failure.close();
  return {name:'startup-paint',assertions};
 }catch(error){log.push('FAIL '+error.stack);throw error;}
 finally{release();await writeFile(resolve(evidence,'startup-paint.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
