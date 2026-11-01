// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Inactive capture core: no database opener, app entry point or event listeners.
// These limits are provisional module admission limits, not approved product caps.
export const PROPOSED_CAPTURE_LIMITS=Object.freeze({actions:65536,retainedBytes:512*1024*1024,
  actionBytes:8192,descriptorBytes:2048,changedRecords:32,recordBytes:32768,
  segmentBytes:256*1024,payloadBytes:100*1024*1024,stateBytes:25*1024*1024,
  currentBytes:25*1024*1024,outboxBytes:16384,metadataDepth:64,metadataNodes:100000});
const SCHEMA='scorebrush-research-record',encoder=new TextEncoder();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/,ASSET=/^sha256:[0-9a-f]{64}$/;
const writers=new WeakMap(),prepared=new WeakMap(),payloads=new WeakMap(),restartPlans=new WeakMap();
export const CAPTURE_RESTART_LIMITS=Object.freeze({controlBytes:4*1024*1024,rows:16384,batches:512,status:'PROPOSED_INACTIVE_ADMISSION'});
const actionTypes=new Set(['capture.started','finding.finalized','finding.edited','finding.deleted','undo.outcome','redo.outcome','branch.created','judgment.changed','judgment.reversed','judgment.retracted','revision.loaded']);
const categories=new Set(['transcription_error','source_ambiguity','editorial_choice','comment','unclassified']);
function fail(message){throw new TypeError('Capture format: '+message);}
function check(ok,message){if(!ok)fail(message);}
function string(value,label){check(typeof value==='string',label+' must be a string');for(let i=0;i<value.length;i++){
  const n=value.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);check(next>=0xdc00&&next<=0xdfff,label+' has a lone surrogate');}
  else check(n<0xdc00||n>0xdfff,label+' has a lone surrogate');}return value;}
function id(value,label){check(typeof value==='string'&&UUID.test(value),label+' must be a lowercase UUID');return value;}
function hash(value,label){check(typeof value==='string'&&HASH.test(value),label+' must be SHA-256');return value;}
function integer(value,label,min=0,max=Number.MAX_SAFE_INTEGER){check(Number.isSafeInteger(value)&&!Object.is(value,-0)&&value>=min&&value<=max,label+' must be a bounded safe integer');return value;}
function keys(value,names,label){check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype,label+' must be a plain object');
  check(Object.keys(value).sort().join('|')===[...names].sort().join('|'),label+' has missing or unknown fields');return value;}
function time(value,label){if(value===null)return null;string(value,label);check(value.length<=40&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value)),label+' must be recorded UTC time');check(new Date(value).toISOString().slice(0,19)===value.slice(0,19),label+' invalid calendar time');return value;}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
export function canonicalCaptureJson(value){
  let nodes=0;const stack=new Set();
  function visit(item,depth){check(++nodes<=PROPOSED_CAPTURE_LIMITS.metadataNodes&&depth<=PROPOSED_CAPTURE_LIMITS.metadataDepth,'metadata complexity limit');
    if(item===null)return 'null';
    if(typeof item==='string')return JSON.stringify(string(item,'metadata string'));
    if(typeof item==='number'){check(Number.isSafeInteger(item)&&!Object.is(item,-0),'metadata requires safe integers');return String(item);}
    if(typeof item==='boolean')return String(item);
    check(item&&typeof item==='object','unsupported metadata value');check(!stack.has(item),'cyclic metadata');stack.add(item);
    let result;if(Array.isArray(item)){
      check(Object.keys(item).length===item.length&&Object.getOwnPropertyNames(item).length===item.length+1&&Object.getOwnPropertySymbols(item).length===0,'sparse or extended array');
      const entries=[];for(let index=0;index<item.length;index++){const d=Object.getOwnPropertyDescriptor(item,String(index));check(d&&d.enumerable&&'value'in d,'metadata accessor');entries.push(visit(d.value,depth+1));}result='['+entries.join(',')+']';
    }else{
      check(Object.getPrototypeOf(item)===Object.prototype||Object.getPrototypeOf(item)===null,'metadata must be plain');
      check(Object.getOwnPropertySymbols(item).length===0,'symbol metadata key');
      const fields=Object.getOwnPropertyNames(item).sort();
      result='{'+fields.map(key=>{check(/^[\x20-\x7e]+$/.test(key),'metadata keys must be ASCII');const d=Object.getOwnPropertyDescriptor(item,key);check(d.enumerable&&'value'in d,'metadata accessor/hidden property');return JSON.stringify(key)+':'+visit(d.value,depth+1);}).join(',')+'}';
    }stack.delete(item);return result;
  }return visit(value,0);
}
function own(value){return JSON.parse(canonicalCaptureJson(value));}
function byteLength(value){return encoder.encode(value).length;}
function boundJson(value,limit,label){const json=canonicalCaptureJson(value);check(byteLength(json)<=limit,label+' byte limit');return json;}
function opaqueJson(value,label){string(value,label);check(byteLength(value)<=PROPOSED_CAPTURE_LIMITS.stateBytes,label+' byte limit');
  try{JSON.parse(value,(_key,item)=>{if(typeof item==='number'&&!Number.isFinite(item))fail(label+' nonfinite value');return item;});}catch(error){fail(label+' is invalid JSON: '+error.message);}return value;}
