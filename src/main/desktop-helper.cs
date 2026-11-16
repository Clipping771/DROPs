// DROPs desktop helper: lists windows, screenshots one window, reads and uses its UI (UI Automation),
// and sends mouse and keyboard input. Compiled at run time by Windows PowerShell (no extra programs).
// Every safety rule lives in desktop.js; this file only does what it is asked and reports facts.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class DropsDesk {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int k);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
  static List<AutomationElement> nodes = new List<AutomationElement>();
  static IntPtr nodesWindow = IntPtr.Zero;

  public static void Init() { try { SetProcessDPIAware(); } catch { } }

  /** One request (a JSON line) in, one JSON line out. Never throws. */
  public static string Run(string line) {
    Dictionary<string, object> q = null;
    try {
      q = Json.Deserialize<Dictionary<string, object>>(line);
      var r = Do(q);
      r["id"] = q.ContainsKey("id") ? q["id"] : null; r["ok"] = true;
      return Json.Serialize(r);
    } catch (Exception e) {
      var msg = (e.InnerException ?? e).Message;
      return Json.Serialize(new Dictionary<string, object> { { "id", q != null && q.ContainsKey("id") ? q["id"] : null }, { "ok", false }, { "error", msg } });
    }
  }

  static string S(Dictionary<string, object> q, string k) { return q.ContainsKey(k) && q[k] != null ? Convert.ToString(q[k]) : null; }
  static int I(Dictionary<string, object> q, string k, int d) { return q.ContainsKey(k) && q[k] != null ? Convert.ToInt32(q[k]) : d; }
  static IntPtr H(Dictionary<string, object> q) { return new IntPtr(Convert.ToInt64(q["hwnd"])); }

  static Dictionary<string, object> Do(Dictionary<string, object> q) {
    var r = new Dictionary<string, object>();
    switch (S(q, "op")) {
      case "windows": r["windows"] = Windows(); break;
      case "info": r["window"] = Info(H(q)); break;
      case "state": {
        POINT p; GetCursorPos(out p);
        r["cursor"] = new[] { p.X, p.Y };
        // Low bit: Esc was pressed since the last call.
        r["esc"] = (GetAsyncKeyState(0x1B) & 1) != 0;
        var fg = GetForegroundWindow(); r["foreground"] = Info(fg);
        break;
      }
      case "focus": r["focused"] = Focus(H(q)); r["window"] = Info(H(q)); break;
      case "shot": {
        var h = H(q); int max = I(q, "max", 1280); double scale;
        var bmp = Capture(h, out scale, max);
        using (var ms = new MemoryStream()) {
          if (S(q, "format") == "jpeg") {
            var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.MimeType == "image/jpeg");
            var ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 55L);
            bmp.Save(ms, enc, ep);
          } else bmp.Save(ms, ImageFormat.Png);
          r["data"] = Convert.ToBase64String(ms.ToArray());
        }
        r["width"] = bmp.Width; r["height"] = bmp.Height; r["scale"] = scale;
        r["hash"] = Hash(bmp); bmp.Dispose();
        break;
      }
      case "tree": r["text"] = Tree(H(q), I(q, "max", 400)); r["count"] = nodes.Count; break;
      case "find": r["matches"] = Find(H(q), S(q, "name")); break;
      case "element": r["element"] = Describe(Node(I(q, "n", -1))); break;
      case "at": {
        var e = AutomationElement.FromPoint(new System.Windows.Point(I(q, "x", 0), I(q, "y", 0)));
        r["element"] = Describe(e);
        POINT p; p.X = I(q, "x", 0); p.Y = I(q, "y", 0);
        var root = GetAncestor(WindowFromPoint(p), 2);
        r["window"] = Info(root);
        break;
      }
      case "focused": {
        var e = AutomationElement.FocusedElement; r["element"] = Describe(e); break;
      }
      case "invoke": r["how"] = Invoke(Node(I(q, "n", -1))); break;
      case "setvalue": {
        var e = Node(I(q, "n", -1));
        if (e.Current.IsPassword) throw new Exception("password field");
        object vp; if (!e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) throw new Exception("This element does not take text; click it and use type instead.");
        var v = (ValuePattern)vp; if (v.Current.IsReadOnly) throw new Exception("This field is read-only.");
        v.SetValue(S(q, "text") ?? ""); r["how"] = "value";
        break;
      }
      case "click": {
        int x = I(q, "x", 0), y = I(q, "y", 0); string b = S(q, "button") ?? "left"; int n = I(q, "count", 1);
        SetCursorPos(x, y); Thread.Sleep(40);
        uint down = b == "right" ? 0x0008u : b == "middle" ? 0x0020u : 0x0002u, up = down << 1;
        for (int i = 0; i < n; i++) { Mouse(down, 0); Mouse(up, 0); Thread.Sleep(60); }
        r["cursor"] = new[] { x, y };
        break;
      }
      case "drag": {
        int x = I(q, "x", 0), y = I(q, "y", 0), x2 = I(q, "x2", 0), y2 = I(q, "y2", 0);
        SetCursorPos(x, y); Thread.Sleep(40); Mouse(0x0002, 0);
        for (int i = 1; i <= 10; i++) { SetCursorPos(x + (x2 - x) * i / 10, y + (y2 - y) * i / 10); Thread.Sleep(25); }
        Mouse(0x0004, 0); r["cursor"] = new[] { x2, y2 };
        break;
      }
      case "scroll": {
        SetCursorPos(I(q, "x", 0), I(q, "y", 0)); Thread.Sleep(30);
        Mouse(0x0800, (uint)(-I(q, "amount", 3) * 120)); r["cursor"] = new[] { I(q, "x", 0), I(q, "y", 0) };
        break;
      }
      case "type": TypeText(S(q, "text") ?? ""); break;
      case "keys": Keys(S(q, "keys") ?? ""); GetAsyncKeyState(0x1B); break;
      case "launch": {
        var psi = new ProcessStartInfo(S(q, "app")) { UseShellExecute = true };
        var a = S(q, "args"); if (!string.IsNullOrEmpty(a)) psi.Arguments = a;
        var p = Process.Start(psi); r["pid"] = p != null ? (object)p.Id : null;
        break;
      }
      default: throw new Exception("unknown op");
    }
    return r;
  }

  // ---------- windows ----------
  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  static string PName(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }
  /** Store apps run inside ApplicationFrameHost: the real program is the child window's process. */
  static uint RealPid(IntPtr h) {
    uint pid = Pid(h);
    if (!string.Equals(PName(pid), "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return pid;
    uint real = pid;
    EnumChildWindows(h, (c, l) => { uint p = Pid(c); if (p != pid) { real = p; return false; } return true; }, IntPtr.Zero);
    return real;
  }
  static Dictionary<string, object> Info(IntPtr h) {
    if (h == IntPtr.Zero || !IsWindow(h)) return null;
    RECT rc; GetWindowRect(h, out rc); uint pid = RealPid(h);
    return new Dictionary<string, object> {
      { "hwnd", h.ToInt64() }, { "title", Title(h) }, { "pid", pid }, { "process", PName(pid) },
      { "rect", new[] { rc.L, rc.T, rc.R, rc.B } }, { "minimized", IsIconic(h) }, { "foreground", GetForegroundWindow() == h },
    };
  }
  static List<object> Windows() {
    var list = new List<object>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true; // skip owned popups
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      var t = Title(h); if (t.Length == 0) return true;
      RECT rc; GetWindowRect(h, out rc); if (rc.R - rc.L < 50 || rc.B - rc.T < 30) return true;
      list.Add(Info(h)); return true;
    }, IntPtr.Zero);
    return list;
  }
  static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(200); }
    if (GetForegroundWindow() == h) return true;
    // Windows only lets a program bring a window forward right after input: a lone Alt tap allows it.
    Key(0x12, false); Key(0x12, true);
    SetForegroundWindow(h); Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }

  // ---------- screenshots of one window ----------
  static Bitmap Capture(IntPtr h, out double scale, int max) {
    RECT rc; GetWindowRect(h, out rc); int w = Math.Max(1, rc.R - rc.L), ht = Math.Max(1, rc.B - rc.T);
    var full = new Bitmap(w, ht, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(full)) {
      var dc = g.GetHdc(); bool ok = PrintWindow(h, dc, 2); g.ReleaseHdc(dc);
      if (!ok || Blank(full)) g.CopyFromScreen(rc.L, rc.T, 0, 0, new Size(w, ht));
    }
    scale = Math.Min(1.0, (double)max / Math.Max(w, ht));
    if (scale >= 1.0) return full;
    var small = new Bitmap((int)(w * scale), (int)(ht * scale));
    using (var g = Graphics.FromImage(small)) { g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic; g.DrawImage(full, 0, 0, small.Width, small.Height); }
    full.Dispose(); return small;
  }
  static bool Blank(Bitmap b) {
    var c0 = b.GetPixel(b.Width / 2, b.Height / 2);
    for (int i = 1; i < 9; i++) for (int j = 1; j < 9; j++) if (b.GetPixel(b.Width * i / 10, b.Height * j / 10) != c0) return false;
    return c0.R < 8 && c0.G < 8 && c0.B < 8;
  }
  static string Hash(Bitmap b) {
    long hsh = 17;
    for (int i = 0; i < 24; i++) for (int j = 0; j < 24; j++) hsh = hsh * 31 + b.GetPixel(b.Width * i / 24, b.Height * j / 24).ToArgb();
    return hsh.ToString("x");
  }

  // ---------- UI Automation ----------
  static AutomationElement Node(int n) {
    if (n < 0 || n >= nodes.Count) throw new Exception("Unknown element number: read the window again.");
    return nodes[n];
  }
  static Dictionary<string, object> Describe(AutomationElement e) {
    if (e == null) return null;
    var c = e.Current; var r = c.BoundingRectangle;
    string value = null;
    object vp; if (!c.IsPassword && e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { try { value = ((ValuePattern)vp).Current.Value; } catch { } }
    return new Dictionary<string, object> {
      { "name", c.Name }, { "type", c.ControlType.ProgrammaticName.Replace("ControlType.", "") }, { "password", c.IsPassword },
      { "enabled", c.IsEnabled }, { "value", value != null && value.Length > 300 ? value.Substring(0, 300) + "…" : value },
      { "pid", c.ProcessId },
      { "rect", r.IsEmpty ? null : new[] { (int)r.Left, (int)r.Top, (int)r.Right, (int)r.Bottom } },
    };
  }
  static string Tree(IntPtr h, int max) {
    nodes = new List<AutomationElement>(); nodesWindow = h;
    var root = AutomationElement.FromHandle(h); var sb = new StringBuilder();
    Walk(root, 0, max, sb);
    return sb.ToString();
  }
  static void Walk(AutomationElement e, int depth, int max, StringBuilder sb) {
    if (nodes.Count >= max || depth > 30) return;
    AutomationElement.AutomationElementInformation c;
    try { c = e.Current; } catch { return; }
    if (c.IsOffscreen && depth > 0 && c.ControlType != ControlType.ListItem && c.ControlType != ControlType.TreeItem) { }
    string type = c.ControlType.ProgrammaticName.Replace("ControlType.", "");
    bool useful = c.Name.Length > 0 || type == "Edit" || type == "Document" || type == "Button" || type == "CheckBox" || type == "ComboBox";
    if (useful && depth > 0) {
      int n = nodes.Count; nodes.Add(e);
      sb.Append(new string(' ', Math.Min(depth, 12) * 2)).Append('[').Append(n).Append("] ").Append(type);
      if (c.Name.Length > 0) sb.Append(" \"").Append(c.Name.Length > 120 ? c.Name.Substring(0, 120) + "…" : c.Name).Append('"');
      if (c.IsPassword) sb.Append(" (password field: DROPs never types here)");
      else {
        object vp; if (e.TryGetCurrentPattern(ValuePattern.Pattern, out vp)) { try { var v = ((ValuePattern)vp).Current.Value; if (!string.IsNullOrEmpty(v) && v != c.Name) sb.Append(" value=\"").Append(v.Length > 160 ? v.Substring(0, 160) + "…" : v).Append('"'); } catch { } }
        object tp; if (e.TryGetCurrentPattern(TogglePattern.Pattern, out tp)) { try { sb.Append(((TogglePattern)tp).Current.ToggleState == ToggleState.On ? " [on]" : " [off]"); } catch { } }
      }
      if (!c.IsEnabled) sb.Append(" (disabled)");
      if (c.HasKeyboardFocus) sb.Append(" (focused)");
      sb.Append('\n');
    }
    var w = TreeWalker.ControlViewWalker; AutomationElement ch = null;
    try { ch = w.GetFirstChild(e); } catch { }
    while (ch != null && nodes.Count < max) {
      Walk(ch, depth + 1, max, sb);
      try { ch = w.GetNextSibling(ch); } catch { ch = null; }
    }
  }
  static List<object> Find(IntPtr h, string name) {
    if (nodesWindow != h || nodes.Count == 0) Tree(h, 600);
    var exact = new List<object>(); var part = new List<object>();
    string want = (name ?? "").Trim().ToLowerInvariant();
    for (int i = 0; i < nodes.Count; i++) {
      string nm; try { nm = (nodes[i].Current.Name ?? "").Trim().ToLowerInvariant(); } catch { continue; }
      if (nm.Length == 0) continue;
      var d = Describe(nodes[i]); d["n"] = i;
      if (nm == want) exact.Add(d); else if (nm.Contains(want)) part.Add(d);
    }
    exact.AddRange(part); return exact;
  }
  static string Invoke(AutomationElement e) {
    if (!e.Current.IsEnabled) throw new Exception("That element is disabled.");
    object p;
    try {
      if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoke"; }
      if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggle"; }
      if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "select"; }
      if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { var x = (ExpandCollapsePattern)p; if (x.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) x.Expand(); else x.Collapse(); return "expand"; }
    } catch (InvalidOperationException) { /* fall back to mouse click in desktop.js */ }
    return "none";
  }

  // ---------- input ----------
  static void Mouse(uint flags, uint data) {
    var i = new INPUT[1]; i[0].type = 0; i[0].u.mi.dwFlags = flags; i[0].u.mi.mouseData = data;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  static void Key(ushort vk, bool up) {
    var i = new INPUT[1]; i[0].type = 1; i[0].u.ki.vk = vk; i[0].u.ki.flags = up ? 2u : 0u;
    SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
  static void TypeText(string text) {
    foreach (char ch in text.Replace("\r\n", "\n")) {
      if (ch == '\n') { Key(0x0D, false); Key(0x0D, true); Thread.Sleep(8); continue; }
      var i = new INPUT[2];
      i[0].type = 1; i[0].u.ki.scan = ch; i[0].u.ki.flags = 4;
      i[1].type = 1; i[1].u.ki.scan = ch; i[1].u.ki.flags = 4 | 2;
      SendInput(2, i, Marshal.SizeOf(typeof(INPUT))); Thread.Sleep(8);
    }
  }
  static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort> {
    { "ctrl", 0x11 }, { "control", 0x11 }, { "shift", 0x10 }, { "alt", 0x12 }, { "enter", 0x0D }, { "return", 0x0D }, { "tab", 0x09 },
    { "esc", 0x1B }, { "escape", 0x1B }, { "backspace", 0x08 }, { "delete", 0x2E }, { "del", 0x2E }, { "insert", 0x2D }, { "home", 0x24 }, { "end", 0x23 },
    { "pageup", 0x21 }, { "pagedown", 0x22 }, { "up", 0x26 }, { "down", 0x28 }, { "left", 0x25 }, { "right", 0x27 }, { "space", 0x20 },
  };
  static ushort VkOf(string k) {
    k = k.Trim().ToLowerInvariant();
    if (VK.ContainsKey(k)) return VK[k];
    if (k.Length == 1 && char.IsLetterOrDigit(k[0])) return (ushort)char.ToUpperInvariant(k[0]);
    if (k.Length >= 2 && k[0] == 'f') { int n; if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 12) return (ushort)(0x6F + n); }
    throw new Exception("Unknown key: " + k);
  }
  /** "ctrl+s", "enter", "alt+f4" ... ; several presses separated by spaces. */
  static void Keys(string spec) {
    foreach (var combo in spec.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
      var parts = combo.Split('+'); var vks = new List<ushort>();
      foreach (var p in parts) vks.Add(VkOf(p));
      foreach (var v in vks) Key(v, false);
      for (int i = vks.Count - 1; i >= 0; i--) Key(vks[i], true);
      Thread.Sleep(60);
    }
  }
}
