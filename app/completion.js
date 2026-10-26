// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {COMPLETION_EXTENSION,SCOPES,createCompletion,mergeCompletions,completionSummary,jsonBlob,stateHash,validateCompletionBundle} from './completion-model.js';
import {makeReturnedBackup} from './returned.js';
import {returnedHistory} from './storage.js';
import {seal,LIMITS} from './workflow.js';
import {roles,sha256} from './model.js';
import {observationText} from './export.js';
// Backups preserve the current workspace without adding a review declaration.
// Completion records are retained only for compatibility with earlier backups.
export async function prepareBackup(scene,progress,packageMaker,{signal,lookup}={}){
  const check=()=>signal?.throwIfAborted();check();
  for(const role of roles){
    if(await sha256(await scene.files[role].blob.arrayBuffer())!==scene.review.files[role].sha256)throw new Error('Current input bytes changed. Reopen the exact files before saving a backup.');
    check();
  }
  let payloads=await packageMaker(scene.review,scene.files,scene.doc,'120',progress,{signal});check();
  if(scene.returned)payloads=await makeReturnedBackup(scene.review,scene.files,scene.returned,payloads,{lookup});check();
  const manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.kind='review-backup';delete manifest.completionId;payloads.set('manifest.json',jsonBlob(manifest));
  payloads=await addCompletionHistory(payloads,scene.review,scene.returned,scene.revisionId,scene.completions??[],{preserveRevision:true});check();
  await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));check();
  if(payloads.size>LIMITS.count||[...payloads.values()].some(b=>b.size>LIMITS.file)||[...payloads.values()].reduce((n,b)=>n+b.size,0)>LIMITS.total)throw new Error('Backup exceeds the supported import size limits.');
  return {payloads};
}
export async function addCompletionHistory(payloads,review,round,revisionId,records,{preserveRevision=false}={}){
  if(!records.length&&!preserveRevision)return payloads;
  const manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.extensions=[...(manifest.extensions??[]).filter(e=>e.schema!==COMPLETION_EXTENSION.schema),COMPLETION_EXTENSION];
  const metadata={schema:COMPLETION_EXTENSION.schema,version:1,revisionId,stateSha256:await stateHash(review,round),records},bundle=jsonBlob(metadata);
  if(bundle.size>LIMITS.json)throw new Error('Completion history exceeds the 25 MB import limit. Keep earlier packages and use a smaller review.');
  await validateCompletionBundle(metadata,review,round);
  payloads.set(COMPLETION_EXTENSION.path,bundle);
  // The existing extension also preserves exact revision identity and annotation
  // dates when there are no historical declarations. Older readers support it.
  if(!records.length)return seal(payloads,manifest);
  const current=records.filter(r=>r.revision.id===revisionId).at(-1);
  const history='\nCOMPLETION HISTORY (full immutable records: completion-history.json)\n'+records.map(r=>`${r.id} | ${r.revision.id===revisionId?'matches current review state':'historical; does not declare current revision'} | ${SCOPES[r.scope]} | ${r.createdAt} | ${r.totals.unresolved} unresolved`).join('\n')+'\n';
  payloads.set('completion-summary.txt',new Blob([observationText(current?'COMPLETED REVIEW':'HISTORICAL COMPLETIONS ONLY',{summary:current?completionSummary(current):records.map(r=>completionSummary(r)),history})],{type:'text/plain;charset=utf-8'}));return seal(payloads,manifest);
}
// Kept for legacy-format fixtures and compatibility checks. The workspace UI
// never creates these declarations; its backup action uses prepareBackup.
export async function prepareCompletion(scene,declaration,attempt,progress,packageMaker){
  for(const role of roles)if(await sha256(await scene.files[role].blob.arrayBuffer())!==scene.review.files[role].sha256)throw new Error('Current input bytes changed. Reopen the exact files before finishing.');
  let payloads=await packageMaker(scene.review,scene.files,scene.doc,'120',progress);
  if(scene.returned)payloads=await makeReturnedBackup(scene.review,scene.files,scene.returned,payloads);
  const events=scene.returned?(await returnedHistory(scene.workspaceId)).filter(e=>e.storageRevision<=scene.persistedRevision):[];
  const record=attempt.record??=await createCompletion(scene,declaration,attempt,events);
  const manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.kind='completed-review-handoff';manifest.completionId=record.id;payloads.set('manifest.json',jsonBlob(manifest));
  payloads.set('review.txt',new Blob(['COMPLETED-REVIEW HANDOFF\nRead completion-summary.txt for the declared scope and exact revision. This is not an issued AI correction task. All finding states remain included; no approval or score verification is established.\n\n',await payloads.get('review.txt').text()],{type:'text/plain;charset=utf-8'}));
  payloads=await addCompletionHistory(payloads,scene.review,scene.returned,scene.revisionId,mergeCompletions(scene.completions,[record]));
  await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
  if(payloads.size>LIMITS.count||[...payloads.values()].some(b=>b.size>LIMITS.file)||[...payloads.values()].reduce((n,b)=>n+b.size,0)>LIMITS.total)throw new Error('Completed package exceeds the supported import size limits.');return {record,payloads};
}
