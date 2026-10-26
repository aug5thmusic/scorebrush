// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {syncPdfVersions,retainedRenderings,checkPdfVersions} from '../app/pdf-versions.js';
import {sha256} from '../app/model.js';
import {ensureDataDirectory} from '../app/project-directory.js';
import {safeBasename,validPdfName,UNKNOWN_TITLE} from '../app/pdf-output-names.js';
globalThis.crypto??=webcrypto;
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_key,fn)=>fn()}},configurable:true});
const missing=()=>new DOMException('Missing','NotFoundError');
class Dir{
  kind='directory';
  constructor(control={writes:[],steps:0},path=''){this.control=control;this.path=path;this.children=new Map();}
  tick(){if(++this.control.steps===this.control.failAt)throw Error('SYNTHETIC interrupted');}
  async getDirectoryHandle(n,{create=false}={}){let e=this.children.get(n);if(!e&&create){e=new Dir(this.control,this.path+n+'/');this.children.set(n,e);this.tick();}if(!e)throw missing();if(e.kind!=='directory')throw new DOMException('File','TypeMismatchError');return e;}
  async getFileHandle(n,{create=false}={}){let e=this.children.get(n);if(!e&&create){e={kind:'file',blob:new Blob(),getFile:async()=>e.blob,createWritable:async()=>{let b;return {write:async data=>{b=data;this.tick();},close:async()=>{e.blob=b;this.control.writes.push(this.path+n);this.tick();},abort:async()=>{}};}};this.children.set(n,e);this.tick();}if(!e)throw missing();if(e.kind!=='file')throw new DOMException('Directory','TypeMismatchError');return e;}
  async *entries(){yield* this.children;}
  async removeEntry(name){this.children.delete(name);this.tick();}
}
const projectId=crypto.randomUUID();
test('unrelated normalization collisions preserve every entry and agree with the clean proof',async()=>{
  const root=new Dir(),s=await snapshot(['initial']),first=await syncPdfVersions(root,s);s.manifest.pdfOutput=first.output;
  const dir=await root.getDirectoryHandle('Versions'),names=['Caf\u00e9.pdf','Cafe\u0301.pdf','OTHER.pdf','other.pdf'];
  for(const name of names)(await dir.getFileHandle(name,{create:true})).blob=new Blob(['USER '+name]);
  const before=await pdfs(root),writes=root.control.writes.length;
  for(let i=0;i<2;i++){assert.deepEqual(await checkPdfVersions(root,s),first.versions);assert.equal((await syncPdfVersions(root,s)).written,0);}
  assert.deepEqual(await pdfs(root),before);assert.equal(root.control.writes.length,writes);assert.equal(Object.keys(before).length,5);
});
test('owned Unicode and case aliases are stable actionable conflicts, never collapsed or overwritten',async()=>{
  for(const alias of [n=>n.normalize('NFD'),n=>n.toUpperCase()]){
    const root=new Dir(),s=await snapshot(['initial']);s.manifest.initialTranscriptionFilename='Caf\u00e9.pdf';
    const first=await syncPdfVersions(root,s);s.manifest.pdfOutput=first.output;const name=first.versions[0].path.slice(9),dir=await root.getDirectoryHandle('Versions');
    (await dir.getFileHandle(alias(name),{create:true})).blob=new Blob(['USER alias']);const before=await pdfs(root),writes=root.control.writes.length;
    for(let i=0;i<2;i++){await assert.rejects(checkPdfVersions(root,s),/ambiguous owned filename.*Unicode\/case/);await assert.rejects(syncPdfVersions(root,s),/ambiguous owned filename/);}
    assert.deepEqual(await pdfs(root),before);assert.equal(root.control.writes.length,writes);
    await dir.removeEntry(alias(name));assert.deepEqual(await checkPdfVersions(root,s),first.versions);assert.equal((await syncPdfVersions(root,s)).written,0);
  }
});
test('a verified suffix wins over a missing or empty earlier reservation; genuinely missing copies repair',async()=>{
  for(const empty of [false,true]){
    const root=new Dir(),s=await snapshot(['initial']),first=await syncPdfVersions(root,s);s.manifest.pdfOutput=first.output;
    const name=first.versions[0].path.slice(9),dir=await root.getDirectoryHandle('Versions');(await dir.getFileHandle(name)).blob=new Blob(['USER changed']);
    const suffix=await syncPdfVersions(root,s);assert.equal(suffix.written,1);assert.match(suffix.versions[0].path,/ \(2\)\.pdf$/);
    assert.equal(await(await dir.getFileHandle(name)).blob.text(),'USER changed');await dir.removeEntry(name);
    if(empty)(await dir.getFileHandle(name,{create:true})).blob=new Blob();
    const writes=root.control.writes.length;
    assert.deepEqual(await checkPdfVersions(root,s),suffix.versions);assert.deepEqual((await syncPdfVersions(root,s)).versions,suffix.versions);assert.equal(root.control.writes.length,writes);
    assert.equal(Object.values(await pdfs(root)).filter(b=>b===bytes('initial')).length,1);
    await dir.removeEntry(suffix.versions[0].path.slice(9));assert.equal(await checkPdfVersions(root,s),null);assert.equal((await syncPdfVersions(root,s)).written,1);
  }
});
async function snapshot(values=['initial','second']){
  const records=[],objects=new Map();
  async function asset(blob){const info={size:blob.size,sha256:await sha256(await blob.arrayBuffer())};objects.set(info.sha256,blob);return info;}
  for(const [i,value]of values.entries()){
    const pdf=new Blob([new Uint8Array([37,80,68,70,0,255]),value]),info=await asset(pdf);
    const annotations=await asset(new Blob([JSON.stringify({createdAt:'2026-10-'+String(20+i).padStart(2,'0')+'T00:00:00Z',files:{rendered:info}})]));
    records.unshift({id:String(i),payloads:{'annotations.json':annotations,'rendered-original.pdf':info}});
  }
  return {manifest:{projectId,initialTranscriptionFilename:'SYNTHETIC - Moonlit Widget Sonata.pdf',records},objects};
}
async function pdfs(root){const result={};for await(const[n,e]of(await root.getDirectoryHandle('Versions')).entries())if(e.kind==='file')result[n]=Buffer.from(await(await e.getFile()).arrayBuffer()).toString('hex');return result;}
const bytes=s=>Buffer.from(new Uint8Array([37,80,68,70,0,255])).toString('hex')+Buffer.from(s).toString('hex');
test('backfills initial and subsequent exact bytes in chronological readable filenames; ordinary saves write nothing',async()=>{
  const root=new Dir(),s=await snapshot(),first=await syncPdfVersions(root,s);assert.equal(first.count,2);assert.equal(first.written,2);assert.deepEqual(first.versions.map(v=>v.number),[1,2]);
  assert.deepEqual(await pdfs(root),{'0001 - SYNTHETIC - Moonlit Widget Sonata.pdf':bytes('initial'),'0002 - SYNTHETIC - Moonlit Widget Sonata.pdf':bytes('second')});
  const writes=root.control.writes.length,again=await syncPdfVersions(root,s);assert.equal(again.count,2);assert.equal(again.written,0);assert.deepEqual(again.versions,first.versions);assert.equal(root.control.writes.length,writes);
  assert.equal((await syncPdfVersions(root,await snapshot(['initial','second','third','second']))).written,1);assert.equal(Object.keys(await pdfs(root)).length,3);
});
test('embedded task baselines backfill missing initial records; unreviewed responses and marked exports are excluded',async()=>{
  const s=await snapshot(),prior=s.manifest.records.pop(),current=s.manifest.records[0];
  for(const[p,i]of Object.entries(prior.payloads))current.payloads['history/task/'+p]=i;
  current.payloads['rendered-marked.pdf']=prior.payloads['rendered-original.pdf'];
  s.manifest.handoffs=[{kind:'response',payloads:{'rendered-original.pdf':{sha256:'f'.repeat(64),size:123}}}];
  assert.equal((await retainedRenderings(s)).length,2);const root=new Dir();await syncPdfVersions(root,s);assert.equal((await pdfs(root))['0001 - SYNTHETIC - Moonlit Widget Sonata.pdf'],bytes('initial'));
});
test('unrelated files, directories, case collisions and changed former copies are never overwritten',async()=>{
  const root=new Dir(),versions=await root.getDirectoryHandle('Versions',{create:true});(await versions.getFileHandle('0001 - SYNTHETIC - MOONLIT WIDGET SONATA.pdf',{create:true})).blob=new Blob(['PERSONAL']);
  await versions.getDirectoryHandle('0002 - SYNTHETIC - Moonlit Widget Sonata.pdf',{create:true});const s=await snapshot();await syncPdfVersions(root,s);
  assert.equal(await(await(await versions.getFileHandle('0001 - SYNTHETIC - MOONLIT WIDGET SONATA.pdf')).getFile()).text(),'PERSONAL');
  const original=await versions.getFileHandle('0001 - SYNTHETIC - Moonlit Widget Sonata (2).pdf');original.blob=new Blob(['EDITED USER COPY']);await syncPdfVersions(root,s);
  assert.equal(await original.blob.text(),'EDITED USER COPY');assert.equal((await pdfs(root))['0001 - SYNTHETIC - Moonlit Widget Sonata (3).pdf'],bytes('initial'));
});
test('each interrupted creation/write/close resumes without duplicate complete PDFs',async()=>{
  const s=await snapshot(),baseline=new Dir();await ensureDataDirectory(baseline);baseline.control.steps=0;await syncPdfVersions(baseline,s);const steps=baseline.control.steps;
  for(let i=1;i<=steps;i++){const root=new Dir();await ensureDataDirectory(root);root.control.steps=0;root.control.failAt=i;await assert.rejects(syncPdfVersions(root,s),/SYNTHETIC/);root.control.failAt=null;await syncPdfVersions(root,s);const values=Object.values(await pdfs(root));for(const v of ['initial','second'])assert.equal(values.filter(x=>x===bytes(v)).length,1,'checkpoint '+i);}
  console.log('Versions interruption checkpoints:',steps);
});
test('invalid retained hashes and unsafe/foreign version metadata stop before replacing files',async()=>{
  const s=await snapshot(),root=new Dir();s.objects.set(s.manifest.records[0].payloads['rendered-original.pdf'].sha256,new Blob(['CORRUPT']));await assert.rejects(syncPdfVersions(root,s),/identity/);
  const clean=await snapshot();await syncPdfVersions(root,clean);const before=await pdfs(root),journal=await(await root.getDirectoryHandle('.scorebrush')).getDirectoryHandle('pdf-versions');
  const record=await journal.getFileHandle('version-'+crypto.randomUUID()+'.json',{create:true});record.blob=new Blob([JSON.stringify({schema:'scorebrush-pdf-version',version:1,projectId,name:'../escape.pdf'})]);
  await assert.rejects(syncPdfVersions(root,clean),/metadata is invalid/);assert.deepEqual(await pdfs(root),before);
});
test('Versions file collision and permission failure are actionable and retryable',async()=>{
  const s=await snapshot(),root=new Dir();(await root.getFileHandle('Versions',{create:true})).blob=new Blob(['USER FILE']);await assert.rejects(syncPdfVersions(root,s),/Rename that file/);assert.equal(await(await(await root.getFileHandle('Versions')).getFile()).text(),'USER FILE');
  const fresh=new Dir(),original=fresh.getDirectoryHandle.bind(fresh);fresh.getDirectoryHandle=async(n,o)=>{if(n==='Versions')throw new DOMException('Denied','NotAllowedError');return original(n,o);};await assert.rejects(syncPdfVersions(fresh,s),{name:'NotAllowedError'});fresh.getDirectoryHandle=original;assert.equal((await syncPdfVersions(fresh,s)).written,2);
});

