using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace DeskTodo
{
    class Item
    {
        public bool Done;
        public DateTime? Due;
        public int Minutes;     // 预计耗时，0 = 没估
        public string Priority = "";   // S/A/B/C/D/E
        public string Text;
    }

    class ClassSlot
    {
        public int Day;        // 1=周一 ... 7=周日
        public int StartMin;   // 距 0 点分钟
        public int EndMin;
        public int WeekFrom = 1;   // 起始周
        public int WeekTo = 99;    // 结束周
        public int Parity;         // 0=每周 1=单周 2=双周
        public string Name = "";

        public bool InWeek(int week)
        {
            if (week <= 0) return true;
            if (week < WeekFrom || week > WeekTo) return false;
            if (Parity == 1 && week % 2 == 0) return false;
            if (Parity == 2 && week % 2 == 1) return false;
            return true;
        }
        public string StartText { get { return Fmt(StartMin); } }
        public string EndText { get { return Fmt(EndMin); } }
        public static string Fmt(int m) { return (m / 60).ToString("00") + ":" + (m % 60).ToString("00"); }
        public static int Parse(string t)
        {
            int h = 0, mm = 0;
            string[] p = t.Split(':');
            int.TryParse(p[0], out h);
            if (p.Length > 1) int.TryParse(p[1], out mm);
            if (h < 0) h = 0; if (h > 23) h = 23;
            if (mm < 0) mm = 0; if (mm > 59) mm = 59;
            return h * 60 + mm;
        }
    }

    class Evt
    {
        public DateTime Date;
        public int StartMin, EndMin;
        public string Kind = "安排";
        public string Name = "";
        public string Cat = "日常";    // 日常 / 特殊 / 重要
        public string StartText { get { return ClassSlot.Fmt(StartMin); } }
        public string EndText { get { return ClassSlot.Fmt(EndMin); } }
        public string Prefix { get { return StartText + "-" + EndText; } }
    }

    static class Natives
    {
        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, string lParam);
        [DllImport("user32.dll")]
        public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        public static extern IntPtr FindWindow(string cls, string title);
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr h);

        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HTCAPTION = 0x2;
        public const int EM_SETCUEBANNER = 0x1501;
    }

    static class Store
    {
        public const string DueFmt = "yyyy-MM-dd HH:mm";

        public static readonly string[] Cats = { "日常", "特殊", "重要" };

        public static string Cat(string s)
        {
            s = Clean(s);
            if (s == "特殊" || s == "重要" || s == "日常") return s;
            return "日常";
        }

        public static Color CatColor(string c)
        {
            if (c == "重要") return Color.FromArgb(214, 96, 92);
            if (c == "特殊") return Color.FromArgb(212, 152, 66);
            return Color.FromArgb(122, 150, 176);
        }

        public static List<Item> Load(string path)
        {
            List<Item> list = new List<Item>();
            if (!File.Exists(path)) return list;
            try
            {
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.TrimEnd('\r');
                    if (line.Length == 0) continue;
                    string[] parts = line.Split('\t');
                    if (parts.Length < 2) continue;

                    Item it = new Item();
                    it.Done = parts[0].Trim() == "1";
                    if (parts.Length >= 5)
                    {
                        DateTime d;
                        if (DateTime.TryParseExact(parts[1].Trim(), DueFmt, CultureInfo.InvariantCulture,
                                DateTimeStyles.None, out d)) it.Due = d;
                        int mm;
                        if (int.TryParse(parts[2].Trim(), out mm)) it.Minutes = mm;
                        it.Priority = parts[3].Trim().ToUpperInvariant();
                        it.Text = parts[4];
                    }
                    else if (parts.Length >= 4)
                    {
                        DateTime d;
                        if (DateTime.TryParseExact(parts[1].Trim(), DueFmt, CultureInfo.InvariantCulture,
                                DateTimeStyles.None, out d)) it.Due = d;
                        int mm;
                        if (int.TryParse(parts[2].Trim(), out mm)) it.Minutes = mm;
                        it.Text = parts[3];
                    }
                    else if (parts.Length == 3)
                    {
                        DateTime d;
                        if (DateTime.TryParseExact(parts[1].Trim(), DueFmt, CultureInfo.InvariantCulture,
                                DateTimeStyles.None, out d)) it.Due = d;
                        it.Text = parts[2];
                    }
                    else
                    {
                        it.Text = parts[1];
                    }
                    it.Text = Clean(it.Text);
                    if (it.Text.Length == 0) continue;
                    list.Add(it);
                }
            }
            catch { }
            return list;
        }

        public static string Serialize(List<Item> items)
        {
            StringBuilder sb = new StringBuilder();
            foreach (Item it in items)
            {
                sb.Append(it.Done ? "1" : "0").Append('\t');
                sb.Append(it.Due.HasValue ? it.Due.Value.ToString(DueFmt, CultureInfo.InvariantCulture) : "");
                sb.Append('\t').Append(it.Minutes > 0 ? it.Minutes.ToString() : "");
                sb.Append('\t').Append(Clean(it.Priority));
                sb.Append('\t').Append(Clean(it.Text)).Append("\r\n");
            }
            return sb.ToString();
        }

        public static string Clean(string s)
        {
            if (s == null) return "";
            return s.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ').Trim();
        }

        public static void Save(string path, string content)
        {
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, content, new UTF8Encoding(false));
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        public static List<ClassSlot> LoadClasses(string path)
        {
            List<ClassSlot> list = new List<ClassSlot>();
            if (!File.Exists(path)) return list;
            try
            {
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.TrimEnd('\r');
                    if (line.Length == 0) continue;
                    string[] p = line.Split('\t');
                    if (p.Length < 4) continue;
                    int day;
                    if (!int.TryParse(p[0].Trim(), out day)) continue;
                    if (day < 1 || day > 7) continue;
                    ClassSlot c = new ClassSlot();
                    c.Day = day;
                    c.StartMin = ClassSlot.Parse(p[1].Trim());
                    c.EndMin = ClassSlot.Parse(p[2].Trim());
                    c.Name = Clean(p[3]);
                    if (p.Length >= 7)
                    {
                        int wf, wt, par;
                        if (int.TryParse(p[4].Trim(), out wf)) c.WeekFrom = wf;
                        if (int.TryParse(p[5].Trim(), out wt)) c.WeekTo = wt;
                        if (int.TryParse(p[6].Trim(), out par)) c.Parity = par;
                    }
                    if (c.EndMin <= c.StartMin) c.EndMin = c.StartMin + 45;
                    list.Add(c);
                }
            }
            catch { }
            return list;
        }

        public static void SaveClasses(string path, List<ClassSlot> list)
        {
            StringBuilder sb = new StringBuilder();
            foreach (ClassSlot c in list)
                sb.Append(c.Day).Append('\t').Append(c.StartText).Append('\t').Append(c.EndText)
                  .Append('\t').Append(Clean(c.Name))
                  .Append('\t').Append(c.WeekFrom).Append('\t').Append(c.WeekTo).Append('\t').Append(c.Parity)
                  .Append("\r\n");
            try { File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false)); } catch { }
        }

        public static List<Evt> LoadEvents(string path)
        {
            List<Evt> list = new List<Evt>();
            if (!File.Exists(path)) return list;
            try
            {
                foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
                {
                    string line = raw.TrimEnd('\r');
                    if (line.Length == 0) continue;
                    string[] p = line.Split('\t');
                    if (p.Length < 5) continue;
                    DateTime d;
                    if (!DateTime.TryParseExact(p[0].Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture,
                            DateTimeStyles.None, out d)) continue;
                    Evt e = new Evt();
                    e.Date = d.Date;
                    e.StartMin = ClassSlot.Parse(p[1].Trim());
                    e.EndMin = ClassSlot.Parse(p[2].Trim());
                    if (e.EndMin <= e.StartMin) e.EndMin = e.StartMin + 30;
                    e.Kind = Clean(p[3]);
                    e.Name = Clean(p[4]);
                    e.Cat = p.Length > 5 ? Cat(p[5]) : "日常";
                    if (e.Kind.Length == 0) e.Kind = "安排";
                    if (e.Name.Length == 0) continue;
                    list.Add(e);
                }
            }
            catch { }
            return list;
        }

        public static void SaveEvents(string path, List<Evt> list)
        {
            StringBuilder sb = new StringBuilder();
            foreach (Evt e in list)
                sb.Append(e.Date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)).Append('\t')
                  .Append(e.StartText).Append('\t').Append(e.EndText).Append('\t')
                  .Append(Clean(e.Kind)).Append('\t').Append(Clean(e.Name)).Append('\t')
                  .Append(Cat(e.Cat)).Append("\r\n");
            try { File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false)); } catch { }
        }

        public static Dictionary<string, string> LoadCfg(string path)
        {
            Dictionary<string, string> d = new Dictionary<string, string>();
            if (!File.Exists(path)) return d;
            try
            {
                foreach (string line in File.ReadAllLines(path, Encoding.UTF8))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    d[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
                }
            }
            catch { }
            return d;
        }

        public static void SaveCfg(string path, Dictionary<string, string> d)
        {
            StringBuilder sb = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in d)
                sb.Append(kv.Key).Append('=').Append(kv.Value).Append("\r\n");
            try { File.WriteAllText(path, sb.ToString(), new UTF8Encoding(false)); } catch { }
        }
    }

    static class Ui
    {
        public static Color CARD = Color.FromArgb(30, 30, 34);
        public static Color INK = Color.FromArgb(232, 230, 225);
        public static Color DONE = Color.FromArgb(112, 108, 101);
        public static Color MUTED = Color.FromArgb(138, 134, 126);
        public static Color FAINT = Color.FromArgb(96, 93, 86);
        public static Color LINE = Color.FromArgb(48, 48, 55);
        public static Color EDGE = Color.FromArgb(58, 58, 66);
        public static Color ACCENT = Color.FromArgb(214, 214, 214);
        public static Color ACCENT_DIM = Color.FromArgb(148, 148, 148);
        public static Color PILL = Color.FromArgb(42, 42, 48);
        public static Color HOVER = Color.FromArgb(43, 43, 50);
        public static Color BOX = Color.FromArgb(74, 74, 84);

        public static Color Red = Color.FromArgb(224, 108, 108);
        public static Color Yellow = Color.FromArgb(227, 179, 65);
        public static Color Green = Color.FromArgb(111, 191, 139);
        public static Color Blue = Color.FromArgb(111, 168, 208);

        public static ContextMenuStrip Menu(Font f)
        {
            ContextMenuStrip m = new ContextMenuStrip();
            m.Font = f;
            m.Renderer = new DarkMenu();
            m.ForeColor = INK;
            m.BackColor = Color.FromArgb(38, 38, 43);
            return m;
        }

        public static Color PriorityColor(string p)
        {
            if (p == "S") return Color.FromArgb(226, 96, 96);
            if (p == "A") return Color.FromArgb(232, 146, 74);
            if (p == "B") return Color.FromArgb(226, 190, 80);
            if (p == "C") return Color.FromArgb(118, 190, 136);
            if (p == "D") return Color.FromArgb(120, 160, 200);
            if (p == "E") return Color.FromArgb(140, 138, 132);
            return Color.Transparent;
        }

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            GraphicsPath p = new GraphicsPath();
            int d = radius * 2;
            if (d > r.Width) d = r.Width;
            if (d > r.Height) d = r.Height;
            if (d <= 2) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }
    }

    static class Due
    {
        public static string Chip(Item it, out Color color)
        {
            color = Ui.MUTED;
            if (!it.Due.HasValue) return "";
            DateTime due = it.Due.Value;
            DateTime now = DateTime.Now;

            if (it.Done) { color = Ui.FAINT; return due.ToString("MM-dd"); }

            if (due < now)
            {
                color = Ui.Red;
                int days = (int)Math.Ceiling((now - due).TotalDays);
                return days <= 1 ? "已过期" : ("过期 " + days + " 天");
            }

            if (due.Date == now.Date) { color = Ui.Yellow; return "今天 " + due.ToString("HH:mm"); }
            if (due.Date == now.Date.AddDays(1)) { color = Ui.Yellow; return "明天 " + due.ToString("HH:mm"); }

            double d = (due - now).TotalDays;
            if (d <= 3) { color = Ui.Yellow; return "还剩 " + ((int)Math.Ceiling(d)) + " 天"; }
            if (d <= 7) { color = Ui.Green; return "还剩 " + ((int)Math.Ceiling(d)) + " 天"; }
            color = Ui.Blue;
            return due.ToString("M月d日");
        }
    }

    static class Emblem
    {
        static Dictionary<int, Bitmap> cache = new Dictionary<int, Bitmap>();
        static Bitmap master;
        static bool tried;

        static Bitmap Master()
        {
            if (tried) return master;
            tried = true;
            try
            {
                using (Stream st = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("emblem.png"))
                {
                    if (st != null) master = new Bitmap(st);
                }
            }
            catch { }
            return master;
        }

        static Dictionary<int, Bitmap> darkCache = new Dictionary<int, Bitmap>();

        public static Bitmap RenderDark(int size)
        {
            if (size < 8) size = 8;
            Bitmap hit;
            if (darkCache.TryGetValue(size, out hit)) return hit;
            Bitmap src = Render(size);
            if (src == null) return null;
            Bitmap inv = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(inv))
            {
                System.Drawing.Imaging.ColorMatrix m = new System.Drawing.Imaging.ColorMatrix(new float[][] {
                    new float[] { -1f,  0f,  0f, 0f, 0f },
                    new float[] {  0f, -1f,  0f, 0f, 0f },
                    new float[] {  0f,  0f, -1f, 0f, 0f },
                    new float[] {  0f,  0f,  0f, 1f, 0f },
                    new float[] {  1f,  1f,  1f, 0f, 1f }
                });
                using (System.Drawing.Imaging.ImageAttributes ia = new System.Drawing.Imaging.ImageAttributes())
                {
                    ia.SetColorMatrix(m, System.Drawing.Imaging.ColorMatrixFlag.Default, System.Drawing.Imaging.ColorAdjustType.Bitmap);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(src, new Rectangle(0, 0, size, size), 0, 0, size, size, GraphicsUnit.Pixel, ia);
                }
            }
            darkCache[size] = inv;
            return inv;
        }

        public static Bitmap Render(int size)
        {
            if (size < 8) size = 8;
            Bitmap hit;
            if (cache.TryGetValue(size, out hit)) return hit;
            Bitmap m = Master();
            if (m == null) return null;
            Bitmap b = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(b))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.CompositingQuality = CompositingQuality.HighQuality;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.DrawImage(m, new Rectangle(0, 0, size, size));
            }
            cache[size] = b;
            return b;
        }
    }

    class TodoRow : Control
    {
        public Item Data;
        public Font FNormal, FDone;
        public int RowH;
        public bool Hover;
        public float Alpha;     // 悬停底色淡入
        public float Pop;       // 打勾时的回弹，1 -> 0
        System.Windows.Forms.Timer fade;
        System.Windows.Forms.Timer popTimer;

        public void StartPop()
        {
            Pop = 1f;
            if (popTimer == null)
            {
                popTimer = new System.Windows.Forms.Timer();
                popTimer.Interval = 18;
                popTimer.Tick += delegate
                {
                    Pop -= 0.075f;
                    if (Pop <= 0f) { Pop = 0f; popTimer.Stop(); }
                    Invalidate();
                };
            }
            popTimer.Start();
        }
        public bool IsClass;
        public string Prefix = "";
        public string Tag = "";
        public string CatTag = "";
        public Color CatColor = Color.Empty;
        public object Ref;
        public string TipHead = "";
        public string[] TipLines;
        public event Action<TodoRow> HoverIn;
        public event Action<TodoRow> HoverOut;

        public TodoRow(Item it, int rowH, Font fn, Font fd)
        {
            Data = it;
            RowH = rowH;
            FNormal = fn;
            FDone = fd;
            Height = rowH;
            BackColor = Ui.CARD;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            Cursor = Cursors.Hand;
        }

        void EnsureFade()
        {
            if (fade != null) return;
            fade = new System.Windows.Forms.Timer();
            fade.Interval = 25;
            fade.Tick += delegate
            {
                float target = Hover ? 1f : 0f;
                Alpha += (target - Alpha) * 0.35f;
                if (Math.Abs(target - Alpha) < 0.03f)
                {
                    Alpha = target;
                    fade.Stop();
                }
                Invalidate();
            };
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            Hover = true;
            EnsureFade();
            fade.Start();
            if (HoverIn != null) HoverIn(this);
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            Hover = false;
            EnsureFade();
            fade.Start();
            if (HoverOut != null) HoverOut(this);
            base.OnMouseLeave(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            int h = Height;
            if (Alpha > 0.01f)
            {
                int a = (int)(Alpha * 255f * 0.90f);
                using (GraphicsPath p = Ui.Round(new Rectangle(0, 1, Width - 4, h - 2), 7))
                using (SolidBrush b = new SolidBrush(Color.FromArgb(a, Ui.HOVER.R, Ui.HOVER.G, Ui.HOVER.B)))
                    g.FillPath(b, p);
                int ba = (int)(Alpha * 210f);
                Rectangle bar = new Rectangle(1, h / 2 - (int)(RowH * 0.26f), 2, (int)(RowH * 0.52f));
                using (GraphicsPath bp = Ui.Round(bar, 1))
                using (SolidBrush bb = new SolidBrush(Color.FromArgb(ba, 200, 200, 210)))
                    g.FillPath(bb, bp);
            }

            if (IsClass)
            {
                int px = 10;
                if (Prefix.Length > 0)
                {
                    int pw = (int)Math.Round(86 * (RowH / 34f));
                    TextRenderer.DrawText(g, Prefix, FNormal, new Rectangle(px, 0, pw, h), Color.FromArgb(150, 147, 140),
                        TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                    px += pw;
                }
                Color barC = Color.FromArgb(120, 118, 112);
                using (SolidBrush b = new SolidBrush(barC))
                    g.FillRectangle(b, px, h / 2 - (int)(RowH * 0.28f), 2, (int)(RowH * 0.56f));
                px += 8;

                if (Tag.Length > 0)
                {
                    Font tf = FNormal;
                    Size ts = TextRenderer.MeasureText(g, Tag, tf);
                    Rectangle tagRect = new Rectangle(px, h / 2 - (int)(RowH * 0.30f), ts.Width + 12, (int)(RowH * 0.60f));
                    using (GraphicsPath tp = Ui.Round(tagRect, Math.Max(3, tagRect.Height / 3)))
                    using (Pen pen = new Pen(Color.FromArgb(110, 107, 100), 1f))
                        g.DrawPath(pen, tp);
                    TextRenderer.DrawText(g, Tag, tf, tagRect, Color.FromArgb(168, 165, 158),
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                    px += tagRect.Width + 8;
                }

                if (CatTag.Length > 0)
                {
                    Font cf = FNormal;
                    Size cs = TextRenderer.MeasureText(g, CatTag, cf);
                    Rectangle cr = new Rectangle(px, h / 2 - (int)(RowH * 0.30f), cs.Width + 12, (int)(RowH * 0.60f));
                    using (GraphicsPath cp = Ui.Round(cr, Math.Max(3, cr.Height / 3)))
                    using (SolidBrush cb = new SolidBrush(Color.FromArgb(46, CatColor)))
                        g.FillPath(cb, cp);
                    TextRenderer.DrawText(g, CatTag, cf, cr, CatColor,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                    px += cr.Width + 8;
                }

                Rectangle nr = new Rectangle(px, 0, Width - px - 14, h);
                TextRenderer.DrawText(g, Data.Text, FNormal, nr, Color.FromArgb(228, 226, 220),
                    TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                return;
            }

            int sz = (int)Math.Round(RowH * 0.48);
            if (sz < 12) sz = 12;
            if (sz > 22) sz = 22;
            if (Pop > 0f)
            {
                float bump = (float)Math.Sin(Math.PI * (1.0f - Pop)) * 0.55f;
                sz = (int)Math.Round(sz * (1.0f + bump));
            }

            int bx = 7;
            Rectangle box = new Rectangle(bx, (h - sz) / 2, sz, sz);

            using (GraphicsPath p = Ui.Round(box, Math.Max(3, sz / 4)))
            {
                if (Data.Done)
                {
                    using (SolidBrush b = new SolidBrush(Ui.ACCENT_DIM)) g.FillPath(b, p);
                    using (Pen pen = new Pen(Color.FromArgb(24, 26, 26), Math.Max(1.6f, sz / 9f)))
                    {
                        pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                        Point[] tick = {
                            new Point(box.Left + (int)(sz*0.26), box.Top + (int)(sz*0.52)),
                            new Point(box.Left + (int)(sz*0.43), box.Top + (int)(sz*0.70)),
                            new Point(box.Left + (int)(sz*0.75), box.Top + (int)(sz*0.30))
                        };
                        g.DrawLines(pen, tick);
                    }
                }
                else
                {
                    Color bc = Pop > 0.05f ? Ui.ACCENT : Ui.BOX;
                    using (Pen pen = new Pen(bc, Math.Max(1.3f, sz / 11f))) g.DrawPath(pen, p);
                }
            }

            // 右侧倒计时
            Color chipColor;
            string chip = Due.Chip(Data, out chipColor);
            int chipW = 0;
            if (chip.Length > 0)
            {
                Font cf = FNormal;
                Size cs = TextRenderer.MeasureText(g, chip, cf);
                chipW = cs.Width + 10;
                Rectangle cr = new Rectangle(Width - chipW - 6, 0, chipW, h);
                TextRenderer.DrawText(g, chip, cf, cr, chipColor,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
            }

            int durW = 0;
            if (Data.Minutes > 0)
            {
                string dt = Data.Minutes >= 60
                    ? (Data.Minutes / 60.0).ToString("0.#") + "h"
                    : Data.Minutes + "分";
                Font cf2 = FNormal;
                Size ds = TextRenderer.MeasureText(g, dt, cf2);
                durW = ds.Width + 8;
                Rectangle dr = new Rectangle(Width - chipW - durW - 4, 0, durW, h);
                TextRenderer.DrawText(g, dt, cf2, dr, Ui.FAINT,
                    TextFormatFlags.VerticalCenter | TextFormatFlags.Right | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
            }

            int px2 = bx + sz + 10;
            if (Data.Priority.Length > 0)
            {
                Color pc = Ui.PriorityColor(Data.Priority);
                int bw = (int)Math.Round(RowH * 0.54);
                Rectangle br2 = new Rectangle(px2, h / 2 - bw / 2, bw, bw);
                using (GraphicsPath bp = Ui.Round(br2, Math.Max(3, bw / 4)))
                {
                    using (SolidBrush bb = new SolidBrush(Color.FromArgb(44, pc))) g.FillPath(bb, bp);
                    using (Pen bp2 = new Pen(Color.FromArgb(110, pc), 1f)) g.DrawPath(bp2, bp);
                }
                TextRenderer.DrawText(g, Data.Priority, FNormal, br2, pc,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
                px2 += bw + 8;
            }

            int tx = px2;
            int tw = Width - tx - chipW - durW - 8;
            if (tw < 20) tw = 20;
            Rectangle tr = new Rectangle(tx, 0, tw, h);
            TextFormatFlags fl = TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
            TextRenderer.DrawText(g, Data.Text, Data.Done ? FDone : FNormal, tr,
                Data.Done ? Ui.DONE : Ui.INK, fl);
        }

        public event Action<TodoRow> Toggled;
        public event Action<TodoRow, Point> MenuRequested;

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button == MouseButtons.Right)
            {
                if (MenuRequested != null) MenuRequested(this, e.Location);
                return;
            }
            if (e.Button == MouseButtons.Left)
            {
                if (IsClass) return;      // 课程不可勾选
                Data.Done = !Data.Done;
                StartPop();
                if (Toggled != null) Toggled(this);
            }
        }
    }

    class MonthGrid : Control
    {
        public DateTime Month = new DateTime(DateTime.Now.Year, DateTime.Now.Month, 1);
        public DateTime Selected = DateTime.Today;
        public Dictionary<DateTime, int> Counts = new Dictionary<DateTime, int>();
        public Font FDay, FHead;
        public float S = 1f;

        public MonthGrid()
        {
            BackColor = Ui.CARD;
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
            Cursor = Cursors.Hand;
        }

        static readonly string[] WD = { "一", "二", "三", "四", "五", "六", "日" };

        int HeadH { get { return (int)Math.Round(18 * S); } }

        Rectangle CellRect(int col, int row)
        {
            int w = Width / 7;
            int hh = HeadH;
            int h = (Height - hh) / 6;
            return new Rectangle(col * w, hh + row * h, w, h);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            int w = Width / 7;
            for (int i = 0; i < 7; i++)
            {
                Rectangle hr = new Rectangle(i * w, 0, w, HeadH);
                TextRenderer.DrawText(g, WD[i], FHead, hr, Ui.FAINT,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
            }

            DateTime first = Month;
            int lead = ((int)first.DayOfWeek + 6) % 7;   // 周一开头
            DateTime start = first.AddDays(-lead);

            for (int r = 0; r < 6; r++)
            {
                for (int c = 0; c < 7; c++)
                {
                    DateTime d = start.AddDays(r * 7 + c);
                    Rectangle cell = CellRect(c, r);
                    Rectangle inner = new Rectangle(cell.X + 2, cell.Y + 1, cell.Width - 4, cell.Height - 2);

                    bool inMonth = d.Month == first.Month;
                    bool isToday = d == DateTime.Today;
                    bool isSel = d == Selected;

                    if (isSel)
                    {
                        using (GraphicsPath p = Ui.Round(inner, Math.Max(4, inner.Height / 3)))
                        using (SolidBrush b = new SolidBrush(Color.FromArgb(58, 58, 66)))
                            g.FillPath(b, p);
                    }
                    else if (isToday)
                    {
                        using (GraphicsPath p = Ui.Round(inner, Math.Max(4, inner.Height / 3)))
                        using (Pen pen = new Pen(Color.FromArgb(120, 120, 128), 1f))
                            g.DrawPath(pen, p);
                    }

                    Color fg = inMonth ? (isSel ? Color.White : Ui.INK) : Color.FromArgb(78, 76, 72);
                    Rectangle tr = new Rectangle(cell.X, cell.Y, cell.Width, cell.Height - (int)Math.Round(6 * S));
                    TextRenderer.DrawText(g, d.Day.ToString(), FDay, tr, fg,
                        TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);

                    int n;
                    if (Counts.TryGetValue(d.Date, out n) && n > 0)
                    {
                        int dot = (int)Math.Round(3.4 * S);
                        int dy = cell.Bottom - (int)Math.Round(6 * S);
                        using (SolidBrush b = new SolidBrush(isSel ? Color.White : Ui.Blue))
                            g.FillEllipse(b, cell.X + cell.Width / 2 - dot / 2, dy, dot, dot);
                    }
                }
            }
        }

        public event Action<DateTime> Picked;

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            if (e.Y < HeadH) return;
            int w = Width / 7;
            int h = (Height - HeadH) / 6;
            if (w <= 0 || h <= 0) return;
            int c = e.X / w; if (c > 6) c = 6;
            int r = (e.Y - HeadH) / h; if (r > 5) r = 5;
            DateTime first = Month;
            int lead = ((int)first.DayOfWeek + 6) % 7;
            DateTime d = first.AddDays(-lead + r * 7 + c);
            Selected = d;
            if (d.Month != Month.Month) Month = new DateTime(d.Year, d.Month, 1);
            Invalidate();
            if (Picked != null) Picked(d);
        }
    }

    class MainForm : Form
    {
        static int W, HEAD, FOOT, ROW, MAXH, RAD;

        float S;
        int CSPX;
        bool userSized;
        int userW, userH;
        Point pressScreen;
        bool pressMoved;

        Font fTitle, fCount, fItem, fItemDone, fInput, fHint, fPlus, fTab, fCell;

        string dir, dataPath, cfgPath, classesPath, eventsPath, archivePath;
        List<ClassSlot> classes = new List<ClassSlot>();
        List<Evt> events = new List<Evt>();
        Label lblSummary;
        List<Item> items = new List<Item>();
        string snapshot = "";
        Dictionary<string, string> cfg = new Dictionary<string, string>();
        System.Windows.Forms.Timer poll, anim;
        bool building = false;
        bool collapsed = false;
        bool hideDone = false;
        bool scheduleMode = false;

        float breath = 0f;

        TableLayoutPanel table;
        Panel head;
        Panel content;
        FlowLayoutPanel list;
        Panel viewport;
        int listScroll;
        FlowLayoutPanel dayList2;
        Panel schedulePanel;
        MonthGrid grid;
        FlowLayoutPanel dayList;
        Panel dayViewport;
        int dayScroll;
        Label lblMonth, lblPrev, lblNext, lblBack, lblClasses;
        Panel foot;
        TextBox input;
        Label lblCount, lblCollapse, lblAdd, lblList, lblSched, lblArchive;
        TipWindow tipWin;
        System.Windows.Forms.Timer tipTimer;
        TodoRow tipRow;
        Rectangle emblemHit;
        System.Windows.Forms.Timer dockTimer, slideTimer;
        int dockSide;          // 0 不贴边 / 1 贴左 / 2 贴右
        int dockRestX;         // 完全展开时的 X
        bool dockHidden;
        bool sliding;
        int awayTicks;
        bool dockMenuOpen;
        Label lblArchiveNow;

        public MainForm()
        {
            dir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            dataPath = Path.Combine(dir, "todos.txt");
            cfgPath = Path.Combine(dir, "cfg.txt");
            classesPath = Path.Combine(dir, "classes.txt");
            eventsPath = Path.Combine(dir, "events.txt");
            archivePath = Path.Combine(dir, "archive.txt");
            cfg = Store.LoadCfg(cfgPath);
            classes = Store.LoadClasses(classesPath);
            events = Store.LoadEvents(eventsPath);

            float s = 1f;
            try { using (Graphics g = Graphics.FromHwnd(IntPtr.Zero)) s = g.DpiX / 96f; } catch { }
            S = s;
            W = (int)Math.Round(340 * s);
            HEAD = (int)Math.Round(50 * s);
            FOOT = (int)Math.Round(48 * s);
            ROW = (int)Math.Round(34 * s);
            MAXH = (int)Math.Round(700 * s);
            RAD = (int)Math.Round(14 * s);
            CSPX = (int)Math.Round(64 * s);
            MinimumSize = new Size((int)Math.Round(250 * s), (int)Math.Round(140 * s));

            fTitle = F("Microsoft YaHei UI", 11f, FontStyle.Bold);
            fCount = F("Microsoft YaHei UI", 8.5f, FontStyle.Regular);
            fItem = F("Microsoft YaHei UI", 10f, FontStyle.Regular);
            fItemDone = F("Microsoft YaHei UI", 10f, FontStyle.Strikeout);
            fInput = F("Microsoft YaHei UI", 10f, FontStyle.Regular);
            fHint = F("Microsoft YaHei UI", 9.5f, FontStyle.Regular);
            fPlus = F("Microsoft YaHei UI", 14f, FontStyle.Regular);
            fTab = F("Microsoft YaHei UI", 9f, FontStyle.Regular);
            fCell = F("Microsoft YaHei UI", 9f, FontStyle.Regular);

            BuildForm();
            ReloadFromDisk(true);
            ApplySavedState();
            StartPolling();
            StartDocking();
            UpdateDock();
            StartBreathing();
        }

        static Font F(string name, float size, FontStyle st)
        {
            try { return new Font(name, size, st, GraphicsUnit.Point); }
            catch { try { return new Font("Microsoft YaHei", size, st, GraphicsUnit.Point); } catch { return new Font(FontFamily.GenericSansSerif, size, st); } }
        }

        void BuildForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = CfgBool("topmost", true);
            BackColor = Ui.CARD;
            Text = "待办";
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);

            table = new TableLayoutPanel();
            table.Dock = DockStyle.Fill;
            table.ColumnCount = 1;
            table.RowCount = 3;
            table.Margin = new Padding(0);
            table.Padding = new Padding(0);
            table.BackColor = Ui.CARD;
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100f));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, HEAD));
            table.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
            table.RowStyles.Add(new RowStyle(SizeType.Absolute, FOOT));
            Controls.Add(table);

            head = new Panel();
            head.Dock = DockStyle.Fill;
            head.Margin = new Padding(0);
            head.BackColor = Ui.CARD;
            head.Paint += HeadPaint;
            head.MouseDown += DragMove;
            head.DoubleClick += delegate { ToggleCollapse(); };
            head.MouseUp += delegate(object o, MouseEventArgs e) { if (e.Button == MouseButtons.Right) HeadMenu(); };
            head.MouseMove += delegate(object o, MouseEventArgs e)
            {
                Cursor c = (emblemHit.Width > 0 && emblemHit.Contains(e.Location)) ? Cursors.Hand : Cursors.Default;
                if (head.Cursor != c) head.Cursor = c;
            };
            table.Controls.Add(head, 0, 0);

            lblList = MakeTab("清单");
            lblList.Click += delegate { SetMode(false); };
            head.Controls.Add(lblList);

            lblSched = MakeTab("日程");
            lblSched.Click += delegate { SetMode(true); };
            head.Controls.Add(lblSched);

            lblArchive = MakeTab("归档");
            lblArchive.ForeColor = Ui.FAINT;
            lblArchive.Click += delegate { OpenArchive(); };
            head.Controls.Add(lblArchive);

            tipTimer = new System.Windows.Forms.Timer();
            tipTimer.Interval = 380;
            tipTimer.Tick += delegate
            {
                tipTimer.Stop();
                if (tipRow == null) return;
                if (tipWin == null) tipWin = new TipWindow();
                tipWin.ShowTip(tipRow.TipHead, tipRow.TipLines, Cursor.Position);
            };

            lblCount = new Label();
            lblCount.AutoSize = false;
            lblCount.TextAlign = ContentAlignment.MiddleRight;
            lblCount.BackColor = Ui.CARD;
            lblCount.ForeColor = Ui.MUTED;
            lblCount.Font = fCount;
            lblCount.MouseDown += DragMove;
            lblCount.MouseUp += delegate(object o, MouseEventArgs e) { if (e.Button == MouseButtons.Right) HeadMenu(); };
            head.Controls.Add(lblCount);

            lblCollapse = new Label();
            lblCollapse.AutoSize = false;
            lblCollapse.Text = "\u2013";
            lblCollapse.TextAlign = ContentAlignment.MiddleCenter;
            lblCollapse.BackColor = Ui.CARD;
            lblCollapse.ForeColor = Ui.MUTED;
            lblCollapse.Font = fCount;
            lblCollapse.Cursor = Cursors.Hand;
            lblCollapse.Click += delegate { ToggleCollapse(); };
            head.Controls.Add(lblCollapse);

            content = new Panel();
            content.Dock = DockStyle.Fill;
            content.Margin = new Padding(0);
            content.BackColor = Ui.CARD;
            table.Controls.Add(content, 0, 1);

            viewport = new Panel();
            viewport.Dock = DockStyle.Fill;
            viewport.BackColor = Ui.CARD;
            viewport.AutoScroll = false;
            viewport.Paint += ViewportPaint;
            viewport.Resize += delegate { LayoutListArea(); };
            content.Controls.Add(viewport);

            lblArchiveNow = new Label();
            lblArchiveNow.AutoSize = false;
            lblArchiveNow.TextAlign = ContentAlignment.MiddleCenter;
            lblArchiveNow.BackColor = Ui.PILL;
            lblArchiveNow.ForeColor = Ui.MUTED;
            lblArchiveNow.Font = fCount;
            lblArchiveNow.Cursor = Cursors.Hand;
            lblArchiveNow.Visible = false;
            lblArchiveNow.Click += delegate { ArchiveDone(); };
            viewport.Controls.Add(lblArchiveNow);
            lblArchiveNow.BringToFront();

            list = new FlowLayoutPanel();
            list.FlowDirection = FlowDirection.TopDown;
            list.WrapContents = false;
            list.AutoScroll = false;
            list.BackColor = Ui.CARD;
            list.Padding = new Padding(6, 2, 4, 2);
            list.Margin = new Padding(0);
            list.Location = new Point(0, 0);
            viewport.Controls.Add(list);

            schedulePanel = new Panel();
            schedulePanel.Dock = DockStyle.Fill;
            schedulePanel.Margin = new Padding(0);
            schedulePanel.BackColor = Ui.CARD;
            schedulePanel.Visible = false;
            content.Controls.Add(schedulePanel);

            BuildSchedule();

            foot = new Panel();
            foot.Dock = DockStyle.Fill;
            foot.Margin = new Padding(0);
            foot.BackColor = Ui.CARD;
            foot.Paint += FootPaint;
            foot.MouseDown += DragMove;
            table.Controls.Add(foot, 0, 2);

            input = new TextBox();
            input.BorderStyle = BorderStyle.None;
            input.BackColor = Ui.PILL;
            input.ForeColor = Ui.INK;
            input.Font = fInput;
            input.KeyDown += InputKeyDown;
            foot.Controls.Add(input);

            lblAdd = new Label();
            lblAdd.AutoSize = false;
            lblAdd.Text = "+";
            lblAdd.TextAlign = ContentAlignment.MiddleCenter;
            lblAdd.BackColor = Ui.PILL;
            lblAdd.ForeColor = Ui.ACCENT;
            lblAdd.Font = fPlus;
            lblAdd.Cursor = Cursors.Hand;
            lblAdd.Click += delegate { OpenNewDialog(input.Text); };
            foot.Controls.Add(lblAdd);

            foot.Resize += delegate { LayoutFoot(); };
            head.Resize += delegate { LayoutHead(); };
            schedulePanel.Resize += delegate { LayoutSchedule(); };
            Resize += delegate { RoundCorners(); };
            Load += delegate { RoundCorners(); LayoutHead(); LayoutFoot(); LayoutSchedule(); LayoutListArea(); };

            anim = new System.Windows.Forms.Timer();
            anim.Interval = 16;
            anim.Tick += AnimTick;
        }

        Label MakeTab(string text)
        {
            Label l = new Label();
            l.AutoSize = false;
            l.Text = text;
            l.TextAlign = ContentAlignment.MiddleCenter;
            l.BackColor = Ui.CARD;
            l.ForeColor = Ui.MUTED;
            l.Font = fTab;
            l.Cursor = Cursors.Hand;
            return l;
        }

        void BuildSchedule()
        {
            lblPrev = new Label();
            lblPrev.AutoSize = false;
            lblPrev.Text = "\u2039";
            lblPrev.TextAlign = ContentAlignment.MiddleCenter;
            lblPrev.BackColor = Ui.CARD;
            lblPrev.ForeColor = Ui.MUTED;
            lblPrev.Font = fPlus;
            lblPrev.Cursor = Cursors.Hand;
            lblPrev.Click += delegate { ShiftMonth(-1); };
            schedulePanel.Controls.Add(lblPrev);

            lblNext = new Label();
            lblNext.AutoSize = false;
            lblNext.Text = "\u203A";
            lblNext.TextAlign = ContentAlignment.MiddleCenter;
            lblNext.BackColor = Ui.CARD;
            lblNext.ForeColor = Ui.MUTED;
            lblNext.Font = fPlus;
            lblNext.Cursor = Cursors.Hand;
            lblNext.Click += delegate { ShiftMonth(1); };
            schedulePanel.Controls.Add(lblNext);

            lblMonth = new Label();
            lblMonth.AutoSize = false;
            lblMonth.TextAlign = ContentAlignment.MiddleLeft;
            lblMonth.BackColor = Ui.CARD;
            lblMonth.ForeColor = Ui.INK;
            lblMonth.Font = fTab;
            schedulePanel.Controls.Add(lblMonth);

            lblSummary = new Label();
            lblSummary.AutoSize = false;
            lblSummary.TextAlign = ContentAlignment.MiddleLeft;
            lblSummary.BackColor = Ui.CARD;
            lblSummary.ForeColor = Ui.MUTED;
            lblSummary.Font = fCount;
            schedulePanel.Controls.Add(lblSummary);

            lblClasses = new Label();
            lblClasses.AutoSize = false;
            lblClasses.Text = "课表";
            lblClasses.TextAlign = ContentAlignment.MiddleCenter;
            lblClasses.BackColor = Ui.CARD;
            lblClasses.ForeColor = Ui.MUTED;
            lblClasses.Font = fCount;
            lblClasses.Cursor = Cursors.Hand;
            lblClasses.Click += delegate { OpenClasses(); };
            schedulePanel.Controls.Add(lblClasses);

            grid = new MonthGrid();
            grid.S = S;
            grid.FDay = fCell;
            grid.FHead = fCount;
            grid.Picked += delegate(DateTime d) { RebuildDay(); };
            schedulePanel.Controls.Add(grid);

            dayViewport = new Panel();
            dayViewport.BackColor = Ui.CARD;
            dayViewport.AutoScroll = false;
            dayViewport.Paint += DayViewportPaint;
            dayViewport.Resize += delegate { LayoutDayArea(); };
            schedulePanel.Controls.Add(dayViewport);

            dayList = new FlowLayoutPanel();
            dayList.FlowDirection = FlowDirection.TopDown;
            dayList.WrapContents = false;
            dayList.AutoScroll = false;
            dayList.BackColor = Ui.CARD;
            dayList.Padding = new Padding(6, 2, 4, 2);
            dayList.Location = new Point(0, 0);
            dayViewport.Controls.Add(dayList);
        }

        void LayoutSchedule()
        {
            if (schedulePanel == null) return;
            int w = schedulePanel.ClientSize.Width;
            int top = (int)Math.Round(30 * S);
            lblPrev.SetBounds(4, 0, (int)Math.Round(26 * S), top);
            int tabW = (int)Math.Round(42 * S);
            lblNext.SetBounds(w - (int)Math.Round(26 * S) - 4, 0, (int)Math.Round(26 * S), top);
            lblClasses.SetBounds(w - (int)Math.Round(30 * S) - tabW, 2, tabW, top - 4);
            lblMonth.SetBounds((int)Math.Round(34 * S), 0, w - tabW - (int)Math.Round(80 * S), top);

            int summaryH = (int)Math.Round(22 * S);
            int total = schedulePanel.ClientSize.Height - top;
            int gridH2 = (int)((total - summaryH) * 0.62);
            grid.SetBounds(4, top, w - 8, gridH2);
            lblSummary.SetBounds((int)Math.Round(12 * S), top + gridH2 + 2, w - (int)Math.Round(24 * S), summaryH);
            int listTop = top + gridH2 + summaryH + 4;
            dayViewport.SetBounds(0, listTop, w, Math.Max(40, schedulePanel.ClientSize.Height - listTop));
            LayoutDayArea();
        }

        void OpenClasses()
        {
            ClassDialog.Open(classesPath, S);
            classes = Store.LoadClasses(classesPath);
            events = Store.LoadEvents(eventsPath);
            if (scheduleMode) RebuildSchedule();
        }

        void ShiftMonth(int delta)
        {
            grid.Month = grid.Month.AddMonths(delta);
            grid.Invalidate();
            RefreshMonthLabel();
        }

        void RefreshMonthLabel()
        {
            lblMonth.Text = grid.Month.ToString("yyyy 年 M 月");
        }

        void KeepOnScreen()
        {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int x = Left, y = Top;
            if (x + Width > wa.Right) x = wa.Right - Width;
            if (x < wa.Left) x = wa.Left;
            if (y + Height > wa.Bottom) y = wa.Bottom - Height;
            if (y < wa.Top) y = wa.Top;
            if (x != Left || y != Top) Location = new Point(x, y);
        }

        void UpdateDock()
        {
            if (collapsed) { KeepOnScreen(); dockSide = 0; return; }
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int tol = (int)Math.Round(12 * S);
            if (Left <= wa.Left + tol) { dockSide = 1; dockRestX = wa.Left; }
            else if (Left + Width >= wa.Right - tol) { dockSide = 2; dockRestX = wa.Right - Width; }
            else dockSide = 0;
            dockHidden = false;
            KeepOnScreen();
        }

        void StartDocking()
        {
            dockTimer = new System.Windows.Forms.Timer();
            dockTimer.Interval = 130;
            dockTimer.Tick += delegate { DockTick(); };
            dockTimer.Start();
        }

        void DockTick()
        {
            if (collapsed || dockSide == 0 || sliding) return;

            Point cu = Cursor.Position;
            bool near = new Rectangle(Left - 3, Top - 3, Width + 6, Height + 6).Contains(cu);
            bool busy = input.Focused || (tipWin != null && tipWin.Visible) || dockMenuOpen;

            if (near || busy)
            {
                awayTicks = 0;
                return;
            }

            awayTicks++;
            if (awayTicks >= 2)
            {
                awayTicks = 0;
                ToggleCollapse();     // 贴边时鼠标离开 -> 收成球
            }
        }

        void FadeIn()
        {
            Opacity = 0.88;
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 20;
            t.Tick += delegate
            {
                Opacity += 0.03;
                if (Opacity >= 1.0) { Opacity = 1.0; t.Stop(); t.Dispose(); }
            };
            t.Start();
        }

        void SetMode(bool schedule)
        {
            scheduleMode = schedule;
            FadeIn();
            if (viewport != null) viewport.Visible = !schedule;
            list.Visible = !schedule;
            schedulePanel.Visible = schedule;
            lblList.ForeColor = schedule ? Ui.MUTED : Ui.INK;
            lblSched.ForeColor = schedule ? Ui.INK : Ui.MUTED;
            if (schedule)
            {
                RebuildSchedule();
                if (!userSized)
                {
                    Height = Math.Min(MAXH, (int)Math.Round(660 * S));
                }
            }
            else if (!userSized)
            {
                ApplyLayout();
                return;
            }
            LayoutSchedule();
        }

        void RebuildSchedule()
        {
            grid.Counts.Clear();
            foreach (Item it in items)
            {
                if (!it.Due.HasValue) continue;
                DateTime d = it.Due.Value.Date;
                int n;
                grid.Counts.TryGetValue(d, out n);
                grid.Counts[d] = n + 1;
            }
            // 当月每天按星期几把课表也计进去
            DateTime cursor = grid.Month;
            DateTime monthEnd = grid.Month.AddMonths(1);
            while (cursor < monthEnd)
            {
                int wd = (int)cursor.DayOfWeek; if (wd == 0) wd = 7;
                int wkD = WeekOf(cursor);
                int clsCount = 0;
                foreach (ClassSlot c in classes) if (c.Day == wd && c.InWeek(wkD)) clsCount++;
                if (clsCount > 0)
                {
                    int n;
                    grid.Counts.TryGetValue(cursor.Date, out n);
                    grid.Counts[cursor.Date] = n + clsCount;
                }
                cursor = cursor.AddDays(1);
            }
            RefreshMonthLabel();
            grid.Invalidate();
            RebuildDay();
        }

        int WeekOf(DateTime d)
        {
            string v;
            DateTime start;
            if (!cfg.TryGetValue("semesterstart", out v) ||
                !DateTime.TryParseExact(v, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out start))
                start = new DateTime(DateTime.Now.Year, 9, 7);
            int days = (int)(d.Date - start.Date).TotalDays;
            if (days < 0) return 0;
            return days / 7 + 1;
        }

        int CurrentWeek() { return WeekOf(DateTime.Today); }

        static string Hours(int m)
        {
            if (m <= 0) return "0h";
            if (m % 60 == 0) return (m / 60) + "h";
            return (m / 60) + "h" + (m % 60);
        }

        void UpdateDaySummary()
        {
            DateTime d = grid.Selected;
            int wd = (int)d.DayOfWeek; if (wd == 0) wd = 7;
            int wkS = WeekOf(d);
            int cls = 0;
            foreach (ClassSlot c in classes) if (c.Day == wd && c.InWeek(wkS)) cls += (c.EndMin - c.StartMin);
            int need = 0;
            foreach (Item it in items)
                if (!it.Done && it.Due.HasValue && it.Due.Value.Date == d.Date) need += it.Minutes;

            int window = 900;   // 08:00-23:00
            int free = window - cls; if (free < 0) free = 0;

            string tag; Color tc;
            if (need == 0) { tag = "没安排"; tc = Ui.MUTED; }
            else if (need > free) { tag = "排不下"; tc = Ui.Red; }
            else if (need * 100 > free * 75) { tag = "紧张"; tc = Ui.Red; }
            else if (need * 100 > free * 45) { tag = "正常"; tc = Ui.Yellow; }
            else { tag = "轻松"; tc = Ui.Green; }

            lblSummary.Text = "课 " + Hours(cls) + " · 要做 " + Hours(need) + " · 闲 " + Hours(free) + "—— " + tag;
            lblSummary.ForeColor = tc;
        }

        void RebuildDay()
        {
            List<Control> old = new List<Control>();
            foreach (Control c in dayList.Controls) old.Add(c);
            dayList.Controls.Clear();
            foreach (Control c in old) c.Dispose();

            List<Item> todays = new List<Item>();
            foreach (Item it in items)
                if (it.Due.HasValue && it.Due.Value.Date == grid.Selected.Date) todays.Add(it);
            todays.Sort(delegate(Item a, Item b)
            {
                int c = a.Due.Value.CompareTo(b.Due.Value);
                if (c != 0) return c;
                return a.Done == b.Done ? 0 : (a.Done ? 1 : -1);
            });

            // 课与任务按时间合并
            List<object> merged = new List<object>();
            List<int> keys = new List<int>();
            int wdSel = (int)grid.Selected.DayOfWeek; if (wdSel == 0) wdSel = 7;
            int wkSel = WeekOf(grid.Selected);
            List<ClassSlot> clsSel = new List<ClassSlot>();
            foreach (ClassSlot c in classes) if (c.Day == wdSel && c.InWeek(wkSel)) clsSel.Add(c);
            foreach (ClassSlot c in clsSel) { merged.Add(c); keys.Add(c.StartMin); }
            foreach (Evt e in events)
                if (e.Date == grid.Selected.Date) { merged.Add(e); keys.Add(e.StartMin); }
            foreach (Item it in todays) { merged.Add(it); keys.Add(it.Due.Value.Hour * 60 + it.Due.Value.Minute); }
            for (int i = 0; i < merged.Count; i++)
                for (int j = i + 1; j < merged.Count; j++)
                    if (keys[j] < keys[i])
                    {
                        int tk = keys[i]; keys[i] = keys[j]; keys[j] = tk;
                        object to = merged[i]; merged[i] = merged[j]; merged[j] = to;
                    }

            foreach (object o in merged)
            {
                ClassSlot c = o as ClassSlot;
                if (c != null)
                {
                    Item dc = new Item();
                    dc.Text = c.Name;
                    TodoRow crow = new TodoRow(dc, ROW, fItem, fItemDone);
                    crow.IsClass = true;
                    crow.Prefix = c.StartText + "-" + c.EndText;
                    crow.CatTag = "日常";
                    crow.CatColor = Store.CatColor("日常");
                    crow.Width = dayViewport.ClientSize.Width - 12;
                    crow.Margin = new Padding(0);
                    crow.MenuRequested += delegate(TodoRow r, Point at) { OpenClasses(); };
                    AttachTip(crow, c.Name, new string[] { "课程", c.StartText + "-" + c.EndText });
                    dayList.Controls.Add(crow);
                    continue;
                }

                Evt ev = o as Evt;
                if (ev != null)
                {
                    Item dummy2 = new Item();
                    dummy2.Text = ev.Name;
                    TodoRow er2 = new TodoRow(dummy2, ROW, fItem, fItemDone);
                    er2.IsClass = true;
                    er2.Prefix = ev.Prefix;
                    er2.Tag = ev.Kind;
                    er2.CatTag = ev.Cat;
                    er2.CatColor = Store.CatColor(ev.Cat);
                    er2.Ref = ev;
                    er2.Width = dayViewport.ClientSize.Width - 12;
                    er2.Margin = new Padding(0);
                    er2.MenuRequested += delegate(TodoRow r, Point at)
                    {
                        Evt e0 = r.Ref as Evt;
                        if (e0 != null) ShowEvtMenu(e0, at);
                        else OpenClasses();
                    };
                    AttachTip(er2, ev.Name, new string[] { ev.Kind + " · " + ev.Cat, ev.Prefix });
                    dayList.Controls.Add(er2);
                    continue;
                }

                Item it2 = (Item)o;
                TodoRow row0 = new TodoRow(it2, ROW, fItem, fItemDone);
                row0.Width = dayViewport.ClientSize.Width - 12;
                row0.Margin = new Padding(0);
                row0.Toggled += delegate(TodoRow r)
                {
                    Persist();
                    RebuildSchedule();
                };
                row0.MenuRequested += delegate(TodoRow r, Point at) { ShowRowMenu(r, r.Data, at); };
                AttachTip(row0, it2.Text, TipLinesOf(it2));
                dayList.Controls.Add(row0);
            }

            if (merged.Count == 0)
            {
                Label hint = new Label();
                hint.AutoSize = false;
                hint.Height = (int)Math.Round(46 * S);
                hint.TextAlign = ContentAlignment.MiddleCenter;
                hint.ForeColor = Color.FromArgb(108, 104, 96);
                hint.Font = fHint;
                hint.Text = grid.Selected.ToString("M月d日") + " 没有安排";
                hint.Width = dayViewport.ClientSize.Width - 12;
                dayList.Controls.Add(hint);
                UpdateDaySummary();
                return;
            }

            LayoutDayArea();
            UpdateDaySummary();
        }

        void LayoutHead()
        {
            int bs = (int)Math.Round(HEAD * 0.44);
            int x = head.Width - bs - 6;
            lblCollapse.SetBounds(x, (HEAD - bs) / 2, bs, bs);
            x -= (int)Math.Round(58 * S);
            lblCount.SetBounds(x, (HEAD - bs) / 2, (int)Math.Round(54 * S), bs);
            x -= (int)Math.Round(42 * S);
            lblArchive.SetBounds(x, (HEAD - bs) / 2, (int)Math.Round(42 * S), bs);
            x -= (int)Math.Round(42 * S);
            lblSched.SetBounds(x, (HEAD - bs) / 2, (int)Math.Round(42 * S), bs);
            x -= (int)Math.Round(42 * S);
            lblList.SetBounds(x, (HEAD - bs) / 2, (int)Math.Round(42 * S), bs);
        }

        void LayoutFoot()
        {
            int x = 12, w = foot.Width - 24;
            int pillH = FOOT - 14, y = 7;
            input.SetBounds(x + 12, y + (pillH - input.PreferredHeight) / 2 + 1, w - 50, input.PreferredHeight);
            Natives.SendMessage(input.Handle, Natives.EM_SETCUEBANNER, (IntPtr)1, "加一条，回车 · 可写 @11-20 18:00");
            lblAdd.SetBounds(x + w - 32, y, 30, pillH);
        }

        void RoundCorners()
        {
            if (Width <= 0 || Height <= 0) return;
            try
            {
                if (collapsed)
                {
                    using (GraphicsPath p = new GraphicsPath())
                    {
                        p.AddEllipse(0, 0, Width, Height);
                        Region = new Region(p);
                    }
                    return;
                }
                using (GraphicsPath p = Ui.Round(new Rectangle(0, 0, Width, Height), RAD)) Region = new Region(p);
            }
            catch { }
        }

        void HeadPaint(object s, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            int pad = 11;
            int badge = (int)Math.Round(Math.Min(HEAD * 0.80, 42));
            Rectangle br = new Rectangle(pad, (HEAD - badge) / 2, badge, badge);
            Bitmap em = Emblem.Render(badge);
            if (em != null) g.DrawImage(em, br);
            emblemHit = br;

            TextRenderer.DrawText(g, "待办", fTitle,
                new Rectangle(br.Right + 9, 0, head.Width - br.Right - 9, HEAD), Ui.INK,
                TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix);
        }

        void FootPaint(object s, PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int x = 12, w = foot.Width - 24, h = FOOT - 14, y = 7;
            using (GraphicsPath p = Ui.Round(new Rectangle(x, y, w, h), h / 2))
            using (SolidBrush b = new SolidBrush(Ui.PILL)) g.FillPath(b, p);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (collapsed)
            {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                e.Graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

                float d0 = Math.Min(Width, Height);
                float cx = Width / 2f, cy = Height / 2f;
                float t = (float)Math.Sin(breath);           // -1..1 呼吸相位

                // 外侧扩散光：随呼吸明暗
                for (int i = 3; i >= 1; i--)
                {
                    float rr = d0 * (0.90f + 0.035f * t) * (1f + 0.045f * i);
                    int a = (int)(((t + 1f) / 2f) * 30f) + 6;
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(Math.Min(a, 40), 255, 255, 255)))
                        e.Graphics.FillEllipse(b, cx - rr / 2f, cy - rr / 2f, rr, rr);
                }

                // 底部投影，随呼吸推远拉近
                int shOff = (int)(2 + 1.5f * t);
                for (int i = 3; i >= 1; i--)
                {
                    float sr = d0 * (0.90f + 0.035f * t) * (1f + 0.02f * i);
                    using (SolidBrush b = new SolidBrush(Color.FromArgb(10 + 4 * (3 - i), 0, 0, 0)))
                        e.Graphics.FillEllipse(b, cx - sr / 2f, cy - sr / 2f + shOff, sr, sr);
                }

                // 白球
                float dd = d0 * (0.89f + 0.05f * t);
                Rectangle cr = new Rectangle((int)(cx - dd / 2f), (int)(cy - dd / 2f), (int)dd, (int)dd);
                using (LinearGradientBrush lg = new LinearGradientBrush(cr, Color.White, Color.FromArgb(226, 226, 231), 62f))
                    e.Graphics.FillEllipse(lg, cr);
                using (Pen p = new Pen(Color.FromArgb(210, 255, 255, 255), 1.5f))
                    e.Graphics.DrawEllipse(p, cr);

                // 黑图标
                int inner = (int)(dd * 0.94f);
                Bitmap mark = Emblem.RenderDark(inner);
                if (mark != null)
                    e.Graphics.DrawImage(mark, new Rectangle((int)(cx - inner / 2f), (int)(cy - inner / 2f), inner, inner));
                return;
            }

            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath p = Ui.Round(new Rectangle(0, 0, Width - 1, Height - 1), RAD))
            using (Pen pen = new Pen(Ui.EDGE, 1f)) e.Graphics.DrawPath(pen, p);
            using (Pen pen = new Pen(Ui.LINE, 1f))
                e.Graphics.DrawLine(pen, 13, HEAD, Width - 13, HEAD);
        }

        bool CfgBool(string k, bool def)
        {
            string v;
            if (!cfg.TryGetValue(k, out v)) return def;
            return v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase);
        }

        int CfgInt(string k, int def)
        {
            string v; int n;
            if (cfg.TryGetValue(k, out v) && int.TryParse(v, out n)) return n;
            return def;
        }

        void ApplySavedState()
        {
            int x = CfgInt("x", -9999), y = CfgInt("y", -9999);
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            if (x < -5000 || y < -5000 || x > wa.Right - 60 || y > wa.Bottom - 60)
            {
                x = wa.Right - W - 60;
                y = wa.Top + 120;
                if (x < wa.Left) x = wa.Left;
            }
            Location = new Point(x, y);
            userSized = CfgBool("usersized", false);
            userW = CfgInt("w", 0);
            userH = CfgInt("h", 0);
            hideDone = CfgBool("hidedone", false);
            scheduleMode = CfgBool("schedule", false);
            collapsed = CfgBool("collapsed", false);

            ApplyLayout();
            if (scheduleMode) SetMode(true);
            else
            {
                lblList.ForeColor = Ui.INK;
                lblSched.ForeColor = Ui.MUTED;
                if (viewport != null) viewport.Visible = true;
                list.Visible = true;
                schedulePanel.Visible = false;
            }
        }

        void SaveState()
        {
            cfg["x"] = ((dockSide != 0) ? dockRestX : Location.X).ToString();
            cfg["y"] = Location.Y.ToString();
            cfg["collapsed"] = collapsed ? "1" : "0";
            cfg["hidedone"] = hideDone ? "1" : "0";
            cfg["topmost"] = TopMost ? "1" : "0";
            cfg["schedule"] = scheduleMode ? "1" : "0";
            cfg["usersized"] = userSized ? "1" : "0";
            if (userW > 0) cfg["w"] = userW.ToString();
            if (userH > 0) cfg["h"] = userH.ToString();
            Store.SaveCfg(cfgPath, cfg);
        }

        void ToggleCollapse()
        {
            collapsed = !collapsed;
            ApplyLayout();
            SaveState();
        }

        void ApplyLayout()
        {
            int visible = 0;
            foreach (Item it in items) if (!(hideDone && it.Done)) visible++;
            if (!scheduleMode)
            {
                int wdT = (int)DateTime.Today.DayOfWeek; if (wdT == 0) wdT = 7;
                int wkT = CurrentWeek();
                foreach (ClassSlot c in classes) if (c.Day == wdT && c.InWeek(wkT)) visible++;
                foreach (Evt e in events) if (e.Date == DateTime.Today) visible++;
            }

            if (collapsed)
            {
                table.Visible = false;
                MinimumSize = new Size(CSPX, CSPX);
                Width = CSPX;
                Height = CSPX;
                if (dockSide != 0)
                {
                    Rectangle wa0 = Screen.PrimaryScreen.WorkingArea;
                    Left = (dockSide == 1) ? wa0.Left : wa0.Right - Width;
                }
                try
                {
                    using (GraphicsPath p = new GraphicsPath())
                    {
                        p.AddEllipse(0, 0, Width, Height);
                        Region = new Region(p);
                    }
                }
                catch { }
                Invalidate();
                return;
            }

            table.Visible = true;
            MinimumSize = new Size((int)Math.Round(250 * S), (int)Math.Round(140 * S));

            int rowsH = visible * ROW + 8;
            int minRows = (int)Math.Round(ROW * 2.2);
            if (rowsH < minRows) rowsH = minRows;
            int h = HEAD + rowsH + FOOT;
            if (scheduleMode) h = HEAD + (int)Math.Round(420 * S) + FOOT;
            if (h > MAXH) h = MAXH;

            if (userSized && userW > 0 && userH > 0)
            {
                Width = userW;
                Height = userH;
            }
            else
            {
                Width = W;
                Height = h;
            }
            if (dockSide != 0)
            {
                Rectangle wa1 = Screen.PrimaryScreen.WorkingArea;
                Left = (dockSide == 1) ? wa1.Left : wa1.Right - Width;
            }
            RoundCorners();
            Rebuild();
        }

        void LayoutListArea()
        {
            if (viewport == null || list == null) return;
            list.Width = viewport.ClientSize.Width;
            LayoutFlow(list, viewport.ClientSize.Height, ref listScroll);

            if (lblArchiveNow != null && lblArchiveNow.Visible)
            {
                int w = (int)Math.Round(76 * S);
                int h = (int)Math.Round(26 * S);
                int x = 12;
                int y = viewport.ClientSize.Height - h - (int)Math.Round(10 * S);
                lblArchiveNow.SetBounds(x, y, w, h);
                try
                {
                    using (GraphicsPath p = Ui.Round(new Rectangle(0, 0, lblArchiveNow.Width, lblArchiveNow.Height), h / 2))
                        lblArchiveNow.Region = new Region(p);
                }
                catch { }
            }
        }

        void LayoutDayArea()
        {
            if (dayViewport == null || dayList == null) return;
            dayList.Width = dayViewport.ClientSize.Width;
            LayoutFlow(dayList, dayViewport.ClientSize.Height, ref dayScroll);
        }

        void LayoutFlow(FlowLayoutPanel flow, int viewH, ref int scroll)
        {
            int w = flow.ClientSize.Width - flow.Padding.Horizontal - 6;
            if (w < 80) w = 80;
            int bottom = 0;
            foreach (Control c in flow.Controls)
            {
                if (c.Width != w) c.Width = w;
                bottom = Math.Max(bottom, c.Bottom);
            }
            int contentH = bottom + flow.Padding.Bottom + 4;
            int maxScroll = contentH - viewH;
            if (maxScroll < 0) maxScroll = 0;
            if (scroll > maxScroll) scroll = maxScroll;
            if (scroll < 0) scroll = 0;
            flow.Top = -scroll;
            if (flow.Height != contentH) flow.Height = contentH;
        }

        void ScrollArea(int delta)
        {
            if (scheduleMode)
            {
                dayScroll += delta;
                LayoutDayArea();
                dayViewport.Invalidate();
            }
            else
            {
                listScroll += delta;
                LayoutListArea();
                viewport.Invalidate();
            }
        }

        void ViewportPaint(object s2, PaintEventArgs e) { PaintThinBar(e.Graphics, viewport, list, listScroll); }
        void DayViewportPaint(object s2, PaintEventArgs e) { PaintThinBar(e.Graphics, dayViewport, dayList, dayScroll); }

        static void PaintThinBar(Graphics g, Panel host, Control flow, int scroll)
        {
            if (host == null || flow == null) return;
            int viewH = host.ClientSize.Height;
            int contentH = flow.Height;
            if (contentH <= viewH + 4) return;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int barH = Math.Max(24, (int)((float)viewH * viewH / contentH));
            int maxScroll = contentH - viewH;
            int y = (int)((float)(viewH - barH) * scroll / Math.Max(1, maxScroll));
            Rectangle r = new Rectangle(host.ClientSize.Width - 5, y + 2, 3, barH - 4);
            using (GraphicsPath p = Ui.Round(r, 2))
            using (SolidBrush b = new SolidBrush(Color.FromArgb(70, 200, 200, 210)))
                g.FillPath(b, p);
        }

        void Rebuild()
        {
            building = true;
            list.SuspendLayout();
            List<Control> old = new List<Control>();
            foreach (Control c in list.Controls) old.Add(c);
            list.Controls.Clear();
            foreach (Control c in old) c.Dispose();

            int shown = 0;

            int wdToday = (int)DateTime.Today.DayOfWeek; if (wdToday == 0) wdToday = 7;
            int wkNow = CurrentWeek();
            List<ClassSlot> todayCls = new List<ClassSlot>();
            foreach (ClassSlot c in classes) if (c.Day == wdToday && c.InWeek(wkNow)) todayCls.Add(c);
            todayCls.Sort(delegate(ClassSlot a, ClassSlot b) { return a.StartMin.CompareTo(b.StartMin); });

            List<Evt> todayEvt0 = new List<Evt>();
            foreach (Evt e in events) if (e.Date == DateTime.Today) todayEvt0.Add(e);
            todayEvt0.Sort(delegate(Evt a, Evt b) { return a.StartMin.CompareTo(b.StartMin); });

            // 课与安排按时间交错
            List<object> fixedRows = new List<object>();
            List<int> fixedKeys = new List<int>();
            foreach (ClassSlot c in todayCls) { fixedRows.Add(c); fixedKeys.Add(c.StartMin); }
            foreach (Evt e in todayEvt0) { fixedRows.Add(e); fixedKeys.Add(e.StartMin); }
            for (int i = 0; i < fixedRows.Count; i++)
                for (int j = i + 1; j < fixedRows.Count; j++)
                    if (fixedKeys[j] < fixedKeys[i])
                    {
                        int tk = fixedKeys[i]; fixedKeys[i] = fixedKeys[j]; fixedKeys[j] = tk;
                        object to = fixedRows[i]; fixedRows[i] = fixedRows[j]; fixedRows[j] = to;
                    }

            if (fixedRows.Count > 0)
            {
                Label dayHead = new Label();
                dayHead.AutoSize = false;
                dayHead.Height = (int)Math.Round(26 * S);
                dayHead.TextAlign = ContentAlignment.MiddleLeft;
                dayHead.Padding = new Padding((int)Math.Round(4 * S), 0, 0, 0);
                dayHead.ForeColor = Ui.FAINT;
                dayHead.Font = fCount;
                dayHead.BackColor = Ui.CARD;
                dayHead.Text = "今天 · " + DateTime.Today.ToString("M月d日") + " 周" +
                    "日一二三四五六".Substring((int)DateTime.Today.DayOfWeek, 1);
                dayHead.Width = viewport.ClientSize.Width - 12;
                list.Controls.Add(dayHead);
            }

            foreach (object o in fixedRows)
            {
                Evt ev0 = o as Evt;
                if (ev0 != null)
                {
                    Item dm = new Item();
                    dm.Text = ev0.Name;
                    TodoRow er0 = new TodoRow(dm, ROW, fItem, fItemDone);
                    er0.IsClass = true;
                    er0.Prefix = ev0.Prefix;
                    er0.Tag = ev0.Kind;
                    er0.CatTag = ev0.Cat;
                    er0.CatColor = Store.CatColor(ev0.Cat);
                    er0.Ref = ev0;
                    er0.Width = viewport.ClientSize.Width - 12;
                    er0.Margin = new Padding(0);
                    er0.MenuRequested += delegate(TodoRow r, Point at)
                    {
                        Evt e1 = r.Ref as Evt;
                        if (e1 != null) ShowEvtMenu(e1, at);
                        else OpenClasses();
                    };
                    AttachTip(er0, ev0.Name, new string[] { ev0.Kind + " · " + ev0.Cat, ev0.Prefix });
                    list.Controls.Add(er0);
                    shown++;
                    continue;
                }
                ClassSlot c = (ClassSlot)o;
                {
                Item dummy = new Item();
                dummy.Text = c.Name;
                TodoRow cr = new TodoRow(dummy, ROW, fItem, fItemDone);
                cr.IsClass = true;
                cr.Prefix = c.StartText + "-" + c.EndText;
                cr.CatTag = "日常";
                cr.CatColor = Store.CatColor("日常");
                cr.Width = viewport.ClientSize.Width - 12;
                cr.Margin = new Padding(0);
                cr.MenuRequested += delegate(TodoRow r, Point at) { OpenClasses(); };
                AttachTip(cr, c.Name, new string[] { "课程", c.StartText + "-" + c.EndText });
                list.Controls.Add(cr);
                shown++;
                }
            }

            if (fixedRows.Count > 0)
            {
                Panel sep = new Panel();
                sep.AutoSize = false;
                sep.Height = 1;
                sep.BackColor = Ui.LINE;
                sep.Margin = new Padding(6, 8, 10, 8);
                sep.Width = viewport.ClientSize.Width - 28;
                list.Controls.Add(sep);
                Panel gap = new Panel();
                gap.AutoSize = false;
                gap.Height = (int)Math.Round(6 * S);
                gap.BackColor = Ui.CARD;
                list.Controls.Add(gap);
            }

            foreach (Item it in items)
            {
                if (hideDone && it.Done) continue;
                list.Controls.Add(MakeRow(it));
                shown++;
            }
            if (shown == 0)
            {
                Label hint = new Label();
                hint.AutoSize = false;
                hint.Height = (int)Math.Round(72 * S);
                hint.TextAlign = ContentAlignment.MiddleCenter;
                hint.ForeColor = Color.FromArgb(108, 104, 96);
                hint.Font = fHint;
                hint.Text = items.Count == 0 ? "空着，在下面写第一条" : "都做完了";
                hint.Width = viewport.ClientSize.Width - 12;
                list.Controls.Add(hint);
            }

            int done = 0;
            foreach (Item it in items) if (it.Done) done++;
            lblCount.Text = items.Count == 0 ? "" : (done + "/" + items.Count);

            if (lblArchiveNow != null)
            {
                lblArchiveNow.Text = "归档 " + done;
                lblArchiveNow.Visible = (!scheduleMode && done > 0);
                if (lblArchiveNow.Visible) lblArchiveNow.BringToFront();
            }

            list.ResumeLayout();
            building = false;
            LayoutListArea();
        }

        Control MakeRow(Item it)
        {
            TodoRow row = new TodoRow(it, ROW, fItem, fItemDone);
            row.Width = viewport.ClientSize.Width - 12;
            row.Margin = new Padding(0);
            row.Toggled += delegate(TodoRow r)
            {
                Persist();
                Rebuild();
            };
            row.MenuRequested += delegate(TodoRow r, Point at) { ShowRowMenu(r, r.Data, at); };
            AttachTip(row, it.Text, TipLinesOf(it));
            return row;
        }

        void ShowRowMenu(Control anchor, Item it, Point at)
        {
            ContextMenuStrip m = Ui.Menu(fItem);

            ToolStripItem dur = m.Items.Add(it.Minutes > 0 ? "改预计耗时…" : "预计耗时…");
            dur.Click += delegate
            {
                string v = Prompt.Show("预计耗时（分钟，留空清除）", it.Minutes > 0 ? it.Minutes.ToString() : "30");
                if (v == null) return;
                v = v.Trim();
                if (v.Length == 0) { it.Minutes = 0; }
                else
                {
                    int mm;
                    if (int.TryParse(v, out mm) && mm > 0 && mm < 1440) it.Minutes = mm;
                }
                Persist();
                RefreshAll();
            };

            ToolStripItem when = m.Items.Add(it.Due.HasValue ? "改截止时间…" : "设置截止时间…");
            when.Click += delegate { SetDue(it); };

            if (it.Due.HasValue)
            {
                ToolStripItem clr = m.Items.Add("清除截止时间");
                clr.Click += delegate { it.Due = null; Persist(); RefreshAll(); };
            }
            m.Items.Add(new ToolStripSeparator());

            ToolStripItem edit = m.Items.Add("改文字");
            edit.Click += delegate
            {
                string v = Prompt.Show("改一下", it.Text);
                if (v != null && v.Trim().Length > 0) { it.Text = v.Trim(); Persist(); RefreshAll(); }
            };
            ToolStripItem del = m.Items.Add("删除这条");
            del.Click += delegate { items.Remove(it); Persist(); RefreshAll(); };
            m.Show(Cursor.Position);
        }

        void ShowEvtMenu(Evt ev, Point at)
        {
            ContextMenuStrip m = Ui.Menu(fItem);

            ToolStripMenuItem head = new ToolStripMenuItem(ev.Name.Length > 16 ? ev.Name.Substring(0, 16) + "…" : ev.Name);
            head.Enabled = false;
            m.Items.Add(head);
            m.Items.Add(new ToolStripSeparator());

            foreach (string cat in Store.Cats)
            {
                string c = cat;
                ToolStripMenuItem mi = new ToolStripMenuItem("归为「" + c + "」");
                mi.Checked = ev.Cat == c;
                mi.Click += delegate { SetEvtCat(ev, c); };
                m.Items.Add(mi);
            }

            m.Items.Add(new ToolStripSeparator());
            ToolStripMenuItem man = new ToolStripMenuItem("管理课表…");
            man.Click += delegate { OpenClasses(); };
            m.Items.Add(man);

            m.Show(Cursor.Position);
        }

        void SetEvtCat(Evt ev, string cat)
        {
            List<Evt> all = Store.LoadEvents(eventsPath);
            foreach (Evt x in all)
                if (x.Date == ev.Date && x.StartMin == ev.StartMin && x.EndMin == ev.EndMin &&
                    x.Kind == ev.Kind && x.Name == ev.Name)
                    x.Cat = cat;
            Store.SaveEvents(eventsPath, all);
            events = all;
            ev.Cat = cat;
            if (scheduleMode) RebuildSchedule();
            else Rebuild();
        }

        void SetDue(Item it)
        {
            DateTime? due = DueDialog.Ask(it, S);
            if (due == null) return;
            it.Due = due;
            Persist();
            RefreshAll();
        }

        void RefreshAll()
        {
            if (scheduleMode) RebuildSchedule();
            else Rebuild();
            ApplyLayout();
        }

        void ArchiveDone()
        {
            List<Item> keep = new List<Item>();
            List<Item> gone = new List<Item>();
            foreach (Item it in items)
            {
                if (it.Done) gone.Add(it);
                else keep.Add(it);
            }
            if (gone.Count == 0) return;

            List<Item> arch = Store.Load(archivePath);
            foreach (Item it in gone)
            {
                it.Done = true;
                arch.Add(it);
            }
            Store.Save(archivePath, Store.Serialize(arch));
            items = keep;
            Persist();
            RefreshAll();
        }

        void AttachTip(TodoRow row, string head, string[] lines)
        {
            row.TipHead = head;
            row.TipLines = lines;
            row.HoverIn += delegate(TodoRow r)
            {
                tipRow = r;
                tipTimer.Stop();
                tipTimer.Start();
            };
            row.HoverOut += delegate(TodoRow r)
            {
                if (tipRow != r) return;
                tipRow = null;
                tipTimer.Stop();
                if (tipWin != null) tipWin.HideTip();
            };
        }

        string[] TipLinesOf(Item it)
        {
            List<string> l = new List<string>();
            l.Add("紧要程度　" + (it.Priority.Length > 0 ? it.Priority : "未设"));
            l.Add("死线　　　" + (it.Due.HasValue ? it.Due.Value.ToString("MM-dd HH:mm") : "无"));
            l.Add("预计耗时　" + (it.Minutes > 0 ? it.Minutes + " 分钟" : "未估"));
            l.Add("状态　　　" + (it.Done ? "已完成" : "未完成"));
            return l.ToArray();
        }

        string BuildTip(Item it)
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine(it.Text);
            sb.AppendLine("——————");
            sb.AppendLine("紧要程度：" + (it.Priority.Length > 0 ? it.Priority : "未设"));
            sb.AppendLine("死线：" + (it.Due.HasValue ? it.Due.Value.ToString("yyyy-MM-dd HH:mm") : "无"));
            sb.AppendLine("预计耗时：" + (it.Minutes > 0 ? it.Minutes + " 分钟" : "未估"));
            sb.Append("状态：" + (it.Done ? "已完成" : "未完成"));
            return sb.ToString();
        }

        void OpenArchive()
        {
            ArchiveDialog.Open(archivePath, S);
            RefreshAll();
        }

        void HeadMenu()
        {
            ContextMenuStrip m = Ui.Menu(fItem);

            ToolStripMenuItem t1 = new ToolStripMenuItem("隐藏已完成");
            t1.Checked = hideDone;
            t1.Click += delegate { hideDone = !hideDone; ApplyLayout(); SaveState(); };
            m.Items.Add(t1);

            ToolStripMenuItem t2 = new ToolStripMenuItem("总在最上层");
            t2.Checked = TopMost;
            t2.Click += delegate { TopMost = !TopMost; SaveState(); };
            m.Items.Add(t2);

            m.Items.Add(new ToolStripSeparator());

            int doneCount = 0;
            foreach (Item it in items) if (it.Done) doneCount++;

            ToolStripItem t3 = m.Items.Add(doneCount > 0 ? ("归档已完成（" + doneCount + "）") : "归档已完成");
            t3.Enabled = doneCount > 0;
            t3.Click += delegate { ArchiveDone(); };

            ToolStripItem t3b = m.Items.Add("查看归档…");
            t3b.Click += delegate { OpenArchive(); };
            ToolStripItem tkc = m.Items.Add("课表…");
            tkc.Click += delegate { OpenClasses(); };

            ToolStripItem t4 = m.Items.Add("打开数据文件夹");
            t4.Click += delegate { try { System.Diagnostics.Process.Start("explorer.exe", "\"" + dir + "\""); } catch { } };

            m.Items.Add(new ToolStripSeparator());
            ToolStripItem t5 = m.Items.Add("退出");
            t5.Click += delegate { SaveState(); Close(); };

            dockMenuOpen = true;
            m.Closed += delegate { dockMenuOpen = false; };
            m.Show(Cursor.Position);
        }

        void DragMove(object s, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;

            // 点在左上角徽记上 = 收起成球
            if (s == head && emblemHit.Width > 0 && emblemHit.Contains(e.Location))
            {
                ToggleCollapse();
                return;
            }

            Natives.ReleaseCapture();
            Natives.SendMessage(Handle, Natives.WM_NCLBUTTONDOWN, (IntPtr)Natives.HTCAPTION, IntPtr.Zero);
        }

        protected override void WndProc(ref Message m)
        {
            const int WM_NCHITTEST = 0x84;
            const int WM_EXITSIZEMOVE = 0x232;

            if (m.Msg == WM_EXITSIZEMOVE && !collapsed)
            {
                userSized = true;
                userW = Width;
                userH = Height;
                UpdateDock();
                SaveState();
                base.WndProc(ref m);
                return;
            }

            const int WM_MOUSEWHEEL = 0x020A;
            if (m.Msg == WM_MOUSEWHEEL && !collapsed)
            {
                int delta = (short)((m.WParam.ToInt64() >> 16) & 0xFFFF);
                ScrollArea(-delta / 3);
                return;
            }

            if (m.Msg == WM_NCHITTEST && !collapsed)
            {
                long lp = m.LParam.ToInt64();
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);
                Point pt = PointToClient(new Point(sx, sy));
                int e = (int)Math.Round(7 * S);
                bool left = pt.X <= e;
                bool right = pt.X >= ClientSize.Width - e;
                bool top = pt.Y <= e;
                bool bottom = pt.Y >= ClientSize.Height - e;
                int hit = 0;
                if (top && left) hit = 13;
                else if (top && right) hit = 14;
                else if (bottom && left) hit = 16;
                else if (bottom && right) hit = 17;
                else if (left) hit = 10;
                else if (right) hit = 11;
                else if (bottom) hit = 15;
                else if (top) hit = 12;
                if (hit != 0) { m.Result = (IntPtr)hit; return; }
            }
            base.WndProc(ref m);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (!collapsed) return;
            if (e.Button == MouseButtons.Left) { pressScreen = Cursor.Position; pressMoved = false; }
            else if (e.Button == MouseButtons.Right) HeadMenu();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (!collapsed || e.Button != MouseButtons.Left) return;
            Point cur = Cursor.Position;
            if (!pressMoved && (Math.Abs(cur.X - pressScreen.X) > 3 || Math.Abs(cur.Y - pressScreen.Y) > 3))
                pressMoved = true;
            if (pressMoved)
            {
                Location = new Point(Location.X + (cur.X - pressScreen.X), Location.Y + (cur.Y - pressScreen.Y));
                pressScreen = cur;
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (collapsed)
            {
                if (e.Button == MouseButtons.Left && !pressMoved) ToggleCollapse();
                else if (pressMoved) SaveState();
                return;
            }
            SaveState();
        }

        void InputKeyDown(object s, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; AddFromInput(); }
            else if (e.KeyCode == Keys.Escape) input.Text = "";
        }

        static readonly Regex DuePattern = new Regex(@"\s*@\s*(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?\s*$", RegexOptions.Compiled);
        static readonly Regex TimePattern = new Regex(@"\s*@\s*(\d{1,2}):(\d{2})\s*$", RegexOptions.Compiled);

        void OpenNewDialog(string prefill)
        {
            Item made = NewTodoDialog.Ask(Store.Clean(prefill), S);
            if (made == null) return;
            int pos = items.Count;
            for (int i = 0; i < items.Count; i++)
                if (items[i].Done) { pos = i; break; }
            items.Insert(pos, made);
            input.Text = "";
            Persist();
            RefreshAll();
            input.Focus();
        }

        void AddFromInput()
        {
            OpenNewDialog(input.Text);
        }

        void Persist()
        {
            string body = Store.Serialize(items);
            try { Store.Save(dataPath, body); snapshot = body; }
            catch (Exception ex) { MessageBox.Show("写入失败：" + ex.Message, "待办"); }
        }

        void ReloadFromDisk(bool first)
        {
            string body = "";
            if (File.Exists(dataPath))
            {
                try { body = File.ReadAllText(dataPath, Encoding.UTF8); } catch { }
            }
            body += "#" + (File.Exists(eventsPath) ? SafeRead(eventsPath) : "");
            body += "#" + (File.Exists(classesPath) ? SafeRead(classesPath) : "");
            if (body == snapshot && !first) return;
            snapshot = body;
            items = Store.Load(dataPath);
            if (first && items.Count == 0)
            {
                Item seed = new Item();
                seed.Done = false;
                seed.Text = "点一下勾掉试试；输入框里可以写 “买牛奶 @11-20 18:00”";
                items.Add(seed);
                Persist();
            }
            Rebuild();
            if (scheduleMode) RebuildSchedule();
        }

        static string SafeRead(string path)
        {
            try { return File.ReadAllText(path, Encoding.UTF8); } catch { return ""; }
        }

        void StartPolling()
        {
            poll = new System.Windows.Forms.Timer();
            poll.Interval = 1000;
            poll.Tick += delegate
            {
                try
                {
                    string body = (File.Exists(dataPath) ? File.ReadAllText(dataPath, Encoding.UTF8) : "")
                                + "#" + (File.Exists(eventsPath) ? File.ReadAllText(eventsPath, Encoding.UTF8) : "")
                                + "#" + (File.Exists(classesPath) ? File.ReadAllText(classesPath, Encoding.UTF8) : "");
                    if (body != snapshot)
                    {
                        snapshot = body;
                        items = Store.Load(dataPath);
                        events = Store.LoadEvents(eventsPath);
                        classes = Store.LoadClasses(classesPath);
                        Rebuild();
                        if (scheduleMode) RebuildSchedule();
                    }
                }
                catch { }
            };
            poll.Start();
        }

        void StartBreathing()
        {
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 45;
            t.Tick += delegate
            {
                if (!collapsed) return;
                breath += 0.155f;
                if (breath > (float)(Math.PI * 200)) breath = 0f;
                Invalidate();
            };
            t.Start();
        }

        void AnimTick(object s, EventArgs e)
        {
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveState();
            base.OnFormClosing(e);
        }
    }

    class TipWindow : Form
    {
        string head = "";
        string[] lines = new string[0];
        Font fHead = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        Font fBody = new Font("Microsoft YaHei UI", 9f);

        public TipWindow()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.FromArgb(40, 40, 46);
            DoubleBuffered = true;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x08000000;   // WS_EX_NOACTIVATE
                return cp;
            }
        }

        public void ShowTip(string h, string[] ls, Point at)
        {
            head = h ?? "";
            lines = ls ?? new string[0];

            int w = 0, hgt = 0;
            using (Graphics g = CreateGraphics())
            {
                Size hs = TextRenderer.MeasureText(g, head, fHead);
                w = hs.Width; hgt = hs.Height + 10;
                foreach (string l in lines)
                {
                    Size s2 = TextRenderer.MeasureText(g, l, fBody);
                    if (s2.Width > w) w = s2.Width;
                    hgt += s2.Height + 3;
                }
            }
            Width = Math.Max(140, w + 30);
            Height = hgt + 18;

            Rectangle wa = Screen.FromPoint(at).WorkingArea;
            int x = at.X + 18, y = at.Y + 22;
            if (x + Width > wa.Right) x = wa.Right - Width - 8;
            if (x < wa.Left) x = wa.Left + 8;
            if (y + Height > wa.Bottom) y = at.Y - Height - 14;
            if (y < wa.Top) y = wa.Top + 8;
            Location = new Point(x, y);

            try
            {
                using (GraphicsPath p = Ui.Round(new Rectangle(0, 0, Width, Height), 10))
                    Region = new Region(p);
            }
            catch { }
            if (!Visible) Show(); else Invalidate();
        }

        public void HideTip() { Visible = false; }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;

            using (GraphicsPath p = Ui.Round(new Rectangle(0, 0, Width - 1, Height - 1), 10))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(247, 40, 40, 46))) g.FillPath(b, p);
                using (Pen pen = new Pen(Color.FromArgb(255, 70, 70, 78), 1f)) g.DrawPath(pen, p);
            }

            int y = 9;
            TextRenderer.DrawText(g, head, fHead, new Rectangle(15, y, Width - 30, 22), Color.FromArgb(240, 240, 238),
                TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
            y += 24;
            foreach (string l in lines)
            {
                TextRenderer.DrawText(g, l, fBody, new Rectangle(15, y, Width - 30, 20), Color.FromArgb(168, 166, 160),
                    TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine);
                y += 20;
            }
        }
    }

    class DarkMenu : ToolStripProfessionalRenderer
    {
        public DarkMenu() : base(new DarkColors()) { RoundedEdges = false; }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Ui.INK : Color.FromArgb(112, 109, 102);
            e.TextFormat |= TextFormatFlags.NoPrefix;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            Rectangle r = e.ImageRectangle;
            if (r.Width < 6 || r.Height < 6) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (Pen p = new Pen(Color.FromArgb(140, 196, 158), 1.8f))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                Point[] pts = {
                    new Point(r.Left + (int)(r.Width * 0.15), r.Top + (int)(r.Height * 0.52)),
                    new Point(r.Left + (int)(r.Width * 0.42), r.Top + (int)(r.Height * 0.78)),
                    new Point(r.Left + (int)(r.Width * 0.88), r.Top + (int)(r.Height * 0.22))
                };
                e.Graphics.DrawLines(p, pts);
            }
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = Color.FromArgb(188, 184, 176);
            base.OnRenderArrow(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            Rectangle b = e.Item.Bounds;
            using (Pen p = new Pen(Color.FromArgb(56, 56, 63), 1f))
                e.Graphics.DrawLine(p, b.Left + 8, b.Top + b.Height / 2, b.Right - 8, b.Top + b.Height / 2);
        }
    }

    class DarkColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground { get { return Color.FromArgb(38, 38, 43); } }
        public override Color ImageMarginGradientBegin { get { return Color.FromArgb(38, 38, 43); } }
        public override Color ImageMarginGradientMiddle { get { return Color.FromArgb(38, 38, 43); } }
        public override Color ImageMarginGradientEnd { get { return Color.FromArgb(38, 38, 43); } }
        public override Color MenuBorder { get { return Color.FromArgb(58, 58, 66); } }
        public override Color MenuItemBorder { get { return Color.FromArgb(58, 58, 66); } }
        public override Color MenuItemSelected { get { return Color.FromArgb(52, 52, 60); } }
        public override Color SeparatorDark { get { return Color.FromArgb(52, 52, 58); } }
        public override Color SeparatorLight { get { return Color.FromArgb(52, 52, 58); } }
    }

    class Prompt : Form
    {
        TextBox box;
        public static string Show(string title, string value)
        {
            using (Prompt f = new Prompt())
            {
                f.Text = title;
                f.Width = 400;
                f.Height = 140;
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.MinimizeBox = false;
                f.MaximizeBox = false;
                f.TopMost = true;
                f.BackColor = Ui.CARD;
                f.ForeColor = Ui.INK;
                f.box = new TextBox();
                f.box.Text = value;
                f.box.SetBounds(16, 18, 356, 24);
                f.box.SelectAll();
                f.Controls.Add(f.box);
                Button ok = new Button();
                ok.Text = "确定";
                ok.SetBounds(210, 60, 76, 28);
                ok.DialogResult = DialogResult.OK;
                Button cancel = new Button();
                cancel.Text = "取消";
                cancel.SetBounds(296, 60, 76, 28);
                cancel.DialogResult = DialogResult.Cancel;
                f.Controls.Add(ok);
                f.Controls.Add(cancel);
                f.AcceptButton = ok;
                f.CancelButton = cancel;
                return f.ShowDialog() == DialogResult.OK ? f.box.Text : null;
            }
        }
    }

    class DueDialog : Form
    {
        DateTimePicker picker;
        public static DateTime? Ask(Item it, float scale)
        {
            using (DueDialog f = new DueDialog())
            {
                f.Text = "截止时间";
                f.Width = (int)Math.Round(360 * scale);
                f.Height = (int)Math.Round(160 * scale);
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.StartPosition = FormStartPosition.CenterScreen;
                f.MinimizeBox = false;
                f.MaximizeBox = false;
                f.TopMost = true;

                f.picker = new DateTimePicker();
                f.picker.Format = DateTimePickerFormat.Custom;
                f.picker.CustomFormat = "yyyy-MM-dd HH:mm";
                f.picker.ShowUpDown = true;
                f.picker.Value = it.Due.HasValue ? it.Due.Value : DateTime.Now.AddHours(2);
                f.picker.SetBounds((int)(16 * scale), (int)(20 * scale), (int)(300 * scale), (int)(26 * scale));
                f.Controls.Add(f.picker);

                Button ok = new Button();
                ok.Text = "确定";
                ok.DialogResult = DialogResult.OK;
                ok.SetBounds((int)(180 * scale), (int)(70 * scale), (int)(70 * scale), (int)(28 * scale));
                Button no = new Button();
                no.Text = "清除";
                no.DialogResult = DialogResult.Abort;
                no.SetBounds((int)(256 * scale), (int)(70 * scale), (int)(70 * scale), (int)(28 * scale));
                f.Controls.Add(ok);
                f.Controls.Add(no);
                f.AcceptButton = ok;

                DialogResult r = f.ShowDialog();
                if (r == DialogResult.OK) return f.picker.Value;
                if (r == DialogResult.Abort) return null;
                return it.Due;
            }
        }
    }

    class ClassDialog : Form
    {
        ListBox lb;
        ComboBox cbDay;
        TextBox tbStart, tbEnd, tbName;
        string path;
        List<ClassSlot> slots = new List<ClassSlot>();
        float S = 1f;

        static readonly string[] WD = { "周一", "周二", "周三", "周四", "周五", "周六", "周日" };

        public static void Open(string path, float scale)
        {
            using (ClassDialog f = new ClassDialog())
            {
                f.path = path;
                f.S = scale;
                f.Build();
                f.ShowDialog();
            }
        }

        void Build()
        {
            slots = Store.LoadClasses(path);
            Text = "课表";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            TopMost = true;
            Width = (int)(430 * S);
            Height = (int)(380 * S);
            BackColor = Ui.CARD;
            ForeColor = Ui.INK;

            lb = new ListBox();
            lb.SetBounds((int)(14 * S), (int)(14 * S), (int)(390 * S), (int)(160 * S));
            lb.BackColor = Color.FromArgb(42, 42, 48);
            lb.ForeColor = Ui.INK;
            lb.BorderStyle = BorderStyle.FixedSingle;
            Controls.Add(lb);

            cbDay = new ComboBox();
            cbDay.DropDownStyle = ComboBoxStyle.DropDownList;
            cbDay.Items.AddRange(WD);
            cbDay.SelectedIndex = 0;
            cbDay.SetBounds((int)(14 * S), (int)(186 * S), (int)(72 * S), (int)(26 * S));
            Controls.Add(cbDay);

            tbStart = new TextBox();
            tbStart.Text = "08:00";
            tbStart.SetBounds((int)(92 * S), (int)(186 * S), (int)(64 * S), (int)(26 * S));
            Controls.Add(tbStart);

            tbEnd = new TextBox();
            tbEnd.Text = "09:40";
            tbEnd.SetBounds((int)(162 * S), (int)(186 * S), (int)(64 * S), (int)(26 * S));
            Controls.Add(tbEnd);

            tbName = new TextBox();
            tbName.SetBounds((int)(232 * S), (int)(186 * S), (int)(172 * S), (int)(26 * S));
            Controls.Add(tbName);

            Button add = new Button();
            add.Text = "添加";
            add.SetBounds((int)(14 * S), (int)(224 * S), (int)(86 * S), (int)(28 * S));
            add.Click += delegate { AddSlot(); };
            Controls.Add(add);

            Button save = new Button();
            save.Text = "保存修改";
            save.SetBounds((int)(106 * S), (int)(224 * S), (int)(92 * S), (int)(28 * S));
            save.Click += delegate { SaveSlot(); };
            Controls.Add(save);

            Button del = new Button();
            del.Text = "删除选中";
            del.SetBounds((int)(204 * S), (int)(224 * S), (int)(92 * S), (int)(28 * S));
            del.Click += delegate { DelSlot(); };
            Controls.Add(del);

            lb.SelectedIndexChanged += delegate { FillFromSelection(); };

            Button close = new Button();
            close.Text = "关闭";
            close.SetBounds((int)(300 * S), (int)(300 * S), (int)(104 * S), (int)(30 * S));
            close.Click += delegate { Close(); };
            Controls.Add(close);

            RefreshList();
        }

        void RefreshList()
        {
            slots.Sort(delegate(ClassSlot a, ClassSlot b)
            {
                if (a.Day != b.Day) return a.Day.CompareTo(b.Day);
                return a.StartMin.CompareTo(b.StartMin);
            });
            lb.Items.Clear();
            foreach (ClassSlot c in slots)
                lb.Items.Add(WD[c.Day - 1] + "  " + c.StartText + "-" + c.EndText + "  " + c.Name);
        }

        void AddSlot()
        {
            ClassSlot c = new ClassSlot();
            c.Day = cbDay.SelectedIndex + 1;
            c.StartMin = ClassSlot.Parse(tbStart.Text.Trim());
            c.EndMin = ClassSlot.Parse(tbEnd.Text.Trim());
            if (c.EndMin <= c.StartMin) c.EndMin = c.StartMin + 45;
            c.Name = Store.Clean(tbName.Text);
            if (c.Name.Length == 0) c.Name = "课";
            slots.Add(c);
            Store.SaveClasses(path, slots);
            RefreshList();
            tbName.Text = "";
        }

        void FillFromSelection()
        {
            int i = lb.SelectedIndex;
            if (i < 0 || i >= slots.Count) return;
            ClassSlot c = slots[i];
            cbDay.SelectedIndex = Math.Max(0, Math.Min(6, c.Day - 1));
            tbStart.Text = c.StartText;
            tbEnd.Text = c.EndText;
            tbName.Text = c.Name;
        }

        void SaveSlot()
        {
            int i = lb.SelectedIndex;
            if (i < 0 || i >= slots.Count) return;
            ClassSlot c = slots[i];
            c.Day = cbDay.SelectedIndex + 1;
            c.StartMin = ClassSlot.Parse(tbStart.Text.Trim());
            c.EndMin = ClassSlot.Parse(tbEnd.Text.Trim());
            if (c.EndMin <= c.StartMin) c.EndMin = c.StartMin + 45;
            c.Name = Store.Clean(tbName.Text);
            if (c.Name.Length == 0) c.Name = "课";
            Store.SaveClasses(path, slots);
            RefreshList();
            if (i < lb.Items.Count) lb.SelectedIndex = i;
        }

        void DelSlot()
        {
            int i = lb.SelectedIndex;
            if (i < 0 || i >= slots.Count) return;
            slots.RemoveAt(i);
            Store.SaveClasses(path, slots);
            RefreshList();
        }
    }

    class ArchiveDialog : Form
    {
        ListBox lb;
        string path;
        string todoPath;
        List<Item> items = new List<Item>();
        float S = 1f;

        public static void Open(string archivePath, float scale)
        {
            using (ArchiveDialog f = new ArchiveDialog())
            {
                f.path = archivePath;
                f.todoPath = Path.Combine(Path.GetDirectoryName(archivePath), "todos.txt");
                f.S = scale;
                f.Build();
                f.ShowDialog();
            }
        }

        void Build()
        {
            Text = "归档";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            TopMost = true;
            Width = (int)(460 * S);
            Height = (int)(400 * S);
            BackColor = Ui.CARD;
            ForeColor = Ui.INK;

            lb = new ListBox();
            lb.SetBounds((int)(14 * S), (int)(14 * S), (int)(420 * S), (int)(290 * S));
            lb.BackColor = Color.FromArgb(42, 42, 48);
            lb.ForeColor = Ui.INK;
            lb.BorderStyle = BorderStyle.FixedSingle;
            lb.Font = new Font("Microsoft YaHei UI", 9.5f);
            lb.DoubleClick += delegate { RestoreSelected(); };
            Controls.Add(lb);

            Button back = new Button();
            back.Text = "恢复选中";
            back.SetBounds((int)(14 * S), (int)(316 * S), (int)(100 * S), (int)(30 * S));
            back.Click += delegate { RestoreSelected(); };
            Controls.Add(back);

            Button del = new Button();
            del.Text = "永久删除";
            del.SetBounds((int)(122 * S), (int)(316 * S), (int)(100 * S), (int)(30 * S));
            del.Click += delegate { DeleteSelected(); };
            Controls.Add(del);

            Button clear = new Button();
            clear.Text = "清空归档";
            clear.SetBounds((int)(230 * S), (int)(316 * S), (int)(100 * S), (int)(30 * S));
            clear.Click += delegate
            {
                if (MessageBox.Show("清空整个归档？删了就找不回来。", "归档", MessageBoxButtons.OKCancel) != DialogResult.OK) return;
                items.Clear();
                Store.Save(path, "");
                Refresh();
            };
            Controls.Add(clear);

            Button close = new Button();
            close.Text = "关闭";
            close.SetBounds((int)(338 * S), (int)(316 * S), (int)(96 * S), (int)(30 * S));
            close.Click += delegate { Close(); };
            Controls.Add(close);

            Refresh();
        }

        void Refresh()
        {
            items = Store.Load(path);
            lb.Items.Clear();
            foreach (Item it in items)
            {
                string due = it.Due.HasValue ? it.Due.Value.ToString("MM-dd ") : "";
                lb.Items.Add(due + it.Text);
            }
            if (items.Count == 0) lb.Items.Add("（归档是空的）");
        }

        void RestoreSelected()
        {
            int i = lb.SelectedIndex;
            if (i < 0 || i >= items.Count) return;
            Item it = items[i];

            List<Item> todo = Store.Load(todoPath);
            Item back = new Item();
            back.Text = it.Text;
            back.Due = it.Due;
            back.Minutes = it.Minutes;
            back.Done = false;
            todo.Add(back);
            Store.Save(todoPath, Store.Serialize(todo));

            items.RemoveAt(i);
            Store.Save(path, Store.Serialize(items));
            Refresh();
        }

        void DeleteSelected()
        {
            int i = lb.SelectedIndex;
            if (i < 0 || i >= items.Count) return;
            items.RemoveAt(i);
            Store.Save(path, Store.Serialize(items));
            Refresh();
        }
    }

    class NewTodoDialog : Form
    {
        TextBox tbText, tbMin;
        DateTimePicker dtp;
        CheckBox cbDue;
        ComboBox cbPrio;

        public static Item Ask(string prefill, float S)
        {
            using (NewTodoDialog f = new NewTodoDialog())
            {
                f.Build(prefill, S);
                if (f.ShowDialog() != DialogResult.OK) return null;
                if (Store.Clean(f.tbText.Text).Length == 0) return null;

                Item it = new Item();
                it.Text = Store.Clean(f.tbText.Text);
                it.Done = false;
                it.Due = f.cbDue.Checked ? (DateTime?)f.dtp.Value : null;

                int mm;
                if (int.TryParse(f.tbMin.Text.Trim(), out mm) && mm > 0 && mm < 1440) it.Minutes = mm;

                if (f.cbPrio.SelectedIndex > 0)
                    it.Priority = f.cbPrio.SelectedItem.ToString();
                return it;
            }
        }

        void Build(string prefill, float S)
        {
            Text = "新建待办";
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MinimizeBox = false;
            MaximizeBox = false;
            TopMost = true;
            Width = (int)(430 * S);
            Height = (int)(300 * S);
            BackColor = Ui.CARD;
            ForeColor = Ui.INK;

            Font fl = new Font("Microsoft YaHei UI", 9.5f);

            Label l1 = new Label();
            l1.Text = "内容";
            l1.SetBounds((int)(16 * S), (int)(16 * S), (int)(70 * S), (int)(22 * S));
            l1.ForeColor = Ui.MUTED;
            Controls.Add(l1);

            tbText = new TextBox();
            tbText.Font = fl;
            tbText.Text = prefill;
            tbText.SetBounds((int)(16 * S), (int)(40 * S), (int)(382 * S), (int)(26 * S));
            Controls.Add(tbText);

            Label l2 = new Label();
            l2.Text = "死线";
            l2.SetBounds((int)(16 * S), (int)(78 * S), (int)(70 * S), (int)(22 * S));
            l2.ForeColor = Ui.MUTED;
            Controls.Add(l2);

            cbDue = new CheckBox();
            cbDue.Text = "有";
            cbDue.SetBounds((int)(16 * S), (int)(102 * S), (int)(52 * S), (int)(24 * S));
            cbDue.Checked = false;
            Controls.Add(cbDue);

            dtp = new DateTimePicker();
            dtp.Format = DateTimePickerFormat.Custom;
            dtp.CustomFormat = "yyyy-MM-dd HH:mm";
            dtp.ShowUpDown = true;
            dtp.Value = DateTime.Now.AddHours(3);
            dtp.SetBounds((int)(72 * S), (int)(102 * S), (int)(200 * S), (int)(24 * S));
            dtp.Enabled = false;
            Controls.Add(dtp);
            cbDue.CheckedChanged += delegate { dtp.Enabled = cbDue.Checked; };

            Label l3 = new Label();
            l3.Text = "所需时间（分钟，可空）";
            l3.SetBounds((int)(16 * S), (int)(140 * S), (int)(150 * S), (int)(22 * S));
            l3.ForeColor = Ui.MUTED;
            Controls.Add(l3);

            tbMin = new TextBox();
            tbMin.Font = fl;
            tbMin.Text = "";
            tbMin.SetBounds((int)(16 * S), (int)(164 * S), (int)(90 * S), (int)(26 * S));
            Controls.Add(tbMin);

            Label l4 = new Label();
            l4.Text = "紧要程度";
            l4.SetBounds((int)(130 * S), (int)(140 * S), (int)(100 * S), (int)(22 * S));
            l4.ForeColor = Ui.MUTED;
            Controls.Add(l4);

            cbPrio = new ComboBox();
            cbPrio.DropDownStyle = ComboBoxStyle.DropDownList;
            cbPrio.Items.AddRange(new object[] { "（不设）", "S", "A", "B", "C", "D", "E" });
            cbPrio.SelectedIndex = 0;
            cbPrio.SetBounds((int)(130 * S), (int)(164 * S), (int)(90 * S), (int)(26 * S));
            Controls.Add(cbPrio);

            Label lHint = new Label();
            lHint.Text = "S 最急 · E 最缓";
            lHint.SetBounds((int)(232 * S), (int)(168 * S), (int)(160 * S), (int)(22 * S));
            lHint.ForeColor = Ui.FAINT;
            Controls.Add(lHint);

            Button ok = new Button();
            ok.Text = "添加";
            ok.DialogResult = DialogResult.OK;
            ok.SetBounds((int)(220 * S), (int)(222 * S), (int)(84 * S), (int)(30 * S));
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.SetBounds((int)(312 * S), (int)(222 * S), (int)(84 * S), (int)(30 * S));
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
            tbText.SelectAll();
        }
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            try { Natives.SetProcessDPIAware(); } catch { }
            AppDomain.CurrentDomain.UnhandledException += delegate(object s2, UnhandledExceptionEventArgs e2)
            {
                try
                {
                    File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "error.txt"),
                        DateTime.Now.ToString("HH:mm:ss") + " " + e2.ExceptionObject.ToString() + "\r\n\r\n");
                }
                catch { }
            };

            bool created;
            using (Mutex m = new Mutex(true, "DeskTodoXiWei_v3", out created))
            {
                if (!created)
                {
                    IntPtr h = Natives.FindWindow(null, "待办");
                    if (h != IntPtr.Zero) Natives.SetForegroundWindow(h);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }
}
