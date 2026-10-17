using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32;

public sealed class NodeRuntimeStatus
{
    public bool ready;
    public string executable, version, architecture, reason;
}

public static class NodeRuntime
{
    const string ProbeCode = "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.prepare('SELECT 1').get();db.close();console.log(JSON.stringify({version:process.versions.node,architecture:process.arch,fetch:typeof fetch==='function',abort:typeof AbortSignal.timeout==='function'}))";
    public static NodeRuntimeStatus Resolve()
    {
        string configured = Environment.GetEnvironmentVariable("BEWLY_NODE_PATH");
        if (configured != null) return Probe(configured);
        var candidates = new List<string>();
        // Registry and live PATH values also find Node installed after the browser
        // started; restarting Edge is not required just to refresh its environment.
        foreach (var hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
            try { using (var root = RegistryKey.OpenBaseKey(hive, view)) using (var key = root.OpenSubKey(@"SOFTWARE\Node.js")) {
                string install = key == null ? null : key.GetValue("InstallPath") as string;
                if (!string.IsNullOrEmpty(install)) candidates.Add(Path.Combine(install, "node.exe"));
            } } catch { }
        }
        foreach (var scope in new[] { EnvironmentVariableTarget.User, EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.Process }) {
            string paths = Environment.GetEnvironmentVariable("PATH", scope) ?? "";
            foreach (string value in paths.Split(';')) {
                try {
                    string folder = Environment.ExpandEnvironmentVariables(value.Trim().Trim('"'));
                    if (Path.IsPathRooted(folder)) candidates.Add(Path.Combine(folder, "node.exe"));
                } catch { }
            }
        }
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        NodeRuntimeStatus last = null;
        var elapsed = Stopwatch.StartNew(); int attempted = 0;
        foreach (string candidate in candidates.Distinct(StringComparer.OrdinalIgnoreCase)) {
            if (!File.Exists(candidate)) continue;
            if (attempted++ >= 8 || elapsed.ElapsedMilliseconds > 7000) break;
            last = Probe(candidate);
            if (last.ready) return last;
        }
        return last ?? new NodeRuntimeStatus { ready = false, reason = "未找到系统 Node.js。请从开始菜单打开 Bewly 下载助手，点击下载并安装 Node.js 后重新连接。" };
    }
    static NodeRuntimeStatus Probe(string candidate)
    {
        var result = new NodeRuntimeStatus { ready = false, reason = "需要 Node.js 24 或更新的 x64 版本。请从开始菜单打开 Bewly 下载助手，点击下载并安装 Node.js 后重新连接。" };
        try {
            if (!Path.IsPathRooted(candidate) || Path.GetPathRoot(candidate).Length < 3 || candidate.StartsWith(@"\\") || !string.Equals(Path.GetFileName(candidate), "node.exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate)) return result;
            string executable = Path.GetFullPath(candidate);
            var start = new ProcessStartInfo(executable, "--no-warnings -e \"" + ProbeCode + "\"") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
            Sanitize(start);
            using (var process = Process.Start(start)) {
                process.StandardInput.Close();
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                if (!process.WaitForExit(3500)) { try { process.Kill(); } catch { } return result; }
                if (process.ExitCode != 0 || output.Result.Length > 4096) return result;
                var info = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(output.Result);
                Version version;
                string text = Convert.ToString(info["version"]), arch = Convert.ToString(info["architecture"]);
                result.version = text; result.architecture = arch;
                if (!Version.TryParse(text, out version) || version.Major < 24 || arch != "x64" || !Convert.ToBoolean(info["fetch"]) || !Convert.ToBoolean(info["abort"])) return result;
                result.ready = true; result.executable = executable; result.reason = null;
            }
        } catch { }
        return result;
    }
    public static void Sanitize(ProcessStartInfo start)
    {
        start.EnvironmentVariables.Remove("NODE_OPTIONS");
        start.EnvironmentVariables.Remove("NODE_PATH");
    }
    public static string PrepareSupport(string root, string data)
    {
        string source = Path.Combine(root, "node_modules", "classic-level", "prebuilds", "win32-x64", "classic-level.node");
        string expected = Hash(source);
        string directory = Path.Combine(data, "support", "classic-level-" + expected);
        string destination = Path.Combine(directory, "prebuilds", "win32-x64", "classic-level.node");
        Directory.CreateDirectory(Path.GetDirectoryName(destination));
        if (!File.Exists(destination) || Hash(destination) != expected) {
            string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try { File.Copy(source, temporary); if (File.Exists(destination)) File.Replace(temporary, destination, null); else File.Move(temporary, destination); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        return directory;
    }
    static string Hash(string file) { using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
    public static string ServiceEnvironment(string executable, string root, string data, string mode = "manual")
    {
        var values = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry pair in Environment.GetEnvironmentVariables()) {
            string name = Convert.ToString(pair.Key);
            if (name.Equals("NODE_OPTIONS", StringComparison.OrdinalIgnoreCase) || name.Equals("NODE_PATH", StringComparison.OrdinalIgnoreCase)) continue;
            values[name] = Convert.ToString(pair.Value);
        }
        values["BEWLY_NODE_PATH"] = executable;
        values["BEWLY_DOWNLOAD_MODE"] = mode;
        values["CLASSIC_LEVEL_PREBUILD"] = PrepareSupport(root, data);
        return string.Join("\0", values.Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
    }
}
