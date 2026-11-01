// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Inactive core: callers own the database and its upgrade lifecycle. No opener.
import {preparedCaptureData,canonicalCaptureJson,sha256CaptureBytes,captureRecordFields,validateCaptureApplication,prepareCaptureBaselineRestartData,restoreCaptureBaselinePreparation,CAPTURE_RESTART_LIMITS} from './capture-format.js';

export const CAPTURE_STORES=Object.freeze(['reviews','captureEvents','captureStreams','captureOutbox','captureBlobs']);
export const CAPTURE_STORAGE_LIMITS=Object.freeze({status:'PROPOSED_NOT_ACTIVE_PRODUCT_LIMITS',actions:65536,retainedBytes:512*1024*1024,reservedPublicationBytes:512*1024*1024});
const encoder=new TextEncoder();
export class CaptureCommitError extends Error{
  constructor(code,message){super(message);this.name='CaptureCommitError';this.code=code;}
}
const error=(code,message)=>new CaptureCommitError(code,message);
const safe=n=>Number.isSafeInteger(n)&&n>=0&&!Object.is(n,-0);
const equal=(a,b)=>canonicalCaptureJson(a)===canonicalCaptureJson(b);
const currentKey=(projectId,workspaceId)=>'capture-current:'+projectId+':'+workspaceId;
const ledgerKey=projectId=>'capture-ledger:'+projectId;
export const captureRepairBarrierKey=projectId=>projectId+':repair-barrier';
// Project-wide control barrier. It does not restore a folder/native grant.
export function assertCaptureRepairBarrier(row,{publication=false}={}){
  if(row===undefined)return;
  const compact=row.version===2;
  if(!exactKeys(row,['id','projectId','kind','version','repairId','destinationId','phase','recoveryConflictRequired',...(compact?['workspaceId','recoveredTargetHash','policy']:[])])||row.id!==captureRepairBarrierKey(row.projectId)||row.kind!=='capture-repair-barrier'||![1,2].includes(row.version)||!['prepared','reconciled'].includes(row.phase)||typeof row.recoveryConflictRequired!=='boolean'||compact&&(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.workspaceId)||!/^[a-f0-9]{64}$/.test(row.recoveredTargetHash)||!['prior-with-gap','exact-local-replay'].includes(row.policy)))throw error('CAPTURE_INTEGRITY','Invalid core repair barrier.');
  if(row.phase==='prepared')throw error('CAPTURE_REPAIR_REQUIRED','An unresolved core repair blocks new accepted work and publication.');
  if(publication&&row.recoveryConflictRequired)throw error('CAPTURE_RECOVERY_CONFLICT','Recovery completed at an older folder head; explicit local reconciliation is still required.');
}
const RESERVATION_INDEX='capture-reservation';
const isBlob=value=>Object.prototype.toString.call(value)==='[object Blob]';
function exactKeys(value,names){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join('|')===[...names].sort().join('|');}
const frontierKeys=['branchId','streamId','sequence','eventId','eventHash','afterStateHash','revisionId'];
function validFrontier(value){return exactKeys(value,frontierKeys)&&safe(value.sequence)&&value.sequence>0;}
function validateCurrent(value){
  const observed=Object.hasOwn(value??{},'observationRef'),names=['id','projectId','workspaceId','kind','version','storageRevision','revisionId','stateJson','stateHash','frontier','descriptorHash','activeBranchDescriptor','pendingIntentId','coverage',...(Object.hasOwn(value??{},'application')?['application']:[]),...(observed?['observationRef']:[])];
  if(!exactKeys(value,names)||value.kind!=='capture-current'||value.version!==1||!safe(value.storageRevision)||value.storageRevision<1||!validFrontier(value.frontier)||!observed&&(value.frontier.afterStateHash!==value.stateHash||value.frontier.revisionId!==value.revisionId)||typeof value.stateJson!=='string'||value.id!==currentKey(value.projectId,value.workspaceId))throw error('CAPTURE_INTEGRITY','Unsupported or inconsistent capture current schema.');
  if(observed&&(!exactKeys(value.observationRef,['kind','id','projectId','sha256'])||value.observationRef.kind!=='observation'||value.observationRef.projectId!==value.projectId))throw error('CAPTURE_INTEGRITY','Invalid observed current reference.');
  const descriptor=value.activeBranchDescriptor,coverage=value.coverage;
  if(!exactKeys(descriptor,['schema','version','kind','id','projectId','streamId','writerSessionId','parentBranchId','forkAnchor','rootCaptureStateHash','createdAt',...(Object.hasOwn(descriptor??{},'observedFork')?['observedFork']:[])])||descriptor.schema!=='scorebrush-research-record'||descriptor.version!==1||descriptor.kind!=='branch'||descriptor.projectId!==value.projectId||descriptor.id!==value.frontier.branchId||descriptor.streamId!==value.frontier.streamId)throw error('CAPTURE_INTEGRITY','Unsupported active branch descriptor.');
  if(!exactKeys(coverage,['policy','priorHistory','startStateHash','baselineAssetId','throughFrontier'])||coverage.policy!=='semantic-actions-v1'||coverage.priorHistory!=='not-reconstructed'||!equal(coverage.throughFrontier,value.frontier)||typeof value.pendingIntentId!=='string'||!value.pendingIntentId.startsWith(value.projectId+':intent:'))throw error('CAPTURE_INTEGRITY','Unsupported capture coverage or pending intent.');
  if(Object.hasOwn(value,'application')){try{validateCaptureApplication(value.application,value.projectId,value.revisionId);}catch{throw error('CAPTURE_INTEGRITY','Unsupported capture application metadata.');}}
}
// Structural validation only; callers must separately verify referenced bytes.
export function validateCaptureStoredCurrent(value){validateCurrent(value);return value;}
function validateStream(value){
  if(!exactKeys(value,['id','projectId','kind','version','streamId','branchId','writerSessionId','descriptorId','descriptorHash','frontier'])||value.kind!=='capture-stream'||value.version!==1||!validFrontier(value.frontier)||value.id!==value.projectId+':stream:'+value.streamId||value.frontier.streamId!==value.streamId||value.frontier.branchId!==value.branchId||value.descriptorId!==value.projectId+':branch:'+value.branchId)throw error('CAPTURE_INTEGRITY','Unsupported or inconsistent capture stream schema.');
}
function rowMetadata(row){
  const result={...row};
  if(Object.hasOwn(result,'body')){
    if(!isBlob(result.body))throw error('CAPTURE_INTEGRITY','Invalid immutable Blob body.');
    result.bodyBytes=result.body.size;result.bodyType=result.body.type;delete result.body;
  }
  return result;
}
export function captureStoredRowBytes(row){
  if(row===undefined)return 0;
  return encoder.encode(canonicalCaptureJson(rowMetadata(row))).length+(isBlob(row.body)?row.body.size:0);
}
function sameImmutable(existing,proposed){
  // Existing immutable payload bodies are trusted as core-owned IDB data.
  // Exact supplied bytes were hashed during preparation. This comparison does
  // not certify corrupted/imported stored Blob bodies; recovery must rehash them.
  return existing!==undefined&&equal(rowMetadata(existing),rowMetadata(proposed));
}
function checkReservationIndex(store){
  if(!store.indexNames.contains(RESERVATION_INDEX))throw error('CAPTURE_SCHEMA','Capture reservation index is missing.');
  const index=store.index(RESERVATION_INDEX);
  if(!index.unique||index.multiEntry||!equal(index.keyPath,['projectId','reservationId']))throw error('CAPTURE_SCHEMA','Incompatible capture reservation index.');
}
function schema(db){
  if(!db||typeof db.transaction!=='function'||!CAPTURE_STORES.every(name=>db.objectStoreNames.contains(name)))throw error('CAPTURE_SCHEMA','Capture stores are not installed on the provided database.');
}

