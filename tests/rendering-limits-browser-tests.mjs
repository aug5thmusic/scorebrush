// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {menuCommand} from './menu-actions.mjs';

export async function runRenderingLimits({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:3}),page=await context.newPage(),log=[],errors=[],report={};let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('rendering-limits: '+label);};
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.displayAllocations=[];
    for(const property of ['width','height']){const original=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,property);Object.defineProperty(HTMLCanvasElement.prototype,property,{...original,set(value){original.set.call(this,value);if(['sourceCanvas','renderedCanvas','overlay','historicalOverlay','folderPdfCanvas'].includes(this.id))window.displayAllocations.push({id:this.id,width:this.width,height:this.height});}});}
  });
  const painted=()=>page.waitForFunction(()=>{const a=window.renderingTestApi;return Boolean(a.completion.capture().review)&&!a.sessionStatus().busy&&['source','rendered'].every(kind=>parseFloat(document.querySelector('#'+kind+'Paper').style.width)>0&&document.querySelector('#'+kind+'Paper').getAttribute('aria-busy')==='false'&&!['true','gesture'].includes(document.querySelector('#'+kind+'Paper').dataset.resizePending));},null,{timeout:60000});
  const state=()=>page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return JSON.stringify({review:s.review,returned:s.returned,revisionId:s.revisionId});});
  const geometry=()=>page.evaluate(()=>Object.fromEntries(['source','rendered'].map(kind=>{const canvas=document.querySelector('#'+kind+'Canvas'),paper=document.querySelector('#'+kind+'Paper'),scroll=document.querySelector('#'+kind+'Scroll');return [kind,{width:canvas.width,height:canvas.height,cssWidth:parseFloat(paper.style.width),cssHeight:parseFloat(paper.style.height),available:scroll.clientWidth-38,zoom:document.querySelector('#'+kind+'Zoom').value}];})));
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await page.evaluate(async()=>window.renderingTestApi=await import('./app.js'));await page.locator('#closeWorkspace').click();await menuCommand(page,'File','files');await page.locator('#filesPanel>summary').click();
    await page.evaluate(async()=>{
      async function pdf(label){const doc=await PDFLib.PDFDocument.create();doc.setTitle('SYNTHETIC '+label);
        for(const [width,height]of [[14400,14400],[100,14400],[14400,100]]){const p=doc.addPage([width,height]);p.node.set(PDFLib.PDFName.of('UserUnit'),PDFLib.PDFNumber.of(10));p.drawRectangle({x:0,y:0,width:width/2,height:height/2,color:PDFLib.rgb(.95,.95,.95)});}
        const p=doc.addPage([1000,2000]);p.setCropBox(100,200,700,1500);p.setRotation(PDFLib.degrees(90));p.node.set(PDFLib.PDFName.of('UserUnit'),PDFLib.PDFNumber.of(2));
        return new Blob([await doc.save()],{type:'application/pdf'});
      }
      const blobs={sourceFile:await pdf('SOURCE GEOMETRY'),renderedFile:await pdf('RENDER GEOMETRY'),lyFile:new Blob(['% SYNTHETIC display limits only\n'])};
      for(const [id,blob]of Object.entries(blobs)){const data=new DataTransfer();data.items.add(new File([blob],id==='lyFile'?'SYNTHETIC.ly':'SYNTHETIC-'+id+'.pdf'));document.getElementById(id).files=data.files;}
    });
    await page.locator('#load').click();await page.waitForFunction(()=>document.body.classList.contains('review-open')&&parseFloat(document.querySelector('#renderedPaper').style.width)>0);await painted();report.fit=await geometry();
    check(Object.values(report.fit).every(v=>Math.abs(v.cssWidth-v.available)<1),'very large pages fit their pane below the former 15% minimum');
    check(await page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture();return s.review.pages[0].userUnit===10&&s.doc.numPages===4;}),'synthetic fixture covers large UserUnit and four distinct page geometries');
    await page.locator('#newFinding').click();await painted();const box=await page.locator('#overlay').boundingBox(),start={x:box.x+box.width*.25,y:box.y+box.height*.25},end={x:box.x+box.width*.45,y:box.y+box.height*.25};
    await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:5});await page.mouse.up();await page.locator('#comment').fill('SYNTHETIC geometry must survive display scaling');await page.locator('#comment').press('Enter');await painted();
    report.stroke=await page.evaluate(async()=>{const s=(await import('./app.js')).completion.capture(),mark=s.review.findings[0],points=mark.strokes[0].points;return {first:points[0],last:points.at(-1),view:s.review.pages[0].view};});
    check(Math.abs(report.stroke.first[0]/14400-.25)<.005&&Math.abs(report.stroke.last[0]/14400-.45)<.005&&Math.abs(report.stroke.first[1]/14400-.75)<.005,'drawing on a tiny fitted scale saves the expected original PDF coordinates');
    const baseline=await state();
    await page.locator('#renderedZoom').selectOption('3');await painted();report.maximum=await geometry();
    check(report.maximum.rendered.width*report.maximum.rendered.height<=16000000&&Math.max(report.maximum.rendered.width,report.maximum.rendered.height)<=8192,'300% at DPR3 respects total-pixel and per-dimension backing limits');
    check(Math.max(report.maximum.rendered.cssWidth,report.maximum.rendered.cssHeight)<=32768,'large numeric zoom also caps the CSS surface at a browser-manageable size');
    const hover=await page.locator('#renderedScroll').boundingBox();await page.mouse.move(hover.x+80,hover.y+80);
    await page.keyboard.down('Control');await page.mouse.wheel(0,100);await page.keyboard.up('Control');await page.waitForTimeout(60);await painted();
    check(await page.locator('#renderedZoom').inputValue()==='2','wheel-down from capped 300% advances to the requested 200% step without getting stuck');
    for(const number of [2,3,4,1]){await page.locator('#renderedPage').fill(String(number));await page.locator('#renderedPage').blur();await painted();}
    report.changedPages=await geometry();check(await state()===baseline,'zooming and tall/wide/cropped/rotated page navigation preserve the complete review');
    report.opacity=await page.evaluate(async()=>{const {paint}=await import('./model.js'),viewport={width:400,height:200,scale:1,userUnit:1,convertToViewportPoint:(x,y)=>[x,y]},finding={number:1,page:1,strokes:[{points:[[100,100],[200,100]],color:'#443dd0',width:12,opacity:.35}]};
      const sample=alpha=>{const c=document.createElement('canvas');c.width=400;c.height=200;const ctx=c.getContext('2d');ctx.globalAlpha=alpha;paint(ctx,viewport,[finding],1);return {stroke:ctx.getImageData(150,100,1,1).data[3],marker:ctx.getImageData(93,86,1,1).data[3],caller:ctx.globalAlpha};};return {faded:sample(.3),selected:sample(1)};});
    check(Math.abs(report.opacity.faded.stroke/report.opacity.selected.stroke-.3)<.02&&Math.abs(report.opacity.faded.marker/report.opacity.selected.marker-.3)<.02,'real canvas pixels fade both historical strokes and their number markers to30%');
    check(report.opacity.selected.stroke>=99&&report.opacity.selected.marker===255&&report.opacity.faded.caller===.3,'selected markers keep their prior opacity and the painter restores caller state');
    report.export=await page.evaluate(async()=>{
      const {makePackage,makeRecovery}=await import('./export.js'),{identify,newReview,blobHash}=await import('./model.js'),pdfjs=await import('./vendor/pdf.mjs'),{pdfResourceUrls}=await import('./pdf-resources.js');
      const pdf=await PDFLib.PDFDocument.create();pdf.addPage([100,14400]);const blob=new Blob([await pdf.save()],{type:'application/pdf'}),files={source:{name:'SYNTHETIC-source.pdf',blob},rendered:{name:'SYNTHETIC-thin.pdf',blob},ly:{name:'SYNTHETIC.ly',blob:new Blob(['% SYNTHETIC export axis limit\n'])}};
      const doc=await pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),...pdfResourceUrls,isEvalSupported:false}).promise;
      try{
        const p=await doc.getPage(1),viewport=p.getViewport({scale:3}),{identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit}]);
        review.findings=[{id:'synthetic-axis-note',number:1,page:1,type:'comment',strokes:[],bounds:null,state:'open',comment:'SYNTHETIC text-only note'}];review.nextNumber=2;const original=JSON.stringify(review),create=document.createElement.bind(document);let canvases=0,error='';
        document.createElement=function(tag,...args){if(tag==='canvas')canvases++;return create(tag,...args);};
        try{await makePackage(review,files,doc,'page');}catch(e){error=e.message;}finally{document.createElement=create;}
        const recovery=await makeRecovery(review,files),manifest=JSON.parse(await recovery.get('manifest.json').text());
        return {width:viewport.width,height:viewport.height,canvases,error,unchanged:JSON.stringify(review)===original&&JSON.stringify(JSON.parse(await recovery.get('annotations.json').text()))===original,exact:recovery.get('source-original.pdf')===blob&&recovery.get('rendered-original.pdf')===blob&&manifest.payloads['rendered-original.pdf'].sha256===await blobHash(blob)};
      }finally{await doc.loadingTask.destroy();}
    });
    check(report.export.width*report.export.height<32000000&&report.export.height>16384&&report.export.canvases===0&&/export pixel limit/.test(report.export.error),'thin PDF below the total export pixel budget is rejected before allocating an unsupported canvas axis');
    check(report.export.unchanged&&report.export.exact,'export size rejection retains exact annotations and original PDFs in recovery');
    await page.evaluate(async()=>{
      // The preview receives an in-memory synthetic folder adapter. No directory
      // picker or real workspace is involved.
      document.querySelector('#folderFilesDialog').remove();const {installFolderFiles}=await import('./folder-files-ui.js'),blob=window.renderingTestApi.completion.capture().files.rendered.blob;
      const config={connectionId:'synthetic-rendering-preview',directory:{name:'SYNTHETIC'},paths:{rendered:'SYNTHETIC.pdf'}};
      await installFolderFiles({getConfig:()=>config,scan:async()=>['SYNTHETIC.pdf'],read:async()=>blob}).show();
    });
    await page.locator('#folderFilesDialog .folder-file-open').click();await page.waitForFunction(()=>document.querySelector('#folderPdfCanvas').dataset.renderedPage==='1');
    for(const number of [2,3,4]){await page.locator('#folderFilesDialog').getByRole('button',{name:'Next page',exact:true}).click();await page.waitForFunction(number=>document.querySelector('#folderPdfCanvas').dataset.renderedPage===String(number),number);}
    report.preview=await page.locator('#folderPdfCanvas').evaluate(c=>({width:c.width,height:c.height,cssWidth:parseFloat(c.style.width),cssHeight:parseFloat(c.style.height)}));
    await page.locator('#closeFolderFiles').click();
    check(report.preview.width*report.preview.height<=16000000&&Math.max(report.preview.width,report.preview.height)<=8192&&await state()===baseline,'folder PDF previews render the same varied geometries without changing the open review');
    report.allocations=await page.evaluate(()=>window.displayAllocations);
    check(report.allocations.every(v=>v.width<=8192&&v.height<=8192&&v.width*v.height<=16000000),'every intermediate PDF and overlay allocation stays bounded during page and zoom changes');
    check(errors.length===0,'large-page rendering produces no uncaught browser errors: '+errors.join('; '));
    return {name:'rendering-limits',assertions};
  }catch(error){log.push('FAIL '+error.stack);throw error;}
  finally{await writeFile(resolve(evidence,'rendering-limits.txt'),log.join('\n')+'\n');await writeFile(resolve(evidence,'rendering-limits.json'),JSON.stringify(report,null,2));await context.close();await server.close();}
}
