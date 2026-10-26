// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {readdir,readFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const app=resolve(dirname(fileURLToPath(import.meta.url)),'../app');
const files=(await readdir(app)).filter(name=>name.endsWith('.js'));
const qa=(await readdir(resolve(app,'qa'))).filter(name=>name.endsWith('.js'));
for(const name of [...files,...qa.map(name=>'qa/'+name)]){
  const path=resolve(app,name),text=await readFile(path,'utf8');
  execFileSync(process.execPath,['--check',path],{stdio:'pipe'});
  for(const match of text.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g))assert((await stat(resolve(dirname(path),match[1]))).isFile(),`missing import ${name}: ${match[1]}`);
  assert(!/from\s*['"].*shared-|github-handoff/.test(text),`connected-project dependency in ${name}`);
}
const html=await readFile(resolve(app,'index.html'),'utf8');
assert(html.includes("connect-src 'self';"));
assert.deepEqual([...html.matchAll(/(?:href|src)="(https?:\/\/[^\"]+)"/g)].map(m=>m[1]),['https://github.com/aug5thmusic/scorebrush'],'only the official repository may be an external action/resource in the app shell');
assert(!/sharedProject|sharedSubmit/.test(html),'no connected-project UI in the local shell');
assert(html.includes('id="aboutLicense"')&&html.includes('AGPLv3 or later'),'About exposes the application license');
assert((await readFile(resolve(app,'storage.js'),'utf8')).includes('private-score-desk-local-v1'));
assert((await readFile(resolve(app,'handoff-store.js'),'utf8')).includes('private-score-desk-handoffs-v1'));
for(const required of ['pdf.mjs','pdf.worker.mjs','pdf-lib.min.js','jszip.min.js','PDFJS-LICENSE','PDF-LIB-LICENSE.md','JSZIP-LICENSE.md','fonts/sora.woff2','fonts/sora-OFL.txt','fonts/bricolagegrotesque.woff2','fonts/bricolagegrotesque-OFL.txt']){
  assert((await stat(resolve(app,'vendor',required))).isFile(),'missing bundled dependency or license: '+required);
}
const {fixtureBlob}=await import('../app/qa/fixtures.js');
for(const [name,pages] of [['source.pdf',1],['rendered.pdf',1],['multipage.pdf',4]]){
  const one=await fixtureBlob(name),two=await fixtureBlob(name),text=await one.text();
  assert.equal(one.type,'application/pdf');assert.equal(text,await two.text(),'deterministic synthetic fixture: '+name);
  assert(text.includes(`/Count ${pages}`),'synthetic page count: '+name);
  const offset=Number(text.match(/startxref\n(\d+)/)[1]);assert.equal(text.slice(offset,offset+4),'xref','valid synthetic xref: '+name);
}
assert.notEqual(await (await fixtureBlob('source.pdf')).text(),await (await fixtureBlob('rendered.pdf')).text(),'source/render fixtures must have distinct identities');
const shell=await readFile(resolve(app,'application-shell.js'),'utf8'),host=await readFile(resolve(app,'../launcher.cs'),'utf8');
assert(host.includes('(op=="folder-open"||op=="folder-versions"||op=="folder-latest"||op=="folder-verify")&&(message.Count==7||message.Count==8)'), 'host must route both legacy and explicit proof-directory messages to strict native validation');
const nativeCommands=[...host.matchAll(/Command\((?:file|edit|layout|workflow|help),"([a-z-]+)"/g)].map(m=>m[1]).sort();
const webCommands=[...shell.slice(0,shell.indexOf('export function')).matchAll(/\['([a-z-]+)','[^']+'/g)].map(m=>m[1]).sort();
assert.deepEqual(nativeCommands,webCommands,'native and web command allowlists must match exactly');
assert(nativeCommands.includes('scroll-pages')&&nativeCommands.length===31,'page scrolling is one explicit command in the 31-command allowlist');
assert(host.includes('states.Count!=commands.Count')&&host.includes('!commands.ContainsKey(pair.Key)')&&host.includes('state.Count!=2'),'native menu state retains exact count, command and boolean-field validation');
for(const name of ['index.html',...files]){
  const source=await readFile(resolve(app,name),'utf8');
  for(const obsolete of ['Move existing browser reviews','Automatic recovery needs a connected working folder','Choose once. Your findings will save beside these files','Your files stay on this computer. Allow access','Open in Windows Explorer','Brush & color','Current passage','Location not confirmed','Remember this passage'])assert(!source.includes(obsolete),`obsolete interface copy in ${name}: ${obsolete}`);
}
assert(host.includes('app","wordmark.png')&&html.includes('class="startup-wordmark" src="wordmark.png"'),'native and web startup share one wordmark asset');
const official=resolve(app,'../design-assets/scorebrush-official'),artwork=JSON.parse(await readFile(resolve(official,'source-manifest.json'),'utf8'));
for(const asset of artwork.assets){
  const source=await readFile(resolve(official,asset.file)),shipped=await readFile(resolve(app,'branding',asset.file));
  assert.equal(createHash('sha256').update(source).digest('hex'),asset.sha256,'source artwork hash: '+asset.file);
  assert(source.equals(shipped),'shipped artwork must be byte-identical: '+asset.file);
}
console.log(`Private integration checks passed: ${files.length} application and ${qa.length} QA modules, local imports, CSP, private storage, disconnected UI, bundled licenses and synthetic PDF fixtures.`);
