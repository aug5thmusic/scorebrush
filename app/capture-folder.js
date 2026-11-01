// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Inactive owned-folder foundation. No picker, native access, DB opener or UI hooks.
import {canonicalCaptureJson,sha256CaptureBytes} from './capture-format.js';
import {verifyCapturePublication,assertCapturePublicationAttemptAllowed} from './capture-publication.js';
import {prepareCaptureRepair,readCaptureRepair,acknowledgeCaptureRepair} from './capture-repair.js';
import {initializeCapturePool,reconcileCapturePool,readCapturePoolStatus,getCapturePoolAttempt,preflightCapturePool,admitCapturePool,completeCapturePool} from './capture-pool.js';

export const CAPTURE_FOLDER_LIMITS=Object.freeze({status:'PROPOSED_NOT_ACTIVE_PRODUCT_LIMITS',currentBytes:25*1024*1024,objectBytes:100*1024*1024,packBytes:512*1024,objects:5000,targetBytes:512*1024*1024,controlBytes:16384,ownerBytes:1024});
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const HASH=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENT='current-review.json',PRIOR='previous-current-review.json',INTENT='repair-intent.json',ACK='repair-ack.json';
export class CaptureFolderError extends Error{constructor(code,message){super(message);this.name='CaptureFolderError';this.code=code;}}
const fail=(code,message)=>{throw new CaptureFolderError(code,message);};
const check=(ok,message,code='CAPTURE_FOLDER_INTEGRITY')=>{if(!ok)fail(code,message);};
const equal=(a,b)=>canonicalCaptureJson(a)===canonicalCaptureJson(b);
const keys=(v,names)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...names].sort().join('|');
const missing=e=>e?.name==='NotFoundError';
const hash=async v=>sha256CaptureBytes(v);
const encoded=v=>encoder.encode(canonicalCaptureJson(v));
const hook=async(fault,phase,detail={})=>{if(fault)await fault(phase,Object.freeze({...detail}));};
function destinationCopy(value){
  check(keys(value,['projectId','destinationId','conversionId','ownerHash','activationHash']),'Exact explicit destination identity is required.');
  for(const k of ['projectId','destinationId','conversionId'])check(UUID.test(value[k]),'Invalid destination '+k+'.');
  for(const k of ['ownerHash','activationHash'])check(HASH.test(value[k]),'Invalid destination '+k+'.');
  return {...value};
}
function objectPath(path){
  check(typeof path==='string'&&/^(?:objects\/[0-9a-f]{64}\.bin|packs\/[0-9a-f]{64}\.json)$/.test(path),'Unsafe or unsupported immutable object path.');
  return path;
}
function objectReference(ref){
  check(keys(ref,['path','sha256','bytes'])&&HASH.test(ref.sha256)&&Number.isSafeInteger(ref.bytes)&&ref.bytes>=0,'Invalid immutable object reference.');
  objectPath(ref.path);check(ref.path.includes(ref.sha256),'Object path must contain its exact hash.');
  check(ref.bytes<=(ref.path.startsWith('packs/')?CAPTURE_FOLDER_LIMITS.packBytes:CAPTURE_FOLDER_LIMITS.objectBytes),'Immutable object exceeds admitted bytes.','CAPTURE_FOLDER_CAPACITY');return ref;
}
async function fileHandle(directory,path,create=false){
  const parts=path.split('/');let parent=directory;
  for(const part of parts.slice(0,-1))parent=await parent.getDirectoryHandle(part,{create});
  return parent.getFileHandle(parts.at(-1),{create});
}
async function readFile(directory,path,limit,{optional=false}={}){
  try{const handle=await fileHandle(directory,path),file=await handle.getFile();check(file.size<=limit,'File exceeds bounded read: '+path,'CAPTURE_FOLDER_CAPACITY');const data=new Uint8Array(await file.arrayBuffer());check(data.length===file.size,'File changed size during read.');return {bytes:data,size:data.length,sha256:await hash(data)};}
  catch(e){if(optional&&missing(e))return null;throw e;}
}
function parse(raw,label){try{return JSON.parse(decoder.decode(raw.bytes));}catch{fail('CAPTURE_FOLDER_INTEGRITY','Invalid UTF-8 JSON in '+label+'.');}}
async function ensurePermission(directory,write){
  check(directory?.kind==='directory'&&typeof directory.getDirectoryHandle==='function','Explicit directory handle is required.','CAPTURE_FOLDER_AUTHORITY');
  if(typeof directory.queryPermission==='function')check(await directory.queryPermission({mode:write?'readwrite':'read'})==='granted','Existing directory permission is required.','CAPTURE_FOLDER_PERMISSION');
}
async function authority(directory,destination,write=false){
  await ensurePermission(directory,write);
  try{await directory.getDirectoryHandle('.score-desk');fail('CAPTURE_FOLDER_AUTHORITY','Legacy .score-desk conflicts with research authority.');}catch(e){if(!missing(e))throw e;}
  const owned=await directory.getDirectoryHandle('.scorebrush'),ownerRaw=await readFile(owned,'OWNER.json',CAPTURE_FOLDER_LIMITS.ownerBytes),owner=parse(ownerRaw,'OWNER2');
  check(ownerRaw.sha256===destination.ownerHash,'OWNER2 bytes differ from the explicit authority pin.','CAPTURE_FOLDER_AUTHORITY');
  check(keys(owner,['schema','version','projectId','conversionId','planSha256'])&&owner.schema==='private-score-desk-folder'&&owner.version===2&&owner.projectId===destination.projectId&&owner.conversionId===destination.conversionId&&HASH.test(owner.planSha256),'Unsupported or foreign OWNER2.','CAPTURE_FOLDER_AUTHORITY');
  const capture=await owned.getDirectoryHandle('capture'),manifestRaw=await readFile(capture,'activation/manifest.json',CAPTURE_FOLDER_LIMITS.controlBytes),commitRaw=await readFile(capture,'activation/COMMIT.json',CAPTURE_FOLDER_LIMITS.controlBytes),manifest=parse(manifestRaw,'activation manifest'),commit=parse(commitRaw,'activation COMMIT');
  check(commitRaw.sha256===destination.activationHash,'Activation COMMIT differs from its explicit pin.','CAPTURE_FOLDER_AUTHORITY');
  check(keys(manifest,['schema','version','projectId','destinationId','conversionId','planSha256','initialHeadHash'])&&manifest.schema==='scorebrush-capture-activation-seed'&&manifest.version===1&&manifest.projectId===destination.projectId&&manifest.destinationId===destination.destinationId&&manifest.conversionId===destination.conversionId&&manifest.planSha256===owner.planSha256&&HASH.test(manifest.initialHeadHash),'Unsupported or foreign synthetic activation manifest.','CAPTURE_FOLDER_AUTHORITY');
  check(keys(commit,['schema','version','projectId','destinationId','conversionId','manifestSha256','initialHeadHash'])&&commit.schema==='scorebrush-capture-activation-commit'&&commit.version===1&&commit.projectId===destination.projectId&&commit.destinationId===destination.destinationId&&commit.conversionId===destination.conversionId&&commit.manifestSha256===manifestRaw.sha256&&commit.initialHeadHash===manifest.initialHeadHash,'Incomplete or conflicting activation.','CAPTURE_FOLDER_AUTHORITY');
  return {capture,owner,manifest,commit,controlBytes:ownerRaw.size+manifestRaw.size+commitRaw.size};
}
async function withLock(directory,destination,operation){
  check(globalThis.navigator?.locks&&typeof navigator.locks.request==='function','Origin Web Locks are unavailable.','CAPTURE_FOLDER_COORDINATION');
  return navigator.locks.request('scorebrush-capture:'+destination.projectId+':'+destination.destinationId,{mode:'exclusive'},async()=>{
    const initial=await authority(directory,destination,true),lock=await initial.capture.getFileHandle('write.lock',{create:true});let writer,probe;
    try{
      writer=await lock.createWritable({mode:'exclusive'});
      // Ignoring an unknown mode option must not silently authorize publication.
      let exclusive=false;try{probe=await lock.createWritable({mode:'exclusive'});}catch(e){exclusive=['NoModificationAllowedError','NotAllowedError'].includes(e?.name);}
      if(probe){await probe.abort();probe=null;}
      check(exclusive,'Exclusive writable coordination is unsupported.','CAPTURE_FOLDER_COORDINATION');
      const fresh=await authority(directory,destination,true);return await operation(fresh);
    }finally{if(probe)try{await probe.abort();}catch{}if(writer)try{await writer.abort();}catch{}}
  });
}
async function writeExact(capture,path,data,{immutable=false,fault,phase='write'}={}){
  check(data instanceof Uint8Array,'Owned bytes required for folder write.');
  const old=await readFile(capture,path,data.length>CAPTURE_FOLDER_LIMITS.controlBytes?CAPTURE_FOLDER_LIMITS.objectBytes:CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true});
  const digest=await hash(data);
  if(immutable&&old){check(old.size===data.length&&old.sha256===digest,'Existing immutable/control bytes conflict: '+path,'CAPTURE_FOLDER_CONFLICT');return {written:0,reused:data.length};}
  await hook(fault,phase+'.before',{path});const handle=await fileHandle(capture,path,true);let writable;
  try{writable=await handle.createWritable({mode:'exclusive'});await writable.write(data);await hook(fault,phase+'.write',{path});await writable.close();writable=null;await hook(fault,phase+'.after-close',{path});}
  finally{if(writable)try{await writable.abort();}catch{}}
  const actual=await readFile(capture,path,data.length);check(actual.size===data.length&&actual.sha256===digest,'Written bytes failed readback: '+path,'CAPTURE_FOLDER_READBACK');await hook(fault,phase+'.after',{path});return {written:data.length,reused:0};
}
async function readObject(capture,ref){objectReference(ref);const raw=await readFile(capture,ref.path,ref.bytes);check(raw.size===ref.bytes&&raw.sha256===ref.sha256,'Immutable closure bytes differ: '+ref.path);return raw.bytes;}
async function verified(capture,raw,destination,full){
  check(raw,'Capture current is missing.','CAPTURE_FOLDER_RECOVERY_REQUIRED');
  const envelope=parse(raw,'capture envelope');check(!(envelope?.projectId&&envelope.projectId!==destination.projectId)&&!(envelope?.destinationId&&envelope.destinationId!==destination.destinationId),'Envelope project/destination identity differs.','CAPTURE_FOLDER_CONFLICT');
  const result=await verifyCapturePublication(raw.bytes,ref=>readObject(capture,ref),{full});
  check(result&&typeof result==='object'&&envelope?.projectId===destination.projectId&&envelope?.destinationId===destination.destinationId,'Publication verifier returned no matching verified result.');
  return {...result,envelopeHash:raw.sha256,envelopeBytes:new Uint8Array(raw.bytes)};
}
function validateRepairIntent(value,destination){
  const replay=value?.version===2,fields=['schema','version','repairId','projectId','destinationId','ownerHash','activationHash','observedCurrent','priorHash','targetHash','targetObject','gapNotice','allowEmptyCreation','corruptObject',...(replay?['policy']:[])];
  check(keys(value,fields)&&value.schema==='scorebrush-capture-repair'&&(replay?value.policy==='exact-local-replay'&&HASH.test(value.targetHash)&&value.gapNotice==='Exact retained local state recovered.':value.version===1&&value.targetHash===value.priorHash&&value.gapNotice==='Recovered prior state; newer work may be missing.')&&UUID.test(value.repairId)&&value.projectId===destination.projectId&&value.destinationId===destination.destinationId&&value.ownerHash===destination.ownerHash&&value.activationHash===destination.activationHash&&HASH.test(value.priorHash)&&value.allowEmptyCreation===(value.observedCurrent===null),'Invalid or foreign repair intent.','CAPTURE_FOLDER_REPAIR_CONFLICT');
  check(value.observedCurrent===null||keys(value.observedCurrent,['sha256','bytes'])&&HASH.test(value.observedCurrent.sha256)&&Number.isSafeInteger(value.observedCurrent.bytes)&&value.observedCurrent.bytes>=0&&value.observedCurrent.bytes<=CAPTURE_FOLDER_LIMITS.currentBytes,'Invalid repair source fingerprint.');
  objectReference(value.targetObject);check(value.targetObject.sha256===value.targetHash&&value.targetObject.bytes<=CAPTURE_FOLDER_LIMITS.currentBytes,'Repair target envelope reference differs.');if(value.corruptObject!==null)objectReference(value.corruptObject);
  check(value.observedCurrent===null?value.corruptObject===null:value.corruptObject?.sha256===value.observedCurrent.sha256&&value.corruptObject.bytes===value.observedCurrent.bytes,'Repair raw-evidence reference differs.');return value;
}
function validateRepairAck(value,intent,intentHash){
  check(keys(value,['schema','version','repairId','projectId','destinationId','intentHash','targetHash','gapNotice','recoveredThrough'])&&value.schema==='scorebrush-capture-repair-ack'&&value.version===1&&value.repairId===intent.repairId&&value.projectId===intent.projectId&&value.destinationId===intent.destinationId&&value.intentHash===intentHash&&value.targetHash===intent.targetHash&&value.gapNotice===intent.gapNotice&&value.recoveredThrough&&typeof value.recoveredThrough==='object','Invalid or conflicting repair acknowledgement.','CAPTURE_FOLDER_REPAIR_CONFLICT');return value;
}
async function repairBarrier(capture,destination){
  const raw=await readFile(capture,INTENT,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true}),ackRaw=await readFile(capture,ACK,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true});
  if(!raw){check(!ackRaw,'Orphan repair acknowledgement blocks publication.','CAPTURE_FOLDER_REPAIR_REQUIRED');return null;}
  const intent=validateRepairIntent(parse(raw,INTENT),destination);check(ackRaw,'Unresolved repair blocks ordinary publication.','CAPTURE_FOLDER_REPAIR_REQUIRED');
  const ack=validateRepairAck(parse(ackRaw,ACK),intent,raw.sha256),targetBytes=await readObject(capture,intent.targetObject),target=parse({bytes:targetBytes},'retained repair target');
  check(target?.projectId===destination.projectId&&target?.destinationId===destination.destinationId&&equal(ack.recoveredThrough,target.current?.frontier),'Repair acknowledgement frontier differs from the retained exact target.','CAPTURE_FOLDER_REPAIR_CONFLICT');if(intent.corruptObject)await readObject(capture,intent.corruptObject);return ack;
}
async function currentRaw(capture){return readFile(capture,CURRENT,CAPTURE_FOLDER_LIMITS.currentBytes,{optional:true});}
const fingerprint=raw=>raw?{sha256:raw.sha256,bytes:raw.size}:null;
async function checkExpected(capture,destination,expectedHead,initialAllowed){
  const current=await currentRaw(capture);
  if(!current){check(initialAllowed&&expectedHead===null,'Missing current requires explicit prior recovery.','CAPTURE_FOLDER_RECOVERY_REQUIRED');return null;}
  check(expectedHead!==null&&current.sha256===expectedHead,'Destination head changed.','CAPTURE_FOLDER_CONFLICT');await verified(capture,current,destination,false);return current;
}

