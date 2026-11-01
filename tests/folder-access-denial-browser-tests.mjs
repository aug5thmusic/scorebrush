// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function runFolderAccessDenial({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);};
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{window.a=await import('./app.js');const fixture=(await import('./qa/fixtures.js')).fixtureBlob;window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC denied children',{create:true});for(const [name,f]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixture(f));await w.close();}a.folderWorkspace.io.pickDirectory=async()=>folder;});
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();for(const [id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);await page.locator('#folderSetupConfirm').click();await saved();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC previous durable checkpoint');await page.locator('#saveFinding').click();await saved();
    const denials=await page.evaluate(async()=>{
      const module=await import('./folder-workspace.js'),settings=await a.folderWorkspace.io.getSettings(),before=settings.currentCheckpointId;
      await folder.getDirectoryHandle('SYNTHETIC blocked child',{create:true});
      const originalEntries=FileSystemDirectoryHandle.prototype.entries,originalRead=FileSystemFileHandle.prototype.getFile;
      let enumeration=false,read=false;
      try{FileSystemDirectoryHandle.prototype.entries=async function*(){if(this.name==='SYNTHETIC blocked child')throw new DOMException('SYNTHETIC child enumeration denied','NotAllowedError');yield* originalEntries.call(this);};await module.scanWorkspace(folder);}catch(e){enumeration=e.name==='NotAllowedError';}finally{FileSystemDirectoryHandle.prototype.entries=originalEntries;}
      try{FileSystemFileHandle.prototype.getFile=async function(){if(this.name==='source.pdf')throw new DOMException('SYNTHETIC child read denied','NotAllowedError');return originalRead.call(this);};await module.readWorkspaceFiles(folder,settings.paths);}catch(e){read=e.name==='NotAllowedError';}finally{FileSystemFileHandle.prototype.getFile=originalRead;}
      window.priorCheckpoint=before;window.originalWrite=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='current-review.json')throw new DOMException('SYNTHETIC checkpoint write denied','NotAllowedError');return originalWrite.apply(this,args);};
      return {enumeration,read,before,after:(await a.folderWorkspace.io.getSettings()).currentCheckpointId};
    });
    check(denials.enumeration&&denials.read&&denials.before===denials.after,'access-denied child enumeration/read propagate without changing the prior committed checkpoint');
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC local pending work survives denied write');await page.locator('#saveFinding').click();
    await waitUntil(page,()=>!a.sessionStatus().dirty&&!a.sessionStatus().busy);
    const failure=await page.evaluate(async()=>{let error;try{await a.folderWorkspace.saveCheckpoint();}catch(e){error=e.message;}const config=await a.folderWorkspace.io.getSettings(),disk=await(await import('./current-checkpoint.js')).readCurrentCheckpoint(config.directory),scene=a.completion.capture(),stored=await(await import('./storage.js')).getSavedState(scene.workspaceId);return {error,current:config.currentCheckpointId,disk:disk.id,prior:priorCheckpoint,local:stored.review.findings.at(-1).comment,state:a.folderWorkspace.getState(),status:document.querySelector('#statusLabel').textContent};});
    check(Boolean(failure.error)&&failure.current===failure.prior&&failure.disk===failure.prior,'denied write reports failure and preserves the prior disk commit');
    check(!failure.state.ready&&!/Saved to folder/i.test(failure.status)&&failure.local==='SYNTHETIC local pending work survives denied write','denied write has no false saved status and retains local pending work');
    await page.evaluate(async()=>{FileSystemFileHandle.prototype.createWritable=originalWrite;await a.folderWorkspace.saveCheckpoint();});await saved();
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));await saved();
    check(await page.evaluate(()=>a.completion.capture().review.findings.at(-1).comment==='SYNTHETIC local pending work survives denied write'),'ordinary synthetic project saves and reconnects after access returns');
    await writeFile(resolve(evidence,'folder-access-denial.json'),JSON.stringify({browserVersion:browser.version(),scope:'Installed Stable Edge, isolated OPFS project, injected NotAllowedError. Error-handling evidence only; not WebView2 v159 enforcement acceptance.',denials,failure},null,2));
    return {name:'folder-access-denial',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'folder-access-denial-failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'folder-access-denial.txt'),log.join('\n'));await context.close();await server.close();}
}
