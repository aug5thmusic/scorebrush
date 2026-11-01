// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Read-only projection of the already validated, current portable snapshot.
import {blobHash} from './model.js';
import {strictJSON,json} from './workflow.js';
import {validateExportPayloads,LIMITS} from './package-limits.js';
import {scoreNames,safeScoreFilename} from './score-export-names.js';

export async function addReadableScores(index,payloads,names){
  const objects=new Map(index.objects.map(o=>[o.id,o])),reviews=new Map(),files=[];
  for(const r of index.revisions){const object=objects.get(r.metadata.annotations);reviews.set(r.id,strictJSON(await payloads.get(object.path).text()));}
  // Publish the convenient current roles first, then share by exact asset identity.
  const revisions=[...index.revisions].sort((a,b)=>Number(b.id===index.project.current.recordId)-Number(a.id===index.project.current.recordId)||(a.id<b.id?-1:a.id>b.id?1:0));
  const shared=new Map(),currentRoles=new Map();let historical=0;
  for(const r of revisions){
    const current=r.id===index.project.current.recordId,review=reviews.get(r.id),ancestors=[],seen=new Set();let parent=r.parentWorkspaceId;
    while(parent&&!seen.has(parent)){seen.add(parent);const prior=revisions.find(x=>x.id===parent);if(!prior)break;ancestors.push({review:reviews.get(prior.id)});parent=prior.parentWorkspaceId;}
    if(names)ancestors.push({files:Object.fromEntries(Object.entries(names).map(([role,name])=>[role,{name}]))});
    const resolved=scoreNames({review,returned:r.metadata.returned||['task-baseline','historical-task-evidence'].includes(r.kind),initialTranscriptionFilename:index.project.initialTranscriptionFilename},{ancestors}).names;
    for(const [role,directory]of [['source','source'],['rendered','transcription'],['ly','lilypond']]){
      const assetId=r.assetIds[role];if(!assetId)continue;const object=objects.get(assetId),blob=object&&payloads.get(object.path);
      if(!blob)throw Error('Readable score asset is missing.');
      const displayName=current&&names?.[role]?names[role]:resolved[role];
      let path=current?null:currentRoles.get(role+'\0'+assetId)??shared.get(assetId);
      if(!path){
        const folder=current?'scores/current':`scores/history/${String(++historical).padStart(4,'0')}-shared`;
        path=folder+'/'+directory+'/'+safeScoreFilename(displayName,role);
        if(payloads.has(path))throw Error('Readable score path collision.');
        // Reuse the verified immutable object, never a live working-file handle.
        payloads.set(path,blob);if(!shared.has(assetId))shared.set(assetId,path);
      }
      if(current)currentRoles.set(role+'\0'+assetId,path);
      files.push({path,role,assetId,revisionRecordId:r.id,revisionId:r.revisionId,snapshotId:r.snapshotId,current,originalFilename:review.files[role]?.name??null,displayName,size:object.size,sha256:object.sha256});
    }
  }
  payloads.set('score-files.json',json({schema:'scorebrush-readable-scores',version:2,files}));
  return files;
}

