// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalCaptureJson,hashCaptureRecord,sha256CaptureBytes,createCaptureWriter,
  readCaptureWriter,prepareCapturePayload,prepareCaptureCommit,preparedCaptureData,
  prepareCaptureObservation,prepareCaptureBaseline,readCaptureBaselinePlan,
  prepareCaptureBaselineRestartData,restoreCaptureBaselinePreparation,CAPTURE_RESTART_LIMITS,
  validateCaptureEvidenceRecord,
  PROPOSED_CAPTURE_LIMITS} from '../app/capture-format.js';

const uuid=n=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const at='2026-10-28T00:00:00.000Z',state=' { "unknownLegacy": {"x": 0.123456789012345, "zero": -0}, "text": "é" }\n';
const expected=current=>Object.fromEntries(['storageRevision','revisionId','stateHash','frontier',...(current.observationRef?['observationRef']:[])].map(key=>[key,current[key]]));
async function initial(project=1,workspace=2){
  const writer=await createCaptureWriter({projectId:uuid(project),workspaceId:uuid(workspace),parent:null,startRevisionId:uuid(3),startStateJson:state,createdAt:at});
  const input={writer,expected:null,revisionId:uuid(3),stateJson:state,action:{id:uuid(4),actionType:'capture.started',recordedAt:at,changes:[]},changedRecords:[],blobs:[],publication:{intentId:uuid(5),reservationId:uuid(6),destinationId:uuid(7),expectedHead:null}};
  const token=await prepareCaptureCommit(input);return {writer,input,token,data:preparedCaptureData(token)};
}
async function edited(seed,{payload=null,writer=seed.writer,number=10}={}){
  const projectId=seed.data.projectId,actionId=uuid(number),revisionId=uuid(number+1),findingId=uuid(number+2),versionId=uuid(number+3);
  const record={schema:'scorebrush-research-record',version:1,kind:'finding-version',id:versionId,projectId,findingId,previousVersionId:null,revisionId,createdByActionId:actionId,category:'transcription_error',geometryAssetId:payload?.assetId??null,deleted:false,text:'Exact note ≤ 4000 code units'};
  const change={entityKind:'finding',entityId:findingId,operation:'create',beforeRef:null,afterRef:{kind:'finding-version',id:versionId,projectId,sha256:await hashCaptureRecord(record)}};
  return {writer,expected:expected(seed.data.current),revisionId,stateJson:'{"unknownLegacy":{"x":0.123456789012345},"finding":"'+findingId+'"}\n',action:{id:actionId,actionType:'finding.finalized',recordedAt:at,changes:[change]},changedRecords:[record],blobs:payload?[payload]:[],publication:{intentId:uuid(number+4),reservationId:uuid(number+5),destinationId:uuid(7),expectedHead:null}};
}
const typed=async record=>({kind:record.kind,id:record.id,projectId:record.projectId,sha256:await hashCaptureRecord(record)});
async function applicationInitial(){
  const seed=await initial(),writer=readCaptureWriter(seed.writer),projectId=seed.data.projectId;
  const source=await prepareCapturePayload({projectId,bytes:'%PDF synthetic source',mediaType:'application/octet-stream'}),render=await prepareCapturePayload({projectId,bytes:'%PDF synthetic render',mediaType:'application/octet-stream'}),notation=await prepareCapturePayload({projectId,bytes:'{ c4 }',mediaType:'text/plain'});
  const revision={schema:'scorebrush-research-record',version:1,kind:'revision',id:seed.input.revisionId,projectId,parentIds:[],branchId:writer.branchId,workspaceId:writer.workspaceId,sourceAssetIds:[source.assetId],notationAssetId:notation.assetId,renderAssetIds:[render.assetId],dependencySetId:null,createdByActionId:null,reason:'baseline'};
  const finding={schema:'scorebrush-research-record',version:1,kind:'finding-version',id:uuid(300),projectId,findingId:uuid(301),sourceFindingId:'legacy-finding-a',originalType:'source_footnote',previousVersionId:null,revisionId:revision.id,createdByActionId:seed.input.action.id,category:'unclassified',geometryAssetId:null,deleted:false,text:'Exact legacy footnote'};
  const application={schema:'scorebrush-capture-application',version:1,sourceWorkspaceId:'project:existing-workspace-key',revisionRef:await typed(revision),findingVersions:[{sourceFindingId:finding.sourceFindingId,findingId:finding.findingId,versionRef:await typed(finding),deleted:false}],judgmentHeads:[]};
  const input={...seed.input,changedRecords:[revision,finding],blobs:[source,render,notation],application},data=preparedCaptureData(await prepareCaptureCommit(input));
  return {...seed,input,data,revision,finding,source,render,notation};
}
async function judgmentInput(seed){
  const actionId=uuid(400),revisionId=uuid(401),writer=readCaptureWriter(seed.writer),revision={...seed.revision,id:revisionId,parentIds:[seed.revision.id],branchId:writer.branchId,createdByActionId:actionId,reason:'review_only'};
  const reviewed={revisionId:seed.revision.id,sourceAssetIds:seed.revision.sourceAssetIds,notationAssetId:seed.revision.notationAssetId,renderAssetIds:seed.revision.renderAssetIds};
  const judgment={schema:'scorebrush-research-record',version:1,kind:'judgment',id:uuid(402),projectId:seed.data.projectId,findingVersionId:seed.finding.id,reviewed,scope:{kind:'findings',findingVersionIds:[seed.finding.id],regionAssetIds:[],unresolvedFindingIds:[]},decision:'accepted',reasonAssetId:null,actorId:null,actionId,supersedesJudgmentIds:[]};
  const application={...seed.input.application,revisionRef:await typed(revision),judgmentHeads:[{sourceFindingId:seed.finding.sourceFindingId,findingVersionId:seed.finding.id,reviewed,judgmentRef:await typed(judgment)}]};
  const changes=[];for(const record of [revision,judgment])changes.push({entityKind:record.kind,entityId:record.id,operation:'create',beforeRef:null,afterRef:await typed(record)});
  return {writer:seed.writer,expected:expected(seed.data.current),revisionId,stateJson:'{"domainState":"human decision"}',action:{id:actionId,actionType:'judgment.changed',recordedAt:at,changes},changedRecords:[revision,judgment],blobs:[],publication:{intentId:uuid(403),reservationId:uuid(404),destinationId:uuid(7),expectedHead:null},application};
}

