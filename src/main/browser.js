// A real browser for the agent: open pages, click, type, read what a user sees, catch console errors,
// take screenshots. Uses playwright-core with a browser already on the machine (Playwright's Chromium if
// installed, else Edge or Chrome); nothing is downloaded. Headless. One page per project, reused across
// calls so a login or a filled form carries over between steps, closed after 10 idle minutes.
const fs = require('fs');
let pw = null;
try { pw = require('playwright-core'); } catch { /* optional dependency */ }

const IDLE_MS = 10 * 60_000;
const ACTION_TIMEOUT = 10_000;
const isErrorUrl = (url) => /^chrome-error:|^about:blank$/i.test(String(url || '').trim());

// ---- which addresses the browser may reach ----
// This machine (localhost, 127.x, ::1, *.localhost) for the app being built, and the public internet.
// Not other machines on the home or office network, and not cloud-metadata addresses (169.254.169.254):
// fetch_url blocks those too. Checked for every request, so a link, redirect or script cannot get there.
const net = require('net');
const dns = require('dns').promises;
const hostVerdict = new Map(); // hostname -> { at, ok }
function isLoopbackHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  return net.isIP(h) === 4 && h.startsWith('127.');
}
async function hostAllowed(host) {
  if (isLoopbackHost(host)) return true;
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  const hit = hostVerdict.get(h);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  const { isPrivateAddress } = require('./tools');
  let ok;
  try {
    const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true, verbatim: true });
    ok = addrs.length > 0 && !addrs.some((a) => isPrivateAddress(a.address));
  } catch { ok = true; } // a name that does not resolve fails on its own
  hostVerdict.set(h, { at: Date.now(), ok });
  if (hostVerdict.size > 500) hostVerdict.clear();
  return ok;
}
async function guardRequest(route) {
  let u;
  try { u = new URL(route.request().url()); } catch { return route.continue(); }
  if (!/^(https?|wss?):$/.test(u.protocol)) return route.continue(); // data:, blob: and the like
  if (await hostAllowed(u.hostname)) return route.continue();
  return route.abort('addressunreachable');
}
const sessions = new Map();
let streamHandler = null;
let colorScheme = 'dark';
function setStreamHandler(fn) { streamHandler = typeof fn === 'function' ? fn : null; }
function setColorScheme(mode) {
  colorScheme = mode === 'light' ? 'light' : 'dark';
  for (const s of sessions.values()) {
    if (s.page && !s.page.isClosed()) s.page.emulateMedia({ colorScheme }).catch(() => {});
  }
}

const available = () => !!pw;

async function launch() {
  const tries = [{}, { channel: 'msedge' }, { channel: 'chrome' }];
  let last;
  for (const t of tries) {
    try { return await pw.chromium.launch({ headless: true, ...t }); } catch (e) { last = e; }
  }
  throw new Error(`No browser could be started (${String(last?.message || last).split('\n')[0]}). Install Chrome or Edge, or run \`npx playwright install chromium\`.`);
}

class BrowserSession {
  constructor(key) { this.key = key; this.browser = null; this.page = null; this.cdp = null; this.streaming = false; this.lastEmitAt = 0; this._lastTitle = ''; this._frameListener = null; this.events = []; this.api = []; this.inflight = new Set(); this.timer = null; this.lastStatus = null; this._lock = Promise.resolve(); }

  /** Serializes AI `act()` and user `interact()` on the same Playwright page so they never race. */
  withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  async ensure(viewport) {
    this.touch();
    if (this.page && !this.page.isClosed()) {
      if (viewport) await this.page.setViewportSize(viewport);
      return this.page;
    }
    if (this.app) {
      // An Electron app: its first window is the page (a closed window means the app has quit).
      const w = this.app.windows().find((p) => !p.isClosed());
      if (!w) throw new Error('The app has no open window (it may have quit). Launch it again.');
      this.page = w;
      if (viewport) await this.page.setViewportSize(viewport).catch(() => {});
      return this.page;
    }
    if (!this.browser || !this.browser.isConnected()) this.browser = await launch();
    const context = await this.browser.newContext({ viewport: viewport || { width: 1280, height: 840 }, colorScheme });
    await context.route('**/*', guardRequest);
    this.page = await context.newPage();
    this.attach(this.page);
    return this.page;
  }

