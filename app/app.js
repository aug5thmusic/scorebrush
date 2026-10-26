// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {reviewRound,reviewSummary} from './round-model.js';
import {currentAssociation} from './comparison-model.js';
import {findingRows,findingRowKey,sortFindingRows} from './findings-model.js';
import * as pdfjs from './vendor/pdf.mjs';
import {pdfResourceUrls,pdfWorkerUrl} from './pdf-resources.js';
import {clone,annotationSnapshot,identify,newReview,bounds,paint,hitFinding,validateReview,roles,PALETTE,FINDING_TYPES,findingType,findingTypeLabel,isComment} from './model.js';
import {getSaved,getSavedState,putSaved,listSaved,recoveryIdentity,StorageConflictError} from './storage.js';
import {makeRecovery,makePackage,zipFiles} from './export.js';
import {installHandoff} from './handoff-ui.js';
import {retain,retained} from './handoff-store.js';
import {makeReturnedBackup,restoreInstructionHistory} from './returned.js';
import {mergeCompletions,exactReview,canonical} from './completion-model.js';
import {addCompletionHistory} from './completion.js';
import {installCompletion} from './completion-ui.js';
import {installComparison} from './comparison-ui.js';
import {installFolderWorkspace,handoffCounts} from './folder-workspace.js';
import {installStatus} from './status-ui.js';
import {installWorkspaceLayout} from './workspace-layout.js';
import {installBrushPreview} from './brush-preview.js';
import {installDesktop} from './desktop.js';
import {installApplicationShell} from './application-shell.js';
import {createPageScrollGesture,pageScrollPreferenceKey} from './pdf-page-scroll.js';
pdfjs.GlobalWorkerOptions.workerSrc=pdfWorkerUrl;
const $=id=>document.getElementById(id);
const activeReviewKey='private-score-desk-active-review';
let review=null, files=null, active=null, mode='navigate', gesture=null, undo=[],redo=[], busy=false,revision=0,dirty=false;
let persistedRevision=null,saveConflict=false,recoveryStamp=null,recoveryJob=null;
let returned=null,comparison=null;
let leftDisplay=null;
let prepared=false,preparedType='correction',pendingReportedId=null,composing=false,annotationEdit=null;
let findingFocus=null,findingFocusTimer=null,findingFocusSequence=0;
const findingFilter={type:'all',unresolved:false};
const findingOrderKey='score-desk-findings-order-v1';
let findingOrder='newest',findingEnterHeld=false;
try{if(localStorage.getItem(findingOrderKey)==='oldest')findingOrder='oldest';}catch{/* Interface preferences cannot block review storage. */}
let scrollBetweenPages=false;
try{scrollBetweenPages=localStorage.getItem(pageScrollPreferenceKey)==='true';}catch{/* Interface preferences cannot block review storage. */}
const pageScrollGestures=new Map();
function togglePageScrolling(){
  scrollBetweenPages=!scrollBetweenPages;
  for(const controller of pageScrollGestures.values())controller.block();
  try{localStorage.setItem(pageScrollPreferenceKey,String(scrollBetweenPages));}catch{/* Keep the session preference when local storage is unavailable. */}
  document.dispatchEvent(new Event('score-desk-controls'));
}
const dialogOpen=()=>Boolean(document.querySelector('dialog[open]'));
const canEdit=()=>Boolean(review&&!busy&&!comparison&&!dialogOpen());
let revisionId=crypto.randomUUID(),completions=[];
let projectContext={};
const recordKey=()=>returned?.id??review?.snapshotId;
const stamp=()=>({snapshotId:review?.snapshotId,workspaceId:returned?.id??null,revision});
const matchesStamp=value=>value?.snapshotId===review?.snapshotId&&(value?.workspaceId??null)===(returned?.id??null)&&value?.revision===revision;
const unprotectedWork=()=>Boolean(review&&(dirty||saveFailed)&&!matchesStamp(recoveryStamp));
for(const entry of PALETTE)$('highlightColor').add(new Option(entry.name,entry.color));
const views=Object.fromEntries(['source','rendered'].map(kind=>[kind,{kind,doc:null,page:1,viewport:null,serial:0,task:null}]));
let resizeTimer=0,resizeDeferred=false,resizeFrame=0;
for(const kind of ['source','rendered']){
  const pane=$(`${kind}Viewer`),navigation=document.createElement('div');navigation.id=`${kind}PageNavigation`;navigation.className='review-page-navigation';navigation.setAttribute('role','group');navigation.setAttribute('aria-label',kind==='source'?'Left score page navigation':'Rendered score page navigation');
  navigation.append(pane.querySelector('.page-controls'));pane.querySelector('.viewer-head').append(navigation);
}
export let completion;
let statusUI,storageProblem='';
function noticeLayout(){statusUI?.refresh();}
function message(...args){statusUI?.message(...args);}
function clearMessage(scope){statusUI?.clearProblem(scope);}
function storageStatus(text,problem=''){storageProblem=problem;statusUI?.storage(text,problem);document.dispatchEvent(new Event('score-desk-save-status'));}
const shortcutModifier=/Mac|iPhone|iPad/.test(navigator.userAgentData?.platform??navigator.platform)?'Cmd':'Ctrl';
for(const label of document.querySelectorAll('[data-shortcut-modifier]'))label.textContent=shortcutModifier;
$('doneNext').title=`Finish this group and prepare the next (${shortcutModifier}+Enter)`;
function guard(fn,scope=Symbol('operation')){return async (...args)=>{try{if(await fn(...args)!==false)clearMessage(scope);}catch(e){console.error(e);message(e.message,true,scope);}};}
// Annotation history includes its links, but never rolls back human decisions.
function annotationState(){return {review:annotationSnapshot(review),active,prepared,preparedType,pendingReportedId,workspaceId:returned?.id,associations:returned?.reported.map(f=>[f.id,f.associationId])};}
function endAnnotationEdit({flush=false}={}){annotationEdit=null;if(flush&&dirty)void saveNow();}
function checkpoint(){endAnnotationEdit();undo.push(annotationState());if(undo.length>80)undo.shift();redo=[];}
// Text and marks remain locally autosaved as they change, but one annotation
// editing session is one Undo action. Save, selection and standalone commands
// close that session; another mutation starts from the whole prior annotation.
function annotationCheckpoint(){
  if(annotationEdit?.findingId===active)return;
  checkpoint();annotationEdit={findingId:active};
}
function historyControls(){$('undo').disabled=!undo.length||!canEdit();$('redo').disabled=!redo.length||!canEdit();}
function changed({draft=false,typing=false}={}){revision++;revisionId=crypto.randomUUID();dirty=true;review.updatedAt=new Date().toISOString();historyControls();document.dispatchEvent(new CustomEvent('score-desk-change',{detail:{draft,typing}}));if(draft){const row=[...$('findings').children].find(el=>el.dataset.findingId===active);if(row?.dataset.reportedId)renderFindingList();else if(row)row.querySelector('.finding-comment').textContent=current()?.comment||'(Comment not entered)';}else{renderFindings();drawOverlay();}scheduleSave({typing});}
function controls(){
  for(const id of ['newFinding','navigate','draw','undo','redo','brush','hide','highlightColor','autoColor','comment','findingType','findingState','saveFinding','doneNext','deleteFinding'])$(id).disabled=!canEdit();
  for(const region of [document.querySelector('main'),document.querySelector('.toolbar'),$('filesPanel')])region.inert=busy;
  $('commentsPanel').inert=busy||(matchMedia('(max-width:899px)').matches&&!document.body.classList.contains('comments-open'));
  $('load').disabled=busy;$('reopen').disabled=busy;historyControls();
  for(const el of document.querySelectorAll('[data-handoff-action]'))el.disabled=busy||(el.dataset.needsReview!==undefined&&!review);
  $('findingState').disabled=!current()||!canEdit();$('deleteFinding').disabled=!current()||!canEdit();
  $('hide').disabled=!review||busy;
  // Comparison temporarily owns these controls. Recompute their ordinary
  // state when switching from a returned review to another saved workspace.
  for(const kind of ['source','rendered'])for(const control of $(`${kind}Viewer`).querySelectorAll('.page-controls button,.page-controls input,.page-controls select'))control.disabled=busy||!views[kind].doc;
  const annotations=new Map((review?.findings??[]).map(f=>[f.id,f]));
  $('comparisonControl').hidden=!returned?.reported.some(f=>{const note=annotations.get(f.associationId);return !isComment(note&&Object.hasOwn(note,'type')?note:f);});
  setFindingTitle(comparison?'Previous rendering · read only':current()?findingTitle(current()):'New finding · type or draw');
  noticeLayout();
  for(const button of document.querySelectorAll('.finding-open')){const historical=Boolean(button.closest('[data-reported-id]'));button.disabled=historical?busy:!canEdit();button.title=!historical&&comparison?'Switch to the current rendering to select current marks.':'';}
  for(const button of document.querySelectorAll('#findings .finding-delete'))button.disabled=!canEdit();
  for(const control of document.querySelectorAll('#findingFilters input,#findingFilters select,#resetFindingFilters'))control.disabled=!review||busy;
  document.dispatchEvent(new Event('score-desk-controls'));
}
function setMode(next){cancelFindingFocus();cancelGesture();mode=next;document.body.classList.toggle('drawing',mode==='draw');$('draw').setAttribute('aria-pressed',String(mode==='draw'));$('navigate').setAttribute('aria-pressed',String(mode==='navigate'));document.dispatchEvent(new Event('score-desk-controls'));}
function resumeResize(){if(resizeDeferred&&!resizeFrame)resizeFrame=requestAnimationFrame(()=>{resizeFrame=0;flushResize();});}
function cancelGesture(){if(gesture?.pointerId!==undefined&&$('overlay').hasPointerCapture(gesture.pointerId))$('overlay').releasePointerCapture(gesture.pointerId);gesture=null;drawOverlay();resumeResize();}
let documentWorker=null;
function pdfWorker(){
  if(!documentWorker||documentWorker.destroyed){const worker=documentWorker=new pdfjs.PDFWorker();worker.promise.catch(()=>{if(documentWorker===worker)documentWorker=null;});}
  return documentWorker;
}
async function openPdf(blob){
  const worker=pdfWorker(),task=pdfjs.getDocument({worker,data:new Uint8Array(await blob.arrayBuffer()),...pdfResourceUrls,cMapPacked:true,isEvalSupported:false,enableXfa:false});
  try{return await task.promise;}catch(error){try{await task.destroy();}catch{}throw error;}
}
async function openPdfPair(nextFiles){
  // One explicitly owned worker serves independent document channels. Drain
  // both loads on failure before abandoning the newly opened documents.
  const results=await Promise.allSettled(['source','rendered'].map(role=>openPdf(nextFiles[role].blob)));
  const failure=results.find(result=>result.status==='rejected');
  if(failure){await Promise.allSettled(results.filter(result=>result.status==='fulfilled').map(result=>result.value.destroy()));throw failure.reason;}
  return results.map(result=>result.value);
}
async function openSnapshot(nextFiles=null,targetId=null,imported=null,seed=null,force=false,completionBundle=null,lineage={}){
  if(busy)return;
  // Lock before the first await. In particular, never prefetch Reopen's record
  // before flushing the current edits, and never reinstall the active snapshot.
  busy=true;controls();cancelGesture();
  const docs=[];
  try{
    await saveNow();
    if(unprotectedWork())throw new Error('The current review could not be saved. Download a recovery ZIP containing the latest edits before opening another snapshot.');
    if(!force&&seed?.returned.id===returned?.id&&returned){message('Returned revision resumed: latest annotations and decisions kept.');return;}
    if(!force&&!imported&&targetId&&targetId===recordKey()){message('Reopened the current snapshot: latest edits and undo history kept.');return;}
    let stored=null,readFailure=null;
    if(targetId){stored=await getSaved(targetId);if(!stored)throw new Error('Snapshot no longer available.');nextFiles=stored.files;}
    message('Hashing selected bytes and loading PDFs…');
    // Picker File objects can become unreadable when an external editor saves
    // over their paths. Keep owned bytes for previous-render comparisons.
    nextFiles=Object.fromEntries(await Promise.all(roles.map(async role=>{const entry=nextFiles[role];return [role,entry.blob instanceof File?{...entry,blob:new Blob([await entry.blob.arrayBuffer()],{type:entry.blob.type})}:entry];})));
    const {identity,snapshotId}=await identify(nextFiles);
    if(!force&&!seed&&!returned&&!stored?.returned&&!imported&&snapshotId===review?.snapshotId){message('Reopened the current snapshot: latest edits and undo history kept.');return;}
    if(!stored)try{stored=await getSaved(seed?.returned.id??snapshotId);}catch(error){readFailure=error;}
    // Renaming byte-identical picker inputs resumes the retained snapshot,
    // including the original names recorded in its exact annotation evidence.
    const retainedReview=!imported&&!seed&&Boolean(stored);
    if(retainedReview)nextFiles=stored.files;
    docs.push(...await openPdfPair(nextFiles));
    const pages=[];for(let i=1;i<=docs[1].numPages;i++){const p=await docs[1].getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}
    const expected=newReview(retainedReview?stored.review.files:identity,snapshotId,pages);
    let nextReview=stored?.returned?validateReview(stored.review,expected):imported?validateReview(imported,expected):stored?validateReview(stored.review,expected):expected;
    let nextReturned=clone(stored?.returned??seed?.returned??null);
    const restoredInstructions=await restoreInstructionHistory(nextReturned);
    const bundle=completionBundle??seed?.completionBundle,nextCompletions=mergeCompletions(stored?.completions,bundle?.records);
    const nextRevisionId=bundle?.revisionId??((!imported||seed&&stored)?stored?.revisionId:null)??crypto.randomUUID();
    const issued=seed?await retained(nextReturned.taskId):null;
    const parentWorkspaceId=stored?.parentWorkspaceId??lineage.parentWorkspaceId??nextReturned?.recoveredFrom??issued?.task.parent?.workspaceId??issued?.task.baseline.snapshotId??null;
    const parent=parentWorkspaceId?await getSaved(parentWorkspaceId):null;
    const initialName=stored&&Object.hasOwn(stored,'initialTranscriptionFilename')?stored.initialTranscriptionFilename:Object.hasOwn(lineage,'initialTranscriptionFilename')?lineage.initialTranscriptionFilename:parent&&Object.hasOwn(parent,'initialTranscriptionFilename')?parent.initialTranscriptionFilename:seed?(issued?.task.version===1?issued.review.files.rendered.name:null):stored||imported?null:nextFiles.rendered.name;
    const nextProject={projectId:stored?.projectId??lineage.projectId??parent?.projectId,
      initialTranscriptionFilename:initialName,pdfOutput:stored?.pdfOutput??parent?.pdfOutput??lineage.pdfOutput,parentWorkspaceId};
    // Portable revision metadata hashes exact annotation bytes, even when it
    // contains no legacy completion records. Reopening is not an annotation edit.
    if(bundle||nextCompletions.length)nextReview=exactReview(nextReview,(stored?.returned?stored.review:imported??stored?.review)??nextReview);
    else if(stored&&!imported&&typeof stored.review.updatedAt==='string')nextReview.updatedAt=stored.review.updatedAt;
    if(seed&&!stored){
      if(readFailure)throw readFailure;
      try{stored=await operations.putSaved({...nextProject,id:nextReturned.id,review:nextReview,files:nextFiles,returned:nextReturned,revisionId:nextRevisionId,completions:nextCompletions},null);}
      catch(e){if(e.name!=='StorageConflictError')throw e;stored=await getSaved(nextReturned.id);if(!stored)throw e;nextReview=validateReview(stored.review,expected);nextReturned=stored.returned;if(stored.completions?.length)nextReview=exactReview(nextReview,stored.review);else if(typeof stored.review.updatedAt==='string')nextReview.updatedAt=stored.review.updatedAt;}
    }
    if(imported&&readFailure)throw new Error('Local storage could not be read. The current review is unchanged. Download recovery and retry.');
    if(window.chrome?.webview&&imported&&stored&&(canonical(stored.review)!==canonical(nextReview)||bundle?.revisionId&&stored.revisionId!==bundle.revisionId))throw new Error('This backup differs from an existing desktop review of the same revision. Neither was replaced. Keep both backups and recover the other copy in a separate browser profile for comparison.');
    if(imported&&!seed&&stored)await retain({id:crypto.randomUUID(),kind:'review-backup',createdAt:new Date().toISOString(),review:stored.review,files:stored.files});
    // A backup import must pass its global immutable-ID checks and CAS
    // before replacing the visible ordinary review, just like returned seeds.
    if(bundle&&!seed)stored=await operations.putSaved({...nextProject,id:snapshotId,review:nextReview,files:nextFiles,returned:nextReturned,revisionId:nextRevisionId,completions:nextCompletions},stored?(stored.storageRevision??0):null);
    await clearLeftDisplay();
    if(comparison){views.rendered.doc=comparison.current;await comparison.previous.destroy();comparison=null;}
    for(const v of Object.values(views)){v.serial++;v.task?.cancel();if(v.task)try{await v.task.promise;}catch{}await v.doc?.destroy();}
    files=nextFiles;review=nextReview;returned=clone(nextReturned);revision++;dirty=restoredInstructions||(seed||bundle?false:Boolean(imported)||!stored);persistedRevision=stored?(stored.storageRevision??0):null;
    projectContext={...nextProject,projectId:stored?.projectId??nextProject.projectId};
    revisionId=stored?.returned&&!bundle?stored.revisionId??nextRevisionId:nextRevisionId;completions=mergeCompletions(stored?.completions,nextCompletions);
    saveFailed=false;saveConflict=false;recoveryStamp=null;active=null;prepared=false;preparedType='correction';pendingReportedId=null;undo=[];redo=[];endAnnotationEdit();
    // These failures belonged to the review we have successfully replaced.
    for(const scope of ['import-review','recovery','finding','stroke-limit','export','review-reload','load-review','reopen-review','returned-reload','comparison-decision','comparison-draft','completion'])clearMessage(scope);
    document.dispatchEvent(new Event('score-desk-change'));
    $('emergency').hidden=true;storageStatus(stored?'Saved locally':'Saving…');
    views.source.doc=docs[0];views.rendered.doc=docs[1];
    for(const v of Object.values(views)){
      v.page=1;v.viewport=null;$(`${v.kind}Page`).value='1';$(`${v.kind}Page`).max=v.doc.numPages;$(`${v.kind}Count`).textContent=`/ ${v.doc.numPages}`;$(`${v.kind}Scroll`).scrollTo(0,0);
    }
    $('filesPanel').open=false;$('workspaceDialog').close();document.body.classList.add('review-open');setMode('navigate');renderFindings();await Promise.all(Object.values(views).map(renderPage));if(readFailure)storageFailure(readFailure);await saveNow();
    try{localStorage.setItem(activeReviewKey,recordKey());}catch{/* Review storage still works if preference storage is unavailable. */}
    message(returned?'Returned revision ready. Check each correction against the previous rendering; use Check printed source when needed.':imported?'Package opened. Exact inputs, comments, and marks restored; prior saved review retained.':stored?'Reopened the review for these exact file bytes.':'Ready. Draw a passage or choose New finding to type a correction.');
  }catch(e){for(const doc of docs)if(doc!==views.source.doc&&doc!==views.rendered.doc)await doc.destroy();throw e;}
  finally{busy=false;controls();}
}
function cancelWheelZoom(v){cancelAnimationFrame(v.wheelFrame);v.wheelFrame=0;delete v.wheelZoom;}
async function renderPage(v,{wheelZoom}={}){
  if(wheelZoom){if(v.wheelZoom!==wheelZoom||v.doc!==wheelZoom.doc||v.page!==wheelZoom.page)return;}
  else cancelWheelZoom(v);
  if(!v.doc||!$(`${v.kind}Scroll`).clientWidth)return;
  const padding=v.scrollPaddingScene;if(padding&&(padding.doc!==v.doc||padding.page!==v.page||padding.zoom!==$(`${v.kind}Zoom`).value)){$(`${v.kind}Paper`).style.marginBottom='';delete v.scrollPaddingScene;}
  if(v.kind==='rendered'&&gesture)cancelGesture();
  const serial=++v.serial;v.viewport=null;$(`${v.kind}Paper`).setAttribute('aria-busy','true');document.dispatchEvent(new Event('score-desk-render'));
  let page;try{page=await v.doc.getPage(v.page);}catch(error){if(serial!==v.serial)return;throw error;}if(serial!==v.serial)return;
  const base=page.getViewport({scale:1}),z=$(`${v.kind}Zoom`).value;
  const scale=z==='fit'?Math.max(.15,($(`${v.kind}Scroll`).clientWidth-38)/base.width):Number(z);
  const viewport=page.getViewport({scale});
  v.task?.cancel();if(v.task)try{await v.task.promise;}catch{}
  if(serial!==v.serial)return;
  const canvas=$(`${v.kind}Canvas`),paper=$(`${v.kind}Paper`),dpr=Math.min(window.devicePixelRatio||1,3);
  canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=`${viewport.width}px`;canvas.style.height=`${viewport.height}px`;paper.style.width=`${viewport.width}px`;paper.style.height=`${viewport.height}px`;paper.hidden=false;
  if(v.kind==='rendered'){$('overlay').width=canvas.width;$('overlay').height=canvas.height;$('overlay').style.width=canvas.style.width;$('overlay').style.height=canvas.style.height;}
  v.task=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[dpr,0,0,dpr,0,0]});
  try{await v.task.promise;}catch(e){if(e.name!=='RenderingCancelledException'&&serial===v.serial)throw e;return;}
  if(serial!==v.serial)return;v.viewport=viewport;v.dpr=dpr;$(`${v.kind}Paper`).setAttribute('aria-busy','false');drawOverlay();drawHistorical();clearMessage('render-'+v.kind);
  if(wheelZoom&&v.wheelZoom===wheelZoom){
    delete v.wheelZoom;
    const scroll=$(`${v.kind}Scroll`),rect=paper.getBoundingClientRect(),[x,y]=viewport.convertToViewportPoint(...wheelZoom.point);
    scroll.scrollBy(rect.left+x*rect.width/viewport.width-wheelZoom.clientX,rect.top+y*rect.height/viewport.height-wheelZoom.clientY);
  }else if(v.position){
    const position=v.position;delete v.position;
    if(!position.isCurrent||position.isCurrent()){
      centerView(v,position.point);
    }
  }
  document.dispatchEvent(new Event('score-desk-render'));
}
function centerView(v,point){
  const box=v.viewport.viewBox,clamped=point.map((n,i)=>Math.max(box[i],Math.min(box[i+2],Number.isFinite(n)?n:box[i]))),[x,y]=v.viewport.convertToViewportPoint(...clamped),scroll=$(`${v.kind}Scroll`);
  scroll.scrollTo(x+10-scroll.clientWidth/2,y+10-scroll.clientHeight/2);
  if(v.kind==='rendered'&&findingFocus)findingFocus.scroll=[scroll.scrollLeft,scroll.scrollTop];
}
function viewPosition(kind){
  const v=views[kind],scroll=$(`${kind}Scroll`);if(!v.viewport)return null;
  const point=v.viewport.convertToPdfPoint(Math.max(0,Math.min(v.viewport.width,scroll.scrollLeft+scroll.clientWidth/2-10)),Math.max(0,Math.min(v.viewport.height,scroll.scrollTop+scroll.clientHeight/2-10)));
  return {page:v.page,point,zoom:$(`${kind}Zoom`).value==='fit'?'fit':Number($(`${kind}Zoom`).value)};
}
async function positionView(kind,position,{isCurrent}={}){
  if(isCurrent&&!isCurrent())return;
  const v=views[kind];if(!v.doc)return;
  v.page=Math.max(1,Math.min(v.doc.numPages,position?.page??1));
  $(`${kind}Page`).value=v.page;$(`${kind}Page`).max=v.doc.numPages;$(`${kind}Count`).textContent=`/ ${v.doc.numPages}`;
  if(position?.zoom){
    const zoom=$(`${kind}Zoom`),savedZoom=String(position.zoom);
    // Older bookmarks retain their exact data even when their zoom is no longer offered.
    zoom.value=[...zoom.options].some(option=>option.value===savedZoom)?savedZoom:'fit';
  }
  delete v.position;if(position?.point)v.position={...position,point:[...position.point],isCurrent};else $(`${kind}Scroll`).scrollTo(0,0);
  await renderPage(v);
}
async function clearLeftDisplay(){
  if(!leftDisplay)return;
  const display=leftDisplay;leftDisplay=null;
  views.source.serial++;views.source.task?.cancel();if(views.source.task)try{await views.source.task.promise;}catch{}
  views.source.doc=display.source;
  for(const doc of display.documents.values())await doc.destroy();
  $('historicalOverlay').hidden=true;
}
async function showHistorical(asset,position,showOthers=false){
  // This changes display documents only. files.source and review.files never change.
  if(!leftDisplay)leftDisplay={source:views.source.doc,documents:new Map(),asset:null};
  const display=leftDisplay,v=views.source;
  let doc=display.source;
  if(asset){
    doc=display.documents.get(asset.sha256);
    if(!doc){doc=await openPdf(asset.blob);if(leftDisplay!==display){await doc.destroy();return;}display.documents.set(asset.sha256,doc);}
  }
  v.serial++;v.task?.cancel();if(v.task)try{await v.task.promise;}catch{}
  if(leftDisplay!==display)return;
  v.doc=doc;display.asset=asset;display.showOthers=showOthers;
  $('sourceViewer').dataset.renderSha256=asset?.sha256??review.files.source.sha256;
  await positionView('source',position);
}
function drawHistorical(){
  const canvas=$('historicalOverlay'),v=views.source,asset=leftDisplay?.asset;
  canvas.hidden=!asset||$('hide').checked;canvas.dataset.findingIds='';if(canvas.hidden||!v.viewport){canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);return;}
  canvas.width=$('sourceCanvas').width;canvas.height=$('sourceCanvas').height;canvas.style.width=$('sourceCanvas').style.width;canvas.style.height=$('sourceCanvas').style.height;
  const ctx=canvas.getContext('2d');ctx.setTransform(v.dpr,0,0,v.dpr,0,0);
  const selected=asset.marks.filter(f=>f.id===asset.selectedId);
  if(leftDisplay.showOthers){ctx.globalAlpha=.3;paint(ctx,v.viewport,asset.marks.filter(f=>f.id!==asset.selectedId),v.page);ctx.globalAlpha=1;}
  for(const f of selected)if(f.page===v.page&&f.bounds){const [x0,y0,x1,y1]=v.viewport.convertToViewportRectangle(f.bounds);ctx.strokeStyle='#443dd0';ctx.lineWidth=2;ctx.setLineDash([5,3]);ctx.strokeRect(Math.min(x0,x1)-5,Math.min(y0,y1)-5,Math.abs(x1-x0)+10,Math.abs(y1-y0)+10);}
  ctx.setLineDash([]);paint(ctx,v.viewport,selected,v.page);
  canvas.dataset.findingIds=(leftDisplay.showOthers?asset.marks:selected).filter(f=>f.page===v.page).map(f=>f.id).join(',');
}
function drawOverlay(){
  const v=views.rendered,c=$('overlay'),ctx=c.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,c.width,c.height);c.dataset.focusedFindingId='';
  if(comparison||!review||!v.viewport||$('hide').checked)return;
  ctx.setTransform(v.dpr,0,0,v.dpr,0,0);
  if(findingFocus?.isCurrent()&&findingFocus.expires>performance.now()){
    const box=v.viewport.convertToViewportRectangle(findingFocus.bounds),x=Math.min(box[0],box[2])-5,y=Math.min(box[1],box[3])-5,w=Math.abs(box[2]-box[0])+10,h=Math.abs(box[3]-box[1])+10;
    ctx.save();ctx.strokeStyle='#fff';ctx.lineWidth=4;ctx.strokeRect(x,y,w,h);ctx.strokeStyle='#443dd0';ctx.lineWidth=2;ctx.strokeRect(x,y,w,h);ctx.restore();c.dataset.focusedFindingId=findingFocus.id;
  }
  paint(ctx,v.viewport,review.findings,v.page,gesture?.stroke);
}
// The locating outline and navigation token are view state, never annotations.
function cancelFindingFocus(){const hadFocus=Boolean(findingFocus);findingFocusSequence++;clearTimeout(findingFocusTimer);findingFocusTimer=null;findingFocus=null;if(hadFocus)drawOverlay();}
for(const type of ['wheel','pointerdown','keydown'])$('renderedScroll').addEventListener(type,cancelFindingFocus,{capture:true,passive:true});
$('renderedScroll').addEventListener('scroll',()=>{
  if(!findingFocus||!views.rendered.viewport)return;
  const scroll=$('renderedScroll');if(Math.abs(scroll.scrollLeft-findingFocus.scroll[0])>1||Math.abs(scroll.scrollTop-findingFocus.scroll[1])>1)cancelFindingFocus();
},{passive:true});
document.addEventListener('score-desk-change',cancelFindingFocus);
function current(){return review?.findings.find(f=>f.id===active);}
const findingTitle=f=>`${isComment(f)?'Comment':findingType(f)==='source_footnote'?'Footnote':'Finding'} ${f.number} · Page ${f.page}`;
function setFindingTitle(text){$('editTitle').textContent=text;$('editTitle').title=text;}
function nextColor(){const p=review.preferences;return p.autoColor?PALETTE[p.colorCursor].color:p.color;}
function findingCapacity(){
  if(review.findings.length>=2000)throw new Error('Limit: 2,000 findings per review.');
  if(review.nextNumber>99999)throw new Error('Finding number limit reached.');
}
// Preparation is view state only. Commit a number/color/association with real content.
function createFinding(){
  findingCapacity();const color=nextColor();
  const f={id:crypto.randomUUID(),number:review.nextNumber++,page:views.rendered.page,color,comment:'',type:prepared?preparedType:'correction',state:'open',strokes:[],bounds:null};
  if(review.preferences.autoColor)review.preferences.colorCursor=(review.preferences.colorCursor+1)%PALETTE.length;
  const reported=returned?.reported.find(item=>item.id===pendingReportedId);
  if(reported)reported.associationId=f.id;
  review.findings.push(f);active=f.id;if(annotationEdit)annotationEdit.findingId=f.id;prepared=false;pendingReportedId=null;return f;
}
function setComments(open){
  document.body.classList.toggle('comments-open',open);$('toggleComments').setAttribute('aria-expanded',String(open));
  $('commentsPanel').inert=busy||(matchMedia('(max-width:899px)').matches&&!open);
}
function showScore(kind){
  document.body.dataset.score=kind;
  for(const name of ['source','rendered','both'])$('show'+name[0].toUpperCase()+name.slice(1)).setAttribute('aria-pressed',String(name===kind));
}
function revealRendered(){workspaceLayout?.revealScore('rendered');if(document.body.dataset.score==='source')showScore('rendered');}
function revealMarks(){$('hide').checked=false;drawHistorical();}
// Entering/leaving the note editor changes the comparison header height.
// A taller viewport can clamp scrollTop before it gets smaller again. Keep
// the current top edge reachable with only the temporary space it needs.
function preserveScoreScroll(){
  const positions=Object.values(views).map(v=>{const scroll=$(`${v.kind}Scroll`);return {v,doc:v.doc,page:v.page,zoom:$(`${v.kind}Zoom`).value,left:scroll.scrollLeft,top:scroll.scrollTop};});
  return ()=>{for(const position of positions){
    const {v,doc,page,zoom,left,top}=position;if(v.doc!==doc||v.page!==page||$(`${v.kind}Zoom`).value!==zoom)continue;
    const scroll=$(`${v.kind}Scroll`),paper=$(`${v.kind}Paper`);if(!scroll.clientWidth||!v.viewport)continue;
    paper.style.marginBottom='';
    const contentBottom=paper.offsetTop+paper.offsetHeight+parseFloat(getComputedStyle(scroll).paddingBottom);
    const extra=top>0?Math.max(0,Math.ceil(top+scroll.clientHeight-contentBottom)):0;
    if(extra)paper.style.marginBottom=extra+'px';
    v.scrollPaddingScene={doc,page,zoom};scroll.scrollTo(left,top);
  }};
}
function newFinding(reportedId=null){
  if(!canEdit())return;const restoreScroll=preserveScoreScroll();
  corrections.pauseViewForNote(reportedId);
  const linked=returned?.reported.find(f=>f.id===reportedId)?.associationId;if(linked&&review.findings.some(f=>f.id===linked)){setMode('draw');void selectFinding(linked).then(()=>$('overlay').focus({preventScroll:true}));return;}
  findingCapacity();cancelGesture();endAnnotationEdit({flush:true});active=null;prepared=true;pendingReportedId=typeof reportedId==='string'?reportedId:null;
  preparedType=findingType(returned?.reported.find(f=>f.id===pendingReportedId));
  revealMarks();revealRendered();setComments(false);setMode('draw');renderFindings();drawOverlay();
  (pendingReportedId?$('overlay'):$('comment')).focus({preventScroll:true});restoreScroll();
  message('Type a note or mark a passage.');
}
async function finishFinding(next=false){
  if(!canEdit())return;
  const f=current();
  if(!f?.strokes.length&&!f?.comment.trim()){message('Add a note or mark a passage.');return;}
  busy=true;cancelGesture();controls();
  try{
    if(!await saveNow()||saveFailed||saveConflict){if(!storageProblem)message('Finding is still being edited. Retry Done or download a recovery ZIP.',true,'finding');return;}
    clearMessage('finding');endAnnotationEdit();const restoreScroll=preserveScoreScroll();
    active=null;prepared=next;preparedType='correction';pendingReportedId=null;if(next)revealMarks();setMode(next?'draw':'navigate');
    renderFindings();drawOverlay();setComments(false);restoreScroll();
    message(`${isComment(f)?'Comment':'Finding'} #${f.number} ${isComment(f)?'logged':'saved locally'}.${next?' Add the next finding.':''}`);
  }finally{busy=false;controls();if(!active)(next&&!f.strokes.length?$('comment'):$('overlay')).focus({preventScroll:true});}
}
async function selectFinding(id){
  if(!canEdit())return;
  const f=review.findings.find(f=>f.id===id);if(!f)return;
  corrections.pauseViewForNote(returned?.reported.find(report=>report.associationId===id)?.id);
  cancelFindingFocus();cancelGesture();if(active!==id)endAnnotationEdit({flush:true});active=id;prepared=false;pendingReportedId=null;revealRendered();setComments(false);
  document.dispatchEvent(new Event('score-desk-view-navigation'));
  const pageChanged=views.rendered.page!==f.page;views.rendered.page=f.page;$('renderedPage').value=f.page;renderFindings();drawOverlay();
  const box=f.strokes.length?bounds(f.strokes):null;
  if(!box){if(pageChanged){$('renderedScroll').scrollTo(0,0);await renderPage(views.rendered);}return;}
  const v=views.rendered,doc=v.doc,selected=stamp(),sequence=findingFocusSequence,zoom=$('renderedZoom').value,scroll=$('renderedScroll');
  const isCurrent=()=>sequence===findingFocusSequence&&matchesStamp(selected)&&active===id&&v.doc===doc&&v.page===f.page&&$('renderedZoom').value===zoom&&canEdit();
  findingFocus={id,bounds:box,isCurrent,expires:0,scroll:[scroll.scrollLeft,scroll.scrollTop]};
  const point=[(box[0]+box[2])/2,(box[1]+box[3])/2],vp=v.viewport;
  const fitChanged=zoom==='fit'&&vp&&Math.abs(vp.scale-Math.max(.15,(scroll.clientWidth-38)/(vp.width/vp.scale)))>.001;
  if(pageChanged||!vp||fitChanged){try{await positionView('rendered',{page:f.page,point},{isCurrent});}catch(error){if(isCurrent())throw error;}}
  else centerView(v,point);
  if(!isCurrent())return;
  findingFocus.expires=performance.now()+1500;drawOverlay();
  findingFocusTimer=setTimeout(()=>{if(sequence===findingFocusSequence)cancelFindingFocus();},1500);
}
function renderFindings(){
  const f=current();$('editor').hidden=!f&&!prepared;
  $('commentDock').hidden=$('editor').hidden;
  $('toggleComments').textContent='Findings pane';
  $('highlightColor').value=f?.color??(review?nextColor():PALETTE[0].color);
  $('colorSwatch').style.backgroundColor=$('highlightColor').value;
  $('autoColor').checked=review?.preferences.autoColor??true;
  setFindingTitle(f?findingTitle(f):'New finding · type or draw');
  if(document.activeElement!==$('comment')||$('comment').dataset.findingId!==(f?.id??''))$('comment').value=f?.comment??'';
  $('comment').dataset.findingId=f?.id??'';$('findingState').value=f?.state??'open';
  $('findingType').value=f?findingType(f):preparedType;
  renderFindingTypeInfo($('findingType').value);
  renderFindingList();controls();
}
function renderFindingTypeInfo(type){
  const comment=type==='comment';
  $('findingTypeHint').hidden=!comment;
  $('findingTypeHint').textContent=comment?'Comments are logged internally, not corrected or printed on the score':'';
  $('findingState').closest('.finding-options').hidden=comment;
  $('editor').dataset.findingType=type;
}
function commentIcon(){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
  svg.classList.add('finding-comment-icon');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');
  path.setAttribute('d','M3 2h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6l-4 2V3a1 1 0 0 1 1-1Z');svg.append(path);return svg;
}
function footnoteIcon(){
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg'),path=document.createElementNS(svg.namespaceURI,'path');
  svg.classList.add('finding-footnote-icon');svg.setAttribute('viewBox','0 0 16 16');svg.setAttribute('aria-hidden','true');
  path.setAttribute('d','M8 2.5v11 M3.25 5.25l9.5 5.5 M3.25 10.75l9.5-5.5');svg.append(path);return svg;
}
function renderFindingList({preserveContext=false}={}){
  const list=$('findings'),top=list.getBoundingClientRect().top,scrollTop=list.scrollTop;
  const anchor=preserveContext?[...list.querySelectorAll('.finding')].find(el=>el.getBoundingClientRect().bottom>top):null,anchorKey=anchor?.dataset.rowKey,anchorOffset=anchor?.getBoundingClientRect().top-top;
  const focused=preserveContext&&list.contains(document.activeElement)?document.activeElement:null,focusKey=focused?.closest('.finding')?.dataset.rowKey,focusDelete=focused?.classList.contains('finding-delete');
  const rows=sortFindingRows(findingRows(review,returned),findingOrder),filtered=findingFilter.type!=='all'||findingFilter.unresolved;
  const visible=rows.filter(({finding:f})=>(findingFilter.type==='all'||findingType(f)===findingFilter.type)&&(!findingFilter.unresolved||!isComment(f)&&f.state!=='resolved'));
  $('findingCount').textContent=filtered?`${visible.length} / ${rows.length}`:String(rows.length);
  $('findingCount').setAttribute('aria-label',`${visible.length} of ${rows.length} findings and comments shown`);$('findingCount').title=`${visible.length} shown · ${rows.length} total`;
  list.replaceChildren();
  if(!rows.length){const p=document.createElement('p');p.className='hint';p.textContent='Choose New finding to type a note, or draw on the score.';list.append(p);}
  else if(!visible.length){
    const empty=document.createElement('div');empty.className='finding-filter-empty';const p=document.createElement('p');p.textContent='No findings match these filters.';
    const reset=document.createElement('button');reset.id='resetFindingFilters';reset.type='button';reset.textContent='Reset filters';reset.disabled=busy;
    reset.onclick=()=>{findingFilter.type='all';findingFilter.unresolved=false;$('findingTypeFilter').value='all';$('findingUnresolvedFilter').checked=false;renderFindingList();$('findingTypeFilter').focus({preventScroll:true});};empty.append(p,reset);list.append(empty);
  }
  for(const {finding,reported,annotation,status} of visible){
    const historicalComment=reported&&isComment(finding)&&!annotation;
    const selected=reported&&!isComment(finding)&&document.body.classList.contains('corrections-open')&&document.querySelector('#correctionComparison')?.dataset.findingId===reported.id&&!active;
    const item=document.createElement('div');item.className=`finding ${selected||annotation?.id===active?'active':''}`;item.dataset.findingType=findingType(finding);item.style.borderLeftColor=finding.color;
    item.dataset.rowKey=findingRowKey({finding,reported,annotation});
    if(annotation)item.dataset.findingId=annotation.id;if(reported)item.dataset.reportedId=reported.id;if(historicalComment)item.dataset.reportedCommentId=reported.id;
    const open=document.createElement('button');open.type='button';open.className='finding-open';open.disabled=busy;if(selected||annotation?.id===active)open.setAttribute('aria-current','true');
    const summary=document.createElement('span');summary.className='finding-summary';const number=document.createElement('b');number.className='finding-number';number.textContent=`#${finding.number}`;
    if(isComment(finding))number.prepend(commentIcon());else if(findingType(finding)==='source_footnote')number.prepend(footnoteIcon());
    const text=document.createElement('span');text.className='finding-comment';text.textContent=finding.comment||'(Comment not entered)';summary.append(number,text);
    const meta=document.createElement('small');meta.className='finding-meta';
    for(const text of [finding.page?`Page ${finding.page}`:'Earlier rendering',findingTypeLabel(finding),status]){const detail=document.createElement('span');detail.textContent=text;meta.append(detail);}
    open.append(summary,meta);
    if(reported&&annotation&&annotation.comment!==reported.comment){const note=document.createElement('span');note.className='finding-current-note';note.textContent='Current note: '+annotation.comment;open.append(note);}
    const choose=guard(async()=>{
      if(busy||corrections.state().pending)return;
      if(reported&&!isComment(finding))await corrections.selectFinding(reported.id);
      else if(reported)await handoff.returnedUI.showComment(reported.id);
      else if(annotation)await selectFinding(annotation.id);
      else await handoff.returnedUI.showComment(reported.id);
    },'finding-selection');open.onclick=e=>{e.stopPropagation();choose();};item.onclick=choose;item.append(open);
    if(annotation&&!reported){const remove=document.createElement('button');remove.type='button';remove.className='finding-delete icon-close';remove.disabled=!canEdit();remove.title=`Delete finding #${finding.number}`;remove.setAttribute('aria-label',remove.title);remove.append($('deleteFinding').querySelector('svg').cloneNode(true));remove.onclick=e=>{e.stopPropagation();requestDelete(annotation.id);};item.append(remove);}
    list.append(item);
  }
  if(preserveContext){
    const items=[...list.querySelectorAll('.finding')],next=items.find(el=>el.dataset.rowKey===anchorKey);
    list.scrollTop=next?list.scrollTop+next.getBoundingClientRect().top-top-anchorOffset:scrollTop;
    items.find(el=>el.dataset.rowKey===focusKey)?.querySelector(focusDelete?'.finding-delete':'.finding-open')?.focus({preventScroll:true});
  }
}
document.addEventListener('score-desk-comparison-selection',renderFindingList);
// List filters are presentation state: never checkpoint, save, or replace the editor.
function installFindingFilters(){
  const bar=document.createElement('div');bar.id='findingFilters';bar.setAttribute('role','group');bar.setAttribute('aria-label','Filter and sort findings');
  const type=document.createElement('select');type.id='findingTypeFilter';type.setAttribute('aria-label','Finding type filter');
  for(const [value,label]of [['all','All'],['correction','Corrections'],['source_footnote','Footnotes'],['comment','Comments']])type.add(new Option(label,value));
  const unresolved=document.createElement('input');unresolved.id='findingUnresolvedFilter';unresolved.type='checkbox';
  const label=document.createElement('label');label.title='Show findings whose review status is not resolved';label.append(unresolved,'Unresolved');
  const order=document.createElement('select');order.id='findingOrder';order.setAttribute('aria-label','Finding order');order.title='Sort by the original finding number';
  for(const [value,text]of [['newest','Newest first'],['oldest','Oldest first']])order.add(new Option(text,value));order.value=findingOrder;
  order.onchange=()=>{findingOrder=order.value==='oldest'?'oldest':'newest';try{localStorage.setItem(findingOrderKey,findingOrder);}catch{/* The session choice still works. */}renderFindingList({preserveContext:true});};
  type.onchange=()=>{findingFilter.type=type.value;renderFindingList();};unresolved.onchange=()=>{findingFilter.unresolved=unresolved.checked;renderFindingList();};
  bar.append(type,label,order);$('findings').before(bar);
}
installFindingFilters();
function viewportPoint(event){const v=views.rendered,rect=$('overlay').getBoundingClientRect();return [(event.clientX-rect.left)*v.viewport.width/rect.width,(event.clientY-rect.top)*v.viewport.height/rect.height];}
function pdfPoint(event){const v=views.rendered;const [x,y]=v.viewport.convertToPdfPoint(...viewportPoint(event));const [x0,y0,x1,y1]=review.pages[v.page-1].view;return [Math.max(x0,Math.min(x1,x)),Math.max(y0,Math.min(y1,y))];}
$('overlay').addEventListener('pointerdown',e=>{
  if(busy||!review||dialogOpen()||e.button!==0||gesture||!e.isPrimary&&e.pointerType==='touch')return;
  if(!views.rendered.viewport){message('Wait for this page to finish rendering before drawing.');return;}
  e.preventDefault();
  if(mode==='draw'){
    if(!canEdit())return;
    if($('hide').checked){message('Show marks before drawing.');return;}
    const f=current();if(f&&f.page!==views.rendered.page){message('This finding belongs to another rendered page. Start a new finding here.');return;}
    gesture={pointerId:e.pointerId,findingId:f?.id,stroke:{points:[pdfPoint(e)],width:Number($('brush').value),color:f?.color??nextColor(),opacity:0.35}};
  }else gesture={pointerId:e.pointerId,x:e.clientX,y:e.clientY,dragged:false,left:$('renderedScroll').scrollLeft,top:$('renderedScroll').scrollTop};
  try{$('overlay').setPointerCapture(e.pointerId);}catch{}drawOverlay();
});
$('overlay').addEventListener('pointermove',e=>{
  if(!gesture||e.pointerId!==gesture.pointerId)return;e.preventDefault();
  if(gesture.stroke){const samples=e.getCoalescedEvents?.();for(const p of samples?.length?samples:[e]){if(gesture.stroke.points.length>=200000)break;gesture.stroke.points.push(pdfPoint(p));}drawOverlay();}
  else{gesture.dragged ||= Math.hypot(e.clientX-gesture.x,e.clientY-gesture.y)>5;if(gesture.dragged){$('renderedScroll').scrollLeft=gesture.left-e.clientX+gesture.x;$('renderedScroll').scrollTop=gesture.top-e.clientY+gesture.y;}}
});
$('overlay').addEventListener('pointerup',guard(async e=>{
  if(!gesture||e.pointerId!==gesture.pointerId)return;const completed=gesture,focusAtCompletion=document.activeElement;gesture=null;resumeResize();if($('overlay').hasPointerCapture(e.pointerId))$('overlay').releasePointerCapture(e.pointerId);
  if(completed.stroke){
    if(!canEdit()){drawOverlay();return;}
    let f=review.findings.find(f=>f.id===completed.findingId);
    const total=review.findings.reduce((n,f)=>n+f.strokes.reduce((m,s)=>m+s.points.length,0),0);
    if(total+completed.stroke.points.length>200000||(f?.strokes.length??0)>=5000){message('Point/stroke limit reached. This stroke was not added; export this review before starting another.',true,'stroke-limit');drawOverlay();return;}
    const creating=!f,focusComment=creating&&!pendingReportedId;if(creating)findingCapacity();annotationCheckpoint();if(creating)f=createFinding();f.strokes.push(completed.stroke);f.bounds=bounds(f.strokes);changed();
    clearMessage('stroke-limit');
    // Focus the note after its first stroke; preserve its caret while adding marks.
    // A completed score interaction releases stale option focus without scrolling.
    if(focusComment&&canEdit()&&current()?.id===f.id)$('comment').focus({preventScroll:true});
    else if(document.activeElement!==$('comment'))returnFocusToScore(document.activeElement);
  }else{
    if(!completed.dragged&&Math.hypot(e.clientX-completed.x,e.clientY-completed.y)<=5&&canEdit()&&!$('hide').checked){
      const f=hitFinding(views.rendered.viewport,review.findings,views.rendered.page,...viewportPoint(e));
      if(f)await selectFinding(f.id);
    }
    drawOverlay();returnFocusToScore(focusAtCompletion);
  }
}));
$('overlay').addEventListener('pointercancel',e=>{if(gesture?.pointerId===e.pointerId)cancelGesture();});
$('overlay').addEventListener('lostpointercapture',e=>{if(gesture?.pointerId===e.pointerId&&!$('overlay').hasPointerCapture(e.pointerId))cancelGesture();});
const commands={
  new:()=>newFinding(),draw:()=>{if(canEdit()){revealRendered();setMode('draw');}},navigate:()=>{if(canEdit())setMode('navigate');},
  done:()=>finishFinding(),next:()=>finishFinding(true),undo:()=>history(undo,redo),redo:()=>history(redo,undo)
};
for(const name of Object.keys(commands))commands[name]=guard(commands[name],'command-'+name);
for(const [id,name]of Object.entries({navigate:'navigate',draw:'draw',newFinding:'new',saveFinding:'done',doneNext:'next',undo:'undo',redo:'redo'}))$(id).onclick=commands[name];
$('comment').addEventListener('input',guard(()=>{
  if(!canEdit()){$('comment').value=current()?.comment??'';return;}
  if(!current()&&!prepared)return;const value=$('comment').value;if(!current()&&!value.trim()||current()?.comment===value)return;
  const existing=Boolean(current());if(!existing)findingCapacity();annotationCheckpoint();const f=current()??createFinding();f.comment=value;changed({draft:existing,typing:true});
}));
$('findingState').onchange=()=>{if(!current())return;if(!canEdit()){$('findingState').value=current().state;return;}if(current().state===$('findingState').value)return;annotationCheckpoint();current().state=$('findingState').value;changed();};
$('findingType').onchange=()=>{
  const value=$('findingType').value,f=current();
  if(!canEdit()||!FINDING_TYPES.includes(value)){$('findingType').value=f?findingType(f):preparedType;return;}
  if(f){if(findingType(f)===value)return;annotationCheckpoint();f.type=value;changed();}
  else if(prepared){preparedType=value;renderFindingTypeInfo(value);}
};
let pendingDelete=null;
function requestDelete(id){
  if(!canEdit())return;const f=review.findings.find(f=>f.id===id);if(!f)return;cancelGesture();
  pendingDelete={id:f.id,stamp:stamp(),focus:document.activeElement};
  $('deleteDescription').textContent=`Delete finding #${f.number} · page ${f.page}?`;
  $('deletePreview').textContent=f.comment||'(Marked passage without a comment)';
  $('deleteDialog').showModal();$('confirmDelete').focus();
}
$('deleteFinding').onclick=()=>requestDelete(active);
function cancelDelete(){const pending=pendingDelete;pendingDelete=null;$('deleteDialog').close();controls();pending?.focus?.focus({preventScroll:true});}
$('cancelDelete').onclick=cancelDelete;
$('deleteDialog').addEventListener('cancel',event=>{event.preventDefault();cancelDelete();});
$('confirmDelete').onclick=()=>{
  const pending=pendingDelete;if(!pending||busy||!matchesStamp(pending.stamp)||!review.findings.some(f=>f.id===pending.id)){cancelDelete();return;}
  pendingDelete=null;$('deleteDialog').close();checkpoint();review.findings=review.findings.filter(f=>f.id!==pending.id);
  if(active===pending.id){active=null;prepared=false;preparedType='correction';pendingReportedId=null;}changed();(current()?$('comment'):$('newFinding')).focus({preventScroll:true});
};
function history(from,to){if(!from.length||!canEdit())return;cancelGesture();endAnnotationEdit();to.push(annotationState());const prior=from.pop();review=prior.review;active=prior.active;prepared=prior.prepared;preparedType=prior.preparedType??'correction';pendingReportedId=prior.pendingReportedId;if(returned&&prior.workspaceId===returned.id){const links=new Map(prior.associations);for(const f of returned.reported)f.associationId=links.get(f.id)??null;}if(!current())active=null;const value=current()?.comment??'';if($('comment').value!==value)$('comment').value=value;changed();}
$('hide').onchange=()=>{if(!review||busy)return;cancelFindingFocus();cancelGesture();drawOverlay();drawHistorical();document.dispatchEvent(new Event('score-desk-controls'));};$('brush').oninput=()=>$('brushValue').textContent=`${$('brush').value} pt`;
$('highlightColor').onchange=()=>{if(!canEdit())return;cancelGesture();const color=$('highlightColor').value;if(current())annotationCheckpoint();else checkpoint();review.preferences.color=color;if(review.preferences.autoColor)review.preferences.colorCursor=(PALETTE.findIndex(p=>p.color===color)+1)%PALETTE.length;const f=current();if(f){f.color=color;for(const s of f.strokes)s.color=color;}changed();};
$('autoColor').onchange=()=>{if(!canEdit())return;checkpoint();const prefs=review.preferences;prefs.autoColor=$('autoColor').checked;const index=PALETTE.findIndex(p=>p.color===$('highlightColor').value);prefs.colorCursor=(index+(review.findings.length?1:0))%PALETTE.length;changed();};
function returnFocusToScore(control){
  if(!review||busy||dialogOpen()||document.activeElement!==control)return;
  if($('overlay').getClientRects().length)$('overlay').focus({preventScroll:true});
  else control?.blur?.();
}
function workspaceOption(target){
  return target instanceof HTMLSelectElement&&!target.multiple&&target.size<=1&&target.closest('.toolbar,.viewer-head,#editor,#findingFilters,#comparisonControl')?target:null;
}
const nativeSelectOpen=CSS.supports('selector(select:open)');
// Native pickers emit their closing click after committing, even when the value
// is unchanged. Leave the opening click and arrow/type-ahead navigation alone.
document.addEventListener('click',e=>{
  const select=workspaceOption(e.target);if(select&&nativeSelectOpen&&!select.matches(':open'))returnFocusToScore(select);
});
document.addEventListener('keyup',e=>{
  if(e.key==='Enter'&&findingEnterHeld){findingEnterHeld=false;if(!e.isComposing&&!composing)e.preventDefault();return;}
  const select=workspaceOption(e.target);
  if(select&&!e.isComposing&&!composing&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&['Enter','Escape'].includes(e.key)&&(!nativeSelectOpen||!select.matches(':open')))returnFocusToScore(select);
});
window.addEventListener('blur',()=>findingEnterHeld=false);
document.addEventListener('compositionstart',()=>composing=true);document.addEventListener('compositionend',()=>composing=false);
document.addEventListener('keydown',guard(async e=>{
  if(e.defaultPrevented||e.isComposing||composing||e.keyCode===229)return;
  // Own this key through keyup, including if a save changes focus or prepares
  // another editor. Do not let held Enter activate that editor or another control.
  if(e.key==='Enter'&&findingEnterHeld){e.preventDefault();return;}
  // Completion dialogs still receive Escape to request their own cancellation.
  if(dialogOpen()||busy||e.target.closest?.('#notices'))return;
  const typing=e.target.closest?.('textarea,select,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]):not([type=reset]),[contenteditable]:not([contenteditable="false"])');
  if(e.key==='Escape'){
    if(e.target.closest?.('select'))return;
    if(gesture){e.preventDefault();cancelGesture();return;}
    if(!canEdit())return;e.preventDefault();const restoreScroll=preserveScoreScroll();endAnnotationEdit({flush:true});active=null;prepared=false;preparedType='correction';pendingReportedId=null;setMode('navigate');renderFindings();drawOverlay();
    restoreScroll();message('Navigate. Marks and comments kept.');return;
  }
  if(e.key==='Enter'&&!e.altKey&&(e.target===$('comment')||e.target===$('overlay')&&current()&&!gesture)){e.preventDefault();if(!e.repeat){findingEnterHeld=true;await commands[e.ctrlKey||e.metaKey?'next':'done']();}return;}
  const undoKey=(e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==='z',redoKey=e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='y';
  if((!typing||e.target===$('comment'))&&(undoKey||redoKey)){e.preventDefault();commands[redoKey||e.shiftKey?'redo':'undo']();return;}
  if(typing)return;
  if(e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='h'&&review){e.preventDefault();if(!e.repeat){$('hide').checked=!$('hide').checked;$('hide').onchange();message($('hide').checked?'Finding marks hidden. Ctrl+H shows them again.':'Finding marks shown.');}return;}
  if(e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||e.repeat)return;
  const name={n:'new',d:'draw',v:'navigate'}[e.key.toLowerCase()];if(name&&canEdit()){e.preventDefault();commands[name]();}
}));
$('toggleComments').onclick=()=>{if(!busy){if(workspaceLayout.isDesktop()||document.body.classList.contains('corrections-open'))workspaceLayout.toggleFindings();else setComments(!document.body.classList.contains('comments-open'));}};
$('closeComments').onclick=()=>{if(workspaceLayout.isDesktop()||document.body.classList.contains('corrections-open'))workspaceLayout.setFindings(false);else setComments(false);(document.body.classList.contains('corrections-open')?$('comparisonFindings'):$('toggleComments')).focus({preventScroll:true});};
$('showSource').onclick=()=>showScore('source');$('showRendered').onclick=()=>showScore('rendered');$('showBoth').onclick=()=>showScore('both');
$('workspaceTools').onclick=()=>{if(busy)return;cancelGesture();$('workspaceDialog').dataset.page='files';$('workspaceTitle').textContent='Files & backups';$('workspaceDialog').showModal();controls();};
$('closeWorkspace').onclick=()=>$('workspaceDialog').close();
$('chooseFolderInSetup').onclick=()=>{$('workspaceDialog').close();void appApi.folder.choose({mode:'new'});};
$('shortcutHelp').onclick=()=>{if(!busy){cancelGesture();$('shortcutsDialog').showModal();}};
$('closeShortcuts').onclick=()=>$('shortcutsDialog').close();
for(const dialog of document.querySelectorAll('dialog'))new MutationObserver(()=>{if(dialog.open)cancelGesture();controls();}).observe(dialog,{attributes:true,attributeFilter:['open']});
for(const kind of ['source','rendered']){
  const v=views[kind];const go=guard(async(n,{bottom=false}={})=>{
    if(!v.doc)return false;if(kind==='rendered')cancelFindingFocus();
    v.page=Math.max(1,Math.min(v.doc.numPages,Math.round(Number(n)||1)));
    const doc=v.doc,page=v.page,scroll=$(`${kind}Scroll`);$(`${kind}Page`).value=page;scroll.scrollTo(0,0);
    const painting=renderPage(v),serial=v.serial;await painting;
    // A later arrow, zoom or document replacement owns its own landing position.
    if(v.doc===doc&&v.page===page&&v.serial===serial&&v.viewport){scroll.scrollTo(0,bottom?scroll.scrollHeight:0);document.dispatchEvent(new Event('score-desk-view-navigation'));}
    controls();
  },'render-'+kind);
  $(`${kind}Page`).onchange=e=>go(e.target.value);$(`${kind}Zoom`).onchange=guard(()=>{if(kind==='rendered')cancelFindingFocus();const p=viewPosition(kind);if(p)v.position=p;return renderPage(v);},'render-'+kind);
  document.querySelectorAll(`[data-kind="${kind}"]`).forEach(b=>b.onclick=()=>go(v.page+(b.dataset.action==='next'?1:-1)));
  const scroll=$(`${kind}Scroll`),zoom=$(`${kind}Zoom`),levels=[...zoom.options].map(option=>Number(option.value)).filter(Number.isFinite).sort((a,b)=>a-b);
  const pageScroll=createPageScrollGesture();pageScrollGestures.set(kind,pageScroll);
  scroll.addEventListener('wheel',event=>{
    if(!event.ctrlKey){
      cancelWheelZoom(v);
      if(!scrollBetweenPages){pageScroll.block();return;}
      const paper=$(`${kind}Paper`),allowed=Boolean(v.doc&&v.viewport&&scroll.clientWidth&&!busy&&!document.body.inert&&!gesture&&mode!=='draw'&&!dialogOpen()&&!appApi.corrections?.state().pending&&!completion?.job()&&!recoveryJob&&!event.metaKey&&!event.altKey&&!event.shiftKey&&paper.getAttribute('aria-busy')!=='true'&&!['true','gesture'].includes(paper.dataset.resizePending)&&!event.target.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])'));
      const action=pageScroll.wheel(event,{allowed,scene:v.serial,top:scroll.scrollTop,height:scroll.scrollHeight,clientHeight:scroll.clientHeight,page:v.page,pages:v.doc?.numPages??0});
      if(action.consume)event.preventDefault();
      if(action.turn)void go(v.page+action.turn,{bottom:action.turn<0}).finally(()=>pageScroll.settled());
      return;
    }
    pageScroll.block();
    if(!v.doc||!scroll.clientWidth)return;
    // Catch browser zoom only over this PDF, without moving keyboard focus.
    event.preventDefault();
    if(busy||dialogOpen()||!event.deltaY)return;
    const pending=v.wheelZoom,viewport=pending?.viewport??v.viewport;
    if(!viewport)return;
    const current=viewport.scale,direction=Math.sign(event.deltaY);
    const next=direction<0?levels.find(level=>level>current+.001):levels.findLast(level=>level<current-.001);
    // Crossing either numeric limit returns to Fit width. When fitting is already
    // outside the numeric range, only a wheel step toward that range leaves Fit.
    if(next===undefined&&zoom.value==='fit')return;
    const nextScale=next??Math.max(.15,(scroll.clientWidth-38)/(viewport.width/viewport.scale));
    if(kind==='rendered')cancelFindingFocus();
    cancelGesture();delete v.position;
    // Reuse a pending zoom's passage even when its canvas has not finished.
    // A moved pointer advances relative to that same pending geometry.
    let point;
    if(pending){const [x,y]=viewport.convertToViewportPoint(...pending.point);point=viewport.convertToPdfPoint(x+event.clientX-pending.clientX,y+event.clientY-pending.clientY);}
    else{const rect=$(`${kind}Paper`).getBoundingClientRect();point=viewport.convertToPdfPoint((event.clientX-rect.left)*viewport.width/rect.width,(event.clientY-rect.top)*viewport.height/rect.height);}
    zoom.value=next===undefined?'fit':String(next);
    const wheelZoom={doc:v.doc,page:v.page,point,clientX:event.clientX,clientY:event.clientY,viewport:viewport.clone({scale:nextScale})};
    v.wheelZoom=wheelZoom;cancelAnimationFrame(v.wheelFrame);
    document.dispatchEvent(new Event('score-desk-view-navigation'));
    v.wheelFrame=requestAnimationFrame(()=>{v.wheelFrame=0;guard(()=>renderPage(v,{wheelZoom}),'render-'+kind)();});
  },{passive:false});
  for(const type of ['pointerdown','keydown'])scroll.addEventListener(type,()=>{cancelWheelZoom(v);pageScroll.block();},{capture:true,passive:true});
}
// Busy work makes main inert, which retargets wheel events away from scrollers.
// Keep a held Ctrl+wheel from unexpectedly zooming the whole browser meanwhile.
document.addEventListener('wheel',event=>{
  if(!busy||!event.ctrlKey)return;
  for(const v of Object.values(views))if(v.doc){const box=$(`${v.kind}Scroll`).getBoundingClientRect();if(box.width&&event.clientX>=box.left&&event.clientX<box.right&&event.clientY>=box.top&&event.clientY<box.bottom){event.preventDefault();break;}}
},{capture:true,passive:false});
function flushResize(){
  resizeTimer=0;
  // A delayed fit is background layout work, not a request to abandon input.
  // Keep the displayed PDF/overlay mapping intact through pointerup (or cancel).
  if(gesture){resizeDeferred=true;for(const v of Object.values(views))if($(`${v.kind}Paper`).dataset.resizePending==='true')$(`${v.kind}Paper`).dataset.resizePending='gesture';return;}
  resizeDeferred=false;setComments(document.body.classList.contains('comments-open'));
  for(const v of Object.values(views)){
    const width=$(`${v.kind}Scroll`).clientWidth;
    if(width&&width!==v.observedWidth){v.observedWidth=width;if($(`${v.kind}Zoom`).value==='fit'||!v.viewport)guard(()=>renderPage(v),'render-'+v.kind)();}
    $(`${v.kind}Paper`).dataset.resizePending='false';
  }
}
const resizeObserver=new ResizeObserver(()=>{
  clearTimeout(resizeTimer);
  for(const v of Object.values(views))$(`${v.kind}Paper`).dataset.resizePending=String(Boolean($(`${v.kind}Scroll`).clientWidth&&$(`${v.kind}Scroll`).clientWidth!==v.observedWidth));
  resizeTimer=setTimeout(flushResize,150);
});for(const kind of ['source','rendered'])resizeObserver.observe($(`${kind}Scroll`));
$('load').onclick=guard(async()=>{
  $('fileSetupStatus').hidden=true;$('fileSetupStatus').textContent='';
  try{const selected={};for(const role of roles){const file=$(`${role}File`).files[0];if(!file)throw new Error('Choose a source PDF, transcription PDF, and .ly file to start.');if(file.size>100*1024*1024)throw new Error('Each input file must be 100 MB or smaller.');if(role==='ly'&&!file.name.toLowerCase().endsWith('.ly'))throw new Error('The LilyPond file must end in .ly.');selected[role]={name:file.name,blob:file};}await openSnapshot(selected);}
  catch(error){$('fileSetupStatus').hidden=false;$('fileSetupStatus').textContent=error.message;throw error;}
},'load-review');
async function importAnnotations(file){if(!file||busy)return false;if(!review)throw new Error('Open the exact three input files before importing annotation JSON.');if(file.size>25*1024*1024)throw new Error('Review JSON exceeds 25 MB.');const captured=stamp(),value=JSON.parse(await file.text());if(busy||!matchesStamp(captured))throw new Error('The review changed while importing. Select the JSON again.');const imported=validateReview(value,review);cancelGesture();checkpoint();review=imported;active=null;changed();message('Imported matching review. All comments and strokes restored.');return true;}
// Persistence and package wiring are kept separate from the drawing surface.
let saveFailed=false,saveTimer,saveQueue=Promise.resolve();
function storageFailure(e){saveFailed=true;saveConflict||=e.name==='StorageConflictError';const detail=saveConflict?e.message:`Local saving failed: ${e.message||e.name||'Storage unavailable'}. Keep this tab open and download a recovery ZIP.`;storageStatus('NOT SAVED',detail);}
function decisionConflict(e){if(e.name==='StorageConflictError'){saveConflict=true;storageStatus('Newer saved review',e.message);}}
function scheduleSave({typing=false}={}){clearTimeout(saveTimer);storageStatus(saveConflict||saveFailed?'NOT SAVED':'Saving…',storageProblem);saveTimer=setTimeout(()=>saveNow(),typing?1500:350);}
async function saveNow(){
  clearTimeout(saveTimer);
  const save=async()=>{
    // Capture when this queued write starts, not when it was enqueued. A second
    // queued save must use the first write's persisted revision, or do no work.
    if(!review||!dirty||saveConflict)return !dirty;
    const record={...projectContext,id:recordKey(),review:clone(review),files,revisionId,completions:clone(completions),...(returned?{returned:clone(returned)}:{})},captured=stamp();
    try{
    const saved=await operations.putSaved(record,persistedRevision);
      if(recordKey()===record.id){persistedRevision=saved.storageRevision;projectContext.projectId=saved.projectId;if(matchesStamp(captured)){dirty=false;saveFailed=false;$('emergency').hidden=true;storageStatus('Saved locally');}}
      updateSavedOption(saved);
    }catch(e){storageFailure(e);return false;}

    return !dirty;
  };
  saveQueue=saveQueue.then(save,save);return saveQueue;
}
function updateSavedOption(record){
  const select=$('saved'),selected=select.value,label=(record.returned?'Returned review · ':'')+record.review.files.rendered.name+' · '+record.review.findings.length+' findings';
  let option=[...select.options].find(item=>item.value===record.id);
  if(!option)option=new Option(label,record.id);else option.textContent=label;
  select.add(option,select.options[1]??null);select.value=selected;clearMessage('saved-list');
}
async function refreshSaved(options){const selected=$('saved').value;const entries=await listSaved(options);$('saved').replaceChildren(new Option('Choose a locally saved review…',''));for(const r of entries)$('saved').add(new Option(`${r.name} · ${r.count} findings`,r.id));$('saved').value=selected;clearMessage('saved-list');return entries;}
$('reopen').onclick=guard(async()=>{if(!$('saved').value)throw new Error('Choose a saved snapshot first.');await openSnapshot(null,$('saved').value);},'reopen-review');
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
$('emergency').onclick=guard(async()=>{
  if(!review)throw new Error('Load input files first.');if(busy||recoveryJob)return;
  const job={...stamp()},snapshot=clone(review),snapshotFiles=files,round=clone(returned);recoveryJob=job;noticeLayout();
  try{
    const savedCompletions=clone(completions),savedRevisionId=revisionId;
    message('Preparing immediate recovery ZIP…');let payloads=round?await makeReturnedBackup(snapshot,snapshotFiles,round):await operations.makeRecovery(snapshot,snapshotFiles);payloads=await addCompletionHistory(payloads,snapshot,round,savedRevisionId,savedCompletions);const zip=await operations.zipFiles(payloads);
    await operations.download(zip,'scorebrush-recovery.zip');
    if(matchesStamp(job)){recoveryStamp=job;message('Recovery ZIP download requested for the current revision. Confirm it finished before closing this tab.');}
    else {message('Recovery ZIP contains an earlier revision. Newer edits are still unprotected; save them or download another recovery ZIP.',true,'recovery');return false;}
  }finally{if(recoveryJob===job)recoveryJob=null;noticeLayout();}
},'recovery');
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveNow();});
window.addEventListener('beforeunload',e=>{if(unprotectedWork()){saveNow();e.preventDefault();e.returnValue='';}});
// Mutable I/O boundary for deterministic local QA fault injection. The QA bridge
// is loaded only by the separate test pages, never by the application UI.
export const operations={makeRecovery,makePackage,zipFiles,download,putSaved,getSaved:getSavedState};
export {saveNow};
export const sessionStatus=()=>({...stamp(),dirty,busy,persistedRevision,saveConflict,saveFailed,unprotected:unprotectedWork(),recoveryStamp:recoveryStamp&&{...recoveryStamp},active,marksHidden:$('hide').checked,prepared,mode,gesture:Boolean(gesture),undoLength:undo.length,exporting:Boolean(completion?.job()),recovering:Boolean(recoveryJob)});
const appApi={
  viewPosition,positionView,showHistorical,showScore,saveNow,finishFinding,importAnnotations,
  pageScrolling:()=>scrollBetweenPages,togglePageScrolling,
  getBrushPreviewState:()=>({mode,color:current()?.color??(review?nextColor():PALETTE[0].color),width:Number($('brush').value),editable:canEdit()&&!$('hide').checked&&(!current()||current().page===views.rendered.page),hidden:$('hide').checked,busy,gesture:Boolean(gesture),viewportScale:views.rendered.viewport?views.rendered.viewport.scale*views.rendered.viewport.userUnit:0,viewportWidth:views.rendered.viewport?.width??0}),
  returnedState:()=>returned,
  annotationFindings:()=>review?.findings??[],
  promptSummary:()=>({hasReview:Boolean(review),lyName:files?.ly?.name,counts:review?handoffCounts({review,returned}):{findings:0,comments:0}}),
  roundSummary:()=>reviewSummary(review,returned,{workspaceId:recordKey(),revisionId}),
  comparisonActive:()=>Boolean(comparison),
  associatedFindingId:id=>review?currentAssociation(returned,id,review)?.id??null:null,
  leaveComparison:async()=>{await clearLeftDisplay();await positionView('source',{page:1,zoom:'fit'});appApi.corrections.close();},
  capture:()=>({...projectContext,review:clone(review),files,returned:clone(returned),active,doc:comparison?.current??views.rendered.doc,comparison:Boolean(comparison),stamp:stamp(),revisionId,workspaceId:recordKey(),persistedRevision,completions:clone(completions)}),matches:matchesStamp,status:sessionStatus,message,clearMessage,
  openImported:parsed=>openSnapshot(parsed.files,null,parsed.review,null,false,parsed.completionBundle),
  openFiles:(nextFiles,lineage={})=>openSnapshot(nextFiles,null,null,null,false,null,lineage),
  openSaved:(id,{force=false}={})=>openSnapshot(null,id,null,null,force),
  showFindings:()=>setComments(true),toggleFindings:()=>workspaceLayout.toggleFindings(),
  clearFindingSelection:()=>{endAnnotationEdit({flush:true});active=null;prepared=false;pendingReportedId=null;setMode('navigate');renderFindings();drawOverlay();},
  refreshControls:()=>{cancelGesture();controls();},
  openReturned:seed=>openSnapshot(seed.files,null,seed.review,seed),
  reloadReturned:()=>openSnapshot(null,recordKey(),null,null,true),
  updateReturned:mutate=>{if(!canEdit()||!returned)return;mutate(returned);changed({draft:true,typing:true});},
  newRegion:reportedId=>newFinding(reportedId),
  selectMark:selectFinding,
  commitDecision:async mutate=>{
    endAnnotationEdit();await saveNow();if(unprotectedWork())throw new Error('Save the current annotations or download their latest recovery ZIP before recording a decision.');
    const next=clone(returned);mutate(next);const nextReview=clone(review);nextReview.updatedAt=new Date().toISOString();
    const nextRevisionId=crypto.randomUUID();let saved;try{saved=await operations.putSaved({id:recordKey(),review:nextReview,files,returned:next,revisionId:nextRevisionId,completions},persistedRevision);}catch(e){if(e.name==='StorageConflictError'){e.message='Another tab saved newer review decisions. This decision was not saved. Reload the saved review before continuing.';decisionConflict(e);}throw e;}
    returned=saved.returned;review=nextReview;revisionId=nextRevisionId;completions=saved.completions;persistedRevision=saved.storageRevision;revision++;
    // Keep the committed CAS identity even if read-back fails, so retry cannot
    // overwrite another tab or mistake an unverified save for navigation success.
    let verificationError;
    try{const confirmed=await operations.getSaved(recordKey());if(!confirmed||confirmed.storageRevision!==saved.storageRevision||recoveryIdentity(confirmed)!==recoveryIdentity(saved)){const error=new StorageConflictError();decisionConflict(error);throw error;}}
    catch(error){verificationError=new Error('The decision save could not be verified: '+error.message+'. Your current finding and explanation are kept. Retry or use saving recovery.');}
    document.dispatchEvent(new Event('score-desk-change'));updateSavedOption(saved);
    if(verificationError)throw verificationError;
  },
  compare:async blob=>{
    if(!review||busy)return;busy=true;controls();cancelGesture();try{
      if(blob&&!comparison){const previous=await openPdf(blob);setMode('navigate');comparison={current:views.rendered.doc,previous,currentPage:views.rendered.page,currentScroll:[$('renderedScroll').scrollLeft,$('renderedScroll').scrollTop]};views.rendered.doc=previous;views.rendered.page=1;}
      else if(!blob&&comparison){views.rendered.restoreScroll=comparison.currentScroll;views.rendered.doc=comparison.current;views.rendered.page=comparison.currentPage;await comparison.previous.destroy();comparison=null;}
      $('renderedPage').max=views.rendered.doc.numPages;$('renderedPage').value=views.rendered.page;$('renderedCount').textContent=`/ ${views.rendered.doc.numPages}`;await renderPage(views.rendered);if(views.rendered.restoreScroll){$('renderedScroll').scrollTo(...views.rendered.restoreScroll);delete views.rendered.restoreScroll;}
    }finally{busy=false;controls();}
  },
  inspectPdf:async nextFiles=>{const docs=[];try{docs.push(...await openPdfPair(nextFiles));const pages=[];for(let i=1;i<=docs[1].numPages;i++){const p=await docs[1].getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}return pages;}finally{for(const doc of docs)await doc.destroy();}},
  lock:async action=>{if(busy)throw new Error('Wait for the current operation to finish.');busy=true;cancelGesture();controls();try{return await action();}finally{busy=false;controls();}},
  flush:async()=>{await saveNow();if(unprotectedWork())throw new Error('The latest review could not be saved. Protect your edits with a recovery ZIP before finishing.');},
  packageMaker:(...args)=>operations.makePackage(...args),zip:(...args)=>operations.zipFiles(...args),download:(...args)=>operations.download(...args)
};
statusUI=installStatus({status:sessionStatus,folder:()=>appApi.folder?.getState(),save:saveNow,
  retryFolder:async()=>{if(!appApi.folder.getState().permission)return appApi.folder.reconnect();await appApi.folder.saveCheckpoint({refreshOutput:true});const scene=appApi.capture();if(reviewRound(scene.review,scene.returned).state==='outstanding')await appApi.folder.saveNow();},
  loadLatest:()=>appApi.folder.loadLatest(),chooseFolder:()=>appApi.folder.choose(),openFolder:()=>appApi.folder.showFiles(),
  reload:()=>openSnapshot(null,recordKey(),null,null,true),workspace:()=>$('workspaceTools').click()});
