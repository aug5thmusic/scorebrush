// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';
import {seedCurrentHandoffHistory} from './current-handoff-fixture.mjs';

// Real OPFS, IndexedDB, package rendering and publication in a disposable origin.
// Deterministic I/O assertions protect the native path from archive-size costs;
// elapsed times here describe browser/OPFS, not Windows WebView2 performance.
export async function runCurrentHandoff({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[],report={runs:[]},errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('current-handoff: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.handoffAudit={reads:[],enumerations:[],writes:[],closes:[]};
    const read=FileSystemFileHandle.prototype.getFile;FileSystemFileHandle.prototype.getFile=function(...args){handoffAudit.reads.push(this.name);return read.apply(this,args);};
    const entries=FileSystemDirectoryHandle.prototype.entries;FileSystemDirectoryHandle.prototype.entries=function(...args){handoffAudit.enumerations.push(this.name);return entries.apply(this,args);};
    const create=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){
      const name=this.name,stream=await create.apply(this,args),write=stream.write.bind(stream),close=stream.close.bind(stream);
      stream.write=async value=>{handoffAudit.writes.push(name);return write(value);};stream.close=async()=>{const result=await close();handoffAudit.closes.push(name);return result;};return stream;
    };
  });
  const local=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending,180000);
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;},180000);
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const closePrompt=async()=>{if(await page.locator('#folderPromptDialog').isVisible())await page.locator('#closeFolderPrompt').click();};
  async function edit(text){
    await closePrompt();if(await page.locator('#roundSummary').isVisible())await page.locator('#dismissRoundSummary').click();
    await page.evaluate(()=>a.corrections.selectFinding(a.completion.capture().returned.reported[0].id));await local();
    await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill(text);await page.locator('#sendCorrectionResponse').click();await local();await saved();
  }
  async function disk(){
    return page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),{sha256}=await import('./model.js'),data=await config.directory.getDirectoryHandle('.scorebrush'),latest=await data.getDirectoryHandle('latest');
      const at=async path=>{let directory=latest;const parts=path.split('/');for(const name of parts.slice(0,-1))directory=await directory.getDirectoryHandle(name);return(await directory.getFileHandle(parts.at(-1))).getFile();};
      const ready=JSON.parse(await(await at('READY.json')).text()),manifestBlob=await at('manifest.json'),manifest=JSON.parse(await manifestBlob.text());let valid=ready.ready&&await sha256(await manifestBlob.arrayBuffer())===ready.manifestSha256;
      for(const[path,info]of Object.entries(manifest.payloads)){const blob=await at(path);valid&&=blob.size===info.size&&await sha256(await blob.arrayBuffer())===info.sha256;}
      const checkpoint=JSON.parse(await(await(await data.getFileHandle('current-review.json')).getFile()).text());
      return {valid,ready,checkpointId:checkpoint.id,prompt:await(await at('PROMPT.txt')).text(),task:JSON.parse(await(await at('task.json')).text()),headId:config.head?.id,headPrompt:config.head?.prompt,recoveryId:config.recoveryId};
    });
  }
  async function send(label){
    await closePrompt();await page.evaluate(()=>{window.handoffAudit={reads:[],enumerations:[],writes:[],closes:[]};window.handoffStarted=performance.now();});
    await page.locator('#folderPromptButton').click();
    await waitUntil(page,()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return !document.querySelector('#copyFolderPrompt').disabled&&!f.busy;},180000);
    const result=await page.evaluate(()=>{
      const old=new Set(JSON.parse(localStorage.getItem('SYNTHETIC-handoff-old-objects'))),oldReads=handoffAudit.reads.filter(name=>old.has(name)),allowed=new Set(JSON.parse(localStorage.getItem('SYNTHETIC-handoff-allowed-objects'))),objectReads=handoffAudit.reads.filter(name=>/^[a-f0-9]{64}$/.test(name)),unexpectedObjectReads=[...new Set(objectReads.filter(name=>!allowed.has(name)))];
      return {elapsedMs:performance.now()-handoffStarted,reads:handoffAudit.reads.length,oldReads:oldReads.length,oldReadSample:oldReads.slice(0,8),objectReads:[...new Set(objectReads)],unexpectedObjectReads,objectEnumerations:handoffAudit.enumerations.filter(name=>name==='objects').length,writes:handoffAudit.writes,closes:handoffAudit.closes,recoveryId:a.folderWorkspace.getState().recoveryId,prompt:document.querySelector('#folderPromptText').value};
    });
    result.label=label;report.runs.push(result);await writeFile(resolve(evidence,'current-handoff-performance.json'),JSON.stringify(report,null,2));
    check(result.oldReads===0&&result.unexpectedObjectReads.length===0&&result.objectEnumerations===0,label+' reads only current and task-referenced inputs without traversing the archive');
    check(!result.writes.some(name=>['COMMIT.json','snapshot.json','History.json'].includes(name))&&result.recoveryId===report.fixture.recoveryId,label+' leaves archive generations and the research index unchanged');
    check(result.reads<250,label+' has bounded current-package reads with thousands of retained objects');
    const published=await disk();check(published.valid&&published.ready.currentReview?.id===published.checkpointId&&published.ready.currentReview.baseRecoveryId===report.fixture.recoveryId&&published.ready.taskId===published.headId&&published.task.id===published.headId&&published.prompt===result.prompt&&published.headPrompt===result.prompt,label+' exposes only its exact saved prompt and hash-verified checkpoint-bound task');
    return {...result,published};
  }
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const {fixtureBlob}=await import('./qa/fixtures.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC current handoff history',{create:true});
      for(const[name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(let i=1;i<=3;i++){await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC correction '+i);await page.locator('#saveFinding').click();await local();}await saved();
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),stream=await(await config.directory.getFileHandle(config.paths.rendered)).createWritable();await stream.write(await(await import('./qa/fixtures.js')).fixtureBlob('rendered.pdf'));await stream.close();await a.folderWorkspace.loadLatest();});await local();await saved();
    check(await page.evaluate(()=>a.completion.capture().returned.reported.length===3),'synthetic fixture enters the real returned-review workflow');
    report.fixture=await page.evaluate(seedCurrentHandoffHistory);await writeFile(resolve(evidence,'current-handoff-performance.json'),JSON.stringify(report,null,2));
    check(report.fixture.objects>=4000&&report.fixture.objects<5000&&report.fixture.bytes<40*1024*1024,'legacy fixture has thousands of declared objects while sharing tiny synthetic inputs');
    await page.reload();await boot();await saved();
    await edit('SYNTHETIC first current correction after legacy history');
    const warm=await send('warm edited Send to AI');
    check(JSON.stringify(warm.published.task).includes('SYNTHETIC first current correction after legacy history'),'current explanation is included in the saved task');
    const unchanged=await send('unchanged Send to AI');
    check(unchanged.published.headId===warm.published.headId&&unchanged.writes.length===0,'unchanged prompt reopening reuses the same issued task without writes');
    await closePrompt();await page.reload();await boot();await saved();
    const cold=await send('reopened unchanged Send to AI');
    check(cold.published.headId===warm.published.headId&&cold.writes.length===0,'cold reopen restores the same issued prompt without republishing');
    await edit('SYNTHETIC second current correction after reopen');
    const edited=await send('cold edited Send to AI');
    check(edited.published.headId!==warm.published.headId&&JSON.stringify(edited.published.task).includes('SYNTHETIC second current correction after reopen'),'editing after reopen publishes a new task tied to the current explanation');

    // Only disposable stores are cleared. The saved folder must independently
    // recover the latest issued task as well as current checkpoint decisions.
    await closePrompt();
    await page.evaluate(async()=>{
      for(const[name,storeName]of [['private-score-desk-local-v1','reviews'],['private-score-desk-handoffs-v1','entries']])await new Promise((resolve,reject)=>{
        const request=indexedDB.open(name);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).clear();tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};
      });
    });
    await page.reload();await boot();
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings();a.folderWorkspace.io.pickDirectory=async()=>config.directory;await a.folderWorkspace.choose({mode:'open'});});await saved();
    const recovered=await page.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),entry=await(await import('./handoff-store.js')).retained(c.head?.id);return {headId:c.head?.id,prompt:c.head?.prompt,retainedId:entry?.id,explanation:s.returned.reported[0].explanation,recoveryId:c.recoveryId,events:(await(await import('./storage.js')).workspaceHistory(s.workspaceId)).length};});
    report.recovered=recovered;
    check(recovered.headId===edited.published.headId&&recovered.retainedId===recovered.headId&&recovered.prompt===edited.published.prompt&&recovered.explanation==='SYNTHETIC second current correction after reopen','folder-only recovery restores the exact sent task and current review without browser review or handoff records');
    check(recovered.recoveryId===report.fixture.recoveryId&&recovered.events>=report.fixture.historyRows,'folder-only recovery keeps the complete prior version history');

    const sharing=await page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),entry=await(await import('./handoff-store.js')).retained(config.head.id),manifest=JSON.parse(await entry.payloads.get('manifest.json').text()),groups=new Map();
      let shared=true,duplicates=0;
      for(const[path,info]of Object.entries(manifest.payloads)){
        const blob=entry.payloads.get(path),key=info.sha256+':'+blob.size+':'+blob.type;
        if(groups.has(key)){duplicates++;shared&&=groups.get(key)===blob;}else groups.set(key,blob);
      }
      const legacyPaths={source:'source-original.pdf',rendered:'rendered-original.pdf',ly:'lilypond/supplied.ly'};
      const roles=Object.entries(entry.files).every(([role,file])=>entry.payloads.get(manifest.schema==='score-desk-package'?legacyPaths[role]:manifest.inputs[role].path)===file.blob);
      return {paths:Object.keys(manifest.payloads).length,distinctBlobs:groups.size,duplicates,shared,roles};
    });
    report.recoveredPayloadSharing=sharing;
    check(sharing.duplicates>0&&sharing.shared&&sharing.roles,'folder-only recovery preserves equal-payload and file-role Blob aliases through the retained IndexedDB round trip');

    await edit('SYNTHETIC historical input corruption probe');
    await page.evaluate(async expected=>{
      const config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),{sha256}=await import('./model.js'),store=await import('./handoff-store.js');
      if(expected.sha256===scene.review.files.rendered.sha256)throw Error('The historical corruption fixture must use a different rendering');
      const objects=await(await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects'),handle=await objects.getFileHandle(expected.sha256),blob=new Blob([await(await handle.getFile()).arrayBuffer()]),issued=await store.retained(scene.returned.taskId);
      if(blob.size!==expected.size||await sha256(await blob.arrayBuffer())!==expected.sha256)throw Error('The synthetic historical baseline was not intact');
      window.syntheticHistoricalInput={handle,blob,issuedId:issued.id,task:JSON.stringify(issued.task),manifest:await sha256(await issued.payloads.get('manifest.json').arrayBuffer()),rendered:await sha256(await issued.files.rendered.blob.arrayBuffer())};
      const stream=await handle.createWritable();await stream.write(new Blob([new Uint8Array(blob.size)]));await stream.close();
      window.handoffAudit={reads:[],enumerations:[],writes:[],closes:[]};window.historicalCorruptionError=null;
      try{await a.folderWorkspace.saveNow();}catch(error){historicalCorruptionError=error.message;}
      const after=await store.retained(syntheticHistoricalInput.issuedId);
      window.retainedHistoricalUnchanged=JSON.stringify(after.task)===syntheticHistoricalInput.task&&await sha256(await after.payloads.get('manifest.json').arrayBuffer())===syntheticHistoricalInput.manifest&&await sha256(await after.files.rendered.blob.arrayBuffer())===syntheticHistoricalInput.rendered;
    },report.fixture.previousRendering);
    const historicalCorrupt=await page.evaluate(()=>({error:historicalCorruptionError||a.folderWorkspace.getState().error,writes:handoffAudit.writes,retainedUnchanged:retainedHistoricalUnchanged,prompt:a.folderWorkspace.savedPrompt()}));
    report.historicalCorruption=historicalCorrupt;
    check(Boolean(historicalCorrupt.error)&&historicalCorrupt.retainedUnchanged&&!historicalCorrupt.prompt&&!historicalCorrupt.writes.some(name=>['task.json','COMMIT.json','History.json'].includes(name)),'same-size historical rendering corruption blocks Send while preserving the exact retained issued task');
    await page.evaluate(async()=>{const{handle,blob}=syntheticHistoricalInput,stream=await handle.createWritable();await stream.write(blob);await stream.close();await a.folderWorkspace.saveCheckpoint();});await saved();
    await send('Send after restoring the exact historical input');

    await edit('SYNTHETIC third current correction for negative checks');
    // Current input corruption must still stop the optimized publication path.
    await page.evaluate(async()=>{
      const config=await a.folderWorkspace.io.getSettings(),cp=await(await import('./current-checkpoint.js')).readCurrentCheckpoint(config.directory),hash=cp.checkpoint.review.files.rendered.sha256,objects=await(await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects'),handle=await objects.getFileHandle(hash);
      window.syntheticCurrentInput={handle,blob:new Blob([await(await handle.getFile()).arrayBuffer()])};const stream=await handle.createWritable();await stream.write(new Blob([new Uint8Array(syntheticCurrentInput.blob.size)]));await stream.close();
      window.handoffAudit={reads:[],enumerations:[],writes:[],closes:[]};window.currentCorruptionError=null;try{await a.folderWorkspace.saveNow();}catch(error){currentCorruptionError=error.message;}
    });
    const corrupt=await page.evaluate(()=>({error:currentCorruptionError||a.folderWorkspace.getState().error,writes:handoffAudit.writes}));
    check(Boolean(corrupt.error)&&!corrupt.writes.some(name=>['task.json','COMMIT.json','History.json'].includes(name)),'corrupt current score bytes block publication without touching its task or archive');
    await page.evaluate(async()=>{const {handle,blob}=syntheticCurrentInput,stream=await handle.createWritable();await stream.write(blob);await stream.close();await a.folderWorkspace.saveCheckpoint();});await saved();

    await page.evaluate(async()=>{
      const cp=await import('./current-checkpoint.js'),config=await a.folderWorkspace.io.getSettings(),scene=a.completion.capture(),foreign={...scene,review:structuredClone(scene.review),returned:structuredClone(scene.returned),revisionId:crypto.randomUUID(),persistedRevision:scene.persistedRevision+1};
      const finding=foreign.returned.reported[0];finding.explanation='SYNTHETIC different profile correction';if(finding.decision)finding.decision.explanation=finding.explanation;
      const changed=await cp.writeCurrentCheckpoint(config.directory,foreign,config);window.syntheticForeignId=changed.id;window.handoffAudit={reads:[],enumerations:[],writes:[],closes:[]};window.foreignHandoffError=null;
      try{await a.folderWorkspace.saveNow();}catch(error){foreignHandoffError=error.message;}
      const after=await cp.readCurrentCheckpoint(config.directory);window.syntheticForeignAfter={id:after.id,explanation:after.checkpoint.returned.reported[0].explanation};
    });
    const foreign=await page.evaluate(()=>({error:foreignHandoffError||a.folderWorkspace.getState().error,id:syntheticForeignId,after:syntheticForeignAfter,local:a.completion.capture().returned.reported[0].explanation,writes:handoffAudit.writes}));
    report.foreign=foreign;
    check(Boolean(foreign.error)&&foreign.id===foreign.after.id&&foreign.after.explanation==='SYNTHETIC different profile correction'&&foreign.local==='SYNTHETIC third current correction for negative checks'&&!foreign.writes.some(name=>['task.json','COMMIT.json','History.json'].includes(name)),'a foreign current checkpoint blocks Send to AI and preserves both reviews');
    check(errors.length===0,'current handoff flows have no uncaught browser errors');
    return {name:'current-handoff',assertions};
  }catch(error){report.failure=error.stack;report.last=await page.evaluate(()=>({folder:window.a?.folderWorkspace.getState(),text:document.getElementById('statusLabel')?.textContent})).catch(()=>null);await page.screenshot({path:resolve(evidence,'current-handoff-failure.png')}).catch(()=>{});log.push(error.stack);throw error;}
  finally{await writeFile(resolve(evidence,'current-handoff-performance.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,'current-handoff.txt'),log.join('\n'));await context.close();await server.close();}
}






