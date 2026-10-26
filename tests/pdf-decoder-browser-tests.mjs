// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Image-only JPX pages expose decoder failures that text/geometry PDFs cannot:
// PDF.js can resolve render().promise with an entirely white canvas.
export async function runPdfDecoder({browser,serve,evidence,root}){
  const server=await serve(root,{prefix:'/nested-scorebrush/'}),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],warnings=[],requests=[];
  const jpx=await readFile(new URL('./fixtures/SYNTHETIC-jpx-source.pdf',import.meta.url));let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('pdf-decoder: '+label);};
  page.on('console',entry=>{if(['warning','error'].includes(entry.type()))warnings.push(entry.text());});
  page.on('pageerror',error=>warnings.push(error.message));
  page.on('request',request=>{if(/\/(wasm|iccs|cmaps|standard_fonts)\//.test(request.url()))requests.push(request.url());});
  async function ready(){const end=Date.now()+45000;while(!await page.evaluate(async()=>{const a=await import('./app.js');return Boolean(a.sessionStatus().snapshotId)&&!a.sessionStatus().busy&&!a.sessionStatus().dirty&&['source','rendered'].every(kind=>document.getElementById(kind+'Paper').getAttribute('aria-busy')==='false');})){if(Date.now()>end)throw Error('PDF viewer did not finish opening');await new Promise(resolve=>setTimeout(resolve,30));}}
  async function inputs({imageSource=true,imageRendered=false}={}){
    await page.evaluate(()=>{for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();});
    for(const [id,isImage,name]of [['sourceFile',imageSource,'source.pdf'],['renderedFile',imageRendered,'rendered.pdf']]){
      if(isImage)await page.locator('#'+id).setInputFiles({name:'SYNTHETIC-JPX-'+name,mimeType:'application/pdf',buffer:jpx});
      else await page.evaluate(async({id,name})=>{const blob=await(await import('./qa/fixtures.js')).fixtureBlob(name),transfer=new DataTransfer();transfer.items.add(new File([blob],'SYNTHETIC-'+name));document.getElementById(id).files=transfer.files;},{id,name});
    }
    await page.evaluate(async()=>{const transfer=new DataTransfer();transfer.items.add(new File([await(await import('./qa/fixtures.js')).fixtureBlob('score.ly')],'SYNTHETIC-score.ly'));document.querySelector('#lyFile').files=transfer.files;document.querySelector('#load').click();});await ready();
  }
  const pixels=selector=>page.locator(selector).last().evaluate(canvas=>{const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let dark=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i+3]&&Math.min(bytes[i],bytes[i+1],bytes[i+2])<180)dark++;return {dark,width:canvas.width,height:canvas.height};});
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');await inputs();
    const first=await pixels('#sourceCanvas'),id=await page.evaluate(async()=> (await import('./app.js')).completion.capture().workspaceId);
    check(first.dark>2000,'image-only JPEG2000 source visibly renders through the main viewer');
    check(requests.some(url=>new URL(url).pathname==='/nested-scorebrush/vendor/wasm/openjpeg.wasm')&&!requests.some(url=>url.includes('/vendor/vendor/')),'worker fetches the bundled decoder from the module-relative application directory');
    await page.locator('#newFinding').click();await page.locator('#comment').fill('SYNTHETIC saved note for decoder reopen');await page.locator('#saveFinding').click();await ready();
    await inputs({imageSource:false});check((await pixels('#sourceCanvas')).dark>2000,'switching to another source paints its score');
    await inputs();check((await pixels('#sourceCanvas')).dark>2000&&await page.evaluate(async expected=>{const s=(await import('./app.js')).completion.capture();return s.workspaceId===expected&&s.review.findings.some(f=>f.comment==='SYNTHETIC saved note for decoder reopen');},id),'switching back retains the scanned source and its saved review');
    await page.reload();await ready();check((await pixels('#sourceCanvas')).dark>2000,'reopening the saved scanned source after reload paints nonblank pixels');
    await inputs({imageRendered:true});check((await pixels('#renderedCanvas')).dark>2000,'image-only JPEG2000 rendering uses the same working decoder configuration');
    const comment=await page.evaluate(async()=>{const a=await import('./app.js'),s=a.completion.capture(),{renderCommentImage}=await import('./comment-images.js'),{sha256}=await import('./model.js'),blob=s.files.source.blob,mark={id:'SYNTHETIC-decoder-mark',page:1,strokes:[{points:[[40,40],[45,40]],width:1,color:'#ffd34d',opacity:.35}],bounds:[39,39,46,41]},image=await renderCommentImage({asset:{blob,sha256:await sha256(await blob.arrayBuffer()),pages:[{page:1,view:[0,0,600,600],rotation:0,userUnit:1}]},mark}),bitmap=await createImageBitmap(image),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const bytes=ctx.getImageData(0,0,canvas.width,canvas.height).data;let dark=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i+3]&&Math.min(bytes[i],bytes[i+1],bytes[i+2])<180)dark++;return {dark};});
    check(comment.dark>2000,'historical comment fallback retains the actual scanned score beneath the mark');
    await page.evaluate(async()=>{const {installFolderFiles}=await import('./folder-files-ui.js'),s=(await import('./app.js')).completion.capture(),config={connectionId:'SYNTHETIC-decoder-preview',directory:{name:'SYNTHETIC decoder preview'},paths:{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'}};window.decoderPreview=installFolderFiles({getConfig:()=>config,scan:async()=>['source.pdf'],read:async()=>s.files.source.blob});await window.decoderPreview.show();});
    const dialog=page.locator('#folderFilesDialog').last();await dialog.getByRole('button',{name:'Open source.pdf',exact:true}).click();await page.locator('#folderPdfCanvas').last().waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('#folderPdfCanvas')].at(-1).dataset.renderedPage==='1');
    check((await pixels('#folderPdfCanvas')).dark>2000,'working-folder PDF preview paints the scanned image');
    await page.screenshot({path:resolve(evidence,'pdf-decoder-preview.png')});await dialog.getByRole('button',{name:'Close',exact:true}).click();
    const resources=await page.evaluate(async()=>{const {pdfResourceUrls,pdfWorkerUrl}=await import('./pdf-resources.js');return {...pdfResourceUrls,pdfWorkerUrl};});
    check(Object.values(resources).every(url=>url.startsWith(server.url+'vendor/')),'all PDF.js worker and resource URLs remain absolute and inside the installed app');
    check(!warnings.some(text=>/Unable to decode image|failed to initialize|Failed to fetch|Dependent image/i.test(text)),'source, history and preview render without decoder warnings');
    await page.screenshot({path:resolve(evidence,'pdf-decoder-viewers.png')});
    return {name:'pdf-decoder',assertions};
  }catch(error){await page.screenshot({path:resolve(evidence,'pdf-decoder-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'pdf-decoder.txt'),log.join('\n')+'\n'+warnings.map(text=>'BROWSER '+text).join('\n'));await writeFile(resolve(evidence,'pdf-decoder-requests.json'),JSON.stringify(requests,null,2));await context.close();await server.close();}
}
