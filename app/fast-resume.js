// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// A known current-publication proof is separate from full historical recovery.
// Partial snapshots never escape this module or populate the recovery cache.
import {sha256} from './model.js';
import {canonical} from './completion-model.js';
import {strictJSON,LIMITS} from './workflow.js';
import {readDataDirectory,DATA_DIRECTORY} from './project-directory.js';
import {recoveryIsCurrent,recoveryMatches,recoveryRecordProjectMatches} from './folder-recovery.js';
import {checkFinishedPDF} from './finished-pdf.js';
import {checkPdfVersions} from './pdf-versions.js';
const SCHEMA='scorebrush-clean-resume-proof',VERSION=1;
const UUID=/^[a-f0-9-]{36}$/,HASH=/^[a-f0-9]{64}$/;
const same=(a,b)=>canonical(a)===canonical(b);
const paths={history:'History.json',historyReceipt:'.scorebrush/history-index.json',finishedReceipt:'.scorebrush/finished-pdf.json'};
async function optional(root,path){try{const parts=path.split('/');for(const name of parts.slice(0,-1))root=await root.getDirectoryHandle(name);return await(await root.getFileHandle(parts.at(-1))).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function descriptor(blob){if(blob?.size>LIMITS.json)throw Error('Oversized publication metadata');return blob?{size:blob.size,sha256:await sha256(await blob.arrayBuffer())}:null;}
async function publications(directory){const pairs=await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await descriptor(await optional(directory,path))]));return Object.fromEntries(pairs);}
async function evidence(record){return sha256(new TextEncoder().encode(canonical({legacy:(record?.retainedLegacyEvidence??[]).map(e=>e.bundle),handoffs:(record?.retainedHandoffEvidence??[]).map(e=>e.bundle)})));}
function covered(record,snapshot){return [['retainedLegacyEvidence','legacyEvidence'],['retainedHandoffEvidence','handoffs']].every(([local,committed])=>(record?.[local]??[]).every(e=>same(snapshot?.manifest?.[committed]?.find(b=>b.id===e.bundle.id),e.bundle)));}
// Call only after the existing full save or full clean proof has succeeded.
// Failure to capture an optional acceleration receipt never undoes that save.
export async function captureResumeProof(selected,scene,record,snapshot,{pdfVersions,isCurrent=()=>true}={}){
  try{
    if(!isCurrent()||!snapshot||!pdfVersions||!selected.head||!covered(record,snapshot)||!recoveryRecordProjectMatches(snapshot,record)||
      selected.recoveryId!==snapshot.manifest.id||selected.projectId!==snapshot.manifest.projectId||selected.head.id!==snapshot.manifest.headTaskId||
      record?.revisionId!==scene.revisionId||record.storageRevision!==scene.persistedRevision||
      !['review','returned','completions'].every(k=>same(record[k]??(k==='completions'?[]:null),scene[k]??(k==='completions'?[]:null)))||
      !await recoveryMatches(snapshot,scene))return null;
    const manifest=await optional(selected.directory,'.scorebrush/recovery/g-'+snapshot.manifest.id+'/snapshot.json');
    if(!manifest||manifest.size>LIMITS.json)return null;
    const bytes=await manifest.arrayBuffer();if(!same(strictJSON(new TextDecoder().decode(bytes)),snapshot.manifest))return null;
    const finishedBlob=await optional(selected.directory,paths.finishedReceipt),finished=finishedBlob?strictJSON(await finishedBlob.text()).current:null;
    const proof={schema:SCHEMA,version:VERSION,projectId:selected.projectId,generationId:snapshot.manifest.id,manifestSha256:await sha256(bytes),
      workspaceId:scene.workspaceId,revisionId:scene.revisionId,storageRevision:scene.persistedRevision,headTaskId:selected.head.id,
      evidenceSha256:await evidence(record),publications:await publications(selected.directory),pdfVersions,
      finished:finished?{name:finished.name,number:finished.number,sha256:finished.sha256,size:finished.size}:null};
    return isCurrent()&&await recoveryIsCurrent(selected.directory,snapshot)&&isCurrent()?proof:null;
  }catch{return null;}
}
async function pinnedSnapshot(selected,proof){
  const owned=await readDataDirectory(selected.directory);if(owned?.name!==DATA_DIRECTORY)return null;
  const root=await owned.directory.getDirectoryHandle('recovery');
  const blob=await optional(root,'g-'+proof.generationId+'/snapshot.json');if(!blob||blob.size>LIMITS.json)return null;
  const bytes=await blob.arrayBuffer();if(await sha256(bytes)!==proof.manifestSha256)return null;
  const manifest=strictJSON(new TextDecoder().decode(bytes));
  const snapshot={manifest,objects:new Map()};
  // This API validates COMMIT hashes, schema, competing heads and generations;
  // unlike readRecovery({assets:false}), it DOES NOT cache a partial snapshot.
  if(!await recoveryIsCurrent(selected.directory,snapshot))return null;
  const current=manifest.records.find(r=>r.id===proof.workspaceId),head=manifest.handoffs?.find(r=>r.id===proof.headTaskId&&r.kind==='task');
  if(manifest.projectId!==proof.projectId||manifest.current!==proof.workspaceId||manifest.headTaskId!==proof.headTaskId||!current||!head)return null;
  const refs=new Map();for(const record of [current,head])for(const info of Object.values(record.payloads)){
    if(refs.has(info.sha256)&&refs.get(info.sha256).size!==info.size)throw Error('Inconsistent current closure sizes');refs.set(info.sha256,info);
  }
  const objects=await root.getDirectoryHandle('objects'),items=[...refs.values()];
  let next=0;while(next<items.length){const batch=[];let size=0;while(next<items.length&&batch.length<4){const info=items[next];if(batch.length&&size+info.size>32*1024*1024)break;batch.push(info);size+=info.size;next++;}
    const results=await Promise.allSettled(batch.map(async info=>{const file=await optional(objects,info.sha256);if(!file||file.size!==info.size)throw Error('Current publication asset is missing or changed');const bytes=await file.arrayBuffer();if(await sha256(bytes)!==info.sha256)throw Error('Current publication asset is missing or changed');snapshot.objects.set(info.sha256,new Blob([bytes]));}));const rejected=results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
  }
  return snapshot;
}
// Returns only a proven current task, never the partial recovery snapshot.
// Callers must use existing FULL recovery before writes/export/history access.
export async function verifyFastResume(selected,scene,record,proof,options={},verifySavedFolder){
  if(typeof verifySavedFolder!=='function'||proof?.schema!==SCHEMA||proof.version!==VERSION||!UUID.test(proof.generationId)||!HASH.test(proof.manifestSha256)||
    selected.recoveryId!==proof.generationId||selected.projectId!==proof.projectId||selected.head?.id!==proof.headTaskId||
    scene.workspaceId!==proof.workspaceId||scene.revisionId!==proof.revisionId||scene.persistedRevision!==proof.storageRevision||
    await evidence(record)!==proof.evidenceSha256)return null;
  const snapshot=await pinnedSnapshot(selected,proof);if(!snapshot||!covered(record,snapshot)||!same(proof.publications,await publications(selected.directory)))return null;
  // Preserve the fully verified presentation order: imported older renderings
  // can receive newer ordinal numbers while sorting earlier in history.
  const catalog=proof.pdfVersions?.map(v=>snapshot.manifest.pdfOutput.renderings.find(r=>r.sha256===v.sha256&&r.size===v.size&&r.number===v.number));
  if(!catalog||catalog.some(v=>!v)||new Set(catalog.map(v=>v.sha256)).size!==catalog.length)return null;
  const entry=await verifySavedFolder(selected,scene,record,snapshot,options,{
    versions:async(directory,recovery)=>{const result=await checkPdfVersions(directory,recovery,catalog,{versions:proof.pdfVersions,requiredHashes:new Set([scene.review.files.rendered.sha256,proof.finished?.sha256].filter(Boolean))});return same(result,proof.pdfVersions)?result:null;},
    finished:async directory=>{
      if(!proof.finished)return (await optional(directory,paths.finishedReceipt))===null;
      const result=await checkFinishedPDF(directory,proof.projectId);
      return result.state==='match'&&result.path==='Latest/'+proof.finished.name&&result.number===proof.finished.number&&result.sha256===proof.finished.sha256;
    }
  });
  if(!entry||!same(proof.publications,await publications(selected.directory))||!await recoveryIsCurrent(selected.directory,snapshot))return null;
  return {entry,verifiedCurrentObjectCount:snapshot.objects.size,fullHistoryAudited:false,historicalVersionsAudited:false};
}