  /**
   * Starts an Electron app from its folder, with its own throwaway data folder (APPDATA, where Electron
   * keeps an app's settings) so it never reads or changes the user's real ones. The home folder and
   * LOCALAPPDATA stay real: Electron does not start with a replaced home folder.
   */
  async launchApp(dir, { timeout = 60_000 } = {}) {
    if (!pw?._electron) throw new Error('Desktop app testing is not available (playwright-core with Electron support is missing).');
    const path = require('path'), os = require('os');
    let exe;
    try { exe = require(require.resolve('electron', { paths: [dir] })); } catch { throw new Error(`No Electron in ${dir}: run npm install there first (the app needs the "electron" package).`); }
    if (typeof exe !== 'string' || !fs.existsSync(exe)) throw new Error('The electron package is installed but its program is missing: run npm install again.');
    await this.close();
    sessions.set(this.key, this);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-app-'));
    fs.mkdirSync(path.join(tmp, 'appdata'));
    const env = { ...process.env, APPDATA: path.join(tmp, 'appdata') };
    for (const k of Object.keys(env)) if (/_API_KEY$|^(DROPS|H2O)_/.test(k)) delete env[k]; // the app under test gets no keys
    this.appTmp = tmp;
    this.app = await pw._electron.launch({ executablePath: exe, args: [dir], cwd: dir, env, timeout });
    this.app.process()?.stdout?.on('data', (d) => { const t = String(d).trim(); if (/error|exception/i.test(t)) this.events.push(`app output: ${t.slice(0, 300)}`); });
    this.page = await this.app.firstWindow({ timeout });
    this.attach(this.page);
    await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    this.touch();
    return this.page;
  }

  /** Listens to a page's console, errors, requests and dialogs (browser pages and app windows alike). */
  attach(page) {
    this.page = page;
    this.page.setDefaultTimeout(ACTION_TIMEOUT);
    this.page.on('console', (m) => { if (m.type() === 'error') this.events.push(`console error: ${m.text().slice(0, 300)}`); });
    this.page.on('pageerror', (e) => this.events.push(`page error: ${String(e.message || e).slice(0, 300)}`));
    this.page.on('request', (q) => { if (['document', 'fetch', 'xhr'].includes(q.resourceType())) this.inflight.add(q); });
    this.page.on('requestfinished', (q) => this.inflight.delete(q));
    this.page.on('response', (r) => {
      const t = r.request().resourceType();
      // The app's own API calls (what a click really did on the server), not page loads or prefetches.
      if (['fetch', 'xhr'].includes(t) && !/[?&]_rsc=/.test(r.url())) {
        try { const u = new URL(r.url()); this.api.push(`${r.request().method()} ${u.pathname}${u.search.length > 1 && u.search.length < 60 ? u.search : ''} → ${r.status()}`); } catch { /* ignore */ }
        if (this.api.length > 30) this.api.shift();
      }
      if (r.status() >= 400 && ['document', 'fetch', 'xhr'].includes(t)) this.events.push(`HTTP ${r.status()} ${r.request().method()} ${r.url().slice(0, 200)}`);
      // The page's own code or styles missing: buttons and forms will not work. Usual cause: the app
      // was rebuilt while the old server kept running.
      else if (r.status() >= 400 && ['script', 'stylesheet'].includes(t)) this.events.push(`HTTP ${r.status()} for the page's ${t === 'script' ? 'JavaScript' : 'CSS'} ${r.url().slice(0, 160)}: the page's code did not load, so its buttons and forms will not work. If you rebuilt the app, stop the running server and start it again.`);
    });
    this.page.on('requestfailed', (q) => {
      this.inflight.delete(q);
      // A request the browser itself cancelled (a navigation replacing a prefetch, as Next.js does
      // with its ?_rsc= requests) is normal, not a broken app.
      if (/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(q.failure()?.errorText || '')) return;
      if (['document', 'fetch', 'xhr', 'script'].includes(q.resourceType())) this.events.push(`request failed: ${q.method()} ${q.url().slice(0, 160)} (${q.failure()?.errorText || 'error'})`);
    });
    this.page.on('dialog', (d) => { this.events.push(`dialog (${d.type()}): ${d.message().slice(0, 200)} → accepted`); d.accept().catch(() => {}); });
    this.page.on('load', () => { this.page?.title().then((t) => { this._lastTitle = t || ''; }).catch(() => {}); });
    return this.page;
  }

