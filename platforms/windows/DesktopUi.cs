using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Win32;

#if NETFRAMEWORK
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]
#endif

public sealed class DesktopUiDiagnostics
{
    public bool perMonitorV2 { get; set; }
    public uint systemDpi { get; set; }
    public int controlDpi { get; set; }
    public float renderDpi { get; set; }
    public bool darkApps { get; set; }
    public bool highContrast { get; set; }
    public int menuWidth { get; set; }
    public int menuHeight { get; set; }
    public bool allItemsFit { get; set; }
    public int menuItemCount { get; set; }
}

public static class DesktopUi
{
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] static extern uint GetDpiForSystem();
    static bool initialized;
    public static void Initialize()
    {
        if (initialized) return;
        initialized = true;
        // Set awareness before creating any window. The Framework configuration
        // also enables WinForms' dynamic, per-monitor layout support.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
    }
    public static bool DarkApps()
    {
        try { using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")) return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0; }
        catch { return false; }
    }
    public static DesktopUiDiagnostics Diagnostics()
    {
        Initialize();
        using (var menu = new TrayMenu()) using (var graphics = Graphics.FromHwnd(menu.Handle))
        {
            menu.PrepareLayout();
            bool itemsFit = true;
            foreach (ToolStripItem item in menu.Items) if (!menu.ClientRectangle.Contains(item.Bounds)) itemsFit = false;
            return new DesktopUiDiagnostics {
                perMonitorV2 = AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), new IntPtr(-4)),
                systemDpi = GetDpiForSystem(),
                controlDpi = menu.DeviceDpi,
                renderDpi = graphics.DpiX,
                darkApps = DarkApps(),
                highContrast = SystemInformation.HighContrast,
                menuWidth = menu.Width,
                menuHeight = menu.Height,
                allItemsFit = itemsFit,
                menuItemCount = menu.Items.Count
            };
        }
    }
    public static DesktopUiDiagnostics ExportPreviews(string directory)
    {
        Initialize();
        if (!Path.IsPathRooted(directory)) throw new ArgumentException("预览目录需要绝对路径");
        Directory.CreateDirectory(directory);
        foreach (int dpi in new[] { 96, 120, 144, 192 }) foreach (bool dark in new[] { false, true }) {
            string file = Path.Combine(directory, "tray-" + dpi + "-" + (dark ? "dark" : "light") + ".png");
            using (var renderer = new TrayMenuRenderer(dark))
            using (var bitmap = renderer.Preview(dpi))
            using (var stream = new FileStream(file, FileMode.Create, FileAccess.Write)) bitmap.Save(stream, ImageFormat.Png);
        }
        return Diagnostics();
    }
    public static string ToJson(DesktopUiDiagnostics d)
    {
        using (var ms = new MemoryStream())
        {
            using (var writer = new Utf8JsonWriter(ms))
            {
                writer.WriteStartObject();
                writer.WriteBoolean("perMonitorV2", d.perMonitorV2);
                writer.WriteNumber("systemDpi", d.systemDpi);
                writer.WriteNumber("controlDpi", d.controlDpi);
                writer.WriteNumber("renderDpi", d.renderDpi);
                writer.WriteBoolean("darkApps", d.darkApps);
                writer.WriteBoolean("highContrast", d.highContrast);
                writer.WriteNumber("menuWidth", d.menuWidth);
                writer.WriteNumber("menuHeight", d.menuHeight);
                writer.WriteBoolean("allItemsFit", d.allItemsFit);
                writer.WriteNumber("menuItemCount", d.menuItemCount);
                writer.WriteEndObject();
            }
            return Encoding.UTF8.GetString(ms.ToArray());
        }
    }
}

public sealed class TrayMenuItem : ToolStripMenuItem
{
    public string GlyphName, Hint;
    public TrayMenuItem(string text, string glyph, EventHandler action) : base(text, null, action) { GlyphName = glyph; }
}
public sealed class TrayHeaderItem : ToolStripMenuItem
{
    public string Detail = "正在连接本地下载服务…";
    public TrayHeaderItem() : base("Bewly 下载助手") { Enabled = false; }
}

