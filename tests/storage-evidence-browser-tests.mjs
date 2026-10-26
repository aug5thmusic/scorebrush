// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runStorageEvidence({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('storage-evidence: '+label);};
  await page.route('**/synthetic-storage',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>SYNTHETIC storage migration</title>'}));
  try{
    await page.goto(server.origin+'/synthetic-storage');
    const result=await page.evaluate(async()=>{
      const {identify,newReview}=await import('./model.js'),{makeRecovery}=await import('./export.js'),{fileInfo}=await import('./workflow.js');
      const files={source:{name:'source.pdf',blob:new Blob(['%PDF SYNTHETIC source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF SYNTHETIC rendering'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC source'])}},identity=await identify(files),review=newReview(identity.identity,identity.snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]);
      const payloads=await makeRecovery(review,files),declarations={};for(const[path,blob]of payloads)declarations[path]=await fileInfo(blob);
      const legacy={bundle:{id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations},payloads},record={id:identity.snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[],projectId:crypto.randomUUID(),storageRevision:7,journalVersion:1,retainedLegacyEvidence:[legacy]},event={...record,id:'review-event:'+crypto.randomUUID(),kind:'review-event',workspaceId:record.id,historyId:null,createdAt:'2020-01-01T00:00:00Z'};delete event.retainedLegacyEvidence;
      const old=await new Promise((resolve,reject)=>{const req=indexedDB.open('private-score-desk-local-v1',3);req.onupgradeneeded=()=>req.result.createObjectStore('reviews',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
      window.oldWriterClosed=false;old.onversionchange=()=>{oldWriterClosed=true;old.close();};await new Promise((resolve,reject)=>{const tx=old.transaction('reviews','readwrite'),store=tx.objectStore('reviews');store.put(record);store.put(event);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
      const storage=await import('./storage.js'),full=await storage.getSaved(record.id);const oldRejected=await new Promise(resolve=>{const req=indexedDB.open('private-score-desk-local-v1',3);req.onerror=()=>resolve(req.error.name==='VersionError');req.onsuccess=()=>{req.result.close();resolve(false);};});
      const lightweight=({...value})=>{delete value.retainedLegacyEvidence;delete value.retainedHandoffEvidence;return value;},saved=await storage.putSaved({...lightweight(full),revisionId:crypto.randomUUID(),review:{...review,updatedAt:'2030-01-01T00:00:00Z'}},7),state=await storage.getSavedState(record.id);
      const reads=[],keys=[],get=IDBObjectStore.prototype.get,getKey=IDBObjectStore.prototype.getKey;IDBObjectStore.prototype.get=function(key){if(this.name==='reviews')reads.push(key);return get.call(this,key);};IDBObjectStore.prototype.getKey=function(key){if(this.name==='reviews')keys.push(key);return getKey.call(this,key);};
      let next;try{next=await storage.putSaved({...lightweight(saved),revisionId:crypto.randomUUID(),review:{...saved.review,updatedAt:'2030-01-02T00:00:00Z'}},saved.storageRevision);await storage.getSavedState(record.id);}finally{IDBObjectStore.prototype.get=get;IDBObjectStore.prototype.getKey=getKey;}
      const restored=await storage.getSaved(record.id),history=await storage.workspaceHistory(record.id);window.syntheticRecordId=record.id;localStorage.setItem('synthetic-storage-id',record.id);
      return {oldWriterClosed,oldRejected,normalized:Boolean(state.retainedEvidenceId)&&!state.retainedLegacyEvidence,reads,keys,pointer:state.retainedEvidenceId,revision:next.storageRevision,exactEvidence:JSON.stringify(restored.retainedLegacyEvidence[0].bundle)===JSON.stringify(legacy.bundle),publicPointer:restored.retainedEvidenceId,exactHistory:JSON.stringify(history)===JSON.stringify([event]),listed:(await storage.listSaved()).map(r=>r.id)};
    });
    check(result.oldWriterClosed&&result.oldRejected,'v4 upgrade closes the old connection and prevents v3 writers from dropping evidence links');
    check(result.normalized&&result.exactEvidence&&result.publicPointer===undefined,'first edit atomically separates exact retained packages while full reads preserve their public shape');
    check(result.reads.every(key=>!String(key).startsWith('retained-evidence:'))&&result.keys.includes(result.pointer),'ordinary edits and readback verify the evidence key without cloning its Blob graph');
    check(result.revision===9&&result.exactHistory&&result.listed.length===1,'CAS counters advance while old immutable history and the saved-review menu remain unchanged');
    await page.reload();const reopened=await page.evaluate(async()=>{const storage=await import('./storage.js'),record=await storage.getSaved(localStorage.getItem('synthetic-storage-id'));return {revision:record.storageRevision,evidence:record.retainedLegacyEvidence.length,events:(await storage.workspaceHistory(record.id)).length};});
    check(reopened.revision===9&&reopened.evidence===1&&reopened.events===1,'fresh module startup hydrates the migrated head and preserves every original history entry');
    return {name:'storage-evidence',assertions};
  }finally{await writeFile(resolve(evidence,'storage-evidence.txt'),log.join('\n'));await context.close();await server.close();}
}
