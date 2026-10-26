// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {identify,newReview} from '../app/model.js';
import {makeRecovery} from '../app/export.js';
import {makeTask,json,fileInfo} from '../app/workflow.js';
import {saveTaskFolder,responseFolderPayloads,readResponseFolder} from '../app/folder-io.js';

globalThis.crypto??=webcrypto;
globalThis.fetch=async url=>new Response(await readFile(url));
const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
const error=(name,message)=>Object.assign(new Error(message),{name});
class FileHandle{
  constructor(name,options){this.kind='file';this.name=name;this.options=options;this.blob=new Blob();}
  async createWritable(){const owner=this;return {write:async blob=>{if(owner.options.failOn===owner.name)throw new Error('Simulated disk full');owner.blob=blob;},close:async()=>{},abort:async()=>{owner.aborted=true;}};}
}
class DirectoryHandle{
  constructor(name,options={}){this.kind='directory';this.name=name;this.children=new Map();this.options=options;}
  async getDirectoryHandle(name,{create=false}={}){const existing=this.children.get(name);if(existing?.kind==='file')throw error('TypeMismatchError','Existing file');if(existing)return existing;if(!create)throw error('NotFoundError','Missing');const child=new DirectoryHandle(name,this.options);this.children.set(name,child);return child;}
  async getFileHandle(name,{create=false}={}){const existing=this.children.get(name);if(existing?.kind==='directory')throw error('TypeMismatchError','Existing directory');if(existing)return existing;if(!create)throw error('NotFoundError','Missing');const child=new FileHandle(name,this.options);this.children.set(name,child);return child;}
  async *values(){yield* this.children.values();}
}
const files={source:{name:'source.pdf',blob:new Blob(['%PDF-source'])},rendered:{name:'rendered.pdf',blob:new Blob(['%PDF-rendered'])},ly:{name:'score.ly',blob:new Blob(['% Synthetic test\n{ c4 }'])}};
const {identity,snapshotId}=await identify(files),review=newReview(identity,snapshotId,[{page:1,view:[0,0,400,500],rotation:0,userUnit:1}]);
review.findings=[{id:'finding-one',number:1,page:1,comment:'Check the accidental',state:'open',color:'#ffd34d',strokes:[],bounds:null}];review.nextNumber=2;
const task=await makeTask(review,files,{},'page',()=>{},makeRecovery);
const selected=(path,blob)=>Object.defineProperty(new File([blob],path.split('/').at(-1)), 'webkitRelativePath',{value:path});

test('folder export writes exact inputs into a new destination and never reuses existing content',async()=>{
  const parent=new DirectoryHandle('My private music');
  const existing=await parent.getDirectoryHandle('keep',{create:true});const note=await existing.getFileHandle('notes.txt',{create:true});note.blob=new Blob(['My notes']);
  const saved=await saveTaskFolder(parent,task,{folderName:'new-task'}),directory=parent.children.get(saved.name);
  assert.equal(saved.taskId,task.id);assert.equal(saved.fileCount,task.payloads.size);
  assert.equal(await directory.children.get('source-original.pdf').blob.text(),await files.source.blob.text());
  assert.equal(await directory.children.get('lilypond').children.get('supplied.ly').blob.text(),await files.ly.blob.text());
  assert.equal(await directory.children.get('PROMPT.txt').blob.text(),task.prompt);
  assert.equal(directory.children.get('response').kind,'directory');
  await assert.rejects(saveTaskFolder(parent,task,{folderName:'keep'}),/already exists/);
  await assert.rejects(saveTaskFolder(parent,task,{folderName:'new-task'}),/already exists/);
  await assert.rejects(saveTaskFolder(parent,task,{folderName:'../escape'}),/invalid/);
  assert.equal(await note.blob.text(),'My notes');assert.equal(existing.children.size,1);
});

test('failed folder writes report incomplete status without replacing unrelated data',async()=>{
  const parent=new DirectoryHandle('Chosen folder',{failOn:'task.json'}),kept=await parent.getFileHandle('personal.txt',{create:true});kept.blob=new Blob(['Keep this']);
  await assert.rejects(saveTaskFolder(parent,task,{folderName:'partial'}),/incomplete.*disk full/);
  assert.equal(await kept.blob.text(),'Keep this');
  assert.equal(parent.children.get('partial').children.has('PROMPT.txt'),false,'instruction file written only after task files');
});

test('response folder paths and limits are checked before ZIP interpretation',()=>{
  assert.throws(()=>responseFolderPayloads([]),/empty/);
  assert.throws(()=>responseFolderPayloads([selected('reply/../response.json',json({}))]),/unsafe/);
  assert.throws(()=>responseFolderPayloads([selected('reply/response.json',json({})),selected('reply/RESPONSE.JSON',json({}))]),/duplicate/);
  assert.throws(()=>responseFolderPayloads([selected('reply/response.json',json({})),selected('other/corrected.ly',new Blob(['x']))]),/one response folder/);
  assert.throws(()=>responseFolderPayloads([selected('task/response/response.json',json({}))]),/response subfolder/);
  assert.throws(()=>responseFolderPayloads([{webkitRelativePath:'reply/response.json',size:101*1024*1024}]),/100 MB/);
  assert.throws(()=>responseFolderPayloads([{webkitRelativePath:'reply/response.json',size:3*1024*1024}]),/metadata is too large/);
  const accepted=responseFolderPayloads([selected('Reply folder with spaces/response.json',json({}))]);assert.ok(accepted.has('response.json'));
});

test('response folder import uses the same exact baseline and hash checks as ZIP import',async()=>{
  const response=JSON.parse(await task.payloads.get('response-template.json').text()),code=new Blob(['% Synthetic correction\n{ cis4 }']);
  response.code={status:'changed',path:'corrected.ly'};response.files={'corrected.ly':await fileInfo(code)};response.results[0]={id:'finding-one',status:'changed',explanation:'Corrected accidental'};
  const chosen=[selected('response/response.json',json(response)),selected('response/corrected.ly',code)],lookup=async id=>id===task.id?task:null;
  const imported=await readResponseFolder(chosen,lookup);assert.equal(imported.issued.id,task.id);assert.equal(await imported.payloads.get('corrected.ly').text(),await code.text());
  await assert.rejects(readResponseFolder([chosen[0],selected('response/corrected.ly',new Blob(['Different bytes']))],lookup),/integrity check/);
  await assert.rejects(readResponseFolder([...chosen,selected('response/README.txt',new Blob(['Unrelated']))],lookup),/undeclared/);
});