// Only a later explicitly reviewed upgrader may call this in production.
export function installCaptureSchema(db,upgradeTransaction){
  if(!db||upgradeTransaction?.db!==db||upgradeTransaction.mode!=='versionchange')throw error('CAPTURE_SCHEMA','Capture schema installation requires the caller\'s versionchange transaction.');
  for(const name of CAPTURE_STORES)if(db.objectStoreNames.contains(name)){
    const store=upgradeTransaction.objectStore(name);
    if(store.keyPath!=='id'||store.autoIncrement)throw error('CAPTURE_SCHEMA','Incompatible capture store: '+name);
  }
  if(db.objectStoreNames.contains('captureOutbox')&&upgradeTransaction.objectStore('captureOutbox').indexNames.contains(RESERVATION_INDEX))checkReservationIndex(upgradeTransaction.objectStore('captureOutbox'));
  for(const name of CAPTURE_STORES)if(!db.objectStoreNames.contains(name))db.createObjectStore(name,{keyPath:'id'});
  const outbox=upgradeTransaction.objectStore('captureOutbox');
  if(!outbox.indexNames.contains(RESERVATION_INDEX))outbox.createIndex(RESERVATION_INDEX,['projectId','reservationId'],{unique:true});
}

function checkLedger(value,projectId){
  if(value===undefined)return {id:ledgerKey(projectId),projectId,kind:'capture-ledger',version:1,revision:0,actionCount:0,retainedBytes:0,blobRows:0,outboxCount:0,reservedPublicationBytes:0};
  const keys=['id','projectId','kind','version','revision','actionCount','retainedBytes','blobRows','outboxCount','reservedPublicationBytes'];
  if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.id!==ledgerKey(projectId)||value.projectId!==projectId||value.kind!=='capture-ledger'||value.version!==1||keys.slice(4).some(key=>!safe(value[key])))throw error('CAPTURE_INTEGRITY','Invalid project capacity ledger.');
  return value;
}
function checkCurrent(value,data){
  if(value!==undefined)validateCurrent(value);
  if(data.expected===null){if(value!==undefined)throw error('CAPTURE_STALE','Expected an absent capture current state.');return;}
  if(!value||value.projectId!==data.projectId||value.workspaceId!==data.workspaceId||value.id!==data.current.id||!safe(value.storageRevision))throw error('CAPTURE_STALE','Expected capture current state is missing or foreign.');
  for(const field of ['storageRevision','revisionId','stateHash','frontier'])if(!equal(value[field],data.expected[field]))throw error('CAPTURE_STALE','Capture current '+field+' changed.');
  if(!equal(value.observationRef??null,data.expected.observationRef??null))throw error('CAPTURE_STALE','Capture current observation changed.');
}
function checkStream(value,data){
  if(value!==undefined)validateStream(value);
  const expected=data.expectedStreamFrontier;
  if(expected===null||expected===undefined){if(value!==undefined)throw error('CAPTURE_STALE','Writer stream already exists.');return;}
  if(!value||value.projectId!==data.projectId||value.streamId!==data.stream.streamId||value.branchId!==data.stream.branchId||value.writerSessionId!==data.stream.writerSessionId||value.descriptorId!==data.stream.descriptorId||value.descriptorHash!==data.stream.descriptorHash||!equal(value.frontier,expected))throw error('CAPTURE_STALE','Writer stream frontier or ownership changed.');
}
function checkRef(row,ref){
  if(!row||row.id!==ref.id||(ref.sha256!==null&&ref.sha256!==undefined&&row.sha256!==ref.sha256)||(ref.assetId!==undefined&&(row.assetId!==ref.assetId||row.kind!=='capture-payload')))throw error('CAPTURE_INTEGRITY','Missing or conflicting capture reference: '+ref.id);
  if(ref.kind!==undefined&&row.kind!==ref.kind)throw error('CAPTURE_INTEGRITY','Referenced capture kind differs.');
  if(ref.store==='captureEvents'){
    let record;try{record=JSON.parse(row.canonicalJson);}catch{throw error('CAPTURE_INTEGRITY','Invalid referenced capture record.');}
    let recordKeys;try{recordKeys=captureRecordFields(record);}catch{throw error('CAPTURE_INTEGRITY','Unsupported referenced record kind.');}
    if(!exactKeys(record,recordKeys)||record.schema!=='scorebrush-research-record'||record.version!==1||record.projectId!==row.projectId||record.kind!==row.kind||record.id!==row.logicalId||row.id!==record.projectId+':'+record.kind+':'+record.id||canonicalCaptureJson(record)!==row.canonicalJson)throw error('CAPTURE_INTEGRITY','Referenced capture record identity or schema differs.');
    if(ref.findingId!==undefined&&record.findingId!==ref.findingId)throw error('CAPTURE_INTEGRITY','Referenced version belongs to another finding.');
    if(ref.sourceFindingId!==undefined&&record.sourceFindingId!==ref.sourceFindingId)throw error('CAPTURE_INTEGRITY','Referenced version belongs to another source finding.');
    if(ref.deleted!==undefined&&record.deleted!==ref.deleted)throw error('CAPTURE_INTEGRITY','Referenced finding tombstone differs.');
    if(ref.findingVersionId!==undefined&&record.findingVersionId!==ref.findingVersionId)throw error('CAPTURE_INTEGRITY','Referenced judgment finding version differs.');
    if(ref.reviewed!==undefined){const tuple=record.kind==='revision'?{revisionId:record.id,sourceAssetIds:record.sourceAssetIds,notationAssetId:record.notationAssetId,renderAssetIds:record.renderAssetIds}:record.reviewed;if(!equal(tuple,ref.reviewed))throw error('CAPTURE_INTEGRITY','Referenced reviewed input tuple differs.');}
    if(ref.scope!==undefined&&!equal(record.scope,ref.scope))throw error('CAPTURE_INTEGRITY','Referenced judgment scope differs.');
    if(ref.observedFork!==undefined&&(record.revisionId!==ref.observedFork.revisionId||record.afterStateHash!==ref.observedFork.stateHash||record.storageRevision!==ref.observedFork.storageRevision||!equal(record.semanticFrontier,ref.frontierOfObservation)))throw error('CAPTURE_INTEGRITY','Observed fork does not match immutable observed state.');
    if(ref.eventHash!==undefined&&record.eventHash!==ref.eventHash)throw error('CAPTURE_INTEGRITY','Referenced causal event hash differs.');
    if(ref.frontier){
      const observed={branchId:record.branchId,streamId:record.streamId,sequence:record.sequence,eventId:record.id,eventHash:record.eventHash,afterStateHash:record.afterStateHash,revisionId:record.revisionId};
      if(!equal(observed,ref.frontier))throw error('CAPTURE_INTEGRITY','Referenced causal frontier differs.');
    }
  }
}