test('canonical new metadata is exact, sorted ASCII, without Unicode normalization',async()=>{
  const value={z:0,a:['é','é','line\n"quote"',true,null],n:-5};
  assert.equal(canonicalCaptureJson(value),'{"a":["é","é","line\\n\\\"quote\\\"",true,null],"n":-5,"z":0}');
  assert.equal(await hashCaptureRecord(value),createHash('sha256').update(canonicalCaptureJson(value),'utf8').digest('hex'));
  assert.notEqual(await sha256CaptureBytes('é'),await sha256CaptureBytes('é'));
});

test('unsafe numbers, lone surrogates, hidden fields, cycles and accessors are rejected',()=>{
  for(const value of [NaN,Infinity,-Infinity,-0,0.1,Number.MAX_SAFE_INTEGER+1,undefined,()=>{},new Date(),'\ud800','\udc00',{'é':1}])assert.throws(()=>canonicalCaptureJson(value));
  const cycle={};cycle.self=cycle;assert.throws(()=>canonicalCaptureJson(cycle),/cyclic/);
  const sparse=[];sparse[1]=1;assert.throws(()=>canonicalCaptureJson(sparse),/sparse/);
  let calls=0;const object={};Object.defineProperty(object,'a',{get(){calls++;return 1;},enumerable:true});assert.throws(()=>canonicalCaptureJson(object),/accessor/);
  const array=[0];Object.defineProperty(array,'0',{get(){calls++;return 1;},enumerable:true});assert.throws(()=>canonicalCaptureJson(array),/accessor/);assert.equal(calls,0);
  const hidden={};Object.defineProperty(hidden,'x',{value:1});assert.throws(()=>canonicalCaptureJson(hidden),/hidden/);
});

