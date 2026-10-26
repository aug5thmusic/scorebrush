// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Initial read-only screens do not need to create empty persistent databases.
// This is an uncached inventory snapshot, never proof about existing content.
// If discovery cannot establish absence, callers use their ordinary open/read
// path so permission, version, corruption and blocked-upgrade errors survive.
export async function databaseMayExist(name,factory=globalThis.indexedDB){
  try{
    if(typeof factory?.databases!=='function')return true;
    const entries=await factory.databases();
    if(!Array.isArray(entries)||entries.some(entry=>!entry||typeof entry.name!=='string'))return true;
    return entries.some(entry=>entry.name===name);
  }catch{return true;}
}
