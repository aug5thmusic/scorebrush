// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Display context and bookmarks are deliberately separate from score files,
// annotation coordinates, AI claims, and human approval.
import {clone, sha256, validateReview} from './model.js';
import {taskFindings, contextPaths, strictJSON} from './workflow.js';

// Older local reloads and response templates contain protocol placeholders.
// Keep those immutable records, but do not present them as an AI explanation.
export function aiExplanation(result) {
  const text=typeof result?.explanation==='string'?result.explanation.trim():'';
  const placeholder=/^(?:Loaded updated local files; no per-finding AI explanation was supplied\. Compare and decide\.|Internal comment retained; no score change(?: or correction approval)? requested\.|REPLACE with your source-checked response\.|No (?:per-finding )?(?:AI )?explanation(?: was)? (?:supplied|provided|available)\.?|N\/?A|None|Done|Fixed|Updated|Changed|Unchanged|OK|Acknowledged)[.!]?$/i;
  return text&&!placeholder.test(text)?text:'';
}

export function currentAssociation(round,findingId,review) {
  if(!round||round.contentSnapshotId!==review.snapshotId||round.codeSha256!==review.files.ly.sha256||round.renderSha256!==review.files.rendered.sha256)return null;
  const id=round.reported.find(f=>f.id===findingId)?.associationId;
  return review.findings.find(f=>f.id===id)??null;
}

export function candidateIdentity(review) {
  return {snapshotId:review.snapshotId, codeSha256:review.files.ly.sha256, renderSha256:review.files.rendered.sha256};
}
export function sameCandidate(a,b) {
  return Boolean(a&&b&&['snapshotId','codeSha256','renderSha256'].every(k=>a[k]===b[k]));
}
export function validPosition(p,pages) {
  // Accept historical 25% / 400% bookmarks without changing their review data;
  // the viewer displays unsupported saved zoom levels using Fit width.
  if(!p||!Number.isInteger(p.page)||p.page<1||p.page>pages.length||!['fit',.25,.5,.75,1,1.25,1.5,2,3,4].includes(p.zoom))return false;
  const box=pages[p.page-1].view;
  return Array.isArray(p.point)&&p.point.length===2&&p.point.every(Number.isFinite)&&p.point[0]>=box[0]&&p.point[0]<=box[2]&&p.point[1]>=box[1]&&p.point[1]<=box[3];
}
export function savedLocation(location,findingId,review) {
  return location?.version===1&&location.findingId===findingId&&sameCandidate(location.candidate,candidateIdentity(review))&&validPosition(location.position,review.pages)?location:null;
}
export function bookmark(findingId,review,position) {
  if(!validPosition(position,review.pages))throw new Error('Wait for the revised page to finish loading before locating it.');
  return {version:1,findingId,candidate:candidateIdentity(review),position:clone(position)};
}
export function validateLocations(locations,round,review) {
  if(locations===undefined)return {};
  if(!locations||Array.isArray(locations)||typeof locations!=='object'||Object.keys(locations).length>round.reported.length)throw new Error('Invalid correction locations.');
  for(const [id,value]of Object.entries(locations))if(!round.reported.some(f=>f.id===id)||!savedLocation(value,id,review))throw new Error('Correction location belongs to different files or invalid page geometry.');
  return clone(locations);
}
export async function comparisonContext(issued,finding) {
  const baseline={blob:issued.files.rendered.blob,sha256:issued.task.baseline.renderSha256,marks:issued.review.findings,pages:issued.review.pages,selectedId:finding.id};
  const context=finding.historicalContext,hash=context?.renderSha256??finding.origin?.renderSha256??baseline.sha256;
  const earlier=hash!==baseline.sha256;
  const result={baseline,earlier,page:context?.page??finding.origin?.page??finding.page??1,crops:contextPaths(issued,finding).map(path=>issued.payloads.get(path)),original:null};
  if(!earlier){result.original=baseline;return result;}
  const info=context?.originalFiles?.rendered,blob=issued.payloads.get(info?.path);
  // Legacy follow-ups sometimes retain only crops: never invent a matching PDF.
  if(!blob||info.sha256!==hash||await sha256(await blob.arrayBuffer())!==hash)return result;
  let marks=[],pages=[];
  const raw=issued.payloads.get(context.annotations);
  if(raw){
    const original=strictJSON(await raw.text());
    if(original.files?.rendered?.sha256!==hash)throw new Error('Historical marks do not match their rendering.');
    const checked=validateReview(original,original);pages=checked.pages;
    const originalId=finding.origin?.findingId??finding.id;
    marks=checked.findings.map(f=>f.id===originalId?{...f,id:finding.id,number:finding.number}:f);
  }
  result.original={blob,sha256:hash,marks,pages,selectedId:finding.id};return result;
}
export function taskFinding(issued,id){return taskFindings(issued).find(f=>f.id===id);}

export async function commentReference(issued,finding) {
  const context=await comparisonContext(issued,finding),asset=context.original;
  const mark=asset?.marks.find(f=>f.id===finding.id),[marked,clean]=context.crops;
  // Text-only exports also have a file named marked.png, identical to clean.png.
  // Old crop-only records can still identify this case without guessing a mark.
  const textOnly=mark?mark.strokes.length===0:Boolean(marked&&clean&&await sha256(await marked.arrayBuffer())===await sha256(await clean.arrayBuffer()));
  return {page:mark?.page??context.page,renderSha256:finding.historicalContext?.renderSha256??finding.origin?.renderSha256??context.baseline.sha256,
    textOnly,marked:textOnly?null:marked,asset:mark?.strokes.length?asset:null,mark};
}

// A viewing hint only. Never store this estimate as an annotation or bookmark.
export function approximatePosition(position,previousPages,currentPages,zoom='fit'){
  const clamp=(n,low,high)=>Math.max(low,Math.min(high,n));
  const page=clamp(Number.isInteger(position?.page)?position.page:1,1,currentPages.length);
  const target=currentPages[page-1].view,source=previousPages?.[clamp(position?.page??1,1,previousPages.length)-1]?.view;
  const point=target.slice(0,2).map((low,i)=>{
    const ratio=source&&position?.point&&Number.isFinite(position.point[i])?(position.point[i]-source[i])/(source[i+2]-source[i]):.5;
    return low+clamp(Number.isFinite(ratio)?ratio:.5,0,1)*(target[i+2]-low);
  });
  return {page,point,zoom};
}
