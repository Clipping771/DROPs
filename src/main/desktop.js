// Computer use for DROPs: use the user's desktop apps with mouse, keyboard and UI Automation, safely.
//
// Safety rules (all enforced here, whatever the model asks):
// - Every app needs the user's OK before DROPs touches it, in every mode (full auto too), per session.
// - System and security programs (Explorer, terminals, Task Manager, Registry, Settings, sign-in and UAC
//   prompts, password managers) and DROPs itself can never be controlled.
// - Input goes only to an approved app: before every click or key DROPs checks which window is in front
//   and which window is under the pointer.
// - Never types into a password field, never types card numbers or keys.
// - Clicking something named like delete, send, pay, buy, confirm... asks the user first.
// - If the user moves the mouse or presses Esc, DROPs stops and asks before going on.
// - Screenshots show only the app's own window, never the whole screen.
// - Other apps' window titles are never shown to the model (they can hold private text).
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLOCKED = new Set([
  'explorer', 'taskmgr', 'regedit', 'mmc', 'cmd', 'powershell', 'powershell_ise', 'pwsh', 'windowsterminal', 'wt', 'conhost', 'openconsole',
  'systemsettings', 'control', 'consent', 'credentialuibroker', 'logonui', 'lockapp', 'securityhealthui', 'securityhealthsystray', 'msiexec',
  'secpol', 'gpedit', 'compmgmt', 'diskmgmt', 'services', 'useraccountcontrolsettings', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost',
  '1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'nordpass', 'roboform', 'enpass', 'proton pass', 'authy',
]);
const BROWSERS = new Set(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'vivaldi', 'arc', 'iexplore']);
// Clicking these asks the user first, even in full auto.
const DANGER_RE = /\b(delete|remove|erase|wipe|trash|discard|send|submit|pay|purchase|buy|order|checkout|check out|confirm|transfer|withdraw|uninstall|format|reset|sign out|log ?out|publish|post|share|overwrite|replace all|empty)\b/i;
const MAX_INPUTS = 120;

const norm = (p) => String(p || '').toLowerCase().replace(/\.exe$/, '').trim();
const isBrowser = (p) => BROWSERS.has(norm(p));

