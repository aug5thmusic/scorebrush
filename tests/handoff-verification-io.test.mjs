// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fast-resume-fixture.mjs';
import {get,put} from './history-memory.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function latest(f){return(await f.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('latest');}
async function entry(root,path){for(const part of path.split('/').slice(0,-1))root=await root.getDirectoryHandle(part);return root.getFileHandle(path.split('/').at(-1));}
const firstPaths=['source-original.pdf','rendered-original.pdf','lilypond/supplied.ly','annotations.json'];

test('handoff verification resolves latest once and bounds concurrent fresh payload reads',async()=>{
  const f=await fixture(),owned=await f.directory.getDirectoryHandle('.scorebrush'),directory=await latest(f);let active=0,maximum=0,reads=0,latestLookups=0;
  const getDirectory=owned.getDirectoryHandle.bind(owned);owned.getDirectoryHandle=async(name,...args)=>{if(name==='latest')latestLookups++;return getDirectory(name,...args);};
  for(const path of f.config.head.payloads.keys()){const file=await entry(directory,path),read=file.getFile;file.getFile=async()=>{reads++;maximum=Math.max(maximum,++active);try{await delay(3);return await read();}finally{active--;}};}
  assert(await f.verify());assert.equal(active,0);assert(maximum>1&&maximum<=4);assert(reads>=f.config.head.payloads.size);
  assert(latestLookups<=2,'only initial latest resolution and final fresh path recheck are needed');assert.deepEqual(f.directory.control.writes,[]);
});

for(const failure of ['rejected-read','changed-bytes'])test('handoff '+failure+' drains already started peers before returning',async()=>{
  const f=await fixture(),directory=await latest(f);let active=0,started=0,settled=false,releasePeers,notifyFailure;
  const peers=new Promise(resolve=>releasePeers=resolve),failed=new Promise(resolve=>notifyFailure=resolve),denied=new DOMException('SYNTHETIC denied current payload','NotAllowedError');
  for(const [index,path]of firstPaths.entries()){
    const file=await entry(directory,path),read=file.getFile;
    file.getFile=async()=>{started++;active++;try{if(index===0){notifyFailure();if(failure==='rejected-read')throw denied;const blob=await read();return new Blob([new Uint8Array(blob.size).fill(88)]);}await peers;return await read();}finally{active--;}};
  }
  const pending=f.verify();pending.then(()=>settled=true,()=>settled=true);
  await failed;await delay(10);assert.equal(started,4);assert.equal(active,3);assert.equal(settled,false);
  releasePeers();if(failure==='rejected-read')await assert.rejects(pending,error=>error===denied);else assert.equal(await pending,null);
  assert.equal(active,0);assert.equal(started,4);const stopped=started;await delay(10);assert.equal(started,stopped);assert.deepEqual(f.directory.control.writes,[]);
});

test('parallel payload verification still rejects a changed READY or recovery generation',async()=>{
  for(const changed of ['READY','generation']){
    const f=await fixture(),directory=await latest(f),file=await entry(directory,firstPaths[0]),read=file.getFile;let fired=false;
    file.getFile=async()=>{if(!fired){fired=true;if(changed==='READY'){const path='.scorebrush/latest/READY.json',ready=JSON.parse(await(await get(f.directory,path)).text());ready.generationId=crypto.randomUUID();await put(f.directory,path,new Blob([JSON.stringify(ready)]));}else await f.commit({...f.snapshot.manifest,id:crypto.randomUUID(),parent:f.snapshot.manifest.id,sequence:f.snapshot.manifest.sequence+1});}return read();};
    assert.equal(await f.verify(),null,changed);assert(fired);assert.deepEqual(f.directory.control.writes,[]);
  }
});
