// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Read-only policy resolution against synthetic values. No registry or runtime
// is opened, no environment variables change, and no installer is executed.
using System;
using System.Collections.Generic;
using System.IO;
using Microsoft.Win32;

static class RuntimePackage {
    internal const string BootstrapperSHA256="unused-in-policy-tests";
    internal const string BootstrapperSigner="unused-in-policy-tests";
}
static class RuntimePolicyTests {
    const string Profile=@"C:\Synthetic\ScoreBrush\WebView2",Executable="ScoreBrush.exe",App="ScoreBrush.Desktop";
    static readonly Dictionary<string,string> values=new Dictionary<string,string>();
    static readonly List<string> reads=new List<string>();
    static int count;
    static string Key(RegistryHive hive,string setting,string app){return hive+"/"+setting+"/"+app;}
    static string Read(RegistryHive hive,string setting,string app){string key=Key(hive,setting,app),value;reads.Add(key);return values.TryGetValue(key,out value)?value:null;}
    static void Put(RegistryHive hive,string setting,string app,string value){values[Key(hive,setting,app)]=value;}
    static void Reset(){values.Clear();reads.Clear();}
    static void Check(bool ok,string text){if(!ok)throw new Exception(text);count++;Console.WriteLine("PASS "+text);}
    static void Accept(string text){NativeEvergreenRuntime.ValidatePolicies(Profile,Executable,Read);Check(true,text);}
    static void Reject(string setting,string text){try{NativeEvergreenRuntime.ValidatePolicies(Profile,Executable,Read);}catch(IOException e){Check(e.Message.Contains("("+setting+")")&&e.Message.Contains("has not changed the policy"),text);return;}throw new Exception(text+": conflicting policy was accepted");}
    static void Main(){
        Reset();Accept("absent policies preserve the ordinary startup configuration");Reset();
        Put(RegistryHive.LocalMachine,"ReleaseChannels",App,"0");
        Put(RegistryHive.LocalMachine,"ReleaseChannels",Executable,"1");
        Put(RegistryHive.LocalMachine,"ReleaseChannels","*","1,2,3");
        Put(RegistryHive.CurrentUser,"ReleaseChannels",App,"2");
        Accept("compatible machine app policy wins over executable, wildcard and user policies");
        Check(!reads.Contains(Key(RegistryHive.LocalMachine,"ReleaseChannels",Executable))&&!reads.Contains(Key(RegistryHive.CurrentUser,"ReleaseChannels",App)),"overridden release-channel entries are not consulted");
        Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels",Executable,"0");Put(RegistryHive.LocalMachine,"ReleaseChannels","*","1");Accept("executable policy wins when no app policy exists");
        Reset();Put(RegistryHive.CurrentUser,"ReleaseChannels",App,"0");Put(RegistryHive.CurrentUser,"ReleaseChannels",Executable,"3");Put(RegistryHive.CurrentUser,"ReleaseChannels","*","2");Accept("user app policy wins when machine policies are absent");
        Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels","*","0");Put(RegistryHive.CurrentUser,"ReleaseChannels",App,"1");Accept("machine wildcard takes precedence over a user app policy");
        Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels","*","1");Put(RegistryHive.CurrentUser,"ReleaseChannels",App,"0");Reject("ReleaseChannels","user app policy cannot bypass a conflicting machine wildcard");
        Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels",App,"2");Put(RegistryHive.LocalMachine,"ReleaseChannels",Executable,"0");Reject("ReleaseChannels","compatible executable cannot bypass a conflicting app policy");
        Reset();Put(RegistryHive.CurrentUser,"ReleaseChannels",Executable,"1");Put(RegistryHive.CurrentUser,"ReleaseChannels","*","0");Reject("ReleaseChannels","compatible wildcard cannot bypass a conflicting executable policy");
        Reset();Put(RegistryHive.CurrentUser,"ReleaseChannels","*","0");Accept("a compatible wildcard remains usable as the final fallback");
        foreach(string value in new[]{"1","0,1","2,0","invalid"}){Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels",App,value);Reject("ReleaseChannels","only the Stable-only channel policy is accepted: "+value);}
        Reset();Put(RegistryHive.LocalMachine,"UserDataFolder",App,Profile.ToLowerInvariant()+"\\");Put(RegistryHive.LocalMachine,"UserDataFolder",Executable,@"C:\Synthetic\Other");Accept("matching profile identity retains existing case and trailing-separator normalization");
        Reset();Put(RegistryHive.LocalMachine,"UserDataFolder","*",@"C:\Synthetic\Ignored");Accept("UserDataFolder wildcard is ignored as documented by WebView2");
        Check(!reads.Contains(Key(RegistryHive.LocalMachine,"UserDataFolder","*")),"UserDataFolder never queries a wildcard value");
        Reset();Put(RegistryHive.LocalMachine,"UserDataFolder","*",@"C:\Synthetic\Ignored");Put(RegistryHive.CurrentUser,"UserDataFolder",App,@"C:\Synthetic\Other");Reject("UserDataFolder","ignored profile wildcard cannot suppress a conflicting supported user policy");
        foreach(string setting in new[]{"BrowserExecutableFolder","AdditionalBrowserArguments"}){Reset();Put(RegistryHive.LocalMachine,setting,App,setting=="BrowserExecutableFolder"?@"C:\Synthetic\Runtime":"--remote-debugging-port=9222");Reject(setting,"effective "+setting+" override remains blocked");}
        Reset();Put(RegistryHive.LocalMachine,"ReleaseChannels",App,"0");Put(RegistryHive.CurrentUser,"UserDataFolder",App,@"C:\Synthetic\Other");Reject("UserDataFolder","effective values are resolved independently for each setting");
        bool failed=false;try{NativeEvergreenRuntime.ValidatePolicies(Profile,Executable,(h,s,a)=>{throw new UnauthorizedAccessException("SYNTHETIC denied policy read");});}catch(UnauthorizedAccessException){failed=true;}Check(failed,"policy read failures remain fail-closed");
        Console.WriteLine("Runtime policy checks: "+count);
    }
}