export async function sha256CaptureBytes(value){
  const bytes=typeof value==='string'?encoder.encode(string(value,'bytes')):value instanceof Blob?new Uint8Array(await value.arrayBuffer()):value instanceof ArrayBuffer?new Uint8Array(value.slice(0)):ArrayBuffer.isView(value)?new Uint8Array(value.buffer.slice(value.byteOffset,value.byteOffset+value.byteLength)):null;
  check(bytes,'expected bytes, Blob or UTF-8 string');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function hashCaptureRecord(record){return sha256CaptureBytes(canonicalCaptureJson(record));}
function anchor(value,label){keys(value,['branchId','streamId','sequence','eventId','eventHash','afterStateHash','revisionId'],label);
  for(const field of ['branchId','streamId','eventId','revisionId'])id(value[field],label+'.'+field);integer(value.sequence,label+'.sequence',1,PROPOSED_CAPTURE_LIMITS.actions);hash(value.eventHash,label+'.eventHash');hash(value.afterStateHash,label+'.afterStateHash');return value;}
function equal(a,b){return canonicalCaptureJson(a)===canonicalCaptureJson(b);}
function reference(ref,projectId,label,kind='finding-version'){keys(ref,['kind','id','projectId','sha256'],label);check(ref.kind===kind,label+' unsupported kind');id(ref.id,label+'.id');check(ref.projectId===projectId,label+' foreign project');hash(ref.sha256,label+'.sha256');return ref;}
function sourceFindingId(value){string(value,'source finding ID');check(/^[\w-]{1,80}$/.test(value),'source finding ID');return value;}
function assets(values,label){check(Array.isArray(values)&&values.length<=16,label+' asset count');for(const value of values)check(typeof value==='string'&&ASSET.test(value),label+' asset identity');check(new Set(values).size===values.length,label+' duplicate asset');return values;}
function reviewed(value){keys(value,['revisionId','sourceAssetIds','notationAssetId','renderAssetIds'],'reviewed');id(value.revisionId,'reviewed revision');assets(value.sourceAssetIds,'reviewed source');assets(value.renderAssetIds,'reviewed render');check(value.notationAssetId===null||typeof value.notationAssetId==='string'&&ASSET.test(value.notationAssetId),'reviewed notation');return value;}
const findingFields=['schema','version','kind','id','projectId','findingId','previousVersionId','revisionId','createdByActionId','category','geometryAssetId','deleted','text'];
const revisionFields=['schema','version','kind','id','projectId','parentIds','branchId','workspaceId','sourceAssetIds','notationAssetId','renderAssetIds','dependencySetId','createdByActionId','reason'];
const judgmentFields=['schema','version','kind','id','projectId','findingVersionId','reviewed','scope','decision','reasonAssetId','actorId','actionId','supersedesJudgmentIds'];
const observationFields=['schema','version','kind','id','projectId','workspaceId','revisionId','previousRevisionId','previousObservationRef','beforeStateHash','afterStateHash','storageRevision','semanticFrontier','revisionRef'];
export function captureRecordFields(record){
  if(record.kind==='finding-version')return Object.hasOwn(record,'sourceFindingId')||Object.hasOwn(record,'originalType')?[...findingFields,'sourceFindingId','originalType']:findingFields;
  if(record.kind==='revision')return Object.hasOwn(record,'observedFrontier')?[...revisionFields,'observedFrontier']:revisionFields;
  if(record.kind==='judgment')return judgmentFields;
  if(record.kind==='observation')return observationFields;
  if(record.kind==='branch')return ['schema','version','kind','id','projectId','streamId','writerSessionId','parentBranchId','forkAnchor','rootCaptureStateHash','createdAt',...(Object.hasOwn(record,'observedFork')?['observedFork']:[])];
  if(record.kind==='action')return ['schema','version','kind','id','projectId','streamId','branchId','workspaceId','revisionId','sequence','prevEventHash','causalActionIds','recordedAt','actorId','actionType','changes','beforeStateHash','afterStateHash','capturePolicy','evidenceBasis','streamDescriptorHash','eventHash',...(Object.hasOwn(record,'beforeObservationRef')?['beforeObservationRef']:[])];
  fail('unsupported referenced capture record kind');
}

// Intrinsic evidence validation is shared by independent folder readers.
// Referenced record identity, hashes and graph relationships remain caller checks.
export function validateCaptureEvidenceRecord(record){
  boundJson(record,record?.kind==='branch'?PROPOSED_CAPTURE_LIMITS.descriptorBytes:record?.kind==='action'?PROPOSED_CAPTURE_LIMITS.actionBytes:PROPOSED_CAPTURE_LIMITS.recordBytes,'evidence record');
  keys(record,captureRecordFields(record),'evidence record');check(record.schema===SCHEMA&&record.version===1,'evidence record schema/version');id(record.id,'evidence ID');id(record.projectId,'evidence project');
  if(record.kind==='finding-version'){
    finding(record,record.projectId,record.createdByActionId,record.revisionId);check(record.geometryAssetId===null||typeof record.geometryAssetId==='string'&&ASSET.test(record.geometryAssetId),'evidence geometry identity');
  }else if(record.kind==='revision'){
    if(record.createdByActionId!==null)id(record.createdByActionId,'revision action');const observation=Object.hasOwn(record,'observedFrontier');if(observation)anchor(record.observedFrontier,'observed revision frontier');
    revision(record,{projectId:record.projectId,workspaceId:record.workspaceId,branchId:record.branchId,actionId:record.createdByActionId,revisionId:record.id,baseline:record.reason==='baseline',expectedRevisionId:record.parentIds?.[0],observation,frontier:record.observedFrontier});
    check(record.reason==='baseline'||observation||record.createdByActionId!==null,'semantic revision needs its action identity');
  }else if(record.kind==='judgment'){
    judgment(record,{projectId:record.projectId,actionId:record.actionId,baseline:false,expectedRevisionId:record.reviewed?.revisionId});
  }else if(record.kind==='branch'){
    for(const field of ['streamId','writerSessionId'])id(record[field],'branch '+field);time(record.createdAt,'branch time');
    if(record.parentBranchId===null){check(record.forkAnchor===null&&!Object.hasOwn(record,'observedFork'),'root branch cannot claim parent observations');hash(record.rootCaptureStateHash,'root capture hash');}
    else{id(record.parentBranchId,'parent branch');anchor(record.forkAnchor,'fork anchor');check(record.parentBranchId===record.forkAnchor.branchId&&record.parentBranchId!==record.id&&record.rootCaptureStateHash===null,'branch parent identity');}
    if(Object.hasOwn(record,'observedFork')){const observed=record.observedFork;keys(observed,['storageRevision','revisionId','stateHash','observationRef'],'observed fork');integer(observed.storageRevision,'observed fork storage revision',1);id(observed.revisionId,'observed fork revision');hash(observed.stateHash,'observed fork state');reference(observed.observationRef,record.projectId,'observed fork observation','observation');}
  }else if(record.kind==='observation'){
    for(const field of ['workspaceId','revisionId','previousRevisionId'])id(record[field],'observation '+field);hash(record.beforeStateHash,'observation before state');hash(record.afterStateHash,'observation after state');integer(record.storageRevision,'observation storage revision',2);anchor(record.semanticFrontier,'observation semantic frontier');reference(record.revisionRef,record.projectId,'observed revision','revision');check(record.revisionRef.id===record.revisionId,'observed revision identity');
    if(record.previousObservationRef===null)check(record.semanticFrontier.afterStateHash===record.beforeStateHash&&record.semanticFrontier.revisionId===record.previousRevisionId,'observation must start from its semantic state');
    else{reference(record.previousObservationRef,record.projectId,'previous observation','observation');check(record.previousObservationRef.id!==record.id,'self-linked observation');}
  }else if(record.kind==='action'){
    for(const field of ['streamId','branchId','workspaceId','revisionId'])id(record[field],'action '+field);integer(record.sequence,'action sequence',1,PROPOSED_CAPTURE_LIMITS.actions);time(record.recordedAt,'action time');for(const field of ['beforeStateHash','afterStateHash','streamDescriptorHash','eventHash'])hash(record[field],'action '+field);
    check(record.actorId===null&&actionTypes.has(record.actionType)&&record.capturePolicy==='semantic-actions-v1'&&record.evidenceBasis==='application_observation','action policy/type/actor');check(Array.isArray(record.causalActionIds)&&record.causalActionIds.length<=1,'action causal bound');for(const causal of record.causalActionIds){id(causal,'causal action');check(causal!==record.id,'self-causal action');}
    if(record.sequence===1)check(record.prevEventHash===null,'first action previous hash');else{hash(record.prevEventHash,'previous event hash');check(record.causalActionIds.length===1,'continuing action needs causal predecessor');}
    if(Object.hasOwn(record,'beforeObservationRef'))reference(record.beforeObservationRef,record.projectId,'action before observation','observation');
    check(Array.isArray(record.changes)&&record.changes.length<=32,'action changed-reference bound');const changed=new Set();
    for(const change of record.changes){keys(change,['entityKind','entityId','operation','beforeRef','afterRef'],'evidence change');check(['finding','judgment','revision'].includes(change.entityKind)&&['create','replace','delete','restore'].includes(change.operation),'evidence entity/operation');id(change.entityId,'changed entity');const key=change.entityKind+':'+change.entityId;check(!changed.has(key),'duplicate changed entity');changed.add(key);const kind=change.entityKind==='finding'?'finding-version':change.entityKind;reference(change.afterRef,record.projectId,'changed after reference',kind);if(change.entityKind==='finding'){check((change.operation==='create')===(change.beforeRef===null),'evidence create/prior invariant');if(change.beforeRef!==null)reference(change.beforeRef,record.projectId,'changed before reference');}else check(change.operation==='create'&&change.beforeRef===null&&change.entityId===change.afterRef.id,'append-only evidence change');}
    const findings=record.changes.filter(change=>change.entityKind==='finding'),judgments=record.changes.filter(change=>change.entityKind==='judgment'),operation={'finding.finalized':'create','finding.edited':'replace','finding.deleted':'delete'}[record.actionType];if(operation)check(findings.length>0&&findings.every(change=>change.operation===operation),'finding action operation');
    if(['undo.outcome','redo.outcome'].includes(record.actionType))check(findings.length>0,'undo/redo finding evidence');if(record.actionType.startsWith('judgment.'))check(judgments.length>0&&findings.length===0,'judgment action evidence');if(record.actionType==='revision.loaded')check(record.changes.some(change=>change.entityKind==='revision')&&findings.length===0&&judgments.length===0,'input revision action evidence');
    if(record.actionType==='capture.started')check(record.sequence===1&&record.causalActionIds.length===0&&record.changes.length===0,'capture start action');else check(record.causalActionIds.length===1,'semantic action needs prior accepted action');if(record.actionType==='branch.created')check(record.sequence===1&&record.changes.length===0,'branch creation action');
  }
  return record;
}
export function validateCaptureApplication(value,projectId,revisionId){
  const bindings=Object.hasOwn(value??{},'effectiveDecisionBindings');keys(value,['schema','version','sourceWorkspaceId','revisionRef','findingVersions','judgmentHeads',...(bindings?['effectiveDecisionBindings']:[])],'application');
  check(value.schema==='scorebrush-capture-application'&&value.version===1,'application schema/version');string(value.sourceWorkspaceId,'sourceWorkspaceId');check(value.sourceWorkspaceId.length>0&&value.sourceWorkspaceId.length<=200,'source workspace ID bound');
  reference(value.revisionRef,projectId,'application revision','revision');check(value.revisionRef.id===revisionId,'application revision does not match current logical revision');
  check(Array.isArray(value.findingVersions)&&value.findingVersions.length<=2000,'application finding count');const sources=new Set(),findings=new Set();
  for(const entry of value.findingVersions){keys(entry,['sourceFindingId','findingId','versionRef','deleted'],'application finding');sourceFindingId(entry.sourceFindingId);id(entry.findingId,'application finding ID');reference(entry.versionRef,projectId,'application finding ref');check(typeof entry.deleted==='boolean','application tombstone');check(!sources.has(entry.sourceFindingId)&&!findings.has(entry.findingId),'duplicate application finding');sources.add(entry.sourceFindingId);findings.add(entry.findingId);}
  check(Array.isArray(value.judgmentHeads)&&value.judgmentHeads.length<=2000,'application judgment count');const targets=new Set();
  for(const entry of value.judgmentHeads){keys(entry,['sourceFindingId','findingVersionId','reviewed','judgmentRef'],'application judgment');sourceFindingId(entry.sourceFindingId);id(entry.findingVersionId,'judgment finding version');reviewed(entry.reviewed);reference(entry.judgmentRef,projectId,'application judgment ref','judgment');check(value.findingVersions.some(item=>item.sourceFindingId===entry.sourceFindingId&&item.versionRef.id===entry.findingVersionId&&!item.deleted),'application judgment must target its current exact source finding');const key=entry.findingVersionId+':'+canonicalCaptureJson(entry.reviewed);check(!targets.has(key),'duplicate application judgment target');targets.add(key);}
  if(bindings){
    check(Array.isArray(value.effectiveDecisionBindings)&&value.effectiveDecisionBindings.length<=2000,'effective decision binding count');const reported=new Set();
    for(const entry of value.effectiveDecisionBindings){keys(entry,['reportedFindingId','sourceFindingId','findingVersionId','sourceAssetIds','notationAssetId','renderAssetIds','decisionHash'],'effective decision binding');sourceFindingId(entry.reportedFindingId);sourceFindingId(entry.sourceFindingId);id(entry.findingVersionId,'effective finding version');assets(entry.sourceAssetIds,'effective source');assets(entry.renderAssetIds,'effective render');check(entry.notationAssetId===null||typeof entry.notationAssetId==='string'&&ASSET.test(entry.notationAssetId),'effective notation');hash(entry.decisionHash,'effective decision hash');check(!reported.has(entry.reportedFindingId),'duplicate effective reported finding');reported.add(entry.reportedFindingId);check(value.findingVersions.some(item=>item.sourceFindingId===entry.sourceFindingId&&item.versionRef.id===entry.findingVersionId&&!item.deleted),'effective decision must bind its current exact source finding');}
  }
  return value;
}
function finding(record,projectId,actionId,revisionId){
  keys(record,captureRecordFields(record),'finding-version');
  check(record.schema===SCHEMA&&record.version===1&&record.kind==='finding-version','unsupported changed-record schema/version/kind');
  for(const key of ['id','findingId','revisionId','createdByActionId'])id(record[key],'finding.'+key);
  check(record.projectId===projectId&&record.createdByActionId===actionId&&record.revisionId===revisionId,'changed record context mismatch');
  if(record.previousVersionId!==null)id(record.previousVersionId,'previousVersionId');
  check(record.previousVersionId!==record.id,'self-linked finding version');check(categories.has(record.category),'finding category');
  check(record.geometryAssetId===null||ASSET.test(record.geometryAssetId),'geometry asset identity');
  if(Object.hasOwn(record,'sourceFindingId')){sourceFindingId(record.sourceFindingId);check([null,'correction','source_footnote','comment'].includes(record.originalType),'original finding type');}
  check(typeof record.deleted==='boolean','finding deleted flag');string(record.text,'finding text');check(record.text.length<=4000,'finding text exceeds existing 4000 code-unit bound');return record;
}
function revision(record,context){
  keys(record,captureRecordFields(record),'revision');check(record.schema===SCHEMA&&record.version===1&&record.kind==='revision','revision schema/version');
  for(const field of ['id','projectId','branchId','workspaceId'])id(record[field],'revision '+field);
  check(record.projectId===context.projectId&&record.branchId===context.branchId&&record.workspaceId===context.workspaceId&&record.id===context.revisionId,'revision context mismatch');
  check(Array.isArray(record.parentIds)&&record.parentIds.length<=32&&new Set(record.parentIds).size===record.parentIds.length,'revision parent bound');for(const parent of record.parentIds){id(parent,'parent revision');check(parent!==record.id,'revision self-parent');}
  assets(record.sourceAssetIds,'revision source');assets(record.renderAssetIds,'revision render');check(record.notationAssetId===null||typeof record.notationAssetId==='string'&&ASSET.test(record.notationAssetId),'revision notation');
  check(record.dependencySetId===null,'dependency declarations are outside inactive adapter scope');
  check(['baseline','code_and_render','code_only','pdf_only','branch_import','review_only'].includes(record.reason),'revision reason');
  if(context.observation){check(record.createdByActionId===null&&record.reason==='review_only'&&equal(record.observedFrontier,context.frontier),'observed revision must retain its exact semantic frontier');}
  else{check(!Object.hasOwn(record,'observedFrontier'),'semantic revision cannot claim observation metadata');check(record.createdByActionId===context.actionId||context.baseline&&record.createdByActionId===null,'revision action identity');}
  if(context.baseline)check(record.reason==='baseline'&&record.parentIds.length===0,'baseline revision lineage');else check(record.reason!=='baseline'&&equal(record.parentIds,[context.expectedRevisionId]),'local revision needs its exact prior logical revision');
  return record;
}
function judgment(record,context){
  keys(record,judgmentFields,'judgment');check(record.schema===SCHEMA&&record.version===1&&record.kind==='judgment','judgment schema/version');
  for(const field of ['id','projectId','findingVersionId','actionId'])id(record[field],'judgment '+field);check(record.projectId===context.projectId&&record.actionId===context.actionId&&!context.baseline,'judgment action context');reviewed(record.reviewed);
  keys(record.scope,['kind','findingVersionIds','regionAssetIds','unresolvedFindingIds'],'judgment scope');check(record.scope.kind==='findings'&&equal(record.scope.findingVersionIds,[record.findingVersionId])&&equal(record.scope.regionAssetIds,[])&&equal(record.scope.unresolvedFindingIds,[]),'inactive adapter judgment scope must name its exact finding version');
  check(['accepted','rejected','needs_clarification','retracted'].includes(record.decision),'human judgment decision');check(record.reasonAssetId===null||typeof record.reasonAssetId==='string'&&ASSET.test(record.reasonAssetId),'judgment reason asset');check(record.actorId===null,'reviewer identity remains unknown in inactive adapter');
  check(Array.isArray(record.supersedesJudgmentIds)&&record.supersedesJudgmentIds.length<=32&&new Set(record.supersedesJudgmentIds).size===record.supersedesJudgmentIds.length,'supersedes bound');for(const previous of record.supersedesJudgmentIds){id(previous,'superseded judgment');check(previous!==record.id,'self-superseded judgment');}
  check(record.supersedesJudgmentIds.length>0||record.reviewed.revisionId===context.expectedRevisionId,'new human judgment must name the actual prior reviewed revision');return record;
}
async function recordRow(record){const canonicalJson=canonicalCaptureJson(record);return freeze({id:record.projectId+':'+record.kind+':'+record.id,projectId:record.projectId,kind:record.kind,logicalId:record.id,canonicalJson,sha256:await sha256CaptureBytes(canonicalJson),bytes:byteLength(canonicalJson)});}
// A payload root hashes ordered segment metadata; its asset identity hashes the
// exact original bytes. Segment rows and root rows use distinct key namespaces.
export async function prepareCapturePayload(options){
  check(options&&typeof options==='object','payload options');check(Object.keys(options).sort().join('|')==='bytes|mediaType|projectId','payload fields');
  const projectId=id(options.projectId,'payload project'),mediaType=options.mediaType;
  check(['text/plain','application/json','application/octet-stream'].includes(mediaType),'payload mediaType');
  const source=options.bytes;let body;
  if(typeof source==='string')body=new Blob([encoder.encode(string(source,'payload text'))],{type:mediaType});
  else if(source instanceof Blob)body=source.slice(0,source.size,mediaType);
  else if(source instanceof ArrayBuffer)body=new Blob([source.slice(0)],{type:mediaType});
  else if(ArrayBuffer.isView(source))body=new Blob([new Uint8Array(source.buffer.slice(source.byteOffset,source.byteOffset+source.byteLength))],{type:mediaType});
  else fail('payload bytes');
  check(body.size<=PROPOSED_CAPTURE_LIMITS.payloadBytes,'payload byte limit');
  if(mediaType==='application/json'){const bytes=new Uint8Array(await body.arrayBuffer());let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('JSON payload invalid UTF-8');}opaqueJson(text,'JSON payload');}
  const wholeHash=await sha256CaptureBytes(body),assetId='sha256:'+wholeHash,rows=[],segmentAssetIds=[],segmentIds=[];
  for(let offset=0;offset<body.size;offset+=PROPOSED_CAPTURE_LIMITS.segmentBytes){const part=body.slice(offset,offset+PROPOSED_CAPTURE_LIMITS.segmentBytes),sha256=await sha256CaptureBytes(part),segmentAssetId='sha256:'+sha256,rowId=projectId+':segment:'+segmentAssetId;
    segmentAssetIds.push(segmentAssetId);segmentIds.push(rowId);if(!rows.some(row=>row.id===rowId))rows.push(freeze({id:rowId,projectId,kind:'capture-segment',assetId:segmentAssetId,sha256,bytes:part.size,body:part}));}
  const manifest={schema:'scorebrush-capture-payload',version:1,mediaType,bytes:body.size,sha256:wholeHash,segmentAssetIds},canonicalJson=canonicalCaptureJson(manifest),root=freeze({id:projectId+':blob:'+assetId,projectId,kind:'capture-payload',assetId,sha256:await sha256CaptureBytes(canonicalJson),canonicalJson,bytes:byteLength(canonicalJson),body:new Blob([canonicalJson],{type:'application/json'}),payloadBytes:body.size,segmentIds});
  rows.push(root);const token=freeze({assetId,projectId,payloadBytes:body.size,manifestBytes:root.bytes,rows});payloads.set(token,token);return token;
}
export async function createCaptureWriter(options){
  const input=own(options),hasObserved=Object.hasOwn(input,'observedParent');keys(input,['projectId','workspaceId','parent','startRevisionId','startStateJson','createdAt',...(hasObserved?['observedParent']:[])],'writer options');
  const projectId=id(input.projectId,'projectId'),workspaceId=id(input.workspaceId,'workspaceId');check(projectId!==workspaceId,'project and workspace identity must differ');id(input.startRevisionId,'startRevisionId');time(input.createdAt,'createdAt');opaqueJson(input.startStateJson,'startStateJson');
  if(input.parent!==null){anchor(input.parent,'parent');if(!hasObserved)check(input.parent.revisionId===input.startRevisionId,'parent revision mismatch');}
  const startStateHash=await sha256CaptureBytes(input.startStateJson);if(input.parent!==null&&!hasObserved)check(input.parent.afterStateHash===startStateHash,'parent state mismatch');
  if(hasObserved){check(input.parent!==null,'observed parent requires semantic parent');keys(input.observedParent,['storageRevision','revisionId','stateHash','observationRef'],'observed parent');integer(input.observedParent.storageRevision,'observed storage revision',1);check(input.observedParent.revisionId===input.startRevisionId&&input.observedParent.stateHash===startStateHash,'observed parent state mismatch');reference(input.observedParent.observationRef,projectId,'observed parent ref','observation');}
  const writerSessionId=crypto.randomUUID(),branchId=crypto.randomUUID(),streamId=crypto.randomUUID();
  const record={schema:SCHEMA,version:1,kind:'branch',id:branchId,projectId,streamId,writerSessionId,parentBranchId:input.parent?.branchId??null,forkAnchor:input.parent,rootCaptureStateHash:input.parent===null?startStateHash:null,createdAt:input.createdAt,...(hasObserved?{observedFork:input.observedParent}:{})};
  boundJson(record,PROPOSED_CAPTURE_LIMITS.descriptorBytes,'descriptor');const descriptor=await recordRow(record);
  const data=freeze({projectId,workspaceId,writerSessionId,branchId,streamId,parent:input.parent,startRevisionId:input.startRevisionId,startStateJson:input.startStateJson,startStateHash,descriptor,...(hasObserved?{observedParent:input.observedParent}:{})});
  const token=Object.freeze({});writers.set(token,data);return token;
}
export function readCaptureWriter(token){const value=writers.get(token);check(value,'writer must be a live token from createCaptureWriter');return value;}
export function preparedCaptureData(token){const value=prepared.get(token);check(value,'commit must be prepared by this module');return value;}
export async function prepareCaptureCommit(options){return prepareCommit(options,false);}
export async function prepareCaptureBaseline(options){return prepareCommit(options,true);}
async function prepareCommit(options,baselineMode){
  check(options&&typeof options==='object','commit options');const hasApplication=Object.hasOwn(options,'application');check(Object.keys(options).sort().join('|')===(hasApplication?'action|application|blobs|changedRecords|expected|publication|revisionId|stateJson|writer':'action|blobs|changedRecords|expected|publication|revisionId|stateJson|writer'),'commit fields');
  const writer=readCaptureWriter(options.writer),payloadTokens=[...options.blobs];check(payloadTokens.length<=(baselineMode?2004:PROPOSED_CAPTURE_LIMITS.changedRecords),'changed payload count');
  const input=own({expected:options.expected,revisionId:options.revisionId,stateJson:options.stateJson,action:options.action,changedRecords:options.changedRecords,publication:options.publication,...(hasApplication?{application:options.application}:{})});
  const {projectId,workspaceId,branchId,streamId,writerSessionId,descriptor}=writer;
  const expected=input.expected;if(expected!==null){keys(expected,['storageRevision','revisionId','stateHash','frontier',...(Object.hasOwn(expected,'observationRef')?['observationRef']:[])],'expected');integer(expected.storageRevision,'expected revision',1);id(expected.revisionId,'expected logical revision');hash(expected.stateHash,'expected state hash');anchor(expected.frontier,'expected frontier');if(Object.hasOwn(expected,'observationRef'))reference(expected.observationRef,projectId,'expected observation','observation');else check(expected.frontier.revisionId===expected.revisionId&&expected.frontier.afterStateHash===expected.stateHash,'expected frontier/state disagreement without observation');}
  if(baselineMode)check(expected===null&&hasApplication,'dedicated baseline requires absent current and complete application metadata');
  id(input.revisionId,'revisionId');opaqueJson(input.stateJson,'stateJson');
  if(hasApplication)validateCaptureApplication(input.application,projectId,input.revisionId);
  const sameStream=expected!==null&&expected.frontier.streamId===streamId;
  if(sameStream)check(expected.frontier.branchId===branchId,'owned stream branch mismatch');
  else if(writer.parent===null){check(expected===null,'root writer cannot adopt existing current');check(input.revisionId===writer.startRevisionId&&input.stateJson===writer.startStateJson,'capture-start must preserve exact baseline');}
  else check(expected!==null&&equal(expected.frontier,writer.parent)&&expected.revisionId===writer.startRevisionId&&expected.stateHash===writer.startStateHash,'fork anchor does not equal expected current');
  if(!sameStream&&writer.observedParent)check(expected.storageRevision===writer.observedParent.storageRevision&&expected.revisionId===writer.observedParent.revisionId&&expected.stateHash===writer.observedParent.stateHash,'observed fork does not equal expected current');
  const a=input.action;keys(a,['id','actionType','recordedAt','changes'],'action');id(a.id,'action id');time(a.recordedAt,'recordedAt');check(actionTypes.has(a.actionType),'action type not supported by inactive core');
  check(Array.isArray(a.changes)&&a.changes.length<=32,'changed-reference count');check(Array.isArray(input.changedRecords)&&input.changedRecords.length<=(baselineMode?2001:PROPOSED_CAPTURE_LIMITS.changedRecords),'changed-record count');
  if(expected===null)check(a.actionType==='capture.started'&&a.changes.length===0,'root first action must capture.started');else check(a.actionType!=='capture.started','capture.started is root-only');
  if(a.actionType==='branch.created')check(!sameStream&&writer.parent!==null&&a.changes.length===0&&input.stateJson===writer.startStateJson&&input.revisionId===writer.startRevisionId,'branch.created must preserve its explicit fork state');
  const context={projectId,workspaceId,branchId,actionId:a.id,revisionId:input.revisionId,baseline:expected===null,expectedRevisionId:expected?.revisionId??null};
  const changedRecords=[];const logicalIds=new Set();for(const raw of input.changedRecords){if(raw.kind==='finding-version'){finding(raw,projectId,a.id,input.revisionId);if(context.baseline)check(raw.previousVersionId===null&&!raw.deleted,'baseline findings cannot invent prior versions or tombstones');}else if(raw.kind==='revision')revision(raw,context);else if(raw.kind==='judgment')judgment(raw,context);else fail('unsupported changed record kind');check(!logicalIds.has(raw.kind+':'+raw.id),'duplicate changed record identity');logicalIds.add(raw.kind+':'+raw.id);boundJson(raw,PROPOSED_CAPTURE_LIMITS.recordBytes,'changed record');changedRecords.push(await recordRow(raw));}
  const refs=[],used=new Set(),changedEntities=new Set();
  const requireRecord=(kind,id,extra={})=>refs.push({store:'captureEvents',id:projectId+':'+kind+':'+id,sha256:null,kind,...extra});
  if(expected?.observationRef)requireRecord('observation',expected.observationRef.id,{sha256:expected.observationRef.sha256,observedFork:expected,frontierOfObservation:expected.frontier});
  if(writer.observedParent)requireRecord('observation',writer.observedParent.observationRef.id,{sha256:writer.observedParent.observationRef.sha256,observedFork:writer.observedParent,frontierOfObservation:writer.parent});
  for(const change of a.changes){keys(change,['entityKind','entityId','operation','beforeRef','afterRef'],'change');check(['finding','judgment','revision'].includes(change.entityKind),'unsupported change entity');id(change.entityId,'change entity id');const entityKey=change.entityKind+':'+change.entityId;check(!changedEntities.has(entityKey),'duplicate changed entity in one action');changedEntities.add(entityKey);check(['create','replace','delete','restore'].includes(change.operation),'change operation');
    const recordKind=change.entityKind==='finding'?'finding-version':change.entityKind;
    check(change.afterRef!==null,'changed entity requires immutable after record');reference(change.afterRef,projectId,'afterRef',recordKind);
    const row=changedRecords.find(item=>item.kind===recordKind&&item.logicalId===change.afterRef.id);check(row&&row.sha256===change.afterRef.sha256,'afterRef must match supplied changed record');const record=JSON.parse(row.canonicalJson);used.add(row.logicalId);
    if(change.entityKind!=='finding'){check(record.kind===recordKind&&record.id===change.entityId,'changed entity identity mismatch');check(change.operation==='create'&&change.beforeRef===null,'new revision/judgment records are append-only');continue;}
    check(record.findingId===change.entityId,'change finding identity mismatch');
    check((change.operation==='create')===(change.beforeRef===null),'create requires no prior version and every other operation requires one');
    if(change.beforeRef!==null){reference(change.beforeRef,projectId,'beforeRef');check(change.beforeRef.id!==change.afterRef.id,'immutable finding version reused');check(record.previousVersionId===change.beforeRef.id,'prior version mismatch');refs.push({store:'captureEvents',id:projectId+':finding-version:'+change.beforeRef.id,sha256:change.beforeRef.sha256,kind:'finding-version',findingId:record.findingId});}
    else check(record.previousVersionId===null&&change.operation==='create','missing prior version');
    check((change.operation==='delete')===record.deleted||change.operation==='create'&&!record.deleted,'operation/tombstone mismatch');
  }
  if(hasApplication){
    const app=input.application,appRefs=[app.revisionRef,...app.findingVersions.map(item=>item.versionRef),...app.judgmentHeads.map(item=>item.judgmentRef)];
    for(const ref of appRefs){const row=changedRecords.find(item=>item.kind===ref.kind&&item.logicalId===ref.id);if(row){check(row.sha256===ref.sha256,'application changed reference hash');if(expected===null)used.add(row.logicalId);}else refs.push({store:'captureEvents',id:projectId+':'+ref.kind+':'+ref.id,sha256:ref.sha256,kind:ref.kind});}
    for(const item of app.findingVersions)requireRecord('finding-version',item.versionRef.id,{findingId:item.findingId,sourceFindingId:item.sourceFindingId,deleted:item.deleted});
    for(const item of app.judgmentHeads)requireRecord('judgment',item.judgmentRef.id,{findingVersionId:item.findingVersionId,reviewed:item.reviewed});
    if(app.effectiveDecisionBindings?.length){const first=app.effectiveDecisionBindings[0],tuple={sourceAssetIds:first.sourceAssetIds,notationAssetId:first.notationAssetId,renderAssetIds:first.renderAssetIds};for(const item of app.effectiveDecisionBindings)check(equal(tuple,{sourceAssetIds:item.sourceAssetIds,notationAssetId:item.notationAssetId,renderAssetIds:item.renderAssetIds}),'effective decisions require the same current input tuple');requireRecord('revision',app.revisionRef.id,{reviewed:{revisionId:app.revisionRef.id,...tuple}});}
  }
  check(used.size===changedRecords.length,'unreferenced changed record');
  const operationForType={'finding.finalized':'create','finding.edited':'replace','finding.deleted':'delete'}[a.actionType];
  const findingChanges=a.changes.filter(change=>change.entityKind==='finding'),judgmentChanges=a.changes.filter(change=>change.entityKind==='judgment');
  if(operationForType)check(findingChanges.length>0&&findingChanges.every(change=>change.operation===operationForType),'finding action type/operation mismatch');
  if(a.actionType==='undo.outcome'||a.actionType==='redo.outcome')check(findingChanges.length>0,'undo/redo outcome requires explicit changed finding evidence');
  if(a.actionType.startsWith('judgment.'))check(judgmentChanges.length>0&&findingChanges.length===0,'judgment action requires explicit judgment records only');
  const judgmentRecords=input.changedRecords.filter(record=>record.kind==='judgment');
  for(const record of judgmentRecords)check((record.decision==='retracted')===(a.actionType==='judgment.retracted'),'retracted judgment requires its explicit retraction action');
  if(a.actionType==='judgment.reversed')check(judgmentRecords.some(record=>record.supersedesJudgmentIds.length>0),'judgment reversal requires an explicit predecessor');
  if(a.actionType==='judgment.retracted')check(judgmentRecords.every(record=>record.supersedesJudgmentIds.length>0),'judgment retraction requires explicit predecessors');
  if(a.actionType==='revision.loaded')check(a.changes.some(change=>change.entityKind==='revision')&&findingChanges.length===0&&judgmentChanges.length===0,'revision.loaded requires an input revision only');
  const blobs=[],blobIds=new Map(),suppliedPayloads=new Map();
  function addPayload(token){const data=payloads.get(token);check(data&&data.projectId===projectId,'payload must be owned/prepared for this project');suppliedPayloads.set(data.assetId,data);for(const row of data.rows){const previous=blobIds.get(row.id);check(!previous||previous.sha256===row.sha256&&previous.bytes===row.bytes,'conflicting prepared payload');if(!previous){blobIds.set(row.id,row);blobs.push(row);}}}
  for(const token of payloadTokens)addPayload(token);
  let baselineAssetId=writer.parent===null?'sha256:'+writer.startStateHash:null;if(expected===null){const baseline=await prepareCapturePayload({projectId,bytes:writer.startStateJson,mediaType:'application/json'});addPayload(baseline);}
  const usedAssets=new Set(baselineAssetId?[baselineAssetId]:[]);
  function requireAsset(assetId,mediaTypes,label){
    if(assetId===null)return;usedAssets.add(assetId);const payload=suppliedPayloads.get(assetId);
    if(payload){const manifest=JSON.parse(payload.rows.at(-1).canonicalJson);check(mediaTypes.includes(manifest.mediaType),label+' payload media type');}
    refs.push({store:'captureBlobs',id:projectId+':blob:'+assetId,sha256:null,assetId,kind:'capture-payload',mediaTypes});
  }
  for(const record of input.changedRecords){
    if(record.kind==='finding-version')requireAsset(record.geometryAssetId,['application/json'],'geometry');
    else if(record.kind==='revision'){
      for(const assetId of [...record.sourceAssetIds,...record.renderAssetIds])requireAsset(assetId,['application/octet-stream'],'score');
      requireAsset(record.notationAssetId,['text/plain','application/octet-stream'],'notation');
      for(const parent of record.parentIds)requireRecord('revision',parent);
    }else if(record.kind==='judgment'){
      requireAsset(record.reasonAssetId,['text/plain'],'judgment reason');
      if(record.reasonAssetId!==null&&suppliedPayloads.has(record.reasonAssetId)){
        const payload=suppliedPayloads.get(record.reasonAssetId),root=payload.rows.at(-1),body=new Blob(root.segmentIds.map(key=>payload.rows.find(row=>row.id===key).body));let text;
        try{text=new TextDecoder('utf-8',{fatal:true}).decode(await body.arrayBuffer());}catch{fail('judgment reason UTF-8');}string(text,'judgment reason');check(text.length<=4000,'judgment reason exceeds 4000 code units');
      }
      requireRecord('finding-version',record.findingVersionId,{deleted:false});
      requireRecord('revision',record.reviewed.revisionId,{reviewed:record.reviewed});
      requireRecord('revision',expected.revisionId);
      for(const previous of record.supersedesJudgmentIds)requireRecord('judgment',previous,{findingVersionId:record.findingVersionId,reviewed:record.reviewed,scope:record.scope,supersededBy:record.id});
    }
  }
  for(const asset of suppliedPayloads.keys())check(usedAssets.has(asset),'unreferenced changed payload');
  const stateHash=await sha256CaptureBytes(input.stateJson),sequence=sameStream?expected.frontier.sequence+1:1;integer(sequence,'stream sequence',1,PROPOSED_CAPTURE_LIMITS.actions);
  const previous=sameStream?expected.frontier:null,causal=previous??writer.parent;
  const record={schema:SCHEMA,version:1,kind:'action',id:a.id,projectId,streamId,branchId,workspaceId,revisionId:input.revisionId,sequence,prevEventHash:previous?.eventHash??null,causalActionIds:causal?[causal.eventId]:[],recordedAt:a.recordedAt,actorId:null,actionType:a.actionType,changes:a.changes,beforeStateHash:expected?.stateHash??writer.startStateHash,afterStateHash:stateHash,capturePolicy:'semantic-actions-v1',evidenceBasis:'application_observation',streamDescriptorHash:descriptor.sha256,...(expected?.observationRef?{beforeObservationRef:expected.observationRef}:{})};
  record.eventHash=await hashCaptureRecord(record);boundJson(record,PROPOSED_CAPTURE_LIMITS.actionBytes,'action');const action=await recordRow(record);
  const frontier={branchId,streamId,sequence,eventId:a.id,eventHash:record.eventHash,afterStateHash:stateHash,revisionId:input.revisionId};
  if(causal)refs.push({store:'captureEvents',id:projectId+':action:'+causal.eventId,sha256:null,eventHash:causal.eventHash,frontier:causal,kind:'action'});
  const pub=input.publication;keys(pub,['intentId','reservationId','destinationId','expectedHead'],'publication');for(const key of ['intentId','reservationId','destinationId'])id(pub[key],key);if(pub.expectedHead!==null)hash(pub.expectedHead,'expected publication head');
  const coverage={policy:'semantic-actions-v1',priorHistory:'not-reconstructed',startStateHash:writer.startStateHash,baselineAssetId,throughFrontier:frontier};
  const current={id:'capture-current:'+projectId+':'+workspaceId,projectId,workspaceId,kind:'capture-current',version:1,storageRevision:(expected?.storageRevision??0)+1,revisionId:input.revisionId,stateJson:input.stateJson,stateHash,frontier,descriptorHash:descriptor.sha256,activeBranchDescriptor:JSON.parse(descriptor.canonicalJson),pendingIntentId:projectId+':intent:'+pub.intentId,coverage,...(hasApplication?{application:input.application}:{})};integer(current.storageRevision,'next storage revision',1);
  const currentJson=boundJson(current,PROPOSED_CAPTURE_LIMITS.currentBytes,'current envelope');
  const stream={id:projectId+':stream:'+streamId,kind:'capture-stream',version:1,projectId,streamId,branchId,writerSessionId,descriptorId:descriptor.id,descriptorHash:descriptor.sha256,frontier};
  const allChangedRefs=[descriptor,action,...changedRecords].map(row=>({id:row.id,sha256:row.sha256,bytes:row.bytes})),allBlobRefs=blobs.map(row=>({id:row.id,sha256:row.sha256,bytes:row.bytes}));
  let publicationBytes=byteLength(currentJson)+allChangedRefs.reduce((sum,row)=>sum+row.bytes,0)+allBlobRefs.reduce((sum,row)=>sum+row.bytes,0);
  let baselineStage=null;
  if(baselineMode){
    const rows=[['captureEvents',descriptor],...changedRecords.map(row=>['captureEvents',row]),...blobs.map(row=>['captureBlobs',row])],batches=[];
    for(let offset=0;offset<rows.length;offset+=32){const entries=rows.slice(offset,offset+32),index=batches.length,manifest={schema:'scorebrush-capture-baseline-batch',version:1,projectId,baselineId:a.id,index,rows:entries.map(([store,row])=>({store,id:row.id,sha256:row.sha256,bytes:row.bytes}))};const canonicalJson=boundJson(manifest,32768,'baseline batch manifest'),sha256=await sha256CaptureBytes(canonicalJson);batches.push({index,entries,receipt:{id:projectId+':baseline-batch:'+a.id+':'+index,projectId,kind:'capture-baseline-batch',version:1,canonicalJson,sha256,bytes:byteLength(canonicalJson)}});}
    check(batches.length<=512,'baseline batch count');
    const manifest={schema:'scorebrush-capture-baseline-plan',version:1,projectId,baselineId:a.id,currentStateHash:stateHash,currentRevisionId:input.revisionId,currentSha256:await sha256CaptureBytes(currentJson),actionHash:action.sha256,batchHashes:batches.map(batch=>batch.receipt.sha256),publicationBytes};
    const contentBytes=publicationBytes+batches.reduce((sum,batch)=>sum+batch.receipt.bytes,0);for(let i=0;i<12;i++){const bytes=contentBytes+byteLength(canonicalCaptureJson(manifest));if(bytes===manifest.publicationBytes)break;manifest.publicationBytes=bytes;}publicationBytes=manifest.publicationBytes;
    const canonicalJson=boundJson(manifest,65536,'baseline plan'),planHash=await sha256CaptureBytes(canonicalJson);check(publicationBytes===contentBytes+byteLength(canonicalJson),'baseline reservation accounting');
    baselineStage={id:projectId+':baseline:'+a.id,projectId,baselineId:a.id,planHash,canonicalJson,batchCount:batches.length,batches,publicationBytes};
  }
  const changedRefs=baselineMode?allChangedRefs.slice(0,2):allChangedRefs,blobRefs=baselineMode?[]:allBlobRefs;
  const reservation={id:pub.reservationId,publicationBytes,actionSlots:0,status:'reserved',meaning:'provisional prepared bytes; not folder-space or browser-quota guarantee'};
  const outbox={id:projectId+':intent:'+pub.intentId,kind:'capture-outbox',version:1,intentId:pub.intentId,projectId,branchId,phase:'prepared',destinationId:pub.destinationId,expectedHead:pub.expectedHead,frontier,stateHash,revisionId:input.revisionId,reservationId:pub.reservationId,reservation,changedRefs,blobRefs,publicationSucceeded:false,...(baselineStage?{baselineClosure:{stageId:baselineStage.id,planHash:baselineStage.planHash}}:{})};
  const outboxJson=boundJson(outbox,PROPOSED_CAPTURE_LIMITS.outboxBytes,'outbox'),streamJson=canonicalCaptureJson(stream);
  const accounting={currentBytes:byteLength(currentJson),actionBytes:action.bytes,changedRecordBytes:changedRecords.reduce((sum,row)=>sum+row.bytes,0),descriptorBytes:descriptor.bytes,blobBytes:blobs.reduce((sum,row)=>sum+row.bytes,0),blobRows:blobs.length,outboxBytes:byteLength(outboxJson),streamBytes:byteLength(streamJson),reservationBytes:publicationBytes,manifestBytes:blobs.filter(row=>row.kind==='capture-payload').reduce((sum,row)=>sum+row.bytes,0),status:'PROPOSED_MODULE_ACCOUNTING_NOT_PRODUCT_LIMIT_ACCEPTANCE'};
  const snapshot=freeze({projectId,workspaceId,expected,expectedStreamFrontier:previous,current,action,changedRecords,descriptor,stream,blobs,outbox,requiredRefs:refs,accounting,...(baselineStage?{baselineStage}:{})});const token=Object.freeze({});prepared.set(token,snapshot);return token;
}

