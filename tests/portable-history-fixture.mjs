// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {identify,newReview} from '../app/model.js';
import {putSaved,getSaved,workspaceHistory} from '../app/storage.js';
import {makeRecovery} from '../app/export.js';
import {fileInfo,json} from '../app/workflow.js';
import {saveRecovery} from '../app/folder-recovery.js';
import {buildProjectHistory} from '../app/project-history.js';
import {HistoryDirectory} from './history-memory.mjs';
export const inspect=async()=>[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}];
export const scene=r=>({...r,workspaceId:r.id,doc:{},persistedRevision:r.storageRevision});
export async function head(label){
  const files={source:{name:'SYNTHETIC-source.pdf',blob:new Blob(['%PDF SYNTHETIC '+label])},rendered:{name:'Etude.pdf',blob:new Blob(['%PDF SYNTHETIC rendering'])},ly:{name:'score.ly',blob:new Blob(['% SYNTHETIC notation'])}};
  const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,await inspect());
  return putSaved({id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[]},null);
}
export const note=(i,text)=>({id:'synthetic-'+i,number:i+1,page:1,comment:text,type:'correction',state:'open',color:'#ffd34d',strokes:[],bounds:null});
export async function evidence(record,text){
  const review=structuredClone(record.review);review.findings=[note(0,text)];review.nextNumber=2;
  const payloads=await makeRecovery(review,record.files),declarations={};for(const [path,blob]of payloads)declarations[path]=await fileInfo(blob);
  return {bundle:{id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,missingData:['logical-revision-id-not-recorded']},payloads};
}
export async function currentState(id){return {head:await getSaved(id),journal:await workspaceHistory(id)};}
// Valid annotation packages, generated in memory. Tune real research JSON to an
// exact legacy v1 byte boundary without changing production limits or padding the ZIP.
export async function boundarySnapshot(record,target){
  const {snapshot}=await saveRecovery(new HistoryDirectory(),scene(record),{source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'});
  const reviews=Array.from({length:3},(_,n)=>{const r=structuredClone(record.review);r.findings=Array.from({length:1100},(_,i)=>note(i,String(n)+'x'.repeat(3999)));r.nextNumber=1101;return r;});
  let extra='';
  async function rebuild(){
    snapshot.manifest.legacyEvidence=[];
    for(const [n,review]of reviews.entries()){
      const payloads=await makeRecovery(review,record.files),declarations={};for(const [path,blob]of payloads){const info=await fileInfo(blob);declarations[path]=info;snapshot.objects.set(info.sha256,blob);}
      snapshot.manifest.legacyEvidence.push({id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,legacyRecordId:'SYNTHETIC-'+n+(n===0?extra:''),missingData:[]});
    }
    // The transfer creates one child generation; UUID text length is fixed.
    return json(await buildProjectHistory({...snapshot,manifest:{...snapshot.manifest,sequence:snapshot.manifest.sequence+1}},{objectRoot:'workspace-history/recovery/objects/',version:1})).size;
  }
  let size=await rebuild(),remove=Math.ceil((size-target)/2)+100;
  if(remove<0)throw Error('Boundary fixture must initially exceed target');
  for(const finding of reviews.flatMap(r=>r.findings)){const take=Math.min(remove,finding.comment.length-1);finding.comment=finding.comment.slice(0,finding.comment.length-take);remove-=take;if(!remove)break;}
  for(let n=0;n<5;n++){size=await rebuild();if(size===target)return snapshot;if(size>target)throw Error('Boundary calibration exceeded target');extra+='x'.repeat(target-size);}
  throw Error('Boundary fixture failed to converge');
}

// Recreate a v1 index over the exact generated transfer generation for legacy
// import boundary checks. New exports remain v2 and do not duplicate the notes.
export async function legacyIndex(result){
  const marker=JSON.parse(await result.payloads.get('workspace-transfer.json').text());
  const manifest=JSON.parse(await result.payloads.get('workspace-history/recovery/g-'+marker.generation+'/snapshot.json').text());
  const objects=new Map([...result.payloads].filter(([path])=>path.startsWith('workspace-history/recovery/objects/')).map(([path,blob])=>[path.split('/').at(-1),blob]));
  return json(await buildProjectHistory({manifest,objects},{objectRoot:'workspace-history/recovery/objects/',version:1}));
}
