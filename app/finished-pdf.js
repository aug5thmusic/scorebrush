// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Latest is a derived publication of durable, exact-revision approvals. It
// never reads the working PDF. Migration keeps the old approved copy until
// the numbered destination and its ownership receipt have been verified.
import {sha256,validateReview} from './model.js';
import {reviewRound} from './round-model.js';
import {stateHash,canonical} from './completion-model.js';
import {ensureDataDirectory,readDataDirectory} from './project-directory.js';
import {strictJSON,LIMITS} from './workflow.js';
import {syncPdfVersions,checkPdfVersions} from './pdf-versions.js';
import {validPdfName,nameKey} from './pdf-output-names.js';

export const LATEST_DIRECTORY='Latest',FINISHED_PDF='Finished.pdf';
const RECEIPT='finished-pdf.json',SCHEMA='scorebrush-finished-pdf';
const fail=message=>{throw new Error('Finished PDF: '+message);};
async function optional(dir,name){try{return await(await dir.getFileHandle(name)).getFile();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function parse(blob){if(!blob||blob.size>LIMITS.json)fail('retained approval metadata is missing or too large.');return strictJSON(await blob.text());}
const parsed=new Map();
async function metadata(snapshot,record,path){
  const info=record.payloads[path];if(!info)return null;
  if(parsed.has(info.sha256))return parsed.get(info.sha256);
  const blob=snapshot.objects.get(info.sha256);
  if(!blob||blob.size!==info.size||await sha256(await blob.arrayBuffer())!==info.sha256)fail('retained approval metadata failed verification.');
  const value=await parse(blob);if(parsed.size>2000)parsed.clear();parsed.set(info.sha256,value);return value;
}
export async function approvedRenderings(snapshot){
  const groups=new Map(),candidates=[];
  for(const record of snapshot.manifest.records){
    const meta=await metadata(snapshot,record,'returned-workspace.json');if(!meta)continue;
    const review=await metadata(snapshot,record,'annotations.json'),round=meta.returned;
    validateReview(review,review);
    const history=await metadata(snapshot,record,'completion-history.json');
    if(!history||history.revisionId!==record.revisionId||history.stateSha256!==await stateHash(review,round)||record.snapshotId!==review.snapshotId||round?.schema!=='score-desk-returned-workspace'||round.version!==1||!Array.isArray(round.reported)||round.reported.length>2000||round.contentSnapshotId!==review.snapshotId||round.renderSha256!==review.files.rendered.sha256||round.codeSha256!==review.files.ly.sha256)fail('retained approvals do not match their exact revision.');
    const result=reviewRound(review,round),resolved=result.state==='resolved'&&result.approved>0;
    const group=groups.get(round.id)??[];groups.set(round.id,group);
    group.push({record,review,round,history,resolved,workspaceId:round.id});
  }
  for(const group of groups.values()){
    group.sort((a,b)=>(a.record.storageRevision??1)-(b.record.storageRevision??1)||Number(!a.record.history)-Number(!b.record.history));
    let resolved=false;
    for(const item of group){
      if(item.resolved&&!resolved){
        const {record,review,round,history,workspaceId}=item,info=record.payloads['rendered-original.pdf'],blob=info&&snapshot.objects.get(info.sha256),finishedAt=record.historyCoverage==='legacy-retained-state'?review.updatedAt:record.createdAt??review.updatedAt;
        if(!info||!blob||info.sha256!==review.files.rendered.sha256||info.size!==review.files.rendered.size||blob.size!==info.size||!Number.isFinite(Date.parse(finishedAt)))fail('the approved rendering is missing or has a different identity.');
        candidates.push({recordId:record.id,workspaceId,revisionId:record.revisionId,snapshotId:review.snapshotId,sha256:info.sha256,size:info.size,finishedAt,approval:{review,round,stateSha256:history.stateSha256},blob});
      }
      resolved=item.resolved;
    }
  }
  return candidates.sort((a,b)=>Date.parse(a.finishedAt)-Date.parse(b.finishedAt)||a.recordId.localeCompare(b.recordId));
}
const descriptor=({blob,placeholder,...value})=>value;
const same=(a,b)=>canonical(a)===canonical(b);
async function publicationCandidates(snapshot,journal){
  const candidates=await approvedRenderings(snapshot);
  // Receipts can retain an exact legacy approval predating the first journal
  // checkpoint. Startup uses the same ordering/evidence as publication.
  for(const value of ownedItems(journal)){
    await validateApproval(value);const blob=snapshot.objects.get(value.sha256);
    if(!blob||blob.size!==value.size)fail('published approval history is unavailable. Restore the project backup before publishing again.');
    candidates.push({...value,blob});
  }
  return candidates.sort((a,b)=>Date.parse(a.finishedAt)-Date.parse(b.finishedAt)||a.recordId.localeCompare(b.recordId));
}
async function receipt(dir,projectId){
  const file=await optional(dir,RECEIPT);if(!file?.size)return null;
  const value=await parse(file);
  if(value.schema!==SCHEMA||![1,2].includes(value.version)||value.projectId!==projectId||!Object.hasOwn(value,'current')||!Object.hasOwn(value,'pending'))fail('publication metadata conflicts with existing files. Keep those files and restore a project backup.');
  if(value.version===1){
    if(value.name!==FINISHED_PDF)fail('legacy publication metadata conflicts with existing files.');
    for(const key of ['current','pending'])if(value[key])value[key]={...value[key],name:FINISHED_PDF,number:null};
    if(!value.current&&value.pending)value.pending.placeholder=true;
    value.retiring=[];
  }else if(!Array.isArray(value.retiring)||value.retiring.length>4)fail('publication migration metadata conflicts with existing files.');
  if(value.pendingCreate!==undefined&&typeof value.pendingCreate!=='boolean')fail('invalid pending PDF creation intent.');
  for(const item of [value.current,value.pending,...value.retiring].filter(Boolean)){
    if(!(item.name===FINISHED_PDF&&item.number===null)&&(!Number.isSafeInteger(item.number)||!validPdfName(item.name,item.number)))fail('unsafe finished PDF publication path.');
    if(item.placeholder!==undefined&&!(item.placeholder===true&&item.name===FINISHED_PDF&&item.number===null))fail('invalid legacy pending creation intent.');
  }
  return value;
}
async function validateApproval(value){
  const {review,round,stateSha256}=value?.approval??{};
  if(!review||!round||round.schema!=='score-desk-returned-workspace'||round.version!==1||!Array.isArray(round.reported)||round.reported.length>2000)fail('published approval evidence is invalid. Existing files were kept.');
  validateReview(review,review);
  if(value.workspaceId!==round.id||value.snapshotId!==review.snapshotId||value.sha256!==review.files.rendered.sha256||value.size!==review.files.rendered.size||round.contentSnapshotId!==review.snapshotId||round.codeSha256!==review.files.ly.sha256||round.renderSha256!==value.sha256||stateSha256!==await stateHash(review,round)||reviewRound(review,round).state!=='resolved'||!reviewRound(review,round).approved||!Number.isFinite(Date.parse(value.finishedAt)))fail('published approval evidence is invalid. Existing files were kept.');
}
async function write(dir,name,blob){
  const stream=await(await dir.getFileHandle(name,{create:true})).createWritable({mode:'exclusive'});
  try{await stream.write(blob);await stream.close();}catch(e){try{await stream.abort();}catch{}throw e;}
}
async function saveReceipt(dir,value){
  const text=JSON.stringify(value),blob=new Blob([text]);
  if(blob.size>LIMITS.json)fail('approval metadata exceeds the supported size. Keep a backup before continuing; the previous finished PDF is unchanged.');
  await write(dir,RECEIPT,blob);
  if(await(await optional(dir,RECEIPT)).text()!==text)fail('publication metadata could not be verified. Retry saving.');
}
async function destination(root,create=false){
  try{return await root.getDirectoryHandle(LATEST_DIRECTORY,{create});}
  catch(e){if(e.name==='TypeMismatchError')fail('a file named Latest is in the way. Move it out of the way, then retry saving.');throw e;}
}
const ownedItems=journal=>[journal?.current,journal?.pending,...(journal?.retiring??[])].filter(Boolean);
async function contents(dir,journal,{fresh=false}={}){
  const files=new Map(),claims=ownedItems(journal);
  for await(const [name,entry]of dir.entries()){
    if(!name.toLowerCase().endsWith('.pdf'))continue;
    const owners=claims.filter(item=>item.name===name);
    if(entry.kind!=='file'||!owners.length||[...files.keys()].some(n=>nameKey(n)===nameKey(name)))fail('Latest contains a PDF that ScoreBrush does not own. Move it out of Latest, then retry saving.');
    const file=await entry.getFile();let valid=false;
    for(const owner of owners)if(await matches(dir,file,owner,{fresh})){valid=true;break;}
    if(!valid&&!(file.size===0&&(owners.some(o=>o.placeholder)||journal?.pending?.name===name&&(journal.pendingCreate||!journal.current))))fail(name+' was changed outside ScoreBrush. Move it out of Latest, then retry saving.');
    files.set(name,file);
  }
  return files;
}
const verified=new WeakMap();
async function matches(root,blob,asset,{fresh=false}={}){
  if(!asset||!blob||blob.size!==asset.size)return false;
  const signature=blob.lastModified===undefined?null:[blob.size,blob.lastModified,asset.sha256].join(':');
  if(!fresh&&signature&&verified.get(root)===signature)return true;
  if(await sha256(await blob.arrayBuffer())!==asset.sha256)return false;
  if(signature)verified.set(root,signature);return true;
}
export async function syncFinishedPDF(directory,snapshot,{pdfVersions=null}={}){
  if(!snapshot)fail('save this project to its working folder first.');
  const run=async()=>{
    const projectId=snapshot.manifest.projectId;
    const data=await ensureDataDirectory(directory);let journal=await receipt(data,projectId);
    const candidates=await publicationCandidates(snapshot,journal);
    if(!candidates.length&&!journal)return {ready:false,written:0};
    // Keep exact approval evidence with the receipt as well: a legacy current
    // record may later acquire its first immutable decision checkpoint.
    const latest=candidates.at(-1);if(!latest)fail('no approved rendering is available.');
    const dir=await destination(directory,true);
    await contents(dir,journal);
    const versions=pdfVersions??(await syncPdfVersions(directory,snapshot)).versions;
    let written=0;
    async function clean(){
      if(!journal?.retiring.length)return;
      await contents(dir,journal,{fresh:true});
      for(const name of new Set(journal.retiring.map(r=>r.name))){
        if(!await matches(dir,await optional(dir,journal.current.name),journal.current,{fresh:true}))fail('the new approved copy is missing or changed; superseded copies were kept. Retry saving.');
        if(name===journal.current.name)fail('invalid superseded finished PDF path.');
        const file=await optional(dir,name);if(!file)continue;
        // Recheck immediately before deleting exactly this proven-owned file.
        const owners=journal.retiring.filter(r=>r.name===name);let proven=false;
        for(const owner of owners)if(owner.placeholder&&file.size===0||await matches(dir,file,owner,{fresh:true})){proven=true;break;}
        if(!proven)fail('a superseded PDF was modified; it was preserved. Move it out of Latest and retry.');
        await dir.removeEntry(name);
      }
      journal={...journal,retiring:[]};await saveReceipt(data,journal);
    }
    async function publish(target,blob){
      const old=ownedItems(journal);
      const beforeIntent=await contents(dir,journal,{fresh:true}),pendingCreate=!beforeIntent.has(target.name)||Boolean(journal?.pending?.name===target.name&&(journal.pendingCreate||!journal.current));
      journal={schema:SCHEMA,version:2,projectId,current:journal?.current??null,pending:target,pendingCreate,retiring:journal?.version===1?old.filter(v=>v!==journal.current):journal?.retiring??[]};
      await saveReceipt(data,journal);
      const before=(await contents(dir,journal,{fresh:true})).get(target.name);
      if(!await matches(dir,before,target)){
        if(await sha256(await blob.arrayBuffer())!==target.sha256)fail('retained approved PDF bytes failed verification.');
        // The new path was absent or a zero-byte interrupted pending creation.
        // A complete old copy at a different path stays in place.
        await write(dir,target.name,blob);written++;
      }
      if(!await matches(dir,(await contents(dir,journal,{fresh:true})).get(target.name),target,{fresh:true}))fail('the finished copy could not be verified. Retry saving.');
      const retiring=[...new Map(old.filter(v=>v.name!==target.name).map(v=>[v.name+':'+v.sha256,v])).values()];
      journal={schema:SCHEMA,version:2,projectId,current:target,pending:null,retiring};
      await saveReceipt(data,journal);await clean();
    }
    // Complete a v2 interrupted pair before advancing to a different approval.
    if(journal?.version===2&&journal.pending)await publish(journal.pending,snapshot.objects.get(journal.pending.sha256));
    else if(journal?.retiring.length&&!await matches(dir,await optional(dir,journal.current.name),journal.current,{fresh:true}))await publish(journal.current,snapshot.objects.get(journal.current.sha256));
    await clean();
    const version=versions.find(v=>v.sha256===latest.sha256&&v.size===latest.size);
    if(!version||!version.path?.startsWith('Versions/')||!validPdfName(version.path.slice(9),version.number))fail('the approved rendering has no verified numbered Versions copy.');
    const target={...descriptor(latest),number:version.number,name:version.path.slice(9)};
    const versionDir=await directory.getDirectoryHandle('Versions');
    if(!await matches(versionDir,await optional(versionDir,target.name),target,{fresh:true}))fail('the approved Versions copy changed; retry saving before publishing Latest.');
    if(journal?.version===2&&same(journal.current,target)&&!journal.pending&&!journal.retiring.length&&await matches(dir,(await contents(dir,journal)).get(target.name),target))return {ready:true,written,...target};
    await publish(target,latest.blob);
    return {ready:true,written,...target};
  };
  if(!globalThis.navigator?.locks)fail('this browser cannot coordinate folder saving. Use current Edge or Chrome.');
  return navigator.locks.request('scorebrush-finished-pdf:'+snapshot.manifest.projectId,async()=>{
    // Exclusive native file writers also serialize different browser profiles.
    // Abort the empty lock stream, so ordinary saves don't rewrite a lock file.
    const data=await ensureDataDirectory(directory),lock=await data.getFileHandle('finished-pdf.lock',{create:true});
    if((await lock.getFile()).size)fail('publication lock conflicts with an existing file. Keep that file and restore a project backup.');
    const writer=await lock.createWritable({mode:'exclusive'});
    try{return await run();}finally{await writer.abort();}
  });
}
export async function checkFinishedPDF(directory,projectId){
  try{
    const data=await readDataDirectory(directory),journal=data&&await receipt(data.directory,projectId);
    if(!journal?.current||journal.version!==2||journal.pending||journal.retiring.length)return {state:'unavailable',message:'The finished PDF is still being prepared. Retry saving.'};
    await validateApproval(journal.current);
    const dir=await destination(directory),file=(await contents(dir,journal,{fresh:true})).get(journal.current.name);
    if(!await matches(dir,file,journal.current,{fresh:true}))return {state:'unavailable',message:'The numbered finished PDF is missing or was changed. Move any changed copy out of Latest, then retry saving.'};
    const versions=await directory.getDirectoryHandle('Versions');
    if(!await matches(versions,await optional(versions,journal.current.name),journal.current,{fresh:true}))return {state:'unavailable',message:'The matching Versions copy is missing or changed. Retry saving.'};
    return {state:'match',path:LATEST_DIRECTORY+'/'+journal.current.name,number:journal.current.number,sha256:journal.current.sha256};
  }catch(e){return {state:'unavailable',message:e.message};}
}
export async function checkFinishedPublication(directory,snapshot,pdfVersions){
  const data=await readDataDirectory(directory),journal=data&&await receipt(data.directory,snapshot.manifest.projectId);
  const candidates=await publicationCandidates(snapshot,journal);
  if(!candidates.length&&!journal)return true;
  if(!journal?.current||journal.version!==2||journal.pending||journal.retiring.length)return false;
  const latest=candidates.at(-1),version=pdfVersions.find(v=>v.sha256===latest?.sha256&&v.size===latest.size);
  if(!version||!same(journal.current,{...descriptor(latest),number:version.number,name:version.path.slice(9)}))return false;
  return (await checkFinishedPDF(directory,snapshot.manifest.projectId)).state==='match';
}

// A completed round can publish its approved PDF from the mutable current
// checkpoint. It needs that rendering and any existing publication receipt,
// never all prior score versions or decision records.
export async function syncCurrentFinishedPDF(directory,snapshot){
  if(!snapshot)return {ready:false,written:0};
  const candidates=await approvedRenderings(snapshot);if(!candidates.length)return {ready:false,written:0};
  const data=await ensureDataDirectory(directory),projectId=snapshot.manifest.projectId;
  const journal=await receipt(data,projectId),objects=new Map(snapshot.objects);
  for(const item of ownedItems(journal)){
    if(objects.has(item.sha256))continue;
    const recovery=await data.getDirectoryHandle('recovery'),store=await recovery.getDirectoryHandle('objects');
    const file=await optional(store,item.sha256);
    if(!file||file.size!==item.size)fail('the previously published approved rendering is unavailable. Existing files were kept.');
    const bytes=await file.arrayBuffer();if(await sha256(bytes)!==item.sha256)fail('the previously approved rendering changed. Existing files were kept.');
    objects.set(item.sha256,new Blob([bytes]));
  }
  const versions=await checkPdfVersions(directory,snapshot);
  if(!versions)fail('the current numbered PDF could not be verified. Existing files were kept.');
  return syncFinishedPDF(directory,{...snapshot,objects},{pdfVersions:versions});
}