export function readCaptureBaselinePlan(token){const data=preparedCaptureData(token),stage=data.baselineStage;check(stage,'prepared commit is not a dedicated baseline');return freeze({id:stage.id,planHash:stage.planHash,batchCount:stage.batchCount});}

export async function prepareCaptureBaselineRestartData(token){
  if(restartPlans.has(token))return restartPlans.get(token);
  const data=preparedCaptureData(token),stage=data.baselineStage;check(stage,'restart requires dedicated baseline');const descriptor=JSON.parse(data.descriptor.canonicalJson),action=JSON.parse(data.action.canonicalJson);
  const expectedHashes={};for(const field of ['current','action','descriptor','stream','outbox'])expectedHashes[field]=await sha256CaptureBytes(canonicalCaptureJson(data[field]));
  const control={schema:'scorebrush-capture-baseline-restart',version:1,projectId:data.projectId,baselineId:stage.baselineId,planHash:stage.planHash,expectedHashes,writer:{workspaceId:data.workspaceId,writerSessionId:descriptor.writerSessionId,branchId:descriptor.id,streamId:descriptor.streamId,createdAt:descriptor.createdAt},stateAssetId:data.current.coverage.baselineAssetId,stateHash:data.current.stateHash,revisionId:data.current.revisionId,action:{id:action.id,actionType:action.actionType,recordedAt:action.recordedAt,changes:action.changes},application:data.current.application,publication:{intentId:data.outbox.intentId,reservationId:data.outbox.reservationId,destinationId:data.outbox.destinationId,expectedHead:data.outbox.expectedHead},rows:stage.batches.flatMap(batch=>batch.entries.map(([store,row])=>({store,id:row.id,sha256:row.sha256,bytes:row.bytes})))};
  check(control.rows.length<=CAPTURE_RESTART_LIMITS.rows,'restart row count');const canonicalJson=boundJson(control,CAPTURE_RESTART_LIMITS.controlBytes,'restart control'),sha256=await sha256CaptureBytes(canonicalJson),body=new Blob([canonicalJson],{type:'application/json'});
  const artifact=freeze({id:data.projectId+':baseline-restart-control:'+stage.baselineId,projectId:data.projectId,kind:'capture-baseline-restart-control',version:1,baselineId:stage.baselineId,planHash:stage.planHash,sha256,bytes:body.size,body});
  const result=freeze({control,canonicalJson,artifact});restartPlans.set(token,result);return result;
}