test('root commit binds unchanged legacy bytes, baseline closure and truthful pending state',async()=>{
  const {data,writer}=await initial();const w=readCaptureWriter(writer),action=JSON.parse(data.action.canonicalJson),descriptor=JSON.parse(data.descriptor.canonicalJson);
  assert.equal(data.current.stateJson,state);assert.equal(data.current.stateHash,createHash('sha256').update(state).digest('hex'));
  assert.equal(data.current.coverage.priorHistory,'not-reconstructed');assert.equal(data.current.coverage.baselineAssetId,'sha256:'+data.current.stateHash);
  assert.equal(data.outbox.phase,'prepared');assert.equal(data.outbox.publicationSucceeded,false);assert.equal(data.current.pendingIntentId,data.outbox.id);
  assert.equal(descriptor.rootCaptureStateHash,data.current.stateHash);assert.equal(descriptor.parentBranchId,null);assert.equal(action.sequence,1);assert.equal(action.prevEventHash,null);assert.deepEqual(action.causalActionIds,[]);
  assert.equal(action.streamDescriptorHash,data.descriptor.sha256);assert.equal(action.streamId,w.streamId);assert.equal(action.branchId,w.branchId);
  const eventHash=action.eventHash;delete action.eventHash;assert.equal(eventHash,await hashCaptureRecord(action));
  const root=data.blobs.find(row=>row.kind==='capture-payload');const manifest=JSON.parse(root.canonicalJson);assert.equal(root.assetId,data.current.coverage.baselineAssetId);
  const segments=root.segmentIds.map(key=>data.blobs.find(row=>row.id===key));assert.equal(await new Blob(segments.map(row=>row.body)).text(),state);assert.equal(manifest.sha256,data.current.stateHash);
  assert.equal(data.accounting.manifestBytes,root.bytes);assert.equal(data.accounting.blobBytes,data.blobs.reduce((sum,row)=>sum+row.bytes,0));
});

test('prepared bytes are owned and opaque tokens cannot be reconstructed or mutated',async()=>{
  const seed=await initial(),input=await edited(seed);const original=structuredClone(input.changedRecords[0]);
  const promise=prepareCaptureCommit(input);input.changedRecords[0].text='mutated after preparing';input.action.changes[0].entityId=uuid(999);input.stateJson='{}';
  const data=preparedCaptureData(await promise);assert.deepEqual(JSON.parse(data.changedRecords[0].canonicalJson),original);assert.notEqual(data.current.stateJson,'{}');
  assert.throws(()=>{data.current.stateJson='{}';},TypeError);assert.throws(()=>preparedCaptureData({}),/prepared/);assert.throws(()=>readCaptureWriter(structuredClone(seed.writer)),/live token/);
  assert.throws(()=>{data.blobs.push({});},TypeError);
});

test('geometry keeps original floats and bytes; segmentation counts root overhead and owns mutable input',async()=>{
  const seed=await initial();const geometry=' {"points":[[0.123456789012345, -0, 3.141592653589793]],"padding":"'+'x'.repeat(PROPOSED_CAPTURE_LIMITS.segmentBytes)+'"}\n';
  const bytes=new TextEncoder().encode(geometry),promise=prepareCapturePayload({projectId:seed.data.projectId,bytes,mediaType:'application/json'});bytes.fill(0);
  const payload=await promise,root=payload.rows.at(-1),parts=root.segmentIds.map(key=>payload.rows.find(row=>row.id===key));
  assert.equal(parts.length,2);assert(parts.every(row=>row.bytes<=PROPOSED_CAPTURE_LIMITS.segmentBytes));assert.equal(await new Blob(parts.map(row=>row.body)).text(),geometry);
  assert.equal(payload.assetId,'sha256:'+createHash('sha256').update(geometry).digest('hex'));assert(root.bytes>0);assert.equal(payload.rows.reduce((sum,row)=>sum+row.bytes,0),new TextEncoder().encode(geometry).length+root.bytes);
  const data=preparedCaptureData(await prepareCaptureCommit(await edited(seed,{payload})));assert.equal(JSON.parse(data.changedRecords[0].canonicalJson).geometryAssetId,payload.assetId);assert.equal(data.blobs.length,3);
});

