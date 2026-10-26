// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runComparison({browser,serve,evidence,root}){
  const server=await serve(root),contexts=[],log=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('comparison: '+label);};
  const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',e=>log.push('BROWSER ERROR '+e.message));
  const ready=p=>p.waitForFunction(()=>document.body.dataset.ready==='true'&&!document.querySelector('#correctionComparison').hidden&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');
  const state=p=>p.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture();return {review:s.review,returned:s.returned,selected:a.corrections.state(),position:document.querySelector('#renderedPage').value};});
  const menu=async(p,id,open=true)=>{if(await p.locator('#'+id).evaluate(el=>el.open)!==open)await p.locator('#'+id+'>summary').click();};
  const go=async(p,i)=>{if(!await p.locator('#correctionProblems').isVisible())await p.locator('#correctionFinding').click();await p.locator('#correctionProblemSearch').fill('');await p.locator('#correctionUncheckedOnly').uncheck();await p.locator(`[data-problem-index="${i}"]`).click();await ready(p);};
  const respond=async p=>{if(!await p.locator('#correctionResponse').isVisible())await p.locator('#stillCorrection').click();};
  try{
    await page.goto(server.url+'');await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.locator('#closeWorkspace').click();
    const fixture=await page.evaluate(async()=> (await import('./qa/comparison-fixture.js')).comparisonFixture());await ready(page);
    check(await page.locator('#sourceViewer').getAttribute('data-render-sha256')===fixture.baseline,'Before remains the exact issued baseline despite a parallel candidate');
    check((await state(page)).review.files.rendered.sha256===fixture.after&&(await state(page)).review.pages.length===1,'changed page counts retain exact candidate identity');
    check(await page.locator('#historicalOverlay').getAttribute('data-finding-ids')==='comparison-1'&&(await state(page)).review.findings.length===0,'historical marks stay read-only and on the matching PDF');
    check(await page.locator('#sourcePage').isVisible()&&await page.locator('#renderedPage').isVisible()&&await page.locator('#sourceZoom').isVisible()&&await page.locator('#renderedZoom').isVisible(),'both scores expose page numbers, arrows and zoom without opening a menu');
    await page.locator('#sourcePageNavigation [data-action=next]').click();await ready(page);
    check(await page.locator('#sourcePage').inputValue()==='2'&&await page.locator('#renderedPage').inputValue()==='1','the persistent next-page control advances only its own score');
    await page.locator('#sourcePageNavigation [data-action=prev]').click();await ready(page);
    check(await page.locator('#previousFinding,#nextFinding').count()===0&&await page.locator('#correctionHeader .problem-picker').isVisible(),'the header problem browser replaces redundant Previous and Next controls');
    check(await page.locator('#correctionOriginal').innerText()===(await state(page)).returned.reported[0].comment&&await page.locator('.correction-actions button:visible').allTextContents().then(a=>a.map(t=>t.replace(/\s*[CWS]$/,'').trim()).join('|')==='Looks correct|Still wrong…|Next|Summary'),'the complete report offers approval, focused response and Next without hidden navigation');
    check(await page.locator('#correctionOriginal').evaluate(el=>getComputedStyle(el).fontSize==='16px'&&getComputedStyle(el).textOverflow!=='ellipsis')&&await page.locator('#correctionAI').evaluate(el=>!el.open),'readable problem text is not truncated and AI claims start behind a named disclosure');
    await menu(page,'sourceViewOptions');await page.locator('#otherHistoricalMarks').check();await page.locator('#otherHistoricalMarks').uncheck();await menu(page,'sourceViewOptions',false);
    await page.locator('#renderedZoom').selectOption('2');await page.waitForFunction(()=>document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false');
    await page.locator('#renderedScroll').evaluate(el=>el.scrollTo(180,240));
    check(await page.locator('#correctionAlignment,#locateCorrectedPassage,#correctionLocationStatus').count()===0,'viewing requires no location warning or bookmark button');
    await page.waitForTimeout(250);
    let s=await state(page),location=await page.evaluate(async()=>{const a=await import('./app.js'),v=await import('./revision-views.js'),s=a.completion.capture();return {position:v.readRevisionView(s,'comparison-1'),candidate:{renderSha256:s.review.files.rendered.sha256}};});
    check(location.position.zoom===2&&location.candidate.renderSha256===fixture.after&&s.review.pages[0].rotation===90&&s.review.pages[0].view[0]===12&&s.review.findings.length===0&&!s.returned.reported[0].decision,'remembered view binds cropped/rotated geometry without creating a finding or decision');
    await page.locator('#sourcePage').fill('4');await page.locator('#sourcePage').dispatchEvent('change');await ready(page);
    await page.locator('#checkPrintedSource').click();await ready(page);
    check(await page.locator('#sourcePage').inputValue()==='1'&&await page.locator('#sourcePage').getAttribute('max')==='1'&&await page.locator('#sourceCount').innerText()==='/ 1','page 4 clamps to the source’s last real page and indicator');
    check(await page.locator('#sourceLabel').innerText()==='Printed source'&&await page.locator('#historicalOverlay').isHidden()&&(await state(page)).review.files.source.sha256===fixture.source,'Check printed source displays the source without changing package identities');
    await page.locator('#checkPrintedSource').click();await ready(page);
    check(await page.locator('#sourcePage').inputValue()==='4'&&(await state(page)).review.files.rendered.sha256===fixture.after,'returning from the source restores the Before view and exact AI revision');
    await respond(page);check(await page.locator('#roundExplanation').evaluate(el=>document.activeElement===el)&&await page.locator('#correctionNotice').getAttribute('data-error')!=='true','Still wrong opens its focused editor directly without an error prompt');
    await page.locator('#roundExplanation').fill('Keep this remaining-error draft');await page.locator('#needsClarification').check();await page.waitForFunction(()=>document.querySelector('#correctionDraftStatus').textContent==='Draft saved locally');
    await page.locator('#cancelCorrectionResponse').click();
    check(!await page.locator('#correctionResponse').isVisible()&&!(await state(page)).returned.reported[0].decision,'Cancel closes the editor without deciding or losing the draft');
    await go(page,1);await respond(page);await page.locator('#roundExplanation').fill('Independent text-only draft');await page.locator('#cancelCorrectionResponse').click();
    check(await page.locator('#correctionAlignment').count()===0&&await page.locator('#sourcePage').inputValue()==='2','text-only reports keep page context without an unsolicited status');
    await page.locator('#skipCorrection').click();await ready(page);check(!(await state(page)).returned.reported[1].decision,'Next leaves a text-only problem unchecked');
    await go(page,0);await respond(page);
    check(await page.locator('#roundExplanation').inputValue()==='Keep this remaining-error draft'&&await page.locator('#needsClarification').isChecked(),'finding navigation restores both the explanation and source-clarification draft');
    await page.locator('#appMenuFile').click();await page.keyboard.press('Escape');
    check(await page.locator('#correctionResponse').isVisible()&&await page.locator('#menuFile').isHidden(),'Escape first closes the open named menu and keeps the response editor');
    await page.locator('#roundExplanation').press('Escape');check(!await page.locator('#correctionResponse').isVisible()&&await page.locator('#stillCorrection').evaluate(el=>document.activeElement===el),'Escape closes the response editor and restores logical focus');
    await page.reload();await ready(page);await respond(page);
    check(await page.locator('#renderedZoom').inputValue()==='2'&&await page.locator('#roundExplanation').inputValue()==='Keep this remaining-error draft'&&await page.locator('#needsClarification').isChecked(),'reload preserves remembered passage, explanation and clarification choice');
    await page.locator('#cancelCorrectionResponse').click();
    const stale=await context.newPage();await stale.goto(page.url());await ready(stale);const staleReject=await context.newPage();await staleReject.goto(page.url());await ready(staleReject);await staleReject.locator('#stillCorrection').click();
    await page.screenshot({path:resolve(evidence,'review-status-normal.png')});
    await page.evaluate(async()=>{const a=await import('./app.js');await a.saveNow();window.originalPut=a.operations.putSaved;a.operations.putSaved=async()=>{throw new Error('SIMULATED failed decision save');};});
    const stable=await page.locator('#looksCorrect').boundingBox();await page.locator('#looksCorrect').click();await page.waitForFunction(()=>document.querySelector('#correctionNotice').textContent.includes('SIMULATED failed'));
    check((await state(page)).selected.findingId==='comparison-1'&&!(await state(page)).returned.reported[0].decision&&(await page.locator('#looksCorrect').boundingBox()).y===stable.y,'failed approval preserves selection and draft, and its notification never moves actions');
    await page.screenshot({path:resolve(evidence,'review-status-warning.png')});
    if(await page.locator('#notices').isVisible())await page.locator('#dismissMessage').click();
    await page.locator('#checkPrintedSource').click();await ready(page);await page.locator('#checkPrintedSource').click();await ready(page);
    check(await page.locator('#statusControl').getAttribute('data-state')==='attention'&&(await page.locator('#message').textContent()).includes('SIMULATED failed decision save'),'successful score navigation preserves the unresolved decision-save warning');
    await page.evaluate(async()=>{const a=await import('./app.js');a.operations.putSaved=async(...args)=>{await new Promise(r=>window.releaseDecision=r);return window.originalPut(...args);};});
    await page.locator('#looksCorrect').focus();await page.locator('#looksCorrect').press('Enter');await page.waitForFunction(()=>Boolean(window.releaseDecision));
    check((await state(page)).selected.findingId==='comparison-1'&&await page.locator('#correctionFinding').isDisabled(),'approval waits for persistence before moving on');
    await page.evaluate(()=>window.releaseDecision());await page.waitForFunction(()=>document.querySelector('#correctionFinding').value==='1'&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false');
    check((await state(page)).returned.reported[0].decision.state==='resolved'&&await page.locator('#looksCorrect').evaluate(el=>document.activeElement===el),'confirmed keyboard approval advances exactly once and preserves focus');
    check(!(await page.locator('#message').textContent()).includes('SIMULATED failed decision save')&&await page.locator('#statusControl').getAttribute('data-state')!=='attention','retrying the same decision successfully clears its warning');
    await stale.locator('#looksCorrect').click();await stale.waitForFunction(()=>document.querySelector('#correctionNotice').textContent.includes('Another tab'));check((await state(stale)).selected.findingId==='comparison-1','stale tabs cannot overwrite or advance a concurrent decision');await stale.close();
    await staleReject.locator('#roundExplanation').fill('SYNTHETIC stale rejection must stay editable');await staleReject.waitForFunction(()=>document.querySelector('#correctionDraftStatus').textContent==='Draft not saved');await staleReject.locator('#sendCorrectionResponse').click();await ready(staleReject);check((await state(staleReject)).selected.findingId==='comparison-1'&&!(await state(staleReject)).returned.reported[0].decision&&await staleReject.locator('#roundExplanation').evaluate(el=>el===document.activeElement&&el.value==='SYNTHETIC stale rejection must stay editable')&&await staleReject.locator('#roundSummary').isHidden(),'stale rejection preserves its current finding, text and focus without navigation or summary');await staleReject.close();
    await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.originalPut;});
    await respond(page);await page.locator('#roundExplanation').fill('The printed source is illegible at this text-only problem.');await page.locator('#needsClarification').check();await page.locator('#sendCorrectionResponse').click();await ready(page);
    check((await state(page)).returned.reported[1].decision.state==='needs_source_clarification'&&!await page.locator('#correctionResponse').isVisible(),'the source-unclear option sends the existing clarification state with an explanation');
    await go(page,2);await respond(page);await page.locator('#roundExplanation').fill('The requested correction is still missing.');await page.locator('#needsClarification').uncheck();
    await page.evaluate(async()=>{const a=await import('./app.js');await a.saveNow();a.operations.putSaved=async()=>{throw new Error('SIMULATED response-save failure');};});await page.locator('#sendCorrectionResponse').click();await page.waitForFunction(()=>document.querySelector('#correctionNotice').textContent.includes('response-save failure'));
    check(await page.locator('#correctionResponse').isVisible()&&await page.locator('#roundExplanation').inputValue()==='The requested correction is still missing.'&&!(await state(page)).returned.reported[2].decision,'failed remaining-error submission keeps its editor and exact unsent text');
    await page.evaluate(async()=>{(await import('./app.js')).operations.putSaved=window.originalPut;});await page.locator('#sendCorrectionResponse').click();await ready(page);
    check((await state(page)).returned.reported[2].decision.state==='open','Still wrong sends a remaining-correction decision without marking it resolved');
    await page.locator('#reportAnotherError').click();await page.locator('#comment').fill('SIMULATED separate new error on the AI revision');
    check(await page.locator('.toolbar').isVisible()&&(await state(page)).review.findings.length===1,'Report another error reveals annotation tools and starts a new AI-revision finding');
    await go(page,1);check(await page.locator('#comment').inputValue()==='SIMULATED separate new error on the AI revision','changing problems keeps the new-error draft');
    await page.locator('#comment').pressSequentially('ndv');check((await state(page)).review.findings.length===1,'typing shortcut letters does not trigger commands');await page.locator('#saveFinding').click();
    // A legacy explicit bookmark remains part of the portable review. Automatic
    // positions are preferences and must not rewrite this historical value.
    await page.evaluate(async position=>{const a=await import('./app.js'),s=a.completion.capture(),location=(await import('./comparison-model.js')).bookmark('comparison-1',s.review,position),storage=await import('./storage.js');await a.saveNow();const record=await storage.getSaved(s.workspaceId);record.returned.locations={'comparison-1':location};await storage.putSaved(record,record.storageRevision);},location.position);
    await page.reload();await ready(page);
    await menuCommand(page,'File','backup');
    const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#finishDownloads a.download').click()]);const zip=await readFile(await download.path());await page.locator('#finishDialog').press('Escape');
    const fresh=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(fresh);const imported=await fresh.newPage();await imported.goto(page.url());await imported.waitForFunction(()=>document.body.dataset.ready==='true');await imported.locator('#packageFile').setInputFiles({name:'SIMULATED-review.zip',mimeType:'application/zip',buffer:Buffer.from(zip)});await ready(imported);
    s=await state(imported);check(s.returned.locations['comparison-1'].position.zoom===2&&s.review.files.source.sha256===fixture.source&&s.review.findings.length===1&&s.returned.reported[1].decision.state==='needs_source_clarification','fresh-browser package import retains locations, file identities, decisions and separate findings');
    await page.evaluate(async id=>{const a=await import('./app.js'),e=await (await import('./handoff-store.js')).retained(id);await a.handoff.returnedUI.open(e);},fixture.secondId);await ready(page);s=await state(page);check(!s.returned.locations&&s.returned.reported.every(f=>!f.decision),'a new candidate never inherits locations or approvals');
    await page.evaluate(async id=>{const a=await import('./app.js'),e=await (await import('./handoff-store.js')).retained(id);await a.handoff.returnedUI.open(e);},fixture.olderId);await ready(page);
    check((await page.locator('#correctionHistoryLabel').innerText()).includes('earlier version')&&await page.locator('#sourceViewer').getAttribute('data-render-sha256')===fixture.baseline,'older reports open their original matching PDF with a plain-language explanation');
    await menu(page,'sourceViewOptions');await page.locator('#comparisonLeft').selectOption('before');await ready(page);await menu(page,'sourceViewOptions',false);
    check(await page.locator('#sourceViewer').getAttribute('data-render-sha256')===fixture.after&&await page.locator('#historicalOverlay').getAttribute('data-finding-ids')==='','returning to Before never transfers earlier marks to different PDF bytes');
    await page.evaluate(async id=>{const a=await import('./app.js'),e=await (await import('./handoff-store.js')).retained(id);await a.handoff.returnedUI.open(e);},fixture.cropId);await ready(page);await menu(page,'sourceViewOptions');await menu(page,'originalReportedContext');
    check((await page.locator('#originalReportedContext').innerText()).includes('Only the original marked images')&&await page.locator('.correction-context img').count()===2,'legacy crop-only context is exposed honestly in the source view');await menu(page,'sourceViewOptions',false);
    // Use a fresh current candidate for layout/long-report checks, not stale history.
    await page.evaluate(async id=>{const a=await import('./app.js'),e=await (await import('./handoff-store.js')).retained(id);await a.handoff.returnedUI.open(e);},fixture.secondId);await ready(page);
    for(const [width,height,name]of [[1440,1000,'desktop'],[1440,600,'wide-short'],[900,442,'panel-wide'],[785,442,'medium-short'],[605,499,'actual'],[489,422,'short'],[340,423,'panel'],[390,844,'mobile']]){
      await page.setViewportSize({width,height});
      // Pane labels follow measured widths through ResizeObserver. Wait for that
      // layout cycle as well as PDF rendering before measuring available score space.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.waitForFunction(()=>{
        const compact=document.querySelector('#renderedViewer').clientWidth<=500;
        return document.querySelector('#reportAnotherError').textContent===(compact?'Report error':'Report another error')&&!document.querySelector('#renderedViewOptions')&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false'&&document.querySelector('#renderedPaper').clientWidth<=document.querySelector('#renderedScroll').clientWidth-18;
      });
      const geometry=await page.evaluate(()=>({ratio:document.querySelector('#renderedScroll').clientHeight/innerHeight,overflow:document.querySelector('.correction-actions').scrollWidth>document.querySelector('.correction-actions').clientWidth,font:parseFloat(getComputedStyle(document.querySelector('#correctionOriginal')).fontSize),truncated:document.querySelector('#correctionOriginal').scrollHeight>document.querySelector('#correctionOriginal').clientHeight}));
      // Sub-tablet browser windows add a 28px application menu and a 32px
      // wrapped workflow row. Keep the existing desktop/tablet space budget;
      // account for these visible controls only below the single-pane boundary.
      const minimumScoreHeight=Math.min(120,height*.3);
      check(geometry.ratio*height>minimumScoreHeight&&!geometry.overflow&&geometry.font>=15,`${name} viewport keeps usable score space, readable scrollable reports and no overflowing decisions (${JSON.stringify(geometry)})`);
      check(await page.locator('#showSource').isVisible()===(width<=700)&&await page.locator('#showBoth').isHidden(),`${name} viewport only offers a two-way switch when needed`);
      check(await page.locator('#renderedPage').isVisible()&&await page.locator('#renderedZoom').isVisible()&&await page.locator('#renderedPageNavigation').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight&&el.scrollWidth===el.clientWidth),`${name} viewport keeps page navigation visible and inside the screen`);
      const paneControls=await page.locator('#renderedViewer .review-pane-controls').evaluate(el=>{const nav=el.querySelector('.review-page-navigation').getBoundingClientRect(),actions=el.querySelector('.review-pane-actions').getBoundingClientRect(),title=el.parentElement.querySelector('strong').getBoundingClientRect(),gap=parseFloat(getComputedStyle(el).columnGap),fits=nav.width+actions.width+gap<=el.clientWidth+1;return {fits,sameRow:Math.abs(nav.y+nav.height/2-actions.y-actions.height/2)<2,overflow:el.scrollWidth>el.clientWidth,titleCenter:title.y+title.height/2,navCenter:nav.y+nav.height/2};});
      check(!paneControls.overflow&&(!paneControls.fits||paneControls.sameRow),`${name} keeps page controls and review actions on one row whenever they fit`);
      if(width>=1100)check(!paneControls.overflow&&(!paneControls.fits||paneControls.sameRow),`${name} keeps the score title and all pane controls in one compact row`);
      const layout=await page.evaluate(()=>{const rect=id=>{const r=document.querySelector(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom};};return {header:rect('#correctionHeader'),strip:rect('#correctionComparison'),report:rect('#correctionOriginal'),actions:rect('.correction-actions'),score:rect('#renderedScroll')};});log.push('LAYOUT '+name+' '+JSON.stringify(layout));
      if(width>700)check(layout.actions.y<layout.report.y&&layout.strip.height<=190,'review actions precede variable report text in a compact strip: '+name);
      check(await page.locator('#roundState').isVisible()&&await page.locator('#correctionProgress').isVisible(),'selected state and total checked remain visible: '+name);
      check(await page.evaluate(()=>{const a=document.querySelector('#correctionProgress').getBoundingClientRect(),b=document.querySelector('#statusControl').getBoundingClientRect(),separate=b.x>=a.right-1||b.right<=a.x+1||b.y>=a.bottom-1||b.bottom<=a.y+1;return separate&&b.width>0&&b.x>=0&&b.right<=innerWidth&&document.querySelector('header').contains(document.querySelector('#statusControl'))&&document.querySelector('#correctionHeader').scrollWidth<=innerWidth&&!document.querySelector('#notices').matches(':popover-open');}),'compact header status stays visible without overlapping progress, overflowing, or reserving a notice row: '+name);
      const closedScore=await page.locator('#renderedScroll').boundingBox();await page.locator('#statusSummary').click();
      check(await page.locator('#statusButton').isHidden()&&!await page.locator('#notices').evaluate(el=>el.matches(':popover-open'))&&JSON.stringify(await page.locator('#renderedScroll').boundingBox())===JSON.stringify(closedScore),'healthy comparison status has no dropdown or Resolve action and preserves score geometry: '+name);
      await page.screenshot({path:resolve(evidence,`review-redesign-${name}.png`)});
    }
    await page.setViewportSize({width:1440,height:600});await go(page,1);const longReport=await page.locator('#correctionOriginal').evaluate(el=>({visible:el.clientHeight,total:el.scrollHeight,font:parseFloat(getComputedStyle(el).fontSize)}));check(longReport.visible>0&&longReport.font>=15,'a realistic longer report stays readable with scrolling or expansion available');await page.screenshot({path:resolve(evidence,'review-realistic-report.png')});await go(page,0);
    {
      await page.setViewportSize({width:785,height:442});if(await page.locator('#commentsPanel').isVisible())await page.locator('#closeComments').click();await page.locator('#reportAnotherError').click();await page.locator('#comment').fill('Layout test: compare this slur with the printed source.');
      // Readiness includes the queued ResizeObserver refit, not just the last
      // completed bitmap. Measure the overlay only after that layout settles.
      await page.waitForFunction(()=>['source','rendered'].every(kind=>{const paper=document.getElementById(kind+'Paper');return paper.dataset.resizePending==='false'&&paper.getAttribute('aria-busy')==='false';}));
      const paper=await page.locator('#renderedPaper').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox(),x=paper.x+Math.min(120,paper.width/2),y=Math.max(paper.y,scroll.y)+Math.min(60,scroll.height/2);
      await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+40,y+5,{steps:8});await page.mouse.up();
      // The visible Note heading reserves 24px above its focus outline.
      // Keep at least 100px of score available in this 442px-high editing view.
      check((await state(page)).review.findings[0].strokes.length===1&&await page.locator('#renderedScroll').evaluate(el=>el.clientHeight)>=100,'a synthetic score passage can be marked and commented on in the short panel');await page.screenshot({path:resolve(evidence,'review-synthetic-annotation.png')});await page.locator('#saveFinding').click();await ready(page);
      check((await page.locator('#statusLabel').textContent())==='Saved locally'&&await page.locator('#submitCorrectionError').count()===0,'local-package annotation saving is labeled locally and offers no unavailable project submit');
    }
    await page.setViewportSize({width:489,height:422});await respond(page);await page.locator('#roundExplanation').fill('ndv remains ordinary typed text.');
    // At 489px the always-visible workflow wraps into a second header row.
    // Preserve the editable response and a usable score strip below it.
    check(await page.locator('#renderedScroll').evaluate(el=>el.clientHeight)>=90&&await page.locator('#roundExplanation').isVisible(),'the response editor and score remain visible in a sub-tablet short window: '+await page.locator('#renderedScroll').evaluate(el=>el.clientHeight));
    await page.locator('#roundExplanation').press('Escape');check(!await page.locator('#correctionResponse').isVisible()&&await page.locator('#roundExplanation').inputValue()==='ndv remains ordinary typed text.','Escape keeps the editor draft while returning to the problem');
    // A synthetic long report exercises bounded reading and explicit expansion.
    await go(page,3);
    check(await page.locator('#correctionOriginal').evaluate(el=>el.clientHeight>=40)&&await page.locator('#expandCorrectionReport').isVisible(),'long reports start in a readable bounded area with an explicit expansion control');await page.locator('#expandCorrectionReport').click();
    check(await page.locator('#correctionOriginal').evaluate(el=>el.clientHeight>100),'Read full report expands the original comment without an ellipsis');
    await page.setViewportSize({width:1440,height:1000});await page.evaluate(async id=>(await import('./qa/comparison-fixture.js')).manyProblemsFixture(id),fixture.issuedId);await ready(page);await page.locator('#correctionFinding').click();
    check(await page.locator('#correctionProblemList button').count()===100&&(await page.locator('#correctionProblemList button').nth(97).innerText()).includes('Reported on page 2')&&(await page.locator('#correctionProblemList button').nth(97).innerText()).includes('piano slur'),'100 problems have distinct report text, page context and status in a searchable list');
    await page.screenshot({path:resolve(evidence,'review-problem-browser-100.png')});await page.locator('#correctionProblemSearch').fill('bar 98:');
    check(await page.locator('#correctionProblemList button').count()===1,'search finds a specific report among 100 without knowing its list position');await page.locator('#correctionProblemList button').click();await ready(page);
    check((await state(page)).selected.findingId==='large-problem-98'&&(await page.locator('#correctionOriginal').innerText()).includes('bar 98:'),'choosing a search result opens its complete original report');
    await page.locator('#skipCorrection').click();await ready(page);await go(page,97);
    check((await state(page)).selected.findingId==='large-problem-98'&&(await state(page)).returned.reported.every(f=>!f.decision),'Next and the problem browser navigate without recording any decision');
    await page.locator('#looksCorrect').click();await ready(page);await page.locator('#correctionFinding').click();await page.locator('#correctionProblemSearch').fill('');await page.locator('#correctionUncheckedOnly').check();
    check(await page.locator('#correctionProblemList button').count()===99,'Unchecked only filters the large list using saved human decisions');await page.locator('#correctionProblemSearch').fill('no such reported problem');
    check((await page.locator('#correctionProblemList').innerText()).includes('No problems match'),'an empty search has a clear recovery state');await page.locator('#correctionProblemSearch').press('Escape');
    await go(page,99);check((await page.locator('#skipCorrection').innerText()).startsWith('Next')&&(await page.locator('#looksCorrect').innerText()).startsWith('Looks correct')&&(await page.locator('#correctionEnd').innerText()).includes('99 unchecked'),'last problem has honest approval text and remaining unchecked count, with a direct round-summary action');await page.locator('#looksCorrect').click();await ready(page);check((await page.locator('#correctionNotice').textContent()).includes('98 unchecked'),'last approval reports remaining unchecked items');await page.waitForFunction(()=>document.querySelector('#roundSummary').open);check(await page.locator('#roundSummaryTitle').innerText()==='Keep reviewing'&&await page.locator('#roundSummaryText').innerText()==='98 corrections still need checking.','final-item approval directs the true unchecked remainder back to reviewing');await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();await go(page,97);check(await page.locator('#roundState').innerText()==='Checked'&&await page.locator('#roundState').isVisible()&&await page.locator('#correctionProgress').innerText()==='2/100 checked'&&(await page.locator('#correctionProgress').getAttribute('aria-label'))==='2 of 100 corrections checked','reopening a checked problem exposes its saved state and total progress');
    check(!log.some(line=>line.startsWith('BROWSER ERROR')),'redesigned review flows finish without uncaught browser errors');
    await writeFile(resolve(evidence,'comparison.txt'),log.join('\n')+'\n');return {name:'comparison',assertions};
  }catch(error){await page.screenshot({path:resolve(evidence,'comparison-failure.png')});await writeFile(resolve(evidence,'comparison-failure.txt'),await page.locator('body').innerText());throw error;}
  finally{for(const c of contexts)await c.close();await server.close();}
}