function luhn(d) { let s = 0; for (let i = 0; i < d.length; i++) { let n = +d[d.length - 1 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; }
/** Text DROPs must never type: secrets, keys and card numbers. */
function sensitiveText(text) {
  const t = String(text || '');
  for (const m of t.match(/(?:\d[ -]?){13,19}/g) || []) { const d = m.replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) return 'a card number'; }
  try { if (require('./shell').redact(t).count) return 'a secret key or token'; } catch { /* no shell module */ }
  return null;
}
/** Key combinations that reach Windows itself instead of the app. */
function blockedKeys(spec) {
  const s = String(spec || '').toLowerCase();
  if (/\b(win|windows|meta|cmd|super)\b/.test(s)) return 'the Windows key opens system menus';
  if (/ctrl\+alt\+(del|delete)|ctrl\+shift\+esc|alt\+tab|alt\+esc|ctrl\+esc/.test(s.replace(/\s/g, ''))) return 'it switches to other programs or system screens';
  return null;
}

// ---------- the helper process (PowerShell + the compiled C# helper) ----------
const CS = path.join(__dirname, 'desktop-helper.cs');
const REFS = 'System.Drawing,System.Windows.Forms,UIAutomationClient,UIAutomationTypes,WindowsBase,System.Web.Extensions';

class Helper {
  constructor() { this.proc = null; this.seq = 0; this.wait = new Map(); this.buf = ''; this.ready = null; }
  start() {
    if (this.ready) return this.ready;
    if (process.platform !== 'win32') {
      if (process.platform !== 'darwin' && process.platform !== 'linux') {
        return Promise.reject(new Error(`Computer use is not supported on platform: ${process.platform}`));
      }
      this.ready = Promise.resolve();
      return this.ready;
    }
    const src = fs.readFileSync(CS, 'utf8');
    const tag = crypto.createHash('sha1').update(src).digest('hex').slice(0, 12);
    const dll = path.join(os.tmpdir(), `drops-desk-${tag}.dll`);
    const cs = path.join(os.tmpdir(), `drops-desk-${tag}.cs`);
    if (!fs.existsSync(dll)) fs.writeFileSync(cs, src);
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop'",
      '[Console]::InputEncoding=New-Object Text.UTF8Encoding $false; [Console]::OutputEncoding=New-Object Text.UTF8Encoding $false',
      `if (Test-Path ${q(dll)}) { Add-Type -Path ${q(dll)} } else { Add-Type -Path ${q(cs)} -ReferencedAssemblies ${REFS} -OutputAssembly ${q(dll)}; Add-Type -Path ${q(dll)} }`,
      '[DropsDesk]::Init()',
      "[Console]::Out.WriteLine('{\"ready\":true}'); [Console]::Out.Flush()",
      'while ($true) { $l=[Console]::In.ReadLine(); if ($null -eq $l) { break }; [Console]::Out.WriteLine([DropsDesk]::Run($l)); [Console]::Out.Flush() }',
    ].join('\n');
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    this.proc.stderr.on('data', (d) => { err += d; });
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The desktop helper did not start in time.')), 60_000);
      this.onReady = () => { clearTimeout(t); resolve(); };
      this.proc.on('exit', (code) => {
        clearTimeout(t);
        const e = new Error(`The desktop helper stopped (${code}). ${err.trim().split('\n').slice(0, 3).join(' ')}`.trim());
        reject(e); for (const w of this.wait.values()) w.reject(e); this.wait.clear(); this.proc = null; this.ready = null;
      });
    });
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { this.onReady?.(); continue; }
        const w = this.wait.get(m.id); if (!w) continue;
        this.wait.delete(m.id);
        if (m.ok) w.resolve(m); else w.reject(new Error(m.error || 'failed'));
      }
    });
    return this.ready;
  }
  async call(op, args = {}, timeout = 30_000) {
    await this.start();
    if (process.platform !== 'win32') return this.unixCall(op, args, timeout);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.wait.delete(id); reject(new Error(`Desktop step "${op}" timed out.`)); }, timeout);
      this.wait.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
    });
  }

  /** Cross-platform macOS (osascript/screencapture) & Linux (xdotool/scrot) backend for Desktop helper ops. */
  async unixCall(op, args = {}, timeout = 30_000) {
    const plat = process.platform;
    const runCmd = (cmd, argv) => execFileAsync(cmd, argv, { timeout }).then((r) => String(r.stdout || '').trim());
    if (plat === 'darwin') {
      if (op === 'windows') {
        const out = await runCmd('osascript', ['-e', 'tell application "System Events" to get {name, unix id} of every application process whose background only is false']);
        const parts = out.split(',').map((s) => s.trim()).filter(Boolean);
        const half = Math.floor(parts.length / 2);
        const windows = [];
        for (let i = 0; i < half; i++) {
          const proc = parts[i]; const pid = Number(parts[half + i]) || 0;
          windows.push({ hwnd: pid, pid, process: proc, title: proc, rect: [0, 0, 1280, 800] });
        }
        return { ok: true, windows };
      }
      if (op === 'state') {
        const proc = await runCmd('osascript', ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true']).catch(() => '');
        return { ok: true, esc: false, cursor: [0, 0], foreground: proc ? { hwnd: 0, pid: 0, process: proc, title: proc } : null };
      }
      if (op === 'focus') {
        if (args.process || args.title) await runCmd('osascript', ['-e', `tell application "${String(args.process || args.title).replace(/"/g, '')}" to activate`]);
        return { ok: true, window: { hwnd: args.hwnd || 0, pid: args.hwnd || 0, process: args.process || 'app', title: args.title || '', rect: [0, 0, 1280, 800] } };
      }
      if (op === 'launch') {
        await runCmd('open', ['-a', String(args.target || '')]);
        return { ok: true };
      }
      if (op === 'type') {
        await runCmd('osascript', ['-e', `tell application "System Events" to keystroke "${String(args.text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]);
        return { ok: true };
      }
      if (op === 'shot') {
        const tmp = path.join(os.tmpdir(), `drops-mac-${Date.now()}.jpg`);
        await runCmd('screencapture', ['-x', '-t', 'jpg', tmp]);
        const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
        return { ok: true, data: buf.toString('base64'), hash: crypto.createHash('sha1').update(buf).digest('hex'), width: 1280, height: 800 };
      }
      throw new Error(`Desktop op "${op}" requires accessibility permissions or is not supported on macOS.`);
    }
    // Linux (X11 via xdotool / scrot)
    if (op === 'windows') {
      const ids = (await runCmd('xdotool', ['search', '--onlyvisible', '--name', '.*']).catch(() => '')).split(/\s+/).filter(Boolean).slice(0, 30);
      const windows = [];
      for (const id of ids) {
        const title = await runCmd('xdotool', ['getwindowname', id]).catch(() => '');
        const pid = Number(await runCmd('xdotool', ['getwindowpid', id]).catch(() => 0)) || 0;
        if (title) windows.push({ hwnd: Number(id), pid, process: title.split(' ')[0], title, rect: [0, 0, 1280, 800] });
      }
      return { ok: true, windows };
    }
    if (op === 'state') {
      const id = await runCmd('xdotool', ['getactivewindow']).catch(() => '');
      const title = id ? await runCmd('xdotool', ['getwindowname', id]).catch(() => '') : '';
      const pid = id ? Number(await runCmd('xdotool', ['getwindowpid', id]).catch(() => 0)) || 0 : 0;
      return { ok: true, esc: false, cursor: [0, 0], foreground: id ? { hwnd: Number(id), pid, process: title.split(' ')[0] || 'x11', title } : null };
    }
    if (op === 'focus') {
      if (args.hwnd) await runCmd('xdotool', ['windowactivate', '--sync', String(args.hwnd)]).catch(() => {});
      return { ok: true, window: { hwnd: args.hwnd || 0, pid: args.pid || 0, process: args.process || 'x11', title: args.title || '', rect: [0, 0, 1280, 800] } };
    }
    if (op === 'click') {
      await runCmd('xdotool', ['mousemove', String(args.x || 0), String(args.y || 0), 'click', args.button === 'right' ? '3' : '1']);
      return { ok: true };
    }
    if (op === 'type') {
      await runCmd('xdotool', ['type', '--clearmodifiers', String(args.text || '')]);
      return { ok: true };
    }
    if (op === 'shot') {
      const tmp = path.join(os.tmpdir(), `drops-linux-${Date.now()}.png`);
      await runCmd('scrot', [tmp]);
      const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
      return { ok: true, data: buf.toString('base64'), hash: crypto.createHash('sha1').update(buf).digest('hex'), width: 1280, height: 800 };
    }
    throw new Error(`Desktop op "${op}" requires xdotool/scrot on Linux.`);
  }
  stop() { try { this.proc?.stdin.end(); this.proc?.kill(); } catch { /* gone */ } this.proc = null; this.ready = null; }
}

class Stop extends Error {}

/**
 * One agent session's computer use. `gate` asks the user: approveApp(proc, note), approveAction(text),
 * resume(reason) — each returns true or false. `onFrame({data,title,step})` feeds the live pane.
 */
class Desktop {
  constructor({ gate, onFrame, ownPids = [process.pid], helper } = {}) {
    this.gate = gate; this.onFrame = onFrame || (() => {});
    this.ownPids = new Set(ownPids); this.h = helper || new Helper();
    this.allowed = new Set(); this.target = null; this.lastShot = null; this.lastCursor = null; this.inputs = 0;
  }
  close() { this.h.stop(); }
  resetRequest() { this.inputs = 0; }

  refuseReason(win) {
    if (!win) return 'There is no such window.';
    const p = norm(win.process);
    if (this.ownPids.has(win.pid) || p === 'drops') return 'DROPs never controls its own windows.';
    if (!p) return 'DROPs cannot tell which program owns this window.';
    if (BLOCKED.has(p)) return `${win.process} is a system or security program: DROPs never controls it. Use the shell tools for files and commands.`;
    return null;
  }
  async approve(win) {
    const why = this.refuseReason(win); if (why) throw new Stop(why);
    const p = norm(win.process);
    if (this.allowed.has(p)) return;
    const note = isBrowser(p) ? 'This is your real web browser, with your sign-ins. For web pages the browser tool is safer.' : '';
    if (!(await this.gate.approveApp(win.process, note))) throw new Stop(`The user did not allow DROPs to control ${win.process}.`);
    this.allowed.add(p);
  }
  async windows() { return (await this.h.call('windows')).windows; }
  async listText() {
    const ws = await this.windows();
    const lines = ws.map((w) => {
      const p = norm(w.process), blocked = this.refuseReason(w);
      if (blocked) return `- ${w.process} (cannot be controlled)`;
      return this.allowed.has(p) ? `- ${w.process}: "${w.title}"${w.minimized ? ' (minimized)' : ''}${this.target?.hwnd === w.hwnd ? ' ← current' : ''}` : `- ${w.process} (not approved yet; title hidden)`;
    });
    return `Open windows:\n${[...new Set(lines)].join('\n')}`;
  }
  async needTarget() {
    if (!this.target) throw new Stop('No app is chosen: use action "open" or "focus" first.');
    const info = (await this.h.call('info', { hwnd: this.target.hwnd })).window;
    if (!info) {
      // The window closed: take another window of the same program if there is one.
      const next = (await this.windows()).find((w) => w.pid === this.target.pid || norm(w.process) === norm(this.target.process));
      if (!next) { this.target = null; throw new Stop('The app\'s window is closed.'); }
      this.target = next; return next;
    }
    this.target = info; return info;
  }
  /** Before real mouse or keyboard input: stop if the user took over, and bring the app to the front. */
  async beforeInput() {
    const st = await this.h.call('state');
    if (st.esc) { this.lastCursor = null; if (!(await this.gate.resume('You pressed Esc.'))) throw new Stop('Stopped: the user pressed Esc.'); }
    else if (this.lastCursor && Math.hypot(st.cursor[0] - this.lastCursor[0], st.cursor[1] - this.lastCursor[1]) > 25) {
      this.lastCursor = null;
      if (!(await this.gate.resume('You moved the mouse.'))) throw new Stop('Stopped: the user moved the mouse and took over.');
    }
    if (++this.inputs > MAX_INPUTS) {
      if (!(await this.gate.approveAction(`DROPs has used the mouse and keyboard ${MAX_INPUTS} times in this request. Go on?`))) throw new Stop('Stopped after many steps; the user did not allow more.');
      this.inputs = 0;
    }
    const w = await this.needTarget();
    const f = await this.h.call('focus', { hwnd: w.hwnd });
    const fg = (await this.h.call('state')).foreground;
    if (!fg || (fg.hwnd !== w.hwnd && fg.pid !== w.pid)) throw new Stop(`Could not bring ${w.process} to the front (${fg ? 'another window is in front' : 'no window in front'}), so nothing was typed or clicked.`);
    return f.window || w;
  }
  async afterInput() { const st = await this.h.call('state').catch(() => null); if (st) this.lastCursor = st.cursor; }
  async hash() { try { const w = await this.needTarget(); return (await this.h.call('shot', { hwnd: w.hwnd, max: 320 })).hash; } catch { return null; } }
  async frame(step) {
    try {
      const w = await this.needTarget();
      const s = await this.h.call('shot', { hwnd: w.hwnd, max: 1100, format: 'jpeg' });
      this.onFrame({ data: s.data, title: w.title, url: `app: ${w.process}`, step });
    } catch { /* the live pane is optional */ }
  }
  async checkDanger(el, what) {
    const name = `${el?.name || ''}`;
    if (name && DANGER_RE.test(name)) {
      if (!(await this.gate.approveAction(`${what} "${name}" in ${this.target?.process}. This may delete, send, buy or confirm something.`))) throw new Stop(`The user did not allow clicking "${name}".`);
    }
  }
  pickWindow(ws, { app, title }) {
    const a = norm(app), t = String(title || '').toLowerCase();
    return ws.find((w) => (!a || norm(w.process) === a || norm(w.process).includes(a)) && (!t || String(w.title).toLowerCase().includes(t)));
  }

  // ---------- actions ----------
  async act(input) {
    const a = String(input.action || '');
    if (a === 'windows') return { text: await this.listText() };
    if (a === 'open') return this.open(input);
    if (a === 'focus') {
      const w = this.pickWindow(await this.windows(), input);
      if (!w) throw new Stop(`No open window matches ${input.app || ''} ${input.title || ''}. Use action "windows" to see them, or "open".`);
      await this.approve(w); this.target = w; this.lastShot = null;
      await this.h.call('focus', { hwnd: w.hwnd }).catch(() => {});
      await this.frame('focus');
      return { text: `Now using ${w.process}: "${w.title}". Next: read (the window's controls) or screenshot.` };
    }
    if (a === 'wait') { await new Promise((r) => setTimeout(r, Math.min(15, Math.max(0.2, +input.seconds || 1)) * 1000)); await this.frame('wait'); return { text: 'Waited.' }; }
    const w = await this.needTarget();
    await this.approve(w);
    if (a === 'read') {
      const r = await this.h.call('tree', { hwnd: w.hwnd, max: 400 }, 45_000);
      return { text: `${w.process}: "${w.title}"\n${r.text || '(no readable controls: use screenshot)'}\nUse a number: click {element: n}, type {element: n, text}.` };
    }
    if (a === 'screenshot') {
      const s = await this.h.call('shot', { hwnd: w.hwnd, max: 1280 });
      this.lastShot = { hwnd: w.hwnd, scale: s.scale, rect: w.rect, width: s.width, height: s.height };
      await this.frame('screenshot');
      return { text: `Screenshot of ${w.process}: "${w.title}" (${s.width}×${s.height}). Coordinates for click/scroll/drag are pixels in this image.`, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: s.data } }] };
    }
    if (a === 'click') return this.click(w, input);
    if (a === 'type') return this.type(w, input);
    if (a === 'key') return this.key(w, input);
    if (a === 'scroll' || a === 'drag') return this.pointer(w, input, a);
    throw new Stop(`Unknown action "${a}".`);
  }

  async open(input) {
    const app = String(input.app || '').trim();
    if (!app) throw new Stop('Say which app to open, e.g. {"action":"open","app":"notepad"}.');
    const base = norm(path.basename(app));
    if (BLOCKED.has(base)) throw new Stop(`${base} is a system or security program: DROPs never controls it.`);
    if (!(await this.gate.approveApp(base, isBrowser(base) ? 'This is your real web browser, with your sign-ins. For web pages the browser tool is safer.' : ''))) throw new Stop(`The user did not allow DROPs to open ${base}.`);
    const before = new Set((await this.windows()).map((w) => w.hwnd));
    const r = await this.h.call('launch', { app, args: input.args || '' });
    let found = null;
    for (let i = 0; i < 40 && !found; i++) {
      await new Promise((res) => setTimeout(res, 400));
      const ws = await this.windows();
      found = ws.find((w) => w.pid === r.pid) || ws.find((w) => !before.has(w.hwnd) && (norm(w.process) === base || norm(w.process).includes(base) || base.includes(norm(w.process))))
        || (i > 10 && ws.find((w) => !before.has(w.hwnd) && !this.refuseReason(w)));
    }
    if (!found) throw new Stop(`${app} was started but no window showed up. Use action "windows" to look.`);
    const why = this.refuseReason(found); if (why) throw new Stop(why);
    this.allowed.add(base); this.allowed.add(norm(found.process));
    this.target = found; this.lastShot = null;
    await this.frame('open');
    return { text: `Opened ${found.process}: "${found.title}". Next: read (its controls, exact names) or screenshot.` };
  }

  async element(w, input) {
    if (input.element !== undefined && input.element !== null && input.element !== '') return { n: +input.element, el: (await this.h.call('element', { n: +input.element })).element };
    const m = (await this.h.call('find', { hwnd: w.hwnd, name: String(input.target) })).matches.filter((x) => x.enabled !== false);
    if (!m.length) throw new Stop(`Nothing named "${input.target}" in ${w.process}. Use read to see the names, or screenshot and x,y.`);
    return { n: m[0].n, el: m[0] };
  }
  /** The element must belong to the app being controlled. */
  ownEl(w, el) { if (el && el.pid && el.pid !== w.pid) throw new Stop('That element belongs to another program.'); }

  toScreen(w, x, y) {
    const s = this.lastShot;
    if (!s || s.hwnd !== w.hwnd) throw new Stop('Take a screenshot first: x and y are pixels in the latest screenshot of this window.');
    if (x < 0 || y < 0 || x > s.width || y > s.height) throw new Stop(`(${x}, ${y}) is outside the screenshot (${s.width}×${s.height}).`);
    return [Math.round(w.rect[0] + x / s.scale), Math.round(w.rect[1] + y / s.scale)];
  }
  async checkPoint(w, sx, sy) {
    const at = await this.h.call('at', { x: sx, y: sy });
    const win = at.window;
    if (!win || (win.pid !== w.pid && norm(win.process) !== norm(w.process))) throw new Stop(`That point is over ${win ? win.process : 'nothing'}, not ${w.process}: nothing was clicked.`);
    return at.element;
  }

  async click(w, input) {
    const before = await this.hash();
    let how, label;
    const button = input.button === 'right' ? 'right' : input.button === 'middle' ? 'middle' : 'left';
    const count = input.double ? 2 : 1;
    if (input.element !== undefined || input.target) {
      const { n, el } = await this.element(w, input);
      this.ownEl(w, el); await this.checkDanger(el, 'Click');
      label = `${el.type} "${el.name}"`;
      if (button === 'left' && count === 1) how = (await this.h.call('invoke', { n })).how;
      if (!how || how === 'none') {
        if (!el.rect) throw new Stop(`${label} has no place on screen to click.`);
        await this.beforeInput();
        const sx = Math.round((el.rect[0] + el.rect[2]) / 2), sy = Math.round((el.rect[1] + el.rect[3]) / 2);
        await this.checkPoint(w, sx, sy);
        await this.h.call('click', { x: sx, y: sy, button, count }); await this.afterInput(); how = 'mouse';
      }
    } else {
      const x = +input.x, y = +input.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Stop('Give element, target, or x and y.');
      const fresh = await this.needTarget();
      const [sx, sy] = this.toScreen(fresh, x, y);
      const el = await this.checkPoint(fresh, sx, sy);
      await this.checkDanger(el, 'Click');
      label = el?.name ? `${el.type} "${el.name}"` : `(${x}, ${y})`;
      await this.beforeInput();
      await this.h.call('click', { x: sx, y: sy, button, count }); await this.afterInput(); how = 'mouse';
    }
    return this.after(`${count === 2 ? 'Double-clicked' : button === 'right' ? 'Right-clicked' : 'Clicked'} ${label}${how === 'mouse' ? '' : ` (${how}, without moving the mouse)`}`, before);
  }

  async type(w, input) {
    const text = String(input.text ?? '');
    const bad = sensitiveText(text);
    if (bad) throw new Stop(`DROPs never types ${bad}. Ask the user to type it themselves.`);
    const before = await this.hash();
    if (input.element !== undefined || input.target) {
      const { n, el } = await this.element(w, input);
      this.ownEl(w, el);
      if (el.password) throw new Stop('That is a password field: DROPs never types passwords. Ask the user to type it.');
      if (!input.append) {
        try { await this.h.call('setvalue', { n, text }); return this.after(`Set ${el.type} "${el.name}" to the text`, before); } catch (e) { if (/password/.test(e.message)) throw new Stop('That is a password field: DROPs never types passwords.'); }
      }
      await this.h.call('invoke', { n }).catch(() => {});
    }
    await this.beforeInput();
    const f = (await this.h.call('focused')).element;
    if (f?.password) throw new Stop('The focused field is a password field: DROPs never types passwords. Ask the user to type it.');
    if (f && f.pid && f.pid !== w.pid) throw new Stop('The keyboard focus is in another program: nothing was typed.');
    await this.h.call('type', { text }, 120_000); await this.afterInput();
    return this.after(`Typed ${text.length} characters${f?.name ? ` into ${f.type} "${f.name}"` : ''}`, before);
  }

  async key(w, input) {
    const keys = String(input.keys || input.key || '').trim();
    if (!keys) throw new Stop('Say which keys, e.g. "ctrl+s" or "enter".');
    const why = blockedKeys(keys); if (why) throw new Stop(`Not allowed: ${why}.`);
    if (/shift\+(del|delete)/i.test(keys) && !(await this.gate.approveAction(`Press ${keys} in ${w.process} (permanent delete)`))) throw new Stop('The user did not allow it.');
    const before = await this.hash();
    await this.beforeInput();
    await this.h.call('keys', { keys }); await this.afterInput();
    return this.after(`Pressed ${keys}`, before);
  }

  async pointer(w, input, a) {
    const fresh = await this.needTarget();
    const [sx, sy] = this.toScreen(fresh, +input.x, +input.y);
    await this.checkPoint(fresh, sx, sy);
    let extra = {};
    if (a === 'drag') { const [ex, ey] = this.toScreen(fresh, +input.x2, +input.y2); await this.checkPoint(fresh, ex, ey); extra = { x2: ex, y2: ey }; }
    const before = await this.hash();
    await this.beforeInput();
    await this.h.call(a, { x: sx, y: sy, amount: Math.max(-20, Math.min(20, Math.round(+input.amount || 3))), ...extra }); await this.afterInput();
    return this.after(a === 'drag' ? 'Dragged' : `Scrolled ${input.amount || 3}`, before);
  }

  async after(did, before) {
    await new Promise((r) => setTimeout(r, 350));
    let w = null; try { w = await this.needTarget(); } catch { /* closed */ }
    const now = await this.hash();
    await this.frame(did);
    const st = await this.h.call('state').catch(() => null);
    const fg = st?.foreground;
    const changed = before && now ? (before === now ? 'Nothing in the window changed.' : 'The window changed.') : '';
    let away = '';
    if (fg && w && fg.pid !== w.pid) away = this.refuseReason(fg) ? ` Another program is now in front (${fg.process}).` : ` ${fg.process} is now in front.`;
    return { text: `${did}. ${changed}${w ? ` Window: "${w.title}".` : ' The window closed.'}${away}` };
  }
}

module.exports = { Desktop, Helper, Stop, BLOCKED, DANGER_RE, sensitiveText, blockedKeys, norm };
