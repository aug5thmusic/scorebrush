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

test('current native folder code delivers a pinned directory through real WebView2', {skip:process.platform!=='win32',timeout:90000},async()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),runtime=resolve(root,'.runtime');await mkdir(runtime,{recursive:true});
  const preparation=await readFile(join(root,'prepare_release.py'),'utf8'),version=/WEBVIEW_VERSION = "([^"]+)"/.exec(preparation)?.[1],expected=/WEBVIEW_SHA256 = "([a-f0-9]+)"/.exec(preparation)?.[1];
  assert.ok(version&&expected,'existing SDK pins must be available');
  const sdk=join(runtime,'downloads',`microsoft.web.webview2.${version}.nupkg`),bytes=await readFile(sdk);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected,'cached SDK must match the existing pin; this runner never downloads');
  const evidence=await mkdtemp(join(runtime,'native-folder-webview-'));console.log('Synthetic WebView2 evidence: '+evidence);
  const extract=String.raw`Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead($env:SCOREBRUSH_TEST_SDK)
try {
 $files=@{'Microsoft.Web.WebView2.Core.dll'='lib/net462/Microsoft.Web.WebView2.Core.dll';'Microsoft.Web.WebView2.WinForms.dll'='lib/net462/Microsoft.Web.WebView2.WinForms.dll';'WebView2Loader.dll'='runtimes/win-x64/native/WebView2Loader.dll';'WebView2-LICENSE.txt'='LICENSE.txt'}
 foreach($name in $files.Keys){$entry=$archive.GetEntry($files[$name]);[IO.Compression.ZipFileExtensions]::ExtractToFile($entry,[IO.Path]::Combine($env:SCOREBRUSH_TEST_OUT,$name))}
} finally {$archive.Dispose()}`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',extract],{windowsHide:true,env:{...process.env,SCOREBRUSH_TEST_SDK:sdk,SCOREBRUSH_TEST_OUT:evidence}});
  await mkdir(join(evidence,'web'));
  await writeFile(join(evidence,'web','index.html'),`<!doctype html><meta charset="utf-8"><title>Synthetic native handle test</title><script>
  window.chrome.webview.addEventListener('message',async event=>{
    try {
      const handle=event.additionalObjects?.[0],value=event.data.value;
      if(!handle||handle.kind!=='directory'||handle.name!=='SYNTHETIC selected')throw Error('Missing or wrong actual directory handle');
      if(await handle.queryPermission({mode:'readwrite'})!=='granted')throw Error('Native handle lacks its granted permission');
      const file=await handle.getFileHandle(value.marker,{create:true}),output=await file.createWritable(),proof='private-score-desk-open-v1\\n'+value.proof;
      await output.write(proof);await output.close();if(await(await file.getFile()).text()!==proof)throw Error('Proof read-back differs');
      window.chrome.webview.postMessage({op:'folder-confirm',id:'a'.repeat(32),token:value.token,marker:value.marker,proof:value.proof});
    }catch(error){window.chrome.webview.postMessage({op:'error',error:String(error.stack||error)});}
  });window.chrome.webview.postMessage({op:'ready'});
  </script>`);
  const executable=join(evidence,'NativeFolderWebViewTests.exe'),compiler=join(process.env.WINDIR??'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile=execFileSync(compiler,['/nologo','/codepage:65001','/target:exe','/platform:x64','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll','/r:System.Security.dll','/r:'+join(evidence,'Microsoft.Web.WebView2.Core.dll'),'/r:'+join(evidence,'Microsoft.Web.WebView2.WinForms.dll'),'/out:'+executable,join(root,'native-services.cs'),join(root,'tests/native-folder-webview.test.cs')],{encoding:'utf8',windowsHide:true});
  await writeFile(join(evidence,'compile.txt'),compile);
  let failure=null;try{execFileSync(executable,[evidence],{encoding:'utf8',windowsHide:true,timeout:60000});}catch(error){failure=error;await writeFile(join(evidence,'process-error.txt'),String(error)+String(error.stdout??'')+String(error.stderr??''));}
  const result=JSON.parse(await readFile(join(evidence,'result.json'),'utf8'));console.log(JSON.stringify(result));assert.equal(result.passed,true,result.error);if(failure)throw failure;
});
