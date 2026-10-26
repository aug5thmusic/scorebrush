// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil,folderSnapshot,installResumeAudit,assertCleanAudit} from './clean-resume-helpers.mjs';

// Real controller/IndexedDB/OPFS checks. Holds only canvas encoding and an
// individual synthetic filesystem write so pending status can be observed.
export async function checkSaveProgressAndReuse({browser,server,evidence,check}){
  async function setup(label){
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async label=>{
      const a=await import('./app.js'),{fixtureBlob}=await import('./qa/fixtures.js'),dir=await(await navigator.storage.getDirectory()).getDirectoryHandle(label,{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const stream=await(await dir.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(name));await stream.close();}
      a.folderWorkspace.io.pickDirectory=async()=>({directory:dir,absolutePath:'C:\\'+label,nativeBinding:'a'.repeat(32)});
    },label);
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();
    const saved=()=>waitUntil(page,async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().dirty;});
    const local=()=>waitUntil(page,async()=>{const a=await import('./app.js');return !a.sessionStatus().dirty&&!a.sessionStatus().busy;});
    const note=async text=>{await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await local();};
    await saved();return {context,page,errors,saved,note};
  }
  const fixture=await setup('SYNTHETIC save progress'),{context,page,errors,saved,note}=fixture;
  const measurements={};
  try{
    await note('SYNTHETIC baseline finding');await saved();
    const before=await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),h=await import('./storage.js');return {task:c.head.id,stamp:s.stamp,revisionId:s.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId))};});
    await page.evaluate(async()=>{
      const a=await import('./app.js'),make=a.operations.makePackage;window.saveProbePackages=0;window.saveProbeMessages=[];window.saveProbeInPackage=false;
      window.saveProbeLabels=[];
      new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes){const text=node.textContent;if(/ \u00b7 \d+\s*\/\s*\d+$/.test(text))saveProbeLabels.push(text);}}).observe(document.querySelector('#statusLabel'),{childList:true});
      a.operations.makePackage=async(...args)=>{
        saveProbePackages++;saveProbeInPackage=true;const progress=args[4];
        args[4]=message=>{saveProbeMessages.push(message);progress(message);};
        try{return await make(...args);}finally{saveProbeInPackage=false;}
      };
      const encode=HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob=function(...args){
        if(window.saveProbeHoldCanvas&&saveProbeInPackage){saveProbeHoldCanvas=false;window.saveProbeCanvasPending=true;const canvas=this;window.releaseSaveProbeCanvas=()=>{saveProbeCanvasPending=false;encode.apply(canvas,args);};return;}
        return encode.apply(this,args);
      };
      const create=FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable=async function(...args){
        const name=this.name,stream=await create.apply(this,args),write=stream.write.bind(stream);
        stream.write=async value=>{
          if(name==='snapshot.json'&&window.saveProbeFailSnapshot)throw Error('SYNTHETIC pending-history failure');
          if(name==='snapshot.json'&&window.saveProbeHoldSnapshot){saveProbeHoldSnapshot=false;window.saveProbeSnapshotPending=true;await new Promise(resolve=>{window.releaseSaveProbeSnapshot=()=>{saveProbeSnapshotPending=false;resolve();};});}
          return write(value);
        };return stream;
      };
    });
    await page.evaluate(async()=>await(await import('./app.js')).folderWorkspace.loadLatest());await saved();
    const unchanged=await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),h=await import('./storage.js');return {packages:saveProbePackages,task:c.head.id,revisionId:s.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId))};});
    assert.equal(unchanged.packages,0);assert.equal(unchanged.task,before.task);assert.equal(unchanged.revisionId,before.revisionId);assert.equal(unchanged.journal,before.journal);
    check(true,'unchanged Load latest reuses the exact verified task without rendering another package or inventing edits');
    await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();await c.directory.removeEntry('History.json');await a.folderWorkspace.loadLatest();});await saved();
    const repaired=await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();return {packages:saveProbePackages,task:c.head.id,index:JSON.parse(await(await(await c.directory.getFileHandle('History.json')).getFile()).text())};});
    assert.equal(repaired.packages,0);assert.equal(repaired.task,before.task);assert(repaired.index.revisions.length>0);
    check(true,'same-scene retry repairs missing derived history while reusing the already verified task');
    await page.evaluate(()=>{window.saveProbeHoldCanvas=true;window.saveProbeHoldSnapshot=true;});
    await note('SYNTHETIC changed finding requires new evidence');
    await page.waitForFunction(()=>window.saveProbeCanvasPending===true);
    measurements.rendering=await page.evaluate(async()=>({label:document.querySelector('#statusLabel').textContent,state:document.querySelector('#statusControl').dataset.state,folder:(await import('./app.js')).folderWorkspace.getState(),packages:saveProbePackages,messages:saveProbeMessages}));
    assert.equal(measurements.rendering.packages,1);assert.equal(measurements.rendering.state,'saving');assert(measurements.rendering.folder.busy&&!measurements.rendering.folder.ready);
    assert.match(measurements.rendering.label,/^Preparing PDF · \d+\s*\/\s*\d+$/);
    check(true,'a changed scene renders fresh evidence and exposes real page progress in the visible saving header');
    measurements.widths=[];
    for(const width of [1280,1024]){
      await page.setViewportSize({width,height:768});await page.waitForTimeout(100);
      const label=await page.locator('#statusLabel').evaluate(el=>({text:el.textContent,visible:el.clientWidth,full:el.scrollWidth}));
      assert(label.visible>0&&label.full<=label.visible,'page counts must not be ellipsized at '+width);
      measurements.widths.push({width,kind:'rendering',...label});
    }
    check(true,'page progress counts remain fully visible at 1280 and 1024 pixels');
    await page.screenshot({path:resolve(evidence,'save-progress-rendering.png')});
    await page.evaluate(()=>releaseSaveProbeCanvas());await page.waitForFunction(()=>window.saveProbeSnapshotPending===true);
    measurements.history=await page.evaluate(async()=>({label:document.querySelector('#statusLabel').textContent,state:document.querySelector('#statusControl').dataset.state,folder:(await import('./app.js')).folderWorkspace.getState()}));
    assert.equal(measurements.history.state,'saving');assert(measurements.history.folder.busy&&!measurements.history.folder.ready);
    assert.match(measurements.history.label,/(Reading|Checking|Preparing|Saving|Verifying).* · \d+\s*\/\s*\d+/);
    assert.doesNotMatch(measurements.history.label,/^Saved\b/);
    check(true,'history phase counts remain visible and saving stays pending while its actual snapshot write is held');
    for(const width of [1280,1024]){
      await page.setViewportSize({width,height:768});await page.waitForTimeout(100);
      const label=await page.locator('#statusLabel').evaluate(el=>({text:el.textContent,visible:el.clientWidth,full:el.scrollWidth}));
      assert(label.visible>0&&label.full<=label.visible,'history counts must not be ellipsized at '+width);
      measurements.widths.push({width,kind:'history',...label});
    }
    check(true,'history phase counts remain fully visible at 1280 and 1024 pixels');
    await page.screenshot({path:resolve(evidence,'save-progress-history.png')});
    await page.evaluate(()=>releaseSaveProbeSnapshot());await saved();
    measurements.completed=await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();return {label:document.querySelector('#statusLabel').textContent,state:document.querySelector('#statusControl').dataset.state,folder:a.folderWorkspace.getState(),task:c.head.id,findings:c.head.task.findings,packages:saveProbePackages};});
    assert.equal(measurements.completed.packages,1);assert.notEqual(measurements.completed.task,before.task);assert.equal(measurements.completed.findings.length,2);
    assert.equal(measurements.completed.folder.progressText,'');assert.equal(measurements.completed.state,'saved');assert.equal(measurements.completed.label,'Saved to folder');
    check(true,'successful publication clears transient progress only after the new task and exact changed findings are saved');
    await page.evaluate(()=>{window.saveProbeFailSnapshot=true;});await note('SYNTHETIC failure must retain pending edit');
    await waitUntil(page,async()=>/SYNTHETIC pending-history failure/.test((await import('./app.js')).folderWorkspace.getState().error));
    measurements.failed=await page.evaluate(async()=>({label:document.querySelector('#statusLabel').textContent,state:document.querySelector('#statusControl').dataset.state,folder:(await import('./app.js')).folderWorkspace.getState()}));
    assert.equal(measurements.failed.folder.progressText,'');assert.equal(measurements.failed.state,'attention');assert.doesNotMatch(measurements.failed.label,/^Saved\b/);
    check(true,'failed history publication clears stale progress and keeps an explicit unsaved-folder warning');
    await page.evaluate(async()=>{saveProbeFailSnapshot=false;await(await import('./app.js')).folderWorkspace.saveNow();});await saved();
    assert.equal(await page.evaluate(async()=>(await import('./app.js')).completion.capture().review.findings.length),3);
    // Preserve the text emitted by the real controller; only enlarge its count
    // digits so a tiny fixture catches clipping with research-sized histories.
    await page.setViewportSize({width:900,height:768});
    measurements.largeCounts=await page.evaluate(()=>{
      const el=document.querySelector('#statusLabel'),control=document.querySelector('#statusControl'),original=el.textContent,originalState=control.dataset.state,labels=[...new Set(saveProbeLabels.map(text=>text.replace(/\d+(\s*\/\s*)\d+$/,(_,separator)=>`5000${separator}5000`)))];
      try{control.dataset.state='saving';return labels.map(text=>{el.textContent=text;return {text,visible:el.clientWidth,full:el.scrollWidth};});}
      finally{el.textContent=original;control.dataset.state=originalState;}
    });
    assert(measurements.largeCounts.some(item=>item.text.startsWith('Checking')),'actual checking phase must be exercised');
    assert(measurements.largeCounts.some(item=>item.text.startsWith('Verifying')),'actual verification phase must be exercised');
    assert(measurements.largeCounts.some(item=>item.text.startsWith('Saving')),'actual saving phase must be exercised');
    for(const label of measurements.largeCounts)assert(label.visible>0&&label.full<=label.visible,'5000-item progress must not be ellipsized at 900 pixels: '+label.text);
    check(true,'actual progress phase labels and 5000-item counts fit fully at 900 pixels');
    check(!errors.length,'save progress and task reuse leave no uncaught browser errors: '+errors.join('; '));
  }finally{await writeFile(resolve(evidence,'save-progress-measurements.json'),JSON.stringify(measurements,null,2));await context.close();}
  const restarted=await setup('SYNTHETIC restarted task collision');
  try{
    const pending=await restarted.page.evaluate(async()=>{
      const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),h=await import('./storage.js'),current=await h.getSaved(s.workspaceId);
      if(s.stamp.revision!==1||c.headStamp.revision!==1)throw Error('Fixture must start with the naturally colliding first-session revision');
      const review=structuredClone(current.review);review.findings=[{id:'synthetic-local-only',number:1,page:1,comment:'SYNTHETIC locally saved before interrupted folder publication',state:'open',type:'correction',color:'#ffd34d',strokes:[],bounds:null}];review.nextNumber=2;review.updatedAt=new Date().toISOString();
      const written=await h.putSaved({...current,review,revisionId:crypto.randomUUID()},current.storageRevision);
      return {oldTask:c.head.id,oldStamp:c.headStamp,review,revisionId:written.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId))};
    });
    await restarted.page.reload();await restarted.page.waitForFunction(()=>document.body.dataset.ready==='true');await restarted.saved();
    const current=await restarted.page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),h=await import('./storage.js');return {stamp:s.stamp,task:c.head.id,findings:c.head.task.findings,review:s.review,revisionId:s.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId))};});
    assert.equal(current.stamp.revision,pending.oldStamp.revision);assert.notEqual(current.task,pending.oldTask);assert.equal(current.findings.length,1);assert.equal(current.findings[0].comment,pending.review.findings[0].comment);
    assert.deepEqual(current.review,pending.review);assert.equal(current.revisionId,pending.revisionId);assert.equal(current.journal,pending.journal);
    check(true,'a persisted task with a colliding restarted session stamp cannot hide a newer locally saved finding');
    const snapshot=await folderSnapshot(restarted.page);await installResumeAudit(restarted.page);await restarted.page.reload();await restarted.page.waitForFunction(()=>document.body.dataset.ready==='true');await restarted.saved();
    assert.deepEqual(await folderSnapshot(restarted.page),snapshot);await assertCleanAudit(restarted.page);
    check(!restarted.errors.length,'repaired restarted state reopens without publication, lost notes or fabricated edits');
    await writeFile(resolve(evidence,'save-progress-restarted-task.json'),JSON.stringify({pending,current},null,2));
  }finally{await restarted.context.close();}
}



export async function runSaveProgress({browser,serve,evidence,root}){
  const server=await serve(root),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('save-progress: '+label);};
  try{await checkSaveProgressAndReuse({browser,server,evidence,check});return {name:'save-progress',assertions};}
  catch(error){log.push('FAIL '+error.stack);throw error;}
  finally{await writeFile(resolve(evidence,'save-progress.txt'),log.join('\n'));await server.close();}
}