test('Windows-safe names preserve exact original Unicode metadata and a stable bounded basename',async()=>{
  for(const [input,expected]of [['CON.pdf','_CON'],['LPT¹.txt.pdf','_LPT¹.txt'],[' Étude: 日本語 / Finale?.pdf','Étude_ 日本語 _ Finale_'],['....pdf',UNKNOWN_TITLE],['e\u0301tude.pdf','étude']]){
    assert.equal(safeBasename(input),expected);assert(validPdfName('0007 - '+expected+'.pdf',7,expected));
  }
  const long='𝄞'.repeat(100)+' Clarinet.pdf',base=safeBasename(long);assert(base.length<=120);assert(!/[\uD800-\uDFFF]/u.test(base));
  const s=await snapshot();s.manifest.initialTranscriptionFilename=long;const root=new Dir(),published=await syncPdfVersions(root,s);
  assert.equal(published.output.initialTranscriptionFilename,long);assert.equal(published.output.basename,base);
  const next=await snapshot(['initial','second','third']);next.manifest.initialTranscriptionFilename='temporary proposed.pdf';
  const again=await syncPdfVersions(root,next);assert.equal(again.output.basename,base);assert.equal(again.output.initialTranscriptionFilename,long);
  assert.deepEqual(again.versions.slice(0,2),published.versions);
});

