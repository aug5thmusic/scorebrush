// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Review heads and immutable input references share one atomic transaction.
import {sha256,roles} from './model.js';
import {mergeCompletions,canonical} from './completion-model.js';
import {fileInfo,strictJSON} from './workflow.js';
import {databaseMayExist} from './database-presence.js';
let dbPromise;
function database(){
  return dbPromise??=new Promise((resolve,reject)=>{
    // Version 5 also isolates immutable score inputs from frequently edited heads.
    // Existing rows migrate lazily in the same transaction as their next save.
    // Older writers cannot preserve the sidecar link, so versionchange closes
    // their connections and IndexedDB rejects attempts to reopen at older versions.
    const request=indexedDB.open('private-score-desk-local-v1',5);
    request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('reviews'))request.result.createObjectStore('reviews',{keyPath:'id'});};
    request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
    request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Database upgrade blocked by another open ScoreBrush tab.'));
  });
}
const EVIDENCE_PREFIX='retained-evidence:';
const INPUT_PREFIX='score-inputs:';
const inputError=()=>new Error('Saved score inputs are missing or inconsistent. Existing saved work was kept.');
const isBlob=value=>['[object Blob]','[object File]'].includes(Object.prototype.toString.call(value))&&typeof value.arrayBuffer==='function';
async function inputRecord(record){
  const identity={};
  for(const role of roles){
    const file=record.files?.[role],expected=record.review?.files?.[role];
    if(!file||!isBlob(file.blob)||!expected||file.name!==expected.name)throw inputError();
    const info=await fileInfo(file.blob);
    if(info.sha256!==expected.sha256||info.size!==expected.size)throw inputError();
    identity[role]={name:file.name,...info};
  }
  const id=INPUT_PREFIX+await sha256(new TextEncoder().encode(canonical(identity)));
  return {id,kind:'score-inputs',version:1,identity,files:record.files};
}
function hydrateInputs(store,record,accept,reject){
  if(!record?.inputFilesId){accept(record);return;}
  if(!/^score-inputs:[a-f0-9]{64}$/.test(record.inputFilesId)){reject(inputError());return;}
  const read=store.get(record.inputFilesId);read.onsuccess=()=>{
    const inputs=read.result;
    if(!inputs||inputs.kind!=='score-inputs'||inputs.version!==1||roles.some(role=>{const file=inputs.files?.[role],info=inputs.identity?.[role],expected=record.review?.files?.[role];return !file||!isBlob(file.blob)||!info||!expected||file.name!==expected.name||file.blob.size!==expected.size||info.name!==expected.name||info.size!==expected.size||info.sha256!==expected.sha256;})){reject(inputError());return;}
    const next=Object.fromEntries(Object.entries(record).map(([key,value])=>key==='inputFilesId'?['files',inputs.files]:[key,value]));
    try{accept(next);}catch(error){reject(error);}
  };
}
const pendingInputStores=new WeakMap();
function writeWithInputs(store,mode,record,inputs,reject){
  const next=Object.fromEntries(Object.entries(record).filter(([key])=>key!=='inputFilesId').map(([key,value])=>key==='files'?['inputFilesId',inputs.id]:[key,value]));
  // Several recovered heads/events can share inputs in this transaction.
  // Coordinate their single insertion even before the first getKey fires.
  let pending=pendingInputStores.get(store);if(!pending){pending=new Set();pendingInputStores.set(store,pending);}
  if(pending.has(inputs.id)){store[mode](next);return;}pending.add(inputs.id);
  const read=store.getKey?store.getKey(inputs.id):store.get(inputs.id);
  read.onsuccess=()=>{try{
    if(read.result===undefined)store.add(inputs);
    store[mode](next);
  }catch(error){reject(error);}};
}
const evidenceFields=['retainedLegacyEvidence','retainedHandoffEvidence'];
const isEvidenceId=id=>typeof id==='string'&&/^retained-evidence:[a-f0-9-]{36}$/.test(id);
const evidenceError=()=>new Error('Retained recovery evidence is missing or inconsistent. Existing saved work was kept.');
function withoutEvidence(record){const next={...record};for(const field of evidenceFields)delete next[field];return next;}
function publicRecord(record){if(!record)return record;const next={...record};delete next.retainedEvidenceId;return next;}
function hydrateRecord(store,record,accept,reject){hydrateInputs(store,record,value=>hydrateEvidence(store,value,accept,reject),reject);}
function hydrateEvidence(store,record,accept,reject){
  if(!record?.retainedEvidenceId){try{accept(record);}catch(error){reject(error);}return;}
  if(!isEvidenceId(record.retainedEvidenceId)){reject(evidenceError());return;}
  const request=store.get(record.retainedEvidenceId);request.onsuccess=()=>{
    const value=request.result;
    if(!value||value.kind!=='retained-evidence'||value.version!==1||value.workspaceId!==record.id||evidenceFields.some(field=>value[field]!==undefined&&!Array.isArray(value[field]))){reject(evidenceError());return;}
    try{accept({...record,...Object.fromEntries(evidenceFields.filter(field=>value[field]!==undefined).map(field=>[field,value[field]]))});}catch(error){reject(error);}
  };
}
function verifyEvidenceKey(store,record,accept,reject){
  if(!record?.retainedEvidenceId){try{accept(record);}catch(error){reject(error);}return;}
  if(!isEvidenceId(record.retainedEvidenceId)){reject(evidenceError());return;}
  // getKey verifies presence without cloning the immutable package Blob graph.
  const request=store.getKey?store.getKey(record.retainedEvidenceId):store.get(record.retainedEvidenceId);
  request.onsuccess=()=>{if(request.result===undefined){reject(evidenceError());return;}try{accept(record);}catch(error){reject(error);}};
}
function normalizedRecord(store,record,current=null){
  const next=withoutEvidence(record);delete next.retainedEvidenceId;
  const values=Object.fromEntries(evidenceFields.filter(field=>record[field]!==undefined).map(field=>[field,record[field]]));
  if(current?.retainedEvidenceId){
    if(!isEvidenceId(current.retainedEvidenceId))throw evidenceError();
    if(evidenceFields.every(field=>record[field]===undefined||record[field]===current[field])){next.retainedEvidenceId=current.retainedEvidenceId;return next;}
  }
  if(!Object.keys(values).length){if(record.retainedEvidenceId&&!current)throw evidenceError();return next;}
  if(evidenceFields.some(field=>values[field]!==undefined&&!Array.isArray(values[field])))throw evidenceError();
  const id=EVIDENCE_PREFIX+crypto.randomUUID();store.add({id,kind:'retained-evidence',version:1,workspaceId:record.id,...values});next.retainedEvidenceId=id;return next;
}
async function readSaved(id,full){
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readonly'),store=tx.objectStore('reviews'),request=store.get(id);let result,failure;
    const failed=error=>{failure=error;tx.abort();};
    request.onsuccess=()=>{if(full)hydrateRecord(store,request.result,value=>{result=publicRecord(value);},failed);else verifyEvidenceKey(store,request.result,value=>hydrateInputs(store,value,item=>{result=item?withoutEvidence(item):item;},failed),failed);};
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||new Error('Saved review could not be read.'));tx.onerror=()=>{};
  });
}
async function transaction(mode,action){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('reviews',mode),request=action(tx.objectStore('reviews'));let result;request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||new Error('Local storage transaction aborted.'));tx.onerror=()=>reject(tx.error||request.error);});}
export const getSaved=id=>readSaved(id,true);
export const getSavedState=id=>readSaved(id,false);
// Scan keys first: listing current reviews must not clone every historical
// decision and its PDFs; internal evidence rows are never saved-review entries.
async function currentRecords({evidence=true,inputs=true}={}){
  const db=await database();return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readonly'),store=tx.objectStore('reviews'),result=[];let failure;
    const cursor=store.openKeyCursor();cursor.onsuccess=()=>{
      const entry=cursor.result;if(!entry)return;
      const id=String(entry.primaryKey);
      if(!id.startsWith('returned-event:')&&!id.startsWith('review-event:')&&!id.startsWith('completion:')&&!id.startsWith(EVIDENCE_PREFIX)&&!id.startsWith(INPUT_PREFIX)){const read=store.get(entry.primaryKey);read.onsuccess=()=>{if(read.result?.review&&!read.result.kind){const failed=error=>{failure=error;tx.abort();};if(evidence)hydrateRecord(store,read.result,value=>result.push(publicRecord(value)),failed);else if(inputs)hydrateInputs(store,read.result,value=>result.push(withoutEvidence(value)),failed);else result.push(withoutEvidence(read.result));}};}
      entry.continue();
    };
    tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||new Error('Saved reviews could not be read.'));tx.onerror=()=>{};
  });
}
export const savedRecords=currentRecords;
const legacyStamp=items=>canonical((items??[]).map(e=>({bundle:e.bundle,payloads:[...e.payloads].map(([path,blob])=>[path,blob.size]).sort(([a],[b])=>a.localeCompare(b))})));
const legacyConflict=()=>new Error('Conflicting retained legacy history. Existing saved work is unchanged; keep both backups and resolve the conflicting evidence before importing.');
async function validatedLegacy(items,sourceHash){
  const result=new Map();
  for(const item of items??[]){
    const {bundle,payloads}=item;
    if(!bundle||!(payloads instanceof Map)||bundle.id!=='legacy-package:'+bundle.payloads?.['manifest.json']?.sha256)throw legacyConflict();
    const declarations={};for(const [path,blob]of payloads)declarations[path]=await fileInfo(blob);
    if(canonical(declarations)!==canonical(bundle.payloads))throw legacyConflict();
    const manifest=strictJSON(await payloads.get('manifest.json').text());
    if(manifest.schema!=='score-desk-package'||manifest.version!==1||manifest.inputs?.source?.sha256!==sourceHash)throw legacyConflict();
    for(const [path,info]of Object.entries(declarations))if(path!=='manifest.json'&&canonical(info)!==canonical(manifest.payloads?.[path]))throw legacyConflict();
    const prior=result.get(bundle.id);if(prior&&canonical(prior.bundle)!==canonical(bundle))throw legacyConflict();
    if(!prior)result.set(bundle.id,item);
  }
  return result;
}
// Hash evidence before entering IndexedDB's synchronous request callbacks.
// Recheck its observed metadata in the write transaction to avoid losing an
// additive import by another tab while validation was running.
export async function checkLegacyImport(records){
  const prepared=new Map();
  for(const record of records){
    if(!record.retainedLegacyEvidence?.length)continue;
    const current=await getSaved(record.id),existing=await validatedLegacy(current?.retainedLegacyEvidence,record.review.files.source.sha256);
    const incoming=await validatedLegacy(record.retainedLegacyEvidence,record.review.files.source.sha256);
    for(const [id,item]of incoming){const prior=existing.get(id);if(prior&&canonical(prior.bundle)!==canonical(item.bundle))throw legacyConflict();if(!prior)existing.set(id,item);}
    prepared.set(record.id,{observed:legacyStamp(current?.retainedLegacyEvidence),merged:[...existing.values()]});
  }
  return prepared;
}
// Restore missing records only. A concurrent tab can never be overwritten by
// folder recovery; equality checks and additions share one transaction.
export async function restoreMissing(records){
  records=structuredClone(records);
  const legacy=await checkLegacyImport(records);
  const inputs=new Map();for(const record of records)inputs.set(record.id,await inputRecord(record));
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews');let failure;
    for(const record of records){const req=store.get(record.id);req.onsuccess=()=>{
      const merge=existing=>{
      if(existing){
        if(recoveryIdentity(existing)!==recoveryIdentity(record)){failure=new StorageConflictError();tx.abort();return;}
        const next={...existing};let changed=false;
        const retained=legacy.get(record.id);
        if(retained){
          if(legacyStamp(existing.retainedLegacyEvidence)!==retained.observed){failure=legacyConflict();tx.abort();return;}
          if(legacyStamp(retained.merged)!==retained.observed){next.retainedLegacyEvidence=retained.merged;changed=true;}
        }
        // Add validated immutable package evidence without changing the review,
        // revision, storage counter or edit journal. Keep prior evidence too.
        if(record.retainedHandoffEvidence?.length){
          const evidence=new Map((existing.retainedHandoffEvidence??[]).map(e=>[e.bundle.id,e]));
          for(const item of record.retainedHandoffEvidence){const prior=evidence.get(item.bundle.id);if(prior&&canonical(prior.bundle)!==canonical(item.bundle)){failure=new StorageConflictError();tx.abort();return;}if(!prior){evidence.set(item.bundle.id,item);changed=true;}}
          next.retainedHandoffEvidence=[...evidence.values()];
        }
        if(changed)writeWithInputs(store,'put',normalizedRecord(store,next,existing),inputs.get(record.id),error=>{failure=error;tx.abort();});
        return;
      }
      for(const completion of record.completions??[]){const key='completion:'+completion.id,check=store.get(key);check.onsuccess=()=>{if(check.result&&canonical(check.result.record)!==canonical(completion)){failure=new Error('Completion identity conflict during recovery.');tx.abort();}else if(!check.result)store.put({id:key,kind:'completion-record',record:completion});};}
      writeWithInputs(store,'add',normalizedRecord(store,{...record,...(legacy.has(record.id)?{retainedLegacyEvidence:legacy.get(record.id).merged}:{}),storageRevision:record.storageRevision??1}),inputs.get(record.id),error=>{failure=error;tx.abort();});
      };hydrateRecord(store,req.result,merge,error=>{failure=error;tx.abort();});
    };}
    tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure||tx.error);tx.onerror=()=>{};
  });
}
export const recoveryIdentity=r=>canonical({review:r.review,returned:r.returned??null,revisionId:r.revisionId,completions:r.completions??[]});
// Durable research edits, not typing/view events. Preferences and save timestamps
// do not make a new journal state; exact original records remain untouched.
export function journalIdentity(record){
  const review={...record.review};delete review.updatedAt;delete review.preferences;
  return canonical({review,returned:record.returned??null,completions:record.completions??[]});
}
export class StorageConflictError extends Error {
  constructor(){super('Another tab saved a newer version. Your edits remain in this tab; download a recovery ZIP before reloading or switching.');this.name='StorageConflictError';}
}
// The read AND conditional write must share one readwrite transaction. IndexedDB
// serializes these transactions across tabs; timestamps are not a lock.
export async function putSaved(record,expectedRevision,completion=null){
  const inputs=await inputRecord(record);
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews');
    let saved,failure;
    const request=store.get(record.id);
    request.onsuccess=()=>{
      const save=current=>{
      const actual=current?(current.storageRevision??0):null;
      if(completion&&current?.completions?.some(r=>r.id===completion.id)){
        const existing=current.completions.find(r=>r.id===completion.id);
        if(current.revisionId===record.revisionId&&canonical(existing)===canonical(completion)){
          const key='completion:'+completion.id,lookup=store.get(key);lookup.onsuccess=()=>{if(lookup.result&&canonical(lookup.result.record)!==canonical(completion)){failure=new Error('Completion identity conflicts with an immutable earlier record.');tx.abort();return;}if(!lookup.result)store.add({id:key,kind:'completion-record',record:completion});saved=current;};return;
        }
        failure=new StorageConflictError();tx.abort();return;
      }
      if(actual!==expectedRevision){failure=new StorageConflictError();tx.abort();return;}
      saved={...record,storageRevision:(actual??0)+1,journalVersion:1,
        projectId:current?.projectId??record.projectId??crypto.randomUUID(),
        initialTranscriptionFilename:current&&Object.hasOwn(current,'initialTranscriptionFilename')?current.initialTranscriptionFilename:Object.hasOwn(record,'initialTranscriptionFilename')?record.initialTranscriptionFilename:current?null:record.review.files?.rendered?.name??null,
        ...(current?.pdfOutput||record.pdfOutput?{pdfOutput:current?.pdfOutput??record.pdfOutput}:{}),
        ...(current?.retainedLegacyEvidence||record.retainedLegacyEvidence?{retainedLegacyEvidence:current?.retainedLegacyEvidence??record.retainedLegacyEvidence}:{}),
        ...(current?.retainedHandoffEvidence||record.retainedHandoffEvidence?{retainedHandoffEvidence:current?.retainedHandoffEvidence??record.retainedHandoffEvidence}:{}),
        parentWorkspaceId:current?.parentWorkspaceId??record.parentWorkspaceId??null};
      try{
        saved.completions=mergeCompletions(current?.completions,record.completions);
        const writeHead=()=>{try{
          if(current?.journalVersion===1&&recoveryIdentity(current)===recoveryIdentity(saved)){saved=current;return;}
          // Ordinary annotations and review decisions replace the durable head.
          // Archive an immutable version only at an explicit new-render boundary.
          // Existing historical events remain intact and remain its predecessor.
          const predecessor=current?.historyId??current?.historyPredecessorId??null;
          saved.historyId=null;
          if(predecessor)saved.historyPredecessorId=predecessor;else delete saved.historyPredecessorId;
          saved=normalizedRecord(store,saved,current);writeWithInputs(store,'put',saved,inputs,error=>{failure=error;tx.abort();});
        }catch(error){failure=error;tx.abort();}};
        let pending=saved.completions.length;if(!pending){writeHead();return;}
        // Global immutable IDs also protect imports into a new recovery branch.
        // All lookups, registry additions, history and the head share this tx.
        for(const item of saved.completions){const key='completion:'+item.id,lookup=store.get(key);lookup.onsuccess=()=>{
          if(failure)return;
          if(lookup.result&&canonical(lookup.result.record)!==canonical(item)){failure=new Error('Completion identity conflicts with an immutable earlier record.');tx.abort();return;}
          if(!lookup.result)store.add({id:key,kind:'completion-record',record:item});
          if(!--pending)writeHead();
        };}
      }catch(error){failure=error;tx.abort();}
      };
      const proceed=current=>{
        if(current?.inputFilesId){
          if(!/^score-inputs:[a-f0-9]{64}$/.test(current.inputFilesId)){failure=inputError();tx.abort();return;}
          const check=store.getKey?store.getKey(current.inputFilesId):store.get(current.inputFilesId);check.onsuccess=()=>{if(check.result===undefined){failure=inputError();tx.abort();}else save(Object.fromEntries(Object.entries(current).map(([key,value])=>key==='inputFilesId'?['files',record.files]:[key,value])));};
        }else save(current);
      };
      if(request.result?.retainedEvidenceId&&evidenceFields.some(field=>record[field]!==undefined))hydrateEvidence(store,request.result,proceed,error=>{failure=error;tx.abort();});else verifyEvidenceKey(store,request.result,proceed,error=>{failure=error;tx.abort();});
    };
    tx.oncomplete=()=>{if(saved?.inputFilesId){saved={...saved};delete saved.inputFilesId;}resolve(saved);};
    tx.onabort=()=>reject(failure||tx.error||new Error('Local storage transaction aborted.'));
    tx.onerror=()=>{failure??=tx.error;};
  });
}
export const listSaved=async({existingOnly=false}={})=>{
  // A first write may start while inventory is pending. In that case join its
  // normal database connection/read instead of returning an earlier absence.
  if(existingOnly&&!dbPromise&&!await databaseMayExist('private-score-desk-local-v1')&&!dbPromise)return [];
  return (await currentRecords({evidence:false,inputs:false})).map(({id,review,returned})=>({id,updatedAt:review.updatedAt,name:(returned?'Returned review · ':'')+review.files.rendered.name,count:review.findings.length})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
};
export async function workspaceHistory(id){
  return (await workspaceHistories([id])).get(id)??[];
}
// Legacy event keys do not contain a workspace ID. Scan their two ranges once
// for an entire lineage, rather than once per retained version of that project.
export async function workspaceHistories(ids){
  const selected=new Set(ids),records=new Map([...selected].map(id=>[id,[]]));
  if(!selected.size)return records;
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readonly'),store=tx.objectStore('reviews');let failure;
    const append=rows=>{for(const row of rows)if(['returned-event','review-event'].includes(row.kind)&&selected.has(row.workspaceId))hydrateInputs(store,row,value=>records.get(row.workspaceId).push(value),error=>{failure=error;tx.abort();});};
    // Prefix bounds exclude potentially large current heads and completion rows.
    // Workspace IDs are not encoded in legacy event keys; retain all matching
    // old events without changing the database schema or rewriting their IDs.
    if(globalThis.IDBKeyRange){
      for(const prefix of ['returned-event:','review-event:']){const req=store.getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));req.onsuccess=()=>append(req.result);}
    }else{
      const req=store.openKeyCursor();req.onsuccess=()=>{const cursor=req.result;if(!cursor)return;const key=String(cursor.primaryKey);if(key.startsWith('returned-event:')||key.startsWith('review-event:')){const read=store.get(cursor.primaryKey);read.onsuccess=()=>append(read.result?[read.result]:[]);}cursor.continue();};
    }
    tx.oncomplete=()=>{for(const rows of records.values())rows.sort((a,b)=>a.storageRevision-b.storageRevision);resolve(records);};tx.onabort=()=>reject(failure||tx.error||new Error('Saved version history could not be read.'));tx.onerror=()=>{};
  });
}
export const returnedHistory=workspaceHistory;

