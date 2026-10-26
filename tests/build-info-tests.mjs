// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateBuildInfo,windowsVersion} from '../app/build-info.js';

const cases=JSON.parse(await readFile(new URL('./build-info-cases.json',import.meta.url),'utf8'));
const build=JSON.parse(await readFile(new URL('../app/build-info.json',import.meta.url),'utf8'));
for(const [version,numeric] of cases.valid){
  const info={...build,version};
  assert.equal(windowsVersion(version),numeric);
  assert.deepEqual(validateBuildInfo(info),info,'full informational version is preserved');
  assert(Object.isFrozen(validateBuildInfo(info)));
}
for(const version of [...cases.invalid,'9'.repeat(10000)+'.0.0']){
  assert.throws(()=>windowsVersion(version),/Invalid build information: version/);
  assert.throws(()=>validateBuildInfo({...build,version}),/Invalid build information: version/);
}
for(const info of cases.invalidMetadata)assert.throws(()=>validateBuildInfo(info),/Invalid build information/);
assert.deepEqual(validateBuildInfo(build),build);
console.log('PASS JS metadata: '+cases.valid.length+' valid versions, '+(cases.invalid.length+1)+' invalid versions, '+cases.invalidMetadata.length+' malformed metadata cases; maintained '+build.version+' -> '+windowsVersion(build.version));
