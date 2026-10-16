using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class TrayArtwork
{
    public static readonly Color Accent = Color.FromArgb(0, 161, 214);
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
    public static void Glyph(Graphics g, string name, RectangleF rect, Color color)
    {
        var state = g.Save();
        g.TranslateTransform(rect.X, rect.Y);
        g.ScaleTransform(rect.Width / 24f, rect.Height / 24f);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var pen = new Pen(color, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
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
    public static Bitmap Bitmap(int size)
    {
        var image = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(image)) {
            g.Clear(Color.Transparent); g.SmoothingMode = SmoothingMode.AntiAlias;
            float inset = Math.Max(0.5f, size / 32f);
            using (var shape = Rounded(new RectangleF(inset, inset, size - inset * 2, size - inset * 2), size * 0.24f))
            using (var fill = new SolidBrush(Accent)) g.FillPath(fill, shape);
            Glyph(g, "download", new RectangleF(size * 0.17f, size * 0.14f, size * 0.66f, size * 0.66f), Color.White);
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
