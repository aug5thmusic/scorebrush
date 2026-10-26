// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Mutable current work is not research history. Only version-boundary archive
// operations retain historical records; this file replaces one small checkpoint.
import {sha256,blobHash,validateReview,STATES} from './model.js';
import {canonical,prepareCompletionState,COMPLETION_EXTENSION,validateCompletionBundle} from './completion-model.js';
import {validateLocations} from './comparison-model.js';
import {readDataDirectory,DATA_DIRECTORY} from './project-directory.js';
import {readRecoveryMetadata,RecoveryConflict} from './folder-recovery.js';
import {strictJSON,json,fileInfo,seal,LIMITS} from './workflow.js';
const SCHEMA='scorebrush-current-review',FILE='current-review.json',LOCK='current-review.lock';
const UUID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/;
const same=(a,b)=>canonical(a)===canonical(b);
const fail=message=>{throw new Error('Current review: '+message);};
const fresh=valid=>{if(!valid())fail('saving was superseded by a newer edit.');};
const rolePaths={source:'source-original.pdf',rendered:'rendered-original.pdf',ly:'lilypond/supplied.ly'};
const omit=(object,keys)=>Object.fromEntries(Object.entries(object).filter(([key])=>!keys.includes(key)));
// Cache only the immutable declared archive, never a fresh historical-byte
// audit. Every operation rechecks its small complete COMMIT set. A new writer
// or changed commitment forces metadata validation again; reopening has no cache.
const anchors=new WeakMap();
async function commitments(directory){
  const data=await owned(directory),root=await data.getDirectoryHandle('recovery'),values=[];
  for await(const [name,entry]of root.entries()){
    if(entry.kind!=='directory'||!/^g-[a-f0-9-]{36}$/.test(name))continue;
    const marker=await optional(entry,'COMMIT.json');if(marker?.size>100000)fail('archive commitment metadata is too large.');
    values.push([name,marker?.size?await marker.text():null]);if(values.length>128)fail('too many archive generations.');
  }
  values.sort(([a],[b])=>a.localeCompare(b));return canonical(values);
}
async function archiveFor(directory,onProgress=()=>{}){
  const before=await commitments(directory),cached=anchors.get(directory);
  if(cached?.commitments===before)return cached.snapshot;
  const snapshot=await readRecoveryMetadata(directory,{onProgress});
  if(!snapshot||before!==await commitments(directory))throw new RecoveryConflict();
  anchors.set(directory,{snapshot,commitments:before});return snapshot;
}
async function archiveCurrent(directory,snapshot){const current=await archiveFor(directory);return current.manifest.id===snapshot.manifest.id&&current.manifestSha256===snapshot.manifestSha256;}

