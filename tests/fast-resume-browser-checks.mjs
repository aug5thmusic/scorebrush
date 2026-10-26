// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {checkUnchangedHistoryFallback} from './unchanged-history-fallback-browser-checks.mjs';
import {installResumeAudit,assertCleanAudit,beginClose,finishClose,waitUntil} from './clean-resume-helpers.mjs';

// Real IndexedDB + OPFS controller checks in a disposable browser context.
// The host close transport is simulated; these are not native timing claims.
export async function checkFastResume({browser,server,evidence,check}){
  const context=await browser.newContext(),page=await context.newPage(),errors=[],measurements={};
  page.on('pageerror',error=>errors.push(error.message));await installResumeAudit(page);
  await page.addInitScript(()=>{
    window.fastResumeReads=[];window.fastResumeReadPending=false;
    const read=FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile=async function(...args){
      fastResumeReads.push(this.name);
      if(this.name===localStorage.getItem('SYNTHETIC-fast-resume-hold')){
        localStorage.removeItem('SYNTHETIC-fast-resume-hold');fastResumeReadPending=true;
        await new Promise(resolve=>{window.releaseFastResumeRead=()=>{fastResumeReadPending=false;resolve();};});
      }
      return read.apply(this,args);
    };
  });
  const saved=()=>waitUntil(page,async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().dirty;});
  const local=()=>waitUntil(page,async()=>{const a=await import('./app.js');return !a.sessionStatus().dirty&&!a.sessionStatus().busy;});
  const reload=async()=>{await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');};
  async function note(text){await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await local();}
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      const a=await import('./app.js'),{fixtureBlob}=await import('./qa/fixtures.js'),directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC fast resume',{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const writer=await(await directory.getFileHandle(name,{create:true})).createWritable();await writer.write(await fixtureBlob(name));await writer.close();}
      a.folderWorkspace.io.pickDirectory=async()=>({directory,absolutePath:'C:\\SYNTHETIC fast resume',nativeBinding:'a'.repeat(32)});
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(const text of ['SYNTHETIC first retained note','SYNTHETIC second retained note','SYNTHETIC current note']){await note(text);await saved();}
    const initial=await page.evaluate(async()=>{
      const a=await import('./app.js'),config=await a.folderWorkspace.io.getSettings(),snapshot=await(await import('./folder-recovery.js')).readRecovery(config.directory),m=snapshot.manifest;
      const current=m.records.find(r=>r.id===m.current),head=m.handoffs.find(r=>r.id===m.headTaskId),required=new Set([current,head].flatMap(r=>Object.values(r.payloads).map(i=>i.sha256)));
      const historical=m.records.find(r=>r.history&&r.payloads['annotations.json']&&!required.has(r.payloads['annotations.json'].sha256));
      if(!historical)throw Error('The synthetic fixture needs an unused older annotation object');
      return {proof:config.resumeProof,recoveryId:config.recoveryId,revisionId:a.completion.capture().revisionId,currentHash:current.payloads['annotations.json'].sha256,oldHash:historical.payloads['annotations.json'].sha256,oldText:await snapshot.objects.get(historical.payloads['annotations.json'].sha256).text()};
    });
    assert.equal(initial.proof?.schema,'scorebrush-clean-resume-proof');assert.equal(initial.proof.generationId,initial.recoveryId);
    check(true,'a complete folder save persists a proof tied to its exact committed generation');
    // Seed the exact persisted migration shape: an older folder identity A and
    // independently generated local journal identity B already committed in it.
    // This changes only disposable fixture data before the read-only restart.
    const lineage=await page.evaluate(async()=>{
      const a=await import('./app.js'),storage=await import('./storage.js'),recovery=await import('./folder-recovery.js'),workflow=await import('./workflow.js');
      const config=await a.folderWorkspace.io.getSettings(),snapshot=await recovery.readRecovery(config.directory),record=await storage.getSaved(snapshot.manifest.current),localId=crypto.randomUUID();
      record.projectId=localId;
      await new Promise((resolve,reject)=>{const request=indexedDB.open('private-score-desk-local-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('reviews','readwrite');tx.objectStore('reviews').put(record);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};});
      snapshot.manifest.records.find(r=>r.id===snapshot.manifest.current).projectId=localId;
      const folder=await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery'),generation=await folder.getDirectoryHandle('g-'+snapshot.manifest.id),manifest=workflow.json(snapshot.manifest);
      for(const[name,blob]of [['snapshot.json',manifest],['COMMIT.json',workflow.json({schema:snapshot.manifest.schema,version:1,id:snapshot.manifest.id,manifestSha256:(await workflow.fileInfo(manifest)).sha256})]]){const stream=await(await generation.getFileHandle(name)).createWritable();await stream.write(blob);await stream.close();}
      const versions=await(await import('./pdf-versions.js')).checkPdfVersions(config.directory,snapshot);await(await import('./project-history.js')).syncProjectHistory(config.directory,snapshot,{pdfVersions:versions});
      const proof=await(await import('./fast-resume.js')).captureResumeProof(config,a.completion.capture(),record,snapshot,{pdfVersions:versions});
      if(!proof)throw Error('Valid committed legacy lineage must permit a clean proof');await a.folderWorkspace.io.putSettings({...config,resumeProof:proof});
      return {folderId:config.projectId,localId};
    });
    assert.notEqual(lineage.folderId,lineage.localId);measurements.lineage=lineage;
    check(true,'a legacy folder identity and its explicitly committed local journal identity can differ without being rewritten');
    await reload();await saved();await assertCleanAudit(page);
    const first=await page.evaluate(async()=>({reads:fastResumeReads,state:(await import('./app.js')).folderWorkspace.getState(),revisionId:(await import('./app.js')).completion.capture().revisionId}));
    assert(!first.reads.includes(initial.oldHash));assert.equal(first.state.recoveryId,initial.recoveryId);assert.equal(first.revisionId,initial.revisionId);
    check(true,'ordinary reopen proves the current publication without rereading unused historical annotations or writing project data');
    measurements.clean={readCount:first.reads.length,state:first.state};
    const reopenedLineage=await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),record=await(await import('./storage.js')).getSaved(a.completion.capture().workspaceId);return {localId:record.projectId,folderId:c.projectId};});
    assert.deepEqual(reopenedLineage,lineage);check(true,'ordinary startup preserves both committed identities and becomes ready without automatic folder publication');
    const picked=await page.evaluate(async()=>{
      const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();window.fastResumeReads=[];
      a.folderWorkspace.io.pickDirectory=async()=>({directory:c.directory,absolutePath:c.absolutePath,nativeBinding:c.nativeBinding});
      await a.folderWorkspace.choose({mode:'open'});return {reads:fastResumeReads,state:a.folderWorkspace.getState()};
    });
    assert(!picked.reads.includes(initial.oldHash));assert.equal(picked.state.recoveryId,initial.recoveryId);assert(picked.state.ready);await assertCleanAudit(page);
    check(true,'explicitly reopening the known clean folder verifies its current publication without scanning older annotations');
    await page.evaluate(hash=>localStorage.setItem('SYNTHETIC-fast-resume-hold',hash),initial.currentHash);await reload();
    await page.waitForFunction(()=>fastResumeReadPending);await beginClose(page);
    await page.waitForTimeout(100);
    const held=await page.evaluate(async()=>({ready:(await import('./app.js')).folderWorkspace.getState().ready,replied:closeMessages.some(m=>m.op==='close-result')}));
    assert(!held.ready&&!held.replied);check(true,'required current-byte verification keeps folder readiness and guarded close pending');
    await page.evaluate(()=>releaseFastResumeRead());const closed=await finishClose(page);await saved();await assertCleanAudit(page);
    assert(closed.local&&closed.folder&&closed.idle&&!closed.error);check(true,'guarded close succeeds only after the held current publication proof finishes');
    measurements.close=closed;
    await page.evaluate(async hash=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();await a.folderWorkspace.io.putSettings({...c,resumeProof:null});localStorage.setItem('SYNTHETIC-fast-resume-hold',hash);},initial.currentHash);
    await reload();await page.waitForFunction(()=>fastResumeReadPending);await beginClose(page);await page.waitForTimeout(100);
    const fullHeld=await page.evaluate(async()=>({folder:(await import('./app.js')).folderWorkspace.getState(),label:document.querySelector('#statusLabel').textContent,replied:closeMessages.some(m=>m.op==='close-result')}));
    assert(fullHeld.folder.nativeOpening&&fullHeld.folder.busy&&!fullHeld.folder.ready&&!fullHeld.replied);assert.match(fullHeld.label,/Checking saved history.*\d+\s*\/\s*\d+/);
    check(true,'full startup recovery exposes completed-file progress while current reads and guarded close remain pending');
    await page.evaluate(()=>releaseFastResumeRead());const fullClosed=await finishClose(page);await saved();assert(fullClosed.local&&fullClosed.folder&&fullClosed.idle&&!fullClosed.error);await assertCleanAudit(page);measurements.fullRead={held:fullHeld,closed:fullClosed};
    check(true,'full recovery progress completes before readiness and safe close, without publishing unchanged data');
    await page.evaluate(async hash=>{
      const a=await import('./app.js'),config=await a.folderWorkspace.io.getSettings(),objects=await(await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');
      const writer=await(await objects.getFileHandle(hash)).createWritable();await writer.write(new Blob(['SYNTHETIC damaged unused history']));await writer.close();
    },initial.oldHash);
    await reload();await saved();await assertCleanAudit(page);
    assert(!await page.evaluate(hash=>fastResumeReads.includes(hash),initial.oldHash));
    check(true,'known current readiness does not misrepresent an unused historical object as freshly audited');
    const exported=await page.evaluate(async()=>{try{const result=await(await import('./app.js')).folderWorkspace.portableHistory();return {id:result.baseSnapshot?.manifest.id,damaged:result.baseSnapshot?.damaged??[]};}catch(error){return {error:error.message};}});
    assert(exported.error||exported.id!==initial.recoveryId);assert(await page.evaluate(hash=>fastResumeReads.includes(hash),initial.oldHash));
    check(true,'portable history performs full recovery validation and never exports the damaged generation as verified');
    const paused=await page.evaluate(async()=>{
      const a=await import('./app.js');try{await a.folderWorkspace.reconnect();}catch{}const before=a.folderWorkspace.getState();
      const c=await a.folderWorkspace.io.getSettings();window.fastResumeReads=[];
      a.folderWorkspace.io.pickDirectory=async()=>({directory:c.directory,absolutePath:c.absolutePath,nativeBinding:c.nativeBinding});
      await a.folderWorkspace.choose({mode:'open'});return {before,after:a.folderWorkspace.getState(),reads:fastResumeReads};
    });
    assert(paused.before.pausedReason);assert(!paused.after.ready);assert(paused.reads.includes(initial.oldHash));
    check(true,'a known failed full-history check cannot be cleared by reopening through an older fast proof');
    // Restore only the synthetic connection flag to independently exercise an
    // ordinary fresh edit after deferred corruption, without a pre-known pause.
    await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings();await a.folderWorkspace.io.putSettings({...c,pausedReason:null});});
    await reload();await saved();
    await note('SYNTHETIC edit after historical corruption');
    const attempted=await page.evaluate(async()=>{const a=await import('./app.js');let error;try{await a.folderWorkspace.saveNow();}catch(e){error=e.message;}return {error,state:a.folderWorkspace.getState(),commits:resumeAudit.closes.filter(name=>name==='COMMIT.json').length,revisionId:a.completion.capture().revisionId};});
    assert(attempted.error);assert.equal(attempted.commits,0);assert(!attempted.state.ready);assert.notEqual(attempted.revisionId,initial.revisionId);
    check(true,'a genuine edit revalidates retained history and cannot commit through historical corruption');
    await beginClose(page);const blocked=await finishClose(page);assert(blocked.local&&!blocked.folder&&blocked.error);
    check(true,'historical corruption preserves local edits while guarded close exposes folder recovery');
    measurements.export=exported;measurements.blocked=blocked;measurements.save=attempted;
    check(!errors.length,'fast resume and deferred-history checks produce no uncaught browser errors');
  }catch(error){measurements.failure=error.stack;measurements.state=await page.evaluate(async()=>({reads:fastResumeReads,audit:resumeAudit,state:(await import('./app.js')).folderWorkspace.getState()})).catch(()=>null);await page.screenshot({path:resolve(evidence,'fast-resume-failure.png')}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'fast-resume-browser.json'),JSON.stringify(measurements,null,2));await context.close();}
  await checkUnchangedHistoryFallback({browser,server,check});
}
export async function runFastResume({browser,serve,evidence,root}){
  const server=await serve(root),log=[];let assertions=0;const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('fast-resume: '+label);};
  try{await checkFastResume({browser,server,evidence,check});return {name:'fast-resume',assertions};}catch(error){log.push('FAIL '+error.stack);throw error;}finally{await writeFile(resolve(evidence,'fast-resume.txt'),log.join('\n'));await server.close();}
}


