// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {pdfResourceUrls} from './pdf-resources.js';

// Full OS paths are supplied by the user, never inferred from a browser handle.
export function fullDirectoryPath(value){
  let path=String(value??'').trim();
  if(path.startsWith('"')&&path.endsWith('"'))path=path.slice(1,-1);
  if(!path||path.length>4096||/[\x00-\x1f\x7f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(path)||!(/^[A-Za-z]:[\\/]/.test(path)||/^\\\\[^\\/]+[\\/][^\\/]+/.test(path)||/^\/(?!\/)/.test(path)))throw new Error('Enter the full folder path, such as C:\\Music\\My score. A folder name alone is not a path.');
  const clean=path.replace(/[\\/]+$/,'');return /^[A-Za-z]:$/.test(clean)?clean+'\\':clean||'/';
}
export function fileLocation(directory,path){
  const root=fullDirectoryPath(directory),separator=/^[A-Za-z]:|^\\\\/.test(root)?'\\':'/';
  return root.replace(/[\\/]+$/,'')+separator+path.split('/').join(separator);
}
const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
export function installFolderFiles({getConfig,scan,read}){
  const dialog=element('dialog');dialog.id='folderFilesDialog';dialog.setAttribute('aria-labelledby','folderFilesTitle');
  const heading=element('div');heading.className='dialog-head';const title=element('h2','Files in working folder');title.id='folderFilesTitle';const close=element('button','Close');close.id='closeFolderFiles';close.onclick=()=>dialog.close();heading.append(title,close);
  const location=element('p'),status=element('p'),list=element('div'),preview=element('section');location.id='folderFilesLocation';status.id='folderFilesStatus';status.setAttribute('role','status');list.id='folderFilesList';preview.id='folderFilePreview';preview.hidden=true;
  const previewTitle=element('h3'),text=element('textarea'),pdf=element('div'),download=element('a');text.readOnly=true;text.rows=14;text.setAttribute('aria-label','LilyPond file preview');
  const nav=element('div'),prev=element('button','Previous page'),pageLabel=element('span'),next=element('button','Next page'),paper=element('div'),canvas=element('canvas');nav.className='folder-preview-nav';pageLabel.id='folderPreviewPage';canvas.id='folderPdfCanvas';canvas.setAttribute('aria-label','PDF file preview');paper.style.cssText='max-height:55vh;overflow:auto';paper.append(canvas);nav.append(prev,pageLabel,next);pdf.append(nav,paper);
  download.textContent='Download a copy';preview.append(previewTitle,text,pdf,download);
  dialog.append(heading,location,status,list,preview);document.body.append(dialog);let serial=0,urls=[],pdfDoc=null,renderTask=null,previewPage=1,rendering=false;
  function disposePdf(){rendering=false;delete canvas.dataset.renderedPage;renderTask?.cancel();renderTask=null;const old=pdfDoc;pdfDoc=null;if(old)void old.destroy().catch(()=>{});canvas.width=0;canvas.height=0;}
  function clear(){serial++;for(const url of urls)URL.revokeObjectURL(url);urls=[];disposePdf();text.value='';preview.hidden=true;}
  async function renderPage(number){
    if(!pdfDoc||rendering)return;const request=serial,doc=pdfDoc;previewPage=Math.max(1,Math.min(doc.numPages,number));rendering=true;prev.disabled=next.disabled=true;
    try{const page=await doc.getPage(previewPage);if(request!==serial||pdfDoc!==doc)return;const natural=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.min(2,(preview.clientWidth-4)/natural.width)}),dpr=Math.min(devicePixelRatio||1,2);
      canvas.width=Math.ceil(viewport.width*dpr);canvas.height=Math.ceil(viewport.height*dpr);canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';renderTask=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:dpr===1?null:[dpr,0,0,dpr,0,0]});await renderTask.promise;
      if(request===serial){pageLabel.textContent=`Page ${previewPage} of ${doc.numPages}`;canvas.dataset.renderedPage=String(previewPage);paper.scrollTop=0;return true;}
    }catch(e){if(request===serial&&e.name!=='RenderingCancelledException')status.textContent='Could not preview PDF: '+e.message;}
    finally{if(request===serial&&pdfDoc===doc){rendering=false;prev.disabled=previewPage<=1;next.disabled=previewPage>=doc.numPages;}}
  }
  prev.onclick=()=>renderPage(previewPage-1);next.onclick=()=>renderPage(previewPage+1);
  dialog.addEventListener('close',clear);
  async function show(){
    clear();const token=serial,config=getConfig();list.replaceChildren();status.textContent='Reading folder…';location.textContent=config?.absolutePath||config?.directory.name||'No working folder connected.';
    if(!dialog.open)dialog.showModal();
    if(!config){status.textContent='Choose a working folder first.';return;}
    const valid=()=>serial===token&&getConfig()?.connectionId===config.connectionId&&dialog.open;
    try{
      const paths=await scan(config.directory);if(!valid())return;
      const chosen=new Map(Object.entries(config.paths).map(([role,path])=>[path,{source:'Source PDF',rendered:'Current rendered PDF',ly:'Current LilyPond'}[role]]));
      paths.sort((a,b)=>Number(chosen.has(b))-Number(chosen.has(a))||a.localeCompare(b));status.textContent=`${paths.length} LY/PDF files. These are the current files in your connected folder.`;
      for(const path of paths){
        const row=element('div');row.className='folder-file-row';row.dataset.filePath=path;
        const open=element('button',path),label=element('small',chosen.get(path)||'');open.className='folder-file-open';open.setAttribute('aria-label','Open '+path);row.append(open,label);
        const copy=element('button','Copy full path');copy.disabled=!config.absolutePath;copy.title=config.absolutePath?'Copy the file location':'Enter the full folder path in AI prompt first';row.append(copy);
        copy.onclick=async()=>{try{await navigator.clipboard.writeText(fileLocation(config.absolutePath,path));status.textContent='Full file path copied.';}catch(e){status.textContent=e.message||'Copy unavailable.';}};
        open.onclick=async()=>{
          const request=++serial;disposePdf();status.textContent='Opening '+path+'…';
          try{const file=await read(config.directory,path);if(request!==serial||!dialog.open)return;
            for(const url of urls)URL.revokeObjectURL(url);urls=[];
            const isPdf=/\.pdf$/i.test(path),blob=new Blob([await file.arrayBuffer()],{type:isPdf?'application/pdf':'text/plain;charset=utf-8'});
            if(request!==serial||!dialog.open)return;const url=URL.createObjectURL(blob);urls.push(url);download.href=url;download.download=path.split('/').at(-1);previewTitle.textContent=path;pdf.hidden=!isPdf;text.hidden=isPdf;preview.hidden=false;
            if(isPdf){const pdfjs=await import('./vendor/pdf.mjs');const doc=await pdfjs.getDocument({data:new Uint8Array(await blob.arrayBuffer()),...pdfResourceUrls,cMapPacked:true,isEvalSupported:false,enableXfa:false}).promise;if(request!==serial||!dialog.open){await doc.destroy();return;}pdfDoc=doc;if(!await renderPage(1))return;}else text.value=await blob.text();
            if(request===serial)status.textContent='Viewing '+path+'. Your working file is unchanged.';
          }catch(e){if(request===serial)status.textContent='Could not open file: '+e.message;}
        };
        list.append(row);
      }
    }catch(e){if(valid())status.textContent='Could not read folder: '+e.message+'. Reconnect the working folder if permission has expired.';}
  }
  return {show};
}
