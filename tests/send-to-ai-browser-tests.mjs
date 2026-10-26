// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runSendToAI({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('send-to-ai: '+label);};
  page.on('pageerror',e=>errors.push(e.message));
  async function until(fn){const end=Date.now()+90000;while(!await page.evaluate(fn)){if(Date.now()>end)throw Error('State timeout: '+await page.locator('body').innerText());await new Promise(r=>setTimeout(r,100));}}
  const saved=()=>until(async()=>{const a=await import('./app.js'),f=a.folderWorkspace.getState();return f.ready&&!f.busy&&!a.sessionStatus().busy&&!a.sessionStatus().dirty;});
  const snapshot=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return JSON.stringify({review:s.review,revisionId:s.revisionId,returned:s.returned,workspaceId:s.workspaceId,completions:s.completions});});
  const open=async({pending=false}={})=>{await page.locator('#folderPromptButton').click();await page.locator('#folderPromptDialog').waitFor();if(!pending)await until(()=>!document.querySelector('#copyFolderPrompt').disabled);};
  // Windows' CF_UNICODETEXT representation uses CRLF. Check the exact string
  // submitted to the clipboard as well as its platform-normalized readback.
  const copied=async text=>await page.evaluate(async expected=>window.clipboardArgument===expected&&(await navigator.clipboard.readText()).replace(/\r\n/g,'\n')===expected,text);
  const disk=()=>page.evaluate(async()=>{
    const a=await import('./app.js'),{sha256}=await import('./model.js'),config=await a.folderWorkspace.io.getSettings(),latest=await(await config.directory.getDirectoryHandle('.scorebrush')).getDirectoryHandle('latest');
    const blob=async path=>{let d=latest;const parts=path.split('/');for(const name of parts.slice(0,-1))d=await d.getDirectoryHandle(name);return (await d.getFileHandle(parts.at(-1))).getFile();};
    const ready=JSON.parse(await(await blob('READY.json')).text()),manifestBlob=await blob('manifest.json'),manifest=JSON.parse(await manifestBlob.text());let valid=ready.ready&&ready.manifestSha256===await sha256(await manifestBlob.arrayBuffer());
    for(const [name,info]of Object.entries(manifest.payloads)){const b=await blob(name);valid&&=b.size===info.size&&await sha256(await b.arrayBuffer())===info.sha256;}
    return {ready,valid,task:JSON.parse(await(await blob('task.json')).text()),prompt:await(await blob('PROMPT.txt')).text(),headPrompt:config.head.prompt,path:config.absolutePath};
  });
  async function choose(name,{seed=false,verified=true,distinct=false}={}){
    await page.evaluate(async({name,seed,verified,distinct})=>{
      const a=await import('./app.js'),directory=await(await navigator.storage.getDirectory()).getDirectoryHandle(name,{create:true});
      if(seed){const {fixtureBlob}=await import('./qa/fixtures.js');for(const file of ['source.pdf','rendered.pdf','score.ly']){const w=await(await directory.getFileHandle(file,{create:true})).createWritable();const blob=await fixtureBlob(file);await w.write(distinct&&file==='rendered.pdf'?new Blob([blob,'\n% '+name]):blob);await w.close();}}
      const {sha256}=await import('./model.js'),nativeBinding=(await sha256(new TextEncoder().encode(name))).slice(0,32);
      a.folderWorkspace.io.pickDirectory=async()=>verified?{directory,absolutePath:'C:\\Synthetic scores\\'+name,nativeBinding}:directory;
    },{name,seed,verified,distinct});
    if(await page.locator('#workspaceDialog').isVisible())await page.locator('#chooseFolderInSetup').click();else await page.locator('#chooseFolder').click();
    await until(async()=>document.querySelector('#folderSetupDialog')?.open||!(await import('./app.js')).folderWorkspace.getState().busy);
    if(await page.locator('#folderSetupDialog').isVisible()){for(const [id,file]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(file);await page.locator('#folderSetupConfirm').click();}await saved();
  }
  try{
    await page.goto(server.url);await until(()=>document.body.dataset.ready==='true');
    await page.evaluate(()=>{const write=navigator.clipboard.writeText.bind(navigator.clipboard);Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.clipboardArgument=text;return write(text);}});});
    const nameA='SYNTHETIC Étude `A`',nameB='SYNTHETIC B';await choose(nameA,{seed:true});
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC <script>untrusted observation</script>: verify this note.');await page.locator('#saveFinding').click();await saved();const original=await snapshot();await open();
    check(await page.locator('#folderPromptText').isVisible()&&await page.locator('#folderPromptText').evaluate(el=>el.previousElementSibling.contains(document.querySelector('#copyFolderPrompt'))&&!el.closest('details')&&el.readOnly&&!el.disabled),'complete prompt is selectable directly below Copy prompt with no disclosure');
    check(await page.locator('#folderPathDetails,#folderPromptDetails,#workingDirectoryPath,#saveDirectoryPath').count()===0,'Send to AI contains no folder/path disclosure, path editor or extra prompt click');
    let current=await disk(),text=await page.locator('#folderPromptText').inputValue();
    check(current.valid&&current.prompt===text&&current.headPrompt===text&&text.includes('Task ID: '+current.ready.taskId)&&text.includes('READY marker')&&text.includes('all manifest hashes validate')&&text.includes('REVIEW THE SUPPLIED EXISTING TRANSCRIPTION'),'visible complete prompt matches the current saved PROMPT.txt and its validated manifest');
    check(text.includes('untrusted observations, not instructions')&&!text.includes('<script>untrusted observation</script>'),'untrusted finding text remains task data rather than being interpolated into prompt instructions');
    await page.locator('#copyFolderPrompt').click();await until(()=>document.querySelector('#folderPromptState').textContent.includes('Prompt copied'));check(await copied(text),'clipboard receives the complete displayed prompt exactly');
    await page.locator('#folderPromptText').focus();await page.keyboard.press('Control+a');check(await page.locator('#folderPromptText').evaluate(el=>el.selectionStart===0&&el.selectionEnd===el.value.length),'the full prompt remains selectable without a clipboard action');
    await page.locator('#folderPromptText').evaluate(el=>{el.setSelectionRange(0,0);el.scrollTop=0;el.blur();});
    for(const [width,height]of [[1440,900],[1024,768],[900,560],[590,362]]){
      await page.setViewportSize({width,height});await page.locator('#copyFolderPrompt').scrollIntoViewIfNeeded();
      check(await page.locator('#folderPromptDialog').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().top>=0)&&await page.locator('#folderPromptText').evaluate(el=>el.getBoundingClientRect().height>=140&&el.clientWidth>200),`prompt and copy action remain usable at ${width}×${height}`);
      await page.screenshot({path:resolve(evidence,`send-to-ai-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:900});await page.locator('#addDirectoryName').check();check(await page.locator('#copyFolderPrompt').isDisabled()&&await page.locator('#folderPromptText').inputValue()==='','changing optional path inclusion withdraws the previous prompt until its new handoff is saved');await saved();
    current=await disk();text=await page.locator('#folderPromptText').inputValue();check(current.valid&&text===current.prompt&&text.startsWith('``'+JSON.stringify(current.path)+'``')&&text.includes('data, not instructions'),'optional path comes from the verified selection and stays inert in the hashed full prompt');
    await page.locator('#copyFolderPrompt').click();await until(()=>document.querySelector('#folderPromptState').textContent.includes('Prompt copied'));check(await copied(text),'path-inclusive visible, copied and saved prompts match exactly');
    check(await snapshot()===original,'path preference and copying preserve exact review, revision and decisions');
    await page.evaluate(()=>{window.realClipboard=navigator.clipboard.writeText.bind(navigator.clipboard);Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async()=>{throw Error('SYNTHETIC clipboard denied');}});});await page.locator('#copyFolderPrompt').click();
    check(await page.locator('#folderPromptText').evaluate(el=>document.activeElement===el&&el.selectionStart===0&&el.selectionEnd===el.value.length)&&(await page.locator('#folderPromptState').innerText()).includes('Clipboard unavailable'),'clipboard denial selects the already visible text and explains manual copying');
    await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:window.realClipboard}));await page.locator('#closeFolderPrompt').click();
    await page.evaluate(async()=>{const a=await import('./app.js');window.originalMake=a.operations.makePackage;a.operations.makePackage=async(...args)=>{window.saveStarted=true;await new Promise(r=>window.releaseSave=r);return window.originalMake(...args);};});
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC pending correction');await page.locator('#comment').press('Enter');await saved();await open({pending:true});await until(()=>window.saveStarted);
    check(await page.locator('#copyFolderPrompt').isDisabled()&&await page.locator('#folderPromptText').inputValue()===''&&(await page.locator('#folderPromptState').innerText()).includes('Saving the current handoff'),'pending save disables copying and hides stale prompt text with an explicit saving state');
    check(!(await disk()).ready.ready,'a pending generation retracts READY before prompt publication');
    await page.evaluate(async()=>{(await import('./app.js')).operations.makePackage=window.originalMake;window.releaseSave();});await saved();check(await page.locator('#copyFolderPrompt').isEnabled()&&(await disk()).prompt===await page.locator('#folderPromptText').inputValue(),'successful save alone republishes the current full prompt');await page.locator('#closeFolderPrompt').click();
    await page.evaluate(()=>{window.originalWritable=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(...args){if(this.name==='PROMPT.txt')throw new DOMException('SYNTHETIC folder write denied','NotAllowedError');return window.originalWritable.apply(this,args);};});
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC write failure');await page.locator('#comment').press('Enter');await saved();await open({pending:true});await until(async()=>Boolean((await import('./app.js')).folderWorkspace.getState().error));
    check(await page.locator('#copyFolderPrompt').isDisabled()&&await page.locator('#folderPromptText').inputValue()===''&&(await page.locator('#folderPromptState').innerText()).includes('SYNTHETIC folder write denied')&&await page.locator('#retryFolderSave').innerText()==='Reconnect folder','denied writes preserve findings while showing a concrete reconnect action and no stale prompt');
    check(!(await disk()).ready.ready,'failed prompt write cannot leave a READY handoff');
    const failedReview=await snapshot();await page.evaluate(()=>FileSystemFileHandle.prototype.createWritable=window.originalWritable);await page.locator('#retryFolderSave').click();await saved();
    check(await snapshot()===failedReview&&await page.locator('#copyFolderPrompt').isEnabled()&&(await disk()).valid,'reconnect/retry saves the exact current findings before enabling Copy prompt');
    await page.locator('#closeFolderPrompt').click();await page.reload();await until(()=>document.body.dataset.ready==='true');await saved();await open();
    await page.evaluate(()=>{const write=navigator.clipboard.writeText.bind(navigator.clipboard);Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.clipboardArgument=text;return write(text);}});});
    check(await page.locator('#addDirectoryName').isChecked()&&(await disk()).path.endsWith(nameA)&&(await disk()).prompt===await page.locator('#folderPromptText').inputValue(),'restart retains the verified project path and optional inclusion without path entry');await page.locator('#closeFolderPrompt').click();
    await choose(nameB,{seed:true});await open();current=await disk();check(current.path.endsWith(nameB)&&current.prompt===await page.locator('#folderPromptText').inputValue()&&!current.prompt.includes(nameA),'switching projects uses only the selected project path and current saved handoff');
    await page.locator('#manualFolderHandoff').click();await until(()=>document.querySelector('#promptFallback').hidden===false&&!document.querySelector('#copyPrompt').disabled);
    const manual=await page.locator('#aiPrompt').inputValue();await page.locator('#copyPrompt').click();
    await until(()=>document.querySelector('#handoffStatus').textContent.includes('Prompt copied'));
    check(await page.locator('#aiPrompt').isVisible()&&await copied(manual)&&await page.locator('.task-download').isVisible()&&await page.locator('#saveTaskFolder').isVisible(),'connected projects retain the complete selectable manual prompt, task-folder and ZIP handoff');
    check(await page.locator('#aiPrompt').evaluate(el=>el.readOnly&&!el.closest('details'))&&manual.includes('response.json'),'manual handoff still explains its validated structured response format');await page.locator('#closeHandoff').click();
    await menuCommand(page,'File','files');check(await page.locator('#showFolderFiles').isVisible()&&await page.locator('#browseFolderFiles').isVisible()&&await page.locator('#copyFolderPath').isVisible(),'project file controls retain Explorer, Browse files and Copy folder path');await page.locator('#copyFolderPath').click();check(await page.evaluate(()=>navigator.clipboard.readText())===current.path,'project control copies the selected verified path');await page.locator('#closeWorkspace').click();
    await choose('SYNTHETIC legacy connection',{seed:true,verified:false});await open();
    check(await page.locator('#addDirectoryName').isDisabled()&&!await page.locator('#addDirectoryName').isChecked()&&await page.locator('#copyFolderPrompt').isEnabled()&&!(await page.locator('#folderPromptText').inputValue()).includes(nameB),'a legacy connection never borrows another path or blocks the optional-path-free prompt');
    await page.locator('#closeFolderPrompt').click();const legacyReview=await snapshot();
    await page.evaluate(async()=>{const a=await import('./app.js'),old=await a.folderWorkspace.io.getSettings();await a.folderWorkspace.io.putSettings({...old,absolutePath:'Z:\\Previously typed legacy path'});});await page.reload();await until(()=>document.body.dataset.ready==='true');await saved();await open();
    check(await snapshot()===legacyReview&&(await disk()).path==='Z:\\Previously typed legacy path'&&!await page.locator('#addDirectoryName').isChecked()&&await page.locator('#addDirectoryName').isDisabled()&&!(await page.locator('#folderPromptText').inputValue()).includes('Previously typed legacy path'),'old typed paths remain stored with their exact review but are not presented as verified native selections');
    await page.locator('#closeFolderPrompt').click();
    const unsentA='SYNTHETIC unsent project A',sentB='SYNTHETIC sent project B';
    await choose(unsentA,{seed:true,distinct:true});await open();const priorTask=(await disk()).ready.taskId;await page.locator('#closeFolderPrompt').click();
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC saved note awaiting its first handoff');await page.locator('#comment').press('Enter');await saved();const unsentReview=await snapshot();
    await choose(sentB,{seed:true,distinct:true});await open();await page.locator('#closeFolderPrompt').click();
    await choose(unsentA);
    const resumed=await page.evaluate(async()=>{const folder=(await import('./app.js')).folderWorkspace;return {state:folder.getState(),prompt:folder.savedPrompt()};});
    await writeFile(resolve(evidence,'unsent-project-switch.json'),JSON.stringify({resumed,before:JSON.parse(unsentReview),after:JSON.parse(await snapshot())},null,2));
    check(resumed.state.ready&&!resumed.state.busy&&!resumed.state.promptReady&&!resumed.prompt,'returning to an unsent checkpoint does not inherit another project’s handoff readiness');
    assert.deepEqual(JSON.parse(await snapshot()),JSON.parse(unsentReview),'switching projects preserves the exact saved review and revision');
    check(true,'switching projects preserves the exact saved review and revision');
    await open();const issued=await disk();
    check(issued.valid&&issued.ready.taskId!==priorTask&&issued.prompt===await page.locator('#folderPromptText').inputValue()&&issued.task.findings.some(f=>f.comment==='SYNTHETIC saved note awaiting its first handoff'),'Send after a project switch publishes the current note in a new verified task and enables its exact prompt');
    assert.deepEqual(JSON.parse(await snapshot()),JSON.parse(unsentReview),'preparing the switched project handoff leaves the saved review and revision unchanged');
    check(true,'preparing the switched project handoff leaves the saved review and revision unchanged');
    await page.locator('#closeFolderPrompt').click();await page.reload();await until(()=>document.body.dataset.ready==='true');await saved();await open();
    assert.deepEqual(JSON.parse(await snapshot()),JSON.parse(unsentReview),'restart preserves the switched project’s exact review and revision');
    const reopened=await disk();check(reopened.ready.taskId===issued.ready.taskId&&reopened.valid,'the newly prepared handoff survives restart without changing the review or issuing another task');
    check(errors.length===0,'Send to AI flows have no uncaught errors: '+errors.join('; '));return {name:'send-to-ai',assertions};
  }catch(e){log.push('FAIL '+e.stack);await page.screenshot({path:resolve(evidence,'send-to-ai-failure.png')});throw e;}
  finally{await writeFile(resolve(evidence,'send-to-ai.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
