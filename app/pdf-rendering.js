// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Display-only limits: PDF coordinates, original bytes and saved annotations
// remain unchanged. PDF and annotation canvases must share the returned plan.
export const PDF_DISPLAY_LIMITS=Object.freeze({dimension:32768,canvasDimension:8192,canvasPixels:16000000});
function dimensions(natural){
  const {width,height}=natural??{};
  if(!Number.isFinite(width)||width<=0||!Number.isFinite(height)||height<=0)throw new Error('This PDF page has invalid dimensions.');
  return {width,height};
}
export function pdfDisplayScale(natural,zoom,availableWidth){
  const {width,height}=dimensions(natural);
  const requested=zoom==='fit'?Math.max(1,Number.isFinite(availableWidth)?availableWidth:1)/width:Number(zoom);
  if(!Number.isFinite(requested)||requested<=0)throw new Error('This PDF page has an invalid display scale.');
  return Math.min(requested,PDF_DISPLAY_LIMITS.dimension/width,PDF_DISPLAY_LIMITS.dimension/height);
}
export function pdfRenderPlan(natural,{zoom='fit',availableWidth,devicePixelRatio=1,maxDpr=3}={}){
  const {width,height}=dimensions(natural),scale=pdfDisplayScale(natural,zoom,availableWidth),displayWidth=width*scale,displayHeight=height*scale;
  const wantedDpr=Number.isFinite(devicePixelRatio)&&devicePixelRatio>0?devicePixelRatio:1;
  const desiredRatio=Math.min(wantedDpr,Number.isFinite(maxDpr)&&maxDpr>0?maxDpr:3);
  const size=ratio=>({width:Math.max(1,Math.ceil(displayWidth*ratio)),height:Math.max(1,Math.ceil(displayHeight*ratio))});
  const fits=({width,height})=>width<=PDF_DISPLAY_LIMITS.canvasDimension&&height<=PDF_DISPLAY_LIMITS.canvasDimension&&width*height<=PDF_DISPLAY_LIMITS.canvasPixels;
  let pixelRatio=Math.min(desiredRatio,PDF_DISPLAY_LIMITS.canvasDimension/displayWidth,PDF_DISPLAY_LIMITS.canvasDimension/displayHeight,Math.sqrt(PDF_DISPLAY_LIMITS.canvasPixels/(displayWidth*displayHeight)));
  // Integer allocation rounds upward. Include that rounding in the limit,
  // including unusually thin pages where a dimension is only one pixel.
  if(!fits(size(pixelRatio))){let low=0,high=pixelRatio;for(let i=0;i<40;i++){const mid=(low+high)/2;if(fits(size(mid)))low=mid;else high=mid;}pixelRatio=low;}
  const pixels=size(pixelRatio),requested=zoom==='fit'?Math.max(1,Number.isFinite(availableWidth)?availableWidth:1)/width:Number(zoom);
  return {scale,pixelRatio,canvasWidth:pixels.width,canvasHeight:pixels.height,scaleLimited:scale<requested,resolutionLimited:pixelRatio<desiredRatio};
}
export function sizePdfCanvas(canvas,{canvasWidth,canvasHeight}){
  if(!Number.isInteger(canvasWidth)||canvasWidth<1||canvasWidth>PDF_DISPLAY_LIMITS.canvasDimension||!Number.isInteger(canvasHeight)||canvasHeight<1||canvasHeight>PDF_DISPLAY_LIMITS.canvasDimension||canvasWidth*canvasHeight>PDF_DISPLAY_LIMITS.canvasPixels)throw new Error('This PDF page exceeds the display canvas limit.');
  // Changing width first while a previous tall page still owns its height can
  // allocate an oversized intermediate bitmap. Release it before either size.
  canvas.width=0;canvas.height=canvasHeight;canvas.width=canvasWidth;
}
