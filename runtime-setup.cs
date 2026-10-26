// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Shared Evergreen discovery and one bounded, non-elevated setup attempt.
// The test harness substitutes IEvergreenRuntime; production has no fake installer switch.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;

interface IEvergreenRuntime {
    string Probe();
    Task<int> InstallAsync(CancellationToken cancel);
}

sealed class EvergreenSetup {
    readonly IEvergreenRuntime runtime;
    internal EvergreenSetup(IEvergreenRuntime runtime) {this.runtime=runtime;}
    internal async Task<string> EnsureAsync(Action<string> progress,CancellationToken cancel) {
        cancel.ThrowIfCancellationRequested();
        string version=await Task.Run(()=>runtime.Probe(),cancel);
        if(version!=null)return version;
        progress("Setting up Microsoft WebView2…\nInternet is needed for this first-time download.\nClosing stops waiting; Microsoft setup may finish in the background.");
        int code=await runtime.InstallAsync(cancel);
        cancel.ThrowIfCancellationRequested();
        // Exit code alone never proves that a usable runtime is installed.
        version=await Task.Run(()=>runtime.Probe(),cancel);
        if(version!=null)return version;
        throw new IOException("Microsoft WebView2 is still unavailable. Check your internet connection and any installation restrictions, then choose Retry.\n\nMicrosoft setup exit code: "+code+" (0x"+unchecked((uint)code).ToString("X8")+").");
    }
}

sealed class NativeEvergreenRuntime : IEvergreenRuntime, IDisposable {
    readonly string root,log;
    readonly CoreWebView2EnvironmentOptions options;
    Process installer;
    internal NativeEvergreenRuntime(string root,string log,CoreWebView2EnvironmentOptions options) {this.root=root;this.log=log;this.options=options;}
    internal void Record(string text) {try{File.AppendAllText(log,DateTime.UtcNow.ToString("o")+" "+text+Environment.NewLine);}catch{}}
    public string Probe() {
        try {
            string version=CoreWebView2Environment.GetAvailableBrowserVersionString(null,options);
            Version parsed;
            if(!Version.TryParse(version,out parsed))throw new IOException("Windows selected a browser preview channel instead of the shared Evergreen WebView2 Runtime. Ask your administrator to review the WebView2 policy for ScoreBrush.");
            if(CoreWebView2Environment.CompareBrowserVersions(version,options.TargetCompatibleBrowserVersion)<0)
                throw new IOException("The installed Microsoft WebView2 Runtime ("+version+") is older than this app supports ("+options.TargetCompatibleBrowserVersion+"). Allow Microsoft's Evergreen updater to finish, then choose Retry. ScoreBrush will not replace or modify your existing shared runtime.");
            Record("Evergreen available: "+version);return version;
        } catch(WebView2RuntimeNotFoundException) {Record("Evergreen runtime not found");return null;}
    }
    public async Task<int> InstallAsync(CancellationToken cancel) {
        cancel.ThrowIfCancellationRequested();
        if(installer==null||installer.HasExited) {
            if(installer!=null){installer.Dispose();installer=null;}
            string path=Path.Combine(root,"setup","MicrosoftEdgeWebview2Setup.exe");
            // Hold the executable against replacement from verification through launch.
            using(var held=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read)) {
                await Task.Run(()=>BootstrapperTrust.Verify(path,held),cancel);
                cancel.ThrowIfCancellationRequested();
                Record("Starting verified Microsoft bootstrapper /silent /install (no elevation requested)");
                installer=Process.Start(new ProcessStartInfo(path,"/silent /install") {UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,WorkingDirectory=Path.GetDirectoryName(path)});
                if(installer==null)throw new IOException("Windows did not start Microsoft WebView2 setup.");
            }
        } else Record("Continuing to wait for the existing setup attempt; no second installer launched");
        var elapsed=Stopwatch.StartNew();
        while(!installer.HasExited) {
            cancel.ThrowIfCancellationRequested();
            if(elapsed.Elapsed>TimeSpan.FromMinutes(5))throw new TimeoutException("Microsoft WebView2 setup is taking longer than expected. Check your connection or installation policy. Retry checks the same attempt; Close stops waiting. Microsoft setup may finish in the background.");
            await Task.Delay(250,cancel);
        }
        int code=installer.ExitCode;Record("Microsoft setup exited: "+code+" (0x"+unchecked((uint)code).ToString("X8")+")");return code;
    }
    // Do not kill shared updater/installer processes when the user closes setup.
    public void Dispose(){if(installer!=null)installer.Dispose();}

    internal static void Configure(string profile,int debugPort) {
        // Respect policy: stop on overrides that would change the app's runtime,
        // stable storage identity or no-listener contract; never edit policy keys.
        foreach(var hive in new[]{RegistryHive.LocalMachine,RegistryHive.CurrentUser})
        foreach(var view in new[]{RegistryView.Registry64,RegistryView.Registry32})
        using(var registry=RegistryKey.OpenBaseKey(hive,view))
        foreach(string setting in new[]{"BrowserExecutableFolder","UserDataFolder","AdditionalBrowserArguments","ReleaseChannels"})
        using(var key=registry.OpenSubKey(@"Software\Policies\Microsoft\Edge\WebView2\"+setting)) {
            if(key==null)continue;
            foreach(string app in new[]{"ScoreBrush.Desktop",Path.GetFileName(System.Windows.Forms.Application.ExecutablePath),"*"}) {
                string value=key.GetValue(app) as string;if(String.IsNullOrWhiteSpace(value))continue;
                bool allowed=setting=="ReleaseChannels"&&value.Trim()=="0"||setting=="UserDataFolder"&&String.Equals(value.TrimEnd('\\'),profile.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);
                if(!allowed)throw new IOException("A Windows WebView2 policy ("+setting+") conflicts with ScoreBrush's shared-runtime or local-storage requirements. Ask your administrator to review it, then choose Retry. ScoreBrush has not changed the policy.");
            }
        }
        foreach(string name in new[]{"WEBVIEW2_BROWSER_EXECUTABLE_FOLDER","WEBVIEW2_RELEASE_CHANNELS","WEBVIEW2_RELEASE_CHANNEL_PREFERENCE","WEBVIEW2_CHANNEL_SEARCH_KIND","WEBVIEW2_PIPE_FOR_SCRIPT_DEBUGGER","WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER"})Environment.SetEnvironmentVariable(name,null);
        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER",profile);
        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",debugPort==0?" ":" --remote-debugging-address=127.0.0.1 --remote-debugging-port="+debugPort);
    }
}

