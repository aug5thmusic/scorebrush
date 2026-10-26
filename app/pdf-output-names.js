// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Presentation names only. Content hashes and logical revision IDs never change.
export const UNKNOWN_TITLE='Transcription (original title unknown)';
const HASH=/^[a-f0-9]{64}$/,reserved=/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i;
export const nameKey=name=>name.normalize('NFC').toUpperCase();
export function safeBasename(original){
  let value=typeof original==='string'?original.replace(/\.pdf$/i,''):'';
  value=value.normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').replace(/[\uD800-\uDFFF]/gu,'_').trim().replace(/[. ]+$/g,'');
  if(!value||value==='.'||value==='..')value=UNKNOWN_TITLE;
  if(reserved.test(value))value='_'+value;
  // Bound UTF-16 length without splitting a surrogate pair. Leave ample room
  // for the ordinal, collision suffix and extension within a Windows component.
  let result='';for(const point of value){if(result.length+point.length>120)break;result+=point;}
  return result.replace(/[. ]+$/g,'')||UNKNOWN_TITLE;
}
export function pdfName(number,basename,suffix=1){
  return String(number).padStart(4,'0')+' - '+basename+(suffix>1?' ('+suffix+')':'')+'.pdf';
}
export function validPdfName(name,number=null,basename=null){
  if(typeof name!=='string'||name.length>160||/[\x00-\x1f<>:"/\\|?*]/.test(name)||/[\uD800-\uDFFF]/u.test(name)||/[. ]$/.test(name))return false;
  const match=/^(\d{4,5}) - (.+)\.pdf$/.exec(name);if(!match||Number(match[1])<1||Number(match[1])>5000||number!==null&&Number(match[1])!==number)return false;
  if(basename===null)return true;
  const stem=pdfName(Number(match[1]),basename).slice(0,-4);
  if(name===stem+'.pdf')return true;
  const suffix=name.slice(stem.length);
  return name.startsWith(stem)&&/^ \(([2-9]|[1-9][0-9]+)\)\.pdf$/.test(suffix);
}
export function validatePdfOutput(value){
  if(!value||value.version!==1||!['initial-selection','legacy-initial-evidence','unknown'].includes(value.nameSource)||value.initialTranscriptionFilename!==null&&(typeof value.initialTranscriptionFilename!=='string'||!value.initialTranscriptionFilename.length||value.initialTranscriptionFilename.length>1000)||value.basename!==safeBasename(value.initialTranscriptionFilename)||(value.initialTranscriptionFilename===null)!==(value.nameSource==='unknown')||!Array.isArray(value.renderings)||value.renderings.length>5000)throw new Error('PDF naming metadata is invalid. Existing files were kept.');
  const hashes=new Set(),numbers=new Set();
  for(const r of value.renderings){
    if(!HASH.test(r.sha256)||!Number.isSafeInteger(r.size)||r.size<1||r.size>100*1024*1024||!Number.isSafeInteger(r.number)||r.number<1||r.number>5000||hashes.has(r.sha256)||numbers.has(r.number))throw new Error('PDF rendering ordinals conflict. Existing numbers were kept.');
    hashes.add(r.sha256);numbers.add(r.number);
  }
  return value;
}
