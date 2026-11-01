// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Export-only synthetic history. No storage, folders or real scores are used.
import {createHash} from 'node:crypto';
import {fixtureBlob} from '../app/qa/fixtures.js';
export async function researchHistoryFixture(count=158){
  const payloads=new Map(),objects=new Map(),assets=new Map(),revisions=[];
  async function object(blob,asset=false){
    const sha256=createHash('sha256').update(new Uint8Array(await blob.arrayBuffer())).digest('hex');
    const row={id:'sha256:'+sha256,sha256,size:blob.size,path:'workspace-history/recovery/objects/'+sha256};
    objects.set(row.id,row);payloads.set(row.path,blob);if(asset)assets.set(row.id,row);return row;
  }
  const versions=[];
  for(let version=0;version<3;version++){
    const files={};
    for(const [role,name]of [['source','source.pdf'],['rendered','rendered.pdf'],['ly','score.ly']]){
      // Real geometry PDFs / inert notation, with deterministic comment padding.
      const padding=Array.from({length:1000},(_,i)=>'% SYNTHETIC '+createHash('sha256').update(role+version+':'+i).digest('hex')+'\n').join('');
      files[role]=await object(new Blob([await fixtureBlob(name),padding]),true);
    }
    versions.push(files);
  }
  for(let i=0;i<count;i++){
    const version=Math.min(2,Math.floor(i*3/count)),id='record-'+String(i).padStart(4,'0'),files={};
    for(const role of ['source','rendered','ly'])files[role]={...versions[version][role],name:role==='ly'?['Étude 舞?曲.ly','Étude 舞:曲.ly','Étude 舞_曲.ly'][version]:'Same 名称.pdf'};
    const snapshotId='snapshot-'+version,review={schema:'score-desk-review',snapshotId,files,findings:[{id:'finding',number:1,type:'correction',state:'open',comment:'SYNTHETIC annotation checkpoint '+i,strokes:[]}]};
    const metadata={annotations:(await object(new Blob([JSON.stringify(review)]))).id,returned:null,completion:null};
    revisions.push({id,kind:i<40?'legacy-package':'durable-edit',revisionId:i<40?null:'revision-'+i,snapshotId,workspaceId:'workspace-'+version,parentWorkspaceId:i?revisions[i-1].id:null,metadata,assetIds:Object.fromEntries(Object.entries(versions[version]).map(([role,o])=>[role,o.id])),missingData:i<40?['logical-revision-id-not-recorded']:[]});
  }
  // Retained evidence is deliberately not a score asset, and must survive intact.
  await object(new Blob([await fixtureBlob('multipage.pdf'),'\n% SYNTHETIC retained PDF evidence\n']));
  await object(new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9B0AAAAASUVORK5CYII=','base64')]));
  await object(new Blob(['SYNTHETIC highly compressible retained evidence\n','0'.repeat(1024*1024)]));
  const last=revisions.at(-1),current={recordId:last.id,revisionId:last.revisionId,snapshotId:last.snapshotId,workspaceId:last.workspaceId};
  const index={schema:'scorebrush-project-history',version:3,project:{id:'SYNTHETIC research compaction',current},committedGeneration:'synthetic-generation',objects:[...objects.values()],assets:[...assets.values()],revisions,handoffs:[],events:revisions.filter(r=>r.kind==='durable-edit').map(r=>({...r}))};
  payloads.set('History.json',new Blob([JSON.stringify(index)]));return {payloads,index};
}
