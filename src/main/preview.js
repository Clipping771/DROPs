// Zero-config loopback HTTP preview server for live-reloading UI files written in the workspace.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

const SKIP_RE = /(^|[\\/])(node_modules|\.git|dist|build|\.next|\.nuxt|coverage)([\\/]|$)/i;
const isHtml = (rel) => /\.html?$/i.test(String(rel || '')) && !SKIP_RE.test(String(rel || ''));
const isStyleFile = (rel) => /\.css$/i.test(String(rel || '')) && !SKIP_RE.test(String(rel || ''));
const isAssetFile = (rel) => /\.(css|js|mjs|svg)$/i.test(String(rel || '')) && !SKIP_RE.test(String(rel || ''));

const servers = new Map(); // rootAbs -> { root, server, port, baseUrl, pages, activeHtml, starting }

function normalizeRel(relPath) {
  return String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function pageList(st) {
  return st.pages.map((p) => ({
    rel: p,
    label: path.basename(p),
    url: `${st.baseUrl}/${encodeURI(p)}`,
  }));
}

async function ensureServer(projectDir) {
  const rootAbs = path.resolve(projectDir);
  const existing = servers.get(rootAbs);
  if (existing?.server) return existing;
  if (existing?.starting) return existing.starting;

  const state = { root: rootAbs, server: null, port: 0, baseUrl: '', pages: [], activeHtml: null, starting: null };
  state.starting = new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const rawUrl = String(req.url || '/').split('?')[0];
      let pathname;
      try {
        pathname = decodeURIComponent(rawUrl);
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }

      const relSeg = pathname.replace(/^\/+/, '');
      const abs = path.resolve(rootAbs, relSeg);
      if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      let target = abs;
      try {
        const st = await fsp.stat(target);
        if (st.isDirectory()) target = path.join(target, 'index.html');
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }

      if (target !== rootAbs && !target.startsWith(rootAbs + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }

      try {
        const st = await fsp.stat(target);
        if (!st.isFile()) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }
        const ext = path.extname(target).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        });
        fs.createReadStream(target).pipe(res);
      } catch {
        if (!res.headersSent) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
        }
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      state.server = server;
      state.port = addr.port;
      state.baseUrl = `http://127.0.0.1:${addr.port}`;
      state.starting = null;
      resolve(state);
    });
  });

  servers.set(rootAbs, state);
  return state.starting;
}

function findHtmlInDir(rootAbs, dirRel) {
  const dirAbs = dirRel && dirRel !== '.' ? path.resolve(rootAbs, dirRel) : rootAbs;
  if (dirAbs !== rootAbs && !dirAbs.startsWith(rootAbs + path.sep)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  const htmlFiles = entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  if (!htmlFiles.length) return null;
  const pick = htmlFiles.find((n) => n.toLowerCase() === 'index.html') || htmlFiles[0];
  return dirRel && dirRel !== '.' ? `${dirRel.replace(/\\/g, '/')}/${pick}` : pick;
}

function findNearbyHtml(rootAbs, rel) {
  const dirRel = path.posix.dirname(rel);
  if (dirRel && dirRel !== '.') {
    const localHit = findHtmlInDir(rootAbs, dirRel);
    if (localHit) return localHit;
  }
  return findHtmlInDir(rootAbs, '.');
}

function trackPage(st, rel) {
  if (!st.pages.includes(rel)) {
    if (st.pages.length >= 12) st.pages.shift();
    st.pages.push(rel);
  }
  st.activeHtml = rel;
}

async function onFileChanged(projectDir, relPath) {
  const rel = normalizeRel(relPath);
  if (!projectDir || !rel || SKIP_RE.test(rel)) return null;
  const rootAbs = path.resolve(projectDir);

  if (isHtml(rel)) {
    const st = await ensureServer(rootAbs);
    trackPage(st, rel);
    return {
      state: 'ready',
      reason: 'html',
      file: rel,
      activeHtml: rel,
      url: `${st.baseUrl}/${encodeURI(rel)}`,
      pages: pageList(st),
    };
  }

  if (isAssetFile(rel)) {
    const html = servers.get(rootAbs)?.activeHtml || findNearbyHtml(rootAbs, rel);
    if (html) {
      const st = await ensureServer(rootAbs);
      trackPage(st, html);
      return {
        state: 'reload',
        reason: 'asset',
        file: rel,
        activeHtml: html,
        url: `${st.baseUrl}/${encodeURI(html)}`,
        pages: pageList(st),
      };
    }
    if (isStyleFile(rel)) {
      return { state: 'building', reason: 'style', file: rel, activeHtml: null, url: null, pages: [] };
    }
  }

  return null;
}

async function closeProject(projectDir) {
  if (!projectDir) return;
  const rootAbs = path.resolve(projectDir);
  const st = servers.get(rootAbs);
  if (!st) return;
  servers.delete(rootAbs);
  if (st.starting) {
    try { await st.starting; } catch { /* ignore */ }
  }
  if (st.server) {
    st.server.closeAllConnections?.();
    await new Promise((resolve) => st.server.close(() => resolve()));
  }
}

async function closeAll() {
  await Promise.all([...servers.keys()].map((root) => closeProject(root)));
}

module.exports = { onFileChanged, closeProject, closeAll, isHtml, isStyleFile, isAssetFile };
