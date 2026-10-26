// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// A current AI handoff is pinned to one mutable review checkpoint. Reading it
// validates only its declared task and the current score, never old history.
import {sha256,blobHash} from './model.js';
import {canonical} from './completion-model.js';
import {strictJSON,hydrateTaskPayloads,localTaskDelivery,LIMITS} from './workflow.js';
import {readDataDirectory,DATA_DIRECTORY} from './project-directory.js';
import {readCurrentCheckpoint} from './current-checkpoint.js';
import {RecoveryConflict,readRecoveryMetadata,recoveryRecordProjectMatches} from './folder-recovery.js';
import {getSaved,getSavedState,recoveryIdentity} from './storage.js';
import {retained,retain} from './handoff-store.js';

const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9-]{36}$/,TASK=/^[\w-]{1,80}$/;
const PIN_FIELDS=['id','baseRecoveryId','baseManifestSha256','projectId','workspaceId','revisionId','storageRevision','stateSha256'];
const same=(a,b)=>canonical(a)===canonical(b);
const fail=message=>{throw new Error('Current AI handoff: '+message);};
const fresh=isCurrent=>{if(!isCurrent())fail('publication was superseded by a newer edit.');};
const safePath=path=>typeof path==='string'&&path.length>0&&path.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)&&!path.split('/').some(part=>!part||part==='.'||part==='..');
function pinShape(pin){
  if(!pin||typeof pin!=='object'||Array.isArray(pin)||Object.keys(pin).length!==PIN_FIELDS.length||PIN_FIELDS.some(field=>!Object.hasOwn(pin,field))||
    typeof pin.id!=='string'||!HASH.test(pin.id)||typeof pin.baseRecoveryId!=='string'||!UUID.test(pin.baseRecoveryId)||
    typeof pin.baseManifestSha256!=='string'||!HASH.test(pin.baseManifestSha256)||typeof pin.projectId!=='string'||!UUID.test(pin.projectId)||
    typeof pin.workspaceId!=='string'||!pin.workspaceId.length||pin.workspaceId.length>200||typeof pin.revisionId!=='string'||!pin.revisionId.length||pin.revisionId.length>200||
    !Number.isSafeInteger(pin.storageRevision)||pin.storageRevision<1||typeof pin.stateSha256!=='string'||!HASH.test(pin.stateSha256))fail('the current-review identity is invalid.');
  return pin;
}
export function checkpointPublication(result){
  const checkpoint=result?.checkpoint;
  if(!checkpoint||checkpoint.retired||result.id!==checkpoint.id)fail('a current verified checkpoint is required.');
  return pinShape(Object.fromEntries(PIN_FIELDS.map(field=>[field,checkpoint[field]])));
}
async function optional(root,path){
  try{const parts=path.split('/');for(const name of parts.slice(0,-1))root=await root.getDirectoryHandle(name);return await(await root.getFileHandle(parts.at(-1))).getFile();}
  catch(error){if(error.name==='NotFoundError')return null;throw error;}
}
async function exactPayloads(latest,manifestFile,manifest,isCurrent){
  const declarations=manifest?.payloads;
  if(!declarations||typeof declarations!=='object'||Array.isArray(declarations))fail('the task manifest has no payload declarations.');
  const entries=Object.entries(declarations),seen=new Set(),payloads=new Map([['manifest.json',manifestFile]]);
  if(entries.length+1>LIMITS.count)fail('the task has too many files.');
  let total=manifestFile.size;
  for(const [path,info]of entries){
    if(!safePath(path)||['manifest.json','ready.json'].includes(path.toLowerCase())||seen.has(path.toLowerCase())||
      !info||typeof info!=='object'||Array.isArray(info)||typeof info.sha256!=='string'||!HASH.test(info.sha256)||!Number.isSafeInteger(info.size)||info.size<0||info.size>LIMITS.file)fail('the task declares an unsafe file or invalid size.');
    seen.add(path.toLowerCase());total+=info.size;if(total>LIMITS.total)fail('the task exceeds the supported size.');
  }
  const shared=new Map();let next=0;
  while(next<entries.length){
    fresh(isCurrent);const batch=[];let bytes=0;
    while(next<entries.length&&batch.length<4){const item=entries[next];if(batch.length&&bytes+item[1].size>32*1024*1024)break;batch.push(item);bytes+=item[1].size;next++;}
    const results=await Promise.allSettled(batch.map(async([path,info])=>{
      fresh(isCurrent);const file=await optional(latest,path);fresh(isCurrent);
      if(!file||file.size!==info.size)fail('a declared task file is missing or changed: '+path);
      const bytes=await file.arrayBuffer();fresh(isCurrent);
      const owned=new Blob([bytes],{type:file.type});
      if(await blobHash(owned)!==info.sha256)fail('a declared task file is missing or changed: '+path);
      // Each path still reads and validates its own current disk bytes. Only
      // then share equal immutable payloads within this one read operation;
      // MIME type remains part of identity and hydration sees the shared graph.
      const key=info.sha256+':'+owned.size+':'+owned.type;
      if(!shared.has(key))shared.set(key,owned);
      payloads.set(path,shared.get(key));
    }));
    const rejected=results.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
  }
  fresh(isCurrent);return payloads;
}
// A valid stale publication is not a current prompt. A matching publication
// whose bytes are damaged must fail; it cannot silently become a trusted task.
// This function takes no checkpoint lock, so publication may call it while
// withCurrentCheckpoint already holds that lock.
export async function readCurrentHandoff(directory,result,{inspectPdf,isCurrent=()=>true,paths}={}){
  if(!result)return null;fresh(isCurrent);
  const expected=checkpointPublication(result),owned=await readDataDirectory(directory);fresh(isCurrent);
  if(owned?.name!==DATA_DIRECTORY)return null;
  let latest;try{latest=await owned.directory.getDirectoryHandle('latest');}catch(error){if(error.name==='NotFoundError')return null;throw error;}
  const marker=await optional(latest,'READY.json');fresh(isCurrent);if(!marker?.size)return null;
  if(marker.size>100000)fail('the READY marker is too large.');
  const readyText=await marker.text(),ready=strictJSON(readyText);fresh(isCurrent);
  if(!ready||ready.schema!=='private-score-desk-ready'||ready.version!==1||typeof ready.ready!=='boolean')fail('the READY marker is invalid.');
  if(!ready.ready||ready.currentReview==null)return null;
  const pin=pinShape(ready.currentReview);if(!same(pin,expected))return null;
  if(typeof ready.generationId!=='string'||!ready.generationId.length||ready.generationId.length>200||typeof ready.taskId!=='string'||!TASK.test(ready.taskId)||typeof ready.manifestSha256!=='string'||!HASH.test(ready.manifestSha256))fail('the ready task identity is invalid.');
  const archivePaths=result.snapshot?.manifest?.paths;
  if(!archivePaths||!same(ready.paths,archivePaths)||paths&&!same(ready.paths,paths))fail('the configured working paths differ.');
  const file=await optional(latest,'manifest.json');fresh(isCurrent);
  if(!file?.size||file.size>2*1024*1024)fail('the task manifest is missing or too large.');
  const bytes=await file.arrayBuffer();fresh(isCurrent);
  if(await sha256(bytes)!==ready.manifestSha256)fail('the task manifest changed.');
  const manifestFile=new Blob([bytes],{type:'application/json'}),manifest=strictJSON(new TextDecoder().decode(bytes));
  const payloads=await exactPayloads(latest,manifestFile,manifest,isCurrent);
  if(typeof inspectPdf!=='function')fail('PDF validation is required to recover the current task.');
  const entry=await hydrateTaskPayloads(payloads,inspectPdf,{expectedId:ready.taskId});fresh(isCurrent);
  const checkpoint=result.checkpoint,baseline=entry.task.baseline;
  if(!same(ready.baseline,baseline)||baseline.snapshotId!==checkpoint.review.snapshotId||baseline.sourceSha256!==checkpoint.review.files.source.sha256||baseline.codeSha256!==checkpoint.review.files.ly.sha256||baseline.renderSha256!==checkpoint.review.files.rendered.sha256)fail('the task belongs to different score inputs.');
  const prompt=payloads.get('PROMPT.txt');if(!prompt||prompt.size>LIMITS.json)fail('the exact prompt is missing or too large.');
  // Display/copy only; this text is never executed or used as application rules.
  entry.prompt=await prompt.text();fresh(isCurrent);
  const current=await readCurrentCheckpoint(directory);fresh(isCurrent);
  if(!current||!same(checkpointPublication(current),expected)||!same(current.checkpoint,checkpoint))throw new RecoveryConflict();
  if(await(await optional(latest,'READY.json'))?.text()!==readyText)throw new RecoveryConflict();
  fresh(isCurrent);return {entry,ready};
}

