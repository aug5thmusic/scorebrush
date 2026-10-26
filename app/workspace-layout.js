// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// View preferences only: never stored with review data or exported task hashes.
const KEY='score-desk-workspace-layout-v1';
const $=id=>document.getElementById(id);
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const defaults=mode=>({ratio:.5,findings:300,collapsed:false,max:'none'});
function readPreferences(){
  const result={normal:defaults('normal'),comparison:defaults('comparison')};
  try{
    const raw=localStorage.getItem(KEY);if(!raw||raw.length>2048)return result;
    const value=JSON.parse(raw);if(value?.version!==1)return result;
    for(const mode of ['normal','comparison']){
      const p=value[mode];if(!p||typeof p!=='object')continue;
      result[mode]={ratio:Number.isFinite(p.ratio)?clamp(p.ratio,.2,.8):.5,findings:Number.isFinite(p.findings)?clamp(p.findings,220,560):300,collapsed:typeof p.collapsed==='boolean'?p.collapsed:false,max:['none','source','rendered'].includes(p.max)?p.max:'none'};
    }
  }catch{/* Unavailable or invalid preference storage cannot block a review. */}
  return result;
}
export function installWorkspaceLayout(api){
  const main=document.querySelector('main'),wide=matchMedia('(min-width:900px)'),preferences=readPreferences();
  let mode='normal',wasWide=wide.matches,drag=null,restoreTimer=null,preserved=null,frame=0,lastWidth=-1,positionGeneration=0,activeRestores=0;
  const separator=(id,label,controls)=>{const el=document.createElement('div');el.id=id;el.className='workspace-divider';el.tabIndex=0;el.setAttribute('role','separator');el.setAttribute('aria-orientation','vertical');el.setAttribute('aria-label',label);el.setAttribute('aria-controls',controls);el.title=label+' · drag or use arrow keys; Enter resets';main.append(el);return el;};
  const scores=separator('scoreDivider','Resize score panes','sourceViewer renderedViewer');
  const findings=separator('findingsDivider','Resize Findings pane','commentsPanel commentDock');
  const reopen=document.createElement('button');reopen.id='reopenFindings';reopen.type='button';reopen.className='workspace-reopen';reopen.textContent='Findings';reopen.setAttribute('aria-label','Expand Findings pane');reopen.setAttribute('aria-controls','commentsPanel');reopen.onclick=()=>setFindings(true);main.append(reopen);
  const maximize={};
  for(const kind of ['source','rendered']){
    const button=document.createElement('button');button.id=kind+'Maximize';button.type='button';button.className='workspace-maximize';button.innerHTML='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/></svg>';
    button.onclick=()=>change(()=>{preferences[mode].max=preferences[mode].max===kind?'none':kind;});
    $(kind+'Viewer').querySelector('.viewer-head').append(button);maximize[kind]=button;
  }
  const isDesktop=()=>wide.matches;
  const save=()=>{try{localStorage.setItem(KEY,JSON.stringify({version:1,...preferences}));}catch{/* Layout still works for this session. */}};
  function rememberPositions(){
    if(preserved)return;
    preserved={stamp:api.status(),mode,generation:++positionGeneration,positions:{},assets:{}};
    for(const kind of ['source','rendered']){
      if($(kind+'Scroll').clientWidth)preserved.positions[kind]=api.viewPosition(kind);
      preserved.assets[kind]=$(kind+'Viewer').dataset.renderSha256;
    }
  }
  function discardPositions(){positionGeneration++;clearTimeout(restoreTimer);restoreTimer=null;preserved=null;}
  function restorePositions(){
    clearTimeout(restoreTimer);
    restoreTimer=setTimeout(async()=>{
      const saved=preserved;preserved=null;restoreTimer=null;
      const current=()=>saved&&saved.generation===positionGeneration&&saved.mode===mode&&api.matches(saved.stamp)&&!api.status().busy;
      if(!current())return;
      activeRestores++;let failed=false,restored=false;
      try{for(const kind of ['source','rendered']){
          const position=saved.positions[kind];
          const isCurrent=()=>current()&&$(kind+'Viewer').dataset.renderSha256===saved.assets[kind]&&Number($(kind+'Page').value)===position.page&&$(kind+'Zoom').value===String(position.zoom);
          if(!position||!isCurrent())continue;
          try{await api.positionView(kind,position,{isCurrent});restored=true;}catch(error){failed=true;if(isCurrent())api.message?.('Could not restore the score view: '+error.message,true,'workspace-layout');}
        }
        if(restored&&!failed&&current())api.clearMessage?.('workspace-layout');
      }finally{activeRestores--;}
    },220);
  }
  function dimensions(){
    const width=main.clientWidth,p=preferences[mode],sidebar=p.collapsed?28:clamp(p.findings,220,Math.min(560,width-2*270-12));
    const available=Math.max(0,width-sidebar-(p.collapsed?0:6)-6),minimum=Math.min(270,available/2),left=clamp(available*p.ratio,minimum,available-minimum);
    return {width,sidebar,available,minimum,left,right:available-left};
  }
  function apply(){
    const nextMode=document.body.classList.contains('corrections-open')?'comparison':'normal',enteringNarrowComparison=!wide.matches&&(nextMode!==mode||wasWide);wasWide=wide.matches;
    if(nextMode!==mode){cancelDrag(false);discardPositions();mode=nextMode;}
    if(document.body.classList.contains('workspace-adjustable')!==wide.matches)document.body.classList.toggle('workspace-adjustable',wide.matches);
    const p=preferences[mode],d=dimensions();
    document.body.dataset.workspaceMax=p.max;document.body.dataset.workspaceFindings=p.collapsed?'collapsed':'open';
    main.style.setProperty('--workspace-left',d.left+'px');main.style.setProperty('--workspace-right',d.right+'px');main.style.setProperty('--workspace-findings',d.sidebar+'px');
    main.style.setProperty('--workspace-findings-divider',p.collapsed?'0px':'6px');
    if($('comparisonFindings'))$('comparisonFindings').setAttribute('aria-expanded',String(!p.collapsed));
    const maximized=p.max!=='none';scores.hidden=!wide.matches||maximized;findings.hidden=!wide.matches||p.collapsed;reopen.hidden=!wide.matches||!p.collapsed;
    for(const [kind,button]of Object.entries(maximize)){
      const name=$(kind+'Label').textContent,active=p.max===kind;
      button.hidden=!wide.matches;button.setAttribute('aria-label',active?'Restore both scores':'Maximize '+name);button.title=active?'Restore both scores':'Maximize '+name;button.setAttribute('aria-pressed',String(active));
    }
    scores.setAttribute('aria-valuemin',String(Math.round(d.minimum/d.available*100)));scores.setAttribute('aria-valuemax',String(Math.round((d.available-d.minimum)/d.available*100)));scores.setAttribute('aria-valuenow',String(Math.round(d.left/d.available*100)));scores.setAttribute('aria-valuetext',Math.round(d.left/d.available*100)+'% for the left score');
    findings.setAttribute('aria-valuemin','220');findings.setAttribute('aria-valuemax',String(Math.floor(Math.min(560,d.width-552))));findings.setAttribute('aria-valuenow',String(Math.round(d.sidebar)));findings.setAttribute('aria-valuetext',Math.round(d.sidebar)+' pixels');
    if(!wide.matches&&mode==='comparison'){if(enteringNarrowComparison)document.body.classList.toggle('comments-open',!p.collapsed);const open=document.body.classList.contains('comments-open');$('commentsPanel').inert=api.status().busy||!open;$('toggleComments').setAttribute('aria-expanded',String(open));$('comparisonFindings')?.setAttribute('aria-expanded',String(open));}
    if(wide.matches){$('commentsPanel').inert=api.status().busy||p.collapsed;$('toggleComments').setAttribute('aria-expanded',String(!p.collapsed));}
  }
  function change(mutator){if(!wide.matches||api.status().busy)return;rememberPositions();mutator();apply();save();restorePositions();}
  function setFindings(open){if(!wide.matches&&mode==='comparison'&&!api.status().busy){preferences[mode].collapsed=!open;document.body.classList.toggle('comments-open',open);apply();save();}else change(()=>{preferences[mode].collapsed=!open;});if(open)$('closeComments').focus({preventScroll:true});else reopen.focus({preventScroll:true});}
  function cancelDrag(rollback=true){
    if(!drag)return;const current=drag;drag=null;
    if(rollback&&current.mode===mode)preferences[mode]={...current.start};
    if(current.element.hasPointerCapture(current.pointerId))current.element.releasePointerCapture(current.pointerId);
    document.body.classList.remove('workspace-resizing');apply();restorePositions();
  }
  for(const [element,type]of [[scores,'scores'],[findings,'findings']]){
    element.addEventListener('pointerdown',event=>{
      if(event.button!==0||!wide.matches||api.status().busy)return;event.preventDefault();element.focus({preventScroll:true});rememberPositions();
      drag={element,type,pointerId:event.pointerId,mode,start:{...preferences[mode]}};element.setPointerCapture(event.pointerId);document.body.classList.add('workspace-resizing');
    });
    element.addEventListener('pointermove',event=>{
      if(!drag||drag.element!==element||drag.pointerId!==event.pointerId)return;
      const bounds=main.getBoundingClientRect(),d=dimensions(),p=preferences[mode];
      if(type==='scores')p.ratio=clamp((event.clientX-bounds.left)/d.available,d.minimum/d.available,1-d.minimum/d.available);
      else p.findings=clamp(bounds.right-event.clientX,220,Math.min(560,d.width-552));
      apply();
    });
    element.addEventListener('pointerup',event=>{if(drag?.element!==element||drag.pointerId!==event.pointerId)return;cancelDrag(false);save();});
    element.addEventListener('pointercancel',()=>cancelDrag());element.addEventListener('lostpointercapture',()=>cancelDrag());
    element.addEventListener('keydown',event=>{
      if(event.key==='Escape'&&drag){event.preventDefault();cancelDrag();return;}
      if(!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;event.preventDefault();
      change(()=>{const p=preferences[mode],d=dimensions(),step=event.shiftKey?40:16,delta=event.key==='ArrowRight'?step:-step;
        if(type==='scores')p.ratio=event.key==='Enter'?.5:event.key==='Home'?d.minimum/d.available:event.key==='End'?1-d.minimum/d.available:clamp((d.left+delta)/d.available,d.minimum/d.available,1-d.minimum/d.available);
        else p.findings=event.key==='Enter'?300:event.key==='Home'?220:event.key==='End'?Math.min(560,d.width-552):clamp(d.sidebar-delta,220,Math.min(560,d.width-552));
      });
    });
  }
  // Do not restore an old position over a subsequent page jump or user scroll.
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.workspace-divider,.workspace-maximize,#reopenFindings,#toggleComments,#closeComments'))discardPositions();},true);
  document.addEventListener('wheel',discardPositions,{capture:true,passive:true});
  document.addEventListener('score-desk-view-navigation',discardPositions);
  document.addEventListener('keydown',event=>{if(!event.target.closest('.workspace-divider')&&!['Tab','Shift'].includes(event.key))discardPositions();},true);
  const observer=new ResizeObserver(()=>{if(main.clientWidth===lastWidth)return;lastWidth=main.clientWidth;cancelAnimationFrame(frame);frame=requestAnimationFrame(apply);});observer.observe(main);
  new MutationObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(apply);}).observe(document.body,{attributes:true,attributeFilter:['class']});
  document.addEventListener('score-desk-controls',apply);
  wide.addEventListener('change',()=>{cancelDrag(false);discardPositions();apply();});
  apply();
  return {isDesktop,isSettled:()=>!drag&&!preserved&&!restoreTimer&&!activeRestores,setFindings,toggleFindings:()=>setFindings(!wide.matches&&mode==='comparison'?!document.body.classList.contains('comments-open'):preferences[mode].collapsed),revealScore:kind=>{if(wide.matches&&preferences[mode].max!=='none'&&preferences[mode].max!==kind)change(()=>{preferences[mode].max=kind;});},refresh:apply};
}
