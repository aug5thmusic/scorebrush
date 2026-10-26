// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runNewProjectCancel({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1200,height:850}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,text)=>{assert(ok,text);assertions++;log.push('PASS '+text);console.log('new-project-cancel: '+text);};
  page.on('pageerror',error=>errors.push(error.message));
  const until=async predicate=>{const end=Date.now()+30000;while(!await page.evaluate(predicate)){if(Date.now()>end)throw Error('Synthetic setup did not settle');await new Promise(resolve=>setTimeout(resolve,25));}};
  const saved=()=>until(()=>{const f=window.app.folderWorkspace.getState();return f.ready&&!f.busy&&!window.app.sessionStatus().dirty;});
  const menu=async()=>{await page.locator('#appMenuFile').click();await page.locator('#menuFile [data-command=new-project]').click();};
  const roles=async()=>{await page.locator('#folderSetupDialog').waitFor();for(const [id,path]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(path);};
  const pick=async(name,{native=false,hold=false}={})=>page.evaluate(({name,native,hold})=>{
    window.app.folderWorkspace.io.pickDirectory=options=>{
      window.picks++;
      if(hold)return new Promise((resolve,reject)=>window.cancelPicker=()=>reject(new DOMException('Synthetic cancellation','AbortError')));
      if(name==='sync-cancel')throw new DOMException('Synthetic cancellation','AbortError');
      if(name==='async-cancel')return Promise.reject(new DOMException('Synthetic cancellation','AbortError'));
      const directory=window.directories[name];
      if(!native)return Promise.resolve(directory);
      // Exercise the production native selection/proof ordering against real
      // disposable browser directory handles. The host response is a stub.
      return window.nativeFolder.selectNativeFolder(options,{request:async(op,body)=>{
        window.nativeCalls.push(op);
        if(op==='folder-select')return {directory,path:'C:\\SYNTHETIC\\'+name,token:'a'.repeat(32),marker:'native-open-'+ 'b'.repeat(32)+'.txt',proof:'c'.repeat(64)};
        if(op==='folder-confirm')return {binding:'d'.repeat(32),path:'C:\\SYNTHETIC\\'+name};
        return {released:true};
      }});
    };
  },{name,native,hold});
  const snapshot=()=>page.evaluate(()=>window.snapshot());
  const counters=()=>page.evaluate(()=>structuredClone(window.audit));
  const reset=()=>page.evaluate(()=>{window.audit={writes:[],creates:[],removes:[],packages:0,local:0,settings:0};window.nativeCalls=[];});
  // No saved()/idle() poll is allowed between cancellation and these checks.
  const unchanged=async(before,label)=>{
    const immediate=await page.evaluate(()=>({folder:window.app.folderWorkspace.getState(),enabled:window.app.applicationShell.states()['new-project'].enabled,audit:window.audit}));
    check(!immediate.folder.selecting&&!immediate.folder.busy&&immediate.folder.ready&&immediate.enabled,label+': immediately ready and New Project enabled');
    assert.deepEqual(immediate.audit,{writes:[],creates:[],removes:[],packages:0,local:0,settings:0});check(true,label+': no folder mutation, local save, binding write or prompt build');
    assert.deepEqual(await snapshot(),before);check(true,label+': exact review, binding, generation, prompt and READY contents unchanged');
  };
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.app=await import('./app.js');window.nativeFolder=await import('./native-folder.js');window.picks=0;window.nativeCalls=[];
      const {fixtureBlob}=await import('./qa/fixtures.js'),root=await navigator.storage.getDirectory();window.directories={};
      for(const name of ['SYNTHETIC-saved','SYNTHETIC-empty']){
        const directory=await root.getDirectoryHandle(name,{create:true});window.directories[name]=directory;
        for(const file of ['source.pdf','rendered.pdf','score.ly']){const writer=await(await directory.getFileHandle(file,{create:true})).createWritable();await writer.write(await fixtureBlob(file));await writer.close();}
      }
    });
    await pick('SYNTHETIC-saved');await page.locator('#chooseFolderInSetup').click();await roles();await page.locator('#folderSetupConfirm').click();await saved();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC retained correction');await page.locator('#saveFinding').click();await saved();
    await page.evaluate(()=>window.app.folderWorkspace.openPrompt());await until(()=>Boolean(window.app.folderWorkspace.savedPrompt()));await page.locator('#closeFolderPrompt').click();await saved();
    await page.evaluate(async()=>{
      const {sha256}=await import('./model.js');
      window.snapshot=async()=>{
        const app=window.app,c=await app.folderWorkspace.io.getSettings(),s=app.completion.capture(),disk={};
        const scan=async(directory,path)=>{for await(const [name,handle]of directory.entries()){if(handle.kind==='directory')await scan(handle,path+name+'/');else disk[path+name]=await sha256(await(await handle.getFile()).arrayBuffer());}};
        for(const [name,directory]of Object.entries(window.directories))await scan(directory,name+'/');
        const {directory,...binding}=c;
        return {review:s.review,returned:s.returned,completions:s.completions,revisionId:s.revisionId,workspaceId:s.workspaceId,persistedRevision:s.persistedRevision,folder:app.folderWorkspace.getState(),binding,prompt:app.folderWorkspace.savedPrompt(),disk};
      };
      const writable=FileSystemFileHandle.prototype.createWritable;
      window.checkpointGate=null;window.checkpointStarts=0;
      FileSystemFileHandle.prototype.createWritable=async function(...args){window.audit.writes.push(this.name);if(this.name==='current-review.json'){window.checkpointStarts++;const gate=window.checkpointGate;if(gate)await gate;}return writable.apply(this,args);};
      for(const method of ['getFileHandle','getDirectoryHandle']){const real=FileSystemDirectoryHandle.prototype[method];FileSystemDirectoryHandle.prototype[method]=function(name,options){if(options?.create)window.audit.creates.push(method+':'+name);return real.call(this,name,options);};}
      const remove=FileSystemDirectoryHandle.prototype.removeEntry;FileSystemDirectoryHandle.prototype.removeEntry=function(name,...args){window.audit.removes.push(name);return remove.call(this,name,...args);};
      const make=window.app.operations.makePackage;
      window.app.operations.makePackage=async(...args)=>{window.audit.packages++;return make(...args);};
      const put=window.app.operations.putSaved;window.app.operations.putSaved=(...args)=>{window.audit.local++;return put(...args);};
      for(const method of ['putSettings','putConnection']){const real=window.app.folderWorkspace.io[method];window.app.folderWorkspace.io[method]=(...args)=>{window.audit.settings++;return real(...args);};}
    });
    await reset();const baseline=await snapshot();check(baseline.folder.ready&&baseline.prompt?.text,'fixture starts with a fully saved project and ready AI handoff');
    for(const name of ['sync-cancel','async-cancel']){
      await pick(name);await menu();await unchanged(baseline,name);
    }
    for(const native of [false,true])for(const kind of ['roles','existing'])for(const escape of [false,true]){
      await reset();await pick(kind==='roles'?'SYNTHETIC-empty':'SYNTHETIC-saved',{native});await menu();
      const dialog=kind==='roles'?'#folderSetupDialog':'#projectChoiceDialog';await page.locator(dialog).waitFor();
      if(kind==='roles')await roles();
      check(await page.evaluate(()=>window.app.folderWorkspace.getState().ready&&Boolean(window.app.folderWorkspace.savedPrompt())),`${native?'native':'browser'} ${kind}: saved output stays ready during setup`);
      if(escape)await page.locator(dialog).press('Escape');else await page.locator(kind==='roles'?'#folderSetupCancel':'#cancelProjectChoice').click();
      await unchanged(baseline,`${native?'native':'browser'} ${kind} ${escape?'Escape':'Cancel'}`);
      if(native){assert.deepEqual(await page.evaluate(()=>window.nativeCalls),['folder-select','folder-release']);check(true,'native cancellation releases the selected handle without a proof write or binding confirmation');}
    }
    // The immediate assertions above already ran; this separate delay detects
    // accidentally scheduled debounce saves, never masks disabled commands.
    await new Promise(resolve=>setTimeout(resolve,1400));await unchanged(baseline,'after autosave debounce interval');
    const startSave=async()=>{
      await reset();await page.evaluate(()=>{window.checkpointStarts=0;window.checkpointGate=new Promise(resolve=>window.releaseCheckpoint=resolve);});
      await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC save already running '+Date.now());await page.locator('#saveFinding').click();
      await until(()=>window.checkpointStarts===1);return page.evaluate(()=>window.app.folderWorkspace.getState().generation);
    };
    for(const kind of ['picker','roles','existing']){
      const generation=await startSave(),before=await counters();
      await pick(kind==='existing'?'SYNTHETIC-saved':'SYNTHETIC-empty',{hold:kind==='picker'});await menu();
      if(kind==='picker')await page.evaluate(()=>window.cancelPicker());
      else {await page.locator(kind==='roles'?'#folderSetupDialog':'#projectChoiceDialog').waitFor();await page.locator(kind==='roles'?'#folderSetupCancel':'#cancelProjectChoice').click();}
      const immediate=await page.evaluate(()=>({state:window.app.folderWorkspace.getState(),enabled:window.app.applicationShell.states()['new-project'].enabled}));
      check(immediate.state.generation===generation&&!immediate.state.selecting&&immediate.state.busy&&immediate.enabled,kind+': cancellation returns while the original checkpoint is still blocked, with its generation unchanged');
      assert.deepEqual(await counters(),before);check(true,kind+': cancellation adds no writes or save work while the prior save is pending');
      await pick('async-cancel');const picks=await page.evaluate(()=>window.picks);await menu();check(await page.evaluate(()=>window.picks)===picks+1,kind+': New Project can be invoked again before the original save finishes');
      await page.evaluate(()=>{window.checkpointGate=null;window.releaseCheckpoint();});await saved();
      check(await page.evaluate(g=>window.audit.packages===0&&window.checkpointStarts===1&&window.app.folderWorkspace.getState().generation===g&&window.app.folderWorkspace.getState().lastCheckpointGeneration===g,generation),kind+': original checkpoint succeeds once, with its own unchanged generation and no handoff build');
    }
    const generation=await startSave();await pick('SYNTHETIC-saved');await menu();await page.locator('#projectChoiceDialog').waitFor();
    await page.evaluate(()=>{window.checkpointGate=null;window.releaseCheckpoint();});
    await until(()=>window.app.folderWorkspace.getState().ready);
    check(await page.locator('#projectChoiceDialog').isVisible()&&await page.evaluate(g=>window.app.folderWorkspace.getState().lastCheckpointGeneration===g&&window.checkpointStarts===1&&window.audit.packages===0,generation),'an existing checkpoint can finish normally while confirmation remains open');
    const writesAfterSave=await counters();await page.locator('#cancelProjectChoice').click();assert.deepEqual(await counters(),writesAfterSave);
    check(await page.evaluate(()=>window.app.applicationShell.states()['new-project'].enabled&&window.app.folderWorkspace.getState().ready),'cancelling after the prior save finishes leaves its output ready immediately');
    // Re-read the target after an in-flight save finishes before opening it.
    await startSave();await pick('SYNTHETIC-saved');await menu();await page.locator('#projectChoiceDialog').waitFor();
    const review=await page.evaluate(()=>window.app.completion.capture().review);await page.locator('#confirmProjectChoice').click();
    await page.evaluate(()=>{window.checkpointGate=null;window.releaseCheckpoint();});await saved();
    assert.deepEqual(await page.evaluate(()=>window.app.completion.capture().review),review);check(true,'accepting an existing project after a pending save opens the latest saved history');
    check(errors.length===0,'cancellation checks produce no uncaught errors: '+errors.join('; '));
    return {name:'new-project-cancel',assertions};
  }catch(error){log.push('FAIL '+error.stack);log.push('STATE '+JSON.stringify(await page.evaluate(()=>({folder:window.app?.folderWorkspace.getState(),audit:window.audit})).catch(()=>null)));await page.screenshot({path:resolve(evidence,'new-project-cancel-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'new-project-cancel.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
