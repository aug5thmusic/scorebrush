// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil,installResumeAudit,assertCleanAudit,beginClose,finishClose} from './clean-resume-helpers.mjs';

// Explicit legacy journal fixtures, package hashing, PDF decoding, OPFS migration and
// the application's Load latest path. The 2500 initial objects deliberately
// include legacy packages and unreferenced evidence, as older writers left it.
export async function checkLargeHistory({newPage,check,evidence}){
  const page=await newPage();
  const migrated=await page.evaluate(async()=>{
    const h=window.historyTest,{fixtureBlob}=await import('./qa/fixtures.js'),{retainLegacyState}=await import('./qa/legacy-journal-fixture.js');
    const files={source:{name:'source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:'SYNTHETIC large history.pdf',blob:await fixtureBlob('rendered.pdf')},ly:{name:'score.ly',blob:await fixtureBlob('score.ly')}};
    const {identity,snapshotId}=await h.identify(files),review=h.newReview(identity,snapshotId,await h.inspect(files));
    let current=await retainLegacyState(await h.putSaved({id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[]},null));
    const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC large history migration',{create:true});
    const paths={source:'source.pdf',rendered:'working.pdf',ly:'score.ly'};
    for(const role of ['source','rendered','ly'])await h.put(dir,paths[role],files[role].blob);
    const finding=text=>({id:'synthetic-large-history-note',number:1,type:'correction',page:1,comment:text,color:'#ffd34d',state:'open',strokes:[],bounds:null});
    async function edit(n){current.review.findings=[finding('SYNTHETIC durable correction '+n)];current.review.nextNumber=2;current=await retainLegacyState(await h.commit(current));}
    for(let n=1;n<176;n++)await edit(n);
    const first=await h.saveRecovery(dir,h.scene(current),paths);
    // A pre-backfill generation is an explicit, hashed legacy format fixture.
    const old=structuredClone(first.snapshot.manifest);delete old.historyBackfillVersion;
    const oldBlob=h.json(old);await h.put(dir,'.scorebrush/recovery/g-'+old.id+'/snapshot.json',oldBlob);
    await h.put(dir,'.scorebrush/recovery/g-'+old.id+'/COMMIT.json',h.json({schema:old.schema,version:old.version,id:old.id,manifestSha256:(await h.fileInfo(oldBlob)).sha256}));
    const legacyIds=[];
    for(let n=0;n<199;n++){
      const legacy=structuredClone(current.review);legacy.findings=[finding('SYNTHETIC retained legacy correction '+n)];
      const payloads=await h.makeRecovery(legacy,files);
      for(const [path,blob]of payloads){const info=await h.fileInfo(blob);await h.put(dir,'.scorebrush/recovery/objects/'+info.sha256,blob);if(path==='manifest.json')legacyIds.push('legacy-package:'+info.sha256);}
    }
    const objects=await(await(await dir.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('objects');
    async function inventory(){const result=[];for await(const [name,e]of objects.entries())if(e.kind==='file')result.push({sha256:name,size:(await e.getFile()).size});return result;}
    const original=await inventory();
    for(let n=original.length;n<2500;n++){const blob=new Blob(['SYNTHETIC unreferenced retained evidence '+n]),info=await h.fileInfo(blob);await h.put(dir,'.scorebrush/recovery/objects/'+info.sha256,blob);}
    const before=await inventory();
    for(let n=176;n<728;n++)await edit(n);
    const expected=[current,...await h.workspaceHistory(current.id)];
    const migrated=await h.publish(dir,h.scene(current),{manifest:old});
    const snapshot=await h.readRecovery(dir),decoded=await h.decodeRecovery(snapshot,h.inspect),after=await inventory();
    const exact=expected.every(r=>decoded.records.some(d=>d.id===r.id&&h.recoveryIdentity(d)===h.recoveryIdentity(r)&&d.parentHistoryId===r.parentHistoryId));
    const allLegacy=legacyIds.every(id=>snapshot.manifest.legacyEvidence.some(b=>b.id===id));
    const noDiscard=before.every(b=>after.some(a=>a.sha256===b.sha256&&a.size===b.size));
    const indexBlob=await h.at(dir,'History.json'),index=JSON.parse(await indexBlob.text());
    h.large={dir,paths,current,expected,legacyIds,migrated};
    return {exact,allLegacy,noDiscard,records:snapshot.manifest.records.length,legacy:snapshot.manifest.legacyEvidence.length,indexRevisions:index.revisions.length,indexBytes:indexBlob.size,initialObjects:before.length,finalObjects:after.length,initialBytes:before.reduce((n,b)=>n+b.size,0),finalBytes:after.reduce((n,b)=>n+b.size,0),limit:h.HISTORY_LIMITS.records,objectLimit:h.LIMITS.count,byteLimit:h.LIMITS.total,metadataLimit:h.LIMITS.json};
  });
  check(migrated.records+migrated.legacy===928&&migrated.exact&&migrated.allLegacy,'928 retained states migrate with every exact revision, predecessor, correction and legacy package preserved');
  check(migrated.initialObjects===2500&&migrated.finalObjects<=migrated.objectLimit&&migrated.noDiscard,'migration retains all 2500 existing objects, including orphan evidence, within the unchanged physical object budget');
  check(migrated.indexRevisions===928&&migrated.indexBytes<migrated.metadataLimit,'928-state research index remains within the existing metadata limit');
  await page.evaluate(async()=>{
    const a=await import('./app.js'),h=window.historyTest;
    a.folderWorkspace.io.pickDirectory=async()=>h.large.dir;
    await a.folderWorkspace.choose({mode:'open'});
  });
  await waitUntil(page,async()=>{const a=await import('./app.js'),s=a.folderWorkspace.getState();if(s.error)throw Error(s.error);return s.ready&&!s.busy&&!a.sessionStatus().dirty;},180000);
  const loaded=await page.evaluate(async()=>{
    const a=await import('./app.js'),h=window.historyTest,{fixtureBlob}=await import('./qa/fixtures.js'),before=a.completion.capture();
    const rendered=await fixtureBlob('multipage.pdf'),ly=new Blob(['% SYNTHETIC latest large-history correction\n{ e4 f4 g4 }\n']);
    await h.put(h.large.dir,h.large.paths.rendered,rendered);await h.put(h.large.dir,h.large.paths.ly,ly);
    await a.folderWorkspace.loadLatest();
    const after=a.completion.capture();
    return {prior:before.review.files.rendered.sha256,rendered:after.review.files.rendered.sha256,expectedRendered:await h.blobHash(rendered),code:after.review.files.ly.sha256,expectedCode:await h.blobHash(ly),error:a.folderWorkspace.getState().loadError,notice:a.folderWorkspace.getState().loadNotice};
  });
  check(!loaded.error&&loaded.prior!==loaded.rendered&&loaded.rendered===loaded.expectedRendered&&loaded.code===loaded.expectedCode,'Load latest opens the exact newer PDF and LilyPond bytes after large-history migration');
  await waitUntil(page,async()=>{const a=await import('./app.js'),s=a.folderWorkspace.getState();if(s.error)throw Error(s.error);return s.ready&&!s.busy&&!a.sessionStatus().dirty;},180000);
  const preserved=await page.evaluate(async()=>{
    const h=window.historyTest,snapshot=await h.readRecovery(h.large.dir),decoded=await h.decodeRecovery(snapshot,h.inspect);
    return {allRecords:h.large.expected.every(r=>decoded.records.some(d=>d.id===r.id&&h.recoveryIdentity(d)===h.recoveryIdentity(r))),allLegacy:h.large.legacyIds.every(id=>snapshot.manifest.legacyEvidence.some(b=>b.id===id)),count:snapshot.manifest.records.length+snapshot.manifest.legacyEvidence.length};
  });
  check(preserved.allRecords&&preserved.allLegacy&&preserved.count>928,'loading the next revision preserves the complete prior large history and adds the new revision');
  const identity=async()=>{const a=await import('./app.js'),scene=a.completion.capture(),{workspaceHistory}=await import('./storage.js');return {workspaceId:scene.workspaceId,revisionId:scene.revisionId,recoveryId:a.folderWorkspace.getState().recoveryId,history:(await workspaceHistory(scene.workspaceId)).map(r=>r.id)};};
  const beforeReload=await page.evaluate(identity);await installResumeAudit(page);await page.reload();await page.waitForFunction(()=>document.body.dataset.ready==='true');
  await waitUntil(page,async()=>{const a=await import('./app.js'),s=a.folderWorkspace.getState();if(s.error)throw Error(s.error);return s.ready&&!s.busy&&!a.sessionStatus().dirty;},180000);
  await beginClose(page);const close=await finishClose(page),audit=await assertCleanAudit(page),afterReload=await page.evaluate(identity);
  assert.deepEqual(afterReload,beforeReload);
  check(close.local&&close.folder&&close.idle&&!close.error,'large saved project reopens and passes guarded close with identical identities and zero project or journal writes');
  await writeFile(resolve(evidence,'large-history-migration.json'),JSON.stringify({migrated,loaded,preserved,close,audit:audit.counts},null,2)+'\n');
  assert(migrated.finalBytes<migrated.byteLimit);
}