// The caller has successfully opened these resulting rendered bytes. Preserve
// the departing completed review exactly once without inventing a local edit.
export async function archiveSavedVersion(id,expectedRevision,{resultingSnapshotId,resultingRenderSha256}={}){
  const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  if(!hash(resultingSnapshotId)||!hash(resultingRenderSha256))throw new Error('A completed version requires the resulting snapshot and rendering identities.');
  const observed=await getSaved(id);
  if(!observed||observed.storageRevision!==expectedRevision)throw new StorageConflictError();
  if(observed.review.files.rendered.sha256===resultingRenderSha256)return null;
  if(observed.review.snapshotId===resultingSnapshotId)throw new Error('The resulting rendering identity is inconsistent.');
  const digest=(await fileInfo(new Blob([canonical({schema:'scorebrush-completed-version',id,revisionId:observed.revisionId,storageRevision:expectedRevision,resultingSnapshotId,resultingRenderSha256})]))).sha256;
  const uuid=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join('-'),kind=observed.returned?'returned-event':'review-event',eventId=kind+':'+uuid;
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews');let failure;
    const read=store.get(id);read.onsuccess=()=>{
      const current=read.result;
      if(!current||current.storageRevision!==expectedRevision||recoveryIdentity(current)!==recoveryIdentity(observed)){failure=new StorageConflictError();tx.abort();return;}
      const check=store.get(eventId);check.onsuccess=()=>{
        const prior=check.result;
        if(prior&&(recoveryIdentity(prior)!==recoveryIdentity(current)||prior.workspaceId!==id||prior.resultingSnapshotId!==resultingSnapshotId||prior.resultingRenderSha256!==resultingRenderSha256)){failure=new StorageConflictError();tx.abort();return;}
        if(!prior){
          const event={...current,id:eventId,kind,workspaceId:id,historyId:eventId,parentHistoryId:current.historyId??current.historyPredecessorId??null,createdAt:new Date().toISOString(),historyCoverage:'durable-save',resultingSnapshotId,resultingRenderSha256};
          delete event.historyPredecessorId;delete event.pdfOutput;delete event.retainedLegacyEvidence;delete event.retainedHandoffEvidence;delete event.retainedEvidenceId;store.add(event);
        }
        if(!prior){const next={...current,historyId:eventId};delete next.historyPredecessorId;store.put(next);}
      };
    };
    tx.oncomplete=()=>resolve(eventId);tx.onabort=()=>reject(failure||tx.error||new Error('The completed review could not be archived.'));tx.onerror=()=>{};
  });
}