async function legacy(root,s,{edited=false}={}){
  const owned=await ensureDataDirectory(root),journal=await owned.getDirectoryHandle('pdf-versions',{create:true}),versions=await root.getDirectoryHandle('Versions',{create:true}),assets=await retainedRenderings(s);
  for(const [i,asset]of assets.entries()){
    const number=i?3:7,name=String(number).padStart(4,'0')+' - Revision '+number+'.pdf';
    (await journal.getFileHandle('version-'+crypto.randomUUID()+'.json',{create:true})).blob=new Blob([JSON.stringify({schema:'scorebrush-pdf-version',version:1,projectId,number,name,sha256:asset.sha256,size:asset.size})]);
    (await versions.getFileHandle(name,{create:true})).blob=edited&&i===0?new Blob(['USER EDIT']):asset.blob;
  }
}
test('legacy ordinals survive migration, reordered recovery, renamed inputs and deleted derived copies',async()=>{
  const s=await snapshot(),root=new Dir();await legacy(root,s);
  const result=await syncPdfVersions(root,s);assert.deepEqual(result.versions.map(v=>v.number),[7,3]);
  assert.deepEqual(await pdfs(root),{'0007 - SYNTHETIC - Moonlit Widget Sonata.pdf':bytes('initial'),'0003 - SYNTHETIC - Moonlit Widget Sonata.pdf':bytes('second')});
  const restored=await snapshot(['second','initial']);restored.manifest.pdfOutput=result.output;restored.manifest.initialTranscriptionFilename='proposed.pdf';
  const fresh=new Dir(),copies=await syncPdfVersions(fresh,restored);assert.deepEqual(copies.output,result.output);assert.deepEqual(await pdfs(fresh),await pdfs(root));
  fresh.children.delete('Versions');assert.equal((await syncPdfVersions(fresh,restored)).written,2);assert.deepEqual(await pdfs(fresh),await pdfs(root));
});
test('every legacy migration interruption preserves bytes and resumes without duplicate complete PDFs',async()=>{
  const s=await snapshot(),base=new Dir();await legacy(base,s);base.control.steps=0;await syncPdfVersions(base,s);const steps=base.control.steps;
  for(let i=1;i<=steps;i++){
    const root=new Dir();await legacy(root,s);root.control.steps=0;root.control.failAt=i;
    await assert.rejects(syncPdfVersions(root,s),/SYNTHETIC/);root.control.failAt=null;
    const before=Object.values(await pdfs(root));for(const value of ['initial','second'])assert(before.includes(bytes(value)),'old or new complete bytes at '+i);
    await syncPdfVersions(root,s);assert.deepEqual(await pdfs(root),await pdfs(base),'migration checkpoint '+i);
  }
  console.log('Legacy Versions migration checkpoints:',steps);
});
test('legacy gaps use a persisted honest fallback; edited, case-colliding and unproven old files survive',async()=>{
  const s=await snapshot();delete s.manifest.initialTranscriptionFilename;
  const root=new Dir();await legacy(root,s,{edited:true});
  const copies=await syncPdfVersions(root,s);assert.equal(copies.output.basename,UNKNOWN_TITLE);assert.equal(copies.output.initialTranscriptionFilename,null);
  assert(copies.warnings.some(w=>w.includes('0007 - Revision 7.pdf')));assert.equal((await pdfs(root))['0007 - Revision 7.pdf'],Buffer.from('USER EDIT').toString('hex'));
  s.manifest.initialTranscriptionFilename='later temporary.pdf';assert.equal((await syncPdfVersions(root,s)).output.basename,UNKNOWN_TITLE);
  const unproven=await root.getDirectoryHandle('Versions');(await unproven.getFileHandle('0009 - Revision 9.pdf',{create:true})).blob=new Blob(['PERSONAL']);
  await syncPdfVersions(root,s);assert.equal((await pdfs(root))['0009 - Revision 9.pdf'],Buffer.from('PERSONAL').toString('hex'));
});

