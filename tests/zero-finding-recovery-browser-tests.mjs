// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runZeroFindingRecovery({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report={},log=[],errors=[];let assertions=0;
  const check=(condition,label)=>{assert(condition,label);assertions++;log.push('PASS '+label);console.log('zero-finding-recovery: '+label);};
  const boot=async()=>{await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.a=await import('./app.js'));};
  const saved=()=>page.waitForFunction(()=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||f.loadError||s.saveConflict||s.saveFailed)throw Error(f.error||f.loadNotice||'Synthetic local save failed');return f.ready&&!f.busy&&!s.busy&&!s.dirty;},null,{timeout:120000});
  page.on('pageerror',error=>errors.push(error.message));
  try{
    await page.goto(server.url);await boot();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC zero-finding recovery',{create:true});for(const name of ['source.pdf','rendered.pdf','score.ly']){const writer=await(await folder.getFileHandle(name,{create:true})).createWritable();await writer.write(await fixtureBlob(name));await writer.close();}a.folderWorkspace.io.pickDirectory=async()=>folder;});
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const[id,name]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    report.initial=await page.evaluate(()=>{const scene=a.completion.capture();return {workspaceId:scene.workspaceId,projectId:scene.projectId,snapshotId:scene.review.snapshotId,findings:scene.review.findings.length};});
    check(report.initial.findings===0,'new synthetic project begins with a committed zero-finding task');
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings(),writer=await(await config.directory.getFileHandle('score.ly')).createWritable();await writer.write(new Blob(['% SYNTHETIC changed code\n\\version "2.24.3"\n{ e4 f4 }']));await writer.close();await a.folderWorkspace.loadLatest();});await saved();
    report.afterLoad=await page.evaluate(()=>{const scene=a.completion.capture();return {workspaceId:scene.workspaceId,projectId:scene.projectId,snapshotId:scene.review.snapshotId,review:scene.review};});
    check(report.afterLoad.snapshotId!==report.initial.snapshotId&&report.afterLoad.projectId===report.initial.projectId,'code-only Load latest keeps project lineage and the previous empty task');
    report.recovery=await page.evaluate(async()=>{
      const recovery=await import('./folder-recovery.js'),handoffs=await import('./handoff-store.js'),workflow=await import('./workflow.js'),storage=await import('./storage.js'),config=await a.folderWorkspace.io.getSettings(),snapshot=await recovery.readRecovery(config.directory);
      const pdfjs=await import('./vendor/pdf.mjs'),resources=await import('./pdf-resources.js');
      const inspect=async files=>{const doc=await pdfjs.getDocument({data:new Uint8Array(await files.rendered.blob.arrayBuffer()),...resources.pdfResourceUrls,isEvalSupported:false,enableXfa:false}).promise;try{const pages=[];for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}return pages;}finally{await doc.loadingTask.destroy();}};
      const fingerprints=async payloads=>Promise.all([...payloads].map(async([path,blob])=>[path,(await workflow.fileInfo(blob)).sha256]));
      const decoded=await recovery.decodeRecovery(snapshot,inspect),diff=[],before=new Map();
      for(const entry of decoded.entries){const existing=await handoffs.retained(entry.id);if(!existing)continue;const local=await fingerprints(existing.payloads),archived=await fingerprints(entry.payloads),localHashes=new Map(local),changed=archived.filter(([path,hash])=>localHashes.get(path)!==hash).map(([path])=>path);diff.push({id:entry.id,findings:entry.task?.findings?.length,changed,variants:decoded.entryVariants.filter(v=>v.id===entry.id).length});before.set(entry.id,{local,archived});}
      const id=await recovery.restoreRecovery(snapshot,inspect,{allowLocal:true}),record=await storage.getSaved(id);let retainedUnchanged=true,archivePreserved=true;
      for(const [entryId,prior]of before){retainedUnchanged&&=JSON.stringify(await fingerprints((await handoffs.retained(entryId)).payloads))===JSON.stringify(prior.local);const evidence=record.retainedHandoffEvidence?.find(item=>item.bundle.id===entryId);archivePreserved&&=Boolean(evidence)&&JSON.stringify(await fingerprints(evidence.payloads))===JSON.stringify(prior.archived);}
      const again=await recovery.restoreRecovery(snapshot,inspect,{allowLocal:true});return {id,again,diff,retainedUnchanged,archivePreserved};
    });
    check(report.recovery.diff.some(item=>item.findings===0&&item.variants===0&&item.changed.length===2&&item.changed.includes('PROMPT.txt')&&item.changed.includes('manifest.json')),'fixture exercises the real folder prefix mismatch absent from returned-backup variants');
    check(report.recovery.id===report.afterLoad.workspaceId&&report.recovery.again===report.recovery.id,'actual folder delivery conflict restores and repeats idempotently');
    check(report.recovery.retainedUnchanged&&report.recovery.archivePreserved,'restore keeps both retained folder delivery and exact archived original bytes');
    await page.evaluate(async()=>{const config=await a.folderWorkspace.io.getSettings();await config.directory.removeEntry('Versions',{recursive:true});a.folderWorkspace.io.pickDirectory=async()=>config.directory;await a.folderWorkspace.choose({mode:'open'});});await saved();
    report.reopened=await page.evaluate(()=>({state:a.folderWorkspace.getState(),scene:{workspaceId:a.completion.capture().workspaceId,review:a.completion.capture().review}}));
    assert.deepEqual(report.reopened.scene.review,report.afterLoad.review);
    check(!report.reopened.state.loadError&&report.reopened.scene.workspaceId===report.afterLoad.workspaceId,'UI recovery after removing synthetic derived Versions completes without conflict or review changes');
    await page.reload();await boot();await saved();
    check(await page.evaluate(id=>a.completion.capture().workspaceId===id,report.afterLoad.workspaceId),'recovered zero-finding workspace remains reopenable after restart');
    check(errors.length===0,'zero-finding recovery produces no uncaught browser errors');
    return {name:'zero-finding-recovery',assertions};
  }catch(error){report.failure=error.message;throw error;}
  finally{await writeFile(resolve(evidence,'zero-finding-recovery.json'),JSON.stringify(report,null,2));await writeFile(resolve(evidence,'zero-finding-recovery.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
