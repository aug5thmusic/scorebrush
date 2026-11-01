// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {paint,drawStroke} from '../app/model.js';

function context(alpha){
  const states=[],draws=[];
  return {globalAlpha:alpha,draws,save(){states.push(this.globalAlpha);},restore(){this.globalAlpha=states.pop();},
    beginPath(){},moveTo(){},lineTo(){},quadraticCurveTo(){},closePath(){},arc(){},
    stroke(){draws.push({op:'stroke',alpha:this.globalAlpha});},fill(){draws.push({op:'fill',alpha:this.globalAlpha});},fillText(){draws.push({op:'text',alpha:this.globalAlpha});},
    measureText(){return {actualBoundingBoxLeft:0,actualBoundingBoxRight:5,actualBoundingBoxAscent:8,actualBoundingBoxDescent:0};}};
}
const viewport={width:612,height:792,scale:1,userUnit:1,convertToViewportPoint:(x,y)=>[x,y]};
const stroke={color:'#443dd0',width:12,opacity:.35,points:[[100,100],[200,100]]};
test('historical stroke opacity multiplies caller alpha and restores it afterward',()=>{
  const ctx=context(.3),before=JSON.stringify(stroke);drawStroke(ctx,viewport,stroke);
  assert.equal(ctx.draws[0].alpha,.3*Math.min(1,.35*1.12));assert.equal(ctx.globalAlpha,.3);assert.equal(JSON.stringify(stroke),before);
});
test('historical finding markers and labels honor caller alpha for each finding type',()=>{
  for(const type of ['correction','comment','source_footnote']){
    const ctx=context(.3),findings=[{id:'synthetic',number:1,page:1,type,strokes:[stroke]}],before=JSON.stringify(findings);
    paint(ctx,viewport,findings,1);assert(Math.abs(ctx.draws[0].alpha-.1176)<1e-12);
    assert(ctx.draws.slice(1).every(draw=>draw.alpha===.3));assert.equal(ctx.globalAlpha,.3);assert.equal(JSON.stringify(findings),before);
  }
});
test('selected marks and ordinary export painting retain full marker opacity and existing stroke darkness',()=>{
  const ctx=context(1);paint(ctx,viewport,[{number:1,page:1,strokes:[stroke]}],1, {...stroke,points:[[300,300]]});
  assert.equal(ctx.draws[0].alpha,.35*1.12);assert(ctx.draws.slice(1,-1).every(draw=>draw.alpha===1));assert.equal(ctx.draws.at(-1).alpha,.35*1.12);assert.equal(ctx.globalAlpha,1);
});