function checkObservedCurrent(current,row){
  if(!current?.observationRef)return;
  const ref=current.observationRef;checkRef(row,{store:'captureEvents',id:current.projectId+':observation:'+ref.id,kind:'observation',sha256:ref.sha256});const observed=JSON.parse(row.canonicalJson);
  if(observed.workspaceId!==current.workspaceId||observed.revisionId!==current.revisionId||observed.afterStateHash!==current.stateHash||observed.storageRevision!==current.storageRevision||!equal(observed.semanticFrontier,current.frontier)||!equal(observed.revisionRef,current.application?.revisionRef))throw error('CAPTURE_INTEGRITY','Observed current state is not bound to its immutable observation.');
}

// Every request and write uses one strict transaction over all five stores.
// Preparation has already copied, validated and hashed owned bytes; no hashing,
// asynchronous producer, timer, file I/O or second database is used inside it.
export function commitCapture(db,prepared){
  let data;
  try{schema(db);data=preparedCaptureData(prepared);}catch(failure){return Promise.reject(failure);}
  return new Promise((resolve,reject)=>{
    let tx,failure,result;
    try{tx=db.transaction(CAPTURE_STORES,'readwrite',{durability:'strict'});}catch(cause){reject(cause);return;}
    const abort=cause=>{failure??=cause;try{tx.abort();}catch{ /* completion/abort already owns settlement */ }};
    tx.onabort=()=>reject(failure||(tx.error?.name==='ConstraintError'?error('CAPTURE_CONFLICT','Capture identity or reservation is already committed.'):tx.error)||error('CAPTURE_ABORT','Capture transaction aborted; no commit was accepted.'));
    tx.onerror=()=>{};
    tx.oncomplete=()=>resolve(result);
    const fetched=new Map(),requests=new Map();let pending=0,initialScheduled=false,closureScheduled=false;
    const key=(store,id)=>store+'\u0000'+id;
    const read=(store,id)=>{
      const k=key(store,id);if(requests.has(k))return;
      pending++;const request=tx.objectStore(store).get(id);requests.set(k,request);
      request.onsuccess=()=>{fetched.set(k,request.result);pending--;if(initialScheduled&&!pending)advance();};
    };
    const get=(store,id)=>fetched.get(key(store,id));
    const observationMode=data.mode==='observation',immutable=[...(data.descriptor?[['captureEvents',data.descriptor]]:[]),...(data.action?[['captureEvents',data.action]]:[]),...(data.observation?[['captureEvents',data.observation]]:[]),...data.changedRecords.map(row=>['captureEvents',row]),...data.blobs.map(row=>['captureBlobs',row])];
    const proposed=new Map(immutable.map(([store,row])=>[key(store,row.id),row]));
    function advance(){
      try{
        const priorCurrent=get('reviews',data.current.id);
        if(priorCurrent?.observationRef){const id=data.projectId+':observation:'+priorCurrent.observationRef.id;if(!requests.has(key('captureEvents',id))){read('captureEvents',id);return;}checkObservedCurrent(priorCurrent,get('captureEvents',id));}
        if(!closureScheduled){
          closureScheduled=true;
          // Changed/baseline payload references are explicitly bounded, not history.
          for(const ref of data.requiredRefs){
            const row=proposed.get(key(ref.store,ref.id))||get(ref.store,ref.id);checkRef(row,ref);
            if(row.kind==='capture-payload'){
              if(!Array.isArray(row.segmentIds)||row.segmentIds.length>400)throw error('CAPTURE_INTEGRITY','Invalid bounded payload manifest.');
              for(const id of row.segmentIds)if(!proposed.has(key('captureBlobs',id)))read('captureBlobs',id);
            }
          }
          if(pending)return;
        }
        for(const ref of data.requiredRefs){
          const row=proposed.get(key(ref.store,ref.id))||get(ref.store,ref.id);
          if(row.kind==='capture-payload'){
            let manifest;try{manifest=JSON.parse(row.canonicalJson);}catch{throw error('CAPTURE_INTEGRITY','Invalid payload manifest JSON.');}
            if(!exactKeys(manifest,['schema','version','mediaType','bytes','sha256','segmentAssetIds'])||manifest.schema!=='scorebrush-capture-payload'||manifest.version!==1||!(ref.mediaTypes??['application/json']).includes(manifest.mediaType)||!safe(manifest.bytes)||manifest.bytes>100*1024*1024||row.assetId!=='sha256:'+manifest.sha256||row.payloadBytes!==manifest.bytes||!Array.isArray(manifest.segmentAssetIds)||!equal(row.segmentIds,manifest.segmentAssetIds.map(id=>data.projectId+':segment:'+id))||row.segmentIds.length!==Math.ceil(manifest.bytes/(256*1024)))throw error('CAPTURE_INTEGRITY','Unsupported or inconsistent payload manifest.');
            for(const [index,id]of row.segmentIds.entries()){
            const segment=proposed.get(key('captureBlobs',id))||get('captureBlobs',id);
            const expectedBytes=Math.min(256*1024,manifest.bytes-index*256*1024);
            if(!segment||segment.id!==id||segment.projectId!==data.projectId||segment.kind!=='capture-segment'||segment.assetId!=='sha256:'+segment.sha256||!isBlob(segment.body)||segment.body.size!==segment.bytes||segment.bytes!==expectedBytes)throw error('CAPTURE_INTEGRITY','Missing or malformed payload segment.');
            }
          }
        }
        const existingCurrent=get('reviews',data.current.id),existingAction=get('captureEvents',(data.action??data.observation).id),existingOutbox=data.outbox?get('captureOutbox',data.outbox.id):undefined,archivedOutbox=data.outbox?get('captureStreams',data.outbox.id):undefined;
        // Immutable conflict detection precedes stale-state checks, including retries.
        for(const [store,row]of immutable){const old=get(store,row.id);if(old!==undefined&&!sameImmutable(old,row))throw error('CAPTURE_CONFLICT','Immutable capture ID has different bytes: '+row.id);}
        if(existingOutbox!==undefined&&!equal(existingOutbox,data.outbox))throw error('CAPTURE_CONFLICT','Publication intent ID has different bytes.');
        if(archivedOutbox!==undefined&&(!existingAction||!equal(archivedOutbox,data.outbox)))throw error('CAPTURE_CONFLICT','Archived publication intent cannot authorize a new or different commit.');
        if(existingAction!==undefined&&observationMode){
          const retainedLedger=get('captureStreams',ledgerKey(data.projectId));if(immutable.some(([store,row])=>get(store,row.id)===undefined)||!existingCurrent||existingCurrent.storageRevision<data.current.storageRevision||!retainedLedger)throw error('CAPTURE_INTEGRITY','Observed retry lost its committed closure.');
          validateCurrent(existingCurrent);const ledger=checkLedger(retainedLedger,data.projectId);if(ledger.actionCount<1||ledger.revision<1)throw error('CAPTURE_INTEGRITY','Observed retry lost its baseline capacity counters.');result={status:'already-committed',current:existingCurrent,actionId:null,semanticAction:false,publicationSucceeded:false};return;
        }
        if(existingAction!==undefined){
          if(existingOutbox===undefined&&archivedOutbox===undefined||immutable.some(([store,row])=>get(store,row.id)===undefined))throw error('CAPTURE_INTEGRITY','Committed retry has incomplete atomic evidence.');
          if(data.baselineStage)checkBaselineClosure(data.baselineStage,get,'adopted');
          const retainedStream=get('captureStreams',data.stream.id),retainedLedger=get('captureStreams',ledgerKey(data.projectId));
          validateCurrent(existingCurrent);validateStream(retainedStream);
          if(!existingCurrent||existingCurrent.projectId!==data.projectId||existingCurrent.workspaceId!==data.workspaceId||!safe(existingCurrent.storageRevision)||existingCurrent.storageRevision<data.current.storageRevision||!retainedStream||retainedStream.descriptorId!==data.descriptor.id||retainedStream.descriptorHash!==data.descriptor.sha256||retainedStream.writerSessionId!==data.stream.writerSessionId||retainedStream.branchId!==data.stream.branchId||retainedStream.streamId!==data.stream.streamId||!safe(retainedStream.frontier?.sequence)||retainedStream.frontier.sequence<data.stream.frontier.sequence||!retainedLedger)throw error('CAPTURE_INTEGRITY','Committed retry has missing current, stream or ledger closure.');
          const ledger=checkLedger(retainedLedger,data.projectId);if(ledger.actionCount<1||existingOutbox!==undefined&&ledger.outboxCount<1||ledger.revision<1)throw error('CAPTURE_INTEGRITY','Committed retry has invalid capacity closure.');
          result={status:'already-committed',current:existingCurrent,actionId:data.action.logicalId,publicationSucceeded:false};return;
        }
        if(existingOutbox!==undefined)throw error('CAPTURE_CONFLICT','Publication intent belongs to a different commit.');
        assertCaptureRepairBarrier(get('captureStreams',captureRepairBarrierKey(data.projectId)));
        checkCurrent(existingCurrent,data);const existingStream=data.stream?get('captureStreams',data.stream.id):undefined;if(!observationMode)checkStream(existingStream,data);
        const observedFork=data.descriptor?JSON.parse(data.descriptor.canonicalJson).observedFork:null;
        if(observedFork&&data.expectedStreamFrontier===null&&(!equal(observedFork.observationRef,existingCurrent?.observationRef)||observedFork.storageRevision!==existingCurrent.storageRevision||observedFork.revisionId!==existingCurrent.revisionId||observedFork.stateHash!==existingCurrent.stateHash))throw error('CAPTURE_INTEGRITY','First fork commit does not match the actual observed current.');
        if(existingCurrent?.application&&!data.current.application)throw error('CAPTURE_INTEGRITY','Application capture pointers cannot be silently removed.');
        if(observationMode){
          validateCurrent(data.current);
          const old=existingCurrent.application,next=data.current.application;
          if(!equal(old.findingVersions,next.findingVersions)||!equal(old.judgmentHeads,next.judgmentHeads)||!equal(old.effectiveDecisionBindings??null,next.effectiveDecisionBindings??null)||old.sourceWorkspaceId!==next.sourceWorkspaceId||!equal(existingCurrent.frontier,data.current.frontier)||existingCurrent.pendingIntentId!==data.current.pendingIntentId||!equal(existingCurrent.activeBranchDescriptor,data.current.activeBranchDescriptor)||!equal(existingCurrent.coverage,data.current.coverage)||existingCurrent.descriptorHash!==data.current.descriptorHash)throw error('CAPTURE_INTEGRITY','State-only observation cannot change semantic pointers.');
          const before=JSON.parse(get('captureEvents',data.projectId+':revision:'+existingCurrent.revisionId).canonicalJson),after=JSON.parse((proposed.get(key('captureEvents',data.projectId+':revision:'+data.current.revisionId))||get('captureEvents',data.projectId+':revision:'+data.current.revisionId)).canonicalJson);
          for(const field of ['sourceAssetIds','notationAssetId','renderAssetIds'])if(!equal(before[field],after[field]))throw error('CAPTURE_INTEGRITY','State-only observation cannot change input identities.');
          checkObservedCurrent(data.current,data.observation);
        }
        const actionType=data.action?JSON.parse(data.action.canonicalJson).actionType:null;let reversedDecision=false;
        for(const row of data.changedRecords)if(row.kind==='judgment'){
          const record=JSON.parse(row.canonicalJson),application=existingCurrent?.application;
          const finding=application?.findingVersions.find(item=>item.versionRef.id===record.findingVersionId&&!item.deleted);
          if(!finding)throw error('CAPTURE_INTEGRITY','Human judgment does not target the current exact finding version.');
          const currentRevision=get('captureEvents',data.projectId+':revision:'+existingCurrent.revisionId);
          if(!currentRevision)throw error('CAPTURE_INTEGRITY','Human judgment current input revision is missing.');
          const revision=JSON.parse(currentRevision.canonicalJson),tuple={sourceAssetIds:revision.sourceAssetIds,notationAssetId:revision.notationAssetId,renderAssetIds:revision.renderAssetIds};
          if(!equal(tuple,{sourceAssetIds:record.reviewed.sourceAssetIds,notationAssetId:record.reviewed.notationAssetId,renderAssetIds:record.reviewed.renderAssetIds}))throw error('CAPTURE_INTEGRITY','Human judgment input bytes do not match the current reviewed tuple.');
          const heads=application.judgmentHeads.filter(item=>item.findingVersionId===record.findingVersionId&&equal(item.reviewed,record.reviewed));
          if(!equal(record.supersedesJudgmentIds,[...heads.map(item=>item.judgmentRef.id)].sort())&&!equal([...record.supersedesJudgmentIds].sort(),heads.map(item=>item.judgmentRef.id).sort()))throw error('CAPTURE_INTEGRITY','Judgment supersession does not match current causal target heads.');
          const nextHead=data.current.application?.judgmentHeads.find(item=>item.findingVersionId===record.findingVersionId&&equal(item.reviewed,record.reviewed));
          if(!nextHead||nextHead.judgmentRef.id!==record.id||nextHead.sourceFindingId!==finding.sourceFindingId)throw error('CAPTURE_INTEGRITY','Committed judgment is not the exact resulting application head.');
          if(actionType==='judgment.reversed')for(const id of record.supersedesJudgmentIds){const previous=JSON.parse(get('captureEvents',data.projectId+':judgment:'+id).canonicalJson);if(previous.decision!==record.decision)reversedDecision=true;}
        }
        if(actionType==='judgment.reversed'&&!reversedDecision)throw error('CAPTURE_INTEGRITY','Judgment reversal must change a superseded decision.');
        const oldLedger=get('captureStreams',ledgerKey(data.projectId));
        if(oldLedger===undefined&&(data.expected!==null||existingStream!==undefined||immutable.some(([store,row])=>get(store,row.id)!==undefined)))throw error('CAPTURE_INTEGRITY','Initialized capture project is missing its capacity ledger.');
        const ledger=checkLedger(oldLedger,data.projectId);
        if(!observationMode&&ledger.actionCount>=CAPTURE_STORAGE_LIMITS.actions)throw error('CAPTURE_CAPACITY','Proposed capture action capacity is exhausted.');
        let retainedDelta=captureStoredRowBytes(data.current)-captureStoredRowBytes(existingCurrent)+(data.stream?captureStoredRowBytes(data.stream)-captureStoredRowBytes(existingStream):0)+(data.outbox?captureStoredRowBytes(data.outbox):0),newBlobRows=0;
        for(const [store,row]of immutable)if(get(store,row.id)===undefined){retainedDelta+=captureStoredRowBytes(row);if(store==='captureBlobs')newBlobRows++;}
        let adoptedStage=null;if(data.baselineStage){const stage=checkBaselineClosure(data.baselineStage,get,'staged');adoptedStage={...stage,phase:'adopted'};retainedDelta+=captureStoredRowBytes(adoptedStage)-captureStoredRowBytes(stage);}
        const reservation=observationMode||data.baselineStage?0:data.outbox.reservation?.publicationBytes;
        if(!safe(reservation))throw error('CAPTURE_INTEGRITY','Invalid pending publication reservation.');
        const next={...ledger,revision:ledger.revision+1,actionCount:ledger.actionCount+(observationMode?0:1),blobRows:ledger.blobRows+newBlobRows,outboxCount:ledger.outboxCount+(observationMode?0:1),reservedPublicationBytes:ledger.reservedPublicationBytes+reservation,retainedBytes:0};
        const base=ledger.retainedBytes-captureStoredRowBytes(oldLedger)+retainedDelta;
        // Include the ledger's own serialized size, including its byte-count digits.
        for(let i=0;i<12;i++){const n=base+captureStoredRowBytes(next);if(n===next.retainedBytes)break;next.retainedBytes=n;}
        if(Object.entries(next).some(([k,v])=>typeof v==='number'&&!safe(v))||next.retainedBytes!==base+captureStoredRowBytes(next))throw error('CAPTURE_CAPACITY','Capture accounting exceeds safe integer capacity.');
        if(next.retainedBytes>CAPTURE_STORAGE_LIMITS.retainedBytes||next.reservedPublicationBytes>CAPTURE_STORAGE_LIMITS.reservedPublicationBytes)throw error('CAPTURE_CAPACITY','Proposed capture storage or publication reservation capacity is exhausted.');
        for(const [store,row]of immutable)if(get(store,row.id)===undefined)tx.objectStore(store).add(row);
        if(data.stream)tx.objectStore('captureStreams').put(data.stream);
        if(adoptedStage)tx.objectStore('captureStreams').put(adoptedStage);
        tx.objectStore('captureStreams').put(next);
        if(data.outbox)tx.objectStore('captureOutbox').add(data.outbox);
        tx.objectStore('reviews').put(data.current);
        result={status:'committed',current:data.current,actionId:data.action?.logicalId??null,semanticAction:!observationMode,ledger:next,publicationSucceeded:false};
      }catch(cause){abort(cause);}
    }
    try{
      for(const name of CAPTURE_STORES){const store=tx.objectStore(name);if(store.keyPath!=='id'||store.autoIncrement)throw error('CAPTURE_SCHEMA','Incompatible capture store: '+name);}
      checkReservationIndex(tx.objectStore('captureOutbox'));
      read('captureStreams',captureRepairBarrierKey(data.projectId));
      read('reviews',data.current.id);if(data.stream)read('captureStreams',data.stream.id);read('captureStreams',ledgerKey(data.projectId));if(data.outbox){read('captureOutbox',data.outbox.id);read('captureStreams',data.outbox.id);}if(data.baselineStage){read('captureStreams',data.baselineStage.id);for(const batch of data.baselineStage.batches)read('captureStreams',batch.receipt.id);}
      for(const [store,row]of immutable)read(store,row.id);
      for(const ref of data.requiredRefs)if(!proposed.has(key(ref.store,ref.id)))read(ref.store,ref.id);
      initialScheduled=true;if(!pending)advance();
    }catch(cause){abort(cause);}
  });
}

