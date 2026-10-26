// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Synthetic files and disposable in-memory ZIPs; no user scores or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview,clone,validateReview,findingType} from '../app/model.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {makeTask,hydrateTaskPackage,localTaskDelivery,readPackage,readResponse,responseRevision,json,seal} from '../app/workflow.js';
import {workspaceSeed,followupTask,makeReturnedBackup,restoreReturnedBackup} from '../app/returned.js';
import {exactReview,annotationHash,stateHash} from '../app/completion-model.js';
import {prepareCompletion} from '../app/completion.js';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
const files={source:{name:'source.pdf',blob:new Blob(['%PDF-synthetic source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF-synthetic rendering'])},ly:{name:'score.ly',blob:new Blob(['% Synthetic notation fixture\n{ c4 des4 }'])}};
const pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}],inspectPdf=async()=>pages;
const {identity,snapshotId}=await identify(files),base=newReview(identity,snapshotId,pages);
base.findings=[{id:'source-note',number:1,page:1,comment:'The D-flat in bar 2 of the source is almost certainly an error.',state:'open',color:'#ffd34d',strokes:[],bounds:null}];base.nextNumber=2;
const typed=()=>{const review=clone(base);review.findings[0].type='source_footnote';return review;};
const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
async function packageMaker(review,files){const payloads=await makeRecovery(review,files);for(const f of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(f.number).padStart(3,'0')}-${f.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));}
const issue=review=>makeTask(review,files,{},'page',()=>{},packageMaker);
function assertNumberedFootnotes(prompt){
  assert.match(prompt,/sequential Arabic numerals.*in score order/);
  assert.match(prompt,/LilyPond's automatic footnote numbering/);
  assert.match(prompt,/matching numeric markers at the referenced passage and its footnote text at the bottom of the page/);
  assert.match(prompt,/Do not use asterisks or daggers as footnote markers/);
  assert.match(prompt,/Do not use ScoreBrush finding IDs or finding numbers as footnote numbers/);
  assert.match(prompt,/Preserve the reviewer's degree of uncertainty/);
  assert.match(prompt,/D-flat or Db becomes D♭; F-sharp or F# becomes F♯/);
}
async function returned(review=typed()){
  const task=await issue(review),response=JSON.parse(await task.payloads.get('response-template.json').text());
  response.results[0]={id:'source-note',status:'unchanged_with_reason',explanation:'Synthetic pending footnote.'};
  const store=new Map([[task.id,task]]),lookup=async id=>store.get(id);
  const parsed=await readResponse(await zipFiles(new Map([['response.json',json(response)]])),lookup),entry=responseRevision(parsed);store.set(entry.id,entry);
  return {task,entry,lookup,store,seed:await workspaceSeed(entry,task,inspectPdf)};
}

test('source footnote type validates and legacy annotations keep their exact optional-field identity',async()=>{
  assert.equal(findingType(undefined),'correction');
  for(const original of [base,typed()]){
    const restored=exactReview(validateReview(original,original),original);
    assert.deepEqual(restored,original);
    assert.equal(await annotationHash(restored),await annotationHash(original));
    assert.equal(await stateHash(restored),await stateHash(original));
  }
  assert.equal(Object.hasOwn(validateReview(base,base).findings[0],'type'),false);
  assert.equal(validateReview(typed(),base).findings[0].type,'source_footnote');
  for(const type of [null,'footnote','<script>',{},7]){const invalid=typed();invalid.findings[0].type=type;assert.throws(()=>validateReview(invalid,base),/finding type/);}
});

test('ordinary task and portable package retain source footnotes with trusted rendering instructions',async()=>{
  const task=await issue(typed()),reopened=await hydrateTaskPackage(await zipFiles(task.payloads),inspectPdf);
  assert.equal(task.task.findings[0].type,'source_footnote');assert.equal(reopened.review.findings[0].type,'source_footnote');assert.equal(reopened.task.findings[0].type,'source_footnote');
  assert.match(task.prompt,/editorial footnote in the rendered score/);assert.match(task.prompt,/Preserve the reviewer's degree of uncertainty/);assert.match(task.prompt,/Do not silently change the musical reading/);
  assertNumberedFootnotes(task.prompt);assertNumberedFootnotes(await task.payloads.get('PROMPT.txt').text());
  assert.match(task.prompt,/D-flat or Db becomes D♭; F-sharp or F# becomes F♯/);assert.match(task.prompt,/Do not replace ordinary prose letters b or # numbering/);assert.equal(task.task.findings[0].comment,base.findings[0].comment);
  assert.match(await task.payloads.get('guidance/review-guide.txt').text(),/LilyPond music-glyph markup/);
  assert.match(await task.payloads.get('review.txt').text(),/"type": "source_footnote"/);
  const legacy=await issue(base);assert.equal(Object.hasOwn(legacy.task.findings[0],'type'),false);assert.equal(Object.hasOwn((await hydrateTaskPackage(await zipFiles(legacy.payloads),inspectPdf)).review.findings[0],'type'),false);
  for(const type of ['correction','arbitrary',null]){
    const altered=new Map(task.payloads),data=clone(task.task);data.findings[0].type=type;altered.set('task.json',json(data));await seal(altered,JSON.parse(await altered.get('manifest.json').text()));
    await assert.rejects(hydrateTaskPackage(await zipFiles(altered),inspectPdf),/type|baseline/);
  }
  const invalid=clone(task);invalid.task.findings[0].type='arbitrary';await assert.rejects(localTaskDelivery(invalid),/finding type/);
});

test('current delivery adds numbered-footnote policy without rewriting a historical package',async()=>{
  const task=await issue(typed()),archivedPayloads=new Map(task.payloads),oldPrompt='SYNTHETIC historical task prompt retained before numbered footnotes.';
  archivedPayloads.set('PROMPT.txt',new Blob([oldPrompt]));await seal(archivedPayloads,JSON.parse(await archivedPayloads.get('manifest.json').text()));
  const historical=await hydrateTaskPackage(await zipFiles(archivedPayloads),inspectPdf),before=new Map(await Promise.all([...historical.payloads].map(async([path,blob])=>[path,Buffer.from(await blob.arrayBuffer())])));
  const delivery=await localTaskDelivery(historical);assertNumberedFootnotes(await delivery.payloads.get('PROMPT.txt').text());
  assert.equal(await historical.payloads.get('PROMPT.txt').text(),oldPrompt);assert.deepEqual({...delivery.task.baseline},{...historical.task.baseline});
  assert.deepEqual(Buffer.from(await delivery.payloads.get('annotations.json').arrayBuffer()),before.get('annotations.json'));
  assert.equal(historical.payloads.size,before.size);for(const [path,blob]of historical.payloads)assert.deepEqual(Buffer.from(await blob.arrayBuffer()),before.get(path),path+' historical bytes are unchanged');
  await hydrateTaskPackage(await zipFiles(delivery.payloads),inspectPdf);
});

test('returned footnotes survive unlocated follow-ups and exact backup recovery',async()=>{
  const {task,entry,lookup,seed}=await returned();
  assert.equal(entry.findings[0].type,'source_footnote');assert.equal(seed.returned.reported[0].type,'source_footnote');
  const followup=await followupTask({...seed,doc:{}},'page',()=>{},packageMaker,{lookup});
  assertNumberedFootnotes(followup.prompt);assertNumberedFootnotes(await followup.payloads.get('PROMPT.txt').text());
  assert.equal(followup.task.findings[0].type,'source_footnote');assert.equal(followup.task.findings[0].page,null);
  assert.equal((await hydrateTaskPackage(await zipFiles(followup.payloads),inspectPdf)).task.findings[0].type,'source_footnote');
  const backup=await makeReturnedBackup(seed.review,seed.files,seed.returned,null,{lookup});
  const restored=await restoreReturnedBackup(await readPackage(await zipFiles(backup),inspectPdf),inspectPdf);
  assert.equal(restored.seed.returned.reported[0].type,'source_footnote');assert.equal(restored.issued.review.findings[0].type,'source_footnote');assert.deepEqual({...restored.issued.task.baseline},task.task.baseline);
  const bad=new Map(backup),metadata=JSON.parse(await bad.get('returned-workspace.json').text());metadata.returned.reported[0].type='correction';bad.set('returned-workspace.json',json(metadata));await seal(bad,JSON.parse(await bad.get('manifest.json').text()));
  await assert.rejects(restoreReturnedBackup(await readPackage(await zipFiles(bad),inspectPdf),inspectPdf),/finding type mismatch/);
});

test('follow-ups preserve the chosen type of associated notes and new footnotes',async()=>{
  const {seed,lookup}=await returned();
  seed.review.findings=[{...clone(base.findings[0]),id:'current-note',number:2,type:'correction'},{...clone(base.findings[0]),id:'new-footnote',number:3,type:'source_footnote'}];seed.review.nextNumber=4;
  seed.returned.reported[0].associationId='current-note';
  const followup=await followupTask({...seed,doc:{}},'page',()=>{},packageMaker,{lookup}),reopened=await hydrateTaskPackage(await zipFiles(followup.payloads),inspectPdf);
  assert.equal(reopened.task.findings[0].type,'correction');assert.equal(reopened.review.findings[0].type,'correction');assert.equal(reopened.task.findings[1].type,'source_footnote');assert.equal(seed.returned.reported[0].type,'source_footnote','original reported type remains historical evidence');
  delete seed.review.findings[0].type;
  const inherited=await followupTask({...seed,doc:{}},'page',()=>{},packageMaker,{lookup});
  assert.equal(inherited.task.findings[0].type,'source_footnote');assert.equal(inherited.review.findings[0].type,'source_footnote','legacy associated annotation inherits the reported purpose');
  await hydrateTaskPackage(await zipFiles(inherited.payloads),inspectPdf);
});

test('completed handoffs preserve footnote types while legacy completion hashes remain valid',async()=>{
  for(const review of [base,typed()]){
    const scene={review,files,doc:{},returned:null,revisionId:crypto.randomUUID(),completions:[],workspaceId:snapshotId,persistedRevision:1};
    const result=await prepareCompletion(scene,{scope:'partial',note:'Synthetic page 1',reviewer:''},{id:crypto.randomUUID(),createdAt:new Date().toISOString()},()=>{},packageMaker);
    const parsed=await readPackage(await zipFiles(result.payloads),inspectPdf);
    assert.equal(findingType(parsed.review.findings[0]),findingType(review.findings[0]));
    assert.equal(parsed.completionBundle.records[0].hashes.annotations,await annotationHash(review));
    assert.match(await result.payloads.get('completion-summary.txt').text(),new RegExp('Type: '+(review.findings[0].type?'Footnote':'Correction')));
  }
});
