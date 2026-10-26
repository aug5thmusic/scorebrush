// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Ordinary, byte-identical PDFs derived only from validated retained recovery.
// Append-only reservations live in the owned project data, never in the visible
// folder. A collision (even a changed former copy) is preserved, not replaced.
import {sha256} from './model.js';
import {ensureDataDirectory,readDataDirectory} from './project-directory.js';
import {strictJSON,LIMITS} from './workflow.js';
import {canonical} from './completion-model.js';
import {safeBasename,nameKey,pdfName,validPdfName,validatePdfOutput} from './pdf-output-names.js';

export const VERSIONS_DIRECTORY='Versions';
const SCHEMA='scorebrush-pdf-version',HASH=/^[a-f0-9]{64}$/;
const fail=(message,name='Error')=>{const error=new Error('Previous PDF versions: '+message);error.name=name;throw error;};
const missing=e=>e.name==='NotFoundError';
async function optional(dir,name){try{return await(await dir.getFileHandle(name)).getFile();}catch(e){if(missing(e)||e.name==='TypeMismatchError')return null;throw e;}}
async function parsed(blob){if(!blob||blob.size>LIMITS.json)fail('retained metadata is missing or too large.');return strictJSON(await blob.text());}

export async function retainedRenderings(snapshot){
  const found=new Map();
  const object=(bundle,path)=>{const info=bundle.payloads[path];return info?{...info,blob:snapshot.objects.get(info.sha256)}:null;};
  function add(asset,info,date,priority=0){
    if(!asset||!asset.blob||!HASH.test(asset.sha256)||asset.size!==asset.blob.size||info?.sha256!==asset.sha256||info.size!==asset.size)fail('a retained rendering does not match its original identity.');
    const time=Date.parse(date),order=Number.isFinite(time)?time:0,prior=found.get(asset.sha256);
    if(!prior||order<prior.order||order===prior.order&&priority<prior.priority)found.set(asset.sha256,{...asset,order,priority});
  }
  // Current records, decision checkpoints and issued task baselines all refer
  // to PDFs actually loaded. Unopened AI responses and marked exports do not.
  for(const bundle of [...snapshot.manifest.records,...(snapshot.manifest.legacyEvidence??[]),...(snapshot.manifest.handoffs??[]).filter(h=>h.kind==='task')]){
    for(const prefix of ['', 'history/task/']){
      const annotations=object(bundle,prefix+'annotations.json');if(!annotations)continue;
      const review=await parsed(annotations.blob);
      const rendering=object(bundle,prefix+'rendered-original.pdf');
      if(rendering)add(rendering,review.files?.rendered,review.createdAt);
      const taskAsset=object(bundle,prefix+'task.json');if(!taskAsset)continue;
      const task=await parsed(taskAsset.blob);
      for(const finding of task.findings??[]){const info=finding.historicalContext?.originalFiles?.rendered;if(info)add(object(bundle,prefix+info.path),info,review.createdAt,-2);}
      const previous=object(bundle,prefix+'historical/previous-rendering.pdf');
      if(previous)add(previous,previous,review.createdAt,-1);
    }
  }
  return [...found.values()].sort((a,b)=>a.order-b.order||a.priority-b.priority||a.sha256.localeCompare(b.sha256));
}