  async startStream(opts = {}) {
    if (!this.page || this.page.isClosed() || this.app) return false;
    if (opts.width && opts.height) {
      const w = Math.max(480, Math.min(1600, Math.round(Number(opts.width))));
      const h = Math.max(420, Math.min(1200, Math.round(Number(opts.height))));
      const cur = this.page.viewportSize();
      if (!cur || Math.abs(cur.width - w) > 36 || Math.abs(cur.height - h) > 36) {
        await this.page.setViewportSize({ width: w, height: h }).catch(() => {});
      }
    }
    if (this.streaming) return true;
    try {
      this.cdp = this.cdp || (await this.page.context().newCDPSession(this.page));
      if (!this._frameListener) {
        this._frameListener = ({ data, metadata, sessionId }) => {
          this.cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          const now = Date.now();
          if (now - this.lastEmitAt < 50) return;
          this.lastEmitAt = now;
          if (!streamHandler || !this.page || this.page.isClosed()) return;
          const curUrl = this.page.url();
          if (isErrorUrl(curUrl)) return;
          streamHandler({
            type: 'frame',
            key: this.key,
            data,
            url: curUrl,
            title: this._lastTitle || '',
            width: metadata?.deviceWidth || 1280,
            height: metadata?.deviceHeight || 840,
          });
        };
        this.cdp.on('Page.screencastFrame', this._frameListener);
      }
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 });
      this.streaming = true;
      return true;
    } catch {
      this.streaming = false;
      return false;
    }
  }

  async stopStream() {
    this.streaming = false;
    if (this.cdp) {
      try { await this.cdp.send('Page.stopScreencast'); } catch { /* ignore */ }
    }
  }

  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), IDLE_MS);
    this.timer.unref?.();
  }

  async close() {
    clearTimeout(this.timer);
    await this.stopStream();
    if (this.cdp) {
      try {
        if (this._frameListener) this.cdp.off('Page.screencastFrame', this._frameListener);
        await this.cdp.detach();
      } catch { /* ignore */ }
      this.cdp = null;
      this._frameListener = null;
    }
    const b = this.browser, app = this.app, tmp = this.appTmp;
    this.browser = null; this.page = null; this.app = null; this.appTmp = null;
    sessions.delete(this.key);
    await b?.close().catch(() => {});
    if (app) {
      // Never leave a window behind: close it, and end the process if it does not quit.
      const proc = app.process();
      await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
      try { if (proc && proc.exitCode === null) { if (process.platform === 'win32') require('child_process').execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' }); else proc.kill('SIGKILL'); } } catch { /* already gone */ }
      if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* files still locked: left in temp */ } }
    }
  }

  takeEvents() { const e = this.events; this.events = []; return e; }
  takeApi() { const a = this.api; this.api = []; return a; }
}

function sessionFor(key) {
  let s = sessions.get(key);
  if (!s) { s = new BrowserSession(key); sessions.set(key, s); }
  return s;
}

