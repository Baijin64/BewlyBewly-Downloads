using System;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public static class NativeHost
{
    const string HostName = "io.bewly.download";
    const string ConnectorVersion = "0.2.6";
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name);
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo
    {
        public int cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, width, height, xChars, yChars, fill, flags;
        public ushort show, reservedSize;
        public IntPtr reservedBytes, input, output, error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo result);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static string Root { get { return AppDomain.CurrentDomain.BaseDirectory; } }
    static string Data { get { return Environment.GetEnvironmentVariable("BEWLY_DOWNLOAD_DATA") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "BewlyDownload"); } }
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--run-tool") return BundledTool.Run(args);
            if (args.Length == 2 && args[0] == "--node-setup-preview") {
                WriteOutput(new JavaScriptSerializer().Serialize(NodeSetupForm.ExportPreview(args[1]))); return 0;
            }
            if (args.Length > 0 && args[0] == "--check-node-installer") {
                WriteOutput(new JavaScriptSerializer().Serialize(NodeInstaller.CheckDownload().GetAwaiter().GetResult())); return 0;
            }
            if (args.Length > 0 && args[0] == "--node-release-diagnostics") {
                WriteOutput(new JavaScriptSerializer().Serialize(NodeInstaller.ParseRelease(ReadInput()))); return 0;
            }
            if (args.Length > 0 && args[0] == "--runtime-diagnostics") {
                WriteOutput(new JavaScriptSerializer().Serialize(new { connectorVersion = ConnectorVersion, runtime = NodeRuntime.Resolve() })); return 0;
            }
            if (args.Length > 0 && args[0] == "--ui-diagnostics") {
                WriteOutput(new JavaScriptSerializer().Serialize(DesktopUi.Diagnostics())); return 0;
            }
            if (args.Length == 2 && args[0] == "--tray-preview") {
                WriteOutput(new JavaScriptSerializer().Serialize(DesktopUi.ExportPreviews(args[1]))); return 0;
            }
            if (args.Length > 0 && args[0] == "--tray") return TrayHost.Run(Data);
            if (args.Length > 0 && args[0] == "--start-service")
            {
                WriteOutput(new JavaScriptSerializer().Serialize(new { pid = StartService() }));
                return 0;
            }
            if (args.Length > 0 && args[0] == "--desktop") return Desktop();
            if (args.Length > 0 && args[0] == "--open") return OpenTarget();
            if (args.Length > 0 && (args[0] == "--protect" || args[0] == "--unprotect"))
            {
                string text = ReadInput();
                if (args[0] == "--protect") WriteOutput(Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(text), null, DataProtectionScope.CurrentUser)));
                else WriteOutput(Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(text), null, DataProtectionScope.CurrentUser)));
                return 0;
            }
            if (args.Length == 0 || args[0] == "--register" || args[0] == "--unregister")
            {
                if (args.Length > 0 && args[0] == "--unregister")
                {
                    foreach (string browser in new[] { "Google\\Chrome", "Microsoft\\Edge" })
                        Registry.CurrentUser.DeleteSubKeyTree("Software\\" + browser + "\\NativeMessagingHosts\\" + HostName, false);
                }
                else Register();
                if (args.Length == 0)
                {
                    var runtime = NodeRuntime.Resolve();
                    if (!runtime.ready) {
                        DesktopUi.Initialize();
                        using (var setup = new NodeSetupForm(runtime.reason)) if (setup.ShowDialog() != DialogResult.OK) return 0;
                        runtime = NodeRuntime.Resolve();
                        if (!runtime.ready) return 0;
                    }
                    StartService(runtime.executable);
                }
                if (args.Length == 0) { DesktopUi.Initialize(); MessageBox.Show("下载助手已连接 Chrome 和 Edge。\n\n回到 BewlyBewly，点击视频上的下载按钮即可。\n下载配置和任务列表都在插件内。", "Bewly 下载助手", MessageBoxButtons.OK, MessageBoxIcon.Information); }
                return 0;
            }
            var identity = new JavaScriptSerializer().Deserialize<Identity>(File.ReadAllText(Path.Combine(Root, "identity.json")));
            if (!AllowedOrigins(identity).Contains(args[0])) return 2;
            var input = Console.OpenStandardInput();
            var output = Console.OpenStandardOutput();
            byte[] first;
            NodeRuntimeStatus runtimeStatus = null;
            // Bootstrap detection must work without Node. Ordinary requests are
            // replayed unchanged to the existing live bridge, including its ID.
            while ((first = ReadFrame(input)) != null) {
                var message = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(first));
                if (runtimeStatus == null || !runtimeStatus.ready) runtimeStatus = NodeRuntime.Resolve();
                object id = message.ContainsKey("requestId") ? message["requestId"] : null;
                if (Convert.ToString(message["method"]) == "bootstrapStatus") {
                    WriteFrame(output, new { ok = true, requestId = id, result = new { connectorVersion = ConnectorVersion, runtime = runtimeStatus } });
                    continue;
                }
                if (runtimeStatus.ready) break;
                WriteFrame(output, new { ok = false, requestId = id, code = "NODE_UNAVAILABLE", error = runtimeStatus.reason });
            }
            if (first == null) return 0;
            var start = new ProcessStartInfo(runtimeStatus.executable, "--no-warnings \"" + Path.Combine(Root, "bridge.mjs") + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            NodeRuntime.Sanitize(start);
            start.EnvironmentVariables["BEWLY_NODE_PATH"] = runtimeStatus.executable;
            start.EnvironmentVariables["CLASSIC_LEVEL_PREBUILD"] = NodeRuntime.PrepareSupport(Root, Data);
            using (var child = Process.Start(start))
            {
                byte[] prefix = BitConverter.GetBytes(first.Length);
                child.StandardInput.BaseStream.Write(prefix, 0, prefix.Length);
                child.StandardInput.BaseStream.Write(first, 0, first.Length);
                child.StandardInput.BaseStream.Flush();
                var reader = System.Threading.Tasks.Task.Run(() => {
                    try { CopyLive(input, child.StandardInput.BaseStream); }
                    finally { try { child.StandardInput.Close(); } catch {} }
                });
                var errors = child.StandardError.ReadToEndAsync();
                CopyLive(child.StandardOutput.BaseStream, output);
                output.Flush();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(error.Message + "\n");
            var output = Console.OpenStandardError();
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
            return 1;
        }
    }
    static int StartService()
    {
        var runtime = NodeRuntime.Resolve();
        if (!runtime.ready) throw new IOException(runtime.reason);
        return StartService(runtime.executable);
    }
    static int StartService(string node)
    {
        string entry = Path.Combine(Root, "service-entry.mjs");
        var command = new StringBuilder("\"" + node + "\" --no-warnings \"" + entry + "\"");
        var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), flags = 1, show = 0 };
        ProcessInfo result;
        // A long-lived daemon must never inherit the native messaging pipes.
        // Detached Node spawning alone can retain extra inheritable Win32 handles.
        IntPtr environment = Marshal.StringToHGlobalUni(NodeRuntime.ServiceEnvironment(node, Root, Data));
        try {
            if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, 0x08000608, environment, Root, ref startup, out result))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "无法启动独立下载服务");
        } finally { Marshal.FreeHGlobal(environment); }
        CloseHandle(result.thread);
        CloseHandle(result.process);
        return (int)result.pid;
    }
    static string ReadInput() { return new StreamReader(Console.OpenStandardInput(), Encoding.UTF8).ReadToEnd(); }
    static byte[] ReadFrame(Stream stream)
    {
        var header = new byte[4];
        int first = stream.ReadByte();
        if (first < 0) return null;
        header[0] = (byte)first;
        ReadExactly(stream, header, 1, 3);
        int length = BitConverter.ToInt32(header, 0);
        if (length < 1 || length > 2 * 1024 * 1024) throw new IOException("原生消息长度无效");
        var body = new byte[length]; ReadExactly(stream, body, 0, length); return body;
    }
    static void ReadExactly(Stream stream, byte[] bytes, int offset, int count)
    {
        while (count > 0) { int read = stream.Read(bytes, offset, count); if (read == 0) throw new EndOfStreamException("原生消息不完整"); offset += read; count -= read; }
    }
    static void WriteFrame(Stream output, object reply)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(reply)), prefix = BitConverter.GetBytes(bytes.Length);
        output.Write(prefix, 0, prefix.Length); output.Write(bytes, 0, bytes.Length); output.Flush();
    }
    static void WriteOutput(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        var output = Console.OpenStandardOutput();
        output.Write(bytes, 0, bytes.Length);
        output.Flush();
    }
    static int Desktop()
    {
        var json = new JavaScriptSerializer();
        var request = json.Deserialize<DesktopRequest>(ReadInput());
        string selected = null;
        DesktopUi.Initialize();
        if (request.kind == "directory")
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择下载保存目录";
                dialog.ShowNewFolderButton = true;
                if (Directory.Exists(request.path)) dialog.SelectedPath = request.path;
                if (ShowPicker(dialog) == DialogResult.OK) selected = dialog.SelectedPath;
            }
        }
        else
        {
            string filter;
            switch (request.kind)
            {
                case "audio": filter = "音频文件|*.aac;*.m4a;*.m4s;*.mp3;*.flac;*.mka;*.eac3;*.wav"; break;
                case "video": filter = "视频文件|*.m4s;*.mp4;*.mkv;*.mov"; break;
                case "cc": filter = "CC 字幕|*.json"; break;
                case "srt": filter = "SRT 字幕|*.srt"; break;
                case "legacy": filter = "Bilidown 历史|*.bilidownexport"; break;
                default: throw new ArgumentException("不支持的文件选择类型");
            }
            using (var dialog = new OpenFileDialog())
            {
                dialog.Filter = filter;
                dialog.CheckFileExists = true;
                if (ShowPicker(dialog) == DialogResult.OK) selected = dialog.FileName;
            }
        }
        WriteOutput(json.Serialize(new { path = selected, cancelled = selected == null }));
        return 0;
    }
    static DialogResult ShowPicker(CommonDialog dialog)
    {
        // The picker is launched from a background service after a browser click.
        // Give it a temporary owner so it appears above the browser.
        using (var owner = new Form { TopMost = true, ShowInTaskbar = false, Opacity = 0, Width = 1, Height = 1, StartPosition = FormStartPosition.CenterScreen })
        {
            owner.Show();
            return dialog.ShowDialog(owner);
        }
    }
    static int OpenTarget()
    {
        var request = new JavaScriptSerializer().Deserialize<DesktopRequest>(ReadInput());
        string target = Path.GetFullPath(request.path);
        if (request.kind == "folder")
        {
            if (!Directory.Exists(target)) throw new FileNotFoundException("目录不存在");
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        else
        {
            if (!File.Exists(target)) throw new FileNotFoundException("文件不存在");
            if (request.kind == "reveal") Process.Start(new ProcessStartInfo("explorer.exe", "/select,\"" + target + "\"") { UseShellExecute = true });
            else if (request.kind == "play" && new[] { ".mp4", ".mkv", ".m4a", ".mp3", ".flac", ".mka", ".aac", ".wav", ".eac3" }.Contains(Path.GetExtension(target).ToLowerInvariant()))
                Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
            else throw new ArgumentException("此文件不能作为媒体播放");
        }
        WriteOutput("{\"opened\":true}");
        return 0;
    }
    public class DesktopRequest { public string kind { get; set; } public string path { get; set; } }
    static void CopyLive(Stream input, Stream output)
    {
        var buffer = new byte[8192];
        int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, count);
            // Chrome keeps stdin open while waiting for a reply. Flush each chunk.
            output.Flush();
        }
    }
    static void Register()
    {
        Directory.CreateDirectory(Data);
        var json = new JavaScriptSerializer();
        var identity = json.Deserialize<Identity>(File.ReadAllText(Path.Combine(Root, "identity.json")));
        // MSIX updates replace versioned package paths. App execution aliases stay stable.
        string alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "BewlyDownloadHost.exe");
        uint packageNameLength = 0;
        int packageStatus = GetCurrentPackageFullName(ref packageNameLength, null);
        bool packaged = packageStatus == 0 || packageStatus == 122;
        string executable = packaged ? alias : Path.Combine(Root, "BewlyDownloadHost.exe");
        string manifest = Path.Combine(Data, "native-host.json");
        File.WriteAllText(manifest, json.Serialize(new { name = HostName, description = "Bewly local download core", path = executable, type = "stdio", allowed_origins = AllowedOrigins(identity) }), new UTF8Encoding(false));
        foreach (string browser in new[] { "Google\\Chrome", "Microsoft\\Edge" })
            using (var key = Registry.CurrentUser.CreateSubKey("Software\\" + browser + "\\NativeMessagingHosts\\" + HostName)) key.SetValue("", manifest, RegistryValueKind.String);
    }
    static string[] AllowedOrigins(Identity identity)
    {
        return new[] { identity.extensionId }.Concat(identity.legacyExtensionIds ?? new string[0]).Distinct().Select(id => "chrome-extension://" + id + "/").ToArray();
    }
    public class Identity { public string extensionId { get; set; } public string[] legacyExtensionIds { get; set; } }
}
