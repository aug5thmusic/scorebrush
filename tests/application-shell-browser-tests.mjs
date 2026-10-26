// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runApplicationShell({browser,serve,evidence,root}){
  const build=JSON.parse(await readFile(resolve(root,'build-info.json'),'utf8')),versionLabel=`Version ${build.version} (${build.buildDate})`;
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('application-shell: '+label);};
  page.on('pageerror',e=>errors.push(e.message));
  const capture=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return JSON.stringify({review:s.review,returned:s.returned,revisionId:s.revisionId,persistedRevision:s.persistedRevision,completions:s.completions});});
  const settled=async()=>{await page.evaluate(async()=>window.shellApi=await import('./app.js'));await page.waitForFunction(()=>!window.shellApi.sessionStatus().busy&&['source','rendered'].every(k=>document.getElementById(k+'Paper').getAttribute('aria-busy')==='false'&&!['true','gesture'].includes(document.getElementById(k+'Paper').dataset.resizePending)));};
  const folderSaved=async()=>{await page.evaluate(async()=>window.shellApi=await import('./app.js'));await page.waitForFunction(()=>{const a=window.shellApi,f=a.folderWorkspace.getState();return Boolean(a.sessionStatus().snapshotId)&&f.bound&&f.ready&&!f.busy&&!a.sessionStatus().dirty;},null,{timeout:90000});};
  const shot=name=>page.screenshot({path:resolve(evidence,'shell-'+name+'.png')});
  try{
    // Hold a genuinely pending module request, without adding a delay to the app.
    let release,seen;const gate=new Promise(r=>release=r),requested=new Promise(r=>seen=r);
    await page.route('**/app.js',async route=>{seen();await gate;await route.continue();});
    let releaseFonts;const fontGate=new Promise(resolve=>releaseFonts=resolve);await page.route('**/vendor/fonts/*.woff2',async route=>{await fontGate;await route.continue();});
    const navigation=page.goto(server.url);await requested;
    await page.waitForFunction(label=>document.querySelector('[data-build-info]')?.textContent===label,versionLabel);
    check(await page.locator('#startupScreen').isVisible()&&!await page.locator('#workspaceDialog').evaluate(el=>el.open),'startup is visible while initialization is genuinely pending');
    await page.waitForFunction(()=>document.querySelector('.startup-wordmark')?.complete&&document.querySelector('.startup-wordmark').naturalWidth>0);
    const startupType=()=>page.evaluate(()=>{const el=document.querySelector('#startupStatus'),range=document.createRange();range.selectNodeContents(el);const img=document.querySelector('.startup-wordmark');return {family:getComputedStyle(el).fontFamily,size:getComputedStyle(el).fontSize,weight:getComputedStyle(el).fontWeight,lineHeight:getComputedStyle(el).lineHeight,box:el.getBoundingClientRect().toJSON(),width:range.getBoundingClientRect().width,height:range.getBoundingClientRect().height,wordmark:img.getAttribute('src'),imageWidth:img.width,imageHeight:img.height};});
    const beforeFonts=await startupType();check(!await page.evaluate(()=>document.fonts.check('14px Sora'))&&beforeFonts.family.includes('Segoe UI')&&beforeFonts.wordmark==='wordmark.png','startup uses the native wordmark asset and system font while bundled fonts are delayed');
    releaseFonts();await page.evaluate(()=>document.fonts.ready);check(JSON.stringify(await startupType())===JSON.stringify(beforeFonts),'loading bundled fonts does not change startup typography or text geometry');await page.unroute('**/vendor/fonts/*.woff2');
    await shot('startup');release();await navigation;await page.unroute('**/app.js');await page.waitForFunction(()=>document.body.dataset.ready==='true');
    check(await page.locator('#startupScreen').isHidden()&&await page.locator('#workspaceDialog').isVisible(),'successful initialization immediately gives way to welcome');
    check(await page.locator('#workspaceDialog [data-build-info]').innerText()===versionLabel,'Welcome displays the complete maintained version and build date');
    check(await page.locator('.welcome-steps li:visible').count()===4&&await page.locator('#chooseFolderInSetup').isVisible()&&await page.locator('#welcomeRecover').isVisible()&&await page.locator('#welcomeRestore').isVisible(),'welcome explains all four steps and offers folder, saved work and backup entry points');await shot('welcome');
    await page.locator('#closeWorkspace').click();
    await page.locator('#chooseFolder').focus();await page.keyboard.press('Alt+f');check(await page.locator('#menuFile').isVisible(),'Alt+F opens the browser application menu');await page.keyboard.press('Escape');check(await page.locator('#chooseFolder').evaluate(el=>el===document.activeElement),'menu Escape restores the original focus');
    await menuCommand(page,'Help','about');check(await page.locator('#aboutDialog [data-build-info]').innerText()===versionLabel,'About displays the complete maintained version and parenthesized build date');await shot('about');await page.locator('#closeAbout').click();
    await page.locator('#appMenuEdit').click();check(await page.locator('#menuEdit [data-command=undo]').isDisabled()&&await page.locator('#menuEdit [data-command=new-finding]').isDisabled(),'Edit commands are unavailable without an open review');await shot('menu-empty');await page.keyboard.press('Escape');
    await page.evaluate(async()=>{
      const a=await import('./app.js'),directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Sonata-review',{create:true}),{fixtureBlob}=await import('./qa/fixtures.js');
      for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const w=await(await directory.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>directory;
    });
    await menuCommand(page,'File','new-project');await page.locator('#folderSetupDialog').waitFor();
    for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await page.waitForFunction(()=>document.body.classList.contains('review-open')&&!document.querySelector('#autoColor').disabled);await folderSaved();await settled();
    check(await page.locator('#autoColor').isChecked(),'new reviews enable Cycle colors by default');
    check(await page.evaluate(async()=>{const {defaultPreferences,validateReview}=await import('./model.js'),a=await import('./app.js'),saved=structuredClone(a.completion.capture().review);saved.preferences.autoColor=false;const old=structuredClone(saved);delete old.preferences;return defaultPreferences().autoColor&&validateReview(saved,saved).preferences.autoColor===false&&validateReview(old,saved).preferences.autoColor===false;}),'saved and legacy fixed-color preferences remain unchanged on import');
    for(const [type,text]of [['correction','SYNTHETIC: check the accidental in bar 2.'],['source_footnote','SYNTHETIC: add an editorial note about the slur.'],['comment','SYNTHETIC: retain this source observation internally.']]){
      await page.locator('#newFinding').click();await page.locator('#findingType').selectOption(type);await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();
    }
    await folderSaved();const original=await capture();
    for(const [width,height]of [[1440,900],[1024,768],[900,650]]){
      await page.setViewportSize({width,height});await settled();
      check(await page.evaluate(()=>{
        const h=document.querySelector('header'),brand=h.querySelector('h1'),accent=brand.querySelector('span'),nav=document.querySelector('#workflowNavigation'),status=document.querySelector('#statusControl'),b=brand.getBoundingClientRect(),n=nav.getBoundingClientRect(),s=status.getBoundingClientRect();
        return getComputedStyle(brand).fontSize===getComputedStyle(accent).fontSize&&getComputedStyle(brand).fontWeight===getComputedStyle(accent).fontWeight&&Math.abs((b.top+b.height/2)-(n.top+n.height/2))<3&&n.left>s.right-1&&Math.abs(s.left+s.width/2-innerWidth/2)<1&&h.scrollWidth<=h.clientWidth;
      }),`equal-sized wordmark, centered save status and top-right workflow share one header row at ${width}px`);
      check(await page.locator('#brush').isVisible()&&await page.locator('#highlightColor').isVisible()&&await page.locator('#autoColor').isVisible()&&await page.locator('#hide').isVisible()&&await page.locator('#undo').isVisible(),`working tools and Hide marks remain directly visible at ${width}px`);
      check(await page.locator('#renderedScroll').evaluate(el=>el.clientHeight/innerHeight>.55),`scores retain useful height at ${width}px`);await shot('proofread-'+width);
    }
    await page.setViewportSize({width:1440,height:900});await settled();
    await menuCommand(page,'Help','welcome');await page.locator('#closeWorkspace').click();check(await capture()===original,'opening and closing welcome preserves exact active review, decisions and saved revision');
    await page.locator('#hide').check();await page.locator('#appMenuView').click();check(await page.locator('#menuView [data-command=marks]').getAttribute('aria-checked')==='true','View checked state follows the visible Hide marks checkbox');await shot('menu-view');await page.keyboard.press('Escape');await page.locator('#overlay').focus();await page.keyboard.press('Control+h');check(!await page.locator('#hide').isChecked(),'Ctrl+H continues to restore marks');
    await folderSaved();await page.locator('#folderPromptButton').click();
    // Send to AI prepares and verifies the handoff on demand before enabling Copy.
    await page.waitForFunction(()=>!document.querySelector('#copyFolderPrompt').disabled);
    check(await page.locator('#copyFolderPrompt').isEnabled()&&(await page.locator('.folder-handoff-hint').innerText()).includes('does not contact an AI service'),'connected Send to AI leads with a ready copy action and explains the external AI boundary');await page.locator('#copyFolderPrompt').click();await shot('send-to-ai');await page.locator('#closeFolderPrompt').click();
    await page.evaluate(async()=>{const a=await import('./app.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle(a.folderWorkspace.getState().directoryName),{fixtureBlob}=await import('./qa/fixtures.js');for(const [name,data]of [['rendered.pdf',await fixtureBlob('multipage.pdf')],['score.ly','% SYNTHETIC updated LilyPond']]){const w=await(await folder.getFileHandle(name)).createWritable();await w.write(data);await w.close();}});
    await page.locator('#workflowReview').click();await page.locator('#reviewLoadLatest').click();await page.waitForFunction(()=>document.body.classList.contains('corrections-open')&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await folderSaved();await settled();
    const beforeStages=await capture(),baseline=await page.locator('#sourceViewer').getAttribute('data-render-sha256');await shot('review-changes');
    await menuCommand(page,'Help','welcome');
    check(await page.locator('#returnedBar').isHidden()&&!/Reviewing |proposed\.ly|proposed\.pdf|Page numbers may differ/.test(await page.locator('#workspaceDialog').innerText()),'reopened Welcome hides returned-review details by page context');
    await shot('welcome-during-review');await page.locator('#closeWorkspace').click();
    await menuCommand(page,'File','files');check(await page.locator('#returnedBar').isVisible()&&await page.locator('#roundReload').isVisible(),'Files & backups preserves returned-review recovery controls');
    await page.locator('#closeWorkspace').click();check(await capture()===beforeStages,'Welcome and Files visibility never clear or mutate returned review state');
    await page.locator('#workflowProof').click();await page.waitForFunction(()=>!document.body.classList.contains('corrections-open'));await settled();check(await page.locator('#sourceLabel').innerText()==='Original source'&&await page.locator('#draw').isVisible(),'Proofread can reopen the original source and drawing tools during a returned round');
    await page.locator('#workflowReview').click();await page.waitForFunction(()=>document.body.classList.contains('corrections-open')&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await settled();
    check(await capture()===beforeStages&&await page.locator('#sourceViewer').getAttribute('data-render-sha256')===baseline,'moving between stages preserves exact state and restores the exact historical render');
    await page.locator('#looksCorrect').click();await page.waitForFunction(()=>document.querySelector('#correctionProgress').textContent==='1/2 checked');await folderSaved();
    check((await page.locator('#comparisonComments').innerText()).includes('1'),'internal comments remain outside the two-item correction/footnote decision queue');
    const saved=await capture();await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await settled();check(await page.locator('#workspaceDialog').isHidden()&&await capture()===saved,'returning users restore the exact saved round and decisions without onboarding');
    check(errors.length===0,'new shell actions produce no uncaught errors: '+errors.join('; '));
    const failure=await context.newPage();await failure.route('**/app.js',route=>route.abort());await failure.goto(server.url);await failure.waitForFunction(()=>document.querySelector('#startupScreen').dataset.state==='error');check(await failure.locator('#startupScreen').isVisible()&&(await failure.locator('#startupError').innerText()).includes('complete ZIP'),'failed module loading leaves a visible recovery instruction instead of hiding startup');await failure.screenshot({path:resolve(evidence,'shell-startup-failure.png')});await failure.close();
    const mockContext=await browser.newContext();
    try{
      await mockContext.addInitScript(()=>{window.nativeMenuMessages=[];window.nativeMenuListeners=[];window.chrome??={};window.chrome.webview={postMessage:message=>window.nativeMenuMessages.push(message),addEventListener:(type,listener)=>{if(type==='message')window.nativeMenuListeners.push(listener);}};});
      const mock=await mockContext.newPage();await mock.goto(server.url);await mock.waitForFunction(()=>document.body.dataset.ready==='true');await mock.locator('#closeWorkspace').click();
      const send=message=>mock.evaluate(message=>{for(const listener of window.nativeMenuListeners)listener({data:message});},message);
      const checked=()=>mock.evaluate(async()=>(await import('./app.js')).applicationShell.states()['scroll-pages'].checked);
      await mock.waitForFunction(()=>window.nativeMenuMessages.some(m=>m.op==='menu-state'&&m.items['scroll-pages']?.enabled));
      check(await mock.evaluate(()=>{const s=window.nativeMenuMessages.filter(m=>m.op==='menu-state').at(-1).items;return Object.keys(s).length===31&&s['scroll-pages'].checked===false&&Object.values(s).every(v=>Object.keys(v).length===2&&typeof v.enabled==='boolean'&&typeof v.checked==='boolean');}),'simulated native menu receives exactly 31 validated command states with scrolling initially unchecked');
      await send({op:'command',id:'scroll-pages',value:true});await send({op:'command',id:'arbitrary-setting'});check(!await checked(),'native command listener rejects extra fields and unknown commands');
      await send({op:'command',id:'scroll-pages'});check(await checked(),'exact native Scroll between pages command changes the same local preference');
      await mock.waitForFunction(()=>window.nativeMenuMessages.filter(m=>m.op==='menu-state').at(-1).items['scroll-pages'].checked);
      await send({op:'command',id:'welcome'});await send({op:'command',id:'scroll-pages'});check(await checked(),'native scrolling command is blocked while a modal is open');
      await mock.locator('#closeWorkspace').click();await send({op:'command',id:'scroll-pages'});check(!await checked(),'native menu command unchecks the preference through the same explicit route');
    }finally{await mockContext.close();}
    for(const [label,body,status] of [
      ['invalid-prerelease',JSON.stringify({...build,version:'0.1.0-beta.01'}),200],
      ['invalid-native-range',JSON.stringify({...build,version:'65535.1.0-beta.1'}),200],
      ['invalid-date',JSON.stringify({...build,buildDate:20261023}),200],
      ['invalid-object','null',200],
      ['invalid-json','{',200],
      ['missing-metadata','Not found',404]
    ]){
      const isolated=await browser.newContext(),bad=await isolated.newPage();
      try{
        await bad.route('**/build-info.json',route=>route.fulfill({status,contentType:'application/json',body}));
        await bad.goto(server.url);await bad.waitForFunction(()=>document.body.dataset.ready==='true'&&document.querySelector('#startupScreen').dataset.state==='error');
        await bad.locator('#startupRecovery').click({trial:true});
        check(await bad.locator('#startupScreen').isVisible()&&/build information/i.test(await bad.locator('#startupError').innerText())&&(await bad.locator('#startupError').innerText()).includes('complete review ZIP'),label+' leaves a visible, actionable startup error');
        if(label==='invalid-prerelease'){
          await bad.screenshot({path:resolve(evidence,'shell-invalid-metadata.png')});
          await bad.locator('#startupRecovery').click();
          check(await bad.locator('#startupScreen').isHidden()&&await bad.locator('#workspaceDialog').isVisible(),'invalid metadata still permits initialized recovery options without reloading');
        }
      }finally{await isolated.close();}
    }
    return {name:'application-shell',assertions};
  }catch(e){log.push('FAIL '+e.stack);await shot('failure');throw e;}
  finally{await writeFile(resolve(evidence,'application-shell.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