/** Turns what the model wrote into a locator: data-testid, CSS, Playwright selectors, or plain visible text. */
async function locate(page, target, purpose) {
  const t = String(target || '').trim();
  if (!t) throw new Error('Say which element: its visible text, label, data-testid ("testid=save") or a CSS selector.');
  if (/^testid=/i.test(t)) return page.locator(`[data-testid="${t.slice(7).trim()}"]`).first();
  // Selector syntax only when the text has selector characters; plain words ("Log in") are visible text.
  const plainWords = /^[\p{L}\p{N}\s'’&,!?()-]+$/u.test(t);
  if (/^(css=|text=|role=|xpath=|id=|#|\.|\[|\/\/)/.test(t) || (!plainWords && /[[\]#.>:=]/.test(t))) return page.locator(t).first();
  // Plain words: the element a user would recognise by that text, in order of what they most likely
  // mean (a button before a link before any text; a labelled field before a placeholder). Exact
  // matches win over partial ones.
  const candidates = purpose === 'fill'
    ? [page.getByLabel(t, { exact: true }), page.getByPlaceholder(t, { exact: true }), page.getByLabel(t), page.getByPlaceholder(t)]
    : [page.getByRole('button', { name: t, exact: true }), page.getByRole('link', { name: t, exact: true }), page.getByRole('button', { name: t }), page.getByRole('link', { name: t }),
      page.getByRole('checkbox', { name: t }), page.getByRole('tab', { name: t }), page.getByText(t, { exact: true }), page.getByText(t)];
  for (const c of candidates) if (await c.count().catch(() => 0)) return c.first();
  return candidates[candidates.length - 1].first(); // waits, then reports a clear "not found"
}

/** What the page looks like now, in text a model can act on. */
async function snapshot(page, s, { full = false } = {}) {
  const info = await page.evaluate((maxText) => {
    const visible = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
    const label = (el) => {
      const id = el.getAttribute('id');
      const l = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label');
      return (el.getAttribute('aria-label') || (l && l.textContent) || el.getAttribute('placeholder') || el.getAttribute('name') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    };
    const items = [];
    for (const el of document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [data-testid]')) {
      if (!visible(el) || items.length >= 70) continue;
      const tag = el.tagName.toLowerCase();
      const tid = el.getAttribute('data-testid');
      const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      let d = tag === 'input' ? `input[${el.type}]` : tag;
      if (tid) d += ` testid=${tid}`;
      if (['input', 'select', 'textarea'].includes(tag)) d += ` label="${label(el)}"${el.value ? ` value="${String(el.value).slice(0, 40)}"` : ''}`;
      else if (text) d += ` "${text}"`;
      if (tag === 'a') d += ` → ${el.getAttribute('href')}`;
      if (el.disabled) d += ' (disabled)';
      if (tag === 'select') d += ` options=[${[...el.options].slice(0, 8).map((o) => o.textContent.trim()).join(' | ')}]`;
      items.push(d);
    }
    const alerts = [...document.querySelectorAll('[role="alert"], .error, [data-testid*="error"]')].filter(visible).map((e) => e.innerText.trim()).filter(Boolean).slice(0, 5);
    // A test id rendered in two different places (e.g. a desktop and a mobile menu, one hidden) breaks
    // automated tests that expect one element. Repeats inside one list (rows) are normal.
    const byId = new Map();
    for (const el of document.querySelectorAll('[data-testid]')) { const k = el.getAttribute('data-testid'); if (!byId.has(k)) byId.set(k, []); byId.get(k).push(el); }
    // Items of one list share the same structure above them; the same id in two different places does not.
    const shape = (el) => { const parts = []; for (let n = el.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) parts.push(n.tagName + '.' + [...n.classList].sort().join('.')); return parts.join('>'); };
    const dupes = [...byId.entries()].filter(([, els]) => els.length > 1 && new Set(els.map(shape)).size > 1).map(([k, els]) => `${k} ×${els.length}`).slice(0, 8);
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    return { title: document.title, text: text.length > maxText ? text.slice(0, maxText) + `\n[… ${text.length - maxText} more characters; use action "read" with full=true]` : text, items, alerts, dupes, wide: document.documentElement.scrollWidth > window.innerWidth + 1 };
  }, full ? 20000 : 3000);
  const events = s.takeEvents();
  s.lastEvents = events;
  const api = s.takeApi();
  return [
    `URL: ${page.url()}${s.lastStatus ? ` (HTTP ${s.lastStatus})` : ''}`,
    `Title: ${info.title || '(none)'}`,
    info.alerts.length ? `Messages shown: ${info.alerts.join(' | ')}` : '',
    info.wide ? 'Layout: the page scrolls sideways at this width.' : '',
    info.dupes?.length ? `Duplicate test ids (the same id in different places, e.g. a desktop and a mobile menu): ${info.dupes.join(', ')}. Automated tests that look for one of these will fail: render each once, or give the copies different ids.` : '',
    events.length ? `Problems since the last step:\n- ${events.slice(0, 12).join('\n- ')}` : 'Problems since the last step: none',
    api.length ? `API calls since the last step: ${api.slice(-10).join('; ')}` : '',
    `Interactive elements (${info.items.length}):\n${info.items.map((i) => '- ' + i).join('\n') || '(none)'}`,
    `Visible text:\n${info.text || '(empty page)'}`,
  ].filter(Boolean).join('\n');
}

/**
 * Runs one browser action. `mapUrl` rewrites addresses (e.g. localhost:3000 inside the Docker sandbox
 * to the port published on this machine). Returns text, plus an image for screenshots.
 */
async function act(key, input, { mapUrl = (u) => u, signal } = {}) {
  if (!pw) throw new Error('The browser is not available (playwright-core is not installed).');
  const s = sessionFor(key);
  return s.withLock(() => actInner(s, input, { mapUrl, signal }));
}
async function actInner(s, input, { mapUrl = (u) => u, signal } = {}) {
  const action = input.action;
  if (action === 'close') { const wasApp = !!s.app; await s.close(); return { text: wasApp ? 'App closed.' : 'Browser closed.' }; }
  if (action === 'launch') { await s.launchApp(input.path); }
  const viewport = input.width ? { width: Math.max(320, Math.min(input.width, 2560)), height: Math.max(480, Math.min(input.height || 900, 2000)) } : null;
  const page = await s.ensure(viewport);
  const settle = async () => { await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); };
  // Playwright's networkidle latch resolves in 0 ms once the initial page load has settled, so a
  // click/Enter that triggers an async fetch() + router.push() needs to wait for any requests it
  // started (plus the post-fetch navigation/DOM update) before we snapshot or judge s.unchanged.
  const afterInteract = async (before) => {
    await page.waitForTimeout(50).catch(() => {});
    const deadline = Date.now() + 4000;
    const idleLimit = Date.now() + 900;
    while (Date.now() < deadline) {
      if (s.inflight.size > 0) {
        await page.waitForTimeout(80).catch(() => {});
        if (s.inflight.size === 0) await page.waitForTimeout(80).catch(() => {});
        continue;
      }
      if ((await fingerprint(page)) !== before) break;
      if (Date.now() >= idleLimit) break;
      await page.waitForTimeout(80).catch(() => {});
    }
    await settle();
    return (await fingerprint(page)) === before;
  };
  if (signal?.aborted) throw new Error('Stopped.');
  if (streamHandler && !s.app && !s.streaming) await s.startStream().catch(() => {});

  const emitCursor = (active, label = '', xRatio = 0.5, yRatio = 0.5) => {
    if (!streamHandler || s.app) return;
    streamHandler({ type: 'cursor', key: s.key, active, label: String(label || '').slice(0, 72), xRatio, yRatio });
  };
  const aimLocator = async (el, label) => {
    try {
      const box = await el.boundingBox();
      const vp = page.viewportSize() || { width: 1280, height: 840 };
      if (box && vp.width && vp.height) {
        const xr = Math.max(0.03, Math.min(0.97, (box.x + box.width / 2) / vp.width));
        const yr = Math.max(0.03, Math.min(0.97, (box.y + box.height / 2) / vp.height));
        emitCursor(true, label, xr, yr);
        return;
      }
    } catch { /* ignore */ }
    emitCursor(true, label, 0.5, 0.45);
  };

  try {
    switch (action) {
      case 'open': {
        if (!input.url) throw new Error('open needs a url.');
        const url = mapUrl(String(input.url));
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) addresses can be opened.');
        if (!(await hostAllowed(new URL(url).hostname))) throw new Error(`${new URL(url).hostname} is on a private network. The browser opens this computer (localhost) and the public internet only.`);
        emitCursor(true, 'Opening ' + String(input.url).replace(/^https?:\/\//i, '').slice(0, 38), 0.52, 0.44);
        const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => { throw new Error(`Could not open ${input.url}: ${String(e.message).split('\n')[0]}. Is the app running (start_process) and listening on that port?`); });
        s.lastStatus = r?.status() ?? null;
        s._lastTitle = await page.title().catch(() => '');
        await settle();
        break;
      }
      case 'click': { const before = await fingerprint(page); s.inflight.clear(); const el = await locate(page, input.target, 'click'); await aimLocator(el, 'Click ' + input.target); await el.click(); s.lastStatus = null; s.unchanged = await afterInteract(before); break; }
      case 'fill': { const el = await locate(page, input.target, 'fill'); await aimLocator(el, 'Type into ' + input.target); await el.fill(String(input.value ?? '')); break; }
      case 'select': { const el = await locate(page, input.target, 'fill'); await aimLocator(el, 'Select ' + input.target); await el.selectOption({ label: String(input.value ?? '') }).catch(() => el.selectOption(String(input.value ?? ''))); await settle(); break; }
      case 'check': { const el = await locate(page, input.target, 'fill'); await aimLocator(el, 'Check ' + input.target); await el.check(); break; }
      case 'press': {
        const before = await fingerprint(page);
        s.inflight.clear();
        if (input.target) { const el = await locate(page, input.target, 'fill'); await aimLocator(el, 'Press ' + (input.key || 'Enter')); await el.press(input.key || 'Enter'); }
        else { emitCursor(true, 'Press ' + (input.key || 'Enter'), 0.5, 0.5); await page.keyboard.press(input.key || 'Enter'); }
        const same = await afterInteract(before);
        s.unchanged = /^(Enter|NumpadEnter)$/.test(input.key || 'Enter') && same;
        break;
      }
      case 'wait': {
        emitCursor(true, input.target ? 'Waiting for ' + input.target : 'Waiting on page', 0.5, 0.45);
        if (input.target) await (await locate(page, input.target, 'click')).waitFor({ state: 'visible', timeout: Math.min((input.seconds || 10) * 1000, 30000) });
        else await page.waitForTimeout(Math.min((input.seconds || 2) * 1000, 15000));
        break;
      }
      case 'back': emitCursor(true, 'Going back', 0.45, 0.45); await page.goBack().catch(() => {}); await settle(); break;
      // Reload: does what was saved survive a fresh load (it is in the database, not only on screen)?
      case 'reload': { emitCursor(true, 'Reloading page', 0.5, 0.45); const r = await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => null); s.lastStatus = r ? r.status() : null; await settle(); break; }
      case 'read': emitCursor(true, 'Inspecting elements & accessibility', 0.52, 0.46); break;
      case 'launch': await settle(); break; // the app was started above
      case 'screenshot': {
        emitCursor(true, 'Capturing visual snapshot', 0.5, 0.5);
        // A slow machine (no GPU, software rendering) can need longer than one action's timeout. A desktop
        // app that still does not answer is captured by Electron itself, which does not wait for fonts.
        let png;
        try { png = await page.screenshot({ fullPage: !!input.full, type: 'png', timeout: 30_000 }); } catch (e) {
          if (!s.app) throw e;
          const b64 = await s.app.evaluate(async ({ BrowserWindow }) => {
            const w = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            return w ? (await w.capturePage()).toPNG().toString('base64') : null;
          });
          if (!b64) throw e;
          png = Buffer.from(b64, 'base64');
        }
        const text = await snapshot(page, s);
        return { text: `${text}\n\n[screenshot of ${page.url()}: shown below]`, images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }] };
      }
      default: throw new Error(`Unknown browser action "${action}". Use open, click, fill, select, check, press, wait, back, reload, read, screenshot or close.`);
    }
  } finally {
    emitCursor(false);
  }
  const text = await snapshot(page, s, { full: !!input.full });
  // Problems a user would hit, for the agent's UI check: errors since this step, or a click/Enter that
  // changed nothing at all (a submit that did not submit, a link that did not go anywhere).
  const unchanged = s.unchanged && ['click', 'press'].includes(action);
  s.unchanged = false;
  const errors = (s.lastEvents || []).filter((e) => !/^dialog/.test(e));
  const issue = unchanged ? `${action === 'click' ? `clicking "${input.target}"` : `pressing ${input.key || 'Enter'}`} changed nothing on ${new URL(page.url()).pathname}`
    : errors.length ? `${errors[0].split(':')[0]} on ${new URL(page.url()).pathname}: ${errors[0].slice(0, 160)}` : null;
  return { text: unchanged ? `${text}
Note: nothing on the page changed after this step (same address, same text). If it was meant to submit, save or navigate, it did not work: find out why (failed request? page code not loaded? validation?) and fix it.` : text, issue };
}

