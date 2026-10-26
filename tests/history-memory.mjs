// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Synthetic File System Access handles with staged writes and fault injection.
export class HistoryDirectory {
  kind='directory';
  constructor(control={writes:[],steps:0},path=''){this.control=control;this.path=path;this.children=new Map();}
  tick(){if(++this.control.steps===this.control.failAt)throw Error('SYNTHETIC interrupted');}
  async getDirectoryHandle(name,{create=false}={}){
    let entry=this.children.get(name);
    if(!entry&&create){entry=new HistoryDirectory(this.control,this.path+name+'/');this.children.set(name,entry);this.tick();}
    if(!entry)throw new DOMException('Missing','NotFoundError');
    if(entry.kind!=='directory')throw new DOMException('Not a directory','TypeMismatchError');return entry;
  }
  async getFileHandle(name,{create=false}={}){
    let entry=this.children.get(name);
    if(!entry&&create){
      entry={kind:'file',name,blob:new Blob(),getFile:async()=>entry.blob,
        createWritable:async()=>{let staged;return {
          write:async value=>{staged=value instanceof Blob?value:new Blob([value]);this.tick();},
          close:async()=>{await this.control.beforeClose?.(this.path+name,staged);entry.blob=staged;this.control.writes.push(this.path+name);this.tick();},
          abort:async()=>{}
        };}};
      this.children.set(name,entry);this.tick();
    }
    if(!entry)throw new DOMException('Missing','NotFoundError');
    if(entry.kind!=='file')throw new DOMException('Not a file','TypeMismatchError');return entry;
  }
  async *entries(){yield* this.children;}
  async removeEntry(name){this.children.delete(name);}
}
export async function put(root,path,blob){const parts=path.split('/');for(const p of parts.slice(0,-1))root=await root.getDirectoryHandle(p,{create:true});const file=await root.getFileHandle(parts.at(-1),{create:true});file.blob=blob;}
export async function get(root,path){const parts=path.split('/');for(const p of parts.slice(0,-1))root=await root.getDirectoryHandle(p);return(await root.getFileHandle(parts.at(-1))).getFile();}
