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
  return { available: true, current, version, url, notes: String(rel.body || '').replace(/\r/g, '').trim().slice(0, 600), publishedAt: rel.published_at || null };
}

module.exports = { compare, check, REPO };
