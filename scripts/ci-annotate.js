// CI helper: turns failed tests in a node --test (TAP) log into GitHub error annotations, which anyone can
// read on the run page and through the public API (step logs need a sign-in).
// Usage: node scripts/ci-annotate.js <log file> [title]
const fs = require('fs');

// Workflow-command escaping (%, CR, LF), and no ANSI colours.
const esc = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C'); // the title is a property: ":" and "," too

const [file, title = 'Test failed'] = process.argv.slice(2);
let log = '';
try { log = fs.readFileSync(file, 'utf8'); } catch { console.log(`::error title=${escProp(title)}::No test log at ${file}`); process.exit(0); }
const lines = log.split(/\r?\n/);
let found = 0;
for (let i = 0; i < lines.length && found < 10; i++) {
  if (!/^\s*not ok \d+/.test(lines[i])) continue;
  found++;
  // The YAML block after "not ok": error, expected/actual, and the first lines of the stack and app output.
  const detail = [];
  for (let j = i + 1; j < Math.min(lines.length, i + 80) && !/^\s*(not ok|ok) \d+/.test(lines[j]); j++) {
    const l = lines[j];
    const t = l.trim();
    if (/^(duration_ms|type|failureType|code|operator):/.test(t) || t === '---' || t === '...' || !t) continue;
    detail.push(l.trimEnd());
    if (detail.join('\n').length > 3000) break;
  }
  console.log(`::error title=${escProp(`${title} - ${lines[i].replace(/^\s*not ok \d+ - /, '').slice(0, 120)}`)}::${esc(detail.join('\n').slice(0, 3500))}`);
}
// No "not ok" line: the run died before or between tests (a crash, a hang, a missing screen). Show the end.
if (!found) console.log(`::error title=${escProp(`${title} - no failing test line, last output`)}::${esc(lines.slice(-60).join('\n').slice(-3500))}`);
