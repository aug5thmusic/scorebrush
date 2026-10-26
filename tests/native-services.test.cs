// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
static class NativeServicesTests {
 static int checks;
 static void Check(bool ok,string label){if(!ok)throw new Exception(label);checks++;Console.WriteLine("PASS "+label);}
 static MethodInfo verify=typeof(NativeFolders).GetMethod("Verify",BindingFlags.NonPublic|BindingFlags.Static);
 static void Reject(string path,string marker,string proof){try{using((IDisposable)verify.Invoke(null,new object[]{path,marker,proof,".score-desk"})){}throw new Exception("Accepted invalid proof/path: "+path);}catch(TargetInvocationException e){Check(e.InnerException is IOException||e.InnerException is ArgumentException,"reject invalid path/proof");}}
 static byte[] Protect(byte[] value){return ProtectedData.Protect(value,Encoding.UTF8.GetBytes("ScoreBrush selected folders v1"),DataProtectionScope.CurrentUser);}
 static Dictionary<string,object> SelectProof(NativeFolders host,string path,bool write){
  var json=new JavaScriptSerializer();Dictionary<string,object> selected=null;
  Action<object,string> receive=(value,actual)=>{Check(actual==path,"fresh selection keeps the exact verified directory");selected=json.Deserialize<Dictionary<string,object>>(json.Serialize(value));};
  typeof(NativeFolders).GetMethod("Grant",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(host,new object[]{path,null,receive});
  if(write)File.WriteAllText(Path.Combine(path,(string)selected["marker"]),"private-score-desk-open-v1\n"+selected["proof"]);
  selected.Remove("path");selected["op"]="folder-confirm";selected["id"]=new string('a',32);return selected;
 }
 static void SelectedReplacement(string root){
  string profile=Path.Combine(root,"replacement-profile"),path=Path.Combine(root,"replacement-selected"),moved=path+"-original";
  Directory.CreateDirectory(profile);Directory.CreateDirectory(path);string registry=Path.Combine(profile,"scorebrush-folder-grants.dat"),binding=null;
  using(var host=new NativeFolders(profile)){
   var confirm=SelectProof(host,path,false);bool replaced=false;
   try{Directory.Move(path,moved);Directory.CreateDirectory(path);replaced=true;}catch(IOException){}
   File.WriteAllText(Path.Combine(path,(string)confirm["marker"]),"private-score-desk-open-v1\n"+confirm["proof"]);
   if(replaced){
    bool rejected=false;try{host.Confirm(confirm);}catch(IOException){rejected=true;}catch(ArgumentException){rejected=true;}
    Check(rejected&&!File.Exists(registry),"replaced selected leaf is rejected before a stale binding is stored");
   }else{
    Check(Directory.Exists(path)&&!Directory.Exists(moved)&&!File.Exists(registry),"selected leaf replacement is prevented before proof confirmation");
    var result=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(new JavaScriptSerializer().Serialize(host.Confirm(confirm)));binding=(string)result["binding"];
    Check(File.Exists(registry),"prevented replacement leaves the valid selected proof usable");
   }
   try{host.Confirm(confirm);throw new Exception("Replacement-attempt proof replay accepted");}catch(ArgumentException){Check(true,"replacement attempt cannot make its selected proof replayable");}
  }
  if(binding!=null)using(var host=new NativeFolders(profile)){
   bool delivered=false;host.Resume(binding,(value,actual)=>{delivered=actual==path;});Check(delivered,"selection protected from replacement survives native restart");
   bool renamed=false;try{Directory.Move(path,moved);renamed=true;}catch(IOException){}
   Check(!renamed,"resumed selected leaf remains held until its new proof is completed");
  }
 }
 static void DamagedRegistry(string profile,string path,byte[] damaged,byte[] backup,string oldBinding){
  Directory.CreateDirectory(profile);string registry=Path.Combine(profile,"scorebrush-folder-grants.dat");File.WriteAllBytes(registry,damaged);File.WriteAllBytes(registry+".bak",backup);
  var json=new JavaScriptSerializer();string newBinding;
  using(var host=new NativeFolders(profile)){
   bool delivered=false;
   try{host.Resume(oldBinding,(value,actual)=>{delivered=true;});throw new Exception("Damaged registry granted access");}catch(IOException e){Check(e.Message.Contains("Select this working folder once"),"damaged registry requests a fresh selection without exposing a decryption/parser error");}
   Check(!delivered&&!File.Exists(registry),"old binding and backup cannot silently restore a damaged grant");
   string[] invalid=Directory.GetFiles(profile,"scorebrush-folder-grants.dat.*.invalid");
   Check(invalid.Length==1&&Convert.ToBase64String(File.ReadAllBytes(invalid[0]))==Convert.ToBase64String(damaged),"all damaged registry bytes are preserved in one separate file");
   Check(Convert.ToBase64String(File.ReadAllBytes(registry+".bak"))==Convert.ToBase64String(backup),"existing grant backup remains untouched");
   var missing=SelectProof(host,path,false);try{host.Confirm(missing);throw new Exception("Selection without proof acquired a grant");}catch(IOException){Check(!File.Exists(registry),"empty recovered registry still requires the new on-disk one-use proof");}
   var confirm=SelectProof(host,path,true);var granted=json.Deserialize<Dictionary<string,object>>(json.Serialize(host.Confirm(confirm)));newBinding=(string)granted["binding"];
   Check(newBinding!=oldBinding&&File.Exists(registry),"fresh proof writes a new protected binding after recovery");
   try{host.Confirm(confirm);throw new Exception("Fresh proof replay accepted");}catch(ArgumentException){Check(true,"recovered grant proof cannot be replayed");}
   try{host.Resume(oldBinding,(value,actual)=>{});throw new Exception("Old binding survived recovery");}catch(IOException){Check(true,"invalidated old binding remains unavailable after reconnecting");}
  }
  using(var host=new NativeFolders(profile)){bool delivered=false;host.Resume(newBinding,(value,actual)=>{delivered=actual==path;});Check(delivered,"new encrypted binding survives another host restart");}
 }
 static void Main(string[] args){
  var link=new Dictionary<string,object>{{"op","open-source"},{"id",new string('a',32)}};
  Check(NativeRepositoryLink.IsRequest(link)&&NativeRepositoryLink.Address=="https://github.com/aug5thmusic/scorebrush","repository action accepts only the fixed repository destination");
  foreach(var invalid in new[]{
   new Dictionary<string,object>{{"op","open-source"},{"id",new string('a',32)},{"url","file:///C:/Windows"}},
   new Dictionary<string,object>{{"op","open-url"},{"id",new string('a',32)}},
   new Dictionary<string,object>{{"op","open-source"},{"id",new string('a',32)+"\n"}},
   new Dictionary<string,object>{{"op","open-source"},{"id",1}}
  }){try{NativeRepositoryLink.Open(invalid);throw new Exception("Expanded repository action accepted");}catch(ArgumentException){Check(true,"repository action rejects extra fields, other commands and malformed IDs before OS dispatch");}}
  string root=Path.GetFullPath(args[0]),marker="native-open-"+new string('b',32)+".txt",proof=new string('c',64);
  SelectedReplacement(root);
  Directory.CreateDirectory(Path.Combine(root,".score-desk"));string file=Path.Combine(root,".score-desk",marker);File.WriteAllText(file,"private-score-desk-open-v1\n"+proof);
  using((IDisposable)verify.Invoke(null,new object[]{root,marker,proof,".score-desk"})){
   Check(true,"selected local folder and exact proof accepted");
   try{Directory.Move(Path.Combine(root,".score-desk"),Path.Combine(root,"replaced"));throw new Exception("Directory replacement was not locked");}catch(IOException){Check(true,"verified directory cannot be replaced during Explorer dispatch");}
  }
  var holdVersions=typeof(NativeFolders).GetMethod("HoldVersions",BindingFlags.NonPublic|BindingFlags.Static);
  Directory.CreateDirectory(Path.Combine(root,"Versions"));
  using(var held=(IDisposable)verify.Invoke(null,new object[]{root,marker,proof,".score-desk"})){
   Check((string)holdVersions.Invoke(null,new object[]{held})==Path.Combine(root,"Versions"),"Versions destination is the fixed child of the proven root");
   try{Directory.Move(Path.Combine(root,"Versions"),Path.Combine(root,"Versions-moved"));throw new Exception("Versions replacement allowed");}catch(IOException){Check(true,"Versions child cannot be redirected during Explorer dispatch");}
  }
  Directory.Move(Path.Combine(root,"Versions"),Path.Combine(root,"Versions-moved"));
  using(var held=(IDisposable)verify.Invoke(null,new object[]{root,marker,proof,".score-desk"})){
   try{holdVersions.Invoke(null,new object[]{held});throw new Exception("Missing Versions accepted");}catch(TargetInvocationException e){Check(e.InnerException is IOException,"missing Versions gives a failure without a picker");}
  }
  var holdLatest=typeof(NativeFolders).GetMethod("HoldLatest",BindingFlags.NonPublic|BindingFlags.Static);
  Directory.CreateDirectory(Path.Combine(root,"Latest"));
  using(var held=(IDisposable)verify.Invoke(null,new object[]{root,marker,proof,".score-desk"})){
   Check((string)holdLatest.Invoke(null,new object[]{held})==Path.Combine(root,"Latest"),"Latest destination is the fixed child of the proven root");
   try{Directory.Move(Path.Combine(root,"Latest"),Path.Combine(root,"Latest-moved"));throw new Exception("Latest replacement allowed");}catch(IOException){Check(true,"Latest child cannot be redirected during Explorer dispatch");}
  }
  Directory.Move(Path.Combine(root,"Latest"),Path.Combine(root,"Latest-moved"));
  using(var held=(IDisposable)verify.Invoke(null,new object[]{root,marker,proof,".score-desk"})){
   try{holdLatest.Invoke(null,new object[]{held});throw new Exception("Missing Latest accepted");}catch(TargetInvocationException e){Check(e.InnerException is IOException,"missing Latest gives a failure without a picker");}
  }
  string redirected=Path.Combine(root,"redirect-project");
  if(Directory.Exists(redirected)){
   Directory.CreateDirectory(Path.Combine(redirected,".score-desk"));File.WriteAllText(Path.Combine(redirected,".score-desk",marker),"private-score-desk-open-v1\n"+proof);
   using(var held=(IDisposable)verify.Invoke(null,new object[]{redirected,marker,proof,".score-desk"})){
    try{holdVersions.Invoke(null,new object[]{held});throw new Exception("Redirected Versions accepted");}catch(TargetInvocationException e){Check(e.InnerException is IOException,"Versions junction is refused before Explorer dispatch");}
   }
  }
  if(Directory.Exists(Path.Combine(redirected,"Latest"))){
   using(var held=(IDisposable)verify.Invoke(null,new object[]{redirected,marker,proof,".score-desk"})){
    try{holdLatest.Invoke(null,new object[]{held});throw new Exception("Redirected Latest accepted");}catch(TargetInvocationException e){Check(e.InnerException is IOException,"Latest junction is refused before Explorer dispatch");}
   }
  }
  foreach(string path in new[]{"relative",@"\\server\share",@"\\?\C:\test",root+@"\..\other",root+@"\trailing.",root+":stream",root+"\n"})Reject(path,marker,proof);
  Reject(root,marker,new string('d',64));Reject(root,"missing.txt",proof);
  if(Directory.Exists(Path.Combine(root,"redirect")))Reject(Path.Combine(root,"redirect"),marker,proof);
  var folders=new NativeFolders();var json=new JavaScriptSerializer();var challenge=json.Deserialize<Dictionary<string,object>>(json.Serialize(folders.Challenge()));
  var request=new Dictionary<string,object>(challenge);request["op"]="folder-open";request["id"]=new string('a',32);request["path"]=root;request["name"]="Synthetic";
  request["proof"]=new string('d',64);try{folders.Open(request,null);throw new Exception("Accepted fake proof");}catch(ArgumentException){Check(true,"host challenge rejects substituted proof before any picker");}
  request["proof"]=challenge["proof"];typeof(NativeFolders).GetField("expires",BindingFlags.Instance|BindingFlags.NonPublic).SetValue(folders,DateTime.UtcNow.AddSeconds(-1));
  try{folders.Open(request,null);throw new Exception("Accepted expired proof");}catch(ArgumentException){Check(true,"expired host challenge is refused");}
  request["extra"]="shell";try{folders.Open(request,null);throw new Exception("Accepted expanded schema");}catch(ArgumentException){Check(true,"additional bridge fields are refused");}
  string profile=Path.Combine(root,"test-profile"),chosen=Path.Combine(root,"chosen");Directory.CreateDirectory(profile);Directory.CreateDirectory(chosen);
  var grant=typeof(NativeFolders).GetMethod("Grant",BindingFlags.NonPublic|BindingFlags.Instance);Dictionary<string,object> selected=null;
  Action<object,string> receive=(value,path)=>{selected=json.Deserialize<Dictionary<string,object>>(json.Serialize(value));Check(path==chosen||path==chosen+"-moved","native grant uses the verified selected path");};
  string binding;
  using(var connected=new NativeFolders(profile)){
   grant.Invoke(connected,new object[]{chosen,null,receive});
   string selectedMarker=(string)selected["marker"];File.WriteAllText(Path.Combine(chosen,selectedMarker),"private-score-desk-open-v1\n"+selected["proof"]);
   var confirm=new Dictionary<string,object>(selected);confirm.Remove("path");confirm["op"]="folder-confirm";confirm["id"]=new string('a',32);
   var result=json.Deserialize<Dictionary<string,object>>(json.Serialize(connected.Confirm(confirm)));binding=(string)result["binding"];
   Check((string)result["path"]==chosen,"one-use selected proof establishes an opaque binding");
   try{connected.Confirm(confirm);throw new Exception("Replayed proof accepted");}catch(ArgumentException){Check(true,"selected proof cannot be replayed");}
   File.Delete(Path.Combine(chosen,selectedMarker));
  }
  using(var reopened=new NativeFolders(profile)){
   reopened.Resume(binding,receive);Check(true,"protected native binding survives host restart");reopened.Release();
   try{reopened.Resume(new string('f',32),receive);throw new Exception("Unknown binding accepted");}catch(IOException){Check(true,"unknown binding cannot grant arbitrary access");}
   Directory.Move(chosen,chosen+"-moved");
   try{reopened.Resume(binding,receive);throw new Exception("Missing folder accepted");}catch(IOException){Check(true,"missing folder is refused without a picker");}
   Directory.CreateDirectory(chosen);
   try{reopened.Resume(binding,receive);throw new Exception("Replacement folder accepted");}catch(IOException){Check(true,"different directory at the old path is refused before granting access");}
   grant.Invoke(reopened,new object[]{chosen+"-moved",null,receive});string movedMarker=(string)selected["marker"];
   File.WriteAllText(Path.Combine(chosen+"-moved",movedMarker),"private-score-desk-open-v1\n"+selected["proof"]);
   var movedProof=new Dictionary<string,object>(selected);movedProof.Remove("path");movedProof["op"]="folder-confirm";movedProof["id"]=new string('a',32);
   var movedResult=json.Deserialize<Dictionary<string,object>>(json.Serialize(reopened.Confirm(movedProof)));
   Check((string)movedResult["binding"]==binding,"explicitly selecting the moved directory retains its native binding");File.Delete(Path.Combine(chosen+"-moved",movedMarker));
  }
  using(var legacy=new NativeFolders(profile)){
   string actual=chosen+"-moved",other=Path.Combine(root,"other");Directory.CreateDirectory(Path.Combine(actual,".score-desk"));Directory.CreateDirectory(other);
   var c=json.Deserialize<Dictionary<string,object>>(json.Serialize(legacy.Challenge()));string proofFile=Path.Combine(actual,".score-desk",(string)c["marker"]);File.WriteAllText(proofFile,"private-score-desk-open-v1\n"+c["proof"]);
   var r=new Dictionary<string,object>(c);r["op"]="folder-verify";r["id"]=new string('a',32);r["path"]=actual;r["name"]="Synthetic";
   var verified=json.Deserialize<Dictionary<string,object>>(json.Serialize(legacy.VerifyConnection(r)));Check((string)verified["binding"]==binding,"legacy path proof recovers the existing directory binding without a picker or Explorer");
   try{legacy.VerifyConnection(r);throw new Exception("Legacy proof replay accepted");}catch(ArgumentException){Check(true,"legacy path proof is one-use");}
   File.Delete(proofFile);legacy.Resume(binding,receive);Check(true,"legacy proof binds the project directory identity, not its proof file");legacy.Release();
   c=json.Deserialize<Dictionary<string,object>>(json.Serialize(legacy.Challenge()));proofFile=Path.Combine(actual,".score-desk",(string)c["marker"]);File.WriteAllText(proofFile,"private-score-desk-open-v1\n"+c["proof"]);
   r=new Dictionary<string,object>(c);r["op"]="folder-verify";r["id"]=new string('a',32);r["path"]=other;r["name"]="Synthetic";
   try{legacy.VerifyConnection(r);throw new Exception("Unproven stored path accepted");}catch(IOException){Check(true,"a stored path for another folder cannot acquire access");}File.Delete(proofFile);
  }
  using(var modern=new NativeFolders(profile)){
   string actual=chosen+"-moved";Directory.CreateDirectory(Path.Combine(actual,".scorebrush"));
   var c=json.Deserialize<Dictionary<string,object>>(json.Serialize(modern.Challenge()));
   var r=new Dictionary<string,object>(c);r["op"]="folder-verify";r["id"]=new string('a',32);r["path"]=actual;r["name"]="Synthetic";r["dataDirectory"]=".scorebrush";
   string proofFile=Path.Combine(actual,".scorebrush",(string)c["marker"]);File.WriteAllText(proofFile,"private-score-desk-open-v1\n"+c["proof"]);
   var result=json.Deserialize<Dictionary<string,object>>(json.Serialize(modern.VerifyConnection(r)));
   Check((string)result["binding"]==binding,"new data directory retains the project binding and verified absolute path");File.Delete(proofFile);
   foreach(var invalid in new[]{"..",".scorebrush/../elsewhere","C:\\Windows","other"}){
    c=json.Deserialize<Dictionary<string,object>>(json.Serialize(modern.Challenge()));r=new Dictionary<string,object>(c);r["op"]="folder-verify";r["id"]=new string('a',32);r["path"]=actual;r["name"]="Synthetic";r["dataDirectory"]=invalid;
    try{modern.VerifyConnection(r);throw new Exception("Expanded proof directory accepted");}catch(ArgumentException){Check(true,"proof directory is a fixed literal allowlist, never arbitrary filesystem access");}
   }
  }
  string registry=Path.Combine(profile,"scorebrush-folder-grants.dat");byte[] validRegistry=File.ReadAllBytes(registry),damaged=(byte[])validRegistry.Clone();damaged[damaged.Length-1]^=1;
  var corruptions=new[]{damaged,new byte[0],new byte[1024*1024+1],Protect(Encoding.UTF8.GetBytes("{")),Protect(Encoding.UTF8.GetBytes("null")),Protect(Encoding.UTF8.GetBytes("{\""+binding+"\":null}")),Protect(Encoding.UTF8.GetBytes("{\"bad-key\":{\"Path\":\"C:\\\\Synthetic\",\"Identity\":\"invalid\"}}")),Protect(new byte[]{255,255})};
  for(int i=0;i<corruptions.Length;i++)DamagedRegistry(Path.Combine(root,"damaged-registry-"+i),chosen+"-moved",corruptions[i],validRegistry,binding);
  using(var heldFile=new FileStream(registry,FileMode.Open,FileAccess.Read,FileShare.None))using(var host=new NativeFolders(profile)){
   try{host.Resume(binding,receive);throw new Exception("Locked registry accepted");}catch(IOException){Check(File.Exists(registry)&&Directory.GetFiles(profile,"*.invalid").Length==0,"ordinary registry I/O failures do not discard or quarantine valid grants");}
  }
  File.WriteAllBytes(registry,damaged);
  using(var heldFile=new FileStream(registry,FileMode.Open,FileAccess.Read,FileShare.Read))using(var host=new NativeFolders(profile)){
   try{host.Resume(binding,receive);throw new Exception("Quarantine failure ignored");}catch(IOException){Check(File.Exists(registry)&&Directory.GetFiles(profile,"*.invalid").Length==0,"failed quarantine preserves the original and refuses access");}
  }
  Check(Convert.ToBase64String(File.ReadAllBytes(registry))==Convert.ToBase64String(damaged),"quarantine failure preserves every original byte");
  File.WriteAllBytes(registry,validRegistry);
  using(var host=new NativeFolders(profile)){host.Resume(binding,receive);Check(true,"temporary I/O failure does not invalidate an intact grant");}
  Console.WriteLine("Native verification checks: "+checks);
 }
}
