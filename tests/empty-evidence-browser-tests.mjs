// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Synthetic PDFs only, isolated browser context. Exercise real export/import and
// returned-round evidence: avoiding an empty raster must not erase older notes.
export async function runEmptyEvidence({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage(),errors=[],log=[];let assertions=0;
  page.on('pageerror',e=>errors.push(e.message));
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('empty-evidence: '+label);};
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    const results=await page.evaluate(async()=>{
      const {fixtureBlob}=await import('./qa/fixtures.js'),{identify,newReview,bounds,blobHash}=await import('./model.js');
      const {makePackage}=await import('./export.js'),{makeTask,hydrateTaskPayloads,readPackagePayloads,responseRevision}=await import('./workflow.js');
      const {workspaceSeed,followupTask}=await import('./returned.js'),{rawFolderResponse}=await import('./folder-workspace.js');
      const pdfjs=await import('./vendor/pdf.mjs'),{pdfResourceUrls}=await import('./pdf-resources.js');
      const files={source:{name:'source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:'rendered.pdf',blob:await fixtureBlob('rendered.pdf')},ly:{name:'score.ly',blob:await fixtureBlob('score.ly')}};
      const open=async blob=>pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),...pdfResourceUrls,isEvalSupported:false}).promise;
      const inspect=async inputs=>{const doc=await open(inputs.rendered.blob),pages=[];try{for(let n=1;n<=doc.numPages;n++){const p=await doc.getPage(n);pages.push({page:n,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}return pages;}finally{await doc.destroy();}};
      const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,await inspect(files));
      const doc=await open(files.rendered.blob),r={},forbiddenDoc={numPages:doc.numPages,getPage(){throw Error('Empty export must not render pages');}};
      const create=document.createElement.bind(document),OriginalWorker=window.Worker;let canvases=0,workers=0;
      document.createElement=function(tag,...args){if(tag==='canvas')canvases++;return create(tag,...args);};
      window.Worker=class extends OriginalWorker{constructor(url,...args){if(String(url).includes('evidence-worker'))workers++;super(url,...args);}};
      try{
        const empty=await makePackage(review,files,forbiddenDoc,'120'),manifest=JSON.parse(await empty.get('manifest.json').text());
        r.noRaster=canvases===0&&workers===0;
        r.exactPDF=empty.get('rendered-marked.pdf')===files.rendered.blob&&await blobHash(empty.get('rendered-marked.pdf'))===identity.rendered.sha256;
        r.metadata=JSON.stringify(JSON.parse(await empty.get('annotations.json').text()))===JSON.stringify(review)&&Object.keys(manifest.context.filesByFinding).length===0&&manifest.rendering.markedPdf.includes('byte-identical')&&empty.has('guidance/review-guide.txt')&&empty.has('review.txt')&&empty.has('internal-comments.txt');
        const imported=await readPackagePayloads(empty,inspect);r.packageRoundtrip=imported.review.snapshotId===snapshotId&&imported.review.findings.length===0&&await blobHash(imported.files.rendered.blob)===identity.rendered.sha256;
        const task=await makeTask(review,files,forbiddenDoc,'120'),restored=await hydrateTaskPayloads(task.payloads,inspect,{expectedId:task.id});
        r.taskRoundtrip=restored.task.id===task.id&&restored.task.baseline.annotationSha256===await blobHash(task.payloads.get('annotations.json'))&&restored.task.findings.length===0;
        const cancelled=new AbortController();cancelled.abort();try{await makePackage(review,files,forbiddenDoc,'120',()=>{},{signal:cancelled.signal});r.abortBefore=false;}catch(e){r.abortBefore=e.name==='AbortError';}
        const pending=new AbortController(),fetchOriginal=window.fetch;window.fetch=async(...args)=>{const response=await fetchOriginal(...args);if(String(args[0]).includes('review-guide'))pending.abort();return response;};
        try{await makePackage(review,files,forbiddenDoc,'120',()=>{},{signal:pending.signal});r.abortDuring=false;}catch(e){r.abortDuring=e.name==='AbortError';}finally{window.fetch=fetchOriginal;}
        const base={id:'synthetic-note',number:1,page:1,color:'#ffd34d',strokes:[],bounds:null,state:'open',comment:'SYNTHETIC text-only note — retain this wording'};
        for(const type of ['correction','comment']){
          const note=structuredClone(review);note.nextNumber=2;note.findings=[{...base,type}];const before=workers,pkg=await makePackage(note,files,doc,'120');
          const m=JSON.parse(await pkg.get('manifest.json').text()),paths=m.context.filesByFinding[base.id];
          r[type]=workers>before&&await blobHash(pkg.get('rendered-marked.pdf'))!==identity.rendered.sha256&&paths.length===2&&paths.every(path=>pkg.get(path)?.size>0)&&JSON.parse(await pkg.get('annotations.json').text()).findings[0].comment===base.comment;
        }
        const marked=structuredClone(review),strokes=[{width:4,points:[[70,640],[140,635]]}];marked.nextNumber=2;marked.findings=[{...base,strokes,bounds:bounds(strokes)}];
        const before=workers,issued=await makeTask(marked,files,doc,'120');r.marked=workers>before&&await blobHash(issued.payloads.get('rendered-marked.pdf'))!==identity.rendered.sha256;
        const updated={...files,rendered:{name:'updated.pdf',blob:await fixtureBlob('multipage.pdf')}};
        const entry=responseRevision(await rawFolderResponse(issued,updated)),seed=await workspaceSeed(entry,issued,inspect),beforeFollowup={canvases,workers};
        const followup=await followupTask({...seed,doc:forbiddenDoc},'120',()=>{},makePackage,{lookup:async id=>id===issued.id?issued:id===entry.id?entry:null});
        const finding=followup.task.findings[0],oldPaths=seed.returned.reported[0].context,history=finding.historicalContext;
        r.historicalNoRaster=seed.review.findings.length===0&&canvases===beforeFollowup.canvases&&workers===beforeFollowup.workers&&await blobHash(followup.payloads.get('rendered-marked.pdf'))===seed.review.files.rendered.sha256;
        r.historicalEvidence=finding.comment===base.comment&&finding.currentAnchor===null&&finding.page===null&&await blobHash(followup.payloads.get(history.marked))===await blobHash(issued.payloads.get(oldPaths[0]))&&await blobHash(followup.payloads.get(history.clean))===await blobHash(issued.payloads.get(oldPaths[1]))&&await blobHash(followup.payloads.get('historical/previous-rendering.pdf'))===identity.rendered.sha256&&JSON.stringify(JSON.parse(await followup.payloads.get(history.annotations).text()))===JSON.stringify(marked);
        r.historicalOriginals=true;for(const [role,info]of Object.entries(history.originalFiles))r.historicalOriginals&&=await blobHash(followup.payloads.get(info.path))===identity[role].sha256;
        const hydrated=await hydrateTaskPayloads(followup.payloads,inspect,{expectedId:followup.id});r.followupRoundtrip=JSON.stringify(hydrated.task)===JSON.stringify(followup.task)&&hydrated.review.findings.length===0;
      }finally{document.createElement=create;window.Worker=OriginalWorker;await doc.destroy();}
      return r;
    });
    const labels={noRaster:'zero findings create no canvas or evidence worker',exactPDF:'zero findings preserve the exact original PDF as marked output',metadata:'empty export retains annotations, guidance and truthful rendering metadata',packageRoundtrip:'empty package imports with exact input identity',taskRoundtrip:'empty task imports with exact task and annotation identity',abortBefore:'already aborted export stops before work',abortDuring:'abort during guidance loading stops empty export',correction:'text-only correction still renders context and printed note index',comment:'internal comment still renders context and printed note index',marked:'marked finding still creates annotated PDF evidence',historicalNoRaster:'unlocated historical findings do not rasterize the empty current score',historicalEvidence:'follow-up retains exact historical images, annotations and prior PDF',historicalOriginals:'historical original PDF and LilyPond bytes remain associated correctly',followupRoundtrip:'historical follow-up imports with all exact task metadata'};
    for(const [key,label]of Object.entries(labels))check(results[key],label);
    check(!errors.length,'no uncaught errors: '+errors.join('; '));
    return {name:'empty-evidence',assertions};
  }catch(e){log.push('FAIL '+e.stack);throw e;}
  finally{await writeFile(resolve(evidence,'empty-evidence.txt'),log.join('\n'));await context.close();await server.close();}
}
