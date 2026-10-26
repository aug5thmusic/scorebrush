// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,waitUntil,beginClose,finishClose} from './clean-resume-helpers.mjs';

export async function runRecoveryEdit({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[];let assertions=0;
  const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);};
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||s.saveFailed||s.saveConflict)throw Error(f.error||'Local save failed');return f.ready&&!f.busy&&!s.busy&&!s.dirty;});
  const edit=async text=>{await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await saved();};
  const capture=()=>page.evaluate(async()=>{const c=a.completion.capture(),f=await a.folderWorkspace.io.getSettings();return {workspaceId:c.workspaceId,revisionId:c.revisionId,persistedRevision:c.persistedRevision,review:c.review,returned:c.returned,completions:c.completions,recoveryId:f.recoveryId,currentCheckpointId:f.currentCheckpointId,headId:f.head?.id??null};});
  await installResumeAudit(page);
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const fixture=(await import('./qa/fixtures.js')).fixtureBlob;window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC recovered unsent checkpoint',{create:true});
      for(const [name,source]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixture(source));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    await edit('SYNTHETIC unsent checkpoint before profile loss');const before=await capture();
    check(Boolean(before.currentCheckpointId),'unsent review has an exact durable current checkpoint');
    check(await page.evaluate(()=>!a.folderWorkspace.savedPrompt()),'unsent checkpoint does not advertise an old AI prompt');
    // Only the three databases in this new synthetic context are cleared.
    // The OPFS project remains; no connection/head survives to assist recovery.
    await page.evaluate(async()=>{
      for(const[name,store]of [['private-score-desk-local-v1','reviews'],['private-score-desk-handoffs-v1','entries'],['private-score-desk-folders-v1','settings']])await new Promise((resolve,reject)=>{const r=indexedDB.open(name);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction(store,'readwrite');tx.objectStore(store).clear();tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};});
    });
    await page.reload();await boot();
    check(await page.evaluate(async()=>!(await a.folderWorkspace.io.getSettings())&&(await(await import('./storage.js')).listSaved()).length===0),'fresh browser state has neither review records nor a saved connection');
    await page.evaluate(async()=>{window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC recovered unsent checkpoint');a.folderWorkspace.io.pickDirectory=async()=>folder;await a.folderWorkspace.choose({mode:'open'});});await saved();
    const recovered=await capture();await writeFile(resolve(evidence,'recovery-edit-recovered.json'),JSON.stringify({before,recovered},null,2));assert.deepEqual(recovered.review,before.review);check(recovered.workspaceId===before.workspaceId&&recovered.revisionId===before.revisionId,'folder-only recovery preserves the exact unsent review and revision');
    await page.evaluate(()=>{resumeAudit.writes=[];});await edit('SYNTHETIC first edit after folder-only recovery');const edited=await capture();
    check(edited.recoveryId===recovered.recoveryId&&edited.currentCheckpointId!==recovered.currentCheckpointId,'first recovered edit updates only the current checkpoint');
    check(!await page.evaluate(()=>resumeAudit.writes.some(w=>['COMMIT.json','snapshot.json','task.json','History.json'].includes(w.name))),'ordinary recovered edit does not republish archives or an AI task');
    check(edited.review.findings.length===2&&edited.review.findings[0].comment===before.review.findings[0].comment,'new recovered edit preserves earlier notes');
    await beginClose(page);const close=await finishClose(page);check(close.local&&close.folder&&close.idle&&!close.error,'guarded close verifies the recovered edit without a handoff');
    await page.reload();await boot();await saved();const reopened=await capture();
    assert.deepEqual(reopened.review,edited.review);check(reopened.revisionId===edited.revisionId,'saved recovered edit survives a new page session');
    await page.evaluate(async()=>{await a.folderWorkspace.saveNow();});await saved();const issued=await capture();
    check(issued.recoveryId===edited.recoveryId&&Boolean(issued.headId),'first Send after recovery publishes its task without inventing an archive generation');
    const prompt=await page.evaluate(()=>a.folderWorkspace.savedPrompt()?.text);check(Boolean(prompt),'published recovered task exposes a verified prompt');
    await page.evaluate(async()=>{resumeAudit.writes=[];await a.folderWorkspace.saveNow();});await saved();const unchanged=await capture();
    check(unchanged.headId===issued.headId&&await page.evaluate(expected=>a.folderWorkspace.savedPrompt()?.text===expected&&resumeAudit.writes.length===0,prompt),'unchanged Send retains exact task/prompt without rewriting files');
    await page.evaluate(async()=>{const folder=(await a.folderWorkspace.io.getSettings()).directory,w=await(await folder.getFileHandle('score.ly')).createWritable();await w.write(new Blob(['% SYNTHETIC next code-only revision\n\\version "2.24.3"\n']));await w.close();await a.folderWorkspace.loadLatest();});await saved();const loaded=await capture();
    check(loaded.recoveryId!==issued.recoveryId&&loaded.review.files.rendered.sha256===issued.review.files.rendered.sha256&&loaded.review.files.ly.sha256!==issued.review.files.ly.sha256,'code-only Load latest still commits its distinct revision while retaining PDF bytes');
    check(loaded.returned?.reported.length===2&&loaded.returned.reported[0].comment===before.review.findings[0].comment,'both exact notes remain associated with the returned revision');
    log.push(`ALL ${assertions} RECOVERY EDIT CHECKS PASSED`);await writeFile(resolve(evidence,'recovery-edit.txt'),log.join('\n')+'\n');await writeFile(resolve(evidence,'recovery-edit-identities.json'),JSON.stringify({before,recovered,edited,reopened,issued,unchanged,loaded,close},null,2));
    return {name:'recovery-edit',assertions};
  }catch(error){log.push('FAIL '+error.stack);await writeFile(resolve(evidence,'recovery-edit.txt'),log.join('\n')+'\n');await page.screenshot({path:resolve(evidence,'recovery-edit-failure.png'),fullPage:true});throw error;}
  finally{await context.close();await server.close();}
}
