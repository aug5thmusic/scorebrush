// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Current status and unresolved problems only. No notification archive or storage.
export function installStatus(api){
  const $=id=>document.getElementById(id),panel=$('notices'),button=$('statusButton'),summary=$('statusSummary');
  const retryOpen=document.createElement('button');retryOpen.id='statusRetryOpenFolder';retryOpen.type='button';retryOpen.textContent='Retry opening folder';retryOpen.hidden=true;$('statusRetryLoad').after(retryOpen);
  const problems=new Map();let localProblem='',routine='',timer,acting=false;
  const isOpen=()=>panel.matches(':popover-open');
  function position(){
    if(!isOpen())return;const anchor=$('statusControl').getBoundingClientRect(),box=panel.getBoundingClientRect();
    panel.style.left=Math.max(12,Math.min(anchor.left+(anchor.width-box.width)/2,innerWidth-box.width-12))+'px';
    panel.style.top=Math.max(12,Math.min(anchor.bottom+8,innerHeight-box.height-12))+'px';
  }
  function open(){if(button.hidden||document.querySelector('dialog[open]')||api.status().gesture)return;if(!isOpen())panel.showPopover();button.setAttribute('aria-expanded','true');position();}
  function close(){const restore=panel.contains(document.activeElement);if(isOpen())panel.hidePopover();button.setAttribute('aria-expanded','false');if(restore)(button.hidden?summary:button).focus({preventScroll:true});}
  function expire(){clearTimeout(timer);if(!routine)return;timer=setTimeout(()=>{if(panel.contains(document.activeElement)){expire();return;}routine='';refresh();},3500);}
  function clearProblem(scope){if(problems.delete(scope))refresh();}
  function message(text,error=false,scope='operation'){
    // The former third boolean was a display override, never permission to
    // dismiss an unrelated unresolved failure.
    if(typeof scope!=='string'&&typeof scope!=='symbol')scope='operation';
    if(error){problems.set(scope,String(text));}else{routine=String(text);expire();}
    refresh();
  }
  function storage(text,problem=''){
    localProblem=problem;$('storage').textContent=text;$('storage').hidden=!text;
    $('storage').classList.toggle('unsaved',Boolean(problem));refresh();
  }
  function refresh(){
    const state=api.status(),folder=api.folder?.(),currentErrors=[...new Set(problems.values())].filter(text=>text!==localProblem);
    const folderWarnings=[folder?.error,folder?.pausedReason,folder?.recoveryWarning,folder?.loadError?folder.loadNotice:'',
      folder?.configured&&!folder.permission?'Reconnect the folder to save your latest corrections.':'',
      folder?.configured&&!folder.bound&&!folder.busy?'Choose the working folder for this review.':''].filter(Boolean);
    const folderAttention=folderWarnings.length>0;
    const warningTexts=[...new Set([localProblem,...currentErrors,...folderWarnings].filter(Boolean))];
    const attention=warningTexts.length>0;
    const routineText=attention&&!currentErrors.length?routine:'';
    const copy=[...currentErrors,...(routineText?[routineText]:[])].join('\n\n');
    if($('message').textContent!==copy)$('message').textContent=copy;
    $('message').hidden=!copy;$('message').dataset.error=String(currentErrors.length>0);
    if($('storageProblem').textContent!==localProblem)$('storageProblem').textContent=localProblem;
    $('storageProblem').hidden=!localProblem;
    $('folderStatus').classList.toggle('status-problem',folderAttention);
    $('notices').classList.toggle('error',attention);
    let label='No review open',status='idle';
    if(localProblem){label='Not saved';status='attention';}
    else if(attention){label=folder?.busy&&folder.progressText?folder.progressText:folder?.configured&&!folder.permission?'Reconnect folder':'Needs attention';status='attention';}
    else if(folder?.busy&&folder.progressText){label=folder.progressText;status='saving';}
    else if(folder?.nativeOpening){label='Checking folder…';status='saving';}
    else if(state.busy){label='Working…';status='saving';}
    else if(state.dirty){label='Saving locally…';status='saving';}
    else if(folder?.configured){label=folder.ready?'Saved to folder':folder.progressText||'Saving to folder…';status=folder.ready?'saved':'saving';}
    else if(state.snapshotId){label='Saved locally';status='saved';}
    if($('statusLabel').textContent!==label)$('statusLabel').textContent=label;
    $('statusControl').dataset.state=status;
    const resolveFocused=document.activeElement===button;
    button.hidden=!attention;
    button.setAttribute('aria-label',`Resolve: ${label}`);
    button.title='Show current warnings and recovery actions';
    summary.title=attention?warningTexts.join('\n'):[...new Set([label,folder?.configured?$('folderStatus').textContent:'',routine].filter(Boolean))].join('\n');
    if(!attention){close();if(resolveFocused)summary.focus({preventScroll:true});}
    const blocked=acting||state.busy;
    $('retrySave').hidden=!localProblem||state.saveConflict||!state.snapshotId;$('retrySave').disabled=blocked;
    $('statusReloadSaved').hidden=!state.saveConflict;$('statusReloadSaved').disabled=blocked||state.unprotected;
    $('statusReloadSaved').title=state.unprotected?'Download a recovery ZIP of your latest edits before reloading.':'Reload the newer saved review';
    $('statusRetryFolder').hidden=!folder?.configured||Boolean(folder.pausedReason)||!folder.bound||!(folder.error||!folder.permission);
    $('statusRetryFolder').textContent=folder?.permission?'Retry folder save':'Reconnect folder';$('statusRetryFolder').disabled=blocked||Boolean(folder?.busy);
    $('statusRetryLoad').hidden=!folder?.loadError||folder?.loadAction!=='load'||Boolean(folder.pausedReason)||!folder.bound;
    $('statusRetryLoad').disabled=blocked||Boolean(folder?.busy);
    retryOpen.hidden=!problems.has('native-folder')||!folder?.configured;retryOpen.disabled=blocked||Boolean(folder?.busy);
    $('statusChooseFolder').hidden=!(folder?.pausedReason||folder?.loadError&&folder.loadAction==='choose'||folder?.error&&!folder.configured||folder?.configured&&!folder.bound);
    $('statusChooseFolder').disabled=blocked||Boolean(folder?.busy);
    $('emergency').hidden=!state.snapshotId||!attention;$('emergency').disabled=blocked||Boolean(state.recovering);
    $('statusWorkspace').hidden=!attention;$('statusWorkspace').disabled=blocked;
    $('dismissMessage').disabled=false;
    // Warnings persist in the header; only Resolve opens their recovery actions.
    // Keep those actions out of the way while another modal is open.
    if(document.querySelector('dialog[open]')){if(isOpen())panel.hidePopover();}
    position();
  }
  async function act(scope,action){if(acting)return;const actionFocused=panel.contains(document.activeElement);acting=true;refresh();try{if(await action()!==false)clearProblem(scope);}catch(error){
    // Folder failures already have an owner and clear on a successful autosave.
    // Do not create a second warning that could outlive that recovery.
    if(!(scope.startsWith('folder-')&&(api.folder?.()?.error||api.folder?.()?.loadError)))message(error.message,true,scope);
  }finally{acting=false;refresh();
    // Disabling the recovery button can release focus before the panel closes.
    // Restore a keyboard anchor only when the user has not focused elsewhere.
    if(actionFocused&&button.hidden&&document.activeElement===document.body&&!document.querySelector('dialog[open]')&&!api.status().gesture)summary.focus({preventScroll:true});
  }}
  button.onclick=()=>isOpen()?close():open();$('dismissMessage').onclick=close;
  $('retrySave').onclick=()=>act('local-retry',()=>api.save());
  $('statusRetryFolder').onclick=()=>act('folder-retry',()=>api.retryFolder());
  $('statusRetryLoad').onclick=()=>act('folder-load',()=>api.loadLatest());
  retryOpen.onclick=()=>act('native-folder',()=>api.openFolder());
  $('statusChooseFolder').onclick=()=>act('folder-choose',()=>api.chooseFolder());
  $('statusReloadSaved').onclick=()=>act('review-reload',()=>api.reload());
  $('statusWorkspace').onclick=()=>{close();api.workspace();};
  panel.addEventListener('toggle',()=>{button.setAttribute('aria-expanded',String(isOpen()));if(isOpen())position();});
  panel.addEventListener('focusout',()=>{if(routine)expire();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&isOpen()){event.preventDefault();event.stopImmediatePropagation();close();}},true);
  document.addEventListener('score-desk-folder-status',refresh);
  document.addEventListener('score-desk-controls',position);
  new MutationObserver(refresh).observe(document.body,{attributes:true,attributeFilter:['open'],subtree:true});
  window.addEventListener('resize',position);
  return {message,storage,refresh,clearProblem,close,open};
}
