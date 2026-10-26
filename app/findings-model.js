// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {findingType,isComment} from './model.js';

export const findingRowKey=({reported,annotation,finding})=>reported?'reported:'+reported.id:'annotation:'+(annotation??finding).id;
// Numbers are the existing immutable presentation identity, not inferred dates.
// Keep ties deterministic in either direction, independent of incoming array order.
export function sortFindingRows(rows,order='newest'){
  return [...rows].sort((a,b)=>{
    const number=a.finding.number-b.finding.number;
    if(number)return order==='oldest'?number:-number;
    const left=findingRowKey(a),right=findingRowKey(b);return left<right?-1:left>right?1:0;
  });
}

// Presentation only. An associated current annotation and its reported finding
// form one row; neither the annotations nor exact-revision decisions are edited.
export function findingRows(review,returned){
  const annotations=review?.findings??[],byId=new Map(annotations.map(f=>[f.id,f])),associated=new Set();
  const rows=(returned?.reported??[]).map(reported=>{
    const annotation=byId.get(reported.associationId);if(annotation)associated.add(annotation.id);
    const type=findingType(annotation&&Object.hasOwn(annotation,'type')?annotation:reported);
    const finding={...reported,type,page:annotation?.page??reported.origin?.page, color:annotation?.color??reported.color??'#827bce'};
    const decision=reported.decision;
    const status=isComment(finding)?'Logged':!decision?'Unchecked':decision.state==='resolved'||decision.state==='looks_correct'?'Looks correct':['needs_source_clarification','needs_clarification'].includes(decision.state)?'Source unclear':'Still wrong';
    return {finding,reported,annotation,status};
  });
  return [...rows,...annotations.filter(f=>!associated.has(f.id)).map(finding=>({finding,annotation:finding,status:isComment(finding)?'Logged':finding.state.replaceAll('_',' ')}))];
}
