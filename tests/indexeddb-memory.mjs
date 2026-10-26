// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Disposable Node-only IndexedDB facade. Browser regressions exercise real IDB.
// Stage every write until completion so abort tests cannot pass on partial data.
export function installMemoryIndexedDB(){
  const databases=new Map();
  globalThis.indexedDB={open(name){
    if(!databases.has(name))databases.set(name,new Map());
    const database={objectStoreNames:{contains:()=>true},close(){},transaction(_name,mode){
      const rows=databases.get(name),staged=new Map(rows);let pending=0,finished=false;
      const tx={abort(){this.aborted=true;queueMicrotask(()=>this.onabort?.());}};
      const complete=()=>queueMicrotask(()=>{if(!pending&&!finished&&!tx.aborted){finished=true;if(mode==='readwrite')databases.set(name,staged);tx.oncomplete?.();}});
      const request=operation=>{const req={};pending++;queueMicrotask(()=>{if(tx.aborted)return;try{req.result=structuredClone(operation());req.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;complete();}});return req;};
      const openKeyCursor=()=>{const req={},keys=[...staged.keys()].sort();let index=0;const next=()=>{pending++;queueMicrotask(()=>{if(tx.aborted)return;req.result=index<keys.length?{primaryKey:keys[index++],continue:next}:null;req.onsuccess?.();pending--;complete();});};next();return req;};
      tx.objectStore=()=>({openKeyCursor,getKey:key=>request(()=>staged.has(key)?key:undefined),get:key=>request(()=>staged.get(key)),getAll:()=>request(()=>[...staged.values()]),add:value=>request(()=>{if(staged.has(value.id))throw Error('Duplicate ID');staged.set(value.id,structuredClone(value));return value.id;}),put:value=>request(()=>{staged.set(value.id,structuredClone(value));return value.id;})});return tx;
    }};const req={result:database};queueMicrotask(()=>req.onsuccess?.());return req;
  }};
  return databases;
}

