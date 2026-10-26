// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readRecovery,RecoveryConflict,HISTORY_LIMITS} from '../app/folder-recovery.js';
import {json,fileInfo,LIMITS} from '../app/workflow.js';
globalThis.crypto??=webcrypto;
const missing=()=>Object.assign(new Error('Missing'),{name:'NotFoundError'});
class Directory {
  constructor(){this.kind='directory';this.children=new Map();}
  async getDirectoryHandle(name){const child=this.children.get(name);if(!child)throw missing();return child;}
  async getFileHandle(name){const blob=this.children.get(name);if(!blob)throw missing();return {getFile:async()=>blob};}
  async *entries(){for(const [name,entry]of this.children)yield [name,entry instanceof Directory?entry:{kind:'file'}];}
}
function put(dir,path,blob){const [first,...rest]=path.split('/');if(!rest.length){dir.children.set(first,blob);return;}if(!dir.children.has(first))dir.children.set(first,new Directory());put(dir.children.get(first),rest.join('/'),blob);}
const projectId=crypto.randomUUID(),sourceSha256='1'.repeat(64),asset=new Blob(['SYNTHETIC recovery bytes']),assetInfo=await fileInfo(asset);
function manifest(id,parent=null,sequence=1){return {schema:'private-score-desk-recovery',version:1,id,projectId,sourceSha256,parent,sequence,current:sourceSha256,paths:{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'},records:[{id:sourceSha256,snapshotId:sourceSha256,revisionId:crypto.randomUUID(),payloads:{'annotations.json':assetInfo}}]};}
async function commit(dir,value){const blob=json(value);put(dir,`.scorebrush/recovery/g-${value.id}/snapshot.json`,blob);put(dir,`.scorebrush/recovery/g-${value.id}/COMMIT.json`,json({schema:value.schema,version:1,id:value.id,manifestSha256:(await fileInfo(blob)).sha256}));}
function folder(){const dir=new Directory();put(dir,'.scorebrush/OWNER.json',json({schema:'private-score-desk-folder',version:1}));put(dir,'.scorebrush/recovery/objects/'+assetInfo.sha256,asset);return dir;}

test('interrupted unpublished generations cannot displace a complete snapshot',async()=>{const dir=folder(),id=crypto.randomUUID();await commit(dir,manifest(id));put(dir,`.scorebrush/recovery/g-${crypto.randomUUID()}/snapshot.json`,new Blob(['incomplete']));assert.equal((await readRecovery(dir)).manifest.id,id);});
test('corrupt latest manifest falls back without deleting damaged evidence',async()=>{const dir=folder(),one=crypto.randomUUID(),two=crypto.randomUUID();await commit(dir,manifest(one));await commit(dir,manifest(two,one,2));put(dir,`.scorebrush/recovery/g-${two}/snapshot.json`,new Blob(['corrupt']));const recovered=await readRecovery(dir);assert.equal(recovered.manifest.id,one);assert.deepEqual(recovered.damaged,[two]);});
test('missing or corrupt durable assets reject recovery',async()=>{const dir=folder(),id=crypto.randomUUID();await commit(dir,manifest(id));put(dir,'.scorebrush/recovery/objects/'+assetInfo.sha256,new Blob(['wrong']));await assert.rejects(readRecovery(dir),/No complete valid/);});

test('recovery validates persisted titles and rendering ordinals before accepting a hashed generation',async()=>{
  const valid={version:1,initialTranscriptionFilename:'Étude.pdf',basename:'Étude',nameSource:'initial-selection',renderings:[{number:7,...assetInfo}]};
  const dir=folder(),id=crypto.randomUUID(),m={...manifest(id),pdfOutput:valid};await commit(dir,m);assert.deepEqual(JSON.parse(JSON.stringify((await readRecovery(dir)).manifest.pdfOutput)),valid);
  for(const change of [o=>o.basename='../escape',o=>o.nameSource='invented',o=>o.renderings.push({...o.renderings[0],sha256:'f'.repeat(64)}),o=>o.renderings[0].number=0,o=>o.renderings[0].number=5001]){
    const root=folder(),value=structuredClone(m);change(value.pdfOutput);await commit(root,value);await assert.rejects(readRecovery(root),/No complete valid/);
  }
});
test('two independently committed children are a conflict regardless of time or sequence',async()=>{const dir=folder(),id=crypto.randomUUID();await commit(dir,manifest(id));await commit(dir,manifest(crypto.randomUUID(),id,2));await commit(dir,manifest(crypto.randomUUID(),id,999));await assert.rejects(readRecovery(dir),RecoveryConflict);});
test('schema, working paths, asset paths, project ids and limits are checked even with valid outer hashes',async()=>{for(const mutate of [m=>m.version=999,m=>m.paths.ly='../escape.ly',m=>m.paths.source='C:/private.pdf',m=>m.projectId='../escape',m=>m.headTaskId='missing-task',m=>m.handoffs=[{id:'duplicate',kind:'task'},{id:'duplicate',kind:'task'}],m=>m.records[0].history=true,m=>m.records[0].payloads={'../escape':assetInfo},m=>m.records[0].payloads['annotations.json'].size=Number.MAX_SAFE_INTEGER]){const dir=folder(),m=structuredClone(manifest(crypto.randomUUID()));mutate(m);await commit(dir,m);await assert.rejects(readRecovery(dir),/No complete valid/);}});
test('foreign folder ownership and permission loss are never treated as an empty folder',async()=>{const dir=folder();put(dir,'.scorebrush/OWNER.json',json({schema:'another-app',version:1}));await assert.rejects(readRecovery(dir),/not owned/);const denied=Object.assign(new Error('Denied'),{name:'NotAllowedError'});dir.getDirectoryHandle=async()=>{throw denied;};await assert.rejects(readRecovery(dir),e=>e===denied);});

test('earlier cleanup preserves another profile’s published and in-flight assets; quota counts orphans',async()=>{const result=await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./recovery-race-probe.mjs',import.meta.url))],{timeout:30000});assert.match(result.stdout,/PASS overlapping profiles published/);assert.match(result.stdout,/PASS overlapping profiles before-commit/);});

test('older snapshot migration survives saving without edits and another recovery',async()=>{const result=await promisify(execFile)(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./recovery-history-probe.mjs',import.meta.url))],{timeout:30000});assert.match(result.stdout,/PASS older snapshot/);assert.match(result.stdout,/PASS exact unchanged head repair/);assert.match(result.stdout,/PASS current-state and predecessor/);assert.match(result.stdout,/PASS an exact legacy checkpoint/);assert.match(result.stdout,/PASS next decision preserves exact legacy history/);});

// Tiny shared payloads isolate the logical boundary from the unchanged object
// and byte budgets. Outer hashes are valid even for the rejected snapshots.
test('recovery shares the resource budget and accepts every unique record at its boundary',async()=>{
  assert.equal(HISTORY_LIMITS.records,LIMITS.count);assert.equal(HISTORY_LIMITS.handoffs,1000);
  for(const legacyCount of [0,199]){
    const dir=folder(),m=manifest(crypto.randomUUID()),template=m.records[0];
    m.records=Array.from({length:HISTORY_LIMITS.records-legacyCount},(_,i)=>({...template,id:i?`review-event:${crypto.randomUUID()}`:m.current}));
    m.legacyEvidence=Array.from({length:legacyCount},(_,i)=>({id:'legacy-package:'+i.toString(16).padStart(64,'0'),payloads:template.payloads}));
    await commit(dir,m);const recovered=await readRecovery(dir);
    assert.deepEqual(recovered.manifest.records.map(r=>r.id),m.records.map(r=>r.id));
    assert.deepEqual(recovered.manifest.legacyEvidence.map(r=>r.id),m.legacyEvidence.map(r=>r.id));
    const overflow=structuredClone(m);overflow.id=crypto.randomUUID();overflow.parent=m.id;overflow.sequence++;
    if(legacyCount)overflow.legacyEvidence.push({id:'legacy-package:'+'f'.repeat(64),payloads:template.payloads});
    else overflow.records.push({...template,id:'review-event:'+crypto.randomUUID()});
    await commit(dir,overflow);const unchanged=await readRecovery(dir);
    assert.equal(unchanged.manifest.id,m.id);assert.deepEqual(unchanged.damaged,[overflow.id]);
  }
});
test('recovery rejects duplicate record and legacy identities without erasing the prior generation',async()=>{
  for(const duplicate of ['record','legacy','cross-list']){
    const dir=folder(),first=manifest(crypto.randomUUID());await commit(dir,first);
    const m=manifest(crypto.randomUUID(),first.id,2),legacy={id:'legacy-package:'+'a'.repeat(64),payloads:m.records[0].payloads};
    if(duplicate==='record')m.records.push({...m.records[0]});
    if(duplicate==='legacy')m.legacyEvidence=[legacy,legacy];
    if(duplicate==='cross-list'){m.records.push({...m.records[0],id:legacy.id});m.legacyEvidence=[legacy];}
    await commit(dir,m);assert.equal((await readRecovery(dir)).manifest.id,first.id);
  }
});


test('parallel recovery rejects conflicting sizes for a repeated object hash',async()=>{
  for(const order of ['valid-first','invalid-first']){
    const dir=folder(),m=manifest(crypto.randomUUID()),good=m.records[0],bad={...good,id:'different-record',payloads:{'annotations.json':{...assetInfo,size:assetInfo.size+1}}};
    m.records=order==='valid-first'?[good,bad]:[bad,good];await commit(dir,m);await assert.rejects(readRecovery(dir),/No complete valid/);
  }
});
