// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Browser DPR simulation complements, but does not replace, the native probe.
export async function runStartupTypography({browser,serve,evidence,root}){
  const server=await serve(root),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('startup-typography: '+label);};
  try{
    for(const [scale,fonts] of [[1,'normal'],[1,'delayed'],[1,'failed'],[1.25,'delayed'],[1.5,'delayed'],[1.75,'failed'],[2,'normal'],[2,'delayed'],[2,'failed']]){
      const context=await browser.newContext({viewport:{width:1280,height:900},deviceScaleFactor:scale}),page=await context.newPage(),label=`${scale*100}-${fonts}`;
      let releaseModule,releaseFonts,requested;
      const moduleGate=new Promise(r=>releaseModule=r),fontGate=new Promise(r=>releaseFonts=r),moduleSeen=new Promise(r=>requested=r);
      page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.addInitScript(()=>window.scoreBrushNativeStartup=Object.freeze({version:1,pixelScale:1}));
        await page.route('**/app.js',async route=>{requested();await moduleGate;await route.continue();});
        if(fonts!=='normal')await page.route('**/vendor/fonts/*.woff2',async route=>{if(fonts==='failed')await route.abort();else{await fontGate;await route.continue();}});
        const navigation=page.goto(server.url);await moduleSeen;
        await page.waitForFunction(()=>document.querySelector('.startup-wordmark')?.complete&&document.querySelector('[data-build-info]').textContent.startsWith('Version '));
        const metrics=()=>page.evaluate(()=>{
          const box=selector=>{const el=document.querySelector(selector),s=getComputedStyle(el),r=el.getBoundingClientRect();return {family:s.fontFamily,size:s.fontSize,weight:s.fontWeight,lineHeight:s.lineHeight,x:r.x,y:r.y,width:r.width,height:r.height};};
          return {dpr:devicePixelRatio,content:box('.startup-content'),status:box('#startupStatus'),version:box('#startupScreen [data-build-info]'),wordmark:box('.startup-wordmark')};
        });
        const before=await metrics();
        check(before.status.family.includes('Segoe UI')&&before.status.size==='13.3333px'&&before.status.weight==='400'&&before.status.lineHeight==='18px'&&before.version.size==='11px'&&before.version.lineHeight==='15px',label+' uses native loading type metrics');
        check(Math.abs(before.content.width*scale-620)<1&&Math.abs(before.content.height*scale-440)<1&&Math.abs(before.wordmark.height*scale-74)<1,label+' compensates only the loading composition for device scale');
        releaseFonts();await page.evaluate(()=>document.fonts.ready);
        if(fonts==='failed')check(await page.evaluate(()=>[...document.fonts].some(face=>face.status==='error')),label+' confirms font failure was actually exercised');
        check(JSON.stringify(await metrics())===JSON.stringify(before),label+' has no loading font or placement jump after fonts settle');
        await writeFile(resolve(evidence,`startup-${label}.json`),JSON.stringify(before,null,2));
        if(scale===1||scale===2)await page.screenshot({path:resolve(evidence,`startup-${label}.png`)});
        releaseModule();await navigation;await page.waitForFunction(()=>document.body.dataset.ready==='true');
        check(await page.locator('#startupScreen').isHidden()&&await page.locator('.welcome-steps li').count()===4&&await page.locator('.welcome-name').innerText()==='ScoreBrush'&&await page.locator('.welcome-name img').count()===0,label+' reaches Welcome with its existing text wordmark and no opaque image background');
        if(fonts==='failed')await page.screenshot({path:resolve(evidence,`welcome-${label}.png`)});
      }finally{releaseModule?.();releaseFonts?.();await context.close();}
    }
    check(errors.length===0,'no uncaught startup errors: '+errors.join('; '));return {name:'startup-typography',assertions};
  }catch(error){log.push('FAIL '+error.stack);throw error;}finally{await writeFile(resolve(evidence,'startup-typography.txt'),log.join('\n')+'\n');await server.close();}
}
