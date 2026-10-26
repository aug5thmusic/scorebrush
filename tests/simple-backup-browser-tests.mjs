// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {menuCommand} from './menu-actions.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

// Fresh loopback origin and disposable browser contexts; synthetic files only.
export async function runSimpleBackup({browser,serve,evidence,root}){
  const server=await serve(root),contexts=[],pages=[],errors=[],log=[];let assertions=0;
  const module={exports:{}};Function('module','exports',await readFile(resolve(root,'vendor/jszip.min.js'),'utf8'))(module,module.exports);const JSZip=module.exports;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('simple-backup: '+label);};
  async function newPage(context=null){
    if(!context){context=await browser.newContext({viewport:{width:1440,height:900}});contexts.push(context);}
    const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');return page;
  }
  const settled=page=>page.waitForFunction(()=>document.body.classList.contains('review-open')&&document.querySelector('#renderedPaper').getAttribute('aria-busy')==='false'&&document.querySelector('#sourcePaper').getAttribute('aria-busy')==='false');
  const idle=page=>page.waitForFunction(async()=>!document.querySelector('#closeFinish').disabled&&!(await import('./app.js')).completion.job());
  const state=page=>page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return {review:s.review,returned:s.returned,completions:s.completions,revisionId:s.revisionId,persistedRevision:s.persistedRevision};});
  async function importBackup(page,bytes){await page.locator('#packageFile').setInputFiles({name:'SYNTHETIC-backup.zip',mimeType:'application/zip',buffer:bytes});await page.locator('#workspaceDialog').waitFor({state:'hidden'});await settled(page);}
  async function saveBackup(page){const event=page.waitForEvent('download');await page.evaluate(async()=>{void(await import('./app.js')).completion.open();});const file=await event;await idle(page);return readFile(await file.path());}
  try{
    const page=await newPage();let downloads=0;page.on('download',()=>downloads++);
    await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{const {fixtureBlob}=await import('./qa/fixtures.js');for(const [id,name]of [['sourceFile','source.pdf'],['renderedFile','rendered.pdf'],['lyFile','score.ly']]){const transfer=new DataTransfer();transfer.items.add(new File([await fixtureBlob(name)],'SYNTHETIC-'+name));const input=document.getElementById(id);input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));}});
    await page.locator('#load').click();await settled(page);await page.locator('#newFinding').click();
    const firstDownload=page.waitForEvent('download');
    await page.evaluate(async()=>{const a=await import('./app.js'),note=document.querySelector('#comment');note.value='SYNTHETIC note entered immediately before backup';note.dispatchEvent(new Event('input',{bubbles:true}));window.backupWasDirty=a.sessionStatus().dirty;document.querySelector('#finishReview').click();});
    const file=await firstDownload,firstBytes=await readFile(await file.path());await idle(page);const firstZip=await JSZip.loadAsync(firstBytes),firstReview=JSON.parse(await firstZip.file('annotations.json').async('string'));
    check(await page.evaluate(()=>window.backupWasDirty)&&firstReview.findings[0].comment==='SYNTHETIC note entered immediately before backup','Save backup flushes the note being edited and requests the ZIP download automatically');
    const firstState=await state(page),revisionMetadata=JSON.parse(await firstZip.file('completion-history.json').async('string'));
    check(await page.locator('[name=finishScope],#finishReviewer,#finishNote,#completionHistory,#finishSummary').count()===0&&firstState.completions.length===0&&revisionMetadata.records.length===0&&!firstZip.file('completion-summary.txt'),'ordinary backup needs no review declaration and creates no certification record');
    check(await page.locator('#finishDownloads>a').count()===1&&(await page.locator('#finishTitle').innerText())==='Backup ready','ready dialog offers one reusable ZIP link without claiming the file was saved to disk');
    for(const width of [1440,1024]){await page.setViewportSize({width,height:900});check(await page.locator('#finishDialog').evaluate(el=>el.scrollWidth<=el.clientWidth&&el.getBoundingClientRect().width<innerWidth-16),width+'px backup dialog fits without horizontal scrolling');}
    await page.screenshot({path:resolve(evidence,'simple-backup-ready.png')});await writeFile(resolve(evidence,'simple-backup.zip'),firstBytes);
    const restored=await newPage();await importBackup(restored,firstBytes);const restoredState=await state(restored);check(isDeepStrictEqual(restoredState.review.findings,firstReview.findings)&&restoredState.revisionId===firstState.revisionId&&restoredState.review.updatedAt===firstReview.updatedAt,'ordinary ZIP restores exact findings, revision identity, and annotation date in a fresh browser context');
    await restored.reload();await restored.waitForFunction(()=>document.body.dataset.ready==='true');await settled(restored);const reloadedState=await state(restored);check(isDeepStrictEqual(reloadedState.review,restoredState.review)&&reloadedState.revisionId===restoredState.revisionId,'reloading an ordinary restored backup preserves the exact revision and annotation date');
    await page.locator('#closeFinish').click();

    // A legacy package is generated by the frozen compatibility helper, then
    // passed through the actual import and new Save backup controls.
    const legacyBytes=Buffer.from(await page.evaluate(async()=>{const a=await import('./app.js'),{prepareCompletion}=await import('./completion.js'),s=a.completion.capture(),old=await prepareCompletion(s,{scope:'partial',note:'Synthetic historical declaration',reviewer:'Synthetic reviewer'},{id:crypto.randomUUID(),createdAt:new Date().toISOString()},()=>{},a.operations.makePackage);return [...new Uint8Array(await(await a.operations.zipFiles(old.payloads)).arrayBuffer())];}));
    const legacy=await newPage();await importBackup(legacy,legacyBytes);const beforeLegacy=await state(legacy),newLegacyBytes=await saveBackup(legacy),newLegacyZip=await JSZip.loadAsync(newLegacyBytes),records=JSON.parse(await newLegacyZip.file('completion-history.json').async('string')).records;
    check(records.length===1&&isDeepStrictEqual(records,beforeLegacy.completions),'new backup carries an old completion record unchanged and adds no new declaration');
    const legacyRestored=await newPage();await importBackup(legacyRestored,newLegacyBytes);check(isDeepStrictEqual((await state(legacyRestored)).completions,beforeLegacy.completions),'legacy records remain readable after new-backup export and fresh-context restore');

    const beforeCancel=await state(page),downloadCount=downloads;
    await page.evaluate(async()=>{const a=await import('./app.js');window.originalBackupPrepare=a.completion.io.prepare;a.completion.io.prepare=async(...args)=>{window.backupSignal=args[3].signal;await new Promise(resolve=>window.releaseBackup=resolve);return window.originalBackupPrepare(...args);};void a.completion.open();});
    await page.waitForFunction(()=>Boolean(window.releaseBackup));await page.locator('#cancelFinish').click();
    check(await page.evaluate(()=>window.backupSignal.aborted),'Cancel interrupts rendering through an abort signal');
    await page.evaluate(()=>window.releaseBackup());await idle(page);
    check(downloads===downloadCount&&JSON.stringify(await state(page))===JSON.stringify(beforeCancel)&&await page.locator('#finishDownloads>a').count()===0,'cancelled preparation leaves the review unchanged and publishes no download');
    await page.evaluate(async()=>{(await import('./app.js')).completion.io.prepare=async()=>{throw new Error('SYNTHETIC package failure');};});await page.locator('#prepareFinish').click();await idle(page);
    check((await page.locator('#finishStatus').innerText()).includes('SYNTHETIC package failure')&&await page.locator('#prepareFinish').isVisible()&&downloads===downloadCount,'failed preparation offers retry without a partial ZIP or false success');
    await page.evaluate(async()=>{(await import('./app.js')).completion.io.prepare=window.originalBackupPrepare;});const retryDownload=page.waitForEvent('download');await page.locator('#prepareFinish').click();await retryDownload;await idle(page);
    check(downloads===downloadCount+1&&(await state(page)).completions.length===0,'retry succeeds without creating a declaration or duplicate record');await page.locator('#closeFinish').click();

    const countBeforeStale=downloads;
    await page.evaluate(async()=>{const a=await import('./app.js');a.completion.io.prepare=async(...args)=>{const result=await window.originalBackupPrepare(...args);args[0].stamp.revision++;return result;};await a.completion.open();});await idle(page);
    check((await page.locator('#finishStatus').innerText()).includes('Review changed')&&downloads===countBeforeStale&&await page.locator('#finishDownloads>a').count()===0,'a mismatched captured revision is discarded before any download is published');
    await page.evaluate(async()=>{const a=await import('./app.js');a.completion.io.prepare=window.originalBackupPrepare;window.originalBackupDownload=a.completion.io.download;a.completion.io.download=()=>{throw new Error('SYNTHETIC download unavailable');};});await page.locator('#prepareFinish').click();await page.waitForFunction(()=>document.querySelector('#finishStatus').textContent.includes('Use Download backup ZIP'));await idle(page);
    check((await page.locator('#finishStatus').innerText()).includes('Use Download backup ZIP')&&await page.locator('#finishDownloads>a').isVisible(),'a blocked automatic download keeps the complete ZIP available through its link');
    const manualDownload=page.waitForEvent('download');await page.locator('#finishDownloads>a').click();await manualDownload;await page.locator('#closeFinish').click();
    await page.evaluate(async()=>{(await import('./app.js')).completion.io.download=window.originalBackupDownload;});

    // Another tab may save while this tab is preparing an immutable backup.
    // Saving the ZIP must not overwrite the newer persisted review.
    const other=await newPage(page.context());await settled(other);
    await page.evaluate(async()=>{const a=await import('./app.js');window.originalBackupZip=a.completion.io.zip;a.completion.io.zip=async(...args)=>{await new Promise(resolve=>window.releaseBackupZip=resolve);return window.originalBackupZip(...args);};void a.completion.open();});await page.waitForFunction(()=>Boolean(window.releaseBackupZip));
    await other.locator('#newFinding').click();await other.locator('#comment').fill('SYNTHETIC edit from another tab');await other.locator('#saveFinding').click();await other.waitForFunction(async()=>!(await import('./app.js')).sessionStatus().dirty);
    const otherState=await state(other),concurrentDownload=page.waitForEvent('download');await page.evaluate(()=>window.releaseBackupZip());const concurrentFile=await concurrentDownload;await idle(page);
    const concurrentZip=await JSZip.loadAsync(await readFile(await concurrentFile.path())),captured=JSON.parse(await concurrentZip.file('annotations.json').async('string')),saved=await page.evaluate(async()=>{const a=await import('./app.js');return(await(await import('./storage.js')).getSaved(a.completion.capture().workspaceId)).review;});
    check(captured.findings.length===1&&saved.findings.length===2&&JSON.stringify(saved.findings)===JSON.stringify(otherState.review.findings),'backup contains its captured state and never overwrites newer edits saved by another tab');
    const large=await newPage();await importBackup(large,firstBytes);let largeDownloads=0;large.on('download',()=>largeDownloads++);
    await large.evaluate(async()=>{
      const a=await import('./app.js'),storage=await import('./storage.js'),{retainLegacyState}=await import('./qa/legacy-journal-fixture.js');let current=await retainLegacyState(await storage.getSaved(a.completion.capture().workspaceId));const visible=structuredClone(current.review);
      for(let n=0;n<36;n++){
        const review=structuredClone(current.review);review.findings=Array.from({length:120},(_,i)=>({id:'synthetic-large-'+i,number:i+1,page:1,comment:n+':'+i+':'+('SYNTHETIC note text ').repeat(180),type:'correction',state:'open',color:'#ffd34d',strokes:[],bounds:null}));review.nextNumber=121;
        current=await retainLegacyState(await storage.putSaved({...current,review,revisionId:crypto.randomUUID()},current.storageRevision));
      }
      // Keep every large historical state, with a small current note so this
      // history test does not spend its time rasterizing a huge comment index.
      await retainLegacyState(await storage.putSaved({...current,review:visible,revisionId:crypto.randomUUID()},current.storageRevision));
    });
    await large.reload();await large.waitForFunction(()=>document.body.dataset.ready==='true');await settled(large);
    const capacityBefore=await state(large),journalBefore=await large.evaluate(async()=>{const a=await import('./app.js');return JSON.stringify(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId));});
    const largeDownload=large.waitForEvent('download',{timeout:120000});
    await large.evaluate(async()=>{await(await import('./app.js')).completion.open();});const largeFile=await largeDownload;await idle(large);
    const largeBytes=await readFile(await largeFile.path()),largeZip=await JSZip.loadAsync(largeBytes),largeIndex=JSON.parse(await largeZip.file('History.json').async('string')),journal=JSON.parse(journalBefore);
    check(largeDownloads===1&&await large.locator('#finishDownloads>a').count()===1&&await large.locator('#finishTitle').innerText()==='Backup ready'&&largeIndex.version===2,'real large-history UI produces a complete compact backup and one automatic download');
    assert.deepEqual(largeIndex.events.map(e=>e.id).sort(),journal.map(e=>e.id).sort());
    for(const event of largeIndex.events){
      const original=journal.find(r=>r.id===event.id),annotations=largeIndex.objects.find(o=>o.id===event.metadata.annotations),completion=largeIndex.objects.find(o=>o.id===event.metadata.completion);
      assert.equal(event.revisionId,original.revisionId);assert.equal(event.parentEventId,original.parentHistoryId??null);
      assert.deepEqual(JSON.parse(await largeZip.file(annotations.path).async('string')),original.review);
      assert.equal(JSON.parse(await largeZip.file(completion.path).async('string')).revisionId,event.revisionId);
    }
    for(const object of largeIndex.objects){const bytes=await largeZip.file(object.path).async('nodebuffer');assert.equal(bytes.length,object.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),object.sha256);}
    check(true,'large backup preserves every event, revision, parent, exact annotation and completion association, and all retained object bytes');
    check(isDeepStrictEqual(await state(large),capacityBefore)&&await large.evaluate(async expected=>{const a=await import('./app.js');return JSON.stringify(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId))===expected;},journalBefore),'large-history export preserves the complete saved head, storage counter and every durable edit');
    await large.screenshot({path:resolve(evidence,'simple-backup-large-history-ready.png')});
    const largeRestored=await newPage();await importBackup(largeRestored,largeBytes);
    const restoredJournal=await largeRestored.evaluate(async()=>{const a=await import('./app.js');return(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId);});
    const retainedState=records=>records.map(({id,revisionId,parentHistoryId,review})=>({id,revisionId,parentHistoryId,review})).sort((a,b)=>a.id.localeCompare(b.id));
    check(isDeepStrictEqual(retainedState(restoredJournal),retainedState(journal))&&(await state(largeRestored)).revisionId===capacityBefore.revisionId,'the large backup restores every exact durable state and current revision in a fresh browser context');
    const entryLimit=await newPage();await importBackup(entryLimit,firstBytes);let entryDownloads=0;entryLimit.on('download',()=>entryDownloads++);
    const entryBefore=await state(entryLimit),entryJournal=await entryLimit.evaluate(async()=>{const a=await import('./app.js');return JSON.stringify(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId));});
    await entryLimit.evaluate(async()=>{
      const a=await import('./app.js'),prepare=a.completion.io.prepare,{seal,LIMITS}=await import('./workflow.js');
      // Exercise the real preparation/capacity/UI path, adding only synthetic
      // manifest-declared companion files through the existing test seam.
      a.completion.io.prepare=async(s,progress,maker,options)=>{
        const baseline=await prepare(s,progress,maker,options),extra=LIMITS.count+1-baseline.payloads.size;
        return prepare(s,progress,async(...args)=>{
          const payloads=await maker(...args);for(let i=0;i<extra;i++)payloads.set(`synthetic/branch-${i}/nested/evidence.txt`,new Blob(['SYNTHETIC '+i]));
          return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
        },options);
      };
      await a.completion.open();
    });await idle(entryLimit);
    check(/exceeds backup capacity.*no older history was discarded/.test(await entryLimit.locator('#finishStatus').innerText())&&entryDownloads===0&&await entryLimit.locator('#finishDownloads>a').count()===0&&await entryLimit.locator('#finishTitle').innerText()!=='Backup ready','nested ZIP entry overflow fails before any download or ready link');
    check(isDeepStrictEqual(await state(entryLimit),entryBefore)&&await entryLimit.evaluate(async expected=>{const a=await import('./app.js');return JSON.stringify(await(await import('./storage.js')).workspaceHistory(a.completion.capture().workspaceId))===expected;},entryJournal),'entry-count failure preserves the exact saved head, storage counter and journal');
    await entryLimit.screenshot({path:resolve(evidence,'simple-backup-entry-capacity.png')});
    check(errors.length===0,'backup workflow finishes without uncaught browser errors: '+errors.join('; '));
    return {name:'simple workspace backups',assertions};
  }catch(error){log.push('FAIL '+error.stack);for(let i=0;i<pages.length;i++)try{await pages[i].screenshot({path:resolve(evidence,`simple-backup-failure-${i}.png`),fullPage:true});await writeFile(resolve(evidence,`simple-backup-failure-${i}.txt`),await pages[i].locator('body').innerText());}catch{}throw error;}
  finally{await writeFile(resolve(evidence,'simple-backup.txt'),log.join('\n'));for(const context of contexts)await context.close();await server.close();}
}
