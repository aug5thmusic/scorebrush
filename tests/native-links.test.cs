// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Verify URL allowlists without opening a browser or touching a user profile.
using System;
using System.Collections.Generic;

static class NativeLinksTest {
    static void Check(bool value){if(!value)throw new Exception("Native link schema check failed");}
    static Dictionary<string,object> Request(string op){return new Dictionary<string,object>{{"op",op},{"id",new string('a',32)}};}
    static void Main(){
        Check(NativeRepositoryLink.Address=="https://github.com/aug5thmusic/scorebrush");
        Check(NativeRepositoryLink.IsRequest(Request("open-source")));
        Check(!NativeRepositoryLink.IsRequest(Request("open-unknown")));
        foreach(string op in new[]{"open-source","open-url","file:///C:/Windows"}){
            var r=Request(op);r["url"]="https://attacker.invalid";
            Check(!NativeRepositoryLink.IsRequest(r));
            try{NativeRepositoryLink.Open(r);throw new Exception("Invalid request reached OS dispatch");}catch(ArgumentException){}
        }
        foreach(object id in new object[]{null,1,new string('a',32)+"\n",new string('A',32),new string('a',31)}){
            var r=Request("open-source");r["id"]=id;Check(!NativeRepositoryLink.IsRequest(r));
        }
        Check(!NativeRepositoryLink.IsRequest(null));
        Console.WriteLine("PASS native repository allowlist, unsupported actions, exact schemas and malformed requests; no OS dispatch");
    }
}