public sealed class TrayMenu : ContextMenuStrip
{
    [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
    TrayMenuRenderer ownedRenderer;
    readonly Font ownedFont;
    public readonly TrayHeaderItem Status;
    public readonly TrayMenuItem StartItem, PauseItem, CancelItem;
    public TrayMenu() : this(null) { }
    public TrayMenu(Action<string> command)
    {
        ownedFont = new Font(SystemFonts.MenuFont.FontFamily, Math.Max(9.5f, SystemFonts.MenuFont.SizeInPoints));
        Font = ownedFont; ShowImageMargin = false; ShowCheckMargin = false; ShowItemToolTips = true; DropShadowEnabled = true;
        // ToolStripDropDownMenu computes its automatic width from native text
        // columns. Our owner-drawn header and glyph columns need explicit bounds.
        AutoSize = false;
        Status = new TrayHeaderItem();
        Items.Add(Status);
        Items.Add(new TrayMenuItem("打开下载器", "download", (s, e) => { if (command != null) command("open"); }) { Hint = "双击图标" });
        Items.Add(new TrayMenuItem("下载设置", "settings", (s, e) => { if (command != null) command("settings"); }));
        Items.Add(new ToolStripSeparator());
        StartItem = new TrayMenuItem("开始全部待下载", "start", (s, e) => { if (command != null) command("start"); }) { Enabled = false };
        PauseItem = new TrayMenuItem("暂停全部下载", "pause", (s, e) => { if (command != null) command("pause"); }) { Enabled = false };
        CancelItem = new TrayMenuItem("取消自动关机", "cancel", (s, e) => { if (command != null) command("cancelShutdown"); }) { Enabled = false };
        Items.Add(StartItem); Items.Add(PauseItem); Items.Add(CancelItem);
        Items.Add(new ToolStripSeparator());
        Items.Add(new TrayMenuItem("退出助手", "exit", (s, e) => { if (command != null) command("exit"); }));
        RefreshAppearance();
    }
    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        int corner = 3;
        try { DwmSetWindowAttribute(Handle, 33, ref corner, sizeof(int)); } catch (EntryPointNotFoundException) { }
    }
    protected override void OnOpening(CancelEventArgs e)
    {
        RefreshAppearance();
        PrepareLayout();
        base.OnOpening(e);
    }
    public void PrepareLayout()
    {
        float scale = DeviceDpi / 96f;
        SuspendLayout();
        Padding = new Padding(Scale(6, scale));
        int height = Padding.Vertical;
        foreach (ToolStripItem item in Items) {
            item.AutoSize = false;
            item.Size = new Size(Scale(256, scale), Scale(item is TrayHeaderItem ? 52 : item is ToolStripSeparator ? 8 : 32, scale));
            item.Margin = Padding.Empty;
            height += item.Height;
        }
        int width = Scale(256, scale) + Padding.Horizontal;
        MinimumSize = new Size(width, 0);
        Size = new Size(width, height);
        ResumeLayout(true);
        PerformLayout();
    }
    static int Scale(int value, float scale) { return (int)Math.Round(value * scale); }
    void RefreshAppearance()
    {
        if (ownedRenderer != null) ownedRenderer.Dispose();
        ownedRenderer = new TrayMenuRenderer(DesktopUi.DarkApps());
        Renderer = SystemInformation.HighContrast ? (ToolStripRenderer)new ToolStripSystemRenderer() : ownedRenderer;
        BackColor = SystemInformation.HighContrast ? SystemColors.Menu : ownedRenderer.Background;
        ForeColor = SystemInformation.HighContrast ? SystemColors.MenuText : ownedRenderer.Foreground;
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing) { ownedFont.Dispose(); if (ownedRenderer != null) ownedRenderer.Dispose(); }
    }
}

