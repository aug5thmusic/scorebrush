// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Reproducible browser tests. Always creates disposable browser contexts and a
// fresh loopback server; never connects to the user's running browser.
import {createServer} from 'node:http';
import {readFile, stat, mkdir, writeFile} from 'node:fs/promises';
import {resolve, relative, extname, sep} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
const root=resolve(process.argv.find(arg=>arg.startsWith('--app-root='))?.slice(11)??resolve(repository,'app'));
const moduleName=process.env.SCORE_DESK_PLAYWRIGHT;
const {chromium}=await import(moduleName?pathToFileURL(resolve(moduleName)).href:'playwright');
export const evidence=resolve(repository,'test-results',new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(evidence,{recursive:true});
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.pdf':'application/pdf','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};

export async function serve(directory,{prefix='/'}={}){
  directory=resolve(directory);
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(!url.pathname.startsWith(prefix)){res.writeHead(404).end();return;}
      const requestPath=decodeURIComponent(url.pathname.slice(prefix.length)),servingRoot=requestPath.startsWith('qa/')?resolve(repository,'app'):directory;
      let path=resolve(servingRoot,requestPath||'.');
      if(relative(servingRoot,path).startsWith('..'+sep)||relative(servingRoot,path)==='..'){res.writeHead(403).end();return;}
      if((await stat(path)).isDirectory())path=resolve(path,'index.html');
      res.writeHead(200,{'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':'no-store'}).end(await readFile(path));
    }catch{res.writeHead(404).end('Not found');}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  assert(!['8939','8945','8964','8967','8995'].includes(String(server.address().port)));
  return {origin,url:origin+prefix,close:()=>new Promise(r=>server.close(r))};
}