/** A cheap signature of what the user sees: address plus visible text and form/dialog state. */
async function fingerprint(page) {
  try {
    return page.url() + '|' + (await page.evaluate(() => {
      if (!document.body) return '';
      const vals = [...document.querySelectorAll('input,select,textarea')].map((e) => (e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value)).join('\x1f');
      return document.body.innerText + '|' + vals + '|' + document.querySelectorAll('[role="dialog"],dialog[open]').length;
    }));
  } catch { return page.url(); }
}

async function closeAll() { await Promise.all([...sessions.values()].map((s) => s.close())); }
/** Closes one session (an app or a browser) if it is open. */
async function closeKey(key) { await sessions.get(key)?.close(); }
const isOpen = (key) => !!sessions.get(key)?.page;

/** A small picture of what a browser session shows now, for the live pane (never sent to the model). */
async function frame(key) {
  const s = sessions.get(key);
  if (!s?.page || s.page.isClosed()) return null;
  try {
    const url = s.page.url();
    if (isErrorUrl(url)) return { url, title: '', data: null, errorPage: true };
    const png = await s.page.screenshot({ type: 'jpeg', quality: 82, timeout: 15000 });
    return { url, title: await s.page.title().catch(() => ''), data: png.toString('base64') };
  } catch { return null; }
}

