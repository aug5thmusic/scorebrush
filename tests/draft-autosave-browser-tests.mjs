// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

// Exercise real IndexedDB + connected-folder checkpoint writes. Slow typing is
// deliberately slower than the old 350ms debounce, but faster than draft idle.
export async function runDraftAutosave({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[],report={runs:[]},errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('draft-autosave: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.draftAuditEnabled=false;window.draftAudit={local:[],files:[],closes:[]};window.draftWorkspace=null;
    for(const method of ['put','add']){
      const original=IDBObjectStore.prototype[method];
      IDBObjectStore.prototype[method]=function(...args){
        const value=args[0];if(draftAuditEnabled&&this.name==='reviews'&&value?.id===draftWorkspace&&value.review&&!value.kind)draftAudit.local.push({method,at:performance.now(),revision:value.storageRevision,returned:value.returned?.reported.map(f=>({id:f.id,explanation:f.explanation,decision:f.decision}))});
        return original.apply(this,args);
      };
    }
    const create=FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable=async function(...args){
      const name=this.name,stream=await create.apply(this,args),write=stream.write.bind(stream),close=stream.close.bind(stream);
      stream.write=async value=>{if(draftAuditEnabled)draftAudit.files.push({name,at:performance.now(),ready:name==='READY.json'?String(value instanceof Blob?await value.text():value):null});if(window.draftCheckpointGate&&name==='current-review.json'){window.draftCheckpointGate=false;window.draftCheckpointPending=true;await new Promise(resolve=>window.releaseDraftCheckpoint=resolve);window.draftCheckpointPending=false;}return write(value);};
      stream.close=async()=>{const result=await close();if(draftAuditEnabled)draftAudit.closes.push(name);return result;};return stream;
    };
  });
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const idle=()=>waitUntil(page,()=>!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending&&!a.folderWorkspace.getState().busy);
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState();if(f.error)throw Error(f.error);return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;});
  const reset=()=>page.evaluate(()=>{window.draftAudit={local:[],files:[],closes:[]};window.draftAuditEnabled=true;window.draftWorkspace=a.completion.capture().workspaceId;});
  const measure=async label=>{const value=await page.evaluate(()=>({audit:structuredClone(draftAudit),status:a.sessionStatus(),folder:a.folderWorkspace.getState(),draft:document.querySelector('#correctionDraftStatus')?.textContent,scene:a.completion.capture().returned}));value.label=label;report.runs.push(value);return value;};
  const local=()=>page.evaluate(async()=>{const s=a.completion.capture();return (await(await import('./storage.js')).getSavedState(s.workspaceId)).returned;});
  const checkpoint=()=>page.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),d=await c.directory.getDirectoryHandle('.scorebrush');return JSON.parse(await(await(await d.getFileHandle('current-review.json')).getFile()).text());});
  const readyWrites=value=>value.audit.files.filter(f=>f.name==='READY.json');
  const checkpointWrites=value=>value.audit.files.filter(f=>f.name==='current-review.json');
  const cleanWrites=value=>!value.audit.files.some(f=>['COMMIT.json','snapshot.json','History.json'].includes(f.name));
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{
      const {fixtureBlob}=await import('./qa/fixtures.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC draft autosave',{create:true});
      for(const[name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','multipage.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(let i=1;i<=2;i++){await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC draft correction '+i);await page.locator('#saveFinding').click();await idle();}await saved();
    await page.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),stream=await(await c.directory.getFileHandle(c.paths.rendered)).createWritable();await stream.write(await(await import('./qa/fixtures.js')).fixtureBlob('rendered.pdf'));await stream.close();await a.folderWorkspace.loadLatest();});await idle();await saved();
    await page.evaluate(async()=>{const c=await a.folderWorkspace.io.getSettings(),data=await c.directory.getDirectoryHandle('.scorebrush'),latest=await data.getDirectoryHandle('latest');window.originalDraftReady=await(await(await latest.getFileHandle('READY.json')).getFile()).text();});
    check(await page.evaluate(()=>a.completion.capture().returned.reported.length===2&&JSON.parse(originalDraftReady).ready===true),'small connected fixture begins with two corrections and a published ready task');

    await page.locator('#stillCorrection').click();await reset();
    for(const letter of 'SLOWLY'){await page.locator('#roundExplanation').pressSequentially(letter);await page.waitForTimeout(450);}
    const typing=await measure('450ms-per-character Still wrong typing');
    check(typing.status.dirty&&typing.draft==='Unsaved draft','Still wrong reports an unsaved draft while slow typing continues');
    check(typing.audit.local.length===0&&checkpointWrites(typing).length===0,'450ms-per-character typing performs no per-character local or checkpoint writes');
    check(readyWrites(typing).length===1&&JSON.parse(readyWrites(typing)[0].ready).ready===false,'first edit invalidates the ready task once; subsequent characters do not rewrite it');
    await page.waitForTimeout(700);const beforeIdle=await measure('before 1.5s draft idle');
    check(beforeIdle.audit.local.length===0&&checkpointWrites(beforeIdle).length===0,'draft remains coalesced before the 1.5-second idle boundary');
    await saved();const afterIdle=await measure('after draft idle');
    check(afterIdle.audit.local.length===1&&checkpointWrites(afterIdle).length===1&&readyWrites(afterIdle).length===1,'one idle flush writes one complete local review and one current folder checkpoint');
    check(afterIdle.draft==='Draft saved locally'&&(await local()).reported[0].explanation==='SLOWLY'&&(await checkpoint()).returned.reported[0].explanation==='SLOWLY','saved draft status agrees with exact local and folder text');
    check(cleanWrites(afterIdle),'draft typing and idle saving never write completed-version history');

    await reset();const exact='SLOWLY — explicit Enter saves E♭ and 𝄞';await page.locator('#roundExplanation').fill(exact);await page.locator('#roundExplanation').press('Enter');await idle();await saved();
    const decided=await local(),decision=decided.reported[0].decision;
    check(decision?.state==='open'&&decision.explanation===exact&&decided.reported[0].explanation===exact,'Enter flushes the latest exact draft and stores its complete correction decision');
    check(await page.evaluate(()=>a.corrections.state().findingId===a.completion.capture().returned.reported[1].id),'Enter advances to the next correction after the decision is saved');
    const explicit=await measure('explicit Enter decision');check(cleanWrites(explicit),'explicit decision saving does not append completed-version history');

    await page.locator('#stillCorrection').click();await reset();await page.locator('#roundExplanation').fill('SYNTHETIC Cancel keeps this draft');
    const cancelAt=Date.now();await page.locator('#cancelCorrectionResponse').click();await waitUntil(page,()=>!a.sessionStatus().dirty&&!a.sessionStatus().busy,1200);
    const cancelled=await local();check(cancelled.reported[1].explanation==='SYNTHETIC Cancel keeps this draft'&&!cancelled.reported[1].decision&&Date.now()-cancelAt<1400,'Cancel closes Still wrong and flushes its draft before the idle deadline without recording a decision');await saved();
    await page.locator('#stillCorrection').click();await reset();await page.locator('#roundExplanation').fill('SYNTHETIC Escape keeps this draft');
    const escapeAt=Date.now();await page.locator('#roundExplanation').press('Escape');await waitUntil(page,()=>!a.sessionStatus().dirty&&!a.sessionStatus().busy,1200);
    const escaped=await local();check(escaped.reported[1].explanation==='SYNTHETIC Escape keeps this draft'&&!escaped.reported[1].decision&&Date.now()-escapeAt<1400,'Escape flushes the exact draft before the idle deadline without approving or rejecting it');await saved();

    // A marker changed by another writer must be rechecked, not skipped using
    // an in-memory assumption from the first successful invalidation.
    await page.locator('#stillCorrection').click();await page.evaluate(async()=>{draftAuditEnabled=false;const c=await a.folderWorkspace.io.getSettings(),data=await c.directory.getDirectoryHandle('.scorebrush'),latest=await data.getDirectoryHandle('latest'),stream=await(await latest.getFileHandle('READY.json')).createWritable();await stream.write(originalDraftReady);await stream.close();});await reset();
    await page.locator('#roundExplanation').fill('SYNTHETIC renewed ready marker');await page.waitForTimeout(150);const renewed=await measure('externally renewed READY invalidation');
    check(readyWrites(renewed).length===1&&JSON.parse(readyWrites(renewed)[0].ready).ready===false&&renewed.audit.local.length===0,'a newly ready marker is invalidated on the next edit even after earlier false-marker checks');await saved();

    await reset();await page.evaluate(()=>window.draftCheckpointGate=true);await page.locator('#roundExplanation').fill('SYNTHETIC held checkpoint');
    await waitUntil(page,()=>Boolean(window.draftCheckpointPending),10000);
    for(const letter of '12'){await page.locator('#roundExplanation').pressSequentially(letter);await page.waitForTimeout(450);}
    await page.evaluate(()=>window.releaseDraftCheckpoint());await page.waitForTimeout(400);const superseded=await measure('superseded checkpoint before typing deadline');
    check(superseded.audit.local.length===1&&checkpointWrites(superseded).length===1&&superseded.status.dirty,'a superseded in-flight checkpoint does not restart local or folder writes at the old 250ms retry interval');
    await saved();const supersededSaved=await measure('superseded checkpoint after typing idle');
    check(supersededSaved.audit.local.length===2&&checkpointWrites(supersededSaved).length===2&&(await checkpoint()).returned.reported[1].explanation==='SYNTHETIC held checkpoint12','the superseded draft is published exactly once after its new idle deadline');

    await reset();await page.evaluate(()=>{window.draftRealPut=a.operations.putSaved;window.draftFailedAttempts=0;a.operations.putSaved=async()=>{draftFailedAttempts++;throw Error('SYNTHETIC draft local write failure');};});
    const lastSaved=(await local()).reported[1].explanation;await page.locator('#roundExplanation').fill('SYNTHETIC failing draft must stay unsaved');
    await waitUntil(page,()=>a.sessionStatus().saveFailed&&!a.folderWorkspace.getState().busy,10000);await page.waitForTimeout(200);
    const failed=await measure('failed draft local saving');
    check(failed.status.dirty&&failed.status.saveFailed&&failed.draft==='Draft not saved','a failed idle save keeps the draft dirty and explicitly reports that it is not saved');
    check(failed.audit.local.length===0&&checkpointWrites(failed).length===0&&(await local()).reported[1].explanation===lastSaved,'failed local saving leaves the prior durable draft intact and does not publish an unsaved folder checkpoint');
    await page.evaluate(async()=>{a.operations.putSaved=draftRealPut;await a.saveNow();await a.folderWorkspace.saveCheckpoint();});await saved();
    check(await page.locator('#correctionDraftStatus').innerText()==='Draft saved locally'&&(await local()).reported[1].explanation==='SYNTHETIC failing draft must stay unsaved','retry changes the status to saved only after preserving the exact recovered draft');
    check(errors.length===0,'connected draft autosaving has no uncaught browser errors');
    return {name:'draft-autosave',assertions};
  }catch(error){report.failure=error.stack;report.last=await measure('failure state').catch(()=>null);log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'draft-autosave-failure.png')}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'draft-autosave-performance.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,'draft-autosave.txt'),log.join('\n'));await context.close();await server.close();}
}
