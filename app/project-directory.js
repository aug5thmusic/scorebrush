// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Directory names change; on-disk schemas and exact historical bytes do not.
// Only browser handles already granted by the user are used here.
import {sha256} from './model.js';
export const DATA_DIRECTORY='.scorebrush', LEGACY_DIRECTORY='.score-desk';
export const OWNER_SCHEMA='private-score-desk-folder';
const SCHEMA='scorebrush-directory-migration', PLAN=/^\.scorebrush-migration-([a-f0-9-]{36})\.json$/;
const HASH=/^[a-f0-9]{64}$/, UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POINTER='<!-- private-score-desk:review-pointer:v1 -->';
const fail=message=>{throw new Error(message+' Your saved reviews and migration archive have been kept.');};
const safe=path=>typeof path==='string'&&path.length<1000&&!/[\\\x00-\x1f:*?"<>|]/.test(path)&&path.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p));
async function optional(action){try{return await action();}catch(e){if(e.name==='NotFoundError')return null;throw e;}}
async function dir(root,name){return optional(()=>root.getDirectoryHandle(name));}
async function file(root,path){let d=root;const parts=path.split('/');for(const name of parts.slice(0,-1)){d=await dir(d,name);if(!d)return null;}return optional(async()=>await(await d.getFileHandle(parts.at(-1))).getFile());}
async function write(root,path,blob){let d=root;const parts=path.split('/');for(const name of parts.slice(0,-1))d=await d.getDirectoryHandle(name,{create:true});const stream=await(await d.getFileHandle(parts.at(-1),{create:true})).createWritable();try{await stream.write(blob);await stream.close();}catch(e){try{await stream.abort();}catch{}throw e;}}
const json=value=>new Blob([JSON.stringify(value)],{type:'application/json'});
async function parse(blob,max=4*1024*1024){if(!blob||blob.size>max)fail('Missing or oversized migration metadata.');try{return JSON.parse(await blob.text());}catch{fail('Unreadable migration metadata.');}}
const info=async blob=>({size:blob.size,sha256:await sha256(await blob.arrayBuffer())});
const matches=async(blob,expected)=>Boolean(blob&&blob.size===expected.size&&await sha256(await blob.arrayBuffer())===expected.sha256);
async function owner(d){const blob=d?await file(d,'OWNER.json'):null;return blob?parse(blob,1024):null;}
function owned(value){if(value?.schema!==OWNER_SCHEMA||value.version!==1||value.migrationId!==undefined&&!UUID.test(value.migrationId)||value.migrationVersion!==undefined&&(!value.migrationId||![1,2].includes(value.migrationVersion)))fail('This project data directory is not owned by ScoreBrush.');}
// v1 archives remain readable at their original paths. New archives shorten
// only generated components; every original relative path and byte is retained.
export function migrationArchivePaths(record){
  owned(record);if(!record.migrationId)fail('Missing migration identity.');
  if((record.migrationVersion??1)===1)return {base:'migration-'+record.migrationId,original:'original'};
  const bytes=record.migrationId.replaceAll('-','').match(/../g).map(x=>parseInt(x,16));
  const compact=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  return {base:'m-'+compact,original:'o'};
}
async function committed(modern,record){
  if(!record?.migrationId)return false;
  if(!UUID.test(record.migrationId))fail('Invalid migration identity.');
  const {base}=migrationArchivePaths(record),version=record.migrationVersion??1,commit=await file(modern,base+'/COMMITTED.json');
  if(!commit?.size)return false;
  const c=await parse(commit,1024),plan=await file(modern,base+'/plan.json');
  if(c.schema!==SCHEMA||c.version!==version||c.id!==record.migrationId||!HASH.test(c.planSha256)||!plan||await sha256(await plan.arrayBuffer())!==c.planSha256)fail('Migration verification record differs.');
  const retained=validatePlan(await parse(plan));if(retained.id!==record.migrationId||retained.version!==version)fail('Migration archive layout differs from its plan.');
  return true;
}
// Read-only, including tentative New Project setup. Never migrate on cancel.
export async function readDataDirectory(root){
  const legacy=await dir(root,LEGACY_DIRECTORY),modern=await dir(root,DATA_DIRECTORY);
  if(legacy){
    if(modern){const blob=await file(modern,'OWNER.json');if(blob?.size){const o=await parse(blob,1024);if(o.schema===OWNER_SCHEMA&&o.version===1&&await committed(modern,o))return {directory:modern,name:DATA_DIRECTORY};}}
    owned(await owner(legacy));return {directory:legacy,name:LEGACY_DIRECTORY};
  }
  if(!modern)return null;const record=await owner(modern);owned(record);if(record.migrationId&&!await committed(modern,record))fail('Migration is incomplete and its original directory is missing. Restore that directory before retrying.');return {directory:modern,name:DATA_DIRECTORY};
}
async function inventory(root){
  const files=Object.create(null),directories=[];let count=0,total=0;
  async function walk(d,prefix='',depth=0){
    if(depth>32)fail('Project data is nested too deeply to migrate safely.');
    for await(const [name,entry]of d.entries()){
      const path=prefix+name;if(!safe(path)||++count>12000)fail('Project data contains an unsupported path or too many entries.');
      if(entry.kind==='directory'){directories.push(path);await walk(entry,path+'/',depth+1);}
      else if(entry.kind==='file'){const blob=await entry.getFile();total+=blob.size;if(blob.size>512*1024*1024||total>2*1024*1024*1024)fail('Project data exceeds the migration size limit. Keep a backup and contact support.');files[path]=await info(blob);}
      else fail('Unsupported project data entry.');
    }
  }
  await walk(root);return {files,directories:directories.sort()};
}
function validatePlan(p){
  if(p?.schema!==SCHEMA||![1,2].includes(p.version)||p.version===2&&p.archiveLayout!=='compact-tree-v1'||p.version===1&&p.archiveLayout!==undefined||!UUID.test(p.id)||!p.inventory||!Array.isArray(p.inventory.directories)||!p.inventory.files||Array.isArray(p.inventory.files)||Object.keys(p.inventory.files).length+p.inventory.directories.length>12000)fail('Invalid migration plan.');
  for(const [path,i]of Object.entries(p.inventory.files))if(!safe(path)||!HASH.test(i?.sha256)||!Number.isSafeInteger(i.size)||i.size<0||i.size>512*1024*1024)fail('Invalid migration file declaration.');
  const {base}=migrationArchivePaths({schema:OWNER_SCHEMA,version:1,migrationId:p.id,migrationVersion:p.version});
  if(p.inventory.directories.some(path=>!safe(path))||!p.inventory.files['OWNER.json']||Object.keys(p.inventory.files).some(path=>path.split('/')[0]===base)||p.inventory.directories.some(path=>path.split('/')[0]===base))fail('Conflicting migration paths.');
  if(p.pointer!==null&&(!HASH.test(p.pointer?.sha256)||!Number.isSafeInteger(p.pointer.size)||p.pointer.size<0||p.pointer.size>1024*1024))fail('Invalid migration pointer.');
  return p;
}
async function pendingPlan(root){
  const found=[];
  for await(const [name,entry]of root.entries())if(PLAN.test(name)&&entry.kind==='file'){
    const blob=await entry.getFile();if(!blob.size)continue; // An interrupted initial atomic write owns no destination.
    const plan=validatePlan(await parse(blob));if(name!=='.scorebrush-migration-'+plan.id+'.json')fail('Migration filename differs from its identity.');found.push({plan,blob,name});
  }
  if(found.length>1)fail('Multiple migration plans exist. Keep both directories and resolve the competing migration before saving.');return found[0]??null;
}
async function exactTree(root,plan,{partial=false}={}){
  const actual=await inventory(root),expected=plan.inventory;
  for(const [path,i]of Object.entries(actual.files))if(JSON.stringify(i)!==JSON.stringify(expected.files[path]))fail('Project data changed during migration: '+path+'. Retry after closing other writers.');
  if(actual.directories.some(path=>!expected.directories.includes(path))||!partial&&(Object.keys(actual.files).length!==Object.keys(expected.files).length||actual.directories.length!==expected.directories.length))fail('Project data changed during migration. Retry after closing other writers.');
}
async function verifyCopy(root,plan){
  for(const [path,i]of Object.entries(plan.inventory.files))if(!await matches(await file(root,path),i))fail('Migration copy failed verification: '+path+'.');
  for(const path of plan.inventory.directories){let d=root;for(const name of path.split('/')){d=await dir(d,name);if(!d)fail('Migration lost an empty directory.');}}
}
async function copyFile(source,target,path,i){
  const existing=await file(target,path);if(await matches(existing,i))return;
  if(existing?.size)fail('The migration destination has different bytes at '+path+'. Move the conflicting file aside before retrying.');
  const bytes=await file(source,path);if(!await matches(bytes,i))fail('Original file changed during migration: '+path+'.');
  // Own bytes before an external editor can invalidate a disk-backed File.
  await write(target,path,new Blob([await bytes.arrayBuffer()]));
  if(!await matches(await file(target,path),i))fail('Copied file could not be read back: '+path+'.');
}
async function createDirectories(target,paths){for(const path of paths){let d=target;for(const name of path.split('/'))d=await d.getDirectoryHandle(name,{create:true});}}
async function preflightMigration(root,plan){
  // Test the actual browser filesystem's generated path lengths and atomic
  // writable streams, not a guessed Windows MAX_PATH threshold. A sibling with
  // exactly the data directory's name length leaves the real migration untouched.
  // Every file uses an owned random sentinel; cleanup never recursively deletes.
  let probe=null,probeName='',attempted='',failure=null,cleanupFailure=null;
  const files=[],directories=[],known=new Map(),sentinel=new Blob(['ScoreBrush migration path test '+crypto.randomUUID()]),sentinelInfo=await info(sentinel);
  const {base,original}=migrationArchivePaths({schema:OWNER_SCHEMA,version:1,migrationId:plan.id,migrationVersion:plan.version});
  async function directory(path){let d=probe,prefix='';for(const name of path.split('/').filter(Boolean)){prefix+=(prefix?'/':'')+name;if(!known.has(prefix)){const next=await d.getDirectoryHandle(name,{create:true});known.set(prefix,next);directories.push({parent:d,name});}d=known.get(prefix);}return d;}
  async function writable(path,label=DATA_DIRECTORY+'/'+path){attempted=label;const parts=path.split('/'),parent=await directory(parts.slice(0,-1).join('/')),name=parts.at(-1);
    if(await file(parent,name))throw new Error('A temporary path-test file already exists.');
    const handle=await parent.getFileHandle(name,{create:true}),entry={parent,name,handle,written:false};files.push(entry);let stream;
    try{stream=await handle.createWritable();await stream.write(sentinel);await stream.close();entry.written=true;stream=null;if(!await matches(await handle.getFile(),sentinelInfo))throw new Error('Temporary path-test read-back differs.');}finally{if(stream)try{await stream.abort();}catch{}}
  }
  try{
    for(let n=0;n<8;n++){const candidate='.sb'+crypto.randomUUID().replaceAll('-','').slice(0,8);if(!await dir(root,candidate)&&!await file(root,candidate)){probeName=candidate;break;}}
    if(!probeName)throw new Error('A unique temporary path-test directory is unavailable.');
    probe=await root.getDirectoryHandle(probeName,{create:true});for await(const entry of probe.entries())throw new Error('The temporary path-test directory is not empty.');
    for(const path of plan.inventory.directories){attempted=DATA_DIRECTORY+'/'+base+'/'+original+'/'+path;await directory(base+'/'+original+'/'+path);attempted=DATA_DIRECTORY+'/'+path;await directory(path);}
    for(const path of Object.keys(plan.inventory.files)){await writable(base+'/'+original+'/'+path);await writable(path);}
    for(const path of [base+'/plan.json',base+'/COMMITTED.json',...(plan.pointer?[base+'/REVIEW_THIS.md']:[])])await writable(path);
    // The root plan has no extra data-directory component. This equal-length
    // sibling path exercises its write length without creating the real plan.
    const planName='.scorebrush-migration-'+plan.id+'.json',probeLength=planName.length-DATA_DIRECTORY.length-1;let planProbe='';
    for(let n=0;n<8;n++){const candidate=(crypto.randomUUID()+crypto.randomUUID()).replaceAll('-','').slice(0,probeLength);if(!known.has(candidate)&&!await file(probe,candidate)){planProbe=candidate;break;}}
    if(!planProbe)throw new Error('A unique migration plan path-test filename is unavailable.');await writable(planProbe,planName);
  }catch(error){failure=error;}
  finally{
    for(const {parent,name,handle,written}of files.reverse())try{const current=await handle.getFile();if((written||current.size)&&!await matches(current,sentinelInfo))throw new Error('A temporary path-test file changed; it was kept.');await parent.removeEntry(name);}catch(error){cleanupFailure??=error;}
    for(const {parent,name}of directories.reverse())try{await parent.removeEntry(name);}catch(error){cleanupFailure??=error;}
    if(probe)try{await root.removeEntry(probeName);}catch(error){cleanupFailure??=error;}
  }
  if(failure||cleanupFailure){const detail=failure?.message??cleanupFailure.message;fail('ScoreBrush could not create and verify the migration path '+(attempted||DATA_DIRECTORY)+'. '+detail+' No migration plan or archive was started or changed by this check. Check write permissions, or move the entire project folder, including .score-desk, any .scorebrush data and migration plan, to a shorter local path, then open it again. Do not delete or rename individual migration files.'+(cleanupFailure||(!probe&&probeName)?' The temporary path-test folder '+probeName+' could not be confirmed fully removed; any remaining files were kept.':''));}
}
async function migrate(root){
  let legacy=await dir(root,LEGACY_DIRECTORY),modern=await dir(root,DATA_DIRECTORY),pending=await pendingPlan(root),preflightDone=false;
  if(!legacy&&!pending){
    if(modern){owned(await owner(modern));return modern;}
    modern=await root.getDirectoryHandle(DATA_DIRECTORY,{create:true});await write(modern,'OWNER.json',json({schema:OWNER_SCHEMA,version:1}));owned(await owner(modern));return modern;
  }
  if(!pending){
    owned(await owner(legacy));
    if(modern){for await(const entry of modern.entries())fail('An existing .scorebrush directory conflicts with this migration. Move it aside or choose the correct project; nothing was overwritten.');}
    const pointer=await file(root,'REVIEW_THIS.md');if(pointer&&(pointer.size>1024*1024||!(await pointer.text()).startsWith(POINTER)))fail('REVIEW_THIS.md is not an owned review pointer. Move it aside before migrating.');
    const plan={schema:SCHEMA,version:2,archiveLayout:'compact-tree-v1',id:crypto.randomUUID(),inventory:await inventory(legacy),pointer:pointer?await info(pointer):null};validatePlan(plan);
    await preflightMigration(root,plan);preflightDone=true;
    const blob=json(plan),name='.scorebrush-migration-'+plan.id+'.json';if(await file(root,name))fail('Migration plan name already exists.');await write(root,name,blob);
    if(!await matches(await file(root,name),await info(blob)))fail('Migration plan could not be read back.');pending={plan,blob,name};
  }
  const {plan,blob,name}=pending,{base,original:originalName}=migrationArchivePaths({schema:OWNER_SCHEMA,version:1,migrationId:plan.id,migrationVersion:plan.version});
  if(!preflightDone&&legacy){const ownerBlob=modern?await file(modern,'OWNER.json'):null,current=ownerBlob?.size?await parse(ownerBlob,1024):null;
    if(current){owned(current);if(current.migrationId!==plan.id||(current.migrationVersion??1)!==plan.version)fail('The existing .scorebrush directory belongs to another project or migration. Nothing was overwritten.');}
    if(!current||!await committed(modern,current))await preflightMigration(root,plan);
  }
  modern??=await root.getDirectoryHandle(DATA_DIRECTORY,{create:true});
  const ownerBlob=await file(modern,'OWNER.json');
  if(!ownerBlob?.size){
    for await(const [entry]of modern.entries())if(entry!=='OWNER.json')fail('The migration destination contains unrelated files.');
    await write(modern,'OWNER.json',json({schema:OWNER_SCHEMA,version:1,migrationId:plan.id,...(plan.version===2?{migrationVersion:2}:{})}));
  }
  const o=await owner(modern);owned(o);if(o.migrationId!==plan.id||(o.migrationVersion??1)!==plan.version)fail('The existing .scorebrush directory belongs to another project or migration. Nothing was overwritten.');
  const archive=await modern.getDirectoryHandle(base,{create:true}),original=await archive.getDirectoryHandle(originalName,{create:true});
  const wasCommitted=await committed(modern,o);
  if(!wasCommitted){
    if(!legacy)fail('Original project data is unavailable before migration verification.');await exactTree(legacy,plan);
    // Reject additions/type conflicts, including files from another project.
    const allowed=new Set(['OWNER.json',base,...Object.keys(plan.inventory.files).map(p=>p.split('/')[0]),...plan.inventory.directories.map(p=>p.split('/')[0])]);
    for await(const [entry]of modern.entries())if(!allowed.has(entry))fail('The migration destination contains unrelated files: '+entry+'.');
    const recorded=await file(archive,'plan.json');if(recorded?.size&&!await matches(recorded,await info(blob)))fail('The retained migration plan differs.');
    await write(archive,'plan.json',blob);await createDirectories(original,plan.inventory.directories);await createDirectories(modern,plan.inventory.directories);
    const notReady=json({schema:'private-score-desk-ready',version:1,ready:false}),pausedInfo=await info(notReady);
    for(const [path,i]of Object.entries(plan.inventory.files)){
      await copyFile(legacy,original,path,i);if(path!=='OWNER.json'&&!(path==='latest/READY.json'&&await matches(await file(modern,path),pausedInfo)))await copyFile(legacy,modern,path,i);
    }
    await verifyCopy(original,plan);
    for(const [path,i]of Object.entries(plan.inventory.files))if(path!=='OWNER.json'&&!await matches(await file(modern,path),i)&&!(path==='latest/READY.json'&&await matches(await file(modern,path),pausedInfo)))fail('Active migration copy differs: '+path+'.');
    await exactTree(legacy,plan);
    // A stale retained prompt cannot be advertised as ready after the move.
    if(await file(modern,'latest/READY.json'))await write(modern,'latest/READY.json',notReady);
    if(plan.pointer){
      const current=await file(root,'REVIEW_THIS.md'),preserved=await file(archive,'REVIEW_THIS.md');
      if(!await matches(preserved,plan.pointer)){if(!await matches(current,plan.pointer))fail('The review pointer changed during migration.');await write(archive,'REVIEW_THIS.md',new Blob([await current.arrayBuffer()]));}
      if(!await matches(await file(archive,'REVIEW_THIS.md'),plan.pointer))fail('The original review pointer could not be preserved.');
      const oldText=await(await file(archive,'REVIEW_THIS.md')).text(),newText=oldText.replaceAll('.score-desk',DATA_DIRECTORY).replaceAll('Score Desk','ScoreBrush').replaceAll('SCORE DESK','ScoreBrush');
      if(!current||![oldText,newText].includes(await current.text()))fail('The review pointer changed during migration.');
      if(await current.text()!==newText)await write(root,'REVIEW_THIS.md',new Blob([newText]));
      if(await(await file(root,'REVIEW_THIS.md')).text()!==newText)fail('The updated review pointer could not be verified.');
    }
    await write(archive,'COMMITTED.json',json({schema:SCHEMA,version:plan.version,id:plan.id,planSha256:await sha256(await blob.arrayBuffer())}));
    if(!await committed(modern,o))fail('Migration verification did not commit.');
  }
  // The archive is complete before the first removal. On retry, only matching
  // remaining originals are retired, one file at a time; never recursive delete.
  await verifyCopy(original,plan);
  if(legacy){
    await exactTree(legacy,plan,{partial:true});
    const paths=Object.keys(plan.inventory.files).sort((a,b)=>(a==='OWNER.json')-(b==='OWNER.json'));
    for(const path of paths){const remaining=await file(legacy,path);if(!remaining)continue;if(!await matches(remaining,plan.inventory.files[path]))fail('An original changed before retirement: '+path+'.');let parent=legacy;const parts=path.split('/');for(const part of parts.slice(0,-1))parent=await parent.getDirectoryHandle(part);await parent.removeEntry(parts.at(-1));}
    for(const path of [...plan.inventory.directories].sort((a,b)=>b.split('/').length-a.split('/').length)){let parent=legacy;const parts=path.split('/');for(const part of parts.slice(0,-1)){parent=await dir(parent,part);if(!parent)break;}if(parent&&await dir(parent,parts.at(-1)))await parent.removeEntry(parts.at(-1));}
    await root.removeEntry(LEGACY_DIRECTORY);
  }
  if(!await matches(await file(root,name),await info(blob)))fail('Migration plan changed before cleanup.');await root.removeEntry(name);return modern;
}
export async function ensureDataDirectory(root){
  // Skip inventory work for ordinary saves, but retry an interrupted retirement.
  const legacy=await dir(root,LEGACY_DIRECTORY),modern=await dir(root,DATA_DIRECTORY);
  if(!legacy&&modern){const o=await owner(modern);owned(o);if(!o.migrationId)return modern;if(!await file(root,'.scorebrush-migration-'+o.migrationId+'.json')){if(!await committed(modern,o))fail('Migration is incomplete and its plan is missing. Restore the original directory and migration plan before retrying.');return modern;}}
  return globalThis.navigator?.locks?navigator.locks.request('scorebrush-directory-migration',()=>migrate(root)):migrate(root);
}
