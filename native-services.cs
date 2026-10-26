// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Narrow Windows integration. No server, shell command strings or score reads.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

// One user-facing link, with no URL, arguments or executable supplied by the web.
static class NativeRepositoryLink {
    internal const string Address="https://github.com/aug5thmusic/scorebrush";
    internal static bool IsRequest(Dictionary<string,object> request){
        return request!=null&&request.Count==2&&request.ContainsKey("op")&&Equals(request["op"],"open-source")&&request.ContainsKey("id")&&request["id"] is string&&Regex.IsMatch((string)request["id"],@"\A[a-f0-9]{32}\z");
    }
    internal static void Open(Dictionary<string,object> request){
        if(!IsRequest(request))throw new ArgumentException("Invalid repository link action.");
        System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Address){UseShellExecute=true});
    }
}

sealed class NativeFolders : IDisposable {
    string token,marker,proof;DateTime expires;bool opening;
    readonly string registry;Verified selected;string selectedBinding;
    readonly Timer expiry=new Timer {Interval=1000};
    internal NativeFolders(string profile=null) {registry=profile==null?null:System.IO.Path.Combine(profile,"scorebrush-folder-grants.dat");expiry.Tick+=(s,e)=>{if(DateTime.UtcNow>expires)Release();};expiry.Start();}
    internal void Release(){token=null;marker=null;proof=null;if(selected!=null)selected.Dispose();selected=null;selectedBinding=null;}
    public void Dispose(){Release();expiry.Dispose();}
    internal sealed class Binding {public string Path {get;set;} public string Identity {get;set;}}
    Dictionary<string,Binding> QuarantineBindings(){
        // Preserve corrupt/foreign-account bytes for diagnosis. Never fall back
        // to an older grant: every replacement still requires a fresh proof.
        string invalid=registry+"."+DateTime.UtcNow.ToString("yyyyMMddTHHmmssfffZ",System.Globalization.CultureInfo.InvariantCulture)+"."+Guid.NewGuid().ToString("N")+".invalid";
        try{File.Move(registry,invalid);}
        catch(IOException e){throw new IOException("Saved folder access is damaged and could not be set aside. Close other ScoreBrush windows and check access to the application profile, then reconnect the working folder.",e);}
        catch(UnauthorizedAccessException e){throw new IOException("Saved folder access is damaged and could not be set aside. Check access to the application profile, then reconnect the working folder.",e);}
        return new Dictionary<string,Binding>();
    }
    Dictionary<string,Binding> Bindings(){
        if(registry==null||!File.Exists(registry))return new Dictionary<string,Binding>();
        if(new System.IO.FileInfo(registry).Length>1024*1024)return QuarantineBindings();
        // Read failures (permissions, locks, missing drive) are not corruption.
        // Keep them outside the decoding catches so intact grants stay intact.
        var encrypted=File.ReadAllBytes(registry);
        try{
            var bytes=ProtectedData.Unprotect(encrypted,Encoding.UTF8.GetBytes("ScoreBrush selected folders v1"),DataProtectionScope.CurrentUser);
            var bindings=new JavaScriptSerializer().Deserialize<Dictionary<string,Binding>>(new UTF8Encoding(false,true).GetString(bytes));
            if(bindings==null||bindings.Count>1000)throw new ArgumentException("Invalid saved folder registry.");
            foreach(var pair in bindings){
                var value=pair.Value;
                if(!Regex.IsMatch(pair.Key,@"\A[a-f0-9]{32}\z")||value==null||value.Path==null||value.Path.Length>1024||!Regex.IsMatch(value.Path,@"\A[A-Za-z]:[\\/]")||value.Identity==null||!Regex.IsMatch(value.Identity,@"\A[A-F0-9]{8}:[A-F0-9]{16}:-?[0-9]{1,10}:-?[0-9]{1,10}\z"))throw new ArgumentException("Invalid saved folder binding.");
            }
            return bindings;
        }catch(CryptographicException){}catch(ArgumentException){}catch(InvalidOperationException){}
        return QuarantineBindings();
    }
    void Remember(string id,Binding binding){
        var bindings=Bindings();if(bindings.Count>=1000&&!bindings.ContainsKey(id))throw new IOException("Saved folder access is full. Keep a backup before resetting folder access.");bindings[id]=binding;
        var bytes=ProtectedData.Protect(Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(bindings)),Encoding.UTF8.GetBytes("ScoreBrush selected folders v1"),DataProtectionScope.CurrentUser);
        string temp=registry+"."+Guid.NewGuid().ToString("N")+".tmp";
        try{using(var output=new FileStream(temp,FileMode.CreateNew,FileAccess.Write,FileShare.None)){output.Write(bytes,0,bytes.Length);output.Flush(true);}if(File.Exists(registry))File.Replace(temp,registry,registry+".bak");else File.Move(temp,registry);}finally{if(File.Exists(temp))File.Delete(temp);}
    }
    // Resume accepts an opaque binding, never a web-supplied filesystem path.
    internal void Select(IWin32Window owner,Action<object,string> deliver){
        if(opening)throw new InvalidOperationException("Finish the current folder action first.");opening=true;
        try{string path=NativeDirectoryPicker.Choose(owner);if(path==null){deliver(new {cancelled=true},null);return;}Grant(path,null,deliver);}finally{opening=false;}
    }
    internal void Resume(string binding,Action<object,string> deliver){
        if(!Regex.IsMatch(binding??"","^[a-f0-9]{32}$"))throw new ArgumentException("Invalid folder binding.");
        Binding record;if(!Bindings().TryGetValue(binding,out record))throw new IOException("Select this working folder once to restore desktop access.");
        using(var held=VerifyPath(record.Path)){if(held.Identity!=record.Identity)throw new IOException("The connected folder moved or was replaced. Select its new location to reconnect.");Grant(held.Path,binding,deliver);}
    }
    void Grant(string path,string binding,Action<object,string> deliver){
        Release();selected=VerifyPath(path);selectedBinding=binding;NewChallenge();
        try{deliver(new {path=selected.Path,token=token,marker=marker,proof=proof},selected.Path);}catch{Release();throw;}
    }
    internal object Confirm(Dictionary<string,object> request){
        if(request.Count!=5||selected==null)throw new ArgumentException("Invalid selected-folder proof.");
        CheckProof(request);var held=selected;string currentMarker=marker,currentProof=proof,id=selectedBinding??Guid.NewGuid().ToString("N");
        token=null;selected=null;selectedBinding=null;
        using(held){
            string identity=held.Identity;VerifyProof(held,held.Path,currentMarker,currentProof);
            // Re-selecting the same Windows directory also retains its binding
            // after a move. Copies/replacements have a different identity.
            foreach(var pair in Bindings())if(pair.Value.Identity==identity){id=pair.Key;break;}
            Remember(id,new Binding {Path=held.Path,Identity=identity});return new {binding=id,path=held.Path};
        }
    }
    void NewChallenge(){
        token=Guid.NewGuid().ToString("N");marker="native-open-"+Guid.NewGuid().ToString("N")+".txt";
        var bytes=new byte[32];using(var random=RandomNumberGenerator.Create())random.GetBytes(bytes);
        proof=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();expires=DateTime.UtcNow.AddMinutes(3);
    }
    void CheckProof(Dictionary<string,object> request){
        foreach(string key in new[]{"op","id","token","marker","proof"})if(!request.ContainsKey(key)||!(request[key] is string))throw new ArgumentException("Invalid folder request.");
        if(token==null||DateTime.UtcNow>expires||!Equals(request["token"],token)||!Equals(request["marker"],marker)||!Equals(request["proof"],proof))throw new ArgumentException("Folder verification expired. Try again.");
    }
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInfo info);
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Created,Accessed,Written;public uint Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;}
    [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern IntPtr ShellExecute(IntPtr owner,string verb,string file,string parameters,string directory,int show);
    internal object Challenge() {
        if(opening)throw new InvalidOperationException("Finish the current folder action first.");
        if(selected!=null)throw new InvalidOperationException("Finish connecting the selected folder first.");NewChallenge();
        return new {token=token,marker=marker,proof=proof};
    }
    internal object Open(Dictionary<string,object> request,IWin32Window owner) {
        return ProvenFolder(request,owner,"folder-open");
    }
    internal object OpenVersions(Dictionary<string,object> request,IWin32Window owner) {
        return ProvenFolder(request,owner,"folder-versions");
    }
    internal object OpenLatest(Dictionary<string,object> request,IWin32Window owner) {
        return ProvenFolder(request,owner,"folder-latest");
    }
    internal object VerifyConnection(Dictionary<string,object> request) {
        return ProvenFolder(request,null,"folder-verify");
    }
    object ProvenFolder(Dictionary<string,object> request,IWin32Window owner,string action) {
        if(opening||(request.Count!=7&&request.Count!=8))throw new ArgumentException("Invalid folder request.");
        foreach(string key in new[]{"op","id","token","marker","proof","path","name"})if(!request.ContainsKey(key)||!(request[key] is string))throw new ArgumentException("Invalid folder request.");
        if(!Equals(request["op"],action))throw new ArgumentException("Invalid folder action.");
        // Older clients use the original fixed proof directory. New clients
        // may select only one of these two literal names, never a relative path.
        string dataDirectory=".score-desk";
        if(request.Count==8){object value;if(!request.TryGetValue("dataDirectory",out value)||!(value is string)||(!Equals(value,".scorebrush")&&!Equals(value,".score-desk")))throw new ArgumentException("Invalid proof directory.");dataDirectory=(string)value;}
        if(selected!=null)throw new ArgumentException("Invalid Explorer proof.");CheckProof(request);
        string requested=(string)request["path"],name=(string)request["name"],currentMarker=marker,currentProof=proof;
        token=null;marker=null;proof=null;
        if(name.Length>255||Regex.IsMatch(name,@"[\x00-\x1f]"))throw new ArgumentException("Invalid folder name.");
        opening=true;
        try {
            using(var held=Verify(requested,currentMarker,currentProof,dataDirectory)){
                if(action!="folder-verify"){
                    string destination=held.Path;
                    if(action=="folder-versions")destination=HoldVersions(held);
                    if(action=="folder-latest")destination=HoldLatest(held);
                    Explore(owner,destination);return new {opened=true,path=destination};
                }
                // Existing browser access proves this exact path before it can
                // acquire a durable grant. A path alone never grants access.
                string id=Guid.NewGuid().ToString("N");
                foreach(var pair in Bindings())if(pair.Value.Identity==held.Identity){id=pair.Key;break;}
                Remember(id,new Binding {Path=held.Path,Identity=held.Identity});return new {binding=id,path=held.Path};
            }
        }finally{opening=false;}
    }
    sealed class Verified:IDisposable {
        internal string Path,Identity;internal List<SafeFileHandle> Handles=new List<SafeFileHandle>();
        public void Dispose(){foreach(var handle in Handles)handle.Dispose();}
    }
    static void Hold(Verified held,string path,bool directory,uint access=0) {
        // Metadata-only ancestor handles avoid requiring directory-list access
        // during traversal. The selected leaf also gets a list-access handle
        // below, which makes Windows enforce its deny-delete sharing.
        var handle=CreateFile(path,access,3,IntPtr.Zero,3,0x02000000|0x00200000,IntPtr.Zero);
        if(handle.IsInvalid){handle.Dispose();throw new IOException("Folder verification could not open its selected directory.");}
        held.Handles.Add(handle);FileInfo info;
        if(!GetFileInformationByHandle(handle,out info)||(info.Attributes&0x400)!=0||((info.Attributes&0x10)!=0)!=directory)throw new IOException("Folder verification does not accept links or redirected paths.");
        held.Identity=info.Volume.ToString("X8")+":"+info.IndexHigh.ToString("X8")+info.IndexLow.ToString("X8")+":"+info.Created.dwHighDateTime+":"+info.Created.dwLowDateTime;
    }
    static Verified VerifyPath(string value) {
        if(value==null)throw new ArgumentException("Choose a normal local Windows folder.");
        if(value.Length>1024||!Regex.IsMatch(value,@"^[A-Za-z]:[\\/]")||Regex.IsMatch(value.Substring(2),"[\x00-\x1f:*?\"<>|]"))throw new ArgumentException("Choose a normal local Windows folder.");
        foreach(string part in value.Substring(3).Split(new[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries))if(part=="."||part==".."||part.EndsWith(".")||part.EndsWith(" "))throw new ArgumentException("Choose a complete folder path without shortcuts.");
        string path=System.IO.Path.GetFullPath(value),root=System.IO.Path.GetPathRoot(path);uint drive=GetDriveType(root);
        if(drive!=2&&drive!=3&&drive!=5&&drive!=6)throw new ArgumentException("Choose a folder on a local drive.");
        var held=new Verified {Path=path};
        try {
            string component=root;Hold(held,component,true);
            foreach(string part in path.Substring(root.Length).Split(new[]{'\\'},StringSplitOptions.RemoveEmptyEntries)){component=System.IO.Path.Combine(component,part);Hold(held,component,true);}
            // Pin the exact selected leaf through handle delivery and Confirm.
            // Access 0 does not prevent this directory from being renamed; ask
            // for FILE_LIST_DIRECTORY only here, not on traversal ancestors.
            Hold(held,path,true,1);
            return held;
        }catch{held.Dispose();throw;}
    }
    static Verified Verify(string value,string marker,string proof,string dataDirectory){
        var held=VerifyPath(value);try{string identity=held.Identity,privatePath=System.IO.Path.Combine(held.Path,dataDirectory);Hold(held,privatePath,true);VerifyProof(held,privatePath,marker,proof);held.Identity=identity;return held;}catch{held.Dispose();throw;}
    }
    static string HoldVersions(Verified held){
        // A single fixed child of the proven project, never a supplied subpath.
        // Keep it open without delete sharing through the Explorer dispatch.
        string path=System.IO.Path.Combine(held.Path,"Versions");
        if(!Directory.Exists(path))throw new IOException("Previous PDF versions are not saved yet. Retry saving to the working folder.");
        // FILE_LIST_DIRECTORY makes Windows enforce the deny-delete share on
        // this child itself, even when the directory is empty.
        Hold(held,path,true,1);return path;
    }
    static string HoldLatest(Verified held){
        string path=System.IO.Path.Combine(held.Path,"Latest");
        if(!Directory.Exists(path))throw new IOException("The finished PDF is not saved yet. Retry saving to the working folder.");
        Hold(held,path,true,1);return path;
    }
    static void VerifyProof(Verified held,string directory,string marker,string proof){
            string target=System.IO.Path.Combine(directory,marker);Hold(held,target,false);
            byte[] expected=Encoding.ASCII.GetBytes("private-score-desk-open-v1\n"+proof);
            using(var input=new FileStream(target,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                if(input.Length!=expected.Length)throw new IOException("Folder proof does not match.");
                var actual=new byte[expected.Length];int offset=0,n;while(offset<actual.Length&&(n=input.Read(actual,offset,actual.Length-offset))>0)offset+=n;
                int difference=offset^expected.Length;for(int i=0;i<actual.Length;i++)difference|=actual[i]^expected[i];
                if(difference!=0)throw new IOException("Folder proof does not match.");
            }
    }
    static void Explore(IWin32Window owner,string path) {
        // No executable name or command arguments come from JavaScript.
        long result=ShellExecute(owner.Handle,"explore",path,null,null,1).ToInt64();
        if(result<=32)throw new IOException("Windows Explorer could not open the verified folder.");
    }
}

// Windows Common Item Dialog, folder-only and filesystem-only. No path comes
// from a web message and cancelling never grants or changes a connection.
static class NativeDirectoryPicker {
    [ComImport,Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialog {}
    [ComImport,Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IFileDialog {
        [PreserveSig]int Show(IntPtr parent);
        void SetFileTypes(uint count,IntPtr types);void SetFileTypeIndex(uint index);void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events,out uint cookie);void Unadvise(uint cookie);void SetOptions(uint options);void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);void SetFolder(IShellItem item);void GetFolder(out IShellItem item);void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
    }
    [ComImport,Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IShellItem {
        void BindToHandler(IntPtr context,ref Guid handler,ref Guid iid,out IntPtr result);void GetParent(out IShellItem parent);void GetDisplayName(uint kind,out IntPtr name);
    }
    internal static string Choose(IWin32Window owner){
        var dialog=(IFileDialog)new FileOpenDialog();IShellItem item=null;IntPtr text=IntPtr.Zero;
        try{
            uint options;dialog.GetOptions(out options);dialog.SetOptions(options|0x20|0x40|0x800|0x02000000); // PICKFOLDERS, FORCEFILESYSTEM, PATHMUSTEXIST, DONTADDTORECENT
            dialog.SetTitle("Choose your ScoreBrush working folder");dialog.SetOkButtonLabel("Select folder");
            int result=dialog.Show(owner.Handle);if(result==unchecked((int)0x800704C7))return null;if(result<0)Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out item);item.GetDisplayName(0x80058000,out text);return Marshal.PtrToStringUni(text);
        }finally{if(text!=IntPtr.Zero)Marshal.FreeCoTaskMem(text);if(item!=null)Marshal.ReleaseComObject(item);Marshal.ReleaseComObject(dialog);}
    }
}