test('same writer extends only its exact stream; fresh writer forks from explicit parent',async()=>{
  const seed=await initial(),next=preparedCaptureData(await prepareCaptureCommit(await edited(seed)));const event=JSON.parse(next.action.canonicalJson);
  assert.equal(event.sequence,2);assert.equal(event.prevEventHash,seed.data.current.frontier.eventHash);assert.deepEqual(event.causalActionIds,[seed.data.current.frontier.eventId]);assert.deepEqual(next.expectedStreamFrontier,seed.data.current.frontier);
  assert.equal(next.current.coverage.baselineAssetId,seed.data.current.coverage.baselineAssetId);assert(!next.requiredRefs.some(ref=>ref.assetId===seed.data.current.coverage.baselineAssetId),'unchanged baseline is not reread during ordinary commit');
  assert.equal(await hashCaptureRecord(next.current.activeBranchDescriptor),next.current.descriptorHash);
  const writer=await createCaptureWriter({projectId:seed.data.projectId,workspaceId:seed.data.workspaceId,parent:seed.data.current.frontier,startRevisionId:seed.data.current.revisionId,startStateJson:state,createdAt:at});
  const fork=preparedCaptureData(await prepareCaptureCommit(await edited(seed,{writer,number:30}))),forkEvent=JSON.parse(fork.action.canonicalJson);
  assert.equal(forkEvent.sequence,1);assert.equal(forkEvent.prevEventHash,null);assert.deepEqual(forkEvent.causalActionIds,[seed.data.current.frontier.eventId]);assert.equal(fork.expectedStreamFrontier,null);assert.notEqual(fork.stream.streamId,seed.data.stream.streamId);
  assert.deepEqual(JSON.parse(fork.descriptor.canonicalJson).forkAnchor,seed.data.current.frontier);
});

test('independent project identities do not merge byte-identical state and geometry',async()=>{
  const a=await initial(1,2),b=await initial(101,102);assert.equal(a.data.current.stateHash,b.data.current.stateHash);assert.notEqual(a.data.current.id,b.data.current.id);assert.notEqual(a.data.action.id,b.data.action.id);
  const roots=[a,b].map(seed=>seed.data.blobs.find(row=>row.kind==='capture-payload'));assert.equal(roots[0].assetId,roots[1].assetId);assert.notEqual(roots[0].id,roots[1].id);
});

test('closed schemas, false refs, foreign projects and unreferenced changes fail before storage',async()=>{
  const seed=await initial();
  for(const mutate of [input=>{input.extra=true;},input=>{input.changedRecords[0].extra=true;},input=>{input.changedRecords[0].version=2;},input=>{input.action.actionType='task.published';},input=>{input.action.changes[0].afterRef.sha256='0'.repeat(64);},input=>{input.action.changes[0].afterRef.projectId=uuid(999);},input=>{input.action.changes=[];},input=>{input.changedRecords[0].text='x'.repeat(4001);},input=>{input.expected.storageRevision=Number.MAX_SAFE_INTEGER;},input=>{input.action.recordedAt='2026-02-30T00:00:00Z';}]){
    const input=await edited(seed);mutate(input);await assert.rejects(prepareCaptureCommit(input));
  }
  const detached=await prepareCapturePayload({projectId:seed.data.projectId,bytes:'{}',mediaType:'application/json'}),input=await edited(seed);input.blobs=[detached];await assert.rejects(prepareCaptureCommit(input),/unreferenced changed payload/);
  const duplicate=await edited(seed);duplicate.action.changes.push(structuredClone(duplicate.action.changes[0]));await assert.rejects(prepareCaptureCommit(duplicate),/duplicate changed entity/);
  for(const actionType of ['undo.outcome','redo.outcome']){const empty=await edited(seed);empty.action.actionType=actionType;empty.action.changes=[];empty.changedRecords=[];await assert.rejects(prepareCaptureCommit(empty),/requires explicit changed finding evidence/);}
  const badParent={...seed.data.current.frontier,afterStateHash:'0'.repeat(64)};await assert.rejects(createCaptureWriter({projectId:seed.data.projectId,workspaceId:seed.data.workspaceId,parent:badParent,startRevisionId:seed.data.current.revisionId,startStateJson:state,createdAt:at}),/parent state mismatch/);
});

test('opaque JSON validates encoding and finite data while preserving fractional legacy numbers',async()=>{
  assert.equal(await sha256CaptureBytes('1.125'),createHash('sha256').update('1.125').digest('hex'));
  await assert.rejects(prepareCapturePayload({projectId:uuid(1),bytes:'{"x":1e999}',mediaType:'application/json'}),/nonfinite/);
  await assert.rejects(prepareCapturePayload({projectId:uuid(1),bytes:new Uint8Array([0xff]),mediaType:'application/json'}),/UTF-8/);
  await assert.rejects(prepareCapturePayload({projectId:uuid(1),bytes:'{broken',mediaType:'application/json'}),/invalid JSON/);
});