// A folder delivery may regenerate installed guidance and its folder prompt,
// but cannot replace the exact musical evidence retained under a task ID.
export async function retainCurrentHandoff(entry,{lookup=retained,write=retain,insertFirst=false}={}){
  if(entry?.kind!=='task'||typeof entry.id!=='string'||!(entry.payloads instanceof Map))fail('a validated current task is required.');
  async function matching(existing,{folderPrompt=false}={}){
    if(existing?.kind!=='task'||existing.id!==entry.id||!(existing.payloads instanceof Map)||!same(existing.task,entry.task))return false;
    const omitted=folderPrompt?new Set(['PROMPT.txt','manifest.json']):new Set();
    const paths=[...entry.payloads.keys()].filter(path=>!omitted.has(path)),other=[...existing.payloads.keys()].filter(path=>!omitted.has(path));
    if(paths.length!==other.length||paths.some(path=>!existing.payloads.has(path)))return false;
    for(const path of paths){const before=existing.payloads.get(path),after=entry.payloads.get(path);if(before.size!==after.size||await blobHash(before)!==await blobHash(after))return false;}
    if(folderPrompt){
      const parseManifest=async value=>{const blob=value.payloads.get('manifest.json');if(!blob||blob.size>2*1024*1024)return null;const manifest=strictJSON(await blob.text());if(!manifest.payloads)return null;delete manifest.payloads['PROMPT.txt'];return manifest;};
      const before=await parseManifest(existing),after=await parseManifest(entry);if(!before||!after||!same(before,after))return false;
    }
    return true;
  }
  async function preserved(existing){
    if(await matching(existing))return existing;
    if(existing?.kind==='task'&&same(existing.task?.baseline,entry.task.baseline)){
      try{if(await matching(await localTaskDelivery(existing),{folderPrompt:true}))return existing;}catch{/* A malformed retained task is never a compatible projection. */}
    }
    fail('this task ID already has different original bytes. The retained task was preserved.');
  }
  async function insert(){
    try{await write(entry);return entry;}
    catch(error){
      // A newly generated task ID needs no speculative read. Only an actual
      // duplicate can reuse retained bytes; operational failures still fail.
      if(error.name!=='ConstraintError')throw error;
      const concurrent=await lookup(entry.id);if(concurrent)return preserved(concurrent);throw error;
    }
  }
  if(!insertFirst){const existing=await lookup(entry.id);if(existing)return preserved(existing);}
  return insert();
}

