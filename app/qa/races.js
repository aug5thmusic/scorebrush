// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {getSaved,listSaved,returnedHistory} from '../storage.js';
if(['8939','8945','8964','8967','8995'].includes(location.port)||location.hostname!=='127.0.0.1')throw new Error('Run QA on a separate loopback port, never a working ScoreBrush origin.');
const channelName='score-desk-races-'+crypto.randomUUID(),channel=new BroadcastChannel(channelName),pending=new Map(),ready=new Set();
const out=document.getElementById('results'),run=document.getElementById('run'),next=document.getElementById('continue');
for(const slot of ['A','B'])document.getElementById('open'+slot).href=`./tab.html?slot=${slot}&channel=${channelName}`;
channel.onmessage=e=>{if(e.data.ready){ready.add(e.data.ready);out.textContent=`Connected: ${[...ready].join(', ')}`;run.disabled=ready.size!==2;return;}const request=pending.get(e.data.id);if(request){pending.delete(e.data.id);clearTimeout(request.timer);e.data.error?request.reject(new Error(e.data.error)):request.resolve(e.data.result);}};
const ask=(to,action,arg)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout: '+to+' '+action));},60000);pending.set(id,{resolve,reject,timer});channel.postMessage({id,to,action,arg});});
const log=s=>out.textContent+=s+'\n';
let passed=0;
const assert=(test,label)=>{if(!test)throw new Error(label);passed++;log('PASS '+label);};
const until=async(test,label)=>{const end=Date.now()+60000;while(Date.now()<end){const value=await test();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw new Error('Timeout: '+label);};
const settled=async slot=>until(async()=>{const s=await ask(slot,'stats');return !s.busy&&!s.dirty?s:false;},'settled '+slot);
const tag=()=>crypto.randomUUID();
run.onclick=async()=>{
  out.textContent='';run.disabled=true;passed=0;
  try{
    assert(await ask('A','rejectsOldClient'),'old database-version clients cannot reopen an unguarded writer');
    await ask('A','load',{tag:tag()});await ask('A','add',{comment:'legacy record'});await ask('A','legacyRecord');await ask('A','reload');assert((await ask('A','stats')).persistedRevision===0,'existing records without revision metadata reopen unchanged');await ask('A','edit',{comment:'legacy record edited safely'});await ask('A','save');assert((await ask('A','stored')).storageRevision===1,'first legacy-record edit uses an atomic revision-zero check');
    const shared=tag();await ask('A','load',{tag:shared});await ask('A','add',{comment:'initial'});await ask('B','load',{tag:shared});
    await ask('A','add',{comment:'newer finding from A'});const aSaved=await ask('A','stored');await ask('B','hidden');const afterHidden=await ask('B','stored');
    assert(afterHidden.storageRevision===aSaved.storageRevision&&afterHidden.review.findings.length===2,'unchanged hidden tab B cannot overwrite newer A findings');
    await ask('B','edit',{comment:'local conflicting B comment'});await ask('B','save');const b=await ask('B','stats'),afterConflict=await ask('A','stored');
    assert(b.dirty&&b.saveConflict&&b.unprotected&&b.comment.includes('conflicting B')&&afterConflict.storageRevision===aSaved.storageRevision&&afterConflict.review.findings.length===2,'edited stale tab retains local edits and rejects overwrite atomically');
    await ask('B','recover');await until(async()=>(await ask('B','stats')).recoveryStamp,'conflict recovery');const conflictZip=await ask('B','downloaded');
    assert(conflictZip.review.findings[0].comment==='local conflicting B comment'&&(await ask('A','stored')).review.findings[0].comment==='initial','conflict recovery preserves local version separately from saved version');
    // A fresh pair edits from the same baseline; race the actual CAS writes.
    const concurrent=tag();await ask('A','load',{tag:concurrent});await ask('A','add',{comment:'baseline'});await ask('B','load',{tag:concurrent});await ask('A','delay',{name:'putSaved'});await ask('B','delay',{name:'putSaved'});await ask('A','edit',{comment:'racing A'});await ask('B','edit',{comment:'racing B'});
    const racingSaves=Promise.all([ask('A','save'),ask('B','save')]);await until(()=>ask('A','started',{name:'putSaved'}),'A CAS barrier');await until(()=>ask('B','started',{name:'putSaved'}),'B CAS barrier');await Promise.all([ask('A','release',{name:'putSaved'}),ask('B','release',{name:'putSaved'})]);await racingSaves;const pair=await Promise.all([ask('A','stats'),ask('B','stats')]);
    assert(pair.filter(s=>s.saveConflict&&s.unprotected).length===1&&pair.filter(s=>!s.dirty).length===1,'two simultaneous edited tabs produce exactly one saved winner and one protected conflict');
    for(const slot of ['A','B'])if((await ask(slot,'stats')).saveConflict){await ask(slot,'recover');await until(async()=>(await ask(slot,'stats')).recoveryStamp,'race recovery');}
    await ask('A','load',{tag:tag()});await ask('A','add',{comment:'before immediate reopen'});
    await ask('A','delay',{name:'putSaved'});const edit=await ask('A','edit',{comment:'latest comment before debounce'});await ask('A','reopen');await until(()=>ask('A','started',{name:'putSaved'}),'held reopen save');
    const locked=await ask('A','edit',{comment:'must not enter during transition'});assert(locked.busy&&locked.commentDisabled&&locked.comment===edit.comment,'snapshot transition blocks edits before awaiting its save');
    await ask('A','release',{name:'putSaved'});const reopened=await settled('A'),savedReopen=await ask('A','stored');
    assert(savedReopen.review.findings[0].comment===edit.comment&&reopened.comment===edit.comment&&reopened.undoLength===edit.undoLength,'immediate active Reopen flushes latest comment and preserves undo history');
    await ask('A','undo');await ask('A','save');assert((await ask('A','stored')).review.findings[0].comment==='before immediate reopen','undo still works after active Reopen');
    // Hold real backup generation. Native Escape requests cancellation, while
    // the application retains the edit lock until package work has stopped.
    await ask('A','delay',{name:'makePackage'});await ask('A','startBackup');await until(()=>ask('A','started',{name:'makePackage'}),'held backup');
    next.hidden=false;log('WAITING: press Escape in test tab A, then Continue here.');await new Promise(resolve=>next.onclick=resolve);next.hidden=true;
    const escaped=await ask('A','escape'),during=await ask('A','edit',{comment:'must not enter during backup'});
    assert(escaped.dialog&&escaped.cancelPrevented&&escaped.cancelled&&during.commentDisabled&&during.prepareDisabled&&during.comment==='before immediate reopen','Escape requests cancellation without exposing editable comments during backup preparation');
    await ask('A','release',{name:'makePackage'});await until(async()=>{const s=await ask('A','stats');return !s.busy&&s.progress.startsWith('Backup cancelled');},'cancelled backup');
    assert((await ask('A','stats')).links===0,'cancelled backup preparation publishes no download');
    await ask('A','delay',{name:'makePackage',fail:true});await ask('A','startBackup');await until(()=>ask('A','started',{name:'makePackage'}),'failing backup');await ask('A','release',{name:'makePackage'});await until(async()=>!(await ask('A','stats')).busy,'backup failure');
    const failed=await ask('A','stats');assert(failed.links===0&&!failed.prepareDisabled&&failed.progress.includes('failed'),'failed backup leaves no partial links and restores retry controls');
    await ask('A','delay',{name:'zipFiles'});await ask('A','startBackup');await until(()=>ask('A','started',{name:'zipFiles'}),'held ZIP');assert((await ask('A','stats')).links===0,'backup downloads remain unpublished while ZIP packaging is pending');await ask('A','closeBackup');await ask('A','release',{name:'zipFiles'});await until(async()=>!(await ask('A','stats')).busy,'discarded backup');
    assert((await ask('A','stats')).links===0,'dialog cancellation during ZIP packaging discards the download');
    await ask('A','startBackup');await until(async()=>{const s=await ask('A','stats');return !s.busy&&s.title==='Backup ready';},'retry backup');assert((await ask('A','stats')).links===1,'backup works again after failed and cancelled operations');await ask('A','closeBackup');
    await ask('A','edit',{comment:'newer edit after backup'});assert((await ask('A','stats')).links===0,'editing the review revokes the outdated backup link');await ask('A','save');
    await ask('A','failStorage');await ask('A','edit',{comment:'recovery captured revision'});await ask('A','save');
    await ask('A','delay',{name:'makeRecovery'});await ask('A','recover');await until(()=>ask('A','started',{name:'makeRecovery'}),'held recovery');await ask('A','edit',{comment:'newer unsaved edit during packaging'});await ask('A','save');await ask('A','release',{name:'makeRecovery'});
    await until(async()=>{const s=await ask('A','stats');return s.message.includes('earlier revision');},'outdated recovery');const recovered=await ask('A','downloaded'),newer=await ask('A','stats'),unload=await ask('A','unload');
    assert(recovered.review.findings[0].comment==='recovery captured revision'&&newer.unprotected&&unload.prevented,'older recovery ZIP does not suppress unload protection for newer unsaved edits');
    await ask('A','reopen');await until(async()=>!(await ask('A','stats')).busy,'blocked switch');assert((await ask('A','stats')).message.includes('latest edits'),'older recovery ZIP does not bypass the snapshot-switch guard');
    await ask('A','delay',{name:'makeRecovery',fail:true});await ask('A','recover');await until(()=>ask('A','started',{name:'makeRecovery'}),'failing recovery');await ask('A','release',{name:'makeRecovery'});await until(async()=>(await ask('A','stats')).message.includes('Injected makeRecovery failure'),'recovery failure');assert((await ask('A','unload')).prevented,'failed recovery also retains unsaved-work protection');
    await ask('A','recover');await until(async()=>!(await ask('A','stats')).unprotected,'current recovery');const latestZip=await ask('A','downloaded');assert(latestZip.review.findings[0].comment==='newer unsaved edit during packaging'&&!(await ask('A','unload')).prevented,'retry recovery covers exactly the current revision');
    await ask('A','restoreStorage');await ask('A','save');assert(!(await ask('A','stats')).dirty&&(await ask('A','stored')).review.findings[0].comment==='newer unsaved edit during packaging','successful save still works after quota and recovery failures');
    const candidates=await listSaved();let round;
    for(const item of candidates){const record=await getSaved(item.id);if(record.returned&&record.review.files.rendered.name.startsWith('SIMULATED-')&&record.returned.reported.length>=2&&record.returned.reported.slice(0,2).every(f=>!f.decision)){round=record;break;}}
    if(round){
      const retainedHistory=JSON.stringify(await returnedHistory(round.id));
      await ask('A','openSaved',{id:round.id});await ask('B','openSaved',{id:round.id});await ask('A','roundDecide');await until(async()=>!(await ask('A','round')).busy,'A returned decision');const winner=await ask('A','roundStored'),eventCount=(await returnedHistory(round.id)).length;
      await ask('B','roundDecide');await until(async()=>!(await ask('B','round')).busy,'B stale decision');const stale=await ask('B','round');
      const staleStored=await ask('B','roundStored'),staleEvents=(await returnedHistory(round.id)).length;
      const staleProtected=stale.message.includes('Another tab saved newer')&&staleStored.storageRevision===winner.storageRevision&&staleEvents===eventCount;
      if(!staleProtected)log('DIAGNOSTIC '+JSON.stringify({message:stale.message,winnerRevision:winner.storageRevision,storedRevision:staleStored.storageRevision,eventsBefore:eventCount,eventsAfter:staleEvents}));
      assert(staleProtected,'stale returned-review tab cannot overwrite a newer decision or create a false history event');
      await ask('B','roundReload');await until(async()=>{const s=await ask('B','round');return !s.busy&&s.progress.startsWith('1 of');},'reload newer returned review');await ask('B','roundNext');await ask('B','roundDecide');await until(async()=>!(await ask('B','round')).busy,'B cumulative returned decision');const combined=await ask('B','roundStored');
      assert(combined.returned.reported.slice(0,2).every(f=>f.state==='resolved')&&combined.returned.reported.slice(0,2).every(f=>f.decision.reviewed.codeSha256===combined.returned.codeSha256),'reloading a stale tab then deciding preserves both humans decisions for the exact reviewed files');
      const chain=await returnedHistory(round.id);assert(JSON.stringify(chain)===retainedHistory&&combined.storageRevision>winner.storageRevision,'cumulative returned decisions update the durable head while preserving exact existing version history');
    }else log('Returned-review tab checks require disposable workspace fixtures from qa/workflow.html first.');
    log(`\nALL ${passed} RACE REGRESSIONS PASSED · ${location.origin} · disposable snapshots only.`);
  }catch(error){out.className='fail';log('FAIL '+error.stack);}
  finally{run.disabled=false;next.hidden=true;for(const slot of ['A','B'])try{await ask(slot,'restoreStorage');}catch{}}
};