// Staged immutable rows are unreachable until the single capture-start adoption.
// A caller retains the opaque plan for exact retry; orphaned stages stay counted.
function validateBaselineStage(stage,plan){
  if(!exactKeys(stage,['id','projectId','kind','version','baselineId','planHash','canonicalJson','batchCount','nextBatch','phase','publicationBytes'])||stage.id!==plan.id||stage.kind!=='capture-baseline-stage'||stage.version!==1||stage.projectId!==plan.projectId||stage.baselineId!==plan.baselineId||stage.planHash!==plan.planHash||stage.canonicalJson!==plan.canonicalJson||stage.batchCount!==plan.batchCount||stage.publicationBytes!==plan.publicationBytes||!safe(stage.nextBatch)||stage.nextBatch>plan.batchCount||!['staged','adopted'].includes(stage.phase))throw error('CAPTURE_CONFLICT','Baseline stage identity conflicts.');
}
function checkBaselineClosure(plan,get,phase){
  const stage=get('captureStreams',plan.id);validateBaselineStage(stage,plan);
  if(stage.nextBatch!==plan.batchCount||stage.phase!==phase||plan.batches.some(batch=>get('captureStreams',batch.receipt.id)===undefined||!equal(get('captureStreams',batch.receipt.id),batch.receipt)||batch.entries.some(([store,row])=>get(store,row.id)===undefined||!sameImmutable(get(store,row.id),row))))throw error('CAPTURE_INTEGRITY','Baseline staging is incomplete or belongs to another plan.');
  return stage;
}
export function stageCaptureBaseline(db,token,index){
  let data,plan,batch;try{schema(db);data=preparedCaptureData(token);plan=data.baselineStage;if(!plan||!safe(index)||index>=plan.batchCount)throw error('CAPTURE_SCHEMA','Invalid bounded baseline batch.');batch=plan.batches[index];}catch(failure){return Promise.reject(failure);}
  return new Promise((resolve,reject)=>{
    let tx,failure,result;try{tx=db.transaction(CAPTURE_STORES,'readwrite',{durability:'strict'});}catch(cause){reject(cause);return;}
    const abort=cause=>{failure??=cause;try{tx.abort();}catch{}};tx.onabort=()=>reject(failure||tx.error||error('CAPTURE_ABORT','Baseline batch aborted.'));tx.onerror=()=>{};tx.oncomplete=()=>resolve(result);
    const fetched=new Map(),requests=new Set();let pending=0,scheduled=false;const key=(store,id)=>store+'\u0000'+id,get=(store,id)=>fetched.get(key(store,id));
    function read(store,id){const k=key(store,id);if(requests.has(k))return;requests.add(k);pending++;const request=tx.objectStore(store).get(id);request.onsuccess=()=>{fetched.set(k,request.result);pending--;if(scheduled&&!pending)advance();};}
    function advance(){try{
      const oldStage=get('captureStreams',plan.id),receipt=get('captureStreams',batch.receipt.id),oldLedger=get('captureStreams',ledgerKey(data.projectId)),current=get('reviews',data.current.id),preparation=get('captureStreams',preparationKey(data.projectId,plan.baselineId));
      if(oldStage)validateBaselineStage(oldStage,plan);
      if(preparation){validatePreparationHeader(preparation,{projectId:data.projectId,baselineId:plan.baselineId,planHash:plan.planHash,batchCount:plan.batchCount,publicationBytes:plan.publicationBytes});if(preparation.phase!=='prepared'||preparation.nextBatch!==plan.batchCount)throw error('CAPTURE_PREPARATION_INCOMPLETE','Baseline preparation is not durably complete.');}
      for(const [store,row]of batch.entries){const old=get(store,row.id);if(old!==undefined&&!sameImmutable(old,row))throw error('CAPTURE_CONFLICT','Baseline immutable row conflicts.');}
      if(receipt!==undefined){
        if(!equal(receipt,batch.receipt)||!oldStage||oldStage.nextBatch<=index||!oldLedger||batch.entries.some(([store,row])=>get(store,row.id)===undefined))throw error('CAPTURE_INTEGRITY','Baseline batch retry has incomplete durable closure.');
        checkLedger(oldLedger,data.projectId);result={status:'already-staged',stageId:plan.id,index,nextBatch:oldStage.nextBatch,adopted:oldStage.phase==='adopted'};return;
      }
      if(current!==undefined)throw error('CAPTURE_STALE','Baseline staging cannot replace active current state.');
      assertCaptureRepairBarrier(get('captureStreams',captureRepairBarrierKey(data.projectId)));
      if(index!==(oldStage?.nextBatch??0)||oldStage?.phase==='adopted')throw error('CAPTURE_STALE','Baseline batches require their exact next index.');
      if(!oldLedger&&(oldStage||preparation||batch.entries.some(([store,row])=>get(store,row.id)!==undefined)))throw error('CAPTURE_INTEGRITY','Staged baseline lost its capacity ledger.');
      const ledger=checkLedger(oldLedger,data.projectId),stage={id:plan.id,projectId:data.projectId,kind:'capture-baseline-stage',version:1,baselineId:plan.baselineId,planHash:plan.planHash,canonicalJson:plan.canonicalJson,batchCount:plan.batchCount,nextBatch:index+1,phase:'staged',publicationBytes:plan.publicationBytes};
      let delta=captureStoredRowBytes(stage)-captureStoredRowBytes(oldStage)+captureStoredRowBytes(batch.receipt),newBlobRows=0;
      for(const [store,row]of batch.entries)if(get(store,row.id)===undefined){delta+=captureStoredRowBytes(row);if(store==='captureBlobs')newBlobRows++;}
      const next={...ledger,revision:ledger.revision+1,blobRows:ledger.blobRows+newBlobRows,reservedPublicationBytes:ledger.reservedPublicationBytes+(oldStage||preparation?0:plan.publicationBytes),retainedBytes:0},base=ledger.retainedBytes-captureStoredRowBytes(oldLedger)+delta;
      for(let i=0;i<12;i++){const n=base+captureStoredRowBytes(next);if(n===next.retainedBytes)break;next.retainedBytes=n;}
      if(Object.values(next).some(value=>typeof value==='number'&&!safe(value))||next.retainedBytes!==base+captureStoredRowBytes(next)||next.retainedBytes>CAPTURE_STORAGE_LIMITS.retainedBytes||next.reservedPublicationBytes>CAPTURE_STORAGE_LIMITS.reservedPublicationBytes)throw error('CAPTURE_CAPACITY','Proposed baseline staging capacity is exhausted.');
      for(const [store,row]of batch.entries)if(get(store,row.id)===undefined)tx.objectStore(store).add(row);
      tx.objectStore('captureStreams').add(batch.receipt);tx.objectStore('captureStreams').put(stage);tx.objectStore('captureStreams').put(next);
      result={status:'staged',stageId:plan.id,index,nextBatch:stage.nextBatch,ledger:next,adopted:false};
    }catch(cause){abort(cause);}}
    try{for(const name of CAPTURE_STORES){const store=tx.objectStore(name);if(store.keyPath!=='id'||store.autoIncrement)throw error('CAPTURE_SCHEMA','Incompatible capture stage store.');}checkReservationIndex(tx.objectStore('captureOutbox'));read('captureStreams',captureRepairBarrierKey(data.projectId));read('reviews',data.current.id);read('captureStreams',plan.id);read('captureStreams',preparationKey(data.projectId,plan.baselineId));read('captureStreams',batch.receipt.id);read('captureStreams',ledgerKey(data.projectId));for(const [store,row]of batch.entries)read(store,row.id);scheduled=true;if(!pending)advance();}catch(cause){abort(cause);}
  });
}