appApi.corrections=installComparison(appApi);
export const workspaceLayout=installWorkspaceLayout(appApi);
installBrushPreview(appApi);
export const corrections=appApi.corrections;
export const handoff=installHandoff(appApi);
export const folderWorkspace=installFolderWorkspace(appApi,{openReturnedEntry:entry=>handoff.returnedUI.open(entry)});appApi.folder=folderWorkspace;
completion=installCompletion(appApi);
export const applicationShell=installApplicationShell(appApi,workspaceLayout);
installDesktop(appApi,()=>completion.open(),applicationShell);
controls();
// Reopening retained bytes never attaches an old review to newly selected files.
(async()=>{
  let startupError,refreshMenu=false;
  try{
    let preferred;try{preferred=localStorage.getItem(activeReviewKey);}catch{}
    // Opening the preferred record does not need to enumerate the entire edit
    // journal first. openSnapshot still reads it afresh after flushing edits.
    const preferredRecord=preferred&&!/^(returned-event:|review-event:|completion:)/.test(preferred)?await getSaved(preferred):null;
    if(preferredRecord?.review&&!preferredRecord.kind){await openSnapshot(null,preferred);refreshMenu=true;message('Restored your last open review');}
    else{const entries=await refreshSaved({existingOnly:true});if(entries.length){await openSnapshot(null,entries[0].id);message('Restored your last open review');}else{$('filesPanel').open=false;applicationShell.welcome();}}
  }catch(e){startupError=e;storageFailure(e);}
  finally{
    await window.scoreBrushStartup?.finish(startupError);document.body.dataset.ready='true';document.dispatchEvent(new Event('score-desk-ready'));
    if(refreshMenu)void refreshSaved().catch(e=>message('The saved-review list could not refresh: '+e.message,true,'saved-list'));
  }
})();

