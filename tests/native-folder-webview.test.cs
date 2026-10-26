// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Test-only current-source host: no production launcher, picker or real profile.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

static class NativeFolderWebViewTests {
 internal static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
 [STAThread] static int Main(string[] args){
  string root=Path.GetFullPath(args[0]);
  if(!root.Contains(Path.DirectorySeparatorChar+".runtime"+Path.DirectorySeparatorChar)||Directory.Exists(Path.Combine(root,"web-profile")))return 2;
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  using(var window=new ProbeWindow(root)){Application.Run(window);return window.Passed?0:1;}
 }
 sealed class ProbeWindow:Form {
  const string Address="https://scorebrush-native-test.invalid/index.html";
  readonly string root,selected,grantProfile;readonly WebView2 view=new WebView2{Dock=DockStyle.Fill};
  readonly Timer timeout=new Timer{Interval=45000};NativeFolders folders;string binding;int phase,checks;bool finished;
  internal bool Passed;
  internal ProbeWindow(string directory){
   root=directory;selected=Path.Combine(root,"SYNTHETIC selected");grantProfile=Path.Combine(root,"grant-profile");Directory.CreateDirectory(selected);Directory.CreateDirectory(grantProfile);
   ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Location=new Point(-16000,-16000);Size=new Size(640,480);Controls.Add(view);
   folders=new NativeFolders(grantProfile);timeout.Tick+=(s,e)=>Finish(new Exception("Synthetic WebView2 handle delivery timed out."));Shown+=async(s,e)=>{timeout.Start();try{await Initialize();}catch(Exception error){Finish(error);}};
  }
  void Check(bool condition,string message){if(!condition)throw new Exception(message);checks++;}
  async Task Initialize(){
   // Fail before runtime creation if environment/policy could redirect this
   // test into a real profile or a non-Stable runtime. Never change policy.
   foreach(string name in new[]{"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER","WEBVIEW2_USER_DATA_FOLDER","WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS","WEBVIEW2_RELEASE_CHANNELS","WEBVIEW2_RELEASE_CHANNEL_PREFERENCE","WEBVIEW2_CHANNEL_SEARCH_KIND","WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER","WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER"})
    if(!String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name)))throw new IOException("Remove the conflicting test-process environment override before running this isolated test: "+name);
   foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})foreach(var registryView in new[]{RegistryView.Registry64,RegistryView.Registry32})
   using(var registry=RegistryKey.OpenBaseKey(hive,registryView))foreach(string setting in new[]{"BrowserExecutableFolder","UserDataFolder","AdditionalBrowserArguments","ReleaseChannels"})
   using(var key=registry.OpenSubKey(@"Software\Policies\Microsoft\Edge\WebView2\"+setting)){
    if(key==null)continue;foreach(string app in new[]{Path.GetFileName(Application.ExecutablePath),"*"}){
     string value=key.GetValue(app) as string;if(String.IsNullOrWhiteSpace(value))continue;
     if(setting!="ReleaseChannels"||value.Trim()!="0")throw new IOException("WebView2 policy prevents this isolated test: "+setting);
    }
   }
   var options=new CoreWebView2EnvironmentOptions{ReleaseChannels=CoreWebView2ReleaseChannels.Stable};
   var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(root,"web-profile"),options);await view.EnsureCoreWebView2Async(environment);
   view.CoreWebView2.SetVirtualHostNameToFolderMapping("scorebrush-native-test.invalid",Path.Combine(root,"web"),CoreWebView2HostResourceAccessKind.Deny);
   view.CoreWebView2.WebMessageReceived+=Message;view.CoreWebView2.Navigate(Address);
  }
  void Deliver(object value,string path){
   Check(path==selected,"native delivery must retain the exact synthetic selected path");
   bool renamed=false;try{Directory.Move(selected,selected+"-replacement-attempt");renamed=true;}catch(IOException){}
   Check(!renamed&&Directory.Exists(selected),"selected leaf must remain pinned through actual WebView2 handle delivery");
   var handle=view.CoreWebView2.Environment.CreateWebFileSystemDirectoryHandle(path,CoreWebView2FileSystemHandlePermission.ReadWrite);
   view.CoreWebView2.PostWebMessageAsJson(NativeFolderWebViewTests.Json.Serialize(new {phase=phase,value=value}),new List<object>{handle});
  }
  void Message(object sender,CoreWebView2WebMessageReceivedEventArgs e){
   if(finished)return;
   try{
    Check(e.Source==Address&&view.CoreWebView2.Source==Address,"test messages must originate in the exact isolated test page");
    var message=NativeFolderWebViewTests.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);string op=message["op"] as string;
    if(op=="error")throw new Exception("WebView2 fixture: "+message["error"]);
    if(op=="ready"){
     Check(phase==0,"test page must initialize only once");phase=1;
     typeof(NativeFolders).GetMethod("Grant",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(folders,new object[]{selected,null,(Action<object,string>)Deliver});return;
    }
    Check(op=="folder-confirm"&&message.Count==5,"actual browser proof uses the unchanged native confirmation schema");
    string marker=(string)message["marker"];Check(File.ReadAllText(Path.Combine(selected,marker))=="private-score-desk-open-v1\n"+message["proof"],"WebView2 directory handle wrote the exact proof into the selected native folder");
    var confirmed=NativeFolderWebViewTests.Json.Deserialize<Dictionary<string,object>>(NativeFolderWebViewTests.Json.Serialize(folders.Confirm(message)));
    Check((string)confirmed["path"]==selected,"confirmation retains the selected native path");
    bool replayRejected=false;try{folders.Confirm(message);}catch(ArgumentException){replayRejected=true;}Check(replayRejected,"actual delivered proof remains one-use");
    if(phase==1){
     binding=(string)confirmed["binding"];folders.Dispose();folders=new NativeFolders(grantProfile);phase=2;folders.Resume(binding,Deliver);
    }else{Check(phase==2&&(string)confirmed["binding"]==binding,"fresh native registry instance resumes and reconfirms the same durable binding");Finish(null);}
   }catch(Exception error){Finish(error);}
  }
  void Finish(Exception error){
   if(finished)return;finished=true;timeout.Stop();Passed=error==null;
   File.WriteAllText(Path.Combine(root,"result.json"),NativeFolderWebViewTests.Json.Serialize(new {passed=Passed,checks=checks,phase=phase,runtime=view.CoreWebView2==null?null:view.CoreWebView2.Environment.BrowserVersionString,error=error==null?null:error.ToString()}));
   folders.Dispose();view.Dispose();Close();
  }
  protected override void Dispose(bool disposing){if(disposing){timeout.Dispose();if(folders!=null)folders.Dispose();}base.Dispose(disposing);}
 }
}
