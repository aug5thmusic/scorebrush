// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Real browser IndexedDB in isolated contexts. The synthetic page allows old
// schema/error setup without starting the app before the test state exists.
export async function runStartupStorage({browser,serve,evidence,root}){
  const server=await serve(root),contexts=[],log=[];let assertions=0;
  const names=['private-score-desk-local-v1','private-score-desk-handoffs-v1','private-score-desk-folders-v1'];
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('startup-storage: '+label);};
  const probe=async()=>{
    const context=await browser.newContext({viewport:{width:1280,height:900}});contexts.push(context);
    await context.route('**/startup-storage-probe',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>SYNTHETIC startup storage</title>'}));
    const page=await context.newPage();await page.goto(server.origin+'/startup-storage-probe');return {context,page};
  };
  const ready=page=>page.waitForFunction(()=>document.body.dataset.ready==='true'&&!document.querySelector('#chooseFolderInSetup').disabled,null,{timeout:30000});
  const seed=async(page,{version=4,keepOpen=false}={})=>page.evaluate(async({version,keepOpen})=>{
    const {fixtureBlob}=await import('./qa/fixtures.js'),{identify,newReview}=await import('./model.js');
    const files={source:{name:'SYNTHETIC source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:'SYNTHETIC rendered.pdf',blob:await fixtureBlob('rendered.pdf')},ly:{name:'SYNTHETIC.ly',blob:await fixtureBlob('score.ly')}};
    const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[0,0,612,792],rotation:0,userUnit:1}]);
    review.findings=[{id:'SYNTHETIC-kept-note',number:1,page:1,type:'comment',comment:'SYNTHETIC retained startup note',state:'open',color:'#ffd34d',strokes:[],bounds:null}];review.nextNumber=2;
    const row={id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[],storageRevision:7,journalVersion:1};
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('private-score-desk-local-v1',version);r.onupgradeneeded=()=>r.result.createObjectStore('reviews',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('reviews','readwrite');tx.objectStore('reviews').put(row);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    window.syntheticStartupHead=row;
    if(keepOpen)window.syntheticOldWriter=db;else db.close();
    return {id:row.id,revisionId:row.revisionId,review:row.review};
  },{version,keepOpen});
  try{
    {
      const {context,page}=await probe();
      await context.addInitScript(()=>{window.startupStorageOpens=[];const open=IDBFactory.prototype.open;IDBFactory.prototype.open=function(name,...args){window.startupStorageOpens.push(String(name));return open.call(this,name,...args);};});
      await page.goto(server.url);await ready(page);
      const result=await page.evaluate(async()=>({open:window.startupStorageOpens,databases:await indexedDB.databases(),welcome:document.querySelector('#workspaceDialog').open&&document.querySelector('#workspaceDialog').dataset.page==='welcome'}));
      check(result.welcome&&names.every(name=>!result.open.includes(name)),'fresh Welcome reaches usable controls without creating empty review, handoff or folder databases');
      check(names.every(name=>!result.databases.some(entry=>entry.name===name)),'fresh read-only startup leaves all three persistent stores absent');
    }
    {
      const {page}=await probe(),expected=await seed(page);
      await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.body.classList.contains('review-open'),null,{timeout:30000});
      const result=await page.evaluate(async()=>{const a=await import('./app.js'),s=await import('./storage.js'),c=a.completion.capture();return {id:c.workspaceId,revisionId:c.revisionId,review:c.review,rows:await s.listSaved({existingOnly:true}),databases:await indexedDB.databases()};});
      assert.deepEqual(result.review,expected.review,'existing version-4 review annotations must survive normal opening');
      check(result.id===expected.id&&result.revisionId===expected.revisionId,'an existing version-4 review opens with exact saved annotations and revision identity');
      check(result.databases.find(entry=>entry.name===names[0])?.version===5&&result.rows.some(row=>row.id===expected.id),'existing storage still takes the normal schema-upgrade and validated-read path');
    }
    for(const mode of ['unavailable','rejected']){
      const {context,page}=await probe();
      await context.addInitScript(mode=>{window.readStartupDatabaseInventory=indexedDB.databases.bind(indexedDB);Object.defineProperty(IDBFactory.prototype,'databases',{configurable:true,value:mode==='unavailable'?undefined:async()=>{throw new DOMException('SYNTHETIC inventory denial','SecurityError');}});},mode);
      await page.goto(server.url);await ready(page);
      const actual=await page.evaluate(()=>window.readStartupDatabaseInventory());
      check(names.every(name=>actual.some(entry=>entry.name===name)),mode+' database discovery falls back to ordinary reads and preserves usable startup');
    }
    {
      const {page}=await probe(),expected=await seed(page,{version:6});
      const result=await page.evaluate(async()=>{let error;try{await(await import('./storage.js')).listSaved({existingOnly:true});}catch(e){error=e.name;}
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('private-score-desk-local-v1',6);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const row=await new Promise((resolve,reject)=>{const r=db.transaction('reviews').objectStore('reviews').get(window.syntheticStartupHead.id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return {error,review:row.review,revisionId:row.revisionId};});
      check(result.error==='VersionError'&&result.revisionId===expected.revisionId&&JSON.stringify(result.review)===JSON.stringify(expected.review),'a present unsupported-version database fails visibly without hiding or changing its saved review');
    }
    {
      const {page}=await probe(),expected=await seed(page,{keepOpen:true});
      const result=await page.evaluate(async()=>{let error;try{await(await import('./storage.js')).listSaved({existingOnly:true});}catch(e){error=e.message;}
        const row=await new Promise((resolve,reject)=>{const r=window.syntheticOldWriter.transaction('reviews').objectStore('reviews').get(window.syntheticStartupHead.id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});window.syntheticOldWriter.close();return {error,review:row.review,revisionId:row.revisionId};});
      check(/upgrade blocked/.test(result.error)&&result.revisionId===expected.revisionId&&JSON.stringify(result.review)===JSON.stringify(expected.review),'a blocked existing upgrade remains an error and retains every saved annotation');
    }
    {
      const {page}=await probe();
      const result=await page.evaluate(async()=>{
        const s=await import('./storage.js'),h=await import('./handoff-store.js'),f=await import('./folder-settings.js'),m=await import('./model.js'),fixtures=await import('./qa/fixtures.js');
        const files={source:{name:'SYNTHETIC.pdf',blob:await fixtures.fixtureBlob('source.pdf')},rendered:{name:'SYNTHETIC render.pdf',blob:await fixtures.fixtureBlob('rendered.pdf')},ly:{name:'SYNTHETIC.ly',blob:await fixtures.fixtureBlob('score.ly')}};
        const {identity,snapshotId}=await m.identify(files),review=m.newReview(identity,snapshotId,[{page:1,view:[0,0,612,792],rotation:0,userUnit:1}]);
        const head={id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[]},entry={id:crypto.randomUUID(),kind:'review-backup',createdAt:new Date().toISOString(),review,files},connection={connectionId:crypto.randomUUID(),directory:await navigator.storage.getDirectory(),paths:{source:'SYNTHETIC.pdf',rendered:'SYNTHETIC render.pdf',ly:'SYNTHETIC.ly'}};
        const original=IDBFactory.prototype.databases,gates=[];IDBFactory.prototype.databases=function(){return new Promise(resolve=>gates.push(resolve));};
        try{
          const reads=[s.listSaved({existingOnly:true}),h.retainedList({existingOnly:true}),f.readFolderSettings({existingOnly:true})];
          while(gates.length<3)await new Promise(resolve=>setTimeout(resolve,0));
          await s.putSaved(head,null);await h.retain(entry);await f.saveFolderSettings(connection);
          for(const release of gates)release([]);
          const [saved,handoffs,folder]=await Promise.all(reads);
          return {saved:saved.some(row=>row.id===head.id),handoff:handoffs.some(row=>row.id===entry.id),folder:folder?.connectionId===connection.connectionId,revisionId:(await s.getSaved(head.id)).revisionId,expectedRevisionId:head.revisionId,input:await(await s.getSaved(head.id)).files.source.blob.text(),expectedInput:await files.source.blob.text()};
        }finally{IDBFactory.prototype.databases=original;}
      });
      check(result.saved&&result.handoff&&result.folder,'pending initial inventories join first writes instead of reporting a stale absent store');
      check(result.revisionId===result.expectedRevisionId&&result.input===result.expectedInput,'first real writes still commit exact revision and input bytes through the ordinary persistence path');
      await page.reload();const reopened=await page.evaluate(async()=>({saved:(await(await import('./storage.js')).listSaved({existingOnly:true})).length,handoffs:(await(await import('./handoff-store.js')).retainedList({existingOnly:true})).length,folder:Boolean(await(await import('./folder-settings.js')).readFolderSettings({existingOnly:true}))}));
      check(reopened.saved===1&&reopened.handoffs===1&&reopened.folder,'new module sessions rediscover all three stores after first-use persistence');
    }
    return {name:'startup-storage',assertions};
  }catch(error){log.push('FAIL '+error.stack);throw error;}finally{await writeFile(resolve(evidence,'startup-storage.txt'),log.join('\n')+'\n');for(const context of contexts)await context.close();await server.close();}
}
