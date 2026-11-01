// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// A fresh origin/context and tiny synthetic score exercise the production UI.
// Large immutable Blob fixtures are inspected by size, never serialized.
export async function runExportLimits({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[];let assertions=0;
  const check=(condition,label)=>{assert(condition,label);assertions++;log.push('PASS '+label);console.log('export-limits: '+label);};
  const state=()=>page.evaluate(()=>({status:a.sessionStatus(),scene:a.completion.capture(),counts:{...exportAudit.counts}}));
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js');for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
      for(const[id,name]of [['sourceFile','source.pdf'],['renderedFile','rendered.pdf'],['lyFile','score.ly']]){const transfer=new DataTransfer();transfer.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));document.getElementById(id).files=transfer.files;}
      document.getElementById('load').click();
    });
    await page.waitForFunction(()=>a.sessionStatus().snapshotId&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!document.querySelector('dialog[open]'));
    await page.evaluate(()=>{
      const blob=new Blob([new Uint8Array(90*1024*1024)]),payloads=new Map(['source.pdf','rendered.pdf','score.ly'].map(name=>[name,blob]));
      window.exportAudit={payloads,original:{...a.operations},originalMakeTask:a.handoff.io.makeTask,originalRetain:a.handoff.io.retain,counts:{zip:0,download:0,retain:0}};
      a.operations.putSaved=async()=>{throw new Error('SYNTHETIC local storage unavailable');};
      a.operations.makeRecovery=async()=>payloads;
      a.operations.zipFiles=async()=>{exportAudit.counts.zip++;throw Error('SYNTHETIC serialization must not start');};
      a.operations.download=async()=>{exportAudit.counts.download++;};
      document.getElementById('newFinding').click();const comment=document.getElementById('comment');comment.value='SYNTHETIC unsaved note must stay protected';comment.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await page.evaluate(()=>a.saveNow());const before=await state();
    check(before.status.dirty&&before.status.unprotected&&before.status.saveFailed,'synthetic save failure leaves the new note unprotected');
    await page.evaluate(()=>document.getElementById('emergency').click());
    await page.waitForFunction(()=>!a.sessionStatus().recovering&&document.body.textContent.includes('256 MB import limit'));
    const failed=await state();
    check(failed.status.recoveryStamp===null&&failed.status.unprotected&&failed.status.dirty,'oversized emergency ZIP never creates a recovery stamp or clears protection');
    check(failed.counts.zip===0&&failed.counts.download===0,'oversized emergency output is rejected before packing or requesting a download');
    await page.evaluate(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['% SYNTHETIC alternate score'],'SYNTHETIC-alternate.ly'));document.getElementById('lyFile').files=transfer.files;document.getElementById('load').click();});
    await page.waitForFunction(()=>!a.sessionStatus().busy);const afterSwitch=await state();
    check(afterSwitch.status.snapshotId===before.status.snapshotId&&JSON.stringify(afterSwitch.scene.review.findings)===JSON.stringify(before.scene.review.findings),'failed recovery does not authorize switching away from unsaved findings');

    await page.evaluate(()=>{a.operations.putSaved=exportAudit.original.putSaved;return a.saveNow();});
    await page.evaluate(()=>{
      a.handoff.io.makeTask=async()=>({payloads:exportAudit.payloads});
      a.handoff.io.retain=async()=>{exportAudit.counts.retain++;};
      document.getElementById('exportTask').click();
    });
    await page.waitForFunction(()=>!document.getElementById('closeHandoff').disabled&&document.getElementById('handoffStatus').textContent.includes('256 MB import limit'));
    const task=await state();
    check(task.counts.retain===0&&task.counts.zip===0&&task.counts.download===0,'oversized manual task is rejected before retention, packing, and publication');
    check(await page.locator('#handoffDownloads a').count()===0&&await page.locator('#promptFallback').isHidden(),'failed task export offers no download or copied-prompt-ready state');

    await page.evaluate(()=>{
      document.getElementById('handoffDialog').close();Object.assign(a.operations,exportAudit.original);a.handoff.io.makeTask=exportAudit.originalMakeTask;a.handoff.io.retain=exportAudit.originalRetain;
      a.completion.io.prepare=async()=>({payloads:exportAudit.payloads});a.completion.io.zip=async()=>{exportAudit.counts.zip++;throw Error('SYNTHETIC serialization must not start');};a.completion.io.download=async()=>{exportAudit.counts.download++;};void a.completion.open();
    });
    await page.waitForFunction(()=>!a.completion.job()&&document.getElementById('finishStatus').textContent.includes('256 MB import limit'));
    check(await page.locator('#finishDownloads a').count()===0&&(await state()).counts.zip===0,'ordinary backup uses the same preflight before serialization and ready links');
    await page.screenshot({path:resolve(evidence,'export-limits-blocked.png')});
    return {name:'export-limits',assertions};
  }finally{await writeFile(resolve(evidence,'export-limits.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
