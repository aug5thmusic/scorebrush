// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// All geometry uses PDF.js's native, unrotated PDF user space, including crop offsets.
export const SCHEMA = 'score-desk-review';
export const VERSION = 2;
export const PALETTE = [
  {name:'Yellow',color:'#ffd34d'}, {name:'Mint',color:'#65d6a3'},
  {name:'Blue',color:'#74b9ff'}, {name:'Pink',color:'#f49ac2'},
  {name:'Lavender',color:'#b7a2ff'}
];
export const defaultPreferences = () => ({color:PALETTE[0].color,autoColor:true,colorCursor:0});
const allowedColor = color => PALETTE.some(p=>p.color===color);
export const COORDINATES = 'pdf-user-space; unrotated; crop-box offsets retained; 1-based pages';
export const STATES = ['open','corrected_pending_review','resolved','needs_source_clarification'];
export const FINDING_TYPES = ['correction','source_footnote','comment'];
export const findingType = finding => finding?.type ?? 'correction';
export const isComment = finding => findingType(finding)==='comment';
// Absence is the legacy correction type. Do not add defaults to historical
// evidence: exact annotation/state hashes also cover optional field presence.
export const findingTypeFields = finding => Object.hasOwn(finding,'type') ? {type:finding.type} : {};
export const findingTypeLabel = finding => isComment(finding) ? 'Comment' : findingType(finding)==='source_footnote' ? 'Footnote' : 'Correction';
export const roles = ['source','rendered','ly'];
export const clone = value => structuredClone(value);
// Completed strokes never change their geometry. Undo owns editable metadata
// (including stroke colours), but shares frozen point arrays across its 80
// entries instead of retaining 80 deep copies of every coordinate pair.
export function annotationSnapshot(review){
  if(!review)return review;
  const copy=clone({...review,findings:[]});
  copy.findings=review.findings.map(finding=>{
    const next=clone({...finding,strokes:[]});
    next.strokes=finding.strokes.map(stroke=>{
      const points=stroke.points;
      if(!Object.isFrozen(points)){for(const point of points)Object.freeze(point);Object.freeze(points);}
      return {...clone({...stroke,points:[]}),points};
    });return next;
  });return copy;
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
// Owned Blobs are immutable. Disk-backed Files must always be read afresh so
// external changes, permission loss and replaced files cannot reuse a digest.
const blobHashes=new WeakMap();
export function blobHash(blob){
  if(Object.prototype.toString.call(blob)!=='[object Blob]')return blob.arrayBuffer().then(sha256);
  let digest=blobHashes.get(blob);
  if(!digest){digest=blob.arrayBuffer().then(sha256);blobHashes.set(blob,digest);digest.catch(()=>blobHashes.delete(blob));}
  return digest;
}
export async function identify(files) {
  const identity = {};
  for (const role of roles) {
    const f = files[role];
    identity[role] = {name:f.name, size:f.blob.size, sha256:await blobHash(f.blob)};
  }
  const snapshotId = await sha256(new TextEncoder().encode(roles.map(r=>`${r}:${identity[r].sha256}`).join('\n')));
  return {identity, snapshotId};
}
export function newReview(identity, snapshotId, pages) {
  return {schema:SCHEMA,version:VERSION,snapshotId,files:identity,relationship:'user-supplied; not established by compilation',coordinates:COORDINATES,pages,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nextNumber:1,findings:[],preferences:defaultPreferences(),coverage:'Not declared; no verification is claimed.'};
}
export function bounds(strokes) {
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for(const s of strokes) for(const [x,y] of s.points){x0=Math.min(x0,x-s.width/2);y0=Math.min(y0,y-s.width/2);x1=Math.max(x1,x+s.width/2);y1=Math.max(y1,y+s.width/2);}
  return x0===Infinity?null:[x0,y0,x1,y1];
}
// Screen paint and hit testing share marker geometry, including rotation/crops.
export function markerPosition(viewport,finding) {
  if(!finding.strokes.length)return null;
  let x=Infinity,y=Infinity;
  for(const s of finding.strokes)for(const p of s.points){const [px,py]=viewport.convertToViewportPoint(...p);x=Math.min(x,px);y=Math.min(y,py);}
  const radius=11*viewport.scale*viewport.userUnit;
  return {x:Math.max(radius+2,Math.min(viewport.width-radius-2,x)),y:Math.max(radius+2,Math.min(viewport.height-radius-2,y-radius-3)),radius};
}
export function hitFinding(viewport,findings,pageNumber,x,y) {
  // Last painted wins when marks overlap. All distances are in CSS pixels.
  for(const f of findings.filter(f=>f.page===pageNumber).slice().reverse()){
    const marker=markerPosition(viewport,f);
    if(marker&&(isComment(f)||findingType(f)==='source_footnote'?Math.abs(x-marker.x)<=marker.radius+3&&Math.abs(y-marker.y)<=marker.radius+3:Math.hypot(x-marker.x,y-marker.y)<=marker.radius+3))return f;
    for(const s of f.strokes){
      const points=s.points.map(p=>viewport.convertToViewportPoint(...p)),radius=s.width*viewport.scale*viewport.userUnit/2+3;
      for(let i=0;i<points.length;i++){
        const a=points[Math.max(0,i-1)],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1],length=dx*dx+dy*dy;
        const t=length?Math.max(0,Math.min(1,((x-a[0])*dx+(y-a[1])*dy)/length)):0;
        if(Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy)<=radius)return f;
      }
    }
  }
  return null;
}
// Shared by screen, crops, and the flattened PDF. Each stroke is composited once.
export function paint(ctx, viewport, findings, pageNumber, draft=null) {
  for (const f of findings.filter(f=>f.page===pageNumber)) {
    for (const s of f.strokes) drawStroke(ctx,viewport,s);
    const box=bounds(f.strokes);
    if(!box) continue;
    const {x,y,radius}=markerPosition(viewport,f);
    ctx.save();ctx.globalAlpha=1;ctx.beginPath();
    if(isComment(f)){
      // An outlined speech bubble stays distinct from correction circles even
      // in monochrome evidence. Keep its locator within the same marker bounds.
      const r=radius,k=r*.3;
      ctx.moveTo(x-r+k,y-r);ctx.lineTo(x+r-k,y-r);ctx.quadraticCurveTo(x+r,y-r,x+r,y-r+k);
      ctx.lineTo(x+r,y+r*.4);ctx.quadraticCurveTo(x+r,y+r*.7,x+r-k,y+r*.7);
      ctx.lineTo(x-r*.25,y+r*.7);ctx.lineTo(x-r*.75,y+r);ctx.lineTo(x-r*.75,y+r*.7);
      ctx.quadraticCurveTo(x-r,y+r*.7,x-r,y+r*.4);ctx.lineTo(x-r,y-r+k);ctx.quadraticCurveTo(x-r,y-r,x-r+k,y-r);ctx.closePath();
      ctx.fillStyle='#f0f3f8';ctx.fill();ctx.strokeStyle='#515b70';ctx.lineWidth=1.3*viewport.scale*viewport.userUnit;ctx.stroke();ctx.fillStyle='#384256';
    }else if(findingType(f)==='source_footnote'){
      // The amber box identifies a footnote; its centered label remains the
      // finding number, independent of the final score's footnote numbering.
      const r=radius,k=r*.22;
      ctx.moveTo(x-r+k,y-r);ctx.lineTo(x+r-k,y-r);ctx.quadraticCurveTo(x+r,y-r,x+r,y-r+k);
      ctx.lineTo(x+r,y+r-k);ctx.quadraticCurveTo(x+r,y+r,x+r-k,y+r);
      ctx.lineTo(x-r+k,y+r);ctx.quadraticCurveTo(x-r,y+r,x-r,y+r-k);
      ctx.lineTo(x-r,y-r+k);ctx.quadraticCurveTo(x-r,y-r,x-r+k,y-r);ctx.closePath();
      ctx.fillStyle='#fff3d6';ctx.fill();ctx.strokeStyle='#925e0a';ctx.lineWidth=1.3*viewport.scale*viewport.userUnit;ctx.lineJoin='round';ctx.stroke();ctx.fillStyle='#754704';
    }else{ctx.arc(x,y,radius,0,2*Math.PI);ctx.fillStyle='#443dd0';ctx.fill();ctx.fillStyle='#fff';}
    ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.font=`bold ${11*viewport.scale*viewport.userUnit}px sans-serif`;
    // Center the visible glyphs, not the advance width or the font's em box.
    const label=String(f.number),ink=ctx.measureText(label);
    ctx.fillText(label,x+(ink.actualBoundingBoxLeft-ink.actualBoundingBoxRight)/2,y+(ink.actualBoundingBoxAscent-ink.actualBoundingBoxDescent)/2+(isComment(f)?-radius*.15:0));ctx.restore();
  }
  if(draft) drawStroke(ctx,viewport,draft);
}
// Keep stored stroke opacity unchanged for old reviews and backup hashes.
// The shared painter makes both live marks and new exported evidence 12% darker.
export function drawStroke(ctx,viewport,s) {
  ctx.save();ctx.strokeStyle=s.color;ctx.fillStyle=s.color;ctx.globalAlpha=Math.min(1,s.opacity*1.12);ctx.lineWidth=s.width*viewport.scale*viewport.userUnit;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
  s.points.forEach((p,i)=>{const [x,y]=viewport.convertToViewportPoint(...p);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);});
  if(s.points.length===1){const [x,y]=viewport.convertToViewportPoint(...s.points[0]);ctx.arc(x,y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}else ctx.stroke();ctx.restore();
}
export function validateReview(value, expected) {
  const fail=message=>{throw new Error(`Review rejected: ${message}`);};
  if(!value||value.schema!==SCHEMA||![1,VERSION].includes(value.version))fail('unsupported schema or version.');
  if(value.snapshotId!==expected.snapshotId)fail('file snapshot mismatch. Select the exact original PDF, rendered PDF, and LilyPond bytes used for this review.');
  if(value.coordinates!==COORDINATES)fail('unsupported coordinate convention.');
  for(const r of roles)if(value.files?.[r]?.sha256!==expected.files[r].sha256||value.files[r].size!==expected.files[r].size)fail(`${r} file hash/size mismatch.`);
  if(value.relationship!==expected.relationship)fail('invalid PDF/code relationship.');
  if(!Array.isArray(value.pages)||JSON.stringify(value.pages)!==JSON.stringify(expected.pages))fail('rendered page geometry differs.');
  if(!Array.isArray(value.findings)||value.findings.length>2000)fail('too many findings or missing list.');
  // Reviews predating stored preferences used a fixed color. Preserve that
  // behavior on import; only newly created reviews start with color cycling.
  const preferences=value.preferences??{...defaultPreferences(),autoColor:false};
  if(!allowedColor(preferences.color)||typeof preferences.autoColor!=='boolean'||!Number.isInteger(preferences.colorCursor)||preferences.colorCursor<0||preferences.colorCursor>=PALETTE.length)fail('invalid highlight preferences.');
  const ids=new Set(),numbers=new Set(); let pointCount=0;
  for(const f of value.findings){
    if(typeof f.id!=='string'||!/^[\w-]{1,80}$/.test(f.id)||ids.has(f.id))fail('invalid or duplicate finding ID.');ids.add(f.id);
    if(!Number.isSafeInteger(f.number)||f.number<1||f.number>99999||numbers.has(f.number))fail('invalid or duplicate finding number.');numbers.add(f.number);
    if(typeof f.comment!=='string'||f.comment.length>4000||!STATES.includes(f.state))fail('invalid comment or state.');
    if(Object.hasOwn(f,'type')&&!FINDING_TYPES.includes(f.type))fail('invalid finding type.');
    if(!Number.isInteger(f.page)||f.page<1||f.page>expected.pages.length)fail('invalid page.');
    const [x0,y0,x1,y1]=expected.pages[f.page-1].view;
    if(!Array.isArray(f.strokes)||f.strokes.length>5000)fail('invalid strokes.');
    const color=f.color??f.strokes[0]?.color??PALETTE[0].color;
    if(!allowedColor(color))fail('highlight color is outside the allowed palette.');
    for(const s of f.strokes){
      if(!Number.isFinite(s.width)||s.width<2||s.width>36||s.color!==color||s.opacity!==0.35||!Array.isArray(s.points)||!s.points.length)fail('invalid brush or inconsistent finding color.');
      pointCount+=s.points.length;if(pointCount>200000)fail('review exceeds 200,000 point limit.');
      for(const p of s.points)if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<x0||p[0]>x1||p[1]<y0||p[1]>y1)fail('coordinates outside page bounds.');
    }
    const actual=bounds(f.strokes);
    if(JSON.stringify(actual)!==JSON.stringify(f.bounds))fail('stroke bounding box differs.');
  }
  if(!Number.isSafeInteger(value.nextNumber)||value.nextNumber<=Math.max(0,...numbers)||value.nextNumber>100000)fail('invalid next finding number.');
  // Whitelist imported properties; comments are always rendered with textContent/value.
  return {...clone(expected),version:VERSION,preferences:{color:preferences.color,autoColor:preferences.autoColor,colorCursor:preferences.colorCursor},createdAt:typeof value.createdAt==='string'?value.createdAt.slice(0,80):expected.createdAt,nextNumber:value.nextNumber,findings:clone(value.findings).map(f=>({id:f.id,number:f.number,page:f.page,color:f.color??f.strokes[0]?.color??PALETTE[0].color,comment:f.comment,state:f.state,...findingTypeFields(f),strokes:f.strokes.map(s=>({width:s.width,color:s.color,opacity:s.opacity,points:s.points})),bounds:f.bounds})),updatedAt:new Date().toISOString()};
}
