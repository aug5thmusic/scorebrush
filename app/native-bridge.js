// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Correlated, bounded requests to the trusted native host; no HTTP transport.
export function nativeRequest(op,fields={}){
  const bridge=globalThis.chrome?.webview;
  if(!bridge)throw new Error('This action requires the ScoreBrush desktop application.');
  if(!['folder-challenge','folder-open','folder-versions','folder-latest','folder-verify','folder-select','folder-resume','folder-confirm','folder-release','open-source'].includes(op))throw new Error('Unsupported native action.');
  const external=op==='open-source';
  if(external&&Object.keys(fields).length)throw new Error('The external link accepts no additional fields.');
  const id=crypto.randomUUID().replaceAll('-','');
  return new Promise((resolve,reject)=>{
    const finish=()=>{clearTimeout(timeout);bridge.removeEventListener('message',receive);};
    const receive=event=>{
      const m=event.data;
      if(!m||m.op!==(external?'external-result':'folder-result')||m.id!==id)return;
      finish();
      if(typeof m.error==='string')reject(new Error(m.error));
      else if(m.value&&typeof m.value==='object'){
        if(['folder-select','folder-resume'].includes(op)&&!m.value.cancelled){
          const directory=event.additionalObjects?.[0];
          if(event.additionalObjects?.length!==1||directory?.kind!=='directory'){reject(new Error('Windows did not provide a directory handle. Update WebView2 and restart ScoreBrush.'));return;}
          resolve({...m.value,directory});
        }else resolve(m.value);
      }
      else reject(new Error('Windows did not return a valid response.'));
    };
    const timeout=setTimeout(()=>{finish();reject(new Error(external?'Opening the link timed out. Try again.':'Folder verification timed out. Try opening the folder again.'));},external?10000:180000);
    bridge.addEventListener('message',receive);
    try{bridge.postMessage({op,id,...fields});}catch(error){finish();reject(error);}
  });
}
