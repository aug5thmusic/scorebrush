// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Auggie (@aug5thmusic).
// Additional permissions: see LICENSING.md at the source root.
// Local host preference only. No browser command can read or choose this file.
using System;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Windows.Forms;

sealed class WindowPlacement {
    public int Version {get;set;}
    public int X {get;set;}
    public int Y {get;set;}
    public int Width {get;set;}
    public int Height {get;set;}
    public bool Maximized {get;set;}
    internal Rectangle Bounds {get{return new Rectangle(X,Y,Width,Height);}set{X=value.X;Y=value.Y;Width=value.Width;Height=value.Height;}}
    internal static Rectangle Fit(Rectangle bounds,Rectangle area) {
        int width=Math.Min(area.Width,Math.Max(900,bounds.Width)),height=Math.Min(area.Height,Math.Max(620,bounds.Height));
        return new Rectangle((int)Math.Max(area.Left,Math.Min((long)bounds.X,(long)area.Right-width)),(int)Math.Max(area.Top,Math.Min((long)bounds.Y,(long)area.Bottom-height)),width,height);
    }
    internal static WindowPlacement Read(string file,Rectangle area) {
        try {
            if(new FileInfo(file).Length<=4096){var saved=new JavaScriptSerializer().Deserialize<WindowPlacement>(File.ReadAllText(file));
                if(saved!=null&&saved.Version==1&&saved.Width>0&&saved.Height>0&&saved.Width<=100000&&saved.Height<=100000&&Math.Abs((long)saved.X)<=100000&&Math.Abs((long)saved.Y)<=100000)return saved;
            }
        } catch(Exception) { /* Missing or invalid preferences never block startup. */ }
        var initial=new Rectangle(area.Left+(area.Width-1440)/2,area.Top+(area.Height-980)/2,1440,980);
        return new WindowPlacement {Version=1,Bounds=Fit(initial,area),Maximized=true};
    }
    internal bool Save(string file) {
        string temporary=file+".tmp";
        try {
            File.WriteAllText(temporary,new JavaScriptSerializer().Serialize(this));
            if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);
            return true;
        } catch(Exception) {return false;}
        finally {try{if(File.Exists(temporary))File.Delete(temporary);}catch(Exception){}}
    }
}

sealed class DesktopPlacement : IDisposable {
    readonly Form window;
    readonly string file;
    readonly Timer timer=new Timer {Interval=350};
    readonly WindowPlacement saved;
    bool started,adjusting;
    internal bool Maximized {get{return saved.Maximized;}}
    internal DesktopPlacement(Form form,string profile) {
        window=form;file=Path.Combine(profile,"scorebrush-window.json");
        saved=WindowPlacement.Read(file,Screen.PrimaryScreen.WorkingArea);
        RestoreArea();window.StartPosition=FormStartPosition.Manual;
        window.WindowState=saved.Maximized?FormWindowState.Maximized:FormWindowState.Normal;
        timer.Tick+=(s,e)=>{timer.Stop();Capture();saved.Save(file);};
        window.Shown+=(s,e)=>{started=true;Changed(s,e);};
        window.LocationChanged+=Changed;window.SizeChanged+=Changed;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged+=ScreenChanged;
        Microsoft.Win32.SystemEvents.UserPreferenceChanged+=ScreenChanged;
    }
    void RestoreArea() {
        var area=Screen.FromRectangle(saved.Bounds).WorkingArea;
        window.MinimumSize=new Size(Math.Min(900,area.Width),Math.Min(620,area.Height));
        saved.Bounds=WindowPlacement.Fit(saved.Bounds,area);window.Bounds=saved.Bounds;
    }
    void Capture() {
        if(!started||adjusting||window.WindowState==FormWindowState.Minimized)return;
        saved.Maximized=window.WindowState==FormWindowState.Maximized;
        var bounds=saved.Maximized?window.RestoreBounds:window.Bounds;
        if(bounds.Width>0&&bounds.Height>0)saved.Bounds=bounds;
    }
    void Changed(object sender,EventArgs e) {if(!started||adjusting)return;timer.Stop();Capture();timer.Start();}
    void ScreenChanged(object sender,EventArgs e) {
        if(!started||window.IsDisposed||!window.IsHandleCreated)return;
        window.BeginInvoke((Action)(()=>{
            if(window.IsDisposed)return;
            // Restore normal bounds as well as the maximized surface after a
            // monitor disconnect, resolution change, or changed taskbar area.
            Capture();adjusting=true;
            try {var state=window.WindowState;window.WindowState=FormWindowState.Normal;RestoreArea();window.WindowState=state;}
            finally {adjusting=false;Changed(this,EventArgs.Empty);}
        }));
    }
    public void Dispose() {
        timer.Stop();Capture();if(started)saved.Save(file);timer.Dispose();
        window.LocationChanged-=Changed;window.SizeChanged-=Changed;
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged-=ScreenChanged;
        Microsoft.Win32.SystemEvents.UserPreferenceChanged-=ScreenChanged;
    }
}
