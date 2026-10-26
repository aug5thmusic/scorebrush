// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {fixtureBlob} from './fixtures.js';
import {getSaved} from '../storage.js';
import {sha256,validateReview,clone,bounds,PALETTE,VERSION,paint,markerPosition,hitFinding} from '../model.js';
import * as pdfjs from '../vendor/pdf.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='../vendor/pdf.worker.mjs';
const frame=document.getElementById('app'),out=document.getElementById('results');
if(['8939','8945','8964','8967','8995'].includes(location.port)||location.hostname!=='127.0.0.1'){out.textContent='QA refused: use an isolated loopback port, never a working ScoreBrush origin.';document.getElementById('run').disabled=true;throw new Error(out.textContent);}
frame.src='../index.html';
const log=s=>{out.textContent+=s+'\n';};
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const assert=(condition,label)=>{if(!condition)throw new Error(label);log('PASS '+label);};
const wait=async(fn,label)=>{const until=Date.now()+20000;while(Date.now()<until){if(await fn())return;await new Promise(r=>setTimeout(r,70));}throw new Error('Timeout: '+label);};
const $=id=>frame.contentDocument.getElementById(id),api=()=>frame.contentWindow.scoreDeskQA;
async function bridge(){const script=frame.contentDocument.createElement('script');script.type='module';script.src='./qa/bridge.js';frame.contentDocument.body.append(script);await wait(()=>api(),'app state bridge');}
const rowFor=id=>[...frame.contentDocument.querySelectorAll('.finding')].find(row=>row.dataset.findingId===id);
const reviewReady=(test,label)=>wait(()=>api()&&!api().sessionStatus().busy&&$('renderedPaper').getAttribute('aria-busy')==='false'&&$('sourcePaper').getAttribute('aria-busy')==='false'&&test(api().completion.capture().review),label);
const event=(id,type)=>$(id).dispatchEvent(new frame.contentWindow.Event(type,{bubbles:true}));
async function markAligned(record,doc,label){await wait(()=>$('renderedPaper').getAttribute('aria-busy')==='false','visible page paint');const page=await doc.getPage(1),base=page.getViewport({scale:1}),canvas=$('overlay'),vp=page.getViewport({scale:parseFloat(canvas.style.width)/base.width}),point=record.review.findings[0].strokes[0].points[0];const [x,y]=vp.convertToViewportPoint(...point),dpr=canvas.width/vp.width;assert(canvas.getContext('2d').getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data[3]>0,label);}
async function choose(id,blob,name){const dt=new frame.contentWindow.DataTransfer();dt.items.add(new frame.contentWindow.File([blob],name));$(id).files=dt.files;event(id,'change');}
async function saved(){return getSaved(api().completion.capture().workspaceId);}
async function settle(){await wait(()=>!$('storage').textContent.startsWith('Saving')&&$('storage').textContent.startsWith('Saved locally'),'durable save');return saved();}
function input(id,value){$(id).value=value;event(id,'input');}
async function stroke(x,y,dx=25,cancel=false){await wait(()=>$('renderedPaper').getAttribute('aria-busy')==='false','page ready for pointer input');const c=$('overlay'),r=c.getBoundingClientRect(),w=frame.contentWindow;const send=(type,px,py)=>c.dispatchEvent(new w.PointerEvent(type,{bubbles:true,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,buttons:type==='pointerup'?0:1,clientX:r.left+px,clientY:r.top+py}));send('pointerdown',x,y);send('pointermove',x+dx,y+2);send(cancel?'pointercancel':'pointerup',x+dx,y+2);}
async function alphaAt(finding,doc){await wait(()=>$('renderedPaper').getAttribute('aria-busy')==='false','focus page ready');const p=await doc.getPage(1),base=p.getViewport({scale:1}),c=$('overlay'),v=p.getViewport({scale:parseFloat(c.style.width)/base.width}),[x,y]=v.convertToViewportPoint(...finding.strokes[0].points[0]),dpr=c.width/v.width;return c.getContext('2d').getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data[3];}
function markerLabelsCentered(){
  let unchanged=true;
  for(const dpr of [1,2])for(const scale of [.75,1,2]){
    const offsets=[];
    for(const number of [1,10,11,20,99]){
      const viewport={scale,userUnit:1,width:128*scale,height:128*scale,convertToViewportPoint:(x,y)=>[x*scale,y*scale]},finding={number,page:1,strokes:[{points:[[64,80],[80,80]],width:2,color:PALETTE[0].color,opacity:.35}]};
      const before=JSON.stringify(finding),marker=markerPosition(viewport,finding),canvas=document.createElement('canvas');canvas.width=viewport.width*dpr;canvas.height=viewport.height*dpr;
      const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);paint(ctx,viewport,[finding],1);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;
      // Isolate the actual white glyph pixels from the purple circle and yellow
      // stroke; compare their visible bounds with the unchanged marker center.
      for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
        const i=(y*canvas.width+x)*4;
        if(pixels[i]>70&&pixels[i+1]>63&&pixels[i+2]>210&&pixels[i+3]>250){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}
      }
      offsets.push({number,x:(left+right+1)/2-marker.x*dpr,y:(top+bottom+1)/2-marker.y*dpr});
      const circle=ctx.getImageData(Math.floor((marker.x+marker.radius*.8)*dpr),Math.floor(marker.y*dpr),1,1).data;
      unchanged&&=JSON.stringify(finding)===before&&JSON.stringify(markerPosition(viewport,finding))===JSON.stringify(marker)&&hitFinding(viewport,[finding],1,marker.x,marker.y)===finding&&circle[0]===68&&circle[1]===61&&circle[2]===208;
    }
    assert(offsets.every(offset=>Math.abs(offset.x)<=.5&&Math.abs(offset.y)<=.5),`visible number ink for 1, 10, 11, 20 and 99 is centered within half a backing pixel at ${scale*100}% / DPR ${dpr}: ${JSON.stringify(offsets)}`);
  }
  const c=document.createElement('canvas');c.width=c.height=80;const ctx=c.getContext('2d'),v={scale:1,userUnit:1,convertToViewportPoint:(x,y)=>[x,y]};paint(ctx,v,[{number:1,page:1,strokes:[{points:[[40,40],[65,40]],width:12,color:PALETTE[0].color,opacity:.35}]}],1);assert(Math.abs(ctx.getImageData(55,40,1,1).data[3]-100)<=1,'brush markings render 12% more opaque while old stroke data stays compatible');
  assert(unchanged,'number alignment preserves purple circles, marker geometry, hit targets and finding data');
}
document.getElementById('run').onclick=async()=>{
  out.textContent='';document.getElementById('run').disabled=true;
  try{
    if(['8939','8945','8964','8967','8995'].includes(location.port)||location.hostname!=='127.0.0.1')throw new Error('Run QA on a separate loopback port, never a working ScoreBrush origin.');
    markerLabelsCentered();
    await wait(()=>frame.contentDocument.body.dataset.ready==='true','app ready after any restore');await bridge();
    const [source,render,ly]=await Promise.all(['source.pdf','multipage.pdf','score.ly'].map(async name=>fixtureBlob(name)));
    // An inert PDF comment makes test bytes distinct; PDF readers ignore trailing comments.
    const uniqueRender=new Blob([render,'\n% ScoreBrush QA '+Date.now()+'\n'],{type:'application/pdf'});
    const geometryDoc=await pdfjs.getDocument({data:new Uint8Array(await uniqueRender.arrayBuffer()),isEvalSupported:false}).promise;
    await choose('sourceFile',source,'qa-source.pdf');await choose('renderedFile',uniqueRender,'qa-rendered.pdf');await choose('lyFile',ly,'qa-score.ly');$('load').click();
    const originalRenderHash=await sha256(await uniqueRender.arrayBuffer());await reviewReady(review=>review?.files.rendered.sha256===originalRenderHash,'load exact local bytes');await settle();
    assert($('sourceCount').textContent==='/ 1'&&$('renderedCount').textContent==='/ 4','independent 1-page source and 4-page render loaded');
    $('newFinding').click();input('comment','should be E♭ — compare ♯ and 𝄞');await stroke(90,110);await stroke(130,116);
    let record=await settle();assert(record.review.findings.length===1&&record.review.findings[0].strokes.length===2,'two brush strokes share one comment');
    const first=clone(record.review.findings[0]);await stroke(160,120,30,true);record=await settle();assert(record.review.findings[0].strokes.length===2,'cancelled gesture leaves no phantom stroke');
    $('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');$('newFinding').click();input('comment','beam together');await stroke(175,160);$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');record=await settle();assert(record.review.findings.length===2&&record.review.findings[1].strokes.length===1,'separate pitch and beam findings');
    rowFor(first.id).click();await wait(()=>$('comment').value===first.comment,'select finding for color');
    $('highlightColor').value=PALETTE[2].color;event('highlightColor','change');record=await settle();
    assert(record.review.findings[0].strokes.every(s=>s.color===PALETTE[2].color)&&record.review.findings[1].color===PALETTE[1].color,'changing a finding color recolors all its strokes only; the second finding retains its default cycled color');
    $('undo').click();record=await settle();assert(record.review.findings[0].color===PALETTE[0].color,'undo color change');$('redo').click();record=await settle();assert(record.review.findings[0].color===PALETTE[2].color,'redo color change');
    const beforeVisibility=canonical(record.review.findings);$('hide').checked=true;event('hide','change');
    assert(await alphaAt(record.review.findings[0],geometryDoc)===0&&await alphaAt(record.review.findings[1],geometryDoc)===0,'global visibility hides every finding');
    $('hide').checked=false;event('hide','change');assert(await alphaAt(record.review.findings[0],geometryDoc)>0&&await alphaAt(record.review.findings[1],geometryDoc)>0&&canonical((await saved()).review.findings)===beforeVisibility,'showing marks restores every finding without changing annotations');
    $('autoColor').checked=true;event('autoColor','change');$('newFinding').click();input('comment','automatic color example');await stroke(90,210);$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');$('newFinding').click();input('comment','next automatic color');await stroke(130,215);$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');record=await settle();
    assert(record.review.findings[2].color===PALETTE[3].color&&record.review.findings[3].color===PALETTE[4].color,'each new finding advances through the allowed palette');
    for(const finding of record.review.findings.slice(2)){rowFor(finding.id).click();await wait(()=>$('comment').dataset.findingId===finding.id,'select exact temporary finding');$('deleteFinding').click();$('confirmDelete').click();await settle();}
    $('autoColor').checked=false;event('autoColor','change');$('highlightColor').value=PALETTE[1].color;event('highlightColor','change');$('newFinding').click();input('comment','manual color example');await stroke(90,210);record=await settle();assert(record.review.findings[2].color===PALETTE[1].color,'manual default color used with cycling disabled');$('deleteFinding').click();$('confirmDelete').click();await settle();$('autoColor').checked=true;event('autoColor','change');await settle();
    rowFor(first.id).click();await wait(()=>$('comment').value===first.comment,'select first comment');input('comment','should be E♭ — edited; ♯ and 𝄞');$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');record=await settle();
    const stable=canonical(record.review.findings.map(f=>f.strokes));
    $('renderedZoom').value='2';event('renderedZoom','change');await wait(()=>$('renderedCanvas').style.width.replace('px','')>1000,'200% render');
    await markAligned(record,geometryDoc,'mark stays on expected PDF point at 200%');
    $('renderedZoom').value='0.75';event('renderedZoom','change');await new Promise(r=>setTimeout(r,500));record=await saved();assert(canonical(record.review.findings.map(f=>f.strokes))===stable,'zoom leaves PDF coordinates and widths unchanged');
    await markAligned(record,geometryDoc,'mark stays on expected PDF point at 75%');
    $('hide').checked=true;event('hide','change');const pixels=$('overlay').getContext('2d').getImageData(0,0,$('overlay').width,$('overlay').height).data;assert(!pixels.some((v,i)=>i%4===3&&v),'hide marks clears overlay');$('hide').checked=false;event('hide','change');
    rowFor(record.review.findings[1].id).click();await new Promise(r=>setTimeout(r,100));$('deleteFinding').click();$('confirmDelete').click();await settle();$('undo').click();record=await settle();assert(record.review.findings.length===2&&record.review.findings[0].comment.includes('edited'),'undo deletion preserves neighboring comment');$('redo').click();record=await settle();assert(record.review.findings.length===1,'redo deletion');$('undo').click();await settle();
    $('renderedPage').value='3';event('renderedPage','change');await new Promise(r=>setTimeout(r,300));assert($('sourcePage').value==='1'&&$('renderedPage').value==='3','page navigation does not align unrelated PDFs');
    $('renderedPage').value='1';event('renderedPage','change');$('renderedZoom').value='fit';event('renderedZoom','change');await settle();
    record=await saved();const beforeReload=canonical(record.review.findings),beforeDocument=frame.contentDocument,restoredSnapshot=record.review.snapshotId;frame.contentWindow.location.reload();await wait(()=>frame.contentDocument!==beforeDocument&&frame.contentDocument?.body?.dataset.ready==='true','reload document ready');await bridge();await reviewReady(review=>review?.snapshotId===restoredSnapshot,'reload restoration');record=await settle();assert(canonical(record.review.findings)===beforeReload,'reload restores exact comments and strokes');
    assert(record.review.preferences.autoColor&&$('autoColor').checked&&record.review.findings[0].color===PALETTE[2].color,'colors and automatic cycling preference survive reload');
    await markAligned(record,geometryDoc,'restored marks align after reload');
    frame.style.width='650px';await new Promise(r=>setTimeout(r,400));await markAligned(record,geometryDoc,'marks align after panel resize');frame.style.width='100%';await new Promise(r=>setTimeout(r,400));
    for(const r of ['source','rendered','ly'])assert(await sha256(await record.files[r].blob.arrayBuffer())===record.review.files[r].sha256,'restored exact '+r+' bytes');
    const matching=JSON.stringify(record.review),beforeImport=api().sessionStatus().revision;await choose('packageFile',new Blob([matching]),'annotations.json');await wait(()=>api().sessionStatus().revision>beforeImport&&!api().sessionStatus().busy,'JSON round-trip');assert((await settle()).review.findings.length===2,'matching JSON round-trip');
    const bad=clone(record.review);bad.snapshotId='0'.repeat(64);await choose('packageFile',new Blob([JSON.stringify(bad)]),'wrong-review.json');await wait(()=>$('message').textContent.includes('snapshot mismatch'),'mismatched import rejection');assert(canonical((await saved()).review.findings)===beforeReload,'mismatched JSON rejected without changing marks');
    const malformed=clone(record.review);malformed.findings[0].strokes[0].points[0]=[Infinity,1];let rejected=false;try{validateReview(malformed,record.review);}catch{rejected=true;}assert(rejected,'non-finite/out-of-bounds geometry rejected');
    const invalidColor=clone(record.review);invalidColor.findings[0].color='#000000';rejected=false;try{validateReview(invalidColor,record.review);}catch{rejected=true;}assert(rejected,'colors outside the readable palette are rejected');
    const legacy=clone(record.review);legacy.version=1;delete legacy.preferences;for(const f of legacy.findings){delete f.color;for(const s of f.strokes)s.color=PALETTE[0].color;}const migrated=validateReview(legacy,record.review);assert(migrated.version===VERSION&&migrated.findings.every(f=>f.color===PALETTE[0].color),'version 1 reviews migrate without losing geometry or comments');
    // Force a real IndexedDB put failure, then exercise the existing recovery affordance.
    const proto=frame.contentWindow.IDBObjectStore.prototype,put=proto.put;proto.put=function(){throw new frame.contentWindow.DOMException('Simulated quota exhaustion','QuotaExceededError');};
    $('newFinding').click();input('comment','temporary quota test');await wait(()=>$('storage').textContent.includes('NOT SAVED'),'storage failure UI');assert(!$('emergency').hidden,'storage failure exposes immediate recovery ZIP download');proto.put=put;$('deleteFinding').click();$('confirmDelete').click();await settle();
    // Create a rotated/cropped view of the existing PDF in memory, without encoding music.
    const rotated=await PDFLib.PDFDocument.load(await render.arrayBuffer());const p=rotated.getPages()[0],size=p.getSize();p.setCropBox(12,24,size.width-24,size.height-48);p.setRotation(PDFLib.degrees(90));
    const rotatedBlob=new Blob([await rotated.save()]),rotatedHash=await sha256(await rotatedBlob.arrayBuffer());await choose('sourceFile',source,'qa-source.pdf');await choose('lyFile',ly,'qa-score.ly');await choose('renderedFile',rotatedBlob,'qa-rotated-crop.pdf');$('load').click();await reviewReady(review=>review?.files.rendered.sha256===rotatedHash,'rotated snapshot');record=await settle();assert(record.review.findings.length===0,'new PDF bytes do not inherit old findings');assert(record.review.pages[0].rotation===90&&record.review.pages[0].view[0]===12,'rotation and nonzero crop offsets recorded');
    $('newFinding').click();input('comment','rotation / crop coordinate check');await stroke(100,90);$('saveFinding').click();await wait(()=>!$('comment').disabled,'finding completion');record=await settle();const f=record.review.findings[0],box=record.review.pages[0].view;assert(f.strokes[0].points.every(([x,y])=>x>=box[0]&&x<=box[2]&&y>=box[1]&&y<=box[3]),'rotated pointer positions invert into raw PDF crop bounds');
    // Reopen the earlier saved snapshot using the product control, then export it.
    const oldId=JSON.parse(matching).snapshotId;$('saved').value=oldId;$('reopen').click();await reviewReady(review=>review?.snapshotId===oldId,'old snapshot reopen');record=await settle();assert(record.review.findings.length===2&&canonical(record.review.findings)===beforeReload,'earlier snapshot remains available with original files');
    $('hide').checked=true;event('hide','change');api().completion.open();await wait(()=>$('finishDownloads').children.length&&!api().sessionStatus().busy,'full portable backup');
    const links=[...frame.contentDocument.querySelectorAll('#finishDownloads a')],zip=await frame.contentWindow.JSZip.loadAsync(await(await fetch(links[0].href)).blob());assert(links.length===1&&Boolean(zip.file('guidance/review-guide.txt')),'one backup ZIP includes the installed review guide');
    const get=async name=>{const file=zip.file(name);if(!file)throw new Error('Missing '+name);return new Blob([await file.async('uint8array')]);};
    const manifest=JSON.parse(await (await get('manifest.json')).text());for(const [path,expected]of Object.entries(manifest.payloads))assert(await sha256(await (await get(path)).arrayBuffer())===expected.sha256,'backup integrity: '+path);
    const report=await (await get('review.txt')).text();assert(report.includes('should be E♭ — edited; ♯ and 𝄞')&&report.includes('beam together'),'all Unicode comments readable as ordinary report text');
    const exported=JSON.parse(await (await get('annotations.json')).text());assert(exported.findings.length===2&&exported.findings[0].strokes.every(s=>s.color===PALETTE[2].color),'hidden view exports all findings with their chosen colors');
    for(const f of record.review.findings){const paths=manifest.context.filesByFinding[f.id];const clean=await createImageBitmap(await get(paths[1])),marked=await createImageBitmap(await get(paths[0]));assert(clean.width===marked.width&&clean.height===marked.height&&clean.width>1500,'clean and marked context dimensions match for #'+f.number);clean.close();marked.close();}
    log('\nALL CHECKS PASSED. Backup download is in the embedded actual interface.');
  }catch(e){log('FAIL '+e.stack);out.className='fail';console.error(e);}finally{document.getElementById('run').disabled=false;}
};
