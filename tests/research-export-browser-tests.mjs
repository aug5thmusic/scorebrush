// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,access} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {waitUntil} from './clean-resume-helpers.mjs';
import {menuCommand} from './menu-actions.mjs';

export async function runResearchExport({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),log=[];let assertions=0;
  const check=(value,label)=>{assert(value,label);assertions++;log.push('PASS '+label);console.log('research-export: '+label);};
  const saved=()=>waitUntil(page,()=>{const f=a.folderWorkspace.getState(),s=a.sessionStatus();if(f.error||s.saveFailed||s.saveConflict)throw Error(f.error||'Local save failed');return f.ready&&!f.busy&&!s.busy&&!s.dirty;});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    await page.evaluate(async()=>{
      window.a=await import('./app.js');const {fixtureBlob}=await import('./qa/fixtures.js');
      window.folder=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC research export',{create:true});
      for(const [name,fixture]of [['Étude source.pdf','source.pdf'],['Transcription été.pdf','rendered.pdf'],['Mozart 舞曲 K545.ly','score.ly']]){const w=await(await folder.getFileHandle(name,{create:true})).createWritable();await w.write(await fixtureBlob(fixture));await w.close();}
      a.folderWorkspace.io.pickDirectory=async()=>folder;
    });
    await page.locator('#chooseFolderInSetup').click();await page.locator('#folderSetupDialog').waitFor();
    for(const [id,name]of [['folderSourceSelect','Étude source.pdf'],['folderRenderedSelect','Transcription été.pdf'],['folderLySelect','Mozart 舞曲 K545.ly']])await page.locator('#'+id).selectOption(name);
    await page.locator('#folderSetupConfirm').click();await saved();
    for(const text of ['SYNTHETIC correct this pitch','SYNTHETIC unresolved rhythm']){await page.locator('#newFinding').click();await page.locator('#comment').fill(text);await page.locator('#saveFinding').click();await saved();}
    await page.evaluate(async()=>{await a.folderWorkspace.saveNow();const w=await(await folder.getFileHandle('Mozart 舞曲 K545.ly')).createWritable();await w.write('% SYNTHETIC changed notation\n\\version "2.24.3"\n');await w.close();await a.folderWorkspace.loadLatest();});await saved();
    const before=await page.evaluate(async()=>({history:await(await(await folder.getFileHandle('History.json')).getFile()).text(),scene:a.completion.capture().returned}));
    check(before.scene.reported.length===2,'synthetic correction round contains two issued findings');
    await page.locator('#looksCorrect').click();await saved();
    const decision=await page.evaluate(async()=>({history:await(await(await folder.getFileHandle('History.json')).getFile()).text(),scene:a.completion.capture().returned}));
    check(decision.history===before.history&&decision.scene.reported[0].decision?.state==='resolved'&&decision.scene.reported[1].decision===null,'saved human decision is newer than the published history index');
    await menuCommand(page,'Edit','new-finding');await page.locator('#comment').fill('SYNTHETIC new annotation after the returned round');await page.locator('#saveFinding').click();await saved();
    await page.locator('#locateRegion').click();await page.locator('#comment').fill('SYNTHETIC current note attached to unresolved finding');await page.locator('#saveFinding').click();await saved();
    const capturedBeforeExport=await page.evaluate(()=>JSON.stringify(a.completion.capture().review));
    const started=performance.now();
    const [file]=await Promise.all([page.waitForEvent('download'),(async()=>{await menuCommand(page,'File','files');await page.locator('#exportResearch').click();})()]);
    const bytes=await readFile(await file.path());await waitUntil(page,()=>!a.completion.job());
    const elapsedMs=performance.now()-started;
    check(/^Mozart 舞曲 K545-research-[0-9]{8}-[0-9]{6}\.zip$/.test(file.suggestedFilename())&&await page.locator('#finishTitle').innerText()==='Research export ready','existing Files & backups UI produces research ZIP only after validation');
    check(await page.locator('#finishDownloads>a').getAttribute('download')===file.suggestedFilename(),'automatic and fallback ZIP names match');
    check(await page.locator('#finishRevision').innerText()==='Source PDF: Étude source.pdf · Transcription PDF: Transcription été.pdf · LilyPond: Mozart 舞曲 K545.ly','returned-round popup shows captured project role names without proposed aliases');
    await writeFile(resolve(evidence,'scorebrush-research.zip'),bytes);await page.screenshot({path:resolve(evidence,'research-export-ready.png')});
    const module={exports:{}};Function('module','exports',await readFile(resolve(root,'vendor/jszip.min.js'),'utf8'))(module,module.exports);const JSZip=module.exports,zip=await JSZip.loadAsync(bytes);
    const manifest=JSON.parse(await zip.file('research-manifest.json').async('string'));
    const mapping=JSON.parse(await zip.file('score-files.json').async('string')),history=JSON.parse(await zip.file('History.json').async('string'));
    const readableCount=new Set(mapping.files.map(f=>f.path)).size,uniqueAssets=new Set(mapping.files.map(f=>f.assetId)).size;
    check(mapping.version===2&&readableCount===uniqueAssets&&readableCount<mapping.files.length,'shared readable files grow with distinct assets, not retained checkpoint count');
    check(bytes.readUInt16LE(8)===8,'Research ZIP compresses its history with standard DEFLATE');
    check(await page.evaluate(()=>JSON.stringify(a.completion.capture().review))===capturedBeforeExport,'export preserves the captured review unchanged');
    check(mapping.files.filter(f=>f.current).length===3&&mapping.files.some(f=>!f.current),'readable copies include current and retained historical scores');
    check(mapping.files.filter(f=>f.current).map(f=>f.path).sort().join('|')===['scores/current/source/Étude source.pdf','scores/current/transcription/Transcription été.pdf','scores/current/lilypond/Mozart 舞曲 K545.ly'].sort().join('|'),'readable current files use the known Unicode project filenames');
    for(const copy of mapping.files){const object=history.objects.find(o=>o.id===copy.assetId),data=await zip.file(copy.path).async('nodebuffer');assert.deepEqual(data,await zip.file(object.path).async('nodebuffer'));assert.equal(data.length,copy.size);assert.equal(createHash('sha256').update(data).digest('hex'),copy.sha256);const declaration=manifest.files.find(f=>f.path===copy.path);assert.equal(declaration.role,'readable-score');assert.equal(declaration.sha256,copy.sha256);assert.equal(declaration.size,copy.size);}
    check(mapping.files.length===history.revisions.reduce((n,r)=>n+Object.values(r.assetIds).filter(Boolean).length,0),'every retained available revision asset has a byte-exact manifest-declared readable copy');
    check((await zip.file('README.txt').async('string')).indexOf('without Python')<(await zip.file('README.txt').async('string')).indexOf('Optional dataset'),'README explains readable folders before optional Python');

    for(const name of ['LICENSE','LICENSING.md']){
      assert.deepEqual(await zip.file(name).async('nodebuffer'),await readFile(resolve(root,'..',name)));
      assert.equal(manifest.files.find(f=>f.path===name)?.role,'notice');
    }
    check(true,'reader software notices match root documents byte for byte and have manifest notice roles');
    check(!Object.keys(zip.files).some(p=>/OWNER|grant|proof|profile|diagnostic/i.test(p)),'ZIP paths contain only research records, reader and content-addressed project objects');
    const fresh=resolve(evidence,'standalone-reader-disposable');await mkdir(fresh);await copyFile(resolve(evidence,'scorebrush-research.zip'),resolve(fresh,'moved-research.zip'));await writeFile(resolve(fresh,'research-reader.py'),await zip.file('research-reader.py').async('nodebuffer'));
    const python=process.env.SCOREBRUSH_TEST_PYTHON??'C:/Python/310/python.exe';
    const run=(name,args=[])=>spawnSync(python,['research-reader.py',name,...args],{cwd:fresh,encoding:'utf8',windowsHide:true,timeout:30000});
    const valid=run('moved-research.zip',['--current','--output','examples.jsonl']);await writeFile(resolve(evidence,'research-reader-valid.txt'),JSON.stringify(valid,null,2));check(valid.status===0,'included reader runs independently after moving ZIP, without application imports');
    const legacy=await JSZip.loadAsync(bytes),legacyManifest=JSON.parse(await legacy.file('research-manifest.json').async('string'));
    const removed=['LICENSE','LICENSING.md','score-files.json',...legacyManifest.files.filter(f=>f.role==='readable-score').map(f=>f.path)];
    for(const name of removed)legacy.remove(name);
    legacyManifest.files=legacyManifest.files.filter(f=>!removed.includes(f.path));legacy.file('research-manifest.json',JSON.stringify(legacyManifest));
    await writeFile(resolve(fresh,'legacy-without-notices.zip'),await legacy.generateAsync({type:'nodebuffer',compression:'STORE'}));
    const legacyResult=run('legacy-without-notices.zip',['--current','--output','legacy-examples.jsonl']);
    check(legacyResult.status===0,'earlier format-1 archives without readable copies or notices remain readable');
    const episodes=(await readFile(resolve(fresh,'examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    check(episodes.length===3&&episodes[0].humanJudgment?.state==='resolved'&&episodes[1].humanJudgment===null&&episodes[1].status!=='resolved','reader reconstructs accepted and unresolved findings from the newer current checkpoint');
    check(episodes[2].findingKind==='annotation'&&episodes[2].retainedFinding.comment.includes('new annotation')&&episodes[2].humanJudgment===null&&episodes[2].missing.includes('issued-finding-context-unavailable'),'new unassociated annotation is retained without inventing a returned judgment');
    check(episodes[1].currentAnnotation?.comment==='SYNTHETIC current note attached to unresolved finding','current associated note is preserved alongside its original issued finding');
    check(episodes.slice(0,2).every(e=>e.startingAssets?.ly&&e.resultAssets?.ly&&e.sourceAssetId&&e.issuedFinding&&e.issuedPayloads&&e.judgmentScope.includes('no whole-score')),'episodes join source, task baseline, exact issued context, result and scoped judgment');
    const readable=episodes[0].evidence;
    for(const descriptor of [readable.source,readable.starting.ly,readable.result.ly,...Object.values(readable.issuedContext)])assert.equal(createHash('sha256').update(await readFile(resolve(fresh,descriptor.file))).digest('hex'),descriptor.sha256);
    check(Object.keys(readable.issuedContext).includes('PROMPT.txt'),'reader resolves exact source, notation, render and prompt bytes into independently usable evidence files');
    const extracted=resolve(fresh,'extracted');await mkdir(extracted);
    for(const name of Object.keys(zip.files)){const target=resolve(extracted,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,await zip.file(name).async('nodebuffer'));}
    const directoryRead=run('extracted',['--output','all-observations.jsonl']);
    const all=(await readFile(resolve(fresh,'all-observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    check(directoryRead.status===0&&all.length===manifest.episodeCount,'extracted-directory reader reconstructs every retained observation');
    const overwrite=run('moved-research.zip',['--current','--output','examples.jsonl']);
    check(overwrite.status!==0&&(await readFile(resolve(fresh,'examples.jsonl'),'utf8')).trim().split('\n').length===episodes.length,'reader refuses to overwrite existing example evidence');
    const asset=manifest.files.find(f=>f.role==='retained-project-object');
    for(const mutation of ['missing','tampered','reference','asset-join','judgment','license-missing','license-tampered','permissions-missing','permissions-tampered','readable-tampered','readable-rehashed','readable-mapping','readable-unsafe','readable-duplicate-reference','readable-missing-reference','readable-snapshot','readable-conflicting-declaration','readable-wrong-shared-path','expansion-ratio']){
      const broken=await JSZip.loadAsync(bytes);
      if(mutation.startsWith('license-')||mutation.startsWith('permissions-')){const name=mutation.startsWith('license-')?'LICENSE':'LICENSING.md';if(mutation.endsWith('-missing'))broken.remove(name);else broken.file(name,'SYNTHETIC changed notice');}
      if(mutation.startsWith('readable-')){
        const m=JSON.parse(await broken.file('research-manifest.json').async('string')),copy=m.files.find(f=>f.role==='readable-score');
        if(['readable-mapping','readable-duplicate-reference','readable-missing-reference','readable-snapshot','readable-conflicting-declaration','readable-wrong-shared-path'].includes(mutation)){
          const mapping=JSON.parse(await broken.file('score-files.json').async('string'));
          if(mutation==='readable-mapping')mapping.files[0].assetId='sha256:'+'0'.repeat(64);
          if(mutation==='readable-duplicate-reference')mapping.files.push({...mapping.files[0]});
          if(mutation==='readable-missing-reference')mapping.files.pop();
          if(mutation==='readable-snapshot')mapping.files[0].snapshotId='wrong-snapshot';
          const shared=mapping.files.find(f=>!f.current&&mapping.files.some(g=>g!==f&&g.path===f.path));
          if(mutation==='readable-conflicting-declaration')shared.sha256='0'.repeat(64);
          if(mutation==='readable-wrong-shared-path')shared.path=mapping.files.find(f=>f.assetId!==shared.assetId).path;
          const text=JSON.stringify(mapping);broken.file('score-files.json',text);const entry=m.files.find(f=>f.path==='score-files.json');entry.size=Buffer.byteLength(text);entry.sha256=createHash('sha256').update(text).digest('hex');
        }else if(mutation==='readable-unsafe'){
          const data=await broken.file(copy.path).async('nodebuffer');broken.remove(copy.path);copy.path='scores/current/source/CON.pdf';broken.file(copy.path,data);
        }else {const text='SYNTHETIC tampered readable bytes';broken.file(copy.path,text);if(mutation==='readable-rehashed'){copy.size=Buffer.byteLength(text);copy.sha256=createHash('sha256').update(text).digest('hex');}}
        broken.file('research-manifest.json',JSON.stringify(m));
      }
      if(mutation==='missing')broken.remove(asset.path);
      if(mutation==='tampered')broken.file(asset.path,'SYNTHETIC changed asset');
      if(mutation==='expansion-ratio')broken.file(asset.path,'0'.repeat(1024*1024));
      if(['reference','asset-join','judgment'].includes(mutation)){
        const path=mutation==='judgment'?'episodes.jsonl':'History.json';let text;
        if(path==='History.json'){const index=JSON.parse(await broken.file(path).async('string')),current=index.revisions.find(r=>r.id===index.project.current.recordId);if(mutation==='reference')current.metadata.annotations='sha256:'+'0'.repeat(64);else current.assetIds.ly=current.assetIds.source;text=JSON.stringify(index);}
        else{const records=(await broken.file(path).async('string')).trim().split('\n').map(JSON.parse);records.find(r=>r.current).humanJudgment={state:'fabricated'};text=records.map(r=>JSON.stringify(r)).join('\n')+'\n';}
        broken.file(path,text);const m=JSON.parse(await broken.file('research-manifest.json').async('string')),entry=m.files.find(f=>f.path===path);entry.size=Buffer.byteLength(text);entry.sha256=createHash('sha256').update(text).digest('hex');broken.file('research-manifest.json',JSON.stringify(m));
      }
      const name='invalid-'+mutation+'.zip',output='must-not-exist-'+mutation+'.jsonl';await writeFile(resolve(fresh,name),await broken.generateAsync({type:'nodebuffer',compression:mutation==='expansion-ratio'?'DEFLATE':'STORE'}));const result=run(name,['--output',output]);await writeFile(resolve(evidence,'reader-'+mutation+'.txt'),JSON.stringify(result,null,2));await assert.rejects(access(resolve(fresh,output)));await assert.rejects(access(resolve(fresh,output+'.assets')));check(result.status!==0&&!result.stdout,'reader rejects '+mutation+' before showing examples or writing evidence');
      if(mutation==='expansion-ratio')assert.match(result.stderr,/expansion ratio/);
    }
    // Cancellation/stale-state handling stays in the same backup controller.
    await page.locator('#closeFinish').click();
    await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC rejected result: rhythm still wrong');await page.locator('#sendCorrectionResponse').click();await saved();
    const [rejectedFile]=await Promise.all([page.waitForEvent('download'),page.evaluate(async()=>a.completion.open({research:true}))]);await waitUntil(page,()=>!a.completion.job());
    const rejectedBytes=await readFile(await rejectedFile.path());await writeFile(resolve(fresh,'rejected-result.zip'),rejectedBytes);await writeFile(resolve(evidence,'scorebrush-research-rejected.zip'),rejectedBytes);
    const rejected=run('rejected-result.zip',['--current','--output','rejected-examples.jsonl']);
    const rejectedEpisodes=(await readFile(resolve(fresh,'rejected-examples.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    check(rejected.status===0&&rejectedEpisodes[1].status==='open'&&rejectedEpisodes[1].humanJudgment?.state==='open'&&rejectedEpisodes[1].humanJudgment.explanation==='SYNTHETIC rejected result: rhythm still wrong','rejected correction stays open with its exact scoped human rejection');
    await page.locator('#closeFinish').click();let downloads=0;page.on('download',()=>downloads++);
    await page.evaluate(async()=>{const original=a.completion.io.prepare;a.completion.io.prepare=async(...args)=>{await new Promise(r=>window.releaseResearch=r);return original(...args);};void a.completion.open({research:true});});
    await page.waitForFunction(()=>Boolean(window.releaseResearch));await page.locator('#cancelFinish').click();await page.evaluate(()=>releaseResearch());await waitUntil(page,()=>!a.completion.job());
    check(downloads===0&&await page.locator('#finishDownloads>a').count()===0,'cancelled research export offers no complete archive');
    await writeFile(resolve(evidence,'research-export-measurements.json'),JSON.stringify({elapsedMs,zipBytes:bytes.length,files:manifest.files.length+1,readableCount,uniqueAssets,readableReferences:mapping.files.length,historyRecords:history.revisions.length,episodes:manifest.episodeCount,currentEpisodes:episodes.length,driver:'Installed Edge with isolated OPFS synthetic folder; standalone Python 3.10 reader',fullApplicationLatencyQualification:false},null,2));
    return {name:'research-export',assertions};
  }catch(error){log.push('FAIL '+error.stack);await writeFile(resolve(evidence,'research-export-failure.txt'),await page.locator('body').innerText()).catch(()=>{});await page.screenshot({path:resolve(evidence,'research-export-failure.png'),fullPage:true}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'research-export.txt'),log.join('\n'));await context.close();await server.close();}
}
