// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {scoreNames,safeScoreFilename,readableScorePathOK,researchZipName} from '../app/score-export-names.js';
import {addReadableScores} from '../app/research-export.js';
import {validateExportPayloads,LIMITS} from '../app/package-limits.js';
import {zipFiles} from '../app/export.js';
import {researchHistoryFixture} from './research-history-fixture.mjs';
import {inspectZip} from '../app/workflow.js';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('returned aliases use only the captured project names; unknown names are honest',()=>{
  const scene={returned:{},files:{source:{name:'Étude 原典.pdf'},rendered:{name:'proposed.pdf'},ly:{name:'proposed.ly'}},initialTranscriptionFilename:'Transcription été.pdf'};
  const original={review:{files:{ly:{name:'Mozart 舞曲 K545.ly'}}}};
  const resolved=scoreNames(scene,{ancestors:[original]});
  assert.deepEqual(resolved.names,{source:'Étude 原典.pdf',rendered:'Transcription été.pdf',ly:'Mozart 舞曲 K545.ly'});
  assert.equal(researchZipName(resolved,scene,new Date(2026,9,31,10,30,15)),'Mozart 舞曲 K545-research-20261031-103015.zip');
  assert.equal(scoreNames(scene,{paths:{ly:'notation/Configured Ω.ly'},ancestors:[original]}).names.ly,'Configured Ω.ly');
  const unknown=scoreNames({returned:{},files:{ly:{name:'proposed.ly'},rendered:{name:'proposed.pdf'}}});
  assert.deepEqual(unknown.known,{source:false,rendered:false,ly:false});
  assert.equal(researchZipName(unknown,{projectId:'project-123'},new Date(2026,9,31,10,30,15)),'project-project-123-research-20261031-103015.zip');
});

test('Windows-safe names preserve Unicode; reserved/control/path names stay inert',()=>{
  for(const name of ['CON.pdf','LPT¹.pdf','../A:B?.pdf','...pdf','.hidden.pdf','x\u0000\u202E.pdf','trailing .pdf','😀'.repeat(120)+'.pdf']){
    const safe=safeScoreFilename(name,'source');assert(readableScorePathOK('scores/current/source/'+safe),safe);
  }
  assert.equal(safeScoreFilename('Étude 舞曲 😀.PDF','source'),'Étude 舞曲 😀.PDF');
  for(const path of ['scores/current/source/CON.pdf','scores/current/source/../x.pdf','scores/current/source/x.pdf:stream','scores/current/source/x.pdf.','scores/current/source/a\\b.pdf','scores/current/lilypond/x.pdf','scores/current/source/\u202Ex.pdf'])assert(!readableScorePathOK(path),path);
});

test('readable current/history copies preserve different colliding versions and exact bytes',async()=>{
  const payloads=new Map(),objects=[],revisions=[];
  const object=text=>{const blob=new Blob([text]),hash=sha(text),o={id:'sha256:'+hash,sha256:hash,size:blob.size,path:'workspace-history/recovery/objects/'+hash};objects.push(o);payloads.set(o.path,blob);return o.id;};
  for(const [i,name]of ['A?B.ly','A:B.ly','A_B.ly'].entries()){
    const assetIds={source:object('source '+i),rendered:object('transcription '+i),ly:object('notation '+i)};
    const annotations=object(JSON.stringify({files:{source:{name:'same.pdf'},rendered:{name:'same.pdf'},ly:{name}}}));
    revisions.push({id:'revision-'+i,revisionId:'logical-'+i,snapshotId:'snapshot-'+i,kind:'workspace-head',metadata:{annotations,returned:null},assetIds});
  }
  const index={objects,revisions,project:{current:{recordId:'revision-2'}}};
  const copies=await addReadableScores(index,payloads);assert.equal(copies.length,9);assert.equal(new Set(copies.map(c=>c.path.toLowerCase())).size,9);
  for(const c of copies){assert(readableScorePathOK(c.path));const object=objects.find(o=>o.id===c.assetId);assert.equal(await payloads.get(c.path).text(),await payloads.get(object.path).text());assert.equal(sha(await payloads.get(c.path).text()),c.sha256);}
  assert.equal(copies.filter(c=>c.current).length,3);assert.equal(copies.filter(c=>c.path.endsWith('/A_B.ly')).length,3);
  const round=new Map([...payloads].filter(([p])=>!p.startsWith('scores/')&&p!=='score-files.json'));assert.deepEqual(await addReadableScores(index,round),copies);
});

test('Unicode ZIP headers count toward unchanged capacity limits; normal packages stay strict',async()=>{
  const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
  const payloads=new Map([['scores/current/lilypond/Étude 舞曲.ly',new Blob(['exact notation'])]]);
  assert.throws(()=>validateExportPayloads(payloads),/unsafe/);
  assert.equal((await zipFiles(payloads,undefined,{research:true})).size,validateExportPayloads(payloads,{research:true}).zipBytes);
  assert.throws(()=>validateExportPayloads(new Map([['scores/current/source/NUL.pdf',new Blob()]]),{research:true}),/unsafe/);
  const count=new Map(Array.from({length:LIMITS.count+1},(_,i)=>['synthetic/'+i+'.txt',new Blob()]));assert.throws(()=>validateExportPayloads(count,{research:true}),/5,000/);
  assert.deepEqual(LIMITS,{zip:256*1024*1024,total:512*1024*1024,file:100*1024*1024,count:5000,ratio:200,json:25*1024*1024});
});

