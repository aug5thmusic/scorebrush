// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Presentation and command routing only. Storage, file validation and decisions
// remain owned by the existing workspace implementations.
import {installProjectEntries} from './project-entry-ui.js';
import {nativeRequest} from './native-bridge.js';
const $=id=>document.getElementById(id);
const groups=[
  ['File',[['new-project','New Project…'],['open-folder','Open Project…','Ctrl+O'],['explorer','Open file location'],['versions','Open previous versions'],['copy-path','Copy folder path'],['connect-folder','Connect working folder…'],['import','Restore Backup…'],['backup','Save backup…','Ctrl+Shift+S'],['files','Files & backups…']]],
  ['Edit',[['undo','Undo','Ctrl+Z'],['redo','Redo','Ctrl+Shift+Z'],['new-finding','New finding','N'],['navigate','Navigate','V'],['draw','Draw','D']]],
 ['View',[['marks','Hide marks','Ctrl+H'],['findings','Findings pane'],['scroll-pages','Scroll between pages'],['both','Both scores'],['source','Left score only'],['rendered','Right score only'],['fit','Fit scores to width']]],
  ['Workflow',[['proofread','Proofread'],['send','Send to AI…'],['review','Review Changes'],['round-summary','Round summary…'],['latest','Load latest from working folder'],['response','Open AI response…'],['task','Save AI task ZIP…']]],
  ['Help',[['welcome','Welcome & workflow guide'],['shortcuts','Keyboard shortcuts…','F1'],['about','About ScoreBrush']]]
];

