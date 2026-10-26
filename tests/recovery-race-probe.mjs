// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Separate VM modules model separate profiles: no shared Web Lock or IndexedDB.
// Package construction is stubbed; real recovery writes/validation/pruning run.
import {SourceTextModule,SyntheticModule,createContext} from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import assert from 'node:assert/strict';
import * as projectDirectory from '../app/project-directory.js';
import * as pdfNames from '../app/pdf-output-names.js';
import {LIMITS} from '../app/workflow.js';
globalThis.crypto??=webcrypto;
const source=await readFile(new URL('../app/folder-recovery.js',import.meta.url),'utf8');
const json=x=>new Blob([JSON.stringify(x)]),canonical=JSON.stringify;
const sha256=async bytes=>Buffer.from(await webcrypto.subtle.digest('SHA-256',bytes)).toString('hex');
const fileInfo=async b=>({size:b.size,sha256:await sha256(await b.arrayBuffer())});
const missing=()=>new DOMException('missing','NotFoundError');
class Dir {
  constructor(name='',hooks={}){this.name=name;this.kind='directory';this.children=new Map();this.hooks=hooks;}
  async getDirectoryHandle(name,{create=false}={}){if(!this.children.has(name)&&create)this.children.set(name,new Dir(name,this.hooks));const v=this.children.get(name);if(!v)throw missing();return v;}
  async getFileHandle(name,{create=false}={}){if(!this.children.has(name)&&create)this.children.set(name,new Blob());if(!this.children.has(name))throw missing();return {getFile:async()=>this.children.get(name),createWritable:async()=>{let pending;return {write:async b=>{await this.hooks.write?.(name,b);pending=b;},close:async()=>{this.children.set(name,pending);},abort:async()=>{}};}};}
  async *entries(){for(const [name,v]of this.children)yield[name,v instanceof Dir?v:{kind:'file'}];}
  async removeEntry(name){await this.hooks.remove?.(this.name,name);this.children.delete(name);}
}
const scene=text=>({workspaceId:'1'.repeat(64),revisionId:'revision-'+text,review:{snapshotId:'1'.repeat(64),files:{source:{sha256:'a'.repeat(64)}},text},files:{},completions:[]});
async function profile(s,entries=[]){
  const record={...s,id:s.workspaceId},ctx=createContext({Blob,Map,Set,Error,Date,JSON,Object,Number,String,Array,Promise,crypto:webcrypto,navigator:{locks:{request:async(_key,cb)=>cb()}}});
  const bindings={
    './model.js':{sha256,blobHash:blob=>blob.arrayBuffer().then(sha256)},
    './project-directory.js':projectDirectory,
    './pdf-output-names.js':pdfNames,
    './pdf-versions.js':{preparePdfOutput:async()=>({version:1,initialTranscriptionFilename:null,basename:pdfNames.UNKNOWN_TITLE,nameSource:'unknown',renderings:[]})},
    './workflow.js':{json,strictJSON:JSON.parse,fileInfo,readPackagePayloads:null,hydrateTaskPayloads:null,readResponsePayloads:null,responseRevision:null,LIMITS},
    './export.js':{makeRecovery:async review=>new Map([['annotations.json',json(review)],['manifest.json',json({schema:'score-desk-package',version:1,createdAt:new Date().toISOString()})]]),zipFiles:null},
    './returned.js':{makeReturnedBackup:null,restoreReturnedBackup:null},
    './completion.js':{addCompletionHistory:async(p,review,_round,revisionId,records)=>{p.set('completion-history.json',json({revisionId,records,stateSha256:canonical(review)}));return p;}},
    './storage.js':{getSaved:async()=>record,savedRecords:async()=>[record],workspaceHistories:async()=>new Map(),recoveryIdentity:r=>canonical({review:r.review,returned:r.returned??null,revisionId:r.revisionId,completions:r.completions??[]}),restoreMissing:null,checkLegacyImport:null},
    './handoff-store.js':{retained:async()=>null,retainedList:async()=>entries,retain:null},
    './completion-model.js':{canonical,stateHash:async review=>canonical(review)}
  };
  const mod=new SourceTextModule(source,{context:ctx});await mod.link(spec=>{const values=bindings[spec];return new SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});});await mod.evaluate();return mod.namespace;
}
const paths={source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'};
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
for(const phase of ['published','before-commit']){
  const hooks={},root=new Dir('',hooks),owned=await root.getDirectoryHandle('.scorebrush',{create:true});owned.children.set('OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  let expected=null;
  for(let n=0;n<3;n++){const s=scene('seed'+n),p=await profile(s);expected=(await p.saveRecovery(root,s,paths,{expected})).id;}
  const a=scene('A'),b=scene('B'),A=await profile(a),B=await profile(b),entered=gate(),resume=gate();let once=true;
  hooks.remove=async name=>{if(name==='recovery'&&once){once=false;entered.release();await resume.promise;}};
  const saveA=A.saveRecovery(root,a,paths,{expected});await entered.promise;
  const headA=(await A.readRecovery(root)).manifest.id;
  let resultB;
  if(phase==='published'){
    resultB=await B.saveRecovery(root,b,paths,{expected:headA});resume.release();await saveA;
  }else{
    const publishing=gate(),finish=gate();hooks.write=async name=>{if(name==='COMMIT.json'){publishing.release();await finish.promise;}};
    const saveB=B.saveRecovery(root,b,paths,{expected:headA});await publishing.promise;
    resume.release();await saveA;finish.release();resultB=await saveB;
  }
  const after=await A.readRecovery(root);assert.equal(after.manifest.id,resultB.id,phase);assert.equal(after.damaged.length,0,phase);
  assert.equal(JSON.parse(await after.objects.get(after.manifest.records[0].payloads['annotations.json'].sha256).text()).text,'B');
  // Unreferenced objects are deliberately retained; quota includes them.
  const objects=await(await owned.getDirectoryHandle('recovery')).getDirectoryHandle('objects');
  objects.children.set('f'.repeat(64),{size:LIMITS.total});
  await assert.rejects(B.saveRecovery(root,b,paths,{expected:resultB.id}),/storage exceeds/);
  console.log('PASS overlapping profiles '+phase+'; newest assets intact; orphan quota enforced');
}

for(const limit of ['handoffs','objects']){
  const root=new Dir(),s=scene('capacity'),api=await profile(s),first=await api.saveRecovery(root,s,paths);
  const owned=await root.getDirectoryHandle('.scorebrush'),objects=await(await owned.getDirectoryHandle('recovery')).getDirectoryHandle('objects');
  let attempt=api;
  if(limit==='handoffs'){
    const entries=Array.from({length:1001},(_,n)=>({id:'synthetic-task-'+n,kind:'task',task:{shared:false},review:s.review,payloads:new Map()}));
    attempt=await profile(s,entries);
  }else for(let n=1;n<=5001;n++)objects.children.set(n.toString(16).padStart(64,'0'),new Blob());
  const count=objects.children.size;
  await assert.rejects(attempt.saveRecovery(root,s,paths,{expected:first.id}),e=>e.name==='HistoryCapacityError'&&e.message.includes('No older history was discarded'));
  assert.equal((await api.readRecovery(root)).manifest.id,first.id);assert.equal(objects.children.size,count);
  console.log('PASS '+limit+' capacity refuses publication without rewriting the prior commit or dropping evidence');
}
