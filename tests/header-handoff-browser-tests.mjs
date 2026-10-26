// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runHeaderHandoff({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('header-handoff: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  async function until(fn){const end=Date.now()+90000;do{const value=await page.evaluate(fn);if(value)return value;await new Promise(resolve=>setTimeout(resolve,75));}while(Date.now()<end);throw new Error('Timeout: '+await page.locator('body').innerText());}
  const saved=()=>until(async()=>{const a=await import('./app.js'),s=a.folderWorkspace.getState();return s.ready&&!s.busy&&!a.sessionStatus().busy;});
  const scene=()=>page.evaluate(async()=>{const a=await import('./app.js');return {review:a.completion.capture().review,folder:a.folderWorkspace.getState()};});
  async function choose(name,seed=false){
    await page.evaluate(async({name,seed})=>{
      const a=await import('./app.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle(name,{create:true});
      if(seed){const {fixtureBlob}=await import('./qa/fixtures.js');for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}}
      a.folderWorkspace.io.pickDirectory=async()=>name.includes('Étude')?{directory:folder,absolutePath:'C:\\Synthetic scores\\Étude A',nativeBinding:'a'.repeat(32)}:folder;
    },{name,seed});
    if(await page.locator('#workspaceDialog').isVisible())await page.locator('#chooseFolderInSetup').click();else await page.locator('#chooseFolder').click();
    await until(async()=>document.querySelector('#folderSetupDialog')?.open||!(await import('./app.js')).folderWorkspace.getState().busy);if(await page.locator('#folderSetupDialog').isVisible()){for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);await page.locator('#folderSetupConfirm').click();}await saved();
  }
  const add=async(text,type='correction')=>{await page.locator('#newFinding').click();await page.locator('#findingType').selectOption(type);await page.locator('#comment').fill(text);await page.locator('#comment').press('Enter');await saved();};
  async function taskCount(){return page.evaluate(async()=>{const a=await import('./app.js'),name=a.folderWorkspace.getState().directoryName,folder=await(await navigator.storage.getDirectory()).getDirectoryHandle(name),privateFolder=await folder.getDirectoryHandle('.scorebrush'),latest=await privateFolder.getDirectoryHandle('latest');return JSON.parse(await(await(await latest.getFileHandle('task.json')).getFile()).text()).findings.length;});}
  const openPrompt=async({ready=true}={})=>{await page.locator('#folderPromptButton').click();await page.locator('#folderPromptDialog').waitFor();if(ready)await until(()=>!document.querySelector('#copyFolderPrompt').disabled);};
  async function headerFits(selector){return page.locator(selector).evaluate(header=>{const r=header.getBoundingClientRect(),children=[...header.children].filter(n=>getComputedStyle(n).display!=='none').map(n=>n.getBoundingClientRect());return r.height<=58&&header.scrollWidth<=header.clientWidth+1&&children.every(b=>b.x>=r.x-1&&b.right<=r.right+1&&b.bottom<=r.bottom+1);});}
  async function checkHeaderGeometry(selector,width,state){
    await page.setViewportSize({width,height:900});
    const geometry=await page.locator(selector).evaluate(header=>{
      const rect=header.getBoundingClientRect(),visible=el=>getComputedStyle(el).display!=='none',children=[...header.children].filter(visible),status=header.querySelector('#statusControl').getBoundingClientRect(),statusContents=[...header.querySelector('#statusControl').children].filter(visible).map(el=>el.getBoundingClientRect()),brand=header.querySelector('.desk-brand')?.getBoundingClientRect(),identity=header.querySelector('#workspaceIdentity').getBoundingClientRect();
      const overlaps=[];for(let i=0;i<children.length;i++)for(let j=i+1;j<children.length;j++){const a=children[i].getBoundingClientRect(),b=children[j].getBoundingClientRect();if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5)overlaps.push([children[i].id||children[i].className,children[j].id||children[j].className]);}
      const progress=header.querySelector('#correctionProgress');
      return {center:Math.abs(status.left+status.width/2-(rect.left+rect.width/2)),visibleCenter:Math.abs((Math.min(...statusContents.map(r=>r.left))+Math.max(...statusContents.map(r=>r.right)))/2-(rect.left+rect.width/2)),folderGap:brand?identity.left-brand.right:null,progressClipped:progress?progress.scrollWidth>progress.clientWidth:false,overlaps};
    });
    check(await headerFits(selector)&&geometry.center<=1&&geometry.visibleCenter<=1&&!geometry.overlaps.length&&!geometry.progressClipped,`${state} header is centered on one row without overlapping controls or clipped progress at ${width}px: ${JSON.stringify(geometry)}`);
    if(geometry.folderGap!==null)check(geometry.folderGap>=8&&geometry.folderGap<=24,`folder has a moderate gap after the ScoreBrush logo at ${width}px`);
    await page.screenshot({path:resolve(evidence,`${state}-header-${width}.png`)});
  }
  try{
    await page.goto(server.url);await until(()=>document.body.dataset.ready==='true');
    await page.evaluate(()=>document.fonts.ready);
    await page.locator('.desk-brand h1').screenshot({path:resolve(evidence,'scorebrush-logo.png')});
    const nameA='SYNTHETIC Étude <not markup> — Opus 1';await choose(nameA,true);
    check(await page.locator('#workspaceName').innerText()===nameA&&await page.locator('#workspaceName').locator('*').count()===0,'current folder is visible as safe text in the existing header');
    check(await page.locator('#folderPromptButton').innerText()==='Send to AI'&&await page.locator('#folderPromptButton').evaluate(el=>el.classList.contains('primary')),'Send to AI is the primary header action');
    check(await page.locator('#workspaceExplorer').isVisible()&&await page.locator('#chooseFolder').getAttribute('aria-label').then(value=>value.includes('Change working folder')),'folder switching and Explorer access are beside the current work name');
    check(!await page.locator('#statusButton').isVisible()&&await page.locator('#statusControl svg:visible').count()===0,'healthy header status has no Resolve button or dropdown chevron');
    await add('SYNTHETIC: change the upper note.');await add('SYNTHETIC: the D-flat in the source may be an error.','source_footnote');
    await openPrompt();
    check(await page.locator('#folderPromptCount').innerText()==='2 findings to send'&&await taskCount()===2&&await page.locator('#folderPromptDialog').getAttribute('data-state')==='ready','handoff count matches the exact saved task, including footnotes');
    check(await page.locator('#folderPathDetails,#folderPromptDetails').count()===0&&await page.locator('#folderPromptText').isVisible()&&!await page.locator('#retryFolderSave').isVisible(),'ready handoff exposes the full prompt with no path disclosure or retry button');
    check(await page.locator('#copyFolderPrompt').innerText()==='Copy prompt'&&await page.locator('#copyFolderPrompt').isEnabled(),'ready handoff has one clear Copy prompt action');
    await page.screenshot({path:resolve(evidence,'header-handoff-ready.png')});await page.locator('#copyFolderPrompt').click();
    check((await page.evaluate(()=>navigator.clipboard.readText())).includes('REVIEW_THIS.md'),'the compact action copies the complete prompt');
    await page.evaluate(()=>{window.realClipboardWrite=navigator.clipboard.writeText.bind(navigator.clipboard);Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw new Error('SYNTHETIC clipboard unavailable');}});});await page.locator('#copyFolderPrompt').click();
    check(await page.locator('#folderPromptText').isVisible()&&await page.locator('#folderPromptText').evaluate(el=>document.activeElement===el&&el.selectionStart===0&&el.selectionEnd===el.value.length),'clipboard failure selects the visible complete prompt for manual copying');
    await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:window.realClipboardWrite}));await page.locator('#closeFolderPrompt').click();
    const first=(await scene()).review.findings[0].id;await page.locator(`[data-finding-id="${first}"] .finding-open`).click();await page.locator('.finding-options>summary').click();await page.locator('#findingState').selectOption('resolved');await page.locator('#saveFinding').click();await saved();await openPrompt();
    check(await page.locator('#folderPromptCount').innerText()==='1 finding to send'&&await taskCount()===1,'resolved findings are excluded from the handoff count');await page.locator('#closeFolderPrompt').click();
    await page.evaluate(async()=>{const a=await import('./app.js');window.realMakePackage=a.operations.makePackage;a.operations.makePackage=async(...args)=>{window.headerEvidenceStarted=true;await new Promise(resolve=>window.releaseHeaderEvidence=resolve);return window.realMakePackage(...args);};});
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC latest unsaved handoff finding.');await page.locator('#comment').press('Enter');await openPrompt({ready:false});await until(()=>window.headerEvidenceStarted);
    check(await page.locator('#folderPromptCount').innerText()==='2 findings to send'&&await taskCount()===1&&await page.locator('#copyFolderPrompt').isDisabled()&&await page.locator('#folderPromptDialog').getAttribute('data-state')==='pending','pending count reflects current findings without presenting the older saved task as ready');
    check(!await page.locator('#retryFolderSave').isVisible(),'normal background saving does not show a retry button');
    await page.evaluate(async()=>{const a=await import('./app.js');a.operations.makePackage=window.realMakePackage;window.releaseHeaderEvidence();});await saved();await page.locator('#closeFolderPrompt').click();
    check((await page.locator('#workspaceExplorer').getAttribute('title'))==='Open file location','Explorer has a direct location label with no setup invitation');
    await page.evaluate(async()=>{const a=await import('./app.js');a.folderWorkspace.io.openNativeFolder=async request=>{window.openedHeaderFolder=request.directory.name;window.openedHeaderPath=request.absolutePath;await new Promise(resolve=>window.releaseHeaderExplorer=resolve);return {opened:true,path:'C:\\Synthetic scores\\Étude A'};};});await page.locator('#workspaceExplorer').click();await until(()=>Boolean(window.releaseHeaderExplorer));
    check(await page.locator('#statusLabel').innerText()==='Checking folder…'&&await page.locator('#workspaceExplorer').isDisabled(),'Explorer verification remains visible in compact header status without changing score layout');
    await page.evaluate(()=>window.releaseHeaderExplorer());await saved();
    check(await page.evaluate(()=>window.openedHeaderFolder)==nameA&&(await scene()).folder.absolutePath==='C:\\Synthetic scores\\Étude A','header Explorer opens the selected folder through the existing native boundary');
    await page.evaluate(()=>window.releaseHeaderExplorer=null);await page.locator('#workspaceExplorer').click();await until(()=>Boolean(window.releaseHeaderExplorer));
    check(await page.locator('#statusLabel').innerText()==='Checking folder…'&&await page.evaluate(()=>window.openedHeaderPath)==='C:\\Synthetic scores\\Étude A','later Explorer clicks use the remembered absolute path and show direct-opening progress');
    await page.evaluate(()=>window.releaseHeaderExplorer());await saved();
    await openPrompt();check(await page.locator('#addDirectoryName').isEnabled(),'a verified native folder path remains available for optional prompt inclusion');await page.locator('#closeFolderPrompt').click();
    for(const width of [1440,1280,1024])await checkHeaderGeometry('body>header',width,'saved-workspace');
    const nameB='SYNTHETIC Second piece';await choose(nameB,true);await openPrompt();
    check(await page.locator('#addDirectoryName').isDisabled()&&await page.locator('#copyFolderPrompt').isEnabled()&&await page.locator('#folderPromptDialog').getAttribute('data-state')==='ready','an optional unavailable path never blocks the saved prompt or asks for path entry');
    await page.locator('#closeFolderPrompt').click();await choose(nameA);
    await page.evaluate(async()=>{const a=await import('./app.js');a.operations.makePackage=async()=>{throw new Error('SYNTHETIC handoff disk failure');};});await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC triggers real failed handoff.');await page.locator('#comment').press('Enter');await page.evaluate(async()=>{void(await import('./app.js')).folderWorkspace.saveNow().catch(()=>{});});await until(async()=>Boolean((await import('./app.js')).folderWorkspace.getState().error));
    check(await page.locator('#statusControl .status-warning').isVisible()&&await page.locator('#statusControl .status-symbol').getAttribute('aria-hidden')==='true'&&!(await page.locator('#statusLabel').innerText()).includes('!'),'unresolved warning uses an outlined circle icon with no bare punctuation in its readable label');
    for(const width of [1440,1280,1024])await checkHeaderGeometry('body>header',width,'warning-workspace');
    if(await page.locator('#notices').evaluate(el=>el.matches(':popover-open')))await page.locator('#dismissMessage').click();await openPrompt({ready:false});await until(()=>!document.querySelector('#retryFolderSave').hidden&&!document.querySelector('#retryFolderSave').disabled);
    check(await page.locator('#retryFolderSave').isVisible()&&await page.locator('#copyFolderPrompt').isDisabled()&&(await page.locator('#folderPromptState').innerText()).includes('SYNTHETIC handoff disk failure'),'a genuine handoff failure shows its reason and retry action');
    await page.evaluate(async()=>{(await import('./app.js')).operations.makePackage=window.realMakePackage;});await page.locator('#retryFolderSave').click();await saved();check(!await page.locator('#retryFolderSave').isVisible()&&await page.locator('#copyFolderPrompt').isEnabled(),'successful retry restores ready prompt and removes retry');await page.locator('#closeFolderPrompt').click();
    await add('SYNTHETIC logged comment for comparison header.','comment');
    await page.evaluate(async()=>{const a=await import('./app.js'),root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle(a.folderWorkspace.getState().directoryName),{fixtureBlob}=await import('./qa/fixtures.js');for(const [name,data]of [['rendered.pdf',await fixtureBlob('multipage.pdf')],['score.ly','% SYNTHETIC revised code']]){const stream=await(await folder.getFileHandle(name)).createWritable();await stream.write(data);await stream.close();}});await page.locator('#loadLatest').click();await until(()=>!document.querySelector('#correctionHeader').hidden&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');await saved();
    check(await page.locator('header #workspaceIdentity').count()===1&&await page.locator('#workspaceName').innerText()===nameA&&await page.locator('#workspaceExplorer').isVisible(),'the shared header keeps work identity and Explorer visible during correction review');
    check(await page.locator('#comparisonComments').isVisible()&&await page.locator('#correctionHeader>#comparisonComments').count()===1&&(await page.locator('#correctionProgress').innerText())==='0/3 checked'&&(await page.locator('#correctionProgress').getAttribute('aria-label'))==='0 of 3 corrections checked','correction header keeps Comments with the right actions and readable progress beside Problems');
    for(const width of [1440,1280,1024])await checkHeaderGeometry('header',width,'saved-correction');
    await page.evaluate(async()=>{const a=await import('./app.js');a.folderWorkspace.io.openNativeFolder=async()=>{throw new Error('SYNTHETIC Explorer unavailable');};});await page.locator('#workspaceExplorer').click();await until(()=>document.querySelector('#statusControl').dataset.state==='attention');
    for(const width of [1440,1280,1024])await checkHeaderGeometry('header',width,'warning-correction');
    await page.evaluate(async()=>{const a=await import('./app.js');a.folderWorkspace.io.openNativeFolder=async()=>({opened:true,path:'C:\\Synthetic scores\\Étude A'});});await page.locator('#statusButton').click();await page.locator('#statusRetryOpenFolder').click();await saved();
    await openPrompt();check(await page.locator('#folderPromptCount').innerText()===`${await taskCount()-1} findings to send · 1 comment logged`,'correction-review handoff count comes from its saved follow-up task and separates the logged comment');await page.locator('#closeFolderPrompt').click();
    await choose(nameB);
    check(await page.locator('body>header #workspaceIdentity').count()===1&&await page.locator('#workflowNavigation #folderPromptButton').count()===1&&await page.locator('#workspaceName').innerText()===nameB&&await page.locator('body>header').evaluate(el=>[...el.children].map(n=>n.id||n.className).join('|')==='desk-brand|workspaceIdentity|statusControl|primary-actions'),'switching pieces from correction review keeps the shared header controls in order and Send to AI in the workflow strip');
    check(errors.length===0,'header and handoff flows produce no uncaught browser errors: '+errors.join('; '));
    return {name:'header-handoff',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'header-handoff-failure.png'),fullPage:true});await writeFile(resolve(evidence,'header-handoff-failure.txt'),await page.locator('body').innerText());throw error;}
  finally{await writeFile(resolve(evidence,'header-handoff.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
