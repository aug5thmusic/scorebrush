// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
export async function menuCommand(page,group,id){
  if(await page.evaluate(()=>Boolean(window.scoreBrushDesktop))){await page.evaluate(async id=>(await import('./app.js')).applicationShell.execute(id,{fromNative:true}),id);return;}
  await page.locator('#appMenu'+group).click();
  await page.locator('#menu'+group+' [data-command="'+id+'"]').click();
}