export function installApplicationShell(api,layout){
  const native=Boolean(window.chrome?.webview);
  document.body.classList.toggle('native-host',native);
  const bar=document.createElement('div');bar.id='workbar';
  const workflow=document.createElement('nav');workflow.id='workflowNavigation';workflow.setAttribute('aria-label','Review workflow');
  const workflowArrow='<span aria-hidden="true"><svg viewBox="0 0 8 12" focusable="false"><path d="m2 2 4 4-4 4"/></svg></span>';
  workflow.innerHTML='<button id="workflowProof" type="button">Proofread</button>'+workflowArrow+'<span id="sendSlot"></span>'+workflowArrow+'<button id="workflowReview" type="button">Review Changes</button>';
  const toolbar=document.querySelector('.toolbar');toolbar.before(bar);bar.append(workflow,toolbar,$('correctionHeader'));
  workflow.querySelector('#sendSlot').replaceWith($('folderPromptButton'));
  document.querySelector('.primary-actions').append(workflow);
  $('workspaceTools').hidden=true;
  const latest=$('loadLatest');latest.textContent='Load latest';latest.classList.add('workflow-load');bar.append(latest);
  const menu=document.createElement('nav');menu.id='appMenu';menu.setAttribute('aria-label','Application menu');menu.setAttribute('role','menubar');
  document.querySelector('header').before(menu);
  let returnFocus=null,openMenu=null,lastState='',scheduled=false,transitioning=false;
  const menuButtons=new Map(),items=new Map();
  function dismissMenu(restore=true){if(openMenu){openMenu.panel.hidden=true;openMenu.button.setAttribute('aria-expanded','false');openMenu=null;}if(restore&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});}
  function showMenu(group,last=false){
    if(!openMenu)returnFocus=document.activeElement;
    dismissMenu(false);group.panel.hidden=false;group.button.setAttribute('aria-expanded','true');openMenu=group;
    const available=[...group.panel.querySelectorAll('button:not(:disabled)')];(last?available.at(-1):available[0])?.focus();
  }
  for(const [label,commands] of groups){
    const group={button:document.createElement('button'),panel:document.createElement('div')};
    group.button.id='appMenu'+label;group.button.textContent=label;group.button.setAttribute('role','menuitem');group.button.setAttribute('aria-haspopup','menu');group.button.setAttribute('aria-expanded','false');group.button.tabIndex=label==='File'?0:-1;
    group.panel.className='application-menu';group.panel.hidden=true;group.panel.setAttribute('role','menu');group.panel.setAttribute('aria-label',label);group.panel.id='menu'+label;group.button.setAttribute('aria-controls',group.panel.id);
    group.button.onclick=()=>openMenu===group?dismissMenu():showMenu(group);
    for(const [id,text,key] of commands){const item=document.createElement('button');item.dataset.command=id;item.setAttribute('role','menuitem');item.tabIndex=-1;const name=document.createElement('span');name.textContent=text;item.append(name);if(key){const hint=document.createElement('kbd');hint.textContent=key;item.append(hint);}item.onclick=()=>{dismissMenu();void execute(id);};group.panel.append(item);items.set(id,item);}
    const wrap=document.createElement('div');wrap.append(group.button,group.panel);menu.append(wrap);menuButtons.set(label,group);
  }
  menu.addEventListener('keydown',event=>{
    const order=[...menuButtons.values()],index=order.findIndex(g=>g===openMenu||g.button===event.target);
    if(['ArrowRight','ArrowLeft'].includes(event.key)){event.preventDefault();const next=order[(index+(event.key==='ArrowRight'?1:-1)+order.length)%order.length];if(openMenu)showMenu(next);else next.button.focus();}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();if(!openMenu){showMenu(order[index],event.key==='ArrowUp');return;}const available=[...openMenu.panel.querySelectorAll('button:not(:disabled)')],current=available.indexOf(document.activeElement);available[event.key==='Home'?0:event.key==='End'?available.length-1:(current+(event.key==='ArrowUp'?-1:1)+available.length)%available.length]?.focus();}
    else if(event.key==='Escape'){event.preventDefault();dismissMenu();}
    else if(event.key==='Tab')dismissMenu(false);
    event.stopPropagation();
  });
  window.addEventListener('keydown',event=>{if(openMenu&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();dismissMenu();}},true);
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))dismissMenu(false);},true);
  const openFiles=(section=null)=>{
    if(!$('workspaceDialog').open)$('workspaceTools').click();
    $('workspaceDialog').dataset.page='files';$('workspaceTitle').textContent='Files & backups';
    if(section){$(section).open=true;$(section).querySelector('select,input,button,summary')?.focus();$(section).scrollIntoView({block:'nearest'});}
  };
  function welcome(){
    if(api.status().busy)return;
    $('workspaceDialog').dataset.page='welcome';$('workspaceTitle').textContent='Welcome to ScoreBrush';
    if(!$('workspaceDialog').open)$('workspaceDialog').showModal();
    $('closeWorkspace').setAttribute('aria-label',api.status().snapshotId?'Return to your review':'Close welcome');
    $('chooseFolderInSetup').focus();
  }
  const projects=installProjectEntries(api);
  $('welcomeRecover').onclick=projects.open;
  $('welcomeRestore').onclick=projects.restore;
  $('closeAbout').onclick=()=>$('aboutDialog').close();
  let openingRepository=false;
  $('sourceLink').onclick=async event=>{
    if(!native)return;
    event.preventDefault();if(openingRepository)return;openingRepository=true;
    const status=$('sourceLinkStatus');status.hidden=true;status.textContent='';
    try{await nativeRequest('open-source');}
    catch(error){status.textContent=error.message;status.hidden=false;}
    finally{openingRepository=false;}
  };
  function enabledButton(id){const el=$(id);return Boolean(el&&!el.disabled);}
  function states(){
    const s=api.status(),modal=document.querySelector('dialog[open]'),welcomeOpen=modal?.id==='workspaceDialog',blocked=transitioning||s.busy||s.gesture||s.exporting||s.recovering||document.body.inert||api.corrections.state().pending;
    const free=!blocked&&!modal,filesFree=!blocked&&(!modal||welcomeOpen),review=Boolean(s.snapshotId),comparison=Boolean(api.corrections.state().key),activeComparison=comparison&&!api.corrections.state().suspended;
    const state={};const set=(id,enabled,checked=false)=>state[id]={enabled:Boolean(enabled),checked:Boolean(checked)};
    for(const [id,target] of [['undo','undo'],['redo','redo'],['new-finding','newFinding'],['navigate','navigate'],['draw','draw']])set(id,free&&enabledButton(target),['navigate','draw'].includes(id)&&s.mode===id);
    set('marks',free&&review,s.marksHidden);set('findings',free&&review,$('toggleComments').getAttribute('aria-expanded')==='true');
    set('scroll-pages',free,api.pageScrolling());
    for(const [id,value] of [['both','none'],['source','source'],['rendered','rendered']])set(id,free&&review,(document.body.dataset.workspaceMax??'none')===value);
    set('fit',free&&review);
    const sending=$('folderPromptDialog').open||$('handoffDialog').open&&$('promptFallback').hidden===false;
    set('proofread',free&&review,review&&!activeComparison&&!sending);set('send',free&&enabledButton('folderPromptButton'),sending);
    set('review',free&&review,activeComparison&&!sending);set('latest',free&&enabledButton('loadLatest'));set('response',filesFree&&enabledButton('importResponse'));set('task',free&&enabledButton('exportTask'));
    set('round-summary',free&&Boolean(api.capture().returned));
    set('new-project',filesFree&&!api.folder.getState().selecting);
    for(const id of ['open-folder','import'])set(id,filesFree&&!api.folder.getState().busy);set('files',filesFree);
    set('connect-folder',free&&api.folder.getState().needsConnection&&enabledButton('connectWorkingFolder'));set('explorer',free&&enabledButton('showFolderFiles'));set('copy-path',free&&enabledButton('copyFolderPath'));set('versions',free&&enabledButton('openPreviousVersions'));
    set('backup',filesFree&&enabledButton('finishReview'));for(const id of ['welcome','shortcuts','about'])set(id,free);
    return state;
  }
  async function execute(id,{fromNative=false}={}){
    if(!states()[id]?.enabled)return false;
    const transition=['proofread','review'].includes(id)&&Boolean(api.corrections.state().key);
    if(transition){transitioning=true;refresh();}
    try{
      switch(id){
        case 'new-project':$('workspaceDialog').close();void api.folder.choose({mode:'new'});break;
        case 'open-folder':void projects.open();break;
        case 'explorer':$('showFolderFiles').click();break;
        case 'versions':$('openPreviousVersions').click();break;
        case 'connect-folder':$('connectWorkingFolder').click();break;
        case 'copy-path':$('copyFolderPath').click();break;
        case 'files':openFiles();break;
        case 'import':projects.restore();break;
        case 'response':if(fromNative){openFiles('manualHandoffPanel');$('importResponse').focus();}else $('importResponse').click();break;
        case 'backup':$('finishReview').click();break;
        case 'task':$('exportTask').click();break;
        case 'new-finding':$('newFinding').click();break;
        case 'undo':case 'redo':case 'draw':case 'navigate':$(id).click();break;
        case 'marks':$('hide').click();break;
        case 'findings':$('toggleComments').click();break;
        case 'scroll-pages':api.togglePageScrolling();break;
        case 'both':case 'source':case 'rendered':{
          if(layout.isDesktop()){const current=document.body.dataset.workspaceMax;if(id==='both'){if(current&&current!=='none')$(current+'Maximize').click();}else if(current!==id)$(id+'Maximize').click();}
          else $('show'+({both:'Both',source:'Source',rendered:'Rendered'}[id])).click();break;}
        case 'fit':for(const kind of ['source','rendered']){$(kind+'Zoom').value='fit';$(kind+'Zoom').dispatchEvent(new Event('change'));}break;
        case 'proofread':await api.corrections.proofread();break;
        case 'send':$('folderPromptButton').click();break;
        case 'round-summary':api.corrections.showSummary();break;
        case 'review':if(api.corrections.state().key)await api.corrections.resume();else {reviewDialog.showModal();(enabledButton('loadLatest')?$('reviewLoadLatest'):$('reviewImport')).focus();}break;
        case 'latest':$('loadLatest').click();break;
        case 'welcome':welcome();break;
        case 'shortcuts':$('shortcutHelp').click();break;
        case 'about':$('aboutDialog').showModal();break;
        default:return false;
      }
      return true;
    }catch(error){api.message(error.message,true,'application-command');return false;}
    finally{if(transition)transitioning=false;schedule();}
  }
  const reviewDialog=document.createElement('dialog');reviewDialog.id='reviewStartDialog';reviewDialog.setAttribute('aria-labelledby','reviewStartTitle');
  reviewDialog.innerHTML='<div class="dialog-head"><h2 id="reviewStartTitle">Review Changes</h2><button id="closeReviewStart">Close</button></div><p>Ready to check your agent’s work?</p><p>Load the updated LilyPond and rendered PDF from your working folder, or open an AI response package. Your previous rendering stays available for exact comparison.</p><div class="action-row"><button id="reviewLoadLatest" class="primary">Load latest from folder</button><button id="reviewImport">Open AI response</button></div><p class="hint">After checking corrections and footnotes, send any remaining findings for another round. Internal comments remain in the Comment log.</p>';
  document.body.append(reviewDialog);$('closeReviewStart').onclick=()=>reviewDialog.close();$('reviewLoadLatest').onclick=()=>{reviewDialog.close();latest.click();};$('reviewImport').onclick=()=>{reviewDialog.close();$('importResponse').click();};
  $('workflowProof').onclick=()=>execute('proofread');$('workflowReview').onclick=()=>execute('review');
  function refresh(){
    const state=states();
    for(const [id,item]of items){const value=state[id];if(item.disabled===value.enabled)item.disabled=!value.enabled;const checked=['navigate','draw','marks','findings','scroll-pages','both','source','rendered','proofread','review'].includes(id);if(checked){item.setAttribute('role','menuitemcheckbox');item.setAttribute('aria-checked',String(value.checked));}}
    for(const [id,command]of [['workflowProof','proofread'],['workflowReview','review']]){$(id).disabled=!state[command].enabled;$(id).setAttribute('aria-current',state[command].checked?'step':'false');}
    const sending=$('folderPromptDialog').open||$('handoffDialog').open&&$('promptFallback').hidden===false;
    document.body.dataset.workflow=sending?'send':state.review.checked?'review':'proofread';
    $('folderPromptButton').setAttribute('aria-current',sending?'step':'false');
    $('reviewLoadLatest').disabled=!enabledButton('loadLatest');
    for(const [id,command]of [['chooseFolderInSetup','new-project'],['welcomeRecover','open-folder'],['welcomeRestore','import']])$(id).disabled=!state[command].enabled;
    const encoded=JSON.stringify(state);if(encoded!==lastState){lastState=encoded;window.chrome?.webview?.postMessage({op:'menu-state',items:state});}
  }
  function schedule(){if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;refresh();});}
  const observer=new MutationObserver(schedule);
  observer.observe(document.body,{attributes:true,attributeFilter:['class','inert','data-workspace-max','data-workspace-findings']});
  for(const el of document.querySelectorAll('dialog'))observer.observe(el,{attributes:true,attributeFilter:['open']});
  for(const id of ['folderPromptButton','loadLatest','undo','redo','newFinding','brush','draw','navigate','toggleComments'])observer.observe($(id),{attributes:true,attributeFilter:['disabled','aria-expanded']});
  for(const event of ['score-desk-controls','score-desk-ready','score-desk-change','score-desk-folder-status'])document.addEventListener(event,schedule);
  document.addEventListener('keydown',event=>{
    if(event.isComposing||event.defaultPrevented)return;
    if(!native&&(event.key==='F10'||event.altKey&&['f','e','v','w','h'].includes(event.key.toLowerCase()))){event.preventDefault();returnFocus=document.activeElement;const label={f:'File',e:'Edit',v:'View',w:'Workflow',h:'Help'}[event.key.toLowerCase()];if(label)showMenu(menuButtons.get(label));else menuButtons.get('File').button.focus();return;}
    const command=event.key==='F1'?'shortcuts':event.ctrlKey&&!event.shiftKey&&event.key.toLowerCase()==='o'?'open-folder':event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='s'?'backup':null;
    if(command){event.preventDefault();void execute(command);}
  });
  window.chrome?.webview?.addEventListener('message',event=>{const m=event.data;if(m&&Object.keys(m).length===2&&m.op==='command'&&typeof m.id==='string'&&items.has(m.id))void execute(m.id,{fromNative:true});});
  refresh();
  return Object.freeze({welcome,execute,states,refresh:()=>{lastState='';refresh();}});
}
