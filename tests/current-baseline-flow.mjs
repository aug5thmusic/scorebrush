// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

// Called after the shared 4,493-object fixture is ready. This is a render
// boundary, so one archive publication is legitimate; ordinary decisions after
// it must never strand the new review against the previous archive baseline.
export async function exerciseCurrentBaseline({page,evidence,report,check,reset,record,idle,saved,archive}){
  await page.evaluate(async()=>{
    const put=a.folderWorkspace.io.putSettings;let heldSettings=false;
    a.folderWorkspace.io.putSettings=async value=>{
      if(!heldSettings&&value?.pendingBaselineWorkspaceId){heldSettings=true;window.baselineSettingsHeld=true;await new Promise(resolve=>window.releaseBaselineSettings=resolve);window.baselineSettingsHeld=false;}
      return put(value);
    };

    const original=FileSystemFileHandle.prototype.createWritable;window.holdNextArchive=true;
    FileSystemFileHandle.prototype.createWritable=async function(...args){
      const stream=await original.apply(this,args),write=stream.write.bind(stream),name=this.name;
      stream.write=async value=>{
        if(name==='snapshot.json'&&window.holdNextArchive){window.holdNextArchive=false;window.archiveHeld=true;await new Promise(resolve=>window.releaseHeldArchive=resolve);window.archiveHeld=false;}
        return write(value);
      };return stream;
    };
    const config=await a.folderWorkspace.io.getSettings(),writer=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();
    await writer.write(await(await import('./qa/fixtures.js')).fixtureBlob('multipage.pdf'));await writer.close();
  });
  await reset();await page.evaluate(()=>{window.pendingLoadLatest=a.folderWorkspace.loadLatest();});
  await waitUntil(page,()=>window.baselineSettingsHeld===true||window.archiveHeld===true,180000);
  if(await page.evaluate(()=>Boolean(window.baselineSettingsHeld))){
    report.settingsGate={blocked:await page.locator('#looksCorrect').isDisabled()};
    await page.keyboard.press('c');
    report.settingsGate.reported=await page.evaluate(()=>a.completion.capture().returned.reported);
    await page.evaluate(()=>window.releaseBaselineSettings());
  }

  await waitUntil(page,()=>window.archiveHeld===true,180000);
  report.held=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture();return {head:config.head?.id??null,workspaceId:scene.workspaceId,configWorkspace:config.workspaceId,recoveryId:config.recoveryId,checkpointId:config.currentCheckpointId,review:scene.review,returned:scene.returned};});
  check(report.held.workspaceId===report.held.configWorkspace&&report.held.head===null,'the new review is visible while its first archive publication is still pending');
  const decisionBlocked=await page.locator('#looksCorrect').isDisabled();report.decisionBlocked=decisionBlocked;
  if(decisionBlocked)await page.keyboard.press('c');else await page.locator('#looksCorrect').click();
  await waitUntil(page,()=>!a.sessionStatus().dirty&&!a.corrections.state().pending,90000);
  report.decisionDuringPublication=await page.evaluate(()=>({revisionId:a.completion.capture().revisionId,reported:a.completion.capture().returned.reported}));
  await page.evaluate(()=>window.releaseHeldArchive());
  await page.evaluate(()=>window.pendingLoadLatest);

  await waitUntil(page,()=>{const f=a.folderWorkspace.getState();return !f.busy&&(f.ready||Boolean(f.error));},180000);
  // Allow any already-scheduled checkpoint attempt to reach its real outcome.
  await page.waitForTimeout(600);await idle();
  const first=await record('new rendering baseline with an attempted early decision');
  report.firstPublication=first;
  if(first.error){
    if(await page.locator('#loadProgressDialog').isVisible())await page.locator('#closeLoadProgress').click();
    await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await reset();
    await page.locator('#statusRetryFolder').click();await idle();
    report.recoveryRetry=await record('status Retry following the stranded new-rendering baseline');
  }
  const settled=await page.evaluate(async()=>{
    const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),record=await(await import('./storage.js')).getSaved(scene.workspaceId),archive=await(await import('./folder-recovery.js')).readRecoveryMetadata(config.directory);
    return {error:a.folderWorkspace.getState().error,ready:a.folderWorkspace.getState().ready,recoveryId:config.recoveryId,archiveCurrent:archive.manifest.current,workspaceId:scene.workspaceId,
      reported:scene.returned.reported,localReported:record.returned.reported,revisionId:scene.revisionId,head:config.head?.id??null};
  });report.settled=settled;await writeFile(resolve(evidence,'current-baseline-performance.json'),JSON.stringify(report,null,2));
  check(report.settingsGate?.blocked&&report.settingsGate.reported.every(f=>!f.decision),'the initial baseline is locked before its pending settings are persisted');
  check(first.writes.filter(({name})=>name==='COMMIT.json').length===1,'one new rendering creates exactly one committed archive baseline');
  check(decisionBlocked,'review controls wait for the new rendering archive baseline before accepting decisions');
  assert.deepEqual(report.decisionDuringPublication.reported,report.held.returned.reported);
  check(!first.error,'waiting for the initial publication does not create a browser-folder conflict');
  check(!settled.error&&settled.ready&&settled.archiveCurrent===settled.workspaceId&&settled.recoveryId!==report.fixture.recoveryId&&Boolean(settled.head),'the new rendering reaches its matching durable baseline');
  assert.deepEqual(settled.reported,report.held.returned.reported);assert.deepEqual(settled.localReported,settled.reported);
  check(true,'held keyboard input creates no unintended decisions and preserves the exact local review');
  report.currentClosure=await page.evaluate(async()=>{
    const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),metadata=await(await import('./folder-recovery.js')).readRecoveryMetadata(config.directory),manifest=metadata.manifest;
    const current=manifest.records.find(item=>item.id===manifest.current),head=manifest.handoffs.find(item=>item.id===manifest.headTaskId),issued=manifest.handoffs.find(item=>item.id===scene.returned.taskId);
    if(!current||!head||!issued)throw Error('Expected current, head and issued-task closure in new archive');
    const data=await config.directory.getDirectoryHandle('.scorebrush');let priorCheckpoint=null;try{priorCheckpoint=JSON.parse(await(await(await data.getFileHandle('current-review.json')).getFile()).text());}catch(error){if(error.name!=='NotFoundError')throw error;}
    const predecessor=priorCheckpoint?.retired?manifest.records.filter(item=>(item.id===priorCheckpoint.workspaceId||item.workspaceId===priorCheckpoint.workspaceId)&&item.revisionId===priorCheckpoint.revisionId&&item.snapshotId===priorCheckpoint.review.snapshotId):[];
    const allowed=new Set([current,head,issued,...predecessor].flatMap(item=>Object.values(item.payloads).map(info=>info.sha256)));
    const all=new Set([...manifest.records,...manifest.handoffs,...(manifest.legacyEvidence??[])].flatMap(item=>Object.values(item.payloads).map(info=>info.sha256)));
    localStorage.setItem('SYNTHETIC-handoff-allowed-objects',JSON.stringify([...allowed]));
    localStorage.setItem('SYNTHETIC-handoff-old-objects',JSON.stringify([...all].filter(hash=>!allowed.has(hash))));
    return {allowed:allowed.size,declaredObjects:all.size,retiredCheckpointRecords:predecessor.map(item=>item.id)};
  });

  const baseline=await archive();
  for(let i=0;i<2;i++){
    await reset();await page.locator('#looksCorrect').click();await idle();await saved();
    const decision=await record('ordinary decision '+(i+1)+' after the new baseline');
    check(decision.oldReads===0&&decision.unexpectedObjectReads.length===0&&decision.objectEnumerations===0&&decision.reads<250&&!decision.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json'].includes(name)),'decision '+(i+1)+' writes only current review metadata without auditing the retained archive');
  }
  assert.deepEqual(await archive(),baseline);check(true,'ordinary decisions leave the new archive bytes unchanged');
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await saved();
  check(await page.evaluate(()=>a.completion.capture().returned.reported.filter(f=>f.decision?.state==='resolved').length===2),'reopening preserves the decisions made after the new rendering publication');
  await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported[2].id));await idle();
  await reset();await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC remaining correction after initial baseline');await page.locator('#sendCorrectionResponse').click();await idle();await saved();
  await page.locator('#roundSummary').waitFor();await page.locator('#prepareRoundPrompt').waitFor();
  const completed=await record('complete review with one outstanding correction');
  check(completed.oldReads===0&&completed.unexpectedObjectReads.length===0&&completed.objectEnumerations===0&&completed.reads<250&&!completed.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json','task.json'].includes(name)),'finishing an outstanding round saves only its current review without a full history publication');
  await page.waitForTimeout(550);await reset();await page.locator('#prepareRoundPrompt').click();
  await waitUntil(page,()=>!document.querySelector('#sendRemaining').hidden&&!document.querySelector('#sendRemaining').disabled&&!a.folderWorkspace.getState().busy,180000);
  const sent=await record('prepare prompt for the completed outstanding round');
  check(sent.oldReads===0&&sent.unexpectedObjectReads.length===0&&sent.objectEnumerations===0&&sent.reads<250&&!sent.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json'].includes(name)),'preparing the completed-round prompt reads only current task inputs without scanning prior history');
  check(await page.evaluate(async()=>document.querySelector('#nextAIPrompt').value===a.folderWorkspace.savedPrompt()?.text&&JSON.stringify((await a.folderWorkspace.io.getSettings()).head.task).includes('SYNTHETIC remaining correction after initial baseline')),'the completed-round prompt exactly matches the saved latest correction');
  assert.deepEqual(await archive(),baseline);check(true,'round completion and its prompt keep the new archive byte-identical');


  // A failed first publication must stay an explicit pending baseline across
  // restart. Edits remain locally durable; neither autosave nor boot may try
  // applying that new workspace to the preceding archive's current record.
  await page.locator('#dismissRoundSummary').click();
  await page.evaluate(async()=>{
    const create=FileSystemFileHandle.prototype.createWritable;let fail=true;
    FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(fail&&name==='snapshot.json'){fail=false;throw Error('SYNTHETIC initial rendering archive failure');}return write(value);};return stream;};
    const config=await a.folderWorkspace.io.getSettings(),writer=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();await writer.write(await(await import('./qa/fixtures.js')).fixtureBlob('rendered.pdf'));await writer.close();
  });
  await reset();await page.evaluate(()=>a.folderWorkspace.loadLatest());await idle();
  const initialFailure=await record('failed first archive publication of another new rendering');
  const pending=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture();return {marker:config.pendingBaselineWorkspaceId,workspaceId:scene.workspaceId,revisionId:scene.revisionId,returned:scene.returned};});
  check(initialFailure.error.includes('SYNTHETIC initial rendering archive failure')&&pending.marker===pending.workspaceId&&!initialFailure.ready,'a failed initial publication preserves an explicit pending baseline and its actual error');
  assert.deepEqual(await archive(),baseline);check(true,'a failed initial publication preserves the previous committed archive exactly');
  check(await page.locator('#loadProgressDialog').isVisible()&&await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&(await page.locator('#loadProgressDetail').innerText()).includes('SYNTHETIC initial rendering archive failure'),'the failed initial publication keeps its actual error visible in the loading popup');
  await page.locator('#closeLoadProgress').click();
  check(await page.locator('#loadProgressDialog').isHidden()&&await page.locator('#stillCorrection').isEnabled(),'closing the failure popup restores review controls without discarding the pending baseline');
  await reset();await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC note while initial baseline awaits retry');await page.locator('#sendCorrectionResponse').click();await idle();await page.waitForTimeout(450);
  const pendingEdit=await record('local correction while initial baseline awaits retry');
  const pendingState=await page.evaluate(()=>({workspaceId:a.completion.capture().workspaceId,revisionId:a.completion.capture().revisionId,review:a.completion.capture().review,returned:a.completion.capture().returned}));
  check(pendingEdit.oldReads===0&&!pendingEdit.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json','current-review.json'].includes(name)),'a pending-baseline edit is saved locally without trying a checkpoint against the preceding archive');
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await idle();await page.waitForTimeout(450);
  const reopened=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),local=await(await import('./storage.js')).getSaved(scene.workspaceId);return {marker:config.pendingBaselineWorkspaceId,workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned,localReturned:local.returned,error:a.folderWorkspace.getState().error,writes:completionAudit.writes};});
  assert.deepEqual({workspaceId:reopened.workspaceId,revisionId:reopened.revisionId,review:reopened.review,returned:reopened.returned},pendingState);assert.deepEqual(reopened.localReturned,pendingState.returned);
  check(reopened.marker===reopened.workspaceId&&Boolean(reopened.error)&&!reopened.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json','current-review.json'].includes(name)),'restart preserves the exact pending review and asks for explicit retry without background archive writes');
  await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await reset();await page.locator('#statusRetryFolder').click();await idle();await saved();
  const explicitRetry=await record('explicit Retry finishes the pending baseline after restart');
  const recovered=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),metadata=await(await import('./folder-recovery.js')).readRecoveryMetadata(config.directory);return {marker:config.pendingBaselineWorkspaceId,workspaceId:scene.workspaceId,archiveCurrent:metadata.manifest.current,revisionId:scene.revisionId,review:scene.review,returned:scene.returned};});
  assert.deepEqual({workspaceId:recovered.workspaceId,revisionId:recovered.revisionId,review:recovered.review,returned:recovered.returned},pendingState);
  check(!recovered.marker&&recovered.archiveCurrent===recovered.workspaceId&&explicitRetry.writes.filter(({name})=>name==='COMMIT.json').length===1,'explicit Retry commits one matching new-render baseline and retains the note saved before restart');


  // Fail the earlier local completed-version event, before any archive writes.
  // Its persisted boundary descriptor must survive restart and be replayed once.
  const boundaryBefore=await page.evaluate(async()=>{const scene=a.completion.capture(),events=await(await import('./storage.js')).workspaceHistory(scene.workspaceId);return {workspaceId:scene.workspaceId,eventIds:events.map(event=>event.id)};});
  await page.evaluate(async()=>{
    const add=IDBObjectStore.prototype.add;let fail=true;
    IDBObjectStore.prototype.add=function(value,...args){if(fail&&this.name==='reviews'&&['returned-event','review-event'].includes(value?.kind)){fail=false;window.syntheticBoundaryFailure=true;return add.call(this,{...value,id:value.workspaceId},...args);}return add.call(this,value,...args);};
    const config=await a.folderWorkspace.io.getSettings(),writer=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();await writer.write(await(await import('./qa/fixtures.js')).fixtureBlob('multipage.pdf'));await writer.close();
  });
  await reset();await page.evaluate(()=>a.folderWorkspace.loadLatest());await idle();
  const boundaryFailure=await record('failed local completed-version event before initial archive publication');
  const boundaryPending=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture();return {injected:window.syntheticBoundaryFailure,marker:config.pendingBaselineWorkspaceId,boundary:config.pendingVersionBoundary,workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned};});
  check(boundaryPending.injected&&Boolean(boundaryFailure.error)&&boundaryPending.marker===boundaryPending.workspaceId&&boundaryPending.boundary?.workspaceId===boundaryBefore.workspaceId&&!boundaryFailure.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json'].includes(name)),'an early local event failure preserves the pending new review and its exact uncommitted version boundary');
  check(await page.locator('#loadProgressDialog').isVisible()&&await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&(await page.locator('#loadProgressDetail').innerText()).includes('saved locally'),'an interrupted local version event leaves a visible error while keeping the new review saved locally');
  await page.locator('#closeLoadProgress').click();
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await idle();
  await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await reset();await page.locator('#statusRetryFolder').click();await idle();await saved();
  const boundaryRetry=await record('explicit Retry restores the interrupted local version boundary after restart');
  const boundaryRecovered=await page.evaluate(async previous=>{
    const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),events=await(await import('./storage.js')).workspaceHistory(previous.workspaceId);
    return {marker:config.pendingBaselineWorkspaceId,boundary:config.pendingVersionBoundary,workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned,newEvents:events.filter(event=>!previous.eventIds.includes(event.id)).map(event=>({id:event.id,resultingRenderSha256:event.resultingRenderSha256}))};
  },boundaryBefore);
  assert.deepEqual({workspaceId:boundaryRecovered.workspaceId,revisionId:boundaryRecovered.revisionId,review:boundaryRecovered.review,returned:boundaryRecovered.returned},{workspaceId:boundaryPending.workspaceId,revisionId:boundaryPending.revisionId,review:boundaryPending.review,returned:boundaryPending.returned});
  check(!boundaryRecovered.marker&&!boundaryRecovered.boundary&&boundaryRecovered.newEvents.length===1&&boundaryRetry.writes.filter(({name})=>name==='COMMIT.json').length===1,'retry retains the exact new review and writes its interrupted completed-version event and archive exactly once');


  await writeFile(resolve(evidence,'current-baseline-performance.json'),JSON.stringify(report,null,2));
}

