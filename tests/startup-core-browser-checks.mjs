// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {waitUntil} from './clean-resume-helpers.mjs';

export async function checkStartupPdfLifecycle({browser,server,evidence,check}){
  const context=await browser.newContext(),page=await context.newPage(),errors=[],measurements=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    window.pdfWorkerAudit={created:0,terminated:0,messages:[]};const Native=window.Worker;
    window.Worker=class extends Native{
      constructor(...args){super(...args);this.syntheticPdfWorker=String(args[0]).includes('pdf.worker');if(this.syntheticPdfWorker)pdfWorkerAudit.created++;}
      postMessage(value,...args){if(this.syntheticPdfWorker&&['GetDocRequest','Terminate'].includes(value?.action))pdfWorkerAudit.messages.push({action:value.action,id:value.data?.docId,target:value.targetName});return super.postMessage(value,...args);}
      terminate(){if(this.syntheticPdfWorker)pdfWorkerAudit.terminated++;return super.terminate();}
    };
  });
  async function open({bad=null,tag='valid'}={}){
    await page.evaluate(async({bad,tag})=>{
      const {fixtureBlob}=await import('./qa/fixtures.js');
      for(const role of ['source','rendered','ly']){const name=role==='ly'?'score.ly':role+'.pdf',blob=role===bad?new Blob(['SYNTHETIC invalid PDF '+tag]):role==='ly'?new Blob(['% SYNTHETIC '+tag+'\n{ c4 d4 }']):await fixtureBlob(name),data=new DataTransfer();data.items.add(new File([blob],name,{type:role==='ly'?'text/plain':'application/pdf'}));document.querySelector('#'+role+'File').files=data.files;}
      document.querySelector('#load').click();
    },{bad,tag});
    await waitUntil(page,async()=>{const a=await import('./app.js');return !a.sessionStatus().busy&&!a.sessionStatus().dirty;});
    return page.evaluate(async()=>{const a=await import('./app.js'),scene=a.completion.capture();return {workspaceId:scene.workspaceId,revisionId:scene.revisionId,pages:scene.doc?.numPages,status:document.querySelector('#fileSetupStatus').textContent,audit:structuredClone(pdfWorkerAudit)};});
  }
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    const initial=await open({tag:'first'});assert(initial.workspaceId);assert.equal(initial.audit.created,1);assert.equal(initial.audit.terminated,0);
    check(true,'the source and rendering open on one explicitly owned shared PDF worker');
    for(const bad of ['source','rendered']){
      const before=await page.evaluate(()=>pdfWorkerAudit.messages.length),failed=await open({bad,tag:'invalid '+bad}),events=failed.audit.messages.slice(before),ids=events.filter(e=>e.action==='GetDocRequest').map(e=>e.id);
      assert.equal(ids.length,2);assert(ids.every(id=>events.some(e=>e.action==='Terminate'&&e.target===id+'_worker')),'both temporary document channels must terminate after '+bad+' fails');
      assert.equal(failed.workspaceId,initial.workspaceId);assert.equal(failed.revisionId,initial.revisionId);assert.equal(failed.audit.created,1);assert.equal(failed.audit.terminated,0);assert.match(failed.status,/PDF|Invalid/i);
      const rendered=await page.evaluate(async()=>{const a=await import('./app.js'),doc=a.completion.capture().doc,page=await doc.getPage(1),canvas=document.createElement('canvas'),viewport=page.getViewport({scale:.15});canvas.width=viewport.width;canvas.height=viewport.height;await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;return canvas.width>0&&canvas.height>0;});assert(rendered);
      check(true,'invalid '+bad+' drains both temporary documents while the current score remains renderable');measurements.push(failed);
    }
    for(const tag of ['second valid','third valid']){const opened=await open({tag});assert.notEqual(opened.workspaceId,initial.workspaceId);assert.equal(opened.audit.created,1);assert.equal(opened.audit.terminated,0);assert.equal(opened.pages,initial.pages);measurements.push(opened);}
    check(true,'subsequent valid opens destroy replaced documents without destroying their shared worker');
    check(!errors.length,'shared-worker failure cleanup leaves no uncaught browser errors');
  }catch(error){measurements.push({failure:error.stack});await page.screenshot({path:resolve(evidence,'startup-core-failure.png')}).catch(()=>{});throw error;}
  finally{await writeFile(resolve(evidence,'startup-core-browser.json'),JSON.stringify(measurements,null,2));await context.close();}
}
export async function runStartupCore({browser,serve,evidence,root}){
  const server=await serve(root),log=[];let assertions=0;const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('startup-core: '+label);};
  try{await checkStartupPdfLifecycle({browser,server,evidence,check});return {name:'startup-core',assertions};}catch(error){log.push('FAIL '+error.stack);throw error;}finally{await writeFile(resolve(evidence,'startup-core.txt'),log.join('\n'));await server.close();}
}
