// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Recovery is separate from latest/ and its AI READY protocol. Immutable,
// content-addressed assets are shared by three committed generations. Every
// generation also carries all prior score revisions. Shared objects are never
// collected online: Web Locks cannot exclude another browser profile's writer.
import {sha256,blobHash} from './model.js';
import {readDataDirectory,ensureDataDirectory,DATA_DIRECTORY,LEGACY_DIRECTORY} from './project-directory.js';
import {json,strictJSON,fileInfo,readPackagePayloads,hydrateTaskPayloads,readResponsePayloads,responseRevision,LIMITS} from './workflow.js';
import {makeRecovery} from './export.js';
import {makeReturnedBackup,restoreReturnedBackup} from './returned.js';
import {addCompletionHistory} from './completion.js';
import {getSaved,savedRecords,workspaceHistories,recoveryIdentity,restoreMissing,checkLegacyImport} from './storage.js';
import {retained,retainedList,retain} from './handoff-store.js';
import {canonical,stateHash} from './completion-model.js';
import {preparePdfOutput} from './pdf-versions.js';
import {validatePdfOutput} from './pdf-output-names.js';

const SCHEMA='private-score-desk-recovery', HASH=/^[a-f0-9]{64}$/, ID=/^[a-f0-9-]{36}$/,EVENT_ID=/^(returned|review)-event:[a-f0-9-]{36}$/;
const matches=(pattern,value)=>typeof value==='string'&&pattern.test(value);
const safe=path=>typeof path==='string'&&path.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');
const fail=message=>{throw new Error(message);};
export class RecoveryDataError extends Error {
  constructor(message,code='manifest-schema',context={}){super(message);this.name='RecoveryDataError';this.code=code;this.recoveryContext=context;}
}
const corrupt=(message,code,context)=>{throw new RecoveryDataError(message,code,context);};
function recoveryContext(error,context){
  // Preserve DOMException names and runtime error identity for permission and
  // resource handling. Operational failures must never authorize fallback.
  if(!error||typeof error!=='object')error=new Error(String(error));
  try{error.recoveryContext={...context,...error.recoveryContext};error.recoveryReadFailure=!(error instanceof RecoveryDataError);return error;}
  catch{const wrapped=new Error(error.message??String(error),{cause:error});wrapped.name=error.name??'Error';wrapped.recoveryContext=context;wrapped.recoveryReadFailure=true;return wrapped;}
}
const jsonFailures=new Set(['Incomplete JSON text.','JSON nesting is excessive.','Invalid JSON object.','Duplicate or unsafe JSON key.','Invalid JSON separator.','Incomplete JSON object.','Invalid JSON value.','Unexpected text after JSON.']);
const bundles=m=>[...m.records,...(m.handoffs??[]),...(m.legacyEvidence??[])];
// Bound logical history by the same resource budget as immutable objects.
// Record and legacy-package IDs share this allowance; no history is pruned.
export const HISTORY_LIMITS=Object.freeze({records:LIMITS.count,handoffs:1000});
export class HistoryCapacityError extends Error {
  constructor(pending){super('Captured history capacity reached ('+pending+'). These changes are still pending folder publication; the prior committed folder history is intact and browser work remains saved. Use saving recovery to protect the current review, keep the complete project folder and profile, and retry after resolving capacity. No older history was discarded.');this.name='HistoryCapacityError';this.pending=pending;}
}
export class RecoveryConflict extends Error {constructor(){super('Browser and folder recovery have different changes. Neither was replaced. Save a backup of this browser review, then choose a new working folder, or recover this folder in a separate browser profile.');this.name='RecoveryConflict';}}
async function at(dir,path,create=false){if(!safe(path))fail('Unsafe recovery path.');const parts=path.split('/');for(const part of parts.slice(0,-1))dir=await dir.getDirectoryHandle(part,{create});return dir.getFileHandle(parts.at(-1),{create});}
async function read(dir,path){try{return await(await at(dir,path)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function write(dir,path,blob){const stream=await(await at(dir,path,true)).createWritable();try{await stream.write(blob);await stream.close();}catch(e){try{await stream.abort();}catch{}throw e;}}
async function parse(blob){
  if(!blob)corrupt('Recovery metadata is missing.','metadata-missing');
  if(blob.size>LIMITS.json)corrupt('Recovery metadata exceeds the supported size.','metadata-size',{actualSize:blob.size,limit:LIMITS.json});
  const text=await blob.text();
  try{return strictJSON(text);}catch(e){if(e instanceof SyntaxError||jsonFailures.has(e.message))corrupt('Recovery metadata is invalid: '+e.message,'metadata-json');throw e;}
}
async function recoveryDir(directory,create=false){const owned=create?await ensureDataDirectory(directory):(await readDataDirectory(directory))?.directory;if(!owned)return null;try{return await owned.getDirectoryHandle('recovery',{create});}catch(e){if(!create&&e.name==='NotFoundError')return null;throw e;}}
async function generations(dir){const result=[];for await(const [name,entry]of dir.entries()){if(entry.kind==='directory'&&name.startsWith('g-')&&ID.test(name.slice(2))){result.push(name.slice(2));if(result.length>128)fail('Too many recovery generations. Keep a manual backup and ask for recovery help.');}}return result;}
const IO_CONCURRENCY=4,IO_BATCH_BYTES=32*1024*1024;
const fresh=isCurrent=>{if(!isCurrent())fail('Recovery save superseded by a newer edit.');};
// Bound both simultaneous filesystem calls and large byte buffers. Drain every
// started operation before rejection, so a superseding save cannot overlap it.
async function bounded(items,visit,{isCurrent=()=>true,onProgress=()=>{},phase='read',size=()=>0}={}){
  let next=0,done=0;fresh(isCurrent);onProgress({phase,done,total:items.length});
  while(next<items.length){
    fresh(isCurrent);const batch=[];let bytes=0;
    while(next<items.length&&batch.length<IO_CONCURRENCY){const weight=size(items[next]);if(batch.length&&bytes+weight>IO_BATCH_BYTES)break;batch.push([items[next],next++]);bytes+=weight;}
    const results=await Promise.allSettled(batch.map(async([item,index])=>{fresh(isCurrent);await visit(item,index);fresh(isCurrent);}));
    // A sibling corruption must not hide an operational read failure and
    // authorize fallback from an incompletely checked generation.
    const rejected=results.find(r=>r.status==='rejected'&&r.reason?.recoveryReadFailure)||results.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
    done+=batch.length;onProgress({phase,done,total:items.length});
  }
}
function assetInfos(manifest){
  const unique=new Map();for(const record of bundles(manifest))for(const info of Object.values(record.payloads)){
    if(unique.has(info.sha256)&&unique.get(info.sha256).size!==info.size)corrupt('Recovery asset sizes disagree.','asset-size-declaration',{sha256:info.sha256});unique.set(info.sha256,info);
  }return [...unique.values()];
}
async function objectBudget(dir,options={}){
  const sizes=new Map();let total=0,objects;try{objects=await dir.getDirectoryHandle('objects');}catch(e){if(e.name!=='NotFoundError')throw e;}
  const entries=[];if(objects)for await(const [name,entry]of objects.entries()){fresh(options.isCurrent??(()=>true));if(entry.kind==='file'&&HASH.test(name))entries.push([name,entry]);}
  await bounded(entries,async([name,entry])=>{const blob=entry.getFile?await entry.getFile():await read(objects,name);if(blob){sizes.set(name,blob.size);total+=blob.size;}},{...options,phase:'budget'});
  const reserve=info=>{const count=sizes.size+(sizes.has(info?.sha256)?0:info?1:0),next=total+(info?info.size-(sizes.get(info.sha256)??0):0);if(count>LIMITS.count||next>LIMITS.total)throw new HistoryCapacityError('storage exceeds '+LIMITS.total+' bytes / '+LIMITS.count+' objects; attempted '+next+' bytes / '+count+' objects');if(info){sizes.set(info.sha256,info.size);total=next;}};
  reserve.directory=objects;reserve.sizes=sizes;return reserve;
}
function checkManifest(m,id){
  if(!m||typeof m!=='object'||Array.isArray(m))corrupt('Invalid recovery manifest.');
  if(m.pdfOutput!==undefined){
    if(Array.isArray(m.pdfOutput?.renderings)&&m.pdfOutput.renderings.some(r=>!r||typeof r!=='object'||Array.isArray(r)||!matches(HASH,r.sha256)))corrupt('Invalid PDF rendering entry.','manifest-pdf-output');
    try{validatePdfOutput(m.pdfOutput);}catch(e){if(['PDF naming metadata is invalid. Existing files were kept.','PDF rendering ordinals conflict. Existing numbers were kept.'].includes(e.message))corrupt(e.message,'manifest-pdf-output');throw e;}
  }
  if(m.schema!==SCHEMA||m.version!==1||m.id!==id||!matches(ID,m.projectId)||!matches(HASH,m.sourceSha256)||m.parent!==null&&!matches(ID,m.parent)||!Number.isSafeInteger(m.sequence)||m.sequence<1||!Array.isArray(m.records)||!m.records.length||m.records.length>HISTORY_LIMITS.records||m.records.some(r=>!r||typeof r!=='object'||Array.isArray(r))||typeof m.current!=='string'||!m.records.some(r=>r.id===m.current)||new Set(m.records.map(r=>r.id)).size!==m.records.length)corrupt('Invalid recovery schema or identity.');
  const paths=m.paths;if(!paths||['source','rendered','ly'].some(role=>typeof paths[role]!=='string'||paths[role].length>999||/[\\\x00-\x1f:]/.test(paths[role])||paths[role].split('/').some(p=>!p||p==='.'||p==='..')||[DATA_DIRECTORY,LEGACY_DIRECTORY].some(name=>paths[role].toLowerCase().startsWith(name+'/'))))corrupt('Unsafe recovery working paths.');
  if(m.handoffs!==undefined&&(!Array.isArray(m.handoffs)||m.handoffs.length>HISTORY_LIMITS.handoffs||m.handoffs.some(h=>!h||typeof h!=='object'||Array.isArray(h))||new Set(m.handoffs.map(h=>h.id)).size!==m.handoffs.length||m.handoffs.some(h=>!['task','response'].includes(h.kind))))corrupt('Invalid recovery handoff list.');
  if(m.legacyEvidence!==undefined&&(!Array.isArray(m.legacyEvidence)||m.legacyEvidence.length+m.records.length>HISTORY_LIMITS.records||m.legacyEvidence.some(r=>!r||typeof r!=='object'||Array.isArray(r))||new Set(m.legacyEvidence.map(r=>r.id)).size!==m.legacyEvidence.length||m.legacyEvidence.some(r=>!matches(/^legacy-package:[a-f0-9]{64}$/,r.id))))corrupt('Invalid retained legacy evidence.');
  if(new Set([...m.records,...(m.legacyEvidence??[])].map(r=>r.id)).size!==m.records.length+(m.legacyEvidence?.length??0))corrupt('Duplicate retained history identity.');
  if(m.records.find(r=>r.id===m.current)?.history||m.headTaskId!=null&&!(m.handoffs??[]).some(h=>h.id===m.headTaskId&&h.kind==='task'))corrupt('Invalid current recovery identity.');
  for(const r of bundles(m)){if(typeof r.id!=='string'||r.id.length>200||!r.payloads||typeof r.payloads!=='object'||Array.isArray(r.payloads)||Object.keys(r.payloads).length>LIMITS.count)corrupt('Invalid recovery record.');let total=0;for(const [path,info]of Object.entries(r.payloads)){if(!safe(path)||!matches(HASH,info?.sha256)||!Number.isSafeInteger(info.size)||info.size<0||info.size>LIMITS.file)corrupt('Unsafe recovery asset.');total+=info.size;}if(total>LIMITS.total)corrupt('Recovery record is too large.');}
  const unique=new Map(bundles(m).flatMap(r=>Object.values(r.payloads).map(i=>[i.sha256,i])));if(unique.size>LIMITS.count||[...unique.values()].reduce((n,i)=>n+i.size,0)>LIMITS.total)corrupt('Folder recovery history exceeds 512 MB or 5000 unique assets. Keep a manual backup; browser work remains saved.');
}
async function loadGeneration(dir,id,{assets=true,objects=new Map(),isCurrent=()=>true,onProgress=()=>{}}={}){
  let context={generationId:id,phase:'commit',path:`g-${id}/COMMIT.json`};
  try{
    fresh(isCurrent);onProgress({phase:'metadata',generationId:id});const commit=await parse(await read(dir,context.path));
    if(!commit||commit.schema!==SCHEMA||commit.version!==1||commit.id!==id||!matches(HASH,commit.manifestSha256))corrupt('Invalid recovery commit.','commit-schema');
    context={generationId:id,phase:'manifest',path:`g-${id}/snapshot.json`};
    const blob=await read(dir,context.path);if(!blob)corrupt('Recovery manifest is missing.','manifest-missing');
    if(blob.size>LIMITS.json)corrupt('Recovery manifest exceeds the supported size.','manifest-size',{actualSize:blob.size,limit:LIMITS.json});
    if(await blobHash(blob)!==commit.manifestSha256)corrupt('Recovery manifest hash differs.','manifest-hash');
    const manifest=await parse(blob);checkManifest(manifest,id);
    if(assets){
      context={generationId:id,phase:'assets',path:'objects'};
      const pending=[];for(const info of assetInfos(manifest)){if(objects.has(info.sha256)){if(objects.get(info.sha256).size!==info.size)corrupt('Recovery asset sizes disagree.','asset-size-declaration',{sha256:info.sha256});}else pending.push(info);}
      let directory;try{directory=await dir.getDirectoryHandle('objects');}catch(e){if(e.name==='NotFoundError')corrupt('Recovery object directory is missing.','objects-missing');throw e;}
      await bounded(pending,async info=>{
        const assetContext={generationId:id,phase:'asset',path:'objects/'+info.sha256,sha256:info.sha256,expectedSize:info.size};
        try{
          const asset=await read(directory,info.sha256);if(!asset)corrupt('Recovery asset is missing.','asset-missing');
          if(asset.size!==info.size)corrupt('Recovery asset size differs.','asset-size',{actualSize:asset.size});
          const owned=new Blob([await asset.arrayBuffer()]),actualSha256=await blobHash(owned);
          if(actualSha256!==info.sha256)corrupt('Recovery asset hash differs.','asset-hash',{actualSha256});
          objects.set(info.sha256,owned);
        }catch(e){throw recoveryContext(e,assetContext);}
      },{isCurrent,onProgress:value=>onProgress({...value,generationId:id}),phase:'read',size:info=>info.size});
    }
    return {manifest,objects,manifestSha256:commit.manifestSha256};
  }catch(e){throw recoveryContext(e,context);}
}
const verifiedSnapshots=new WeakMap();
async function scanRecovery(directory,{assets=true,isCurrent=()=>true,onProgress=()=>{}}={}){
  const dir=await recoveryDir(directory);if(!dir)return null;const ids=await generations(dir),valid=[],damaged=[],incomplete=[],damageDetails=[],objects=new Map();
  for(const id of ids){
    fresh(isCurrent);
    try{const marker=await read(dir,`g-${id}/COMMIT.json`);if(!marker?.size){incomplete.push(id);continue;}valid.push(await loadGeneration(dir,id,{objects,assets,isCurrent,onProgress}));}
    catch(error){fresh(isCurrent);const e=recoveryContext(error,{generationId:id,phase:'commit',path:`g-${id}/COMMIT.json`});
      if(!(e instanceof RecoveryDataError))throw e;
      damaged.push(id);damageDetails.push({generationId:id,code:e.code,message:e.message,context:e.recoveryContext});
    }
  }
  if(!valid.length){if(damaged.length){const error=new RecoveryDataError('No complete valid folder recovery is available. '+damageDetails[0].message+' Browser work and existing backups are unchanged.','no-valid-generation');error.damageDetails=damageDetails;throw error;}return null;}
  const projects=new Set(valid.map(v=>v.manifest.projectId));if(projects.size!==1)throw new RecoveryConflict();
  for(const item of valid){const parent=valid.find(v=>v.manifest.id===item.manifest.parent);if(parent&&(parent.manifest.sourceSha256!==item.manifest.sourceSha256||parent.manifest.sequence+1!==item.manifest.sequence))throw new RecoveryConflict();}
  const parents=new Set(valid.map(v=>v.manifest.parent)),heads=valid.filter(v=>!parents.has(v.manifest.id));
  // A damaged intermediate generation may disconnect its valid descendants.
  // Never guess between two heads, even when their timestamps differ.
  if(heads.length!==1)throw new RecoveryConflict();
  return {...heads[0],damaged,incomplete,damageDetails,ids};
}
export async function readRecovery(directory,options={}){
  try{const snapshot=await scanRecovery(directory,options);if(snapshot)verifiedSnapshots.set(directory,snapshot);return snapshot;}
  catch(error){throw recoveryContext(error,{phase:'read',path:'recovery'});}
}
// Metadata-only anchor for mutable current-review checkpoints. It never
// populates the full-history verification cache.
export const readRecoveryMetadata=(directory,options={})=>scanRecovery(directory,{...options,assets:false});
export async function recoveryIsCurrent(directory,snapshot){
  const latest=await scanRecovery(directory,{assets:false});
  return Boolean(latest&&canonical(latest.manifest)===canonical(snapshot.manifest));
}
async function recoveryForWrite(directory,options={}){
  const cached=verifiedSnapshots.get(directory);
  if(cached){const current=await scanRecovery(directory,{...options,assets:false});if(current&&canonical(current.manifest)===canonical(cached.manifest))return {...current,objects:cached.objects};}
  return readRecovery(directory,options);
}
const packageCache=new Map();
// Folder ownership and a browser journal's lineage are separate identities.
// Legacy migration may allocate the journal ID after the folder already exists;
// the committed current record is the explicit binding between those IDs.
export function recoveryRecordProjectMatches(snapshot,record){
  const committed=snapshot?.manifest?.records?.find(item=>item.id===snapshot.manifest.current);
  return Boolean(committed&&record?.id===committed.id&&(record.projectId==null||record.projectId===(committed.projectId??snapshot.manifest.projectId)));
}
export async function recoveryMatches(snapshot,scene){
  if(!snapshot||snapshot.manifest.current!==scene.workspaceId)return false;
  const record=snapshot.manifest.records.find(r=>r.id===scene.workspaceId),info=record?.payloads?.['completion-history.json'];
  if(record?.revisionId!==scene.revisionId||record?.snapshotId!==scene.review?.snapshotId||!info)return false;
  const metadata=await parse(snapshot.objects.get(info.sha256));
  return metadata.stateSha256===await stateHash(scene.review,scene.returned??null)&&canonical(metadata.records)===canonical(scene.completions??[]);
}
const captureIdentity=(record,kind=record.kind??'workspace')=>({kind,id:record.id,revisionId:record.revisionId??null});
async function capturedPackage(payloads,record,kind){
  const manifest=await parse(payloads.get('manifest.json'));
  const date=kind==='review-backup'||record.kind?record.createdAt:record.review?.updatedAt??record.review?.createdAt;
  // Retry/restart must produce the same objects. The recorded capture identity
  // also keeps distinct saves with equal content and timestamps distinguishable.
  manifest.createdAt=typeof date==='string'&&Number.isFinite(Date.parse(date))?date:null;
  manifest.recoveryCapture=captureIdentity(record,kind);
  payloads.set('manifest.json',json(manifest));return payloads;
}
async function packageRecord(record){
  const key=record.id+':'+recoveryIdentity(record);if(packageCache.has(key))return packageCache.get(key);
  let payloads=await makeRecovery(record.review,record.files);if(record.returned)payloads=await makeReturnedBackup(record.review,record.files,record.returned,payloads);
  payloads=await addCompletionHistory(payloads,record.review,record.returned??null,record.revisionId,record.completions??[],{preserveRevision:true});
  await capturedPackage(payloads,record);packageCache.clear();packageCache.set(key,payloads);return payloads;
}
// Traverse the current round's exact parent links. This migrates earlier browser
// rounds on the next save without copying unrelated reviews of the same source.
async function lineage(current){
  const all=await savedRecords({evidence:false,inputs:false}),byId=new Map(all.map(item=>[item.id,item])),result=new Map([[current.id,current]]),pending=[current];
  // A project can contain several imported/returned branches. Only explicit
  // project/parent relationships join them; equal PDF bytes are not a lineage.
  for(const item of all)if(current.projectId&&item.projectId===current.projectId&&item.id!==current.id){result.set(item.id,item);pending.push(item);}
  while(pending.length){const r=pending.pop();let parent=r.parentWorkspaceId;
    if(r.returned){const task=await retained(r.returned.taskId);if(!task)fail('A retained task needed by recovery is missing. Save a backup before continuing.');parent??=task.task.parent?.workspaceId??task.task.baseline.snapshotId;}
    const match=byId.get(parent);if(match&&!result.has(match.id)){if(match.review.files.source.sha256!==current.review.files.source.sha256)fail('Recovery source lineage mismatch.');result.set(match.id,match);pending.push(match);}
  }
  // Hydrate input bytes and retained evidence only for this project's lineage.
  const related=[];for(const item of result.values())related.push(item!==current&&(item.inputFilesId||item.retainedEvidenceId)?await getSaved(item.id):item);
  return related;
}

// Older writers left content-addressed package objects after pruning generation
// metadata. Recover their explicit declarations once; never guess missing bytes.
async function backfillLegacy(dir,previous,sourceSha256,knownCapture=async()=>false,{isCurrent=()=>true,onProgress=()=>{},directory=null,sizes=new Map()}={}){
  if(previous?.manifest.historyBackfillVersion===1)return previous.manifest.legacyEvidence??[];
  const result=new Map((previous?.manifest.legacyEvidence??[]).map(r=>[r.id,r]));
  const signature=payloads=>['annotations.json','completion-history.json','returned-workspace.json','task.json'].map(p=>payloads[p]?.sha256??'').join(':');
  const priorBundles=bundles(previous?.manifest??{records:[]}),known=new Set(priorBundles.map(r=>signature(r.payloads))),knownPackages=new Set(priorBundles.map(r=>r.payloads['manifest.json']?.sha256));
  let objects=directory;try{objects??=await dir.getDirectoryHandle('objects');}catch(e){if(e.name==='NotFoundError')return [...result.values()];throw e;}
  const checked=new Map();
  async function object(info){
    if(!HASH.test(info?.sha256)||!Number.isSafeInteger(info.size)||info.size<0||info.size>LIMITS.file)return null;
    if(!checked.has(info.sha256))checked.set(info.sha256,(async()=>{const blob=await read(objects,info.sha256);return blob&&blob.size<=LIMITS.file&&await blobHash(blob)===info.sha256?blob:null;})());
    const blob=await checked.get(info.sha256);return blob?.size===info.size?blob:null;
  }
  const entries=[];for await(const [hash,entry]of objects.entries()){fresh(isCurrent);if(entry.kind==='file'&&HASH.test(hash))entries.push([hash,entry]);}
  const candidates=new Array(entries.length);
  await bounded(entries,async([hash,entry],index)=>{
    const blob=entry.getFile?await entry.getFile():await read(objects,hash);if(!blob?.size||blob.size>LIMITS.json)return;
    if(!(await blob.slice(0,200).text()).includes('"score-desk-package"'))return;
    let manifest;try{manifest=strictJSON(await blob.text());}catch{return;}
    if(manifest.schema!=='score-desk-package'||manifest.version!==1||manifest.inputs?.source?.sha256!==sourceSha256||!manifest.payloads||typeof manifest.payloads!=='object'||Array.isArray(manifest.payloads))return;
    if(Object.keys(manifest.payloads).length>LIMITS.count||await blobHash(blob)!==hash)return;
    candidates[index]={hash,blob,manifest};
  },{isCurrent,onProgress,phase:'backfill',size:([hash])=>Math.min(sizes.get(hash)??0,LIMITS.json)});
  const packages=candidates.filter(Boolean);let done=0;onProgress({phase:'backfill-verify',done,total:packages.length});
  for(const {hash,blob,manifest}of packages){
    fresh(isCurrent);
    // Skip only exact locally reproducible bytes, never a claimed capture ID.
    if(!(manifest.recoveryCapture?(knownPackages.has(hash)||await knownCapture(manifest.recoveryCapture,hash)):known.has(signature(manifest.payloads)))){
      const payloads={'manifest.json':{sha256:hash,size:blob.size}},missingData=[];
      const declarations=Object.entries(manifest.payloads),valid=new Array(declarations.length);
      await bounded(declarations,async([path,info],index)=>{valid[index]=safe(path)&&Boolean(await object(info));},{isCurrent,size:([,info])=>info?.size??0});
      for(const [index,[path,info]]of declarations.entries()){if(valid[index])payloads[path]=info;else missingData.push('missing-or-invalid-payload:'+path);}
      if(payloads['annotations.json']){result.set('legacy-package:'+hash,{id:'legacy-package:'+hash,payloads,missingData});knownPackages.add(hash);if(!manifest.recoveryCapture)known.add(signature(manifest.payloads));}
    }
    onProgress({phase:'backfill-verify',done:++done,total:packages.length});
  }
  return [...result.values()];
}

// A durable intent authorizes exactly one read-back manifest, never an arbitrary
// descendant from another writer. Its parent remains the acknowledged CAS ID
// until publication is verified (including across a second interrupted retry).
export function recoveryPublicationIntent(snapshot){
  const m=snapshot.manifest;
  return {schema:'scorebrush-recovery-intent',version:1,id:m.id,manifestSha256:snapshot.manifestSha256,projectId:m.projectId,parent:m.parent,sourceSha256:m.sourceSha256,workspaceId:m.current};
}
export function reconcileRecoveryIntent(snapshot,config){
  const intent=config?.pendingRecoveryIntent;if(!intent)return config;
  // An interrupted successor can lack COMMIT; an acknowledged parent cannot.
  // Preserve that existing damage check before promoting a verified intent.
  if(snapshot?.damaged?.includes(config.recoveryId)||snapshot?.incomplete?.includes(config.recoveryId))throw new RecoveryConflict();
  if(intent.schema!=='scorebrush-recovery-intent'||intent.version!==1||!matches(ID,intent.id)||!matches(HASH,intent.manifestSha256)||!matches(ID,intent.projectId)||intent.parent!==null&&!matches(ID,intent.parent)||!matches(HASH,intent.sourceSha256)||typeof intent.workspaceId!=='string'||!intent.workspaceId.length||intent.workspaceId.length>200||config.projectId&&config.projectId!==intent.projectId||config.sourceSha256&&config.sourceSha256!==intent.sourceSha256||![intent.parent,intent.id].includes(config.recoveryId??null))throw new RecoveryConflict();
  if(snapshot?.manifest.id===intent.id){
    if(canonical(recoveryPublicationIntent(snapshot))!==canonical(intent))throw new RecoveryConflict();
    return {...config,recoveryId:intent.id,projectId:intent.projectId,pendingRecoveryIntent:null,resumeProof:null};
  }
  // An uncommitted intent may be replaced only while its acknowledged parent
  // is still current. Same-project or matching-review foreign work is not proof.
  if((snapshot?.manifest.id??null)!==intent.parent||snapshot?.damaged?.includes(intent.id))throw new RecoveryConflict();
  return config;
}
export async function saveRecovery(directory,scene,paths,{expected=null,projectId=null,pendingRecoveryIntent=null,beforeCommit=async()=>{},isCurrent=()=>true,head=null,onProgress=()=>{}}={}){
  const lock=async()=>{
    fresh(isCurrent);const options={isCurrent,onProgress},dir=await recoveryDir(directory,true),previous=await recoveryForWrite(directory,options);
    // A matching current review cannot prove that a damaged expected generation
    // contained no additional history. Keep that identity for explicit recovery.
    if(expected!==null&&(!ID.test(expected)||previous?.damaged?.includes(expected)))throw new RecoveryConflict();
    expected=reconcileRecoveryIntent(previous,{recoveryId:expected,projectId,sourceSha256:scene.review.files.source.sha256,pendingRecoveryIntent}).recoveryId;
    if(expected!==null&&previous?.manifest.id!==expected){
      let expectedDirectory;try{expectedDirectory=await dir.getDirectoryHandle('g-'+expected);}catch(e){if(e.name!=='NotFoundError')throw e;}
      // An existing expected generation with a missing marker is interrupted or
      // damaged, not evidence that an older matching review superseded it.
      if(expectedDirectory&&!(await read(expectedDirectory,'COMMIT.json'))?.size)throw new RecoveryConflict();
    }
    if((previous?.manifest.id??null)!==expected){if(await recoveryMatches(previous,scene))expected=previous.manifest.id;else throw new RecoveryConflict();}
    const sourceSha256=scene.review.files.source.sha256;if(previous&&previous.manifest.sourceSha256!==sourceSha256)throw new RecoveryConflict();
    const records=new Map((previous?.manifest.records??[]).map(r=>[r.id,r])),currentRecord={id:scene.workspaceId,review:scene.review,files:scene.files,returned:scene.returned??null,revisionId:scene.revisionId,completions:scene.completions??[]};
    const local=await getSaved(currentRecord.id);if(local&&recoveryIdentity(local)!==recoveryIdentity(currentRecord))throw new RecoveryConflict();
    currentRecord.storageRevision=local?.storageRevision??1;currentRecord.historyId=local?.historyId??null;currentRecord.historyPredecessorId=local?.historyPredecessorId??null;
    for(const field of ['projectId','initialTranscriptionFilename','parentWorkspaceId','journalVersion','pdfOutput','retainedLegacyEvidence','retainedHandoffEvidence'])if(local?.[field]!==undefined)currentRecord[field]=local[field];
    const reserve=await objectBudget(dir,options);reserve();const objectDirectory=reserve.directory??await dir.getDirectoryHandle('objects',{create:true});
    const related=await lineage(currentRecord),events=[...(await workspaceHistories(related.map(record=>record.id))).values()].flat(),history=await retainedList();
    const snapshots=new Set([...records.values(),...related,...events].map(r=>r.snapshotId??r.review.snapshotId));
    const backupCandidates=history.filter(e=>e.kind==='review-backup'&&e.review?.files.source.sha256===sourceSha256&&snapshots.has(e.review.snapshotId));
    const preparedPackages=new Map(),captures=new Map();
    for(const record of [...related,...events,...backupCandidates])captures.set(canonical(captureIdentity(record)),record);
    async function preparedPackage(record){
      if(!preparedPackages.has(record.id))preparedPackages.set(record.id,record.kind==='review-backup'?await capturedPackage(await makeRecovery(record.review,record.files),record,'review-backup'):await packageRecord(record));
      return preparedPackages.get(record.id);
    }
    const legacyEvidence=await backfillLegacy(dir,previous,sourceSha256,async(capture,hash)=>{
      const record=captures.get(canonical(capture));return Boolean(record)&&(await fileInfo((await preparedPackage(record)).get('manifest.json'))).sha256===hash;
    },{...options,directory:objectDirectory,sizes:reserve.sizes});
    const available=new Map(previous?.objects??[]);let written=0;
    async function storePayloads(payloads){
      const entries=[...payloads],prepared=new Array(entries.length);
      await bounded(entries,async([path,blob],index)=>{prepared[index]={path,blob,info:await fileInfo(blob)};},{isCurrent,size:([,blob])=>blob.size});
      // Retain path ordering, while one content hash can have several paths.
      // Admit every new object in this package before any write is started.
      const declarations={},pending=new Map();
      for(const item of prepared){
        const {path,info}=item;declarations[path]=info;
        const prior=available.get(info.sha256)??pending.get(info.sha256)?.blob;
        if(prior){if(prior.size!==info.size)fail('Recovery asset sizes disagree.');continue;}
        pending.set(info.sha256,item);
      }
      for(const {info}of pending.values())reserve(info);
      await bounded([...pending.values()],async({blob,info})=>{
        const existing=await read(objectDirectory,info.sha256);
        if(!existing||existing.size!==info.size||await blobHash(existing)!==info.sha256){await write(objectDirectory,info.sha256,blob);written++;}
        available.set(info.sha256,blob);
      },{isCurrent,size:({info})=>info.size});
      return declarations;
    }
    const inheritedEvidence=new Map();
    for(const record of related)for(const evidence of record.retainedLegacyEvidence??[]){
      const prior=legacyEvidence.find(b=>b.id===evidence.bundle.id)??inheritedEvidence.get(evidence.bundle.id)?.bundle;
      if(prior&&canonical(prior)!==canonical(evidence.bundle))fail('Conflicting retained legacy history. Keep the complete folder, profile and both backups; no evidence was replaced.');
      if(!prior)inheritedEvidence.set(evidence.bundle.id,evidence);
    }
    const backups=backupCandidates.filter(e=>!legacyEvidence.some(b=>b.legacyRecordId===e.id));
    const tasks=history.filter(e=>e.kind==='task'&&!e.task.shared&&e.review?.files.source.sha256===sourceSha256&&snapshots.has(e.review.snapshotId));if(head)tasks.push(head);
    const handoffs=new Map((previous?.manifest.handoffs??[]).map(h=>[h.id,h]));
    // Keep the exact committed task packages through a fresh-folder/ZIP restore,
    // even when this profile already retained a validated folder delivery.
    const inheritedHandoffs=new Map();
    for(const record of related)for(const evidence of record.retainedHandoffEvidence??[]){
      const prior=handoffs.get(evidence.bundle.id)??inheritedHandoffs.get(evidence.bundle.id)?.bundle;
      if(prior&&canonical(prior)!==canonical(evidence.bundle))throw new RecoveryConflict();
      if(!prior)inheritedHandoffs.set(evidence.bundle.id,evidence);
    }
    for(const [id,evidence]of inheritedHandoffs)handoffs.set(id,evidence.bundle);
    const taskIds=new Set([...handoffs.keys(),...tasks.map(t=>t.id)]),responses=history.filter(e=>e.kind==='response'&&taskIds.has(e.taskId));
    const handoffCount=new Set([...taskIds,...responses.map(e=>e.id)]).size;
    if(handoffCount>HISTORY_LIMITS.handoffs)throw new HistoryCapacityError(handoffCount+' handoffs; limit '+HISTORY_LIMITS.handoffs+'; current revision '+scene.revisionId);
    const recordIds=new Set([...records.keys(),...related.map(r=>r.id),...events.map(r=>r.id),...legacyEvidence.map(b=>b.id),...inheritedEvidence.keys()]);
    const checkRecordBudget=()=>{if(recordIds.size>HISTORY_LIMITS.records)throw new HistoryCapacityError(recordIds.size+' retained records; limit '+HISTORY_LIMITS.records+'; current revision '+scene.revisionId);};
    checkRecordBudget();
    // Count the exact packages that will be retained, not candidate backups:
    // repeated retained entries may resolve to an already protected package.
    // Prepare and hash before any asset writes so a logical overflow is atomic.
    const backupPackages=new Map();
    for(const backup of backups){
      fresh(isCurrent);const payloads=await preparedPackage(backup),id='legacy-package:'+(await fileInfo(payloads.get('manifest.json'))).sha256;
      if(recordIds.has(id))continue;
      recordIds.add(id);checkRecordBudget();backupPackages.set(id,{backup,payloads});
    }
    for(const evidence of inheritedHandoffs.values())if(canonical(await storePayloads(evidence.payloads))!==canonical(evidence.bundle.payloads))fail('Restored handoff evidence differs from its retained identity.');
    for(const evidence of inheritedEvidence.values()){
      const payloads=await storePayloads(evidence.payloads);
      if(canonical(payloads)!==canonical(evidence.bundle.payloads))fail('Restored legacy evidence differs from its retained identity.');
      legacyEvidence.push({...evidence.bundle,payloads});
    }
    for(const [id,{backup,payloads:prepared}]of backupPackages){
      const payloads=await storePayloads(prepared);
      legacyEvidence.push({id,legacyRecordId:backup.id,createdAt:backup.createdAt,payloads,missingData:['logical-revision-id-not-recorded','original-save-time-not-recorded']});
    }
    const reuseCurrent=await recoveryMatches(previous,scene);
    const recordList=[...related,...events];let processedRecords=0;onProgress({phase:'records',done:0,total:recordList.length});
    for(const record of recordList){
      fresh(isCurrent);onProgress({phase:'records',done:processedRecords,total:recordList.length});
      // Historical records already protected in the folder are immutable here.
      if(records.has(record.id)&&(record.kind||record.id!==currentRecord.id&&records.get(record.id).revisionId===record.revisionId)){processedRecords++;continue;}
      // Reconnection/derived-output repair may need a new task while the saved
      // review is identical. Keep its validated package bytes (and creation
      // metadata) instead of re-exporting the unchanged head on every repair.
      const declarations=record.id===currentRecord.id&&reuseCurrent?records.get(record.id).payloads:await storePayloads(await preparedPackage(record));
      records.set(record.id,{id:record.id,revisionId:record.revisionId,snapshotId:record.review.snapshotId,payloads:declarations,storageRevision:record.storageRevision??1,
        ...Object.fromEntries(['projectId','initialTranscriptionFilename','parentWorkspaceId','journalVersion','historyCoverage','resultingSnapshotId','resultingRenderSha256'].filter(k=>record[k]!==undefined).map(k=>[k,record[k]])),
        ...(['returned-event','review-event'].includes(record.kind)?{history:true,workspaceId:record.workspaceId,createdAt:record.createdAt,parentHistoryId:record.parentHistoryId??null}:{historyId:record.historyId??null,...(record.historyPredecessorId?{historyPredecessorId:record.historyPredecessorId}:{})})});processedRecords++;
    }
    onProgress({phase:'records',done:processedRecords,total:recordList.length});
    for(const task of tasks)if(!handoffs.has(task.id))handoffs.set(task.id,{id:task.id,kind:'task',payloads:await storePayloads(task.payloads)});
    for(const entry of history)if(entry.kind==='response'&&handoffs.has(entry.taskId)&&!handoffs.has(entry.id))handoffs.set(entry.id,{id:entry.id,kind:'response',taskId:entry.taskId,createdAt:entry.createdAt,payloads:await storePayloads(entry.payloads)});
    const id=crypto.randomUUID(),manifest={schema:SCHEMA,version:1,id,projectId:previous?.manifest.projectId??projectId??currentRecord.projectId??crypto.randomUUID(),initialTranscriptionFilename:previous?.manifest.initialTranscriptionFilename??currentRecord.initialTranscriptionFilename??null,parent:expected,sequence:(previous?.manifest.sequence??0)+1,createdAt:new Date().toISOString(),sourceSha256,paths,current:scene.workspaceId,records:[...records.values()],handoffs:[...handoffs.values()],headTaskId:head?.id??null,historyBackfillVersion:1,legacyEvidence,...(previous?.manifest.pdfOutput?{pdfOutput:previous.manifest.pdfOutput}:{})};checkManifest(manifest,id);
    for(const bundle of legacyEvidence)for(const info of Object.values(bundle.payloads))if(!available.has(info.sha256))available.set(info.sha256,await read(objectDirectory,info.sha256));
    if(!manifest.pdfOutput&&currentRecord.pdfOutput)manifest.pdfOutput=currentRecord.pdfOutput;
    manifest.pdfOutput=await preparePdfOutput(directory,{manifest,objects:available});
    manifest.initialTranscriptionFilename=manifest.pdfOutput.initialTranscriptionFilename;
    const blob=json(manifest);if(blob.size>LIMITS.json)throw new HistoryCapacityError('recovery metadata '+blob.size+' bytes; limit '+LIMITS.json);await write(dir,`g-${id}/snapshot.json`,blob);
    // Validate written bytes BEFORE publishing, keeping the old commit usable.
    const disk=await read(dir,`g-${id}/snapshot.json`);if(await blobHash(disk)!==await blobHash(blob))fail('Recovery write verification failed.');
    const verified=new Map();
    await bounded(assetInfos(manifest),async info=>{
      const asset=await read(objectDirectory,info.sha256);if(!asset||asset.size!==info.size)fail('Recovery asset write verification failed.');
      const bytes=await asset.arrayBuffer();if(await sha256(bytes)!==info.sha256)fail('Recovery asset write verification failed.');
      // Publish owned bytes from this exact read-back, never a live disk File.
      verified.set(info.sha256,new Blob([bytes]));
    },{...options,phase:'verify',size:info=>info.size});
    if(!isCurrent())fail('Recovery save superseded by a newer edit.');
    if(((await scanRecovery(directory,{assets:false}))?.manifest.id??null)!==expected||recoveryIdentity(await getSaved(currentRecord.id))!==recoveryIdentity(currentRecord))throw new RecoveryConflict();
    const manifestSha256=await blobHash(blob),intent=recoveryPublicationIntent({manifest,manifestSha256});
    await beforeCommit(intent);fresh(isCurrent);
    if(((await scanRecovery(directory,{assets:false}))?.manifest.id??null)!==expected||recoveryIdentity(await getSaved(currentRecord.id))!==recoveryIdentity(currentRecord))throw new RecoveryConflict();
    onProgress({phase:'commit',done:0,total:1});await write(dir,`g-${id}/COMMIT.json`,json({schema:SCHEMA,version:1,id,manifestSha256}));
    const committed=await scanRecovery(directory,{assets:false});if(!committed||canonical(recoveryPublicationIntent(committed))!==canonical(intent))throw new RecoveryConflict();committed.objects=verified;verifiedSnapshots.set(directory,committed);onProgress({phase:'commit',done:1,total:1});
    // Only remove validated ancestors, after complete read-back. Unique review
    // assets remain referenced by every new generation's historical records.
    const old=[];for(const prior of previous?.ids??[]){if(previous.damaged.includes(prior))continue;try{old.push(await loadGeneration(dir,prior,{assets:false}));}catch{/* Preserve corrupt evidence. */}}
    old.sort((a,b)=>b.manifest.sequence-a.manifest.sequence);
    let cleanupWarning='';try{
      for(const item of old.slice(2))await dir.removeEntry('g-'+item.manifest.id,{recursive:true});
      // Never delete shared objects here. Another profile can publish or reuse
      // one after any reachability scan, even after a final head recheck. Only
      // known ancestor metadata is pruned; the append-only store has a quota.
    }catch{cleanupWarning='Recovery is saved, but old recovery generations could not be pruned.';}
    return {id,projectId:manifest.projectId,written,cleanupWarning,snapshot:committed};
  };
  if(!globalThis.navigator?.locks)fail('This browser cannot safely coordinate folder recovery. Use current Edge or Chrome.');
  return navigator.locks.request('score-desk-recovery:'+scene.review.files.source.sha256,lock);
}

export async function decodeRecovery(snapshot,inspectPdf,{isCurrent=()=>true,onProgress=()=>{}}={}){
  let context={generationId:snapshot.manifest.id,phase:'decode'};
  try{
  // Every package still passes its complete integrity/annotation validation.
  // Inspect the same immutable PDF inputs once per decode, not once per edit.
  const inspect=inspectPdf,inspections=new Map(),hashes=new WeakMap();
  inspectPdf=async files=>{
    // Names and LilyPond/snapshot identities are validated by each package.
    // Only the exact PDF bytes determine this operation's PDF inspection.
    const key=JSON.stringify(await Promise.all(['source','rendered'].map(async role=>{
      const {blob}=files[role];if(!hashes.has(blob))hashes.set(blob,blobHash(blob));
      return await hashes.get(blob);
    })));
    if(!inspections.has(key))inspections.set(key,Promise.resolve().then(()=>inspect(files)));
    return structuredClone(await inspections.get(key));
  };
  const records=[],entries=new Map(),entryVariants=[];let done=0;const total=(snapshot.manifest.handoffs?.length??0)+snapshot.manifest.records.length;
  const decoding=item=>{fresh(isCurrent);context={generationId:snapshot.manifest.id,phase:'decode',recordId:item.id};onProgress({phase:'decode',done,total});};
  const decoded=()=>{fresh(isCurrent);onProgress({phase:'decode',done:++done,total});};
  const payloadsFor=item=>new Map(Object.entries(item.payloads).map(([path,info])=>[path,snapshot.objects.get(info.sha256)]));
  for(const item of snapshot.manifest.handoffs??[]){if(item.kind!=='task')continue;decoding(item);const task=await hydrateTaskPayloads(payloadsFor(item),inspectPdf,{expectedId:item.id});if(task.review.files.source.sha256!==snapshot.manifest.sourceSha256)fail('Recovery task project identity differs.');entries.set(task.id,task);decoded();}
  for(const item of snapshot.manifest.handoffs??[]){if(item.kind==='task')continue;decoding(item);if(item.kind!=='response'||typeof item.id!=='string'||!/^[-\w]{1,80}$/.test(item.id)||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt)))fail('Invalid recovery response metadata.');const parsed=await readResponsePayloads(payloadsFor(item),async id=>entries.get(id));if(parsed.issued.id!==item.taskId)fail('Recovery response task differs.');entries.set(item.id,{...responseRevision(parsed),id:item.id,createdAt:item.createdAt});decoded();}
  for(const item of snapshot.manifest.records){
    decoding(item);
    const payloads=payloadsFor(item);
    const parsed=await readPackagePayloads(payloads,inspectPdf),restored=await restoreReturnedBackup(parsed,inspectPdf);
    let round=null;if(restored){
      const original=strictJSON(await payloads.get('returned-workspace.json').text()).returned;round=original;
      for(const entry of [restored.issued,restored.entry]){
        const prior=entries.get(entry.id);if(prior&&canonical(prior.task??prior.response)!==canonical(entry.task??entry.response))fail('Conflicting retained recovery identity.');
        // A returned backup can embed a folder delivery of the same task. Its
        // prompt is a projection, not a replacement for the separately retained
        // immutable handoff. Both packages were validated; keep the original.
        if(!prior)entries.set(entry.id,entry);else entryVariants.push(entry);
      }
    }
    const history=item.history===true;if(history&&(!EVENT_ID.test(item.id)||item.id.startsWith('returned-event:')!==Boolean(round)||item.workspaceId!==(round?.id??parsed.review.snapshotId)||!Number.isSafeInteger(item.storageRevision)||item.storageRevision<1||typeof item.createdAt!=='string'||!Number.isFinite(Date.parse(item.createdAt))||item.parentHistoryId!==null&&!EVENT_ID.test(item.parentHistoryId)))fail('Invalid recovery decision history.');
    if(parsed.review.files.source.sha256!==snapshot.manifest.sourceSha256||parsed.review.snapshotId!==item.snapshotId||parsed.completionBundle?.revisionId!==item.revisionId||!history&&item.id!==(round?.id??parsed.review.snapshotId)||round&&(!/^returned:[\w:-]{1,180}$/.test(round.id)))fail('Recovery project or revision identity differs.');
    if(!history&&(item.storageRevision!==undefined&&(!Number.isSafeInteger(item.storageRevision)||item.storageRevision<1)||[item.historyId,item.historyPredecessorId].some(id=>id!=null&&!EVENT_ID.test(id))||item.historyId!=null&&item.historyPredecessorId!=null))fail('Invalid recovery history position.');
    if(['resultingSnapshotId','resultingRenderSha256'].some(field=>item[field]!==undefined&&!matches(HASH,item[field]))||item.projectId!==undefined&&!ID.test(item.projectId)||item.journalVersion!==undefined&&item.journalVersion!==1||item.parentWorkspaceId!=null&&(typeof item.parentWorkspaceId!=='string'||item.parentWorkspaceId.length>200)||item.initialTranscriptionFilename!=null&&(typeof item.initialTranscriptionFilename!=='string'||item.initialTranscriptionFilename.length>1000)||item.historyCoverage!==undefined&&!['durable-save','legacy-retained-state'].includes(item.historyCoverage))fail('Invalid recovery journal metadata.');
    records.push({id:item.id,review:parsed.review,files:parsed.files,returned:round,revisionId:item.revisionId,completions:parsed.completionBundle.records,
      ...(!history&&item.id===snapshot.manifest.current&&snapshot.manifest.handoffs?.length?{retainedHandoffEvidence:snapshot.manifest.handoffs.map(bundle=>({bundle,payloads:payloadsFor(bundle)}))}:{}),
      ...Object.fromEntries(['projectId','initialTranscriptionFilename','parentWorkspaceId','journalVersion','historyCoverage','resultingSnapshotId','resultingRenderSha256'].filter(k=>item[k]!==undefined).map(k=>[k,item[k]])),
      ...(!history?{projectId:item.projectId??snapshot.manifest.projectId,initialTranscriptionFilename:item.initialTranscriptionFilename??snapshot.manifest.initialTranscriptionFilename??null,...(snapshot.manifest.pdfOutput?{pdfOutput:snapshot.manifest.pdfOutput}:{}),...(item.id===snapshot.manifest.current&&snapshot.manifest.legacyEvidence?.length?{retainedLegacyEvidence:snapshot.manifest.legacyEvidence.map(bundle=>({bundle,payloads:payloadsFor(bundle)}))}:{})}:{}),
      ...(history?{kind:round?'returned-event':'review-event',workspaceId:item.workspaceId,historyId:item.id,storageRevision:item.storageRevision,createdAt:item.createdAt,parentHistoryId:item.parentHistoryId}:{storageRevision:item.storageRevision,historyId:item.historyId,historyPredecessorId:item.historyPredecessorId})});decoded();
  }
  for(const record of records.filter(r=>!r.kind)){
    fresh(isCurrent);context={generationId:snapshot.manifest.id,phase:'decode-history',recordId:record.id};
    const checkpoints=records.filter(r=>['returned-event','review-event'].includes(r.kind)&&r.workspaceId===record.id).sort((a,b)=>a.storageRevision-b.storageRevision),last=checkpoints.at(-1);
    if(record.storageRevision!==undefined&&record.storageRevision<(last?.storageRevision??1))fail('Recovery history position precedes its checkpoints.');
    if(record.historyId!=null){const head=checkpoints.find(r=>r.id===record.historyId);if(!head||head.storageRevision!==record.storageRevision||recoveryIdentity(head)!==recoveryIdentity(record))fail('Recovery history predecessor differs from the current review.');}
    if(record.historyPredecessorId!=null&&!checkpoints.some(r=>r.id===record.historyPredecessorId))fail('Recovery history predecessor is missing from this review.');
    // Older snapshots may have edits after their last retained checkpoint. Keep
    // that event as a predecessor, not an identical current-state checkpoint.
    // The next genuine edit links to it without inventing or renumbering events.
    record.storageRevision??=last?.storageRevision??1;
    if(record.historyId==null&&record.historyPredecessorId==null&&last){if(last.storageRevision===record.storageRevision&&recoveryIdentity(last)===recoveryIdentity(record))record.historyId=last.id;else record.historyPredecessorId=last.id;}
    record.historyId??=null;
  }
  return {records,entries:[...entries.values()],entryVariants};
  }catch(error){throw recoveryContext(error,context);}
}
export async function restoreRecovery(snapshot,inspectPdf,{allowLocal=false,isCurrent=()=>true,onProgress=()=>{}}={}){
  let context={generationId:snapshot.manifest.id,phase:'decode'};
  try{
  const decoded=await decodeRecovery(snapshot,inspectPdf,{isCurrent,onProgress}),missing=[];let checked=0;
  onProgress({phase:'reconcile',done:0,total:decoded.records.length});
  for(const record of decoded.records){fresh(isCurrent);context={generationId:snapshot.manifest.id,phase:'reconcile',recordId:record.id};const local=await getSaved(record.id);if(local&&recoveryIdentity(local)!==recoveryIdentity(record)){if(!allowLocal)throw new RecoveryConflict();}else missing.push(record);onProgress({phase:'reconcile',done:++checked,total:decoded.records.length});}
  context={generationId:snapshot.manifest.id,phase:'legacy-import'};

  // Reject inconsistent legacy imports before adding anything to either store.
  await checkLegacyImport(missing);
  // Immutable handoffs are restored before the atomic review transaction. An
  // interrupted import is idempotent; it never publishes half a review record.
  async function sameEntry(a,b){
    if(canonical(a.task??a.response)!==canonical(b.task??b.response)||a.payloads.size!==b.payloads.size)return false;
    for(const [path,blob]of b.payloads){const other=a.payloads.get(path);if(!other||other.size!==blob.size||await blobHash(other)!==await blobHash(blob))return false;}return true;
  }
  let handoffs=0;onProgress({phase:'handoffs',done:0,total:decoded.entries.length});
  for(const entry of decoded.entries){
    fresh(isCurrent);context={generationId:snapshot.manifest.id,phase:'handoffs',recordId:entry.id};
    const existing=await retained(entry.id);if(!existing){await retain(entry);onProgress({phase:'handoffs',done:++handoffs,total:decoded.entries.length});continue;}
    let matches=await sameEntry(existing,entry);
    // Older profiles retained the actual folder delivery. Accept only a
    // byte-exact variant validated from this recovery, never overwrite it.
    if(!matches)for(const variant of decoded.entryVariants.filter(v=>v.id===entry.id))if(await sameEntry(existing,variant)){matches=true;break;}
    if(!matches)throw new RecoveryConflict();onProgress({phase:'handoffs',done:++handoffs,total:decoded.entries.length});
  }
  fresh(isCurrent);context={generationId:snapshot.manifest.id,phase:'restore'};onProgress({phase:'restore',done:0,total:missing.length});
  await restoreMissing(missing);onProgress({phase:'restore',done:missing.length,total:missing.length});return snapshot.manifest.current;
  }catch(error){throw recoveryContext(error,context);}
}