async function optional(dir,name){try{return await(await dir.getFileHandle(name)).getFile();}catch(error){if(error.name==='NotFoundError')return null;throw error;}}
async function parse(blob){if(!blob||blob.size>LIMITS.json)fail('checkpoint metadata is missing or too large.');return strictJSON(await blob.text());}
async function owned(directory){const value=await readDataDirectory(directory);if(value?.name!==DATA_DIRECTORY)fail('the project data directory is unavailable.');return value.directory;}
function shape(value){
  if(!value||value.schema!==SCHEMA||value.version!==1||typeof value.id!=='string'||!HASH.test(value.id)||typeof value.baseRecoveryId!=='string'||!UUID.test(value.baseRecoveryId)||typeof value.baseManifestSha256!=='string'||!HASH.test(value.baseManifestSha256)||typeof value.projectId!=='string'||!UUID.test(value.projectId)||typeof value.workspaceId!=='string'||value.workspaceId.length>200||typeof value.revisionId!=='string'||!value.revisionId.length||value.revisionId.length>200||!Number.isSafeInteger(value.storageRevision)||value.storageRevision<1||typeof value.stateSha256!=='string'||!HASH.test(value.stateSha256)||!value.review||!Array.isArray(value.completions)||value.retired!==undefined&&typeof value.retired!=='boolean')fail('checkpoint identity is invalid.');
  return value;
}
async function checkpointId(value){return sha256(new TextEncoder().encode(canonical(omit(value,['id','retired','archivedBy']))));}
async function storedText(data){const blob=await optional(data,FILE);if(!blob?.size)return null;if(blob.size>LIMITS.json)fail('checkpoint metadata is missing or too large.');return blob.text();}
async function stored(data){const text=await storedText(data);if(text===null)return {value:null,text:null};const value=shape(strictJSON(text));if(await checkpointId(value)!==value.id)fail('checkpoint content does not match its identity.');return {value,text};}
async function object(data,info){
  if(!info||typeof info.sha256!=='string'||!HASH.test(info.sha256)||!Number.isSafeInteger(info.size)||info.size<0||info.size>LIMITS.file)fail('a current input declaration is invalid.');
  const objects=await(await data.getDirectoryHandle('recovery')).getDirectoryHandle('objects'),blob=await optional(objects,info.sha256);
  if(!blob||blob.size!==info.size)fail('a current input or state file is missing or changed.');
  const result=new Blob([await blob.arrayBuffer()]);if(await blobHash(result)!==info.sha256)fail('a current input or state file is missing or changed.');return result;
}
async function load(data,snapshot,info){return snapshot.objects?.get(info?.sha256)??await object(data,info);}
async function completion(checkpoint){const value={schema:COMPLETION_EXTENSION.schema,version:1,revisionId:checkpoint.revisionId,stateSha256:checkpoint.stateSha256,records:checkpoint.completions};await validateCompletionBundle(value,checkpoint.review,checkpoint.returned??null);return value;}
function roundMatches(round,baseline,review){
  if(!round||!baseline){if(round!==baseline)fail('returned-review identity differs from its saved score version.');return;}
  if(!Array.isArray(round.reported)||round.reported.length!==baseline.reported?.length||!same(omit(round,['reported','locations']),omit(baseline,['reported','locations'])))fail('returned-review identity differs from its saved score version.');
  const fields=['state','explanation','draftKind','decision','associationId'];
  for(let i=0;i<round.reported.length;i++){
    const finding=round.reported[i],original=baseline.reported[i];
    if(!finding||!same(omit(finding,fields),omit(original,fields))||!STATES.includes(finding.state)||typeof finding.explanation!=='string'||finding.explanation.length>4000||finding.draftKind!==undefined&&!['needs_correction','needs_clarification'].includes(finding.draftKind)||finding.associationId!=null&&typeof finding.associationId!=='string')fail('a returned-review finding is invalid.');
    const decision=finding.decision;
    if(finding.state==='resolved'&&!decision||decision&&(decision.state!==finding.state||decision.reviewed?.snapshotId!==round.contentSnapshotId||decision.reviewed?.codeSha256!==round.codeSha256||decision.reviewed?.renderSha256!==round.renderSha256))fail('a decision does not belong to this rendering.');
  }
  if(round.locations!==undefined)validateLocations(round.locations,round,review);
}
async function baseState(directory,archive,onProgress=()=>{}){
  const data=await owned(directory),snapshot=archive??await archiveFor(directory,onProgress);if(!snapshot)fail('save the score version before saving its current review.');
  const bundle=snapshot.manifest.records.find(item=>item.id===snapshot.manifest.current);if(!bundle)fail('the saved current score version is missing.');
  const annotations=await object(data,bundle.payloads['annotations.json']),review=await parse(annotations),sidecar=bundle.payloads['returned-workspace.json']?await object(data,bundle.payloads['returned-workspace.json']):null;
  const baseline=sidecar?await parse(sidecar):null,objects=new Map(),files={};
  const results=await Promise.allSettled(Object.entries(rolePaths).map(async([role,path])=>{
    const info=bundle.payloads[path],blob=await object(data,info);if(info.sha256!==review.files?.[role]?.sha256||info.size!==review.files[role].size)fail('current score inputs differ from their archived version.');objects.set(info.sha256,blob);files[role]={name:review.files[role].name,blob};
  }));const rejected=results.find(item=>item.status==='rejected');if(rejected)throw rejected.reason;
  return {data,archive:snapshot,bundle,review,baseline,objects,files};
}
function validateState(checkpoint,base){
  shape(checkpoint);const {archive,bundle,review,baseline}=base;
  if(checkpoint.baseRecoveryId!==archive.manifest.id||checkpoint.baseManifestSha256!==archive.manifestSha256||checkpoint.projectId!==archive.manifest.projectId||checkpoint.workspaceId!==bundle.id||checkpoint.review.snapshotId!==bundle.snapshotId||checkpoint.recordProjectId!==(bundle.projectId??archive.manifest.projectId))throw new RecoveryConflict();
  validateReview(checkpoint.review,review);if(!same(checkpoint.review.files,review.files))fail('input names or identities changed.');
  roundMatches(checkpoint.returned??null,baseline?.returned??null,checkpoint.review);
}
async function currentSnapshot(base,checkpoint,completionBundle){
  const objects=new Map(base.objects),payloads={...Object.fromEntries(Object.entries(rolePaths).map(([,path])=>[path,base.bundle.payloads[path]]))};
  const values={'annotations.json':json(checkpoint.review),'completion-history.json':json(completionBundle)};
  if(checkpoint.returned)values['returned-workspace.json']=json({returned:checkpoint.returned});
  for(const [path,blob]of Object.entries(values)){const info=await fileInfo(blob);payloads[path]=info;objects.set(info.sha256,blob);}
  const record={...base.bundle,id:checkpoint.workspaceId,revisionId:checkpoint.revisionId,snapshotId:checkpoint.review.snapshotId,storageRevision:checkpoint.storageRevision,payloads};delete record.historyId;delete record.historyPredecessorId;
  return {manifest:{...base.archive.manifest,records:[record],handoffs:[],legacyEvidence:[],headTaskId:null},objects,currentCheckpoint:true,fullHistoryAudited:false};
}
async function covered(data,archive,checkpoint){
  if(archive.manifest.projectId!==checkpoint.projectId)return false;
  for(const bundle of archive.manifest.records.filter(item=>(item.id===checkpoint.workspaceId||item.workspaceId===checkpoint.workspaceId)&&item.revisionId===checkpoint.revisionId&&item.snapshotId===checkpoint.review.snapshotId)){
    const review=await parse(await load(data,archive,bundle.payloads['annotations.json'])),metadata=await parse(await load(data,archive,bundle.payloads['completion-history.json']));
    const round=bundle.payloads['returned-workspace.json']?(await parse(await load(data,archive,bundle.payloads['returned-workspace.json']))).returned:null;
    if(same(review,checkpoint.review)&&same(round,checkpoint.returned??null)&&same(metadata.records,checkpoint.completions)&&metadata.stateSha256===checkpoint.stateSha256)return true;
  }return false;
}
export async function readCurrentCheckpoint(directory,{snapshot=null,onProgress=()=>{}}={}){
  const data=await owned(directory),saved=await stored(data);if(!saved.value)return null;
  const checkpoint=saved.value,archive=snapshot??await archiveFor(directory,onProgress);if(!archive)throw new RecoveryConflict();
  if(checkpoint.retired||checkpoint.baseRecoveryId!==archive.manifest.id){if(await covered(data,archive,checkpoint))return null;throw new RecoveryConflict();}
  const base=await baseState(directory,archive,onProgress);validateState(checkpoint,base);
  // This is a fresh disk value: compute and verify its state digest here.
  // Reuse only this operation's validated bundle when assembling its snapshot.
  const completionBundle=await completion(checkpoint);
  if(!await archiveCurrent(directory,archive)||await storedText(data)!==saved.text)throw new RecoveryConflict();
  return {id:checkpoint.id,baseRecoveryId:checkpoint.baseRecoveryId,stateSha256:checkpoint.stateSha256,checkpoint,snapshot:await currentSnapshot(base,checkpoint,completionBundle),files:base.files};
}
export async function verifyCurrentCheckpoint(directory,scene,record,config,{isCurrent=()=>true,onProgress=()=>{}}={}){
  if(!isCurrent()||!record||record.id!==scene.workspaceId||record.revisionId!==scene.revisionId||record.storageRevision!==scene.persistedRevision)return null;
  // The read-only shortcut cannot resume an unmigrated legacy directory.
  // Let the normal connection path finish its verified migration first.
  const data=await readDataDirectory(directory);if(!data||data.name!==DATA_DIRECTORY)return null;
  const result=await readCurrentCheckpoint(directory,{onProgress});if(!result||!isCurrent())return null;const checkpoint=result.checkpoint;
  // A committed or durably prepared checkpoint may trail newer local edits.
  // Preparation is persisted before replacing the file, covering an exit
  // between the filesystem commit and the connection's acknowledgement.
  // An unobserved checkpoint belongs to another writer and must not fall
  // through to an older archive proof.
  const mismatch=()=>{if(isCurrent()&&!knownCurrentCheckpoint(config,result.id))throw new RecoveryConflict();return null;};
  if(config.recoveryId!==checkpoint.baseRecoveryId||config.projectId!==checkpoint.projectId||record.projectId!=null&&record.projectId!==checkpoint.recordProjectId||scene.workspaceId!==checkpoint.workspaceId||scene.revisionId!==checkpoint.revisionId||scene.persistedRevision!==checkpoint.storageRevision)return mismatch();
  for(const field of ['review','returned','completions']){const empty=field==='completions'?[]:null,expected=canonical(checkpoint[field]??empty);if(canonical(scene[field]??empty)!==expected||canonical(record[field]??empty)!==expected)return mismatch();}
  for(const role of Object.keys(rolePaths))if(await blobHash(record.files[role].blob)!==checkpoint.review.files[role].sha256||await blobHash(scene.files[role].blob)!==checkpoint.review.files[role].sha256)return mismatch();
  return isCurrent()?result:null;
}
export const knownCurrentCheckpoint=(config,id)=>id===(config?.currentCheckpointId??null)||typeof id==='string'&&HASH.test(id)&&id===config?.pendingCheckpointId;
async function locked(directory,projectId,action){
  if(!globalThis.navigator?.locks)fail('this browser cannot coordinate folder saving.');
  return navigator.locks.request('scorebrush-current:'+projectId,async()=>{
    const data=await owned(directory),lock=await data.getFileHandle(LOCK,{create:true});if((await lock.getFile()).size)fail('the current-review lock conflicts with existing data.');
    const writer=await lock.createWritable({mode:'exclusive'});try{return await action(data);}finally{await writer.abort();}
  });
}
async function replace(data,value,observed,{isCurrent=()=>true,beforeCommit=async()=>{}}={}){
  const blob=json(value);if(blob.size>LIMITS.json)fail('checkpoint exceeds the supported metadata size.');
  fresh(isCurrent);if(await storedText(data)!==observed)throw new RecoveryConflict();
  const stream=await(await data.getFileHandle(FILE,{create:true})).createWritable({mode:'exclusive'});
  try{await stream.write(blob);fresh(isCurrent);await beforeCommit();fresh(isCurrent);if(await storedText(data)!==observed)throw new RecoveryConflict();await stream.close();}
  catch(error){try{await stream.abort();}catch{}throw error;}
  const disk=await optional(data,FILE);if(!disk||await sha256(await disk.arrayBuffer())!==await blobHash(blob))fail('checkpoint read-back failed.');
}
export async function writeCurrentCheckpoint(directory,scene,config,{isCurrent=()=>true,onProgress=()=>{},beforeWrite=async()=>{}}={}){
  return locked(directory,config.projectId,async data=>{
    fresh(isCurrent);const base=await baseState(directory,null,onProgress),archive=base.archive;
    if(archive.manifest.id!==config.recoveryId||archive.manifest.projectId!==config.projectId||scene.workspaceId!==archive.manifest.current)throw new RecoveryConflict();
    const prepared=await prepareCompletionState(scene.review,scene.returned??null,scene.revisionId,scene.completions??[]);
    const checkpoint={schema:SCHEMA,version:1,id:'',baseRecoveryId:archive.manifest.id,baseManifestSha256:archive.manifestSha256,projectId:archive.manifest.projectId,recordProjectId:scene.projectId??base.bundle.projectId??archive.manifest.projectId,workspaceId:scene.workspaceId,revisionId:scene.revisionId,storageRevision:scene.persistedRevision,review:prepared.review,returned:prepared.returned,completions:prepared.bundle.records,stateSha256:prepared.bundle.stateSha256};
    checkpoint.id=await checkpointId(checkpoint);validateState(checkpoint,base);
    for(const role of Object.keys(rolePaths))if(await blobHash(scene.files[role].blob)!==checkpoint.review.files[role].sha256)fail('the open current inputs changed.');
    const saved=await stored(data);
    // Both content IDs were computed from their actual complete content in
    // this operation. The only excluded fields are rejected explicitly here.
    if(saved.value?.id===checkpoint.id&&!Object.hasOwn(saved.value,'retired')&&!Object.hasOwn(saved.value,'archivedBy')){checkpoint.id=saved.value.id;}
    else{
      if(saved.value?.retired&&!await covered(data,archive,saved.value))throw new RecoveryConflict();
      if(!saved.value?.retired&&!knownCurrentCheckpoint(config,saved.value?.id??null))throw new RecoveryConflict();
      // Persist the intended ID while holding the same locks as replacement.
      // A failed preparation must never publish an unrecorded checkpoint.
      await beforeWrite(checkpoint.id,saved.value?.retired?null:saved.value?.id??null);fresh(isCurrent);
      await replace(data,checkpoint,saved.text,{isCurrent,beforeCommit:async()=>{if(!await archiveCurrent(directory,archive))throw new RecoveryConflict();}});
    }
    return {id:checkpoint.id,baseRecoveryId:checkpoint.baseRecoveryId,stateSha256:checkpoint.stateSha256,checkpoint,snapshot:await currentSnapshot(base,checkpoint,prepared.bundle),files:base.files,superseded:!isCurrent()};
  });
}
// Hold the same browser and exclusive file locks as checkpoint writes while
// publishing its AI task. This protects current work, without auditing or
// appending the historical archive. The callback can recheck just before READY.
export async function withCurrentCheckpoint(directory,result,action,{isCurrent=()=>true}={}){
  const expected=structuredClone(result?.checkpoint);shape(expected);
  if(expected.retired||result.id!==expected.id||typeof action!=='function')throw new RecoveryConflict();
  const expectedState=canonical(expected);
  return locked(directory,expected.projectId,async()=>{
    const assertCurrent=async()=>{
      fresh(isCurrent);const actual=await readCurrentCheckpoint(directory);fresh(isCurrent);
      if(!actual||canonical(actual.checkpoint)!==expectedState)throw new RecoveryConflict();
      return actual;
    };
    await assertCurrent();const value=await action(assertCurrent);await assertCurrent();return value;
  });
}
export async function acknowledgeCurrentCheckpoint(directory,archive,{expectedId=null,isCurrent=()=>true}={}){
  return locked(directory,archive.manifest.projectId,async data=>{
    const saved=await stored(data);if(!saved.value)return null;
    if(expectedId!==null&&saved.value.id!==expectedId)throw new RecoveryConflict();
    if(!await covered(data,archive,saved.value)||!await archiveCurrent(directory,archive))throw new RecoveryConflict();
    if(!saved.value.retired)await replace(data,{...saved.value,retired:true,archivedBy:archive.manifest.id},saved.text,{isCurrent,beforeCommit:async()=>{if(!await archiveCurrent(directory,archive))throw new RecoveryConflict();}});
    return saved.value.id;
  });
}
// Full-profile recovery uses the existing package validators with a resealed
// in-memory current package. The actual archive and its CAS identity stay intact.
export async function overlayCurrentCheckpoint(snapshot,result){
  if(!result)return snapshot;const checkpoint=result.checkpoint;
  if(snapshot.manifest.id!==checkpoint.baseRecoveryId||snapshot.manifest.projectId!==checkpoint.projectId)throw new RecoveryConflict();
  const original=snapshot.manifest.records.find(item=>item.id===checkpoint.workspaceId);if(!original)throw new RecoveryConflict();
  const payloads=new Map(Object.entries(original.payloads).map(([path,info])=>[path,snapshot.objects.get(info.sha256)]));
  if([...payloads.values()].some(blob=>!blob))fail('full recovery assets are needed before applying current work.');
  payloads.set('annotations.json',json(checkpoint.review));payloads.set('completion-history.json',json(await completion(checkpoint)));
  if(checkpoint.returned){const sidecar=await parse(payloads.get('returned-workspace.json'));sidecar.returned=checkpoint.returned;payloads.set('returned-workspace.json',json(sidecar));}
  const manifest=await parse(payloads.get('manifest.json'));manifest.extensions=[...(manifest.extensions??[]).filter(e=>e.schema!==COMPLETION_EXTENSION.schema),COMPLETION_EXTENSION];await seal(payloads,manifest);
  const objects=new Map(snapshot.objects),declarations={};for(const [path,blob]of payloads){const info=await fileInfo(blob);objects.set(info.sha256,blob);declarations[path]=info;}
  const record={...original,revisionId:checkpoint.revisionId,storageRevision:checkpoint.storageRevision,payloads:declarations};delete record.historyId;delete record.historyPredecessorId;
  return {...snapshot,manifest:{...snapshot.manifest,records:snapshot.manifest.records.map(item=>item.id===record.id?record:item)},objects,currentCheckpoint:true,fullHistoryAudited:false};
}
