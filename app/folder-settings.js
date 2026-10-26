// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {sha256} from './model.js';
import {canonical} from './completion-model.js';
import {fileInfo} from './workflow.js';
import {databaseMayExist} from './database-presence.js';
class FolderHandoffError extends Error {}
const fail=message=>{throw new FolderHandoffError(message);};
let database;
function folderDatabase(){return database??=new Promise((resolve,reject)=>{const r=indexedDB.open('private-score-desk-folders-v1',2);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('settings'))r.result.createObjectStore('settings');};r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Close another ScoreBrush window before upgrading folder storage.'));r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};});}
async function settingsOperation(mode,action){const db=await folderDatabase();return new Promise((resolve,reject)=>{
  const tx=db.transaction('settings',mode);let result,failure;
  tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(failure||tx.error||new Error('Folder connection could not be saved in this browser.'));tx.onerror=()=>{};
  try{const r=action(tx.objectStore('settings'));r.onsuccess=()=>result=r.result;}catch(error){failure=error;try{tx.abort();}catch{reject(failure);}}
});}
// A connection changes on every checkpoint, but its handoff bytes are immutable.
// Store those once in the same database/transaction; old inline rows migrate on
// their next save. Older writers cannot open v2 and discard these references.
async function connectionHead(entry){
  const payloads=[];for(const [path,blob]of entry.payloads)payloads.push([path,await fileInfo(blob)]);
  const files={};for(const [role,file]of Object.entries(entry.files))files[role]={...file,blob:await fileInfo(file.blob)};
  const identity={...entry,payloads,files,...(entry.zip?{zip:await fileInfo(entry.zip)}:{})};
  return {key:'head:'+await sha256(new TextEncoder().encode(canonical(identity))),entry};
}
async function hydrateConnection(value){
  if(!value)return value;const next={...value};
  for(const field of ['head','pendingHead'])if(value[field+'Ref']){
    const key=value[field+'Ref'];if(!/^head:[a-f0-9]{64}$/.test(key))fail('Saved folder handoff reference is invalid.');
    const row=await settingsOperation('readonly',store=>store.get(key));
    if(!row||row.kind!=='folder-head'||row.version!==1||!row.entry||row.entry.kind!=='task'||!(row.entry.payloads instanceof Map))fail('Saved folder handoff is missing. Existing project files were kept.');
    next[field]=row.entry;delete next[field+'Ref'];
  }return next;
}
async function writeConnection(value,{activate=true}={}){
  value.connectionId??=crypto.randomUUID();const next={...value},heads=[];
  for(const field of ['head','pendingHead']){
    delete next[field+'Ref'];if(!value[field])continue;
    const head=await connectionHead(value[field]);heads.push(head);next[field+'Ref']=head.key;delete next[field];
  }
  const db=await folderDatabase();return new Promise((resolve,reject)=>{
    // Intent must commit before the independent filesystem replacement. Ask
    // IndexedDB to flush that transaction rather than use relaxed durability.
    const tx=db.transaction('settings','readwrite',next.pendingCheckpointId||next.pendingRecoveryIntent?{durability:'strict'}:undefined);let failure;
    tx.oncomplete=resolve;tx.onabort=()=>reject(failure||tx.error||new Error('Folder connection could not be saved in this browser.'));tx.onerror=()=>{};
    const abort=error=>{failure??=error;try{tx.abort();}catch{reject(failure);}};
    // A synchronous cloning/request error does not abort IndexedDB by itself.
    // Abort the already queued sidecar work before reporting the original error.
    try{
      const store=tx.objectStore('settings');
      for(const head of new Map(heads.map(head=>[head.key,head])).values()){const check=store.getKey(head.key);check.onsuccess=()=>{try{if(check.result===undefined)store.add({kind:'folder-head',version:1,entry:head.entry},head.key);}catch(error){abort(error);}};}
      store.put(next,'folder:'+next.connectionId);if(activate)store.put({connectionId:next.connectionId},'current');
    }catch(error){abort(error);}
  });
}
async function settings(mode,value){
  if(mode==='list'){
    const rows=(await settingsOperation('readonly',store=>store.getAll(globalThis.IDBKeyRange?.bound('folder:','folder:\uffff')))).filter(item=>item?.directory&&item?.paths);
    const legacy=await settingsOperation('readonly',store=>store.get('current'));if(legacy?.directory&&!rows.some(row=>row.connectionId===legacy.connectionId))rows.push(legacy);
    const result=[];for(const row of rows){try{result.push(await hydrateConnection(row));}catch(error){if(!(error instanceof FolderHandoffError))throw error;result.push({...row,folderStorageError:error.message});}}return result;
  }
  if(mode==='readonly'){const saved=await settingsOperation('readonly',store=>store.get('current'));return hydrateConnection(saved?.connectionId&&!saved.directory?await settingsOperation('readonly',store=>store.get('folder:'+saved.connectionId)):saved);}
  return value?writeConnection(value):settingsOperation('readwrite',store=>store.clear());
}
export const readFolderSettings=async({existingOnly=false}={})=>{
  if(existingOnly&&!database&&!await databaseMayExist('private-score-desk-folders-v1')&&!database)return undefined;
  return settings('readonly');
};
export const listFolderSettings=()=>settings('list');
export const saveFolderSettings=value=>settings('readwrite',value);
export const saveFolderConnection=value=>writeConnection(value,{activate:false});
