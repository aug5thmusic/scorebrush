// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function runInterruptedSave({browser,serve,evidence,root}){
  const server=await serve(root),log=[],runs=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('interrupted-save: '+label);};
  try{
    for(const phase of ['before-file-commit','before-settings-ack'])for(const action of ['saveCheckpoint','saveNow']){
      const context=await browser.newContext(),page=await context.newPage(),label=phase+' / '+action;
      const local=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending);
      const saved=()=>waitUntil(page,()=>{const state=a.folderWorkspace.getState();if(state.error||state.pausedReason)throw Error(state.error||state.pausedReason);return state.ready&&!state.busy;});
      const note=async text=>{await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await local();};
      try{
        await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
        await page.evaluate(async()=>{
          window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js');
          const folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC interrupted save',{create:true});
          for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}
          a.folderWorkspace.io.pickDirectory=async()=>folder;
        });
        await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
        for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
        await page.locator('#folderSetupConfirm').click();await saved();await note('SYNTHETIC original checkpoint');await saved();
        await page.evaluate(async phase=>{
          const config=await a.folderWorkspace.io.getSettings();window.originalCheckpoint=config.currentCheckpointId;window.originalRecovery=config.recoveryId;
          window.interruptPhase=phase;window.blocked=false;window.failure=null;
          window.intentDurability=[];const transaction=IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction=function(names,mode,options){const tx=transaction.call(this,names,mode,options);if(this.name==='private-score-desk-folders-v1'&&mode==='readwrite'&&options?.durability==='strict')intentDurability.push(tx.durability);return tx;};
          const hold=async()=>{window.blocked=true;await new Promise(resolve=>{window.releaseFailure=resolve;});throw Error('SYNTHETIC interrupted checkpoint persistence');};
          const open=FileSystemFileHandle.prototype.createWritable;
          FileSystemFileHandle.prototype.createWritable=async function(...args){const stream=await open.apply(this,args),close=stream.close.bind(stream);if(this.name==='current-review.json')stream.close=async()=>{if(interruptPhase==='before-file-commit')await hold();return close();};return stream;};
          const put=a.folderWorkspace.io.putSettings;
          a.folderWorkspace.io.putSettings=async value=>{if(interruptPhase==='before-settings-ack'&&value.currentCheckpointId!==originalCheckpoint&&!value.pendingCheckpointId)await hold();return put(value);};
        },phase);
        await note('SYNTHETIC checkpoint being published');
        await page.evaluate(action=>{window.operation=a.folderWorkspace[action]().then(()=>{window.failure='unexpected success';},e=>{window.failure=e.message;});},action);
        await waitUntil(page,()=>window.blocked);
        // A real later local save lands while the earlier folder save is held.
        await note('SYNTHETIC newer local edit survives interruption');
        const held=await page.evaluate(async()=>{
          const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),record=await(await import('./storage.js')).getSavedState(scene.workspaceId);
          const disk=await(await import('./current-checkpoint.js')).readCurrentCheckpoint(config.directory);
          window.expected={review:record.review,revisionId:record.revisionId,storageRevision:record.storageRevision};
          return {current:config.currentCheckpointId,pending:config.pendingCheckpointId,disk:disk.id,original:originalCheckpoint,local:record.review.findings.at(-1).comment,revisionId:record.revisionId,intentDurability};
        });
        check(held.current===held.original&&/^[a-f0-9]{64}$/.test(held.pending)&&held.pending!==held.current,label+': intent is durable while the prior acknowledged ID is retained');
        check(held.intentDurability.length>0&&held.intentDurability.every(value=>value==='strict'),label+': intent uses a real IndexedDB transaction with strict durability');
        check(held.disk===(phase==='before-file-commit'?held.current:held.pending)&&held.local==='SYNTHETIC newer local edit survives interruption',label+': correct side of the disk commit coexists with the newer local edit');
        let expected=await page.evaluate(async()=>{
          interruptPhase=null;releaseFailure();await operation;
          return {state:expected,failure,originalRecovery};
        });
        check(expected.failure?.includes('SYNTHETIC interrupted'),label+': interrupted operation reports failure instead of claiming a save');
        if(phase==='before-settings-ack'&&action==='saveCheckpoint'){
          await page.evaluate(()=>{interruptPhase='before-file-commit';blocked=false;failure=null;window.operation=a.folderWorkspace.saveCheckpoint().then(()=>{failure='unexpected success';},e=>{failure=e.message;});});
          await waitUntil(page,()=>window.blocked);await note('SYNTHETIC latest local edit after a second interruption');
          const retry=await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),record=await(await import('./storage.js')).getSavedState(scene.workspaceId),disk=await(await import('./current-checkpoint.js')).readCurrentCheckpoint(config.directory);window.expected={review:record.review,revisionId:record.revisionId,storageRevision:record.storageRevision};return {current:config.currentCheckpointId,pending:config.pendingCheckpointId,disk:disk.id};});
          check(retry.current===held.pending&&retry.disk===held.pending&&retry.pending!==retry.current,label+': an interrupted retry retains the previous pending disk checkpoint as its predecessor');
          expected=await page.evaluate(async()=>{interruptPhase=null;releaseFailure();await operation;return {state:expected,failure,originalRecovery};});
          check(expected.failure?.includes('SYNTHETIC interrupted'),label+': a second interruption preserves the next local edit without claiming success');
        }
        await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));
        await saved();
        const restored=await page.evaluate(async()=>{const scene=a.completion.capture(),config=await a.folderWorkspace.io.getSettings(),storage=await import('./storage.js'),record=await storage.getSavedState(scene.workspaceId),disk=await(await import('./current-checkpoint.js')).readCurrentCheckpoint(config.directory);return {review:record.review,revisionId:record.revisionId,storageRevision:record.storageRevision,pending:config.pendingCheckpointId,current:config.currentCheckpointId,disk:disk.id,diskReview:disk.checkpoint.review,recoveryId:config.recoveryId,history:(await storage.workspaceHistory(scene.workspaceId)).length};});
        runs.push({label,held,expected,restored});
        check(JSON.stringify(restored.review)===JSON.stringify(expected.state.review)&&restored.revisionId===expected.state.revisionId&&restored.storageRevision===expected.state.storageRevision,label+': restart retains the exact newer local review and revision counter');
        assert.deepEqual(restored.diskReview,expected.state.review,label+': exact checkpoint review after validated JSON round trip');
        check(!restored.pending&&restored.current===restored.disk,label+': folder saving resumes and clears the pending identity only after acknowledgement');
        check(restored.recoveryId===expected.originalRecovery&&restored.history===0,label+': recovery does not invent archive generations or edit history');
      }catch(error){await page.screenshot({path:resolve(evidence,'interrupted-save-'+phase+'-'+action+'-failure.png')}).catch(()=>{});throw error;}
      finally{await context.close();}
    }
    return {name:'interrupted-save',assertions};
  }finally{await writeFile(resolve(evidence,'interrupted-save.txt'),log.join('\n'));await writeFile(resolve(evidence,'interrupted-save.json'),JSON.stringify(runs,null,2));await server.close();}
}
