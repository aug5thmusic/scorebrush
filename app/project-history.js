// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Public research data derived from committed, hash-checked recovery objects.
// This module grants no filesystem authority and never reads working score files.
import {blobHash,validateReview,findingType} from './model.js';
import {canonical,stateHash} from './completion-model.js';
import {strictJSON,LIMITS} from './workflow.js';
import {approvedRenderings} from './finished-pdf.js';
import {ensureDataDirectory,readDataDirectory} from './project-directory.js';
import {validPdfName} from './pdf-output-names.js';

export const HISTORY_FILE='History.json',HISTORY_SCHEMA='scorebrush-project-history',HISTORY_VERSION=2;
const RECEIPT='history-index.json',HASH=/^[a-f0-9]{64}$/;
const fail=message=>{throw new Error('Project history: '+message);};
const parsed=new WeakMap();
async function metadata(blob){
  if(!blob||blob.size>LIMITS.json)fail('missing or oversized retained metadata.');
  let value=parsed.get(blob);if(!value){value=strictJSON(await blob.text());parsed.set(blob,value);}return value;
}
const knownDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const roles=['source','rendered','ly'],inputPaths={source:'source-original.pdf',rendered:'rendered-original.pdf',ly:'lilypond/supplied.ly'};
const refId=hash=>'sha256:'+hash;

