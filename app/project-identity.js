// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Content hashes identify bytes. A project identity identifies the review that
// owns those bytes; two new projects must never share a mutable review head.
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash=/^[a-f0-9]{64}$/;
export const projectWorkspaceId=(projectId,snapshotId)=>{
  if(!uuid.test(projectId)||!hash.test(snapshotId))throw new Error('Invalid project workspace identity.');
  return `project:${projectId}:${snapshotId}`;
};
export function validateWorkspaceIdentity(value,snapshotId){
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value)||!uuid.test(value.projectId)||typeof value.id!=='string'||
    !(value.id===snapshotId||value.id===projectWorkspaceId(value.projectId,snapshotId)||/^returned:[\w:-]{1,180}$/.test(value.id))||
    Object.keys(value).some(k=>!['id','projectId','parentWorkspaceId','initialTranscriptionFilename'].includes(k))||
    value.parentWorkspaceId!=null&&(typeof value.parentWorkspaceId!=='string'||!value.parentWorkspaceId.length||value.parentWorkspaceId.length>200)||
    value.initialTranscriptionFilename!=null&&(typeof value.initialTranscriptionFilename!=='string'||value.initialTranscriptionFilename.length>1000))throw new Error('Package project identity does not match its input snapshot.');
  return structuredClone(value);
}
export function workspaceIdentity(scene){
  if(!scene?.projectId)return null; // Legacy fixtures and packages remain valid.
  return validateWorkspaceIdentity({id:scene.workspaceId??scene.id,projectId:scene.projectId,
    ...(scene.parentWorkspaceId!==undefined?{parentWorkspaceId:scene.parentWorkspaceId}:{}),
    ...(scene.initialTranscriptionFilename!==undefined?{initialTranscriptionFilename:scene.initialTranscriptionFilename}:{})},scene.review.snapshotId);
}
export async function addWorkspaceIdentity(payloads,scene){
  const identity=workspaceIdentity(scene);if(!identity)return payloads;
  // Version 1 readers ignore unknown metadata and would reopen these bytes in
  // the shared hash-key workspace. Require a reader that preserves ownership.
  const manifest=JSON.parse(await payloads.get('manifest.json').text());manifest.version=2;manifest.workspace=identity;
  payloads.set('manifest.json',new Blob([JSON.stringify(manifest,null,2)+'\n'],{type:'application/json;charset=utf-8'}));return payloads;
}
