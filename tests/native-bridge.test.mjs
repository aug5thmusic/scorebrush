// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRequest} from '../app/native-bridge.js';

test('native browser launch failures reach the caller and remove the listener',async()=>{
  let listener;
  globalThis.chrome={webview:{addEventListener:(_,fn)=>listener=fn,removeEventListener:()=>listener=null,postMessage:m=>queueMicrotask(()=>listener({data:{op:'external-result',id:m.id,error:'Default browser unavailable'}}))}};
  try{await assert.rejects(nativeRequest('open-source'),/Default browser unavailable/);assert.equal(listener,null);}finally{delete globalThis.chrome;}
});

test('repository action accepts no destination and only its correlated external reply',async()=>{
  let listener,request;
  globalThis.chrome={webview:{addEventListener:(_,fn)=>listener=fn,removeEventListener:()=>listener=null,postMessage:m=>request=m}};
  try{
    const pending=nativeRequest('open-source');assert.deepEqual(Object.keys(request).sort(),['id','op']);
    assert.equal(request.op,'open-source');
    listener({data:{op:'folder-result',id:request.id,value:{opened:true}}});assert(listener);
    listener({data:{op:'external-result',id:'b'.repeat(32),value:{opened:true}}});assert(listener);
    listener({data:{op:'external-result',id:request.id,value:{opened:true}}});assert.deepEqual(await pending,{opened:true});
    assert.throws(()=>nativeRequest('open-unknown'),/Unsupported/);
    assert.throws(()=>nativeRequest('open-source',{url:'https://attacker.invalid'}),/no additional fields/);
    assert.throws(()=>nativeRequest('open-source',{path:'C:\\Windows'}),/no additional fields/);
    assert.equal(listener,null);
  }finally{delete globalThis.chrome;}
});