export async function buildProjectHistory(snapshot,{objectRoot='.scorebrush/recovery/objects/',pdfVersions=[],version=HISTORY_VERSION}={}){
  if(![1,HISTORY_VERSION].includes(version))fail('unsupported research index version.');
  if(!snapshot||!['.scorebrush/recovery/objects/','workspace-history/recovery/objects/'].includes(objectRoot))fail('a committed project and safe object root are required.');
  for(const version of pdfVersions){
    const safePath=path=>path==null||typeof path==='string'&&path.startsWith('Versions/')&&validPdfName(path.slice(9),version.number);
    if(!HASH.test(version.sha256)||!Number.isSafeInteger(version.number)||version.number<1||version.number>LIMITS.count||!safePath(version.path)||!safePath(version.originalPath))fail('unsafe visible PDF version reference.');
  }
  const {manifest,objects}=snapshot,objectIndex=new Map(),assets=new Map(),revisions=[],handoffs=[],gaps=[],revisionStates=new Map();
  // Many findings retain the same immutable annotation document. Validate each
  // decoded object once in this build, while still checking every payload and
  // historical file binding below. Never carry validation across builds.
  const validatedReviews=new WeakSet();
  function validateRetainedReview(review){
    if(validatedReviews.has(review))return;
    validateReview(review,review);validatedReviews.add(review);
  }
  async function reference(info){
    if(!HASH.test(info?.sha256)||!Number.isSafeInteger(info.size))fail('invalid retained object identity.');
    const id=refId(info.sha256);
    if(!objectIndex.has(id)){
      const blob=objects.get(info.sha256);
      if(!blob||blob.size!==info.size||await blobHash(blob)!==info.sha256)fail('a retained object is missing or changed: '+info.sha256);
      objectIndex.set(id,{id,sha256:info.sha256,size:info.size,path:objectRoot+info.sha256});
    }else if(objectIndex.get(id).size!==info.size)fail('inconsistent retained object sizes.');
    return id;
  }
  async function value(bundle,path){
    const info=bundle.payloads[path];if(!info)return null;await reference(info);return metadata(objects.get(info.sha256));
  }
  async function scoreAsset(bundle,path,role,identity){
    const info=bundle.payloads[path];
    if(!info||!identity||info.sha256!==identity.sha256||info.size!==identity.size)return null;
    const id=await reference(info),asset=assets.get(id)??{...objectIndex.get(id),roles:[],originalFilenames:[]};
    if(!asset.roles.includes(role))asset.roles.push(role);
    if(typeof identity.name==='string'&&!asset.originalFilenames.includes(identity.name))asset.originalFilenames.push(identity.name);
    assets.set(id,asset);return id;
  }
  async function payloadReferences(bundle){
    const result={};for(const [path,info]of Object.entries(bundle.payloads))result[path]=await reference(info);return result;
  }
  async function addRevision(bundle,{prefix='',kind='retained-state',id=bundle.id,revisionId=bundle.revisionId??null,taskId=null,legacy=false}={}){
    const review=await value(bundle,prefix+'annotations.json');if(!review)return null;
    validateRetainedReview(review);
    const round=(await value(bundle,prefix+'returned-workspace.json'))?.returned??null;
    const completion=await value(bundle,prefix+'completion-history.json'),missingData=[];
    if(completion&&completion.stateSha256!==await stateHash(review,round))fail('retained edit state hash differs.');
    revisionId??=completion?.revisionId??null;
    if(!revisionId)missingData.push('logical-revision-id-not-recorded');
    const assetIds={};
    for(const role of roles){
      assetIds[role]=await scoreAsset(bundle,prefix+inputPaths[role],role,review.files[role]);
      if(!assetIds[role])missingData.push('missing-exact-'+role+'-bytes');
    }
    if(!legacy&&(Object.values(assetIds).some(v=>!v)||bundle.snapshotId&&bundle.snapshotId!==review.snapshotId||completion?.revisionId!==revisionId))fail('committed revision identity differs.');
    if(round&&(round.contentSnapshotId!==review.snapshotId||round.codeSha256!==review.files.ly.sha256||round.renderSha256!==review.files.rendered.sha256))fail('review decisions refer to different code/render bytes.');
    const hasResult=bundle.resultingSnapshotId!==undefined||bundle.resultingRenderSha256!==undefined;
    if(hasResult&&(!bundle.history||typeof bundle.resultingSnapshotId!=='string'||!HASH.test(bundle.resultingSnapshotId)||typeof bundle.resultingRenderSha256!=='string'||!HASH.test(bundle.resultingRenderSha256)||bundle.resultingRenderSha256===review.files.rendered.sha256))fail('completed-review rendering identity is invalid.');
    const resultIdentity=hasResult?{resultingSnapshotId:bundle.resultingSnapshotId,resultingRenderSha256:bundle.resultingRenderSha256}:{};
    const checkpoint=manifest.records.find(r=>r.id===bundle.historyId);
    const coverage=bundle.historyCoverage??checkpoint?.historyCoverage??(legacy?'legacy-evidence':bundle.journalVersion===1?'current-journal-state':'legacy-retained-state');
    if(!['durable-save','current-journal-state'].includes(coverage))missingData.push('earlier-durable-edits-not-completely-recorded');
    const capturedAt=coverage==='durable-save'?knownDate(bundle.createdAt??checkpoint?.createdAt):bundle.history&&bundle.historyCoverage===undefined?knownDate(bundle.createdAt):null;
    if(!capturedAt)missingData.push('exact-capture-time-not-recorded');
    const pdf=pdfVersions.filter(v=>v.sha256===review.files.rendered.sha256);
    const currentFindings=version===1?review.findings.map(f=>({id:f.id,number:f.number,type:findingType(f),text:f.comment,state:f.state,
      rendered:{assetId:assetIds.rendered,page:f.page,pageGeometry:review.pages[f.page-1],coordinates:review.coordinates,strokes:f.strokes,bounds:f.bounds},
      source:{assetId:assetIds.source,page:null,region:null,mapping:'not established'},
      associatedReportedIds:(round?.reported??[]).filter(r=>r.associationId===f.id).map(r=>r.id)})):null;
    const reported=version===1?(round?.reported??[]).map(f=>({id:f.id,number:f.number,type:findingType(f),originalText:f.comment,
      origin:f.origin,associationId:f.associationId,state:f.state,explanation:f.explanation,decision:f.decision,
      agent:f.agent,instructionHistory:f.instructionHistory??null,context:f.context,
      reviewed:{revisionId,snapshotId:review.snapshotId,codeSha256:review.files.ly.sha256,renderSha256:review.files.rendered.sha256}})):null;
    const result={id,kind:hasResult?'completed-review':kind,...resultIdentity,revisionId,snapshotId:review.snapshotId,workspaceId:bundle.workspaceId??round?.id??bundle.id,
      parentEventId:bundle.parentHistoryId??null,parentWorkspaceId:bundle.parentWorkspaceId??null,
      parentRevisionId:round?.parentRevisionId??null,importedFromWorkspaceId:round?.recoveredFrom??null,legacyRecordId:bundle.legacyRecordId??null,
      taskId:round?.taskId??taskId,responseId:round?.responseId??null,attachmentId:round?.attachmentId??null,
      capturedAt,retainedAt:knownDate(bundle.createdAt),annotationCreatedAt:knownDate(review.createdAt),annotationUpdatedAt:knownDate(review.updatedAt),
      storageRevision:bundle.storageRevision??null,assetIds,pdfVersions:pdf,
      ...(version===1?{findings:currentFindings,reportedFindings:reported,annotations:review,returned:round,completionRecords:completion?.records??[]}:{
        packageManifestId:bundle.payloads['manifest.json']?refId(bundle.payloads['manifest.json'].sha256):null,
        metadata:{annotations:refId(bundle.payloads[prefix+'annotations.json'].sha256),
          returned:round?refId(bundle.payloads[prefix+'returned-workspace.json'].sha256):null,
          completion:completion?refId(bundle.payloads[prefix+'completion-history.json'].sha256):null},
        counts:{findings:review.findings.length,reportedFindings:round?.reported?.length??0,completionRecords:completion?.records?.length??0}}),coverage,missingData};
    revisionStates.set(id,{review,round});revisions.push(result);return result;
  }
  for(const bundle of manifest.records){
    await payloadReferences(bundle);
    await addRevision(bundle,{kind:bundle.history?'durable-edit':'workspace-head'});
  }
  // Task baselines and their explicit historical annotations retain evidence
  // predating the edit journal, without inventing parents, capture dates or code.
  const handoffBundles=new Map((manifest.handoffs??[]).map(bundle=>[bundle.id,bundle]));
  // Older backups may retain task/response packages only as embedded payloads.
  // Expose their metadata directly, using the original IDs and exact bytes.
  for(const bundle of [...manifest.records,...(manifest.legacyEvidence??[])])for(const [prefix,kind]of [['history/task/','task'],['history/response/','response']]){
    const meta=await value(bundle,prefix+kind+'.json');if(!meta)continue;
    const round=(await value(bundle,'returned-workspace.json'))?.returned;
    const id=kind==='task'?meta.id:round?.responseId;
    if(!id)continue;
    const embedded={id,kind,taskId:meta.taskId,payloads:Object.fromEntries(Object.entries(bundle.payloads).filter(([p])=>p.startsWith(prefix)).map(([p,v])=>[p.slice(prefix.length),v]))};
    const prior=handoffBundles.get(id);
    if(prior&&canonical(await value(prior,kind+'.json'))!==canonical(meta))fail('conflicting embedded handoff identity.');
    if(!prior)handoffBundles.set(id,embedded);
  }
  for(const bundle of handoffBundles.values()){
    const payloads=await payloadReferences(bundle),task=await value(bundle,'task.json'),response=await value(bundle,'response.json');
    if(bundle.kind==='task'){
      if(task?.id!==bundle.id)fail('retained task identity differs.');
      const baseline=await addRevision(bundle,{id:'task-baseline:'+bundle.id,kind:'task-baseline',taskId:bundle.id,legacy:true});
      if(!baseline||task.baseline.snapshotId!==baseline.snapshotId||task.baseline.codeSha256!==revisionStates.get(baseline.id).review.files.ly.sha256||task.baseline.renderSha256!==revisionStates.get(baseline.id).review.files.rendered.sha256)fail('retained task baseline differs.');
      for(const finding of task.findings??[]){
        const historical=finding.historicalContext;
        if(historical?.originalFiles)for(const role of roles){
          const info=historical.originalFiles[role];if(info)await scoreAsset(bundle,info.path,role,info);
        }
        if(historical?.annotations){
          const review=await value(bundle,historical.annotations);
          if(review){
            validateRetainedReview(review);
            const assetIds={};for(const role of roles){const info=historical.originalFiles?.[role];assetIds[role]=info?await scoreAsset(bundle,info.path,role,info):null;}
            const id='task-history:'+bundle.id+':'+review.snapshotId;
            if(!revisions.some(r=>r.id===id))revisions.push({id,kind:'historical-task-evidence',revisionId:null,snapshotId:review.snapshotId,workspaceId:null,taskId:bundle.id,parentEventId:null,parentWorkspaceId:null,capturedAt:null,assetIds,...(version===1?{annotations:review,findings:review.findings}:{metadata:{annotations:refId(bundle.payloads[historical.annotations].sha256),returned:null,completion:null},counts:{findings:review.findings.length,reportedFindings:0,completionRecords:0}}),missingData:['logical-revision-id-not-recorded','exact-capture-time-not-recorded','earlier-durable-edits-not-completely-recorded']});
          }
        }
      }
    }else if(bundle.kind==='response'&&response?.taskId!==bundle.taskId)fail('retained response task differs.');
    handoffs.push({id:bundle.id,kind:bundle.kind,taskId:bundle.kind==='response'?bundle.taskId:bundle.id,createdAt:knownDate(bundle.createdAt??task?.createdAt),...(version===1?{metadata:task??response}:{metadataId:task?refId(bundle.payloads['task.json'].sha256):response?refId(bundle.payloads['response.json'].sha256):null}),payloads,missingData:task||response?[]:['metadata-unavailable']});
  }
  for(const bundle of manifest.legacyEvidence??[]){
    await payloadReferences(bundle);
    const revision=await addRevision(bundle,{kind:'legacy-package',legacy:true});
    if(revision)revision.missingData.push(...(bundle.missingData??[]));
  }
  const byId=new Map(revisions.map(r=>[r.id,r]));
  const events=revisions.filter(r=>['durable-edit','completed-review'].includes(r.kind)).map(r=>{
    const parent=byId.get(r.parentEventId),before=revisionStates.get(r.parentEventId)?.review.findings,after=revisionStates.get(r.id).review.findings;
    const changes=before?{
      added:after.filter(f=>!before.some(p=>p.id===f.id)).map(f=>f.id),
      deleted:before.filter(f=>!after.some(p=>p.id===f.id)).map(f=>f.id),
      modified:after.filter(f=>before.some(p=>p.id===f.id&&canonical(p)!==canonical(f))).map(f=>f.id)
    }:null;
    if(r.parentEventId&&!parent)r.missingData.push('parent-event-not-retained');
    return {id:r.id,...(r.kind==='completed-review'?{kind:r.kind,resultingSnapshotId:r.resultingSnapshotId,resultingRenderSha256:r.resultingRenderSha256}:{}),revisionId:r.revisionId,workspaceId:r.workspaceId,parentEventId:r.parentEventId,capturedAt:r.capturedAt,coverage:r.coverage,assetIds:r.assetIds,changes,...(version===1?{decisionStates:r.reportedFindings}:{metadata:r.metadata})};
  });
  const current=byId.get(manifest.current);if(!current)fail('the current revision is missing.');
  const approved=await approvedRenderings(snapshot),latest=approved.at(-1),approvedRecord=latest&&manifest.records.find(r=>r.id===latest.recordId);
  for(const revision of revisions)if(revision.missingData.length)gaps.push({recordId:revision.id,missing:revision.missingData});
  return {schema:HISTORY_SCHEMA,version,...(version===1?{}:{metadataFormat:{
      resolution:'Resolve each metadata ID through objects[].id; read that exact UTF-8 JSON file at objects[].path. Hashes and sizes identify immutable bytes.',
      annotations:'The entire original annotations document, including files, pages, coordinates, findings, text, types, strokes and bounds.',
      returned:'The entire returned-workspace document; its returned property contains exact reported findings, decisions, explanations, associations and origins.',
      completion:'The entire completion-history document; its records property contains exact completion declarations and evidence.',
      packages:'Each revision packageManifestId resolves the original package manifest; its payloads map associates every original filename with an object SHA-256 and size.',
      handoffs:'metadataId identifies the original task or response document; payloads maps every original relative filename to its exact object ID.'}}),project:{id:manifest.projectId,initialTranscriptionFilename:manifest.initialTranscriptionFilename??null,pdfOutput:manifest.pdfOutput??null,
      current:{recordId:current.id,revisionId:current.revisionId,snapshotId:current.snapshotId,workspaceId:current.workspaceId},
      latestApprovedRevision:latest?{recordId:latest.recordId,revisionId:latest.revisionId,workspaceId:latest.workspaceId,snapshotId:latest.snapshotId,renderSha256:latest.sha256,codeSha256:latest.approval.review.files.ly.sha256,approvedAt:approvedRecord?.history&&approvedRecord.historyCoverage!=='legacy-retained-state'?latest.finishedAt:null,orderingEvidenceAt:latest.finishedAt}:null},
    committedGeneration:{id:manifest.id,sequence:manifest.sequence},assets:[...assets.values()],objects:[...objectIndex.values()],revisions,events,handoffs,
    coverage:{guarantee:'Every captured file revision and every changed correction/review state at a durable save boundary from journalVersion 1 onward; immutable retained states, not a keystroke log.',
      excludes:['External edits never loaded by ScoreBrush','External LilyPond includes not selected as the supplied .ly file','Keystrokes between durable saves','View opening, scrolling and unchanged saves'],
      pageMapping:'Source and rendered page identities are independent. No musical matches are inferred.',
      initialFilenameKnown:manifest.initialTranscriptionFilename!=null,legacyGaps:gaps,missingData:manifest.legacyGaps??[]}};
}

