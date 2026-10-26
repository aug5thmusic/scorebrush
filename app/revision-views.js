// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
import {candidateIdentity,savedLocation,bookmark} from './comparison-model.js';

// Disposable UI preferences, separate from review records and their immutable
// history. Both workspace and exact candidate identity scope every position.
const memory=new Map(),prefix='scorebrush-revision-view-v1:';
function key(scene,id){return prefix+JSON.stringify([scene.workspaceId,candidateIdentity(scene.review),id]);}
export function readRevisionView(scene,id){
  const name=key(scene,id);let value=memory.get(name);
  if(!value)try{const text=localStorage.getItem(name);if(text&&text.length<4096)value=JSON.parse(text);}catch{}
  return savedLocation(value,id,scene.review)?.position??null;
}
export function rememberRevisionView(scene,id,position){
  if(!position)return false;
  let location;try{location=bookmark(id,scene.review,position);}catch{return false;}
  const name=key(scene,id),text=JSON.stringify(location);memory.set(name,location);
  try{if(localStorage.getItem(name)!==text)localStorage.setItem(name,text);return true;}catch{return false;}
}