// Additive backup imports can change retained evidence without changing the
// review revision. Its immutable sidecar ID is a small coverage token; only
// the first use or a changed ID needs to read the retained package declarations.
export async function currentEvidenceToken(directory,config,scene,{record=null,isCurrent=()=>true}={}){
  fresh(isCurrent);
  const local=record??await getSavedState(scene.workspaceId);fresh(isCurrent);
  const exact=value=>value?.id===scene.workspaceId&&value.revisionId===scene.revisionId&&value.storageRevision===scene.persistedRevision&&recoveryIdentity(value)===recoveryIdentity(scene);
  if(!config?.recoveryId||config.workspaceId!==scene.workspaceId||!exact(local))return null;
  const tokenFor=value=>({recoveryId:config.recoveryId,workspaceId:scene.workspaceId,retainedEvidenceId:value.retainedEvidenceId??null});
  const token=tokenFor(local);
  if(same(config.archivedEvidenceToken??null,token))return token;
  const full=await getSaved(scene.workspaceId);fresh(isCurrent);if(!exact(full))return null;
  const archive=await readRecoveryMetadata(directory,{isCurrent});fresh(isCurrent);
  if(!archive||archive.manifest.id!==config.recoveryId||archive.manifest.projectId!==config.projectId||archive.manifest.current!==scene.workspaceId||archive.manifest.sourceSha256!==config.sourceSha256||!same(archive.manifest.paths,config.paths)||!recoveryRecordProjectMatches(archive,full))return null;
  for(const [field,committed]of [['retainedLegacyEvidence','legacyEvidence'],['retainedHandoffEvidence','handoffs']]){
    for(const item of full[field]??[])if(!item?.bundle||!same(archive.manifest[committed]?.find(bundle=>bundle.id===item.bundle.id),item.bundle))return null;
  }
  const after=await getSavedState(scene.workspaceId);fresh(isCurrent);
  return exact(after)&&same(tokenFor(after),token)?token:null;
}


