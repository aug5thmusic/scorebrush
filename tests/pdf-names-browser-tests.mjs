// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,relative} from 'node:path';
import {checkLegacyHistoryImport} from './legacy-history-browser-checks.mjs';
import {checkLargeHistory} from './large-history-browser-checks.mjs';

// Real IndexedDB, PDF parsing, OPFS and ZIP validation; isolated synthetic profiles.
export async function runPdfNames({browser,serve,evidence,root,largeOnly=false}){
  const server=await serve(root),contexts=[],log=[],errors=[];let assertions=0;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('pdf-names: '+label);};
  async function page(){
    const context=await browser.newContext({viewport:{width:1350,height:900}});contexts.push(context);
    const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(server.url);await p.waitForFunction(()=>document.body.dataset.ready==='true');
    await p.evaluate(async()=>{
      const modules=await Promise.all(['model','storage','workflow','export','returned','handoff-store','folder-recovery','pdf-versions','finished-pdf','project-history','portable-history','completion','folder-workspace'].map(n=>import('./'+n+'.js')));
      const h=window.historyTest=Object.assign({},...modules),pdf=await import('./vendor/pdf.mjs');
      h.inspect=async files=>{const doc=await pdf.getDocument({data:await files.rendered.blob.arrayBuffer()}).promise,pages=[];try{for(let i=1;i<=doc.numPages;i++){const p=await doc.getPage(i);pages.push({page:i,view:[...p.view],rotation:p.rotate,userUnit:p.userUnit});}return pages;}finally{await doc.destroy();}};
      const png=new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII='),c=>c.charCodeAt(0))]);
      h.maker=async(review,files)=>{const payloads=await h.makeRecovery(review,files);for(const f of review.findings)for(const kind of ['clean','marked'])payloads.set('findings/'+String(f.number).padStart(3,'0')+'-'+f.id+'-'+kind+'.png',png);return h.seal(payloads,JSON.parse(await payloads.get('manifest.json').text()));};
      h.scene=r=>({...r,workspaceId:r.id,doc:{},persistedRevision:r.storageRevision});
      h.commit=async r=>h.putSaved({...r,revisionId:crypto.randomUUID(),review:{...r.review,updatedAt:new Date().toISOString()}},r.storageRevision??null);
      h.at=async(dir,path)=>{const parts=path.split('/');for(const p of parts.slice(0,-1))dir=await dir.getDirectoryHandle(p);return(await dir.getFileHandle(parts.at(-1))).getFile();};
      h.put=async(dir,path,blob)=>{const parts=path.split('/');for(const p of parts.slice(0,-1))dir=await dir.getDirectoryHandle(p,{create:true});const w=await(await dir.getFileHandle(parts.at(-1),{create:true})).createWritable();await w.write(blob);await w.close();};
      h.dump=async function dump(dir,prefix=''){const result=[];for await(const[name,e]of dir.entries())if(e.kind==='directory')result.push(...await dump(e,prefix+name+'/'));else result.push([prefix+name,[...new Uint8Array(await(await e.getFile()).arrayBuffer())]]);return result;};
      h.verify=async dir=>{
        const index=JSON.parse(await(await h.at(dir,'History.json')).text()),files={};
        for(const o of index.objects){const blob=await h.at(dir,o.path);if(blob.size!==o.size||await h.blobHash(blob)!==o.sha256)throw Error('Bad research object '+o.path);}
        for(const name of ['Versions','Latest']){const d=await dir.getDirectoryHandle(name);for await(const[n,e]of d.entries())if(e.kind==='file')files[name+'/'+n]=await h.blobHash(await e.getFile());}
        return {index,files,ready:await h.checkFinishedPDF(dir,index.project.id)};
      };
      h.describe=async snapshot=>{
        const inspected=new Set();
        const decoded=await h.decodeRecovery(snapshot,async files=>{
          const key=JSON.stringify(await Promise.all(['source','rendered','ly'].map(async role=>[files[role].name,await h.blobHash(files[role].blob)])));
          if(inspected.has(key))throw Error('Repeated PDF inspection for identical returned-baseline bytes');inspected.add(key);return h.inspect(files);
        });h.lastInspectionCount=inspected.size;
        return {records:decoded.records.map(r=>({id:r.id,identity:h.recoveryIdentity(r),parent:r.parentHistoryId??null,projectId:r.projectId??null})).sort((a,b)=>a.id.localeCompare(b.id)),handoffs:decoded.entries.map(e=>({id:e.id,metadata:e.task??e.response})).sort((a,b)=>a.id.localeCompare(b.id)),legacy:snapshot.manifest.legacyEvidence??[],output:snapshot.manifest.pdfOutput};
      };
      h.publish=async(dir,scene,base=null)=>{
        const saved=await h.saveRecovery(dir,scene,{source:'source.pdf',rendered:'working.pdf',ly:'score.ly'},{expected:base?.manifest.id??null,projectId:scene.projectId});
        const versions=await h.syncPdfVersions(dir,saved.snapshot);await h.syncProjectHistory(dir,saved.snapshot,{pdfVersions:versions.versions});await h.syncFinishedPDF(dir,saved.snapshot,{pdfVersions:versions.versions});return saved.snapshot;
      };
    });return p;
  }
  try{
    if(!largeOnly)await checkLegacyHistoryImport({newPage:page,check});
    await checkLargeHistory({newPage:page,check,evidence});
    if(largeOnly){check(errors.length===0,'large history completes without uncaught browser errors');return {name:'large-history',assertions};}
    const p=await page();
    const generated=await p.evaluate(async()=>{
      const h=window.historyTest,{fixtureBlob}=await import('./qa/fixtures.js'),{retainLegacyState}=await import('./qa/legacy-journal-fixture.js'),title='SYNTHETIC - Moonlit Widget Sonata.pdf';
      const files={source:{name:'source.pdf',blob:await fixtureBlob('source.pdf')},rendered:{name:title,blob:await fixtureBlob('rendered.pdf')},ly:{name:'score.ly',blob:await fixtureBlob('score.ly')}};
      const {identity,snapshotId}=await h.identify(files),review=h.newReview(identity,snapshotId,await h.inspect(files));
      const finding=(id,number,type,text)=>({id,number,type,comment:text,page:1,state:'open',color:'#ffd34d',strokes:[],bounds:null});
      review.findings=[finding('correction',1,'correction','Original exact correction'),finding('comment',2,'comment','Internal comment'),finding('footnote',3,'source_footnote','Printed source footnote')];review.nextNumber=4;
      // Explicit older per-edit journal: current saves do not create these rows.
      // Its text/type/deletion/undo evidence must still survive export/recovery.
      let first=await retainLegacyState(await h.putSaved({id:snapshotId,review,files,revisionId:crypto.randomUUID(),completions:[],initialTranscriptionFilename:title},null));
      const original=structuredClone(first.review);
      first.review.findings[0].comment='Durably edited text';first=await retainLegacyState(await h.commit(first));
      first.review.findings[1].type='source_footnote';first=await retainLegacyState(await h.commit(first));
      first.review.findings.splice(1,1);first=await retainLegacyState(await h.commit(first));
      first.review.findings.splice(1,0,structuredClone(original.findings[1]));first=await retainLegacyState(await h.commit(first));
      const legacy=(await h.workspaceHistory(first.id)).map(r=>({id:r.id,revisionId:r.revisionId,identity:h.recoveryIdentity(r),parent:r.parentHistoryId??null,review:r.review}));
      const journal=()=>h.workspaceHistory(first.id).then(rows=>rows.map(r=>({id:r.id,revisionId:r.revisionId,identity:h.recoveryIdentity(r),parent:r.parentHistoryId??null,review:r.review})));
      const checkpoints=[];
      async function checkpoint(label){
        first=await h.commit(first);const saved=await h.getSaved(first.id);
        if(h.recoveryIdentity(saved)!==h.recoveryIdentity(first)||saved.storageRevision!==first.storageRevision)throw Error('Current checkpoint changed '+label);
        if(JSON.stringify(await journal())!==JSON.stringify(legacy))throw Error('Ordinary edit changed retained legacy history '+label);
        for(const role of ['source','rendered','ly'])if(await h.blobHash(saved.files[role].blob)!==first.review.files[role].sha256)throw Error('Checkpoint input bytes changed '+role);
        checkpoints.push({label,revisionId:saved.revisionId,snapshotId:saved.review.snapshotId,review:structuredClone(saved.review)});
      }
      first.review.findings[0].comment='SYNTHETIC current checkpoint correction';await checkpoint('note');
      first.review.findings[1].type='source_footnote';await checkpoint('type');
      first.review.findings.splice(1,1);await checkpoint('deletion');
      first.review.findings.splice(1,0,structuredClone(original.findings[1]));await checkpoint('undo');
      const count=(await h.workspaceHistory(first.id)).length;await h.putSaved(first,first.storageRevision);
      if((await h.workspaceHistory(first.id)).length!==count)throw Error('Unchanged save journaled');
      await h.retain({id:crypto.randomUUID(),kind:'review-backup',createdAt:new Date().toISOString(),review:original,files});
      const issued=await h.makeTask(first.review,files,{},'120',()=>{},h.maker);await h.retain(issued);
      const boundaries=[];
      async function returned(task,next,parent){
        const entry=h.responseRevision(await h.rawFolderResponse(task,next));await h.retain(entry);const seed=await h.workspaceSeed(entry,task,h.inspect);
        const prior=await h.getSaved(parent),before=await h.workspaceHistory(parent),resultingSnapshotId=seed.review.snapshotId,resultingRenderSha256=seed.review.files.rendered.sha256;
        const eventId=await h.archiveSavedVersion(parent,prior.storageRevision,{resultingSnapshotId,resultingRenderSha256}),after=await h.workspaceHistory(parent);
        const changed=prior.review.files.rendered.sha256!==resultingRenderSha256,event=after.find(r=>r.id===eventId);
        if(changed?after.length!==before.length+1||!event||h.recoveryIdentity(event)!==h.recoveryIdentity(prior):eventId!==null||JSON.stringify(before)!==JSON.stringify(after))throw Error('Score-version boundary archive differs');
        boundaries.push({changed,eventId,workspaceId:parent,revisionId:prior.revisionId,resultingSnapshotId,resultingRenderSha256});
        return h.putSaved({id:seed.returned.id,...seed,revisionId:crypto.randomUUID(),completions:[],projectId:first.projectId,initialTranscriptionFilename:title,parentWorkspaceId:parent},null);
      }
      let codeOnly=await returned(issued,{...files,ly:{name:'temporary.ly',blob:new Blob([files.ly.blob,'\n% SYNTHETIC code-only revision'])}},first.id);
      const rejected=codeOnly.returned.reported.find(r=>r.id==='correction');
      rejected.state='open';rejected.explanation='Rejected: preserve the original pitch';rejected.decision={state:'open',explanation:rejected.explanation,reviewed:{snapshotId:codeOnly.review.snapshotId,codeSha256:codeOnly.returned.codeSha256,renderSha256:codeOnly.returned.renderSha256}};codeOnly=await h.commit(codeOnly);
      const follow=await h.followupTask(h.scene(codeOnly),'120',()=>{},h.maker);await h.retain(follow);
      let pdfOnly=await returned(follow,{...codeOnly.files,rendered:{name:'temporary proposed.pdf',blob:await fixtureBlob('multipage.pdf')}},codeOnly.id);
      for(const reported of pdfOnly.returned.reported)if(reported.type!=='comment'){
        reported.state='resolved';reported.explanation='Approved exact reviewed bytes';
        reported.decision={state:'resolved',explanation:reported.explanation,reviewed:{snapshotId:pdfOnly.review.snapshotId,codeSha256:pdfOnly.returned.codeSha256,renderSha256:pdfOnly.returned.renderSha256}};
      }
      pdfOnly=await h.commit(pdfOnly);
      pdfOnly.files.rendered={...pdfOnly.files.rendered,name:'Same bytes renamed.pdf'};pdfOnly.review.files.rendered.name='Same bytes renamed.pdf';pdfOnly=await h.commit(pdfOnly);
      // Explicit branch from the original task, with the same PDF and new code.
      const branch=await returned(issued,{...files,ly:{name:'branch.ly',blob:new Blob([files.ly.blob,'\n% SYNTHETIC alternate branch'])}},first.id);
      const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-numbered-history',{create:true});
      const snapshot=await h.publish(dir,h.scene(branch));h.snapshot=snapshot;h.current=branch;h.dir=dir;
      const result=await h.verify(dir),unchanged=await h.syncPdfVersions(dir,snapshot),again=await h.syncFinishedPDF(dir,snapshot,{pdfVersions:unchanged.versions});
      const backup=await h.addPortableHistory(await h.prepareBackup(h.scene(branch),()=>{},h.maker),h.scene(branch),{baseSnapshot:snapshot,pdfVersions:unchanged.versions});
      h.zip=await h.zipFiles(backup.payloads);
      const exactMetadata=await Promise.all(result.index.revisions.map(async r=>({id:r.id,revisionId:r.revisionId,annotations:r.metadata?.annotations?JSON.parse(await snapshot.objects.get(r.metadata.annotations.slice(7)).text()):null,returned:r.metadata?.returned?JSON.parse(await snapshot.objects.get(r.metadata.returned.slice(7)).text()).returned:null})));
      const expected=await h.describe(snapshot),inspectionCount=h.lastInspectionCount;
      return {result,exactMetadata,expected,inspectionCount,legacy,checkpoints,boundaries,dump:await h.dump(dir),zip:[...new Uint8Array(await h.zip.arrayBuffer())],unchanged:{versions:unchanged.written,latest:again.written},ids:{first:first.id,codeOnly:codeOnly.id,pdfOnly:pdfOnly.id,branch:branch.id},hashes:{first:first.review.files.rendered.sha256,second:pdfOnly.review.files.rendered.sha256}};
    });
    const {result,ids,hashes}=generated,index=result.index;
    check(generated.inspectionCount<generated.expected.records.length,'returned history inspects each exact byte/name set once, including freshly unpacked baseline Blobs');
    check(result.files['Versions/0001 - SYNTHETIC - Moonlit Widget Sonata.pdf']===hashes.first&&result.files['Versions/0002 - SYNTHETIC - Moonlit Widget Sonata.pdf']===hashes.second,'original title and stable ordinals identify the exact captured PDF bytes');
    check(result.files['Latest/0002 - SYNTHETIC - Moonlit Widget Sonata.pdf']===hashes.second&&result.ready.number===2,'Latest matches the exact approved Versions entry while the current branch remains unapproved');
    check(generated.unchanged.versions===0&&generated.unchanged.latest===0,'ordinary unchanged publication rewrites no PDFs');
    const initial=index.revisions.find(r=>r.id===ids.first),code=index.revisions.find(r=>r.id===ids.codeOnly),branch=index.revisions.find(r=>r.id===ids.branch);
    check(initial.assetIds.rendered===code.assetIds.rendered&&code.assetIds.rendered===branch.assetIds.rendered&&initial.snapshotId!==code.snapshotId&&code.snapshotId!==branch.snapshotId&&code.pdfVersions[0].number===branch.pdfVersions[0].number,'code-only revisions and branches remain distinct while sharing one rendering number');
    check(code.parentWorkspaceId===ids.first&&branch.parentWorkspaceId===ids.first&&index.revisions.find(r=>r.id===ids.pdfOnly).parentWorkspaceId===ids.codeOnly,'actual task/response and branch relationships are retained without inventing a single chain');
    const checkpoints=generated.checkpoints,findComment=r=>r.review.findings.find(f=>f.id==='comment');
    check(checkpoints.length===4&&new Set(checkpoints.map(r=>r.revisionId)).size===4&&checkpoints.every(r=>r.snapshotId===initial.snapshotId)&&checkpoints[0].review.findings[0].comment==='SYNTHETIC current checkpoint correction'&&findComment(checkpoints[1]).type==='source_footnote'&&!findComment(checkpoints[2])&&findComment(checkpoints[3]).type==='comment','ordinary note, type, deletion and undo saves replace the exact durable checkpoint without adding or changing retained history');
    assert.equal(initial.revisionId,checkpoints.at(-1).revisionId);assert.deepEqual(generated.exactMetadata.find(r=>r.id===ids.first).annotations,checkpoints.at(-1).review);
    for(const retained of generated.legacy){const published=generated.exactMetadata.find(r=>r.id===retained.id);assert.equal(published?.revisionId,retained.revisionId);assert.deepEqual(published.annotations,retained.review);assert.equal(index.revisions.find(r=>r.id===retained.id).parentEventId,retained.parent);}
    check(generated.legacy.length===5&&index.events.some(e=>e.changes?.deleted.includes('comment'))&&index.events.some(e=>e.changes?.added.includes('comment'))&&generated.legacy[0].review.findings[0].comment==='Original exact correction'&&generated.legacy[1].review.findings[0].comment==='Durably edited text'&&findComment(generated.legacy[2]).type==='source_footnote'&&!findComment(generated.legacy[3])&&findComment(generated.legacy[4]).type==='comment','explicit legacy text, type, deletion and undo records retain exact revisions, predecessors and annotations in the public index');
    const boundary=generated.boundaries.find(b=>b.changed),archived=index.revisions.find(r=>r.id===boundary?.eventId);
    check(generated.boundaries.length===3&&generated.boundaries.filter(b=>b.changed).length===1&&archived?.kind==='completed-review'&&archived.workspaceId===ids.codeOnly&&archived.revisionId===boundary.revisionId&&archived.resultingSnapshotId===boundary.resultingSnapshotId&&archived.resultingRenderSha256===hashes.second,'only a new rendering archives the exact departing review with its resulting score identity; code-only and same-PDF branches add no boundary event');
    check(generated.exactMetadata.some(r=>r.returned?.reported.some(f=>f.explanation==='Rejected: preserve the original pitch'))&&index.project.latestApprovedRevision.workspaceId===ids.pdfOnly&&index.coverage.legacyGaps.length>0,'exact rejected/approved decisions, comments, footnotes and explicit legacy gaps are preserved');
    await writeFile(resolve(evidence,'numbered-History.json'),JSON.stringify(index,null,2));await writeFile(resolve(evidence,'numbered-history-backup.zip'),Buffer.from(generated.zip));
    await writeFile(resolve(evidence,'checkpoint-history-contract.json'),JSON.stringify({checkpoints,legacy:generated.legacy,boundaries:generated.boundaries},null,2));
    const example=resolve(evidence,'SYNTHETIC-numbered-project');
    for(const[path,bytes]of generated.dump){const target=resolve(example,path);assert(!relative(example,target).startsWith('..'));await mkdir(dirname(target),{recursive:true});await writeFile(target,Buffer.from(bytes));}
    const folderPage=await page();
    const fromFolder=await folderPage.evaluate(async dump=>{
      const h=window.historyTest,dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-relocated-folder',{create:true});
      for(const[path,bytes]of dump)await h.put(dir,path,new Blob([Uint8Array.from(bytes)]));
      const standalone=await h.verify(dir),snapshot=await h.readRecovery(dir);await h.restoreRecovery(snapshot,h.inspect);
      const versions=await h.syncPdfVersions(dir,snapshot),latest=await h.syncFinishedPDF(dir,snapshot,{pdfVersions:versions.versions});
      return {standalone,description:await h.describe(snapshot),written:versions.written+latest.written};
    },generated.dump);
    assert.deepEqual(fromFolder.description,generated.expected);assert.deepEqual(fromFolder.standalone.index,index);
    check(fromFolder.written===0,'folder-only reconstruction in a fresh profile preserves exact bytes, IDs, branches, title and ordinals without rewriting PDFs');
    const zipPage=await page();
    const fromZip=await zipPage.evaluate(async bytes=>{
      const h=window.historyTest,parsed=await h.readPackage(new Blob([Uint8Array.from(bytes)]),h.inspect),id=await h.importPortableHistory(parsed,h.inspect),record=await h.getSaved(id);
      const dir=await(await navigator.storage.getDirectory()).getDirectoryHandle('SYNTHETIC-restored-ZIP',{create:true});
      const snapshot=await h.publish(dir,h.scene(record)),result=await h.verify(dir);
      // An input rename after restore cannot replace the selected original title.
      const changed={...record,files:{...record.files,rendered:{...record.files.rendered,name:'another proposed.pdf'}},review:structuredClone(record.review)};changed.review.files.rendered.name='another proposed.pdf';
      const saved=await h.commit(changed),next=await h.publish(dir,h.scene(saved),snapshot);
      return {result,description:await h.describe(snapshot),next:await h.verify(dir),restoredTitle:next.manifest.pdfOutput.initialTranscriptionFilename};
    },generated.zip);
    assert.deepEqual(fromZip.description,generated.expected);
    assert.deepEqual(fromZip.result.files,result.files);
    check(fromZip.restoredTitle==='SYNTHETIC - Moonlit Widget Sonata.pdf'&&JSON.stringify(fromZip.next.files)===JSON.stringify(result.files),'ZIP restoration in a third profile keeps every relationship, byte, ordinal and title after working files are renamed');
    check(fromZip.result.index.objects.every(o=>o.path.startsWith('.scorebrush/recovery/objects/')),'restored History.json references actual relocated objects, with no stale ZIP or absolute paths');
    const capacity=await p.evaluate(async()=>{
      const h=window.historyTest,before=await(await h.at(h.dir,'History.json')).text();let pending=await h.getSaved(h.current.id);
      const count=h.snapshot.manifest.records.length+(h.snapshot.manifest.legacyEvidence?.length??0);
      // Batch a coherent journal into this disposable profile. This fixture
      // avoids thousands of UI renders while preserving real durable records.
      const rows=[];let predecessor=pending.historyId;
      for(let n=count;n<=h.HISTORY_LIMITS.records;n++){
        const id='returned-event:'+crypto.randomUUID();pending=structuredClone(pending);pending.returned.reported[0].explanation='SYNTHETIC durable capacity edit '+n;
        pending.revisionId=crypto.randomUUID();pending.storageRevision++;pending.historyId=id;
        rows.push({...pending,id,kind:'returned-event',workspaceId:pending.id,parentHistoryId:predecessor,createdAt:new Date().toISOString(),historyCoverage:'durable-save'});predecessor=id;
      }
      await new Promise((resolve,reject)=>{const open=indexedDB.open('private-score-desk-local-v1');open.onerror=()=>reject(open.error);open.onsuccess=()=>{
        const db=open.result,tx=db.transaction('reviews','readwrite'),store=tx.objectStore('reviews');for(const row of rows)store.add(row);store.put(pending);
        tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};tx.onerror=()=>{};
      }});
      let failure;try{await h.saveRecovery(h.dir,h.scene(pending),h.snapshot.manifest.paths,{expected:h.snapshot.manifest.id});}catch(e){failure={name:e.name,message:e.message,pending:e.pending};}
      return {failure,unchanged:before===await(await h.at(h.dir,'History.json')).text(),generation:(await h.readRecovery(h.dir)).manifest.id,expected:h.snapshot.manifest.id,pendingSaved:(await h.getSaved(pending.id)).revisionId===pending.revisionId,revisionId:pending.revisionId};
    });
    check(capacity.failure?.name==='HistoryCapacityError'&&capacity.failure.pending.includes(capacity.revisionId)&&capacity.unchanged&&capacity.generation===capacity.expected&&capacity.pendingSaved,'overflow at the shared record budget names pending work and preserves the prior index, committed folder and durable browser edits');
    check(errors.length===0,'synthetic history and naming workflows complete without uncaught browser errors');
    return {name:'pdf-names and complete-history round trips',assertions};
  }catch(e){log.push('FAIL '+e.stack);throw e;}
  finally{await writeFile(resolve(evidence,'pdf-names.txt'),log.join('\n')+'\n');for(const c of contexts)await c.close();await server.close();}
}

