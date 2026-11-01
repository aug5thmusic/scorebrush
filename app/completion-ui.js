// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {prepareBackup} from './completion.js';
import {completionFindings} from './completion-model.js';
import {validateExportPayloads,validateExportZip} from './package-limits.js';
import {isComment} from './model.js';
import {scoreNames,researchZipName} from './score-export-names.js';
import {getSavedState} from './storage.js';
import {retained} from './handoff-store.js';
const $=id=>document.getElementById(id);
export function installCompletion(api){
  let job=null,urls=[],published=null,research=false;
  const io={prepare:async(scene,progress,maker,options)=>{
    const result=await prepareBackup(scene,progress,maker,options);
    const {addPortableHistory}=await import('./portable-history.js');
    try{return await addPortableHistory(result,scene,{...await api.folder?.portableHistory?.(),isCurrent:()=>api.matches(scene.stamp)&&!options?.signal?.aborted});}
    catch(error){if(error.name!=='RecoveryConflict')throw error;return {...result,warning:'Another tab changed the saved history during export. This ZIP protects the captured review only. Keep the original profile and export again after resolving the competing changes to transfer the full history.'};}
  },zip:api.zip,download:api.download};
  const status=text=>{$('finishStatus').textContent=text;};
  function clear(){for(const url of urls)URL.revokeObjectURL(url);urls=[];$('finishDownloads').replaceChildren();$('finishForm').hidden=false;$('finishIntro').hidden=false;$('finishOverview').hidden=false;$('finishTitle').textContent=research?'Export research':'Save backup';published=null;}
  function controls(){
    const busy=Boolean(job);$('prepareFinish').disabled=busy||Boolean(published);$('prepareFinish').hidden=busy||Boolean(published);$('closeFinish').disabled=busy;$('cancelFinish').hidden=!busy;
  }
  async function namesFor(scene){
    const ancestors=[],seen=new Set();let id=scene.parentWorkspaceId;
    while(id&&!seen.has(id)&&ancestors.length<64){seen.add(id);const parent=await getSavedState(id);if(!parent||scene.projectId&&parent.projectId&&scene.projectId!==parent.projectId)break;ancestors.push(parent);id=parent.parentWorkspaceId;}
    if(scene.returned?.taskId){const task=await retained(scene.returned.taskId);if(task)ancestors.push(task);}
    const folder=api.folder?.getState?.();
    return scoreNames(scene,{ancestors,paths:folder?.bound?structuredClone(folder.paths):null});
  }
  function overview(s,resolved){
    const findings=completionFindings(s.review,s.returned),actions=findings.filter(f=>!isComment(f.region&&Object.hasOwn(f.region,'type')?f.region:f)),comments=findings.length-actions.length;
    $('finishRevision').textContent=`Source PDF: ${resolved.names.source} · Transcription PDF: ${resolved.names.rendered} · LilyPond: ${resolved.names.ly}`;
    $('finishOverview').textContent=`${actions.length} finding${actions.length===1?'':'s'} · ${actions.filter(f=>f.state!=='resolved').length} unresolved${comments?` · ${comments} ${comments===1?'comment':'comments'} logged`:''}. All are included.`;
  }
  function open(options={}){
    if(api.status().busy||!api.capture().review)return;research=options.research===true;clear();$('finishRevision').textContent='Preparing captured score files…';$('workspaceDialog').close();$('finishDialog').showModal();return prepare();
  }
  function cancel(){
    if(job){job.cancelled=true;job.controller.abort(new Error('Export cancelled'));status(research?'Cancelling research export…':'Cancelling backup preparation…');}
    else $('finishDialog').close();
  }
  $('finishReview').onclick=open;$('exportResearch').onclick=()=>open({research:true});$('closeFinish').onclick=cancel;$('cancelFinish').onclick=cancel;
  $('finishDialog').addEventListener('cancel',e=>{if(job){e.preventDefault();cancel();}});
  $('finishDialog').addEventListener('close',()=>{if(job&&!$('finishDialog').open)cancel();});
  async function prepare(){
    if(job||api.status().busy||published)return;
    const thisJob=job={phase:'preparing',cancelled:false,controller:new AbortController()};clear();controls();status(research?'Preparing research export…':'Preparing backup…');
    const valid=scene=>{
      const cancelled=job!==thisJob||thisJob.cancelled||!$('finishDialog').open;
      const reason=job!==thisJob?'Operation replaced':thisJob.cancelled?'Preparation cancelled':!$('finishDialog').open?'Dialog closed':!api.matches(scene.stamp)?'Review changed during preparation':null;
      if(reason)throw Object.assign(new Error(reason),{cancelled});
    };
    try{await api.lock(async()=>{
      await api.flush();const scene=api.capture();valid(scene);const resolved=await namesFor(scene);valid(scene);overview(scene,resolved);const downloadName=research?researchZipName(resolved,scene):'scorebrush-backup.zip';
      let result=await io.prepare(scene,text=>status(text),api.packageMaker,{signal:thisJob.controller.signal});valid(scene);
      if(research){const {prepareResearchExport}=await import('./research-export.js');result=await prepareResearchExport(result,{signal:thisJob.controller.signal,names:resolved.names});valid(scene);}
      const {payloads,warning}=result;
      validateExportPayloads(payloads,{research});
      const zip=await io.zip(payloads,text=>status(text),{research});valid(scene);
      validateExportZip(zip);
      const a=document.createElement('a'),url=URL.createObjectURL(zip);urls.push(url);a.href=url;a.download=downloadName;a.textContent=research?'Download research ZIP':'Download backup ZIP';a.className='download';$('finishDownloads').append(a);published=scene.stamp;
      $('finishForm').hidden=true;$('finishIntro').hidden=true;$('finishTitle').textContent=research?'Research export ready':'Backup ready';$('finishDialog').scrollTop=0;
      status(warning||(research?'Extract the ZIP to open the PDFs and LilyPond files in scores/current and scores/history. Python is optional for dataset processing. See README.txt.':'Your files, findings, review decisions, and retained workspace history are included. Keep this ZIP to restore the workspace.'));
      try{await io.download(zip,a.download);}catch{status((warning?warning+' ':'')+(research?'Research export ready. Use Download research ZIP to save it.':'Backup ready. Use Download backup ZIP to save it.'));}
    });api.clearMessage?.('completion');}
    catch(error){clear();if(error.cancelled||thisJob.cancelled){status((research?'Research export':'Backup')+' cancelled. Your review is unchanged.');}else{status(`${research?'Research export':'Backup'} failed: ${error.message} Your review is retained. Try again when ready.`);api.message($('finishStatus').textContent,true,'completion');}}
    finally{if(job===thisJob)job=null;controls();}
  }
  $('finishForm').onsubmit=e=>{e.preventDefault();void prepare();};
  document.addEventListener('score-desk-change',()=>{if(published&&!api.matches(published)){clear();status(research?'Review changed. Export again to include your latest edits.':'Review changed. Create a new backup to include your latest edits.');controls();}});
  return {io,open,capture:api.capture,job:()=>job};
}
