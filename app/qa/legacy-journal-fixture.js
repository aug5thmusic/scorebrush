// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Synthetic fixtures for history captured by pre-boundary builds. Production
// ordinary edits no longer create these events; preservation tests still need
// an explicit old journal rather than weakening their retained-history counts.
export async function retainLegacyState(record){
  const id=(record.returned?'returned-event:':'review-event:')+crypto.randomUUID(),event={...record,id,kind:record.returned?'returned-event':'review-event',workspaceId:record.id,historyId:id,parentHistoryId:record.historyId??record.historyPredecessorId??null,createdAt:new Date().toISOString(),historyCoverage:'durable-save'};
  delete event.historyPredecessorId;delete event.retainedLegacyEvidence;delete event.retainedHandoffEvidence;delete event.pdfOutput;delete event.retainedEvidenceId;
  const next={...record,historyId:id};delete next.historyPredecessorId;
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('private-score-desk-local-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  await new Promise((resolve,reject)=>{const tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews'),read=store.get(record.id);read.onsuccess=()=>{if(read.result?.revisionId!==record.revisionId||read.result?.storageRevision!==record.storageRevision){tx.abort();return;}store.add(event);store.put(next);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('SYNTHETIC legacy fixture raced'));});
  return next;
}
