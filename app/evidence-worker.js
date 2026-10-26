// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// CPU-heavy PNG decoding and PDF assembly stay off the editor's UI thread.
importScripts('./vendor/pdf-lib.min.js');
self.onmessage=async({data:{pages,index,base}})=>{
  try{
    const pdf=base?await PDFLib.PDFDocument.load(base):await PDFLib.PDFDocument.create();
    const add=async({blob,width,height})=>{const image=await pdf.embedPng(await blob.arrayBuffer());pdf.addPage([width,height]).drawImage(image,{x:0,y:0,width,height});};
    if(!base){for(const page of pages)await add(page);base=await pdf.save();}
    for(const page of index)await add(page);
    const full=await pdf.save();self.postMessage({base,pdf:full},[base.buffer??base,full.buffer]);
  }catch(error){self.postMessage({error:error.message});}
};
