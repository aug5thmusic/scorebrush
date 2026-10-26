// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {reviewRound,automaticRoundOutcome} from './round-model.js';
import {taskForScene} from './folder-workspace.js';
import {retain} from './handoff-store.js';
const $=id=>document.getElementById(id);
const element=(tag,text,id)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(id)el.id=id;return el;};
const keyOf=s=>JSON.stringify([s.workspaceId,s.revisionId,s.review?.snapshotId]);
const roundKey=s=>JSON.stringify([s.workspaceId,s.returned?.id,s.review?.snapshotId,s.review?.files.ly.sha256,s.review?.files.rendered.sha256]);
const outcomeKey=(scene,state)=>JSON.stringify([roundKey(scene),state]);
const seenKey='score-desk-completion-dialog-seen-v1';

export function installRoundSummary(api){
  const root=element('dialog',null,'roundSummary');root.className='round-summary';root.setAttribute('aria-labelledby','roundSummaryTitle');root.setAttribute('aria-describedby','roundSummaryText');
  const title=element('h2',null,'roundSummaryTitle');title.tabIndex=-1;
  const text=element('p',null,'roundSummaryText'),status=element('p',null,'roundSummaryStatus');status.setAttribute('role','status');
  const content=element('div',null,'roundSummaryContent');content.append(title,text,status);
  const prompt=element('textarea',null,'nextAIPrompt');prompt.readOnly=true;prompt.rows=10;prompt.setAttribute('aria-label','Complete next AI prompt');
  const promptArea=element('div',null,'roundSummaryPrompt');promptArea.append(prompt);
  let key=null,manual=null,manualFailed=false,working=false,checking=false,checkKey=null,checked=null,feedback='',returnFocus=null,pendingCompletion=null,autoTimer=null,protectedUntil=0;
  let seen=new Set();try{const saved=JSON.parse(localStorage.getItem(seenKey));if(Array.isArray(saved))seen=new Set(saved.filter(s=>typeof s==='string').slice(-200));}catch{}
  const keys=new Set(),pointers=new Set();
  const localSaved=()=>{const s=api.status();return !s.dirty&&!s.saveConflict&&!s.saveFailed&&!s.unprotected&&s.persistedRevision!=null;};
  const connected=()=>{const f=api.folder?.getState();return f?.configured&&f.bound?f:null;};
  // Approval is durable when its local CAS succeeds. Folder publication is a
  // separate background operation and must not delay that acknowledgement.
  const completionSaved=localSaved;
  const visible=()=>root.open;
  function rememberShown(scene,state){seen.add(outcomeKey(scene,state));seen=new Set([...seen].slice(-200));try{localStorage.setItem(seenKey,JSON.stringify([...seen]));}catch{/* Presentation preference only; saving reviews is independent. */}}
  const alreadyShown=(scene,state)=>seen.has(outcomeKey(scene,state))||state==='resolved'&&seen.has(roundKey(scene)); // Existing completion preferences remain valid.
  function hide(){if(root.open)root.close();}
  function action(label,id,run){const b=element('button',label,id);b.type='button';b.onclick=async event=>{if(b.disabled||performance.now()<protectedUntil||event.detail>1)return;feedback='';try{await run();api.clearMessage?.('round-summary');}catch(e){feedback=id==='summaryFolderFiles'?'The working folder could not be opened. Try connecting it again.':e.message||'The operation could not be completed. Try again.';api.message(e.message,true,'round-summary');}finally{update();}};return b;}
  const resume=action('Review remaining','reviewUnchecked',async()=>{const s=api.capture(),id=reviewRound(s.review,s.returned).unchecked[0];hide();if(id)await api.corrections.selectFinding(id);});
  const copy=action('Copy prompt','sendRemaining',async()=>{
    update();const scene=api.capture(),saved=connected()?api.folder.savedPrompt():manual;
    if(reviewRound(scene.review,scene.returned).state!=='outstanding'||!localSaved()||!saved||saved.text!==prompt.value)return;
    try{await navigator.clipboard.writeText(saved.text);if(keyOf(api.capture())===keyOf(scene))feedback='Prompt copied.';}
    catch{prompt.focus();prompt.select();feedback='Select and copy the prompt below.';}
  });
  const prepareFolder=action('Prepare prompt','prepareRoundPrompt',async()=>{working=true;update();try{await api.folder.saveNow();}finally{working=false;}});
  const openFolder=action('Open finished PDF folder','summaryFolderFiles',async()=>{working=true;update();try{await api.folder.openFinished();}finally{working=false;await checkPDF(true);}});
  const retry=action('Retry saving','retryRoundSave',async()=>{
    if(api.status().saveConflict||connected()?.pausedReason||connected()?.loadError){hide();$('statusButton').click();return;}
    working=true;update();try{await api.flush();if(connected()){if(reviewRound(api.capture().review,api.capture().returned).state==='outstanding')await api.folder.saveNow();else await api.folder.saveCheckpoint({refreshOutput:true});}manualFailed=false;}finally{working=false;}
    if(!connected())await preparePrompt();else await checkPDF(true);
  });
  const connect=action('Connect working folder','connectRoundFolder',async()=>{working=true;update();try{await api.folder.reconnect();}finally{working=false;await checkPDF(true);}});
  const reload=action('Retry loading','retryRoundLoad',async()=>{working=true;update();try{await api.folder.loadLatest();}finally{working=false;}});
  const files=action('Files & backups','summaryFiles',()=>{hide();$('workspaceTools').click();});
  const dismiss=action('Close','dismissRoundSummary',hide);
  const actions=element('div');actions.className='action-row round-primary-actions';actions.append(resume,copy,prepareFolder,openFolder,retry,connect,reload,files,dismiss);
  actions.append(promptArea);root.append(content,actions);document.body.append(root);
  root.addEventListener('close',()=>{pendingCompletion=null;api.refreshControls?.();if(returnFocus?.isConnected&&!returnFocus.closest('[hidden]'))returnFocus.focus({preventScroll:true});});
  root.addEventListener('cancel',event=>{if(performance.now()<protectedUntil)event.preventDefault();});
  root.addEventListener('keydown',event=>{if(event.repeat||performance.now()<protectedUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
  function clear(){manual=null;manualFailed=false;checked=null;checkKey=null;feedback='';}
  function identityKey(scene,folder){return JSON.stringify([keyOf(scene),folder?.connectionId,folder?.nativeBinding,folder?.absolutePath,folder?.recoveryId,folder?.generation,folder?.permission]);}
  async function checkPDF(force=false){
    const scene=api.capture(),folder=connected();if(!visible()||!scene.returned||!folder||!folder.ready||folder.busy||!localSaved()||reviewRound(scene.review,scene.returned).state!=='resolved')return;
    const token=identityKey(scene,folder);if(checking||!force&&token===checkKey)return;
    checking=true;checkKey=token;checked=null;update();
    try{const result=await api.folder.checkFinishedPDF();if(identityKey(api.capture(),connected())===token)checked=result;}
    catch{if(identityKey(api.capture(),connected())===token)checked={state:'unavailable'};}
    finally{checking=false;update();}
  }
  async function preparePrompt(){
    const scene=api.capture(),captured=keyOf(scene);
    if(!visible()||working||connected()||manual||manualFailed||!localSaved()||api.status().busy||reviewRound(scene.review,scene.returned).state!=='outstanding')return;
    working=true;update();
    try{const entry=await api.lock(async()=>{const entry=await taskForScene(scene,{packageMaker:api.packageMaker});if(keyOf(api.capture())!==captured)throw Error('Review changed.');await retain(entry);return entry;});if(keyOf(api.capture())===captured)manual={entry,text:await entry.payloads.get('PROMPT.txt').text(),key:captured};}
    catch(e){if(keyOf(api.capture())===captured)manualFailed=true;api.message(e.message,true,'round-summary');}
    finally{working=false;update();}
  }
  function update(){
    const scene=api.roundSummary();if(!scene.review||!scene.returned){hide();clear();key=null;pendingCompletion=null;return;}
    const next=keyOf(scene);if(next!==key){clear();key=next;}
    const round=scene.round,folder=connected(),local=api.status(),saved=localSaved(),busy=working||local.busy||Boolean(folder?.busy),outstanding=round.state==='outstanding';
    if(checkKey&&checkKey!==identityKey(scene,folder)){checked=null;checkKey=null;}
    const handoff=saved&&!busy&&outstanding?(folder?api.folder.savedPrompt():manual):null;
    const saveError=local.saveConflict||local.saveFailed||folder?.error||folder?.pausedReason;
    const folderFailure=folder?.error?.split('Finished PDF: ')[1]||folder?.error||folder?.pausedReason||'Folder saving failed. Your decisions are saved locally.';
    const folderPending=folder&&(folder.lastCheckpointGeneration??folder.lastSavedGeneration)!==folder.generation;
    title.textContent=round.state==='unchecked'?'Keep reviewing':outstanding?'Another correction round':'Review complete';
    const count=round.state==='unchecked'?round.unchecked.length:round.outstanding.length,corrections=count+(count===1?' correction still needs':' corrections still need');
    text.textContent=round.state==='unchecked'?corrections+' checking.':outstanding?'Some corrections still need work. Copy the prompt and send it to your AI for another round of corrections.':'All corrections approved. Your finished PDF is ready.';
    const reconnect=folder?.needsConnection&&(folder.pathProblem||!folder.canOpenLocation);
    let primary=round.state==='unchecked'?resume:outstanding?copy:reconnect?connect:folder?.canOpenLocation?openFolder:files;
    let message='';
    if(!saved){
      title.textContent=saveError?'Review needs saving':'Saving review…';text.textContent=saveError?'Your latest changes could not be saved. Try again.':'Your latest changes are being saved.';
      primary=saveError?(folder&&!folder.permission?connect:retry):null;
    }else if(folder?.loadError&&round.state!=='resolved'){
      title.textContent='Working files unavailable';text.textContent='The working files could not be loaded. Try loading them again.';primary=reload;
    }else if(round.state==='resolved'){
      if(!folder)text.textContent='You’ve approved every correction. Save or export your files from Files & backups.';
      else if(saveError){text.textContent='You’ve approved every correction.';message=folderFailure;primary=folder.permission?retry:connect;}
      else if(reconnect)text.textContent=folder.pathProblem?'The working folder could not be opened. Connect it again.':'You’ve approved every correction. Connect the working folder to open it.';
      else if(folderPending||folder.busy||!folder.ready){text.textContent='You’ve approved every correction.';message='Finishing the folder save…';}
      else if(checking||!checked){text.textContent='You’ve approved every correction.';message='Checking the finished PDF…';}
      else if(checked.state!=='match'){text.textContent='All corrections approved.';message=checked.message||'The finished PDF is unavailable. Retry saving.';primary=retry;}
    }else if(outstanding&&!handoff){
      message=saveError?folderFailure:manualFailed?'The prompt could not be saved. Try again.':folder&&!folder.busy?'Prepare a prompt with the corrections from this completed round.':'Preparing the current prompt…';
      primary=saveError?(folder&&!folder.permission?connect:retry):manualFailed?retry:folder&&!folder.busy?prepareFolder:null;
    }else if(round.state==='unchecked'&&saveError)message=folderFailure;
    status.textContent=feedback||message;status.hidden=!status.textContent;
    promptArea.hidden=!outstanding||!handoff;const value=handoff?.text??'';if(prompt.value!==value)prompt.value=value;
    for(const button of [resume,copy,prepareFolder,openFolder,retry,connect,reload,files]){button.hidden=button!==primary;button.disabled=(button===resume?working||local.busy||Boolean(folder?.selecting):busy)||button===copy&&!handoff||button===openFolder&&(!folder?.ready||checking||checked?.state!=='match');button.classList.toggle('primary',button===primary);}
    dismiss.textContent=outstanding?'Back to score':'Close';dismiss.disabled=false;
    root.dataset.state=saved?round.state:'saving';root.dataset.handoff=handoff?'ready':'pending';
    if(visible()&&saved&&round.state==='resolved'&&folder?.ready&&!folder.busy&&!checking&&checkKey!==identityKey(scene,folder))void checkPDF();
    if(visible()&&saved&&outstanding&&!folder&&!manual&&!manualFailed&&!working&&!local.busy)queueMicrotask(()=>void preparePrompt());
    scheduleCompletion();
  }
  function show({automatic=false}={}){
    feedback='';checkKey=null;checked=null;update();const scene=api.capture();if(!scene.returned)return;
    pendingCompletion=null;returnFocus=$('looksCorrect')??$('openRoundSummary')??document.activeElement;
    if(!visible())root.showModal();content.scrollTop=0;title.focus({preventScroll:true});
    protectedUntil=automatic?performance.now()+500:0;
    if(completionSaved())rememberShown(scene,reviewRound(scene.review,scene.returned).state);update();
  }
  function scheduleCompletion(){
    if(!pendingCompletion||autoTimer)return;
    autoTimer=setTimeout(()=>{
      autoTimer=null;if(!pendingCompletion)return;
      const scene=api.capture();if(outcomeKey(scene,reviewRound(scene.review,scene.returned).state)!==pendingCompletion){pendingCompletion=null;return;}
      if(keys.size||pointers.size||api.status().busy||api.corrections.state().pending||document.querySelector('dialog[open]'))return;
      if(completionSaved())show({automatic:true});
    },16);
  }
  function decisionSaved(before,options){
    const scene=api.capture();if(roundKey(before)!==roundKey(scene))return;
    const state=automaticRoundOutcome(reviewRound(scene.review,scene.returned),options);
    if(!state||alreadyShown(scene,state))return;
    pendingCompletion=outcomeKey(scene,state);scheduleCompletion();
  }
  function endReached(){const scene=api.capture();if(!scene.returned)return;pendingCompletion=outcomeKey(scene,reviewRound(scene.review,scene.returned).state);scheduleCompletion();}
  for(const [event,down]of [['keydown',true],['keyup',false]])document.addEventListener(event,e=>{if(down)keys.add(e.code||e.key);else keys.delete(e.code||e.key);scheduleCompletion();},true);
  for(const [event,down]of [['pointerdown',true],['pointerup',false],['pointercancel',false]])document.addEventListener(event,e=>{if(down)pointers.add(e.pointerId);else pointers.delete(e.pointerId);scheduleCompletion();},true);
  window.addEventListener('blur',()=>{keys.clear();pointers.clear();});
  document.addEventListener('close',scheduleCompletion,true);
  for(const event of ['score-desk-folder-status','score-desk-change','score-desk-controls','score-desk-save-status'])document.addEventListener(event,update);
  window.addEventListener('focus',()=>{scheduleCompletion();if(visible())void checkPDF(true);});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&visible())void checkPDF(true);});
  return {show,update,hide,decisionSaved,endReached,task:()=>manual?.key===keyOf(api.capture())&&localSaved()?manual.entry:null};
}

