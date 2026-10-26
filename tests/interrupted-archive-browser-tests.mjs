// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function runInterruptedArchive({browser,serve,evidence,root}){
 const server=await serve(root),runs=[],log=[];let assertions=0;
 const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);console.log('interrupted-archive: '+label);};
 const local=p=>waitUntil(p,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending);
 const saved=p=>waitUntil(p,()=>{const s=a.folderWorkspace.getState();if(s.error||s.pausedReason)throw Error(s.error||s.pausedReason);return s.ready&&!s.busy;});
 const dismiss=p=>p.evaluate(()=>{for(const d of document.querySelectorAll('dialog[open]'))d.close();});
 async function note(p,text){await p.locator('#newFinding').click();await p.locator('#comment').fill(text);await p.locator('#saveFinding').click();await local(p);}
 async function decision(p,text){await dismiss(p);await p.locator('#stillCorrection').click();await p.locator('#roundExplanation').fill(text);await p.locator('#sendCorrectionResponse').click();await local(p);}
 async function snapshot(p){return p.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),s=a.completion.capture(),storage=await import('./storage.js'),record=await storage.getSaved(s.workspaceId),recovery=await(await import('./folder-recovery.js')).readRecovery(c.directory),checkpoint=recovery?await(await import('./current-checkpoint.js')).readCurrentCheckpoint(c.directory):null;let diskReview=null,diskReturned=null;if(checkpoint){diskReview=checkpoint.checkpoint.review;diskReturned=checkpoint.checkpoint.returned;}else if(recovery){const r=recovery.manifest.records.find(r=>r.id===recovery.manifest.current);diskReview=JSON.parse(await recovery.objects.get(r.payloads['annotations.json'].sha256).text());diskReturned=r.payloads['returned-workspace.json']?JSON.parse(await recovery.objects.get(r.payloads['returned-workspace.json'].sha256).text()).returned:null;}return {record:{id:record.id,revisionId:record.revisionId,storageRevision:record.storageRevision,review:record.review,returned:record.returned??null,completions:record.completions??[]},intent:c.pendingRecoveryIntent??null,recoveryId:c.recoveryId??null,diskId:recovery?.manifest.id??null,diskManifest:recovery?.manifest??null,checkpointRetired:!checkpoint,diskReview,diskReturned,state:a.folderWorkspace.getState(),history:(await storage.workspaceHistory(s.workspaceId)).map(r=>({id:r.id,revisionId:r.revisionId,resultingSnapshotId:r.resultingSnapshotId,resultingRenderSha256:r.resultingRenderSha256}))};});}
 async function inject(p,phase){await p.evaluate(phase=>{
  window.interruptPhase=phase;window.blocked=false;window.intentTransactions=[];
  const hold=async()=>{blocked=true;await new Promise(r=>window.release=r);throw Error('SYNTHETIC interrupted archive '+phase);};
  if(!window.originalArchivePut){window.originalArchivePut=a.folderWorkspace.io.putSettings;window.originalArchiveWritable=FileSystemFileHandle.prototype.createWritable;const transaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,options){const tx=transaction.call(this,names,mode,options);if(this.name==='private-score-desk-folders-v1'&&mode==='readwrite'&&options?.durability==='strict')intentTransactions.push(tx.durability);return tx;};}
  a.folderWorkspace.io.putSettings=async value=>{if(interruptPhase==='after-commit'&&!value.pendingRecoveryIntent&&window.preparedIntent&&value.recoveryId===preparedIntent.id)await hold();await originalArchivePut(value);if(value.pendingRecoveryIntent)window.preparedIntent=structuredClone(value.pendingRecoveryIntent);};
  FileSystemFileHandle.prototype.createWritable=async function(...args){const s=await originalArchiveWritable.apply(this,args),close=s.close.bind(s);if(this.name==='COMMIT.json')s.close=async()=>{if(interruptPhase==='before-commit')await hold();return close();};return s;};
 },phase);}
 try{
  for(const initial of [false,true])for(const phase of ['before-commit','after-commit']){
   const context=await browser.newContext(),p=await context.newPage(),label=(initial?'initial baseline':'Load latest')+' / '+phase,run={label};runs.push(run);
   try{
    await p.goto(server.url);await p.waitForFunction(()=>document.body.dataset.ready==='true');await p.evaluate(async()=>{window.a=await import('./app.js');window.fixtureBlob=(await import('./qa/fixtures.js')).fixtureBlob;window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC archive intent',{create:true});for(const[name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}a.folderWorkspace.io.pickDirectory=async()=>folder;});
    if(initial)await inject(p,phase);
    await p.locator('#chooseFolderInSetup').click();await p.locator('#folderSetupDialog').waitFor();for(const[id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await p.locator('#'+id).selectOption(path);await p.locator('#folderSetupConfirm').click();
    if(!initial){await saved(p);await note(p,'SYNTHETIC departing review');await saved(p);run.prior=await snapshot(p);await inject(p,phase);await p.evaluate(async()=>{const w=await(await folder.getFileHandle('rendered.pdf')).createWritable();await w.write(await fixtureBlob('rendered.pdf'));await w.close();window.operation=a.folderWorkspace.loadLatest();});}
    await waitUntil(p,()=>window.blocked);run.held=await snapshot(p);
    check(run.held.intent?.schema==='scorebrush-recovery-intent'&&/^[a-f0-9]{64}$/.test(run.held.intent.manifestSha256),label+': exact manifest intent is durable before publication');
    check(await p.evaluate(()=>intentTransactions.length>0&&intentTransactions.every(v=>v==='strict')),label+': actual intent transaction uses strict durability');
    check(run.held.diskId===(phase==='before-commit'?run.held.intent.parent:run.held.intent.id),label+': disk is on the injected side of COMMIT');
    await p.evaluate(async()=>{interruptPhase=null;release();if(window.operation)await operation;});await waitUntil(p,()=>!a.folderWorkspace.getState().busy);await local(p);await dismiss(p);
    if(initial)await note(p,'SYNTHETIC newer note after failed initial archive');else await decision(p,'SYNTHETIC newer local decision after failed archive');run.newer=await snapshot(p);
    // Reload before a later retry can persist a new binding. Local decision is
    // real IndexedDB data; no fake state is written directly into its stores.
    await p.reload();await p.waitForFunction(()=>document.body.dataset.ready==='true');await p.evaluate(async()=>window.a=await import('./app.js'));await waitUntil(p,()=>!a.folderWorkspace.getState().busy);run.restart=await snapshot(p);
    assert.deepEqual(run.restart.record,run.newer.record);check(true,label+': restart preserves the exact newer local revision, state and completions');
    if(!initial&&phase==='after-commit'){
     await inject(p,'before-commit');await p.evaluate(()=>{window.operation=a.folderWorkspace.saveNow().catch(e=>window.retryError=e.message);});await waitUntil(p,()=>window.blocked);run.retryHeld=await snapshot(p);
     check(run.retryHeld.intent.parent===run.held.intent.id&&run.retryHeld.recoveryId===run.held.intent.id,label+': repeated interruption promotes only the verified prior intent');
     await p.evaluate(async()=>{interruptPhase=null;release();await operation;});await decision(p,'SYNTHETIC latest decision after interrupted retry');run.newer=await snapshot(p);
     await p.reload();await p.waitForFunction(()=>document.body.dataset.ready==='true');await p.evaluate(async()=>window.a=await import('./app.js'));await waitUntil(p,()=>!a.folderWorkspace.getState().busy);
    }
    // Exercise explicit selection before retry, as well as startup's binding.
    await dismiss(p);await p.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings();a.folderWorkspace.io.pickDirectory=async()=>c.directory;await a.folderWorkspace.choose({mode:'open'});});await p.evaluate(()=>a.folderWorkspace.saveNow());await saved(p);run.final=await snapshot(p);
    assert.deepEqual(run.final.record,run.newer.record);assert.deepEqual(run.final.diskReview,run.newer.record.review);assert.deepEqual(run.final.diskReturned??null,run.newer.record.returned);
    check(!run.final.intent&&run.final.recoveryId===run.final.diskId,label+': explicit reopening and retry recover current work and clear only verified intent');
    check(run.final.checkpointRetired||run.final.diskReview.snapshotId===run.newer.record.review.snapshotId,label+': prior checkpoint retirement/current checkpoint remains consistent');
    if(run.prior){const priorIds=run.prior.diskManifest.records.map(r=>r.id);check(priorIds.every(id=>run.final.diskManifest.records.some(r=>r.id===id)),label+': prior archive records remain retained');}
   }catch(e){await p.screenshot({path:resolve(evidence,'archive-'+initial+'-'+phase+'-failure.png')}).catch(()=>{});throw e;}finally{await writeFile(resolve(evidence,'interrupted-archive.json'),JSON.stringify(runs,null,2));await context.close();}
  }
  return {name:'interrupted-archive',assertions};
 }finally{await writeFile(resolve(evidence,'interrupted-archive.txt'),log.join('\n'));await server.close();}
}
