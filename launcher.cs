// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Windows .NET Framework 4.8+, official pinned WebView2 WinForms SDK.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class ScoreBrushLauncher {
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    internal static string Root = AppDomain.CurrentDomain.BaseDirectory;
    internal static string Data;
    internal const string Origin = "https://scorebrush.invalid";
    internal static bool Test;
    internal static int DebugPort;
    [DllImport("shell32.dll")] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
    internal static string Hash(string value) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").Substring(0,24); }
    [STAThread] static int Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try {
            bool testClose=false;string testData=null;
            for(int i=0;i<args.Length;i++) {
                switch(args[i]) {
                case "--test-data": testData=Path.GetFullPath(args[++i]);Test=true;break;
                case "--debug-port": DebugPort=int.Parse(args[++i]);break;
                case "--test-close": testClose=true;break;
                default: throw new Exception("Unsupported ScoreBrush option.");
                }
            }
            if(DebugPort!=0&&(!Test||DebugPort<1024||DebugPort>65535)||testClose&&!Test)
                throw new Exception("Debugging and test-close require an explicit disposable --test-data profile.");
            Data=testData??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ScoreBrush","Standalone","WebView2");
            if(Test&&String.Equals(Data.TrimEnd('\\'),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"ScoreBrush","Standalone","WebView2"),StringComparison.OrdinalIgnoreCase))throw new Exception("Tests cannot use the normal profile.");
            string key=Hash(WindowsIdentity.GetCurrent().User.Value+"|"+Data.ToUpperInvariant()+"|"+Origin);
            string name="Local\\ScoreBrush-desktop-"+key;
            bool owner;
            using(var mutex=new Mutex(true,name,out owner)) {
                if(!owner) {
                    EventWaitHandle signal=null;
                    for(int attempt=0;attempt<100;attempt++){if(EventWaitHandle.TryOpenExisting(name+(testClose?"-close":"-focus"),out signal))break;Thread.Sleep(100);}
                    if(signal==null)throw new Exception("ScoreBrush is still starting in another window. Wait a moment and try again.");
                    using(signal)signal.Set();
                    return 0;
                }
                try {
                    if(testClose)return 0;
                    Directory.CreateDirectory(Data);
                    using(var profileLock=new FileStream(Path.Combine(Data,"scorebrush-host.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
                    using(var focus=new EventWaitHandle(false,EventResetMode.AutoReset,name+"-focus"))
                    using(var close=new EventWaitHandle(false,EventResetMode.AutoReset,name+"-close")) {
                        SetCurrentProcessExplicitAppUserModelID("ScoreBrush.Desktop");
                        Application.Run(new DesktopWindow(focus,close));
                    }
                } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        } catch(Exception e) { MessageBox.Show(e.Message,"ScoreBrush could not start",MessageBoxButtons.OK,MessageBoxIcon.Error);return 1; }
    }
}

sealed class DesktopWindow : Form {
    readonly WebView2 view=new WebView2();
    readonly EventWaitHandle focusEvent,closeEvent;
    readonly System.Windows.Forms.Timer signals=new System.Windows.Forms.Timer();
    bool ready,approved,closing,mainDocumentLost;
    bool initializing;
    readonly DesktopPlacement placement;
    readonly CancellationTokenSource startupCancel=new CancellationTokenSource();
    NativeEvergreenRuntime evergreen;
    readonly Label startupStatus=new Label {Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter,ForeColor=Color.FromArgb(68,61,208)};
    readonly ProgressBar startupProgress=new ProgressBar {Dock=DockStyle.Fill,Style=ProgressBarStyle.Marquee,MarqueeAnimationSpeed=30};
    readonly Button startupRetry=new Button {Text="Retry",AutoSize=true,Visible=false};
    readonly Button startupClose=new Button {Text="Close",AutoSize=true};
    readonly NativeFolders folders=new NativeFolders(ScoreBrushLauncher.Data);
    string closeToken;
    TaskCompletionSource<Dictionary<string,object>> closeReply;
    readonly HashSet<CoreWebView2DownloadOperation> downloads=new HashSet<CoreWebView2DownloadOperation>();
    readonly HashSet<ulong> blockedNavigations=new HashSet<ulong>();
    readonly Panel loading=new Panel { Dock=DockStyle.Fill,BackColor=Color.FromArgb(248,247,251) };
    readonly MenuStrip menu=new MenuStrip();
    readonly Dictionary<string,ToolStripMenuItem> commands=new Dictionary<string,ToolStripMenuItem>();
    readonly Dictionary<string,bool> menuEnabled=new Dictionary<string,bool>();
    void Command(ToolStripMenuItem parent,string id,string label,string shortcut=null) {
        var item=new ToolStripMenuItem(label);item.Enabled=false;if(shortcut!=null)item.ShortcutKeyDisplayString=shortcut;
        commands.Add(id,item);menuEnabled.Add(id,false);parent.DropDownItems.Add(item);
        item.Click+=(s,e)=>{if(!ready||closing||!item.Enabled||!Trusted(view.CoreWebView2.Source))return;view.Focus();view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="command",id=id}));};
    }
    void RefreshMenu() {
        foreach(var pair in commands)pair.Value.Enabled=ready&&!closing&&menuEnabled[pair.Key];
    }
    void BuildMenu() {
        menu.AccessibleName="Application menu";menu.BackColor=Color.White;menu.RenderMode=ToolStripRenderMode.System;
        var file=new ToolStripMenuItem("&File");var edit=new ToolStripMenuItem("&Edit");var layout=new ToolStripMenuItem("&View");var workflow=new ToolStripMenuItem("&Workflow");var help=new ToolStripMenuItem("&Help");
        menu.Items.AddRange(new ToolStripItem[]{file,edit,layout,workflow,help});
        Command(file,"new-project","&New Project…");Command(file,"open-folder","&Open Project…","Ctrl+O");Command(file,"explorer","Open file &location");Command(file,"versions","Open previous &versions");Command(file,"copy-path","Copy folder &path");Command(file,"connect-folder","&Connect working folder…");file.DropDownItems.Add(new ToolStripSeparator());
        Command(file,"import","&Restore Backup…");Command(file,"backup","&Save backup…","Ctrl+Shift+S");Command(file,"files","Files && backups…");file.DropDownItems.Add(new ToolStripSeparator());file.DropDownItems.Add("E&xit",null,(s,e)=>Close());
        Command(edit,"undo","&Undo","Ctrl+Z");Command(edit,"redo","&Redo","Ctrl+Shift+Z");edit.DropDownItems.Add(new ToolStripSeparator());Command(edit,"new-finding","&New finding","N");Command(edit,"navigate","Na&vigate","V");Command(edit,"draw","&Draw","D");
        Command(layout,"marks","&Hide marks","Ctrl+H");Command(layout,"findings","&Findings pane");Command(layout,"scroll-pages","Scroll between &pages");layout.DropDownItems.Add(new ToolStripSeparator());Command(layout,"both","&Both scores");Command(layout,"source","&Left score only");Command(layout,"rendered","&Right score only");Command(layout,"fit","Fit scores to &width");
        Command(workflow,"proofread","&Proofread");Command(workflow,"send","&Send to AI…");Command(workflow,"review","&Review Changes");Command(workflow,"round-summary","Round s&ummary…");workflow.DropDownItems.Add(new ToolStripSeparator());Command(workflow,"latest","&Load latest from working folder");Command(workflow,"response","&Open AI response…");Command(workflow,"task","Save AI task &ZIP…");
        Command(help,"welcome","&Welcome && workflow guide");Command(help,"shortcuts","&Keyboard shortcuts…","F1");help.DropDownItems.Add(new ToolStripSeparator());
        Command(help,"about","&About ScoreBrush");
        menu.MenuDeactivate+=(s,e)=>{if(!IsDisposed)view.Focus();};MainMenuStrip=menu;RefreshMenu();
    }
    void BuildStartup() {
        var info=ScoreBrushLauncher.Json.Deserialize<Dictionary<string,string>>(File.ReadAllText(Path.Combine(ScoreBrushLauncher.Root,"app","build-info.json")));
        loading.Font=new Font("Segoe UI",10f);
        var box=new TableLayoutPanel {Width=620,Height=440,ColumnCount=1,RowCount=6,BackColor=loading.BackColor};
        box.RowStyles.Add(new RowStyle(SizeType.Absolute,88));box.RowStyles.Add(new RowStyle(SizeType.Absolute,80));box.RowStyles.Add(new RowStyle(SizeType.Absolute,35));box.RowStyles.Add(new RowStyle(SizeType.Percent,100));box.RowStyles.Add(new RowStyle(SizeType.Absolute,8));box.RowStyles.Add(new RowStyle(SizeType.Absolute,48));
        box.Controls.Add(new PictureBox {Image=Image.FromFile(Path.Combine(ScoreBrushLauncher.Root,"app","branding","scorebrush-app.png")),SizeMode=PictureBoxSizeMode.Zoom,Width=72,Height=72,Anchor=AnchorStyles.None});
        var brand=new PictureBox {Image=Image.FromFile(Path.Combine(ScoreBrushLauncher.Root,"app","wordmark.png")),SizeMode=PictureBoxSizeMode.Zoom,Dock=DockStyle.Fill,Height=80};
        box.Controls.Add(brand);box.Controls.Add(new Label {Dock=DockStyle.Fill,Font=new Font("Segoe UI",8.25f),Text="Version "+info["version"]+" ("+info["buildDate"]+")",TextAlign=ContentAlignment.MiddleCenter,ForeColor=Color.FromArgb(108,104,125)});
        startupStatus.Text="Opening your local workspace…";box.Controls.Add(startupStatus);box.Controls.Add(startupProgress);
        var actions=new FlowLayoutPanel {Dock=DockStyle.Fill,FlowDirection=FlowDirection.RightToLeft,Padding=new Padding(8)};
        actions.Controls.Add(startupClose);actions.Controls.Add(startupRetry);box.Controls.Add(actions);
        startupRetry.Click+=async(s,e)=>await Initialize();startupClose.Click+=(s,e)=>Close();
        loading.Controls.Add(box);loading.Resize+=(s,e)=>box.Location=new Point((loading.Width-box.Width)/2,(loading.Height-box.Height)/2);
    }
    internal DesktopWindow(EventWaitHandle focus,EventWaitHandle close) {
        focusEvent=focus;closeEvent=close;
        Text=ScoreBrushLauncher.Test?"ScoreBrush — synthetic verification":"ScoreBrush";Width=1440;Height=980;MinimumSize=new Size(900,620);StartPosition=FormStartPosition.CenterScreen;
        placement=new DesktopPlacement(this,ScoreBrushLauncher.Data);
        Icon=new Icon(Path.Combine(ScoreBrushLauncher.Root,"app","branding","scorebrush.ico"));
        BuildMenu();BuildStartup();
        // Keep the native splash above WebView2's unpainted child window. The
        // browser and form also share its opaque background during composition.
        BackColor=loading.BackColor;view.DefaultBackgroundColor=loading.BackColor;
        view.Dock=DockStyle.Fill;Controls.Add(view);Controls.Add(loading);Controls.Add(menu);loading.BringToFront();
        signals.Interval=150;signals.Tick+=(s,e)=>{if(focusEvent.WaitOne(0)){if(WindowState==FormWindowState.Minimized)WindowState=placement.Maximized?FormWindowState.Maximized:FormWindowState.Normal;Show();Activate();}if(closeEvent.WaitOne(0))Close();};signals.Start();
        Shown+=async(s,e)=>await Initialize();FormClosing+=OnClosing;FormClosed+=(s,e)=>{placement.Dispose();Cleanup();};
    }
    bool Trusted(string uri) { return uri==ScoreBrushLauncher.Origin+"/" || uri==ScoreBrushLauncher.Origin+"/index.html"; }
    async Task Initialize() {
        if(initializing||IsDisposed)return;initializing=true;startupRetry.Visible=false;startupProgress.Visible=true;
        startupStatus.Text="Opening your local workspace…";
        try {
            NativeEvergreenRuntime.Configure(ScoreBrushLauncher.Data,ScoreBrushLauncher.DebugPort);
            var options=new CoreWebView2EnvironmentOptions {ExclusiveUserDataFolderAccess=true,IsCustomCrashReportingEnabled=true,ReleaseChannels=CoreWebView2ReleaseChannels.Stable};
            if(evergreen==null)evergreen=new NativeEvergreenRuntime(ScoreBrushLauncher.Root,Path.Combine(ScoreBrushLauncher.Data,"scorebrush-runtime.log"),options);
            await new EvergreenSetup(evergreen).EnsureAsync(text=>startupStatus.Text=text,startupCancel.Token);
            startupCancel.Token.ThrowIfCancellationRequested();startupStatus.Text="Opening your local workspace…";
            var environment=await CoreWebView2Environment.CreateAsync(null,ScoreBrushLauncher.Data,options);
            startupCancel.Token.ThrowIfCancellationRequested();
            await view.EnsureCoreWebView2Async(environment);
            var core=view.CoreWebView2;
            // Read-only loading metrics, not a browser command or persistent
            // identity. WinForms can use 96-DPI units while WebView2 renders at
            // the monitor scale; keep only the loading panel at its native size.
            float startupPixelScale;using(var graphics=loading.CreateGraphics())startupPixelScale=graphics.DpiY/96f;
            await core.AddScriptToExecuteOnDocumentCreatedAsync("window.scoreBrushNativeStartup=Object.freeze("+ScoreBrushLauncher.Json.Serialize(new {version=1,pixelScale=startupPixelScale})+");");
            string actual=Process.GetProcessById((int)core.BrowserProcessId).MainModule.FileName;
            evergreen.Record("Loaded Evergreen "+environment.BrowserVersionString+" from "+actual);
            core.SetVirtualHostNameToFolderMapping("scorebrush.invalid",Path.Combine(ScoreBrushLauncher.Root,"app"),CoreWebView2HostResourceAccessKind.Deny);
            core.AddWebResourceRequestedFilter("*",CoreWebView2WebResourceContext.All,CoreWebView2WebResourceRequestSourceKinds.All);
            core.WebResourceRequested+=(s,e)=>{
                Uri uri;bool local=Uri.TryCreate(e.Request.Uri,UriKind.Absolute,out uri)&&uri.Scheme=="https"&&uri.Host=="scorebrush.invalid"&&uri.IsDefaultPort;
                if(!local&&!e.Request.Uri.StartsWith("blob:"+ScoreBrushLauncher.Origin+"/",StringComparison.Ordinal))e.Response=environment.CreateWebResourceResponse(new MemoryStream(),403,"External resource blocked","Content-Type: text/plain");
            };
            view.KeyDown+=(s,e)=>{
                int index=-1;bool alt=(ModifierKeys&Keys.Alt)==Keys.Alt;
                if(alt){switch(e.KeyCode){case Keys.F:index=0;break;case Keys.E:index=1;break;case Keys.V:index=2;break;case Keys.W:index=3;break;case Keys.H:index=4;break;}}
                if(index>=0||e.KeyCode==Keys.F10){e.Handled=true;int selected=index;BeginInvoke((Action)(()=>{menu.Focus();var item=(ToolStripMenuItem)menu.Items[Math.Max(0,selected)];item.Select();if(selected>=0)item.ShowDropDown();}));}
            };
            core.Settings.AreHostObjectsAllowed=false;core.Settings.AreDevToolsEnabled=ScoreBrushLauncher.DebugPort!=0;
            core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;core.Settings.IsStatusBarEnabled=false;core.Settings.IsZoomControlEnabled=false;
            core.NavigationStarting+=(s,e)=>{if(!Trusted(e.Uri)||ready&&!ScoreBrushLauncher.Test){blockedNavigations.Add(e.NavigationId);e.Cancel=true;}};
            core.FrameNavigationStarting+=(s,e)=>{e.Cancel=true;};
            core.NewWindowRequested+=(s,e)=>{e.Handled=true;};
            core.PermissionRequested+=(s,e)=>{
                if(!Trusted(e.Uri)){e.State=CoreWebView2PermissionState.Deny;return;}
                // Native selected handles already have their scoped grant. Other
                // file workflows keep the runtime's permission checks unchanged.
                if(e.PermissionKind==CoreWebView2PermissionKind.FileReadWrite)return;
                e.SavesInProfile=false;e.Handled=true;
                if(e.PermissionKind==CoreWebView2PermissionKind.ClipboardRead) e.State=e.IsUserInitiated&&MessageBox.Show(this,"Allow ScoreBrush to read the clipboard for this action?","Clipboard",MessageBoxButtons.YesNo)==DialogResult.Yes?CoreWebView2PermissionState.Allow:CoreWebView2PermissionState.Deny;
                else e.State=CoreWebView2PermissionState.Deny;
            };
            core.DownloadStarting+=(s,e)=>{
                if(!Trusted(core.Source)||!e.DownloadOperation.Uri.StartsWith("blob:"+ScoreBrushLauncher.Origin+"/",StringComparison.Ordinal)){e.Cancel=true;return;}
                var operation=e.DownloadOperation;downloads.Add(operation);
                operation.StateChanged+=(sender,ev)=>{if(operation.State!=CoreWebView2DownloadState.InProgress)downloads.Remove(operation);};
            };
            core.WebMessageReceived+=Message;
            core.ProcessFailed+=(s,e)=>HandleProcessFailure(e.ProcessFailedKind);
            core.NavigationCompleted+=async(s,e)=>{
                // A deliberately rejected navigation can complete much later.
                // It must not open a modal inside WebView2's event callback and
                // prevent delivery of a subsequent save/close acknowledgement.
                if(blockedNavigations.Remove(e.NavigationId))return;
                if(!e.IsSuccess){startupProgress.Visible=false;startupStatus.Text="ScoreBrush could not load its local app: "+e.WebErrorStatus+". Your saved profile is unchanged. Reopen the complete extracted app.";loading.Visible=true;loading.BringToFront();return;}
                if(!Trusted(core.Source))return;
                if(await core.ExecuteScriptAsync("Boolean(window.scoreBrushStartup)")!="true"){
                    startupProgress.Visible=false;startupStatus.Text="A required startup file could not load. Extract the complete review ZIP and reopen ScoreBrush. Your saved profile is unchanged.";loading.Visible=true;loading.BringToFront();return;
                }
                await core.ExecuteScriptAsync("window.dispatchEvent(new Event('scorebrush-desktop-host'))");
            };
            core.Navigate(ScoreBrushLauncher.Origin+"/index.html");
        } catch(OperationCanceledException) { }
        catch(Exception e) {if(!IsDisposed&&!startupCancel.IsCancellationRequested){startupProgress.Visible=false;startupStatus.Text="ScoreBrush could not start. Your saved work is unchanged.\n\n"+e.Message+"\n\nDetails: 0x"+unchecked((uint)e.HResult).ToString("X8");startupRetry.Visible=true;if(evergreen!=null)evergreen.Record("Startup failed: "+e.Message);}}
        finally {initializing=false;}
    }
    async Task Script(string script) {if(view.CoreWebView2!=null&&Trusted(view.CoreWebView2.Source))await view.CoreWebView2.ExecuteScriptAsync(script);}
    void HandleProcessFailure(CoreWebView2ProcessFailedKind kind) {
        // GPU/utility exits, subframe failures and an unresponsive renderer do
        // not mean the main document is gone. Keep its save/close handshake,
        // including the timeout that refuses to close an unresponsive review.
        if(kind!=CoreWebView2ProcessFailedKind.BrowserProcessExited&&kind!=CoreWebView2ProcessFailedKind.RenderProcessExited)return;
        if(approved||IsDisposed||mainDocumentLost)return;
        mainDocumentLost=true;ready=false;RefreshMenu();
        // Leave the WebView2 callback before opening any modal dialog.
        BeginInvoke((Action)(()=>{
            if(IsDisposed||approved||!mainDocumentLost)return;
            MessageBox.Show(this,"The review process stopped. Changes that had not reached storage may already be lost. Close and reopen ScoreBrush to recover durable saved work. Your profile and working folder have not been reset.\n\n"+kind,"ScoreBrush review process stopped",MessageBoxButtons.OK,MessageBoxIcon.Error);
        }));
    }
    void Message(object sender,CoreWebView2WebMessageReceivedEventArgs e) {
        if(!Trusted(e.Source)||!Trusted(view.CoreWebView2.Source))return;
        try {
            if(e.WebMessageAsJson.Length>4096)return;
            var message=ScoreBrushLauncher.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);
            // NavigationCompleted does not establish that WebView2 has painted.
            // The startup script acknowledges a rendered frame independently
            // of app readiness, so loading errors remain visible and actionable.
            if(message.Count==1&&message.ContainsKey("op")&&(string)message["op"]=="startup-painted"){loading.Visible=false;return;}
            if(message.Count==1&&message.ContainsKey("op")&&(string)message["op"]=="ready"){ready=true;mainDocumentLost=false;RefreshMenu();return;}
            if(ready&&!closing&&message.ContainsKey("id")&&message["id"] is string&&System.Text.RegularExpressions.Regex.IsMatch((string)message["id"],"^[a-f0-9]{32}$")&&message.ContainsKey("op")) {
                string id=(string)message["id"],op=message["op"] as string;
                if(NativeRepositoryLink.IsRequest(message)){
                    BeginInvoke((Action)(()=>{
                        if(!ready||closing||IsDisposed||!Trusted(view.CoreWebView2.Source))return;
                        string error=null;
                        try{NativeRepositoryLink.Open(message);}catch{error="Windows could not open the repository link. Check your default browser and try again.";}
                        if(Trusted(view.CoreWebView2.Source))view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="external-result",id=id,value=new {opened=error==null},error=error}));
                    }));return;
                }
                if(op=="folder-challenge"&&message.Count==2){try{FolderReply(id,folders.Challenge(),null);}catch(Exception error){FolderReply(id,null,error.Message);}return;}
                if(op=="folder-release"&&message.Count==2){folders.Release();FolderReply(id,new {released=true},null);return;}
                if(op=="folder-confirm"&&message.Count==5){try{FolderReply(id,folders.Confirm(message),null);}catch(Exception error){folders.Release();FolderReply(id,null,error.Message);}return;}
                if(op=="folder-select"&&message.Count==2||op=="folder-resume"&&message.Count==3&&message.ContainsKey("binding")&&message["binding"] is string){
                    BeginInvoke((Action)(()=>{
                        if(!ready||closing||IsDisposed||!Trusted(view.CoreWebView2.Source))return;
                        try{
                            if(CoreWebView2Environment.CompareBrowserVersions(view.CoreWebView2.Environment.BrowserVersionString,"127.0.2651.64")<0)throw new NotSupportedException("Folder access requires Microsoft WebView2 Runtime 127 or later. Allow the Stable runtime to update, then restart ScoreBrush.");
                            Action<object,string> deliver=(value,path)=>{
                                if(!Trusted(view.CoreWebView2.Source)||closing)throw new InvalidOperationException("Folder selection cancelled because the app is closing or navigating.");
                                if(path==null){FolderReply(id,value,null);return;}
                                var handle=view.CoreWebView2.Environment.CreateWebFileSystemDirectoryHandle(path,CoreWebView2FileSystemHandlePermission.ReadWrite);
                                if(!Trusted(view.CoreWebView2.Source))throw new InvalidOperationException("Folder selection cancelled.");
                                view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="folder-result",id=id,value=value,error=(string)null}),new List<object>{handle});
                            };
                            if(op=="folder-select")folders.Select(this,deliver);else folders.Resume((string)message["binding"],deliver);
                        }catch(Exception error){folders.Release();FolderReply(id,null,error is NotImplementedException?"This WebView2 runtime does not support desktop folder access. Update the Stable runtime and restart ScoreBrush.":error.Message);}
                    }));return;
                }
                if((op=="folder-open"||op=="folder-versions"||op=="folder-latest"||op=="folder-verify")&&(message.Count==7||message.Count==8)){BeginInvoke((Action)(()=>{if(!ready||closing||IsDisposed||!Trusted(view.CoreWebView2.Source))return;try{FolderReply(id,op=="folder-verify"?folders.VerifyConnection(message):op=="folder-versions"?folders.OpenVersions(message,this):op=="folder-latest"?folders.OpenLatest(message,this):folders.Open(message,this),null);}catch(Exception error){FolderReply(id,null,error.Message);}}));return;}
            }
            if(message.Count==2&&message.ContainsKey("op")&&Equals(message["op"],"menu-state")&&message.ContainsKey("items")) {
                var states=message["items"] as Dictionary<string,object>;if(states==null||states.Count!=commands.Count)return;
                foreach(var pair in states){var state=pair.Value as Dictionary<string,object>;if(!commands.ContainsKey(pair.Key)||state==null||state.Count!=2||!state.ContainsKey("enabled")||!state.ContainsKey("checked")||!(state["enabled"] is bool)||!(state["checked"] is bool))return;}
                foreach(var pair in states){var state=(Dictionary<string,object>)pair.Value;menuEnabled[pair.Key]=(bool)state["enabled"];commands[pair.Key].Checked=(bool)state["checked"];}
                RefreshMenu();return;
            }
            if(message.Count!=6||closeReply==null||!closing||!message.ContainsKey("op")||!Equals(message["op"],"close-result")||!message.ContainsKey("token")||!Equals(message["token"],closeToken))return;
            if(!(message["local"] is bool)||!(message["folder"] is bool)||!(message["idle"] is bool)||!(message["error"] is string))return;
            closeReply.TrySetResult(message);
        } catch { }
    }
    void FolderReply(string id,object value,string error){if(view.CoreWebView2!=null&&Trusted(view.CoreWebView2.Source))view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="folder-result",id=id,value=value,error=error}));}
    async void OnClosing(object sender,FormClosingEventArgs e) {
        if(!ready&&!mainDocumentLost){startupCancel.Cancel();approved=true;return;}
        if(approved)return;e.Cancel=true;if(closing)return;closing=true;RefreshMenu();
        try {
            if(!ready){
                if(MessageBox.Show(this,mainDocumentLost?"The review process has stopped. Changes that had not reached storage may already be lost. Close and reopen to recover durable saved work?":"The app has not finished starting. Close this window? Saved work will remain unchanged.","Close ScoreBrush",MessageBoxButtons.OKCancel)!=DialogResult.OK)return;
                approved=true;
            } else {
                closeToken=Guid.NewGuid().ToString("N");closeReply=new TaskCompletionSource<Dictionary<string,object>>();
                view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="prepare-close",token=closeToken}));
                if(await Task.WhenAny(closeReply.Task,Task.Delay(45000))!=closeReply.Task){MessageBox.Show(this,"Saving is still running or the app did not respond. Keep ScoreBrush open and try again when saving finishes. No forced shutdown occurred.","Waiting for saves");return;}
                var result=await closeReply.Task;
                if(downloads.Count>0){MessageBox.Show(this,"Finish or cancel the backup download before closing ScoreBrush.","Backup in progress");return;}
                if((bool)result["local"]&&(bool)result["folder"]&&(bool)result["idle"])approved=true;
                else {
                    string action=CloseChoice((string)result["error"],(bool)result["local"]&&(bool)result["idle"]);
                    if(action=="local")approved=true;
                    else if(action=="backup")await Script("window.scoreBrushDesktop.backup()");
                    else if(action=="retry"){BeginInvoke((Action)(()=>Close()));}
                }
            }
        } catch(Exception error){MessageBox.Show(this,"Closing was cancelled: "+error.Message+"\nYour profile has not been reset.","Save before closing");}
        finally {
            try {if(!approved&&view.CoreWebView2!=null&&Trusted(view.CoreWebView2.Source))view.CoreWebView2.PostWebMessageAsJson(ScoreBrushLauncher.Json.Serialize(new {op="cancel-close",token=closeToken}));}catch { /* A failed runtime cannot acknowledge cancellation; keep the window. */ }
            closeReply=null;closing=false;RefreshMenu();if(approved)BeginInvoke((Action)(()=>Close()));
        }
    }
    string CloseChoice(string error,bool local) {
        string choice="cancel";
        using(var dialog=new Form {Text="Save before closing",Width=620,Height=260,StartPosition=FormStartPosition.CenterParent,FormBorderStyle=FormBorderStyle.FixedDialog,MinimizeBox=false,MaximizeBox=false}) {
            dialog.Controls.Add(new Label {Text=(String.IsNullOrEmpty(error)?"Some work is still pending.":error)+"\n\n"+(local?"The exact current review has been read back from local storage. You may close with that local copy; folder saving remains unfinished.":"The current work has not been verified in local storage. Keep the window open, retry, or save a backup."),Dock=DockStyle.Fill,Padding=new Padding(16)});
            var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=75,Padding=new Padding(10)};
            foreach(string value in new[]{"retry","backup","cancel","local"}) {if(value=="local"&&!local)continue;string action=value;var button=new Button {AutoSize=true,Text=value=="retry"?"Retry saves":value=="backup"?"Save backup":value=="cancel"?"Cancel closing":"Close using local copy"};button.Click+=(s,e)=>{choice=action;dialog.Close();};buttons.Controls.Add(button);}
            dialog.Controls.Add(buttons);buttons.BringToFront();dialog.ShowDialog(this);
        }return choice;
    }
    void Cleanup() {startupCancel.Cancel();signals.Stop();folders.Dispose();view.Dispose();if(evergreen!=null)evergreen.Dispose();}
}
