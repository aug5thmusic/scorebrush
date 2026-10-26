// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
export async function waitUntil(page,predicate,timeout=90000){
  const end=Date.now()+timeout;while(!await page.evaluate(predicate)){if(Date.now()>end)throw Error('Timed out: '+predicate);await new Promise(r=>setTimeout(r,50));}
}

// Installed before startup in a disposable context only. Count attempts as
// well as committed writes, including READY invalidations and empty locks.
export async function installResumeAudit(page){
  await page.addInitScript(()=>{
    window.resumeAudit={streams:[],writes:[],closes:[],removes:[],localWrites:[],preferences:[]};
    const open=FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable=async function(...args){
      const name=this.name;resumeAudit.streams.push(name);const stream=await open.apply(this,args),write=stream.write.bind(stream),close=stream.close.bind(stream);
      stream.write=async value=>{resumeAudit.writes.push({name,ready:name==='READY.json'?String(value instanceof Blob?await value.text():value):null});
        if(window.resumeDelay&&name==='snapshot.json'){window.resumeWritePending=true;await new Promise(r=>{window.releaseResumeWrite=r;});window.resumeWritePending=false;}
        if(window.resumeFail&&name===window.resumeFail)throw Error('SYNTHETIC interrupted '+name);
        return write(value);
      };
      stream.close=async()=>{const result=await close();resumeAudit.closes.push(name);return result;};return stream;
    };
    const remove=FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry=function(name,...args){resumeAudit.removes.push(name);return remove.call(this,name,...args);};
    for(const name of ['put','add','delete','clear']){const fn=IDBObjectStore.prototype[name];IDBObjectStore.prototype[name]=function(...args){resumeAudit.localWrites.push({store:this.name,action:name});return fn.apply(this,args);};}
    const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){resumeAudit.preferences.push(key);return set.call(this,key,value);};
  });
}
export async function folderSnapshot(page){
  return page.evaluate(async()=>{
    const a=await import('./app.js'),scene=a.completion.capture(),config=await a.folderWorkspace.io.getSettings(),{sha256}=await import('./model.js'),files={};
    async function walk(dir,prefix=''){for await(const [name,entry]of dir.entries())if(entry.kind==='directory')await walk(entry,prefix+name+'/');else{const blob=await entry.getFile();files[prefix+name]={size:blob.size,sha256:await sha256(await blob.arrayBuffer())};}}
    await walk(config.directory);
    const {workspaceHistory}=await import('./storage.js');
    return {files,workspaceId:scene.workspaceId,revisionId:scene.revisionId,review:scene.review,returned:scene.returned,completions:scene.completions,
      events:(await workspaceHistory(scene.workspaceId)).map(r=>({id:r.id,revisionId:r.revisionId})),recoveryId:config.recoveryId,taskId:config.head?.id??null};
  });
}
export async function assertCleanAudit(page){
  const audit=await page.evaluate(()=>window.resumeAudit);
  assert.deepEqual(audit.streams,[],'clean resume must not even open a project writable stream');
  assert.deepEqual(audit.writes,[]);assert.deepEqual(audit.closes,[]);assert.deepEqual(audit.removes,[]);
  assert(!audit.localWrites.some(w=>w.store==='reviews'||w.store==='handoffs'),'no review events or task retention on resume');
  const proof=name=>/^native-open-[a-f0-9]{32}\.txt$/.test(name);
  audit.counts={projectContentWriteAttempts:audit.writes.filter(w=>!proof(w.name)).length,folderProofWriteAttempts:audit.writes.filter(w=>proof(w.name)).length,
    projectContentCommits:audit.closes.filter(name=>!proof(name)).length,connectionMetadataWrites:audit.localWrites.filter(w=>w.store==='settings').length,interfacePreferenceWrites:audit.preferences.length};
  return audit;
}
// Execute the real browser-side close protocol, with only host transport
// simulated. This is not native WinForms/WebView2 verification.
export async function beginClose(page){
  return page.evaluate(async()=>{
    const a=await import('./app.js'),{installDesktop}=await import('./desktop.js');
    let listener;window.closeMessages=[];
    window.chrome??={};window.chrome.webview={addEventListener:(name,fn)=>{listener=fn;},postMessage:value=>closeMessages.push(value)};
    installDesktop({capture:a.completion.capture,status:a.sessionStatus,saveNow:a.saveNow,folder:a.folderWorkspace,corrections:a.corrections,
      matches:stamp=>JSON.stringify(stamp)===JSON.stringify(a.completion.capture().stamp)},()=>{}, {refresh:()=>{}});
    // installDesktop retains its transport in a closure. Remove the temporary
    // global synchronously so automatic restore still uses browser folder
    // access, rather than sending native requests to this close-only stub.
    delete window.chrome.webview;
    window.cancelTestClose=()=>{listener({data:{op:'cancel-close',token:'4'.repeat(32)}});delete window.chrome.webview;};
    window.closeStarted=performance.now();void listener({data:{op:'prepare-close',token:'4'.repeat(32)}});
  });
}
export async function finishClose(page){
  await page.waitForFunction(()=>window.closeMessages.some(m=>m.op==='close-result'),null,{timeout:60000});
  return page.evaluate(()=>{const value=closeMessages.find(m=>m.op==='close-result'),elapsedMs=performance.now()-closeStarted;cancelTestClose();return {...value,elapsedMs};});
}