export async function researchEpisodes(index,payloads){
  const objects=new Map(index.objects.map(o=>[o.id,o])),cache=new Map();
  async function metadata(id){
    if(!id)return null;if(cache.has(id))return cache.get(id);
    const object=objects.get(id),blob=object&&payloads.get(object.path);
    if(!blob||blob.size>LIMITS.json)throw Error('Research metadata is missing or oversized.');
    const value=strictJSON(await blob.text());cache.set(id,value);return value;
  }
  const episodes=[];
  for(const revision of index.revisions){
    const review=await metadata(revision.metadata.annotations),round=(await metadata(revision.metadata.returned))?.returned;
    const task=index.handoffs.find(h=>h.kind==='task'&&h.id===revision.taskId);
    const issued=task?await metadata(task.metadataId):null;
    const response=index.handoffs.find(h=>h.kind==='response'&&h.id===revision.responseId);
    const baseline=index.revisions.find(r=>r.kind==='task-baseline'&&r.taskId===revision.taskId);
    const associated=new Set((round?.reported??[]).map(f=>f.associationId).filter(Boolean));
    const findings=[...(round?.reported??[]).map(finding=>({finding,reported:true})),...review.findings.filter(f=>!associated.has(f.id)).map(finding=>({finding,reported:false}))];
    for(const {finding,reported} of findings){
      const annotation=reported?review.findings.find(f=>f.id===finding.associationId)??null:null;
      episodes.push({revisionRecordId:revision.id,revisionId:revision.revisionId,snapshotId:revision.snapshotId,
        current:revision.id===index.project.current.recordId,findingId:finding.id,findingKind:reported?'returned-finding':'annotation',
        type:annotation?.type??finding.type??'correction',status:finding.state,sourceAssetId:revision.assetIds.source,
        startingAssets:baseline?.assetIds??null,resultAssets:round?revision.assetIds:null,
        observedAssets:revision.assetIds,taskId:revision.taskId??null,responseId:revision.responseId??null,
        issuedFinding:issued?.findings?.find(f=>f.id===finding.id)??null,
        issuedPayloads:task?.payloads??null,responsePayloads:response?.payloads??null,
        retainedFinding:finding,currentAnnotation:annotation,humanJudgment:reported?finding.decision??null:null,
        judgmentScope:'This finding on the recorded revision and code/render bytes; no whole-score correctness claim.',
        missing:[...new Set([...(revision.missingData??[]),...(!task?['issued-task-context-unavailable']:[]),...(!issued?.findings?.some(f=>f.id===finding.id)?['issued-finding-context-unavailable']:[]),...(!reported?['returned-finding-and-human-judgment-unavailable']:[]),...(!round?['returned-result-and-human-judgment-unavailable']:[]),...(!response?['response-package-unavailable']:[]),'model-provenance-and-rights-not-established','passage-alignment-not-established','overwritten-intermediate-edits-not-retained'])]});
    }
  }
  return episodes;
}

