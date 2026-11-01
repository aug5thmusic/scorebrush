// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Real UI entry points and disposable OPFS folders; only the selected-head I/O
// boundary and picker are delayed. The real project, storage and folder code run.
export async function runRecentProjectSelection({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[],errors=[],report={};let assertions=0;
  const check=(condition,label)=>{assert(condition,label);assertions++;log.push('PASS '+label);console.log('recent-project-selection: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const settled=()=>page.waitForFunction(()=>!a.folderWorkspace.getState().selecting&&!a.folderWorkspace.getState().busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty,null,{timeout:120000});
  const saved=name=>page.waitForFunction(name=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||s.saveFailed||s.saveConflict)throw Error(f.error||'Synthetic local save failed');return f.ready&&!f.selecting&&!f.busy&&!s.busy&&!s.dirty&&(!name||f.directoryName===name);},name,{timeout:120000});
  async function command(name){await page.locator('#appMenuFile').click();await page.locator(`#menuFile [data-command="${name}"]`).click();}
  async function recent(name){await command('open-folder');await page.locator('#projectOpenDialog').waitFor();await page.locator('#recentProjects .recent-project').filter({hasText:name}).click();}
  const capture=()=>page.evaluate(()=>selectionAudit.capture());
  async function unchanged(before,label){assert.deepEqual(await capture(),before);check(true,label+' preserves the exact active review, binding and synthetic folder bytes');}
  const arm=async(name,count=1)=>page.evaluate(({name,count})=>{
    selectionAudit.hydrated=[];selectionAudit.gates=[];selectionAudit.holdName=name;selectionAudit.holds=count;
  },{name,count});
  const held=number=>page.waitForFunction(number=>selectionAudit.gates.length>=number,number);
  async function competing(label){
    const initial=await page.evaluate(()=>({state:a.folderWorkspace.getState(),pickers:selectionAudit.pickers.length,hydrations:selectionAudit.hydrated.length}));
    await page.locator('#appMenuFile').click();
    const disabled=[];
    // Mouse input still reaches the disabled control's screen location. It must
    // not dispatch a selection, just as a user's competing click must not.
    for(const name of ['new-project','open-folder']){
      const item=page.locator(`#menuFile [data-command="${name}"]`),box=await item.boundingBox();disabled.push(Boolean(box)&&await item.isDisabled());
      if(box)await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
    }
    await page.keyboard.press('Escape');
    const afterUI=await page.evaluate(()=>({state:a.folderWorkspace.getState(),pickers:selectionAudit.pickers.length,recentOpen:document.getElementById('projectOpenDialog').open}));
    check(initial.state.selecting&&initial.state.busy&&disabled.every(Boolean)&&afterUI.pickers===initial.pickers&&!afterUI.recentOpen,label+' reserves selection before hydration and blocks actual File → New/Open clicks');
    await page.evaluate(async()=>{const entry=(await selectionAudit.original.listSettings({hydrate:false})).find(e=>e.directory.name===selectionAudit.holdName);await Promise.all([a.folderWorkspace.choose({mode:'new'}),a.folderWorkspace.choose({mode:'open'}),a.folderWorkspace.choose({mode:'open',recent:entry})]);});
    const afterRepeated=await page.evaluate(()=>({state:a.folderWorkspace.getState(),pickers:selectionAudit.pickers.length,hydrations:selectionAudit.hydrated.length}));
    check(afterRepeated.pickers===initial.pickers&&afterRepeated.hydrations===initial.hydrations,label+' repeated requests invoke neither another picker nor another selected-head read');
    check(afterRepeated.state.selecting&&afterRepeated.state.busy,label+' rejected competing requests cannot release the original operation guard');
  }
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js'),root=await navigator.storage.getDirectory();window.selectionDirectories={};
      for(const name of ['SYNTHETIC Recent A','SYNTHETIC Recent B','SYNTHETIC New selection']){
        const directory=await root.getDirectoryHandle(name,{create:true});selectionDirectories[name]=directory;
        for(const file of ['source.pdf','rendered.pdf','score.ly']){const writer=await(await directory.getFileHandle(file,{create:true})).createWritable();await writer.write(await fixtureBlob(file));await writer.close();}
      }
    });
    for(const name of ['SYNTHETIC Recent A','SYNTHETIC Recent B']){
      await page.evaluate(name=>{a.folderWorkspace.io.pickDirectory=()=>Promise.resolve(selectionDirectories[name]);},name);
      if(name.endsWith(' A'))await page.locator('#chooseFolderInSetup').click();else await command('new-project');
      await page.locator('#folderSetupDialog').waitFor();for(const [id,file]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(file);
      await page.locator('#folderSetupConfirm').click();await saved(name);
      await page.locator('#newFinding').click();await page.locator('#comment').fill(name+' retained correction');await page.locator('#saveFinding').click();await saved(name);
      await page.evaluate(()=>a.folderWorkspace.saveNow());await saved(name);
    }
    await recent('SYNTHETIC Recent A');await saved('SYNTHETIC Recent A');
    await page.evaluate(async()=>{
      const io=a.folderWorkspace.io,{sha256}=await import('./model.js');
      window.selectionAudit={original:{listSettings:io.listSettings,hydrateConnection:io.hydrateConnection,pickDirectory:io.pickDirectory},listed:[],hydrated:[],pickers:[],gates:[],holds:0,holdName:'',metadataError:null,inTrustedClick:false};
      selectionAudit.capture=async()=>{
        const scene=a.completion.capture(),config=await io.getSettings(),disk={};
        async function scan(directory,path){for await(const [name,entry]of directory.entries()){if(entry.kind==='directory')await scan(entry,path+name+'/');else disk[path+name]=await sha256(await(await entry.getFile()).arrayBuffer());}}
        for(const [name,directory]of Object.entries(selectionDirectories))await scan(directory,name+'/');
        const {directory,...binding}=config;
        return {scene:{projectId:scene.projectId,workspaceId:scene.workspaceId,revisionId:scene.revisionId,persistedRevision:scene.persistedRevision,review:scene.review,returned:scene.returned,completions:scene.completions},binding:JSON.parse(JSON.stringify({...binding,directory:directory.name})),disk};
      };
      io.listSettings=async options=>{const entries=await selectionAudit.original.listSettings(options);selectionAudit.listed.push({hydrate:options?.hydrate,entries:entries.map(e=>({name:e.directory.name,headRef:e.headRef,hasHead:Boolean(e.head)}))});return entries.map(e=>selectionAudit.metadataError&&e.directory.name===selectionAudit.metadataError.name?{...e,folderStorageError:selectionAudit.metadataError.message}:e);};
      io.hydrateConnection=async entry=>{
        selectionAudit.hydrated.push({name:entry.directory.name,headRef:entry.headRef,hasHead:Boolean(entry.head)});
        if(entry.directory.name===selectionAudit.holdName&&selectionAudit.holds-->0)await new Promise((resolve,reject)=>selectionAudit.gates.push({resolve,reject}));
        return selectionAudit.original.hydrateConnection(entry);
      };
      // Every unexpected competing picker stays pending, reproducing the
      // reviewed race instead of making it disappear through quick cancellation.
      io.pickDirectory=()=>{selectionAudit.pickers.push({inTrustedClick:selectionAudit.inTrustedClick,activation:navigator.userActivation.isActive,guarded:a.folderWorkspace.getState().selecting});return new Promise((resolve,reject)=>selectionAudit.cancelPicker=()=>reject(new DOMException('Synthetic picker cancelled','AbortError')));};
      // Wrap the real DOM handler's call stack: an await inserted before the
      // picker would resume after this finally, even if activation still lives.
      for(const selector of ['#menuFile [data-command="new-project"]','#browseProjectFolder']){
        const button=document.querySelector(selector),onclick=button.onclick;
        button.onclick=function(event){selectionAudit.inTrustedClick=event.isTrusted;try{return onclick.call(this,event);}finally{selectionAudit.inTrustedClick=false;}};
      }
    });

    const first=await capture();report.first=first.scene;
    await arm('SYNTHETIC Recent B',2);await recent('SYNTHETIC Recent B');await held(1);
    check(await page.locator('#projectOpenDialog').isHidden(),'recent-project dialog closes while its selected handoff is delayed');
    await competing('Delayed recent project');await unchanged(first,'Pending hydration');
    const lazy=await page.evaluate(()=>({listed:selectionAudit.listed,hydrated:selectionAudit.hydrated}));
    check(lazy.listed.length>0&&lazy.listed.every(call=>call.hydrate===false&&call.entries.every(e=>!e.hasHead))&&lazy.hydrated.length===1&&lazy.hydrated[0].name==='SYNTHETIC Recent B'&&Boolean(lazy.hydrated[0].headRef),'recent listing stays metadata-only and initially hydrates only the selected connection');
    await page.evaluate(()=>selectionAudit.gates[0].resolve());await held(2);await competing('Selection continuation');
    await unchanged(first,'Selection before its second hydration completes');
    await page.evaluate(()=>selectionAudit.gates[1].resolve());await saved('SYNTHETIC Recent B');
    check(await page.evaluate(()=>!a.folderWorkspace.getState().selecting&&!a.folderWorkspace.getState().busy&&selectionAudit.hydrated.every(e=>e.name==='SYNTHETIC Recent B')),'guard remains owned through continuation and releases after the selected project opens');
    check((await capture()).scene.review.findings[0].comment==='SYNTHETIC Recent B retained correction','successful delayed selection restores the chosen project exact findings');

    for(const kind of ['error','cancel']){
      const before=await capture(),target=before.binding.directory.endsWith(' B')?'SYNTHETIC Recent A':'SYNTHETIC Recent B';
      await arm(target);await recent(target);await held(1);await competing('Hydration '+kind);
      await page.evaluate(kind=>selectionAudit.gates[0].reject(kind==='cancel'?new DOMException('SYNTHETIC hydration cancelled','AbortError'):new Error('SYNTHETIC selected handoff read failed')),kind);await settled();
      const state=await page.evaluate(()=>a.folderWorkspace.getState());
      check(!state.selecting&&!state.busy,kind+' releases the selection guard');
      check(kind==='error'?state.loadError&&state.loadAction==='choose'&&state.loadNotice.includes('SYNTHETIC selected handoff read failed'):!state.loadError&&!(state.loadNotice??'').includes('SYNTHETIC hydration cancelled'),kind==='error'?'hydration failure is reported through the guarded project status':'hydration cancellation is handled without an unhandled error or false failure notice');
      await unchanged(before,'Hydration '+kind);
      await arm(target,0);await recent(target);await saved(target);
      check(!await page.evaluate(()=>a.folderWorkspace.getState().loadError),kind+' permits a successful retry through Open Project and Recent');
    }

    const beforeMetadataError=await capture(),metadataTarget=beforeMetadataError.binding.directory.endsWith(' B')?'SYNTHETIC Recent A':'SYNTHETIC Recent B';
    await page.evaluate(name=>{selectionAudit.metadataError={name,message:'SYNTHETIC retained recent handoff unavailable'};},metadataTarget);
    await recent(metadataTarget);await settled();
    check(await page.evaluate(()=>!a.folderWorkspace.getState().selecting&&a.folderWorkspace.getState().loadError&&a.folderWorkspace.getState().loadNotice.includes('SYNTHETIC retained recent handoff unavailable')),'a pre-existing selected-connection error also settles inside the guarded lifecycle');
    await unchanged(beforeMetadataError,'Selected connection metadata failure');
    await page.evaluate(()=>{selectionAudit.metadataError=null;});await recent(metadataTarget);await saved(metadataTarget);
    check(!await page.evaluate(()=>a.folderWorkspace.getState().loadError),'a failed selected connection can be retried without leaving selection locked');

    for(const mode of ['new','open']){
      const before=await capture();await page.evaluate(()=>{selectionAudit.pickerStart=selectionAudit.pickers.length;});
      if(mode==='new')await command('new-project');else{await command('open-folder');await page.locator('#browseProjectFolder').click();}
      const picker=await page.evaluate(()=>selectionAudit.pickers.at(-1));
      check(picker.inTrustedClick&&picker.activation&&picker.guarded,mode+' picker is invoked synchronously in the trusted click before any await, with activation and guard intact');
      await competing('Ordinary '+mode+' picker');
      await page.evaluate(()=>selectionAudit.cancelPicker());await settled();await unchanged(before,'Ordinary '+mode+' cancellation');
      check(await page.evaluate(()=>selectionAudit.pickers.length===selectionAudit.pickerStart+1&&!a.folderWorkspace.getState().selecting),'ordinary '+mode+' cancellation releases its one picker operation');
    }
    const beforeSyncCancel=await capture();
    await page.evaluate(()=>{a.folderWorkspace.io.pickDirectory=()=>{selectionAudit.syncCancel={inTrustedClick:selectionAudit.inTrustedClick,activation:navigator.userActivation.isActive,guarded:a.folderWorkspace.getState().selecting};throw new DOMException('SYNTHETIC synchronous picker cancellation','AbortError');};});
    await command('new-project');await settled();
    check(await page.evaluate(()=>selectionAudit.syncCancel.inTrustedClick&&selectionAudit.syncCancel.activation&&selectionAudit.syncCancel.guarded&&!a.folderWorkspace.getState().selecting),'synchronous picker cancellation is guarded and releases without losing transient activation');
    await unchanged(beforeSyncCancel,'Synchronous picker cancellation');
    check(errors.length===0,'all failure and cancellation paths settle without uncaught browser errors');
    report.errors=errors;report.final=await capture();report.audit=await page.evaluate(()=>({listed:selectionAudit.listed,hydrated:selectionAudit.hydrated,pickers:selectionAudit.pickers}));
    await page.screenshot({path:resolve(evidence,'recent-project-selection.png')});
    return {name:'recent-project-selection',assertions};
  }catch(error){report.failure={message:error.message,stack:error.stack};try{report.failureState=await page.evaluate(()=>({folder:a.folderWorkspace.getState(),hydrated:selectionAudit?.hydrated,pickers:selectionAudit?.pickers}));await page.screenshot({path:resolve(evidence,'recent-project-selection-failure.png')});}catch{}throw error;}
  finally{await writeFile(resolve(evidence,'recent-project-selection.txt'),log.join('\n')+'\n');await writeFile(resolve(evidence,'recent-project-selection.json'),JSON.stringify(report,null,2));await context.close();await server.close();}
}
