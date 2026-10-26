// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {openNativeFolder,openNativeVersions,openNativeLatest,selectNativeFolder,verifyNativeFolder} from '../app/native-folder.js';
globalThis.crypto??=webcrypto;

function folder(){
  const files=new Map([['OWNER.json',new Blob([JSON.stringify({schema:'private-score-desk-folder',version:1})])]]),removed=[];
  const privateFolder={
    async getFileHandle(name,{create=false}={}){if(!files.has(name)&&!create)throw Object.assign(new Error('Missing'),{name:'NotFoundError'});if(create)files.set(name,new Blob());return {getFile:async()=>files.get(name),createWritable:async()=>({write:async value=>files.set(name,new Blob([value])),close:async()=>{},abort:async()=>{}})};},
    async removeEntry(name){removed.push(name);files.delete(name);}
  };
  return {files,removed,privateFolder,directory:{name:'Synthetic score & notes',queryPermission:async()=> 'granted',getDirectoryHandle:async name=>{if(name!=='.scorebrush')throw Object.assign(new Error('Missing'),{name:'NotFoundError'});return privateFolder;}}};
}

const challenge=()=>({token:'a'.repeat(32),marker:'native-open-'+ 'b'.repeat(32)+'.txt',proof:'c'.repeat(64)});
test('Explorer sends only the host proof and removes it after success',async()=>{
  const fixture=folder(),calls=[];
  const result=await openNativeFolder({directory:fixture.directory,absolutePath:'C:\\Synthetic score & notes'},{request:async(op,body)=>{
    calls.push(op);if(op==='folder-challenge')return challenge();
    assert.equal(body.path,'C:\\Synthetic score & notes');assert.equal(body.token,challenge().token);
    assert.equal(await fixture.files.get(body.marker).text(),'private-score-desk-open-v1\n'+body.proof);
    assert.deepEqual(Object.keys(body).sort(),['dataDirectory','marker','name','path','proof','token']);
    return {opened:true,path:body.path};
  }});
  assert.equal(result.opened,true);assert.deepEqual(calls,['folder-challenge','folder-open']);assert.equal(fixture.removed.length,1);assert.deepEqual([...fixture.files.keys()],['OWNER.json']);
});
test('cancellation and failed verification clean only the owned proof',async()=>{
  for(const fails of [false,true]){
    const fixture=folder();const request=async op=>{if(op==='folder-challenge')return challenge();if(fails)throw Error('Choose the connected folder');return {cancelled:true};};
    if(fails)await assert.rejects(openNativeFolder({directory:fixture.directory},{request}),/connected folder/);
    else assert.deepEqual(await openNativeFolder({directory:fixture.directory},{request}),{cancelled:true});
    assert.equal(fixture.removed.length,1);assert.deepEqual([...fixture.files.keys()],['OWNER.json']);
  }
});
test('denied permission and absent native bridge cannot create a proof',async()=>{
  const fixture=folder();await assert.rejects(openNativeFolder({directory:fixture.directory}),/desktop application/);
  fixture.directory.queryPermission=async()=> 'denied';await assert.rejects(openNativeFolder({directory:fixture.directory}),/Connect working folder/);
  assert.deepEqual([...fixture.files.keys()],['OWNER.json']);assert.equal(fixture.removed.length,0);
});
test('untrusted challenge paths and collisions cannot overwrite or remove existing files',async()=>{
  for(const bad of [{...challenge(),marker:'../OWNER.json'},{...challenge(),proof:'short'},{...challenge(),token:'bad'}]){
    const f=folder();await assert.rejects(openNativeFolder({directory:f.directory},{request:async()=>bad}),/verify/);assert.equal(f.removed.length,0);
  }
  const f=folder(),c=challenge();f.files.set(c.marker,new Blob(['keep']));await assert.rejects(openNativeFolder({directory:f.directory},{request:async()=>c}),/could not start/);assert.equal(await f.files.get(c.marker).text(),'keep');assert.equal(f.removed.length,0);
});
test('expired cleanup permission leaves only the inert owned proof',async()=>{
  const fixture=folder();let marker;fixture.privateFolder.removeEntry=async name=>{marker=name;throw Error('Permission expired');};
  const result=await openNativeFolder({directory:fixture.directory},{request:async op=>op==='folder-challenge'?challenge():{opened:true,path:'C:\\Synthetic'}});
  assert.equal(result.opened,true);assert.equal(marker,challenge().marker);assert.deepEqual([...fixture.files.keys()],['OWNER.json',marker]);
});

