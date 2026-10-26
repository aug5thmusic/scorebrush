// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {exerciseReviewFocus} from './review-focus-flow.mjs';
export async function runReviewFocus({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('review-focus: '+label);};page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(server.url);await page.waitForFunction(()=>document.body.dataset.ready==='true');
    for(const start of ['row','button','score'])await exerciseReviewFocus(page,start,check,name=>page.screenshot({path:resolve(evidence,'review-focus-'+name+'.png')}));
    check(!errors.length,'no uncaught browser errors: '+errors.join('; '));return {name:'review-focus',assertions};
  }catch(error){log.push('FAIL '+error.stack);await page.screenshot({path:resolve(evidence,'review-focus-failure.png')});throw error;}
  finally{await writeFile(resolve(evidence,'review-focus.txt'),log.join('\n')+'\n');await context.close();await server.close();}
}