/** Starts, stops or resizes the CDP live screencast for a browser session. */
async function streamControl(key, cmd, opts = {}) {
  const s = sessions.get(key);
  if (!s || !s.page || s.page.isClosed()) return { ok: false };
  if (cmd === 'stop') { await s.stopStream(); return { ok: true }; }
  if (cmd === 'resize') {
    return s.withLock(async () => {
      const w = Math.max(480, Math.min(1600, Math.round(Number(opts.width || 1280))));
      const h = Math.max(420, Math.min(1200, Math.round(Number(opts.height || 840))));
      const cur = s.page.viewportSize();
      if (!cur || Math.abs(cur.width - w) > 36 || Math.abs(cur.height - h) > 36) {
        await s.page.setViewportSize({ width: w, height: h }).catch(() => {});
      }
      if (s.streaming) return { ok: true, frame: await frame(key) };
      return { ok: true };
    });
  }
  if (cmd === 'start') {
    const ok = await s.startStream(opts);
    return { ok, frame: await frame(key) };
  }
  return { ok: false };
}

/** Interactive controls for the user's Live Browser Pane (shares the same Playwright session). */
async function interact(key, action, payload = {}) {
  if (!pw) throw new Error('The browser is not available (playwright-core is not installed).');
  const s = sessionFor(key);
  if (action === 'stop') {
    if (s.page && !s.page.isClosed()) await s.page.evaluate(() => window.stop()).catch(() => {});
    return frame(key);
  }
  return s.withLock(async () => {
    const page = await s.ensure();
    if (streamHandler && !s.app && !s.streaming) await s.startStream().catch(() => {});
    const vp = page.viewportSize() || { width: 1280, height: 840 };
    const toPx = (xr, yr) => [
      Math.max(0, Math.min(vp.width - 1, Math.round(Number(xr || 0) * vp.width))),
      Math.max(0, Math.min(vp.height - 1, Math.round(Number(yr || 0) * vp.height))),
    ];
    if (action === 'open') {
      const raw = String(payload.url || '').trim();
      if (!raw) return frame(key);
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      let u;
      try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${raw}`); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('Only http:// and https:// URLs are allowed.');
      if (!(await hostAllowed(u.hostname))) throw new Error(`${u.hostname} is on a private network.`);
      await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    } else if (action === 'back') {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    } else if (action === 'forward') {
      await page.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    } else if (action === 'reload') {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } else if (action === 'move') {
      const [x, y] = toPx(payload.xRatio, payload.yRatio);
      await page.mouse.move(x, y);
      return null;
    } else if (action === 'drag') {
      const [x1, y1] = toPx(payload.x1, payload.y1);
      const [x2, y2] = toPx(payload.x2, payload.y2);
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(100).catch(() => {});
    } else if (action === 'clickAt') {
      const [x, y] = toPx(payload.xRatio, payload.yRatio);
      await page.mouse.click(x, y);
      await page.waitForTimeout(180).catch(() => {});
    } else if (action === 'scroll') {
      await page.mouse.wheel(0, Number(payload.deltaY) || 300);
      await page.waitForTimeout(100).catch(() => {});
    } else if (action === 'type') {
      if (payload.key) await page.keyboard.press(String(payload.key));
      else if (payload.text) await page.keyboard.type(String(payload.text));
      await page.waitForTimeout(120).catch(() => {});
    }
    return frame(key);
  });
}

/** Loads or reloads a local preview URL inside the live browser session and captures a fresh frame. */
async function previewSync(key, url, { reload = false } = {}) {
  if (!pw || !url) return null;
  const s = sessionFor(key);
  return s.withLock(async () => {
    const page = await s.ensure();
    const curUrl = page.url();
    if (reload && curUrl === url) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } else {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
    if (streamHandler && !s.app && !s.streaming) await s.startStream().catch(() => {});
    await page.waitForTimeout(140).catch(() => {});
    return frame(key);
  });
}

module.exports = { available, act, interact, closeAll, closeKey, isOpen, locate, frame, hostAllowed, setStreamHandler, setColorScheme, streamControl, previewSync };
