// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';

export async function checkLegacyHistoryImport({newPage,check}){
  const page=await newPage();
  const exported=await page.evaluate(async()=>{
    const h=window.historyTest,{fixtureBlob}=await import('./qa/fixtures.js');
    const files={source:{name:'source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:'Legacy Etude.pdf',blob:await fixtureBlob('rendered.pdf')},ly:{name:'current.ly',blob:await fixtureBlob('score.ly')}};
    const {identity,snapshotId}=await h.identify(files),review=h.newReview(identity,snapshotId,await h.inspect(files));
    const record=await h.putSaved({id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[]},null),baseState=h.recoveryIdentity(record),baseJournal=JSON.stringify(await h.workspaceHistory(record.id));
    const root=await navigator.storage.getDirectory(),dir=await root.getDirectoryHandle('SYNTHETIC legacy origin',{create:true});
    const {snapshot}=await h.saveRecovery(dir,h.scene(record),{source:'source.pdf',rendered:'Legacy Etude.pdf',ly:'current.ly'});
    async function legacy(label){
      const selected={...files,ly:{name:label+'.ly',blob:new Blob(['% EXACT SYNTHETIC old '+label+'\n{ c4 des4 }\n'])}},identified=await h.identify(selected),annotations=h.newReview(identified.identity,identified.snapshotId,await h.inspect(selected));
      annotations.createdAt=annotations.updatedAt='2026-10-01T00:00:00Z';annotations.findings=[{id:label,number:1,type:label==='older-A'?'comment':'source_footnote',page:1,comment:'Exact retained '+label+'\nMultiline original text.',color:'#ffd34d',state:'open',strokes:[],bounds:null}];annotations.nextNumber=2;
      const payloads=await h.makeRecovery(annotations,selected),declarations={};for(const [path,blob]of payloads)declarations[path]=await h.fileInfo(blob);
      return {bundle:{id:'legacy-package:'+declarations['manifest.json'].sha256,payloads:declarations,legacyRecordId:label,createdAt:'2026-10-02T00:00:00Z',missingData:['logical-revision-id-not-recorded','original-save-time-not-recorded']},payloads};
    }
    const a=await legacy('older-A'),b=await legacy('older-B');
    async function archive(evidence){
      const base=structuredClone(snapshot);base.manifest.legacyEvidence=[evidence.bundle];for(const [path,blob]of evidence.payloads)base.objects.set(evidence.bundle.payloads[path].sha256,blob);
      const packed=await h.addPortableHistory(await h.prepareBackup(h.scene(record),()=>{},h.makeRecovery),h.scene(record),{baseSnapshot:base});return h.zipFiles(packed.payloads);
    }
    const archiveA=await archive(a),archiveB=await archive(b),conflicting=structuredClone(b);conflicting.bundle.missingData.push('CONFLICTING metadata');const badArchive=await archive(conflicting);
    const restore=async zip=>h.importPortableHistory(await h.readPackage(zip,h.inspect),h.inspect);
    await restore(archiveA);await restore(archiveB);
    let saved=await h.getSaved(record.id);
    const bundleList=r=>r.retainedLegacyEvidence.map(e=>e.bundle).sort((a,b)=>a.id.localeCompare(b.id));
    const exact=async()=>{
      const r=await h.getSaved(record.id);if(h.recoveryIdentity(r)!==baseState||r.storageRevision!==record.storageRevision||JSON.stringify(await h.workspaceHistory(record.id))!==baseJournal)throw Error('Import changed current state or journal');
      if(JSON.stringify(bundleList(r))!==JSON.stringify([a.bundle,b.bundle].sort((a,b)=>a.id.localeCompare(b.id))))throw Error('Legacy metadata lost or duplicated');
      for(const e of r.retainedLegacyEvidence){const original=[a,b].find(v=>v.bundle.id===e.bundle.id);for(const[path,blob]of original.payloads)if(await h.blobHash(blob)!==await h.blobHash(e.payloads.get(path)))throw Error('Legacy payload bytes changed');}
    };
    await exact();
    let writes=0;const put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.put=function(...args){writes++;return put.apply(this,args);};IDBObjectStore.prototype.add=function(...args){writes++;return add.apply(this,args);};
    const failures=[];
    try{
      await restore(archiveB);await exact();if(writes)throw Error('Repeated evidence import wrote storage');
      try{await restore(badArchive);throw Error('Conflicting metadata accepted');}catch(e){if(!/Conflicting retained legacy history/.test(e.message))throw e;failures.push(e.message);}
      const {restoreMissing}=await import('./storage.js');
      const corrupt=structuredClone(saved),oldCode=corrupt.retainedLegacyEvidence[1].payloads.get('lilypond/supplied.ly');corrupt.retainedLegacyEvidence[1].payloads.set('lilypond/supplied.ly',new Blob([new Uint8Array(oldCode.size).fill(88)]));
      // A separate record queued first must not survive a later conflict.
      try{await restoreMissing([{...record,id:'SYNTHETIC should not be inserted'},corrupt]);throw Error('Corrupt bytes accepted');}catch(e){if(!/Conflicting retained legacy history/.test(e.message))throw e;failures.push(e.message);}
      if(await h.getSaved('SYNTHETIC should not be inserted'))throw Error('Partial storage mutation');
      await exact();if(writes)throw Error('Rejected import partially wrote storage');
    }finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
    // Remove the only source folder. Re-export must use retained browser evidence.
    await root.removeEntry('SYNTHETIC legacy origin',{recursive:true});saved=await h.getSaved(record.id);
    const next=await h.addPortableHistory(await h.prepareBackup(h.scene(saved),()=>{},h.makeRecovery),h.scene(saved)),zip=await h.zipFiles(next.payloads),parsed=await h.readPackage(zip,h.inspect);
    const index=JSON.parse(await parsed.payloads.get('History.json').text());if(index.revisions.filter(r=>r.kind==='legacy-package').length!==2)throw Error('Re-export lost history');
    for(const object of index.objects)if((await h.fileInfo(parsed.payloads.get(object.path))).sha256!==object.sha256)throw Error('Broken ZIP reference');
    await restore(zip);await exact();
    const journal=(await h.workspaceHistory(record.id)).map(r=>({id:r.id,revisionId:r.revisionId,storageRevision:r.storageRevision,parentHistoryId:r.parentHistoryId,identity:h.recoveryIdentity(r)}));
    return {zip:[...new Uint8Array(await zip.arrayBuffer())],id:record.id,identity:baseState,storageRevision:record.storageRevision,journal,bundles:bundleList(saved),legacy:index.revisions.filter(r=>r.kind==='legacy-package'),failures,writes};
  });
  check(exported.bundles.length===2,'matching-head real IndexedDB imports preserve both existing and incoming legacy bytes/metadata without changing current revision, decisions, counter or journal');
  check(exported.writes===0&&exported.failures.length===2,'repeated imports are write-free and conflicting metadata/payloads reject before any partial storage additions');
  check(exported.legacy.length===2,'real ZIP re-export retains both legacy packages after the original synthetic folder is removed');
  const fresh=await newPage();
  const restored=await fresh.evaluate(async data=>{
    const h=window.historyTest,parsed=await h.readPackage(new Blob([new Uint8Array(data.zip)]),h.inspect),id=await h.importPortableHistory(parsed,h.inspect),record=await h.getSaved(id);
    const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC fresh legacy folder',{create:true}),snapshot=await h.publish(dir,h.scene(record));
    const index=JSON.parse(await(await h.at(dir,'History.json')).text());
    for(const o of index.objects){const blob=await h.at(dir,o.path);if(blob.size!==o.size||await h.blobHash(blob)!==o.sha256)throw Error('Broken restored research object');}
    for(const e of record.retainedLegacyEvidence)for(const[path,blob]of e.payloads)if(await h.blobHash(snapshot.objects.get(e.bundle.payloads[path].sha256))!==await h.blobHash(blob))throw Error('Fresh folder changed original legacy bytes');
    const journal=(await h.workspaceHistory(id)).map(r=>({id:r.id,revisionId:r.revisionId,storageRevision:r.storageRevision,parentHistoryId:r.parentHistoryId,identity:h.recoveryIdentity(r)}));
    return {id,identity:h.recoveryIdentity(record),storageRevision:record.storageRevision,journal,bundles:snapshot.manifest.legacyEvidence.sort((a,b)=>a.id.localeCompare(b.id)),legacy:index.revisions.filter(r=>r.kind==='legacy-package'),objectCount:index.objects.length};
  },exported);
  assert.equal(restored.id,exported.id);assert.equal(restored.identity,exported.identity);assert.equal(restored.storageRevision,exported.storageRevision);assert.deepEqual(restored.journal,exported.journal);assert.deepEqual(restored.bundles,exported.bundles);
  assert.deepEqual(restored.legacy.map(r=>({...r,pdfVersions:[]})),exported.legacy);
  for(const r of restored.legacy){assert.equal(r.pdfVersions.length,1);assert.equal(r.pdfVersions[0].number,1);assert.equal('sha256:'+r.pdfVersions[0].sha256,r.assetIds.rendered);assert.equal(r.pdfVersions[0].path,'Versions/0001 - Legacy Etude.pdf');}
  check(restored.objectCount>0,'fresh-profile ZIP import and fresh-folder publication preserve exact legacy relationships and every relocated object hash');
}
