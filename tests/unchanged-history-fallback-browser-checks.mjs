// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {waitUntil,installResumeAudit} from './clean-resume-helpers.mjs';

// Add history without changing the current scene, so falling back to its parent
// really does pass recoveryMatches and cannot be rejected merely as a new edit.
export async function checkUnchangedHistoryFallback({browser,server,check}){
  const context=await browser.newContext(),page=await context.newPage();await installResumeAudit(page);
  const saved=()=>waitUntil(page,async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().dirty;});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      const a=await import('./app.js'),{fixtureBlob}=await import('./qa/fixtures.js'),directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC unchanged fallback',{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const writer=await(await directory.getFileHandle(name,{create:true})).createWritable();await writer.write(await fixtureBlob(name));await writer.close();}
      a.folderWorkspace.io.pickDirectory=async()=>({directory,absolutePath:'C:\\SYNTHETIC unchanged fallback',nativeBinding:'b'.repeat(32)});
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();for(const[id,name]of[['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);await page.locator('#folderSetupConfirm').click();await saved();
    const fixture=await page.evaluate(async()=>{
      const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),record=await(await import('./storage.js')).getSaved(s.workspaceId),{readRecovery,recoveryMatches}=await import('./folder-recovery.js'),{json,fileInfo}=await import('./workflow.js'),{makeRecovery}=await import('./export.js');
      const before=await readRecovery(c.directory),oldReview=structuredClone(s.review);oldReview.updatedAt='2020-01-01T00:00:00.000Z';oldReview.findings=[{id:crypto.randomUUID(),number:1,page:1,comment:'SYNTHETIC independently retained older evidence',state:'open',type:'correction',color:'#ffd34d',strokes:[],bounds:null}];oldReview.nextNumber=2;
      const payloads=await makeRecovery(oldReview,s.files),declarations={};for(const[path,blob]of payloads)declarations[path]=await fileInfo(blob);
      const bundle={id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,missingData:[]},manifest={...structuredClone(before.manifest),id:crypto.randomUUID(),parent:before.manifest.id,sequence:before.manifest.sequence+1,legacyEvidence:[...(before.manifest.legacyEvidence??[]),bundle]},objects=new Map(before.objects);
      async function write(path,blob){let dir=c.directory;const parts=path.split('/');for(const name of parts.slice(0,-1))dir=await dir.getDirectoryHandle(name,{create:true});const writer=await(await dir.getFileHandle(parts.at(-1),{create:true})).createWritable();await writer.write(blob);await writer.close();}
      for(const[path,blob]of payloads){objects.set(declarations[path].sha256,blob);await write('.scorebrush/recovery/objects/'+declarations[path].sha256,blob);}
      const blob=json(manifest);await write('.scorebrush/recovery/g-'+manifest.id+'/snapshot.json',blob);await write('.scorebrush/recovery/g-'+manifest.id+'/COMMIT.json',json({schema:manifest.schema,version:1,id:manifest.id,manifestSha256:(await fileInfo(blob)).sha256}));
      const snapshot={manifest,objects},versions=await(await import('./pdf-versions.js')).syncPdfVersions(c.directory,snapshot);await(await import('./project-history.js')).syncProjectHistory(c.directory,snapshot,{pdfVersions:versions.versions});await(await import('./finished-pdf.js')).syncFinishedPDF(c.directory,snapshot,{pdfVersions:versions.versions});
      const next={...c,recoveryId:manifest.id,resumeProof:null};if(!await(await import('./folder-workspace.js')).verifySavedFolder(next,s,record,snapshot))throw Error('Synthetic unchanged-history publication failed full verification');
      next.resumeProof=await(await import('./fast-resume.js')).captureResumeProof(next,s,record,snapshot,{pdfVersions:versions.versions});if(!next.resumeProof)throw Error('Synthetic unchanged-history proof missing');await a.folderWorkspace.io.putSettings(next);
      await write('.scorebrush/recovery/objects/'+declarations['annotations.json'].sha256,new Blob(['SYNTHETIC damaged additional legacy history']));
      const fallback=await readRecovery(c.directory);if(fallback.manifest.id!==before.manifest.id||!await recoveryMatches(fallback,s))throw Error('Fixture must have a valid older generation with an identical current scene');
      return {expected:manifest.id,parent:before.manifest.id,revisionId:s.revisionId};
    });
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await saved();
    const output=await page.evaluate(async()=>{
      const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),{sha256}=await import('./model.js');
      async function history(){return sha256(await(await(await c.directory.getFileHandle('History.json')).getFile()).arrayBuffer());}
      const before=await history();let error;try{await a.folderWorkspace.saveNow({refreshOutput:true});}catch(e){error=e.message;}
      return {before,after:await history(),error,state:a.folderWorkspace.getState(),writes:resumeAudit.writes,config:await a.folderWorkspace.io.getSettings()};
    });
    assert(output.error);assert.equal(output.before,output.after);assert.equal(output.config.recoveryId,fixture.expected);assert.deepEqual(output.writes,[]);
    check(true,'refreshing derived output refuses an older matching-scene fallback without changing History or expected identity');
    const reconnected=await page.evaluate(async()=>{const a=await import('./app.js');let error;try{await a.folderWorkspace.reconnect();}catch(e){error=e.message;}return {error,state:a.folderWorkspace.getState(),config:await a.folderWorkspace.io.getSettings(),revisionId:a.completion.capture().revisionId,writes:resumeAudit.writes};});
    assert(reconnected.error);assert(reconnected.state.pausedReason);assert.equal(reconnected.config.recoveryId,fixture.expected);assert.equal(reconnected.revisionId,fixture.revisionId);assert.deepEqual(reconnected.writes,[]);
    check(true,'reconnect preserves a damaged expected generation even when its older fallback has the same current scene');
  }finally{await context.close();}
}