// The caller first durably pins an attempt in the publication module. This API
// neither opens a database nor treats a callback being scheduled as an ack.
export async function initializeCaptureFolderPool({directory,destination,fault}={}){
  const owned=destinationCopy(destination);
  return withLock(directory,owned,()=>initializeCapturePool({directory,destination:owned,fault}));
}
export async function reconcileCaptureFolderPool({directory,destination,fault}={}){
  const owned=destinationCopy(destination);
  return withLock(directory,owned,()=>reconcileCapturePool({directory,destination:owned,fault}));
}
export async function readCaptureFolderPoolStatus({directory,destination}={}){
  const owned=destinationCopy(destination);
  return withLock(directory,owned,()=>readCapturePoolStatus({directory,destination:owned}));
}
const poolObject=object=>({path:'capture/'+object.path,sha256:object.sha256,bytes:object.size??object.bytes});
const poolFile=(path,raw)=>({path:'capture/'+path,sha256:raw.sha256,bytes:raw.size});
async function admitRepairPool(directory,destination,intent,intentBytes,ack,prior,objects,fault,preflightOnly=false){
  const ackBytes=encoded(ack);
  return (preflightOnly?preflightCapturePool:admitCapturePool)({directory,destination,attempt:{kind:'repair',attemptId:intent.repairId,expectedCurrent:intent.observedCurrent,targetHash:intent.targetHash,immutable:objects.map(poolObject),finalFiles:[{path:'capture/'+CURRENT,sha256:intent.targetHash,bytes:intent.targetObject.bytes},poolFile(PRIOR,prior),{path:'capture/'+INTENT,sha256:await hash(intentBytes),bytes:intentBytes.length},{path:'capture/'+ACK,sha256:await hash(ackBytes),bytes:ackBytes.length}]},fault});
}
async function admitPublicationPool(directory,destination,target,current,fault){
  const finalFiles=[{path:'capture/'+CURRENT,sha256:target.envelopeHash,bytes:target.envelopeBytes.length},...(current?[poolFile(PRIOR,current)]:[])];
  return admitCapturePool({directory,destination,attempt:{kind:'publication',attemptId:target.attemptId,expectedCurrent:fingerprint(current),targetHash:target.envelopeHash,immutable:target.objects.map(poolObject),finalFiles},fault});
}
async function completeVisiblePublicationPool(directory,destination,target,fault){
  const existing=await getCapturePoolAttempt({directory,destination,attemptId:target.attemptId,targetHash:target.envelopeHash});
  if(existing)return completeCapturePool({directory,destination,attemptId:target.attemptId,targetHash:target.envelopeHash,fault});
  // Explicit initialization/reconciliation or proven replay may already account
  // this exact visible envelope. There are no folder allocations on this path.
  const accounting=await readCapturePoolStatus({directory,destination});
  check(!accounting.poolTotalUnknown&&accounting.targetHash===target.envelopeHash,'Visible target lacks a completed matching pool commitment.','CAPTURE_POOL_RECONCILE_REQUIRED');
  return {status:'already-accounted-visible-target',accounting};
}
export async function publishCaptureFolder({directory,destination,attempt,acknowledge,fault}={}){
  const ownedDestination=destinationCopy(destination);check(typeof acknowledge==='function','Exact local acknowledgement callback is required.');
  check(attempt&&UUID.test(attempt.attemptId)&&attempt.projectId===ownedDestination.projectId&&attempt.destinationId===ownedDestination.destinationId&&(attempt.expectedHead===null||HASH.test(attempt.expectedHead))&&HASH.test(attempt.envelopeHash),'Invalid publication attempt.');
  check(keys(attempt.destination,['projectId','destinationId','conversionId','ownerHash','activationHash','expectedHead'])&&equal(attempt.destination,{...ownedDestination,expectedHead:attempt.expectedHead}),'Publication attempt authority differs from the explicit granted destination.','CAPTURE_FOLDER_AUTHORITY');
  check(attempt.envelopeBytes instanceof Uint8Array&&attempt.envelopeBytes.length<=CAPTURE_FOLDER_LIMITS.currentBytes,'Pinned envelope exceeds admission.','CAPTURE_FOLDER_CAPACITY');
  const envelopeBytes=new Uint8Array(attempt.envelopeBytes),identity={attemptId:attempt.attemptId,projectId:attempt.projectId,destinationId:attempt.destinationId,expectedHead:attempt.expectedHead,envelopeHash:attempt.envelopeHash};
  const pinned=parse({bytes:envelopeBytes},'pinned publication envelope');check(pinned.attemptId===identity.attemptId&&pinned.projectId===identity.projectId&&pinned.destinationId===identity.destinationId&&pinned.expectedHead===identity.expectedHead,'Attempt identity/head differs from its exact envelope.','CAPTURE_FOLDER_CONFLICT');
  check(Array.isArray(attempt.objects)&&attempt.objects.length<=CAPTURE_FOLDER_LIMITS.objects,'Immutable target object count exceeds admission.','CAPTURE_FOLDER_CAPACITY');
  const objects=[],paths=new Set();let proposedBytes=0;
  // Copy all mutable wrappers/typed arrays before the first asynchronous hash.
  for(const item of attempt.objects){objectReference({path:item.path,sha256:item.sha256,bytes:item.size});check(!paths.has(item.path),'Duplicate immutable target path.');paths.add(item.path);check(item.bytes instanceof Blob&&item.bytes.size===item.size||item.bytes instanceof Uint8Array&&item.bytes.length===item.size,'Pinned immutable size/type differs.');proposedBytes+=item.size;check(proposedBytes<=CAPTURE_FOLDER_LIMITS.targetBytes,'Immutable target bytes exceed admission.','CAPTURE_FOLDER_CAPACITY');objects.push({path:item.path,sha256:item.sha256,size:item.size,body:item.bytes instanceof Blob?item.bytes:new Uint8Array(item.bytes)});}
  check(await hash(envelopeBytes)===identity.envelopeHash,'Pinned envelope hash differs.');
  for(const item of objects){if(item.body instanceof Blob)item.body=new Uint8Array(await item.body.arrayBuffer());check(await hash(item.body)===item.sha256,'Pinned immutable bytes differ.');}
  const target={...identity,envelopeBytes,objects};
  const guardedTarget={...identity,destination:{...ownedDestination,expectedHead:identity.expectedHead},objects:objects.map(object=>({path:object.path,sha256:object.sha256,bytes:object.size}))};
  return withLock(directory,ownedDestination,async({capture,commit,controlBytes})=>{
    await assertCapturePublicationAttemptAllowed(attempt,guardedTarget);
    const recovery=await repairBarrier(capture,ownedDestination),present=await currentRaw(capture);
    if(present?.sha256===target.envelopeHash){const result=await verified(capture,present,ownedDestination,false),pool=await completeVisiblePublicationPool(directory,ownedDestination,target,fault);await hook(fault,'ack.before');const acknowledgement=await acknowledge({attemptId:target.attemptId,envelopeHash:target.envelopeHash,destinationId:ownedDestination.destinationId});await hook(fault,'ack.after');return {status:'already-published',publicationSucceeded:true,acknowledgement,verified:result,recovery,accounting:{newImmutableBytes:0,currentBytes:present.size,poolAccounting:pool.accounting,poolTotalUnknown:pool.accounting.poolTotalUnknown}};}
    const initialAllowed=commit.initialHeadHash===target.envelopeHash&&target.expectedHead===null;
    const priorCurrent=await checkExpected(capture,ownedDestination,target.expectedHead,initialAllowed),priorOld=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes,{optional:true});
    if(!priorCurrent)check(!priorOld&&!recovery,'Initial activation completion cannot replace a missing evolved current.','CAPTURE_FOLDER_RECOVERY_REQUIRED');
    await admitPublicationPool(directory,ownedDestination,target,priorCurrent,fault);
    let newImmutableBytes=0,reusedImmutableBytes=0;
    for(const object of objects){const out=await writeExact(capture,object.path,object.body,{immutable:true,fault,phase:'immutable'});newImmutableBytes+=out.written;reusedImmutableBytes+=out.reused;}
    await verified(capture,{bytes:envelopeBytes,size:envelopeBytes.length,sha256:target.envelopeHash},ownedDestination,false);
    await authority(directory,ownedDestination,true);await checkExpected(capture,ownedDestination,target.expectedHead,initialAllowed);
    if(priorCurrent){await writeExact(capture,PRIOR,priorCurrent.bytes,{fault,phase:'prior'});const actualPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);check(actualPrior.sha256===priorCurrent.sha256,'Prior replacement differs.');await verified(capture,actualPrior,ownedDestination,false);}
    await hook(fault,'current.before');let writable,createdMissing=false;
    try{
      if(!priorCurrent){check(!await currentRaw(capture),'Initially absent current appeared.','CAPTURE_FOLDER_CONFLICT');createdMissing=true;}
      const handle=await capture.getFileHandle(CURRENT,{create:true});writable=await handle.createWritable({mode:'exclusive'});await writable.write(envelopeBytes);await hook(fault,'current.write');
      await hook(fault,'current.before-close');await assertCapturePublicationAttemptAllowed(attempt,guardedTarget);await authority(directory,ownedDestination,true);const beforeClose=await currentRaw(capture);
      check(priorCurrent?beforeClose?.sha256===priorCurrent.sha256:createdMissing&&beforeClose?.size===0,'Current changed while replacement was staged.','CAPTURE_FOLDER_CONFLICT');
      await writable.close();writable=null;await hook(fault,'current.after-close');
    }finally{if(writable)try{await writable.abort();}catch{}}
    const actual=await currentRaw(capture);check(actual?.sha256===target.envelopeHash,'Current failed exact authoritative readback.','CAPTURE_FOLDER_READBACK');const result=await verified(capture,actual,ownedDestination,false);await hook(fault,'current.readback');
    const pool=await completeCapturePool({directory,destination:ownedDestination,attemptId:target.attemptId,targetHash:target.envelopeHash,fault});
    await hook(fault,'ack.before');const acknowledgement=await acknowledge({attemptId:target.attemptId,envelopeHash:target.envelopeHash,destinationId:ownedDestination.destinationId});await hook(fault,'ack.after');
    const oldCurrentBytes=priorCurrent?.size??0,oldPriorBytes=priorOld?.size??0,newPriorBytes=oldCurrentBytes;
    return {status:'published',publicationSucceeded:true,acknowledgement,verified:result,recovery,accounting:{declaredImmutableBytes:proposedBytes,newImmutableBytes,reusedImmutableBytes,currentBytes:actual.size,priorBytes:newPriorBytes,authorityControlBytes:controlBytes,browserReplacementAdditionalBytes:Math.max(oldCurrentBytes+oldPriorBytes+newPriorBytes,3*oldCurrentBytes,oldCurrentBytes+newPriorBytes+actual.size),poolAccounting:pool.accounting,poolTotalUnknown:pool.accounting.poolTotalUnknown,physicalAllocationMeasured:false}};
  });
}

