// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {clone,sha256,findingType,findingTypeLabel,isComment} from './model.js';
import {makeRecovery} from './export.js';
import {readPackage,makeTask,readResponse,acceptResponse,taskFindings,contextPaths,localTaskDelivery,retainPortableTask} from './workflow.js';
import {installReturned} from './returned-ui.js';
import {restoreReturnedBackup} from './returned.js';
import {retain,retained,retainedList} from './handoff-store.js';
import {saveTaskFolder,readResponseFolder} from './folder-io.js';
const $=id=>document.getElementById(id);
export function installHandoff(api){
  let job=false,resolving=false,pending=null,shown=null,links=[],prompt='',issuedStamp=null;
  const io={readPackage,makeTask,readResponse,readResponseFolder,acceptResponse,retain,saveTaskFolder,pickDirectory:typeof window.showDirectoryPicker==='function'?()=>window.showDirectoryPicker({mode:'readwrite'}):null};
  const responseChoices=document.createElement('div');responseChoices.id='responseImportChoices';responseChoices.hidden=true;
  const folderChoice=document.createElement('button');folderChoice.id='openResponseFolder';folderChoice.className='primary';folderChoice.textContent='Open response folder';
  const zipChoice=document.createElement('button');zipChoice.id='openResponseZip';zipChoice.textContent='Open response ZIP';
  const choiceNote=document.createElement('p');choiceNote.textContent='For a packaged AI response, select the folder containing response.json and its corrected files, or its ZIP. To load ordinary LilyPond and PDF files from your working folder, use Load latest instead.';
  const responseActions=document.createElement('div');responseActions.className='action-row';responseActions.append(folderChoice,zipChoice);responseChoices.append(responseActions,choiceNote);$('responsePreview').before(responseChoices);
  const folderInput=document.createElement('input');folderInput.id='responseFolderFile';folderInput.type='file';folderInput.multiple=true;folderInput.setAttribute('webkitdirectory','');folderInput.hidden=true;document.body.append(folderInput);
  const status=(text,error=false,scope='handoff')=>{$('handoffStatus').textContent=text;api.message(text,error,scope);};
  const cancelled=text=>Object.assign(new Error(text),{cancelled:true});
  const guarded=(scope,action)=>async(...args)=>{try{const result=await action(...args);if(result!==false)api.clearMessage?.(scope);return result;}catch(e){if(e.cancelled){status(e.message);return false;}console.error(e);status(e.message,true,scope);return false;}};
  const canResolve=response=>response.code.status==='unchanged'||response.rendering.status==='supplied';
  function resolutionControls(response){for(const button of $('responsePreview').querySelectorAll('[data-resolve-finding]'))button.disabled=resolving||!canResolve(response);}
  const clear=()=>{for(const url of links)URL.revokeObjectURL(url);links=[];$('handoffDownloads').replaceChildren();};
  function downloadLink(blob,name,label=name,parent=$('handoffDownloads')){const a=document.createElement('a'),url=URL.createObjectURL(blob);links.push(url);a.href=url;a.download=name.replaceAll('/','__');a.textContent=label;a.className='download';parent.append(a);return a;}
  function taskDownloads(entry,zip){
    const save=document.createElement('button');save.id='saveTaskFolder';save.className='primary';save.textContent='Save task to folder';save.disabled=!io.pickDirectory;
    const folderStatus=document.createElement('p');folderStatus.id='folderHandoffStatus';folderStatus.setAttribute('role','status');
    folderStatus.textContent=io.pickDirectory?'Choose a parent folder. A new task folder is created without replacing existing files.':'This browser cannot save a folder directly. Download the task ZIP and extract it into a new folder, or open this app in Chrome or Edge.';
    const token=generation;save.onclick=guarded('handoff-folder',async()=>{
      if(job||!io.pickDirectory)return false;job=true;save.disabled=true;$('closeHandoff').disabled=true;let picking=true;
      try{
        const parent=await io.pickDirectory();picking=false;
        if(generation!==token||issuedStamp&&!api.matches(issuedStamp))throw new Error('The task changed while choosing a folder. Export the current task again.');
        const saved=await api.lock(()=>io.saveTaskFolder(parent,entry,{progress:text=>{folderStatus.textContent=text;}}));
        folderStatus.textContent=`Saved ${saved.fileCount} files in ${saved.parentName}/${saved.name}. Point your AI at this folder and ask it to read PROMPT.txt. Keep the originals and write returned files in response/.`;
        status('Task folder saved. The same task is retained in local history.');
      }catch(error){if(picking&&error.name==='AbortError'){folderStatus.textContent='Folder selection cancelled. Your task is still saved locally.';return false;}else throw error;}
      finally{job=false;save.disabled=!io.pickDirectory;$('closeHandoff').disabled=false;}
    });
    const actions=document.createElement('div');actions.className='action-row';actions.append(save);
    downloadLink(zip,'scorebrush-ai-task.zip','Download ZIP instead',actions).classList.add('task-download');
    $('handoffDownloads').append(actions,folderStatus);
    const note=document.createElement('p');note.textContent='Point a local AI at the task folder, or attach its ZIP in a chat. The copied prompt explains both return options. This app does not contact an AI service.';$('handoffDownloads').append(note);
  }
  function show(task=false){responseChoices.hidden=true;$('workspaceDialog').close();$('taskInstructions').hidden=!task;$('handoffIntro').hidden=task;if(!$('handoffDialog').open)$('handoffDialog').showModal();}
  const close=()=>{if(!job)$('handoffDialog').close();};$('closeHandoff').onclick=close;
  $('handoffDialog').addEventListener('cancel',e=>{if(job){e.preventDefault();status('Preparing files. Editing stays blocked until this operation finishes.');}});
  // A closed dialog invalidates a running job, even if closed programmatically.
  let generation=0;$('handoffDialog').addEventListener('close',()=>{generation++;});
  async function history(options){
    try{
    const entries=await retainedList(options),names=new Map(entries.filter(e=>e.kind==='task').map(e=>[e.id,e.review.files.ly.name]));
    $('handoffHistory').hidden=entries.length===0;$('inspectHandoff').hidden=entries.length===0;$('handoffEmpty').hidden=entries.length!==0;
    $('handoffEmpty').textContent='No saved tasks, responses or reviews yet.';
    $('handoffHistory').replaceChildren(new Option('Choose a saved task, response, or review…',''));
    for(const e of entries){const name=e.kind==='task'?e.review.files.ly.name:e.kind==='review-backup'?e.review.files.rendered.name:names.get(e.taskId)??'AI response',kind=e.kind==='response'?(e.parentRevisionId?'Saved review':e.renderingStatus==='pending'?'AI response · PDF pending':'AI response'):{task:'AI task','review-backup':'Review backup','render-attachment':'Attached PDF'}[e.kind]??'Saved review';$('handoffHistory').add(new Option(`${kind} · ${name} · ${new Date(e.createdAt).toLocaleString()}`,e.id));}
    api.clearMessage?.('handoff-history');
    }catch(e){$('handoffEmpty').textContent='Saved history could not be loaded.';status('Handoff history is unavailable: '+e.message,true,'handoff-history');return false;}
  }
  $('openPackage').onclick=()=>$('packageFile').click();
  $('packageFile').onchange=guarded('handoff-package',async e=>{const file=e.target.files[0];e.target.value='';if(!file||api.status().busy)return false;if(/\.json$/i.test(file.name)){await api.importAnnotations(file);return;}const captured=api.capture().stamp;status('Checking package files…');
    const parsed=await api.lock(()=>io.readPackage(file,api.inspectPdf));if(!api.matches(captured))throw new Error('The review changed while checking this package. Open it again when ready.');
    // An original task ZIP carries the immutable baseline needed in a fresh
    // browser. Validate every byte before retaining it; never replace an ID.
    if(parsed.payloads.has('task.json'))await api.lock(()=>retainPortableTask(file,api.inspectPdf,{lookup:retained,write:io.retain}));
    const restored=await restoreReturnedBackup(parsed,api.inspectPdf);
    if(parsed.payloads.has('workspace-transfer.json')){
      const {importPortableHistory}=await import('./portable-history.js');
      const id=await api.lock(async()=>{await api.flush();return importPortableHistory(parsed,api.inspectPdf,restored?.seed.returned??null);});
      if(!api.matches(captured))throw new Error('The review changed during transfer. Imported work is retained; reopen it under Files & backups → Locally saved reviews & history.');
      await api.openSaved(id,{force:true});await history();return;
    }
    if(restored&&window.chrome?.webview){
      // Legacy ZIPs have no full journal, but their original round identity and
      // decisions still transfer exactly. Refuse a divergent existing head.
      const original=JSON.parse(await parsed.payloads.get('returned-workspace.json').text()).returned;
      const {getSaved}=await import('./storage.js'),{canonical}=await import('./completion-model.js');
      const existing=await getSaved(original.id);
      if(existing&&(canonical(existing.returned)!==canonical(original)||canonical(existing.review.findings)!==canonical(parsed.review.findings)||parsed.completionBundle?.revisionId&&existing.revisionId!==parsed.completionBundle.revisionId))throw new Error('This legacy backup conflicts with an existing desktop review. Neither was replaced. Keep both backups and use a separate browser profile to compare them.');
      restored.seed.returned=original;
    }
    if(restored){for(const entry of [restored.issued,restored.entry]){const existing=await retained(entry.id),path=entry.kind==='task'?'task.json':'response.json';if(existing&&(JSON.stringify(existing.task?.baseline??existing.baseline)!==JSON.stringify(entry.task?.baseline??entry.baseline)||await sha256(await existing.payloads.get(path).arrayBuffer())!==await sha256(await entry.payloads.get(path).arrayBuffer())))throw new Error('Retained task or response identity conflicts with this recovery.');if(!existing)await io.retain(entry);}await api.openReturned(restored.seed);}
    else await api.openImported(parsed);await history();
  });
  $('exportTask').onclick=guarded('handoff-task',async()=>{
    if(!api.capture().review||api.status().busy)return false;
    show(true);clear();$('responsePreview').replaceChildren();$('acceptResponse').hidden=true;$('handoffTitle').textContent='Send to AI';$('promptFallback').hidden=true;
    const s=api.capture(),token=++generation;job=true;$('closeHandoff').disabled=true;status('Preparing the exact baseline and visual context…');
    try{await api.lock(async()=>{
      const prepared=api.corrections.summaryTask?.(),entry=prepared??(s.returned?await returnedUI.io.followupTask(s,'120',text=>status(text),api.packageMaker):await io.makeTask(s.review,s.files,s.doc,'120',text=>status(text),api.packageMaker)),zip=await api.zip(entry.payloads,text=>status(text));
      if(generation!==token)throw cancelled('Task export cancelled. Your review is retained.');
      if(!api.matches(s.stamp))throw new Error('The review changed during task export. Export again.');
      // Retain before publishing: a response must have an issued baseline here.
      if(!prepared)await io.retain(entry);if(generation!==token)throw cancelled('Task retained as historical; export was cancelled.');if(!api.matches(s.stamp))throw new Error('Task retained as historical; the review changed. Export again.');
      const text=await entry.payloads.get('PROMPT.txt').text();if(generation!==token)throw cancelled('Task retained as historical; export was cancelled.');if(!api.matches(s.stamp))throw new Error('Task retained as historical; the review changed. Export again.');
      issuedStamp=s.stamp;prompt=text;$('aiPrompt').value=prompt;$('promptFallback').hidden=false;
      taskDownloads(entry,zip);
      const comments=entry.task.findings.filter(isComment).length;
      status(`AI task ready · ${entry.review.files.ly.name} · ${entry.task.findings.length-comments} findings${comments?` · ${comments} comments logged`:''}. Exact baseline retained locally.`);
    });await history();}catch(e){clear();prompt='';$('promptFallback').hidden=true;throw e;}
    finally{job=false;$('closeHandoff').disabled=false;}
  });
  $('copyPrompt').onclick=guarded('handoff-copy',async()=>{
    if(!prompt){status('Choose Send to AI first, or open a saved task.');return false;}
    show(true);$('aiPrompt').value=prompt;$('promptFallback').hidden=false;
    try{await navigator.clipboard.writeText(prompt);status('Prompt copied. Selectable text is also shown below.');}catch{status('Clipboard is unavailable. Select and copy the complete prompt below.');$('aiPrompt').focus();$('aiPrompt').select();}
  });
  $('importResponse').onclick=()=>{if(api.status().busy)return;clear();$('responsePreview').replaceChildren();$('acceptResponse').hidden=true;$('promptFallback').hidden=true;$('handoffTitle').textContent='Import packaged AI response';show();responseChoices.hidden=false;status('Choose the returned response folder or ZIP.');};
  folderChoice.onclick=()=>folderInput.click();zipChoice.onclick=()=>$('responseFile').click();
  async function previewResponse(read){
    if(api.status().busy)return false;status('Checking AI response against its issued task…');
    const parsed=await api.lock(async()=>{const next=await read();if(next.response.rendering.status==='supplied')await api.inspectPdf({source:next.issued.files.source,rendered:{blob:next.payloads.get(next.response.rendering.path)}});return next;});
    pending=parsed;shown=null;clear();$('promptFallback').hidden=true;$('handoffTitle').textContent='Preview AI response';show();renderResponse(parsed,null);$('acceptResponse').hidden=false;
    status('Response validated. Review the proposal below, then Accept as a retained revision. Your current review will stay open.');
  }
  $('responseFile').onchange=guarded('handoff-response',async e=>{const file=e.target.files[0];e.target.value='';return file?previewResponse(()=>io.readResponse(file)):false;});
  folderInput.onchange=guarded('handoff-response',async e=>{const files=Array.from(e.target.files);e.target.value='';return files.length?previewResponse(()=>io.readResponseFolder(files)):false;});
  function renderResponse(parsed,entry){
    const {issued,response,payloads}=parsed,root=$('responsePreview');root.replaceChildren();
    const p=document.createElement('p');p.className='response-banner';p.textContent=response.code.status==='changed'&&response.rendering.status==='pending'?'Code changes received — updated rendering pending.':response.rendering.status==='supplied'?'Updated rendering ready to review.':'No code changes received.';root.append(p);
    const note=document.createElement('p');note.textContent=`Response for ${issued.review.files.ly.name}. Original marks are shown on the previous rendering.`;root.append(note);
    downloadLink(issued.files.rendered.blob,'previous-rendering.pdf','Previous rendering with original findings',root);
    downloadLink(issued.files.source.blob,'original-printed-source.pdf','Original printed source',root);
    downloadLink(response.code.status==='changed'?payloads.get(response.code.path):issued.files.ly.blob,'proposed.ly',response.code.status==='changed'?'Proposed LilyPond — rendering '+response.rendering.status:'Unchanged baseline LilyPond',root);
    if(response.rendering.status==='supplied')downloadLink(payloads.get(response.rendering.path),'proposed-rendering.pdf','Updated PDF from '+response.rendering.producer,root);
    if(entry){const actions=document.createElement('div'),open=document.createElement('button'),attach=document.createElement('button');actions.className='action-row';open.id='reviewReturned';open.className='primary';open.textContent='Review this returned revision';open.dataset.handoffAction='';open.onclick=guarded('returned-open',()=>returnedUI.open(entry));attach.id='attachUpdated';attach.textContent='Attach updated rendering';attach.dataset.handoffAction='';attach.onclick=()=>returnedUI.attach(entry);actions.append(open,attach);root.append(actions);}
    for(const f of taskFindings(issued)){const result=response.results.find(r=>r.id===f.id),card=document.createElement('article');card.className='response-finding';card.dataset.findingType=findingType(f);const title=document.createElement('h3');title.textContent=`${isComment(f)?'Comment ':findingType(f)==='source_footnote'?'Footnote ':''}#${f.number} · ${f.page==null?'current passage not located':'previous rendered page '+f.page}`;card.append(title);
      for(const text of [`${findingTypeLabel(f)}: ${f.comment}`,`Agent: ${result.status.replaceAll('_',' ')} — ${result.explanation}`,result.codeLocation?`Code location: ${result.codeLocation}`:''])if(text){const p=document.createElement('p');p.textContent=text;card.append(p);}
      const state=entry?.findings.find(item=>item.id===f.id)?.state??({changed:'corrected_pending_review',unchanged_with_reason:'open',needs_clarification:'needs_source_clarification',unreviewed:'open'})[result.status];const label=document.createElement('strong');label.textContent=isComment(f)?'Logged · no correction approval needed':'Review state: '+state.replaceAll('_',' ');card.append(label);
      const paths=contextPaths(issued,f);for(const [i,type]of ['marked','clean'].entries()){const blob=issued.payloads.get(paths[i]);if(blob){const img=document.createElement('img'),caption=document.createElement('p'),url=URL.createObjectURL(blob);links.push(url);img.src=url;img.alt=`Original ${type} context for finding ${f.number}`;caption.textContent=img.alt;card.append(caption,img);}}
      if(entry&&!isComment(f)&&state!=='resolved'){const approve=document.createElement('button');approve.textContent='Human: resolve finding after visual review';approve.dataset.resolveFinding=f.id;approve.disabled=resolving||!canResolve(response);approve.title=!canResolve(response)?'Code changed and updated rendering is pending; visual approval is unavailable.':'';
        approve.onclick=guarded('handoff-decision',()=>resolveFinding(parsed,entry,f.id));const actions=document.createElement('div');actions.className='action-row';actions.append(approve);card.append(actions);}
      root.append(card);
    }
    $('handoffDialog').scrollTop=0;
  }
  async function resolveFinding(parsed,entry,id){
    // Single-flight, set before any await. A detached/stale button must not
    // branch from an earlier displayed revision after a successful decision.
    if(job||api.status().busy||shown?.id!==entry.id||!canResolve(parsed.response)||isComment(taskFindings(parsed.issued).find(f=>f.id===id)))return false;
    job=true;resolving=true;resolutionControls(parsed.response);$('closeHandoff').disabled=true;$('responsePreview').setAttribute('aria-busy','true');
    try{await api.lock(async()=>{
      const next=clone(shown);next.id=crypto.randomUUID();next.createdAt=new Date().toISOString();next.parentRevisionId=shown.id;next.findings.find(item=>item.id===id).state='resolved';
      status('Saving human review decision…');await io.retain(next);shown=next;clear();renderResponse(parsed,next);await history();status('Human decision saved.');
    });}
    finally{job=false;resolving=false;resolutionControls(parsed.response);$('closeHandoff').disabled=false;$('responsePreview').setAttribute('aria-busy','false');}
  }
  $('acceptResponse').onclick=guarded('handoff-accept',async()=>{
    if(!pending||job)return false;job=true;$('acceptResponse').disabled=true;$('closeHandoff').disabled=true;
    try{const entry=await api.lock(()=>io.acceptResponse(pending));shown=entry;$('acceptResponse').hidden=true;clear();renderResponse(pending,entry);await history();status('Accepted and saved for review.');}
    finally{job=false;$('acceptResponse').disabled=false;$('closeHandoff').disabled=false;}
  });
  $('inspectHandoff').onclick=guarded('handoff-inspect',async()=>{const entry=await retained($('handoffHistory').value);if(!entry)return false;clear();$('responsePreview').replaceChildren();$('acceptResponse').hidden=true;$('promptFallback').hidden=true;show(entry.kind==='task');
    if(entry.kind==='task'){const delivery=await localTaskDelivery(entry);prompt=delivery.prompt;issuedStamp=null;$('handoffTitle').textContent='Saved AI task';$('aiPrompt').value=prompt;$('promptFallback').hidden=false;taskDownloads(delivery,await api.zip(delivery.payloads));}
    else if(entry.kind==='response'){const issued=await retained(entry.taskId);pending={issued,response:entry.response,payloads:entry.payloads};shown=entry;$('handoffTitle').textContent='Saved AI response';renderResponse(pending,entry);}
    else if(entry.kind==='render-attachment'){const responseEntry=await retained(entry.responseId);shown=responseEntry;$('handoffTitle').textContent='Saved rendering';await returnedUI.open(responseEntry,entry);}
    else{ $('handoffTitle').textContent='Saved review';const payloads=await makeRecovery(entry.review,entry.files);downloadLink(await api.zip(payloads),'prior-review-recovery.zip','Download review backup');}
    status('Saved item opened. Your current workspace is unchanged.');
  });
  // Invalidate generated downloads as soon as the visible review changes.
  document.addEventListener('score-desk-change',()=>{if(issuedStamp&&!api.matches(issuedStamp)){clear();issuedStamp=null;prompt='';$('aiPrompt').value='';$('promptFallback').hidden=true;status('Review changed. The issued task remains in history; export a new task for the latest findings.');}});
  const returnedUI=installReturned(api,{getShown:()=>shown,close,refresh:history});
  history({existingOnly:true});
  return {io,history,returnedUI};
}
