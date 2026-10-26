// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {fixtureBlob} from './fixtures.js';
import {getSaved} from '../storage.js';
import {identify} from '../model.js';
if(['8939','8945','8964','8967','8995'].includes(location.port)||location.hostname!=='127.0.0.1')throw new Error('Run QA on an isolated loopback port, never a working ScoreBrush origin.');
const params=new URLSearchParams(location.search),slot=params.get('slot'),channel=new BroadcastChannel(params.get('channel'));
const frame=document.getElementById('app'),label=document.getElementById('status');
frame.src='../index.html';
document.title=`ScoreBrush test tab ${slot}`;
const wait=async(fn,label)=>{const end=Date.now()+30000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw new Error('Timeout: '+label);};
const $=id=>frame.contentDocument.getElementById(id),api=()=>frame.contentWindow.scoreDeskQA;
const fire=(id,type)=>$(id).dispatchEvent(new frame.contentWindow.Event(type,{bubbles:true}));
let gates={},downloads=[],putOriginal=null;
async function bridge(){await wait(()=>frame.contentDocument?.body?.dataset.ready==='true','app ready');if(!api()){const script=frame.contentDocument.createElement('script');script.type='module';script.src='./qa/bridge.js';frame.contentDocument.body.append(script);await wait(()=>api(),'QA bridge');}api().operations.download=async(blob,name)=>downloads.push({blob,name});}
function stats(){return {...api().sessionStatus(),message:[$('message').textContent,$('statusSummary').title].filter(Boolean).join('\n'),storage:$('storage').textContent,comment:$('comment').value,commentDisabled:$('comment').disabled,dialog:$('finishDialog').open,progress:$('finishStatus').textContent,title:$('finishTitle').textContent,links:$('finishDownloads').children.length,prepareDisabled:$('prepareFinish').disabled,cancelled:Boolean(api().completion.job()?.cancelled)};}
async function choose(id,blob,name){const dt=new frame.contentWindow.DataTransfer();dt.items.add(new frame.contentWindow.File([blob],name));$(id).files=dt.files;fire(id,'change');}
async function select(){if($('editor').hidden){frame.contentDocument.querySelector('.finding-open').click();await wait(()=>$('renderedPaper').getAttribute('aria-busy')==='false','selection render');}}
function edit(value){$('comment').value=value;fire('comment','input');}
async function stroke(){await wait(()=>$('renderedPaper').getAttribute('aria-busy')==='false','pointer render');const c=$('overlay'),r=c.getBoundingClientRect(),w=frame.contentWindow;for(const [type,x]of [['pointerdown',70],['pointermove',95],['pointerup',95]])c.dispatchEvent(new w.PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',button:0,buttons:type==='pointerup'?0:1,clientX:r.left+x,clientY:r.top+90}));}
const actions={
  async load({tag}){
    const blobs=await Promise.all(['source.pdf','rendered.pdf','score.ly'].map(async n=>fixtureBlob(n)));
    blobs[2]=new Blob([blobs[2],`\n% disposable race fixture ${tag}\n`]);
    const {snapshotId}=await identify({source:{name:'race-source.pdf',blob:blobs[0]},rendered:{name:'race-rendered.pdf',blob:blobs[1]},ly:{name:'race.ly',blob:blobs[2]}});
    await choose('sourceFile',blobs[0],'race-source.pdf');await choose('renderedFile',blobs[1],'race-rendered.pdf');await choose('lyFile',blobs[2],'race.ly');
    $('load').click();await wait(()=>!api().sessionStatus().busy&&api().sessionStatus().snapshotId===snapshotId&&$('renderedPaper').getAttribute('aria-busy')==='false','snapshot load');await api().saveNow();return stats();
  },
  async add({comment}){$('newFinding').click();edit(comment);await stroke();$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');await api().saveNow();return stats();},
  async edit({comment}){await select();edit(comment);return stats();},
  async save(){await api().saveNow();return stats();},
  async openSaved({id}){$('saved').value=id;$('reopen').click();await wait(()=>!api().sessionStatus().busy&&api().sessionStatus().workspaceId===id&&$('correctionComparison').getAttribute('aria-busy')==='false','returned workspace open');return stats();},
  round(){return {workspaceId:api().sessionStatus().workspaceId,busy:api().sessionStatus().busy||$('correctionComparison').getAttribute('aria-busy')==='true',progress:$('roundProgress').textContent,message:stats().message,status:$('roundStatus').textContent};},
  roundDecide(){$('looksCorrect').click();return actions.round();},
  async roundNext(){$('skipCorrection').click();await wait(()=>$('correctionComparison').getAttribute('aria-busy')==='false','finding navigation');return actions.round();},
  roundReload(){$('roundReload').click();return actions.round();},
  roundStored(){return getSaved(api().sessionStatus().workspaceId);},
  async stored(){return (await getSaved(api().sessionStatus().snapshotId));},
  async legacyRecord(){
    const record=await getSaved(api().sessionStatus().snapshotId);delete record.storageRevision;
    await new Promise((resolve,reject)=>{const r=indexedDB.open('private-score-desk-local-v1');r.onsuccess=()=>{const db=r.result,tx=db.transaction('reviews','readwrite');tx.objectStore('reviews').put(record);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};r.onerror=()=>reject(r.error);});return true;
  },
  async rejectsOldClient(){return new Promise((resolve,reject)=>{const r=indexedDB.open('private-score-desk-local-v1',1);r.onerror=()=>resolve(r.error.name==='VersionError');r.onsuccess=()=>{r.result.close();resolve(false);};});},
  async hidden(){const doc=frame.contentDocument,own=Object.getOwnPropertyDescriptor(doc,'hidden');Object.defineProperty(doc,'hidden',{configurable:true,get:()=>true});doc.dispatchEvent(new frame.contentWindow.Event('visibilitychange'));if(own)Object.defineProperty(doc,'hidden',own);else delete doc.hidden;await api().saveNow();return stats();},
  stats,
  delay({name,fail=false}){
    const original=api().operations[name];let release;const gate={started:false,release:null,original};
    const promise=new Promise(r=>release=r);gate.release=release;gates[name]=gate;
    api().operations[name]=async(...args)=>{gate.started=true;await promise;if(fail)throw new Error('Injected '+name+' failure');return original(...args);};return true;
  },
  release({name}){const gate=gates[name];api().operations[name]=gate.original;gate.release();return true;},
  started({name}){return Boolean(gates[name]?.started);},
  reopen(){$('saved').value=api().sessionStatus().snapshotId;$('reopen').click();return stats();},
  undo(){$('undo').click();return stats();},
  failStorage(){const proto=frame.contentWindow.IDBObjectStore.prototype;putOriginal??=proto.put;proto.put=function(){throw new frame.contentWindow.DOMException('Injected storage quota failure','QuotaExceededError');};return true;},
  restoreStorage(){if(putOriginal)frame.contentWindow.IDBObjectStore.prototype.put=putOriginal;putOriginal=null;return true;},
  startBackup(){if(!$('finishDialog').open)void api().completion.open();else $('prepareFinish').click();return stats();},
  escape(){const w=frame.contentWindow,cancel=new w.Event('cancel',{cancelable:true});$('finishDialog').dispatchEvent(cancel);return {cancelPrevented:cancel.defaultPrevented,...stats()};},
  closeBackup(){$('finishDialog').close();return stats();},
  recover(){$('emergency').click();return stats();},
  async downloaded(){const last=downloads.at(-1);if(!last)return null;const zip=await frame.contentWindow.JSZip.loadAsync(last.blob);return {name:last.name,review:JSON.parse(await zip.file('annotations.json').async('string'))};},
  unload(){const event=new frame.contentWindow.Event('beforeunload',{cancelable:true});frame.contentWindow.dispatchEvent(event);return {prevented:event.defaultPrevented,...stats()};},
  async reload(){frame.contentWindow.location.reload();await new Promise(r=>frame.addEventListener('load',r,{once:true}));await bridge();return stats();}
};
await bridge();label.textContent=`Disposable test app ${slot} · ${location.origin} · connected`;
channel.onmessage=async e=>{const {id,to,action,arg}=e.data;if(to!==slot)return;try{const result=await actions[action](arg??{});channel.postMessage({id,result});label.textContent=`Test app ${slot} · last operation: ${action}\n${JSON.stringify(stats(),null,2)}`;}catch(error){channel.postMessage({id,error:error.message});}};
channel.postMessage({ready:slot});

