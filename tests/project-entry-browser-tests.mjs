// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,folderSnapshot,assertCleanAudit} from './clean-resume-helpers.mjs';

export async function runProjectEntry({browser,serve,evidence,root,sourceOnly=false}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1200,height:850}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  page.on('pageerror',e=>errors.push(e.message));
  await installResumeAudit(page);
  const check=(ok,text)=>{assert(ok,text);assertions++;log.push('PASS '+text);console.log('project-entry: '+text);};
  const menu=async id=>{await page.locator('#appMenuFile').click();await page.locator(`#menuFile [data-command="${id}"]`).click();};
  const until=async predicate=>{const end=Date.now()+90000;while(!await page.evaluate(predicate)){if(Date.now()>end)throw new Error('Project state did not settle');await new Promise(r=>setTimeout(r,50));}};
  const saved=()=>until(async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;});
  const idle=()=>until(async()=>!(await import('./app.js')).folderWorkspace.getState().busy);
  const cancelled=async()=>assert(await page.evaluate(async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return !f.busy&&f.ready&&a.applicationShell.states()['new-project'].enabled;}),'Cancellation must return immediately without waiting for another save');
  const capture=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),{sha256}=await import('./model.js'),c=await a.folderWorkspace.io.getSettings();return {review:s.review,returned:s.returned,completions:s.completions,revisionId:s.revisionId,workspaceId:s.workspaceId,connectionId:c?.connectionId,source:await sha256(await s.files.source.blob.arrayBuffer()),rendered:await sha256(await s.files.rendered.blob.arrayBuffer())};});
  const pick=async name=>page.evaluate(async name=>{const a=await import('./app.js'),directory=await(await navigator.storage.getDirectory()).getDirectoryHandle(name);a.folderWorkspace.io.pickDirectory=async()=>directory;},name);
  const sourcePixels=async()=>{
    await page.locator('#sourceZoom').selectOption('1');
    await page.waitForFunction(()=>document.querySelector('#sourcePaper').getAttribute('aria-busy')==='false'&&document.querySelector('#sourcePaper').dataset.resizePending!=='true');
    return page.evaluate(async()=>{const canvas=document.querySelector('#sourceCanvas'),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,{sha256}=await import('./model.js');let ink=0;const inkMask=new Uint8Array(pixels.length/4);for(let i=0;i<pixels.length;i+=4)if(pixels[i+3]&&Math.min(pixels[i],pixels[i+1],pixels[i+2])<220){ink++;inkMask[i/4]=1;}return {hash:await sha256(inkMask),ink,width:canvas.width,height:canvas.height,page:document.querySelector('#sourcePage').value,count:document.querySelector('#sourceCount').textContent};});
  };

  const roles=async()=>{await page.locator('#folderSetupDialog').waitFor();for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await idle();
    check(JSON.stringify(await page.locator('.welcome-steps p').allTextContents())===JSON.stringify(['Ask your AI to transcribe a score in LilyPond. Put the original score, the LilyPond PDF, and the LilyPond .ly file in the same folder and start a New Project.','Compare two scores, such as a LilyPond rendering and its original source. Mark passages for correction.','Send the marked-up score to your AI with a pre-written prompt.','Load the AI’s corrected score and review the changes.']),'Welcome has the exact requested four-step copy');
    check(await page.locator('ol.welcome-steps').count()===1&&JSON.stringify(await page.locator('.welcome-first strong').allTextContents())===JSON.stringify(['Ask your AI to transcribe a score in LilyPond.','New Project'])&&await page.locator('.welcome-first img,.welcome-files').count()===0,'first step has exact emphasis, semantic order, no icon and no redundant paragraph');
    check(JSON.stringify(await page.locator('.welcome-actions button').allTextContents())===JSON.stringify(['New Project','Open Project','Restore Backup']),'Welcome has three distinct entry points');
    check(await page.locator('#menuFile [data-command=explorer] span').innerText()==='Open file location'&&await page.locator('#workspaceExplorer').getAttribute('aria-label')==='Open file location'&&await page.locator('#showFolderFiles').innerText()==='Open file location','Open file location is consistent in menus, header and folder actions');
    await page.screenshot({path:resolve(evidence,'project-entry-welcome.png')});
    await page.locator('#welcomeRecover').click();check(await page.locator('#projectOpenDialog').isVisible()&&(await page.locator('#recentProjects').innerText()).includes('No recent'),'Open Project opens folders and recent projects, not saved local history');await page.locator('#closeProjectOpen').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js'),root=await navigator.storage.getDirectory();for(const name of ['SYNTHETIC-Project-A','SYNTHETIC-Project-B','SYNTHETIC-New-Folder']){const dir=await root.getDirectoryHandle(name,{create:true});for(const file of ['source.pdf','rendered.pdf','score.ly']){const out=await(await dir.getFileHandle(file,{create:true})).createWritable();await out.write(file==='score.ly'?new Blob([await fixtureBlob(file),'\n% '+name]):await fixtureBlob(name==='SYNTHETIC-Project-B'&&file==='source.pdf'?'multipage.pdf':file));await out.close();}}});
    await pick('SYNTHETIC-Project-A');await page.locator('#appMenuHelp').click();await page.locator('#menuHelp [data-command=welcome]').click();await page.locator('#chooseFolderInSetup').click();await roles();
    check(await page.locator('#folderSetupDialog label strong').count()===3&&await page.locator('#folderSetupDialog label strong').evaluateAll(els=>els.every(e=>e.textContent.endsWith(':')&&Number(getComputedStyle(e).fontWeight)>=600)),'all role headings are bold and end with a colon');
    check(await page.locator('#folderSetupConfirm').evaluate(el=>getComputedStyle(el).backgroundColor==='rgb(68, 61, 208)'),'role confirmation is indigo');
    await page.screenshot({path:resolve(evidence,'project-entry-roles.png')});await page.locator('#folderSetupCancel').click();await idle();
    check(await page.evaluate(async()=>{const a=await import('./app.js'),d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A');try{await d.getDirectoryHandle('.scorebrush');return false;}catch(e){return e.name==='NotFoundError'&&(await a.folderWorkspace.io.listSettings()).length===0;}}),'cancelling role selection creates no project or recovery folder');
    await menu('new-project');await roles();await page.locator('#folderSetupConfirm').click();await saved();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC retained finding');await page.locator('#saveFinding').click();await saved();
    const initial=await capture(),initialSource=await sourcePixels();check(initialSource.ink>100,'the first project source contains actual rendered ink');
    const sortFolderBefore=await folderSnapshot(page),sortAuditBefore=await page.evaluate(()=>structuredClone(window.resumeAudit));
    await page.locator('#findingOrder').selectOption('oldest');await page.locator('#findingOrder').selectOption('newest');
    assert.deepEqual(await folderSnapshot(page),sortFolderBefore);
    const sortAuditAfter=await page.evaluate(()=>window.resumeAudit),sortAudit={streams:sortAuditAfter.streams.slice(sortAuditBefore.streams.length),writes:sortAuditAfter.writes.slice(sortAuditBefore.writes.length),removes:sortAuditAfter.removes.slice(sortAuditBefore.removes.length),localWrites:sortAuditAfter.localWrites.slice(sortAuditBefore.localWrites.length),preferences:sortAuditAfter.preferences.slice(sortAuditBefore.preferences.length)};
    assert.deepEqual(sortAudit.streams,[]);assert.deepEqual(sortAudit.writes,[]);assert.deepEqual(sortAudit.removes,[]);assert(!sortAudit.localWrites.some(w=>['reviews','handoffs'].includes(w.store)));assert.deepEqual(sortAudit.preferences,['score-desk-findings-order-v1','score-desk-findings-order-v1']);
    await writeFile(resolve(evidence,'findings-sort-folder-audit.json'),JSON.stringify(sortAudit,null,2));
    check(true,'sort toggles write only interface preferences; exact folder bytes, history, task, recovery and revision identities stay unchanged');
    const versionCopies=()=>page.evaluate(async()=>{
      const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A'),{sha256}=await import('./model.js'),v=await d.getDirectoryHandle('Versions'),copies={};
      for await(const[n,e]of v.entries())if(e.kind==='file')copies[n]=await sha256(await(await e.getFile()).arrayBuffer());return copies;
    });
    assert.deepEqual(await versionCopies(),{'0001 - rendered.pdf':initial.rendered});check(true,'Versions starts with the byte-identical initial transcription');

    await menu('new-project');await page.locator('#projectChoiceDialog').waitFor();check((await page.locator('#projectChoiceTitle').innerText())==='Project already exists'&&await page.locator('#folderSetupDialog').count()===0,'New Project detects existing history before presenting roles');
    await page.locator('#cancelProjectChoice').click();await cancelled();assert.deepEqual(await capture(),initial);check(true,'cancelling an existing-project offer preserves exact review, revision, bytes and binding');
    await menu('new-project');await page.locator('#confirmProjectChoice').click();await saved();assert.deepEqual(await capture(),initial);check(true,'accepting the existing-project offer opens its history without a new identity');
    await pick('SYNTHETIC-New-Folder');await menu('open-folder');await page.locator('#browseProjectFolder').click();await page.locator('#projectChoiceDialog').waitFor();check((await page.locator('#projectChoiceTitle').innerText())==='No saved project in this folder','Open Project does not silently initialize an unsaved folder');await page.locator('#cancelProjectChoice').click();await cancelled();assert.deepEqual(await capture(),initial);
    await pick('SYNTHETIC-Project-B');await menu('new-project');await roles();await page.locator('#folderSetupConfirm').click();await until(async()=>(await import('./app.js')).folderWorkspace.getState().directoryName==='SYNTHETIC-Project-B');await saved();const second=await capture();check(second.connectionId!==initial.connectionId,'New Project creates a separate per-folder binding');
    const secondSource=await sourcePixels();check(secondSource.ink>100&&secondSource.hash!==initialSource.hash&&secondSource.count==='/ 4','switching to another project paints its distinct multipage source instead of a blank or stale canvas');
    await page.locator('#sourcePage').fill('3');await page.locator('#sourcePage').press('Tab');const thirdSource=await sourcePixels();check(thirdSource.ink>100&&thirdSource.hash!==secondSource.hash&&thirdSource.page==='3','source page navigation paints the selected page in the new project');
    await page.locator('#sourcePage').fill('1');await page.locator('#sourcePage').press('Tab');assert.deepEqual(await sourcePixels(),secondSource);check(true,'returning to source page one restores the exact rendered ink pattern');
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await saved();assert.deepEqual(await sourcePixels(),secondSource);check(true,'restarting on the second project preserves its source page ink pattern');
    await menu('open-folder');await page.locator('.recent-project').first().waitFor();check(await page.locator('.recent-project').count()===2&&(await page.locator('.recent-project').first().innerText()).includes('Project-B'),'recent folders include both projects with the latest first');
    await page.screenshot({path:resolve(evidence,'project-entry-recent.png')});await page.locator('.recent-project').filter({hasText:'SYNTHETIC-Project-A'}).click();await saved();assert.deepEqual(await capture(),initial);check(true,'recent selection opens the exact original folder review and binding without role setup');assert.deepEqual(await sourcePixels(),initialSource);check(true,'switching back repaints the original project source exactly');
    if(sourceOnly){check(errors.length===0,'source project switches and restart produce no uncaught browser errors');return {name:'project-source',assertions};}
    // Save a later rendering and a review decision, then reopen through both
    // new-project detection and Open Project to exercise real historical bytes.
    await page.evaluate(async()=>{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A'),f=await d.getFileHandle('score.ly'),blob=await f.getFile(),w=await f.createWritable();await w.write(new Blob([blob,'\n% SYNTHETIC code-only captured revision']));await w.close();await(await import('./app.js')).folderWorkspace.loadLatest();});await saved();
    const codeOnly=await capture();check(codeOnly.rendered===initial.rendered&&codeOnly.review.snapshotId!==initial.review.snapshotId&&codeOnly.returned!==null,'Load latest captures changed code with identical PDFs as a separate unverified revision');
    assert.deepEqual(await versionCopies(),{'0001 - rendered.pdf':initial.rendered});check(true,'code-only Load latest retains the original PDF ordinal');
    await page.evaluate(async()=>{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A'),{fixtureBlob}=await import('./qa/fixtures.js');const w=await(await d.getFileHandle('rendered.pdf')).createWritable();await w.write(await fixtureBlob('multipage.pdf'));await w.close();await(await import('./app.js')).folderWorkspace.loadLatest();});await saved();
    await page.locator('#looksCorrect').click();await saved();const reviewed=await capture();check(reviewed.returned!==null&&reviewed.revisionId!==initial.revisionId,'synthetic project has a returned revision and a saved review decision');

    const expectedVersions={'0001 - rendered.pdf':initial.rendered,'0002 - rendered.pdf':reviewed.rendered};assert.deepEqual(await versionCopies(),expectedVersions);
    check(await page.evaluate(async()=>{const {scanWorkspace}=await import('./folder-workspace.js'),d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A');return !(await scanWorkspace(d)).some(p=>p.toLowerCase().startsWith('versions/'));}),'distinct loaded rendering is preserved and Versions is excluded from working-file discovery');
    // Remove derived copies while retaining the modern current checkpoint.
    // Resuming it stays read-only; explicit output repair restores the copies.
    await page.evaluate(async()=>{const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A');await d.removeEntry('Versions',{recursive:true});await(await d.getDirectoryHandle('.scorebrush')).removeEntry('pdf-versions',{recursive:true});});
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await saved();assert.deepEqual(await capture(),reviewed);check(true,'restart preserves exact returned revision, decisions, historical linkage and binding');
    await assertCleanAudit(page);check(true,'checkpoint resume leaves missing derived outputs untouched');
    await page.evaluate(async()=>{await(await import('./app.js')).folderWorkspace.saveNow({refreshOutput:true});});await saved();
    assert.deepEqual(await capture(),reviewed);assert.deepEqual(await versionCopies(),expectedVersions);check(true,'explicit output repair restores both exact PDFs without changing decisions');
    check(await page.locator('#menuFile [data-command=versions] span').innerText()==='Open previous versions'&&await page.locator('#openPreviousVersions').innerText()==='Open previous versions','Versions action is available in File and folder utilities');

    // Turn this synthetic project into the exact legacy layout. No user folder
    // or profile is used; all retained PDF/decision/revision bytes remain real.
    const migration=await page.evaluate(async()=>{
      const directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A'),{sha256}=await import('./model.js'),{fileInfo}=await import('./workflow.js');
      const modern=await directory.getDirectoryHandle('.scorebrush'),legacy=await directory.getDirectoryHandle('.score-desk',{create:true});
      const write=async(d,name,blob)=>{const w=await(await d.getFileHandle(name,{create:true})).createWritable();await w.write(blob);await w.close();};
      async function copy(from,to){for await(const [name,e]of from.entries())if(e.kind==='directory')await copy(e,await to.getDirectoryHandle(name,{create:true}));else await write(to,name,await e.getFile());}
      await copy(modern,legacy);const latest=await legacy.getDirectoryHandle('latest'),prompt=await(await latest.getFileHandle('PROMPT.txt')).getFile(),oldPrompt=new Blob([(await prompt.text()).replaceAll('ScoreBrush','Score Desk').replaceAll('.scorebrush','.score-desk')]);await write(latest,'PROMPT.txt',oldPrompt);
      const manifest=JSON.parse(await(await(await latest.getFileHandle('manifest.json')).getFile()).text());manifest.payloads['PROMPT.txt']=await fileInfo(oldPrompt);const manifestBlob=new Blob([JSON.stringify(manifest)]);await write(latest,'manifest.json',manifestBlob);
      const ready=JSON.parse(await(await(await latest.getFileHandle('READY.json')).getFile()).text());ready.manifestSha256=await sha256(await manifestBlob.arrayBuffer());await write(latest,'READY.json',new Blob([JSON.stringify(ready)]));
      const pointer=await(await directory.getFileHandle('REVIEW_THIS.md')).getFile();await write(directory,'REVIEW_THIS.md',new Blob([(await pointer.text()).replaceAll('.scorebrush','.score-desk')]));
      await directory.removeEntry('.scorebrush',{recursive:true});
      async function hashes(d){const result={};for await(const[n,e]of d.entries())if(e.kind==='directory'){for(const[p,h]of Object.entries(await hashes(e)))result[n+'/'+p]=h;}else result[n]=await sha256(await(await e.getFile()).arrayBuffer());return result;}
      window.legacyHashesBeforeMigration=await hashes(legacy);
      const original=FileSystemFileHandle.prototype.createWritable,originalGet=FileSystemDirectoryHandle.prototype.getFileHandle;let interrupted=false,error='',migrationStarted=false;
      FileSystemDirectoryHandle.prototype.getFileHandle=async function(name,options){if(this.name==='.scorebrush'&&name==='OWNER.json'&&options?.create)migrationStarted=true;return originalGet.call(this,name,options);};
      FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='PROMPT.txt'&&migrationStarted&&!interrupted){interrupted=true;throw Error('SYNTHETIC migration interruption');}return original.apply(this,args);};
      try{await(await import('./project-directory.js')).ensureDataDirectory(directory);}catch(e){error=e.message;}finally{FileSystemFileHandle.prototype.createWritable=original;FileSystemDirectoryHandle.prototype.getFileHandle=originalGet;}
      return {error,before:window.legacyHashesBeforeMigration,after:await hashes(legacy)};
    });
    assert.deepEqual(migration.after,migration.before);check(migration.error.includes('SYNTHETIC migration interruption'),'interrupted migration in real browser filesystem handles preserves every legacy file');
    await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await saved();assert.deepEqual(await capture(),reviewed);check(true,'restart resumes migration without changing review identity, decisions, historical PDFs or folder binding');
    await page.evaluate(async()=>{(await import('./app.js')).folderWorkspace.openPrompt();});await until(async()=>Boolean((await import('./app.js')).folderWorkspace.savedPrompt()));await page.locator('#closeFolderPrompt').click();await saved();
    const migrated=await page.evaluate(async()=>{
      const a=await import('./app.js'),{sha256}=await import('./model.js'),{migrationArchivePaths}=await import('./project-directory.js'),d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-Project-A'),modern=await d.getDirectoryHandle('.scorebrush'),o=JSON.parse(await(await(await modern.getFileHandle('OWNER.json')).getFile()).text()),layout=migrationArchivePaths(o),archive=await(await modern.getDirectoryHandle(layout.base)).getDirectoryHandle(layout.original);
      async function hashes(d){const result={};for await(const[n,e]of d.entries())if(e.kind==='directory'){for(const[p,h]of Object.entries(await hashes(e)))result[n+'/'+p]=h;}else result[n]=await sha256(await(await e.getFile()).arrayBuffer());return result;}
      let oldExists=true;try{await d.getDirectoryHandle('.score-desk');}catch(e){if(e.name==='NotFoundError')oldExists=false;else throw e;}
      return {archive:await hashes(archive),oldExists,prompt:a.folderWorkspace.savedPrompt()?.text};
    });
    assert.deepEqual(migrated.archive,migration.before);check(!migrated.oldExists,'every original file is archived byte-for-byte before the old directory is retired');
    check(migrated.prompt.includes('ScoreBrush')&&migrated.prompt.includes('.scorebrush/latest')&&!/SCORE DESK|Score Desk|\.score-desk\//.test(migrated.prompt),'current saved AI prompt uses ScoreBrush and the new path while archived prompts keep their original bytes');
    const committedMigration=await folderSnapshot(page);await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');await saved();
    assert.deepEqual(await folderSnapshot(page),committedMigration);await assertCleanAudit(page);check(true,'completed migration resumes on its next start with zero folder writes and unchanged recovery/task/history identities');
    await pick('SYNTHETIC-Project-A');await menu('new-project');await page.locator('#confirmProjectChoice').click();await saved();assert.deepEqual(await capture(),reviewed);check(true,'New Project existing-folder offer preserves a reviewed returned round');
    await menu('open-folder');await page.locator('.recent-project').filter({hasText:'SYNTHETIC-Project-B'}).click();await saved();assert.deepEqual(await capture(),second);
    await menu('open-folder');await page.locator('#browseProjectFolder').click();await saved();assert.deepEqual(await capture(),reviewed);check(true,'Open Project browsing restores existing project roles and historical round without setup');
    await page.evaluate(async()=>{(await import('./app.js')).folderWorkspace.io.pickDirectory=async()=>{throw new DOMException('Synthetic cancel','AbortError');};});await menu('new-project');await cancelled();assert.deepEqual(await capture(),reviewed);check(true,'cancelled folder selection preserves the current reviewed project');
    await page.evaluate(async()=>{const a=await import('./app.js');window.originalList=a.folderWorkspace.io.listSettings;a.folderWorkspace.io.listSettings=async()=>{const rows=await window.originalList();return rows.map(c=>({...c,directory:{name:c.directory.name,queryPermission:async()=> 'denied',requestPermission:async()=> 'denied'}}));};});
    await menu('open-folder');await page.locator('.recent-project').filter({hasText:'SYNTHETIC-Project-B'}).click();await idle();assert.deepEqual(await capture(),reviewed);check(await page.evaluate(async()=>(await import('./app.js')).folderWorkspace.getState().loadError),'denied recent-folder access leaves current history and binding unchanged');
    await page.evaluate(async()=>{const a=await import('./app.js');a.folderWorkspace.io.listSettings=window.originalList;});
    await menu('files');await page.locator('#handoffHistoryPanel>summary').click();check(await page.locator('#saved').isVisible()&&await page.locator('#openPackage').isVisible(),'Files & backups retains locally saved reviews and older package import');await page.locator('#closeWorkspace').click();
    const download=page.waitForEvent('download');await menu('backup');const bytes=await readFile(await(await download).path());await page.waitForFunction(()=>!document.querySelector('#closeFinish').disabled);await page.locator('#closeFinish').click();
    const clean=await browser.newContext(),restored=await clean.newPage();try{
      await restored.goto(server.url);await restored.waitForFunction(()=>document.body.dataset.ready==='true');await restored.locator('#welcomeRestore').click();check(await restored.locator('#restoreBackupDialog').isVisible(),'Welcome Restore Backup opens the dedicated backup chooser');
      const chooser=restored.waitForEvent('filechooser');await restored.locator('#chooseRestoreBackup').click();await(await chooser).setFiles({name:'SYNTHETIC-existing-backup.zip',mimeType:'application/zip',buffer:bytes});
      await restored.evaluate(async()=>window.projectApi=await import('./app.js'));await restored.waitForFunction(()=>Boolean(window.projectApi.completion.capture().returned)&&!window.projectApi.sessionStatus().busy);
      const recovered=await restored.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return {revisionId:s.revisionId,findings:s.review.findings,reported:s.returned.reported};});
      assert.deepEqual(recovered,{revisionId:reviewed.revisionId,findings:reviewed.review.findings,reported:reviewed.returned.reported});check(true,'Restore Backup restores exact revision, findings and decisions in a fresh profile');
    }finally{await clean.close();}
    await menu('import');check(await page.locator('#restoreBackupDialog').isVisible(),'File menu Restore Backup uses the same chooser as Welcome');await page.locator('#closeRestoreBackup').click();
    check(errors.length===0,'project entry flows produce no uncaught browser errors');return {name:'project-entry',assertions};
  }catch(e){log.push('STATE '+JSON.stringify(await page.evaluate(async()=>{const a=await import('./app.js');return {folder:a.folderWorkspace.getState(),session:a.sessionStatus()};}).catch(()=>null)));log.push('FAIL '+e.stack);await page.screenshot({path:resolve(evidence,'project-entry-failure.png')});throw e;}
  finally{await writeFile(resolve(evidence,sourceOnly?'project-source.txt':'project-entry.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
