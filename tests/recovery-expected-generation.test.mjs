// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installMemoryIndexedDB} from './indexeddb-memory.mjs';
import {HistoryDirectory,put,get} from './history-memory.mjs';
import {head,scene,evidence} from './portable-history-fixture.mjs';
import {saveRecovery,readRecovery,recoveryMatches,RecoveryConflict} from '../app/folder-recovery.js';
import {json,fileInfo} from '../app/workflow.js';
installMemoryIndexedDB();
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,fn)=>fn()}}});
const paths={source:'source.pdf',rendered:'Etude.pdf',ly:'score.ly'};
for(const damage of ['legacy-asset','manifest','missing-marker'])test('unchanged current scene cannot adopt fallback after expected '+damage+' damage',async()=>{
  const record=await head('SYNTHETIC expected generation '+damage),directory=new HistoryDirectory(),capture=scene(record),first=await saveRecovery(directory,capture,paths),legacy=await evidence(record,'SYNTHETIC additional history absent from the parent');
  const manifest={...structuredClone(first.snapshot.manifest),id:crypto.randomUUID(),parent:first.id,sequence:first.snapshot.manifest.sequence+1,legacyEvidence:[legacy.bundle]};
  for(const [path,blob]of legacy.payloads)await put(directory,'.scorebrush/recovery/objects/'+legacy.bundle.payloads[path].sha256,blob);
  const bytes=json(manifest);await put(directory,'.scorebrush/recovery/g-'+manifest.id+'/snapshot.json',bytes);await put(directory,'.scorebrush/recovery/g-'+manifest.id+'/COMMIT.json',json({schema:manifest.schema,version:1,id:manifest.id,manifestSha256:(await fileInfo(bytes)).sha256}));
  if(damage==='legacy-asset')await put(directory,'.scorebrush/recovery/objects/'+legacy.bundle.payloads['annotations.json'].sha256,new Blob(['SYNTHETIC corrupted additional evidence']));
  if(damage==='manifest')await put(directory,'.scorebrush/recovery/g-'+manifest.id+'/snapshot.json',new Blob(['SYNTHETIC corrupted generation']));
  if(damage==='missing-marker'){const generation=await(await(await directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('recovery')).getDirectoryHandle('g-'+manifest.id);await generation.removeEntry('COMMIT.json');}
  const fallback=await readRecovery(directory);assert.equal(fallback.manifest.id,first.id);assert(await recoveryMatches(fallback,capture),'the unchanged scene alone would incorrectly authorize adoption');
  const before=await(await get(directory,'.scorebrush/recovery/g-'+first.id+'/COMMIT.json')).text();directory.control.writes.length=0;
  await assert.rejects(saveRecovery(directory,capture,paths,{expected:manifest.id}),RecoveryConflict);
  assert.deepEqual(directory.control.writes,[],'reject before object or derived publication writes');assert.equal(await(await get(directory,'.scorebrush/recovery/g-'+first.id+'/COMMIT.json')).text(),before);
});
