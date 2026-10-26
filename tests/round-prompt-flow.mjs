// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {seedReviewFocus,focusReady} from './review-focus-flow.mjs';

// Exercise the summary's connected-project contract with a real task builder.
// Folder publication is gated here; disk/CAS behavior is covered by current-review.
export async function exerciseRoundPrompt(page,check){
  const ready=()=>focusReady(page),until=fn=>page.waitForFunction(fn,null,{timeout:30000});
  if(await page.locator('#roundSummary').isVisible()){await page.waitForTimeout(550);await page.locator('#dismissRoundSummary').click();}
  await seedReviewFocus(page);await ready();
  await page.evaluate(async()=>{
    const a=await import('./app.js'),folder=a.folderWorkspace;
    window.promptOriginal={getState:folder.getState,savedPrompt:folder.savedPrompt,saveNow:folder.saveNow};
    window.promptFixture={busy:false,entry:null,calls:0};
    folder.getState=()=>({configured:true,bound:true,ready:true,permission:true,generation:1,lastCheckpointGeneration:1,lastSavedGeneration:1,busy:promptFixture.busy});
    folder.savedPrompt=()=>promptFixture.entry;
    folder.saveNow=async()=>{
      promptFixture.calls++;promptFixture.busy=true;document.dispatchEvent(new Event('score-desk-folder-status'));
      try{await new Promise(resolve=>window.releasePromptPublication=resolve);const scene=a.completion.capture(),{taskForScene}=await import('./folder-workspace.js');
        const entry=await taskForScene(scene,{packageMaker:a.operations.makePackage});promptFixture.entry={entry,text:await entry.payloads.get('PROMPT.txt').text()};return entry;
      }finally{promptFixture.busy=false;document.dispatchEvent(new Event('score-desk-folder-status'));}
    };
  });
  try{
    await page.locator('#stillCorrection').click();await page.locator('#roundExplanation').fill('SYNTHETIC current completed-round explanation');await page.locator('#sendCorrectionResponse').click();await ready();
    for(let i=0;i<3;i++){await page.locator('#looksCorrect').click();await ready();}
    await until(()=>document.querySelector('#roundSummary').open);await page.waitForTimeout(550);
    check(await page.locator('#prepareRoundPrompt').isVisible()&&await page.locator('#prepareRoundPrompt').isEnabled()&&await page.locator('#sendRemaining').isHidden()&&await page.evaluate(()=>promptFixture.calls===0),'completed connected round offers Prepare prompt without automatically publishing a task');
    const before=await page.evaluate(async()=>JSON.stringify((await import('./app.js')).completion.capture().returned));
    await page.locator('#prepareRoundPrompt').click();await until(()=>Boolean(window.releasePromptPublication));
    check(await page.locator('#sendRemaining').isHidden()&&await page.locator('#nextAIPrompt').inputValue()===''&&await page.evaluate(()=>promptFixture.calls===1),'explicit preparation waits for publication and cannot copy a previous prompt');
    await page.evaluate(()=>releasePromptPublication());await until(()=>!document.querySelector('#sendRemaining').hidden&&!document.querySelector('#sendRemaining').disabled);
    const saved=await page.evaluate(()=>({text:promptFixture.entry.text,task:promptFixture.entry.entry.task}));
    check(saved.task.findings.length===1&&saved.task.findings[0].reviewer.explanation==='SYNTHETIC current completed-round explanation'&&await page.locator('#nextAIPrompt').inputValue()===saved.text,'prepared prompt contains only the latest outstanding correction from this completed round');
    await page.locator('#sendRemaining').click();
    check((await page.evaluate(()=>navigator.clipboard.readText())).replace(/\r\n/g,'\n')===saved.text,'Copy prompt uses the freshly published task text exactly');
    assert.equal(await page.evaluate(async()=>JSON.stringify((await import('./app.js')).completion.capture().returned)),before);
    check(await page.evaluate(()=>promptFixture.calls===1),'copying the prepared prompt does not rebuild the task or change decisions');
  }finally{
    await page.evaluate(async()=>Object.assign((await import('./app.js')).folderWorkspace,promptOriginal));
    if(await page.locator('#roundSummary').isVisible())await page.locator('#dismissRoundSummary').click();
  }
}
