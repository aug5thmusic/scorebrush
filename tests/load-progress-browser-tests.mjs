// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

// Real small connected projects, with held I/O boundaries to inspect progress.
// This never accesses a user profile or transcription folder.
export async function runLoadProgress({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('load-progress: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const until=(fn,timeout=45000)=>waitUntil(page,fn,timeout);
  const saved=()=>until(()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy&&!a.sessionStatus().dirty&&!a.sessionStatus().busy;});
  const state=()=>page.evaluate(()=>({status:a.sessionStatus(),folder:a.folderWorkspace.getState(),scene:a.completion.capture().returned,open:document.querySelector('#loadProgressDialog').open}));
  const overwrite=fixture=>page.evaluate(async fixture=>{const c=await a.folderWorkspace.io.getSettings(),w=await(await c.directory.getFileHandle(c.paths.rendered)).createWritable();await w.write(await(await import('./qa/fixtures.js')).fixtureBlob(fixture));await w.close();},fixture);
  const start=()=>page.evaluate(()=>{window.loadingCall=a.folderWorkspace.loadLatest();});
  const finish=()=>page.evaluate(()=>window.loadingCall);
  try{
    await page.goto(server.url);await until(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js');
      const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC load progress',{create:true});
      for(const[name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,value]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(value);
    await page.locator('#folderSetupConfirm').click();await saved();
    check(await page.locator('#loadProgressDialog').isHidden(),'ordinary project setup and folder saving do not open the Load latest popup');
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC previous finding');await page.locator('#saveFinding').click();await saved();
    await overwrite('rendered.pdf');
    await page.evaluate(()=>{
      window.originalPut=a.operations.putSaved;window.originalSettings=a.folderWorkspace.io.putSettings;
      a.operations.putSaved=async(...args)=>{if(window.holdPreflight){window.holdPreflight=false;window.preflightHeld=true;await new Promise(resolve=>window.releasePreflight=resolve);window.preflightHeld=false;}return originalPut(...args);};
      a.folderWorkspace.io.putSettings=async value=>{if(window.holdBaseline&&value?.pendingBaselineWorkspaceId){window.holdBaseline=false;window.baselineHeld=true;await new Promise(resolve=>window.releaseBaseline=resolve);window.baselineHeld=false;}return originalSettings(value);};
      const get=FileSystemFileHandle.prototype.getFile,create=FileSystemFileHandle.prototype.createWritable;
      window.loadWorkingReads=0;
      FileSystemFileHandle.prototype.getFile=async function(...args){if(this.name==='rendered.pdf'){loadWorkingReads++;if(window.abortWorkingRead){window.abortWorkingRead=false;throw new DOMException('SYNTHETIC cancelled load','AbortError');}if(window.holdWorkingRead){window.holdWorkingRead=false;window.workingReadHeld=true;await new Promise(resolve=>window.releaseWorkingRead=resolve);window.workingReadHeld=false;}}return get.apply(this,args);};
      FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(name==='snapshot.json'&&window.failBaselineWrite){window.failBaselineWrite=false;throw Error('SYNTHETIC new-version write failed');}return write(value);};return stream;};
    });
    await page.locator('#newFinding').click();await page.evaluate(()=>{window.holdPreflight=true;window.holdBaseline=true;});await page.locator('#comment').fill('SYNTHETIC unsaved note before Load latest');
    await start();await until(()=>window.preflightHeld);
    const held=await state();
    check(held.open&&held.folder.busy&&held.folder.selecting,'Load latest displays a modal and advertises busy before preflight saving finishes');
    check(await page.getByRole('dialog',{name:'Loading latest score'}).isVisible()&&await page.getByRole('progressbar',{name:'Loading the updated score'}).isVisible(),'the centered popup has an accessible name, status and progress indicator');
    check(await page.locator('#loadProgressBar').getAttribute('value')===null&&await page.locator('#loadProgressPhase').innerText()==='Saving your current review…','progress is honestly indeterminate while existing edits are saved');
    await page.keyboard.press('Escape');await page.keyboard.press('Enter');await page.evaluate(()=>a.folderWorkspace.loadLatest());
    check((await state()).open&&await page.evaluate(()=>loadWorkingReads===0),'Escape, Enter and a second Load latest cannot dismiss or duplicate the active operation');
    check(await page.locator('#newFinding').isDisabled()&&await page.locator('#closeLoadProgress').isHidden(),'review editing is blocked and no fake cancellation control is offered');
    for(const [width,height]of [[1440,900],[900,600]]){await page.setViewportSize({width,height});const box=await page.locator('#loadProgressDialog').boundingBox();check(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'progress popup remains fully visible at '+width+'×'+height);await page.screenshot({path:resolve(evidence,'load-progress-'+width+'.png')});}
    await page.setViewportSize({width:1440,height:900});
    await page.evaluate(()=>window.releasePreflight());await until(()=>window.baselineHeld);
    check((await state()).open&&await page.locator('#loadProgressPhase').innerText()==='Saving the new score version…','the popup stays visible after the PDF opens until the new version is saved');
    check(await page.locator('#looksCorrect').isDisabled()&&(await state()).scene.reported.every(f=>!f.decision),'a visible new PDF cannot accept review decisions during its pending baseline save');
    await page.evaluate(()=>window.releaseBaseline());await finish();await saved();
    check(await page.locator('#loadProgressDialog').isHidden()&&await page.locator('#newFinding').isEnabled()&&await page.locator('#looksCorrect').isEnabled(),'successful Load latest closes its popup and restores editing and review controls');
    check((await state()).scene.reported.length===2,'preflight protects the unsaved note before constructing the new review');
    await page.locator('#reportAnotherError').click();await page.locator('#comment').fill('SYNTHETIC ordinary autosave does not need a modal');await saved();
    check(await page.locator('#loadProgressDialog').isHidden(),'ordinary note autosaving stays unobtrusive');await page.locator('#saveFinding').click();await saved();

    await start();await finish();await saved();check(await page.locator('#loadProgressDialog').isHidden()&&await page.locator('#newFinding').isEnabled(),'already-current files finish without a lingering popup or disabled controls');

    await page.locator('#openRoundSummary').click();await page.locator('#roundSummary').waitFor();
    await page.locator('#dismissRoundSummary').focus();await page.evaluate(()=>window.holdWorkingRead=true);await start();await until(()=>window.workingReadHeld);
    check(await page.evaluate(()=>document.querySelector('#roundSummary').open&&document.querySelector('#loadProgressDialog').open),'loading can appear above an existing workflow dialog without closing it');
    await page.evaluate(()=>window.releaseWorkingRead());await finish();
    check(await page.locator('#loadProgressDialog').isHidden()&&await page.locator('#roundSummary').isVisible(),'finishing returns to the pre-existing workflow dialog');check(await page.locator('#dismissRoundSummary').evaluate(el=>el===document.activeElement),'focus returns inside the underlying workflow dialog');await page.locator('#dismissRoundSummary').click();
    // The dialog close event and its control-state refresh run asynchronously.
    await page.waitForFunction(()=>!document.querySelector('#newFinding').disabled,null,{timeout:2000});
    check(await page.locator('#newFinding').isEnabled(),'closing the restored workflow dialog re-enables annotations');

    const before=await page.evaluate(()=>a.completion.capture().review.snapshotId);
    await page.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),w=await(await c.directory.getFileHandle(c.paths.rendered)).createWritable();await w.write(new Blob(['SYNTHETIC invalid PDF <script>not code</script>']));await w.close();});
    await page.locator('#looksCorrect').focus();await start();await finish();
    check(await page.locator('#loadProgressDialog').isVisible()&&await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&await page.locator('#closeLoadProgress').isEnabled(),'invalid PDF errors remain prominent with a working Close action');check(await page.locator('#closeLoadProgress').evaluate(el=>el===document.activeElement),'a loading error focuses its visible Close action');
    check(!(await state()).folder.busy&&await page.locator('#loadProgressBar').isHidden()&&(await page.locator('#loadProgressDetail').innerText()).length>0,'failed loading stops the activity indicator and displays its actual error');
    check(await page.evaluate(before=>a.completion.capture().review.snapshotId===before,before),'invalid updated files preserve the currently reviewed score');await page.locator('#closeLoadProgress').click();check(await page.locator('#looksCorrect').evaluate(el=>el===document.activeElement),'closing the error restores focus to the prior enabled review control');
    await overwrite('rendered.pdf');await start();await finish();await saved();

    await page.locator('#reportAnotherError').click();await page.locator('#comment').fill('SYNTHETIC pending text survives a failed preflight');
    await page.evaluate(()=>{a.operations.putSaved=async()=>{throw Error('SYNTHETIC preflight local save failed');};});await start();await finish();
    check(await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&(await page.locator('#loadProgressDetail').innerText()).length>0,'a save failure before file reading is handled visibly rather than escaping the loading lifecycle');
    check((await state()).status.dirty&&await page.locator('#comment').inputValue()==='SYNTHETIC pending text survives a failed preflight','failed preflight keeps the latest unsaved annotation in memory');
    await page.locator('#closeLoadProgress').click();await page.evaluate(async()=>{a.operations.putSaved=window.originalPut;await a.saveNow();await a.folderWorkspace.saveCheckpoint();});await page.locator('#saveFinding').click();await saved();
    await start();await finish();await saved();

    await page.evaluate(()=>window.abortWorkingRead=true);await start();await finish();
    check(await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&!(await state()).folder.busy,'an aborted file read remains a visible retryable error and releases its busy guard');await page.locator('#closeLoadProgress').click();

    await overwrite('multipage.pdf');await page.evaluate(()=>window.failBaselineWrite=true);await start();await finish();
    check(await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&(await page.locator('#loadProgressDetail').innerText()).includes('saved locally'),'a new-version folder failure explains that the newly opened score is saved locally');
    check(Boolean((await state()).folder.pendingBaselineWorkspaceId),'failed new-version saving retains its pending recovery identity');await page.locator('#closeLoadProgress').click();
    await start();await finish();await saved();
    check(await page.locator('#loadProgressDialog').isHidden()&&!(await state()).folder.pendingBaselineWorkspaceId&&await page.locator('#newFinding').isEnabled(),'retry completes the pending version and restores normal controls');
    check(errors.length===0,'loading progress produces no uncaught browser errors');
    return {name:'load-progress',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'load-progress-failure.png')}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'load-progress.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