test('158 mixed legacy/modern records share nine assets without losing any revision association',async()=>{
  const {payloads,index}=await researchHistoryFixture(),before=new Map(payloads),history=await payloads.get('History.json').text();
  const copies=await addReadableScores(index,payloads),paths=new Set(copies.map(c=>c.path));
  assert.equal(copies.length,474);assert.equal(paths.size,9);assert.equal(index.assets.length,9);
  assert.equal(copies.filter(c=>c.current).length,3);assert.equal([...paths].filter(p=>p.startsWith('scores/history/')).length,6);
  assert.equal(JSON.parse(await payloads.get('score-files.json').text()).version,2);
  for(const r of index.revisions)for(const role of ['source','rendered','ly']){
    const c=copies.find(c=>c.revisionRecordId===r.id&&c.role===role),o=index.objects.find(o=>o.id===r.assetIds[role]);
    assert.equal(c.assetId,o.id);assert.equal(c.revisionId,r.revisionId);assert.equal(c.snapshotId,r.snapshotId);
    assert.deepEqual(await payloads.get(c.path).arrayBuffer(),await payloads.get(o.path).arrayBuffer());
    if(r.assetIds[role]===index.revisions.at(-1).assetIds[role])assert(c.path.startsWith('scores/current/'));
  }
  for(const [p,b]of before)assert.equal(payloads.get(p),b);
  assert.equal(await payloads.get('History.json').text(),history);
  const reordered={...index,revisions:[...index.revisions].reverse()},again=new Map(before);
  assert.deepEqual(await addReadableScores(reordered,again),copies,'stable paths even when revision enumeration changes');
});

test('identical source/transcription keep current roles but share all historical references',async()=>{
  const {payloads,index}=await researchHistoryFixture(9);
  for(const r of index.revisions)r.assetIds.rendered=r.assetIds.source;
  const copies=await addReadableScores(index,payloads),current=copies.filter(c=>c.current);
  assert.equal(new Set(current.map(c=>c.path)).size,3);
  assert.equal(new Set(copies.map(c=>c.path)).size,7,'six distinct assets plus the separate current PDF role');
  for(const r of index.revisions.slice(0,6)){
    const refs=copies.filter(c=>c.revisionRecordId===r.id&&c.role!=='ly');assert.equal(refs[0].path,refs[1].path);
  }
});

test('research uses DEFLATE only when smaller and within the unchanged expansion ratio',async()=>{
  const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
  const moderate=Array.from({length:5000},(_,i)=>'SYNTHETIC checkpoint '+i+' retained observation\n').join('');
  const payloads=new Map([['moderate.txt',new Blob([moderate])],['ratio.txt',new Blob(['x'.repeat(1024*1024)])],['tiny.txt',new Blob(['x'])],['empty.txt',new Blob()]]);
  const zipped=await zipFiles(payloads,undefined,{research:true}),data=await zipped.arrayBuffer(),entries=inspectZip(data);
  assert(zipped.size<validateExportPayloads(payloads,{research:true}).zipBytes);
  const parsed=await JSZip.loadAsync(data);
  for(const [p,b]of payloads)assert.equal(await parsed.file(p).async('string'),await b.text());
  const view=new DataView(data);let offset=view.getUint32(data.byteLength-6,true);const methods={};
  for(let i=0;i<entries.length;i++){
    const length=view.getUint16(offset+28,true),name=new TextDecoder().decode(data.slice(offset+46,offset+46+length));
    methods[name]=view.getUint16(offset+10,true);const compressed=view.getUint32(offset+20,true),expanded=view.getUint32(offset+24,true);
    assert(expanded<=Math.max(1,compressed)*LIMITS.ratio);
    offset+=46+length+view.getUint16(offset+30,true)+view.getUint16(offset+32,true);
  }
  assert.deepEqual(methods,{'moderate.txt':8,'ratio.txt':0,'tiny.txt':0,'empty.txt':0});
  assert.equal((await zipFiles(payloads)).size,validateExportPayloads(payloads).zipBytes,'ordinary export stays STORE');
});

test('research preflight retains expanded/file/count limits while final ZIP size uses compression',()=>{
  const large=new Blob([new Uint8Array(LIMITS.file)]),payloads=new Map(['a','b','c'].map(p=>[p,large]));
  assert.throws(()=>validateExportPayloads(payloads),/256 MB/);
  assert.equal(validateExportPayloads(payloads,{research:true}).total,3*LIMITS.file);
  assert.throws(()=>validateExportPayloads(new Map([['large',new Blob([large,'x'])]]),{research:true}),/100 MB/);
  for(const p of ['d','e','f'])payloads.set(p,large);
  assert.throws(()=>validateExportPayloads(payloads,{research:true}),/512 MB/);
});

test('mixed compression accounts for Unicode headers and STORE fallback at the final ZIP boundary',async()=>{
  const module={exports:{}};Function('module','exports',await readFile(new URL('../app/vendor/jszip.min.js',import.meta.url),'utf8'))(module,module.exports);globalThis.JSZip=module.exports;
  const payloads=new Map([['scores/current/lilypond/Étude 舞曲.ly',new Blob(['0'.repeat(1024*1024)])],['notes.txt',new Blob([Array.from({length:100},(_,i)=>'SYNTHETIC note '+i).join('\n')])]]);
  const actual=await zipFiles(payloads,undefined,{research:true}),limit=LIMITS.zip;
  try{
    LIMITS.zip=actual.size;assert.equal((await zipFiles(payloads,undefined,{research:true})).size,actual.size);
    LIMITS.zip=actual.size-1;await assert.rejects(zipFiles(payloads,undefined,{research:true}),/256 MB/);
  }finally{LIMITS.zip=limit;}
});
