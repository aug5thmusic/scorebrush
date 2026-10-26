// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// A screen-only pointer preview. It never touches the annotation canvas or exports.
export function installBrushPreview(api){
  const overlay=document.getElementById('overlay'),scroll=document.getElementById('renderedScroll');
  const preview=document.createElement('div');preview.id='brushPreview';preview.hidden=true;preview.setAttribute('aria-hidden','true');document.body.append(preview);
  let pointer=null,frame=0;
  function hide(){
    if(!preview.hidden)preview.hidden=true;
    if(overlay.classList.contains('brush-preview-visible'))overlay.classList.remove('brush-preview-visible');
  }
  function refresh(){
    frame=0;const state=api.getBrushPreviewState();
    if(!pointer||pointer.buttons||state.mode!=='draw'||!state.editable||state.hidden||state.busy||state.gesture||!state.viewportScale||document.hidden){hide();return;}
    const rect=overlay.getBoundingClientRect(),clip=scroll.getBoundingClientRect(),{x,y}=pointer;
    if(!rect.width||x<Math.max(rect.left,clip.left)||x>=Math.min(rect.right,clip.right)||y<Math.max(rect.top,clip.top)||y>=Math.min(rect.bottom,clip.bottom)||document.elementFromPoint(x,y)!==overlay){hide();return;}
    // PDF.js scale includes zoom, while userUnit and the CSS rectangle account
    // for unusual PDFs and browser layout. Device pixel ratio is not a CSS scale.
    const diameter=state.width*state.viewportScale*(rect.width/state.viewportWidth);
    if(!Number.isFinite(diameter)||diameter<=0){hide();return;}
    preview.style.width=diameter+'px';preview.style.height=diameter+'px';preview.style.left=x+'px';preview.style.top=y+'px';preview.style.setProperty('--brush-color',state.color);
    if(preview.hidden)preview.hidden=false;
    if(!overlay.classList.contains('brush-preview-visible'))overlay.classList.add('brush-preview-visible');
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(refresh);}
  function move(event){
    if(event.pointerType!=='mouse'&&event.pointerType!=='pen'){pointer=null;hide();return;}
    pointer={x:event.clientX,y:event.clientY,buttons:event.buttons};schedule();
  }
  overlay.addEventListener('pointerenter',move);overlay.addEventListener('pointermove',move);overlay.addEventListener('pointerup',move);
  overlay.addEventListener('pointerdown',event=>{move(event);hide();});
  for(const event of ['pointerleave','pointercancel','lostpointercapture'])overlay.addEventListener(event,()=>{pointer=null;hide();});
  window.addEventListener('blur',()=>{pointer=null;hide();});document.addEventListener('visibilitychange',()=>{pointer=null;hide();});
  for(const event of ['score-desk-controls','score-desk-change','score-desk-render','score-desk-view-navigation'])document.addEventListener(event,schedule);
  for(const event of ['input','change','toggle'])document.addEventListener(event,schedule,true);
  scroll.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);
  // Modal/popover changes and maximize/collapse can occur without moving the mouse.
  new MutationObserver(schedule).observe(document.body,{subtree:true,attributes:true,attributeFilter:['class','open','hidden','aria-busy']});
  new ResizeObserver(schedule).observe(scroll);
  return {refresh:schedule};
}
