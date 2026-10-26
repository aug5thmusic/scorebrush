// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Executed only inside a disposable browser context. Tiny shared PDF inputs
// reproduce the pre-boundary history shape without copying any user scores.
export async function seedCurrentHandoffHistory({history=950,legacy=199,handoffs=15}={}){
  const a=await import('./app.js'),storage=await import('./storage.js'),workflow=await import('./workflow.js'),exports=await import('./export.js'),handoff=await import('./handoff-store.js');
  const config=await a.folderWorkspace.io.getSettings(),record=await storage.getSaved(a.completion.capture().workspaceId);
  if(!config.directory.name.startsWith('SYNTHETIC ')||!record?.returned)throw Error('A disposable synthetic returned review is required');
  const legacyEvidence=[];
  for(let i=0;i<legacy;i++){
    const review=structuredClone(record.review);review.findings=[{id:'SYNTHETIC-legacy-'+i,number:1,type:'correction',page:1,comment:'SYNTHETIC historical correction '+i,state:'open',color:'#ffd34d',strokes:[],bounds:null}];review.nextNumber=2;
    const payloads=await exports.makeRecovery(review,record.files),declarations={};for(const[path,blob]of payloads)declarations[path]=await workflow.fileInfo(blob);
    legacyEvidence.push({bundle:{id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,missingData:['logical-revision-id-not-recorded']},payloads});
  }
  const issued=await handoff.retained(record.returned.taskId),handoffEvidence=[];
  for(let i=0;i<handoffs;i++){
    const entry=structuredClone(issued);entry.id=crypto.randomUUID();entry.task.id=entry.id;await workflow.finalizeTask(entry);
    const declarations={};for(const[path,blob]of entry.payloads)declarations[path]=await workflow.fileInfo(blob);
    handoffEvidence.push({bundle:{id:entry.id,kind:'task',payloads:declarations},payloads:entry.payloads});
  }
  record.retainedLegacyEvidence=legacyEvidence;record.retainedHandoffEvidence=handoffEvidence;
  const rows=[],source={...record};for(const field of ['retainedLegacyEvidence','retainedHandoffEvidence','retainedEvidenceId','pdfOutput'])delete source[field];
  let previous=record.historyId??null;
  for(let i=0;i<history;i++){
    const event=structuredClone(source),id='returned-event:'+crypto.randomUUID();
    Object.assign(event,{id,kind:'returned-event',workspaceId:record.id,historyId:id,parentHistoryId:previous,storageRevision:record.storageRevision+i+1,createdAt:new Date(1600000000000+i*1000).toISOString(),historyCoverage:'durable-save'});
    if(i<history-1){event.returned.reported[0].explanation='SYNTHETIC journal capture '+i;event.revisionId=crypto.randomUUID();}
    previous=id;rows.push(event);
  }
  record.storageRevision+=history;if(history){record.historyId=previous;delete record.historyPredecessorId;}
  await new Promise((resolve,reject)=>{
    const request=indexedDB.open('private-score-desk-local-v1');request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews');for(const row of rows)store.put(row);store.put(record);
      tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};
    };
  });
  const scene={...record,workspaceId:record.id,persistedRevision:record.storageRevision,doc:{}};
  const archived=await(await import('./folder-recovery.js')).saveRecovery(config.directory,scene,config.paths,{expected:config.recoveryId,projectId:config.projectId,head:config.head});
  const versions=await(await import('./pdf-versions.js')).syncPdfVersions(config.directory,archived.snapshot);
  await(await import('./project-history.js')).syncProjectHistory(config.directory,archived.snapshot,{pdfVersions:versions.versions});
  await(await import('./finished-pdf.js')).syncFinishedPDF(config.directory,archived.snapshot,{pdfVersions:versions.versions});
  await a.folderWorkspace.io.putSettings({...config,recoveryId:archived.id,projectId:archived.projectId,resumeProof:null,currentCheckpointId:null});
  const manifest=archived.snapshot.manifest,current=manifest.records.find(item=>item.id===manifest.current),head=manifest.handoffs.find(item=>item.id===manifest.headTaskId);
  const currentHashes=new Set([current,head].filter(Boolean).flatMap(item=>Object.values(item.payloads).map(info=>info.sha256)));
  const historicalInputs=new Map(Object.entries(issued.review.files).map(([role,info])=>[info.sha256,{role,sha256:info.sha256,size:info.size}]));
  for(const finding of issued.task.findings)for(const[role,info]of Object.entries(finding.historicalContext?.originalFiles??{}))historicalInputs.set(info.sha256,{role,sha256:info.sha256,size:info.size});
  for(const hash of historicalInputs.keys())currentHashes.add(hash);
  const previousRendering={sha256:issued.review.files.rendered.sha256,size:issued.review.files.rendered.size};
  const historicalHashes=[...archived.snapshot.objects.keys()].filter(hash=>!currentHashes.has(hash));
  localStorage.setItem('SYNTHETIC-handoff-allowed-objects',JSON.stringify([...currentHashes]));
  localStorage.setItem('SYNTHETIC-handoff-old-objects',JSON.stringify(historicalHashes));
  localStorage.setItem('SYNTHETIC-handoff-recovery-id',archived.id);
  return {recoveryId:archived.id,records:manifest.records.length,legacy:manifest.legacyEvidence.length,handoffs:manifest.handoffs.length,objects:archived.snapshot.objects.size,historicalObjects:historicalHashes.length,bytes:[...archived.snapshot.objects.values()].reduce((n,blob)=>n+blob.size,0),historyRows:rows.length,historicalInputs:[...historicalInputs.values()],previousRendering};
}



