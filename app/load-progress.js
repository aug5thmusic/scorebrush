// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// A task-owned modal for an explicit, blocking score load. Routine autosaves
// never open it, and the indeterminate bar makes no overall-percent claim.
export function installLoadProgress({refreshControls=()=>{}}={}){
  const dialog=document.createElement('dialog');dialog.id='loadProgressDialog';dialog.className='load-progress';
  dialog.setAttribute('aria-labelledby','loadProgressTitle');dialog.setAttribute('aria-describedby','loadProgressPhase loadProgressDetail');
  const title=document.createElement('h2');title.id='loadProgressTitle';title.tabIndex=-1;
  const phase=document.createElement('p');phase.id='loadProgressPhase';phase.setAttribute('role','status');phase.setAttribute('aria-live','polite');phase.setAttribute('aria-atomic','true');
  const bar=document.createElement('progress');bar.id='loadProgressBar';bar.setAttribute('aria-label','Loading the updated score');
  const detail=document.createElement('p');detail.id='loadProgressDetail';
  const close=document.createElement('button');close.id='closeLoadProgress';close.type='button';close.className='primary';close.textContent='Close';
  dialog.append(title,phase,bar,detail,close);document.body.append(dialog);
  let active=false,returnFocus=null;
  const focusable=element=>element?.isConnected&&!element.disabled&&!element.closest('[hidden]')&&element.getClientRects().length;
  close.onclick=()=>{if(!active)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(active)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    active=false;refreshControls();
    const underlying=document.querySelector('dialog[open]');
    if(focusable(returnFocus)&&(!underlying||underlying.contains(returnFocus)))returnFocus.focus({preventScroll:true});
    else if(!underlying){const target=document.getElementById('newFinding');if(focusable(target))target.focus({preventScroll:true});}
    returnFocus=null;
  });
  return {
    async begin(){
      if(!dialog.open)returnFocus=document.activeElement;active=true;dialog.dataset.state='loading';dialog.setAttribute('aria-busy','true');
      title.textContent='Loading latest score';phase.textContent='Saving your current review…';detail.textContent='Your score will appear when it’s ready.';bar.hidden=false;close.hidden=true;
      if(!dialog.open)dialog.showModal();title.focus({preventScroll:true});refreshControls();
      // Give the modal a paint opportunity before hashing/rendering starts.
      // A background/minimized window must not stall the operation on rAF.
      await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve();};const timer=setTimeout(finish,150);requestAnimationFrame(()=>requestAnimationFrame(finish));});
    },
    phase(text){if(active&&phase.textContent!==text)phase.textContent=text;},
    fail(message){active=false;dialog.dataset.state='error';dialog.setAttribute('aria-busy','false');title.textContent='Couldn’t finish loading';phase.textContent='The latest score needs attention.';detail.textContent=String(message||'The score could not be loaded.');bar.hidden=true;close.hidden=false;close.focus({preventScroll:true});},
    finish(){active=false;if(dialog.open)dialog.close();},
    get active(){return active;}
  };
}
