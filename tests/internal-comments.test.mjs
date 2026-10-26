// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Synthetic bytes and disposable memory handles only; no user scores or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview,clone,validateReview,sha256,isComment,findingTypeLabel} from '../app/model.js';
import {makeRecovery,zipFiles} from '../app/export.js';
import {makeTask,hydrateTaskPackage,localTaskDelivery,readPackage,readResponse,responseRevision,json,seal} from '../app/workflow.js';
import {workspaceSeed,makeReturnedBackup,restoreReturnedBackup} from '../app/returned.js';
import {exactReview,annotationHash,stateHash,createCompletion,validateCompletionBundle,completionSummary,COMPLETION_EXTENSION} from '../app/completion-model.js';
import {taskForScene,handoffCounts,rawFolderResponse,writeLatestTask} from '../app/folder-workspace.js';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
const files={source:{name:'source.pdf',blob:new Blob(['%PDF-synthetic source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF-synthetic rendering'])},ly:{name:'score.ly',blob:new Blob(['% Synthetic notation fixture\n{ c4 des4 }'])}};
const pages=[{page:1,view:[0,0,600,800],rotation:0,userUnit:1}],inspectPdf=async()=>pages;
const {identity,snapshotId}=await identify(files),base=newReview(identity,snapshotId,pages);
const note={id:'internal-note',number:1,page:1,type:'comment',comment:'The source prints D-flat here; retain this observation internally.',state:'open',color:'#ffd34d',strokes:[],bounds:null};
const reviewOf=(...findings)=>({...clone(base),findings:clone(findings),nextNumber:Math.max(0,...findings.map(f=>f.number))+1});
const png=new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]);
async function packageMaker(review,files){const payloads=await makeRecovery(review,files);for(const f of review.findings)for(const kind of ['clean','marked'])payloads.set(`findings/${String(f.number).padStart(3,'0')}-${f.id}-${kind}.png`,png);return seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));}
const issue=review=>makeTask(review,files,{},'page',()=>{},packageMaker);
async function returned(review=reviewOf(note)){
  const task=await issue(review),response=JSON.parse(await task.payloads.get('response-template.json').text()),store=new Map([[task.id,task]]),lookup=async id=>store.get(id);
  for(const result of response.results)result.status='unchanged_with_reason';
  const parsed=await readResponse(await zipFiles(new Map([['response.json',json(response)]])),lookup),entry=responseRevision(parsed);store.set(entry.id,entry);
  return {task,entry,lookup,store,seed:await workspaceSeed(entry,task,inspectPdf)};
}

test('internal comment type validates without changing legacy annotations or exact optional-field hashes',async()=>{
  assert.equal(isComment(note),true);assert.equal(findingTypeLabel(note),'Comment');assert.equal(isComment({}),false);
  for(const type of [undefined,'correction','source_footnote','comment']){
    const finding={...clone(note)};if(type===undefined)delete finding.type;else finding.type=type;
    const review=reviewOf(finding),checked=exactReview(validateReview(review,review),review);
    assert.deepEqual(checked,review);assert.equal(await annotationHash(checked),await annotationHash(review));assert.equal(await stateHash(checked),await stateHash(review));
  }
});

test('comment records and exact wording survive task/recovery round trips in a manifest-checked log',async()=>{
  const review=reviewOf({...note,comment:'Internal only. D-flat / Db / F#; <script> is inert text.'}),task=await issue(review);
  const reopened=await hydrateTaskPackage(await zipFiles(task.payloads),inspectPdf),recovery=await readPackage(await zipFiles(await makeRecovery(review,files)),inspectPdf);
  assert.deepEqual(reopened.review.findings,review.findings);assert.deepEqual(recovery.review.findings,review.findings);
  assert.equal(reopened.task.findings[0].type,'comment');
  const log=await task.payloads.get('internal-comments.txt').text();assert.match(log,/LOG ONLY; DO NOT PRINT ON THE SCORE/);assert.ok(log.includes(review.findings[0].comment));
  const manifest=JSON.parse(await task.payloads.get('manifest.json').text());assert.equal(manifest.payloads['internal-comments.txt'].sha256,await sha256(await task.payloads.get('internal-comments.txt').arrayBuffer()));
  assert.match(task.prompt,/must not appear on the score/);assert.match(task.prompt,/do not turn it into a footnote, printed annotation, or musical change/);assert.match(task.prompt,/comment-only task requests no score changes/);
  const template=JSON.parse(await task.payloads.get('response-template.json').text());assert.equal(template.results[0].status,'unchanged_with_reason');
  const corrupt=new Map(task.payloads);corrupt.set('internal-comments.txt',new Blob(['Altered observation']));await assert.rejects(hydrateTaskPackage(await zipFiles(corrupt),inspectPdf),/integrity check failed/);
  const before=await annotationHash(task.review),delivery=await localTaskDelivery(task);assert.equal(await annotationHash(task.review),before);assert.equal(await delivery.payloads.get('annotations.json').text(),await task.payloads.get('annotations.json').text());
});

