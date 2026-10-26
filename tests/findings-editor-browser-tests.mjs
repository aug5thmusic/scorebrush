// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runFindingsEditor({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('findings-editor: '+label);};
  const until=async predicate=>{const end=Date.now()+45000;while(!await page.evaluate(predicate)){if(Date.now()>end)throw Error('Finding state did not settle');await new Promise(r=>setTimeout(r,30));}};
  const ready=()=>until(async()=>{const a=await import('./app.js');return document.body.dataset.ready==='true'&&Boolean(a.sessionStatus().snapshotId)&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&!a.corrections.state().pending;});
  const scene=()=>page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),saved=await(await import('./storage.js')).getSaved(s.workspaceId);return {review:s.review,returned:s.returned,revisionId:s.revisionId,status:a.sessionStatus(),selected:a.corrections.state().findingId,saved,writes:window.noteWrites,focus:document.activeElement.id};});
  const instrument=()=>page.evaluate(async()=>{const a=await import('./app.js');window.noteWrites=0;window.notePut=a.operations.putSaved;a.operations.putSaved=(...args)=>{window.noteWrites++;return window.notePut(...args);};});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();
    await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name] of [['sourceFile','source.pdf'],['renderedFile','rendered.pdf'],['lyFile','score.ly']]){const transfer=new DataTransfer();transfer.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await ready();await instrument();
    for(const action of ['Enter','button']){
      await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC ordinary '+action);
      if(action==='Enter')await page.locator('#comment').press('Enter');else await page.locator('#saveFinding').click();await ready();
      const s=await scene();check(s.status.active===null&&s.saved.review.findings.at(-1).comment==='SYNTHETIC ordinary '+action,action+' durably finishes an ordinary note');
    }
    const drawnNote=(await scene()).review.findings.at(-1);
    for(const action of ['Enter','button']){
      await page.locator(`[data-finding-id="${drawnNote.id}"] .finding-open`).click();await page.locator('#draw').click();
      const scroll=await page.locator('#renderedScroll').boundingBox();await page.mouse.move(scroll.x+70,scroll.y+70);await page.mouse.down();await page.mouse.move(scroll.x+130,scroll.y+78,{steps:5});await page.mouse.up();await ready();
      const edited=await scene();check(edited.focus==='overlay'&&edited.status.active===drawnNote.id,'adding a stroke to an old note returns keyboard focus to the score');
      if(action==='Enter'){
        await page.locator('#overlay').dispatchEvent('keydown',{key:'Enter',isComposing:true});check((await scene()).status.active===drawnNote.id,'IME Enter on the score does not finish the edited finding');
        await page.keyboard.press('Enter');
      }else await page.locator('#saveFinding').click();await ready();
      const saved=await scene();check(saved.status.active===null&&saved.saved.review.findings.find(f=>f.id===drawnNote.id).strokes.length===edited.review.findings.find(f=>f.id===drawnNote.id).strokes.length&&saved.review.findings.length===2,action+' finishes an existing note after drawing, preserving its strokes and identity');
    }
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC held modifier first');
    await page.keyboard.down('Control');await page.keyboard.down('Enter');await ready();
    await page.locator('#comment').fill('SYNTHETIC next editor must stay open');await page.keyboard.down('Enter');await ready();
    const held=await scene();log.push('REPRO held Ctrl+Enter '+JSON.stringify({active:held.status.active,prepared:held.status.prepared,text:await page.locator('#comment').inputValue()}));
    if(!process.env.SCORE_DESK_FINDINGS_REPRO_ONLY)check(Boolean(held.status.active)&&await page.locator('#comment').inputValue()==='SYNTHETIC next editor must stay open','held Ctrl+Enter cannot finish a second editor');
    await page.keyboard.up('Enter');await page.keyboard.up('Control');
    if(held.status.active)await page.locator('#saveFinding').click();else await page.locator('#comment').press('Escape');await ready();
    const numbers=()=>page.locator('#findings .finding-number').allTextContents().then(values=>values.map(value=>Number(value.slice(1))));
    check(await page.locator('#findingOrder').inputValue()==='newest','Findings defaults to Newest first');
    for(const key of ['Enter','Shift+Enter','Control+Enter','Meta+Enter','button']){
      await page.locator('#newFinding').click();const text='SYNTHETIC '+key+'\nPasted second line\nThird line';
      const before=await scene();await page.locator('#comment').fill(text);
      if(key==='button')await page.locator('#saveFinding').click();else await page.locator('#comment').press(key);await ready();
      let saved=await scene();const note=saved.review.findings.at(-1);
      check(saved.saved.review.findings.find(f=>f.id===note.id).comment===text&&saved.status.active===null&&saved.writes===before.writes+1,key+' saves a new multiline note exactly once');
      check(saved.status.prepared===['Control+Enter','Meta+Enter'].includes(key),key+' preserves Done versus Done & next');
      await page.locator(`[data-finding-id="${note.id}"] .finding-open`).click();await page.locator('#comment').fill(text+'\nEdited');
      if(key==='button')await page.locator('#saveFinding').click();else await page.locator('#comment').press(key);await ready();saved=await scene();
      check(saved.saved.review.findings.find(f=>f.id===note.id).comment===text+'\nEdited'&&saved.review.findings.at(-1).id===note.id,key+' saves an existing note without allocating another identity');
    }
    await page.locator('#newFinding').click();const empty=await scene();await page.locator('#comment').fill('  \n ');await page.locator('#comment').press('Enter');
    check((await scene()).review.nextNumber===empty.review.nextNumber&&await page.locator('#editor').isVisible(),'empty Enter keeps preparation without allocating a number');
    await page.locator('#comment').press('Escape');check(!(await scene()).status.prepared&&(await scene()).writes===empty.writes,'cancelling empty preparation makes no substantive save');
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC IME draft');await ready();const ime=await scene();
    await page.locator('#comment').dispatchEvent('compositionstart');await page.locator('#comment').press('Enter');await page.locator('#comment').dispatchEvent('compositionend');
    await page.locator('#comment').dispatchEvent('keydown',{key:'Enter',isComposing:true});await page.locator('#comment').dispatchEvent('keydown',{key:'Enter',keyCode:229});
    check((await scene()).status.active===ime.status.active&&await page.locator('#editor').isVisible(),'IME Enter and keyCode 229 do not finish the editor');
    // Alt+Enter retains normal text input behavior; only the documented save keys are handled.
    await page.locator('#comment').press('Alt+Enter');check((await scene()).status.active===ime.status.active,'Alt+Enter never dispatches a save command');
    await page.locator('#comment').fill('SYNTHETIC ordinary held Enter');await page.keyboard.down('Enter');await ready();
    await page.locator('#newFinding').focus();await page.keyboard.down('Enter');await page.keyboard.up('Enter');
    check(!(await scene()).status.prepared,'held Enter and its keyup cannot activate the next focused button');
    while((await scene()).review.nextNumber<=12){const number=(await scene()).review.nextNumber;await page.locator('#newFinding').click();await page.locator('#findingType').selectOption(number===11?'comment':number===12?'source_footnote':'correction');await page.locator('#comment').fill('SYNTHETIC number '+number+'\nA second line for scroll context.');await page.locator('#comment').press('Enter');await ready();}
    check((await numbers()).slice(0,2).join(',')==='12,11','numeric Newest first places #12 before #11, including comments and footnotes');
    await page.evaluate(()=>{window.noteChanges=0;document.addEventListener('score-desk-change',()=>window.noteChanges++);});
    const orderBefore=await scene();await page.locator('#findingOrder').selectOption('oldest');
    let orderAfter=await scene();check(JSON.stringify(await numbers())===JSON.stringify([...await numbers()].sort((a,b)=>a-b)),'Oldest first updates presentation immediately');
    check(JSON.stringify([orderAfter.review,orderAfter.returned,orderAfter.revisionId,orderAfter.saved.storageRevision,orderAfter.writes])===JSON.stringify([orderBefore.review,orderBefore.returned,orderBefore.revisionId,orderBefore.saved.storageRevision,orderBefore.writes])&&await page.evaluate(()=>window.noteChanges===0),'sorting changes only an interface preference, with no project save or history event');
    await page.setViewportSize({width:1440,height:650});
    await page.locator('#findings').evaluate(el=>{const row=el.querySelectorAll('.finding')[5];el.scrollTop+=row.getBoundingClientRect().top-el.getBoundingClientRect().top-8;});
    const scrollAnchor=()=>page.locator('#findings').evaluate(el=>{const top=el.getBoundingClientRect().top,row=[...el.querySelectorAll('.finding')].find(row=>row.getBoundingClientRect().bottom>top);return {key:row.dataset.rowKey,offset:row.getBoundingClientRect().top-top};});
    const anchor=await scrollAnchor();await page.locator('#findingOrder').selectOption('newest');const afterAnchor=await scrollAnchor();
    log.push('SCROLL '+JSON.stringify({anchor,afterAnchor,metrics:await page.locator('#findings').evaluate(el=>({height:el.clientHeight,scroll:el.scrollTop,max:el.scrollHeight-el.clientHeight}))}));
    const limits=await page.locator('#findings').evaluate(el=>({scroll:el.scrollTop,max:el.scrollHeight-el.clientHeight}));
    check(anchor.key===afterAnchor.key&&Math.abs(limits.scroll-Math.max(0,Math.min(limits.max,limits.scroll+afterAnchor.offset-anchor.offset)))<2,'sorting retains the visible row and clamps its scroll offset only at list boundaries');
    const editable=(await scene()).review.findings.find(f=>f.number===8);await page.locator(`[data-finding-id="${editable.id}"] .finding-open`).click();
    await page.evaluate(async()=>{const a=await import('./app.js');window.beforeGate=a.operations.putSaved;a.operations.putSaved=async(...args)=>{await new Promise(r=>window.releaseNote=r);return window.beforeGate(...args);};});
    await page.locator('#comment').fill('SYNTHETIC unsaved\n'+Array(16).fill('Keep each pasted line').join('\n'));
    await page.locator('#comment').evaluate(el=>{el.setSelectionRange(4,13,'backward');el.scrollTop=40;});
    await page.locator('#findingTypeFilter').selectOption('comment');
    const draft=await scene(),selection=await page.locator('#comment').evaluate(el=>[el.value,el.selectionStart,el.selectionEnd,el.selectionDirection,el.scrollTop]);
    await page.locator('#findingOrder').selectOption('oldest');
    check(JSON.stringify(selection)===JSON.stringify(await page.locator('#comment').evaluate(el=>[el.value,el.selectionStart,el.selectionEnd,el.selectionDirection,el.scrollTop]))&&(await scene()).status.active===draft.status.active&&(await scene()).revisionId===draft.revisionId&&await page.locator('#findingTypeFilter').inputValue()==='comment','sorting preserves unsaved multiline text, caret, editor scroll, selection and filter');
    await until(()=>Boolean(window.releaseNote));await page.evaluate(()=>window.releaseNote());await ready();await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.beforeGate;});await page.locator('#saveFinding').click();
    await page.locator('#findingTypeFilter').selectOption('all');await ready();await page.reload();await ready();await instrument();
    check(await page.locator('#findingOrder').inputValue()==='oldest'&&(await numbers())[0]===1,'sort preference survives restart independently of the saved project');
    await page.setViewportSize({width:390,height:844});if(!await page.locator('#findingOrder').isVisible())await page.locator('#toggleComments').click();
    check(await page.locator('#findingFilters').evaluate(el=>el.scrollWidth<=el.clientWidth&&[...el.querySelectorAll('select,label')].every(child=>{const r=child.getBoundingClientRect(),b=el.getBoundingClientRect();return r.left>=b.left&&r.right<=b.right+1;})),'filters and accessible order selector fit the narrow Findings drawer');
    await page.screenshot({path:resolve(evidence,'findings-order-narrow.png')});await page.setViewportSize({width:1440,height:900});
    await page.screenshot({path:resolve(evidence,'findings-order-oldest.png')});await page.locator('#findingOrder').selectOption('newest');await page.locator('#findings').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:resolve(evidence,'findings-order-wide.png')});
    await page.evaluate(async()=>{window.noteFixture=await(await import('./qa/comparison-fixture.js')).comparisonFixture({types:{2:'source_footnote',3:'comment'}});});await ready();
    const settledViews=async()=>{await ready();await page.waitForFunction(()=>['source','rendered'].every(kind=>document.getElementById(kind+'Paper').getAttribute('aria-busy')==='false'&&!['true','gesture'].includes(document.getElementById(kind+'Paper').dataset.resizePending)));await page.waitForTimeout(300);};
    const scorePositions=()=>page.evaluate(()=>Object.fromEntries(['source','rendered'].map(kind=>{const scroll=document.getElementById(kind+'Scroll');return [kind,{page:document.getElementById(kind+'Page').value,zoom:document.getElementById(kind+'Zoom').value,left:scroll.scrollLeft,top:scroll.scrollTop,width:scroll.clientWidth,height:scroll.clientHeight}];})));
    const samePassage=(left,right)=>['source','rendered'].every(kind=>left[kind].page===right[kind].page&&left[kind].zoom===right[kind].zoom&&Math.abs(left[kind].left-right[kind].left)<=2&&Math.abs(left[kind].top-right[kind].top)<=2);
    for(const layout of [{width:1920,height:650,zoom:'fit'},{width:1440,height:900,zoom:'2'},{width:850,height:650,zoom:'2'}]){
      await page.setViewportSize(layout);await settledViews();if(await page.locator('#closeComments').isVisible()&&layout.width<900)await page.locator('#closeComments').click();
      for(const kind of ['source','rendered'])await page.locator('#'+kind+'Zoom').selectOption(layout.zoom);await settledViews();
      await page.evaluate(top=>{for(const kind of ['source','rendered'])document.getElementById(kind+'Scroll').scrollTo(200,top);},layout.zoom==='fit'?10000:320);await page.waitForTimeout(200);
      const beforeNew=await scorePositions(),beforeState=await scene();await page.locator('#reportAnotherError').click();await settledViews();const afterNew=await scorePositions();
      await page.locator('#comment').press('Escape');await settledViews();const afterCancel=await scorePositions(),cancelState=await scene();
      log.push('POSITION '+JSON.stringify({layout,beforeNew,afterNew,afterCancel}));
      check(samePassage(beforeNew,afterNew),'Review Changes keeps both PDF scroll positions when starting a new finding at '+layout.width+'px / '+layout.zoom);
      check(samePassage(afterNew,afterCancel),'Review Changes keeps both PDF scroll positions when cancelling with Escape at '+layout.width+'px / '+layout.zoom);
      check(beforeState.revisionId===cancelState.revisionId&&JSON.stringify(beforeState.returned)===JSON.stringify(cancelState.returned)&&JSON.stringify(beforeState.review)===JSON.stringify(cancelState.review),'starting/cancelling preserves review data and decisions at '+layout.width+'px');
    }
    await page.setViewportSize({width:1440,height:900});await settledViews();if(!await page.locator('#findingOrder').isVisible())await page.locator('#reopenFindings').click();await settledViews();
    const queueBefore=await scene();await page.locator('#findingOrder').selectOption('newest');const queueAfter=await scene();
    check((await numbers()).join(',')==='4,3,2,1'&&JSON.stringify(queueBefore.returned)===JSON.stringify(queueAfter.returned)&&queueBefore.selected===queueAfter.selected&&queueBefore.revisionId===queueAfter.revisionId,'returned comments join numerical order without changing the review queue, selection or decisions');
    await page.evaluate(async()=>(await import('./app.js')).corrections.selectFinding('comparison-2'));await ready();await page.locator('#locateRegion').click();
    await page.locator('#comment').fill('SYNTHETIC associated Enter');await page.locator('#comment').press('Enter');await ready();
    let s=await scene(),association=s.returned.reported.find(f=>f.id==='comparison-2').associationId;
    check(s.status.active===null&&s.saved.review.findings.find(f=>f.id===association).comment==='SYNTHETIC associated Enter','Enter durably finishes an associated Review Changes note');
    await page.locator('#showRegion').click();await page.locator('#comment').fill('SYNTHETIC associated button');await page.locator('#saveFinding').click();await ready();s=await scene();
    check(s.returned.reported.find(f=>f.id==='comparison-2').associationId===association&&s.saved.review.findings.find(f=>f.id===association).comment==='SYNTHETIC associated button','Save note preserves the same associated annotation');
    check(await page.locator(`[data-reported-id="comparison-2"][data-finding-id="${association}"]`).count()===1&&await page.locator('#findings .finding').count()===4,'associated current footnote and its report remain one sorted row');
    for(const key of ['Shift+Enter','Control+Enter','Meta+Enter']){
      await page.locator('#showRegion').click();const text='SYNTHETIC associated '+key+'\nPasted line';await page.locator('#comment').fill(text);await page.locator('#comment').press(key);await ready();const result=await scene();
      check(result.saved.review.findings.find(f=>f.id===association).comment===text&&result.returned.reported.find(f=>f.id==='comparison-2').associationId===association&&!result.returned.reported.some(f=>f.decision),key+' preserves multiline associated text without review approval');
      if(result.status.prepared)await page.locator('#comment').press('Escape');
    }
    await page.locator('#showRegion').click();await page.locator('#comment').fill('SYNTHETIC keep on failure');
    await page.evaluate(async()=>{const a=await import('./app.js');a.operations.putSaved=async()=>{throw Error('SYNTHETIC note save failure');};document.getElementById('comment').setSelectionRange(4,9);});
    await page.locator('#comment').press('Enter');await until(async()=>!(await import('./app.js')).sessionStatus().busy);s=await scene();
    log.push('REPRO save failure '+JSON.stringify({active:s.status.active,focus:s.focus,text:await page.locator('#comment').inputValue(),selection:await page.locator('#comment').evaluate(el=>[el.selectionStart,el.selectionEnd])}));
    check(s.status.active===association&&s.focus==='comment'&&JSON.stringify(await page.locator('#comment').evaluate(el=>[el.selectionStart,el.selectionEnd]))==='[4,9]'&&await page.locator('#comment').inputValue()==='SYNTHETIC keep on failure','failed local save retains associated text and selection identity');
    await page.screenshot({path:resolve(evidence,'findings-editor-save-failure.png')});
    await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.notePut;});await page.locator('#saveFinding').click();await ready();
    await page.setViewportSize({width:1920,height:800});for(const kind of ['source','rendered'])await page.locator('#'+kind+'Zoom').selectOption('fit');await settledViews();
    await page.evaluate(()=>{for(const kind of ['source','rendered'])document.getElementById(kind+'Scroll').scrollTo(0,150);});await page.waitForTimeout(200);
    const beforeTyped=await scorePositions();await page.locator('#reportAnotherError').click();await page.locator('#comment').fill('SYNTHETIC new finding keeps the visible passage');await settledViews();const afterTyped=await scorePositions();
    await page.locator('#saveFinding').click();await settledViews();const afterSaved=await scorePositions();log.push('TYPED POSITION '+JSON.stringify({beforeTyped,afterTyped,afterSaved}));
    check(samePassage(beforeTyped,afterTyped),'typing a new Review Changes finding retains both PDF positions even when a whole page would otherwise fit');
    check(samePassage(afterTyped,afterSaved),'Save note retains both PDF positions when leaving the Review Changes note editor');
    return {name:'findings-editor',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'findings-editor-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'findings-editor.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
