using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class TrayArtwork
{
    public static readonly Color Accent = Color.FromArgb(0, 161, 214);
    public static readonly Color BadgeTopLeft = Color.FromArgb(203, 232, 255);
    public static readonly Color BadgeBottomRight = Color.FromArgb(242, 249, 255);
    public static string MascotOverridePath;

    public static GraphicsPath Rounded(RectangleF bounds, float radius)
    {
        var path = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        path.AddArc(bounds.Left, bounds.Top, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Top, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static void Glyph(Graphics g, string name, RectangleF rect, Color color, float penWidth = 1.8f)
    {
        var state = g.Save();
        g.TranslateTransform(rect.X, rect.Y);
        g.ScaleTransform(rect.Width / 24f, rect.Height / 24f);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var pen = new Pen(color, penWidth) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
        using (var brush = new SolidBrush(color))
        {
            if (name == "download") {
                g.DrawLine(pen, 12, 3, 12, 15); g.DrawLines(pen, new[] { new PointF(7, 10), new PointF(12, 15), new PointF(17, 10) });
                g.DrawLines(pen, new[] { new PointF(4, 15), new PointF(4, 20), new PointF(20, 20), new PointF(20, 15) });
            }
            else if (name == "settings") {
                var points = new List<PointF>();
                for (int n = 0; n < 32; n++) { double a = n * Math.PI / 16; float r = (n % 4 == 0 || n % 4 == 3) ? 9 : 7; points.Add(new PointF(12 + (float)Math.Cos(a) * r, 12 + (float)Math.Sin(a) * r)); }
                g.DrawPolygon(pen, points.ToArray()); g.DrawEllipse(pen, 8.5f, 8.5f, 7, 7);
            }
            else if (name == "start") g.FillPolygon(brush, new[] { new PointF(8, 4), new PointF(20, 12), new PointF(8, 20) });
            else if (name == "pause") { g.DrawLine(pen, 8, 5, 8, 19); g.DrawLine(pen, 16, 5, 16, 19); }
            else if (name == "cancel") { g.DrawEllipse(pen, 3, 3, 18, 18); g.DrawLine(pen, 12, 7, 12, 12); g.DrawLine(pen, 12, 12, 16, 14); g.DrawLine(pen, 5, 20, 20, 5); }
            else if (name == "exit") { g.DrawLines(pen, new[] { new PointF(10, 4), new PointF(4, 4), new PointF(4, 20), new PointF(10, 20) }); g.DrawLine(pen, 10, 12, 21, 12); g.DrawLines(pen, new[] { new PointF(17, 8), new PointF(21, 12), new PointF(17, 16) }); }
        }
        g.Restore(state);
    }

    static bool DrawMascot(Graphics g, int size)
    {
        float pad = Math.Max(2f, size * 0.13f);
        var targetRect = new RectangleF(pad, pad, Math.Max(8f, size - pad * 2), Math.Max(8f, size - pad * 2));

        using (var stream = typeof(TrayArtwork).Assembly.GetManifestResourceStream("BewlyMascot.png"))
        {
            if (stream != null)
            {
                using (var src = Image.FromStream(stream))
                {
                    g.DrawImage(src, targetRect);
                    return true;
                }
            }
        }

        string file = FindExternalMascotPath();
        if (file != null)
        {
            using (var src = Image.FromFile(file))
            {
                g.DrawImage(src, targetRect);
                return true;
            }
        }

        return false;
    }

    static string FindExternalMascotPath()
    {
        if (!string.IsNullOrEmpty(MascotOverridePath) && File.Exists(MascotOverridePath))
            return MascotOverridePath;

        string[] roots = { Directory.GetCurrentDirectory(), AppDomain.CurrentDomain.BaseDirectory };
        string[] rels = {
            Path.Combine("Assets", "BewlyMascot.png"),
            Path.Combine("platforms", "windows", "Assets", "BewlyMascot.png"),
            Path.Combine("assets", "icon-512.png")
        };

        foreach (string start in roots)
        {
            var dir = string.IsNullOrEmpty(start) ? null : new DirectoryInfo(start);
            for (int depth = 0; dir != null && depth < 8; depth++, dir = dir.Parent)
            {
                foreach (string rel in rels)
                {
                    string candidate = Path.Combine(dir.FullName, rel);
                    if (File.Exists(candidate)) return candidate;
                }
            }
        }
        return null;
    }

    public static Bitmap Bitmap(int size)
    {
        var image = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(image))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;

            float inset = Math.Max(0.5f, size / 32f);
            var tileRect = new RectangleF(inset, inset, size - inset * 2, size - inset * 2);
            using (var shape = Rounded(tileRect, size * 0.22f))
            using (var grad = new LinearGradientBrush(tileRect, BadgeTopLeft, BadgeBottomRight, 45f))
            {
                g.FillPath(grad, shape);
                if (!DrawMascot(g, size))
                {
                    using (var fallbackBg = new SolidBrush(Accent)) g.FillPath(fallbackBg, shape);
                    float grid = size * 1.053f;
                    float penWidth = size >= 96 ? 2.6f : 3.0f;
                    Glyph(g, "download", new RectangleF(-size * 0.027f, 0f, grid, grid), Color.White, penWidth);
                }
            }
        }
        return image;
    }

    public static void WriteIcon(string file)
    {
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        var frames = new List<byte[]>();
        foreach (int size in sizes) using (var bitmap = Bitmap(size)) using (var stream = new MemoryStream()) { bitmap.Save(stream, ImageFormat.Png); frames.Add(stream.ToArray()); }
        using (var stream = File.Create(file)) using (var writer = new BinaryWriter(stream)) {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
            int offset = 6 + sizes.Length * 16;
            for (int n = 0; n < sizes.Length; n++) {
                writer.Write((byte)(sizes[n] == 256 ? 0 : sizes[n])); writer.Write((byte)(sizes[n] == 256 ? 0 : sizes[n])); writer.Write((byte)0); writer.Write((byte)0);
                writer.Write((ushort)1); writer.Write((ushort)32); writer.Write(frames[n].Length); writer.Write(offset); offset += frames[n].Length;
            }
            foreach (var frame in frames) writer.Write(frame);
        }
    }
}
