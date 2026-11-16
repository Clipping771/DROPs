// Update check: asks GitHub for the newest DROPs release and tells the user when it is newer.
// It only reads the public releases page (no account, nothing about the user is sent besides the
// request itself). Downloading and installing stay the user's choice: DROPs opens the release page.
// Settings → "Check for updates" turns it off.
const https = require('https');

const REPO = 'Clipping771/DROPs';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** -1, 0 or 1 for two versions like "2.1.0" and "v2.2.0-beta.1" (a pre-release is older than its release). */
function compare(a, b) {
  const p = (v) => { const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-(.+))?/); return m ? [+m[1], +(m[2] || 0), +(m[3] || 0), m[4] || ''] : [0, 0, 0, '']; };
  const x = p(a), y = p(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1; if (!y[3]) return -1;
  return x[3] < y[3] ? -1 : 1;
}

function getJson(url, timeout = 10_000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'DROPs-update-check', Accept: 'application/vnd.github+json' }, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 500_000) body += d; });
      res.on('end', () => {
        if (res.statusCode === 404) return resolve(null);
        if (res.statusCode !== 200) return reject(new Error(`GitHub answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

/**
 * Returns { available: false } or { available: true, version, url, notes, publishedAt }.
 * `fetchLatest` can be replaced in tests.
 */
async function check(current, { fetchLatest = () => getJson(API) } = {}) {
  const rel = await fetchLatest();
  if (!rel || rel.draft || rel.prerelease || !rel.tag_name) return { available: false, current };
  const version = String(rel.tag_name).replace(/^v/i, '');
  if (compare(version, current) <= 0) return { available: false, current, latest: version };
  const url = /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${REPO}/releases/latest`;
  return { available: true, current, version, url, notes: String(rel.body || '').replace(/\r/g, '').trim().slice(0, 600), publishedAt: rel.published_at || null, installer: pickInstaller(rel.assets, version) };
}

// ---------- download and install (Windows installer only) ----------
const crypto = require('crypto');
const fs = require('fs');
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
/** The Windows installer of a release ("DROPs Setup 2.3.0.exe"), never the portable build or a zip. */
function pickInstaller(assets, version) {
  const list = (Array.isArray(assets) ? assets : []).filter((a) => /setup.*\.exe$/i.test(a?.name || '') && !/portable/i.test(a.name)
    && String(a.browser_download_url || '').startsWith(ASSET_PREFIX));
  const a = list.find((x) => x.name.includes(version)) || list[0];
  if (!a) return null;
  const sha256 = /^sha256:([a-f0-9]{64})$/i.test(a.digest || '') ? a.digest.slice(7).toLowerCase() : null;
  return { name: a.name, url: a.browser_download_url, size: Number(a.size) || 0, sha256 };
}

/** GET over https only, following GitHub's redirects to its download servers. */
function getStream(url, redirects = 5, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//.test(url)) return reject(new Error('Refusing a download that is not https.'));
    const req = https.get(url, { headers: { 'User-Agent': 'DROPs-update', Accept: 'application/octet-stream' }, timeout }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getStream(new URL(res.headers.location, url).toString(), redirects - 1, timeout));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The download answered ${res.statusCode}`)); }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('The download timed out.')));
    req.on('error', reject);
  });
}

/**
 * Downloads the installer to `dest`, checking the size and (when GitHub lists it) the SHA-256 digest.
 * Only files from this project's GitHub releases are accepted. `get` can be replaced in tests.
 */
async function downloadInstaller(installer, dest, { onProgress = () => {}, get = getStream } = {}) {
  if (!installer || !String(installer.url || '').startsWith(ASSET_PREFIX)) throw new Error('This update has no installer from the DROPs releases page.');
  const res = await get(installer.url);
  const total = installer.size || Number(res.headers?.['content-length']) || 0;
  const hash = crypto.createHash('sha256');
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let got = 0, lastPct = -1;
  try {
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        got += chunk.length; hash.update(chunk);
        if (installer.size && got > installer.size) { res.destroy(new Error('The download is larger than the release says.')); return; }
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct !== lastPct) { lastPct = pct; onProgress({ received: got, total, percent: pct }); }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    if (installer.size && got !== installer.size) throw new Error(`The download is incomplete (${got} of ${installer.size} bytes).`);
    const digest = hash.digest('hex');
    if (installer.sha256 && digest !== installer.sha256) throw new Error('The downloaded file does not match the release (checksum differs). Nothing was installed.');
    fs.renameSync(tmp, dest);
    return { path: dest, sha256: digest, verified: !!installer.sha256 };
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
}

module.exports = { compare, check, REPO, pickInstaller, downloadInstaller };