function selection(){const f=folder();const directory={...f.privateFolder,kind:'directory',name:'Synthetic',queryPermission:async()=> 'granted'};const selected={...challenge(),path:'C:\\Synthetic',directory};return {...f,directory,selected};}
test('native selection confirms a read/write handle and path with a one-use root proof',async()=>{
  const f=selection(),calls=[];
  const result=await selectNativeFolder({}, {request:async(op,body)=>{calls.push(op);if(op==='folder-select'){assert.deepEqual(body,{});return f.selected;}if(op==='folder-confirm'){assert.equal(await f.files.get(body.marker).text(),'private-score-desk-open-v1\n'+body.proof);assert.deepEqual(Object.keys(body).sort(),['marker','proof','token']);return {binding:'d'.repeat(32),path:f.selected.path};}return {released:true};}});
  assert.equal(result.directory,f.directory);assert.equal(result.absolutePath,f.selected.path);assert.equal(result.nativeBinding,'d'.repeat(32));assert.deepEqual(calls,['folder-select','folder-confirm','folder-release']);assert(!f.files.has(challenge().marker));
});
test('restart requests only an opaque native binding and matches the stored directory',async()=>{
  const f=selection(),binding='e'.repeat(32);let compared=false;
  const result=await selectNativeFolder({binding,expected:{isSameEntry:async h=>{compared=h===f.directory;return compared;}}},{request:async(op,body)=>{if(op==='folder-resume'){assert.deepEqual(body,{binding});return f.selected;}if(op==='folder-confirm')return {binding,path:f.selected.path};return {};}});
  assert(compared);assert.equal(result.nativeBinding,binding);
});
test('cancel, denied access and wrong legacy folder never confirm or overwrite a binding',async()=>{
  for(const mode of ['cancel','denied','wrong']){
    const f=selection(),calls=[];if(mode==='denied')f.directory.queryPermission=async()=> 'denied';
    await assert.rejects(selectNativeFolder({expected:{isSameEntry:async()=>mode!=='wrong'}},{request:async op=>{calls.push(op);if(op==='folder-select')return mode==='cancel'?{cancelled:true}:f.selected;return {};}}),mode==='cancel'?{name:'AbortError'}:mode==='denied'?/did not grant/:/same connected/);
    assert(!calls.includes('folder-confirm'));assert(!f.files.has(challenge().marker));
  }
});
test('failed write access and a missing host binding preserve connection metadata',async()=>{
  const f=selection();f.directory.getFileHandle=async(name,options)=>{if(options?.create)throw new DOMException('Read-only folder','NotAllowedError');throw new DOMException('Missing','NotFoundError');};let confirmed=false;
  await assert.rejects(selectNativeFolder({}, {request:async op=>{if(op==='folder-select')return f.selected;if(op==='folder-confirm')confirmed=true;return {};}}),{name:'NotAllowedError'});assert(!confirmed);
  await assert.rejects(selectNativeFolder({binding:'e'.repeat(32)},{request:async()=>{throw Error('Folder moved or unavailable');}}),/unavailable/);
});
test('explicit reconnection validates selected project data before confirming its one-use proof',async()=>{
  for(const valid of [false,true]){
    const f=selection(),calls=[];let validated=false;
    const action=selectNativeFolder({validateSelection:async directory=>{assert.equal(directory,f.directory);validated=true;if(!valid)throw Error('Wrong saved project');}},{request:async(op)=>{calls.push(op);if(op==='folder-select')return f.selected;if(op==='folder-confirm'){assert(validated);return {binding:'d'.repeat(32),path:f.selected.path};}return {};}});
    if(valid)assert.equal((await action).directory,f.directory);else await assert.rejects(action,/Wrong saved project/);
    assert.equal(calls.includes('folder-confirm'),valid);assert(!f.files.has(challenge().marker));assert.equal(calls.at(-1),'folder-release');
  }
});
test('automatic resume cannot use project validation to bypass a mismatched handle',async()=>{
  const f=selection();let validated=false,confirmed=false;
  await assert.rejects(selectNativeFolder({binding:'e'.repeat(32),expected:{isSameEntry:async()=>false},validateSelection:async()=>{validated=true;}},{request:async op=>{if(op==='folder-resume')return f.selected;if(op==='folder-confirm')confirmed=true;return {};}}),/same connected/);
  assert(!validated&&!confirmed);
});

