// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Import and export share one size/path contract. ZIP headers count toward the
// final size; research checks its compressed size after choosing entry methods.
import {readableScorePathOK} from './score-export-names.js';
export const LIMITS={zip:256*1024*1024,total:512*1024*1024,file:100*1024*1024,count:5000,ratio:200,json:25*1024*1024};
export const packagePathOK=name=>typeof name==='string'&&name.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)&&!name.split('/').some(p=>!p||p==='.'||p==='..');
export function validateExportPayloads(payloads,{research=false}={}){
  if(!(payloads instanceof Map)||!payloads.size||payloads.size>LIMITS.count)throw new Error('Export exceeds the supported 5,000-file import limit or contains no files.');
  let total=0,zipBytes=22;const seen=new Set();
  for(const [path,blob]of payloads){
    if(!(packagePathOK(path)||research&&readableScorePathOK(path))||path.startsWith('scores/')&&!readableScorePathOK(path)||seen.has(path.toLowerCase()))throw new Error('Export contains an unsafe or duplicate package path.');
    seen.add(path.toLowerCase());
    if(!(blob instanceof Blob)||blob.size>LIMITS.file)throw new Error('Export contains a missing file or a file above the 100 MB import limit.');
    total+=blob.size;if(total>LIMITS.total)throw new Error('Export exceeds the 512 MB expanded import limit.');
    if(/\.json$/i.test(path)){
      const name=path.split('/').at(-1).toLowerCase(),limit=['manifest.json','response.json'].includes(name)?2*1024*1024:LIMITS.json;
      if(blob.size>limit)throw new Error(`Export ${path} exceeds its ${limit===LIMITS.json?'25':'2'} MB JSON import limit.`);
    }
    // STORE headers, plus both JSZip Unicode-path extra fields when needed.
    const bytes=new TextEncoder().encode(path).length;
    zipBytes+=blob.size+76+2*bytes+(bytes!==path.length?18+2*bytes:0);
  }
  if(!research)validateExportZipSize(zipBytes);
  return {total,zipBytes};
}
export function validateExportZip(zip){
  if(!(zip instanceof Blob))throw new Error('Invalid export ZIP.');
  validateExportZipSize(zip.size);
  return zip;
}
export function validateExportZipSize(size){
  if(!Number.isSafeInteger(size)||size<22||size>LIMITS.zip)throw new Error('Export ZIP exceeds the 256 MB import limit, including ZIP headers, or is invalid. Keep this workspace open; no recovery ZIP was published.');
}
