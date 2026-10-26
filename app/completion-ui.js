// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {prepareBackup} from './completion.js';
import {completionFindings} from './completion-model.js';
import {LIMITS} from './workflow.js';
import {isComment} from './model.js';
const $=id=>document.getElementById(id);
export function installCompletion(api){
  let job=null,urls=[],published=null;
  const io={prepare:async(scene,progress,maker,options)=>{
    const result=await prepareBackup(scene,progress,maker,options);
    const {addPortableHistory}=await import('./portable-history.js');
    try{return await addPortableHistory(result,scene,{...await api.folder?.portableHistory?.(),isCurrent:()=>api.matches(scene.stamp)&&!options?.signal?.aborted});}
    catch(error){if(error.name!=='RecoveryConflict')throw error;return {...result,warning:'Another tab changed the saved history during export. This ZIP protects the captured review only. Keep the original profile and export again after resolving the competing changes to transfer the full history.'};}
  },zip:api.zip,download:api.download};
  const status=text=>{$('finishStatus').textContent=text;};
  function clear(){for(const url of urls)URL.revokeObjectURL(url);urls=[];$('finishDownloads').replaceChildren();$('finishForm').hidden=false;$('finishIntro').hidden=false;$('finishOverview').hidden=false;$('finishTitle').textContent='Save backup';published=null;}
  function controls(){
    const busy=Boolean(job);$('prepareFinish').disabled=busy||Boolean(published);$('prepareFinish').hidden=busy||Boolean(published);$('closeFinish').disabled=busy;$('cancelFinish').hidden=!busy;
  }
  function overview(){
    const s=api.capture(),findings=completionFindings(s.review,s.returned),actions=findings.filter(f=>!isComment(f.region&&Object.hasOwn(f.region,'type')?f.region:f)),comments=findings.length-actions.length;
    $('finishRevision').textContent=`${s.files.ly.name} · ${s.files.rendered.name}`;
    $('finishOverview').textContent=`${actions.length} finding${actions.length===1?'':'s'} · ${actions.filter(f=>f.state!=='resolved').length} unresolved${comments?` · ${comments} ${comments===1?'comment':'comments'} logged`:''}. All are included.`;
  }
  function open(){
    if(api.status().busy||!api.capture().review)return;clear();overview();$('workspaceDialog').close();$('finishDialog').showModal();return prepare();
  }
  function cancel(){
    if(job){job.cancelled=true;job.controller.abort(new Error('Backup cancelled'));status('Cancelling backup preparation…');}
    else $('finishDialog').close();
  }
  $('finishReview').onclick=open;$('closeFinish').onclick=cancel;$('cancelFinish').onclick=cancel;
  $('finishDialog').addEventListener('cancel',e=>{if(job){e.preventDefault();cancel();}});
  $('finishDialog').addEventListener('close',()=>{if(job&&!$('finishDialog').open)cancel();});
  async function prepare(){
    if(job||api.status().busy||published)return;
    const thisJob=job={phase:'preparing',cancelled:false,controller:new AbortController()};clear();controls();status('Preparing backup…');
    const valid=scene=>{
      const cancelled=job!==thisJob||thisJob.cancelled||!$('finishDialog').open;
      const reason=job!==thisJob?'Operation replaced':thisJob.cancelled?'Preparation cancelled':!$('finishDialog').open?'Dialog closed':!api.matches(scene.stamp)?'Review changed during preparation':null;
      if(reason)throw Object.assign(new Error(reason),{cancelled});
    };
    try{await api.lock(async()=>{
      await api.flush();const scene=api.capture();valid(scene);overview();
      const {payloads,warning}=await io.prepare(scene,text=>status(text),api.packageMaker,{signal:thisJob.controller.signal});valid(scene);
      const zip=await io.zip(payloads,text=>status(text));valid(scene);
      if(zip.size>LIMITS.zip)throw new Error('Backup ZIP exceeds the 256 MB import limit.');
      const a=document.createElement('a'),url=URL.createObjectURL(zip);urls.push(url);a.href=url;a.download='scorebrush-backup.zip';a.textContent='Download backup ZIP';a.className='download';$('finishDownloads').append(a);published=scene.stamp;
      $('finishForm').hidden=true;$('finishIntro').hidden=true;$('finishTitle').textContent='Backup ready';$('finishDialog').scrollTop=0;
      status(warning||'Your files, findings, review decisions, and retained workspace history are included. Keep this ZIP to restore the workspace.');
      try{await io.download(zip,'scorebrush-backup.zip');}catch{status((warning?warning+' ':'')+'Backup ready. Use Download backup ZIP to save it.');}
    });api.clearMessage?.('completion');}
    catch(error){clear();if(error.cancelled||thisJob.cancelled){status('Backup cancelled. Your review is unchanged.');}else{status(`Backup failed: ${error.message} Your review is retained. Try again when ready.`);api.message($('finishStatus').textContent,true,'completion');}}
    finally{if(job===thisJob)job=null;controls();}
  }
  $('finishForm').onsubmit=e=>{e.preventDefault();void prepare();};
  document.addEventListener('score-desk-change',()=>{if(published&&!api.matches(published)){clear();status('Review changed. Create a new backup to include your latest edits.');controls();}});
  return {io,open,capture:api.capture,job:()=>job};
}
