// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Wheel intent is interface state only. A gesture must START at an edge: reaching
// it through ordinary scrolling cannot arm its momentum tail to turn a page.
export const PAGE_SCROLL = Object.freeze({idleMs:240,cooldownMs:320,thresholdPx:64,jitterPx:2,linePx:16,axisRatio:1.25,edgePx:2});
export const pageScrollPreferenceKey='score-desk-scroll-between-pages-v1';

export function normalizedWheel(event,pageHeight){
  // Read mode first: some browsers adapt delta values when it is accessed.
  const mode=event.deltaMode,unit=mode===0?1:mode===1?PAGE_SCROLL.linePx:mode===2?pageHeight:NaN;
  return {x:event.deltaX*unit,y:event.deltaY*unit};
}

export function createPageScrollGesture(now=()=>performance.now()){
  let gesture=null,pending=false,cooldownUntil=-Infinity;
  function block(){
    gesture={last:now(),spent:true};
  }
  function settled(){
    pending=false;block();gesture.turned=true;cooldownUntil=now()+PAGE_SCROLL.cooldownMs;
  }
  function wheel(event,{allowed,scene,top,height,clientHeight,page,pages}){
    const time=now(),{x,y}=normalizedWheel(event,clientHeight);
    if(pending){block();gesture.turned=true;return {turn:0,consume:true};}
    if(!allowed||!Number.isFinite(x)||!Number.isFinite(y)){block();return {turn:0,consume:false};}
    if(!gesture||time-gesture.last>=PAGE_SCROLL.idleMs){
      gesture={last:time,scene,spent:time<cooldownUntil,turned:time<cooldownUntil,direction:0,total:0,
        atTop:top<=PAGE_SCROLL.edgePx,atBottom:height-clientHeight-top<=PAGE_SCROLL.edgePx};
    }
    gesture.last=time;
    if(gesture.scene!==scene)gesture.spent=true;
    if(gesture.spent)return {turn:0,consume:Boolean(gesture.turned)};
    if(Math.max(Math.abs(x),Math.abs(y))<PAGE_SCROLL.jitterPx)return {turn:0,consume:false};
    const direction=Math.sign(y);
    // A horizontal/mixed gesture or a meaningful reversal needs another idle
    // boundary. It cannot reuse accumulated intent in the opposite direction.
    if(Math.abs(y)<Math.abs(x)*PAGE_SCROLL.axisRatio||!direction||gesture.direction&&gesture.direction!==direction){gesture.spent=true;return {turn:0,consume:false};}
    gesture.direction=direction;
    const edge=direction>0?gesture.atBottom:gesture.atTop;
    const stillAtEdge=direction>0?height-clientHeight-top<=PAGE_SCROLL.edgePx:top<=PAGE_SCROLL.edgePx;
    if(!edge||!stillAtEdge){gesture.spent=true;return {turn:0,consume:false};}
    gesture.total+=Math.abs(y);
    if(gesture.total<PAGE_SCROLL.thresholdPx)return {turn:0,consume:false};
    gesture.spent=true;
    if(page+direction<1||page+direction>pages)return {turn:0,consume:false};
    gesture.turned=true;pending=true;return {turn:direction,consume:true};
  }
  return {wheel,block,settled};
}