test('finding creation has no prior version while replacement and restoration retain one',async()=>{
  const seed=await initial(),firstInput=await edited(seed),first=preparedCaptureData(await prepareCaptureCommit(firstInput));
  assert.equal(JSON.parse(first.changedRecords[0].canonicalJson).previousVersionId,null);
  const next={...await edited(seed,{number:70}),expected:expected(first.current)};
  const previous=firstInput.changedRecords[0],record={...next.changedRecords[0],findingId:previous.findingId,previousVersionId:previous.id};
  const prior={kind:'finding-version',id:previous.id,projectId:seed.data.projectId,sha256:await hashCaptureRecord(previous)};
  next.changedRecords=[record];next.action.changes=[{entityKind:'finding',entityId:record.findingId,operation:'create',beforeRef:prior,afterRef:{kind:'finding-version',id:record.id,projectId:seed.data.projectId,sha256:await hashCaptureRecord(record)}}];
  await assert.rejects(prepareCaptureCommit(next),/create requires no prior/);
  next.action.actionType='finding.edited';next.action.changes[0].operation='replace';
  assert.equal(JSON.parse(preparedCaptureData(await prepareCaptureCommit(next)).changedRecords[0].canonicalJson).previousVersionId,previous.id);
  next.action.actionType='undo.outcome';next.action.changes[0].operation='restore';
  assert.equal(JSON.parse(preparedCaptureData(await prepareCaptureCommit(next)).changedRecords[0].canonicalJson).deleted,false);
  next.action.changes[0].beforeRef=null;
  await assert.rejects(prepareCaptureCommit(next),/create requires no prior/);
});

test('application baseline retains original IDs/types and complete known input assets without invented actions',async()=>{
  const seed=await applicationInitial(),record=JSON.parse(seed.data.action.canonicalJson);
  assert.deepEqual(record.changes,[]);assert.equal(record.actionType,'capture.started');assert.equal(seed.data.current.application.sourceWorkspaceId,'project:existing-workspace-key');
  assert.equal(seed.data.current.application.findingVersions[0].sourceFindingId,'legacy-finding-a');
  const finding=JSON.parse(seed.data.changedRecords.find(row=>row.kind==='finding-version').canonicalJson);assert.equal(finding.originalType,'source_footnote');assert.equal(finding.category,'unclassified');
  for(const asset of [seed.source,seed.render,seed.notation])assert(seed.data.blobs.some(row=>row.assetId===asset.assetId&&row.kind==='capture-payload'));
  for(const mutate of [value=>{value.previousVersionId=uuid(999);},value=>{value.deleted=true;}]){
    const bad={...seed.input,changedRecords:structuredClone(seed.input.changedRecords)};mutate(bad.changedRecords[1]);await assert.rejects(prepareCaptureCommit(bad),/baseline findings cannot invent/);
  }
  await assert.rejects(prepareCaptureCommit({...seed.input,application:null}),/application must be a plain object/);
});

test('judgments bind exact finding version, reviewed tuple, explicit unknown actor and current revision lineage',async()=>{
  const seed=await applicationInitial(),input=await judgmentInput(seed),data=preparedCaptureData(await prepareCaptureCommit(input));
  const judgment=JSON.parse(data.changedRecords.find(row=>row.kind==='judgment').canonicalJson);assert.equal(judgment.findingVersionId,seed.finding.id);assert.equal(judgment.actorId,null);assert.deepEqual(judgment.reviewed,input.changedRecords[1].reviewed);
  assert(data.requiredRefs.some(ref=>ref.kind==='revision'&&ref.reviewed?.revisionId===seed.revision.id));assert(data.requiredRefs.some(ref=>ref.kind==='finding-version'&&ref.deleted===false));
  for(const mutate of [x=>{x.changedRecords[1].scope.findingVersionIds=[uuid(999)];},x=>{x.changedRecords[1].actorId=uuid(900);},x=>{x.changedRecords[1].extra=true;},x=>{x.changedRecords[0].parentIds=[uuid(998)];},x=>{x.application.findingVersions[0].extra=true;},x=>{x.application.judgmentHeads[0].sourceFindingId='another-source';},x=>{x.application.findingVersions[0].deleted=true;}]){const bad=await judgmentInput(seed);mutate(bad);await assert.rejects(prepareCaptureCommit(bad));}
});