test('legacy title backfill requires an original ordinary baseline, not a later proposed task name',async()=>{
  const s=await snapshot();delete s.manifest.initialTranscriptionFilename;
  const initial=s.manifest.records[1],info=initial.payloads['annotations.json'],review=JSON.parse(await s.objects.get(info.sha256).text());
  review.snapshotId='legacy-initial';review.files.rendered.name='Étude originale.pdf';initial.id=review.snapshotId;
  const store=async value=>{const blob=new Blob([JSON.stringify(value)]),info={sha256:await sha256(await blob.arrayBuffer()),size:blob.size};s.objects.set(info.sha256,blob);return info;};
  initial.payloads['annotations.json']=await store(review);
  const task={kind:'task',payloads:{...initial.payloads,'task.json':await store({version:1,baseline:{snapshotId:review.snapshotId},findings:[]})}};
  s.manifest.handoffs=[task];const output=(await syncPdfVersions(new Dir(),s)).output;
  assert.equal(output.initialTranscriptionFilename,'Étude originale.pdf');assert.equal(output.nameSource,'legacy-initial-evidence');
  s.manifest.records=s.manifest.records.filter(r=>r!==initial);
  const unknown=(await syncPdfVersions(new Dir(),s)).output;assert.equal(unknown.initialTranscriptionFilename,null);assert.equal(unknown.nameSource,'unknown');
});
test('conflicting inherited ordinals fail without renumbering or changing old PDF bytes',async()=>{
  const s=await snapshot(),root=new Dir();await legacy(root,s);const prior=await pdfs(root);
  const assets=await retainedRenderings(s);s.manifest.pdfOutput={version:1,initialTranscriptionFilename:s.manifest.initialTranscriptionFilename,basename:'SYNTHETIC - Moonlit Widget Sonata',nameSource:'initial-selection',renderings:assets.map((a,i)=>({number:i+1,size:a.size,sha256:a.sha256}))};
  await assert.rejects(syncPdfVersions(root,s),/numbers conflict/);assert.deepEqual(await pdfs(root),prior);
});

test('a proven legacy filename already equal to the chosen title is adopted without a suffix or PDF rewrite',async()=>{
  const s=await snapshot();s.manifest.initialTranscriptionFilename='Revision 7.pdf';const root=new Dir();await legacy(root,s);
  const dir=await root.getDirectoryHandle('Versions'),before=await(await dir.getFileHandle('0007 - Revision 7.pdf')).getFile(),result=await syncPdfVersions(root,s);
  assert.equal(result.written,1);assert.equal(result.versions[0].path,'Versions/0007 - Revision 7.pdf');assert.equal(await(await dir.getFileHandle('0007 - Revision 7.pdf')).getFile(),before);
  assert.deepEqual(Object.keys(await pdfs(root)).sort(),['0003 - Revision 7.pdf','0007 - Revision 7.pdf']);
});
