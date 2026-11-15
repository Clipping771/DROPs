// Static security and performance audit of a project: rule-based (no AI guessing), each finding with
// file:line, severity and a fix hint. A finding is a lead to check, not proof of a hole: some can be
// false alarms, and a clean report does not mean the app is safe.
'use strict';
const fs = require('fs');
const path = require('path');
const fg = require('fast-glob');

const IGNORE = ['**/node_modules/**', '**/.next/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/test-results/**', '**/.drops/**', '**/.h2o/**', '**/*.min.js', '**/*.map', '**/package-lock.json', '**/*.lock'];
const isTest = (f) => /(^|\/)(tests?|__tests__|spec|e2e|fixtures?)\/|\.(test|spec)\.[a-z]+$/i.test(f);

// Each rule: id, area, severity (high|medium|low), a line regex, optional file filter, and a hint.
const RULES = [
  // ---- security ----
  { id: 'secret-key', area: 'security', severity: 'high', re: /(sk-(?:or-|proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,})/, hint: 'A real-looking API key is in the code. Move it to an environment variable and rotate it.' },
  { id: 'private-key', area: 'security', severity: 'high', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, hint: 'A private key is in the code. Remove it from the repository and rotate it.' },
  { id: 'hardcoded-password', area: 'security', severity: 'medium', re: /\b(password|passwd|secret|api_?key)\s*[:=]\s*['"][^'"\s]{6,}['"]/i, skipTests: true, hint: 'A password or secret is written in the code. Read it from configuration instead.' },
  { id: 'sql-concat', area: 'security', severity: 'high', re: /\b(query|execute|exec|raw|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*(`[^`]*\$\{|['"][^'"]*['"]\s*\+)/i, hint: 'SQL built from strings can be injected. Use parameters (?, $1) or the ORM.' },
  { id: 'eval', area: 'security', severity: 'high', re: /(^|[^.\w])(eval|new Function)\s*\(/, skipTests: true, hint: 'eval/new Function runs text as code. Remove it.' },
  { id: 'raw-html', area: 'security', severity: 'medium', re: /dangerouslySetInnerHTML|\.innerHTML\s*=\s*[^'"`;]*\b(req|params|query|body|input|data|user|props)\b|v-html=/, hint: 'Inserting HTML from data allows XSS. Render text, or sanitize with a library such as DOMPurify.' },
  { id: 'shell-input', area: 'security', severity: 'high', re: /\b(exec|execSync|spawn|spawnSync)\s*\(\s*`[^`]*\$\{[^}]*(req|params|query|body|input)/, hint: 'A shell command is built from request data: command injection. Pass arguments as an array and validate them.' },
  { id: 'cors-any', area: 'security', severity: 'medium', re: /cors\(\s*\)|origin\s*:\s*['"]\*['"]|Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/, hint: 'Any website can call this API. Allow only your own origins.' },
  { id: 'cookie-flags', area: 'security', severity: 'medium', re: /\.cookie\(|cookies\(\)\.set\(|set-cookie/i, check: (line, text) => !/httpOnly/i.test(text), hint: 'Session cookies need httpOnly (and secure, sameSite) so scripts cannot steal them.' },
  { id: 'plain-password', area: 'security', severity: 'high', re: /password\s*:\s*(body|req\.body|input|data|form)\.password\b/, check: (line, text) => !/(bcrypt|argon2|scrypt|pbkdf2|hash)/i.test(text), hint: 'A password seems to be saved as given. Store only a slow hash (bcrypt, argon2).' },
  { id: 'jwt-none', area: 'security', severity: 'high', re: /algorithms?\s*:\s*\[?\s*['"]none['"]/i, hint: 'JWT "none" algorithm accepts unsigned tokens.' },
  { id: 'tls-off', area: 'security', severity: 'high', re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/, hint: 'TLS certificate checks are turned off.' },
  { id: 'open-redirect', area: 'security', severity: 'medium', re: /redirect\(\s*(req\.query|searchParams\.get|params)\b/, hint: 'Redirecting to a URL from the request lets attackers send users anywhere. Allow only known paths.' },
  // ---- performance ----
  { id: 'query-in-loop', area: 'performance', severity: 'medium', loop: true, re: /await\s+(prisma|db|knex|pool|client|sequelize|mongoose|\w+Repository)\b[\w.]*\.(find|findMany|findUnique|findFirst|query|select|get|count|update|create|insert|delete)\w*\(/, hint: 'A database call inside a loop (N+1). Load everything in one query (findMany with "in", a join, or include).' },
  { id: 'sync-io-in-handler', area: 'performance', severity: 'low', re: /\b(readFileSync|writeFileSync|execSync)\(/, file: /(^|\/)(app|pages|routes|api|server|controllers?)\//, skipTests: true, hint: 'Blocking file or process calls in request code stall every user. Use the async versions.' },
  { id: 'select-star', area: 'performance', severity: 'low', re: /SELECT\s+\*\s+FROM/i, hint: 'SELECT * loads every column. Select only what the page needs.' },
  { id: 'no-pagination', area: 'performance', severity: 'low', re: /\.findMany\(\s*\)/, hint: 'findMany() with no limit loads the whole table. Add take/skip (pagination).' },
];

function scan(root, { area = 'all', max = 80 } = {}) {
  const files = fg.sync(['**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte,py,php,rb,go,java,cs,env,json,yml,yaml}', '**/.env*'], { cwd: root, ignore: IGNORE, onlyFiles: true, dot: true, suppressErrors: true, deep: 14 }).slice(0, 6000);
  const findings = [];
  const big = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let text;
    try { const st = fs.statSync(abs); if (st.size > 600_000) { if (!/\.(json|lock)$/.test(rel)) big.push(rel); continue; } text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const f = rel.replace(/\\/g, '/');
    // A committed .env file with values is a secret leak in itself.
    if (/(^|\/)\.env(\.[\w-]+)?$/.test(f) && !/\.(example|sample|template)$/.test(f) && /=\s*\S{8,}/.test(text) && (area === 'all' || area === 'security')) {
      findings.push({ id: 'env-file', area: 'security', severity: 'medium', where: `${f}:1`, line: '(values hidden)', hint: 'An .env file with values is in the project. Make sure it is in .gitignore and never committed.' });
    }
    const lines = text.split(/\r?\n/);
    // Rough loop tracking for "inside a loop" rules: a loop header with a "{" opens a block that ends
    // when the braces close again; a one-line loop (no "{") covers that line only.
    let depth = 0;
    const loops = [];
    lines.forEach((line, i) => {
      const header = /\b(for|while)\s*\(|\.(forEach|map|flatMap)\(\s*(async\s*)?\(?/.test(line);
      const oneLine = header && !line.includes('{');
      if (header && !oneLine) loops.push(depth);
      const inLoop = loops.length > 0 || oneLine;
      for (const rule of RULES) {
        if (area !== 'all' && rule.area !== area) continue;
        if (rule.skipTests && isTest(f)) continue;
        if (rule.file && !rule.file.test(f)) continue;
        if (rule.loop && !inLoop) continue;
        if (!rule.re.test(line)) continue;
        if (rule.check && !rule.check(line, text)) continue;
        if (rule.id === 'secret-key' && /example|placeholder|xxx|your[-_ ]?key|\.\.\./i.test(line)) continue;
        findings.push({ id: rule.id, area: rule.area, severity: rule.severity, where: `${f}:${i + 1}`, line: rule.area === 'security' && /secret|key|password/.test(rule.id) ? '(value hidden)' : line.trim().slice(0, 140), hint: rule.hint });
      }
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      while (loops.length && depth <= loops[loops.length - 1]) loops.pop();
    });
  }
  if (area !== 'security') for (const b of big.slice(0, 5)) findings.push({ id: 'large-file', area: 'performance', severity: 'low', where: `${b}:1`, line: '', hint: 'A very large source file: slow to load and hard to change. Split it.' });
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.where.localeCompare(b.where));
  return { files: files.length, findings: findings.slice(0, max), total: findings.length };
}

/** The audit as a plain report for the agent and the user. */
function auditReport(root, area = 'all') {
  const r = scan(root, { area });
  const count = (s) => r.findings.filter((x) => x.severity === s).length;
  if (!r.total) return `Audit (${area}) of ${r.files} files: no findings from the rules. That is not proof the app is safe: also test logins, permissions and invalid input in the browser.`;
  const head = `Audit (${area}) of ${r.files} files: ${r.total} finding${r.total === 1 ? '' : 's'} (${count('high')} high, ${count('medium')} medium, ${count('low')} low${r.total > r.findings.length ? `; first ${r.findings.length} shown` : ''}).`;
  const body = r.findings.map((x) => `- [${x.severity}] ${x.where} ${x.id}${x.line ? `: ${x.line}` : ''}\n  ${x.hint}`).join('\n');
  return `${head}\n${body}\nThese are rule matches: confirm each in the code. Fix every high one before finishing.`;
}

module.exports = { scan, auditReport, RULES };
