// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {isComment} from './model.js';

// Queue position can invite more reviewing, never declare a round complete.
export function automaticRoundOutcome(round,{atEnd=false}={}){
  if(round.state==='unchecked')return atEnd?'unchecked':null;
  // A retry can verify an already committed decision whose read-back failed.
  // The presenter suppresses outcomes already acknowledged for this exact round.
  return round.state;
}

// A summary is a projection of decisions for these exact files, never a new
// completion declaration. Associated annotations occupy their report's slot.
export function reviewRound(review,round){
  const annotations=new Map(review.findings.map(f=>[f.id,f])),associated=new Set(round?.reported.map(f=>f.associationId).filter(Boolean));
  const exact=Boolean(round&&round.contentSnapshotId===review.snapshotId&&round.codeSha256===review.files.ly.sha256&&round.renderSha256===review.files.rendered.sha256);
  const unchecked=[],outstanding=[];let approved=0,comments=0;
  for(const f of round?.reported??[]){
    const mark=annotations.get(f.associationId);if(isComment(mark&&Object.hasOwn(mark,'type')?mark:f)){comments++;continue;}
    const d=f.decision,r=d?.reviewed,valid=exact&&r?.snapshotId===review.snapshotId&&r?.codeSha256===review.files.ly.sha256&&r?.renderSha256===review.files.rendered.sha256&&d.state===f.state;
    if(!valid)unchecked.push(f.id);else if(d.state==='resolved')approved++;else outstanding.push(f.id);
  }
  for(const f of review.findings)if(!associated.has(f.id)){if(isComment(f))comments++;else if(f.state==='resolved')approved++;else outstanding.push(f.id);}
  return {state:unchecked.length?'unchecked':outstanding.length?'outstanding':'resolved',unchecked,outstanding,approved,comments};
}

// A synchronous presentation snapshot, not export or persistence evidence.
// Folder progress can refresh a closed summary hundreds of times. It needs
// exact identity and current decision counts, never annotation geometry or the
// retained comparison/file graph. All returned objects/arrays are newly owned.
export function reviewSummary(review,round,{workspaceId,revisionId}){
  return {workspaceId,revisionId,
    review:review?{snapshotId:review.snapshotId,files:{ly:{sha256:review.files.ly.sha256},rendered:{sha256:review.files.rendered.sha256}}}:null,
    returned:round?{id:round.id}:null,
    round:review?reviewRound(review,round):null};
}
