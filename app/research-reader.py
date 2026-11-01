#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Auggie (@aug5thmusic).
# License and additional permissions: see LICENSE and LICENSING.md at the research ZIP root.
"""Validate a ScoreBrush research ZIP/directory before emitting correction episodes.
Python 3.10+, standard library only. Never executes imported content or extracts ZIPs.
"""
import argparse
import hashlib
import json
import math
import re
import stat
import sys
import zipfile
import unicodedata
from pathlib import Path

FILE_LIMIT=100*1024*1024
JSON_LIMIT=25*1024*1024
TOTAL_LIMIT=512*1024*1024
ZIP_LIMIT=256*1024*1024
HASH=re.compile(r'[a-f0-9]{64}\Z')
def require(condition,message):
    if not condition:raise ValueError(message)
def safe(name):
    return isinstance(name,str) and len(name)<=240 and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]*',name) and all(p not in ('','.','..') for p in name.split('/'))

def readable_path(name):
    if not isinstance(name,str) or len(name)>240:return False
    match=re.fullmatch(r'scores/(?:current|history/[0-9]{4}-[a-z-]+)/(source|transcription|lilypond)/([^/]+)',name)
    if not match:return False
    role,filename=match.groups()
    if any(c in '<>:"/\\|?*' or unicodedata.category(c) in ('Cc','Cf','Cs') for c in filename):return False
    return (len(filename.encode('utf-16-le'))//2<=100 and not filename.startswith('.') and not filename.endswith((' ','.'))
            and not re.match(r'(?i)^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)',filename)
            and filename.lower().endswith('.ly' if role=='lilypond' else '.pdf'))

def archive_path(name):
    # Unicode is accepted only within the new, tightly scoped score-copy layout.
    return readable_path(name) if isinstance(name,str) and name.startswith('scores/') else safe(name)
def digest(data):return hashlib.sha256(data).hexdigest()
def unique(items,key):
    result={}
    for item in items:
        name=item[key];require(name not in result,'Duplicate identity: '+str(name));result[name]=item
    return result
