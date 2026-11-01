// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PDF_DISPLAY_LIMITS as limits,pdfDisplayScale,pdfRenderPlan,sizePdfCanvas} from '../app/pdf-rendering.js';

function bounded(plan,natural){
  assert(plan.scale>0&&Number.isFinite(plan.scale));assert(plan.pixelRatio>0&&Number.isFinite(plan.pixelRatio));
  assert(natural.width*plan.scale<=limits.dimension+1e-7&&natural.height*plan.scale<=limits.dimension+1e-7);
  assert(Number.isInteger(plan.canvasWidth)&&plan.canvasWidth>0&&plan.canvasWidth<=limits.canvasDimension);
  assert(Number.isInteger(plan.canvasHeight)&&plan.canvasHeight>0&&plan.canvasHeight<=limits.canvasDimension);
  assert(plan.canvasWidth*plan.canvasHeight<=limits.canvasPixels);
}
test('ordinary PDF fit and numeric zoom retain CSS geometry and requested DPR',()=>{
  const natural={width:612,height:792};
  for(const zoom of ['fit',.5,.75,1,1.25,1.5,2,3]){
    const plan=pdfRenderPlan(natural,{zoom,availableWidth:638,devicePixelRatio:1});bounded(plan,natural);
    assert.equal(plan.scale,zoom==='fit'?638/612:zoom);assert.equal(plan.pixelRatio,1);assert.equal(plan.scaleLimited,false);assert.equal(plan.resolutionLimited,false);
  }
});
test('fit width can fall below fifteen percent without altering the page aspect ratio',()=>{
  const natural={width:14400,height:14400},plan=pdfRenderPlan(natural,{zoom:'fit',availableWidth:638,devicePixelRatio:3});bounded(plan,natural);
  assert(plan.scale<.15);assert.equal(natural.width*plan.scale,638);assert.equal(plan.canvasWidth,1914);assert.equal(plan.canvasHeight,1914);
});
test('large, tall, wide and high-user-unit pages stay within CSS and raster limits at high DPI',()=>{
  for(const natural of [{width:14400,height:14400},{width:10,height:1e8},{width:1e8,height:10},{width:1e10,height:1e10},{width:612,height:792},{width:32768,height:32767}]){
    for(const zoom of ['fit',.5,1,3])for(const dpr of [1,1.25,2,3,8])bounded(pdfRenderPlan(natural,{zoom,availableWidth:638,devicePixelRatio:dpr}),natural);
  }
});
test('canvas pixel budget includes rounding, so fractional dimensions cannot exceed it',()=>{
  const natural={width:4000.01,height:4000.01},plan=pdfRenderPlan(natural,{zoom:1,devicePixelRatio:1});bounded(plan,natural);
  assert.equal(plan.scale,1);assert(plan.resolutionLimited);assert.equal(plan.canvasWidth,4000);assert.equal(plan.canvasHeight,4000);
});
test('one uniform actual viewport scale preserves normalized PDF geometry',()=>{
  const natural={width:90000,height:60000},plan=pdfRenderPlan(natural,{zoom:3,devicePixelRatio:3});bounded(plan,natural);assert(plan.scaleLimited);
  for(const [x,y]of [[0,0],[.1,.8],[.5,.5],[1,1]]){
    const css=[x*natural.width*plan.scale,y*natural.height*plan.scale];
    assert(Math.abs(css[0]/(natural.width*plan.scale)-x)<1e-12);assert(Math.abs(css[1]/(natural.height*plan.scale)-y)<1e-12);
  }
  assert.equal(pdfDisplayScale(natural,'fit',638),638/90000);
});
test('invalid geometry fails before allocation and hidden preview widths stay positive',()=>{
  for(const natural of [{width:0,height:1},{width:1,height:-1},{width:NaN,height:1},{width:1,height:Infinity}])assert.throws(()=>pdfRenderPlan(natural),/dimensions/);
  for(const zoom of [0,-1,Infinity,NaN])assert.throws(()=>pdfRenderPlan({width:612,height:792},{zoom}),/scale/);
  const natural={width:612,height:792};bounded(pdfRenderPlan(natural,{availableWidth:-10,devicePixelRatio:NaN}),natural);
});
test('switching between tall and wide pages never allocates an oversized intermediate canvas',()=>{
  let width=100,height=8192;const sizes=[];
  const canvas={get width(){return width;},set width(v){width=v;sizes.push([width,height]);},get height(){return height;},set height(v){height=v;sizes.push([width,height]);}};
  sizePdfCanvas(canvas,{canvasWidth:8192,canvasHeight:100});
  assert(sizes.every(([w,h])=>w*h<=limits.canvasPixels));assert.equal(canvas.width,8192);assert.equal(canvas.height,100);
  assert.throws(()=>sizePdfCanvas(canvas,{canvasWidth:8192,canvasHeight:8192}),/limit/);
});
