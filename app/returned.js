// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Returned-review metadata is separate from the content-hashed annotation model.
import {clone,identify,newReview,sha256,blobHash,STATES,FINDING_TYPES,findingType,findingTypeFields,isComment} from './model.js';
import {retained} from './handoff-store.js';
import {validateLocations} from './comparison-model.js';
import {makeRecovery,observationText,internalCommentText} from './export.js';
import {makeTask,finalizeTask,localTaskDelivery,taskFindings,contextPaths,seal,json,plain,readPackagePayloads,readResponsePayloads,strictJSON,LIMITS} from './workflow.js';
export const resultState={changed:'corrected_pending_review',unchanged_with_reason:'open',needs_clarification:'needs_source_clarification',unreviewed:'open'};
// Instructions outlive approval. Each issued follow-up contributes one entry;
// opening its response starts a fresh decision without losing earlier wording.
function instructionsFrom(f,issued){
  const history=clone(f.instructionHistory??[]),explanation=f.reviewer?.explanation??'',regionComment=f.currentAnchor?.comment??'';
  if(explanation||regionComment)history.push({taskId:issued.id,codeSha256:issued.task.baseline.codeSha256,renderSha256:issued.task.baseline.renderSha256,explanation,regionComment});
  return history;
}
export async function restoreInstructionHistory(round){
  if(!round||round.reported.every(f=>f.instructionHistory!==undefined))return false;
  const issued=await retained(round.taskId);if(!issued)throw new Error('The issued task is missing; earlier review prompts cannot be restored.');
  for(const f of round.reported)if(f.instructionHistory===undefined){const original=taskFindings(issued).find(item=>item.id===f.id);f.instructionHistory=original?instructionsFrom(original,issued):[];}
  return true;
}
export function returnedInputs(entry,issued,attachment=null){
  const response=entry.response,code=response.code.status==='changed'?{name:response.code.path.split('/').at(-1),blob:entry.payloads.get(response.code.path)}:issued.files.ly;
  const rendered=attachment?attachment.rendered:response.rendering.status==='supplied'?{name:response.rendering.path.split('/').at(-1),blob:entry.payloads.get(response.rendering.path)}:response.code.status==='unchanged'?issued.files.rendered:null;
  return {source:issued.files.source,ly:code,rendered};
}
export async function workspaceSeed(entry,issued,inspectPdf,attachment=null){
  const files=returnedInputs(entry,issued,attachment);if(!files.rendered)throw new Error('Updated rendering pending. Attach an existing PDF before reviewing changed code or exporting a follow-up.');
  const {identity,snapshotId}=await identify(files),pages=await inspectPdf(files),review=newReview(identity,snapshotId,pages);
  if(attachment&&(attachment.responseId!==entry.id||attachment.codeSha256!==identity.ly.sha256||attachment.rendered.sha256!==identity.rendered.sha256))throw new Error('This rendering attachment belongs to a different code revision.');
  const reported=taskFindings(issued).map(f=>{
    const agent=entry.response.results.find(r=>r.id===f.id),legacy=entry.findings.find(r=>r.id===f.id),state=isComment(f)?'open':attachment?resultState[agent.status]:legacy?.state??resultState[agent.status];
    return {id:f.id,number:f.number,comment:f.origin?.comment??f.comment,...findingTypeFields(f),origin:f.origin??{taskId:issued.id,findingId:f.id,page:f.page,renderSha256:issued.task.baseline.renderSha256},context:contextPaths(issued,f),agent:clone(agent),state,explanation:'',instructionHistory:instructionsFrom(f,issued),associationId:null,decision:state==='resolved'?{state,explanation:'Earlier explicit human decision for this exact revision.',reviewed:{snapshotId,codeSha256:identity.ly.sha256,renderSha256:identity.rendered.sha256}}:null};
  });
  review.nextNumber=Math.max(0,...reported.map(f=>f.number))+1;review.preferences=clone(issued.review.preferences);
  const returned={schema:'score-desk-returned-workspace',version:1,id:`returned:${entry.id}:${attachment?.id??'received'}`,responseId:entry.id,taskId:issued.id,parentRevisionId:entry.parentRevisionId??entry.id,attachmentId:attachment?.id??null,contentSnapshotId:snapshotId,codeSha256:identity.ly.sha256,renderSha256:identity.rendered.sha256,provenance:attachment?.provenance??{relationship:'supplier-declared; not established by compilation',supplier:entry.response.rendering.producer??'original user-supplied baseline',compiler:entry.response.rendering.compiler??null},reported};
  return {files,review,returned};
}
export async function renderingAttachment(entry,issued,file,inspectPdf){
  if(!file||file.size>100*1024*1024)throw new Error('Select a local PDF smaller than 100 MB.');
  const inputs=returnedInputs(entry,issued);await inspectPdf({source:inputs.source,rendered:{name:file.name,blob:file}});
  return {id:crypto.randomUUID(),kind:'render-attachment',version:1,createdAt:new Date().toISOString(),taskId:issued.id,responseId:entry.id,parentRevisionId:entry.id,codeSha256:await blobHash(inputs.ly.blob),rendered:{name:file.name,blob:file,size:file.size,sha256:await blobHash(file)},provenance:{supplier:'User-selected existing PDF',declaredAt:new Date().toISOString(),relationship:'supplier-declared; not established by compilation',compiler:null,compilationPerformedByScoreDesk:false}};
}
export async function followupTask(scene,context,progress,packageMaker,{lookup=retained,resolveHistorical=null}={}){
  const {review,files,returned:round,doc}=scene;if(!round)throw new Error('Open a returned revision first.');
  if(review.files.ly.sha256!==round.codeSha256||review.files.rendered.sha256!==round.renderSha256)throw new Error('The current files do not match this returned revision.');
  const issued=await lookup(round.taskId),entry=await lookup(round.responseId),outstanding=round.reported.filter(f=>{const mark=review.findings.find(m=>m.id===f.associationId);return isComment(mark&&Object.hasOwn(mark,'type')?mark:f)||f.state!=='resolved';}),associated=new Set(round.reported.map(f=>f.associationId).filter(Boolean));
  const current=clone(review);current.findings=[];
  const requests=outstanding.map(f=>{
    const mark=review.findings.find(m=>m.id===f.associationId),old=taskFindings(issued).find(m=>m.id===f.id);
    const type=findingTypeFields(mark&&Object.hasOwn(mark,'type')?mark:f);
    if(mark)current.findings.push({...clone(mark),...type,id:f.id,number:f.number,state:f.state});
    return {id:f.id,number:f.number,page:mark?.page??null,comment:f.comment,...type,origin:clone(f.origin),reviewer:{state:f.state,explanation:f.explanation,decision:clone(f.decision)},instructionHistory:clone(f.instructionHistory??[]),priorResponse:{taskId:round.taskId,responseId:round.responseId,result:clone(f.agent)},currentAnchor:mark?{findingId:f.id,page:mark.page,bounds:mark.bounds,comment:mark.comment}:null,historicalContext:{page:old?.historicalContext?.page??old?.page??f.origin.page,renderSha256:old?.historicalContext?.renderSha256??issued.task.baseline.renderSha256}};
  });
  for(const f of review.findings)if(!associated.has(f.id)&&(isComment(f)||f.state!=='resolved')){current.findings.push(clone(f));requests.push({id:f.id,number:f.number,page:f.page,comment:f.comment,...findingTypeFields(f),origin:{taskId:null,findingId:f.id,page:f.page,renderSha256:review.files.rendered.sha256,comment:f.comment},reviewer:{state:f.state,explanation:f.comment},instructionHistory:[],currentAnchor:{findingId:f.id,page:f.page,bounds:f.bounds,comment:f.comment},historicalContext:{page:f.page,renderSha256:review.files.rendered.sha256}});}
  if(!requests.length)throw new Error('There are no outstanding or new findings to send back.');
  const task=await makeTask(current,files,doc,context,progress,packageMaker);task.task.version=2;task.task.findings=requests;task.task.parent={workspaceId:round.id,responseId:round.responseId,taskId:round.taskId,contentSnapshotId:round.contentSnapshotId};
  // Findings often share one exact historical review. Serialize its complete
  // geometry once for this task, rather than replacing the same payload with
  // an equal Blob for every finding. Never retain mutable reviews across sends.
  const annotationPayloads=new WeakMap();
  for(const request of requests){const original=round.reported.find(f=>f.id===request.id),paths=original?original.context:['marked','clean'].map(type=>`findings/${String(request.number).padStart(3,'0')}-${request.id}-${type}.png`);
    for(let i=0;i<2;i++){const path=`historical/${request.id}-${i?'clean':'marked'}.png`,blob=(original?issued.payloads:task.payloads).get(paths[i]);if(blob){task.payloads.set(path,resolveHistorical&&original?await resolveHistorical(null,{taskId:issued.id,path:paths[i]}):blob);request.historicalContext[i?'clean':'marked']=path;}}
    const prior=original?taskFindings(issued).find(f=>f.id===request.id):null;
    const history=prior?.historicalContext;
    const sourceFiles=original?issued.files:files,sourceReview=original?issued.review:review;
    if(request.historicalContext.renderSha256===sourceReview.files.rendered.sha256){
      request.historicalContext.originalFiles={};
      for(const role of ['source','rendered','ly']){const info=sourceReview.files[role],path=`historical/assets/${info.sha256}.${role==='ly'?'ly':'pdf'}`;task.payloads.set(path,resolveHistorical?await resolveHistorical(info):sourceFiles[role].blob);request.historicalContext.originalFiles[role]={...info,path};}
      let annotation=annotationPayloads.get(sourceReview);if(!annotation){annotation=json(sourceReview);annotationPayloads.set(sourceReview,annotation);}
      const path=`historical/annotations/${sourceReview.snapshotId}.json`;task.payloads.set(path,annotation);request.historicalContext.annotations=path;
    }else if(history?.originalFiles){
      request.historicalContext.originalFiles=clone(history.originalFiles);
      for(const info of Object.values(history.originalFiles)){const blob=issued.payloads.get(info.path);if(blob)task.payloads.set(info.path,resolveHistorical?await resolveHistorical(info):blob);}
      if(history.annotations){const blob=issued.payloads.get(history.annotations);task.payloads.set(history.annotations,resolveHistorical&&blob?await resolveHistorical(null,{taskId:issued.id,path:history.annotations}):blob);request.historicalContext.annotations=history.annotations;}
    }
  }
  task.payloads.set('historical/previous-rendering.pdf',resolveHistorical?await resolveHistorical(issued.review.files.rendered):issued.files.rendered.blob);task.payloads.set('historical/prior-response.json',json(entry.response));
  await finalizeTask(task);return task;
}
// Preserve original imported bytes without re-exporting their filenames as
// active configuration/scripts. The compatibility task is safe; this optional
// JSON delta lets this app recover its byte-identical immutable original.
async function originalTaskData(original,delivery){
  const entries=[];
  for(const [path,blob]of original){const safe=delivery.get(path);if(safe===blob||safe?.size===blob.size&&await blobHash(safe)===await blobHash(blob))continue;
    const bytes=new Uint8Array(await blob.arrayBuffer());let base64='';for(let offset=0;offset<bytes.length;offset+=24576)base64+=btoa(String.fromCharCode(...bytes.subarray(offset,offset+24576)));
    entries.push({path,size:blob.size,sha256:await sha256(bytes),base64});
  }
  const result=json({schema:'score-desk-inert-original-task',version:1,entries,remove:[...delivery.keys()].filter(path=>!original.has(path))});
  if(result.size>LIMITS.json)throw new Error('Original imported metadata is too large for an inert recovery record. The original task remains saved.');return result;
}
async function restoreOriginalTask(safe,blob){
  if(!blob||blob.size>LIMITS.json)throw new Error('Original task recovery data is missing or too large.');
  const data=strictJSON(await blob.text()),valid=path=>typeof path==='string'&&path.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)&&!path.split('/').some(p=>!p||p==='.'||p==='..');
  if(data.schema!=='score-desk-inert-original-task'||data.version!==1||!Array.isArray(data.entries)||!Array.isArray(data.remove)||data.entries.length>LIMITS.count||data.remove.length>LIMITS.count||data.remove.some(path=>!valid(path)))throw new Error('Original task recovery metadata is invalid.');
  const result=new Map(safe),seen=new Set();for(const path of data.remove)result.delete(path);
  for(const item of data.entries){if(!valid(item.path)||seen.has(item.path)||typeof item.base64!=='string'||!Number.isSafeInteger(item.size)||item.size<0||item.size>LIMITS.file)throw new Error('Original task recovery entry is invalid.');seen.add(item.path);const bytes=Uint8Array.from(atob(item.base64),c=>c.charCodeAt(0));if(bytes.length!==item.size||await sha256(bytes)!==item.sha256)throw new Error('Original task recovery bytes differ.');result.set(item.path,new Blob([bytes]));}
  return result;
}
// A v1 package extension: older consumers retain ordinary current annotations;
// this app restores the explicit returned-workspace sidecar as a recovery branch.
export async function makeReturnedBackup(review,files,round,payloads=null,{lookup=retained}={}){
  payloads??=await makeRecovery(review,files);const issued=await lookup(round.taskId),entry=await lookup(round.responseId);
  const metadata={schema:'score-desk-returned-workspace-backup',version:1,returned:round,issued:{id:issued.id,kind:'task',createdAt:issued.createdAt,task:issued.task,review:issued.review},entry:{...entry,payloads:undefined},taskPaths:[],responsePaths:[]};
  const delivery=await localTaskDelivery(issued);
  for(const [path,blob]of delivery.payloads){payloads.set('history/task/'+path,blob);metadata.taskPaths.push(path);}
  metadata.originalTaskData='history/original-task-data.json';payloads.set(metadata.originalTaskData,await originalTaskData(issued.payloads,delivery.payloads));
  for(const [path,blob]of entry.payloads){payloads.set('history/response/'+path,blob);metadata.responsePaths.push(path);}
  payloads.set('returned-workspace.json',json(metadata));const manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.extensions=[{schema:metadata.schema,version:1,path:'returned-workspace.json'}];
  payloads.set('review.txt',plain(await payloads.get('review.txt').text()+'\n'+observationText('RETURNED REVISION — historical, not approval',round.reported)));
  const associated=new Set(round.reported.map(f=>f.associationId).filter(Boolean));
  const comments=[...round.reported.map(f=>{const mark=review.findings.find(m=>m.id===f.associationId);return {...f,...(mark&&Object.hasOwn(mark,'type')?findingTypeFields(mark):{}),...(mark?{currentAnchor:{findingId:mark.id,page:mark.page,bounds:mark.bounds,comment:mark.comment}}:{})};}),...review.findings.filter(f=>!associated.has(f.id))];
  payloads.set('internal-comments.txt',plain(internalCommentText(comments)));return seal(payloads,manifest);
}
export async function restoreReturnedBackup(parsed,inspectPdf){
  const extensions=parsed.manifest.extensions?.filter(e=>e.schema==='score-desk-returned-workspace-backup');if(!extensions?.length)return null;
  if(extensions.length!==1||extensions[0].version!==1||extensions[0].path!=='returned-workspace.json')throw new Error('Unsupported returned-review extension.');
  const meta=strictJSON(await parsed.payloads.get('returned-workspace.json').text());if(meta.schema!=='score-desk-returned-workspace-backup'||meta.version!==1)throw new Error('Unsupported returned-workspace backup.');
  let taskMap=new Map(meta.taskPaths.map(path=>[path,parsed.payloads.get('history/task/'+path)]));
  if(meta.originalTaskData){if(meta.originalTaskData!=='history/original-task-data.json')throw new Error('Original task recovery path is invalid.');taskMap=await restoreOriginalTask(taskMap,parsed.payloads.get(meta.originalTaskData));}
  const taskPackage=await readPackagePayloads(taskMap,inspectPdf),task=strictJSON(await taskMap.get('task.json').text()),issued={...meta.issued,task,review:taskPackage.review,files:taskPackage.files,payloads:taskMap};
  if(typeof task.createdAt!=='string'||task.createdAt.length>50||!Number.isFinite(Date.parse(task.createdAt))||issued.createdAt!==task.createdAt)throw new Error('The retained task creation date in this backup is invalid.');
  if(![1,2].includes(task.version)||issued.id!==task.id||task.schema!=='score-desk-task'||task.baseline.snapshotId!==taskPackage.review.snapshotId||task.baseline.codeSha256!==taskPackage.review.files.ly.sha256||task.baseline.renderSha256!==taskPackage.review.files.rendered.sha256||task.baseline.sourceSha256!==taskPackage.review.files.source.sha256||task.baseline.annotationSha256!==await blobHash(taskMap.get('annotations.json'))||!Array.isArray(task.findings)||task.findings.length>2000||new Set(task.findings.map(f=>f.id)).size!==task.findings.length)throw new Error('The retained task baseline in this backup does not match.');
  for(const f of task.findings){
    if(Object.hasOwn(f,'type')&&!FINDING_TYPES.includes(f.type))throw new Error('The retained finding type is invalid.');
    if(task.version===1||f.currentAnchor){const annotation=taskPackage.review.findings.find(a=>a.id===f.id);if(!annotation||findingType(annotation)!==findingType(f))throw new Error('The retained finding type differs from its annotation baseline.');}
  }
  const responseMap=new Map(meta.responsePaths.map(path=>[path,parsed.payloads.get('history/response/'+path)]));const response=await readResponsePayloads(responseMap,async id=>id===issued.id?issued:null),entry={...meta.entry,response:response.response,payloads:responseMap};
  if(entry.kind!=='response'||entry.taskId!==issued.id||typeof entry.id!=='string'||!/^[-\w]{1,80}$/.test(entry.id)||typeof entry.createdAt!=='string'||entry.createdAt.length>50||!Number.isFinite(Date.parse(entry.createdAt)))throw new Error('Returned response metadata is invalid.');
  const round=meta.returned,code=returnedInputs(entry,issued).ly;
  if(round.schema!=='score-desk-returned-workspace'||round.version!==1||round.taskId!==issued.id||round.responseId!==entry.id||round.contentSnapshotId!==parsed.review.snapshotId||round.codeSha256!==parsed.review.files.ly.sha256||round.codeSha256!==await blobHash(code.blob)||parsed.review.files.source.sha256!==task.baseline.sourceSha256||round.renderSha256!==parsed.review.files.rendered.sha256||!Array.isArray(round.reported)||round.reported.length!==task.findings.length)throw new Error('Returned-review identity mismatch.');
  const ids=new Set(task.findings.map(f=>f.id));for(const f of round.reported){
    const finding=task.findings.find(item=>item.id===f.id),agent=entry.response.results.find(item=>item.id===f.id);
    if(Object.hasOwn(f,'type')&&!FINDING_TYPES.includes(f.type)||finding&&findingType(f)!==findingType(finding))throw new Error('Returned-review finding type mismatch.');
    if(!ids.delete(f.id)||f.number!==finding.number||typeof f.comment!=='string'||f.comment.length>4000||!STATES.includes(f.state)||typeof f.explanation!=='string'||f.explanation.length>4000||JSON.stringify(f.agent)!==JSON.stringify(agent)||!Array.isArray(f.context)||f.context.length!==2||f.context.some(path=>typeof path!=='string'||!taskMap.has(path))||!f.origin||f.state==='resolved'&&!f.decision||f.decision&&(f.decision.state!==f.state||f.decision.reviewed.snapshotId!==round.contentSnapshotId||f.decision.reviewed.codeSha256!==round.codeSha256||f.decision.reviewed.renderSha256!==round.renderSha256))throw new Error('Returned-review decision or finding mismatch.');
  }
  // Do not add an empty field to old completed evidence: its state hash covers
  // the exact historical sidecar, including the absence of optional properties.
  if(round.locations!==undefined)round.locations=validateLocations(round.locations,round,parsed.review);
  return {issued,entry,seed:{files:parsed.files,review:parsed.review,completionBundle:parsed.completionBundle,returned:{...round,id:'returned:recovery:'+crypto.randomUUID(),recoveredFrom:round.id}}};
}