// Rebuild only after checking actual durable bytes. No persisted flag grants trust.
export async function restoreCaptureBaselinePreparation(controlJson,entries){
  string(controlJson,'restart control');check(byteLength(controlJson)<=CAPTURE_RESTART_LIMITS.controlBytes,'restart control byte limit');let control;try{control=JSON.parse(controlJson);}catch{fail('restart control JSON');}
  check(canonicalCaptureJson(control)===controlJson,'restart control canonical bytes');keys(control,['schema','version','projectId','baselineId','planHash','expectedHashes','writer','stateAssetId','stateHash','revisionId','action','application','publication','rows'],'restart control');check(control.schema==='scorebrush-capture-baseline-restart'&&control.version===1,'restart control schema/version');id(control.projectId,'restart project');id(control.baselineId,'restart baseline');hash(control.planHash,'restart plan hash');hash(control.stateHash,'restart state hash');check(control.stateAssetId==='sha256:'+control.stateHash,'restart baseline asset identity');id(control.revisionId,'restart revision');keys(control.expectedHashes,['current','action','descriptor','stream','outbox'],'restart expected hashes');for(const value of Object.values(control.expectedHashes))hash(value,'restart expected hash');
  keys(control.writer,['workspaceId','writerSessionId','branchId','streamId','createdAt'],'restart writer');for(const field of ['workspaceId','writerSessionId','branchId','streamId'])id(control.writer[field],'restart '+field);time(control.writer.createdAt,'restart createdAt');check(control.writer.workspaceId!==control.projectId,'restart project/workspace identity');
  check(Array.isArray(control.rows)&&control.rows.length>0&&control.rows.length<=CAPTURE_RESTART_LIMITS.rows&&Array.isArray(entries)&&entries.length===control.rows.length,'restart bounded row closure');const seen=new Set(),rows=new Map();
  for(let index=0;index<control.rows.length;index++){
    const ref=control.rows[index];keys(ref,['store','id','sha256','bytes'],'restart row ref');check(['captureEvents','captureBlobs'].includes(ref.store),'restart row store');hash(ref.sha256,'restart row hash');integer(ref.bytes,'restart row bytes',0,PROPOSED_CAPTURE_LIMITS.payloadBytes);const pair=entries[index];check(Array.isArray(pair)&&pair.length===2&&pair[0]===ref.store,'restart row order');const row=pair[1];check(row&&row.id===ref.id&&row.projectId===control.projectId&&row.sha256===ref.sha256&&row.bytes===ref.bytes,'restart row identity');const key=ref.store+':'+ref.id;check(!seen.has(key),'duplicate restart row');seen.add(key);rows.set(key,row);
    if(ref.store==='captureEvents'){
      keys(row,['id','projectId','kind','logicalId','canonicalJson','sha256','bytes'],'restart record row');check(byteLength(row.canonicalJson)===row.bytes&&await sha256CaptureBytes(row.canonicalJson)===row.sha256,'restart actual record hash/size');const record=JSON.parse(row.canonicalJson);check(canonicalCaptureJson(record)===row.canonicalJson&&record.id===row.logicalId&&record.kind===row.kind&&record.projectId===control.projectId&&row.id===control.projectId+':'+record.kind+':'+record.id,'restart record identity');
    }else if(row.kind==='capture-segment'){
      keys(row,['id','projectId','kind','assetId','sha256','bytes','body'],'restart segment');check(row.body instanceof Blob&&row.body.size===row.bytes&&row.bytes<=PROPOSED_CAPTURE_LIMITS.segmentBytes&&row.assetId==='sha256:'+row.sha256&&row.id===control.projectId+':segment:'+row.assetId&&await sha256CaptureBytes(row.body)===row.sha256,'restart actual segment hash/size');
    }else{
      keys(row,['id','projectId','kind','assetId','sha256','canonicalJson','bytes','body','payloadBytes','segmentIds'],'restart payload');check(row.kind==='capture-payload'&&row.body instanceof Blob&&row.body.size===row.bytes&&byteLength(row.canonicalJson)===row.bytes&&await row.body.text()===row.canonicalJson&&await sha256CaptureBytes(row.body)===row.sha256,'restart actual payload manifest hash/size');
    }
  }
  const payloadTokens=[],payloadByAsset=new Map();for(const [store,row]of entries)if(store==='captureBlobs'&&row.kind==='capture-payload'){
    const manifest=JSON.parse(row.canonicalJson);keys(manifest,['schema','version','mediaType','bytes','sha256','segmentAssetIds'],'restart payload manifest');check(manifest.schema==='scorebrush-capture-payload'&&manifest.version===1&&canonicalCaptureJson(manifest)===row.canonicalJson&&row.assetId==='sha256:'+manifest.sha256&&row.id===control.projectId+':blob:'+row.assetId&&row.payloadBytes===manifest.bytes,'restart payload manifest identity');check(Array.isArray(manifest.segmentAssetIds)&&manifest.segmentAssetIds.length<=400&&equal(row.segmentIds,manifest.segmentAssetIds.map(asset=>control.projectId+':segment:'+asset)),'restart payload segment closure');const segments=row.segmentIds.map(key=>rows.get('captureBlobs:'+key));check(segments.every(Boolean),'restart missing payload segment');const body=new Blob(segments.map(segment=>segment.body),{type:manifest.mediaType});check(body.size===manifest.bytes&&await sha256CaptureBytes(body)===manifest.sha256,'restart actual complete payload hash/size');const token=await prepareCapturePayload({projectId:control.projectId,bytes:body,mediaType:manifest.mediaType});check(token.assetId===row.assetId&&equal(token.rows.at(-1).segmentIds,row.segmentIds)&&token.rows.at(-1).sha256===row.sha256,'restart rebuilt payload differs');payloadTokens.push(token);payloadByAsset.set(row.assetId,body);
  }
  const stateBody=payloadByAsset.get(control.stateAssetId);check(stateBody,'restart missing exact baseline state');let stateJson;try{stateJson=new TextDecoder('utf-8',{fatal:true}).decode(await stateBody.arrayBuffer());}catch{fail('restart baseline UTF-8');}opaqueJson(stateJson,'restart baseline state');check(await sha256CaptureBytes(stateJson)===control.stateHash,'restart baseline state hash');
  const descriptor=rows.get('captureEvents:'+control.projectId+':branch:'+control.writer.branchId);check(descriptor,'restart missing original descriptor');const expectedDescriptor={schema:SCHEMA,version:1,kind:'branch',id:control.writer.branchId,projectId:control.projectId,streamId:control.writer.streamId,writerSessionId:control.writer.writerSessionId,parentBranchId:null,forkAnchor:null,rootCaptureStateHash:control.stateHash,createdAt:control.writer.createdAt};check(descriptor.canonicalJson===canonicalCaptureJson(expectedDescriptor),'restart original descriptor differs');boundJson(expectedDescriptor,PROPOSED_CAPTURE_LIMITS.descriptorBytes,'restart descriptor');
  const writer=Object.freeze({});writers.set(writer,freeze({projectId:control.projectId,workspaceId:control.writer.workspaceId,writerSessionId:control.writer.writerSessionId,branchId:control.writer.branchId,streamId:control.writer.streamId,parent:null,startRevisionId:control.revisionId,startStateJson:stateJson,startStateHash:control.stateHash,descriptor}));
  check(control.action.id===control.baselineId,'restart action identity');const changedRecords=entries.filter(([store,row])=>store==='captureEvents'&&row.id!==descriptor.id).map(([,row])=>JSON.parse(row.canonicalJson));
  const token=await prepareCaptureBaseline({writer,expected:null,revisionId:control.revisionId,stateJson,action:control.action,changedRecords,blobs:payloadTokens,application:control.application,publication:control.publication}),restored=preparedCaptureData(token);check(restored.baselineStage.planHash===control.planHash,'restart reconstructed plan hash differs');for(const [field,expectedHash]of Object.entries(control.expectedHashes))check(await sha256CaptureBytes(canonicalCaptureJson(restored[field]))===expectedHash,'restart exact '+field+' hash differs');check(equal(restored.baselineStage.batches.flatMap(batch=>batch.entries.map(([store,row])=>({store,id:row.id,sha256:row.sha256,bytes:row.bytes}))),control.rows),'restart reconstructed complete row closure differs');return token;
}

