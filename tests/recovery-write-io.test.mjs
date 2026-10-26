// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {HistoryDirectory,put} from './history-memory.mjs';
import {head,scene,note,inspect} from './portable-history-fixture.mjs';
import {putSaved,workspaceHistory,recoveryIdentity} from '../app/storage.js';
import {identify,newReview} from '../app/model.js';
import {fileInfo,LIMITS} from '../app/workflow.js';
import {saveRecovery,readRecovery,decodeRecovery} from '../app/folder-recovery.js';
globalThis.crypto??=webcrypto;Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,fn)=>fn()}}});installMemoryIndexedDB();
const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'},delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function objects(dir){return(await(await dir.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');}
async function edit(record,text){const review=structuredClone(record.review);review.findings=[note(0,text)];review.nextNumber=2;return putSaved({...record,review,revisionId:crypto.randomUUID()},record.storageRevision);}

test('recovery hashes paths first, writes each unique object once, and bounds active writers',async()=>{
  const shared=new Blob(['%PDF SYNTHETIC shared source/render']),files={source:{name:'source.pdf',blob:shared},rendered:{name:'Etude.pdf',blob:shared},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC notation'])}};
  const identified=await identify(files),review=newReview(identified.identity,identified.snapshotId,await inspect()),record=await putSaved({id:identified.snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[]},null);
  const dir=new HistoryDirectory();let active=0,maximum=0;
  dir.control.beforeClose=async path=>{if(path.includes('/objects/')){maximum=Math.max(maximum,++active);await delay(4);active--;}};
  const saved=await saveRecovery(dir,scene(record),paths),writes=dir.control.writes.filter(path=>path.includes('/objects/'));
  assert(maximum>1&&maximum<=4);assert.equal(active,0);assert.equal(new Set(writes).size,writes.length);
  const common=(await fileInfo(shared)).sha256;assert.equal(writes.filter(path=>path.endsWith('/'+common)).length,1);
  const decoded=await decodeRecovery(saved.snapshot,inspect);assert.equal(recoveryIdentity(decoded.records.find(r=>r.id===record.id)),recoveryIdentity(record));
});

test('recovery reserves the whole package before writing when only two slots remain',async()=>{
  let current=await head('parallel package reservation'),dir=new HistoryDirectory(),first=await saveRecovery(dir,scene(current),paths),store=await objects(dir);
  for(let n=store.children.size;n<LIMITS.count-2;n++)await put(dir,'.scorebrush/recovery/objects/'+n.toString(16).padStart(64,'0'),new Blob(['SYNTHETIC orphan '+n]));
  current=await edit(current,'SYNTHETIC capacity edit requiring several new objects');const before=[...store.children.keys()].sort(),writes=dir.control.writes.length;
  await assert.rejects(saveRecovery(dir,scene(current),paths,{expected:first.id}),e=>e.name==='HistoryCapacityError');
  assert.deepEqual([...store.children.keys()].sort(),before);assert.equal(dir.control.writes.length,writes,'no payload or metadata writer starts before full package admission');
  assert.equal((await readRecovery(dir)).manifest.id,first.id);
});

for(const action of ['failure','cancellation'])test('recovery drains in-flight writes on '+action+' and retries without rewriting valid objects',async()=>{
  const current=await head('parallel writer '+action),dir=new HistoryDirectory();let started=0,active=0,settled=false,isCurrent=true,release,entered;
  const gate=new Promise(resolve=>release=resolve),allStarted=new Promise(resolve=>entered=resolve);
  dir.control.beforeClose=async path=>{if(!path.includes('/objects/'))return;const index=++started;active++;if(index===4)entered();try{if(index===1){await delay(5);if(action==='failure')throw Error('SYNTHETIC write failure');isCurrent=false;}else await gate;}finally{active--;}};
  const pending=saveRecovery(dir,scene(current),paths,{isCurrent:()=>isCurrent});pending.then(()=>settled=true,()=>settled=true);
  await allStarted;await delay(15);assert.equal(active,3);assert.equal(settled,false);release();await assert.rejects(pending,action==='failure'?/SYNTHETIC write failure/:/superseded/);
  assert.equal(active,0);assert.equal(started,4);assert.equal(await readRecovery(dir),null);const stopped=started;await delay(15);assert.equal(started,stopped);
  const store=await objects(dir),valid=new Set();for(const [name,entry]of store.children)if(entry.blob.size&&(await fileInfo(entry.blob)).sha256===name)valid.add(name);
  const beforeWrites=dir.control.writes.length;dir.control.beforeClose=null;isCurrent=true;
  const saved=await saveRecovery(dir,scene(current),paths),newWrites=dir.control.writes.slice(beforeWrites).filter(path=>path.includes('/objects/'));
  assert(newWrites.every(path=>!valid.has(path.split('/').at(-1))),'byte-valid orphan objects from the interrupted attempt are reused');
  const decoded=await decodeRecovery(saved.snapshot,inspect),expected=[current,...await workspaceHistory(current.id)];
  assert.deepEqual(decoded.records.map(r=>({id:r.id,identity:recoveryIdentity(r)})).sort((a,b)=>a.id.localeCompare(b.id)),expected.map(r=>({id:r.id,identity:recoveryIdentity(r)})).sort((a,b)=>a.id.localeCompare(b.id)));
});
