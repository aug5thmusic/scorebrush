// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runButtonSpacing({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('button-spacing: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  const style=selector=>page.locator(selector).evaluate(el=>{
    const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
    let bg=getComputedStyle(el).backgroundColor,parent=el;
    while(bg==='rgba(0, 0, 0, 0)'&&parent.parentElement){parent=parent.parentElement;bg=getComputedStyle(parent).backgroundColor;}
    const background=rgb(bg),foreground=rgb(getComputedStyle(el).color),luminance=values=>{const c=values.map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*c[0]+.7152*c[1]+.0722*c[2];},a=luminance(background),b=luminance(foreground);
    return {background,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),border:getComputedStyle(el).borderColor};
  });
  async function assertHover(selector,label,minContrast=4.5,minDistance=35){
    await page.mouse.move(0,0);const before=await style(selector);await page.locator(selector).hover();const after=await style(selector),distance=Math.hypot(...after.background.map((v,i)=>v-before.background[i]));
    check(distance>=minDistance&&after.contrast>=minContrast,label+' has a distinct hover color while remaining readable: '+JSON.stringify({distance,contrast:after.contrast}));
  }
  async function audit(selector,label){
    for(const width of [1440,1024]){
      await page.setViewportSize({width,height:width===1440?900:768});await page.locator(selector).evaluate(el=>el.scrollTop=0);
      const result=await page.locator(selector).evaluate(root=>{
        const shown=el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().height>0&&getComputedStyle(el).visibility!=='hidden',name=el=>el.id||el.textContent.trim().slice(0,45),buttons=[...root.querySelectorAll('button')].filter(shown),problems=[],box=root.getBoundingClientRect(),menu=root.getAttribute('role')==='menu';
        if(root.scrollWidth>root.clientWidth+1||box.width>innerWidth-16)problems.push('horizontal overflow');
        for(let i=0;i<buttons.length;i++)for(let j=i+1;j<buttons.length;j++){
          const a=buttons[i].getBoundingClientRect(),b=buttons[j].getBoundingClientRect(),x=Math.min(a.right,b.right)-Math.max(a.left,b.left),y=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
          const gap=y>2?Math.max(a.left,b.left)-Math.min(a.right,b.right):x>2?Math.max(a.top,b.top)-Math.min(a.bottom,b.bottom):Infinity;
          // Conventional menu rows are contiguous hit targets, unlike dialog
          // action buttons. They must still never overlap.
          if(gap<(menu?-.5:7.5))problems.push(`${name(buttons[i])} / ${name(buttons[j])}: ${gap.toFixed(1)}px`);
        }
        for(const button of buttons){const b=button.getBoundingClientRect();for(let frame=button.parentElement;frame&&root.contains(frame);frame=frame.parentElement){
          const f=frame.getBoundingClientRect(),s=getComputedStyle(frame),scrolls=frame.scrollHeight>frame.clientHeight+1;
          for(const [side,gap]of [['Left',b.left-f.left],['Right',f.right-b.right],['Top',b.top-f.top],['Bottom',f.bottom-b.bottom]]){
            if(parseFloat(s['border'+side+'Width'])<.5||s['border'+side+'Style']==='none'||s['border'+side+'Color']==='rgba(0, 0, 0, 0)')continue;
            if(scrolls&&['Top','Bottom'].includes(side))continue;
            if(gap>=-1&&gap<(menu?5:7.5))problems.push(`${name(button)} near ${name(frame)} ${side}: ${gap.toFixed(1)}px`);
          }
        }}
        return {buttons:buttons.length,controls:[...root.querySelectorAll('button,input,select,textarea')].filter(shown).length,problems};
      });
      check(result.controls>0&&!result.problems.length,`${width}px ${label}: ${result.controls} controls fit; ${result.buttons} buttons separated from each other and panel rules${result.problems.length?' — '+result.problems.join('; '):''}`);
      await page.screenshot({path:resolve(evidence,`spacing-${label.replaceAll(/[^a-z0-9]+/gi,'-')}-${width}.png`)});
    }
    await page.setViewportSize({width:1440,height:900});
  }
  async function workspaceAction(id){
    if(!await page.locator('#workspaceDialog[data-page=files]').isVisible()){if(await page.locator('#workspaceDialog').isVisible())await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');}
    await page.locator('#'+id).evaluate(el=>{for(let parent=el.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;});await page.locator('#'+id).click();
  }
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(()=>document.fonts.ready);
    await assertHover('#chooseFolderInSetup','primary folder action');
    await page.locator('#closeWorkspace').click();
    await menuCommand(page,'File','files');
    await page.locator('#manualHandoffPanel>summary').click();
    await assertHover('#openPackage','secondary package action');await assertHover('#closeWorkspace','dialog close icon',3);
    for(const [width,height]of [[1440,900],[1024,768]]){
      await page.setViewportSize({width,height});await page.mouse.move(0,0);
      const dimensions=await page.evaluate(()=>{
        const box=id=>document.getElementById(id).getBoundingClientRect(),panel=box('manualHandoffPanel'),summary=document.querySelector('#manualHandoffPanel>summary').getBoundingClientRect(),frame=document.querySelector('#manualHandoffPanel .handoff-actions').getBoundingClientRect(),buttons=[...document.querySelectorAll('#manualHandoffPanel button')].map(el=>el.getBoundingClientRect()),row=document.querySelector('.folder-tools-row').getBoundingClientRect(),folder=box('showFolderFiles'),browse=box('browseFolderFiles'),history=box('handoffHistoryPanel'),files=document.querySelector('#filesPanel>summary').getBoundingClientRect(),dialog=box('workspaceDialog');
        return {summaryGap:Math.min(...buttons.map(b=>b.top))-summary.bottom,frameGutter:Math.min(...buttons.flatMap(b=>[b.left-frame.left,frame.right-b.right,b.top-frame.top,frame.bottom-b.bottom])),separatorGap:panel.bottom-Math.max(...buttons.map(b=>b.bottom)),folderGutter:Math.min(folder.top-row.top,folder.left-row.left,row.bottom-folder.bottom,row.right-browse.right),folderBefore:folder.top-history.bottom,folderAfter:files.top-Math.max(folder.bottom,browse.bottom),folderBetween:browse.left-folder.right,sameRow:Math.abs(folder.top-browse.top)<1,dialogFits:dialog.width<=innerWidth-24&&document.querySelector('#workspaceDialog').scrollWidth<=document.querySelector('#workspaceDialog').clientWidth};
      });
      check(dimensions.summaryGap>=10&&dimensions.frameGutter>=10&&dimensions.separatorGap>=10,width+'px package actions clear the heading, frame, and divider');
      check(dimensions.folderGutter>=10&&dimensions.folderBefore>=10&&dimensions.folderAfter>=10,width+'px folder actions clear neighboring disclosure rules');
      check(dimensions.sameRow&&dimensions.folderBetween>=8&&dimensions.dialogFits,width+'px dialog keeps the folder actions compact without touching or horizontal overflow');
      await page.screenshot({path:resolve(evidence,'button-spacing-'+width+'.png')});
    }
    await page.setViewportSize({width:1440,height:900});await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','multipage.pdf'],['lyFile','score.ly']]){const data=new DataTransfer();data.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open')&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false');
    await assertHover('#navigate','selected Navigate');await assertHover('#newFinding','New finding');await assertHover('#sourceMaximize','unselected maximize icon',3);
    await page.locator('#sourceMaximize').click();await assertHover('#sourceMaximize','selected maximize icon',3);await page.locator('#sourceMaximize').click();
    await assertHover('button[data-kind="rendered"][data-action="next"]','page navigation icon',3);
    check(await page.locator('#statusButton').isHidden(),'healthy saved status has no Resolve button or dropdown');
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC source detail.');await page.locator('#comment').press('Enter');await page.locator('.finding-open').click();
    await assertHover('#deleteFinding','finding delete icon',3);
    await page.locator('#deleteFinding').click();await audit('#deleteDialog','delete confirmation');await page.locator('#cancelDelete').click();await page.locator('#saveFinding').click();
    await workspaceAction('importResponse');await audit('#handoffDialog','response import choices');await page.locator('#closeHandoff').click();
    await page.evaluate(async()=>{const a=await import('./app.js');window.spacingPrepare=a.completion.io.prepare;a.completion.io.prepare=async()=>{await new Promise(resolve=>window.releaseSpacingPrepare=resolve);throw Object.assign(new Error('Synthetic cancellation'),{cancelled:true});};});
    await workspaceAction('finishReview');await page.waitForFunction(()=>Boolean(window.releaseSpacingPrepare));await audit('#finishDialog','review preparation and cancel');await page.locator('#cancelFinish').click();
    await page.evaluate(async()=>{const a=await import('./app.js');a.completion.io.prepare=window.spacingPrepare;window.releaseSpacingPrepare();});await page.waitForFunction(()=>!document.querySelector('#closeFinish').disabled);await page.locator('#closeFinish').click();
    await page.locator('.finding-open').click();await page.locator('#comment').fill('SYNTHETIC spacing save recovery.');
    await page.evaluate(async()=>{const a=await import('./app.js');window.spacingPut=a.operations.putSaved;a.operations.putSaved=async()=>{throw new Error('SYNTHETIC save unavailable');};await a.saveNow();});
    // The warning button starts tinted; retain the same text-contrast threshold.
    await assertHover('#statusButton','Resolve recovery action',4.5,25);
    if(!await page.locator('#notices').evaluate(el=>el.matches(':popover-open')))await page.locator('#statusButton').click();await audit('#notices','save recovery');
    await page.evaluate(async()=>{const a=await import('./app.js');a.operations.putSaved=window.spacingPut;await a.saveNow();});await page.waitForFunction(()=>!document.querySelector('#notices').matches(':popover-open'));await page.locator('#saveFinding').click();
    await workspaceAction('exportTask');await page.locator('#saveTaskFolder').waitFor();await page.waitForFunction(()=>!document.querySelector('#closeHandoff').disabled);await audit('#handoffDialog','task export actions');await page.locator('#closeHandoff').click();
    const response=await page.evaluate(async()=>{const {retainedList}=await import('./handoff-store.js'),{json}=await import('./workflow.js'),{zipFiles}=await import('./export.js'),issued=(await retainedList()).find(e=>e.kind==='task'),result=JSON.parse(await issued.payloads.get('response-template.json').text());result.code={status:'unchanged',path:null};result.rendering={status:'pending',path:null,producer:'SYNTHETIC spacing test',compiler:null};result.files={};result.results.forEach(f=>{f.status='unchanged_with_reason';f.explanation='SYNTHETIC spacing test';});return [...new Uint8Array(await(await zipFiles(new Map([['response.json',json(result)]]))).arrayBuffer())];});
    await page.locator('#responseFile').setInputFiles({name:'SYNTHETIC-spacing-response.zip',mimeType:'application/zip',buffer:Buffer.from(response)});await page.locator('#acceptResponse').waitFor();await audit('#handoffDialog','response preview and acceptance');
    await page.locator('#acceptResponse').click();await page.locator('#reviewReturned').waitFor();await audit('#handoffDialog','retained response actions');await page.locator('#reviewReturned').click();await page.waitForFunction(()=>document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');
    await page.locator('#appMenuView').click();await audit('#menuView','application View menu');await page.keyboard.press('Escape');await audit('.correction-note-actions','selected finding note actions');
    for(const id of ['correctionAI','sourceViewOptions']){await page.locator('#'+id+'>summary').click();await audit('#'+id+'>.review-popover',id);await page.locator('#'+id+'>summary').click();}
    await page.locator('#openRoundSummary').click();await audit('#roundSummary','round summary actions');await page.locator('#dismissRoundSummary').click();
    await page.locator('#correctionFinding').click();await audit('#correctionProblems','problem browser');await page.locator('#correctionProblems .dialog-head button').click();
    await page.evaluate(async()=>{const a=await import('./app.js'),folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC spacing folder',{create:true}),{fixtureBlob}=await import('./qa/fixtures.js');window.spacingApp=a;for(const [name,fixture]of [['source.pdf','source.pdf'],['rendered.pdf','rendered.pdf'],['score.ly','score.ly']]){const stream=await(await folder.getFileHandle(name,{create:true})).createWritable();await stream.write(await fixtureBlob(fixture));await stream.close();}a.folderWorkspace.io.pickDirectory=async()=>folder;});
    await page.locator('#chooseFolder').click();await page.locator('#folderSetupDialog').waitFor();check(await page.locator('#folderPromptButton').isDisabled(),'Send to AI stays disabled while a different working folder is being connected');await audit('#folderSetupDialog','folder setup confirmation');for(const [id,value]of [['folderSourceSelect','source.pdf'],['folderRenderedSelect','rendered.pdf'],['folderLySelect','score.ly']])await page.locator('#'+id).selectOption(value);await page.locator('#folderSetupConfirm').click();
    // waitForFunction predicates must be synchronous: an imported module's
    // Promise is truthy even while folder selection is still in progress.
    await page.waitForFunction(()=>{const a=window.spacingApp,s=a.folderWorkspace.getState();return s.bound&&s.ready&&!s.busy&&!a.sessionStatus().busy;});
    check(await page.locator('#folderPromptButton').getAttribute('aria-controls')==='folderPromptDialog','connected working folder routes Send to AI to its current folder prompt');
    await page.locator('#folderPromptButton').click();await audit('#folderPromptDialog','AI prompt and secondary actions');await page.locator('#closeFolderPrompt').click();await menuCommand(page,'File','files');await page.locator('#browseFolderFiles').click();await page.locator('.folder-file-open').first().waitFor();await audit('#folderFilesDialog','folder file actions');await page.locator('.folder-file-row[data-file-path="source.pdf"] .folder-file-open').click();await page.waitForFunction(()=>document.querySelector('#folderPdfCanvas').dataset.renderedPage==='1');await audit('#folderFilesDialog','PDF file preview controls');await page.locator('#closeFolderFiles').click();await page.locator('#closeWorkspace').click();
    await menuCommand(page,'File','files');await page.locator('#workspaceDialog details').evaluateAll(items=>items.forEach(el=>el.open=true));await audit('#workspaceDialog','all workspace disclosures');await page.locator('#closeWorkspace').click();
    check(errors.length===0,'spacing and hover changes produce no uncaught browser errors: '+errors.join('; '));
    return {name:'button-spacing',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'button-spacing-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'button-spacing.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