test('cancelling project setup releases native selection without any proof writes',async()=>{
  const f=selection(),calls=[];let writes=0;
  const get=f.directory.getFileHandle;
  f.directory.getFileHandle=async(...args)=>{if(args[1]?.create)writes++;return get(...args);};
  await assert.rejects(selectNativeFolder({validateSelection:async()=>{throw new DOMException('Setup cancelled','AbortError');}},{request:async op=>{calls.push(op);if(op==='folder-select')return f.selected;return {};}}),{name:'AbortError'});
  assert.deepEqual(calls,['folder-select','folder-release']);assert.equal(writes,0);assert.equal(f.removed.length,0);
});

test('legacy path proof creates a durable binding without selecting or opening Explorer',async()=>{
  const f=folder(),calls=[];
  const result=await verifyNativeFolder({directory:f.directory,absolutePath:'C:\\Synthetic score & notes'},{request:async(op,body)=>{
    calls.push(op);if(op==='folder-challenge')return challenge();
    assert.equal(op,'folder-verify');assert.equal(await f.files.get(body.marker).text(),'private-score-desk-open-v1\n'+body.proof);
    return {binding:'e'.repeat(32),path:body.path};
  }});
  assert.equal(result.nativeBinding,'e'.repeat(32));assert.equal(result.directory,f.directory);assert.deepEqual(calls,['folder-challenge','folder-verify']);assert.equal(f.removed.length,1);
});
test('location actions never ask for browser permission when access has expired',async()=>{
  const f=folder();let requests=0;f.directory.queryPermission=async()=> 'prompt';f.directory.requestPermission=async()=>{requests++;return 'granted';};
  for(const action of [openNativeFolder,verifyNativeFolder])await assert.rejects(action({directory:f.directory,absolutePath:'C:\\Synthetic'},{request:()=>{throw Error('No native action expected');}}),/Connect working folder/);
  assert.equal(requests,0);assert.equal(f.removed.length,0);
});


test('previous versions proves the connected root and uses a fixed native action with no target path argument',async()=>{
  const f=folder(),calls=[];
  await openNativeVersions({directory:f.directory,absolutePath:'D:\\Synthetic'},{request:async(op,body)=>{
    calls.push(op);if(op==='folder-challenge')return challenge();
    assert.equal(body.path,'D:\\Synthetic');assert.equal(body.dataDirectory,'.scorebrush');
    assert.deepEqual(Object.keys(body).sort(),['dataDirectory','marker','name','path','proof','token']);
    return {opened:true,path:body.path+'\\Versions'};
  }});
  assert.deepEqual(calls,['folder-challenge','folder-versions']);assert.equal(f.removed.length,1);
});

test('finished PDF folder proves the connected root and uses a fixed native action with no target path argument',async()=>{
  const f=folder(),calls=[];
  await openNativeLatest({directory:f.directory,absolutePath:'D:\\Synthetic'},{request:async(op,body)=>{
    calls.push(op);if(op==='folder-challenge')return challenge();
    assert.equal(body.path,'D:\\Synthetic');assert.equal(body.dataDirectory,'.scorebrush');
    assert.deepEqual(Object.keys(body).sort(),['dataDirectory','marker','name','path','proof','token']);
    return {opened:true,path:body.path+'\\Latest'};
  }});
  assert.deepEqual(calls,['folder-challenge','folder-latest']);assert.equal(f.removed.length,1);
});

test('numbered Unicode PDF titles add no native path authority',async()=>{
  for(const action of [openNativeVersions,openNativeLatest]){
    const f=folder(),calls=[];
    await action({directory:f.directory,absolutePath:'D:\\Synthetic',pdfOutput:{basename:'Étude 日本語',name:'0007 - Étude 日本語 (2).pdf'},filename:'..\\outside.pdf'},{request:async(op,body)=>{
      calls.push(op);if(op==='folder-challenge')return challenge();
      assert.equal(body.path,'D:\\Synthetic');assert.deepEqual(Object.keys(body).sort(),['dataDirectory','marker','name','path','proof','token']);
      assert(!JSON.stringify(body).includes('outside.pdf'));assert(!JSON.stringify(body).includes('0007'));
      return {opened:true,path:body.path+(action===openNativeVersions?'\\Versions':'\\Latest')};
    }});
    assert.equal(calls[1],action===openNativeVersions?'folder-versions':'folder-latest');assert.equal(f.removed.length,1);
  }
});