test('judgment reversal and retraction labels require exact predecessor evidence',async()=>{
  const seed=await applicationInitial();
  async function labeled(actionType,decision,predecessors){const input=await judgmentInput(seed),record=input.changedRecords[1];input.action.actionType=actionType;record.decision=decision;record.supersedesJudgmentIds=predecessors;input.action.changes[1].afterRef=await typed(record);input.application.judgmentHeads[0].judgmentRef=await typed(record);return input;}
  await assert.rejects(prepareCaptureCommit(await labeled('judgment.reversed','rejected',[])),/reversal requires an explicit predecessor/);
  await assert.rejects(prepareCaptureCommit(await labeled('judgment.retracted','retracted',[])),/retraction requires explicit predecessors/);
  for(const actionType of ['judgment.changed','judgment.reversed'])await assert.rejects(prepareCaptureCommit(await labeled(actionType,'retracted',[uuid(450)])),/explicit retraction action/);
  await assert.rejects(prepareCaptureCommit(await labeled('judgment.retracted','rejected',[uuid(450)])),/explicit retraction action/);
  for(const [actionType,decision]of [['judgment.reversed','rejected'],['judgment.retracted','retracted']]){
    const data=preparedCaptureData(await prepareCaptureCommit(await labeled(actionType,decision,[uuid(450)])));
    assert(data.requiredRefs.some(ref=>ref.kind==='judgment'&&ref.id.endsWith(uuid(450))&&ref.findingVersionId===seed.finding.id));
  }
});

test('observed bookkeeping separates latest state and revision from semantic ancestry',async()=>{
  const seed=await applicationInitial(),old=seed.data.current,revisionRecord={...seed.revision,id:uuid(600),parentIds:[old.revisionId],createdByActionId:null,reason:'review_only',observedFrontier:old.frontier},application={...old.application,revisionRef:await typed(revisionRecord)};
  const options={writer:seed.writer,current:old,stateJson:'{"preferences":{"zoom":125}}',revisionId:revisionRecord.id,revisionRecord,application,observationId:uuid(601)},observed=preparedCaptureData(await prepareCaptureObservation(options));
  assert.deepEqual(observed.current.frontier,old.frontier);assert.equal(observed.current.storageRevision,old.storageRevision+1);assert.equal(observed.current.revisionId,revisionRecord.id);assert.equal(observed.action,null);assert.equal(observed.outbox,null);assert.equal(observed.stream,null);assert.notEqual(observed.current.stateHash,old.frontier.afterStateHash);
  const writer=await createCaptureWriter({projectId:old.projectId,workspaceId:old.workspaceId,parent:old.frontier,startRevisionId:observed.current.revisionId,startStateJson:observed.current.stateJson,createdAt:at,observedParent:{storageRevision:observed.current.storageRevision,revisionId:observed.current.revisionId,stateHash:observed.current.stateHash,observationRef:observed.current.observationRef}});
  const input=await edited(seed,{writer,number:650});input.expected=expected(observed.current);const next=preparedCaptureData(await prepareCaptureCommit(input)),action=JSON.parse(next.action.canonicalJson);assert.equal(action.beforeStateHash,observed.current.stateHash);assert.deepEqual(action.causalActionIds,[old.frontier.eventId]);assert.equal(action.sequence,1);assert.deepEqual(action.beforeObservationRef,observed.current.observationRef);
  const timestampOnly=preparedCaptureData(await prepareCaptureObservation({...options,current:observed.current,revisionRecord:null,stateJson:'{"preferences":{"zoom":125},"updatedAt":"new"}',observationId:uuid(602)}));assert.equal(timestampOnly.changedRecords.length,0);assert.deepEqual(timestampOnly.current.frontier,old.frontier);assert.deepEqual(JSON.parse(timestampOnly.observation.canonicalJson).previousObservationRef,observed.current.observationRef);
  const noObservation={...input,expected:{...input.expected}};delete noObservation.expected.observationRef;await assert.rejects(prepareCaptureCommit(noObservation),/without observation/);
  await assert.rejects(prepareCaptureObservation({...options,application:{...application,findingVersions:[]}}),/cannot replace semantic/);
  await assert.rejects(prepareCaptureObservation({...options,revisionRecord:{...revisionRecord,createdByActionId:uuid(999)}}),/exact semantic frontier/);
});