static class BootstrapperTrust {
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FileInfo {public uint Size;[MarshalAs(UnmanagedType.LPWStr)] public string Path;public IntPtr File,KnownSubject;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct TrustData {public uint Size;public IntPtr Policy,Client;public uint UI,Revocation,Choice;public IntPtr File;public uint Action;public IntPtr State;[MarshalAs(UnmanagedType.LPWStr)] public string URL;public uint Flags,Context;}
    [DllImport("wintrust.dll",ExactSpelling=true,CharSet=CharSet.Unicode)] static extern int WinVerifyTrust(IntPtr window,[In] ref Guid action,[In,Out] ref TrustData data);
    internal static void Verify(string path,FileStream held) {
        using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(held)).Replace("-","").ToLowerInvariant()!=RuntimePackage.BootstrapperSHA256)throw new IOException("The Microsoft WebView2 setup file failed its integrity check. Extract a complete, trusted ScoreBrush ZIP and retry.");
        var file=new FileInfo {Size=(uint)Marshal.SizeOf(typeof(FileInfo)),Path=path,File=held.SafeFileHandle.DangerousGetHandle()};
        IntPtr memory=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));Marshal.StructureToPtr(file,memory,false);
        var data=new TrustData {Size=(uint)Marshal.SizeOf(typeof(TrustData)),UI=2,Revocation=1,Choice=1,File=memory,Action=1,Flags=0x80};
        var action=new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        try {
            int result=WinVerifyTrust(new IntPtr(-1),ref action,ref data);
            if(result!=0)throw new IOException("Windows could not verify Microsoft's WebView2 setup signature (0x"+unchecked((uint)result).ToString("X8")+"). Check connectivity and Windows trust policy, then choose Retry. No installer was run.");
            using(var cert=new X509Certificate2(X509Certificate.CreateFromSignedFile(path)))
                if(!String.Equals(cert.Thumbprint,RuntimePackage.BootstrapperSigner,StringComparison.OrdinalIgnoreCase))throw new IOException("The WebView2 setup publisher does not match the verified Microsoft package. No installer was run.");
        } finally {data.Action=2;WinVerifyTrust(new IntPtr(-1),ref action,ref data);Marshal.DestroyStructure(memory,typeof(FileInfo));Marshal.FreeHGlobal(memory);}
    }
}
