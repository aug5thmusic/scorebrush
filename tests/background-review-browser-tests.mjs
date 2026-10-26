// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {installResumeAudit,folderSnapshot,assertCleanAudit,beginClose,finishClose} from './clean-resume-helpers.mjs';

export async function runBackgroundReview({browser,serve,evidence,root,setupFolder=null,onPendingClose=null}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[],timing={};let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('background-review: '+label);};
  page.on('pageerror',e=>errors.push(e.message));
  if(!setupFolder)await installResumeAudit(page);
  const until=async(fn,timeout=90000)=>{const end=Date.now()+timeout;while(!await page.evaluate(fn)){if(Date.now()>end)throw Error('Timed out: '+fn);await new Promise(r=>setTimeout(r,20));}};
  const local=()=>until(()=>!window.a.corrections.state().pending&&!window.a.sessionStatus().busy&&!window.a.sessionStatus().dirty&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true'));
  const saved=()=>until(()=>{const f=window.a.folderWorkspace.getState();return f.ready&&!f.busy;});
  const decisions=()=>page.evaluate(()=>window.a.completion.capture().returned.reported.filter(f=>f.decision).length);
  const screenshot=async name=>{for(let attempt=0;attempt<2;attempt++){await page.bringToFront();try{await page.screenshot({path:resolve(evidence,name),timeout:10000});return;}catch(e){if(attempt)throw e;}}};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js');window.fixtureBlob=fixtureBlob;
    });
    if(setupFolder)await setupFolder(page);else await page.evaluate(async()=>{
      const d=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC slow review',{create:true});window.slowFolder=d;
      for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const w=await(await d.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}
      window.a.folderWorkspace.io.pickDirectory=async()=>({directory:d,absolutePath:'C:\\SYNTHETIC slow review',nativeBinding:'a'.repeat(32)});
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await saved();
    await page.evaluate(async()=>window.slowFolder=(await window.a.folderWorkspace.io.getSettings()).directory);
    for(let i=1;i<=4;i++){await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC correction '+i);await page.locator('#saveFinding').click();await local();}await saved();
    await page.evaluate(async()=>{const w=await(await window.slowFolder.getFileHandle('rendered.pdf')).createWritable();await w.write(await window.fixtureBlob('rendered.pdf'));await w.close();await window.a.folderWorkspace.loadLatest();});await local();await saved();
    await page.evaluate(()=>{
      window.metrics={pdfHashes:0,pdfBytes:0,evidenceBuilds:0,historyScans:0,folderReads:0,writes:0,packages:0};
      const digest=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(algorithm,bytes)=>{const b=ArrayBuffer.isView(bytes)?new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength):new Uint8Array(bytes);if(b[0]===37&&b[1]===80&&b[2]===68&&b[3]===70){window.metrics.pdfHashes++;window.metrics.pdfBytes+=b.length;}return digest(algorithm,bytes);};
      const WorkerOriginal=window.Worker;window.Worker=class extends WorkerOriginal{constructor(url,...args){if(String(url).includes('evidence-worker'))window.metrics.evidenceBuilds++;super(url,...args);}};
      const all=IDBObjectStore.prototype.getAll;IDBObjectStore.prototype.getAll=function(...args){window.metrics.historyScans++;return all.apply(this,args);};
      const get=FileSystemFileHandle.prototype.getFile;FileSystemFileHandle.prototype.getFile=function(...args){window.metrics.folderReads++;return get.apply(this,args);};
      // Ordinary decisions replace the current checkpoint; archive snapshots
      // are written at score-version boundaries. Delay the actual save path.
      const writable=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){const name=this.name,w=await writable.apply(this,args),write=w.write.bind(w);w.write=async data=>{window.metrics.writes++;if(window.failFolder&&name==='current-review.json')throw Error('SYNTHETIC folder save failed');if(window.slowWrites&&name==='current-review.json'){const item={name,started:performance.now(),finished:null};window.writeDelays.push(item);await new Promise(r=>setTimeout(r,5000));item.finished=performance.now();}return write(data);};return w;};
      const make=window.a.operations.makePackage;window.a.operations.makePackage=(...args)=>{window.metrics.packages++;return make(...args);};
      window.savedPut=window.a.operations.putSaved;window.writeDelays=[];
    });
    // The same three real approvals/saves are measured before and after changes.
    const started=Date.now();
    for(let i=0;i<3;i++){await page.locator('#looksCorrect').click();await local();await page.evaluate(()=>window.a.folderWorkspace.saveNow());await saved();}
    const measurement={...await page.evaluate(()=>window.metrics),elapsedMs:Date.now()-started};
    await writeFile(resolve(evidence,'background-review-measurement.json'),JSON.stringify(measurement,null,2));console.log('MEASURE '+JSON.stringify(measurement));
    if(process.env.SCORE_DESK_REVIEW_MEASURE_ONLY==='1')return {name:'background-review-measurement',assertions:0};
    check(await decisions()===3,'benchmark saves three decisions against the connected folder');
    // Two retained workspaces have durable edit journals: one handoff scan
    // plus both journals per save, for a scan budget of 9.
    check(measurement.evidenceBuilds===0&&measurement.historyScans<=9&&measurement.pdfHashes<200,'unchanged evidence is reused within the complete two-workspace history scan budget');
    check(await page.evaluate(async()=>{
      const s=window.a.completion.capture(),make=window.a.operations.makePackage;
      const one=await make(s.review,s.files,s.doc,'120'),metadata=structuredClone(s.review);metadata.updatedAt='2026-10-24T00:00:00.000Z';
      const two=await make(metadata,s.files,s.doc,'120');
      const marked=one.get('rendered-marked.pdf');
      if(marked!==two.get('rendered-marked.pdf')||await one.get('annotations.json').text()===await two.get('annotations.json').text())return false;
      const withNote=structuredClone(metadata);withNote.findings=[{id:'SYNTHETIC-cache-note',number:1,page:1,color:'#ffd34d',strokes:[],bounds:null,state:'open',comment:'First printed note'}];
      const three=await make(withNote,s.files,s.doc,'120');withNote.findings[0].comment='Changed printed note';const four=await make(withNote,s.files,s.doc,'120');
      return three.get('rendered-marked.pdf')!==four.get('rendered-marked.pdf')&&marked!==three.get('rendered-marked.pdf');
    }),'evidence reuse preserves fresh annotations and regenerates the PDF when printed note content changes');
    // Start a fresh correction round with the same four reported findings.
    await page.evaluate(async()=>{
      const a=window.a,s=a.completion.capture();window.roundIds=s.returned.reported.map(f=>f.id);
      // Reset through an actual saved review record, preserving CAS and its
      // history. Synthetic state preparation is not an acceptance action.
      const record=await(await import('./storage.js')).getSaved(s.workspaceId),next=structuredClone(record);
      for(const f of next.returned.reported){f.decision=null;f.state='open';}
      next.revisionId=crypto.randomUUID();await a.operations.putSaved(next,record.storageRevision);
    });
    await page.locator('#roundReload').evaluate(el=>el.click());await local();await saved();await page.evaluate(()=>window.a.corrections.selectFinding(window.roundIds[0]));await local();
    await page.evaluate(()=>{window.slowWrites=true;window.writeDelays=[];});
    await page.locator('#looksCorrect').focus();await page.keyboard.press('c');await local();await until(()=>window.writeDelays.some(w=>!w.finished));
    const nextStarted=Date.now();await page.keyboard.press('c');await until(()=>window.a.completion.capture().returned.reported.filter(f=>f.decision).length===2,2000);await local();
    timing.secondDecisionMs=Date.now()-nextStarted;
    check(timing.secondDecisionMs<2000&&await page.evaluate(()=>window.a.folderWorkspace.getState().busy&&window.writeDelays.some(w=>!w.finished)),'a second C saves locally and advances while a five-second folder write is still pending');
    await page.keyboard.press('w');check(await page.locator('#correctionResponse').isVisible(),'W opens the explanation editor during background saving');await page.keyboard.press('Escape');
    await page.keyboard.press('x');await local();check(await decisions()===2,'X remains available without approving during background saving');
    await page.evaluate(()=>window.a.corrections.selectFinding(window.roundIds[2]));await local();await page.locator('#stillCorrection').click();check(await page.locator('#correctionResponse').isVisible(),'mouse Still wrong has the same background-save availability as W');await page.locator('#cancelCorrectionResponse').click();
    await page.locator('#skipCorrection').click();await local();check(await decisions()===2,'mouse Next has the same background-save behavior as X');
    await page.locator('#skipCorrection').click();await until(()=>document.querySelector('#roundSummary').open);await page.waitForTimeout(550);check(await page.locator('#roundSummaryTitle').innerText()==='Keep reviewing'&&await page.locator('#reviewUnchecked').isEnabled(),'end-of-queue Review remaining remains available during background folder saving');await page.locator('#reviewUnchecked').click();await local();
    await page.evaluate(()=>window.a.corrections.selectFinding(window.roundIds[2]));await local();await page.locator('#looksCorrect').click();await local();check(await decisions()===3,'mouse approval advances after local save without waiting for the folder');
    // Failed local persistence never advances or acknowledges final approval.
    await page.evaluate(()=>window.a.operations.putSaved=async()=>{throw Error('SYNTHETIC local decision failure');});await page.keyboard.press('c');await local();
    check(await decisions()===3&&await page.locator('#roundSummary').isHidden(),'failed local save preserves the last unchecked correction and suppresses completion');
    await page.evaluate(()=>{window.a.operations.putSaved=window.savedPut;window.failFolder=true;});
    await page.keyboard.down('c');await local();check(await decisions()===4&&await page.locator('#roundSummary').isHidden(),'final approval is local while held C cannot open or activate completion');
    await page.keyboard.down('c');await new Promise(r=>setTimeout(r,150));check(await decisions()===4,'held/repeated C never approves twice');
    const released=Date.now();await page.keyboard.up('c');await until(()=>document.querySelector('#roundSummary').open,1500);
    timing.completionAfterReleaseMs=Date.now()-released;
    check(timing.completionAfterReleaseMs<1500&&await page.locator('#roundSummaryTitle').innerText()==='Review complete','key release acknowledges all approvals immediately, independently of folder saving');
    check(await page.locator('#roundSummaryStatus').innerText()!==''&&await page.locator('#summaryFolderFiles').isDisabled(),'completion shows short preparation status and does not enable its folder action early');
    await screenshot('background-review-preparing.png');
    await until(()=>Boolean(window.a.folderWorkspace.getState().error));
    check(await page.locator('#roundSummaryTitle').innerText()==='Review complete'&&await page.locator('#retryRoundSave').isVisible()&&await decisions()===4,'folder failure retains the approval acknowledgement and offers retry');
    await page.evaluate(()=>{window.failFolder=false;});await page.locator('#retryRoundSave').click();await saved();await until(()=>!document.querySelector('#summaryFolderFiles').disabled);
    check(await page.locator('#roundSummaryTitle').innerText()==='Review complete'&&await page.locator('#summaryFolderFiles').isEnabled(),'retry finishes the folder output and enables Open working folder');
    check(await page.evaluate(()=>window.writeDelays.filter(w=>w.finished).every(w=>w.finished-w.started>=4900)),'instrumented folder writes actually remained pending for five seconds');
    timing.writeDurationsMs=await page.evaluate(()=>window.writeDelays.filter(w=>w.finished).map(w=>w.finished-w.started));
    await writeFile(resolve(evidence,'background-review-timing.json'),JSON.stringify(timing,null,2));
    check(await page.evaluate(async()=>{const s=window.a.completion.capture(),r=await(await import('./storage.js')).getSaved(s.workspaceId);return JSON.stringify(r.returned)===JSON.stringify(s.returned)&&r.revisionId===s.revisionId;}),'all final approvals remain durably saved against the exact local revision');
    await screenshot('background-review-complete.png');
    if(onPendingClose){
      await page.locator('#dismissRoundSummary').click();await local();await page.locator('#looksCorrect').focus();
      await page.evaluate(()=>window.writeDelays=[]);await page.keyboard.press('c');await local();await until(()=>window.writeDelays.some(w=>!w.finished));
      await onPendingClose(page,check);
    }
    if(!setupFolder&&!onPendingClose){
      // The native delayed-save close branch above stays unchanged. Exercise an
      // additional rejected final finding against a real synthetic OPFS handoff.
      await context.grantPermissions(['clipboard-read','clipboard-write']);
      await page.locator('#dismissRoundSummary').click();await local();
      const previousTask=await page.evaluate(()=>window.a.folderWorkspace.getState().headTaskId);
      await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC final correction still wrong after local approval');await local();
      await page.evaluate(()=>window.failFolder=true);await page.keyboard.down('Enter');await local();
      check(await page.locator('#roundSummary').isHidden(),'final rejection waits for key release while folder saving continues');
      await page.keyboard.up('Enter');await until(()=>document.querySelector('#roundSummary').open,1500);
      check(await page.locator('#roundSummaryTitle').innerText()==='Another correction round'&&await page.locator('#nextAIPrompt').inputValue()===''&&await page.locator('#sendRemaining').isHidden(),'locally verified rejection opens another round without displaying the previous saved prompt');
      await until(()=>Boolean(window.a.folderWorkspace.getState().error));
      check(await page.locator('#roundSummaryTitle').innerText()==='Another correction round'&&await page.locator('#retryRoundSave').isVisible()&&await page.locator('#nextAIPrompt').inputValue()===''&&await page.locator('#sendRemaining').isHidden(),'failed folder publication retains next-round direction and suppresses stale prompt copying');
      await page.waitForTimeout(550);await page.evaluate(()=>{window.failFolder=false;window.slowWrites=false;});await page.locator('#retryRoundSave').click();await saved();await until(()=>!document.querySelector('#sendRemaining').hidden&&!document.querySelector('#sendRemaining').disabled);
      const handoff=await page.evaluate(async()=>{
        const a=window.a,{sha256}=await import('./model.js'),config=await a.folderWorkspace.io.getSettings(),latest=await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('latest');
        const blob=async path=>{let d=latest;const parts=path.split('/');for(const name of parts.slice(0,-1))d=await d.getDirectoryHandle(name);return(await d.getFileHandle(parts.at(-1))).getFile();};
        const ready=JSON.parse(await(await blob('READY.json')).text()),mb=await blob('manifest.json'),manifest=JSON.parse(await mb.text());let valid=ready.ready&&ready.manifestSha256===await sha256(await mb.arrayBuffer());
        for(const [name,info]of Object.entries(manifest.payloads)){const b=await blob(name);valid&&=b.size===info.size&&await sha256(await b.arrayBuffer())===info.sha256;}
        return {ready,valid,task:JSON.parse(await(await blob('task.json')).text()),prompt:await(await blob('PROMPT.txt')).text(),current:a.folderWorkspace.savedPrompt(),id:a.completion.capture().returned.reported.at(-1).id};
      });
      check(handoff.valid&&handoff.ready.taskId===handoff.current.taskId&&handoff.current.taskId!==previousTask&&handoff.task.findings.length===1&&handoff.task.findings[0].id===handoff.id&&handoff.task.findings[0].reviewer.explanation==='SYNTHETIC final correction still wrong after local approval','retry validates a new exact handoff containing only the rejected finding and its latest explanation');
      await page.locator('#sendRemaining').click();check(await page.locator('#nextAIPrompt').inputValue()===handoff.prompt&&handoff.current.text===handoff.prompt&&(await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')===handoff.prompt,'folder PROMPT.txt, validated saved prompt, display and clipboard match exactly');
      await writeFile(resolve(evidence,'background-next-prompt.json'),JSON.stringify(handoff,null,2));await screenshot('background-review-another-round.png');
      const before=await folderSnapshot(page);await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');
      await page.evaluate(async()=>window.a=await import('./app.js'));await beginClose(page);const close=await finishClose(page);await saved();
      assert.deepEqual(await folderSnapshot(page),before);const audit=await assertCleanAudit(page);
      check(close.local&&close.folder&&close.idle&&!close.error,'after failed/delayed approval saves recover, startup and close perform zero redundant publication');
      await writeFile(resolve(evidence,'background-review-clean-close.json'),JSON.stringify({close,audit},null,2));
    }
    check(!errors.length,'no uncaught errors: '+errors.join('; '));return {name:'background-review',assertions};
  }catch(e){log.push('FAIL '+e.stack);await page.screenshot({path:resolve(evidence,'background-review-failure.png')}).catch(()=>{});throw e;}
  finally{await writeFile(resolve(evidence,'background-review.txt'),log.join('\n'));await context.close();await server.close();}
}
