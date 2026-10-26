// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {readDataDirectory} from './project-directory.js';
// Prove that a native path is the directory already selected through WebView2.
// The host issues a one-use challenge; only its temporary proof is read natively.
import {nativeRequest} from './native-bridge.js';
export const nativeFoldersAvailable=()=>Boolean(globalThis.chrome?.webview);
function validChallenge(challenge){
  if(!challenge||!/^native-open-[a-f0-9]{32}\.txt$/.test(challenge.marker)||!/^[a-f0-9]{64}$/.test(challenge.proof)||!/^[a-f0-9]{32}$/.test(challenge.token))throw new Error('Windows could not verify the folder request.');
}
async function withProof(directory,challenge,action){
  validChallenge(challenge);const {marker,proof}=challenge;
  try{await directory.getFileHandle(marker);throw new Error('Folder verification could not start. Try again.');}catch(error){if(error.name!=='NotFoundError')throw error;}
  let created=false,writer;
  try{
    const handle=await directory.getFileHandle(marker,{create:true});created=true;writer=await handle.createWritable();
    await writer.write('private-score-desk-open-v1\n'+proof);await writer.close();writer=null;
    return await action();
  }finally{
    if(writer)try{await writer.abort();}catch{}
    if(created)try{await directory.removeEntry(marker);}catch{/* Only the inert, uniquely named proof can remain. */}
  }
}
export async function selectNativeFolder({binding=null,expected=null,validateSelection=null}={}, {request=nativeRequest}={}){
  let result;
  try{
    result=await request(binding?'folder-resume':'folder-select',binding?{binding}:{});
    if(result.cancelled)throw new DOMException('Folder selection cancelled.','AbortError');
    validChallenge(result);
    const directory=result.directory;
    if(directory?.kind!=='directory'||typeof result.path!=='string'||! /^[A-Za-z]:\\/.test(result.path))throw new Error('Windows did not provide a valid selected folder.');
    if(expected&&!await expected.isSameEntry(directory))throw new Error('Choose the same connected working folder. The saved connection has not changed.');
    // The native API grants this specific handle. Never turn a failed grant into
    // a browser permission prompt or a blanket PermissionRequested approval.
    if(await directory.queryPermission({mode:'readwrite'})!=='granted')throw new Error('Windows did not grant access to this folder. Check access and select it again.');
    // Explicit reconnection may validate a moved project's retained identity.
    // Resume still requires the old handle to match; it cannot use this route.
    if(!binding&&validateSelection)await validateSelection(directory);
    const {token,marker,proof}=result;
    const confirmed=await withProof(directory,result,()=>request('folder-confirm',{token,marker,proof}));
    if(!/^[a-f0-9]{32}$/.test(confirmed.binding)||confirmed.path!==result.path)throw new Error('Windows did not confirm the selected folder.');
    return {directory,absolutePath:result.path,nativeBinding:confirmed.binding};
  }finally{if(result&&!result.cancelled)try{await request('folder-release');}catch{}}
}
export function pickWorkingDirectory({validateSelection=null}={}){
  return nativeFoldersAvailable()?selectNativeFolder({validateSelection}):window.showDirectoryPicker({id:'private-score-desk',mode:'readwrite'});
}
export async function openNativeFolder({directory,absolutePath='',name=directory.name},{request=nativeRequest}={}){
  return proveFolder({directory,absolutePath,name},request,'folder-open');
}
export async function openNativeVersions({directory,absolutePath='',name=directory.name},{request=nativeRequest}={}){
  return proveFolder({directory,absolutePath,name},request,'folder-versions');
}
export async function openNativeLatest({directory,absolutePath='',name=directory.name},{request=nativeRequest}={}){
  return proveFolder({directory,absolutePath,name},request,'folder-latest');
}
export async function verifyNativeFolder({directory,absolutePath='',name=directory.name},{request=nativeRequest}={}){
  const result=await proveFolder({directory,absolutePath,name},request,'folder-verify');
  if(!/^[a-f0-9]{32}$/.test(result.binding)||typeof result.path!=='string')throw new Error('Windows did not verify the connected folder.');
  return {directory,absolutePath:result.path,nativeBinding:result.binding};
}
async function proveFolder({directory,absolutePath,name},request,op){
  // Opening/copying a location must never request browser permission or pick a
  // directory. Connection setup owns those explicit user actions.
  if(await directory.queryPermission?.({mode:'readwrite'})!=='granted')throw new Error('Use Connect working folder to restore access to this project.');
  const selected=await readDataDirectory(directory);if(!selected)throw new Error('Connect this project’s working folder first.');const privateFolder=selected.directory;
  const ownerFile=await(await privateFolder.getFileHandle('OWNER.json')).getFile();
  if(ownerFile.size>1024)throw new Error('This folder does not have a valid ScoreBrush connection. Reconnect it first.');
  const owner=JSON.parse(await ownerFile.text());
  if(owner?.schema!=='private-score-desk-folder'||owner.version!==1)throw new Error('This folder does not have a valid ScoreBrush connection. Reconnect it first.');
  const challenge=await request('folder-challenge');
  validChallenge(challenge);
  const {marker,proof,token}=challenge;
  return withProof(privateFolder,challenge,async()=>{
    const result=await request(op,{token,marker,proof,path:absolutePath,name,dataDirectory:selected.name});
    if(['folder-open','folder-versions','folder-latest'].includes(op)&&!result.cancelled&&(!result.opened||typeof result.path!=='string'))throw new Error('Windows did not confirm opening the connected folder.');
    return result;
  });
}