public sealed class TrayMenuRenderer : ToolStripRenderer, IDisposable
{
    public readonly Color Background, Foreground;
    readonly Color border, hover, subtle, disabled;
    readonly Font font, boldFont;
    public TrayMenuRenderer(bool dark)
    {
        Background = dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(250, 250, 250);
        Foreground = dark ? Color.FromArgb(242, 242, 242) : Color.FromArgb(32, 32, 32);
        border = dark ? Color.FromArgb(66, 66, 66) : Color.FromArgb(218, 218, 218);
        hover = dark ? Color.FromArgb(52, 52, 52) : Color.FromArgb(235, 235, 235);
        subtle = dark ? Color.FromArgb(184, 184, 184) : Color.FromArgb(100, 100, 100);
        disabled = dark ? Color.FromArgb(112, 112, 112) : Color.FromArgb(156, 156, 156);
        float pixels = Math.Max(9.5f, SystemFonts.MenuFont.SizeInPoints) * 96f / 72f;
        font = new Font(SystemFonts.MenuFont.FontFamily, pixels, FontStyle.Regular, GraphicsUnit.Pixel);
        boldFont = new Font(font, FontStyle.Bold);
    }
    protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { using (var fill = new SolidBrush(Background)) e.Graphics.FillRectangle(fill, e.AffectedBounds); }
    protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using (var shape = TrayArtwork.Rounded(new RectangleF(0.5f, 0.5f, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1), 7 * e.Graphics.DpiX / 96f))
        using (var pen = new Pen(border)) e.Graphics.DrawPath(pen, shape);
    }
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        if (e.Item.Enabled && e.Item.Selected) DrawHover(e.Graphics, new Rectangle(0, 0, e.Item.Width, e.Item.Height), e.Graphics.DpiX / 96f);
    }
    protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e) { DrawSeparator(e.Graphics, new Rectangle(0, 0, e.Item.Width, e.Item.Height), e.Graphics.DpiX / 96f); }
    protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
    {
        float scale = e.Graphics.DpiX / 96f;
        var header = e.Item as TrayHeaderItem;
        if (header != null) DrawHeader(e.Graphics, new Rectangle(0, 0, header.Width, header.Height), scale, header.Detail);
        else {
            var item = e.Item as TrayMenuItem;
            DrawItem(e.Graphics, new Rectangle(0, 0, e.Item.Width, e.Item.Height), scale, e.Item.Text, item == null ? "" : item.GlyphName, item == null ? null : item.Hint, e.Item.Enabled);
        }
    }
    void Text(Graphics g, string text, Rectangle bounds, float scale, Color color, bool strong)
    {
        using (var scaled = new Font(strong ? boldFont.FontFamily : font.FontFamily, font.Size * scale, strong ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel))
        using (var brush = new SolidBrush(color))
        using (var format = new StringFormat(StringFormat.GenericTypographic) { LineAlignment = StringAlignment.Center, Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap }) {
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            g.DrawString(text, scaled, brush, bounds, format);
        }
    }
    static int S(float value, float scale) { return (int)Math.Round(value * scale); }
    void DrawHeader(Graphics g, Rectangle r, float scale, string detail)
    {
        using (var image = TrayArtwork.Bitmap(S(28, scale))) g.DrawImageUnscaled(image, r.Left + S(10, scale), r.Top + S(10, scale));
        Text(g, "Bewly 下载助手", new Rectangle(r.Left + S(48, scale), r.Top + S(5, scale), r.Width - S(58, scale), S(22, scale)), scale, Foreground, true);
        Text(g, detail, new Rectangle(r.Left + S(48, scale), r.Top + S(27, scale), r.Width - S(58, scale), S(19, scale)), scale * 0.91f, subtle, false);
    }
    void DrawItem(Graphics g, Rectangle r, float scale, string text, string glyph, string hint, bool enabled)
    {
        Color color = enabled ? Foreground : disabled;
        TrayArtwork.Glyph(g, glyph, new RectangleF(r.Left + S(12, scale), r.Top + (r.Height - S(18, scale)) / 2f, S(18, scale), S(18, scale)), color);
        int right = string.IsNullOrEmpty(hint) ? 12 : 72;
        Text(g, text, new Rectangle(r.Left + S(42, scale), r.Top, r.Width - S(42 + right, scale), r.Height), scale, color, false);
        if (!string.IsNullOrEmpty(hint)) Text(g, hint, new Rectangle(r.Right - S(67, scale), r.Top, S(60, scale), r.Height), scale * 0.9f, subtle, false);
    }
    void DrawHover(Graphics g, Rectangle r, float scale)
    {
        using (var shape = TrayArtwork.Rounded(new RectangleF(r.X + S(3, scale), r.Y + S(1, scale), r.Width - S(6, scale), r.Height - S(2, scale)), S(4, scale)))
        using (var brush = new SolidBrush(hover)) g.FillPath(brush, shape);
    }
    void DrawSeparator(Graphics g, Rectangle r, float scale) { using (var pen = new Pen(border)) g.DrawLine(pen, r.Left + S(12, scale), r.Top + r.Height / 2, r.Right - S(12, scale), r.Top + r.Height / 2); }
    public Bitmap Preview(int dpi)
    {
        float scale = dpi / 96f;
        // Match the real popup's opaque surface when exporting the renderer.
        var image = new Bitmap(S(280, scale), S(284, scale), PixelFormat.Format24bppRgb);
        image.SetResolution(dpi, dpi);
        using (var g = Graphics.FromImage(image)) {
            g.Clear(Background); g.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle bounds = new Rectangle(S(6, scale), S(6, scale), S(268, scale), S(272, scale));
            int x = bounds.X + S(6, scale), y = bounds.Y + S(6, scale), width = bounds.Width - S(12, scale);
            DrawHeader(g, new Rectangle(x, y, width, S(52, scale)), scale, "待下载 3 · 下载中 1"); y += S(52, scale);
            string[] labels = { "打开下载器", "下载设置", "", "开始全部待下载", "暂停全部下载", "取消自动关机", "", "退出助手" };
            string[] glyphs = { "download", "settings", "", "start", "pause", "cancel", "", "exit" };
            for (int n = 0; n < labels.Length; n++) {
                int height = S(labels[n] == "" ? 8 : 32, scale);
                var row = new Rectangle(x, y, width, height);
                if (labels[n] == "") DrawSeparator(g, row, scale);
                else { if (n == 0) DrawHover(g, row, scale); DrawItem(g, row, scale, labels[n], glyphs[n], n == 0 ? "双击图标" : null, n != 5); }
                y += height;
            }
            using (var shape = TrayArtwork.Rounded(new RectangleF(bounds.X + 0.5f, bounds.Y + 0.5f, bounds.Width - 1, bounds.Height - 1), S(7, scale)))
            using (var pen = new Pen(border)) g.DrawPath(pen, shape);
        }
        return image;
    }
    public void Dispose() { font.Dispose(); boldFont.Dispose(); }
}
