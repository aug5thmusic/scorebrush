// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Display/export names only. Never changes captured bytes or stored identities.
const roles=['source','rendered','ly'];
const fallback={source:'source.pdf',rendered:'transcription.pdf',ly:'notation.ly'};
const aliases={source:null,rendered:'proposed.pdf',ly:'proposed.ly'};
const reserved=/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;
const forbidden=/[<>:"/\\|?*\p{Cc}\p{Cf}\p{Cs}]/u;
export function leafName(value){return typeof value==='string'?value.split(/[\\/]/).at(-1).trim():'';}
export function scoreNames(scene,{paths=null,ancestors=[]}={}){
  const names={},known={};
  for(const role of roles){
    const own=leafName(scene.files?.[role]?.name??scene.review?.files?.[role]?.name);
    const inherited=ancestors.map(s=>leafName(s.files?.[role]?.name??s.review?.files?.[role]?.name)).find(n=>n&&n.toLowerCase()!==aliases[role]);
    const initial=role==='rendered'?leafName(scene.initialTranscriptionFilename):'';
    const name=leafName(paths?.[role])||(scene.returned&&own.toLowerCase()===aliases[role]?(initial||inherited):own)||initial||inherited;
    names[role]=name||fallback[role];known[role]=Boolean(name);
  }
  return {names,known};
}
export function safeScoreFilename(value,role){
  const ext=role==='ly'?'.ly':'.pdf';let name=leafName(value).normalize('NFC');
  let suffix=name.toLowerCase().endsWith(ext)?name.slice(-ext.length):ext;
  if(name.toLowerCase().endsWith(ext))name=name.slice(0,-ext.length);
  name=Array.from(name).map(c=>forbidden.test(c)?'_':c).join('').replace(/[. ]+$/u,'');
  // Bound both Windows UTF-16 component length and ZIP path length.
  while(name.length>90)name=Array.from(name).slice(0,-1).join('');
  name=name.replace(/[. ]+$/u,'').replace(/^\./u,'_');
  if(!name||/^\.+$/.test(name))name=role==='ly'?'notation':role==='rendered'?'transcription':'source';
  if(reserved.test(name))name='_'+name;
  return name+suffix;
}
export function readableScorePathOK(path){
  if(typeof path!=='string'||path.length>240)return false;
  const match=/^scores\/(?:current|history\/[0-9]{4}-[a-z-]+)\/(source|transcription|lilypond)\/([^/]+)$/u.exec(path);
  if(!match)return false;
  const name=match[2];return name.length<=100&&!forbidden.test(name)&&!/[. ]$/u.test(name)&&!reserved.test(name)&&!name.startsWith('.')&&(match[1]==='lilypond'?/\.ly$/i:/\.pdf$/i).test(name);
}
export function researchZipName(resolved,scene,date=new Date()){
  const identity=scene.projectId??scene.workspaceId??scene.review?.snapshotId??'unknown';
  const stem=resolved.known.ly?resolved.names.ly.replace(/\.ly$/i,''):'project-'+String(identity).slice(0,48);
  const clean=safeScoreFilename(stem+'.ly','ly').slice(0,-3),pad=n=>String(n).padStart(2,'0');
  const stamp=date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'-'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds());
  return clean+'-research-'+stamp+'.zip';
}
