using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Media;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class TrayHost : ApplicationContext
{
    [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
    readonly string data;
    readonly NotifyIcon icon;
    readonly System.Windows.Forms.Timer timer;
    readonly TrayHeaderItem status;
    readonly TrayMenu menu;
    readonly Icon ownedIcon;
    readonly TrayMenuItem startItem, pauseItem, cancelItem;
    bool actionBusy, closing;
    bool polling, listenClipboard, clipboardBusy;
    uint clipboardSequence;
    int failures, completionCount = -1;
    string clipboardHash = "";
    Form countdown;
    Label countdownLabel;
    public static int Run(string data)
    {
        string hash;
        using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(data))).Replace("-", "").Substring(0, 24);
        bool created;
        using (var mutex = new Mutex(true, @"Local\BewlyDownloadTray-" + hash, out created))
        {
            if (!created) return 0;
            DesktopUi.Initialize();
            Application.Run(new TrayHost(data));
            return 0;
        }
    }
    TrayHost(string directory)
    {
        data = directory;
        ownedIcon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "BewlyDownload.ico"), SystemInformation.SmallIconSize);
        icon = new NotifyIcon { Icon = ownedIcon, Text = "Bewly 下载助手", Visible = true };
        menu = new TrayMenu(MenuCommand);
        status = menu.Status; startItem = menu.StartItem; pauseItem = menu.PauseItem; cancelItem = menu.CancelItem;
        icon.ContextMenuStrip = menu;
        icon.DoubleClick += (s, e) => OpenDownloader(false);
        timer = new System.Windows.Forms.Timer { Interval = 2000 };
        timer.Tick += Tick;
        timer.Start();
        clipboardSequence = GetClipboardSequenceNumber();
    }
    void OpenDownloader(bool settings)
    {
        Process.Start(new ProcessStartInfo("https://www.bilibili.com/?page=Downloads" + (settings ? "&downloadView=settings" : "")) { UseShellExecute = true });
    }
    void MenuCommand(string action)
    {
        if (action == "open" || action == "settings") { OpenDownloader(action == "settings"); return; }
        if (action == "exit" && MessageBox.Show("将停止本地下载并保留进度，下次打开可恢复。", "退出 Bewly 下载助手", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        Action(action);
    }
    Dictionary<string, object> Rpc(string method, object parameters)
    {
        var json = new JavaScriptSerializer();
        var descriptor = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(data, "connection.json")));
        int port = Convert.ToInt32(descriptor["port"]);
        if (port < 1 || port > 65535) throw new IOException("无效服务端口");
        var request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/rpc");
        request.Method = "POST";
        request.Proxy = null;
        request.KeepAlive = false;
        request.Timeout = method == "clipboardVideo" ? 30000 : 5000;
        request.ReadWriteTimeout = request.Timeout;
        request.ContentType = "application/json";
        request.Headers["Authorization"] = "Bearer " + Convert.ToString(descriptor["token"]);
        byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(new { method = method, @params = parameters }));
        request.ContentLength = bytes.Length;
        using (var stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
        using (var response = request.GetResponse())
        using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            var reply = json.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
            if (!Convert.ToBoolean(reply["ok"])) throw new IOException(Convert.ToString(reply["error"]));
            return reply["result"] as Dictionary<string, object> ?? new Dictionary<string, object>();
        }
    }
    async void Action(string action)
    {
        if (actionBusy || closing) return;
        actionBusy = true;
        startItem.Enabled = pauseItem.Enabled = cancelItem.Enabled = false;
        try {
            await Task.Run(() => Rpc("desktopAction", new { action = action }));
            if (action == "exit") ExitThread();
        }
        catch (Exception error) { if (!closing) icon.ShowBalloonTip(4000, "Bewly 下载助手", error.Message, ToolTipIcon.Warning); }
        finally { actionBusy = false; if (!closing) Tick(this, EventArgs.Empty); }
    }
    async void Tick(object sender, EventArgs args)
    {
        if (polling) return;
        polling = true;
        try
        {
            var result = await Task.Run(() => Rpc("desktopState", new { }));
            if (result.ContainsKey("exiting") && Convert.ToBoolean(result["exiting"])) { ExitThread(); return; }
            failures = 0;
            int pending = Convert.ToInt32(result["pending"]), active = Convert.ToInt32(result["active"]);
            status.Detail = "待下载 " + pending + " · 下载中 " + active;
            status.Invalidate();
            startItem.Enabled = pending > 0 && !actionBusy;
            pauseItem.Enabled = active > 0 && !actionBusy;
            icon.Text = "Bewly 下载助手 · 待下载 " + pending + " · 进行中 " + active;
            icon.Visible = Convert.ToBoolean(result["tray"]);
            int completed = Convert.ToInt32(result["completed"]);
            if (completionCount >= 0 && completed > completionCount && Convert.ToBoolean(result["soundTip"]))
            {
                SystemSounds.Asterisk.Play();
                icon.ShowBalloonTip(3000, "Bewly 下载助手", "下载任务已完成", ToolTipIcon.Info);
            }
            completionCount = completed;
            double due = Convert.ToDouble(result["shutdownDue"]);
            cancelItem.Enabled = due > 0 && !actionBusy;
            if (due > 0) ShowCountdown(due);
            else if (countdown != null) { countdown.Close(); countdown.Dispose(); countdown = null; }
            bool enabled = Convert.ToBoolean(result["listenClipboard"]);
            if (enabled && !listenClipboard) clipboardSequence = GetClipboardSequenceNumber();
            listenClipboard = enabled;
            if (enabled) CheckClipboard();
        }
        catch { if (++failures >= 5) ExitThread(); }
        finally { polling = false; }
    }
    void ShowCountdown(double due)
    {
        if (countdown == null)
        {
            countdown = new Form { AutoScaleMode = AutoScaleMode.Dpi, Font = SystemFonts.MessageBoxFont, Text = "下载完成 · 自动关机", Width = 380, Height = 180, StartPosition = FormStartPosition.CenterScreen, TopMost = true, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false, ControlBox = false };
            countdownLabel = new Label { Dock = DockStyle.Top, Height = 65, TextAlign = ContentAlignment.MiddleCenter };
            var cancel = new Button { Text = "取消关机", Width = 130, Height = 34, Left = 115, Top = 80 };
            cancel.Click += (s, e) => Action("cancelShutdown");
            countdown.Controls.Add(countdownLabel); countdown.Controls.Add(cancel); countdown.Show();
        }
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        countdownLabel.Text = "本轮任务已完成，将在 " + Math.Max(0, (int)Math.Ceiling((due - now) / 1000)) + " 秒后关机。";
    }
    async void CheckClipboard()
    {
        if (clipboardBusy) return;
        uint sequence = GetClipboardSequenceNumber();
        if (sequence == clipboardSequence) return;
        clipboardSequence = sequence;
        clipboardBusy = true;
        try
        {
            if (!Clipboard.ContainsText()) return;
            string text = Clipboard.GetText();
            if (text.Length > 8000) return;
            var match = Regex.Match(text, @"https?://(?:(?:www\.|m\.)?bilibili\.com/video/(?:BV[0-9A-Za-z]{10}|av[1-9]\d*)|b23\.tv/|bili2233\.(?:cn|com)/)[^\s<>""']*|(?<!\w)BV[0-9A-Za-z]{10}(?!\w)|(?<!\w)av[1-9]\d{0,15}(?!\w)");
            if (!match.Success) return;
            string candidate = match.Value, hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(candidate)));
            if (hash == clipboardHash) return;
            clipboardHash = hash;
            await Task.Run(() => Rpc("clipboardVideo", new { video = candidate }));
            icon.ShowBalloonTip(4000, "Bewly 下载助手", "剪贴板视频已加入待下载，打开下载器可开始。", ToolTipIcon.Info);
        }
        catch (Exception error) { icon.ShowBalloonTip(4000, "剪贴板视频未加入", error.Message, ToolTipIcon.Warning); }
        finally { clipboardBusy = false; }
    }
    protected override void ExitThreadCore()
    {
        closing = true;
        timer.Stop(); timer.Dispose();
        if (countdown != null) countdown.Dispose();
        icon.Visible = false; icon.ContextMenuStrip = null; icon.Dispose();
        menu.Dispose(); ownedIcon.Dispose();
        base.ExitThreadCore();
    }
}
