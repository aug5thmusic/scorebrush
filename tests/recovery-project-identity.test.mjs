// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fast-resume-fixture.mjs';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {putSaved,getSaved,workspaceHistory} from '../app/storage.js';
import {readRecovery,saveRecovery} from '../app/folder-recovery.js';
import {captureResumeProof,verifyFastResume} from '../app/fast-resume.js';
import {verifySavedFolder} from '../app/folder-workspace.js';
import {syncPdfVersions,checkPdfVersions} from '../app/pdf-versions.js';
import {syncProjectHistory} from '../app/project-history.js';

installMemoryIndexedDB();

test('legacy folder identity A preserves independently assigned local journal identity B through save and clean reopen',async()=>{
  const f=await fixture(),folderId=f.snapshot.manifest.projectId,legacy={...f.record};delete legacy.projectId;
  assert.equal(f.snapshot.manifest.records.find(r=>r.id===f.snapshot.manifest.current).projectId,undefined,'old folder current record predates local lineage IDs');
  const local=await putSaved(legacy,null);assert(local.projectId);assert.notEqual(local.projectId,folderId);assert.equal(local.storageRevision,f.scene.persistedRevision);
  const saved=await saveRecovery(f.directory,f.scene,f.config.paths,{expected:f.config.recoveryId,projectId:folderId,head:f.config.head});
  assert.equal(saved.projectId,folderId);assert.equal(saved.snapshot.manifest.records.find(r=>r.id===saved.snapshot.manifest.current).projectId,local.projectId);
  const versions=await syncPdfVersions(f.directory,saved.snapshot);await syncProjectHistory(f.directory,saved.snapshot,{pdfVersions:versions.versions});
  const selected={...f.config,recoveryId:saved.id},historyBefore=await workspaceHistory(local.id);f.directory.control.writes.length=0;
  const snapshot=await readRecovery(f.directory),publication={};
  assert(await verifySavedFolder(selected,f.scene,local,snapshot,{}, {onVerified:v=>Object.assign(publication,v)}));
  const proof=await captureResumeProof(selected,f.scene,local,snapshot,{pdfVersions:publication.pdfVersions});assert(proof);
  assert(await verifyFastResume(selected,f.scene,await getSaved(local.id),proof,{},verifySavedFolder),'exact committed local B must cleanly reopen under established folder A');
  assert.equal((await getSaved(local.id)).projectId,local.projectId);assert.deepEqual(await workspaceHistory(local.id),historyBefore);assert.deepEqual(f.directory.control.writes,[],'verification must not autosave or rewrite either identity');
  const wrong={...local,projectId:crypto.randomUUID()};assert.notEqual(wrong.projectId,folderId);assert.notEqual(wrong.projectId,local.projectId);
  assert.equal(await verifySavedFolder(selected,f.scene,wrong,snapshot),null);
  assert.equal(await captureResumeProof(selected,f.scene,wrong,snapshot,{pdfVersions:publication.pdfVersions}),null,'invalid local C must never mint a clean proof');
  assert.equal(await verifyFastResume(selected,f.scene,wrong,proof,{},verifySavedFolder),null);
  assert.equal(await verifySavedFolder({...selected,projectId:local.projectId},f.scene,local,snapshot),null,'local B cannot replace the independently bound folder identity A');
  for(const forged of [{...local,projectId:folderId},{...local,id:crypto.randomUUID()}]){
    assert.equal(await verifySavedFolder(selected,f.scene,forged,snapshot),null,'a different local identity cannot borrow an exact current bundle');
    assert.equal(await captureResumeProof(selected,f.scene,forged,snapshot,{pdfVersions:publication.pdfVersions}),null);
    assert.equal(await verifyFastResume(selected,f.scene,forged,proof,{},verifySavedFolder),null);
  }
  assert.deepEqual(f.directory.control.writes,[]);
});

test('a legacy record without a committed lineage ID only permits the bound folder ID or an absent local ID',async()=>{
  const f=await fixture(),versions=await checkPdfVersions(f.directory,f.snapshot),unproven={...f.record,projectId:crypto.randomUUID()};
  assert.equal(await verifySavedFolder(f.config,f.scene,unproven,f.snapshot),null);
  assert.equal(await captureResumeProof(f.config,f.scene,unproven,f.snapshot,{pdfVersions:versions}),null);
  assert(await verifySavedFolder(f.config,f.scene,f.record,f.snapshot));
  const absent={...f.record};delete absent.projectId;assert(await verifySavedFolder(f.config,f.scene,absent,f.snapshot));
  assert.deepEqual(f.directory.control.writes,[]);
});