const browser=await chromium.launch({headless:true,...(process.env.SCORE_DESK_BROWSER_CHANNEL?{channel:process.env.SCORE_DESK_BROWSER_CHANNEL}:{})});
let services=[];
const results=[];
const defaultSuites=['empty-evidence','load-progress','startup-paint','draft-autosave','annotation-undo','folder-location','revision-views','round-summary','review-context','review-controls','review-focus','send-to-ai','branding','project-entry','new-project-cancel','background-review','new-finding-visibility','application-shell','brush','desk','workflow','comparison','private','usability','header-handoff','workspace-layout','ui-polish','focus-shortcuts','pdf-wheel-zoom','button-spacing','internal-comments','simple-backup'];
const selected=process.argv.find(arg=>arg.startsWith('--suites='))?.slice(9).split(',')??defaultSuites;
const included=name=>selected.includes(name);
async function record(page,name){
  const text=await page.locator('#results').innerText();
  await writeFile(resolve(evidence,name+'.txt'),text);
  if(/(^|\n)FAIL\b/.test(text)||!/ALL .*PASSED/.test(text)){
    await page.screenshot({path:resolve(evidence,name+'-failure.png'),fullPage:true});
    throw new Error(name+' failed:\n'+text);
  }
  const count=(text.match(/^PASS\b/gm)||[]).length;
  results.push({name,assertions:count});console.log(`${name}: ${count} assertions passed`);
}
async function runSuite(context,url,name){
  const page=await context.newPage();await page.goto(url);await page.locator('#run').click();
  await page.waitForFunction(()=>/ALL .*PASSED|\bFAIL\b/.test(document.querySelector('#results')?.textContent||''),null,{timeout:180000});
  await record(page,name);await page.close();
}
try{
  for(const name of selected)assert([...defaultSuites,'races','pdf-names','clean-resume','startup-typography','startup-storage','findings-editor','review-note-enter','integrated-audit','save-progress','fast-resume','startup-core','current-review','current-handoff','current-completion','current-baseline','current-baseline-legacy','storage-evidence','storage-inputs','large-history','pdf-decoder','project-source','interrupted-save','interrupted-archive','folder-settings','recovery-edit'].includes(name),'Unknown browser suite: '+name);
  {
    const server=await serve(root);services.push(server);
    const context=await browser.newContext({viewport:{width:1440,height:1000}});
    for(const [path,name] of [['index','brush'],['desk','desk'],['workflow','workflow']])if(included(name))await runSuite(context,server.url+`qa/${path}.html`,name);
    if(included('races')){
    const races=await context.newPage();await races.goto(server.url+'qa/races.html');
    const tabs=[];
    for(const slot of ['A','B']){const tab=await context.newPage();await tab.goto(new URL(await races.locator('#open'+slot).getAttribute('href'),races.url()).href);tabs.push(tab);}
    await races.locator('#run').click();
    await races.waitForFunction(()=>!document.querySelector('#continue').hidden||document.querySelector('#results').classList.contains('fail'),null,{timeout:180000});
    if(await races.locator('#continue').isVisible()){await tabs[0].frameLocator('#app').locator('#finishDialog').press('Escape');await races.locator('#continue').click();}
    await races.waitForFunction(()=>/ALL .*PASSED|\bFAIL\b/.test(document.querySelector('#results').textContent),null,{timeout:180000});
    await record(races,'races');}
    await context.close();
    if(included('comparison')){
      const {runComparison}=await import('./comparison-browser-tests.mjs');
      results.push(await runComparison({browser,serve,evidence,root}));
    }
  }
  if(included('empty-evidence')){const {runEmptyEvidence}=await import('./empty-evidence-browser-tests.mjs');results.push(await runEmptyEvidence({browser,serve,evidence,root}));}
  if(included('load-progress')){const {runLoadProgress}=await import('./load-progress-browser-tests.mjs');results.push(await runLoadProgress({browser,serve,evidence,root}));}
  if(included('startup-paint')){const {runStartupPaint}=await import('./startup-paint-browser-tests.mjs');results.push(await runStartupPaint({browser,serve,evidence,root}));}
  if(included('draft-autosave')){const {runDraftAutosave}=await import('./draft-autosave-browser-tests.mjs');results.push(await runDraftAutosave({browser,serve,evidence,root}));}
  if(included('annotation-undo')){const {runAnnotationUndo}=await import('./annotation-undo-browser-tests.mjs');results.push(await runAnnotationUndo({browser,serve,evidence,root}));}
  if(included('storage-evidence')){const {runStorageEvidence}=await import('./storage-evidence-browser-tests.mjs');results.push(await runStorageEvidence({browser,serve,evidence,root}));}
  if(included('storage-inputs')){const {runStorageInputs}=await import('./storage-inputs-browser-tests.mjs');results.push(await runStorageInputs({browser,serve,evidence,root}));}
  if(included('pdf-decoder')){const {runPdfDecoder}=await import('./pdf-decoder-browser-tests.mjs');results.push(await runPdfDecoder({browser,serve,evidence,root}));}
  if(included('folder-location')){const {runFolderLocation}=await import('./folder-location-browser-tests.mjs');results.push(await runFolderLocation({browser,serve,evidence,root}));}
  if(included('revision-views')){const {runRevisionViews}=await import('./revision-views-browser-tests.mjs');results.push(await runRevisionViews({browser,serve,evidence,root}));}
  if(included('round-summary')){const {runRoundSummary}=await import('./round-summary-browser-tests.mjs');results.push(await runRoundSummary({browser,serve,evidence,root}));}
  if(included('review-controls')){const {runReviewControls}=await import('./review-controls-browser-tests.mjs');results.push(await runReviewControls({browser,serve,evidence,root}));}
  if(included('review-focus')){const {runReviewFocus}=await import('./review-focus-browser-tests.mjs');results.push(await runReviewFocus({browser,serve,evidence,root}));}
  if(included('send-to-ai')){const {runSendToAI}=await import('./send-to-ai-browser-tests.mjs');results.push(await runSendToAI({browser,serve,evidence,root}));}
  if(included('startup-typography')){const {runStartupTypography}=await import('./startup-typography-browser-tests.mjs');results.push(await runStartupTypography({browser,serve,evidence,root}));}
  if(included('startup-storage')){const {runStartupStorage}=await import('./startup-storage-browser-tests.mjs');results.push(await runStartupStorage({browser,serve,evidence,root}));}
  if(included('review-note-enter')){const {runReviewNoteEnter}=await import('./review-note-enter-browser-tests.mjs');results.push(await runReviewNoteEnter({browser,serve,evidence,root}));}
  if(included('findings-editor')){const {runFindingsEditor}=await import('./findings-editor-browser-tests.mjs');results.push(await runFindingsEditor({browser,serve,evidence,root}));}
  if(included('branding')){const {runBranding}=await import('./branding-browser-tests.mjs');results.push(await runBranding({browser,serve,evidence,root}));}
  if(included('project-entry')||included('project-source')){const {runProjectEntry}=await import('./project-entry-browser-tests.mjs');results.push(await runProjectEntry({browser,serve,evidence,root,sourceOnly:included('project-source')&&!included('project-entry')}));}
  if(included('new-project-cancel')){const {runNewProjectCancel}=await import('./new-project-cancel-browser-tests.mjs');results.push(await runNewProjectCancel({browser,serve,evidence,root}));}
  if(included('background-review')){const {runBackgroundReview}=await import('./background-review-browser-tests.mjs');results.push(await runBackgroundReview({browser,serve,evidence,root}));}
  if(included('new-finding-visibility')){const {runNewFindingVisibility}=await import('./new-finding-visibility-browser-tests.mjs');results.push(await runNewFindingVisibility({browser,serve,evidence,root}));}
  if(included('application-shell')){const {runApplicationShell}=await import('./application-shell-browser-tests.mjs');results.push(await runApplicationShell({browser,serve,evidence,root}));}
  if(included('private')){const {runPrivate}=await import('./private-browser-tests.mjs');results.push(await runPrivate({browser,serve,evidence,root}));}
  if(included('usability')){const {runUsability}=await import('./usability-browser-tests.mjs');results.push(await runUsability({browser,serve,evidence,root}));}
  if(included('header-handoff')){const {runHeaderHandoff}=await import('./header-handoff-browser-tests.mjs');results.push(await runHeaderHandoff({browser,serve,evidence,root}));}
  if(included('workspace-layout')){const {runWorkspaceLayout}=await import('./workspace-layout-browser-tests.mjs');results.push(await runWorkspaceLayout({browser,serve,evidence,root}));}
  if(included('ui-polish')){const {runUiPolish}=await import('./ui-polish-browser-tests.mjs');results.push(await runUiPolish({browser,serve,evidence,root}));}
  if(included('focus-shortcuts')){const {runFocusShortcuts}=await import('./focus-shortcuts-browser-tests.mjs');results.push(await runFocusShortcuts({browser,serve,evidence,root}));}
  if(included('pdf-wheel-zoom')){const {runPdfWheelZoom}=await import('./pdf-wheel-zoom-browser-tests.mjs');results.push(await runPdfWheelZoom({browser,serve,evidence,root}));}
  if(included('button-spacing')){const {runButtonSpacing}=await import('./button-spacing-browser-tests.mjs');results.push(await runButtonSpacing({browser,serve,evidence,root}));}
  if(included('review-context')){const {runReviewContext}=await import('./review-context-browser-tests.mjs');results.push(await runReviewContext({browser,serve,evidence,root}));}
  if(included('internal-comments')){const {runInternalComments}=await import('./internal-comments-browser-tests.mjs');results.push(await runInternalComments({browser,serve,evidence,root}));}
  if(included('simple-backup')){const {runSimpleBackup}=await import('./simple-backup-browser-tests.mjs');results.push(await runSimpleBackup({browser,serve,evidence,root}));}
  if(included('large-history')){const {runPdfNames}=await import('./pdf-names-browser-tests.mjs');results.push(await runPdfNames({browser,serve,evidence,root,largeOnly:true}));}
  if(included('pdf-names')){const {runPdfNames}=await import('./pdf-names-browser-tests.mjs');results.push(await runPdfNames({browser,serve,evidence,root}));}
  if(included('clean-resume')){const {runCleanResume}=await import('./clean-resume-browser-tests.mjs');results.push(await runCleanResume({browser,serve,evidence,root}));}
  if(included('save-progress')){const {runSaveProgress}=await import('./save-progress-browser-checks.mjs');results.push(await runSaveProgress({browser,serve,evidence,root}));}
  if(included('fast-resume')){const {runFastResume}=await import('./fast-resume-browser-checks.mjs');results.push(await runFastResume({browser,serve,evidence,root}));}
  if(included('current-handoff')){const {runCurrentHandoff}=await import('./current-handoff-browser-tests.mjs');results.push(await runCurrentHandoff({browser,serve,evidence,root}));}
  if(included('current-completion')){const {runCurrentCompletion}=await import('./current-completion-browser-tests.mjs');results.push(await runCurrentCompletion({browser,serve,evidence,root}));}
  if(included('current-baseline')){const {runCurrentCompletion}=await import('./current-completion-browser-tests.mjs');results.push(await runCurrentCompletion({browser,serve,evidence,root,baselineRace:true}));}
  if(included('current-baseline-legacy')){const {runCurrentCompletion}=await import('./current-completion-browser-tests.mjs');results.push(await runCurrentCompletion({browser,serve,evidence,root,legacyOnly:true}));}
  if(included('current-review')){const {runCurrentReview}=await import('./current-review-browser-tests.mjs');results.push(await runCurrentReview({browser,serve,evidence,root}));}
  if(included('recovery-edit')){const {runRecoveryEdit}=await import('./recovery-edit-browser-tests.mjs');results.push(await runRecoveryEdit({browser,serve,evidence,root}));}
  if(included('interrupted-save')){const {runInterruptedSave}=await import('./interrupted-save-browser-tests.mjs');results.push(await runInterruptedSave({browser,serve,evidence,root}));}
  if(included('interrupted-archive')){const {runInterruptedArchive}=await import('./interrupted-archive-browser-tests.mjs');results.push(await runInterruptedArchive({browser,serve,evidence,root}));}
  if(included('folder-settings')){const {runFolderSettings}=await import('./folder-settings-browser-tests.mjs');results.push(await runFolderSettings({browser,serve,evidence,root}));}
  if(included('startup-core')){const {runStartupCore}=await import('./startup-core-browser-checks.mjs');results.push(await runStartupCore({browser,serve,evidence,root}));}
  if(included('integrated-audit')){const {runIntegratedAudit}=await import('./integrated-audit-browser-tests.mjs');results.push(await runIntegratedAudit({browser,serve,evidence,root}));}
  console.log(JSON.stringify({results,evidence},null,2));
}catch(error){console.error(error);process.exitCode=1;}
finally{await browser.close();for(const service of services)await service.close();}



