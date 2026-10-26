// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,symlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('native path/proof security and damaged grant recovery use disposable Windows data', {skip:process.platform!=='win32'},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),runtime=resolve(root,'.runtime');await mkdir(runtime,{recursive:true});
  const evidence=await mkdtemp(join(runtime,'native-services-regression-')),folder=join(evidence,'SYNTHETIC project'),target=join(evidence,'SYNTHETIC junction target');
  await mkdir(join(folder,'redirect-project'),{recursive:true});await mkdir(target);
  for(const name of ['redirect','redirect-project/Versions','redirect-project/Latest'])await symlink(target,join(folder,name),'junction');
  const executable=join(evidence,'NativeServicesTests.exe'),compiler=join(process.env.WINDIR??'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile=execFileSync(compiler,['/nologo','/codepage:65001','/target:exe','/platform:x64','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.Security.dll','/out:'+executable,resolve(root,'native-services.cs'),resolve(root,'tests/native-services.test.cs')],{encoding:'utf8',windowsHide:true});
  await writeFile(join(evidence,'compile.txt'),compile);
  let output;try{output=execFileSync(executable,[folder],{encoding:'utf8',windowsHide:true,timeout:120000});}catch(error){await writeFile(join(evidence,'checks.txt'),String(error.stdout??'')+String(error.stderr??''));throw error;}
  await writeFile(join(evidence,'checks.txt'),output);assert.match(output,/Native verification checks: \d+/);
  console.log(output.trim().split('\n').at(-1));console.log('Synthetic native evidence: '+evidence);
});
