// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,beginClose,finishClose,waitUntil,folderSnapshot,assertCleanAudit} from './clean-resume-helpers.mjs';

// Real IndexedDB/OPFS and JS guarded close, with only native transport simulated.
export async function checkBlockedRetryOverlap({browser,server,evidence,check}){
  for(const editDuringRead of [false,true]){
    const context=await browser.newContext(),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await installResumeAudit(page);
    const label=editDuringRead?'new edit during retry':'pending edit before retry';
    const local=()=>waitUntil(page,async()=>{const a=await import('./app.js');return !a.sessionStatus().dirty&&!a.sessionStatus().busy;});
    const saved=()=>waitUntil(page,async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().dirty;});
    const reload=async()=>{await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');};
    async function note(text){await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await local();}
    try{
      await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
      await page.evaluate(async()=>{
        const a=await import('./app.js'),{fixtureBlob}=await import('./qa/fixtures.js'),d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC overlapping retry',{create:true});
        for(const name of ['source.pdf','rendered.pdf','score.ly']){const w=await(await d.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(name));await w.close();}
        a.folderWorkspace.io.pickDirectory=async()=>({directory:d,absolutePath:'C:\\SYNTHETIC overlapping retry',nativeBinding:'a'.repeat(32)});
      });
      await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
      for(const [id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
      await page.locator('#folderSetupConfirm').click();await saved();await note('SYNTHETIC original');await saved();
      await page.evaluate(async()=>{const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),v=await c.directory.getDirectoryHandle('Versions'),w=await(await v.getFileHandle('0001 - RENDERED.pdf',{create:true})).createWritable();await w.write('SYNTHETIC alias to preserve');await w.close();});
      await reload();await waitUntil(page,async()=>/ambiguous owned filename/.test((await import('./app.js')).folderWorkspace.getState().error));
      await note('SYNTHETIC pending before retry');
      await page.evaluate(async()=>{
        const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),v=await c.directory.getDirectoryHandle('Versions'),alias=await(await v.getFileHandle('0001 - RENDERED.pdf')).getFile();
        const w=await(await c.directory.getFileHandle('SYNTHETIC preserved alias.pdf',{create:true})).createWritable();await w.write(alias);await w.close();await v.removeEntry('0001 - RENDERED.pdf');
        window.retryBefore=await(await import('./folder-recovery.js')).readRecovery(c.directory);window.retryWrites=[];window.retryTasks=[];
        const create=FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable=async function(...args){const name=this.name,w=await create.apply(this,args),write=w.write.bind(w);w.write=async value=>{if(name==='snapshot.json')retryWrites.push(JSON.parse(await value.text()));if(name==='task.json')retryTasks.push(JSON.parse(await value.text()).id);return write(value);};return w;};
        let release;window.retryHeld=true;window.retryReads=0;const gate=new Promise(r=>release=r);window.releaseRetry=()=>{retryHeld=false;release();};
        const get=FileSystemFileHandle.prototype.getFile;
        FileSystemFileHandle.prototype.getFile=async function(...args){if(this.name==='snapshot.json'&&retryHeld){retryReads++;await gate;}return get.apply(this,args);};
        window.retryResult=a.folderWorkspace.saveNow().then(v=>({id:v?.id}),e=>({error:e.message}));
        window.retryImmediatelyBusy=a.folderWorkspace.getState().busy;
        window.retryAutosaves=0;const schedule=window.setTimeout.bind(window);
        window.setTimeout=(callback,delay,...args)=>delay!==1100?schedule(callback,delay,...args):schedule(()=>{retryAutosaves++;callback(...args);},delay);
      });
      await page.waitForFunction(()=>window.retryReads>0);
      check(await page.evaluate(()=>retryImmediatelyBusy),label+': retry is busy before its first asynchronous filesystem read');
      if(editDuringRead)await note('SYNTHETIC newer edit while preflight is held');
      const expected=await page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),h=await import('./storage.js');return {review:s.review,revisionId:s.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId))};});
      await beginClose(page);
      // The second scenario lets changed()'s real 1100 ms autosave timer fire
      // while Retry and Close remain pending on the same read gate.
      await page.waitForTimeout(1350);
      if(editDuringRead)check(await page.evaluate(()=>retryAutosaves===1),label+': the actual autosave timer fires while retry preflight is held');
      await page.evaluate(async()=>{const a=await import('./app.js');window.joinRetry=a.folderWorkspace.saveNow().then(v=>({id:v?.id}),e=>({error:e.message}));window.joinRefresh=a.folderWorkspace.saveNow({refreshOutput:true}).then(v=>({id:v?.id}),e=>({error:e.message}));});
      check(await page.evaluate(async()=>!(window.closeMessages??[]).some(m=>m.op==='close-result')&&retryWrites.length===0&&(await import('./app.js')).folderWorkspace.getState().busy),label+': close and concurrent retry/refresh cannot pass the held preflight or publish early');
      await page.evaluate(()=>releaseRetry());const close=await finishClose(page);await saved();
      const outcome=await page.evaluate(async()=>{
        const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),h=await import('./storage.js'),r=await(await import('./folder-recovery.js')).readRecovery(c.directory);
        async function jsonAt(path){let d=c.directory;const p=path.split('/');for(const n of p.slice(0,-1))d=await d.getDirectoryHandle(n);return JSON.parse(await(await(await d.getFileHandle(p.at(-1))).getFile()).text());}
        const current=r.manifest.records.find(x=>x.id===r.manifest.current),annotations=JSON.parse(await r.objects.get(current.payloads['annotations.json'].sha256).text());
        return {results:await Promise.all([retryResult,joinRetry,joinRefresh]),writes:retryWrites.map(x=>({id:x.id,sequence:x.sequence,headTaskId:x.headTaskId})),tasks:retryTasks,
          before:{id:retryBefore.manifest.id,sequence:retryBefore.manifest.sequence},recovery:{id:r.manifest.id,sequence:r.manifest.sequence,task:r.manifest.headTaskId},
          settings:{recovery:c.recoveryId,task:c.head.id,pending:c.pendingHead??null},live:a.folderWorkspace.getState(),ready:await jsonAt('.scorebrush/latest/READY.json'),task:await jsonAt('.scorebrush/latest/task.json'),annotations,
          revisionId:s.revisionId,journal:JSON.stringify(await h.workspaceHistory(s.workspaceId)),clean:Boolean(await(await import('./folder-workspace.js')).verifySavedFolder(c,s,await h.getSaved(s.workspaceId),r,{addDirectoryPath:false,absolutePath:c.absolutePath}))};
      });
      assert.equal(outcome.writes.length,1);assert.equal(outcome.tasks.length,1);assert.equal(outcome.recovery.sequence,outcome.before.sequence+1);
      assert.equal(outcome.settings.recovery,outcome.recovery.id);assert.equal(outcome.settings.pending,null);
      for(const id of [outcome.settings.task,outcome.live.headTaskId,outcome.ready.taskId,outcome.task.id,...outcome.results.map(r=>r.id)])assert.equal(id,outcome.recovery.task);
      check(outcome.clean&&close.local&&close.folder&&close.idle&&!close.error,label+': one coherent publication joins recovery, settings, READY, live and retry task identities before successful close');
      assert.deepEqual(outcome.annotations,expected.review);assert.equal(outcome.revisionId,expected.revisionId);assert.equal(outcome.journal,expected.journal);
      check(true,label+': exact pending notes, revision and durable edit journal survive without fabricated edits');
      const before=await folderSnapshot(page);await reload();await beginClose(page);const reopened=await finishClose(page);await saved();
      assert.deepEqual(await folderSnapshot(page),before);const audit=await assertCleanAudit(page);
      check(reopened.local&&reopened.folder&&reopened.idle&&!reopened.error,label+': next reopen/close performs zero publication with all files and identities unchanged');
      check(!errors.length,label+': no uncaught browser errors');
      await writeFile(resolve(evidence,'blocked-retry-'+(editDuringRead?'changed':'pending')+'.json'),JSON.stringify({close,reopened,outcome,audit},null,2));
    }catch(e){await page.screenshot({path:resolve(evidence,'blocked-retry-failure.png')}).catch(()=>{});throw e;}
    finally{await context.close();}
  }
}
