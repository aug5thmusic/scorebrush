// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Project entry points use the existing folder and backup validators. Recent
// entries carry saved handles/bindings; their displayed paths are never authority.
const $=id=>document.getElementById(id);

export function confirmProjectChoice(title,text,action){
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.id='projectChoiceDialog';
    const heading=document.createElement('h2');heading.id='projectChoiceTitle';heading.textContent=title;dialog.setAttribute('aria-labelledby',heading.id);
    const description=document.createElement('p');description.textContent=text;
    const actions=document.createElement('div');actions.className='action-row';
    const open=document.createElement('button');open.id='confirmProjectChoice';open.className='primary';open.textContent=action;
    const cancel=document.createElement('button');cancel.id='cancelProjectChoice';cancel.textContent='Cancel';
    const finish=value=>{dialog.close();dialog.remove();resolve(value);};
    open.onclick=()=>finish(true);cancel.onclick=()=>finish(false);dialog.addEventListener('cancel',e=>{e.preventDefault();finish(false);});
    actions.append(open,cancel);dialog.append(heading,description,actions);document.body.append(dialog);dialog.showModal();cancel.focus();
  });
}

export function installProjectEntries(api){
  const dialog=$('projectOpenDialog'),list=$('recentProjects');let generation=0;
  const close=()=>dialog.close();$('closeProjectOpen').onclick=close;
  dialog.addEventListener('close',()=>generation++);
  $('browseProjectFolder').onclick=()=>{close();void api.folder.choose({mode:'open'});};
  async function open(){
    if(api.status().busy||api.folder.getState().busy)return;
    $('workspaceDialog').close();list.textContent='Loading recent projects…';dialog.showModal();$('browseProjectFolder').focus();const token=++generation;
    try{
      const entries=await api.folder.io.listSettings();if(token!==generation||!dialog.open)return;
      entries.sort((a,b)=>(b.lastOpenedAt??0)-(a.lastOpenedAt??0));list.replaceChildren();
      if(!entries.length){list.textContent='No recent project folders yet.';return;}
      const seen=new Set();for(const entry of entries){
        if(entry.connectionId&&seen.has(entry.connectionId))continue;seen.add(entry.connectionId);
        const button=document.createElement('button');button.type='button';button.className='recent-project';
        const name=document.createElement('strong');name.textContent=entry.directory.name;
        const path=document.createElement('span');path.textContent=entry.absolutePath||[entry.paths.source,entry.paths.rendered,entry.paths.ly].join(' · ');
        button.append(name,path);button.onclick=()=>{close();void api.folder.choose({mode:'open',recent:entry});};list.append(button);
      }
    }catch{if(token===generation&&dialog.open)list.textContent='Recent projects could not be loaded. You can still choose a saved project folder.';}
  }
  function restore(){
    if(api.status().busy||api.folder.getState().busy)return;
    $('workspaceDialog').close();$('restoreBackupDialog').showModal();$('chooseRestoreBackup').focus();
  }
  $('closeRestoreBackup').onclick=()=>$('restoreBackupDialog').close();
  // A visible button keeps the file chooser on a real user gesture in WebView2
  // and in browsers, including when the native File menu opened this dialog.
  $('chooseRestoreBackup').onclick=()=>{$('restoreBackupDialog').close();$('openPackage').click();};
  return {open,restore};
}