const preparationKey=(projectId,baselineId)=>projectId+':baseline-preparation:'+baselineId;
const preparationReceipt=(plan,batch)=>({...batch.receipt,id:plan.projectId+':baseline-preparation-batch:'+plan.baselineId+':'+batch.index,kind:'capture-baseline-preparation-batch'});
function validatePreparationHeader(value,expected){
  if(!exactKeys(value,['id','projectId','kind','version','baselineId','planHash','batchCount','nextBatch','phase','publicationBytes','controlId','controlHash','controlBytes'])||value.id!==preparationKey(value.projectId,value.baselineId)||value.kind!=='capture-baseline-preparation'||value.version!==1||!safe(value.nextBatch)||!safe(value.batchCount)||value.batchCount<1||value.batchCount>CAPTURE_RESTART_LIMITS.batches||value.nextBatch>value.batchCount||!['preparing','prepared'].includes(value.phase)||value.phase==='prepared'&&value.nextBatch!==value.batchCount||!safe(value.publicationBytes)||!safe(value.controlBytes)||value.controlBytes>CAPTURE_RESTART_LIMITS.controlBytes||value.controlId!==value.projectId+':baseline-restart-control:'+value.baselineId||typeof value.controlHash!=='string'||!/^[0-9a-f]{64}$/.test(value.controlHash)||typeof value.planHash!=='string'||!/^[0-9a-f]{64}$/.test(value.planHash)||Object.entries(expected).some(([key,expectedValue])=>value[key]!==expectedValue))throw error('CAPTURE_INTEGRITY','Invalid durable baseline preparation header.');
}

