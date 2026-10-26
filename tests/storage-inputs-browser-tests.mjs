// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runStorageInputs({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('storage-inputs: '+label);};
  await page.route('**/synthetic-input-storage',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>SYNTHETIC input migration</title>'}));
  try{
    await page.goto(server.origin+'/synthetic-input-storage');
    const result=await page.evaluate(async()=>{
      const {identify,newReview}=await import('./model.js'),{makeTask}=await import('./workflow.js'),{makeRecovery}=await import('./export.js');
      const files={source:{name:'SYNTHETIC.pdf',blob:new Blob(['%PDF SYNTHETIC'])},rendered:{name:'SYNTHETIC-rendered.pdf',blob:new Blob(['%PDF SYNTHETIC r'])},ly:{name:'SYNTHETIC.ly',blob:new Blob(['% SYNTHETIC'])}},identified=await identify(files),review=newReview(identified.identity,identified.snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]);
      const record={id:identified.snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[],projectId:crypto.randomUUID(),storageRevision:7,journalVersion:1},event={...record,id:'review-event:'+crypto.randomUUID(),kind:'review-event',workspaceId:record.id};
      const open=(name,version,store,keyPath)=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,version);r.onupgradeneeded=()=>r.result.createObjectStore(store,keyPath?{keyPath}:undefined);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const tx=(db,store,action)=>new Promise((resolve,reject)=>{const t=db.transaction(store,'readwrite');action(t.objectStore(store));t.oncomplete=resolve;t.onabort=()=>reject(t.error);});
      const old=await open('private-score-desk-local-v1',4,'reviews','id');await tx(old,'reviews',s=>{s.put(record);s.put(event);});
      const head=await makeTask(review,files,{},'120',()=>{},makeRecovery),connection={connectionId:crypto.randomUUID(),directory:{name:'SYNTHETIC'},paths:{source:'s.pdf',rendered:'r.pdf',ly:'s.ly'},head,pendingHead:head};
      const oldFolders=await open('private-score-desk-folders-v1',1,'settings');await tx(oldFolders,'settings',s=>s.put(connection,'current'));
      let localClosed=false,folderClosed=false;old.onversionchange=()=>{localClosed=true;old.close();};oldFolders.onversionchange=()=>{folderClosed=true;oldFolders.close();};
      const storage=await import('./storage.js'),folders=await import('./folder-settings.js');
      const before=await storage.getSaved(record.id),oldConnection=await folders.readFolderSettings();
      let saved=await storage.putSaved({...before,revisionId:crypto.randomUUID()},7);await folders.saveFolderSettings(oldConnection);
      const local=await open('private-score-desk-local-v1',5,'reviews','id'),folder=await open('private-score-desk-folders-v1',2,'settings');
      const rows=(db,name)=>new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      const startRows=await rows(local,'reviews'),startSettings=await rows(folder,'settings');
      const hasBlob=value=>value instanceof Blob||value instanceof Map&&[...value.values()].some(hasBlob)||value&&typeof value==='object'&&Object.values(value).some(hasBlob);
      const puts=[];const originalPut=IDBObjectStore.prototype.put,originalAdd=IDBObjectStore.prototype.add;
      for(const name of ['put','add']){const original=name==='put'?originalPut:originalAdd;IDBObjectStore.prototype[name]=function(value,...args){puts.push({store:this.name,blob:hasBlob(value)});return original.call(this,value,...args);};}
      try{for(let i=0;i<5;i++){saved=await storage.putSaved({...saved,revisionId:crypto.randomUUID()},saved.storageRevision);await folders.saveFolderSettings({...oldConnection,currentCheckpointId:String(i).padStart(64,'0')});}}finally{IDBObjectStore.prototype.put=originalPut;IDBObjectStore.prototype.add=originalAdd;}
      const finalRows=await rows(local,'reviews'),finalSettings=await rows(folder,'settings'),reopened=await folders.readFolderSettings();
      const oldRejected=async(name,version)=>new Promise(resolve=>{const r=indexedDB.open(name,version);r.onerror=()=>resolve(r.error.name==='VersionError');r.onsuccess=()=>{r.result.close();resolve(false);};});
      const results={localClosed,folderClosed,oldRejected:await oldRejected('private-score-desk-local-v1',4)&&await oldRejected('private-score-desk-folders-v1',1),legacyRead:JSON.stringify(before)===JSON.stringify(record),oldHead:oldConnection.head.id===head.id,inputRows:finalRows.filter(r=>r.kind==='score-inputs').length,headRows:finalSettings.filter(r=>r.kind==='folder-head').length,stableRows:startRows.length===finalRows.length&&startSettings.length===finalSettings.length,noBlobWrites:puts.length>0&&puts.every(r=>!r.blob),revision:saved.storageRevision,legacyEvent:JSON.stringify(finalRows.find(r=>r.id===event.id))===JSON.stringify(event),headExact:reopened.head.id===head.id&&reopened.pendingHead.id===head.id&&JSON.stringify(reopened.head.task)===JSON.stringify(head.task),listCount:(await folders.listFolderSettings()).length};
      localStorage.setItem('synthetic-input-id',record.id);local.close();folder.close();return results;
    });
    check(result.localClosed&&result.folderClosed&&result.oldRejected,'upgrades close old writers and prevent them from discarding input/handoff references');
    check(result.legacyRead&&result.oldHead&&result.legacyEvent,'legacy inline inputs, handoffs and immutable history retain their exact public content');
    check(result.inputRows===1&&result.headRows===1&&result.stableRows,'multiple saves and a shared pending handoff retain one input row and one handoff row');
    check(result.noBlobWrites&&result.revision===13,'ordinary saves advance CAS revisions using metadata writes with no Blob payloads');
    check(result.headExact&&result.listCount===1,'connection hydration preserves task identity and excludes sidecars from recent projects');
    await page.reload();const reopened=await page.evaluate(async()=>{const s=await import('./storage.js'),f=await import('./folder-settings.js'),record=await s.getSaved(localStorage.getItem('synthetic-input-id')),connection=await f.readFolderSettings();return {revision:record.storageRevision,source:await record.files.source.blob.text(),head:connection.head.id,pending:connection.pendingHead.id};});
    check(reopened.revision===13&&reopened.source==='%PDF SYNTHETIC'&&reopened.head===reopened.pending,'a fresh module session restores exact migrated inputs and both handoff references');
    const missing=await page.evaluate(async()=>{const f=await import('./folder-settings.js'),healthyId=crypto.randomUUID();await f.saveFolderConnection({connectionId:healthyId,directory:{name:'SYNTHETIC healthy'},paths:{source:'s.pdf',rendered:'r.pdf',ly:'s.ly'}});const db=await new Promise(resolve=>{const r=indexedDB.open('private-score-desk-folders-v1');r.onsuccess=()=>resolve(r.result);});await new Promise((resolve,reject)=>{const t=db.transaction('settings','readwrite'),s=t.objectStore('settings'),r=s.openKeyCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;if(String(c.primaryKey).startsWith('head:'))s.delete(c.primaryKey);c.continue();};t.oncomplete=resolve;t.onabort=()=>reject(t.error);});db.close();let rejected=false;try{await f.readFolderSettings();}catch(e){rejected=/handoff is missing/.test(e.message);}const rows=await f.listFolderSettings();return {rejected,isolated:rows.length===2&&!rows.find(row=>row.connectionId===healthyId).folderStorageError&&/handoff is missing/.test(rows.find(row=>row.connectionId!==healthyId).folderStorageError)};});
    check(missing.rejected,'a missing handoff sidecar reports an error rather than silently discarding its task');
    check(missing.isolated,'a damaged project remains visible with its error and does not block unrelated folder connections');
    return {name:'storage-inputs',assertions};
  }finally{await writeFile(resolve(evidence,'storage-inputs.txt'),log.join('\n'));await context.close();await server.close();}
}
