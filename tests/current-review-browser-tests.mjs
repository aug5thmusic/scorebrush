// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,waitUntil,beginClose,finishClose} from './clean-resume-helpers.mjs';
export async function runCurrentReview({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[],timings=[];let assertions=0;
  const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);console.log('current-review: '+label);};
  await installResumeAudit(page);
  await page.addInitScript(()=>{const create=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(name==='current-review.json'){if(window.failCheckpoint)throw Error('SYNTHETIC checkpoint failure');if(window.delayCheckpoint){window.checkpointPending=true;await new Promise(resolve=>{window.releaseCheckpoint=resolve;});window.checkpointPending=false;}}return write(value);};return stream;};});
  const local=()=>waitUntil(page,()=>!window.a.sessionStatus().busy&&!window.a.sessionStatus().dirty&&!window.a.corrections.state().pending);
  const saved=()=>waitUntil(page,()=>{const f=window.a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy;});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');window.fixtureBlob=(await import('./qa/fixtures.js')).fixtureBlob;
      window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC current review',{create:true});
      for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(let i=1;i<=4;i++){await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC correction '+i);await page.locator('#saveFinding').click();await local();}
    await saved();
    check(await page.evaluate(async()=>{const s=a.completion.capture();return (await(await import('./storage.js')).workspaceHistory(s.workspaceId)).length===0;}),'ordinary findings create no permanent history records');
    await page.evaluate(async()=>{const w=await(await folder.getFileHandle('rendered.pdf')).createWritable();await w.write(await fixtureBlob('rendered.pdf'));await w.close();await a.folderWorkspace.loadLatest();});await local();await saved();
    check(await page.evaluate(()=>a.completion.capture().returned.reported.length===4),'Load latest opens the new rendering with all four corrections');
    await page.evaluate(async()=>{window.before={recoveryId:a.folderWorkspace.getState().recoveryId,events:(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId)).length};resumeAudit.writes=[];resumeAudit.closes=[];window.checkpointWrites=0;const create=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await create.apply(this,args),write=stream.write.bind(stream),name=this.name;stream.write=async value=>{if(name==='current-review.json'){checkpointWrites++;if(window.failCheckpoint)throw Error('SYNTHETIC checkpoint failure');}return write(value);};return stream;};});
    for(let i=0;i<4;i++){const start=Date.now();await page.locator('#looksCorrect').click();await local();timings.push(Date.now()-start);await saved();}
    await page.waitForFunction(()=>document.querySelector('#roundSummary').open);
    const state=await page.evaluate(async()=>({folder:a.folderWorkspace.getState(),events:(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId)).length,writes:resumeAudit.writes.map(w=>w.name),before,checkpointWrites}));
    check(state.folder.recoveryId===state.before.recoveryId&&state.events===state.before.events,'four approvals and completion do not append archive generations or event records');
    check(state.checkpointWrites>0&&!state.writes.some(n=>['snapshot.json','History.json','task.json','manifest.json','COMMIT.json'].includes(n)),'approvals save current metadata without rebuilding AI packages or file history');
    await page.waitForFunction(()=>!document.querySelector('#summaryFolderFiles').disabled);
    check(await page.locator('#roundSummaryTitle').innerText()==='Review complete','completed round publishes its current numbered finished PDF');
    await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await saved();
    check(await page.evaluate(()=>a.completion.capture().returned.reported.every(f=>f.state==='resolved')&&resumeAudit.writes.length===0),'checkpoint-only reopen restores approvals without writing history or AI files');
    await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported.at(-1).id));await local();
    await page.evaluate(()=>window.failCheckpoint=true);await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC remaining problem');await page.locator('#sendCorrectionResponse').click();await local();await waitUntil(page,()=>Boolean(a.folderWorkspace.getState().error));
    check(await page.evaluate(()=>a.completion.capture().returned.reported.at(-1).state==='open'),'folder failure keeps the local decision');
    await page.evaluate(async()=>{window.failCheckpoint=false;await a.folderWorkspace.saveCheckpoint();});await saved();
    check(await page.evaluate(()=>!a.folderWorkspace.savedPrompt()),'an edited completed round never exposes a stale AI prompt');
    if(await page.locator('#roundSummary').isVisible())await page.locator('#dismissRoundSummary').click();
    // Remove only this disposable test profile's review records. Its folder
    // checkpoint must recover current decisions through the normal Open path.
    await page.evaluate(async()=>{await new Promise((resolve,reject)=>{const request=indexedDB.open('private-score-desk-local-v1');request.onsuccess=()=>{const db=request.result,tx=db.transaction('reviews','readwrite');tx.objectStore('reviews').clear();tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};request.onerror=()=>reject(request.error);});});
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>{window.a=await import('./app.js');const config=await a.folderWorkspace.io.getSettings();a.folderWorkspace.io.pickDirectory=async()=>config.directory;await a.folderWorkspace.choose();});await saved();
    check(await page.evaluate(()=>a.completion.capture().returned.reported.at(-1).explanation==='SYNTHETIC remaining problem'),'folder-only recovery restores the current checkpoint after local review storage is lost');
    if(await page.locator('#roundSummary').isVisible())await page.locator('#dismissRoundSummary').click();
    await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported.at(-1).id));await local();
    await page.evaluate(()=>{window.delayCheckpoint=true;resumeAudit.writes=[];resumeAudit.closes=[];});
    await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC remaining problem, updated draft');await local();
    const persistedDraft=await page.evaluate(async()=>{const scene=a.completion.capture(),record=await(await import('./storage.js')).getSavedState(scene.workspaceId);window.checkpointSave=a.folderWorkspace.saveCheckpoint();return record.returned.reported.at(-1).explanation;});
    await waitUntil(page,()=>window.checkpointPending===true);
    await page.evaluate(()=>{window.publicationSettled=false;window.publicationResult=null;window.publicationRace=Promise.all([a.folderWorkspace.saveNow(),a.folderWorkspace.saveNow()]).then(results=>{publicationResult={ids:results.map(entry=>entry?.id)};},error=>{publicationResult={error:error.message};}).finally(()=>{publicationSettled=true;});});
    const held=await page.evaluate(()=>({pending:checkpointPending,settled:publicationSettled,writes:resumeAudit.writes.map(write=>write.name)}));
    check(persistedDraft==='SYNTHETIC remaining problem, updated draft'&&held.pending&&!held.settled&&!held.writes.some(name=>name==='COMMIT.json'||name==='task.json'),'concurrent Send to AI callers wait behind a real persisted draft checkpoint');
    await page.evaluate(()=>{window.delayCheckpoint=false;releaseCheckpoint();});await waitUntil(page,()=>window.publicationSettled);
    const publication=await page.evaluate(async()=>{await checkpointSave;const config=await a.folderWorkspace.io.getSettings();return {...publicationResult,head:config.head.id,commits:resumeAudit.closes.filter(name=>name==='COMMIT.json').length,tasks:resumeAudit.closes.filter(name=>name==='task.json').length};});
    check(!publication.error&&publication.ids?.length===2&&publication.ids.every(id=>id===publication.head)&&publication.commits===0&&publication.tasks===1,'checkpoint preflight race publishes one task shared by both callers without an archive commit');
    await writeFile(resolve(evidence,'current-review-publication-race.json'),JSON.stringify({persistedDraft,held,publication},null,2));
    await page.evaluate(()=>a.folderWorkspace.openPrompt());await waitUntil(page,()=>Boolean(a.folderWorkspace.savedPrompt()));
    check(await page.locator('#copyFolderPrompt').isEnabled(),'explicit Send to AI publishes the current completed-round prompt');
    await page.locator('#closeFolderPrompt').click();await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await saved();
    check(await page.evaluate(()=>a.completion.capture().returned.reported.at(-1).state==='open'),'saved review survives reopen');
    await page.evaluate(()=>{resumeAudit.writes=[];});await beginClose(page);const close=await finishClose(page);
    check(close.local&&close.folder&&close.idle&&!close.error,'guarded close confirms local and current-folder saves');
    check(await page.evaluate(()=>resumeAudit.writes.length===0),'clean close does not republish history or AI files');
    const repaired=await page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),before=a.completion.capture(),storage=await import('./storage.js');
      const events=(await storage.workspaceHistory(before.workspaceId)).map(item=>item.id);
      await config.directory.removeEntry('History.json');
      await a.folderWorkspace.saveNow({refreshOutput:true});
      const after=a.completion.capture(),next=await a.folderWorkspace.io.getSettings();
      const history=JSON.parse(await(await(await config.directory.getFileHandle('History.json')).getFile()).text());
      return {advanced:next.recoveryId!==config.recoveryId,sameReview:JSON.stringify(before.review)===JSON.stringify(after.review),
        sameEvents:JSON.stringify(events)===JSON.stringify((await storage.workspaceHistory(after.workspaceId)).map(item=>item.id)),
        currentRevision:history.project.current.revisionId,revisionId:after.revisionId};
    });
    check(repaired.advanced&&repaired.sameReview&&repaired.sameEvents&&repaired.currentRevision===repaired.revisionId,'explicit output repair publishes missing history with the exact current review and no invented edit events');
    await page.evaluate(async()=>{
      cancelTestClose();const cp=await import('./current-checkpoint.js'),config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture();
      await cp.writeCurrentCheckpoint(config.directory,scene,config);a.folderWorkspace.io.pickDirectory=async()=>config.directory;await a.folderWorkspace.choose();
      const selected=await a.folderWorkspace.io.getSettings(),foreign={...a.completion.capture(),review:structuredClone(scene.review),returned:structuredClone(scene.returned),revisionId:crypto.randomUUID(),persistedRevision:scene.persistedRevision+1};
      const f=foreign.returned.reported.at(-1);f.explanation='SYNTHETIC foreign review';f.decision.explanation=f.explanation;
      const result=await cp.writeCurrentCheckpoint(selected.directory,foreign,selected);window.foreignId=result.id;await a.folderWorkspace.choose();
      window.foreignResult=await cp.readCurrentCheckpoint(selected.directory);
    });
    const foreignCheck=await page.evaluate(()=>({folder:a.folderWorkspace.getState(),local:a.completion.capture().returned.reported.at(-1).explanation,disk:foreignResult.checkpoint.returned.reported.at(-1).explanation,foreignId,actualId:foreignResult.id}));
    await writeFile(resolve(evidence,'current-review-foreign.json'),JSON.stringify(foreignCheck,null,2));
    check((foreignCheck.folder.loadError||foreignCheck.folder.error||foreignCheck.folder.pausedReason)&&foreignCheck.local==='SYNTHETIC remaining problem, updated draft'&&foreignCheck.actualId===foreignCheck.foreignId&&foreignCheck.disk==='SYNTHETIC foreign review','reconnecting a foreign newer checkpoint preserves both differing reviews');
    await writeFile(resolve(evidence,'current-review-timing.json'),JSON.stringify({timings,state,close},null,2));
    return {name:'current-review',assertions};
  }catch(error){await page.screenshot({path:resolve(evidence,'current-review-failure.png')}).catch(()=>{});log.push(error.stack);throw error;}
  finally{await writeFile(resolve(evidence,'current-review.txt'),log.join('\n'));await context.close();await server.close();}
}

