// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runBranding({browser,serve,evidence,root}){
  const server=await serve(root),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('branding: '+label);};
  try{
    // Browser device-pixel-ratio coverage; actual Windows shell scaling remains
    // a separate final-build check. Every context and PDF is disposable.
    for(const scale of [1,1.25,1.5,1.75,2]){
      const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:scale}),page=await context.newPage();
      page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(()=>document.fonts.ready);
        await page.waitForFunction(()=>[...document.querySelectorAll('.welcome-step-icon,.welcome-app-icon')].every(img=>img.complete&&img.naturalWidth>0));
        const label=`${scale*100}%`;
        check(await page.locator('.welcome-version').evaluate(el=>{const version=el.getBoundingClientRect();return document.querySelector('.welcome-actions').getBoundingClientRect().bottom<=document.querySelector('#welcomeWorkflowHeading').getBoundingClientRect().top&&version.top>=document.querySelector('.welcome-steps').getBoundingClientRect().bottom;}),'Welcome actions sit above How it works and version stays below the workflow at '+label);
        check(await page.evaluate(()=>{const heading=document.querySelector('#welcomeWorkflowHeading').getBoundingClientRect(),first=document.querySelector('.welcome-first').getBoundingClientRect(),next=document.querySelector('.welcome-steps li:nth-child(2)').getBoundingClientRect();return first.top-heading.bottom<=5&&next.top-first.bottom<=9;}),'Welcome has reduced spacing below How it works and after step 1 at '+label);
        check(await page.locator('.welcome-name').innerText()==='ScoreBrush'&&await page.locator('.welcome-name').evaluate(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)')&&await page.locator('.welcome-name img').count()===0,'Welcome text wordmark has no image background at '+label);
        check(await page.evaluate(()=>{
          const icon=document.querySelector('.welcome-app-icon').getBoundingClientRect(),text=document.querySelector('.welcome-brand-text').getBoundingClientRect(),heading=document.querySelector('#welcomeWorkflowHeading').getBoundingClientRect(),list=document.querySelector('.welcome-steps').getBoundingClientRect(),actions=document.querySelector('.welcome-actions').getBoundingClientRect();
          return Math.abs(icon.y+icon.height/2-text.y-text.height/2)<1&&text.left>icon.right&&Math.abs(heading.x+heading.width/2-list.x-list.width/2)<1&&Math.abs(actions.x+actions.width/2-list.x-list.width/2)<1;
        }),'branding block and workflow/actions are centered at '+label);
        check(await page.locator('.welcome-step-number').allTextContents().then(n=>n.join(',')==='1,2,3,4')&&await page.locator('.welcome-step-number').evaluateAll(els=>els.every(el=>getComputedStyle(el).backgroundColor==='rgb(221, 217, 251)'))&&await page.locator('.welcome-steps li').evaluateAll(els=>els.every(el=>getComputedStyle(el).backgroundColor==='rgba(0, 0, 0, 0)')),'only the four numbered circles have light indigo backgrounds at '+label);
        await page.locator('#chooseFolderInSetup').focus();await page.keyboard.press('Tab');check(await page.locator('#welcomeRecover').evaluate(el=>el===document.activeElement),'keyboard moves New Project to Open Project at '+label);
        await page.keyboard.press('Tab');check(await page.locator('#welcomeRestore').evaluate(el=>el===document.activeElement),'keyboard next reaches Restore Backup at '+label);
        await page.keyboard.press('Shift+Tab');check(await page.locator('#welcomeRecover').evaluate(el=>el===document.activeElement),'reverse keyboard order returns to Open Project at '+label);
        check(await page.locator('#welcomeHeading').innerText()==='the AI music transcription workspace'&&await page.locator('#workspaceWelcome').count()===0, 'Welcome uses the new heading with no old subtitle at '+label);
        check(await page.locator('.welcome-step-icon').evaluateAll(images=>images.map(img=>img.getAttribute('src')).join('|')==='branding/proofread.svg|branding/send-to-ai.svg|branding/review-changes.svg'&&images.every(img=>getComputedStyle(img).objectFit==='contain')),'approved SVGs load with preserved proportions at '+label);
        for(const [width,height] of [[1440,900],[1024,768],[900,560],[590,362],[360,640]]){
          await page.setViewportSize({width,height});
          check(await page.locator('#workspaceDialog').evaluate(el=>{const b=el.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight+1&&el.scrollWidth<=el.clientWidth;}),`Welcome stays within ${width}×${height} at ${label}`);
          if((scale===1||scale===2)&&width<=590){await page.locator('#workspaceDialog').evaluate(el=>el.scrollTop=0);await page.screenshot({path:resolve(evidence,`branding-welcome-${width}-${scale}-top.png`)});}
          await page.locator('#welcomeRestore').scrollIntoViewIfNeeded();check(await page.locator('#welcomeRestore').isVisible(),`Welcome actions remain reachable at ${width}×${height}, ${label}`);
          if(scale===1||scale===2)await page.screenshot({path:resolve(evidence,`branding-welcome-${width}-${scale}.png`)});
        }
        await page.setViewportSize({width:900,height:650});
        await page.evaluate(()=>document.documentElement.style.fontSize=(parseFloat(getComputedStyle(document.documentElement).fontSize)*2)+'px');
        check(await page.locator('#workspaceDialog').evaluate(el=>el.scrollWidth<=el.clientWidth)&&await page.locator('.welcome-steps li').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth)),'200% text keeps step text within the dialog at '+label);
        await page.locator('#welcomeRestore').scrollIntoViewIfNeeded();await page.locator('#welcomeRestore').click({trial:true});
        if(scale===1||scale===2)await page.screenshot({path:resolve(evidence,`branding-welcome-large-text-${scale}.png`)});
        await page.evaluate(()=>document.documentElement.style.fontSize='');await page.setViewportSize({width:1440,height:900});
        check((await page.locator('.welcome-steps li').nth(2).locator('p').innerText())==='Send the marked-up score to your AI with a pre-written prompt.','Send to AI has no own-AI parenthetical at '+label);
        const build=await page.evaluate(async()=>await(await fetch('./build-info.json')).json());
        check(await page.locator('[data-build-info]').evaluateAll((els,text)=>els.every(el=>el.textContent===text),`Version ${build.version} (${build.buildDate})`),'all web version notices use metadata and requested format at '+label);
        await page.locator('#closeWorkspace').click();await menuCommand(page,'Help','about');
        check(await page.locator('#aboutDialog a').count()===1&&await page.locator('#sourceLink').getAttribute('href')==='https://github.com/aug5thmusic/scorebrush'&&(await page.locator('#aboutLicense').innerText()).includes('Auggie (@aug5thmusic)'),'About shows the official source link and copyright attribution at '+label);
        check((await page.locator('#aboutLicense').innerText()).includes('AGPLv3 or later'),'About identifies the license and warranty at '+label);
        if(scale===1){
          await context.setOffline(true);
          await page.locator('.legal-notice summary').nth(1).click();
          check((await page.locator('.legal-notice pre').nth(1).innerText()).includes('13. Remote Network Interaction'),'full AGPL is readable offline');
          await page.setViewportSize({width:360,height:640});
          check(await page.locator('#aboutDialog').evaluate(el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1&&b.top>=0&&b.bottom<=innerHeight+1&&el.scrollWidth<=el.clientWidth;}),'expanded license stays inside a narrow viewport');
          await page.screenshot({path:resolve(evidence,'branding-license-offline-narrow.png')});
          await page.locator('.legal-notice summary').nth(1).click();
          await page.setViewportSize({width:1440,height:900});
          await context.setOffline(false);
        }
        if(scale===1){
          const repositoryRequests=[];await context.route('https://github.com/**',route=>{repositoryRequests.push(route.request().url());return route.fulfill({status:200,body:'Synthetic repository destination'});});
          const repositoryPopup=page.waitForEvent('popup');await page.locator('#sourceLink').click();const repositoryTab=await repositoryPopup;await repositoryTab.waitForLoadState();
          check(repositoryRequests[0]==='https://github.com/aug5thmusic/scorebrush'&&page.url()===server.url,'repository link opens only the official repository separately');await repositoryTab.close();
        }
        await page.screenshot({path:resolve(evidence,`branding-about-${scale}.png`)});await page.locator('#closeAbout').click();
        await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
        await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name] of [['sourceFile','source.pdf'],['renderedFile','rendered.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
        await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open')&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false');
        await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC: note heading and focus ring must stay separate.');
        for(const [width,height] of [[1440,900],[1024,768],[900,560]]){
          await page.setViewportSize({width,height});
          for(const collapsed of [false,true]){
            if(await page.locator('#toggleComments').getAttribute('aria-expanded')!==String(!collapsed))await page.locator('#toggleComments').click();
            await page.locator('#comment').focus();
            check(await page.evaluate(()=>{const h=document.querySelector('#findingNoteHeading'),t=document.querySelector('#comment'),b=h.getBoundingClientRect(),r=t.getBoundingClientRect(),s=getComputedStyle(t);return b.height>=18&&parseFloat(getComputedStyle(h).fontSize)>=12&&b.bottom+parseFloat(s.outlineWidth)+Math.max(0,parseFloat(s.outlineOffset))<=r.top&&r.width>100&&document.querySelector('#editor').scrollWidth<=document.querySelector('#editor').clientWidth;}),`Note clears focus ring at ${width}×${height}, ${label}, Findings ${collapsed?'collapsed':'open'}`);
            if((scale===1||scale===2)&&width!==1024)await page.screenshot({path:resolve(evidence,`branding-note-${width}-${scale}-${collapsed}.png`)});
          }
          check(await page.locator('#shortcutHelp').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const a=range.getBoundingClientRect(),b=el.getBoundingClientRect();return Math.abs(a.x+a.width/2-b.x-b.width/2)<1&&Math.abs(a.y+a.height/2-b.y-b.height/2)<2;}),`help question mark is centered at ${width}px, ${label}`);
        }
      }catch(e){await page.screenshot({path:resolve(evidence,'branding-failure.png')});throw e;}finally{await context.close();}
    }
    check(errors.length===0,'branding and layout produce no uncaught errors: '+errors.join('; '));return {name:'branding',assertions};
  }catch(e){log.push('FAIL '+e.stack);throw e;}finally{await writeFile(resolve(evidence,'branding.txt'),log.join('\n')+'\n');await server.close();}
}
