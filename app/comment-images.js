// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import * as pdfjs from './vendor/pdf.mjs';
import {pdfResourceUrls} from './pdf-resources.js';
import {sha256,paint} from './model.js';

// A read-only fallback when a retained marked PNG is missing. No current PDF,
// estimate or current association is accepted as an original comment image.
export async function renderCommentImage({asset,mark}) {
  if(!asset||!mark?.strokes.length)return null;
  if(await sha256(await asset.blob.arrayBuffer())!==asset.sha256)throw new Error('Original comment rendering does not match.');
  const doc=await pdfjs.getDocument({data:new Uint8Array(await asset.blob.arrayBuffer()),...pdfResourceUrls,cMapPacked:true,isEvalSupported:false,enableXfa:false}).promise;
  const canvas=document.createElement('canvas');
  try {
    const page=await doc.getPage(mark.page),geometry=asset.pages[mark.page-1];
    if(!geometry||geometry.rotation!==page.rotate||geometry.userUnit!==page.userUnit||geometry.view.some((n,i)=>n!==page.view[i]))throw new Error('Original comment page geometry does not match.');
    const natural=page.getViewport({scale:1}),scale=Math.min(2,1600/Math.max(natural.width,natural.height)),viewport=page.getViewport({scale});
    canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    const ctx=canvas.getContext('2d');await page.render({canvasContext:ctx,viewport,background:'#ffffff'}).promise;
    paint(ctx,viewport,[mark],mark.page);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Original comment image could not be displayed.')),'image/png'));
  } finally {canvas.width=canvas.height=1;await doc.destroy();}
}
