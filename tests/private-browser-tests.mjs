// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

// A private, manual file round trip through real controls. No service, model,
// repository, compilation, account or contributor browser storage is involved.
export async function runPrivate({browser,serve,evidence,root}){
  const server=await serve(root),contexts=[],pages=[],requests=[],blocked=[],errors=[],log=[];
  let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('private: '+label);};
  const {fixtureBlob}=await import(pathToFileURL(resolve(root,'qa/fixtures.js')).href);
  const module={exports:{}};Function('module','exports',await readFile(resolve(root,'vendor/jszip.min.js'),'utf8'))(module,module.exports);const JSZip=module.exports;
  const bytes=async name=>Buffer.from(await (await fixtureBlob(name)).arrayBuffer());
  const source=await bytes('source.pdf'),before=await bytes('rendered.pdf'),code=await bytes('score.ly');
  const sha=blob=>createHash('sha256').update(blob).digest('hex');
  const ready=page=>page.waitForFunction(()=>document.body.dataset.ready==='true');
  const settled=page=>page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false'&&document.querySelector('#sourcePaper').getAttribute('aria-busy')==='false');
  const state=page=>page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return {review:s.review,returned:s.returned,completions:s.completions,revisionId:s.revisionId};});
  const comparisonReady=page=>page.waitForFunction(()=>document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false'&&!document.querySelector('#correctionComparison').hidden);
  async function newPage(){
    const context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);context.setDefaultTimeout(30000);
    await context.route('**/*',async route=>{
      const address=route.request().url();
      if(!address.startsWith('blob:')&&!address.startsWith('data:')&&new URL(address).origin!==server.origin){blocked.push(address);await route.abort();return;}
      requests.push(address);await route.continue();
    });
    const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.goto(server.url);await ready(page);return page;
  }
  async function download(page,selector,name){
    const [file]=await Promise.all([page.waitForEvent('download'),page.locator(selector).click()]);
    const buffer=await readFile(await file.path());await writeFile(resolve(evidence,name),buffer);return buffer;
  }
  async function importPackage(page,buffer,name){
    await page.locator('#packageFile').setInputFiles({name,mimeType:'application/zip',buffer});
    await page.waitForFunction(()=>!document.querySelector('#workspaceDialog').open&&document.body.classList.contains('review-open'));await settled(page);
  }
  async function more(page){if(!await page.locator('#correctionMore').evaluate(el=>el.open))await page.locator('#correctionMore>summary').click();}
  async function until(page,predicate,arg,timeout=30000){
    const deadline=Date.now()+timeout;
    do{const value=await page.evaluate(predicate,arg);if(value)return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
    throw new Error('Timed out waiting for asynchronous browser state.');
  }
  async function manual(page,selector){
    if(!await page.locator('#workspaceDialog').isVisible())await menuCommand(page,'File','files');
    if(!await page.locator('#manualHandoffPanel').evaluate(el=>el.open))await page.locator('#manualHandoffPanel>summary').click();
    await page.locator(selector).click();
  }
  try{
    const page=await newPage();
    check(await page.locator('#workspaceDialog').isVisible()&&await page.locator('#chooseFolderInSetup').isVisible()&&!await page.locator('#filesPanel').evaluate(el=>el.open),'first run leads with working-folder setup and keeps manual file inputs collapsed');
    check(await page.locator('#sharedProject,#sharedSubmit,#githubHandoff').count()===0&&!/GitHub/.test(await page.locator('body').innerText()),'local workspace has no repository contribution controls');
    await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');
    await page.locator('#filesPanel>summary').click();
    await page.locator('#load').click();
    check(await page.locator('#fileSetupStatus').isVisible()&&(await page.locator('#fileSetupStatus').innerText()).includes('Choose a source PDF'),'incomplete file setup explains the missing files inside its dialog');
    await page.locator('#sourceFile').setInputFiles({name:'SYNTHETIC-source.pdf',mimeType:'application/pdf',buffer:source});
    await page.locator('#renderedFile').setInputFiles({name:'SYNTHETIC-before.pdf',mimeType:'application/pdf',buffer:before});
    await page.locator('#lyFile').setInputFiles({name:'SYNTHETIC.ly',mimeType:'text/plain',buffer:code});
    await page.locator('#load').click();await settled(page);await page.locator('#workspaceDialog').waitFor({state:'hidden'});
    check(await page.locator('#chooseFolder').isVisible()&&await page.locator('#loadLatest').isVisible()&&!await page.locator('#exportTask').isVisible(),'folder controls lead the ordinary workspace while optional package controls stay in Files and backups');
    await page.locator('#draw').click();const paper=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox();
    const x=paper.x+paper.width*.3,y=Math.max(paper.y,scroll.y)+Math.min(120,scroll.height*.3);
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+55,y+5,{steps:10});await page.mouse.up();
    await page.locator('#comment').fill('SYNTHETIC marked correction: the note should be E.');await page.locator('#saveFinding').click();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC text-only correction: beam these notes together.');await page.locator('#saveFinding').click();
    await page.waitForFunction(()=>document.querySelector('#storage').textContent==='Saved locally');
    const marked=(await state(page)).review;
    check(marked.findings.length===2&&marked.findings[0].strokes.length===1&&marked.findings[1].strokes.length===0,'real brush and text-only controls create two separate saved findings');
    await page.screenshot({path:resolve(evidence,'private-main-workspace.png')});
    await page.reload();await ready(page);await settled(page);
    check((await state(page)).review.findings.length===2&&!await page.locator('#workspaceDialog').isVisible(),'reload restores the private review with its findings');
    await manual(page,'#exportTask');await page.locator('#handoffDownloads .task-download').waitFor({state:'visible'});
    const taskBytes=await download(page,'#handoffDownloads .task-download','private-original-task.zip'),taskZip=await JSZip.loadAsync(taskBytes),task=JSON.parse(await taskZip.file('task.json').async('string'));
    const prompt=await taskZip.file('PROMPT.txt').async('string'),names=Object.keys(taskZip.files);
    check(task.findings.length===2&&!task.shared&&prompt.includes('private review task'),'export creates a real private AI task with both findings');
    check(names.includes('source-original.pdf')&&names.includes('rendered-original.pdf')&&names.includes('lilypond/supplied.ly')&&names.includes('rendered-marked.pdf')&&names.some(name=>name.endsWith('-marked.png')),'task carries originals, editable code, marked PDF and visual finding context');
    check((await taskZip.file('source-original.pdf').async('nodebuffer')).equals(source)&&(await taskZip.file('rendered-original.pdf').async('nodebuffer')).equals(before)&&(await taskZip.file('lilypond/supplied.ly').async('nodebuffer')).equals(code),'original file bytes survive the manual package handoff');
    check(!/GitHub|\.py\b|[A-Z]:[\\/]/i.test(prompt)&&!names.some(name=>/github|shared-workflow|^shared\//i.test(name)),'task instructions have no checkout, absolute Windows path or service dependency');
    // The injected picker returns a real origin-private directory. The same
    // production writer must create the task tree and preserve its bytes.
    await page.evaluate(async()=>{(await import('./app.js')).handoff.io.pickDirectory=()=>navigator.storage.getDirectory();});
    await page.locator('#saveTaskFolder').click();
    await page.waitForFunction(()=>document.querySelector('#folderHandoffStatus')?.textContent.toLowerCase().includes('saved'));
    const directoryFiles=await page.evaluate(async()=>{
      const root=await navigator.storage.getDirectory(),files=[];
      async function visit(dir,prefix=''){for await(const [name,entry]of dir.entries()){const path=prefix+name;if(entry.kind==='directory')await visit(entry,path+'/');else{const file=await entry.getFile(),digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());files.push({path,size:file.size,sha256:[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('')});}}}
      await visit(root);return files;
    });
    const folderTask=directoryFiles.find(file=>file.path.endsWith('/task.json'));
    check(Boolean(folderTask)&&directoryFiles.some(file=>file.path.endsWith('/PROMPT.txt')),'Save task folder writes a real task directory with a prompt for the local agent');
    const prefix=folderTask.path.slice(0,-'task.json'.length);
    for(const name of names.filter(name=>!taskZip.files[name].dir)){const fromZip=await taskZip.file(name).async('nodebuffer'),fromFolder=directoryFiles.find(file=>file.path===prefix+name);assert(fromFolder&&fromFolder.size===fromZip.length&&fromFolder.sha256===sha(fromZip),'folder bytes differ for '+name);}
    check(true,'folder handoff preserves every task payload byte, including PDF context and code');
    await page.locator('#closeHandoff').click();

    // Simulate an external AI response from its exported template. No model or
    // compiler is called; the clearly labelled PDF is synthetic geometry.
    const changed=Buffer.from('% SYNTHETIC changed LilyPond for private workflow QA; no music.\n\\version "2.24.3"\n'),after=await bytes('multipage.pdf');
    const response=JSON.parse(await taskZip.file('response-template.json').async('string'));
    response.code={status:'changed',path:'proposed.ly'};response.rendering={status:'supplied',path:'proposed.pdf',producer:'SYNTHETIC private workflow fixture',compiler:null};
    response.files={'proposed.ly':{size:changed.length,sha256:sha(changed)},'proposed.pdf':{size:after.length,sha256:sha(after)}};
    response.results.forEach(result=>{result.status='changed';result.explanation='SYNTHETIC proposed change for interface verification.';result.codeLocation='SYNTHETIC fixture';});
    const responseZip=await new JSZip().file('response.json',JSON.stringify(response)).file('proposed.ly',changed).file('proposed.pdf',after).generateAsync({type:'nodebuffer'});
    await writeFile(resolve(evidence,'private-synthetic-response.zip'),responseZip);
    await page.locator('#responseFile').setInputFiles({name:'SYNTHETIC-response.zip',mimeType:'application/zip',buffer:responseZip});await page.locator('#acceptResponse').waitFor({state:'visible'});
    check((await page.locator('#handoffStatus').innerText()).includes('validated'),'optional ZIP response import remains available');await page.locator('#closeHandoff').click();
    const fresh=await newPage();await importPackage(fresh,taskBytes,'SYNTHETIC-original-task.zip');
    check((await state(fresh)).review.findings.length===2,'a fresh browser imports the original task and its original findings');
    const invalid=structuredClone(response);invalid.files['proposed.ly'].sha256='0'.repeat(64);
    const invalidZip=await new JSZip().file('response.json',JSON.stringify(invalid)).file('proposed.ly',changed).file('proposed.pdf',after).generateAsync({type:'nodebuffer'}),baseline=(await state(fresh)).review;
    await fresh.locator('#responseFile').setInputFiles({name:'SYNTHETIC-invalid-response.zip',mimeType:'application/zip',buffer:invalidZip});
    await fresh.waitForFunction(()=>document.querySelector('#message').dataset.error==='true');
    check(JSON.stringify((await state(fresh)).review)===JSON.stringify(baseline)&&!(await state(fresh)).returned,'a malformed response is rejected without changing the existing review');
    const responseFolder=resolve(evidence,'SYNTHETIC-response-folder');await mkdir(responseFolder,{recursive:true});
    await writeFile(resolve(responseFolder,'response.json'),JSON.stringify(response));await writeFile(resolve(responseFolder,'proposed.ly'),changed);await writeFile(resolve(responseFolder,'proposed.pdf'),after);
    await manual(fresh,'#importResponse');await fresh.locator('#openResponseFolder').waitFor({state:'visible'});
    const [folderChooser]=await Promise.all([fresh.waitForEvent('filechooser'),fresh.locator('#openResponseFolder').click()]);await folderChooser.setFiles(responseFolder);
    await fresh.locator('#acceptResponse').waitFor({state:'visible'});await fresh.locator('#acceptResponse').click();await fresh.locator('#reviewReturned').waitFor({state:'visible'});await fresh.locator('#reviewReturned').click();await comparisonReady(fresh);
    const current=await state(fresh);
    check(current.returned.reported.length===2&&current.review.files.ly.sha256===sha(changed)&&current.review.files.rendered.sha256===sha(after),'fresh-browser response folder import binds review to the exact changed code and PDF');
    check(await fresh.locator('#sourceLabel').innerText()==='Before correction'&&await fresh.locator('#renderedLabel').innerText()==='AI revision'&&(await fresh.locator('#sourceCount').innerText()).includes('1')&&(await fresh.locator('#renderedCount').innerText()).includes('4'),'comparison shows the previous rendering beside the AI revision despite different page counts');
    await fresh.screenshot({path:resolve(evidence,'private-correction-comparison.png')});
    await fresh.setViewportSize({width:785,height:442});await settled(fresh);await comparisonReady(fresh);await fresh.screenshot({path:resolve(evidence,'private-comparison-compact.png')});
    check(await fresh.locator('#renderedPageNavigation').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight)&&await fresh.locator('#sourceViewer').isVisible(),'compact comparison keeps both score panes and page controls available');
    await fresh.setViewportSize({width:390,height:844});await settled(fresh);await fresh.screenshot({path:resolve(evidence,'private-comparison-narrow.png')});
    check(await fresh.locator('#showRendered').isVisible()&&await fresh.locator('#renderedPage').isVisible()&&await fresh.locator('#correctionHeader').evaluate(el=>el.scrollWidth<=innerWidth),'narrow comparison exposes its score switch without header overflow');
    await fresh.setViewportSize({width:1440,height:900});await settled(fresh);await comparisonReady(fresh);
    await fresh.locator('#looksCorrect').click();await fresh.waitForFunction(()=>document.querySelector('#correctionProgress').textContent==='1/2 checked'&&document.querySelector('#correctionProgress').getAttribute('aria-label')==='1 of 2 corrections checked');await comparisonReady(fresh);
    check((await state(fresh)).returned.reported[0].state==='resolved'&&!(await state(fresh)).returned.reported[1].decision,'approval resolves only the selected correction and advances');
    await fresh.locator('#folderPromptButton').click();await fresh.locator('#handoffDownloads .task-download').waitFor({state:'visible'});
    const followupBytes=await download(fresh,'#handoffDownloads .task-download','private-followup-task.zip'),followupZip=await JSZip.loadAsync(followupBytes),followup=JSON.parse(await followupZip.file('task.json').async('string'));
    check(followup.version===2&&followup.findings.length===1&&followup.findings[0].id===task.findings[1].id,'follow-up task includes the outstanding finding and omits the approved one');
    check(followup.baseline.renderSha256===sha(after)&&followup.findings[0].historicalContext.renderSha256===sha(before),'follow-up retains the current rendering identity and original finding context');
    await fresh.locator('#closeHandoff').click();await menuCommand(fresh,'File','backup');
    await fresh.locator('#finishDownloads>a.download').waitFor({state:'visible'});const finishedBytes=await download(fresh,'#finishDownloads>a.download','private-reviewed-backup.zip'),finishedZip=await JSZip.loadAsync(finishedBytes);
    check(JSON.parse(await finishedZip.file('completion-history.json').async('string')).records.length===0&&!Object.keys(finishedZip.files).some(name=>/github/i.test(name)),'new backup contains the review without adding certification records or contribution instructions');
    const reopened=await newPage();await importPackage(reopened,finishedBytes,'SYNTHETIC-reviewed-backup.zip');await comparisonReady(reopened);
    const restored=await state(reopened);
    check(restored.returned.reported[0].state==='resolved'&&restored.returned.reported[1].state!=='resolved'&&restored.completions.length===0,'fresh-browser review backup preserves decisions, remaining findings, without creating a review declaration');

    // The primary private workflow shares one explicitly selected working
    // directory with a local agent. OPFS provides real browser file handles in
    // this disposable context without granting tests access to user folders.
    const live=await newPage();
    async function writeWorking(files,name='SYNTHETIC-working-folder'){await live.evaluate(async({files,name})=>{
      const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle(name,{create:true});
      for(const [name,bytes]of Object.entries(files)){const handle=await folder.getFileHandle(name,{create:true}),writer=await handle.createWritable();await writer.write(new Uint8Array(bytes));await writer.close();}
    },{files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,[...bytes]])),name});}
    const liveState=()=>live.evaluate(async()=>(await import('./app.js')).folderWorkspace.getState());
    async function publishedTask(count,name='SYNTHETIC-working-folder'){
      // First verify automatic checkpoint saving; prepare the handoff explicitly.
      await until(live,async()=>{const a=await import('./app.js'),s=a.folderWorkspace.getState();return s.ready&&!s.busy&&!a.sessionStatus().dirty;},null,60000);
      await live.evaluate(async()=>{await(await import('./app.js')).folderWorkspace.saveNow();});
      return until(live,async({count,name})=>{
      try{const api=(await import('./app.js')).folderWorkspace,s=api.getState();if(s.busy||s.error||s.lastSavedGeneration!==s.generation)return false;
        const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle(name),desk=await folder.getDirectoryHandle('.scorebrush'),latest=await desk.getDirectoryHandle('latest');
        const read=async name=>JSON.parse(await(await(await latest.getFileHandle(name)).getFile()).text()),ready=await read('READY.json'),task=await read('task.json'),readme=await(await(await folder.getFileHandle('REVIEW_THIS.md')).getFile()).text(),confirmed=await read('READY.json'),after=api.getState();
        return ready.ready===true&&confirmed.ready===true&&ready.generationId===confirmed.generationId&&s.generation===after.generation&&!after.busy&&task.findings.length===count&&task.id===s.headTaskId?{ready,task,readme}:false;
      }catch{return false;}
    },{count,name},60000);}
    async function beginChooseNamedFolder(name){
      await live.evaluate(async name=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle(name);(await import('./app.js')).folderWorkspace.io.pickDirectory=async()=>folder;},name);
      await live.locator('#chooseFolder').click();
    }
    async function chooseNamedFolder(name){
      await beginChooseNamedFolder(name);await until(live,async()=>document.querySelector('#projectChoiceDialog')?.open||document.querySelector('#folderSetupDialog')?.open||!(await import('./app.js')).folderWorkspace.getState().busy);
      if(await live.locator('#projectChoiceDialog').isVisible()){await live.locator('#confirmProjectChoice').click();await until(live,async()=>document.querySelector('#folderSetupDialog')?.open||!(await import('./app.js')).folderWorkspace.getState().busy);}
      if(await live.locator('#folderSetupDialog').isVisible()){await live.locator('#folderSourceSelect').selectOption('source.pdf');await live.locator('#folderRenderedSelect').selectOption('rendered.pdf');await live.locator('#folderLySelect').selectOption('score.ly');await live.locator('#folderSetupConfirm').click();}
    }
    await writeWorking({'source.pdf':source,'rendered.pdf':before,'score.ly':code});
    await live.evaluate(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('SYNTHETIC-working-folder');(await import('./app.js')).folderWorkspace.io.pickDirectory=async()=>folder;});
    await live.locator('#chooseFolderInSetup').click();await live.locator('#folderSetupDialog').waitFor({state:'visible'});
    await live.locator('#folderSourceSelect').selectOption('source.pdf');await live.locator('#folderRenderedSelect').selectOption('rendered.pdf');await live.locator('#folderLySelect').selectOption('score.ly');
    await live.locator('#folderSetupConfirm').click();await settled(live);await live.locator('#folderSetupDialog').waitFor({state:'hidden'});
    await publishedTask(0);
    check((await liveState()).configured&&!(await live.locator('#loadLatest').isDisabled())&&(await state(live)).review.files.source.sha256===sha(source),'Choose working folder loads the selected source, rendering, and LilyPond through real file handles');
    await live.locator('#draw').click();const livePaper=await live.locator('#overlay').boundingBox(),liveScroll=await live.locator('#renderedScroll').boundingBox();
    const liveX=livePaper.x+livePaper.width*.3,liveY=Math.max(livePaper.y,liveScroll.y)+100;
    await live.mouse.move(liveX,liveY);await live.mouse.down();await live.mouse.move(liveX+55,liveY+5,{steps:10});await live.mouse.up();await live.locator('#comment').fill('SYNTHETIC live-folder marked correction: should be E.');await live.locator('#saveFinding').click();
    await live.locator('#newFinding').click();await live.locator('#comment').fill('SYNTHETIC live-folder text-only correction: beam together.');await live.locator('#saveFinding').click();
    await live.locator('#loadLatest').click();
    const savedLive=await publishedTask(2),liveBaseline=(await state(live)).review;
    check(savedLive.task.findings.length===2,'Load latest with unchanged files does not cancel a pending note autosave');
    check(savedLive.ready.ready===true&&savedLive.task.findings.some(f=>f.comment.includes('text-only'))&&savedLive.task.findings.some(f=>f.comment.includes('marked correction')),'explicit handoff preparation publishes the automatically saved brush and text-only findings');
    check(savedLive.readme.includes('REVIEW_THIS')||savedLive.readme.includes('PROMPT.txt'),'working-folder instructions point the local agent to the current correction task');
    check(savedLive.task.baseline.renderSha256===sha(before)&&savedLive.task.baseline.codeSha256===sha(code)&&(await live.locator('#statusLabel').innerText())==='Saved to folder'&&/Saved to/.test(await live.locator('#folderStatus').textContent()),'saved folder task identifies the exact prior rendering and code, with visible compact save status');
    await live.screenshot({path:resolve(evidence,'private-linked-folder-workspace.png')});
    await live.reload();await ready(live);await settled(live);await until(live,async()=>(await import('./app.js')).folderWorkspace.getState().configured);
    check((await state(live)).review.findings.length===2&&!await live.locator('#workspaceDialog').isVisible(),'reload restores the working-folder binding and both private findings');

    // Invalid external PDF bytes must not replace the current review.
    // Retry loading succeeds after the synthetic PDF is repaired.
    if(!await live.locator('#findings .finding-open').first().isVisible())await menuCommand(live,'View','findings');await live.locator('#findings .finding-open').first().click();
    await live.locator('#comment').fill('SYNTHETIC live-folder marked correction: should be E; pending before invalid-PDF load.');await live.locator('#saveFinding').click();
    const beforeFolderError=await live.locator('#sourceViewer').boundingBox();
    await writeWorking({'score.ly':changed,'rendered.pdf':Buffer.from('SYNTHETIC invalid PDF')});await live.locator('#loadLatest').click();await until(live,async()=>{const s=(await import('./app.js')).folderWorkspace.getState();return s.loadError&&/PDF|document|structure/i.test(s.loadNotice);});
    await live.locator('#closeLoadProgress').click();
    check((await state(live)).review.files.ly.sha256===liveBaseline.files.ly.sha256&&!(await state(live)).returned,'an invalid PDF is rejected without replacing the current review');
    check(Math.abs((await live.locator('#sourceViewer').boundingBox()).y-beforeFolderError.y)<1,'long folder status and load-error notifications do not shift the score panes');
    const afterRejectedLoad=await publishedTask(2);
    check(afterRejectedLoad.task.findings.some(f=>f.comment.includes('pending before invalid-PDF load')),'a rejected invalid-PDF update still saves the newest pending correction to the folder');
    check((await liveState()).loadError&&!(await liveState()).error&&await live.locator('#statusControl').getAttribute('data-state')==='attention'&&/PDF|document|structure/i.test(await live.locator('#folderStatus').textContent()),'unrelated successful autosave retains the unresolved load warning without inventing a save failure');
    if(!await live.locator('#notices').evaluate(el=>el.matches(':popover-open')))await live.locator('#statusButton').click();await live.locator('#dismissMessage').click();
    check(await live.locator('#statusControl').getAttribute('data-state')==='attention'&&!await live.locator('#notices').evaluate(el=>el.matches(':popover-open')),'closing folder-load details retains the warning in the header');
    await writeWorking({'rendered.pdf':after});await live.locator('#statusButton').click();await live.locator('#statusRetryLoad').click();await comparisonReady(live);await settled(live);
    check(!(await liveState()).loadError&&!(await liveState()).loadNotice,'successful Retry loading clears the failed-load warning');
    const liveRevision=await state(live);
    check(liveRevision.review.files.ly.sha256===sha(changed)&&liveRevision.review.files.rendered.sha256===sha(after)&&liveRevision.returned.reported.length===2,'Load latest accepts ordinary changed files without requiring a ZIP or response JSON');
    const retainedBefore=await live.evaluate(async()=>{const {completion}=await import('./app.js'),entry=await(await import('./handoff-store.js')).retained(completion.capture().returned.taskId);return (await import('./model.js')).sha256(await entry.files.rendered.blob.arrayBuffer());});
    check(retainedBefore===sha(before),'retained prior-render bytes remain readable after the agent overwrites the working PDF');
    check(await live.locator('#sourceLabel').innerText()==='Before correction'&&(await live.locator('#sourceCount').innerText()).includes('1')&&(await live.locator('#renderedCount').innerText()).includes('4'),'live-folder comparison retains the prior rendering and its original findings');
    await live.screenshot({path:resolve(evidence,'private-live-folder-comparison.png')});
    await live.locator('#looksCorrect').click();await live.waitForFunction(()=>document.querySelector('#correctionProgress').textContent==='1/2 checked'&&document.querySelector('#correctionProgress').getAttribute('aria-label')==='1 of 2 corrections checked');await comparisonReady(live);
    const liveFollowup=await publishedTask(1);
    check(liveFollowup.task.version===2&&liveFollowup.task.findings.length===1&&liveFollowup.task.baseline.renderSha256===sha(after)&&liveFollowup.task.findings[0].historicalContext.renderSha256===sha(before),'explicit handoff preparation includes only the outstanding correction with historical context');
    await writeWorking({'rendered.pdf':Buffer.from('%PDF-1.7\nSYNTHETIC invalid PDF: no objects or trailer.\n')});await menuCommand(live,'Workflow','latest');await until(live,async()=>(await import('./app.js')).folderWorkspace.getState().loadError);
    await live.locator('#closeLoadProgress').click();
    check((await state(live)).review.files.rendered.sha256===sha(after)&&(await state(live)).returned.reported[0].state==='resolved','malformed working-folder PDF leaves the reviewed revision and decisions intact');
    await writeWorking({'rendered.pdf':after});
    await publishedTask(1);
    async function folderHeadBytes(){return live.evaluate(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('SYNTHETIC-working-folder'),desk=await folder.getDirectoryHandle('.scorebrush'),latest=await desk.getDirectoryHandle('latest');return Promise.all(['task.json','READY.json'].map(async name=>[name,[...new Uint8Array(await(await(await latest.getFileHandle(name)).getFile()).arrayBuffer())]]));});}
    const returnedA=(await state(live)).returned;
    await writeWorking({'source.pdf':after,'rendered.pdf':before,'score.ly':code},'SYNTHETIC-second-folder');await chooseNamedFolder('SYNTHETIC-second-folder');await settled(live);
    await live.locator('#newFinding').click();await live.locator('#comment').fill('SYNTHETIC second-folder note.');await live.locator('#saveFinding').click();await publishedTask(1,'SYNTHETIC-second-folder');
    await chooseNamedFolder('SYNTHETIC-working-folder');await settled(live);await comparisonReady(live);const resumedTask=await publishedTask(1),resumedA=await state(live);
    check(resumedA.returned.id===returnedA.id&&resumedA.returned.reported[0].state==='resolved'&&!resumedA.returned.reported[1].decision&&resumedTask.task.version===2&&resumedTask.task.findings[0].id===liveFollowup.task.findings[0].id,'switching working folder A to B and back to A restores its exact revision, decisions, and outstanding correction');
    await live.reload();await ready(live);await settled(live);await comparisonReady(live);await publishedTask(1);
    check((await state(live)).returned.id===returnedA.id&&(await state(live)).returned.reported[0].state==='resolved','reload after switching back to A restores the last open review rather than the most recently edited piece B');
    await live.evaluate(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('SYNTHETIC-working-folder'),desk=await folder.getDirectoryHandle('.scorebrush'),latest=await desk.getDirectoryHandle('latest'),handle=await latest.getFileHandle('task.json'),bytes=await(await handle.getFile()).text(),writer=await handle.createWritable();await writer.write(bytes+'\n');await writer.close();});
    const protectedTampered=await folderHeadBytes();await chooseNamedFolder('SYNTHETIC-working-folder');await until(live,async()=>{const s=(await import('./app.js')).folderWorkspace.getState();return !s.busy&&/already contains saved corrections|Current AI handoff:.*task\.json/.test(s.loadNotice);});
    await new Promise(resolve=>setTimeout(resolve,1800));
    check(JSON.stringify(await folderHeadBytes())===JSON.stringify(protectedTampered)&&(await state(live)).returned.id===returnedA.id,'rejecting a changed task in the currently linked folder does not overwrite its task or READY bytes after the autosave debounce');
    const protectedHead=await folderHeadBytes();
    // Forget only the binding in this disposable origin; neither saved review
    // nor folder data is deleted. This models a browser without that binding.
    await live.evaluate(async()=>{await(await import('./app.js')).folderWorkspace.io.putSettings(null);});
    await live.reload();await ready(live);await settled(live);await comparisonReady(live);
    await live.evaluate(async()=>{const root=await navigator.storage.getDirectory(),folder=await root.getDirectoryHandle('SYNTHETIC-working-folder'),io=(await import('./app.js')).folderWorkspace.io;io.pickDirectory=async()=>folder;});
    await chooseNamedFolder('SYNTHETIC-working-folder');
    await until(live,async()=>{const s=(await import('./app.js')).folderWorkspace.getState();return !s.busy&&/already contains saved corrections|Current AI handoff:.*task\.json/.test(s.loadNotice);});
    if(!await live.locator('#notices').evaluate(el=>el.matches(':popover-open')))await live.locator('#statusButton').click();
    check(!(await liveState()).configured&&JSON.stringify(await folderHeadBytes())===JSON.stringify(protectedHead)&&(await state(live)).returned.reported[0].state==='resolved'&&await live.locator('#statusControl').getAttribute('data-state')==='attention'&&await live.locator('#folderStatus').isVisible()&&/already contains saved corrections|Current AI handoff:.*task\.json/.test(await live.locator('#folderStatus').innerText()),'a browser without the folder binding visibly refuses to overwrite existing task or READY bytes');
    await writeFile(resolve(evidence,'private-live-folder-task.json'),JSON.stringify(liveFollowup,null,2));
    check(blocked.length===0&&requests.every(address=>!/^https?:/.test(address)||new URL(address).origin===server.origin),'entire private workflow requested only local app resources');
    check(!requests.some(address=>/\/(?:api|auth)\/|shared-config\.json|shared-ui\.js|github-handoff\.js/.test(address)),'private workflow never loads project-service or account endpoints');
    check(errors.length===0,'private round trip finishes without uncaught browser errors: '+errors.join('; '));
    return {name:'private folder and portable handoff workflow',assertions};
  }catch(error){
    log.push('FAIL '+error.stack);log.push('STATE '+JSON.stringify(await pages.at(-1)?.evaluate(async()=>{const a=await import('./app.js');return {folder:a.folderWorkspace.getState(),session:a.sessionStatus()};}).catch(()=>null)));for(let i=0;i<pages.length;i++)try{await pages[i].screenshot({path:resolve(evidence,`private-failure-${i}.png`),fullPage:true});await writeFile(resolve(evidence,`private-failure-${i}.txt`),await pages[i].locator('body').innerText());}catch{}
    throw error;
  }finally{await writeFile(resolve(evidence,'private-workflow.txt'),log.join('\n')+'\n');await writeFile(resolve(evidence,'private-network.json'),JSON.stringify({requests,blocked,errors},null,2));for(const context of contexts)await context.close();await server.close();}
}
