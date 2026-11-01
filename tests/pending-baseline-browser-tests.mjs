// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function runPendingBaseline({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report={},log=[];let assertions=0;
  const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);};
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const idle=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.folderWorkspace.getState().busy,180000);
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||s.saveConflict||s.saveFailed)throw Error(f.error||'Local save failed');return f.ready&&!f.busy&&!s.busy&&!s.dirty;},180000);
  const capture=()=>page.evaluate(async()=>{
    const scene=a.completion.capture(),config=await a.folderWorkspace.io.getSettings();
    return {workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned,completions:scene.completions,
      connectionId:config.connectionId,projectId:config.projectId,recoveryId:config.recoveryId,pendingBaselineWorkspaceId:config.pendingBaselineWorkspaceId,state:a.folderWorkspace.getState()};
  });
  const archive=()=>page.evaluate(async()=>{
    const config=await a.folderWorkspace.io.getSettings(),data=await config.directory.getDirectoryHandle('.scorebrush'),generation=await(await data.getDirectoryHandle('recovery')).getDirectoryHandle('g-'+config.recoveryId),{sha256}=await import('./model.js');
    return {id:config.recoveryId,commit:await sha256(await(await(await generation.getFileHandle('COMMIT.json')).getFile()).arrayBuffer()),manifest:await sha256(await(await(await generation.getFileHandle('snapshot.json')).getFile()).arrayBuffer())};
  });
  const reviewState=value=>({workspaceId:value.workspaceId,revisionId:value.revisionId,review:value.review,returned:value.returned,completions:value.completions});
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const fixture=(await import('./qa/fixtures.js')).fixtureBlob,folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC pending baseline reopen',{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixture(name));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();report.initial=await capture();report.archive=await archive();
    await page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),w=await(await config.directory.getFileHandle('score.ly')).createWritable();await w.write(new Blob(['% SYNTHETIC new baseline\n\\version "2.24.3"\n{e4 f4}']));await w.close();
      const create=FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='snapshot.json')throw Error('SYNTHETIC interrupted baseline archive');return create.apply(this,args);};
      try{await a.folderWorkspace.loadLatest();}finally{FileSystemFileHandle.prototype.createWritable=create;}
    });await idle();report.pending=await capture();
    check(report.pending.workspaceId!==report.initial.workspaceId&&report.pending.pendingBaselineWorkspaceId===report.pending.workspaceId&&report.pending.state.error.includes('SYNTHETIC interrupted baseline archive'),'failed folder publication retains the new local workspace and pending baseline');
    assert.deepEqual(await archive(),report.archive);check(true,'failed publication preserves the previous committed archive bytes');
    await page.reload();await boot();await idle();report.restarted=await capture();assert.deepEqual(reviewState(report.restarted),reviewState(report.pending));
    check(report.restarted.pendingBaselineWorkspaceId===report.pending.workspaceId,'restart preserves the exact pending baseline identity');
    await page.evaluate(id=>{document.querySelector('#saved').value=id;document.querySelector('#reopen').click();},report.initial.workspaceId);
    await page.waitForFunction(id=>a.completion.capture().workspaceId===id&&!a.sessionStatus().busy&&!a.folderWorkspace.getState().busy,report.initial.workspaceId,{timeout:180000});
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings();a.folderWorkspace.io.pickDirectory=async()=>config.directory;await a.folderWorkspace.choose({mode:'open'});});await idle();report.reopened=await capture();
    assert.deepEqual(reviewState(report.reopened),reviewState(report.pending));
    check(report.reopened.connectionId===report.initial.connectionId&&report.reopened.projectId===report.initial.projectId&&report.reopened.state.bound&&!report.reopened.state.loadError,'Open Project restores the pending workspace with the original folder/project binding');
    check(report.reopened.pendingBaselineWorkspaceId===report.pending.workspaceId&&!report.reopened.state.ready,'reopening keeps publication pending until explicit Retry');
    assert.deepEqual(await archive(),report.archive);check(true,'reopening does not alter or replace previous archive history');
    await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await page.locator('#statusRetryFolder').click();await idle();await saved();report.repaired=await capture();
    assert.deepEqual(reviewState(report.repaired),reviewState(report.pending));
    check(!report.repaired.pendingBaselineWorkspaceId&&report.repaired.recoveryId!==report.archive.id,'explicit Retry commits the pending baseline without changing its review or revision');
    await page.reload();await boot();await saved();report.final=await capture();assert.deepEqual(reviewState(report.final),reviewState(report.pending));check(true,'repaired pending workspace survives a second restart');
    return {name:'pending-baseline',assertions};
  }catch(error){report.failure=error.stack;throw error;}
  finally{await writeFile(resolve(evidence,'pending-baseline.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,'pending-baseline.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