// IndexedDB-backed Blobs can wait on its backing store even for tiny old
// inputs. Resolve only the historical bytes this task actually references,
// retaining the immutable issued package and checking every replacement hash.
export function createHistoricalAssetResolver(directory,result,{isCurrent=()=>true}={}){
  const pin=checkpointPublication(result),checkpoint=result.checkpoint,current=new Map(),pending=new Map();let anchor;
  for(const role of ['source','rendered','ly']){
    const info=checkpoint.review.files[role],blob=result.files?.[role]?.blob;
    if(blob)current.set(info.sha256,{size:info.size,blob});
  }
  async function committed(){
    if(!anchor)anchor=(async()=>{
      fresh(isCurrent);const archive=await readRecoveryMetadata(directory,{isCurrent});fresh(isCurrent);
      if(!archive||archive.manifest.id!==pin.baseRecoveryId||archive.manifestSha256!==pin.baseManifestSha256||archive.manifest.projectId!==pin.projectId||archive.manifest.current!==pin.workspaceId||archive.manifest.sourceSha256!==checkpoint.review.files.source.sha256)throw new RecoveryConflict();
      const declarations=new Map();
      for(const bundle of [...archive.manifest.records,...(archive.manifest.handoffs??[]),...(archive.manifest.legacyEvidence??[])])for(const info of Object.values(bundle.payloads)){
        const prior=declarations.get(info.sha256);if(prior&&prior.size!==info.size)fail('historical asset declarations disagree.');declarations.set(info.sha256,info);
      }
      const owned=await readDataDirectory(directory);fresh(isCurrent);if(owned?.name!==DATA_DIRECTORY)throw new RecoveryConflict();
      const objects=await(await owned.directory.getDirectoryHandle('recovery')).getDirectoryHandle('objects');
      return {declarations,objects,tasks:new Map((archive.manifest.handoffs??[]).filter(bundle=>bundle.kind==='task').map(bundle=>[bundle.id,bundle.payloads]))};
    })();
    return anchor;
  }
  return async(info,{taskId=null,path=null}={})=>{
    fresh(isCurrent);
    if(taskId!==null||path!==null){
      if(typeof taskId!=='string'||!TASK.test(taskId)||!safePath(path))fail('the historical task reference is invalid.');
      const {tasks}=await committed();fresh(isCurrent);const declared=tasks.get(taskId)?.[path];
      if(!declared||info&&(info.sha256!==declared.sha256||info.size!==declared.size))fail('the historical task does not declare this exact asset.');
      info=declared;
    }
    if(!info||typeof info.sha256!=='string'||!HASH.test(info.sha256)||!Number.isSafeInteger(info.size)||info.size<0||info.size>LIMITS.file)fail('the requested historical asset identity is invalid.');
    const cached=pending.get(info.sha256);if(cached){if(cached.size!==info.size)fail('historical asset sizes disagree.');return cached.promise;}
    const promise=(async()=>{
      const owned=current.get(info.sha256);
      if(owned){if(owned.size!==info.size||owned.blob.size!==info.size||await blobHash(owned.blob)!==info.sha256)fail('the current input does not match the historical asset.');fresh(isCurrent);return owned.blob;}
      const {declarations,objects}=await committed();fresh(isCurrent);
      const declaration=declarations.get(info.sha256);if(!declaration||declaration.size!==info.size)fail('the historical asset is not declared by this committed project.');
      const file=await optional(objects,info.sha256);fresh(isCurrent);
      if(!file||file.size!==info.size)fail('the historical asset is missing or changed.');
      const bytes=await file.arrayBuffer();fresh(isCurrent);
      if(await sha256(bytes)!==info.sha256)fail('the historical asset is missing or changed.');
      fresh(isCurrent);return new Blob([bytes],{type:file.type});
    })();
    pending.set(info.sha256,{size:info.size,promise});return promise;
  };
}