export async function persistCaptureBaselinePreparation(db,token){
  schema(db);const data=preparedCaptureData(token),plan=data.baselineStage;if(!plan)throw error('CAPTURE_SCHEMA','Durable preparation requires a dedicated baseline.');const restart=await prepareCaptureBaselineRestartData(token);let result;
  for(const batch of plan.batches)result=await persistPreparationBatch(db,data,plan,batch,restart.artifact);
  return {...result,status:'prepared',projectId:data.projectId,baselineId:plan.baselineId,planHash:plan.planHash,restartResumable:true};
}

function persistPreparationBatch(db,data,plan,batch,control){
  return new Promise((resolve,reject)=>{
    let tx,failure,result;try{tx=db.transaction(CAPTURE_STORES,'readwrite',{durability:'strict'});}catch(cause){reject(cause);return;}
    const abort=cause=>{failure??=cause;try{tx.abort();}catch{}};tx.onabort=()=>reject(failure||tx.error||error('CAPTURE_ABORT','Durable baseline preparation aborted.'));tx.onerror=()=>{};tx.oncomplete=()=>resolve(result);
    const fetched=new Map(),requests=new Set(),receipt=preparationReceipt(plan,batch),headerId=preparationKey(data.projectId,plan.baselineId);let pending=0,scheduled=false;const key=(store,id)=>store+'\u0000'+id,get=(store,id)=>fetched.get(key(store,id));
    function read(store,id){const k=key(store,id);if(requests.has(k))return;requests.add(k);pending++;const request=tx.objectStore(store).get(id);request.onsuccess=()=>{fetched.set(k,request.result);pending--;if(scheduled&&!pending)advance();};}
    function advance(){try{
      const old=get('captureStreams',headerId),oldReceipt=get('captureStreams',receipt.id),oldControl=get('captureBlobs',control.id),oldLedger=get('captureStreams',ledgerKey(data.projectId)),stage=get('captureStreams',plan.id),current=get('reviews',data.current.id);
      if(old)validatePreparationHeader(old,{projectId:data.projectId,baselineId:plan.baselineId,planHash:plan.planHash,batchCount:plan.batchCount,publicationBytes:plan.publicationBytes,controlHash:control.sha256,controlBytes:control.bytes});if(stage)validateBaselineStage(stage,plan);
      if(oldControl&&!old)throw error('CAPTURE_INTEGRITY','Durable baseline control lost its preparation header.');
      if(oldControl&&!sameImmutable(oldControl,control))throw error('CAPTURE_CONFLICT','Durable baseline control differs.');
      for(const [store,row]of batch.entries){const prior=get(store,row.id);if(prior&&!sameImmutable(prior,row))throw error('CAPTURE_CONFLICT','Durable baseline owned row differs.');}
      if(oldReceipt){if(!equal(oldReceipt,receipt)||!old||old.nextBatch<=batch.index||!oldControl||!oldLedger||batch.entries.some(([store,row])=>!get(store,row.id)))throw error('CAPTURE_INTEGRITY','Durable preparation retry has incomplete closure.');checkLedger(oldLedger,data.projectId);result={status:'already-prepared-batch',nextBatch:old.nextBatch,batchCount:plan.batchCount};return;}
      assertCaptureRepairBarrier(get('captureStreams',captureRepairBarrierKey(data.projectId)));
      if(current&&(!stage||stage.phase!=='adopted'))throw error('CAPTURE_STALE','Durable preparation cannot replace an unrelated active current.');if(batch.index!==(old?.nextBatch??0))throw error('CAPTURE_PREPARATION_INCOMPLETE','Durable preparation requires its exact next batch.');
      if(!oldLedger&&(old||oldControl||stage||batch.entries.some(([store,row])=>get(store,row.id)!==undefined)))throw error('CAPTURE_INTEGRITY','Durable preparation lost its capacity ledger.');
      const ledger=checkLedger(oldLedger,data.projectId),header={id:headerId,projectId:data.projectId,kind:'capture-baseline-preparation',version:1,baselineId:plan.baselineId,planHash:plan.planHash,batchCount:plan.batchCount,nextBatch:batch.index+1,phase:batch.index+1===plan.batchCount?'prepared':'preparing',publicationBytes:plan.publicationBytes,controlId:control.id,controlHash:control.sha256,controlBytes:control.bytes};
      let delta=captureStoredRowBytes(header)-captureStoredRowBytes(old)+captureStoredRowBytes(receipt)+(oldControl?0:captureStoredRowBytes(control)),newBlobRows=oldControl?0:1;
      for(const [store,row]of batch.entries)if(!get(store,row.id)){delta+=captureStoredRowBytes(row);if(store==='captureBlobs')newBlobRows++;}
      const next={...ledger,revision:ledger.revision+1,blobRows:ledger.blobRows+newBlobRows,reservedPublicationBytes:ledger.reservedPublicationBytes+(old||stage?0:plan.publicationBytes),retainedBytes:0},base=ledger.retainedBytes-captureStoredRowBytes(oldLedger)+delta;
      for(let i=0;i<12;i++){const bytes=base+captureStoredRowBytes(next);if(bytes===next.retainedBytes)break;next.retainedBytes=bytes;}
      if(Object.values(next).some(value=>typeof value==='number'&&!safe(value))||next.retainedBytes!==base+captureStoredRowBytes(next)||next.retainedBytes>CAPTURE_STORAGE_LIMITS.retainedBytes||next.reservedPublicationBytes>CAPTURE_STORAGE_LIMITS.reservedPublicationBytes)throw error('CAPTURE_CAPACITY','Proposed durable preparation capacity is exhausted.');
      if(!oldControl)tx.objectStore('captureBlobs').add(control);for(const [store,row]of batch.entries)if(!get(store,row.id))tx.objectStore(store).add(row);tx.objectStore('captureStreams').add(receipt);tx.objectStore('captureStreams').put(header);tx.objectStore('captureStreams').put(next);result={status:'prepared-batch',nextBatch:header.nextBatch,batchCount:plan.batchCount,ledger:next};
    }catch(cause){abort(cause);}}
    try{for(const name of CAPTURE_STORES){const store=tx.objectStore(name);if(store.keyPath!=='id'||store.autoIncrement)throw error('CAPTURE_SCHEMA','Incompatible durable preparation store.');}checkReservationIndex(tx.objectStore('captureOutbox'));read('captureStreams',captureRepairBarrierKey(data.projectId));read('reviews',data.current.id);read('captureStreams',headerId);read('captureStreams',receipt.id);read('captureStreams',ledgerKey(data.projectId));read('captureStreams',plan.id);read('captureBlobs',control.id);for(const [store,row]of batch.entries)read(store,row.id);scheduled=true;if(!pending)advance();}catch(cause){abort(cause);}
  });
}

