using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class BundledTool
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit { public long perProcess, perJob; public uint flags; public UIntPtr minimum, maximum; public uint active; public UIntPtr affinity; public uint priority, scheduling; }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong readOperations, writeOperations, otherOperations, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit { public BasicLimit basic; public IoCounters io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob; }
    static string Quote(string value)
    {
        var text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { text.Append('\\', slashes * 2 + 1); text.Append('"'); }
            else { text.Append('\\', slashes); text.Append(c); }
            slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Run(string[] args)
    {
        if (args.Length < 2 || (args[1] != "aria2c" && args[1] != "ffmpeg")) throw new ArgumentException("不支持的本地工具");
        string binary = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "bin", args[1] + ".exe");
        var command = new StringBuilder();
        for (int n = 2; n < args.Length; n++) { if (n > 2) command.Append(' '); command.Append(Quote(args[n])); }
        // The packaged connector keeps package identity when launching bundled
        // tools; system Node itself cannot execute these WindowsApps resources.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new IOException("无法创建本地工具进程组");
        try {
            var limits = new ExtendedLimit { basic = new BasicLimit { flags = 0x2000 } };
            if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit)))) throw new IOException("无法管理本地工具进程");
            var start = new ProcessStartInfo(binary, command.ToString()) { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
            using (var child = Process.Start(start)) {
                child.StandardInput.Close();
                if (!AssignProcessToJobObject(job, child.Handle) && !child.HasExited) { child.Kill(); throw new IOException("无法管理本地工具进程组"); }
                var output = Task.Run(() => Copy(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
                var error = Task.Run(() => Copy(child.StandardError.BaseStream, Console.OpenStandardError()));
                child.WaitForExit(); Task.WaitAll(output, error); return child.ExitCode;
            }
        } finally { CloseHandle(job); }
    }
    static void Copy(Stream source, Stream target) { var bytes = new byte[16384]; int read; while ((read = source.Read(bytes, 0, bytes.Length)) > 0) { target.Write(bytes, 0, read); target.Flush(); } }
}
