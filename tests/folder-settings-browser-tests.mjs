// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runFolderSettings({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),log=[];let assertions=0,result;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('folder-settings: '+label);};
  await page.route('**/synthetic-folder-settings',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>SYNTHETIC folder settings rollback</title>'}));
  try{
    await page.goto(server.origin+'/synthetic-folder-settings');
    result=await page.evaluate(async()=>{
      const folders=await import('./folder-settings.js'),{identify,newReview,blobHash}=await import('./model.js'),{makeTask}=await import('./workflow.js'),{makeRecovery}=await import('./export.js');
      const files={source:{name:'SYNTHETIC.pdf',blob:new Blob(['%PDF SYNTHETIC source'])},rendered:{name:'SYNTHETIC-rendered.pdf',blob:new Blob(['%PDF SYNTHETIC rendering'])},ly:{name:'SYNTHETIC.ly',blob:new Blob(['% SYNTHETIC notation'])}},identified=await identify(files),review=newReview(identified.identity,identified.snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]);
      const task=await makeTask(review,files,{},'120',()=>{},makeRecovery),connection={connectionId:crypto.randomUUID(),directory:{name:'SYNTHETIC'},paths:{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'},head:task,pendingHead:task};
      await folders.saveFolderSettings(connection);
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('private-score-desk-folders-v1',2);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      async function exact(value){
        if(value instanceof Blob)return {blob:{size:value.size,type:value.type,sha256:await blobHash(value)}};
        if(value instanceof Map)return {map:await Promise.all([...value].map(async([key,item])=>[key,await exact(item)]))};
        if(Array.isArray(value))return Promise.all(value.map(exact));
        if(value&&typeof value==='object')return Object.fromEntries(await Promise.all(Object.entries(value).map(async([key,item])=>[key,await exact(item)])));
        return value;
      }
      const snapshot=async()=>{
        const rows=await new Promise((resolve,reject)=>{const tx=db.transaction('settings','readonly'),store=tx.objectStore('settings');let keys,values;tx.oncomplete=()=>resolve({keys,values});tx.onabort=()=>reject(tx.error);const k=store.getAllKeys(),v=store.getAll();k.onsuccess=()=>keys=k.result;v.onsuccess=()=>values=v.result;});
        return {keys:rows.keys,values:await exact(rows.values)};
      };
      const before=await snapshot(),newTask=await makeTask({...review,updatedAt:'2026-10-25T12:01:00.000Z'},files,{},'121',()=>{},makeRecovery),candidate={...connection,head:newTask,pendingHead:newTask};
      const originalPut=IDBObjectStore.prototype.put,originalAdd=IDBObjectStore.prototype.add;let naturalError,caughtError,synchronousQueued=0;
      IDBObjectStore.prototype.put=function(...args){try{return originalPut.apply(this,args);}catch(error){naturalError=error;throw error;}};
      const originalGetKey=IDBObjectStore.prototype.getKey;
      IDBObjectStore.prototype.getKey=function(...args){if(this.name==='settings'&&String(args[0]).startsWith('head:'))synchronousQueued++;return originalGetKey.apply(this,args);};
      try{await folders.saveFolderSettings({...candidate,uncloneableMetadata:()=>{}});}catch(error){caughtError=error;}finally{IDBObjectStore.prototype.put=originalPut;IDBObjectStore.prototype.getKey=originalGetKey;}
      // A transaction opened after rejection also waits for any outstanding
      // earlier write transaction, so comparison observes settled durable rows.
      const afterClone=await snapshot(),cloneFailure={name:caughtError?.name,message:caughtError?.message,originalErrorPreserved:caughtError===naturalError,sidecarLookupsQueued:synchronousQueued};
      let asynchronousError,scheduledConnection=false,scheduledCurrent=false,queuedDuplicate=false;
      IDBObjectStore.prototype.put=function(value,key,...args){
        const request=originalPut.call(this,value,key,...args);
        if(this.name==='settings'){
          if(key==='folder:'+connection.connectionId)scheduledConnection=true;
          if(key==='current'){scheduledCurrent=true;queuedDuplicate=true;originalAdd.call(this,{connectionId:'SYNTHETIC duplicate'},'current');}
        }
        return request;
      };
      try{await folders.saveFolderSettings(candidate);}catch(error){asynchronousError=error;}finally{IDBObjectStore.prototype.put=originalPut;}
      const afterRequestError=await snapshot();
      let abortTriggered=false,abortError;
      IDBObjectStore.prototype.put=function(value,key,...args){const request=originalPut.call(this,value,key,...args);if(this.name==='settings'&&key==='current'){const tx=this.transaction;queueMicrotask(()=>{abortTriggered=true;tx.abort();});}return request;};
      try{await folders.saveFolderSettings(candidate);}catch(error){abortError=error;}finally{IDBObjectStore.prototype.put=originalPut;}
      const afterAbort=await snapshot();
      // This is a settings-only durability marker; archive validation and the
      // complete intent schema are exercised by the archive interruption suite.
      const intent={synthetic:'folder-settings durability'},durability=[],transaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(names,mode,options){const tx=transaction.call(this,names,mode,options);if(this.name==='private-score-desk-folders-v1'&&mode==='readwrite')durability.push({requested:options?.durability??null,actual:tx.durability});return tx;};
      try{
        await folders.saveFolderSettings({...connection,pendingRecoveryIntent:intent});
        await folders.saveFolderSettings({...connection,pendingCheckpointId:'a'.repeat(64)});
        await folders.saveFolderSettings(connection);
      }finally{IDBDatabase.prototype.transaction=transaction;}
      const final=await snapshot(),reopened=await folders.readFolderSettings();db.close();
      return {before,afterClone,cloneFailure,afterRequestError,requestFailure:{name:asynchronousError?.name,scheduledConnection,scheduledCurrent,queuedDuplicate},afterAbort,abortFailure:{name:abortError?.name,triggered:abortTriggered},durability,final,reopened:{connectionId:reopened.connectionId,head:reopened.head.id,pendingHead:reopened.pendingHead.id},taskId:task.id,connectionId:connection.connectionId};
    });
    const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b),connectionIndex=result.before.keys.indexOf('folder:'+result.connectionId),currentIndex=result.before.keys.indexOf('current');
    check(result.cloneFailure.name==='DataCloneError'&&result.cloneFailure.originalErrorPreserved,'natural IndexedDB serialization failure preserves the original DataCloneError');
    check(result.cloneFailure.sidecarLookupsQueued>0,'serialization failure occurs after immutable handoff work has been queued');
    check(equal(result.before.keys,result.afterClone.keys),'synchronous failure leaves exactly the prior keys with no orphan handoff');
    check(equal(result.before.values[connectionIndex],result.afterClone.values[connectionIndex])&&equal(result.before.values[currentIndex],result.afterClone.values[currentIndex]),'synchronous failure preserves the exact existing connection and current pointer');
    check(equal(result.before,result.afterClone),'synchronous failure preserves every prior metadata field and payload byte');
    check(result.requestFailure.name==='ConstraintError'&&result.requestFailure.scheduledConnection&&result.requestFailure.scheduledCurrent&&result.requestFailure.queuedDuplicate,'a real asynchronous request failure follows queued connection and current writes');
    check(equal(result.before,result.afterRequestError),'asynchronous request failure rolls back the complete connection and handoff transaction');
    check(result.abortFailure.triggered&&!!result.abortFailure.name&&equal(result.before,result.afterAbort),'explicit asynchronous transaction abort rolls back all queued writes');
    check(result.durability.length===3&&result.durability[0].requested==='strict'&&result.durability[0].actual==='strict','archive intent uses an actual strict-durability IndexedDB transaction');
    check(result.durability[1].requested==='strict'&&result.durability[1].actual==='strict'&&result.durability[2].requested===null,'checkpoint intent stays strict and ordinary metadata keeps default durability');
    check(equal(result.before,result.final)&&result.reopened.connectionId===result.connectionId&&result.reopened.head===result.taskId&&result.reopened.pendingHead===result.taskId,'valid saves and hydration remain usable after transaction failures');
    return {name:'folder-settings',assertions};
  }finally{await writeFile(resolve(evidence,'folder-settings.txt'),log.join('\n'));if(result)await writeFile(resolve(evidence,'folder-settings.json'),JSON.stringify(result,null,2));await context.close();await server.close();}
}
