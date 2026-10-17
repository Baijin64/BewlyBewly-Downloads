using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

public sealed class NodeRelease
{
    public string version, filename, sha256;
    public string url { get { return "https://nodejs.org/dist/v" + version + "/" + filename; } }
}

public static class NodeInstaller
{
    public const string DownloadPage = "https://nodejs.org/zh-cn/download";
    const string Checksums = "https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt";
    public static NodeRelease ParseRelease(string checksums)
    {
        var match = Regex.Match(checksums, @"(?m)^([0-9a-fA-F]{64})\s+(node-v(24\.\d+\.\d+)-x64\.msi)\r?$");
        if (!match.Success) throw new IOException("官方发布清单没有可用的 Node.js 24 x64 安装程序。");
        return new NodeRelease { version = match.Groups[3].Value, filename = match.Groups[2].Value, sha256 = match.Groups[1].Value.ToLowerInvariant() };
    }
    static HttpWebRequest Request(string url)
    {
        var address = new Uri(url);
        if (address.Scheme != "https" || address.Host != "nodejs.org" || !address.IsDefaultPort) throw new IOException("安装程序地址无效。");
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        var request = (HttpWebRequest)WebRequest.Create(address);
        request.AllowAutoRedirect = false; request.Timeout = 20000; request.ReadWriteTimeout = 20000;
        request.UserAgent = "BewlyDownload-Setup/0.2.8";
        return request;
    }
    public static async Task<NodeRelease> Release(CancellationToken cancellation)
    {
        var request = Request(Checksums);
        using (cancellation.Register(request.Abort))
        using (var response = (HttpWebResponse)await request.GetResponseAsync())
        using (var stream = response.GetResponseStream())
        using (var memory = new MemoryStream()) {
            if (response.StatusCode != HttpStatusCode.OK || response.ContentLength > 128 * 1024) throw new IOException("官方发布清单响应无效。");
            byte[] buffer = new byte[4096]; int read;
            while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0) { if (memory.Length + read > 128 * 1024) throw new IOException("官方发布清单过大。"); memory.Write(buffer, 0, read); }
            cancellation.ThrowIfCancellationRequested();
            return ParseRelease(System.Text.Encoding.UTF8.GetString(memory.ToArray()));
        }
    }
    public static async Task Download(NodeRelease release, string destination, IProgress<int> progress, CancellationToken cancellation)
    {
        var request = Request(release.url);
        using (cancellation.Register(request.Abort))
        using (var response = (HttpWebResponse)await request.GetResponseAsync())
        using (var source = response.GetResponseStream())
        using (var target = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            const long limit = 128 * 1024 * 1024;
            if (response.StatusCode != HttpStatusCode.OK || response.ContentLength <= 0 || response.ContentLength > limit) throw new IOException("安装程序响应大小无效。");
            byte[] buffer = new byte[65536]; int read; long total = 0;
            while ((read = await source.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0) {
                total += read; if (total > response.ContentLength || total > limit) throw new IOException("安装程序大小无效。");
                await target.WriteAsync(buffer, 0, read, cancellation);
                if (progress != null) progress.Report((int)(total * 100 / response.ContentLength));
            }
            if (total != response.ContentLength) throw new IOException("安装程序下载不完整，请重试。");
        }
        cancellation.ThrowIfCancellationRequested();
        await Task.Run(() => Verify(destination, release.sha256), cancellation);
    }
    public static void Verify(string file, string expectedHash)
    {
        using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) {
            string actual = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
            if (!string.Equals(actual, expectedHash, StringComparison.OrdinalIgnoreCase)) throw new IOException("Node.js 安装程序校验失败，请重试。");
        }
        if (SignatureStatus(file) != 0) throw new IOException("Node.js 安装程序的 Windows 数字签名验证失败。");
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    sealed class TrustFile { public uint size = (uint)Marshal.SizeOf(typeof(TrustFile)); public IntPtr path, file, subject; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    sealed class TrustData {
        public uint size = (uint)Marshal.SizeOf(typeof(TrustData)); public IntPtr policy, sip;
        public uint ui = 2, revocation, choice = 1; public IntPtr file;
        public uint action = 1; public IntPtr state, url; public uint flags, context;
    }
    [DllImport("wintrust.dll", ExactSpelling = true)] static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, [In, Out] TrustData data);
    static int SignatureStatus(string file)
    {
        var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        var info = new TrustFile { path = Marshal.StringToHGlobalUni(file) };
        var data = new TrustData { file = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile))) };
        try { Marshal.StructureToPtr(info, data.file, false); return WinVerifyTrust(new IntPtr(-1), ref action, data); }
        finally { data.action = 2; WinVerifyTrust(new IntPtr(-1), ref action, data); Marshal.FreeHGlobal(data.file); Marshal.FreeHGlobal(info.path); }
    }
    public static bool SuccessfulExit(int code) { return code == 0 || code == 3010 || code == 1641; }
    public static string TemporaryDirectory()
    {
        string directory = Path.Combine(Path.GetTempPath(), "bewly-node-setup-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory); return directory;
    }
    public static void Clean(string directory)
    {
        if (directory == null) return;
        string absolute = Path.GetFullPath(directory);
        if (!string.Equals(Path.GetDirectoryName(absolute).TrimEnd(Path.DirectorySeparatorChar), Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(absolute).StartsWith("bewly-node-setup-", StringComparison.Ordinal)) throw new IOException("安装缓存目录无效。");
        if ((File.GetAttributes(absolute) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装缓存目录类型无效。");
        // Only remove the file created by this installer; leave unknown contents.
        foreach (string file in Directory.GetFiles(absolute, "node-v24.*-x64.msi")) File.Delete(file);
        if (Directory.GetFileSystemEntries(absolute).Length == 0) Directory.Delete(absolute);
    }
    public static async Task<object> CheckDownload()
    {
        string directory = TemporaryDirectory();
        try {
            var release = await Release(CancellationToken.None);
            string file = Path.Combine(directory, release.filename);
            await Download(release, file, null, CancellationToken.None);
            return new { version = release.version, url = release.url, bytes = new FileInfo(file).Length, sha256 = release.sha256, signatureVerified = true, installed = false };
        } finally { Clean(directory); }
    }
}

public sealed class NodeSetupForm : Form
{
    readonly Font ownedFont;
    readonly Icon ownedIcon;
    readonly Label message;
    readonly ProgressBar progress;
    readonly Button install, retry, cancel;
    CancellationTokenSource cancellation;
    bool busy, installing;
    public NodeSetupForm(string reason)
    {
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96, 96); AutoScaleMode = AutoScaleMode.Dpi;
        ownedFont = new Font(SystemFonts.MessageBoxFont.FontFamily, 10); Font = ownedFont;
        ownedIcon = new Icon(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Assets", "BewlyDownload.ico"), SystemInformation.SmallIconSize); Icon = ownedIcon;
        Text = "准备本地下载环境"; ClientSize = new Size(470, 235); StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
        bool dark = DesktopUi.DarkApps(); BackColor = dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(250, 250, 250); ForeColor = dark ? Color.WhiteSmoke : Color.FromArgb(32, 32, 32);
        message = new Label { Text = reason + "\n\n点击后将从 Node.js 官网下载并安装。Windows 可能请求安装授权；不会重复安装已兼容的版本。", AutoSize = false, Left = 24, Top = 20, Width = 422, Height = 105 };
        progress = new ProgressBar { Left = 24, Top = 135, Width = 422, Height = 8, Visible = false };
        install = new Button { Text = "下载并安装 Node.js", Left = 24, Top = 163, Width = 178, Height = 36, FlatStyle = FlatStyle.Flat, BackColor = TrayArtwork.Accent, ForeColor = Color.White };
        retry = new Button { Text = "重新检测", Left = 214, Top = 163, Width = 106, Height = 36 };
        cancel = new Button { Text = "稍后", Left = 332, Top = 163, Width = 114, Height = 36 };
        var manual = new LinkLabel { Text = "打开 Node.js 官网", Left = 24, Top = 209, AutoSize = true, LinkColor = TrayArtwork.Accent };
        manual.LinkClicked += (s, e) => Process.Start(new ProcessStartInfo(NodeInstaller.DownloadPage) { UseShellExecute = true });
        install.Click += Install; retry.Click += async (s, e) => await Recheck();
        cancel.Click += (s, e) => { if (busy) { if (!installing) cancellation.Cancel(); } else Close(); };
        FormClosing += (s, e) => { if (busy) { e.Cancel = true; if (!installing) cancellation.Cancel(); } };
        Controls.AddRange(new Control[] { message, progress, install, retry, cancel, manual });
        ResumeLayout(false); PerformLayout();
    }
    protected override void Dispose(bool disposing) { base.Dispose(disposing); if (disposing) { ownedFont.Dispose(); ownedIcon.Dispose(); } }
    public static object ExportPreview(string file)
    {
        DesktopUi.Initialize();
        if (!Path.IsPathRooted(file)) throw new ArgumentException("预览需要绝对路径");
        using (var form = new NodeSetupForm("未找到系统 Node.js，需要 Node.js 24 或更新的 x64 版本。")) {
            var handle = form.Handle; form.PerformAutoScale(); form.PerformLayout();
            bool fits = true; foreach (Control control in form.Controls) if (!form.ClientRectangle.Contains(control.Bounds)) fits = false;
            // Render the client controls without showing or capturing a window.
            using (var image = new Bitmap(form.ClientSize.Width, form.ClientSize.Height)) using (var stream = new FileStream(file, FileMode.CreateNew, FileAccess.Write)) {
                using (var graphics = Graphics.FromImage(image)) graphics.Clear(form.BackColor);
                foreach (Control control in form.Controls) if (!(control is ProgressBar)) { var childHandle = control.Handle; control.DrawToBitmap(image, control.Bounds); }
                image.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
            }
            return new { dpi = form.DeviceDpi, width = form.Width, height = form.Height, allControlsFit = fits };
        }
    }
    async Task Recheck()
    {
        install.Enabled = retry.Enabled = false;
        try { var runtime = await Task.Run(() => NodeRuntime.Resolve()); if (IsDisposed) return; if (runtime.ready) { DialogResult = DialogResult.OK; Close(); } else message.Text = runtime.reason; }
        finally { if (!IsDisposed) install.Enabled = retry.Enabled = true; }
    }
    async void Install(object sender, EventArgs args)
    {
        if (busy) return;
        busy = true; install.Enabled = retry.Enabled = false; cancel.Text = "取消下载";
        cancellation = new CancellationTokenSource(); string directory = null;
        try {
            var existing = await Task.Run(() => NodeRuntime.Resolve());
            if (existing.ready) { busy = false; DialogResult = DialogResult.OK; Close(); return; }
            message.Text = "正在获取 Node.js 官方安装程序…"; progress.Visible = true; progress.Value = 0;
            var release = await NodeInstaller.Release(cancellation.Token);
            directory = NodeInstaller.TemporaryDirectory(); string file = Path.Combine(directory, release.filename);
            message.Text = "正在下载 Node.js " + release.version + "…";
            await NodeInstaller.Download(release, file, new Progress<int>(value => { if (!IsDisposed) progress.Value = value; }), cancellation.Token);
            cancellation.Token.ThrowIfCancellationRequested();
            installing = true; cancel.Enabled = false;
            message.Text = "正在安装 Node.js，请完成 Windows 的安装授权。安装后会自动重新检测。";
            int code = await Task.Run(() => {
                using (var process = Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "msiexec.exe"), "/i \"" + file + "\" /passive /norestart") { UseShellExecute = true, Verb = "runas" })) { process.WaitForExit(); return process.ExitCode; }
            });
            if (code == 1602) { message.Text = "安装已取消，可以稍后重新安装。"; return; }
            if (!NodeInstaller.SuccessfulExit(code)) throw new IOException("Node.js 安装未完成（代码 " + code + "），请重试或从官网手动安装。");
            var runtime = await Task.Run(() => NodeRuntime.Resolve());
            if (!runtime.ready) { message.Text = code == 3010 || code == 1641 ? "Node.js 已安装，请按 Windows 提示重启后重新打开助手。" : runtime.reason; return; }
            busy = false; DialogResult = DialogResult.OK; Close();
        }
        catch (Exception error) {
            if (!IsDisposed) message.Text = cancellation.IsCancellationRequested || error is OperationCanceledException || error is Win32Exception && ((Win32Exception)error).NativeErrorCode == 1223 ? "下载或安装已取消。" : "未能安装：" + error.Message + "\n可重试，或打开官网手动安装。";
        }
        finally {
            try { NodeInstaller.Clean(directory); } catch { }
            busy = installing = false; cancellation.Dispose();
            if (!IsDisposed) { install.Enabled = retry.Enabled = cancel.Enabled = true; cancel.Text = "稍后"; progress.Visible = false; }
        }
    }
}