test('comment-only folder tasks retain comments irrespective of progress state without requesting corrections',async()=>{
  const review=reviewOf({...note,state:'resolved'},{...note,id:'completed-fix',number:2,type:'correction',state:'resolved'}),scene={review,files,doc:{},returned:null};
  assert.deepEqual(handoffCounts(scene),{findings:0,comments:1});
  const task=await taskForScene(scene,{packageMaker});assert.deepEqual(task.task.findings.map(f=>f.id),['internal-note']);
  const changedFiles={...files,rendered:{name:'rendered.pdf',blob:new Blob(['%PDF-new rendering'])},ly:{name:'score.ly',blob:new Blob(['% New independent revision\n{ c4 des4 }'])}};
  const parsed=await rawFolderResponse(task,changedFiles),entry=responseRevision(parsed),store=new Map([[task.id,task],[entry.id,entry]]),lookup=async id=>store.get(id),seed=await workspaceSeed(entry,task,inspectPdf);
  assert.equal(seed.returned.reported[0].type,'comment');assert.equal(seed.returned.reported[0].decision,null);assert.equal(seed.returned.reported[0].state,'open');assert.equal(seed.review.findings.length,0,'historical marks are not copied onto a different rendering');
  assert.deepEqual(handoffCounts(seed),{findings:0,comments:1});
  const next=await taskForScene({...seed,doc:{}},{packageMaker,lookup}),reopened=await hydrateTaskPackage(await zipFiles(next.payloads),inspectPdf);
  assert.equal(next.task.version,2);assert.equal(reopened.task.findings[0].type,'comment');assert.equal(reopened.task.findings[0].page,null);assert.equal(reopened.task.findings[0].historicalContext.renderSha256,task.task.baseline.renderSha256);
  assert.match(await next.payloads.get('internal-comments.txt').text(),/source prints D-flat/);
});

test('mixed returned rounds retain comments after all corrections resolve and exclude them from pending decisions',async()=>{
  const correction={...note,id:'correction',number:2,type:'correction',comment:'Correct the bar 2 rhythm.'},fixture=await returned(reviewOf(note,correction)),{seed,lookup}=fixture;
  const fix=seed.returned.reported.find(f=>f.id==='correction');fix.state='resolved';fix.decision={state:'resolved',explanation:'Checked',reviewed:{snapshotId:seed.review.snapshotId,codeSha256:seed.review.files.ly.sha256,renderSha256:seed.review.files.rendered.sha256}};
  assert.deepEqual(handoffCounts(seed),{findings:0,comments:1});
  const task=await taskForScene({...seed,doc:{}},{packageMaker,lookup});assert.deepEqual(task.task.findings.map(f=>f.id),['internal-note']);
  const scene={...seed,revisionId:'synthetic-comment-round',workspaceId:seed.returned.id,persistedRevision:1},record=await createCompletion(scene,{scope:'corrections',note:'Only corrections checked.',reviewer:''},{id:'completion-comments',createdAt:new Date().toISOString()});
  assert.deepEqual(record.totals,{all:2,resolved:1,unresolved:0,unlocated:1,missingDecisions:0,comments:1});assert.match(completionSummary(record),/Internal comments logged: 1/);assert.match(completionSummary(record),/Human decision: Not applicable — internal comment/);
  await validateCompletionBundle({schema:COMPLETION_EXTENSION.schema,version:1,revisionId:scene.revisionId,stateSha256:record.hashes.state,records:[record]},seed.review,seed.returned);
  const backup=await makeReturnedBackup(seed.review,seed.files,seed.returned,null,{lookup}),restored=await restoreReturnedBackup(await readPackage(await zipFiles(backup),inspectPdf),inspectPdf);
  assert.equal(restored.seed.returned.reported[0].type,'comment');assert.equal(restored.seed.returned.reported[0].decision,null);assert.equal(restored.seed.returned.reported[0].comment,note.comment);assert.match(await backup.get('internal-comments.txt').text(),/source prints D-flat/);
});

test('converting a reported footnote to an internal comment changes the next request while preserving original history',async()=>{
  const {seed,lookup}=await returned(reviewOf({...note,type:'source_footnote'}));
  seed.review.findings=[{...clone(note),id:'current-comment',number:2,comment:'Keep this as an internal observation.'}];seed.review.nextNumber=3;seed.returned.reported[0].associationId='current-comment';
  assert.deepEqual(handoffCounts(seed),{findings:0,comments:1});
  const task=await taskForScene({...seed,doc:{}},{packageMaker,lookup}),reopened=await hydrateTaskPackage(await zipFiles(task.payloads),inspectPdf);
  assert.equal(reopened.task.findings[0].type,'comment');assert.equal(reopened.review.findings[0].type,'comment');assert.equal(seed.returned.reported[0].type,'source_footnote');
  assert.match(await task.payloads.get('internal-comments.txt').text(),/Keep this as an internal observation/);
  const record=await createCompletion({...seed,revisionId:'converted',workspaceId:'converted',persistedRevision:1},{scope:'partial',note:'',reviewer:''},{id:'completion-converted',createdAt:new Date().toISOString()});assert.equal(record.totals.unresolved,0);assert.equal(record.totals.missingDecisions,0);assert.equal(record.totals.comments,1);
});

