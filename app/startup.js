// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Loaded before app modules, so module/asset failures leave an actionable screen.
(() => {
  let complete=false;
  const panel=document.getElementById('startupScreen');
  // A parsed document is not yet a displayed frame. Keep the native splash
  // covering WebView2 until the HTML loading screen has had a paint opportunity.
  // This handshake does not enable commands or bypass the normal ready signal.
  const announcePaint=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>window.chrome?.webview?.postMessage({op:'startup-painted'})));
  announcePaint();window.addEventListener('scorebrush-desktop-host',announcePaint);
  const native=window.scoreBrushNativeStartup;
  if(native?.version===1&&Number.isFinite(native.pixelScale)&&native.pixelScale>=.5&&native.pixelScale<=4){
    const scale=()=>panel.style.setProperty('--startup-scale',String(native.pixelScale/(window.devicePixelRatio||1)));
    scale();window.addEventListener('resize',scale);
  }
  const failure=message=>{
    if(complete)return;
    // A modal Welcome screen must not cover the startup error or recovery action.
    const welcome=document.getElementById('workspaceDialog');
    if(welcome?.open&&welcome.dataset.page==='welcome')welcome.close();
    panel.dataset.state='error';
    document.getElementById('startupStatus').textContent='ScoreBrush could not finish starting.';
    document.getElementById('startupError').textContent=String(message||'A required application file could not load.');
    document.getElementById('startupRecovery').hidden=false;
  };
  const metadata=import('./build-info.js').then(async({validateBuildInfo})=>{
    const response=await fetch('./build-info.json');
    if(!response.ok)throw new Error('Build information is missing. Extract the complete review ZIP and reopen ScoreBrush.');
    const raw=await response.json().catch(()=>{throw new Error('Invalid build information: unreadable JSON. Extract the complete review ZIP.');});
    return validateBuildInfo(raw);
  }).then(info=>{
    for(const el of document.querySelectorAll('[data-build-info]'))el.textContent=`Version ${info.version} (${info.buildDate})`;
    return Object.freeze(info);
  });
  metadata.catch(failure);
  window.addEventListener('error',event=>{if(event.target?.tagName==='SCRIPT')failure('An application script could not load. Extract the complete ZIP, then reopen ScoreBrush.');else if(event.message)failure(event.message);},true);
  window.addEventListener('unhandledrejection',event=>failure(event.reason?.message));
  document.getElementById('startupRecovery').onclick=()=>{
    // Only the initialized app enables recovery; this never reloads a live review.
    if(document.body.dataset.ready==='true'){panel.hidden=true;document.getElementById('workspaceTools').click();}
  };
  window.scoreBrushStartup=Object.freeze({metadata,async finish(error){
    try{await metadata;}catch(e){error??=e;}
    if(error){failure(error.message);document.getElementById('startupRecovery').disabled=false;}
    else{complete=true;panel.hidden=true;}
  }});
})();
