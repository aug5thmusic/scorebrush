// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function runFinishedResume({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report={},log=[];let assertions=0;
  const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);};
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const idle=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending&&!a.folderWorkspace.getState().busy,180000);
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||s.saveConflict||s.saveFailed)throw Error(f.error||'Local save failed');return f.ready&&!f.busy&&!s.busy&&!s.dirty;},180000);
  const note=async text=>{await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await saved();};
  const load=async(fixture,code)=>{await page.evaluate(async({fixture,code})=>{
    const config=await a.folderWorkspace.io.getSettings();
    for(const[name,value]of [['rendered.pdf',await(await import('./qa/fixtures.js')).fixtureBlob(fixture)],['score.ly',new Blob([code])]]){const w=await(await config.directory.getFileHandle(name)).createWritable();await w.write(value);await w.close();}
    await a.folderWorkspace.loadLatest();
  },{fixture,code});await saved();};
  const capture=()=>page.evaluate(async()=>{
    const scene=a.completion.capture(),config=await a.folderWorkspace.io.getSettings(),data=await config.directory.getDirectoryHandle('.scorebrush');
    const receipt=JSON.parse(await(await(await data.getFileHandle('finished-pdf.json')).getFile()).text());
    return {folder:a.folderWorkspace.getState(),revisionId:scene.revisionId,renderSha256:scene.review.files.rendered.sha256,returned:scene.returned,checked:await a.folderWorkspace.checkFinishedPDF(),receipt};
  });
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const fixture=(await import('./qa/fixtures.js')).fixtureBlob,folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC finished PDF restart',{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixture(name));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    await note('SYNTHETIC first correction');await load('multipage.pdf','% SYNTHETIC revision two\n{e4 f4}');
    await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported[0].id));await idle();await page.locator('#looksCorrect').click();await saved();await idle();
    report.first=await capture();check(report.first.checked.state==='match'&&report.first.checked.sha256===report.first.renderSha256,'first approval publishes its exact PDF');
    await page.evaluate(()=>document.querySelector('#roundSummary').close());await page.locator('#workflowProof').click();
    await note('SYNTHETIC second correction');await load('rendered.pdf','% SYNTHETIC revision three\n{g4 a4}');
    await page.evaluate(()=>{
      const create=FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='finished-pdf.json')throw Error('SYNTHETIC failed new finished PDF receipt');return create.apply(this,args);};
    });
    const unresolved=await page.evaluate(()=>a.completion.capture().returned.reported.filter(f=>f.state!=='resolved').map(f=>f.id));
    for(const id of unresolved){await page.evaluate(id=>a.corrections.selectFinding(id),id);await idle();await page.locator('#looksCorrect').click();await idle();}
    await waitUntil(page,()=>a.folderWorkspace.getState().error.includes('SYNTHETIC failed new finished PDF receipt'));
    report.failed=await capture();check(report.failed.returned.reported.every(f=>f.decision?.state==='resolved'),'new approval remains locally saved after receipt publication fails');
    check(report.failed.receipt.current.sha256===report.first.renderSha256&&report.failed.renderSha256!==report.first.renderSha256,'failed receipt write preserves the previous approved PDF');
    await page.reload();await boot();await idle();report.reopened=await capture();
    check(report.reopened.checked.state==='unavailable'&&report.reopened.checked.reason==='different-approval','restart never labels the previous approved PDF as the current completed review');
    check(Boolean(report.reopened.folder.error),'restart retains an actionable publication failure while the checkpoint is durable');
    await page.evaluate(()=>a.corrections.showSummary());await page.locator('#retryRoundSave').waitFor();
    check(!(await page.locator('#roundSummaryText').textContent()).includes('finished PDF is ready'),'completion summary does not advertise the stale PDF');
    await page.locator('#retryRoundSave').click();await idle();await saved();report.repaired=await capture();
    check(report.repaired.checked.state==='match'&&report.repaired.checked.sha256===report.repaired.renderSha256&&report.repaired.receipt.current.revisionId===report.repaired.revisionId,'explicit Retry publishes the exact completed revision');
    assert.deepEqual(report.repaired.returned,report.failed.returned);check(report.repaired.revisionId===report.failed.revisionId,'repair preserves every review decision and its revision');
    await page.evaluate(()=>document.querySelector('#roundSummary').close());await page.locator('#workflowProof').click();
    await page.locator('#newFinding').click();await page.locator('#findingType').selectOption('comment');await page.locator('#comment').fill('SYNTHETIC internal observation after approval');await page.locator('#saveFinding').click();await idle();await saved();report.comment=await capture();
    check(report.comment.revisionId!==report.repaired.revisionId&&report.comment.checked.state==='match'&&report.comment.receipt.current.revisionId===report.comment.revisionId&&report.comment.renderSha256===report.repaired.renderSha256,'an internal comment updates approval identity without changing the approved PDF');
    await page.reload();await boot();await idle();await saved();report.commentRestart=await capture();
    check(report.commentRestart.checked.state==='match'&&report.commentRestart.revisionId===report.comment.revisionId&&!report.commentRestart.folder.error,'approved review with a later internal comment resumes without a false publication error');
    return {name:'finished-resume',assertions};
  }catch(error){report.failure=error.stack;throw error;}
  finally{await writeFile(resolve(evidence,'finished-resume.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,'finished-resume.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