async function freshWrite(dir,name,blob,{ownedEmpty=false}={}){
  // Check both file and directory collisions immediately before creation. The
  // caller serializes cooperating tabs; exclusive writers also reject overlap.
  for await(const [n,entry]of dir.entries())if(nameKey(n)===nameKey(name)&&!(ownedEmpty&&n===name&&entry.kind==='file'&&(await entry.getFile()).size===0))fail('a destination appeared during saving. Retry saving; existing files were kept.');
  const file=await dir.getFileHandle(name,{create:true});
  if((await file.getFile()).size)fail('a destination changed during saving. Existing files were kept.');
  const writer=await file.createWritable({mode:'exclusive'});
  try{await writer.write(blob);await writer.close();}catch(e){try{await writer.abort();}catch{}throw e;}
}
export function validReservation(r,projectId){
  const identity=r&&r.schema===SCHEMA&&r.projectId===projectId&&HASH.test(r.sha256)&&Number.isSafeInteger(r.size)&&r.size>0&&r.size<=LIMITS.file&&Number.isSafeInteger(r.number)&&r.number>0&&r.number<=LIMITS.count;
  if(!identity)return false;
  if(r.version===1)return typeof r.name==='string'&&/^\d{4,5} - (Initial transcription|Revision \d+)( \(\d+\))?\.pdf$/.test(r.name)&&Number(r.name.split(' ')[0])===r.number;
  return r.version===2&&r.basename===safeBasename(r.basename+'.pdf')&&validPdfName(r.name,r.number,r.basename)&&Array.isArray(r.supersedes)&&r.supersedes.length<=LIMITS.count&&r.supersedes.every(n=>typeof n==='string'&&validPdfName(n,r.number)&&n!==r.name);
}
const checked=new WeakMap();
async function matches(root,file,asset,name,{fresh=false}={}){
  if(!file||file.size!==asset.size)return false;
  let cache=checked.get(root);if(!cache){cache=new Map();checked.set(root,cache);}
  const signature=file.lastModified===undefined?null:[file.size,file.lastModified,asset.sha256].join(':');
  if(!fresh&&signature&&cache.get(name)===signature)return true;
  if(await sha256(await file.arrayBuffer())!==asset.sha256)return false;
  if(signature)cache.set(name,signature);return true;
}
async function directoryNames(dir){
  const occupied=new Map();
  for await(const [name,entry]of dir.entries()){
    const key=nameKey(name),entries=occupied.get(key)??[];entries.push({name,entry});occupied.set(key,entries);
  }
  return occupied;
}
function ownedEntry(occupied,name){
  const entries=occupied.get(nameKey(name))??[];
  if(entries.length>1)fail('ambiguous owned filename Versions/'+name+'. Resolve the Unicode/case name collision by moving the conflicting files out of Versions, then retry saving. All files were kept.','PdfVersionConflictError');
  return entries[0];
}
async function selectReservation(directory,occupied,prior,asset,basename,{fresh=false}={}){
  let resumable=null;
  for(const r of prior.filter(r=>r.version===2&&r.basename===basename)){
    const item=ownedEntry(occupied,r.name),file=item?.name===r.name&&item.entry.kind==='file'?await item.entry.getFile():null;
    // Search every reservation for a verified copy BEFORE recreating an older
    // missing/empty destination. The startup proof uses this identical order.
    if(file&&await matches(directory,file,asset,r.name,{fresh}))return {published:r};
    if(!resumable&&(!item||file?.size===0))resumable=r;
  }
  return {resumable};
}
async function reservationsAt(owned,projectId,{create=true}={}){
    const journal=await owned.getDirectoryHandle('pdf-versions',{create}),reservations=[];
    for await(const [name,handle]of journal.entries()){
      if(!/^version-[a-f0-9-]{36}\.json$/.test(name))continue;
      if(handle.kind!=='file')fail('version metadata conflicts with an existing directory.');
      const blob=await handle.getFile();if(!blob.size)continue; // interrupted before publication; never used
      const record=await parsed(blob);if(!validReservation(record,projectId))fail('version metadata is invalid or belongs to another project. Existing files were kept.');
      reservations.push(record);if(reservations.length>LIMITS.count)fail('too many version records. Keep a backup before continuing.');
    }
    return {journal,reservations};
}
async function initialName(snapshot){
  if(snapshot.manifest.initialTranscriptionFilename!=null)return {initialTranscriptionFilename:snapshot.manifest.initialTranscriptionFilename,nameSource:'initial-selection'};
  const names=new Set(),roots=new Set();
  for(const bundle of snapshot.manifest.records){
    if(bundle.history||bundle.parentWorkspaceId||bundle.payloads['returned-workspace.json'])continue;
    const info=bundle.payloads['annotations.json'],review=info&&await parsed(snapshot.objects.get(info.sha256));
    if(review?.snapshotId===bundle.id)roots.add(review.snapshotId);
  }
  for(const bundle of [...snapshot.manifest.records,...(snapshot.manifest.handoffs??[]).filter(h=>h.kind==='task')]){
    for(const prefix of ['', 'history/task/']){
      const taskInfo=bundle.payloads[prefix+'task.json'];
      const task=taskInfo&&await parsed(snapshot.objects.get(taskInfo.sha256));
      // An original task baseline explicitly predates returned/proposed files.
      // An ordinary legacy head alone need not be the initial transcription.
      if(!task||task.parent||task.version!==1||!roots.has(task.baseline?.snapshotId))continue;
      const info=bundle.payloads[prefix+'annotations.json'],review=info&&await parsed(snapshot.objects.get(info.sha256));
      if(typeof review?.files?.rendered?.name==='string')names.add(review.files.rendered.name);
    }
  }
  return names.size===1?{initialTranscriptionFilename:[...names][0],nameSource:'legacy-initial-evidence'}:{initialTranscriptionFilename:null,nameSource:'unknown'};
}
async function catalog(directory,snapshot,assets,reservations){
  const owned=await ensureDataDirectory(directory),file=await optional(owned,'pdf-names.json');
  let stored;
  if(file?.size){stored=await parsed(file);if(stored.schema!=='scorebrush-pdf-names'||stored.version!==1||stored.projectId!==snapshot.manifest.projectId)fail('PDF naming metadata belongs to another project or schema.');validatePdfOutput(stored.output);}
  const inherited=snapshot.manifest.pdfOutput;if(inherited)validatePdfOutput(inherited);
  if(stored&&inherited&&['basename','initialTranscriptionFilename','nameSource'].some(k=>stored.output[k]!==inherited[k]))fail('PDF title metadata conflicts with recovered history.');
  const naming=stored?.output??inherited??await initialName(snapshot);
  const output={version:1,initialTranscriptionFilename:naming.initialTranscriptionFilename,basename:naming.basename??safeBasename(naming.initialTranscriptionFilename),nameSource:naming.nameSource,renderings:[]},byHash=new Map(),byNumber=new Map();
  for(const item of [...(inherited?.renderings??[]),...(stored?.output.renderings??[]),...reservations]){
    const prior=byHash.get(item.sha256),other=byNumber.get(item.number);
    if(prior&&(prior.size!==item.size||prior.number!==item.number)||other&&other.sha256!==item.sha256)fail('PDF version numbers conflict. Keep the existing folder and backup; no ordinals were changed.');
    const entry={number:item.number,sha256:item.sha256,size:item.size};byHash.set(item.sha256,entry);byNumber.set(item.number,entry);
  }
  for(const asset of assets)if(!byHash.has(asset.sha256)){
    const number=Math.max(0,...byNumber.keys())+1;if(number>LIMITS.count)fail('too many PDF versions. Keep the complete folder and use saving recovery.');
    const entry={number,sha256:asset.sha256,size:asset.size};byHash.set(asset.sha256,entry);byNumber.set(number,entry);
  }
  output.renderings=[...byHash.values()].sort((a,b)=>a.number-b.number);validatePdfOutput(output);
  if(!stored||canonical(stored.output)!==canonical(output)){
    const text=JSON.stringify({schema:'scorebrush-pdf-names',version:1,projectId:snapshot.manifest.projectId,output}),writer=await(await owned.getFileHandle('pdf-names.json',{create:true})).createWritable({mode:'exclusive'});
    try{await writer.write(new Blob([text]));await writer.close();}catch(e){try{await writer.abort();}catch{}throw e;}
    if(await(await optional(owned,'pdf-names.json')).text()!==text)fail('PDF naming metadata could not be verified. Retry saving.');
  }
  return output;
}
async function locked(directory,snapshot,run){
  if(!snapshot)fail('save this project to its working folder first.');
  if(!globalThis.navigator?.locks)fail('this browser cannot coordinate folder saving. Use current Edge or Chrome.');
  return navigator.locks.request('scorebrush-pdf-versions:'+snapshot.manifest.projectId,async()=>{
    const owned=await ensureDataDirectory(directory),lock=await owned.getFileHandle('pdf-versions.lock',{create:true});
    if((await lock.getFile()).size)fail('version lock conflicts with existing data.');
    const writer=await lock.createWritable({mode:'exclusive'});
    try{return await run(owned);}finally{await writer.abort();}
  });
}
export async function preparePdfOutput(directory,snapshot){
  return locked(directory,snapshot,async owned=>catalog(directory,snapshot,await retainedRenderings(snapshot),(await reservationsAt(owned,snapshot.manifest.projectId)).reservations));
}
// Read-only startup proof. No reservations, lock streams or output directories
// are created here. A missing copy or unfinished owned rename needs repair.
export async function checkPdfVersions(directory,snapshot,knownCatalog=null,currentPublication=null){
  try{
    const owned=await readDataDirectory(directory);if(!owned||!snapshot.manifest.pdfOutput)return null;
    const file=await optional(owned.directory,'pdf-names.json');if(!file?.size)return null;
    const stored=await parsed(file),output=snapshot.manifest.pdfOutput;validatePdfOutput(output);
    if(stored.schema!=='scorebrush-pdf-names'||stored.version!==1||stored.projectId!==snapshot.manifest.projectId||canonical(stored.output)!==canonical(output))return null;
    const {reservations}=await reservationsAt(owned.directory,snapshot.manifest.projectId,{create:false});
    const dir=await directory.getDirectoryHandle(VERSIONS_DIRECTORY),occupied=await directoryNames(dir),published=[];
    for(const asset of knownCatalog??await retainedRenderings(snapshot)){
      const number=output.renderings.find(r=>r.sha256===asset.sha256&&r.size===asset.size)?.number;
      const prior=reservations.filter(r=>r.sha256===asset.sha256&&r.size===asset.size);
      const structural=Boolean(currentPublication&&!currentPublication.requiredHashes.has(asset.sha256));
      let found;
      if(structural){
        // A known clean current-publication proof pins the previously verified
        // historical path. Ordinary opening checks its ownership/shape only;
        // full saves and explicit history access still hash every PDF copy.
        const published=currentPublication.versions.find(v=>v.sha256===asset.sha256&&v.size===asset.size&&v.number===number);
        if(!published)return null;
        for(const r of prior.filter(r=>r.version===2&&r.basename===output.basename))ownedEntry(occupied,r.name);
        found=prior.find(r=>r.version===2&&r.basename===output.basename&&VERSIONS_DIRECTORY+'/'+r.name===published.path&&r.number===number);
        if(!found)return null;
        const item=ownedEntry(occupied,found.name),file=item?.name===found.name&&item.entry.kind==='file'?await item.entry.getFile():null;
        if(!file||file.size!==asset.size)return null;
        for(const name of found.supersedes)ownedEntry(occupied,name);
      }else{
        ({published:found}=await selectReservation(directory,occupied,prior,asset,output.basename,{fresh:true}));
        if(!found||found.number!==number)return null;
        for(const name of found.supersedes){
          const item=ownedEntry(occupied,name);
          if(item?.name===name&&item.entry.kind==='file'&&await matches(directory,await item.entry.getFile(),asset,name,{fresh:true}))return null;
        }
      }
      published.push({number,path:VERSIONS_DIRECTORY+'/'+found.name,sha256:asset.sha256,size:asset.size});
    }
    return published;
  }catch(e){if(missing(e))return null;throw e;}
}
export async function syncPdfVersions(directory,snapshot){
  return locked(directory,snapshot,async owned=>{
    const assets=await retainedRenderings(snapshot),projectId=snapshot.manifest.projectId;
    const {journal,reservations}=await reservationsAt(owned,projectId),output=await catalog(directory,snapshot,assets,reservations);
    let versions;try{versions=await directory.getDirectoryHandle(VERSIONS_DIRECTORY,{create:true});}catch(e){if(e.name==='TypeMismatchError')fail('a file named Versions is in the way. Rename that file, then retry saving.');throw e;}
    const occupied=await directoryNames(versions);
    let written=0;const published=[],warnings=[];
    for(const asset of assets){
      const prior=reservations.filter(r=>r.sha256===asset.sha256&&r.size===asset.size);
      const number=output.renderings.find(r=>r.sha256===asset.sha256).number;
      const selected=await selectReservation(directory,occupied,prior,asset,output.basename);
      let reservation=selected.published??selected.resumable;
      if(!reservation){
        let suffix=1,name=pdfName(number,output.basename);
        const entries=occupied.get(nameKey(name)),existing=entries?.length===1?entries[0]:null,adopt=existing?.name===name&&existing.entry.kind==='file'&&prior.some(r=>r.name===name)&&await matches(directory,await optional(versions,name),asset,name,{fresh:true});
        if(!adopt)while(occupied.has(nameKey(name)))name=pdfName(number,output.basename,++suffix);
        reservation={schema:SCHEMA,version:2,projectId,number,name,basename:output.basename,sha256:asset.sha256,size:asset.size,supersedes:[...new Set(prior.map(r=>r.name).filter(n=>n!==name))]};
        const receipt='version-'+crypto.randomUUID()+'.json',blob=new Blob([JSON.stringify(reservation)]);
        await freshWrite(journal,receipt,blob);
        if(await(await optional(journal,receipt)).text()!==await blob.text())fail('version metadata could not be verified. Retry saving.');
        reservations.push(reservation);
      }
      if(!await matches(directory,await optional(versions,reservation.name),asset,reservation.name)){
        if(await sha256(await asset.blob.arrayBuffer())!==asset.sha256)fail('retained PDF bytes failed verification.');
        await freshWrite(versions,reservation.name,asset.blob,{ownedEmpty:true});occupied.set(nameKey(reservation.name),[{name:reservation.name,entry:await versions.getFileHandle(reservation.name)}]);written++;
      }
      if(!await matches(directory,await optional(versions,reservation.name),asset,reservation.name))fail('a PDF copy could not be verified. Retry saving.');
      // Destination and its reservation are durable before touching old paths.
      // Keep the ownership evidence permanently so interrupted cleanup retries.
      for(const name of reservation.supersedes){
        const item=ownedEntry(occupied,name);if(!item)continue;
        if(item.name!==name||item.entry.kind!=='file'||!await matches(directory,await optional(versions,name),asset,name,{fresh:true})){warnings.push('Preserved changed or case-colliding Versions/'+name);continue;}
        if(!await matches(directory,await optional(versions,reservation.name),asset,reservation.name,{fresh:true}))fail('the new version copy changed; the superseded copy was kept. Retry saving.');
        await versions.removeEntry(name);occupied.delete(nameKey(name));
      }
      published.push({number:reservation.number,path:VERSIONS_DIRECTORY+'/'+reservation.name,sha256:reservation.sha256,size:reservation.size});
    }
    return {count:assets.length,written,versions:published,output,warnings};
  });
}