async function optional(dir,name){try{return await(await dir.getFileHandle(name)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function write(dir,name,blob){
  const writer=await(await dir.getFileHandle(name,{create:true})).createWritable({mode:'exclusive'});
  try{await writer.write(blob);await writer.close();}catch(e){try{await writer.abort();}catch{}throw e;}
}
async function receipt(data,projectId){
  const file=await optional(data,RECEIPT);if(!file?.size)return null;
  const result=await metadata(file);
  if(result.schema!=='scorebrush-history-publication'||result.version!==1||result.projectId!==projectId||result.name!==HISTORY_FILE||!Object.hasOwn(result,'current')||!Object.hasOwn(result,'pending'))fail('ownership metadata is invalid. Preserve the existing History.json and project folder.');
  for(const item of [result.current,result.pending].filter(Boolean))if(!HASH.test(item.sha256)||!Number.isSafeInteger(item.size)||item.size<1||!Number.isSafeInteger(item.sequence))fail('publication identity is invalid.');
  return result;
}
async function matches(blob,info){return Boolean(blob&&info&&blob.size===info.size&&await blobHash(blob)===info.sha256);}
async function saveReceipt(data,value){
  const blob=new Blob([JSON.stringify(value)]);await write(data,RECEIPT,blob);
  if(!await matches(await optional(data,RECEIPT),{size:blob.size,sha256:await blobHash(blob)}))fail('ownership write could not be verified. Retry saving.');
}
async function visible(root){
  for await(const [name,entry]of root.entries())if(name.toLowerCase()===HISTORY_FILE.toLowerCase()&&(name!==HISTORY_FILE||entry.kind!=='file'))fail('an existing History.json name conflicts with this output. Keep it and move it aside before retrying.');
  return optional(root,HISTORY_FILE);
}
export async function syncProjectHistory(directory,snapshot,{pdfVersions=[]}={}){
  if(!snapshot)fail('save a valid recovery snapshot first.');
  if(!globalThis.navigator?.locks)fail('this browser cannot coordinate history publication.');
  return navigator.locks.request('scorebrush-history:'+snapshot.manifest.projectId,async()=>{
    const data=await ensureDataDirectory(directory),lock=await data.getFileHandle('history-index.lock',{create:true});
    if((await lock.getFile()).size)fail('history lock conflicts with existing data.');
    const writer=await lock.createWritable({mode:'exclusive'});
    try{
      const presentationSha256=await blobHash(new Blob([canonical(pdfVersions)]));
      let journal=await receipt(data,snapshot.manifest.projectId);const existing=await visible(directory);
      if(!journal&&existing)fail('History.json already exists and is not owned by ScoreBrush. Preserve it and move it aside before retrying.');
      if(journal&&existing&&!await matches(existing,journal.current)&&!await matches(existing,journal.pending)&&!(journal.current===null&&journal.pending&&existing.size===0))fail('History.json was modified outside ScoreBrush. Preserve it and move it aside before retrying.');
      if(journal?.current?.indexVersion===HISTORY_VERSION&&journal.current.generation===snapshot.manifest.id&&journal.current.presentationSha256===presentationSha256&&!journal.pending&&await matches(existing,journal.current))return {written:0,generation:snapshot.manifest.id};
      if(journal?.current?.sequence>snapshot.manifest.sequence)fail('a newer history index is already published. Retry from the current committed project.');
      const index=await buildProjectHistory(snapshot,{pdfVersions}),blob=new Blob([JSON.stringify(index,null,2)+'\n'],{type:'application/json'});
      if(blob.size>LIMITS.json)fail('History.json exceeds '+LIMITS.json+' bytes. The prior index is unchanged; protect pending work with saving recovery and keep the complete folder/profile.');
      const target={indexVersion:HISTORY_VERSION,sha256:await blobHash(blob),size:blob.size,generation:snapshot.manifest.id,sequence:snapshot.manifest.sequence,presentationSha256};
      journal={schema:'scorebrush-history-publication',version:1,projectId:snapshot.manifest.projectId,name:HISTORY_FILE,current:journal?.current??null,pending:target};
      await saveReceipt(data,journal);
      // File System Access stages replacement until close. The old complete
      // file remains available on write/close failure; intent makes retry safe.
      const before=await visible(directory);
      if(before&&!await matches(before,journal.current)&&!await matches(before,target)&&!(journal.current===null&&before.size===0))fail('History.json changed during publication. The existing file was preserved.');
      if(!await matches(before,target))await write(directory,HISTORY_FILE,blob);
      if(!await matches(await visible(directory),target))fail('History.json read-back failed. Retry saving.');
      await saveReceipt(data,{...journal,current:target,pending:null});
      return {written:1,generation:snapshot.manifest.id};
    }finally{await writer.abort();}
  });
}
export async function readPublishedHistory(directory,projectId){
  const owned=await readDataDirectory(directory);if(!owned)return null;
  const journal=await receipt(owned.directory,projectId),file=await visible(directory);
  if(!journal?.current||!await matches(file,journal.current))return null;
  return metadata(file);
}
export async function checkProjectHistory(directory,snapshot,pdfVersions){
  const owned=await readDataDirectory(directory);if(!owned)return false;
  const journal=await receipt(owned.directory,snapshot.manifest.projectId);
  return Boolean(journal?.current?.indexVersion===HISTORY_VERSION&&journal.current.generation===snapshot.manifest.id&&journal.current.sequence===snapshot.manifest.sequence&&!journal.pending&&
    journal.current.presentationSha256===await blobHash(new Blob([canonical(pdfVersions)]))&&await matches(await visible(directory),journal.current));
}

