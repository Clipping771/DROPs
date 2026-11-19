// @ts-check
// Generates an independent, reproducible HTML evaluation dashboard from real bench/results/*.json files.
const fs = require('fs');
const path = require('path');
const { summarizeResults } = require('./run');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Loads all valid benchmark result JSON files sorted chronologically. */
function loadBenchmarkRuns(resultsDir = path.join(__dirname, 'results')) {
  if (!fs.existsSync(resultsDir)) return [];
  return fs.readdirSync(resultsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
        if (!Array.isArray(raw.results)) return null;
        const norm = raw.costPerSuccess !== undefined ? raw : { ...raw, ...summarizeResults(raw.results, { model: raw.model, effort: raw.effort, runs: raw.runs || 1 }) };
        return { file, ...norm };
      } catch { return null; }
    })
    .filter(Boolean);
}

/** Computes task-level regressions between consecutive benchmark runs. */
function computeRegressions(runs) {
  const events = [];
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1], curr = runs[i];
    const prevMap = new Map((prev.results || []).map((r) => [r.task, !!r.pass]));
    const regressed = [], fixed = [];
    for (const r of curr.results || []) {
      if (!prevMap.has(r.task)) continue;
      if (prevMap.get(r.task) && !r.pass) regressed.push(r.task);
      else if (!prevMap.get(r.task) && r.pass) fixed.push(r.task);
    }
    if (regressed.length || fixed.length) events.push({ date: curr.date, model: curr.model, vs: prev.file, regressed, fixed });
  }
  return events;
}

/** Renders the evaluation dashboard HTML from real benchmark runs (never fabricates data). */
function renderDashboardHtml(runs) {
  const regressions = computeRegressions(runs);
  const runRows = runs.map((r) => `<tr>
    <td>${esc((r.date || '').slice(0, 16).replace('T', ' '))}</td>
    <td><code>${esc(r.model)}</code></td>
    <td>${esc(r.effort || 'medium')}</td>
    <td><strong>${r.passed}/${r.attempts} (${r.successRate}%)</strong></td>
    <td>${r.avgSeconds ?? 0}s</td>
    <td>${r.cost != null ? '$' + r.cost : 'N/A'}</td>
    <td>${r.costPerSuccess != null ? '$' + r.costPerSuccess : 'N/A'}</td>
    <td>${r.escalations ?? 0}</td>
  </tr>`).join('\n');

  const catTotals = {};
  const failTotals = {};
  for (const r of runs) {
    for (const [cat, v] of Object.entries(r.byCategory || {})) {
      const c = catTotals[cat] ||= { passed: 0, total: 0 };
      c.passed += v.passed || 0; c.total += v.total || 0;
    }
    for (const [b, n] of Object.entries(r.failures || {})) failTotals[b] = (failTotals[b] || 0) + n;
  }
  const catRows = Object.entries(catTotals).map(([k, v]) => {
    const pct = v.total ? Math.round((v.passed / v.total) * 1000) / 10 : 0;
    return `<tr><td>${esc(k)}</td><td>${v.passed}/${v.total}</td><td>${pct}%</td></tr>`;
  }).join('\n');
  const failRows = Object.entries(failTotals).map(([k, n]) => `<tr><td><code>${esc(k)}</code></td><td>${n}</td></tr>`).join('\n');
  const regRows = regressions.map((e) => `<tr>
    <td>${esc((e.date || '').slice(0, 16).replace('T', ' '))}</td>
    <td><code>${esc(e.model)}</code></td>
    <td class="bad">${esc(e.regressed.join(', ') || 'none')}</td>
    <td class="ok">${esc(e.fixed.join(', ') || 'none')}</td>
  </tr>`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>DROPs Independent Evaluation Dashboard</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 24px auto; max-width: 1080px; padding: 0 16px; background: #0b0e14; color: #f0f4f9; }
  h1, h2 { font-weight: 600; }
  .muted { color: #8b95a7; font-size: 13px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin: 16px 0; }
  .card { background: #131822; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
  th { color: #8b95a7; font-weight: 500; }
  code { font-family: ui-monospace, monospace; background: #1e2636; padding: 2px 6px; border-radius: 6px; }
  .ok { color: #5bb974; } .bad { color: #f28b82; }
</style>
</head>
<body>
  <h1>DROPs Independent Evaluation Dashboard</h1>
  <p class="muted">Generated from ${runs.length} recorded run(s) in <code>bench/results/</code>. Re-run with <code>npm run bench:dashboard</code>.</p>
  <div class="card">
    <h2>Model &amp; Run Comparisons</h2>
    ${runs.length ? `<table><thead><tr><th>Date</th><th>Model</th><th>Effort</th><th>Pass Rate</th><th>Avg Time</th><th>Total Cost</th><th>Cost / Success</th><th>Escalations</th></tr></thead><tbody>${runRows}</tbody></table>` : '<p class="muted">No benchmark result JSON files found yet. Run <code>npm run bench</code> first.</p>'}
  </div>
  <div class="grid">
    <div class="card">
      <h2>Success Rate by Category</h2>
      ${catRows ? `<table><thead><tr><th>Category</th><th>Passed</th><th>Rate</th></tr></thead><tbody>${catRows}</tbody></table>` : '<p class="muted">No category data yet.</p>'}
    </div>
    <div class="card">
      <h2>Failure &amp; Recovery Buckets</h2>
      ${failRows ? `<table><thead><tr><th>Bucket</th><th>Count</th></tr></thead><tbody>${failRows}</tbody></table>` : '<p class="muted">No failures recorded.</p>'}
    </div>
  </div>
  <div class="card">
    <h2>Regression History</h2>
    ${regRows ? `<table><thead><tr><th>Date</th><th>Model</th><th>Regressed</th><th>Fixed</th></tr></thead><tbody>${regRows}</tbody></table>` : '<p class="muted">No regressions or fixes between runs recorded yet.</p>'}
  </div>
</body>
</html>\n`;
}

function generateDashboard(resultsDir = path.join(__dirname, 'results'), outFile = path.join(resultsDir, 'dashboard.html')) {
  const runs = loadBenchmarkRuns(resultsDir);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderDashboardHtml(runs), 'utf8');
  return { runs: runs.length, outFile };
}

if (require.main === module) {
  const res = generateDashboard();
  console.log(`Generated evaluation dashboard (${res.runs} runs): ${path.relative(process.cwd(), res.outFile)}`);
}

module.exports = { loadBenchmarkRuns, computeRegressions, renderDashboardHtml, generateDashboard };
