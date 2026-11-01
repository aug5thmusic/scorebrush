// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Real IndexedDB checks for the inactive core, using a fresh synthetic origin.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function runCaptureCore({browser,serve,evidence,root}){
  const server=await serve(root),context=await browser.newContext(),page=await context.newPage();
  const log=[];let assertions=0,details;
  const check=(ok,label)=>{assert(ok,label);assertions++;log.push('PASS '+label);console.log('capture-core: '+label);};
  await page.route('**/synthetic-capture-core',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>SYNTHETIC inactive capture core</title>'}));
  try{
    await page.goto(server.origin+'/synthetic-capture-core');
    details=await page.evaluate(async()=>{
      const beforeImports=await indexedDB.databases();
      const format=await import('./capture-format.js'),core=await import('./capture-store.js');
      const {createCaptureWriter,prepareCaptureCommit,preparedCaptureData,prepareCapturePayload,hashCaptureRecord,sha256CaptureBytes}=format;
      const {installCaptureSchema,commitCapture,readCaptureCurrent,captureStoredRowBytes,CAPTURE_STORAGE_LIMITS}=core;
      const stores=['reviews','captureEvents','captureStreams','captureOutbox','captureBlobs'];
      const records=[];window.captureCoreTestRecords=records;
      const expect=(condition,message)=>{if(!condition)throw new Error(message);};
      const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
      const test=async(name,fn)=>{try{const value=await fn();records.push({name,pass:true,details:value??null});}catch(error){records.push({name,pass:false,error:{name:error.name,message:error.message,stack:error.stack}});throw error;}};
      const refused=async(fn,label)=>{try{await fn();}catch(error){return {name:error.name,code:error.code??null,message:error.message};}throw new Error(label+' unexpectedly succeeded');};
      const open=name=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>{try{installCaptureSchema(r.result,r.transaction);}catch(error){r.transaction.abort();reject(error);}};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('Synthetic database unexpectedly blocked'));});
      const rows=async(db)=>{
        const result={};
        await new Promise((resolve,reject)=>{const tx=db.transaction(stores,'readonly');for(const name of stores){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{result[name]=r.result.sort((a,b)=>String(a.id).localeCompare(String(b.id)));};}tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
        return result;
      };
      const inspectBytes=async value=>{
        if(value instanceof Blob)return {blobType:value.type,blobBytes:value.size,exactHex:[...new Uint8Array(await value.arrayBuffer())].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
        if(Array.isArray(value))return Promise.all(value.map(inspectBytes));
        if(value&&typeof value==='object'){const result={};for(const key of Object.keys(value))result[key]=await inspectBytes(value[key]);return result;}
        return value;
      };
      const snapshot=async(db)=>JSON.stringify(await inspectBytes(await rows(db)));
      const ledgerExact=(all,projectId)=>{
        const ledger=all.captureStreams.find(row=>row.id==='capture-ledger:'+projectId),retained=stores.flatMap(name=>all[name]).filter(row=>row.projectId===projectId);
        expect(ledger.retainedBytes===retained.reduce((sum,row)=>sum+captureStoredRowBytes(row),0),'ledger omitted retained row metadata, manifest or Blob bytes');
        expect(ledger.actionCount===all.captureEvents.filter(row=>row.projectId===projectId&&row.kind==='action').length,'ledger action count differs');
        return {retainedBytes:ledger.retainedBytes,actionCount:ledger.actionCount,reservedPublicationBytes:ledger.reservedPublicationBytes};
      };
      const expected=current=>current?{storageRevision:current.storageRevision,revisionId:current.revisionId,stateHash:current.stateHash,frontier:current.frontier}:null;
      const timestamp='2026-10-28T00:00:00Z';
      const originalState='{\n "legacy": {"unknown": ["e\\u0301", -0, 0.125]}, "note": "SYNTHETIC"\n}\r\n';
      const geometry='[ { "x":0.125, "y":1.23456789012345, "old":-0 } ]\n';
      const publication=()=>({intentId:crypto.randomUUID(),reservationId:crypto.randomUUID(),destinationId:crypto.randomUUID(),expectedHead:null});
      let ordinal=0;
      const start=async(projectId=crypto.randomUUID(),workspaceId=crypto.randomUUID())=>{
        const revisionId=crypto.randomUUID(),writer=await createCaptureWriter({projectId,workspaceId,parent:null,startRevisionId:revisionId,startStateJson:originalState,createdAt:timestamp});
        const prepared=await prepareCaptureCommit({writer,expected:null,revisionId,stateJson:originalState,action:{id:crypto.randomUUID(),actionType:'capture.started',recordedAt:timestamp,changes:[]},changedRecords:[],blobs:[],publication:publication()});
        return {projectId,workspaceId,revisionId,writer,prepared};
      };
      const advance=async(owner,current,options={})=>{
        const revisionId=crypto.randomUUID(),actionId=options.actionId??crypto.randomUUID(),findingId=crypto.randomUUID();
        const payload=await prepareCapturePayload({projectId:owner.projectId,bytes:geometry,mediaType:'application/json'});
        const record={schema:'scorebrush-research-record',version:1,kind:'finding-version',id:crypto.randomUUID(),projectId:owner.projectId,findingId,previousVersionId:null,revisionId,createdByActionId:actionId,category:'transcription_error',geometryAssetId:payload.assetId,deleted:false,text:'SYNTHETIC exact note '+(++ordinal)};
        const stateJson='{\n "legacy": {"unknown": ["e\\u0301", -0, 0.125]}, "note": '+JSON.stringify(record.text)+'\n}\r\n';
        const input={writer:options.writer??owner.writer,expected:options.expected??expected(current),revisionId,stateJson,action:{id:actionId,actionType:'finding.finalized',recordedAt:timestamp,changes:[{entityKind:'finding',entityId:findingId,operation:'create',beforeRef:null,afterRef:{kind:'finding-version',id:record.id,projectId:owner.projectId,sha256:await hashCaptureRecord(record)}}]},changedRecords:[record],blobs:[payload],publication:publication()};
        return {prepared:await prepareCaptureCommit(input),stateJson,record,payload,input};
      };
      const instrument=async(fn)=>{
        const reads=[],writes=[],original={};
        for(const method of ['get','getKey','getAll','getAllKeys','openCursor','openKeyCursor','count','add','put']){
          original[method]=IDBObjectStore.prototype[method];
          IDBObjectStore.prototype[method]=function(...args){
            if(stores.includes(this.name)){
              if(['add','put'].includes(method))writes.push({store:this.name,method,id:args[0]?.id});
              else{reads.push({store:this.name,method,key:args[0]});if(!['get','getKey'].includes(method))throw new Error('Core scanned history using '+method);}
            }
            return original[method].apply(this,args);
          };
        }
        try{return {value:await fn(),reads,writes};}finally{for(const[method,fn]of Object.entries(original))IDBObjectStore.prototype[method]=fn;}
      };
      const injectedAbort=async(db,prepared,quota)=>{
        const original={add:IDBObjectStore.prototype.add,put:IDBObjectStore.prototype.put};let scheduled=0,abortObserved=false;
        for(const method of ['add','put'])IDBObjectStore.prototype[method]=function(...args){
          if(!stores.includes(this.name))return original[method].apply(this,args);
          if(quota&&scheduled===1){abortObserved=true;throw new DOMException('SYNTHETIC quota-style request refusal','QuotaExceededError');}
          const request=original[method].apply(this,args);scheduled++;
          if(!quota&&scheduled===1)request.addEventListener('success',()=>{abortObserved=true;this.transaction.abort();},{once:true});
          return request;
        };
        try{const error=await refused(()=>commitCapture(db,prepared),quota?'Injected quota abort':'Injected transaction abort');return {error,scheduled,abortObserved};}
        finally{for(const[method,fn]of Object.entries(original))IDBObjectStore.prototype[method]=fn;}
      };
      await test('module imports do not open a database',async()=>{expect(beforeImports.length===0,'fresh origin already contained a database');expect((await indexedDB.databases()).length===0,'module import opened a database');});
      const name='scorebrush-capture-synthetic-'+crypto.randomUUID(),db=await open(name),owner=await start();let current,second,earlyReads;
      await test('schema installation is explicit and limited to five intended stores',async()=>{
        expect(equal([...db.objectStoreNames].sort(),[...stores].sort()),'unexpected schema stores');expect(db.version===1,'synthetic schema version changed unexpectedly');
        const index=db.transaction('captureOutbox','readonly').objectStore('captureOutbox').index('capture-reservation');
        expect(equal(index.keyPath,['projectId','reservationId'])&&index.unique===true&&index.multiEntry===false,'publication reservation uniqueness schema differs');
        return {database:name,version:db.version,stores:[...db.objectStoreNames],reservationIndex:{name:index.name,keyPath:index.keyPath,unique:index.unique,multiEntry:index.multiEntry}};
      });
      await test('first local commit retains exact opaque baseline and pending publication',async()=>{
        const result=await commitCapture(db,owner.prepared);expect(result.status==='committed','first commit not committed');current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);
        expect(current.stateJson===originalState,'legacy state text changed');expect(current.stateHash===await sha256CaptureBytes(originalState),'state hash not exact');
        const all=await rows(db);expect(stores.every(name=>all[name].length>0),'five-store closure missing');
        expect(all.captureOutbox.every(row=>row.phase==='prepared'&&row.publicationSucceeded===false&&row.reservation.status==='reserved'),'outbox falsely claims publication');
        const baseline=all.captureBlobs.find(row=>row.id===owner.projectId+':blob:'+current.coverage.baselineAssetId);
        expect(baseline,'original baseline manifest absent');
        const baselineBytes=new Blob(baseline.segmentIds.map(id=>all.captureBlobs.find(row=>row.id===id).body));
        expect(await baselineBytes.text()===originalState,'original opaque baseline bytes changed');
        return {counts:Object.fromEntries(stores.map(name=>[name,all[name].length])),stateBytes:new TextEncoder().encode(originalState).length,ledger:ledgerExact(all,owner.projectId)};
      });
      await test('changed finding and exact geometry commit with state, frontier and reservation',async()=>{
        second=await advance(owner,current);const result=await commitCapture(db,second.prepared);expect(result.status==='committed','changed commit not committed');current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);
        expect(current.stateJson===second.stateJson&&current.stateHash===await sha256CaptureBytes(second.stateJson),'changed state differs');
        const all=await rows(db),prepared=preparedCaptureData(second.prepared);
        for(const [name,proposed]of [['captureEvents',prepared.descriptor],['captureEvents',prepared.action],...prepared.changedRecords.map(row=>['captureEvents',row]),...prepared.blobs.map(row=>['captureBlobs',row])]){
          const stored=all[name].find(row=>row.id===proposed.id);expect(stored&&equal(await inspectBytes(stored),await inspectBytes(proposed)),'stored immutable closure differs: '+proposed.id);
        }
        const payload=all.captureBlobs.find(row=>row.id===owner.projectId+':blob:'+second.payload.assetId);
        const geometryBytes=new Blob(payload.segmentIds.map(id=>all.captureBlobs.find(row=>row.id===id).body));
        expect(await geometryBytes.text()===geometry&&'sha256:'+await sha256CaptureBytes(geometryBytes)===second.payload.assetId,'original geometry bytes/hash changed');
        const stream=all.captureStreams.find(row=>row.id===owner.projectId+':stream:'+current.frontier.streamId);
        expect(stream&&equal(stream.frontier,current.frontier),'stream frontier missing or mismatched');
        expect(current.frontier.eventId===second.input.action.id,'current frontier points to wrong action');
        return {accounting:prepared.accounting,ledger:ledgerExact(all,owner.projectId),geometryUtf8Bytes:new TextEncoder().encode(geometry).length,geometrySha256:await sha256CaptureBytes(geometry),exactGeometry:geometry};
      });
      await test('identical retry does not duplicate or roll back a newer current state',async()=>{
        const before=await snapshot(db),result=await commitCapture(db,owner.prepared),after=await snapshot(db);
        expect(result.status==='already-committed','retry not recognized');expect(before===after,'retry duplicated records or changed current');
        expect((await readCaptureCurrent(db,owner.projectId,owner.workspaceId)).stateJson===second.stateJson,'old retry rolled back current');
      });
      await test('a different publication intent cannot reuse an accepted reservation identity',async()=>{
        const change=await advance(owner,current),input={...change.input,publication:{...change.input.publication,reservationId:second.input.publication.reservationId}},prepared=await prepareCaptureCommit(input),before=await snapshot(db);
        expect(input.publication.intentId!==second.input.publication.intentId&&input.action.id!==second.input.action.id,'reservation conflict fixture must use a new intent and action');
        const error=await refused(()=>commitCapture(db,prepared),'Duplicate reservation identity');expect(error.code==='CAPTURE_CONFLICT','reservation conflict not classified');expect(before===await snapshot(db),'reservation conflict changed current, evidence or ledger');return {error,reservationId:input.publication.reservationId,distinctIntentId:true,distinctActionId:true};
      });
      await test('stale expected revision and frontier are refused without mutations',async()=>{
        const stale=await advance(owner,current),next=await advance(owner,current);await commitCapture(db,next.prepared);current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);
        const before=await snapshot(db),error=await refused(()=>commitCapture(db,stale.prepared),'Stale expected state');expect(error.code==='CAPTURE_STALE','stale state not classified');expect(before===await snapshot(db),'stale commit mutated stores');return error;
      });
      await test('revision-only and frontier-only stale expectations independently fail compare-and-swap',async()=>{
        const casName='scorebrush-capture-cas-'+crypto.randomUUID(),casDb=await open(casName),casOwner=await start();
        try{
          await commitCapture(casDb,casOwner.prepared);const initial=await readCaptureCurrent(casDb,casOwner.projectId,casOwner.workspaceId);
          const revisionOnly=await advance(casOwner,initial,{expected:{...expected(initial),storageRevision:initial.storageRevision+1}}),beforeRevision=await snapshot(casDb),revisionError=await refused(()=>commitCapture(casDb,revisionOnly.prepared),'Revision-only stale expectation');
          expect(revisionError.code==='CAPTURE_STALE','revision-only mismatch did not fail CAS');expect(beforeRevision===await snapshot(casDb),'revision-only stale attempt mutated stores');
          const branchWriter=await createCaptureWriter({projectId:casOwner.projectId,workspaceId:casOwner.workspaceId,parent:initial.frontier,startRevisionId:initial.revisionId,startStateJson:initial.stateJson,createdAt:timestamp});
          const branch=await prepareCaptureCommit({writer:branchWriter,expected:expected(initial),revisionId:initial.revisionId,stateJson:initial.stateJson,action:{id:crypto.randomUUID(),actionType:'branch.created',recordedAt:timestamp,changes:[]},changedRecords:[],blobs:[],publication:publication()});
          await commitCapture(casDb,branch);const branched=await readCaptureCurrent(casDb,casOwner.projectId,casOwner.workspaceId);
          expect(branched.revisionId===initial.revisionId&&branched.stateHash===initial.stateHash&&branched.storageRevision===initial.storageRevision+1,'branch fixture did not isolate frontier from revision/state identity');
          const frontierExpected={...expected(branched),frontier:initial.frontier},frontierOnly=await advance(casOwner,initial,{expected:frontierExpected}),beforeFrontier=await snapshot(casDb),frontierError=await refused(()=>commitCapture(casDb,frontierOnly.prepared),'Frontier-only stale expectation');
          expect(frontierError.code==='CAPTURE_STALE','frontier-only mismatch did not fail CAS');expect(beforeFrontier===await snapshot(casDb),'frontier-only stale attempt mutated stores');
          return {revisionOnly:{error:revisionError,currentStorageRevision:initial.storageRevision,suppliedStorageRevision:initial.storageRevision+1,frontierUnchanged:true},frontierOnly:{error:frontierError,currentStorageRevision:branched.storageRevision,suppliedStorageRevision:frontierExpected.storageRevision,revisionIdUnchanged:true,stateHashUnchanged:true,oldFrontierRemainsValidHistoricalEvidence:true}};
        }finally{casDb.close();}
      });
      await test('conflicting immutable action ID is refused without replacement',async()=>{
        const conflicting=await advance(owner,current,{actionId:second.input.action.id}),before=await snapshot(db),error=await refused(()=>commitCapture(db,conflicting.prepared),'Conflicting action identity');
        expect(error.code==='CAPTURE_CONFLICT','immutable conflict not classified');expect(before===await snapshot(db),'conflicting immutable action mutated stores');return error;
      });
      await test('a valid prior version for another finding cannot authorize a replacement',async()=>{
        const change=await advance(owner,current),record={...change.record,previousVersionId:second.record.id};
        const input={...change.input,changedRecords:[record],action:{...change.input.action,actionType:'finding.edited',changes:[{entityKind:'finding',entityId:record.findingId,operation:'replace',beforeRef:{kind:'finding-version',id:second.record.id,projectId:owner.projectId,sha256:await hashCaptureRecord(second.record)},afterRef:{kind:'finding-version',id:record.id,projectId:owner.projectId,sha256:await hashCaptureRecord(record)}}]}};
        const prepared=await prepareCaptureCommit(input),before=await snapshot(db),error=await refused(()=>commitCapture(db,prepared),'Cross-finding prior reference');
        expect(error.code==='CAPTURE_INTEGRITY','cross-finding reference not rejected as an integrity error');expect(before===await snapshot(db),'cross-finding replacement mutated stores');return error;
      });
      await test('abort after a successful first scheduled write rolls all five stores back',async()=>{
        const change=await advance(owner,current),before=await snapshot(db),result=await injectedAbort(db,change.prepared,false);
        expect(result.scheduled>=1&&result.abortObserved,'abort injection did not reach a scheduled write');expect(before===await snapshot(db),'partial abort left committed records');return result;
      });
      await test('quota-style injected request error rolls back scheduled writes',async()=>{
        const change=await advance(owner,current),before=await snapshot(db),result=await injectedAbort(db,change.prepared,true);
        expect(result.scheduled===1&&result.abortObserved,'quota injection not reached after first write');expect(before===await snapshot(db),'quota-style abort left committed records');return {...result,limitation:'Injected request failure; not an actual disk quota or hardware power-loss test.'};
      });
      await test('current reads and commits use bounded direct keys before history growth',async()=>{
        const change=await advance(owner,current),observed=await instrument(async()=>{await readCaptureCurrent(db,owner.projectId,owner.workspaceId);return commitCapture(db,change.prepared);});
        earlyReads=observed.reads;expect(earlyReads.length>0,'no reads observed');expect(observed.writes.length>0,'no writes observed');current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);return {reads:earlyReads,writes:observed.writes};
      });
      await test('bounded key reads remain constant after twelve more actual history commits',async()=>{
        for(let i=0;i<12;i++){const change=await advance(owner,current);await commitCapture(db,change.prepared);current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);}
        const change=await advance(owner,current),observed=await instrument(async()=>{await readCaptureCurrent(db,owner.projectId,owner.workspaceId);return commitCapture(db,change.prepared);});
        expect(observed.reads.length===earlyReads.length,'direct read count grew with history');expect(observed.reads.every(row=>['get','getKey'].includes(row.method)),'history scan observed');current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);return {historyCommitsAdded:12,earlyReadCount:earlyReads.length,laterReadCount:observed.reads.length,reads:observed.reads};
      });
      await test('competing real connections admit exactly one shared expected frontier',async()=>{
        const other=await open(name),writerA=await createCaptureWriter({projectId:owner.projectId,workspaceId:owner.workspaceId,parent:current.frontier,startRevisionId:current.revisionId,startStateJson:current.stateJson,createdAt:timestamp}),writerB=await createCaptureWriter({projectId:owner.projectId,workspaceId:owner.workspaceId,parent:current.frontier,startRevisionId:current.revisionId,startStateJson:current.stateJson,createdAt:timestamp});
        try{
          const a=await advance(owner,current,{writer:writerA}),b=await advance(owner,current,{writer:writerB}),before=await rows(db),settled=await Promise.allSettled([commitCapture(db,a.prepared),commitCapture(other,b.prepared)]);
          expect(settled.filter(result=>result.status==='fulfilled').length===1,'race did not admit exactly one commit');expect(settled.filter(result=>result.status==='rejected').length===1,'race loser not refused');
          expect(settled.find(result=>result.status==='rejected').reason?.code==='CAPTURE_STALE','race loser did not fail the current/frontier compare-and-swap');
          const winner=settled[0].status==='fulfilled'?a:b,loser=winner===a?b:a,after=await rows(db);current=await readCaptureCurrent(db,owner.projectId,owner.workspaceId);
          expect(current.frontier.eventId===winner.input.action.id,'current did not match admitted race winner');expect(!JSON.stringify(after).includes(loser.input.action.id),'race loser partially committed');
          return {connections:2,outcomes:settled.map(result=>({status:result.status,errorCode:result.status==='rejected'?result.reason.code:null})),beforeCounts:Object.fromEntries(stores.map(name=>[name,before[name].length])),afterCounts:Object.fromEntries(stores.map(name=>[name,after[name].length]))};
        }finally{other.close();}
      });
      await test('identical input bytes in independent project IDs remain independent',async()=>{
        const independent=await start(),before=await snapshot(db);await commitCapture(db,independent.prepared);const one=await readCaptureCurrent(db,owner.projectId,owner.workspaceId),two=await readCaptureCurrent(db,independent.projectId,independent.workspaceId);
        expect(one.projectId!==two.projectId&&one.workspaceId!==two.workspaceId,'independent project identity merged');expect(two.stateJson===originalState,'independent baseline state changed');expect(one.stateJson===current.stateJson,'independent commit changed first project');
        const all=await rows(db),oneBaseline=preparedCaptureData(owner.prepared),twoBaseline=preparedCaptureData(independent.prepared);
        expect(oneBaseline.current.stateHash===twoBaseline.current.stateHash,'identical original bytes had different content hashes');expect(all.captureStreams.some(row=>row.id==='capture-ledger:'+independent.projectId),'independent capacity ledger absent');
        return {firstProjectId:one.projectId,secondProjectId:two.projectId,sharedBaselineHash:twoBaseline.current.stateHash,previousSnapshotBytes:before.length};
      });
      await test('provisional action-capacity refusal keeps current and evidence unchanged',async()=>{
        const capName='scorebrush-capture-capacity-'+crypto.randomUUID(),capDb=await open(capName),capOwner=await start();
        try{
          await commitCapture(capDb,capOwner.prepared);const capCurrent=await readCaptureCurrent(capDb,capOwner.projectId,capOwner.workspaceId),change=await advance(capOwner,capCurrent);
          await new Promise((resolve,reject)=>{const tx=capDb.transaction('captureStreams','readwrite'),store=tx.objectStore('captureStreams'),r=store.get('capture-ledger:'+capOwner.projectId);r.onsuccess=()=>store.put({...r.result,actionCount:CAPTURE_STORAGE_LIMITS.actions});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          const before=await snapshot(capDb),error=await refused(()=>commitCapture(capDb,change.prepared),'Provisional action capacity');expect(error.code==='CAPTURE_CAPACITY','capacity refusal not classified');expect(before===await snapshot(capDb),'capacity refusal mutated state/evidence');return {error,proposedActionLimit:CAPTURE_STORAGE_LIMITS.actions,fixture:'Synthetic ledger at the proposed allowance; does not claim actual browser storage exhaustion.'};
        }finally{capDb.close();}
      });
      await test('an unknown current schema version is preserved instead of overwritten',async()=>{
        const unknownName='scorebrush-capture-unknown-'+crypto.randomUUID(),unknownDb=await open(unknownName),unknownOwner=await start();
        try{
          await commitCapture(unknownDb,unknownOwner.prepared);const known=await readCaptureCurrent(unknownDb,unknownOwner.projectId,unknownOwner.workspaceId),change=await advance(unknownOwner,known);
          await new Promise((resolve,reject)=>{const tx=unknownDb.transaction('reviews','readwrite');tx.objectStore('reviews').put({...known,version:2});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          const before=await snapshot(unknownDb),error=await refused(()=>commitCapture(unknownDb,change.prepared),'Unknown current schema version');
          expect(before===await snapshot(unknownDb),'unknown current schema version was overwritten');return {error,unknownVersion:2};
        }finally{unknownDb.close();}
      });
      await test('a missing project ledger refuses continuation rather than resetting capacity',async()=>{
        const missingName='scorebrush-capture-missing-ledger-'+crypto.randomUUID(),missingDb=await open(missingName),missingOwner=await start();
        try{
          await commitCapture(missingDb,missingOwner.prepared);const known=await readCaptureCurrent(missingDb,missingOwner.projectId,missingOwner.workspaceId),change=await advance(missingOwner,known);
          await new Promise((resolve,reject)=>{const tx=missingDb.transaction('captureStreams','readwrite');tx.objectStore('captureStreams').delete('capture-ledger:'+missingOwner.projectId);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          const before=await snapshot(missingDb),error=await refused(()=>commitCapture(missingDb,change.prepared),'Missing capacity ledger');
          expect(error.code==='CAPTURE_INTEGRITY','missing capacity ledger not classified as integrity failure');expect(before===await snapshot(missingDb),'missing-ledger refusal changed current or manufactured a new ledger');return error;
        }finally{missingDb.close();}
      });
      await test('current reads reject a changed inline descriptor without mutating evidence',async()=>{
        const tamperedName='scorebrush-capture-descriptor-'+crypto.randomUUID(),tamperedDb=await open(tamperedName),tamperedOwner=await start();
        try{
          await commitCapture(tamperedDb,tamperedOwner.prepared);const known=await readCaptureCurrent(tamperedDb,tamperedOwner.projectId,tamperedOwner.workspaceId),changed={...known,activeBranchDescriptor:{...known.activeBranchDescriptor,createdAt:'2026-10-29T00:00:00Z'}};
          await new Promise((resolve,reject)=>{const tx=tamperedDb.transaction('reviews','readwrite');tx.objectStore('reviews').put(changed);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
          const before=await snapshot(tamperedDb),error=await refused(()=>readCaptureCurrent(tamperedDb,tamperedOwner.projectId,tamperedOwner.workspaceId),'Tampered active descriptor');
          expect(error.code==='CAPTURE_INTEGRITY','tampered descriptor not classified as integrity failure');expect(before===await snapshot(tamperedDb),'failed descriptor read mutated evidence');return {error,changedField:'activeBranchDescriptor.createdAt',retainedOriginalHash:known.descriptorHash};
        }finally{tamperedDb.close();}
      });
      await test('identical retry refuses missing current or stream closure instead of claiming success',async()=>{
        const outcomes=[];
        for(const missingPart of ['current','stream']){
          const retryName='scorebrush-capture-retry-'+missingPart+'-'+crypto.randomUUID(),retryDb=await open(retryName),retryOwner=await start();
          try{
            await commitCapture(retryDb,retryOwner.prepared);const known=await readCaptureCurrent(retryDb,retryOwner.projectId,retryOwner.workspaceId),storeName=missingPart==='current'?'reviews':'captureStreams',key=missingPart==='current'?known.id:retryOwner.projectId+':stream:'+known.frontier.streamId;
            await new Promise((resolve,reject)=>{const tx=retryDb.transaction(storeName,'readwrite');tx.objectStore(storeName).delete(key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
            const before=await snapshot(retryDb),error=await refused(()=>commitCapture(retryDb,retryOwner.prepared),'Retry missing '+missingPart);
            expect(error.code==='CAPTURE_INTEGRITY','retry with missing '+missingPart+' did not reject integrity');expect(before===await snapshot(retryDb),'retry manufactured missing '+missingPart+' closure');outcomes.push({missingPart,error});
          }finally{retryDb.close();}
        }
        return outcomes;
      });
      const finalRows=await rows(db),finalSnapshot=JSON.stringify(await inspectBytes(finalRows)),reopen={name,projectId:owner.projectId,workspaceId:owner.workspaceId,current,finalSnapshot};
      const rowSizes=Object.fromEntries(stores.map(name=>[name,{count:finalRows[name].length,jsonUtf8Bytes:finalRows[name].reduce((sum,row)=>sum+new TextEncoder().encode(JSON.stringify(row)).length,0),largestRowJsonUtf8Bytes:Math.max(...finalRows[name].map(row=>new TextEncoder().encode(JSON.stringify(row)).length))}]));
      db.close();
      return {records,reopen,rowSizes,sizeMeaning:'JSON UTF-8 serialization observations of retained row wrappers, not IndexedDB page/index overhead or native memory.',schemaVersion:1,provisionalLimits:true,origin:location.origin,normalProductionDatabaseOpened:(await indexedDB.databases()).some(row=>row.name==='private-score-desk-local-v1')};
    });
    for(const record of details.records)check(record.pass,record.name);
    check(!details.normalProductionDatabaseOpened,'the focused suite never opens the normal production database');
    await page.reload();
    const reopened=await page.evaluate(async expected=>{
      const {readCaptureCurrent}=await import('./capture-store.js');
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open(expected.name,1);r.onupgradeneeded=()=>{r.transaction.abort();reject(new Error('Reopen unexpectedly needed schema creation'));};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      try{
        const current=await readCaptureCurrent(db,expected.projectId,expected.workspaceId),rows={};
        await new Promise((resolve,reject)=>{const tx=db.transaction([...db.objectStoreNames],'readonly');for(const name of db.objectStoreNames){const r=tx.objectStore(name).getAll();r.onsuccess=()=>{rows[name]=r.result.sort((a,b)=>String(a.id).localeCompare(String(b.id)));};}tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
        const inspectBytes=async value=>{
          if(value instanceof Blob)return {blobType:value.type,blobBytes:value.size,exactHex:[...new Uint8Array(await value.arrayBuffer())].map(byte=>byte.toString(16).padStart(2,'0')).join('')};
          if(Array.isArray(value))return Promise.all(value.map(inspectBytes));
          if(value&&typeof value==='object'){const result={};for(const key of Object.keys(value))result[key]=await inspectBytes(value[key]);return result;}
          return value;
        };
        const ordered=Object.fromEntries(['reviews','captureEvents','captureStreams','captureOutbox','captureBlobs'].map(name=>[name,rows[name]]));
        return {currentExact:JSON.stringify(current)===JSON.stringify(expected.current),allFiveStoresExact:JSON.stringify(await inspectBytes(ordered))===expected.finalSnapshot,version:db.version};
      }finally{db.close();}
    },details.reopen);
    check(reopened.currentExact&&reopened.allFiveStoresExact&&reopened.version===1,'a fresh page/module session reopens exact current state and every committed store');
    details.reopenResult=reopened;delete details.reopen.finalSnapshot;
    return {name:'capture-core',assertions,cases:details.records.length,realIndexedDB:true,productionDatabaseOpened:false};
  }catch(error){
    if(!details)details={records:await page.evaluate(()=>window.captureCoreTestRecords??[]).catch(()=>[])};
    details.failure={name:error.name,message:error.message,stack:error.stack};throw error;
  }finally{
    await writeFile(resolve(evidence,'capture-core.txt'),log.join('\n')+'\n');
    await writeFile(resolve(evidence,'capture-core.json'),JSON.stringify(details??{},null,2)+'\n');
    await context.close();await server.close();
  }
}