def parse(data):
    require(len(data)<=JSON_LIMIT,'JSON metadata too large')
    def pairs(entries):
        out={}
        for key,value in entries:
            require(key not in out,'Duplicate JSON field');out[key]=value
        return out
    def number(value):
        result=float(value);require(math.isfinite(result),'Nonfinite JSON number');return result
    result=json.loads(data.decode('utf-8-sig'),object_pairs_hook=pairs,parse_float=number,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite JSON number')))
    def depth(value,level=0):
        require(level<=60,'Excessive JSON depth')
        if isinstance(value,dict):
            for child in value.values():depth(child,level+1)
        elif isinstance(value,list):
            for child in value:depth(child,level+1)
    depth(result);return result

class Package:
    def __init__(self,path):
        self.root=Path(path);self.archive=None
        if self.root.is_file():
            require(self.root.stat().st_size<=ZIP_LIMIT,'ZIP exceeds 256 MiB')
            self.archive=zipfile.ZipFile(self.root);self.names={};total=0
            for item in self.archive.infolist():
                require(archive_path(item.filename) and item.filename.lower() not in self.names,'Unsafe or duplicate ZIP path')
                require(not item.is_dir() and not stat.S_ISLNK(item.external_attr>>16),'ZIP links/directories unsupported')
                require(not item.flag_bits&1 and item.file_size<=FILE_LIMIT,'Encrypted or oversized entry')
                require(item.file_size<=max(1,item.compress_size)*200,'Excessive ZIP expansion ratio')
                self.names[item.filename.lower()]=item;total+=item.file_size
            require(len(self.names)<=5000 and total<=TOTAL_LIMIT,'Archive capacity exceeded')
        else:require(self.root.is_dir(),'Expected research ZIP or extracted directory')
    def read(self,name,limit=FILE_LIMIT):
        require(archive_path(name),'Unsafe path')
        if self.archive:
            item=self.names.get(name.lower());require(item is not None and item.filename==name,'Missing exact file: '+name)
            require(item.file_size<=limit,'Oversized file: '+name)
            with self.archive.open(item) as stream:data=stream.read(limit+1)
        else:
            path=self.root
            for part in name.split('/'):
                path=path/part;info=path.lstat()
                require(not stat.S_ISLNK(info.st_mode) and not getattr(info,'st_file_attributes',0)&0x400,'Linked/reparse path refused')
            require(path.is_file() and path.stat().st_size<=limit,'Missing or oversized file: '+name)
            with path.open('rb') as stream:data=stream.read(limit+1)
        require(len(data)<=limit,'Oversized data');return data
    def close(self):
        if self.archive:self.archive.close()

def reconstruct(index,metadata):
    revisions=unique(index['revisions'],'id');handoffs=unique(index['handoffs'],'id')
    objects=unique(index['objects'],'id');assets=unique(index['assets'],'id');current=index['project']['current']
    require(current['recordId'] in revisions,'Current revision missing')
    for key in ('revisionId','snapshotId','workspaceId'):require(current[key]==revisions[current['recordId']][key],'Current revision identity mismatch')
    def object_ref(value):
        require(value in objects,'Unresolved object reference: '+str(value));return objects[value]
    def meta(value):return metadata[value] if value else None
    for asset in assets.values():
        obj=object_ref(asset['id']);require(all(asset[k]==obj[k] for k in ('sha256','size','path')),'Asset identity mismatch')
    for handoff in handoffs.values():
        for name,value in handoff['payloads'].items():require(safe(name),'Unsafe original payload path');object_ref(value)
        data=meta(handoff['metadataId']);require(data is not None,'Handoff metadata missing')
        require(handoff['payloads'].get(handoff['kind']+'.json')==handoff['metadataId'],'Handoff metadata/payload mismatch')
        if handoff['kind']=='task':require(data['id']==handoff['id'],'Task identity mismatch')
        elif handoff['kind']=='response':require(data['taskId']==handoff['taskId'],'Response task mismatch')
        else:raise ValueError('Unsupported handoff kind')
    result=[]
    for revision in revisions.values():
        for value in revision['metadata'].values():
            if value:object_ref(value)
        if revision.get('packageManifestId'):
            object_ref(revision['packageManifestId']);package=meta(revision['packageManifestId'])
            for name,info in package['payloads'].items():
                require(safe(name),'Unsafe original package path');obj=object_ref('sha256:'+info['sha256']);require(obj['size']==info['size'],'Package object size mismatch')
            for key,name in [('annotations','annotations.json'),('returned','returned-workspace.json'),('completion','completion-history.json')]:
                value=revision['metadata'].get(key)
                if value:require(value=='sha256:'+package['payloads'][name]['sha256'],'Package metadata reference mismatch')
        review=meta(revision['metadata']['annotations']);wrapped=meta(revision['metadata']['returned']);round_=wrapped['returned'] if wrapped else None
        require(review['schema']=='score-desk-review' and review['snapshotId']==revision['snapshotId'],'Annotation snapshot mismatch')
        unique(review['findings'],'id')
        for role,value in revision['assetIds'].items():
            if value:
                asset=assets.get(value);require(asset is not None,'Missing revision asset')
                require(all(asset[k]==review['files'][role][k] for k in ('sha256','size')),'Review/asset mismatch')
        completion=meta(revision['metadata'].get('completion'))
        if completion:require(completion['revisionId']==revision['revisionId'],'Completion revision mismatch')
        task=next((h for h in handoffs.values() if h['kind']=='task' and h['id']==revision.get('taskId')),None)
        issued=meta(task['metadataId']) if task else None
        response=next((h for h in handoffs.values() if h['kind']=='response' and h['id']==revision.get('responseId')),None)
        baseline=next((r for r in revisions.values() if r['kind']=='task-baseline' and r.get('taskId')==revision.get('taskId')),None)
        if issued and baseline:
            baseline_review=meta(baseline['metadata']['annotations'])
            require(issued['baseline']['snapshotId']==baseline['snapshotId'] and issued['baseline']['codeSha256']==baseline_review['files']['ly']['sha256'] and issued['baseline']['renderSha256']==baseline_review['files']['rendered']['sha256'],'Task baseline mismatch')
        if round_:
            require(round_['contentSnapshotId']==revision['snapshotId'] and round_['codeSha256']==review['files']['ly']['sha256'] and round_['renderSha256']==review['files']['rendered']['sha256'],'Returned revision mismatch')
            require(round_['taskId']==revision['taskId'] and round_['responseId']==revision['responseId'],'Returned handoff mismatch')
        reported=round_['reported'] if round_ else [];unique(reported,'id')
        associated={f.get('associationId') for f in reported if f.get('associationId')}
        findings=[(f,True) for f in reported]+[(f,False) for f in review['findings'] if f['id'] not in associated]
        for finding,is_reported in findings:
            annotation=next((f for f in review['findings'] if f['id']==finding.get('associationId')),None) if is_reported else None
            decision=finding.get('decision') if is_reported else None
            if decision:
                checked=decision['reviewed'];require(decision['state']==finding['state'] and checked['snapshotId']==revision['snapshotId'] and checked['codeSha256']==review['files']['ly']['sha256'] and checked['renderSha256']==review['files']['rendered']['sha256'],'Judgment references different state or code/render')
            missing=list(revision.get('missingData',[]))
            if not task:missing.append('issued-task-context-unavailable')
            if not issued or not any(f['id']==finding['id'] for f in issued.get('findings',[])):missing.append('issued-finding-context-unavailable')
            if not is_reported:missing.append('returned-finding-and-human-judgment-unavailable')
            if not round_:missing.append('returned-result-and-human-judgment-unavailable')
            if not response:missing.append('response-package-unavailable')
            missing+=['model-provenance-and-rights-not-established','passage-alignment-not-established','overwritten-intermediate-edits-not-retained']
            result.append(dict(revisionRecordId=revision['id'],revisionId=revision.get('revisionId'),snapshotId=revision['snapshotId'],current=revision['id']==current['recordId'],findingId=finding['id'],findingKind='returned-finding' if is_reported else 'annotation',type=annotation.get('type',finding.get('type','correction')) if annotation else finding.get('type','correction'),status=finding['state'],sourceAssetId=revision['assetIds']['source'],startingAssets=baseline['assetIds'] if baseline else None,resultAssets=revision['assetIds'] if round_ else None,observedAssets=revision['assetIds'],taskId=revision.get('taskId'),responseId=revision.get('responseId'),issuedFinding=next((f for f in issued.get('findings',[]) if f['id']==finding['id']),None) if issued else None,issuedPayloads=task['payloads'] if task else None,responsePayloads=response['payloads'] if response else None,retainedFinding=finding,currentAnnotation=annotation,humanJudgment=decision,judgmentScope='This finding on the recorded revision and code/render bytes; no whole-score correctness claim.',missing=list(dict.fromkeys(missing))))
    for event in index['events']:
        revision=revisions.get(event['id']);require(revision is not None,'Event revision missing')
        for key in ('revisionId','workspaceId','assetIds','metadata'):require(event[key]==revision[key],'Event/revision mismatch')
    return result

def validate(path):
    package=Package(path)
    try:
        manifest=parse(package.read('research-manifest.json',2*1024*1024))
        require(manifest['schema']=='scorebrush-research-export' and type(manifest['version']) is int and manifest['version']==1,'Unsupported research format')
        files=unique(manifest['files'],'path');require(len(files)+1<=5000,'Too many files')
        require(len({p.lower() for p in files})==len(files),'Case-colliding manifest paths')
        require(sum(f['size'] for f in files.values())<=TOTAL_LIMIT,'Payload capacity exceeded')
        required={'History.json','episodes.jsonl','README.txt','research-reader.py'}
        readable={p for p in files if readable_path(p)}
        copy_index={'score-files.json'} & files.keys()
        require(not readable or copy_index,'Readable scores require their identity mapping')
        notices={'LICENSE','LICENSING.md'} & files.keys()
        require(not notices or notices=={'LICENSE','LICENSING.md'},'Incomplete reader software notices')
        for name in notices:require(files[name]['role']=='notice','Invalid software notice role')
        require(required.issubset(files),'Missing research payload')
        if package.archive:require(set(package.names)=={p.lower() for p in files}|{'research-manifest.json'},'Unlisted ZIP entry')
        contents={}
        for name,item in files.items():
            require(name in required|notices|copy_index|readable or re.fullmatch(r'workspace-history/recovery/objects/[a-f0-9]{64}',name),'Non-allowlisted research path')
            require(type(item['size']) is int and 0<=item['size']<=FILE_LIMIT and HASH.fullmatch(item['sha256']),'Invalid file identity')
            data=package.read(name);require(len(data)==item['size'] and digest(data)==item['sha256'],'File hash/size mismatch: '+name);contents[name]=data
        index=parse(contents['History.json']);require(index['schema']=='scorebrush-project-history' and type(index['version']) is int and index['version']==3,'Unsupported history index')
        require(index['project']['id']==manifest['projectId'] and index['project']['current']==manifest['current'] and index['committedGeneration']==manifest['generation'],'Manifest/index identity mismatch')
        objects=unique(index['objects'],'id');metadata={};referenced=set()
        for revision in index['revisions']:
            referenced.update(v for v in revision['metadata'].values() if v)
            if revision.get('packageManifestId'):referenced.add(revision['packageManifestId'])
        for handoff in index['handoffs']:referenced.add(handoff['metadataId'])
        for obj in objects.values():
            require(HASH.fullmatch(obj['sha256']) and obj['id']=='sha256:'+obj['sha256'] and obj['path']=='workspace-history/recovery/objects/'+obj['sha256'],'Invalid object identity/path')
            require(obj['path'] in contents and len(contents[obj['path']])==obj['size'] and digest(contents[obj['path']])==obj['sha256'],'Object bytes mismatch')
            if obj['id'] in referenced:metadata[obj['id']]=parse(contents[obj['path']])
        require(set(contents)==required|notices|copy_index|readable|{o['path'] for o in objects.values()},'Unreferenced object payload')
        require(referenced.issubset(metadata),'Missing metadata reference')
        episodes=reconstruct(index,metadata)
        if copy_index:
            require(files['score-files.json']['role']=='readable-score-index','Invalid readable index role')
            mapping=parse(contents['score-files.json'])
            require(mapping['schema']=='scorebrush-readable-scores' and type(mapping['version']) is int and mapping['version'] in (1,2),'Unsupported readable score mapping')
            # Version 1 has one copy per record/role. Version 2 keeps those exact
            # associations but permits shared paths with one content identity.
            if mapping['version']==1:unique(mapping['files'],'path')
            require({c['path'] for c in mapping['files']}==readable,'Readable mapping/payload mismatch')
            revisions=unique(index['revisions'],'id');seen=set()
            declarations={};current_paths=set()
            order={r['id']:i+1 for i,r in enumerate(sorted(index['revisions'],key=lambda r:r['id']))}
            for copy in mapping['files']:
                name=copy['path']
                revision=revisions.get(copy['revisionRecordId']);role=copy['role'];require(revision is not None and role in ('source','rendered','ly'),'Unknown readable revision/role')
                key=(revision['id'],role);require(key not in seen,'Duplicate readable revision/role');seen.add(key)
                current=revision['id']==index['project']['current']['recordId']
                require(type(copy['current']) is bool and copy['current']==current,'Readable current identity mismatch')
                require(copy['revisionId']==revision.get('revisionId') and copy['snapshotId']==revision['snapshotId'],'Readable revision identity mismatch')
                asset=objects.get(copy['assetId']);require(asset is not None and copy['assetId']==revision['assetIds'][role],'Readable asset reference mismatch')
                label=re.sub('[^a-z-]','',str(revision['kind']))[:32] or 'revision'
                folder='scores/current' if current else 'scores/history/'+str(order[revision['id']]).zfill(4)+'-'+label
                directory={'source':'source','rendered':'transcription','ly':'lilypond'}[role]
                if mapping['version']==1 or current:
                    require(name.rsplit('/',1)[0]==folder+'/'+directory,'Readable role/revision folder mismatch')
                else:
                    require(name.startswith('scores/current/') or re.fullmatch(r'scores/history/[0-9]{4}-shared/(source|transcription|lilypond)/[^/]+',name),'Invalid shared score folder')
                if current:current_paths.add(name)
                declaration=(copy['assetId'],copy['sha256'],copy['size'])
                require(name not in declarations or declarations[name]==declaration,'Conflicting readable file declarations')
                declarations[name]=declaration
                review=metadata[revision['metadata']['annotations']]
                require(copy['originalFilename']==review['files'][role].get('name'),'Readable original filename mismatch')
                require(all(copy[k]==asset[k] for k in ('sha256','size')) and files[name]['role']=='readable-score','Readable identity/role mismatch')
                require(contents[name]==contents[asset['path']],'Readable copy differs from captured object')
            expected={(r['id'],role) for r in revisions.values() for role in ('source','rendered','ly') if r['assetIds'].get(role)}
            require(seen==expected,'Readable scores omit retained assets')
            require({p for p in readable if p.startswith('scores/current/')}==current_paths,'Unbound current score path')
        require(len(contents['episodes.jsonl'])<=JSON_LIMIT,'Episode metadata too large')
        declared=[parse(line) for line in contents['episodes.jsonl'].splitlines() if line.strip()]
        require(declared==episodes and manifest['episodeCount']==len(episodes),'Episode records disagree with retained evidence')
        return episodes,index,contents
    finally:package.close()

def examples(episodes,index,contents,output=None):
    """Resolve evidence for researchers, with optional safe, deduplicated file copies."""
    objects=unique(index['objects'],'id');copies={}
    def resolve(value,name):
        if not value:return None
        obj=objects[value];data=contents[obj['path']]
        extension=Path(name).suffix.lower()
        if extension not in ('.pdf','.ly','.txt','.md','.json'):extension='.bin'
        filename=copies.setdefault(value,obj['sha256']+extension)
        result=dict(sha256=obj['sha256'],size=obj['size'])
        if output:result['file']=output.name+'.assets/'+filename
        else:result['archiveEntry']=obj['path']
        return result
    def assets(values):return {role:resolve(value,'notation.ly' if role=='ly' else 'evidence.pdf') for role,value in values.items()} if values else None
    result=[]
    for episode in episodes:
        evidence=dict(source=resolve(episode['sourceAssetId'],'source.pdf'),starting=assets(episode['startingAssets']),result=assets(episode['resultAssets']),observed=assets(episode['observedAssets']))
        for key in ('issuedPayloads','responsePayloads'):
            evidence[key.replace('Payloads','Context')]={name:resolve(value,name) for name,value in episode[key].items()} if episode[key] else None
        result.append(dict(episode,evidence=evidence))
    if output:
        require(not output.exists(),'Output already exists')
        directory=output.with_name(output.name+'.assets');directory.mkdir()
        for value,filename in copies.items():
            with (directory/filename).open('xb') as stream:stream.write(contents[objects[value]['path']])
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('archive',help='Research ZIP or extracted directory');parser.add_argument('--output',help='New JSONL output file; refuses overwrite');parser.add_argument('--current',action='store_true',help='Show only observations from the current saved review')
    args=parser.parse_args()
    try:
        episodes,index,contents=validate(args.archive)
        if args.current:episodes=[e for e in episodes if e['current']]
        episodes=examples(episodes,index,contents,Path(args.output) if args.output else None)
        output=''.join(json.dumps(e,ensure_ascii=False,sort_keys=True)+'\n' for e in episodes)
        if args.output:
            with open(args.output,'x',encoding='utf-8') as stream:stream.write(output)
        else:sys.stdout.write(output)
        print('Validated; '+str(len(episodes))+' retained finding observations.',file=sys.stderr)
        return 0
    except (ValueError,KeyError,TypeError,AttributeError,IndexError,OSError,zipfile.BadZipFile,RuntimeError,RecursionError) as error:
        print('Validation failed: '+str(error),file=sys.stderr);return 1
if __name__=='__main__':sys.exit(main())
