// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// WebView2 lifecycle only. File operations remain on validated browser handles.
import {getSavedState} from './storage.js';
import {identify} from './model.js';
import {canonical} from './completion-model.js';

export function installDesktop(api,backup,shell){
  const bridge=window.chrome?.webview;if(!bridge)return;
  let token=null,running=null;
  const unlock=()=>{document.body.inert=false;token=null;};
  async function verifyLocal(){
    const scene=api.capture(),state=api.status();
    if(state.dirty||state.saveConflict)return false;
    if(!scene.review)return true;
    const record=await getSavedState(scene.workspaceId);
    if(!record||record.revisionId!==scene.revisionId||record.storageRevision!==scene.persistedRevision)return false;
    for(const field of ['review','returned','completions'])if(canonical(record[field]??(field==='completions'?[]:null))!==canonical(scene[field]??(field==='completions'?[]:null)))return false;
    const {snapshotId}=await identify(record.files);
    return snapshotId===scene.review.snapshotId&&api.matches(scene.stamp)&&!api.status().dirty;
  }
  async function prepare(){
    api.corrections.rememberView();
    let error='';
    const deadline=Date.now()+40000;
    while(Date.now()<deadline){const s=api.status(),f=api.folder.getState();if(!s.busy&&!s.exporting&&!s.recovering&&!f.busy)break;await new Promise(resolve=>setTimeout(resolve,100));}
    const state=api.status(),folder=api.folder.getState();
    if(state.busy||state.gesture||state.exporting||state.recovering||folder.busy)return {local:false,folder:false,idle:false,error:'An operation is still running. Let it finish, then retry closing.'};
    await api.saveNow();
    try{await (api.folder.saveCheckpoint?.()??api.folder.saveNow());}catch(e){error=e.message;}
    let local=false;try{local=await verifyLocal();}catch(e){error='Local save could not be verified: '+e.message;}
    const current=api.folder.getState(),after=api.status();
    const idle=!current.busy&&!after.busy&&!after.exporting&&!after.recovering&&!after.gesture;
    const savedFolder=!current.configured||current.ready;
    if(!error&&!savedFolder)error=current.error||current.pausedReason||'Folder saving is unfinished. Reconnect its permissions or retry saving.';
    if(!local)error='The current review has not been verified in local storage. '+error;
    return {local,folder:savedFolder,idle,error:error.slice(0,2400)};
  }
  bridge.addEventListener('message',async event=>{
    const message=event.data;
    if(!message||Object.keys(message).length!==2||typeof message.token!=='string'||!/^[a-f0-9]{32}$/.test(message.token))return;
    if(message.op==='cancel-close'&&message.token===token){unlock();return;}
    if(message.op!=='prepare-close'||running)return;
    token=message.token;document.body.inert=true;
    running=prepare();
    try{const result=await running;if(token===message.token)bridge.postMessage({op:'close-result',token,...result});}
    catch(e){if(token===message.token)bridge.postMessage({op:'close-result',token,local:false,folder:false,idle:false,error:String(e.message).slice(0,2400)});}
    finally{running=null;}
  });
  window.scoreBrushDesktop=Object.freeze({backup:()=>{unlock();const s=api.status();if(s.dirty||s.saveConflict)document.getElementById('emergency').click();else backup();}});
  const ready=()=>{bridge.postMessage({op:'ready'});shell.refresh();};
  if(document.body.dataset.ready==='true')ready();else document.addEventListener('score-desk-ready',ready,{once:true});
  window.addEventListener('scorebrush-desktop-host',()=>{if(document.body.dataset.ready==='true')ready();});
}
