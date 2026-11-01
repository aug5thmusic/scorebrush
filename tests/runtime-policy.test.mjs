// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('native startup validates effective policy without changing the registry', {skip:process.platform!=='win32'},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),runtime=resolve(root,'.runtime');await mkdir(runtime,{recursive:true});
  const preparation=await readFile(join(root,'prepare_release.py'),'utf8'),version=/WEBVIEW_VERSION = "([^"]+)"/.exec(preparation)?.[1],expected=/WEBVIEW_SHA256 = "([a-f0-9]+)"/.exec(preparation)?.[1];
  assert.ok(version&&expected,'existing SDK pins must be available');
  const sdk=join(runtime,'downloads',`microsoft.web.webview2.${version}.nupkg`),bytes=await readFile(sdk);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'cached SDK must match its pin; this test never downloads');
  const evidence=await mkdtemp(join(runtime,'runtime-policy-'));
  const extract=String.raw`Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($env:SCOREBRUSH_TEST_SDK)
try {[IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry('lib/net462/Microsoft.Web.WebView2.Core.dll'),[IO.Path]::Combine($env:SCOREBRUSH_TEST_OUT,'Microsoft.Web.WebView2.Core.dll'))} finally {$archive.Dispose()}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',extract],{windowsHide:true,env:{...process.env,SCOREBRUSH_TEST_SDK:sdk,SCOREBRUSH_TEST_OUT:evidence}});
  const executable=join(evidence,'RuntimePolicyTests.exe'),compiler=join(process.env.WINDIR??'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compiled=execFileSync(compiler,['/nologo','/codepage:65001','/target:exe','/platform:x64','/r:System.Windows.Forms.dll','/r:System.Security.dll','/r:'+join(evidence,'Microsoft.Web.WebView2.Core.dll'),'/out:'+executable,join(root,'runtime-setup.cs'),join(root,'tests/runtime-policy.test.cs')],{encoding:'utf8',windowsHide:true});
  await writeFile(join(evidence,'compile.txt'),compiled);
  let output;try{output=execFileSync(executable,[],{encoding:'utf8',windowsHide:true,timeout:30000});}catch(error){await writeFile(join(evidence,'checks.txt'),String(error.stdout??'')+String(error.stderr??''));throw error;}
  await writeFile(join(evidence,'checks.txt'),output);assert.match(output,/Runtime policy checks: 22/);
  console.log(output.trim().split('\n').at(-1));console.log('Synthetic policy evidence: '+evidence);
});