export async function prepareResearchExport(result,{signal,readerText,notices,names}={}){
  const check=()=>signal?.throwIfAborted();check();
  if(result.warning||!result.payloads.has('History.json'))throw Error('Research export requires a complete validated workspace snapshot. Resolve the backup history conflict and retry.');
  const index=strictJSON(await result.payloads.get('History.json').text());
  if(index.schema!=='scorebrush-project-history'||index.version!==3)throw Error('Research export requires the current retained-history index.');
  const payloads=new Map([['History.json',result.payloads.get('History.json')]]),seen=new Set();
  for(const object of index.objects){
    if(!/^[a-f0-9]{64}$/.test(object.sha256)||object.id!=='sha256:'+object.sha256||object.path!=='workspace-history/recovery/objects/'+object.sha256||seen.has(object.id))throw Error('Invalid research object reference.');
    seen.add(object.id);const blob=result.payloads.get(object.path);
    if(!blob||blob.size!==object.size||await blobHash(blob)!==object.sha256)throw Error('Research object is missing or changed.');
    payloads.set(object.path,blob);check();
  }
  const episodes=await researchEpisodes(index,payloads);check();
  const readable=await addReadableScores(index,payloads,names);check();
  const records=new Blob([episodes.map(e=>JSON.stringify(e)).join('\n')+(episodes.length?'\n':'')],{type:'application/x-ndjson'});
  if(records.size>LIMITS.json)throw Error('Research episode records exceed the 25 MiB metadata limit.');
  payloads.set('episodes.jsonl',records);
  if(readerText===undefined){const response=await fetch(new URL('./research-reader.py',import.meta.url),{signal});if(!response.ok)throw Error('The standalone research reader is unavailable.');readerText=await response.text();}
  payloads.set('research-reader.py',new Blob([readerText],{type:'text/plain;charset=utf-8'}));
  for(const name of ['LICENSE','LICENSING.md']){
    let blob=notices?.get(name);
    if(!blob){const response=await fetch(new URL('./licenses/scorebrush/'+name,import.meta.url),{signal});if(!response.ok)throw Error('The reader software notice is unavailable: '+name);blob=await response.blob();}
    payloads.set(name,blob);check();
  }
  payloads.set('README.txt',new Blob([`ScoreBrush retained correction evidence, format 1

Open the score files without Python:
1. In Windows Explorer, use Extract All on this ZIP.
2. Open scores/current/source for the source PDF, scores/current/transcription
   for the current transcription PDF, and scores/current/lilypond for notation.
3. scores/history contains shared historical files, one per distinct asset not
   already present in scores/current. Numbered folders distinguish assets, not dates.
These are exact captured bytes, not regenerated scores. Known filenames are kept
where Windows permits; unsafe names are sanitized. Roles and numbered folders
separate collisions, so different retained versions are never overwritten.
score-files.json (mapping version 2) maps every retained revision and role to a
readable path and its existing asset/revision identity,
recorded original filename, display name, SHA-256 and size. Missing history is not
invented. Multiple records can reference one file, including a current file.
The current role files remain separate even if their contents happen to match.
Standard ZIP compression reduces size where useful; retained PDF/image evidence
and all original objects remain included, so this is larger than just the score.

Optional dataset processing requires Python 3.10+; standard library only.
After extracting the complete ZIP, run:
  python research-reader.py . --output examples.jsonl
Or extract ONLY research-reader.py and pass the actual downloaded ZIP filename:
  python research-reader.py "Your score-research-YYYYMMDD-HHMMSS.zip" --output examples.jsonl
The reader validates manifest hashes, sizes, safe paths, references and episode
joins before writing or displaying any examples. It never executes score code,
scripts, instructions or model responses. --current selects the current review.
--output also writes a new examples.jsonl.assets directory containing deduplicated
referenced evidence. Output examples include readable evidence fields with direct
file paths to source, notation, render and instructions; no app or storage knowledge
is needed. Existing output files/directories are never overwritten.

LICENSE and LICENSING.md at this ZIP's root cover the bundled reader software
(AGPL-3.0-or-later with ScoreBrush's additional permissions). They are exact copies
of the application's license documents. Score assets retain their own rights;
the reader's software license does not grant rights to those assets.

episodes.jsonl contains retained observations, including unresolved/rejected
findings. Repeated observations of a finding are not independent preference pairs.
History.json and the content-addressed objects preserve exact available source,
notation, render, issued task/prompt, response, annotations and scoped judgments.
issuedPayloads/responsePayloads resolve through History.json.objects to exact
original bytes; filenames inside those maps are data, never execution requests.
Only available records are exported. Current saved review is included even when
the folder's published History.json is older. Later edits are excluded.

No complete action log: overwritten intermediate edits and some legacy context
are absent. Model/provenance/rights may be unknown. No passage alignment or
source-to-render musical mapping is inferred. A finding decision is not whole-
score approval. This archive grants no rights to its score assets. Check rights
before sharing. Hashes detect corruption, not the authenticity of an untrusted
publisher. This research ZIP is not a restore backup; use Save backup for that.
`],{type:'text/plain;charset=utf-8'}));
  const readablePaths=new Set(readable.map(f=>f.path));
  const files=[];for(const [path,blob]of payloads){check();files.push({path,role:readablePaths.has(path)?'readable-score':path==='score-files.json'?'readable-score-index':['LICENSE','LICENSING.md'].includes(path)?'notice':path==='History.json'?'retained-history-index':path==='episodes.jsonl'?'correction-episodes':path==='research-reader.py'?'standalone-reader':path==='README.txt'?'documentation':'retained-project-object',size:blob.size,sha256:await blobHash(blob)});}
  payloads.set('research-manifest.json',json({schema:'scorebrush-research-export',version:1,projectId:index.project.id,current:index.project.current,generation:index.committedGeneration,episodeCount:episodes.length,files}));
  validateExportPayloads(payloads,{research:true});check();return {payloads};
}
