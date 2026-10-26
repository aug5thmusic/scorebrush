// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageScrollGesture,normalizedWheel,PAGE_SCROLL} from '../app/pdf-page-scroll.js';

function setup(overrides={}){
  let time=0;const controller=createPageScrollGesture(()=>time),geometry={allowed:true,scene:1,top:0,height:500,clientHeight:500,page:2,pages:4,...overrides};
  return {controller,geometry,wait:ms=>time+=ms,wheel:(y=64,x=0,mode=0)=>controller.wheel({deltaMode:mode,deltaX:x,deltaY:y},geometry)};
}
test('normalizes all delta modes, reading mode before the deltas',()=>{
  const order=[],event={get deltaMode(){order.push('mode');return 1;},get deltaX(){order.push('x');return 2;},get deltaY(){order.push('y');return 4;}};
  assert.deepEqual(normalizedWheel(event,500),{x:32,y:64});assert.deepEqual(order,['mode','x','y']);
  assert.deepEqual(normalizedWheel({deltaMode:2,deltaX:0,deltaY:-1},500),{x:0,y:-500});
});
test('fit pages turn both ways; tall pages require a fresh gesture at the edge',()=>{
  for(const direction of [-1,1]){
    const f=setup();assert.equal(f.wheel(64*direction).turn,direction);
    const tall=setup({height:1600,top:300});assert.equal(tall.wheel(200*direction).turn,0);
    tall.geometry.top=direction>0?1100:0;tall.wait(30);assert.equal(tall.wheel(300*direction).turn,0);
    tall.wait(240);assert.equal(tall.wheel(64*direction).turn,direction);
  }
});
test('subthreshold precision input accumulates; jitter does not',()=>{
  const f=setup();for(let i=0;i<200;i++){f.wait(4);assert.equal(f.wheel(.8).turn,0);}
  for(let i=0;i<7;i++){f.wait(10);assert.equal(f.wheel(8).turn,0);}assert.equal(f.wheel(8).turn,1);
});
test('horizontal or mixed-axis intent cannot become a vertical tail',()=>{
  for(const [x,y]of [[90,4],[64,64],[100,0]]){const f=setup();assert.equal(f.wheel(y,x).turn,0);assert.equal(f.wheel(200).turn,0);f.wait(240);assert.equal(f.wheel(64).turn,1);}
});
test('direction reversal discards intent until idle, including after a turn',()=>{
  const f=setup();assert.equal(f.wheel(40).turn,0);assert.equal(f.wheel(-80).turn,0);assert.equal(f.wheel(-80).turn,0);
  f.wait(240);assert.equal(f.wheel(-64).turn,-1);f.controller.settled();f.wait(50);assert.equal(f.wheel(200).turn,0);
});
test('long momentum bursts turn at most once even across slow rendering',()=>{
  const f=setup();assert.equal(f.wheel().turn,1);
  for(let i=0;i<100;i++){f.wait(500);assert.deepEqual(f.wheel(500),{turn:0,consume:true});}
  f.controller.settled();for(let i=0;i<80;i++){f.wait(40);assert.deepEqual(f.wheel(90),{turn:0,consume:true});}
  f.wait(240);assert.equal(f.wheel().turn,1);
});
test('cooldown starts after render completion and swallowed input needs a new idle',()=>{
  const f=setup();f.wheel();f.controller.settled();f.wait(250);assert.equal(f.wheel().turn,0);
  f.wait(80);assert.equal(f.wheel().turn,0);f.wait(240);assert.equal(f.wheel().turn,1);
});
test('document boundaries never wrap',()=>{
  for(const [page,y]of [[1,-100],[4,100]]){const f=setup({page});assert.deepEqual(f.wheel(y),{turn:0,consume:false});f.wait(1000);assert.equal(f.wheel(y).turn,0);}
});
test('blocked input, changed scene and scrolling away from edge disarm a gesture',()=>{
  for(const change of [f=>f.geometry.allowed=false,f=>f.geometry.scene++,f=>{f.geometry.height=900;f.geometry.top=50;}]){
    const f=setup();assert.equal(f.wheel(40).turn,0);change(f);assert.equal(f.wheel(80).turn,0);
    Object.assign(f.geometry,{allowed:true,height:500,top:0});assert.equal(f.wheel(80).turn,0);
    f.wait(240);assert.equal(f.wheel(80).turn,1);
  }
});
test('invalid deltas cannot poison later gestures; fractional edges are tolerated',()=>{
  for(const [y,x,mode]of [[Infinity,0,0],[64,NaN,0],[64,0,99]]){const f=setup();assert.equal(f.wheel(y,x,mode).turn,0);f.wait(240);assert.equal(f.wheel().turn,1);}
  assert.equal(setup({height:900,top:398.5}).wheel().turn,1);
  assert.equal(PAGE_SCROLL.edgePx,2);
});
test('each pane keeps its own gesture state',()=>{
  const left=setup(),right=setup();assert.equal(left.wheel().turn,1);assert.equal(right.wheel(-64).turn,-1);assert.equal(left.wheel().turn,0);
});
