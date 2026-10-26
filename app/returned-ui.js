// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {clone,isComment} from './model.js';
import {commentReference,currentAssociation} from './comparison-model.js';
import {renderCommentImage} from './comment-images.js';
import {retained,retainedList,retain} from './handoff-store.js';
import {workspaceSeed,renderingAttachment,followupTask} from './returned.js';
const $=id=>document.getElementById(id);
export function installReturned(api,host){
  const returnedBarVisibility=()=>{$('returnedBar').hidden=!api.returnedState()||$('workspaceDialog').dataset.page!=='files';};
  new MutationObserver(returnedBarVisibility).observe($('workspaceDialog'),{attributes:true,attributeFilter:['data-page']});
  let position=0,panelId=null,attachmentTarget=null,working=false;
  let commentSequence=0,commentWorkspace=null,commentURLs=[];
  const io={workspaceSeed,renderingAttachment,followupTask,retain};
  const guard=(scope,fn)=>async(...args)=>{try{const result=await fn(...args);if(result!==false)api.clearMessage?.(scope);return result;}catch(e){api.message(e.message,true,scope);$('roundStatus').textContent=e.message;return false;}};
  const element=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  const commentDialog=element('dialog');commentDialog.id='returnedCommentsDialog';commentDialog.setAttribute('aria-labelledby','returnedCommentsTitle');
  const commentHead=element('div',null,'dialog-head'),commentTitle=element('h2','Comments');commentTitle.id='returnedCommentsTitle';
  const commentClose=element('button','Close');commentClose.id='closeReturnedComments';commentClose.onclick=()=>commentDialog.close();commentHead.append(commentTitle,commentClose);
  const commentList=element('div');commentList.id='returnedCommentsList';const commentDetail=element('section');commentDetail.id='returnedCommentDetail';commentDetail.setAttribute('aria-live','polite');
  const commentNavigation=element('details'),commentNavigationLabel=element('summary','Other comments');commentNavigation.id='returnedCommentNavigation';commentNavigation.append(commentNavigationLabel,commentList);
  commentDialog.append(commentHead,commentDetail,commentNavigation,element('p','Internal comments are not printed on the score and do not require correction approval.','hint'));document.body.append(commentDialog);
  function clearCommentContext(){commentSequence++;for(const url of commentURLs)URL.revokeObjectURL(url);commentURLs=[];commentDetail.replaceChildren();}
  commentDialog.addEventListener('close',()=>{clearCommentContext();commentWorkspace=null;});
  function effective(f,annotations){const annotation=annotations.get(f.associationId);return annotation&&Object.hasOwn(annotation,'type')?annotation:f;}
  const currentScene=()=>({review:{findings:api.annotationFindings()},returned:api.returnedState()});
  function actionable(scene=currentScene()){const annotations=new Map(scene.review.findings.map(f=>[f.id,f]));return (scene.returned?.reported??[]).filter(f=>!isComment(effective(f,annotations)));}
  function comments(scene=currentScene()){
    const reported=scene.returned?.reported??[],associated=new Set(reported.map(f=>f.associationId).filter(Boolean)),annotations=new Map(scene.review.findings.map(f=>[f.id,f]));
    return [...reported.filter(f=>isComment(effective(f,annotations))).map(f=>({id:f.id,reported:f,annotation:annotations.get(f.associationId),number:f.number})),...scene.review.findings.filter(f=>isComment(f)&&!associated.has(f.id)).map(f=>({id:f.id,annotation:f,number:f.number}))];
  }
  async function showComment(id=null){
    if(api.status().busy)return false;
    const scene=api.capture(),entries=comments(scene),entry=entries.find(item=>item.id===id)??(id==null?entries[0]:null);if(!entry)return false;
    clearCommentContext();const sequence=commentSequence;commentWorkspace=scene.workspaceId;commentTitle.textContent=`Comments (${entries.length})`;commentList.replaceChildren();commentNavigation.hidden=entries.length<2;commentNavigation.open=false;
    for(const item of entries){const row=element('button',null,'problem-list-item');row.type='button';row.dataset.commentId=item.id;row.setAttribute('aria-current',String(item.id===entry.id));row.append(element('span',`Comment ${item.number} · ${item.annotation?'Current note':'Retained report'}`,'problem-list-context'),element('span',item.annotation?.comment??item.reported.comment,'problem-list-comment'));row.onclick=guard('returned-comment',()=>showComment(item.id));commentList.append(row);}
    commentDetail.append(element('h3',`Comment ${entry.number}`),element('p',entry.annotation?.comment??entry.reported.comment,'internal-comment-text'));
    if(!commentDialog.open)commentDialog.showModal();
    const valid=()=>sequence===commentSequence&&api.capture().workspaceId===scene.workspaceId;
    const unavailable=()=>commentDetail.append(element('p','Original marked passage unavailable in this saved record.','internal-comment-unavailable'));
    let reference;
    try {
      if(entry.reported){
        const issued=await retained(scene.returned.taskId);if(!valid())return false;
        const original=issued?.task.findings.find(f=>f.id===entry.reported.id);
        if(original)reference=await commentReference(issued,original);
      }else{
        const mark=entry.annotation;
        reference={page:mark.page,renderSha256:scene.review.files.rendered.sha256,textOnly:!mark.strokes.length,mark,
          asset:{blob:scene.files.rendered.blob,sha256:scene.review.files.rendered.sha256,marks:[mark],pages:scene.review.pages}};
      }
    }catch{if(!valid())return false;}
    if(!valid())return false;
    const page=reference?.page??entry.reported?.origin?.page;
    const label=element('p','Original comment'+(Number.isInteger(page)?` · page ${page}`:''),'internal-comment-origin');commentDetail.append(label);
    if(entry.annotation&&entry.reported&&entry.annotation.comment!==entry.reported.comment)commentDetail.append(element('p',entry.reported.comment,'internal-comment-original'));
    const current=entry.reported?currentAssociation(scene.returned,entry.id,scene.review):entry.annotation;
    if(current?.strokes.length){const show=element('button',entry.reported?'Show current-revision passage':'Show passage');show.id='showCommentCurrentPassage';show.onclick=guard('returned-comment',async()=>{if(!valid())return false;commentDialog.close();await api.selectMark(current.id);});commentDetail.append(show);}
    if(!reference){unavailable();return true;}
    if(reference.textOnly){commentDetail.append(element('p','Text-only comment · no marked passage.','internal-comment-text-only'));return true;}
    const showImage=async(blob,source)=>{
      if(!blob||!valid())return false;
      const img=element('img'),url=URL.createObjectURL(blob);commentURLs.push(url);img.src=url;
      try{await img.decode();}catch{return false;}
      if(!valid())return false;
      img.id='returnedCommentContext';img.alt=`Original marked passage for comment ${entry.number} · page ${reference.page}`;img.dataset.renderSha256=reference.renderSha256;img.dataset.source=source;commentDetail.append(img);return true;
    };
    if(await showImage(reference.marked,'retained-marked'))return true;
    try{if(await showImage(await renderCommentImage(reference),'original-pdf'))return true;}catch{/* Missing or invalid history must never fall back to today's PDF. */}
    if(valid())unavailable();
    return true;
  }
  async function latestAttachment(entry){return (await retainedList()).find(e=>e.kind==='render-attachment'&&e.responseId===entry.id);}
  async function open(entry,attachment=null){
    if(working||api.status().busy)return false;
    working=true;try{
      const seed=await api.lock(async()=>{const issued=await retained(entry.taskId);attachment??=await latestAttachment(entry);
        if(entry.response.code.status==='changed'&&entry.response.rendering.status==='pending'&&!attachment){$('handoffTitle').textContent='Updated rendering pending';api.message('Updated rendering pending. Attach an existing PDF to review changed code and export a follow-up.');return null;}
        return io.workspaceSeed(entry,issued,api.inspectPdf,attachment);
      });
      if(!seed)return false;await api.openReturned(seed);host.close();await render();api.clearMessage?.('returned-open');
    }finally{working=false;controls();}
  }
  function attach(entry){if(working||api.status().busy)return;attachmentTarget={entry:clone(entry),stamp:api.capture().stamp};$('updatedRenderingFile').click();}
  $('updatedRenderingFile').onchange=guard('returned-attachment',async e=>{
    const file=e.target.files[0],captured=attachmentTarget,target=captured?.entry;e.target.value='';attachmentTarget=null;if(!file||!target||working||api.status().busy)return false;
    working=true;let attachment;try{await api.lock(async()=>{api.message('Checking the selected PDF…');const issued=await retained(target.taskId);attachment=await io.renderingAttachment(target,issued,file,api.inspectPdf);await io.retain(attachment);});await host.refresh();}
    finally{working=false;controls();}
    if(host.getShown()?.id===target.id&&api.matches(captured.stamp))await open(target,attachment);else api.message('Rendering retained for the earlier selected revision. The current workspace was not changed.');
  });
  function controls(){const hasRound=Boolean(api.returnedState()),comparison=api.comparisonActive(),disabled=api.status().busy||working;for(const button of document.querySelectorAll('[data-round-action]'))button.disabled=disabled||!hasRound||comparison&&['locateRegion','showRegion'].includes(button.id);$('roundVersion').disabled=disabled||!hasRound;}
  async function render(){
    if(api.status().busy)return false;
    const scene=api.capture(),round=scene.returned;returnedBarVisibility();document.body.classList.toggle('returned-review',Boolean(round));
    if(commentDialog.open&&commentWorkspace!==scene.workspaceId)commentDialog.close();
    if(!round){panelId=null;api.clearMessage?.('returned-view');return;}
    if(panelId!==round.id){position=0;panelId=round.id;$('roundStatus').textContent='';}
    $('roundVersion').value=scene.comparison?'previous':'current';
    $('roundIdentity').textContent=`Reviewing ${scene.files.ly.name} · ${scene.files.rendered.name}`;
    const issued=await retained(round.taskId);if(api.capture().returned?.id!==round.id)return false;
    if(!actionable(api.capture()).length){
      if(api.corrections.state().key)await api.leaveComparison();
      $('returnedPanel').hidden=true;$('roundProgress').textContent=`${comments(api.capture()).length} comments logged · no corrections to check`;
      controls();api.clearMessage?.('returned-view');return;
    }
    // Read adapter fields without cloning the entire review once per finding.
    const get=()=>api.returnedState();let indexed=null,byId;
    const reported=id=>{const r=get();if(r!==indexed){indexed=r;byId=new Map(r?.reported.map(f=>[f.id,f])??[]);}return byId.get(id);};
    await api.corrections.open({key:round.id,issued,candidate:true,
      ids:{explanation:'roundExplanation',approve:'looksCorrect',reject:'stillCorrection',clarify:'needsClarification',state:'roundState'},
      matches:s=>s.returned?.id===round.id,
      findings:()=>{const ids=new Set(actionable().map(f=>f.id));return issued.task.findings.filter(f=>ids.has(f.id));},
      comments,showComments:()=>showComment(),
      result:id=>reported(id)?.agent,
      explanation:id=>reported(id)?.explanation??'',
      draftKind:id=>reported(id)?.draftKind??'needs_correction',
      saveExplanation:async(id,value,kind)=>{const nextKind=kind??'needs_correction',previous=reported(id);if(previous?.explanation===value&&previous?.draftKind===nextKind)return;api.updateReturned(r=>{const f=r.reported.find(f=>f.id===id);f.explanation=value;f.draftKind=nextKind;});},
      decision:id=>reported(id)?.decision,
      state:id=>(reported(id)?.state??'unchecked').replaceAll('_',' '),
      canApprove:()=>!api.comparisonActive(),
      location:id=>get()?.locations?.[id],
      // Synchronous controls need only presence/identity. Actions below still
      // capture the full owned review before selecting or modifying its note.
      note:id=>{const findingId=api.associatedFindingId(id);return findingId?{id:findingId}:null;},
      addNote:async id=>{const s=api.capture();if(s.comparison||api.status().busy)return;api.newRegion(id);await render();},
      showNote:async id=>{const s=api.capture(),note=currentAssociation(s.returned,id,s.review);if(note&&!s.comparison)await api.selectMark(note.id);},
      saveDecision:async(id,value,explanation)=>{
        if(value!=='looks_correct'&&!explanation.trim())throw new Error('Add your explanation before requesting another correction or source clarification.');
        const state={looks_correct:'resolved',needs_correction:'open',needs_clarification:'needs_source_clarification'}[value];
        await api.lock(()=>api.commitDecision(r=>{const f=r.reported.find(f=>f.id===id);f.explanation=explanation;f.state=state;f.decision={state,explanation,at:new Date().toISOString(),reviewed:{snapshotId:r.contentSnapshotId,codeSha256:r.codeSha256,renderSha256:r.renderSha256}};}));
        $('roundStatus').textContent='Human decision saved.';return true;
      },
      onSelect:async next=>{position=next;}
    });
    controls();api.clearMessage?.('returned-view');
  }
  $('roundReload').onclick=guard('returned-reload',async()=>{if(api.status().busy)return false;await api.reloadReturned();await render();});
  $('roundVersion').onchange=guard('returned-version',async()=>{const s=api.capture();if(!s.returned)return false;const issued=await retained(s.returned.taskId);await api.compare($('roundVersion').value==='previous'?issued.files.rendered.blob:null);await render();});
  document.addEventListener('score-desk-change',event=>{if(event.detail?.draft)return;render().catch(e=>api.message(e.message,true,'returned-view'));});document.addEventListener('score-desk-controls',()=>{controls();if(!api.status().busy)render().catch(e=>api.message(e.message,true,'returned-view'));});
  return {io,open,attach,render,showComment:guard('returned-comment',showComment),isBusy:()=>working,selected:()=>position};
}
