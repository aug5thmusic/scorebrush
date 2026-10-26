// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Memory-only ZIP container; reuses the existing recovery writer and validators.
import {json,seal,strictJSON,fileInfo,LIMITS} from './workflow.js';
import {saveRecovery,readRecovery,recoveryMatches,restoreRecovery} from './folder-recovery.js';
import {buildProjectHistory,HISTORY_FILE} from './project-history.js';
const marker='workspace-transfer.json',prefix='workspace-history/';
function checkIndexSize(blob){
  if(blob.size>LIMITS.json)throw new Error('Workspace History.json exceeds the '+LIMITS.json+' byte (25 MiB) backup/restore limit. No history was discarded. Keep the complete folder and profile, and use saving recovery to protect current work.');
}
class MemoryDirectory {
  kind='directory';
  constructor(name){this.name=name;this.children=new Map();}
  async getDirectoryHandle(name,{create=false}={}){
    let entry=this.children.get(name);if(!entry&&create){entry=new MemoryDirectory(name);this.children.set(name,entry);}
    if(!entry)throw new DOMException('Missing directory','NotFoundError');if(entry.kind!=='directory')throw new Error('Ambiguous transfer directory');return entry;
  }
  async getFileHandle(name,{create=false}={}){
    let entry=this.children.get(name);if(!entry&&create){entry={kind:'file',name,blob:new Blob(),async getFile(){return this.blob;},async createWritable(){let blob;const target=this;return {async write(value){blob=value instanceof Blob?value:new Blob([value]);},async close(){target.blob=blob;},async abort(){}};}};this.children.set(name,entry);}
    if(!entry)throw new DOMException('Missing file','NotFoundError');if(entry.kind!=='file')throw new Error('Ambiguous transfer file');return entry;
  }
  async *entries(){yield* this.children;}
  async removeEntry(name){this.children.delete(name);}
}
async function put(root,path,blob){const parts=path.split('/');let dir=root;for(const name of parts.slice(0,-1))dir=await dir.getDirectoryHandle(name,{create:true});const out=await(await dir.getFileHandle(parts.at(-1),{create:true})).createWritable();await out.write(blob);await out.close();}
async function collect(root,payloads,path=''){for await(const [name,entry]of root.entries())if(entry.kind==='directory')await collect(entry,payloads,path+name+'/');else payloads.set(prefix+path+name,await entry.getFile());}
export async function addPortableHistory(result,scene,{isCurrent=()=>true,baseSnapshot=null,pdfVersions=[]}={}){
  const root=new MemoryDirectory('transfer'),owned=await root.getDirectoryHandle('.scorebrush',{create:true});
  await put(owned,'OWNER.json',json({schema:'private-score-desk-folder',version:1}));
  if(baseSnapshot){
    for(const [hash,blob]of baseSnapshot.objects)await put(owned,'recovery/objects/'+hash,blob);
    const manifest=json(baseSnapshot.manifest),id=baseSnapshot.manifest.id;
    await put(owned,'recovery/g-'+id+'/snapshot.json',manifest);
    await put(owned,'recovery/g-'+id+'/COMMIT.json',json({schema:baseSnapshot.manifest.schema,version:1,id,manifestSha256:(await fileInfo(manifest)).sha256}));
  }
  await saveRecovery(root,scene,{source:'source.pdf',rendered:'rendered.pdf',ly:'score.ly'},{isCurrent,expected:baseSnapshot?.manifest.id??null,projectId:baseSnapshot?.manifest.projectId??scene.projectId??null});
  const snapshot=await readRecovery(root);if(!snapshot||!await recoveryMatches(snapshot,scene))throw new Error('Transfer history could not be verified.');
  const payloads=new Map(result.payloads);await collect(owned,payloads);
  const index=json(await buildProjectHistory(snapshot,{objectRoot:prefix+'recovery/objects/',pdfVersions:pdfVersions.map(v=>({...v,originalPath:v.path,path:null}))}));
  checkIndexSize(index);payloads.set(HISTORY_FILE,index);
  payloads.set(marker,json({schema:'scorebrush-workspace-transfer',version:1,current:snapshot.manifest.current,generation:snapshot.manifest.id,researchIndex:HISTORY_FILE}));
  await seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));
  if(payloads.size>LIMITS.count||[...payloads.values()].some(b=>b.size>LIMITS.file)||[...payloads.values()].reduce((n,b)=>n+b.size,0)>LIMITS.total)throw new Error('Complete workspace history exceeds backup capacity; no older history was discarded. Keep the complete folder and profile, and use saving recovery to protect the current pending review.');
  return {...result,payloads};
}
export async function importPortableHistory(parsed,inspectPdf){
  if(!parsed.payloads.has(marker))return null;
  if(parsed.payloads.get(marker).size>1024)throw new Error('Oversized workspace transfer metadata.');
  const metadata=strictJSON(await parsed.payloads.get(marker).text());
  if(metadata.schema!=='scorebrush-workspace-transfer'||metadata.version!==1)throw new Error('Unsupported workspace transfer.');
  const root=new MemoryDirectory('transfer'),owned=await root.getDirectoryHandle('.scorebrush',{create:true});
  for(const [path,blob]of parsed.payloads)if(path.startsWith(prefix))await put(owned,path.slice(prefix.length),blob);
  const round=parsed.payloads.has('returned-workspace.json')?strictJSON(await parsed.payloads.get('returned-workspace.json').text()).returned:null;
  const snapshot=await readRecovery(root),scene={workspaceId:round?.id??parsed.review.snapshotId,review:parsed.review,returned:round,revisionId:parsed.completionBundle?.revisionId,completions:parsed.completionBundle?.records??[]};
  if(!snapshot||snapshot.damaged.length||snapshot.manifest.current!==metadata.current||snapshot.manifest.id!==metadata.generation||!await recoveryMatches(snapshot,scene))throw new Error('Workspace transfer history does not match its visible review. Existing work is unchanged.');
  if(metadata.researchIndex!==undefined){
    if(metadata.researchIndex!==HISTORY_FILE||!parsed.payloads.has(HISTORY_FILE))throw new Error('Workspace research index is missing.');
    checkIndexSize(parsed.payloads.get(HISTORY_FILE));
    const index=strictJSON(await parsed.payloads.get(HISTORY_FILE).text());
    const versions=[...new Map((index.revisions??[]).flatMap(r=>r.pdfVersions??[]).map(v=>[v.sha256+':'+v.number,v])).values()];
    const expected=await buildProjectHistory(snapshot,{objectRoot:prefix+'recovery/objects/',pdfVersions:versions,version:index.version});
    if(JSON.stringify(index)!==JSON.stringify(expected))throw new Error('Workspace research index differs from its validated retained history.');
  }
  return restoreRecovery(snapshot,inspectPdf);
}