export async function prepareCaptureObservation(options){
  keys(options,['writer','current','stateJson','revisionId','revisionRecord','application','observationId'],'observation options');
  const writer=readCaptureWriter(options.writer),input=own({current:options.current,stateJson:options.stateJson,revisionId:options.revisionId,revisionRecord:options.revisionRecord,application:options.application,observationId:options.observationId}),old=input.current;
  check(old?.projectId===writer.projectId&&old.workspaceId===writer.workspaceId&&old.kind==='capture-current','observation current ownership');id(input.observationId,'observation ID');id(input.revisionId,'observed revision');opaqueJson(input.stateJson,'observed state');anchor(old.frontier,'semantic frontier');
  validateCaptureApplication(input.application,writer.projectId,input.revisionId);check(old.application,'observation needs application baseline');
  check(equal(old.application.findingVersions,input.application.findingVersions)&&equal(old.application.judgmentHeads,input.application.judgmentHeads)&&equal(old.application.effectiveDecisionBindings??null,input.application.effectiveDecisionBindings??null)&&old.application.sourceWorkspaceId===input.application.sourceWorkspaceId,'observation cannot replace semantic finding or judgment pointers');
  const changedRecords=[],refs=[];
  if(input.revisionId===old.revisionId){check(input.revisionRecord===null&&equal(input.application.revisionRef,old.application.revisionRef),'unchanged observed revision must reuse its immutable ref');}
  else{check(input.revisionRecord!==null,'new observed revision requires immutable revision record');revision(input.revisionRecord,{projectId:writer.projectId,workspaceId:writer.workspaceId,branchId:old.frontier.branchId,actionId:null,revisionId:input.revisionId,baseline:false,expectedRevisionId:old.revisionId,observation:true,frontier:old.frontier});const row=await recordRow(input.revisionRecord);check(row.sha256===input.application.revisionRef.sha256,'observed revision reference hash');changedRecords.push(row);}
  const stateHash=await sha256CaptureBytes(input.stateJson);check(stateHash!==old.stateHash||input.revisionId!==old.revisionId,'identical observed state is a no-op');
  const record={schema:SCHEMA,version:1,kind:'observation',id:input.observationId,projectId:writer.projectId,workspaceId:writer.workspaceId,revisionId:input.revisionId,previousRevisionId:old.revisionId,previousObservationRef:old.observationRef??null,beforeStateHash:old.stateHash,afterStateHash:stateHash,storageRevision:old.storageRevision+1,semanticFrontier:old.frontier,revisionRef:input.application.revisionRef};
  boundJson(record,PROPOSED_CAPTURE_LIMITS.recordBytes,'observation');const observation=await recordRow(record),observationRef={kind:'observation',id:record.id,projectId:writer.projectId,sha256:observation.sha256};
  const current={...old,storageRevision:record.storageRevision,revisionId:input.revisionId,stateJson:input.stateJson,stateHash,application:input.application,observationRef};boundJson(current,PROPOSED_CAPTURE_LIMITS.currentBytes,'observed current');
  refs.push({store:'captureEvents',id:writer.projectId+':revision:'+old.revisionId,kind:'revision',sha256:old.application.revisionRef.sha256},{store:'captureEvents',id:writer.projectId+':revision:'+input.revisionId,kind:'revision',sha256:input.application.revisionRef.sha256},{store:'captureEvents',id:writer.projectId+':action:'+old.frontier.eventId,kind:'action',eventHash:old.frontier.eventHash,frontier:old.frontier});
  if(old.observationRef){reference(old.observationRef,writer.projectId,'previous observation','observation');refs.push({store:'captureEvents',id:writer.projectId+':observation:'+old.observationRef.id,kind:'observation',sha256:old.observationRef.sha256,observedFork:old,frontierOfObservation:old.frontier});}
  const expected=Object.fromEntries(['storageRevision','revisionId','stateHash','frontier',...(old.observationRef?['observationRef']:[])].map(key=>[key,old[key]])),data=freeze({mode:'observation',projectId:writer.projectId,workspaceId:writer.workspaceId,expected,current,observation,action:null,descriptor:null,stream:null,changedRecords,blobs:[],outbox:null,requiredRefs:refs,accounting:{status:'PROPOSED_MODULE_ACCOUNTING_NOT_PRODUCT_LIMIT_ACCEPTANCE',currentBytes:byteLength(canonicalCaptureJson(current)),observationBytes:observation.bytes,changedRecordBytes:changedRecords.reduce((sum,row)=>sum+row.bytes,0)}}),token=Object.freeze({});prepared.set(token,data);return token;
}
