// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Keep this grammar aligned with build_info.py and tests/build-info-cases.json.
const versionPattern=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const invalid=detail=>new Error('Invalid build information: '+detail+'. Extract the complete review ZIP.');

export function windowsVersion(version){
  const match=typeof version==='string'?versionPattern.exec(version):null;
  // JS $ also matches before a final newline; require the entire string.
  if(!match||match[0]!==version||match.slice(1,4).some(part=>Number(part)>65534)||
    match[4]?.split('.').some(part=>/^[0-9]+$/.test(part)&&part.length>1&&part.startsWith('0'))){
    throw invalid('version must be SemVer with core components from 0 to 65534');
  }
  return match.slice(1,4).join('.')+'.0';
}

export function validateBuildInfo(info){
  if(!info||typeof info!=='object'||Array.isArray(info))throw invalid('expected a metadata object');
  windowsVersion(info.version);
  if(typeof info.buildDate!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(info.buildDate)||info.buildDate.length!==10){
    throw invalid('buildDate must use YYYY-MM-DD');
  }
  return Object.freeze({...info});
}
