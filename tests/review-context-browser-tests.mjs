// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
export async function runReviewContext({browser,serve,evidence,root}){
 const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
 const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('review-context: '+label);};
 page.on('pageerror',e=>errors.push(e.message));
 async function until(fn){const end=Date.now()+90000;while(!await page.evaluate(fn)){if(Date.now()>end)throw Error('Timed out: '+await page.locator('body').innerText());await new Promise(r=>setTimeout(r,80));}}
 const ready=()=>until(async()=>{const a=await import('./app.js');return !a.corrections.state().pending&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&document.querySelector('#correctionComparison').getAttribute('aria-busy')==='false'&&[...document.querySelectorAll('.paper')].every(el=>el.getAttribute('aria-busy')!=='true'&&el.dataset.resizePending!=='true');});
 const state=()=>page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return {review:s.review,returned:s.returned,revisionId:s.revisionId};});
 const open=async id=>{await page.evaluate(async id=>{const a=await import('./app.js');await a.handoff.returnedUI.open(await(await import('./handoff-store.js')).retained(id));},id);await ready();};
 const comment=async id=>{await page.evaluate(async id=>(await import('./app.js')).handoff.returnedUI.showComment(id),id);};
 const close=()=>page.locator('#closeReturnedComments').click();
 const boxes=()=>page.locator('.correction-actions').evaluate(el=>[...el.children].map(n=>{const r=n.getBoundingClientRect();return [r.x,r.y,r.width,r.height];}));
 try{
  await page.goto(server.url);await until(()=>document.body.dataset.ready==='true');await page.locator('#closeWorkspace').click();
  const fixture=await page.evaluate(async()=>{const f=await(await import('./qa/comparison-fixture.js')).comparisonFixture({types:{2:'comment',3:'comment'}});window.contextFixture=f;return f;});await ready();
  check(await page.locator('#correctionLocationStatus,#correctionAlignment,#locateCorrectedPassage').count()===0,'no floating location warning, alignment explanation or manual remember button remains');
  check(await page.locator('#approximateLocation').count()===0&&!(await page.locator('#renderedPageNavigation').innerText()).includes('≈'),'PDF navigation contains no unexplained approximation symbol');
  check(!(await state()).returned.reported[0].decision,'viewing a revised passage does not approve its correction');
  check(await page.locator('#correctionAI>summary').innerText()==='AI’s explanation'&&await page.locator('#correctionAI').isVisible(),'a response with an explanation exposes the named disclosure');
  await page.locator('#correctionAI>summary').click();check(await page.locator('#correctionAI p').innerText()==='SIMULATED change claim; verify visually.','the displayed explanation belongs to the selected finding');await page.locator('#correctionAI>summary').click();
  const original=await state();await page.locator('[data-reported-id="comparison-3"] .finding-open').click();await until(()=>Boolean(document.querySelector('#returnedCommentContext')?.naturalWidth));
  check(await page.locator('.internal-comment-origin').innerText()==='Original comment · page 3'&&await page.locator('#returnedCommentContext').getAttribute('data-render-sha256')===fixture.baseline&&fixture.baseline!==fixture.after,'a comment names its original page and exact rendering, distinct from the changed score');
  check(await page.evaluate(async()=>{const {retained}=await import('./handoff-store.js'),{sha256}=await import('./model.js'),issued=await retained(window.contextFixture.issuedId),expected=await createImageBitmap(issued.payloads.get('findings/003-comparison-3-marked.png')),shown=document.querySelector('#returnedCommentContext'),pixels=image=>{const c=document.createElement('canvas');c.width=image.naturalWidth??image.width;c.height=image.naturalHeight??image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};try{return await sha256(pixels(expected))===await sha256(pixels(shown));}finally{expected.close();}}),'the displayed marked comment image is pixel-identical to the retained PNG');
  check(await page.locator('#showCommentCurrentPassage').count()===0,'no current-revision location is offered without a current association');
  await page.screenshot({path:resolve(evidence,'review-context-marked.png')});await close();
  check(isDeepStrictEqual(await state(),original),'opening and closing original comment history changes no review, decision or revision identity');
  await comment('comparison-2');check(await page.locator('.internal-comment-text-only').innerText()==='Text-only comment · no marked passage.'&&await page.locator('#returnedCommentContext').count()===0,'text-only comments explicitly have no highlight, even though exports contain page PNGs');await close();
  await open(fixture.olderId);await comment('comparison-3');
  check(await page.locator('#returnedCommentContext').getAttribute('data-render-sha256')===fixture.baseline&&(await state()).review.files.rendered.sha256===fixture.after,'a later round still shows the original comment on its original rendering');await close();
  await open(fixture.cropId);await comment('comparison-3');check(await page.locator('#returnedCommentContext').getAttribute('data-source')==='retained-marked','a legacy crop-only record uses its marked image without requiring a historical PDF');await close();
  await comment('comparison-2');check(await page.locator('.internal-comment-text-only').count()===1&&await page.locator('#returnedCommentContext').count()===0,'identical clean and marked crop bytes identify legacy text-only context without inventing a mark');await close();
  const variants=await page.evaluate(async()=>{
    const {retained,retain}=await import('./handoff-store.js'),{clone}=await import('./model.js'),{finalizeTask,json,readResponse,responseRevision}=await import('./workflow.js'),{zipFiles}=await import('./export.js');
    const a=await import('./app.js'),base=await retained((await retained(window.contextFixture.olderId)).taskId),out={};
    for(const mode of ['pdf','missing','wrong-pdf','wrong-marks']){
      const task=clone(base);task.id=task.task.id=crypto.randomUUID();
      for(const f of task.task.findings){
        const h=f.historicalContext;task.payloads.delete(h.marked);task.payloads.delete(h.clean);
        if(mode==='missing'){delete h.originalFiles;delete h.annotations;}
        if(mode==='wrong-pdf'&&f.id==='comparison-3'){h.originalFiles.rendered.path='historical/wrong-test.pdf';task.payloads.set(h.originalFiles.rendered.path,task.files.rendered.blob);}
        if(mode==='wrong-marks'&&f.id==='comparison-3'){h.annotations='historical/wrong-test.json';task.payloads.set(h.annotations,json(task.review));}
      }
      // Missing and invalid historical bytes simulate already-retained older
      // records. Do not weaken the normal package/import validators to load them.
      if(mode==='pdf'||mode==='missing')await finalizeTask(task);
      await retain(task);const r=JSON.parse(await task.payloads.get('response-template.json').text());r.taskId=task.id;r.code={status:'unchanged',path:null};r.rendering={status:'pending',path:null,producer:'SYNTHETIC history',compiler:null};r.files={};r.results.forEach(f=>{f.status='unchanged_with_reason';f.explanation='Kept the original slur.';});
      const entry=responseRevision(await readResponse(await zipFiles(new Map([['response.json',json(r)]])),async()=>task));await retain(entry);out[mode]=entry.id;
    }
    const issued=await retained(window.contextFixture.issuedId),changed=a.completion.capture().files;
    const entry=responseRevision(await(await import('./folder-workspace.js')).rawFolderResponse(issued,changed));await retain(entry);out.folder=entry.id;
    const old=clone(entry);old.id=crypto.randomUUID();old.response.results.forEach(f=>f.explanation='Loaded updated local files; no per-finding AI explanation was supplied. Compare and decide.');await retain(old);out.legacy=old.id;
    const selected=clone(entry);selected.id=crypto.randomUUID();selected.response.results.find(f=>f.id==='comparison-1').explanation='Changed E to F. <b>Kept the slur.</b>';await retain(selected);out.selected=selected.id;
    return out;
  });
  await open(variants.pdf);await comment('comparison-3');
  check(await page.locator('#returnedCommentContext').getAttribute('data-source')==='original-pdf'&&await page.locator('#returnedCommentContext').getAttribute('data-render-sha256')===fixture.baseline,'missing crops fall back to the exact historical PDF and original overlay');
  check(await page.evaluate(async()=>{const {retained}=await import('./handoff-store.js'),{commentReference}=await import('./comparison-model.js'),{sha256}=await import('./model.js'),{renderCommentImage}=await import('./comment-images.js'),s=(await import('./app.js')).completion.capture(),issued=await retained(s.returned.taskId),ref=await commentReference(issued,issued.task.findings.find(f=>f.id==='comparison-3')),shown=document.querySelector('#returnedCommentContext'),unmarked=await createImageBitmap(await renderCommentImage({...ref,mark:{...ref.mark,strokes:[{...ref.mark.strokes[0],opacity:0,color:'#ffffff'}]}})),pixels=image=>{const c=document.createElement('canvas');c.width=image.naturalWidth??image.width;c.height=image.naturalHeight??image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data;};try{return await sha256(pixels(shown))!==await sha256(pixels(unmarked));}finally{unmarked.close();}}),'historical PDF fallback actually contains the original highlight');await close();
  for(const key of ['missing','wrong-pdf','wrong-marks']){await open(variants[key]);await comment('comparison-3');check(await page.locator('.internal-comment-unavailable').count()===1&&await page.locator('#returnedCommentContext').count()===0,`${key} history is explicit and never substitutes the changed current PDF`);await close();}
  await open(variants.folder);check(await page.locator('#correctionAI').isHidden()&&! (await page.locator('body').innerText()).includes('Loaded updated local files'),'ordinary folder reloads hide the AI explanation and generic fallback');
  await page.reload();await ready();check(await page.locator('#correctionAI').isHidden(),'folder reload explanation stays hidden after restart');
  await open(variants.legacy);check(await page.locator('#correctionAI').isHidden(),'previously saved placeholder responses are hidden without rewriting stored records');
  await open(variants.selected);const stable=await boxes();await page.locator('#correctionAI>summary').click();
  check(await page.locator('#correctionAI p').innerText()==='Changed E to F. <b>Kept the slur.</b>'&&await page.locator('#correctionAI b').count()===0,'substantive explanation remains literal text, including untrusted markup');await page.locator('#correctionAI>summary').click();
  await page.evaluate(async()=>(await import('./app.js')).corrections.selectFinding('comparison-4'));await ready();check(await page.locator('#correctionAI').isHidden()&&isDeepStrictEqual(await boxes(),stable),'switching to a finding without explanation hides stale text without moving review buttons');
  for(const [width,height]of [[1024,768],[590,362],[390,844]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await ready();check(await page.locator('#correctionLocationStatus').count()===0,`no location overlay at ${width} × ${height}`);
    await comment('comparison-3');check(await page.locator('#returnedCommentsDialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1)&&await page.locator('#returnedCommentContext').getAttribute('data-render-sha256')===fixture.baseline,`marked comment fits the dialog at ${width} × ${height}`);await page.locator('#returnedCommentContext').evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:resolve(evidence,`review-context-${width}.png`)});await close();
  }
  await page.setViewportSize({width:1440,height:900});await ready();await open(fixture.entryId);
  await page.evaluate(async()=>{const a=await import('./app.js');await a.corrections.selectFinding('comparison-1');});await page.locator('#locateRegion').click();await page.locator('#findingType').selectOption('comment');await page.locator('#comment').fill('SYNTHETIC current association');await ready();await page.locator('#draw').click();
  const b=await page.locator('#overlay').boundingBox(),scroll=await page.locator('#renderedScroll').boundingBox(),x=Math.max(b.x,scroll.x)+80,y=Math.max(b.y,scroll.y)+90;await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+55,y+5,{steps:4});await page.mouse.up();check((await state()).review.findings.some(f=>f.strokes.length),'the current association has a real newly drawn passage');await page.locator('#saveFinding').click();await ready();
  await page.locator('[data-reported-id="comparison-1"] .finding-open').click();await until(()=>Boolean(document.querySelector('#returnedCommentContext')?.naturalWidth));
  check(await page.locator('#returnedCommentContext').getAttribute('data-render-sha256')===fixture.baseline&&await page.locator('#showCommentCurrentPassage').isVisible(),'an associated comment opens original evidence and offers the valid current passage separately');
  await page.locator('#showCommentCurrentPassage').click();check(await page.locator('#comment').inputValue()==='SYNTHETIC current association'&&(await state()).review.files.rendered.sha256===fixture.after,'the secondary action selects the real current annotation on its own rendering');await page.locator('#saveFinding').click();await ready();
  check(errors.length===0,'review context checks finish without uncaught browser errors: '+errors.join('; '));return {name:'review-context',assertions};
 }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'review-context-failure.png')});throw error;}
 finally{await writeFile(resolve(evidence,'review-context.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
