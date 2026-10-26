// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Exercise real recovery save/decode with synthetic file handles. Payload
// construction is stubbed; checkpoint identity and migration checks are real.
import assert from 'node:assert/strict';
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import * as projectDirectory from '../app/project-directory.js';
import * as pdfNames from '../app/pdf-output-names.js';
globalThis.crypto??=webcrypto;
const source=await readFile(new URL('../app/folder-recovery.js',import.meta.url),'utf8');
const json=x=>new Blob([JSON.stringify(x)]),canonical=JSON.stringify;
const sha256=async bytes=>Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
const fileInfo=async b=>({size:b.size,sha256:await sha256(await b.arrayBuffer())});
const identity=r=>canonical({review:r.review,returned:r.returned??null,revisionId:r.revisionId,completions:r.completions??[]});
const missing=()=>new DOMException('missing','NotFoundError');
class Dir {
 constructor(name=''){this.name=name;this.kind='directory';this.children=new Map();}
 async getDirectoryHandle(name,{create=false}={}){if(!this.children.has(name)&&create)this.children.set(name,new Dir(name));const v=this.children.get(name);if(!v)throw missing();return v;}
 async getFileHandle(name,{create=false}={}){if(!this.children.has(name)&&create)this.children.set(name,new Blob());if(!this.children.has(name))throw missing();return {getFile:async()=>this.children.get(name),createWritable:async()=>{let pending;return {write:async b=>pending=b,close:async()=>this.children.set(name,pending),abort:async()=>{}};}};}
 async *entries(){for(const[name,v]of this.children)yield[name,v instanceof Dir?v:{kind:'file'}];}
 async removeEntry(name){this.children.delete(name);}
}
let local=[],history=[],packageBuilds=0;
const ctx=createContext({Blob,Map,Set,Error,Date,JSON,Object,Number,String,Array,Promise,TextEncoder,structuredClone,crypto:webcrypto,navigator:{locks:{request:async(_key,cb)=>cb()}}});
const bindings={
 './model.js':{sha256,blobHash:blob=>blob.arrayBuffer().then(sha256)},
    './project-directory.js':projectDirectory,
 './pdf-output-names.js':pdfNames,
 './pdf-versions.js':{preparePdfOutput:async()=>({version:1,initialTranscriptionFilename:null,basename:pdfNames.UNKNOWN_TITLE,nameSource:'unknown',renderings:[]})},
 './workflow.js':{json,strictJSON:JSON.parse,fileInfo,readPackagePayloads:async p=>({review:JSON.parse(await p.get('annotations.json').text()),files:{},completionBundle:JSON.parse(await p.get('completion-history.json').text()),payloads:p}),hydrateTaskPayloads:null,readResponsePayloads:null,responseRevision:null,LIMITS:{json:25e6,file:100e6,total:512e6,count:5000}},
 './export.js':{makeRecovery:async review=>{packageBuilds++;return new Map([['annotations.json',json(review)],['manifest.json',json({schema:'score-desk-package',version:1,build:packageBuilds})]]);},zipFiles:null},
 './returned.js':{makeReturnedBackup:async(_review,_files,returned,p)=>{p.set('returned-workspace.json',json({returned}));return p;},restoreReturnedBackup:async p=>p.payloads.has('returned-workspace.json')?{issued:{id:'task1',task:{}},entry:{id:'response1',response:{}}}:null},
 './completion.js':{addCompletionHistory:async(p,review,_round,revisionId,records)=>{p.set('completion-history.json',json({revisionId,records,stateSha256:canonical(review)}));return p;}},
 './storage.js':{getSaved:async id=>local.find(r=>r.id===id),savedRecords:async()=>local,workspaceHistories:async ids=>new Map(ids.map(id=>[id,history.filter(row=>row.workspaceId===id)])),recoveryIdentity:identity,restoreMissing:null,checkLegacyImport:null},
 './handoff-store.js':{retained:async()=>({task:{parent:{workspaceId:'not-present'}}}),retainedList:async()=>[],retain:null},
 './completion-model.js':{canonical,stateHash:async review=>canonical(review)}
};
const mod=new SourceTextModule(source,{context:ctx});await mod.link(spec=>{const values=bindings[spec];return new SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});});await mod.evaluate();const api=mod.namespace;
const sourceHash='a'.repeat(64),snapshotId='1'.repeat(64),workspaceId='returned:legacy1',eventId='returned-event:'+webcrypto.randomUUID();
const round={id:workspaceId,taskId:'task1',reported:[{id:'finding1',decision:{state:'resolved'}}]};
const snapshot={manifest:{sourceSha256:sourceHash,current:workspaceId,records:[]},objects:new Map()};
for(const event of [false,true]){
 const p=new Map([['annotations.json',json({snapshotId,files:{source:{sha256:sourceHash}},text:event?'old note':'edited note after decision'})],['returned-workspace.json',json({returned:round})],['completion-history.json',json({revisionId:event?'old-revision':'head-revision',records:[]})]]),payloads={};
 for(const[path,blob]of p){const info=await fileInfo(blob);payloads[path]=info;snapshot.objects.set(info.sha256,blob);}
 snapshot.manifest.records.push({id:event?eventId:workspaceId,snapshotId,revisionId:event?'old-revision':'head-revision',payloads,...(event?{history:true,workspaceId,storageRevision:20,createdAt:'2026-10-22T00:00:00Z',parentHistoryId:null}:{})});
}
const decoded=await api.decodeRecovery(snapshot,()=>{});local=decoded.records.filter(r=>!r.kind);history=decoded.records.filter(r=>r.kind);const head=local[0];
assert.equal(head.historyId,null);
assert.equal(head.historyPredecessorId,eventId);
assert.equal(head.storageRevision,20);
const originalHead=identity(head),originalEvent=canonical(history[0]);
const root=new Dir(),owned=await root.getDirectoryHandle('.scorebrush',{create:true});owned.children.set('OWNER.json',json({schema:'private-score-desk-folder',version:1}));
const saved=await api.saveRecovery(root,{workspaceId,...head},{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'});
const secondSnapshot=await api.readRecovery(root),second=await api.decodeRecovery(secondSnapshot,()=>{}),secondHead=second.records.find(r=>!r.kind),secondEvent=second.records.find(r=>r.kind);
assert.equal(secondSnapshot.manifest.id,saved.id);
assert.equal(identity(secondHead),originalHead);
assert.equal(canonical(secondEvent),originalEvent);
assert.equal(secondHead.historyId,null);
assert.equal(secondHead.historyPredecessorId,eventId);
assert.equal(secondHead.storageRevision,20);
console.log('PASS older snapshot with edits after its checkpoint survives save without editing and fresh recovery');

const buildsBeforeRepair=packageBuilds;
const repaired=await api.saveRecovery(root,{workspaceId,...head},{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'},{expected:saved.id});
assert.equal(packageBuilds,buildsBeforeRepair,'unchanged recovery repair must reuse committed packages');
assert.equal(canonical(repaired.snapshot.manifest.records.find(r=>r.id===workspaceId).payloads),canonical(secondSnapshot.manifest.records.find(r=>r.id===workspaceId).payloads));
console.log('PASS exact unchanged head repair reuses all committed payload identities without re-export');

// A present current-state checkpoint must still match exactly; migration must
// not make a malformed modern cursor acceptable.
const bad={...secondSnapshot,manifest:structuredClone(secondSnapshot.manifest)},badHead=bad.manifest.records.find(r=>!r.history);
badHead.historyId=eventId;delete badHead.historyPredecessorId;
await assert.rejects(api.decodeRecovery(bad,()=>{}),/predecessor differs/);
badHead.historyId=null;badHead.historyPredecessorId='returned-event:'+webcrypto.randomUUID();
await assert.rejects(api.decodeRecovery(bad,()=>{}),/predecessor is missing/);
console.log('PASS current-state and predecessor associations remain validated');

// With an exact matching legacy checkpoint the current cursor can be retained
// directly, rather than adding a synthetic event or changing its original ID.
const matching={...snapshot,manifest:structuredClone(snapshot.manifest)};
matching.manifest.records[0].payloads=matching.manifest.records[1].payloads;
matching.manifest.records[0].revisionId=matching.manifest.records[1].revisionId;
const matched=(await api.decodeRecovery(matching,()=>{})).records.find(r=>!r.kind);
assert.equal(matched.historyId,eventId);
assert.equal(matched.historyPredecessorId,undefined);
assert.equal(matched.storageRevision,20);
console.log('PASS an exact legacy checkpoint keeps its original current history ID');

// Execute real storage restore/CAS/history code on a disposable asynchronous
// in-memory IndexedDB facade; no application or browser database is accessed.
const rows=new Map(),readKeys=[];
const database={objectStoreNames:{contains:()=>true},close(){},transaction(){
 const tx={abort(){this.aborted=true;queueMicrotask(()=>this.onabort?.());}};let pending=0;
 const request=operation=>{const req={};pending++;queueMicrotask(()=>{if(tx.aborted)return;try{req.result=structuredClone(operation());req.onsuccess?.();}catch(error){tx.error=error;tx.abort();}finally{pending--;queueMicrotask(()=>{if(!pending&&!tx.aborted)tx.oncomplete?.();});}});return req;};
 const openKeyCursor=()=>{const req={},keys=[...rows.keys()].sort();let index=0;const next=()=>{pending++;queueMicrotask(()=>{if(tx.aborted)return;req.result=index<keys.length?{primaryKey:keys[index++],continue:next}:null;req.onsuccess?.();pending--;queueMicrotask(()=>{if(!pending&&!tx.aborted)tx.oncomplete?.();});});};next();return req;};
 tx.objectStore=()=>({openKeyCursor,get:key=>request(()=>{readKeys.push(key);return rows.get(key);}),getAll:()=>request(()=>[...rows.values()]),add:value=>request(()=>{if(rows.has(value.id))throw new Error('Duplicate ID');rows.set(value.id,structuredClone(value));return value.id;}),put:value=>request(()=>{rows.set(value.id,structuredClone(value));return value.id;})});return tx;
}};
ctx.indexedDB={open(){const req={result:database};queueMicrotask(()=>req.onsuccess?.());return req;}};
const storage=new SourceTextModule(await readFile(new URL('../app/storage.js',import.meta.url),'utf8'),{context:ctx});
// Input packaging is intentionally stubbed in this history-only VM. Real
// input-byte/reference integrity is covered by storage-inputs.test.mjs.
const databasePresence=new SourceTextModule(await readFile(new URL('../app/database-presence.js',import.meta.url),'utf8'),{context:ctx});
await databasePresence.link(spec=>{throw new Error(`Unexpected database discovery import: ${spec}`);});
await storage.link(spec=>{
 if(spec==='./database-presence.js')return databasePresence;
 if(spec==='./model.js')return new SyntheticModule(['sha256','roles'],function(){this.setExport('sha256',sha256);this.setExport('roles',[]);},{context:ctx});
 if(spec==='./workflow.js')return new SyntheticModule(['fileInfo','strictJSON'],function(){this.setExport('fileInfo',fileInfo);this.setExport('strictJSON',JSON.parse);},{context:ctx});
 if(spec==='./completion-model.js')return new SyntheticModule(['canonical','mergeCompletions'],function(){this.setExport('canonical',canonical);this.setExport('mergeCompletions',(prior=[],next=[])=>[...prior,...next]);},{context:ctx});
 throw new Error(`Unexpected storage import: ${spec}`);
});await storage.evaluate();
await storage.namespace.restoreMissing(second.records);
const restoredHead=await storage.namespace.getSaved(workspaceId),next={...restoredHead,revisionId:'new-genuine-decision',review:{...restoredHead.review,text:'new note after recovery'},returned:{...restoredHead.returned,reported:[{id:'finding1',decision:{state:'needs_source_clarification'}}]}};
const retainedBeforeEdit=await storage.namespace.returnedHistory(workspaceId);
const changed=await storage.namespace.putSaved(next,restoredHead.storageRevision),events=await storage.namespace.returnedHistory(workspaceId);
assert.equal(changed.storageRevision,21);
// Ordinary decisions update the durable head; only a completed review that
// produces a new rendering creates a new immutable version-history event.
assert.equal(changed.historyId,null);
assert.equal(changed.historyPredecessorId,restoredHead.historyId??restoredHead.historyPredecessorId);
assert.equal(canonical(events),canonical(retainedBeforeEdit));
const retainedEvent=events.find(e=>e.id===eventId);assert(retainedEvent);
assert.equal(canonical(retainedEvent),originalEvent);
assert.equal(changed.historyPredecessorId,eventId);
assert.deepEqual(Array.from(events,e=>e.storageRevision),[20]);
readKeys.length=0;local=await storage.namespace.savedRecords();history=events;
assert(!readKeys.some(key=>key.startsWith('returned-event:')||key.startsWith('completion:')),'listing current reviews never loads immutable history records');
await api.saveRecovery(root,{workspaceId,...changed},{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'},{expected:repaired.id});
const latest=await api.decodeRecovery(await api.readRecovery(root),()=>{}),latestHead=latest.records.find(r=>!r.kind),latestEvent=latest.records.find(r=>r.id===changed.historyPredecessorId);
assert.equal(identity(latestHead),identity(changed));
assert.equal(latestHead.historyId,changed.historyId);
assert.equal(latestHead.historyPredecessorId,eventId);
assert.equal(canonical(latestEvent),originalEvent);
assert.equal(canonical(latest.records.filter(r=>r.kind)),canonical(retainedBeforeEdit));
console.log('PASS next decision preserves exact legacy history and its predecessor through another recovery');
