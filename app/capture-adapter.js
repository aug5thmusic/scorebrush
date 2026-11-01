// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Inactive semantic boundary adapter. No opener, listeners, timers or app hooks.
import {identify,blobHash,newReview,validateReview,isComment,roles,STATES,FINDING_TYPES} from './model.js';
import {canonical,exactReview} from './completion-model.js';
import {candidateIdentity,currentAssociation} from './comparison-model.js';
import {validateWorkspaceIdentity} from './project-identity.js';
import {createCaptureWriter,readCaptureWriter,prepareCaptureCommit,prepareCaptureObservation,prepareCaptureBaseline,readCaptureBaselinePlan,prepareCapturePayload,hashCaptureRecord,PROPOSED_CAPTURE_LIMITS} from './capture-format.js';
import {readCaptureCurrent,commitCapture,stageCaptureBaseline,persistCaptureBaselinePreparation} from './capture-store.js';

const sessions=new WeakMap(),transitions=new WeakMap(),encoder=new TextEncoder();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const boundaries=new Set(['capture-start','finalized','edit','delete','undo','redo','judgment','inputs','save','view','preferences']);
const equal=(a,b)=>canonical(a)===canonical(b),copy=value=>structuredClone(value);
function fail(message,code='CAPTURE_TRANSITION'){const error=new Error('Capture adapter: '+message);error.code=code;throw error;}
function check(value,message,code){if(!value)fail(message,code);}
function keys(value,names,label){check(value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join('|')===[...names].sort().join('|'),label+' fields');}
function ownedJson(value){
  let count=0;const path=new Set();
  function visit(item,depth){check(++count<=1000000&&depth<=64,'state complexity bound');
    if(item===null||typeof item==='boolean'||typeof item==='string')return;
    if(typeof item==='number'){check(Number.isFinite(item)&&!Object.is(item,-0),'unsupported state number');return;}
    check(item&&typeof item==='object'&&!path.has(item),'unsupported or cyclic state');path.add(item);
    check(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype,'state must be plain JSON');
    check(Object.getOwnPropertySymbols(item).length===0,'symbol state fields');
    const names=Object.getOwnPropertyNames(item).filter(name=>!(Array.isArray(item)&&name==='length'));
    check(!Array.isArray(item)||names.length===item.length,'sparse or extended state array');
    for(const name of names){const d=Object.getOwnPropertyDescriptor(item,name);check(d.enumerable&&'value'in d,'state accessor');visit(d.value,depth+1);}
    path.delete(item);
  }
  visit(value,0);const json=JSON.stringify(value);check(encoder.encode(json).length<=PROPOSED_CAPTURE_LIMITS.stateBytes,'state byte bound');return JSON.parse(json);
}
function sceneState(scene){return {schema:'scorebrush-capture-scene',version:1,projectId:scene.projectId,workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned};}
function inputTuple(scene){return {sourceAssetIds:['sha256:'+scene.review.files.source.sha256],notationAssetId:'sha256:'+scene.review.files.ly.sha256,renderAssetIds:['sha256:'+scene.review.files.rendered.sha256]};}
function without(value,names){const result=copy(value);for(const name of names)delete result[name];return result;}
function reviewContext(review){return without(review,['findings','nextNumber','preferences','updatedAt']);}
function reviewMeaning(review){return without(review,['preferences','updatedAt']);}
function roundContext(round){if(!round)return null;return {...round,reported:round.reported.map(f=>without(f,['state','explanation','decision','associationId']))};}
function decisionMeaning(finding){return {state:finding.state,explanation:finding.explanation??null,associationId:finding.associationId,decision:finding.decision?without(finding.decision,['at']):null};}
function roundMeaning(round){return round?{...round,reported:round.reported.map(f=>({...f,...(f.decision?{decision:without(f.decision,['at'])}:{})}))}:null;}
async function needsJudgment(old,next,after,application){
  if(!equal(decisionMeaning(old),decisionMeaning(next)))return true;
  if(!next.decision||equal(old.decision,next.decision))return false;
  const target=currentAssociation(after.returned,next.id,after.review);
  const version=application?.findingVersions.find(item=>item.sourceFindingId===target?.id&&!item.deleted);
  // A timestamp resave is meaningful only when the effective target has changed
  // since its last captured judgment (for example, a finding was edited).
  if(!version)return false;
  const tuple=inputTuple(after),decisionHash=await hashCaptureRecord(decisionMeaning(next));
  return !application.effectiveDecisionBindings.some(binding=>binding.reportedFindingId===next.id&&binding.sourceFindingId===target.id&&binding.findingVersionId===version.versionRef.id&&binding.decisionHash===decisionHash&&equal({sourceAssetIds:binding.sourceAssetIds,notationAssetId:binding.notationAssetId,renderAssetIds:binding.renderAssetIds},tuple));
}
async function effectiveBinding(report,scene,application){
  if(!report.decision)return null;const target=currentAssociation(scene.returned,report.id,scene.review),version=application.findingVersions.find(item=>item.sourceFindingId===target?.id&&!item.deleted);
  if(!version)return null;
  return {reportedFindingId:report.id,sourceFindingId:target.id,findingVersionId:version.versionRef.id,...inputTuple(scene),decisionHash:await hashCaptureRecord(decisionMeaning(report))};
}
// Two input bundles (six roles) maximum. Only branded, plain immutable Blobs can
// reuse an entry; a File/directory snapshot is always read afresh. Entries own
// their bytes and their pending hash promise, including during failed retries.
async function verifiedInput(cache,file){
  const reusable=Object.getPrototypeOf(file.blob)===Blob.prototype;
  let entry=reusable?cache.entries.find(item=>item.original===file.blob||item.owned===file.blob):null;
  if(!entry){
    entry={original:reusable?file.blob:null,owned:null,promise:null};
    entry.promise=(async()=>{
      const owned=reusable?new Blob([file.blob],{type:file.blob.type}):new Blob([await Blob.prototype.arrayBuffer.call(file.blob)],{type:file.blob.type});
      entry.owned=owned;await blobHash(owned);return owned;
    })();
    cache.entries.push(entry);if(cache.entries.length>6)cache.entries.shift();
    entry.promise.catch(()=>{const i=cache.entries.indexOf(entry);if(i>=0)cache.entries.splice(i,1);});
  }
  return {name:file.name,blob:await entry.promise};
}
function validateRound(round,review){
  if(round===null)return;
  check(round.schema==='score-desk-returned-workspace'&&round.version===1&&typeof round.id==='string'&&round.id.length<=200,'unsupported returned workspace');
  check(Array.isArray(round.reported)&&round.reported.length<=2000&&new Set(round.reported.map(f=>f.id)).size===round.reported.length,'returned finding list');
  const candidate=candidateIdentity(review);
  check(round.contentSnapshotId===candidate.snapshotId&&round.codeSha256===candidate.codeSha256&&round.renderSha256===candidate.renderSha256,'returned input tuple mismatch');
  for(const f of round.reported){check(typeof f.id==='string'&&/^[\w-]{1,80}$/.test(f.id),'returned finding ID');
    check(Number.isSafeInteger(f.number)&&f.number>=1&&f.number<=99999&&typeof f.comment==='string'&&f.comment.length<=4000&&STATES.includes(f.state),'returned finding metadata');
    check(!Object.hasOwn(f,'type')||FINDING_TYPES.includes(f.type),'returned finding type');
    check(typeof f.explanation==='string'&&f.explanation.length<=4000,'returned explanation');
    check(f.associationId===null||typeof f.associationId==='string'&&/^[\w-]{1,80}$/.test(f.associationId),'returned association ID');
    if(f.decision!=null){keys(f.decision,['state','explanation','reviewed',...(Object.hasOwn(f.decision,'at')?['at']:[])],'human decision');
      check(['resolved','open','needs_source_clarification'].includes(f.decision.state)&&f.state===f.decision.state,'decision state');
      check(typeof f.decision.explanation==='string'&&f.decision.explanation.length<=4000,'decision explanation');
      if(Object.hasOwn(f.decision,'at'))check(typeof f.decision.at==='string'&&f.decision.at.length<=40&&Number.isFinite(Date.parse(f.decision.at)),'decision time');
      check(equal(f.decision.reviewed,candidate),'decision reviewed candidate differs');
    }
  }
}
// Copy all caller-owned metadata synchronously before hashing any file.
async function validateScene(raw,cache,projectId){
  keys(raw,['projectId','workspaceId','revisionId','review','files','returned'],'scene');
  const scene=ownedJson({projectId:raw.projectId,workspaceId:raw.workspaceId,revisionId:raw.revisionId,review:raw.review,returned:raw.returned});
  check(UUID.test(scene.projectId)&&UUID.test(scene.revisionId),'project/revision UUID');
  check(scene.projectId===projectId,'foreign project');
  keys(raw.files,roles,'files');const inputFiles={};
  for(const role of roles){const file=raw.files[role];keys(file,['name','blob'],'file');check(typeof file.name==='string'&&file.name.length>0&&file.name.length<=1000&&file.blob instanceof Blob&&file.blob.size<=PROPOSED_CAPTURE_LIMITS.payloadBytes,'file name/Blob or proposed payload bound');inputFiles[role]={name:file.name,blob:file.blob};}
  const files={};for(const role of roles)files[role]=await verifiedInput(cache,inputFiles[role]);
  const {identity,snapshotId}=await identify(files);
  check(equal(identity,scene.review.files),'actual file names, sizes or hashes differ');
  check(Array.isArray(scene.review.pages)&&scene.review.pages.length>0&&scene.review.pages.length<=10000,'page count');
  for(const page of scene.review.pages)check(page&&Array.isArray(page.view)&&page.view.length===4&&page.view.every(Number.isFinite)&&page.view[0]<page.view[2]&&page.view[1]<page.view[3],'page bounds');
  exactReview(validateReview(scene.review,newReview(identity,snapshotId,scene.review.pages)),scene.review);
  validateWorkspaceIdentity({id:scene.workspaceId,projectId:scene.projectId},snapshotId);
  validateRound(scene.returned,scene.review);
  if(scene.returned)check(scene.workspaceId===scene.returned.id,'returned workspace binding differs');
  return {...scene,files};
}
// Explicit full recovery validation uses actual independently read role bytes.
// It neither creates a session nor opens or writes a database.
export async function validateCaptureRecoveredScene(scene,application){
  const validated=await validateScene(scene,{entries:[]},scene.projectId);
  if(application)for(const binding of application.effectiveDecisionBindings??[]){const report=validated.returned?.reported.find(item=>item.id===binding.reportedFindingId);check(report&&equal(await effectiveBinding(report,validated,application),binding),'recovered effective decision binding differs');}
  return sceneState(validated);
}
function sessionData(token){const data=sessions.get(token);check(data,'unknown session');return data;}
function stateResult(data){return {current:copy(data.current),scene:copy(data.current?JSON.parse(data.current.stateJson):sceneState(data.observed)),application:copy(data.current?.application??null)};}
export function readCaptureAdapterState(session){
  const result=stateResult(sessionData(session));delete result.scene.schema;delete result.scene.version;return result;
}
export function readCaptureAdapterInputs(session){
  const data=sessionData(session);check(data.observed.files,'current inputs need explicit verified reopening');
  return Object.fromEntries(roles.map(role=>[role,{name:data.observed.files[role].name,blob:data.observed.files[role].blob}]));
}
export async function createCaptureAdapterSession(options){
  keys(options,['db','projectId','captureWorkspaceId','scene','createdAt'],'session');
  const {db,projectId,captureWorkspaceId,createdAt}=options;
  const inputCache={entries:[]};const scene=await validateScene(options.scene,inputCache,projectId);check(projectId===scene.projectId&&UUID.test(captureWorkspaceId),'session project/workspace');
  const current=await readCaptureCurrent(db,projectId,captureWorkspaceId);
  if(current){check(current.application&&Array.isArray(current.application.effectiveDecisionBindings),'core state needs supported effective-decision binding conversion');check(equal(JSON.parse(current.stateJson),sceneState(scene)),'resume scene differs from durable state','CAPTURE_STALE');check(current.application.sourceWorkspaceId===scene.workspaceId,'resume workspace binding differs');}
  const observedParent=current?.observationRef?{storageRevision:current.storageRevision,revisionId:current.revisionId,stateHash:current.stateHash,observationRef:current.observationRef}:null;
  const writer=await createCaptureWriter({projectId,workspaceId:captureWorkspaceId,parent:current?.frontier??null,startRevisionId:scene.revisionId,startStateJson:current?.stateJson??JSON.stringify(sceneState(scene)),createdAt,...(observedParent?{observedParent}:{})});
  const token=Object.freeze({});sessions.set(token,{db,projectId,captureWorkspaceId,writer,current:current??null,observed:scene,inputCache,generation:0,committing:false,destinationId:crypto.randomUUID()});return token;
}
export async function prepareCaptureTransition(session,options){
  const data=sessionData(session);keys(options,['before','after','boundary','recordedAt'],'transition');const {boundary,recordedAt}=options;check(boundaries.has(boundary),'unsupported boundary');
  const generation=data.generation,current=copy(data.current),observed=sceneState(data.observed);
  const beforePromise=validateScene(options.before,data.inputCache,data.projectId),afterPromise=validateScene(options.after,data.inputCache,data.projectId);
  const [before,after]=await Promise.all([beforePromise,afterPromise]);
  check(generation===data.generation&&equal(sceneState(before),observed),'before state/version is stale','CAPTURE_STALE');
  check(before.projectId===data.projectId&&after.projectId===data.projectId,'foreign project');
  const baseline=boundary==='capture-start';
  if(baseline)check(!current&&equal(sceneState(before),sceneState(after)),'capture-start must preserve an absent exact baseline');
  else check(current,'explicit capture-start is required before semantic boundaries');
  const inputsChanged=!equal(inputTuple(before),inputTuple(after));
  if(boundary!=='inputs')check(!inputsChanged&&before.workspaceId===after.workspaceId,'changed inputs/workspace require inputs boundary');
  const priorFindings=new Map(before.review.findings.map(f=>[f.id,f])),nextFindings=new Map(after.review.findings.map(f=>[f.id,f]));
  const changedIds=[...new Set([...priorFindings.keys(),...nextFindings.keys()])].filter(id=>!equal(priorFindings.get(id)??null,nextFindings.get(id)??null));
  const judgmentChanged=[];
  if(boundary==='judgment'&&before.returned&&after.returned&&equal(roundContext(before.returned),roundContext(after.returned)))for(let i=0;i<after.returned.reported.length;i++)judgmentChanged[i]=await needsJudgment(before.returned.reported[i],after.returned.reported[i],after,current?.application);
  const targetJudgmentChanged=judgmentChanged.some(Boolean);
  const noSemanticChange=equal(reviewMeaning(before.review),reviewMeaning(after.review))&&equal(roundMeaning(before.returned),roundMeaning(after.returned))&&before.workspaceId===after.workspaceId&&!targetJudgmentChanged;
  if(!baseline&&noSemanticChange){
    const token=Object.freeze({});
    if(equal(JSON.parse(current.stateJson),sceneState(after))){transitions.set(token,{session,generation,after,noop:true,accepted:false});return token;}
    const application=copy(current.application),revisionRecord=after.revisionId===current.revisionId?null:{schema:'scorebrush-research-record',version:1,kind:'revision',id:after.revisionId,projectId:data.projectId,parentIds:[current.revisionId],branchId:current.frontier.branchId,workspaceId:data.captureWorkspaceId,...inputTuple(after),dependencySetId:null,createdByActionId:null,reason:'review_only',observedFrontier:current.frontier};
    if(revisionRecord)application.revisionRef={kind:'revision',id:revisionRecord.id,projectId:data.projectId,sha256:await hashCaptureRecord(revisionRecord)};
    const prepared=await prepareCaptureObservation({writer:data.writer,current,stateJson:JSON.stringify(sceneState(after)),revisionId:after.revisionId,revisionRecord,application,observationId:crypto.randomUUID()});
    check(generation===data.generation,'session changed during observation preparation','CAPTURE_STALE');
    transitions.set(token,{session,generation,after,prepared,noop:false,baseline:false,accepted:false});return token;
  }
  check(!['save','view','preferences'].includes(boundary),'unfinalized semantic change at nonsemantic boundary');
  if(!baseline&&boundary!=='inputs')check(equal(reviewContext(before.review),reviewContext(after.review)),'unsupported review metadata change');
  if(!baseline&&boundary!=='inputs')check(equal(roundContext(before.returned),roundContext(after.returned)),'unsupported returned context change');
  if(!baseline&&boundary!=='judgment'&&boundary!=='inputs'&&before.returned){
    check(before.returned.reported.every((f,i)=>equal(without(decisionMeaning(f),['associationId']),without(decisionMeaning(after.returned.reported[i]),['associationId']))),'human decisions require judgment boundary');
  }
  if(boundary==='inputs'){
    check(inputsChanged,'inputs boundary needs changed bytes');check(before.review.files.source.sha256===after.review.files.source.sha256,'source replacement is not yet supported');
    check(changedIds.length===0,'input load with annotation remapping needs a later reviewed boundary');
  }
  if(!baseline)check(after.revisionId!==current.revisionId,'semantic change requires its actual new logical revision');
  // A reopened writer has not yet authored a stream. Further observations may
  // advance its actual start state before that first semantic action. Prepare a
  // new unused fork anchored to that exact observed current; adopt it only with
  // a successful semantic transaction, never by rewriting an existing stream.
  let writerToken=data.writer;const priorWriter=readCaptureWriter(writerToken);
  if(current&&priorWriter.streamId!==current.frontier.streamId&&(!equal(priorWriter.parent,current.frontier)||priorWriter.startRevisionId!==current.revisionId||priorWriter.startStateHash!==current.stateHash||!equal(priorWriter.observedParent?.observationRef??null,current.observationRef??null)||(current.observationRef&&priorWriter.observedParent?.storageRevision!==current.storageRevision))){
    writerToken=await createCaptureWriter({projectId:data.projectId,workspaceId:data.captureWorkspaceId,parent:current.frontier,startRevisionId:current.revisionId,startStateJson:current.stateJson,createdAt:recordedAt,...(current.observationRef?{observedParent:{storageRevision:current.storageRevision,revisionId:current.revisionId,stateHash:current.stateHash,observationRef:current.observationRef}}:{})});
  }
  const actionId=crypto.randomUUID(),records=[],blobs=[],changes=[];
  const application=current?copy(current.application):{schema:'scorebrush-capture-application',version:1,sourceWorkspaceId:after.workspaceId,revisionRef:null,findingVersions:[],judgmentHeads:[],effectiveDecisionBindings:[]};
  application.sourceWorkspaceId=after.workspaceId;
  // Prior judgments remain immutable evidence, but a new input revision cannot
  // inherit an active human decision merely because bytes later recur.
  if(inputsChanged){application.judgmentHeads=[];application.effectiveDecisionBindings=[];}
  const ref=async record=>({kind:record.kind,id:record.id,projectId:data.projectId,sha256:await hashCaptureRecord(record)});
  const add=async(record,entityKind,entityId=record.id,operation='create',beforeRef=null)=>{records.push(record);const afterRef=await ref(record);if(!baseline)changes.push({entityKind,entityId,operation,beforeRef,afterRef});return afterRef;};
  // Content-addressed roots/segments are deduplicated by the existing core.
  if(baseline||inputsChanged)for(const role of roles)blobs.push(await prepareCapturePayload({projectId:data.projectId,bytes:after.files[role].blob,mediaType:role==='ly'?'text/plain':'application/octet-stream'}));
  const writer=readCaptureWriter(writerToken),tuple=inputTuple(after);
  let reason=baseline?'baseline':'review_only';
  if(inputsChanged){const code=before.review.files.ly.sha256!==after.review.files.ly.sha256,render=before.review.files.rendered.sha256!==after.review.files.rendered.sha256;reason=code&&render?'code_and_render':code?'code_only':'pdf_only';}
  const revision={schema:'scorebrush-research-record',version:1,kind:'revision',id:after.revisionId,projectId:data.projectId,parentIds:baseline?[]:[current.revisionId],branchId:writer.branchId,workspaceId:data.captureWorkspaceId,...tuple,dependencySetId:null,createdByActionId:baseline?null:actionId,reason};
  application.revisionRef=await add(revision,'revision');
  const findingIds=baseline?[...nextFindings.keys()]:changedIds;
  if(boundary==='judgment')check(changedIds.length===0,'judgment cannot silently change its target finding version');
  for(const sourceId of findingIds){
    const prior=application.findingVersions.find(item=>item.sourceFindingId===sourceId),finding=nextFindings.get(sourceId)??priorFindings.get(sourceId),deleted=!nextFindings.has(sourceId);
    check(baseline||!priorFindings.has(sourceId)||prior&&!prior.deleted,'prior finding version missing or stale','CAPTURE_STALE');
    check(!prior||prior.deleted===!priorFindings.has(sourceId),'prior finding tombstone differs','CAPTURE_STALE');
    const geometry=await prepareCapturePayload({projectId:data.projectId,bytes:JSON.stringify(without(finding,['comment'])),mediaType:'application/json'});blobs.push(geometry);
    const record={schema:'scorebrush-research-record',version:1,kind:'finding-version',id:crypto.randomUUID(),projectId:data.projectId,findingId:prior?.findingId??crypto.randomUUID(),previousVersionId:prior?.versionRef.id??null,revisionId:after.revisionId,createdByActionId:actionId,category:isComment(finding)?'comment':'unclassified',geometryAssetId:geometry.assetId,deleted,text:finding.comment,sourceFindingId:sourceId,originalType:Object.hasOwn(finding,'type')?finding.type:null};
    const operation=!prior?'create':deleted?'delete':prior.deleted?'restore':'replace';
    const versionRef=await add(record,'finding',record.findingId,operation,prior?.versionRef??null),entry={sourceFindingId:sourceId,findingId:record.findingId,versionRef,deleted};
    if(prior)application.findingVersions[application.findingVersions.indexOf(prior)]=entry;else application.findingVersions.push(entry);
    application.judgmentHeads=application.judgmentHeads.filter(head=>head.sourceFindingId!==sourceId);
    application.effectiveDecisionBindings=application.effectiveDecisionBindings.filter(binding=>binding.sourceFindingId!==sourceId);
  }
  if(baseline&&after.returned)for(const report of after.returned.reported){const binding=await effectiveBinding(report,after,application);if(binding)application.effectiveDecisionBindings.push(binding);}
  let actionType=baseline?'capture.started':boundary==='inputs'?'revision.loaded':boundary==='undo'?'undo.outcome':boundary==='redo'?'redo.outcome':null;
  if(boundary==='judgment'){
    check(before.returned&&after.returned,'human judgment requires an actual returned context');
    let reversed=false,retracted=false,count=0;
    for(let i=0;i<after.returned.reported.length;i++){
      const old=before.returned.reported[i],next=after.returned.reported[i];
      if(!judgmentChanged[i])continue;
      check(next.decision!=null,'explicit retraction is not yet represented by the application domain');
      check(Object.hasOwn(next.decision,'at')&&next.explanation===next.decision.explanation,'new human decision needs its actual timestamp and explanation');
      check(!equal(old.decision??null,next.decision)||old.associationId!==next.associationId,'state alone is not a human judgment');
      const target=currentAssociation(after.returned,next.id,after.review);check(target&&!isComment(Object.hasOwn(target,'type')?target:next),'judgment needs an exact non-comment association');
      const version=application.findingVersions.find(item=>item.sourceFindingId===target.id&&!item.deleted);check(version,'judgment finding version is absent');
      const decision={resolved:'accepted',open:'rejected',needs_source_clarification:'needs_clarification'}[next.decision.state];
      check(decision&& (decision==='accepted'||next.decision.explanation.trim().length>0),'decision needs its actual explanation');
      const heads=application.judgmentHeads.filter(head=>head.sourceFindingId===target.id&&head.findingVersionId===version.versionRef.id&&equal(without(head.reviewed,['revisionId']),tuple));
      check(heads.length<=1,'ambiguous reviewed target');const head=heads[0];
      // Reversal retains the durable exact target; equal bytes alone never mint a link.
      const reviewed=head?copy(head.reviewed):{revisionId:before.revisionId,...tuple};
      let reasonAssetId=null;if(next.decision.explanation!==''){const payload=await prepareCapturePayload({projectId:data.projectId,bytes:next.decision.explanation,mediaType:'text/plain'});blobs.push(payload);reasonAssetId=payload.assetId;}
      const record={schema:'scorebrush-research-record',version:1,kind:'judgment',id:crypto.randomUUID(),projectId:data.projectId,findingVersionId:version.versionRef.id,reviewed,scope:{kind:'findings',findingVersionIds:[version.versionRef.id],regionAssetIds:[],unresolvedFindingIds:[]},decision,reasonAssetId,actorId:null,actionId,supersedesJudgmentIds:head?[head.judgmentRef.id]:[]};
      const judgmentRef=await add(record,'judgment'),entry={sourceFindingId:target.id,findingVersionId:version.versionRef.id,reviewed,judgmentRef};
      if(head)application.judgmentHeads[application.judgmentHeads.indexOf(head)]=entry;else application.judgmentHeads.push(entry);
      application.effectiveDecisionBindings=application.effectiveDecisionBindings.filter(binding=>binding.reportedFindingId!==next.id);application.effectiveDecisionBindings.push(await effectiveBinding(next,after,application));
      reversed||=!!head&&old.decision?.state!==next.decision.state;retracted||=decision==='retracted';count++;
    }
    check(count>0,'no explicit human decision change');actionType=retracted?'judgment.retracted':reversed?'judgment.reversed':'judgment.changed';
  }
  if(!actionType){const ops=changes.filter(c=>c.entityKind==='finding').map(c=>c.operation);check(ops.length>0&&new Set(ops).size===1,'mixed/unsupported annotation boundary');actionType={create:'finding.finalized',replace:'finding.edited',delete:'finding.deleted'}[ops[0]];check(actionType,'restoration needs explicit undo/redo boundary');}
  const expected=current?{storageRevision:current.storageRevision,revisionId:current.revisionId,stateHash:current.stateHash,frontier:current.frontier,...(current.observationRef?{observationRef:current.observationRef}:{})}:null;
  const prepared=await (baseline?prepareCaptureBaseline:prepareCaptureCommit)({writer:writerToken,expected,revisionId:after.revisionId,stateJson:JSON.stringify(sceneState(after)),action:{id:actionId,actionType,recordedAt,changes},changedRecords:records,blobs,application,publication:{intentId:crypto.randomUUID(),reservationId:crypto.randomUUID(),destinationId:data.destinationId,expectedHead:null}});
  check(generation===data.generation,'session changed during preparation','CAPTURE_STALE');
  const token=Object.freeze({});transitions.set(token,{session,generation,after,prepared,writer:writerToken,noop:false,baseline,accepted:false});return token;
}
// Explicit inactive preparation boundary; no acceptance or session advancement.
export async function persistCaptureAdapterBaseline(session,token){
  const data=sessionData(session),transition=transitions.get(token);
  check(transition&&transition.session===session&&transition.baseline&&!transition.accepted,'expected unaccepted baseline transition');
  check(!data.committing&&transition.generation===data.generation,'stale or busy baseline preparation','CAPTURE_STALE');
  data.committing=true;
  try{const plan=readCaptureBaselinePlan(transition.prepared);const result=await persistCaptureBaselinePreparation(data.db,transition.prepared);return {...result,projectId:data.projectId??transition.after.projectId,baselineId:plan.id.split(':').at(-1),planHash:plan.planHash,batchCount:plan.batchCount};}
  finally{data.committing=false;}
}
export async function commitCaptureTransition(session,token){
  const data=sessionData(session),transition=transitions.get(token);check(transition&&transition.session===session,'unknown/foreign prepared transition');
  check(!data.committing,'another boundary is committing in this session','CAPTURE_BUSY');
  if(transition.noop){
    if(!transition.accepted){check(transition.generation===data.generation,'stale no-op boundary','CAPTURE_STALE');data.observed=transition.after;data.generation++;transition.accepted=true;}
    return {status:'noop',localOnly:true,publicationSucceeded:false,current:copy(data.current)};
  }
  if(!transition.accepted)check(transition.generation===data.generation,'prepared boundary is stale in this session','CAPTURE_STALE');
  let result;data.committing=true;
  try{
    if(transition.baseline){const plan=readCaptureBaselinePlan(transition.prepared);for(let index=0;index<plan.batchCount;index++)await stageCaptureBaseline(data.db,transition.prepared,index);}
    result=await commitCapture(data.db,transition.prepared);
  }finally{data.committing=false;}
  // An old retry may return the newer current. Never roll session state backwards.
  if(result.status==='committed'||result.status==='observed'){
    data.current=copy(result.current);data.observed=transition.after;if(transition.writer)data.writer=transition.writer;data.generation++;
  }else if(!data.current||result.current.storageRevision>data.current.storageRevision){
    data.current=copy(result.current);const durable=JSON.parse(result.current.stateJson);delete durable.schema;delete durable.version;
    data.observed={...durable,files:equal(sceneState(transition.after),JSON.parse(result.current.stateJson))?transition.after.files:null};data.generation++;
  }
  transition.accepted=true;return {...result,status:result.status==='committed'&&result.semanticAction===false?'observed':result.status,current:copy(result.current),localOnly:true};
}