export async function exerciseLegacyCurrentBaseline({page,evidence,report,check,reset,record,idle,saved}){
  await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported[0].id));await idle();
  await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC retained legacy correction before new rendering');await page.locator('#sendCorrectionResponse').click();await idle();await saved();
  await page.evaluate(()=>a.folderWorkspace.saveNow());await saved();
  // Reproduce r9's already-stranded binding: it had no explicit pending marker,
  // but head=null and the newly opened local workspace were persisted.
  await page.evaluate(async()=>{
    const create=FileSystemFileHandle.prototype.createWritable;let fail=true;
    FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(fail&&name==='snapshot.json'){fail=false;throw Error('SYNTHETIC legacy first archive failure');}return write(value);};return stream;};
    const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),data=await config.directory.getDirectoryHandle('.scorebrush'),latest=await data.getDirectoryHandle('latest');
    window.legacyOldReady=new Blob([await(await(await latest.getFileHandle('READY.json')).getFile()).arrayBuffer()]);window.legacyOldReadyPinned=Boolean(JSON.parse(await legacyOldReady.text()).currentReview);
    const {fixtureBlob}=await import('./qa/fixtures.js'),{sha256}=await import('./model.js');let next=await fixtureBlob('multipage.pdf');if(await sha256(await next.arrayBuffer())===scene.review.files.rendered.sha256)next=await fixtureBlob('rendered.pdf');
    const writer=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();await writer.write(next);await writer.close();await a.folderWorkspace.loadLatest();
    const restore=await(await latest.getFileHandle('READY.json')).createWritable();await restore.write(legacyOldReady);await restore.close();
    const stranded=await a.folderWorkspace.io.getSettings();if(stranded.head||!stranded.pendingBaselineWorkspaceId)throw Error('Expected interrupted new-render baseline');delete stranded.pendingBaselineWorkspaceId;delete stranded.pendingVersionBoundary;await a.folderWorkspace.io.putSettings(stranded);
  });await idle();
  check(await page.locator('#loadProgressDialog').isVisible()&&await page.locator('#loadProgressDialog').getAttribute('data-state')==='error'&&(await page.locator('#loadProgressDetail').innerText()).includes('SYNTHETIC legacy first archive failure'),'the legacy baseline fixture exposes its initial archive failure in the loading popup');
  await page.locator('#closeLoadProgress').click();
  const legacyPending=await page.evaluate(()=>({workspaceId:a.completion.capture().workspaceId,revisionId:a.completion.capture().revisionId,review:a.completion.capture().review,returned:a.completion.capture().returned}));
  await page.addInitScript(()=>{
    const create=FileSystemFileHandle.prototype.createWritable;let hold=true;
    FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(hold&&name==='snapshot.json'){hold=false;window.legacyArchiveHeld=true;await new Promise(resolve=>window.releaseLegacyArchive=resolve);window.legacyArchiveHeld=false;}return write(value);};return stream;};
  });
  await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await idle();
  report.legacyReopened=await page.evaluate(async()=>({folder:a.folderWorkspace.getState(),configHead:(await a.folderWorkspace.io.getSettings()).head?.id??null}));

  await reset();
  await waitUntil(page,()=>Boolean(window.legacyArchiveHeld)||Boolean(a.folderWorkspace.getState().error),180000);
  if(!await page.evaluate(()=>Boolean(window.legacyArchiveHeld))){await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await page.locator('#statusRetryFolder').click();}
  await waitUntil(page,()=>Boolean(window.legacyArchiveHeld),180000);const legacyLocked=await page.locator('#looksCorrect').isDisabled();await page.evaluate(()=>window.releaseLegacyArchive());await idle();await saved();
  const legacyRetry=await record('repair a legacy headless binding without pending markers');
  const legacyRecovered=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),metadata=await(await import('./folder-recovery.js')).readRecoveryMetadata(config.directory);return {workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned,archiveCurrent:metadata.manifest.current,head:config.head?.id};});
  assert.deepEqual({workspaceId:legacyRecovered.workspaceId,revisionId:legacyRecovered.revisionId,review:legacyRecovered.review,returned:legacyRecovered.returned},legacyPending);
  check(legacyLocked&&Boolean(legacyRecovered.head)&&legacyRecovered.archiveCurrent===legacyRecovered.workspaceId&&legacyRetry.writes.filter(({name})=>name==='COMMIT.json').length===1,'an existing r9 headless binding with old valid READY repairs under the UI lock and commits its exact local review once');

  await writeFile(resolve(evidence,'current-baseline-legacy-performance.json'),JSON.stringify(report,null,2));
}
