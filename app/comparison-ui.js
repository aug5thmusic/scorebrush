// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {installRoundSummary} from './round-summary.js';
import {comparisonContext,savedLocation,approximatePosition,aiExplanation,currentAssociation,candidateIdentity,sameCandidate} from './comparison-model.js';
import {readRevisionView,rememberRevisionView} from './revision-views.js';
import {findingType,findingTypeLabel,isComment} from './model.js';
const $=id=>document.getElementById(id);
const element=(tag,text,cls)=>{const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;};

// Both transports share this view. Adapters alone persist decisions and enforce
// permissions; navigation, drafts and remembered passages never imply approval.
export function installComparison(api){
  const header=element('section',null,'correction-header');header.id='correctionHeader';header.hidden=true;document.querySelector('.toolbar').after(header);
  const root=element('section',null,'correction-comparison');root.id='correctionComparison';root.hidden=true;root.setAttribute('aria-label','Review the reported problem');document.querySelector('main').before(root);
  const problemsDialog=element('dialog');problemsDialog.id='correctionProblems';problemsDialog.setAttribute('aria-label','Reported problems');
  const problemsHead=element('div',null,'dialog-head');problemsHead.append(element('h2','Reported problems'));const problemsClose=element('button','Close');problemsClose.onclick=()=>problemsDialog.close();problemsHead.append(problemsClose);
  const problemSearch=element('input');problemSearch.id='correctionProblemSearch';problemSearch.type='search';problemSearch.placeholder='Search report text or page';problemSearch.setAttribute('aria-label','Search reported problems');
  const uncheckedLabel=element('label','Unchecked only'),unchecked=element('input');unchecked.type='checkbox';unchecked.id='correctionUncheckedOnly';uncheckedLabel.prepend(unchecked);
  const problemCount=element('p');problemCount.id='correctionProblemCount';problemCount.setAttribute('role','status');const problemList=element('div');problemList.id='correctionProblemList';
  problemsDialog.append(problemsHead,problemSearch,uncheckedLabel,problemCount,problemList);document.body.append(problemsDialog);
  const refs={},owned=[],homes=new Map(),narrow=matchMedia('(max-width:700px)'),compact=matchMedia('(max-width:430px)');
  const scoreSwitch=document.querySelector('.score-switch'),switchHome=scoreSwitch.parentNode;
  let suspended=false;
  let adapter=null,index=0,context=null,left='before',priorLeft='before',pending=false,initializing=false,opening=null,viewReady=false,generation=0,urls=[],positions=new Map(),currentId=null,editorOpen=false,draftSerial=0;
  const noticeErrorSerial=new Map();
  let viewScene=null,viewTimer,viewPaused=false;
  const selected=()=>adapter?.findings()[index];
  function place(node,parent){if(!homes.has(node))homes.set(node,{parent:node.parentNode,next:node.nextSibling});parent.append(node);}
  function restore(){for(const [node,home]of [...homes].reverse())home.parent.insertBefore(node,home.next?.parentNode===home.parent?home.next:null);homes.clear();for(const node of owned)node.remove();owned.length=0;}
  function own(node,parent){parent.append(node);owned.push(node);return node;}
  function closeMenus(){for(const item of [refs.more,refs.aiDetails,refs.sourceOptions,refs.afterOptions])if(item)item.open=false;}
  function notify(text,error=false,scope='comparison'){if(error)noticeErrorSerial.set(scope,(noticeErrorSerial.get(scope)||0)+1);refs.notice.textContent=text;refs.notice.dataset.error=String(error);api.message(text,error,scope);}
  function controls(){
    if(!adapter||suspended)return;
    const sourceCompact=$('sourceViewer').clientWidth<=500,renderedCompact=$('renderedViewer').clientWidth<=500;
    const status=api.status(),disabled=pending||initializing||status.busy;root.setAttribute('aria-busy',String(disabled));
    const reviewBlocked=disabled||status.dirty||status.saveConflict||api.folder?.getState().selecting||status.gesture;
    for(const scope of [root,header,...owned])for(const el of scope.querySelectorAll('button,select,textarea,input'))if(!el.closest('#statusControl,#workspaceIdentity')&&el.id!=='folderPromptButton')el.disabled=disabled;
    api.folder?.setHeaderBusy(disabled);
    refs.skip.disabled=disabled;refs.skip.hidden=false;
    if(refs.findings)refs.findings.setAttribute('aria-expanded',$('toggleComments').getAttribute('aria-expanded'));
    const comments=adapter.comments?.()??[];if(refs.comments){refs.comments.hidden=!comments.length;refs.comments.textContent=`Comments (${comments.length})`;}
    if(refs.loadLatest)refs.loadLatest.disabled=disabled||$('loadLatest').disabled;
    if(refs.folderStatus)refs.folderStatus.textContent=$('folderStatus').textContent;
    refs.approve.disabled=reviewBlocked||editorOpen||!viewReady||!adapter.canApprove();refs.reject.disabled=reviewBlocked||editorOpen||!viewReady;refs.skip.disabled=reviewBlocked||editorOpen||!viewReady;refs.report.disabled=disabled||!adapter.candidate;
    if(adapter.note){const note=adapter.note(selected()?.id);refs.addNote.hidden=Boolean(note);refs.showNote.hidden=!note;refs.addNote.disabled=refs.showNote.disabled=disabled||!viewReady||!adapter.canApprove();}
    document.body.classList.toggle('corrections-annotating',Boolean(api.status().active||api.status().prepared));
    refs.back.textContent=compact.matches?'← Files':'Files & backups';refs.back.setAttribute('aria-label','Files and backups');
    for(const kind of ['source','rendered']){
      const page=$(`${kind}Page`),nav=$(`${kind}PageNavigation`);
      if(nav){nav.querySelector('[data-action=prev]').disabled=disabled||Number(page.value)<=1;nav.querySelector('[data-action=next]').disabled=disabled||Number(page.value)>=Number(page.max);}
    }
    $('showSource').textContent=left==='source'?(compact.matches?'Source':'Printed source'):left==='original'?'Earlier version':compact.matches?'Before':'Before correction';
    $('showSource').setAttribute('aria-label',left==='source'?'Printed source':left==='original'?'Earlier version':'Before correction');
    refs.sourceToggle.textContent=left==='source'?(sourceCompact?'Back to Before':'Back to correction'):(sourceCompact?'Check source':'Check printed source');
    refs.sourceToggle.setAttribute('aria-label',left==='source'?'Return to the correction comparison':'Check printed source');
    refs.report.textContent=renderedCompact?'Report error':'Report another error';refs.report.setAttribute('aria-label','Report another error');
    for(const [summary,small]of [[refs.sourcePageSummary,sourceCompact],[refs.afterPageSummary,renderedCompact]]){summary.textContent=small?'View':'View options';summary.setAttribute('aria-label','View options');}
  }
  compact.addEventListener('change',controls);
  window.addEventListener('resize',controls);
  // Grid and divider changes settle after window resize. Keep each pane's
  // labels in step with its actual width without reacting to height changes.
  let paneWidths='';const paneSize=new ResizeObserver(()=>{const widths=[$('sourceViewer').clientWidth,$('renderedViewer').clientWidth].join(':');if(widths!==paneWidths){paneWidths=widths;controls();}});
  for(const id of ['sourceViewer','renderedViewer'])paneSize.observe($(id));
  new MutationObserver(controls).observe($('loadLatest'),{attributes:true,attributeFilter:['disabled']});
  new MutationObserver(controls).observe($('folderStatus'),{childList:true,characterData:true,subtree:true});
  const guarded=(fn,scope='comparison-navigation')=>async(...args)=>{
    if(pending||initializing||api.status().busy)return;
    const focused=document.activeElement,errorSerial=noticeErrorSerial.get(scope)||0;pending=true;controls();
    // Validation and background draft failures can report an error without
    // rejecting this action. Only clear the earlier problem after real success.
    try{await fn(...args);if((noticeErrorSerial.get(scope)||0)===errorSerial)api.clearMessage?.(scope);}catch(error){notify(error.message,true,scope);}finally{
      pending=false;controls();roundSummary.update();const target=refs.focusAfter??focused;refs.focusAfter=null;
      if(target?.isConnected&&!target.closest('[hidden]')&&!document.querySelector('dialog[open]'))(target.disabled?refs.picker:target).focus({preventScroll:true});
    }
  };
  function button(label,id,fn,guard=true,scope=id?'comparison-'+id:'comparison-navigation'){const el=element('button',label);el.type='button';if(id)el.id=id;const run=guard?guarded(fn,scope):fn;el.onclick=event=>{if(event.detail>1&&[refs.approve,refs.reject,refs.skip,refs.send].includes(el))return;return run(event);};return el;}
  function disclosure(label,id,cls='review-disclosure'){
    const details=element('details',null,cls);if(id)details.id=id;const summary=element('summary',label),body=element('div',null,'review-popover');details.append(summary,body);return {details,summary,body};
  }
  function renderProblems(){
    if(!adapter)return;
    const query=problemSearch.value.trim().toLocaleLowerCase(),list=adapter.findings();problemList.replaceChildren();let visible=0;
    list.forEach((finding,i)=>{
      const page=finding.historicalContext?.page??finding.origin?.page??finding.page,location=(page?`Reported on page ${page}`:'No page specified')+(findingType(finding)==='source_footnote'?' · Footnote':''),state=adapter.state(finding.id)||'Unchecked';
      if(unchecked.checked&&adapter.decision(finding.id)||query&&!`${finding.comment} ${location} ${state}`.toLocaleLowerCase().includes(query))return;
      visible++;const row=button('',null,async()=>{problemsDialog.close();await select(i);refs.focusAfter=refs.picker;});row.dataset.problemIndex=String(i);row.className='problem-list-item';row.setAttribute('aria-current',String(i===index));
      row.append(element('span',`${i+1} · ${location} · ${state}`, 'problem-list-context'),element('span',finding.comment,'problem-list-comment'));problemList.append(row);
    });
    problemCount.textContent=`${visible} of ${list.length} reported problems`;if(!visible)problemList.append(element('p','No problems match this search.'));
  }
  problemSearch.oninput=unchecked.onchange=()=>{renderProblems();problemList.scrollTop=0;};
  function showProblems(){closeMenus();renderProblems();problemsDialog.showModal();problemSearch.focus();problemList.querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest'});}
  function showEditor(open,restoreFocus=true){if(!open&&editorOpen&&adapter?.candidate&&api.status().dirty)void api.saveNow();editorOpen=open;refs.editor.hidden=!open;refs.actions.hidden=false;refs.reportBody.hidden=open;root.classList.toggle('response-open',open);controls();if(open){closeMenus();refs.explanation.focus({preventScroll:true});}else if(restoreFocus)refs.reject.focus({preventScroll:true});}
  function focusEditor(){if(pending||initializing||api.status().busy||!viewReady||editorOpen)return;showEditor(true);}
  function draftStatus(){
    if(!adapter||!refs.draft)return;const state=api.status();
    refs.draft.textContent=state.saveFailed||state.saveConflict?'Draft not saved':state.dirty?'Unsaved draft':refs.explanation.value?'Draft saved locally':'';
  }
  async function saveDraft(){
    const id=selected().id,key=adapter.key,serial=++draftSerial,value=refs.explanation.value,kind=refs.clarify.checked?'needs_clarification':'needs_correction';
    refs.draft.textContent='Unsaved draft';
    try{await adapter.saveExplanation(id,value,kind);if(adapter?.key===key&&selected()?.id===id&&serial===draftSerial){draftStatus();api.clearMessage?.('comparison-draft');}}
    catch(error){if(adapter?.key===key&&selected()?.id===id&&serial===draftSerial)refs.draft.textContent='Draft not saved';notify(`Draft could not be saved: ${error.message}. Keep this page open.`,true,'comparison-draft');}
  }
  function remember(){
    rememberAIView();if(!currentId)return;const saved=positions.get(currentId)??{};
    // A page change clears its viewport while painting. Preserve the requested
    // page even if the reviewer switches versions before that paint completes.
    const position=kind=>api.viewPosition(kind)??{page:Number($(`${kind}Page`).value)||1,zoom:$(`${kind}Zoom`).value==='fit'?'fit':Number($(`${kind}Zoom`).value)};
    saved[left]=position('source');positions.set(currentId,saved);
  }
  function rememberAIView(){
    clearTimeout(viewTimer);
    if(!viewReady||viewPaused||suspended||!currentId||!adapter?.candidate||!viewScene)return;
    const scene=api.capture();
    if(scene.comparison||scene.workspaceId!==viewScene.workspaceId||!sameCandidate(candidateIdentity(scene.review),candidateIdentity(viewScene.review)))return;
    rememberRevisionView(viewScene,currentId,api.viewPosition('rendered'));
  }
  function pauseViewForNote(reportedId=null){if(reportedId&&reportedId===currentId)return;rememberAIView();viewPaused=true;}
  function queueView(){if(viewReady&&!viewPaused&&!suspended){clearTimeout(viewTimer);viewTimer=setTimeout(rememberAIView,150);}}
  $('renderedScroll').addEventListener('scroll',queueView,{passive:true});
  document.addEventListener('score-desk-render',queueView);
  window.addEventListener('pagehide',rememberAIView);window.addEventListener('blur',rememberAIView);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)rememberAIView();});
  function initial(asset){const mark=asset?.marks.find(f=>f.id===selected().id),box=mark?.bounds;return {page:mark?.page??context.page,zoom:'fit',...(box?{point:[(box[0]+box[2])/2,(box[1]+box[3])/2]}:{})};}
  async function displayLeft(mode,position=null){
    const token=generation;if(mode==='source'&&left!=='source')priorLeft=left;left=mode;refs.left.value=mode;
    const asset=mode==='source'?null:mode==='original'?context.original:context.baseline;
    const target=position??positions.get(currentId)?.[mode]??(mode==='source'?{page:1,zoom:'fit'}:initial(asset));
    await api.showHistorical(asset,target,refs.others.checked);
    if(token!==generation)return;
    $('sourceLabel').textContent=mode==='source'?'Printed source':mode==='original'?'Earlier version':'Before correction';
    refs.sourceToggle.textContent=mode==='source'?'Back to correction':'Check printed source';
    $('showSource').textContent=mode==='source'?'Printed source':mode==='original'?'Earlier version':'Before correction';
  }
  function measureReport(){if(!adapter)return;refs.expand.hidden=refs.original.scrollHeight<=refs.original.clientHeight+1&&!root.classList.contains('report-expanded');}
  const reportSize=new ResizeObserver(measureReport);
  async function select(next){
    if(editorOpen&&adapter?.candidate&&api.status().dirty)await api.saveNow();
    remember();closeMenus();editorOpen=false;refs.editor.hidden=true;refs.actions.hidden=false;refs.reportBody.hidden=false;root.classList.remove('response-open','report-expanded');refs.expand.textContent='Read full report';
    viewReady=false;index=Math.max(0,Math.min(adapter.findings().length-1,next));const f=selected();if(!f)return;
    const token=++generation;currentId=f.id;root.dataset.findingId=f.id;context=await comparisonContext(adapter.issued,f);if(token!==generation)return;
    refs.picker.value=String(index);root.dataset.findingType=findingType(f);refs.original.textContent=(findingType(f)==='source_footnote'?'Footnote: ':'')+f.comment;refs.ai.textContent=aiExplanation(adapter.result(f.id));refs.aiDetails.hidden=!refs.ai.textContent;
    refs.explanation.value=await adapter.explanation(f.id);const kind=await adapter.draftKind?.(f.id);if(token!==generation)return;
    refs.clarify.checked=kind==='needs_clarification';draftStatus();
    for(const url of urls)URL.revokeObjectURL(url);urls=[];refs.context.replaceChildren();
    refs.history.hidden=!context.earlier;refs.history.textContent=context.earlier?'This error was reported on an earlier version.':'';
    refs.earlier.textContent=context.original?'The original PDF and its reported errors are available.':'Only the original marked images are available.';
    refs.originalVersion.hidden=!context.earlier||!context.original;
    refs.left.replaceChildren(new Option('Before correction','before'),new Option('Printed source','source'));if(context.earlier&&context.original)refs.left.add(new Option('Earlier version','original'));
    context.crops.forEach((blob,i)=>{if(!blob)return;const img=element('img');img.src=URL.createObjectURL(blob);urls.push(img.src);img.alt=`${i?'Clean':'Marked'} original context for problem ${index+1}`;refs.context.append(img);});
    await displayLeft(context.earlier&&context.original?'original':'before');if(token!==generation)return;
    const scene=api.capture(),location=adapter.candidate&&savedLocation(adapter.location(f.id),f.id,scene.review);
    const mark=currentAssociation(scene.returned,f.id,scene.review);
    const anchor=mark?.strokes.length?{page:mark.page,zoom:$('renderedZoom').value,...(mark.bounds?{point:[(mark.bounds[0]+mark.bounds[2])/2,(mark.bounds[1]+mark.bounds[3])/2]}:{})}:null;
    const asset=left==='original'?context.original:context.baseline;
    const estimate=approximatePosition(initial(asset),asset?.pages,scene.review.pages,$('renderedZoom').value);
    await api.positionView('rendered',readRevisionView(scene,f.id)??location?.position??anchor??estimate);if(token!==generation)return;
    viewScene=scene;viewPaused=false;refs.notice.textContent='';viewReady=true;refresh();await adapter.onSelect?.(index);controls();measureReport();
  }
  function refresh(){
    if(!adapter)return;const list=adapter.findings(),checked=list.filter(f=>adapter.decision(f.id)).length;
    const progress=`${checked} of ${list.length} corrections checked`;refs.progress.textContent=`${checked}/${list.length} checked`;refs.progress.title=progress;refs.progress.setAttribute('aria-label',progress);const local=$('roundProgress');if(local)local.textContent=progress;
    if(selected()){
      const decision=adapter.decision(selected().id),checked=Boolean(decision),status=adapter.state(selected().id);
      const outcome={needs_correction:'Still wrong',open:'Still wrong',needs_clarification:'Source unclear',needs_source_clarification:'Source unclear'}[decision?.state];
      refs.state.textContent=checked?(status.includes('Applied')?'Checked · Applied':outcome??'Checked'):'Unchecked';refs.state.title=findingTypeLabel(selected())+' · '+status;refs.state.dataset.checked=String(checked);refs.state.dataset.attention=String(Boolean(outcome));
      refs.picker.textContent=`Problems ${index+1}/${list.length}`;refs.picker.setAttribute('aria-label',`Browse reported problems. Problem ${index+1} of ${list.length}. ${selected().comment}`);
      refs.end.textContent=index===list.length-1?remainingText():`${list.filter(f=>!adapter.decision(f.id)).length} unchecked`;refs.end.title=refs.end.textContent;
    }
    if(problemsDialog.open)renderProblems();
    $('renderedLabel').textContent=adapter.candidate?'AI revision':'AI revision unavailable';controls();document.dispatchEvent(new Event('score-desk-comparison-selection'));
  }
  const roundSummary=installRoundSummary(api),summary={hidePopover:roundSummary.hide};
  const updateSummary=roundSummary.update,showSummary=roundSummary.show;
  function remainingText(){const remaining=adapter.findings().filter(f=>!adapter.decision(f.id)).length;return remaining?`${remaining} unchecked · Last problem`:'All corrections checked';}
  async function decide(state){
    const f=selected(),key=adapter.key,id=f.id,before=api.capture(),atEnd=index===adapter.findings().length-1;
    // Saving rebuilds Findings rows. Return to a stable correction control,
    // including on failure and the final approval, after controls are enabled.
    refs.focusAfter=state==='looks_correct'?refs.approve:refs.explanation;
    if(state!=='looks_correct'&&!refs.explanation.value.trim()){notify('Describe what is still wrong before saving.',true,'comparison-decision');refs.focusAfter=refs.explanation;return;}
    const saved=await adapter.saveDecision(id,state,refs.explanation.value);
    if(saved!==true)throw new Error('The decision was not saved. Your problem and draft are kept. Try again or download a backup.');
    if(adapter?.key!==key||selected()?.id!==id)return;
    refs.focusAfter=refs.approve;
    if(!atEnd)await select(index+1);else{showEditor(false,false);refresh();}
    notify('Decision saved locally.'+(index===adapter.findings().length-1?' '+remainingText()+'.':''));
    updateSummary();
    roundSummary.decisionSaved(before,{atEnd});
  }
  function setResponsiveView(){if(adapter)api.showScore(narrow.matches?'rendered':'both');}
  narrow.addEventListener('change',setResponsiveView);
  function secondary(kind){
    const head=$(`${kind}Viewer`).querySelector('.viewer-head'),strip=own(element('div',null,'review-pane-controls'),head),tools=element('div',null,'review-pane-actions'),menu=disclosure('View options',`${kind}ViewOptions`,'review-view-options');place($(`${kind}PageNavigation`),strip);strip.append(tools);tools.append(menu.details);
    return {tools,...menu};
  }
  async function open(next){
    if(suspended&&adapter?.key===next.key)return;
    suspended=false;
    if(adapter?.key===next.key){
      adapter=next;const list=next.findings(),retainedIndex=list.findIndex(f=>f.id===currentId);
      if(!list.length){close();return;}
      // Changing a reported correction's associated note to Comment removes it
      // from this queue without leaving its old text or approval controls active.
      if(currentId&&retainedIndex<0){initializing=true;try{opening=select(Math.min(index,list.length-1));await opening;}finally{opening=null;initializing=false;controls();}}
      else{if(retainedIndex>=0&&index!==retainedIndex){index=retainedIndex;await next.onSelect?.(index);}refresh();}
      updateSummary();return opening;
    }
    if(!next.findings().length){if(adapter)close();return;}
    generation++;summary.hidePopover();remember();viewReady=false;viewScene=null;problemsDialog.close();problemSearch.value='';unchecked.checked=false;restore();switchHome.append(scoreSwitch);adapter=next;$('renderedZoom').value='fit';positions=new Map();currentId=null;index=0;initializing=true;root.replaceChildren();header.replaceChildren();root.hidden=false;header.hidden=false;document.body.classList.add('corrections-open');
    header.setAttribute('aria-label','Correction review navigation');
    refs.back=button('Files & backups','correctionBack',()=>{closeMenus();$('workspaceTools').click();},false);header.append(refs.back);
    const more=disclosure('More','correctionMore');refs.more=more.details;header.append(more.details);
    refs.loadLatest=button('Load latest files','comparisonLoadLatest',()=>{closeMenus();$('loadLatest').click();},false);
    more.body.append(refs.loadLatest,button('Open AI response','comparisonImportResponse',()=>{closeMenus();$('importResponse').click();},false),button('Save backup','comparisonSaveReview',()=>{closeMenus();$('finishReview').click();},false));
    refs.folderStatus=element('small',$('folderStatus').textContent);refs.folderStatus.id='comparisonFolderStatus';refs.folderStatus.setAttribute('role','status');more.body.append(refs.folderStatus);
    refs.progress=element('span');refs.progress.id='correctionProgress';refs.state=element('span',null,'correction-state');refs.state.id=next.ids.state;
    const navigation=element('div',null,'correction-navigation');header.prepend(navigation);
    refs.picker=button('Problems',next.ids.picker??'correctionFinding',showProblems,false);refs.picker.className='problem-picker';refs.picker.setAttribute('aria-haspopup','dialog');refs.picker.setAttribute('aria-controls','correctionProblems');
    refs.comments=button('Comments','comparisonComments',async()=>{closeMenus();await adapter.showComments?.();});refs.comments.setAttribute('aria-haspopup','dialog');refs.comments.setAttribute('aria-controls','returnedCommentsDialog');refs.comments.hidden=!(next.comments?.().length);
    navigation.append(refs.picker,refs.progress);header.insertBefore(refs.comments,refs.back);refs.findings=button('Findings','comparisonFindings',()=>api.toggleFindings(),false);refs.findings.setAttribute('aria-controls','commentsPanel');header.insertBefore(refs.findings,refs.back);
    const ai=disclosure('AI’s explanation','correctionAI');refs.aiDetails=ai.details;refs.ai=element('p');ai.body.append(refs.ai,button('Close','closeAIExplanation',()=>{ai.details.open=false;ai.summary.focus();},false));
    refs.reportBody=element('div',null,'correction-report');refs.original=element('p');refs.original.id='correctionOriginal';refs.original.tabIndex=0;
    const copy=element('div',null,'correction-copy');refs.expand=button('Read full report','expandCorrectionReport',()=>{const expanded=root.classList.toggle('report-expanded');refs.expand.textContent=expanded?'Collapse report':'Read full report';measureReport();},false);refs.expand.className='quiet';copy.append(refs.original,refs.expand);refs.reportBody.append(refs.state,copy,ai.details);root.append(refs.reportBody);reportSize.disconnect();reportSize.observe(refs.original);
    refs.history=element('p',null,'correction-history-hint');refs.history.id='correctionHistoryLabel';copy.append(refs.history);
    const noteActions=element('div',null,'correction-note-actions');noteActions.setAttribute('aria-label','Note on this finding');
    refs.addNote=button('Add note','locateRegion',async()=>{await adapter.addNote?.(selected().id);});
    refs.showNote=button('Show note','showRegion',async()=>{await adapter.showNote?.(selected().id);});
    noteActions.append(refs.addNote,refs.showNote);noteActions.hidden=!next.note;copy.prepend(noteActions);
    refs.actions=element('div',null,'correction-actions');refs.approve=button('Looks correct',next.ids.approve,()=>decide('looks_correct'),true,'comparison-decision');refs.approve.className='primary';refs.reject=button('Still wrong…',next.ids.reject,focusEditor,false);refs.skip=button('Next','skipCorrection',async()=>{refs.focusAfter=refs.skip;if(index<adapter.findings().length-1)await select(index+1);else roundSummary.endReached();});
    for(const [control,key,description] of [[refs.approve,'C','Looks correct. Advance after the decision is saved.'],[refs.reject,'W','Open the Still wrong explanation editor.'],[refs.skip,'X','Next finding without recording a decision']]){
      const label=control.textContent,index=label.toLowerCase().indexOf(key.toLowerCase());
      if(index>=0)control.replaceChildren(label.slice(0,index),element('u',label[index]),label.slice(index+1));
      else{const hint=element('kbd',key);hint.setAttribute('aria-hidden','true');control.append(' ',hint);control.setAttribute('aria-label',label);control.setAttribute('aria-description',description);}
      control.setAttribute('aria-keyshortcuts',key.toLowerCase());if(control===refs.skip)control.setAttribute('aria-description',description);control.title=control===refs.skip?description:key+': '+description;
    }
    refs.summary=button('Summary','openRoundSummary',showSummary,false);refs.summary.setAttribute('aria-label','Round summary');refs.summary.title='Open round summary';refs.end=element('span',null,'correction-end');refs.end.id='correctionEnd';refs.end.setAttribute('role','status');
    refs.actions.append(refs.approve,refs.reject,refs.skip,refs.summary);root.prepend(refs.actions);root.append(refs.end);
    refs.editor=element('form',null,'correction-response');refs.editor.id='correctionResponse';refs.editor.hidden=true;refs.editor.onsubmit=guarded(async event=>{event.preventDefault();await decide(refs.clarify.checked?'needs_clarification':'needs_correction');},'comparison-decision');
    // Prevent native form navigation even when the guard is busy.
    refs.editor.addEventListener('submit',event=>event.preventDefault());
    const label=element('label','What is still wrong?');refs.explanation=element('textarea');refs.explanation.id=next.ids.explanation;refs.explanation.rows=2;refs.explanation.maxLength=4000;refs.explanation.setAttribute('aria-keyshortcuts','Enter');refs.explanation.oninput=saveDraft;label.append(refs.explanation);
    const responseActions=element('div',null,'response-actions');refs.send=button('Save correction','sendCorrectionResponse',()=>decide(refs.clarify.checked?'needs_clarification':'needs_correction'),true,'comparison-decision');const cancel=button('Cancel','cancelCorrectionResponse',()=>showEditor(false),false);responseActions.append(refs.send,cancel);
    const clarifyLabel=element('label','The printed source is unclear');refs.clarify=element('input');refs.clarify.id=next.ids.clarify;refs.clarify.type='checkbox';refs.clarify.onchange=saveDraft;clarifyLabel.prepend(refs.clarify);clarifyLabel.className='source-unclear';refs.draft=element('span',null,'response-draft');refs.draft.id='correctionDraftStatus';refs.draft.setAttribute('role','status');refs.editor.append(label,responseActions,clarifyLabel,refs.draft);root.append(refs.editor);
    root.append(scoreSwitch);$('showSource').textContent='Before correction';$('showRendered').textContent='AI revision';setResponsiveView();
    const source=secondary('source');refs.sourceOptions=source.details;refs.sourcePageSummary=source.summary;
    refs.sourceToggle=button('Check printed source','checkPrintedSource',async()=>{const page=Number($('sourcePage').value)||1;remember();await displayLeft(left==='source'?priorLeft:'source',left==='source'?null:{page,zoom:'fit'});});source.tools.prepend(refs.sourceToggle);
    refs.left=element('select');refs.left.id='comparisonLeft';refs.left.setAttribute('aria-label','Version shown before correction');refs.left.onchange=guarded(async()=>{const mode=refs.left.value;remember();await displayLeft(mode);});source.body.append(refs.left);
    const otherLabel=element('label','Show other reported errors');refs.others=element('input');refs.others.id='otherHistoricalMarks';refs.others.type='checkbox';refs.others.onchange=guarded(async()=>{remember();await displayLeft(left);});otherLabel.prepend(refs.others);source.body.append(otherLabel);
    refs.originalVersion=button('Show the earlier version','showOriginalVersion',async()=>{remember();await displayLeft('original');});source.body.append(refs.originalVersion);
    const original=disclosure('Original marked context','originalReportedContext','correction-context');refs.earlier=element('p');refs.context=element('div');original.body.append(refs.earlier,refs.context);source.body.append(original.details);
    const after=secondary('rendered');refs.afterOptions=after.details;refs.afterPageSummary=after.summary;
    // Page and zoom controls are already visible; there are no secondary
    // commands left on the current revision after automatic view memory.
    after.details.remove();
    refs.report=button('Report another error','reportAnotherError',()=>{closeMenus();$('newFinding').click();},false);after.tools.prepend(refs.report);
    $('saveFinding').textContent='Save note';
    refs.missing=element('p',null,'correction-missing');refs.missing.hidden=Boolean(next.candidate);refs.missing.append(element('span','Add the revised PDF before checking this correction. '),button('Add revised PDF','addMissingRevision',()=>$('workspaceTools').click(),false));root.append(refs.missing);
    refs.notice=element('span');refs.notice.id='correctionNotice';refs.notice.hidden=true;root.append(refs.notice);
    try{controls();opening=select(0);await opening;}finally{if(adapter?.key===next.key){opening=null;initializing=false;controls();document.dispatchEvent(new Event('score-desk-controls'));updateSummary();}}
  }
  function close(){if(editorOpen&&adapter?.candidate&&api.status().dirty)void api.saveNow();rememberAIView();viewReady=false;viewScene=null;summary.hidePopover();suspended=false;adapter=null;generation++;opening=null;initializing=false;currentId=null;root.hidden=true;header.hidden=true;problemsDialog.close();restore();api.folder?.setHeaderBusy(false);$('saveFinding').textContent='Done';switchHome.append(scoreSwitch);for(const url of urls)URL.revokeObjectURL(url);urls=[];document.body.classList.remove('corrections-open','corrections-annotating');$('showSource').textContent='Source';$('showRendered').textContent='Rendered';$('sourceLabel').textContent='Original source';document.dispatchEvent(new Event('score-desk-controls'));}
  document.addEventListener('keydown',event=>{if(!adapter||event.key!=='Escape'||event.isComposing||document.querySelector('dialog[open]'))return;const menu=[refs.more,refs.aiDetails,refs.sourceOptions,refs.afterOptions].find(item=>item?.open);if(menu){event.preventDefault();event.stopImmediatePropagation();menu.open=false;menu.querySelector('summary').focus();}else if(editorOpen){event.preventDefault();event.stopImmediatePropagation();showEditor(false);}},true);
  document.addEventListener('score-desk-controls',controls);
  document.addEventListener('score-desk-folder-status',controls);
  document.addEventListener('score-desk-save-status',()=>{controls();draftStatus();});
  document.addEventListener('score-desk-change',()=>{if(adapter&&!adapter.matches(api.capture()))close();});
  const heldKeys=new Set();let composing=false;
  document.addEventListener('compositionstart',()=>composing=true);document.addEventListener('compositionend',()=>composing=false);
  document.addEventListener('keyup',event=>{const key=event.key.toLowerCase();if(key==='enter'&&heldKeys.has(key)&&!event.isComposing&&!composing){event.preventDefault();event.stopImmediatePropagation();}heldKeys.delete(key);},true);window.addEventListener('blur',()=>heldKeys.clear());
  document.addEventListener('keydown',event=>{
    const key=event.key.toLowerCase(),ime=event.isComposing||composing||event.keyCode===229;
    // This editor owns Save correction. Dispatch its existing guarded button,
    // never the main note editor's Done command, and retain ownership to keyup.
    if(key==='enter'&&heldKeys.has(key)){if(!ime){event.preventDefault();event.stopImmediatePropagation();}return;}
    const enterControl=editorOpen&&event.target===refs.explanation?refs.send:[refs.approve,refs.reject,refs.skip,refs.send].includes(event.target)?event.target:null;
    if(key==='enter'&&adapter&&enterControl&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
      if(event.defaultPrevented||ime||document.querySelector('dialog[open]'))return;
      event.preventDefault();event.stopImmediatePropagation();
      if(!event.repeat&&!enterControl.disabled){heldKeys.add(key);enterControl.click();}return;
    }
    if(!['c','w','x'].includes(key))return;
    const held=heldKeys.has(key);heldKeys.add(key);
    const status=api.status(),folder=api.folder?.getState();
    if(event.defaultPrevented||event.repeat||held||event.isComposing||composing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||!adapter||suspended||pending||initializing||!viewReady||editorOpen||status.busy||status.dirty||status.saveConflict||folder?.selecting||status.active||status.prepared||status.gesture)return;
    if(document.querySelector('dialog[open],:popover-open,.application-menu:not([hidden]),.paper[aria-busy="true"],.paper[data-resize-pending="true"]')||event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),#notices,details[open]'))return;
    const control={c:refs.approve,w:refs.reject,x:refs.skip}[key];if(control.disabled)return;
    event.preventDefault();event.stopImmediatePropagation();control.click();
  },true);
  return {open,refresh,close,showSummary,summaryTask:roundSummary.task,rememberView:rememberAIView,pauseViewForNote,
    selectFinding:guarded(async id=>{const next=adapter?.findings().findIndex(f=>f.id===id);if(next==null||next<0)return;if(suspended){suspended=false;root.hidden=false;header.hidden=false;document.body.classList.add('corrections-open');}api.clearFindingSelection?.();await select(next);document.dispatchEvent(new Event('score-desk-controls'));}),
    async proofread(){if(!adapter)return;remember();currentId=null;suspended=true;summary.hidePopover();root.hidden=true;header.hidden=true;document.body.classList.remove('corrections-open','corrections-annotating');await api.showHistorical(null,{page:1,zoom:'fit'},false);$('sourceLabel').textContent='Original source';$('renderedLabel').textContent='Current transcription';document.dispatchEvent(new Event('score-desk-controls'));},
    async resume(){if(!adapter)return;suspended=false;root.hidden=false;header.hidden=false;document.body.classList.add('corrections-open');await select(index);document.dispatchEvent(new Event('score-desk-controls'));},selected:()=>index,select:guarded(select),state:()=>({key:adapter?.key,suspended,findingId:selected()?.id,left,pending:pending||initializing})};
}
