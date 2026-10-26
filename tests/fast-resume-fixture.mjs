// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {makeTask,json,fileInfo} from '../app/workflow.js';
import {addCompletionHistory} from '../app/completion.js';
import {verifySavedFolder,writeLatestTask} from '../app/folder-workspace.js';
import {readRecovery,recoveryIsCurrent} from '../app/folder-recovery.js';
import {preparePdfOutput,syncPdfVersions} from '../app/pdf-versions.js';
import {syncProjectHistory} from '../app/project-history.js';
import {HistoryDirectory,put,get} from './history-memory.mjs';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
async function fixture(){
  const directory=new HistoryDirectory(),files={source:{name:'source.pdf',blob:new Blob(['%PDF SYNTHETIC source'])},rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC rendering'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC captured code'])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]),revisionId=crypto.randomUUID(),projectId=crypto.randomUUID(),workspaceId=snapshotId;
  const scene={review,files,returned:null,completions:[],workspaceId,revisionId,persistedRevision:1,stamp:{snapshotId,workspaceId:null,revision:1}};
  const record={...scene,id:workspaceId,storageRevision:1,projectId};
  const head=await makeTask(review,files,{},'120',()=>{},makeRecovery),objects=new Map();
  async function store(payloads){const result={};for(const [path,blob]of payloads){const info=await fileInfo(blob);objects.set(info.sha256,blob);result[path]=info;await put(directory,'.scorebrush/recovery/objects/'+info.sha256,blob);}return result;}
  const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'},id=crypto.randomUUID();
  const manifest={schema:'private-score-desk-recovery',version:1,id,projectId,parent:null,sequence:1,createdAt:review.createdAt,sourceSha256:identity.source.sha256,initialTranscriptionFilename:'Etude.pdf',paths,current:workspaceId,
    records:[{id:workspaceId,snapshotId,revisionId,storageRevision:1,payloads:await store(await addCompletionHistory(await makeRecovery(review,files),review,null,revisionId,[],{preserveRevision:true}))}],
    handoffs:[{id:head.id,kind:'task',payloads:await store(head.payloads)}],headTaskId:head.id,historyBackfillVersion:1,legacyEvidence:[]};
  await put(directory,'.scorebrush/OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  manifest.pdfOutput=await preparePdfOutput(directory,{manifest,objects});
  async function commit(value){const blob=json(value);await put(directory,'.scorebrush/recovery/g-'+value.id+'/snapshot.json',blob);await put(directory,'.scorebrush/recovery/g-'+value.id+'/COMMIT.json',json({schema:value.schema,version:1,id:value.id,manifestSha256:(await fileInfo(blob)).sha256}));}
  await commit(manifest);const snapshot=await readRecovery(directory),versions=await syncPdfVersions(directory,snapshot);await syncProjectHistory(directory,snapshot,{pdfVersions:versions.versions});
  const published=await writeLatestTask(directory,head,paths),config={directory,paths,head:published.entry,headStamp:{...scene.stamp,revision:99},workspaceId,boundSnapshotId:snapshotId,sourceSha256:identity.source.sha256,projectId,recoveryId:id};
  const verify=(s=scene,r=record,c=config,recovery=snapshot,options={})=>verifySavedFolder(c,s,r,recovery,options);
  directory.control.writes.length=0;return {directory,scene,record,config,snapshot,verify,commit};
}

export {fixture};