async function readExactRows(db,requests){
  return new Promise((resolve,reject)=>{const stores=[...new Set(requests.map(([store])=>store))],tx=db.transaction(stores,'readonly'),values=new Map();for(const [store,id]of requests){const request=tx.objectStore(store).get(id);request.onsuccess=()=>values.set(store+'\u0000'+id,request.result);}tx.oncomplete=()=>resolve(values);tx.onabort=()=>reject(tx.error||error('CAPTURE_ABORT','Baseline reconstruction read aborted.'));tx.onerror=()=>{};});
}

export async function reconstructCaptureBaselinePreparation(db,options){
  schema(db);if(!exactKeys(options,['projectId','baselineId'])||![options.projectId,options.baselineId].every(value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)))throw error('CAPTURE_SCHEMA','Invalid durable baseline identity.');
  const {projectId,baselineId}=options,headerId=preparationKey(projectId,baselineId),controlId=projectId+':baseline-restart-control:'+baselineId,initial=await readExactRows(db,[['captureStreams',headerId],['captureBlobs',controlId],['captureStreams',ledgerKey(projectId)]]),header=initial.get('captureStreams\u0000'+headerId),control=initial.get('captureBlobs\u0000'+controlId),ledger=initial.get('captureStreams\u0000'+ledgerKey(projectId));
  if(!header)throw error('CAPTURE_PREPARATION_INCOMPLETE','No durable baseline preparation is available.');validatePreparationHeader(header,{projectId,baselineId});if(header.phase!=='prepared')throw error('CAPTURE_PREPARATION_INCOMPLETE','Baseline preparation was interrupted before all owned bytes became durable.');
  if(!ledger)throw error('CAPTURE_INTEGRITY','Durable baseline preparation lost its capacity ledger.');checkLedger(ledger,projectId);
  if(!exactKeys(control,['id','projectId','kind','version','baselineId','planHash','sha256','bytes','body'])||control.id!==controlId||control.projectId!==projectId||control.kind!=='capture-baseline-restart-control'||control.version!==1||control.baselineId!==baselineId||control.planHash!==header.planHash||control.sha256!==header.controlHash||control.bytes!==header.controlBytes||!isBlob(control.body)||control.body.size!==control.bytes||await sha256CaptureBytes(control.body)!==control.sha256)throw error('CAPTURE_INTEGRITY','Durable baseline control bytes are missing or changed.');
  let text,parsed;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await control.body.arrayBuffer());parsed=JSON.parse(text);}catch{throw error('CAPTURE_INTEGRITY','Durable baseline control encoding is invalid.');}
  if(parsed.projectId!==projectId||parsed.baselineId!==baselineId||parsed.planHash!==header.planHash||!Array.isArray(parsed.rows)||parsed.rows.length>CAPTURE_RESTART_LIMITS.rows||parsed.rows.some(ref=>!exactKeys(ref,['store','id','sha256','bytes'])||!['captureEvents','captureBlobs'].includes(ref.store)||typeof ref.id!=='string'||!ref.id.startsWith(projectId+':')))throw error('CAPTURE_INTEGRITY','Durable baseline control row closure is invalid.');
  const requests=parsed.rows.map(ref=>[ref.store,ref.id]);for(let index=0;index<header.batchCount;index++)requests.push(['captureStreams',projectId+':baseline-preparation-batch:'+baselineId+':'+index]);const found=await readExactRows(db,requests),entries=parsed.rows.map(ref=>[ref.store,found.get(ref.store+'\u0000'+ref.id)]);if(entries.some(([,row])=>!row))throw error('CAPTURE_INTEGRITY','Durable baseline owned bytes are incomplete.');
  let token;try{token=await restoreCaptureBaselinePreparation(text,entries);}catch(cause){throw error('CAPTURE_INTEGRITY','Durable baseline verification failed: '+cause.message);}
  const data=preparedCaptureData(token);if(data.baselineStage.batchCount!==header.batchCount||data.baselineStage.planHash!==header.planHash||data.baselineStage.publicationBytes!==header.publicationBytes)throw error('CAPTURE_INTEGRITY','Reconstructed baseline plan differs from its durable header.');
  for(const batch of data.baselineStage.batches){const receipt=preparationReceipt(data.baselineStage,batch),stored=found.get('captureStreams\u0000'+receipt.id);if(!stored||!equal(stored,receipt)||await sha256CaptureBytes(stored.canonicalJson)!==stored.sha256)throw error('CAPTURE_INTEGRITY','Durable baseline preparation receipt is missing or changed.');}
  const rebuilt=await prepareCaptureBaselineRestartData(token);if(rebuilt.artifact.sha256!==control.sha256||rebuilt.artifact.bytes!==control.bytes)throw error('CAPTURE_INTEGRITY','Reconstructed durable control differs from its original exact bytes.');return token;
}

