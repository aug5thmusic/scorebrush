// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';
import {seedCurrentHandoffHistory} from './current-handoff-fixture.mjs';
import {exerciseCurrentBaseline,exerciseLegacyCurrentBaseline} from './current-baseline-flow.mjs';

// The real final approval, finished-PDF writer and both Retry buttons must stay
// bounded even when an old project contains thousands of captured edit records.
export async function runCurrentCompletion({browser,serve,evidence,root,baselineRace=false,legacyOnly=false}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[],report={runs:[]},errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('current-completion: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.completionAudit={reads:[],enumerations:[],writes:[],progress:[]};window.failFinishedPDF=false;window.failedFinishedWrites=0;
    const parents=new WeakMap(),handle=FileSystemDirectoryHandle.prototype.getFileHandle;
    FileSystemDirectoryHandle.prototype.getFileHandle=async function(...args){const result=await handle.apply(this,args);parents.set(result,this.name);return result;};
    const read=FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile=function(...args){completionAudit.reads.push(this.name);return read.apply(this,args);};
    const entries=FileSystemDirectoryHandle.prototype.entries;
    FileSystemDirectoryHandle.prototype.entries=function(...args){completionAudit.enumerations.push(this.name);return entries.apply(this,args);};
    const create=FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable=async function(...args){
      const name=this.name,parent=parents.get(this);
      if(failFinishedPDF&&parent==='Latest'&&name.toLowerCase().endsWith('.pdf')){failedFinishedWrites++;throw Error('SYNTHETIC interrupted finished PDF publication');}
      const stream=await create.apply(this,args),write=stream.write.bind(stream);
      stream.write=async value=>{completionAudit.writes.push({name,parent});return write(value);};return stream;
    };
    document.addEventListener('score-desk-folder-status',()=>{const text=document.querySelector('#folderStatus')?.textContent;if(text&&completionAudit.progress.at(-1)!==text)completionAudit.progress.push(text);});
  });
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const idle=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending&&!a.folderWorkspace.getState().busy,180000);
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;},180000);
  const reset=()=>page.evaluate(()=>{window.completionAudit={reads:[],enumerations:[],writes:[],progress:[]};window.completionStarted=performance.now();});
  const record=async label=>{
    const result=await page.evaluate(()=>{
      const old=new Set(JSON.parse(localStorage.getItem('SYNTHETIC-handoff-old-objects'))),allowed=new Set(JSON.parse(localStorage.getItem('SYNTHETIC-handoff-allowed-objects')));
      const objectReads=completionAudit.reads.filter(name=>/^[a-f0-9]{64}$/.test(name)),f=a.folderWorkspace.getState();
      return {elapsedMs:performance.now()-completionStarted,reads:completionAudit.reads.length,oldReads:completionAudit.reads.filter(name=>old.has(name)).length,
        unexpectedObjectReads:[...new Set(objectReads.filter(name=>!allowed.has(name)))],objectReads:[...new Set(objectReads)],objectEnumerations:completionAudit.enumerations.filter(name=>name==='objects').length,
        writes:completionAudit.writes,progress:completionAudit.progress,error:f.error,recoveryId:f.recoveryId,ready:f.ready,failedFinishedWrites,
        summaryTitle:document.querySelector('#roundSummaryTitle').textContent,summaryStatus:document.querySelector('#roundSummaryStatus').textContent};
    });result.label=label;report.runs.push(result);await writeFile(resolve(evidence,legacyOnly?'current-baseline-legacy-performance.json':baselineRace?'current-baseline-performance.json':'current-completion-performance.json'),JSON.stringify(report,null,2));return result;
  };
  const archive=()=>page.evaluate(async()=>{
    const config=await a.folderWorkspace.io.getSettings(),data=await config.directory.getDirectoryHandle('.scorebrush'),recovery=await data.getDirectoryHandle('recovery'),generation=await recovery.getDirectoryHandle('g-'+config.recoveryId),{sha256}=await import('./model.js');
    const hash=async(dir,name)=>sha256(await(await(await dir.getFileHandle(name)).getFile()).arrayBuffer());
    return {id:config.recoveryId,commit:await hash(generation,'COMMIT.json'),snapshot:await hash(generation,'snapshot.json'),history:await hash(config.directory,'History.json')};
  });
  const bounded=(result,label)=>{
    check(result.oldReads===0&&result.unexpectedObjectReads.length===0&&result.objectEnumerations===0,label+' reads only current approval inputs without traversing retained history');
    check(result.reads<250,label+' has bounded reads with thousands of retained objects');
    check(result.recoveryId===report.fixture.recoveryId&&!result.writes.some(({name})=>['COMMIT.json','snapshot.json','History.json'].includes(name)),label+' leaves immutable history and its research index unchanged');
  };
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const {fixtureBlob}=await import('./qa/fixtures.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC current completion history',{create:true});
      for(const[name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(let i=1;i<=3;i++){await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC completion correction '+i);await page.locator('#saveFinding').click();await idle();}await saved();
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),stream=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();await stream.write(await(await import('./qa/fixtures.js')).fixtureBlob('rendered.pdf'));await stream.close();await a.folderWorkspace.loadLatest();});await idle();await saved();
    report.fixture=await page.evaluate(seedCurrentHandoffHistory,legacyOnly?{history:2,legacy:1,handoffs:1}:undefined);
    check((legacyOnly?report.fixture.objects<100:report.fixture.objects>=4000&&report.fixture.objects<5000)&&report.fixture.bytes<40*1024*1024,legacyOnly?'legacy compatibility fixture uses small synthetic files':'completed-review fixture retains thousands of records using small synthetic files');
    await page.reload();await boot();await saved();report.archiveBefore=await archive();
    if(legacyOnly){await exerciseLegacyCurrentBaseline({page,evidence,report,check,reset,record,idle,saved});check(errors.length===0,'legacy headless recovery has no uncaught browser errors');return {name:'current-baseline-legacy',assertions};}
    if(baselineRace){await exerciseCurrentBaseline({page,evidence,report,check,reset,record,idle,saved,archive});check(errors.length===0,'new-rendering baseline and completed-round flow have no uncaught browser errors');return {name:'current-baseline',assertions};}
    for(let i=0;i<2;i++){await page.evaluate(i=>a.corrections.selectFinding(a.completion.capture().returned.reported[i].id),i);await idle();await page.locator('#looksCorrect').click();await idle();await saved();}
    await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported[2].id));await idle();
    await reset();await page.evaluate(()=>window.failFinishedPDF=true);await page.locator('#looksCorrect').click();
    await waitUntil(page,()=>Boolean(a.folderWorkspace.getState().error)&&!a.folderWorkspace.getState().busy&&!a.sessionStatus().dirty,180000);
    await page.locator('#roundSummary').waitFor();await page.locator('#retryRoundSave').waitFor();const failed=await record('final approval with failed finished PDF write');
    report.decisionsBeforeRetry=await page.evaluate(()=>({revisionId:a.completion.capture().revisionId,returned:a.completion.capture().returned,review:a.completion.capture().review}));
    check(report.decisionsBeforeRetry.returned.reported.every(f=>f.decision?.state==='resolved')&&failed.summaryTitle==='Review complete','the completed review is saved locally despite its finished-PDF publication failure');

    // A deliberate retry while the fault remains must fail without a historical
    // rebuild. Then retry through Resolve, exercising its different API binding.
    await page.waitForTimeout(550);await reset();await page.locator('#retryRoundSave').click();await idle();
    const summaryRetry=await record('summary Retry while finished PDF remains unwritable');
    await page.locator('#dismissRoundSummary').click();await page.evaluate(()=>window.failFinishedPDF=false);
    await page.locator('#statusButton').click();await page.locator('#statusRetryFolder').waitFor();await reset();await page.locator('#statusRetryFolder').click();await idle();
    const statusRetry=await record('status Retry after finished PDF writer recovers');
    report.finished=await page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),{sha256}=await import('./model.js'),data=await config.directory.getDirectoryHandle('.scorebrush');
      const checkpoint=JSON.parse(await(await(await data.getFileHandle('current-review.json')).getFile()).text()),saved=await(await import('./storage.js')).getSaved(scene.workspaceId),checked=await a.folderWorkspace.checkFinishedPDF();
      let exactPDF=false,receipt=null;if(checked.state==='match'){
        const [directory,name]=checked.path.split('/'),file=await(await(await config.directory.getDirectoryHandle(directory)).getFileHandle(name)).getFile();
        exactPDF=file.size===scene.review.files.rendered.size&&await sha256(await file.arrayBuffer())===scene.review.files.rendered.sha256;
        receipt=JSON.parse(await(await(await data.getFileHandle('finished-pdf.json')).getFile()).text());
      }
      return {checked,exactPDF,receipt,checkpoint,review:scene.review,returned:scene.returned,revisionId:scene.revisionId,localReview:saved.review,localReturned:saved.returned};
    });report.archiveAfter=await archive();
    check(failed.failedFinishedWrites===1&&failed.error.includes('SYNTHETIC interrupted finished PDF publication'),'final approval reaches the real finished PDF write before the injected failure');
    check(summaryRetry.failedFinishedWrites===2&&summaryRetry.error.includes('SYNTHETIC interrupted finished PDF publication')&&summaryRetry.summaryStatus.includes('SYNTHETIC interrupted finished PDF publication'),'summary Retry reattempts the failed publication and retains the useful error');
    for(const run of [failed,summaryRetry,statusRetry])bounded(run,run.label);
    check(!statusRetry.error&&statusRetry.ready&&report.finished.checked.state==='match'&&report.finished.exactPDF,'status Retry publishes and verifies the exact approved PDF before reporting success');
    assert.deepEqual(report.archiveAfter,report.archiveBefore);check(true,'failed publication and both retries preserve exact archived bytes');
    assert.deepEqual({revisionId:report.finished.revisionId,returned:report.finished.returned,review:report.finished.review},report.decisionsBeforeRetry);
    assert.deepEqual(report.finished.localReview,report.finished.review);assert.deepEqual(report.finished.localReturned,report.finished.returned);
    check(report.finished.receipt?.current?.revisionId===report.finished.revisionId,'successful publication and both saved stores retain the exact completed review and revision');
    // A missing owned output is a derived-file failure, even when the review
    // checkpoint and folder status are already clean. Retry must repair it.
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),checked=await a.folderWorkspace.checkFinishedPDF(),[dir,name]=checked.path.split('/');await(await config.directory.getDirectoryHandle(dir)).removeEntry(name);a.corrections.showSummary();});
    await page.locator('#retryRoundSave').waitFor();await page.waitForTimeout(550);await reset();await page.locator('#retryRoundSave').click();await idle();
    const missingRetry=await record('summary Retry repairs a missing finished PDF with a clean checkpoint');bounded(missingRetry,missingRetry.label);
    check(await page.evaluate(async()=>(await a.folderWorkspace.checkFinishedPDF()).state==='match'),'clean-checkpoint Retry recreates and verifies the missing owned finished PDF');
    assert.deepEqual(await archive(),report.archiveBefore);check(true,'repairing a missing finished PDF preserves exact archived bytes');
    await page.reload();await boot();await saved();
    check(await page.evaluate(async()=>{const scene=a.completion.capture();return scene.returned.reported.every(f=>f.decision?.state==='resolved')&&(await a.folderWorkspace.checkFinishedPDF()).state==='match';}),'reopening preserves the completed review and its verified finished PDF');
    check(errors.length===0,'completed-review recovery has no uncaught browser errors');
    return {name:'current-completion',assertions};
  }catch(error){report.failure=error.stack;report.last=await page.evaluate(()=>({folder:window.a?.folderWorkspace.getState(),title:document.querySelector('#roundSummaryTitle')?.textContent,status:document.querySelector('#roundSummaryStatus')?.textContent})).catch(()=>null);log.push(error.stack);await page.screenshot({path:resolve(evidence,'current-completion-failure.png')}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,legacyOnly?'current-baseline-legacy-performance.json':baselineRace?'current-baseline-performance.json':'current-completion-performance.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,legacyOnly?'current-baseline-legacy.txt':baselineRace?'current-baseline.txt':'current-completion.txt'),log.join('\n'));await context.close();await server.close();}
}
