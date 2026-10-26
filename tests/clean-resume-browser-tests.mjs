// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,folderSnapshot,assertCleanAudit,beginClose,finishClose,waitUntil} from './clean-resume-helpers.mjs';
import {checkBlockedRetryOverlap} from './blocked-retry-browser-checks.mjs';
import {checkSaveProgressAndReuse} from './save-progress-browser-checks.mjs';
import {checkFastResume} from './fast-resume-browser-checks.mjs';

export async function runCleanResume({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),log=[],measurements=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('clean-resume: '+label);};
  page.on('pageerror',e=>errors.push(e.message));await installResumeAudit(page);
  const saved=()=>waitUntil(page,async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().dirty;});
  const local=()=>waitUntil(page,async()=>{const a=await import('./app.js');return !a.sessionStatus().busy&&!a.sessionStatus().dirty;});
  const reload=async()=>{await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');};
  const clean=async label=>{
    const before=await folderSnapshot(page);await reload();await beginClose(page);const close=await finishClose(page);await saved();
    assert.deepEqual(await folderSnapshot(page),before);const audit=await assertCleanAudit(page);
    check(close.local&&close.folder&&close.idle&&!close.error,label);
    measurements.push({label,close,audit,snapshot:before});
  };
  const mutate=async(fn,arg)=>{const handle=await page.evaluateHandle(async arg=>{
    const a=await import('./app.js'),c=await a.folderWorkspace.io.getSettings(),d=c.directory;
    const read=async path=>{let p=d;const parts=path.split('/');for(const n of parts.slice(0,-1))p=await p.getDirectoryHandle(n);return(await p.getFileHandle(parts.at(-1))).getFile();};
    const put=async(path,blob)=>{let p=d;const parts=path.split('/');for(const n of parts.slice(0,-1))p=await p.getDirectoryHandle(n,{create:true});const w=await(await p.getFileHandle(parts.at(-1),{create:true})).createWritable();await w.write(blob);await w.close();};
    const remove=async path=>{let p=d;const parts=path.split('/');for(const n of parts.slice(0,-1))p=await p.getDirectoryHandle(n);await p.removeEntry(parts.at(-1));};
    return {a,c,d,read,put,remove,arg};
  },arg);try{return await page.evaluate(fn,handle);}finally{await handle.dispose();}};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      const a=await import('./app.js'),{fixtureBlob}=await import('./qa/fixtures.js'),d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC clean resume',{create:true});
      for(const name of ['source.pdf','rendered.pdf','score.ly']){const w=await(await d.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(name));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>({directory:d,absolutePath:'C:\\SYNTHETIC clean resume',nativeBinding:'a'.repeat(32)});
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC saved correction');await page.locator('#saveFinding').click();await saved();
    await clean('saved proofreading resumes and closes with zero project writes and exact IDs/hashes/events');
    await mutate(async({put})=>{const {fixtureBlob}=await import('./qa/fixtures.js');await put('rendered.pdf',await fixtureBlob('multipage.pdf'));await put('score.ly',new Blob(['% SYNTHETIC external code\n{ e4 f4 }']));});
    await clean('newer mutable PDF and code remain byte-exact and unloaded on automatic resume/close');
    await page.evaluate(async()=>await(await import('./app.js')).folderWorkspace.loadLatest());await saved();
    await page.locator('#looksCorrect').click();await saved();
    await clean('approved returned review resumes without changing Latest, Versions, READY or history');
    // Every repair is followed by a second start to prove convergence.
    for(const [label,path]of [['missing history','History.json'],['missing Versions','Versions/0002 - rendered.pdf'],['missing Latest','Latest/0002 - rendered.pdf'],['missing handoff asset','.scorebrush/latest/lilypond/supplied.ly']]){
      const before=await folderSnapshot(page);await mutate(async({remove,arg})=>remove(arg),path);await reload();await saved();
      check((await folderSnapshot(page)).recoveryId!==before.recoveryId,label+' triggers explicit repair');await clean(label+' repair converges to a clean next start');
    }
    await mutate(async({put})=>put('.scorebrush/latest/READY.json',new Blob([JSON.stringify({schema:'private-score-desk-ready',version:1,ready:false})])));await reload();await saved();
    await clean('interrupted READY publication repairs once and then resumes cleanly');
    await page.evaluate(()=>localStorage.setItem('private-score-desk-directory-prompt','true'));const old=(await folderSnapshot(page)).recoveryId;await reload();await saved();
    check((await folderSnapshot(page)).recoveryId!==old,'changed prompt settings republish the saved review');await clean('updated prompt settings do not cause repeated startup saves');
    // Real durable pending notes must not be confused with the clean proof.
    await page.locator('#appMenuEdit').click();await page.locator('#menuEdit [data-command="new-finding"]').click();await page.locator('#comment').fill('SYNTHETIC pending folder note');await page.locator('#saveFinding').click();await local();
    await page.evaluate(()=>{window.resumeDelay=true;});await beginClose(page);
    await page.waitForFunction(()=>window.resumeWritePending);check(!await page.evaluate(()=>closeMessages.some(m=>m.op==='close-result')),'close remains blocked while a real recovery write is delayed');
    await page.evaluate(()=>{window.resumeDelay=false;releaseResumeWrite();});const delayed=await finishClose(page);check(delayed.local&&delayed.folder&&delayed.idle,'close succeeds only after delayed pending data commits');measurements.push({label:'delayed pending close',close:delayed});await saved();
    await clean('durably saved pending note is clean on its next start');
    await page.locator('#appMenuEdit').click();await page.locator('#menuEdit [data-command="new-finding"]').click();await page.locator('#comment').fill('SYNTHETIC failed folder note');await page.locator('#saveFinding').click();await local();
    await page.evaluate(()=>{window.resumeFail='snapshot.json';});await beginClose(page);const failed=await finishClose(page);
    check(failed.local&&!failed.folder&&failed.error.includes('SYNTHETIC'),'failed folder write never authorizes safe folder closure');
    await page.evaluate(async()=>{window.resumeFail=null;await(await import('./app.js')).folderWorkspace.saveNow();});await saved();await clean('failed save retry converges without losing the pending note');
    const known=await folderSnapshot(page);
    const commitments=await mutate(async({d,read,remove})=>{
      const recovery=await(await d.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery'),kept=[];
      for await(const [name,e]of recovery.entries())if(e.kind==='directory'&&name.startsWith('g-')){
        const path='.scorebrush/recovery/'+name+'/COMMIT.json';try{kept.push([path,await(await read(path)).text()]);await remove(path);}catch(e){if(e.name!=='NotFoundError')throw e;}
      }return kept;
    });
    await reload();await waitUntil(page,async()=>Boolean((await import('./app.js')).folderWorkspace.getState().error));
    const missing=await folderSnapshot(page);check(missing.recoveryId===known.recoveryId&&missing.revisionId===known.revisionId&&JSON.stringify(missing.events)===JSON.stringify(known.events),'missing committed recovery preserves its expected identity and saved edits instead of inventing empty history');
    await beginClose(page);const missingClose=await finishClose(page);check(missingClose.local&&!missingClose.folder,'missing recovery exposes the existing guarded-close recovery route');
    await mutate(async({put,arg})=>{for(const [path,text]of arg)await put(path,new Blob([text]));},commitments);await reload();await saved();await clean('restoring exact missing commitments repairs readiness and then resumes cleanly');
    await mutate(async({read,put})=>{const path='.scorebrush/finished-pdf.json',receipt=JSON.parse(await(await read(path)).text());receipt.pending=receipt.current;receipt.pendingCreate=false;await put(path,new Blob([JSON.stringify(receipt)]));});
    await reload();await saved();await clean('an interrupted approved-copy receipt repairs once without changing the approved rendering');
    const originalHistory=await mutate(async({read,put})=>{const original=await(await read('History.json')).text();await put('History.json',new Blob(['SYNTHETIC user-owned edits']));return original;});
    await reload();await waitUntil(page,async()=>Boolean((await import('./app.js')).folderWorkspace.getState().error));
    const conflict=await mutate(async({read})=>(await read('History.json')).text());check(conflict==='SYNTHETIC user-owned edits','modified History.json remains preserved and cannot pass the clean proof');
    await beginClose(page);const blocked=await finishClose(page);check(blocked.local&&!blocked.folder&&Boolean(blocked.error),'publication conflict retains guarded close recovery choices');
    await mutate(async({put,arg})=>put('History.json',new Blob([arg])),originalHistory);await reload();await saved();
    await mutate(async({put})=>{for(const name of ['Caf\u00e9.pdf','Cafe\u0301.pdf','EXTRA.pdf','extra.pdf'])await put('Versions/'+name,new Blob(['SYNTHETIC unrelated '+name]));});
    await clean('unrelated NFC/NFD and case-colliding PDFs reopen and close with zero redundant publication');
    await clean('unrelated normalized collisions remain clean on a second reopen');
    const approvedBefore=await folderSnapshot(page);
    await mutate(async({put})=>put('Versions/0002 - RENDERED.pdf',new Blob(['SYNTHETIC user-owned case alias'])));await reload();
    await waitUntil(page,async()=>Boolean((await import('./app.js')).folderWorkspace.getState().error));
    const collision=await folderSnapshot(page);await beginClose(page);const collisionClose=await finishClose(page);
    check(collisionClose.local&&!collisionClose.folder&&/ambiguous owned filename/.test(collisionClose.error)&&collision.recoveryId===approvedBefore.recoveryId,'owned case collision exposes stable conflict without repair publication or unsafe close');
    await reload();await beginClose(page);const again=await finishClose(page);
    check(!again.folder&&(await folderSnapshot(page)).recoveryId===approvedBefore.recoveryId,'unresolved owned collision cannot report success on repeated reopen');
    await mutate(async({read,remove,put})=>{const bytes=await read('Versions/0002 - RENDERED.pdf');await put('SYNTHETIC preserved alias.pdf',bytes);await remove('Versions/0002 - RENDERED.pdf');});
    await clean('explicitly moving the conflicting alias out of Versions restores clean reopen without publishing');
    await mutate(async({put})=>put('Versions/0002 - rendered.pdf',new Blob(['SYNTHETIC user edit to old approved copy'])));await reload();await saved();
    const suffix=await folderSnapshot(page),oldCopy=await mutate(async({read})=>(await read('Versions/0002 - rendered.pdf')).text());
    check(oldCopy==='SYNTHETIC user edit to old approved copy'&&suffix.files['Versions/0002 - rendered (2).pdf']?.sha256===suffix.files['Latest/0002 - rendered (2).pdf']?.sha256,'edited owned copy survives while Versions and approved Latest publish the verified suffix');
    await mutate(async({remove})=>remove('Versions/0002 - rendered.pdf'));
    await clean('removing the edited old copy reuses the valid suffix with zero PDF or project publication');
    await clean('valid suffix remains selected across another clean reopen and close');
    const stable=await folderSnapshot(page);check(!stable.files['Versions/0002 - rendered.pdf']&&stable.files['Versions/0002 - rendered (2).pdf'].sha256===suffix.files['Versions/0002 - rendered (2).pdf'].sha256&&stable.files['.scorebrush/finished-pdf.json'].sha256===suffix.files['.scorebrush/finished-pdf.json'].sha256&&stable.files['History.json'].sha256===suffix.files['History.json'].sha256,'suffix, approval receipt and exact History relationships remain stable without a duplicate PDF');
    await checkBlockedRetryOverlap({browser,server,evidence,check});
    await checkSaveProgressAndReuse({browser,server,evidence,check});
    await checkFastResume({browser,server,evidence,check});
    check(!errors.length,'no uncaught browser errors: '+errors.join('; '));return {name:'clean-resume',assertions};
  }catch(e){log.push('FAIL '+e.stack);log.push(JSON.stringify(await page.evaluate(async()=>({audit:window.resumeAudit,state:(await import('./app.js')).folderWorkspace.getState()}))));await page.screenshot({path:resolve(evidence,'clean-resume-failure.png')}).catch(()=>{});throw e;}
  finally{await writeFile(resolve(evidence,'clean-resume.txt'),log.join('\n'));await writeFile(resolve(evidence,'clean-resume-measurements.json'),JSON.stringify(measurements,null,2));await context.close();await server.close();}
}