// One current point read plus its optional exact observation; no history replay.
export async function readCaptureCurrent(db,projectId,workspaceId){
  schema(db);
  const {current,observation}=await new Promise((resolve,reject)=>{
    const tx=db.transaction(['reviews','captureEvents'],'readonly'),request=tx.objectStore('reviews').get(currentKey(projectId,workspaceId));let value,observation;
    request.onsuccess=()=>{value=request.result;if(value?.observationRef){const observed=tx.objectStore('captureEvents').get(projectId+':observation:'+value.observationRef.id);observed.onsuccess=()=>{observation=observed.result;};}};tx.oncomplete=()=>resolve({current:value,observation});tx.onabort=()=>reject(tx.error||error('CAPTURE_ABORT','Capture read aborted.'));tx.onerror=()=>{};
  });
  if(current!==undefined){
    validateCurrent(current);
    checkObservedCurrent(current,observation);
    if(current.projectId!==projectId||current.workspaceId!==workspaceId||typeof current.stateJson!=='string'||await sha256CaptureBytes(encoder.encode(current.stateJson))!==current.stateHash)throw error('CAPTURE_INTEGRITY','Current capture state hash or ownership mismatch.');
    if(await sha256CaptureBytes(canonicalCaptureJson(current.activeBranchDescriptor))!==current.descriptorHash)throw error('CAPTURE_INTEGRITY','Current active descriptor hash mismatch.');
  }
  return current;
}