test('dedicated baseline plans bound batches without relaxing ordinary change limits',async()=>{
  const seed=await applicationInitial(),input={...seed.input,changedRecords:[seed.revision],application:{...seed.input.application,findingVersions:[]}};
  for(let n=0;n<2000;n++){const finding={...seed.finding,id:uuid(10000+n),findingId:uuid(20000+n),sourceFindingId:'baseline-'+n};input.changedRecords.push(finding);input.application.findingVersions.push({sourceFindingId:finding.sourceFindingId,findingId:finding.findingId,versionRef:await typed(finding),deleted:false});}
  await assert.rejects(prepareCaptureCommit(input),/changed-record count/);
  const token=await prepareCaptureBaseline(input),data=preparedCaptureData(token),plan=readCaptureBaselinePlan(token);
  assert.equal(data.changedRecords.length,2001);assert.equal(data.current.application.findingVersions.length,2000);assert(plan.batchCount>1);assert(data.baselineStage.batches.every(batch=>batch.entries.length<=32));assert.equal(JSON.parse(data.action.canonicalJson).changes.length,0);assert(data.outbox.baselineClosure);assert(data.accounting.outboxBytes<PROPOSED_CAPTURE_LIMITS.outboxBytes);assert.equal(data.outbox.changedRefs.length,2);assert.equal(data.outbox.blobRefs.length,0);assert.equal(data.outbox.reservation.publicationBytes,data.baselineStage.publicationBytes);
  assert.deepEqual(readCaptureBaselinePlan(token),plan);assert.throws(()=>readCaptureBaselinePlan(seed.token),/not a dedicated baseline/);
});

test('effective baseline decisions bind current finding versions without inventing judgments',async()=>{
  const seed=await applicationInitial(),binding={reportedFindingId:'reported-a',sourceFindingId:seed.finding.sourceFindingId,findingVersionId:seed.finding.id,sourceAssetIds:seed.revision.sourceAssetIds,notationAssetId:seed.revision.notationAssetId,renderAssetIds:seed.revision.renderAssetIds,decisionHash:'a'.repeat(64)},input={...seed.input,application:{...seed.input.application,effectiveDecisionBindings:[binding]}};
  const data=preparedCaptureData(await prepareCaptureCommit(input));assert.equal(data.changedRecords.filter(row=>row.kind==='judgment').length,0);assert.equal(data.current.application.effectiveDecisionBindings.length,1);assert(data.requiredRefs.some(ref=>ref.kind==='revision'&&ref.reviewed?.revisionId===seed.revision.id));
  for(const mutate of [entry=>{entry.findingVersionId=uuid(999);},entry=>{entry.sourceFindingId='wrong-source';},entry=>{entry.decisionHash='untrusted';},entry=>{entry.extra=true;}]){const bad={...input,application:structuredClone(input.application)};mutate(bad.application.effectiveDecisionBindings[0]);await assert.rejects(prepareCaptureCommit(bad));}
  const duplicate={...input,application:{...input.application,effectiveDecisionBindings:[binding,binding]}};await assert.rejects(prepareCaptureCommit(duplicate),/duplicate effective reported finding/);
});

test('durable baseline control reconstructs exact original IDs and refuses altered owned bytes',async()=>{
  const seed=await applicationInitial(),token=await prepareCaptureBaseline(seed.input),data=preparedCaptureData(token),restart=await prepareCaptureBaselineRestartData(token),entries=data.baselineStage.batches.flatMap(batch=>batch.entries);
  assert(restart.artifact.bytes<=CAPTURE_RESTART_LIMITS.controlBytes);assert.equal(await restart.artifact.body.text(),restart.canonicalJson);assert.equal(restart.control.baselineId,seed.input.action.id);
  const restored=preparedCaptureData(await restoreCaptureBaselinePreparation(restart.canonicalJson,entries));
  for(const field of ['current','action','descriptor','stream','outbox','accounting'])assert.deepEqual(restored[field],data[field]);assert.deepEqual(readCaptureBaselinePlan(await restoreCaptureBaselinePreparation(restart.canonicalJson,entries)),readCaptureBaselinePlan(token));
  assert.deepEqual(restored.changedRecords,data.changedRecords);assert.equal(restored.blobs.length,data.blobs.length);for(let index=0;index<data.blobs.length;index++){assert.equal(restored.blobs[index].id,data.blobs[index].id);assert.deepEqual(new Uint8Array(await restored.blobs[index].body.arrayBuffer()),new Uint8Array(await data.blobs[index].body.arrayBuffer()));}
  await assert.rejects(restoreCaptureBaselinePreparation(restart.canonicalJson,entries.slice(1)),/bounded row closure/);
  const altered=entries.map(([store,row])=>[store,{...row}]),segment=altered.find(([,row])=>row.kind==='capture-segment');segment[1].body=new Blob([new Uint8Array(segment[1].bytes)],{type:segment[1].body.type});await assert.rejects(restoreCaptureBaselinePreparation(restart.canonicalJson,altered),/actual segment hash/);
  const badControl=JSON.parse(restart.canonicalJson);badControl.writer.branchId=uuid(991);await assert.rejects(restoreCaptureBaselinePreparation(canonicalCaptureJson(badControl),entries),/original descriptor/);
  badControl.writer.branchId=restart.control.writer.branchId;badControl.publication.intentId=uuid(992);await assert.rejects(restoreCaptureBaselinePreparation(canonicalCaptureJson(badControl),entries),/plan hash differs/);
  badControl.publication.intentId=restart.control.publication.intentId;badControl.publication.reservationId=uuid(993);await assert.rejects(restoreCaptureBaselinePreparation(canonicalCaptureJson(badControl),entries),/exact outbox hash differs/);
});