test('next round includes latest explanations, deduplicated current notes and new findings while omitting approvals',async()=>{
  const fix={...note,id:'fix',number:2,type:'correction'},approved={...fix,id:'approved',number:3};
  const {seed,lookup}=await returned(reviewOf(note,fix,approved)),before=clone(await lookup(seed.returned.taskId));
  const rejected=seed.returned.reported.find(f=>f.id==='fix');rejected.explanation='Latest reviewer explanation: correct the lower note.';rejected.associationId='current-fix';
  const done=seed.returned.reported.find(f=>f.id==='approved');done.state='resolved';done.decision={state:'resolved',reviewed:{snapshotId:seed.review.snapshotId,codeSha256:seed.review.files.ly.sha256,renderSha256:seed.review.files.rendered.sha256}};
  seed.review.findings=[{...fix,id:'current-fix',number:4,comment:'Latest current passage note'},{...fix,id:'new-fix',number:5,comment:'New unresolved correction'}];seed.review.nextNumber=6;
  const task=await taskForScene({...seed,doc:{}},{packageMaker,lookup}),reopened=await hydrateTaskPackage(await zipFiles(task.payloads),inspectPdf);
  assert.deepEqual(reopened.task.findings.map(f=>f.id),['internal-note','fix','new-fix']);
  assert.equal(reopened.task.findings[1].reviewer.explanation,rejected.explanation);assert.equal(reopened.task.findings[1].currentAnchor.comment,'Latest current passage note');
  assert.match(await task.payloads.get('internal-comments.txt').text(),/source prints D-flat/);
  assert.deepEqual((await lookup(seed.returned.taskId)).task,before.task);assert.equal(reopened.task.findings.filter(f=>f.id==='fix').length,1);
});

test('structured responses cannot claim an internal comment caused a score change',async()=>{
  const task=await issue(reviewOf(note)),response=JSON.parse(await task.payloads.get('response-template.json').text()),changed=new Blob(['% changed notation\n{ c4 e4 }']);
  response.code={status:'changed',path:'changed.ly'};response.files={'changed.ly':{size:changed.size,sha256:await sha256(await changed.arrayBuffer())}};response.results[0].status='changed';
  await assert.rejects(readResponse(await zipFiles(new Map([['response.json',json(response)],['changed.ly',changed]])),async()=>task),/contradictory finding result/);
});

test('working-folder comments log is published with READY hashes and never writes source or notation inputs',async()=>{
  const data=new Map(),writes=[],error=()=>Object.assign(new Error('missing'),{name:'NotFoundError'});
  function directory(prefix=''){return {getDirectoryHandle:async(name,{create=false}={})=>{const path=prefix+name+'/';if(!create&&![...data.keys()].some(key=>key.startsWith(path)))throw error();return directory(path);},getFileHandle:async(name,{create=false}={})=>{const path=prefix+name;if(!create&&!data.has(path))throw error();return {getFile:async()=>data.get(path),createWritable:async()=>({write:async blob=>{data.set(path,blob);writes.push(path);},close:async()=>{},abort:async()=>{}})};}};}
  data.set('.scorebrush/OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  const task=await issue(reviewOf(note)),paths={source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'};for(const role of Object.keys(paths))data.set(paths[role],files[role].blob);
  await writeLatestTask(directory(),task,paths,{generationId:'comment-generation'});
  const ready=JSON.parse(await data.get('.scorebrush/latest/READY.json').text()),manifest=JSON.parse(await data.get('.scorebrush/latest/manifest.json').text()),log=data.get('.scorebrush/latest/internal-comments.txt');
  assert.equal(ready.ready,true);assert.equal(ready.generationId,'comment-generation');assert.equal(manifest.payloads['internal-comments.txt'].sha256,await sha256(await log.arrayBuffer()));assert.equal(ready.manifestSha256,await sha256(await data.get('.scorebrush/latest/manifest.json').arrayBuffer()));
  assert.match(await data.get('REVIEW_THIS.md').text(),/Type "comment" records an internal observation only/);assert.ok(writes.every(path=>path.startsWith('.scorebrush/')||path==='REVIEW_THIS.md'));for(const role of Object.keys(paths))assert.equal(data.get(paths[role]),files[role].blob);
});
