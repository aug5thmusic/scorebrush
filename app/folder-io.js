// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {LIMITS,localTaskDelivery,readResponse} from './workflow.js';
import {zipFiles} from './export.js';

const fail=message=>{throw new Error(message);};
const safePath=path=>typeof path==='string'&&path.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)&&!path.split('/').some(part=>!part||part==='.'||part==='..');
const missing=error=>error?.name==='NotFoundError';

// Only a user-selected parent handle is accepted. Each export has a fresh,
// unpredictable child name; existing directories/files are never reused.
export async function saveTaskFolder(parent,entry,{folderName,progress=()=>{}}={}){
  if(!parent||parent.kind!=='directory')fail('Choose a local folder for this task.');
  const delivery=await localTaskDelivery(entry),payloads=delivery.payloads;
  const name=folderName??`score-task-${new Date().toISOString().slice(0,10)}-${crypto.randomUUID()}`;
  if(!safePath(name)||name.includes('/'))fail('The new task folder name is invalid.');
  try{await parent.getDirectoryHandle(name);fail('A folder with this task name already exists. Choose a fresh export.');}catch(error){if(!missing(error))throw error;}
  try{await parent.getFileHandle(name);fail('A file with this task name already exists. Choose a fresh export.');}catch(error){if(!missing(error))throw error;}
  const paths=new Set();let total=0;
  for(const [path,blob]of payloads){
    if(!safePath(path)||paths.has(path.toLowerCase())||!blob||!Number.isSafeInteger(blob.size)||blob.size<0||blob.size>LIMITS.file)fail('The task contains an unsafe path or unsupported file.');
    paths.add(path.toLowerCase());total+=blob.size;
  }
  if(payloads.size>LIMITS.count||total>LIMITS.total)fail('This task exceeds the supported folder export limits.');
  const directory=await parent.getDirectoryHandle(name,{create:true});
  for await(const ignored of directory.values())fail('The destination changed while it was being opened. No existing files were overwritten.');
  try{
    const entries=[...payloads].sort(([a],[b])=>(a==='PROMPT.txt')-(b==='PROMPT.txt'));
    for(const [path,blob]of entries){
      progress(`Writing task folder · ${path}`);const parts=path.split('/');let current=directory;
      for(const part of parts.slice(0,-1))current=await current.getDirectoryHandle(part,{create:true});
      const basename=parts.at(-1);
      try{await current.getFileHandle(basename);fail('A destination file appeared during export. No existing file was overwritten.');}catch(error){if(!missing(error))throw error;}
      const file=await current.getFileHandle(basename,{create:true}),writer=await file.createWritable();
      try{await writer.write(blob);await writer.close();}catch(error){try{await writer.abort();}catch{}throw error;}
    }
    await directory.getDirectoryHandle('response',{create:true});
  }catch(error){throw new Error(`Task folder ${name} is incomplete: ${error.message}. Keep using the saved task or export again to a new folder.`);}
  return {name,parentName:parent.name,fileCount:payloads.size,taskId:delivery.id};
}

// File input directory selection exposes only the selected tree. Strip exactly
// its common root; never use an absolute path or silently discard extra files.
export function responseFolderPayloads(selected){
  const files=Array.from(selected??[]);
  if(!files.length)fail('The selected response folder is empty. Ask the AI to write response.json and its corrected files first.');
  if(files.length>LIMITS.count)fail('The response folder contains too many files. Choose only the response subfolder.');
  const root=files[0].webkitRelativePath?.split('/')[0];
  if(!root||root==='.'||root==='..'||root.includes('\\'))fail('Choose a response folder using Open response folder.');
  const payloads=new Map(),seen=new Set();let total=0;
  for(const file of files){
    const relative=file.webkitRelativePath;
    if(typeof relative!=='string'||!relative.startsWith(root+'/'))fail('The selected files do not belong to one response folder.');
    const path=relative.slice(root.length+1);
    if(!safePath(path)||seen.has(path.toLowerCase()))fail('The response folder contains an unsafe or duplicate relative path.');
    if(!Number.isSafeInteger(file.size)||file.size<0||file.size>LIMITS.file)fail('A response file exceeds the 100 MB limit.');
    total+=file.size;if(total>LIMITS.zip-1024*1024)fail('The response folder exceeds the supported 256 MB import limit.');
    seen.add(path.toLowerCase());payloads.set(path,file);
  }
  if(!payloads.has('response.json'))fail('Choose the response subfolder containing response.json, not the parent task folder.');
  if(payloads.get('response.json').size>2*1024*1024)fail('The response metadata is too large.');
  return payloads;
}
export async function readResponseFolder(files,lookup){
  const payloads=responseFolderPayloads(files),zip=await zipFiles(payloads);
  if(zip.size>LIMITS.zip)fail('The response folder exceeds the supported import limit.');
  // Same declared-file, exact hash, baseline and finding checks as a ZIP import.
  return readResponse(zip,lookup);
}