test('independent evidence validation rejects malformed enums, actors, lineage fields and action operations',async()=>{
  const seed=await applicationInitial(),judged=preparedCaptureData(await prepareCaptureCommit(await judgmentInput(seed))),records=[JSON.parse(seed.data.descriptor.canonicalJson),JSON.parse(seed.data.action.canonicalJson),...seed.data.changedRecords.map(row=>JSON.parse(row.canonicalJson)),JSON.parse(judged.action.canonicalJson),...judged.changedRecords.map(row=>JSON.parse(row.canonicalJson))];
  for(const record of records)assert.equal(validateCaptureEvidenceRecord(record),record);
  const finding=structuredClone(records.find(record=>record.kind==='finding-version'));finding.category='invented_category';assert.throws(()=>validateCaptureEvidenceRecord(finding),/category/);
  const judgment=structuredClone(records.find(record=>record.kind==='judgment'));judgment.actorId=uuid(999);assert.throws(()=>validateCaptureEvidenceRecord(judgment),/identity remains unknown/);judgment.actorId=null;judgment.decision='machine_approved';assert.throws(()=>validateCaptureEvidenceRecord(judgment),/decision/);
  const revision=structuredClone(seed.revision);revision.reason='unknown_revision';assert.throws(()=>validateCaptureEvidenceRecord(revision),/reason/);revision.reason='review_only';revision.parentIds=[uuid(990)];assert.throws(()=>validateCaptureEvidenceRecord(revision),/needs its action/);
  const action=structuredClone(JSON.parse(judged.action.canonicalJson));action.actionType='undeclared.action';assert.throws(()=>validateCaptureEvidenceRecord(action),/policy\/type/);action.actionType='judgment.changed';action.changes[1].operation='replace';assert.throws(()=>validateCaptureEvidenceRecord(action),/append-only/);
  const branch=structuredClone(JSON.parse(seed.data.descriptor.canonicalJson));branch.rootCaptureStateHash=null;assert.throws(()=>validateCaptureEvidenceRecord(branch),/root capture hash/);
});

test('representative serialized-size observations include descriptor, segment and manifest',async()=>{
  const seed=await initial(),geometry='[{"x":0.125,"y":0.3333333333333333}]\n',payload=await prepareCapturePayload({projectId:seed.data.projectId,bytes:geometry,mediaType:'application/json'}),next=preparedCaptureData(await prepareCaptureCommit(await edited(seed,{payload})));
  assert.equal(next.accounting.actionBytes,new TextEncoder().encode(next.action.canonicalJson).length);assert(next.accounting.descriptorBytes>0);assert(next.accounting.manifestBytes>0);assert(next.accounting.reservationBytes>=next.accounting.currentBytes+next.accounting.actionBytes+next.accounting.changedRecordBytes+next.accounting.descriptorBytes+next.accounting.blobBytes);
  console.log('CAPTURE_SIZE_OBSERVATIONS '+JSON.stringify({status:'SERIALIZED_BYTES_NOT_NATIVE_PERFORMANCE',root:seed.data.accounting,changedFindingWithGeometry:next.accounting,geometryBytes:new TextEncoder().encode(geometry).length}));
});