// Full recovery/reader verifies declared history directly from folder files.
// No database row, native binding, persisted grant or trusted flag is imported.
export async function readCaptureFolder({directory,destination,selection='current'}={}){
  const owned=destinationCopy(destination);check(['current','prior'].includes(selection),'Unsupported snapshot selection.');const {capture}=await authority(directory,owned),recovery=await repairBarrier(capture,owned),raw=await readFile(capture,selection==='current'?CURRENT:PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes),result=await verified(capture,raw,owned,true);await authority(directory,owned);
  return {...result,selection,recovery,source:'verified-folder-only',nativeBindingsImported:false,newerWorkMayBeMissing:selection==='prior'||recovery?.gapNotice==='Recovered prior state; newer work may be missing.'};
}

// Explicit fresh-profile prior recovery. It does not restore application storage
// or acknowledge absent/newer local work. Fixed controls are never recycled here.
export async function recoverCaptureFolderPrior({directory,destination,repairId,fault}={}){
  const owned=destinationCopy(destination);check(UUID.test(repairId),'Stable explicit repair ID is required.');
  return withLock(directory,owned,async({capture})=>{
    const raw=await currentRaw(capture),prior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);await verified(capture,prior,owned,true);
    check(raw===null||raw.size>0,'A pre-existing empty current is ambiguous after lock loss; preserve it for separate-destination recovery.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    const oldIntentRaw=await readFile(capture,INTENT,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true}),oldAckRaw=await readFile(capture,ACK,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true});
    let intent;if(oldIntentRaw){intent=validateRepairIntent(parse(oldIntentRaw,INTENT),owned);check(intent.version===1&&intent.repairId===repairId&&intent.priorHash===prior.sha256,'Repair intent/prior changed or requires same-profile replay reconciliation.','CAPTURE_FOLDER_REPAIR_CONFLICT');}
    else{check(!oldAckRaw,'Orphan acknowledgement blocks repair.','CAPTURE_FOLDER_REPAIR_CONFLICT');intent={schema:'scorebrush-capture-repair',version:1,repairId,projectId:owned.projectId,destinationId:owned.destinationId,ownerHash:owned.ownerHash,activationHash:owned.activationHash,observedCurrent:fingerprint(raw),priorHash:prior.sha256,targetHash:prior.sha256,targetObject:{path:'objects/'+prior.sha256+'.bin',sha256:prior.sha256,bytes:prior.size},gapNotice:'Recovered prior state; newer work may be missing.',allowEmptyCreation:raw===null,corruptObject:raw?{path:'objects/'+raw.sha256+'.bin',sha256:raw.sha256,bytes:raw.size}:null};}
    if(oldAckRaw){validateRepairAck(parse(oldAckRaw,ACK),intent,oldIntentRaw.sha256);check(raw?.sha256===intent.targetHash,'A completed repair slot cannot repair a later changed head.','CAPTURE_FOLDER_REPAIR_CONFLICT');}
    let validCurrent=false;if(raw)try{await verified(capture,raw,owned,true);validCurrent=true;}catch(e){if(e.code==='CAPTURE_FOLDER_CONFLICT')throw e;}
    if(validCurrent)check(oldIntentRaw&&raw.sha256===intent.targetHash,'A valid changed current cannot be replaced by prior.','CAPTURE_FOLDER_CONFLICT');
    else check(equal(fingerprint(raw),intent.observedCurrent),'Invalid current changed since the repair intent.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    const intentBytes=encoded(intent),intentHash=await hash(intentBytes);check(intentBytes.length<=CAPTURE_FOLDER_LIMITS.controlBytes,'Repair intent exceeds admission.');
    if(oldIntentRaw)check(oldIntentRaw.sha256===intentHash,'Repair intent serialization differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    const recoveredThrough=parse(prior,'prior envelope').current?.frontier;check(recoveredThrough,'Recovered semantic frontier missing.');
    const ack={schema:'scorebrush-capture-repair-ack',version:1,repairId,projectId:owned.projectId,destinationId:owned.destinationId,intentHash,targetHash:prior.sha256,gapNotice:intent.gapNotice,recoveredThrough};
    if(oldAckRaw)check(oldAckRaw.sha256===await hash(encoded(ack)),'Existing repair acknowledgement differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    await admitRepairPool(directory,owned,intent,intentBytes,ack,prior,[intent.targetObject,...(intent.corruptObject?[intent.corruptObject]:[])],fault);
    await writeExact(capture,intent.targetObject.path,prior.bytes,{immutable:true,fault,phase:'repair.target'});
    if(raw&&!validCurrent)await writeExact(capture,intent.corruptObject.path,raw.bytes,{immutable:true,fault,phase:'repair.corrupt'});
    if(!oldIntentRaw)await writeExact(capture,INTENT,intentBytes,{immutable:true,fault,phase:'repair.intent'});
    if(!validCurrent){
      await hook(fault,'repair.current.before');await authority(directory,owned,true);const latest=await currentRaw(capture),latestPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);check(equal(fingerprint(latest),intent.observedCurrent)&&latestPrior.sha256===prior.sha256,'Recovery authority changed before replacement.','CAPTURE_FOLDER_CONFLICT');
      let writable,createdMissing=false;try{
        if(latest===null)createdMissing=true;
        const handle=await capture.getFileHandle(CURRENT,{create:true});writable=await handle.createWritable({mode:'exclusive'});await writable.write(prior.bytes);await hook(fault,'repair.current.write');
        await hook(fault,'repair.current.before-close');await authority(directory,owned,true);const recheck=await currentRaw(capture),recheckPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);check((createdMissing?recheck?.size===0:equal(fingerprint(recheck),intent.observedCurrent))&&recheckPrior.sha256===prior.sha256,'Recovery source changed while replacement was staged.','CAPTURE_FOLDER_CONFLICT');
        await writable.close();writable=null;await hook(fault,'repair.current.after-close');
      }finally{if(writable)try{await writable.abort();}catch{}}
    }
    const target=await currentRaw(capture);check(target?.sha256===prior.sha256,'Recovered current readback differs.','CAPTURE_FOLDER_READBACK');const result=await verified(capture,target,owned,true);await hook(fault,'repair.current.readback');
    check(equal(recoveredThrough,result.current.frontier),'Recovered frontier differs from the admitted acknowledgement.');
    if(oldAckRaw){validateRepairAck(parse(oldAckRaw,ACK),intent,intentHash);check(oldAckRaw.sha256===await hash(encoded(ack)),'Existing repair acknowledgement differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');}
    else await writeExact(capture,ACK,encoded(ack),{immutable:true,fault,phase:'repair.ack'});
    const pool=await completeCapturePool({directory,destination:owned,attemptId:repairId,targetHash:intent.targetHash,fault});
    return {...result,status:'recovered-prior',publicationSucceeded:false,localWorkAcknowledged:false,newerWorkMayBeMissing:true,gapNotice:intent.gapNotice,repair:ack,preservedCorruptObject:intent.corruptObject,priorUnchanged:true,nativeBindingsImported:false,accounting:{retainedTargetEnvelopeBytes:prior.size,preservedCorruptBytes:intent.corruptObject?.bytes??0,repairIntentBytes:intentBytes.length,repairAckBytes:encoded(ack).length,currentBytes:target.size,priorBytes:prior.size,browserReplacementAdditionalBytes:(raw?.size??0)+prior.size+target.size,poolAccounting:pool.accounting,poolTotalUnknown:pool.accounting.poolTotalUnknown,physicalAllocationMeasured:false}};
  });
}

// Same-profile recovery is explicitly separate from the folder-only operation.
// Locks precede short core transactions; no transaction spans folder I/O. The
// durable core barrier/reservation must exist before any repair evidence write.
export async function recoverCaptureFolderWithCore({db,directory,destination,workspaceId,repairId,policy='prior-with-gap',fault}={}){
  const owned=destinationCopy(destination);check(UUID.test(repairId)&&UUID.test(workspaceId),'Stable repair/workspace identities are required.');
  check(['prior-with-gap','exact-local-replay'].includes(policy),'Unsupported recovery policy.','CAPTURE_FOLDER_REPLAY_UNSUPPORTED');
  return withLock(directory,owned,async({capture})=>{
    const raw=await currentRaw(capture),prior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);
    await verified(capture,prior,owned,true);
    check(raw===null||raw.size>0,'A pre-existing empty current is ambiguous after lock loss.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    let plan=await readCaptureRepair(db,{projectId:owned.projectId,repairId});
    const oldIntentRaw=await readFile(capture,INTENT,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true}),oldAckRaw=await readFile(capture,ACK,CAPTURE_FOLDER_LIMITS.controlBytes,{optional:true});
    let validCurrent=false;if(raw)try{await verified(capture,raw,owned,true);validCurrent=true;}catch(e){if(e.code==='CAPTURE_FOLDER_CONFLICT')throw e;}
    if(!plan){
      check(!oldIntentRaw&&!oldAckRaw,'Existing repair controls cannot be adopted by a new core intent.','CAPTURE_FOLDER_REPAIR_CONFLICT');
      check(!validCurrent,'A valid changed current cannot be replaced by prior.','CAPTURE_FOLDER_CONFLICT');
      plan=await prepareCaptureRepair(db,{projectId:owned.projectId,workspaceId,destination:owned,repairId,observedCurrent:fingerprint(raw),observedCurrentBytes:raw?.bytes??null,priorEnvelopeBytes:prior.bytes,readObject:ref=>readObject(capture,ref),policy,beforeCommit:prospective=>admitRepairPool(directory,owned,prospective.intent,encoded(prospective.intent),prospective.acknowledgement,prior,prospective.objects,undefined,true)});
    }
    check(plan&&plan.repairId===repairId&&plan.workspaceId===workspaceId&&plan.policy===policy&&equal(plan.destination,owned),'Core repair destination, identity or policy differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    const intent=validateRepairIntent(plan.intent,owned),intentBytes=encoded(intent),intentHash=await hash(intentBytes);
    check((intent.version===2)===(policy==='exact-local-replay'),'Core recovery policy differs from folder intent.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    check(intentHash===plan.intentHash&&intent.priorHash===prior.sha256&&plan.targetHash===intent.targetHash,'Core repair prior or exact intent differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    const targetBytes=new Uint8Array(plan.targetBytes);check(targetBytes.length<=CAPTURE_FOLDER_LIMITS.currentBytes&&await hash(targetBytes)===intent.targetHash,'Core repair target bytes differ.');
    if(oldIntentRaw)check(oldIntentRaw.sha256===intentHash&&equal(validateRepairIntent(parse(oldIntentRaw,INTENT),owned),intent),'Existing repair intent differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    if(oldAckRaw){check(oldIntentRaw,'Orphan repair acknowledgement.','CAPTURE_FOLDER_REPAIR_CONFLICT');validateRepairAck(parse(oldAckRaw,ACK),intent,intentHash);check(equal(parse(oldAckRaw,ACK),plan.acknowledgement)&&raw?.sha256===intent.targetHash,'Existing repair acknowledgement or completed target differs.','CAPTURE_FOLDER_REPAIR_CONFLICT');}
    if(validCurrent)check(raw.sha256===intent.targetHash,'Unrelated valid head blocks repair.','CAPTURE_FOLDER_CONFLICT');
    else check(equal(fingerprint(raw),intent.observedCurrent),'Invalid current changed since durable repair preparation.','CAPTURE_FOLDER_REPAIR_CONFLICT');
    await hook(fault,'core.repair.prepared',{repairId,intentHash});
    let newImmutableBytes=0,reusedImmutableBytes=0;
    check(Array.isArray(plan.objects)&&plan.objects.length<=CAPTURE_FOLDER_LIMITS.objects,'Core repair object admission exceeded.','CAPTURE_FOLDER_CAPACITY');
    await admitRepairPool(directory,owned,intent,intentBytes,plan.acknowledgement,prior,plan.objects,fault);
    for(const object of plan.objects){
      objectReference({path:object.path,sha256:object.sha256,bytes:object.size});const body=object.bytes instanceof Blob?new Uint8Array(await object.bytes.arrayBuffer()):new Uint8Array(object.bytes);
      check(body.length===object.size&&await hash(body)===object.sha256,'Core repair immutable bytes differ.');
      const result=await writeExact(capture,object.path,body,{immutable:true,fault,phase:object.sha256===intent.targetHash?'repair.target':object.sha256===intent.corruptObject?.sha256?'repair.corrupt':'repair.immutable'});newImmutableBytes+=result.written;reusedImmutableBytes+=result.reused;
    }
    await verified(capture,{bytes:targetBytes,size:targetBytes.length,sha256:intent.targetHash},owned,true);
    if(!oldIntentRaw)await writeExact(capture,INTENT,intentBytes,{immutable:true,fault,phase:'repair.intent'});
    if(!validCurrent){
      await hook(fault,'repair.current.before');await authority(directory,owned,true);const latest=await currentRaw(capture),latestPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);
      check(equal(fingerprint(latest),intent.observedCurrent)&&latestPrior.sha256===intent.priorHash,'Repair source/prior changed before replacement.','CAPTURE_FOLDER_CONFLICT');
      let writable,createdMissing=false;
      try{
        createdMissing=latest===null;const handle=await capture.getFileHandle(CURRENT,{create:true});writable=await handle.createWritable({mode:'exclusive'});await writable.write(targetBytes);await hook(fault,'repair.current.write');
        await hook(fault,'repair.current.before-close');await authority(directory,owned,true);const recheck=await currentRaw(capture),recheckPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes);
        check((createdMissing?recheck?.size===0:equal(fingerprint(recheck),intent.observedCurrent))&&recheckPrior.sha256===intent.priorHash,'Repair source changed while replacement was staged.','CAPTURE_FOLDER_CONFLICT');
        await writable.close();writable=null;await hook(fault,'repair.current.after-close');
      }finally{if(writable)try{await writable.abort();}catch{}}
    }
    const target=await currentRaw(capture);check(target?.sha256===intent.targetHash,'Recovered current failed exact readback.','CAPTURE_FOLDER_READBACK');const result=await verified(capture,target,owned,true);await hook(fault,'repair.current.readback');
    const ack=validateRepairAck(plan.acknowledgement,intent,intentHash);check(equal(ack.recoveredThrough,result.current.frontier),'Core repair acknowledgement frontier differs.');
    if(!oldAckRaw)await writeExact(capture,ACK,encoded(ack),{immutable:true,fault,phase:'repair.ack'});
    const ackReadback=await readFile(capture,ACK,CAPTURE_FOLDER_LIMITS.controlBytes);check(ackReadback.sha256===await hash(encoded(ack)),'Repair acknowledgement readback differs.','CAPTURE_FOLDER_READBACK');
    // A fault hook may model another writer at any boundary: verify the actual
    // authority, current, prior and ACK once more before the short core CAS.
    await hook(fault,'core.repair.ack.before');await authority(directory,owned,true);
    const finalCurrent=await currentRaw(capture),finalPrior=await readFile(capture,PRIOR,CAPTURE_FOLDER_LIMITS.currentBytes),finalAck=await readFile(capture,ACK,CAPTURE_FOLDER_LIMITS.controlBytes);
    check(finalCurrent?.sha256===intent.targetHash&&finalPrior.sha256===intent.priorHash&&finalAck.sha256===ackReadback.sha256,'Repair evidence changed before core acknowledgement.','CAPTURE_FOLDER_CONFLICT');
    await verified(capture,finalCurrent,owned,true);
    const pool=await completeCapturePool({directory,destination:owned,attemptId:repairId,targetHash:intent.targetHash,fault});
    const coreAcknowledgement=await acknowledgeCaptureRepair(db,{projectId:owned.projectId,repairId,intentHash,targetHash:intent.targetHash,acknowledgement:ack});await hook(fault,'core.repair.ack.after');
    const replay=policy==='exact-local-replay';
    return {...result,status:replay?'recovered-local':'recovered-prior',recoveryCompleted:true,localPublicationPending:coreAcknowledgement.localPublicationPending,recoveryConflictRequired:coreAcknowledgement.recoveryConflictRequired,acknowledgedTargetHash:replay?intent.targetHash:null,publicationSucceeded:replay&&coreAcknowledgement.publicationSucceeded===true,localWorkAcknowledged:replay&&coreAcknowledgement.localWorkAcknowledged===true,newerWorkMayBeMissing:!replay,gapNotice:intent.gapNotice,repair:ack,coreAcknowledgement,priorUnchanged:true,nativeBindingsImported:false,accounting:{...plan.accounting,newImmutableBytes,reusedImmutableBytes,retainedTargetEnvelopeBytes:targetBytes.length,preservedCorruptBytes:intent.corruptObject?.bytes??0,repairIntentBytes:intentBytes.length,repairAckBytes:encoded(ack).length,currentBytes:target.size,priorBytes:prior.size,poolAccounting:pool.accounting,poolTotalUnknown:pool.accounting.poolTotalUnknown,physicalAllocationMeasured:false}};
  });
}
