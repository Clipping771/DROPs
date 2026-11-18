#!/usr/bin/env node
// DROPs benchmark runner.
//   node bench/run.js [--model auto] [--effort medium] [--tasks name1,name2] [--runs 1] [--compare prev.json] [--timeout 300] [--baseline]
// Each task: copy repo/ to a temp folder, let DROPs work on it headlessly, then copy the hidden tests in
// (overwriting anything the agent changed in them) and run the task's check command. Pass = exit code 0.
// --baseline also runs the checks on the untouched repos to prove every task starts out failing.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { runHeadless } = require('../src/cli');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const model = opt('model', 'auto');
const effort = opt('effort', 'medium');
const timeoutS = Number(opt('timeout', 300));
const only = opt('tasks', '');
const runs = Math.max(1, Number(opt('runs', 1)) || 1);
const comparePath = opt('compare', '');
const jsonlDataset = opt('jsonl-dataset', '');
const reportPath = opt('report', '');
const baseline = args.includes('--baseline');

const TASKS = path.join(__dirname, 'tasks');
const names = fs.existsSync(TASKS)
  ? fs.readdirSync(TASKS).filter((n) => fs.existsSync(path.join(TASKS, n, 'task.json'))).filter((n) => !only || only.split(',').includes(n)).sort()
  : [];

/** Parses a SWE-bench / Terminal-Bench JSONL dataset into normalized benchmark tasks. */
function parseSweBenchJsonl(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const rec = JSON.parse(line);
      return {
        id: rec.instance_id || rec.id || `task-${idx + 1}`,
        category: rec.category || (rec.repo ? rec.repo.split('/').pop() : 'swe-bench'),
        repo: rec.repo || null,
        baseCommit: rec.base_commit || null,
        prompt: rec.problem_statement || rec.prompt || rec.instruction || '',
        check: rec.check || 'npm test',
        testPatch: rec.test_patch || null,
      };
    });
}

/** Classifies a failed benchmark run into an actionable failure bucket. */
function categorizeFailure(row) {
  if (row.pass) return null;
  if (/timeout/i.test(row.error || '')) return 'timeout';
  if (row.stoppedByLimit) return 'stopped_by_limit';
  if (row.error) return 'error';
  if (row.verifyFailed) return 'verify_failed';
  if ((row.toolErrors || 0) >= 3) return 'tool_errors';
  return 'patch_or_test_failed';
}

/** Formats a benchmark summary into a Markdown scorecard suitable for reviews/leaderboards. */
function formatScorecard(summary) {
  const lines = [
    `# DROPs Benchmark Scorecard`,
    ``,
    `- **Date:** ${summary.date}`,
    `- **Model:** \`${summary.model}\` · **Effort:** \`${summary.effort}\``,
    `- **Pass Rate:** **${summary.passed}/${summary.attempts} (${summary.successRate}%)**${summary.passAtK != null ? ` · **pass@${summary.runs}:** ${summary.passAtK}%` : ''}`,
    `- **Avg Time:** ${summary.avgSeconds}s/task · **Tokens:** ${summary.tokensIn} in / ${summary.tokensOut} out · **Cost:** ${summary.cost != null ? `$${summary.cost}` : 'N/A'}`,
    ``,
    `## By Category`,
    `| Category | Passed | Total | Pass Rate |`,
    `|---|---:|---:|---:|`,
    ...Object.entries(summary.byCategory || {}).map(([k, v]) => `| ${k} | ${v.passed} | ${v.total} | ${v.passRate}% |`),
  ];
  const failures = summary.failures || {};
  if (Object.keys(failures).length) {
    lines.push('', '## Failure Breakdown', '| Bucket | Count |', '|---|---:|', ...Object.entries(failures).map(([k, v]) => `| ${k} | ${v} |`));
  }
  return lines.join('\n') + '\n';
}

function check(dir, cmd) {
  try { execSync(cmd, { cwd: dir, stdio: 'pipe', timeout: 180000, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }); return { pass: true }; } catch (e) {
    return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
function prepare(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `h2o-bench-${name}-`));
  fs.cpSync(path.join(TASKS, name, 'repo'), dir, { recursive: true });
  return dir;
}
function grade(name, dir) {
  const task = JSON.parse(fs.readFileSync(path.join(TASKS, name, 'task.json'), 'utf8'));
  const hidden = path.join(TASKS, name, 'hidden');
  if (fs.existsSync(hidden)) fs.cpSync(hidden, dir, { recursive: true, force: true });
  return check(dir, task.check);
}

async function main() {
  const datasetTasks = jsonlDataset ? parseSweBenchJsonl(fs.readFileSync(path.resolve(jsonlDataset), 'utf8')).filter((t) => !only || only.split(',').includes(t.id)) : null;
  const taskNames = datasetTasks ? datasetTasks.map((t) => t.id) : names;
  if (baseline && !datasetTasks) {
    console.log('Baseline (untouched repos must FAIL their checks):');
    let bad = 0;
    for (const n of taskNames) { const d = prepare(n); const r = grade(n, d); console.log(`  ${r.pass ? 'PASSES (bad task!)' : 'fails  (good)'}  ${n}`); if (r.pass) bad++; fs.rmSync(d, { recursive: true, force: true }); }
    if (bad) process.exit(1);
    if (!args.includes('--model')) return;
  }
  console.log(`\nDROPs benchmark · model ${model} · effort ${effort} · ${taskNames.length} tasks${runs > 1 ? ` · ${runs} runs each` : ''}\n`);
  const results = [];
  for (let idx = 0; idx < taskNames.length; idx++) {
    const name = taskNames[idx];
    const task = datasetTasks ? datasetTasks[idx] : JSON.parse(fs.readFileSync(path.join(TASKS, name, 'task.json'), 'utf8'));
    for (let runIdx = 1; runIdx <= runs; runIdx++) {
      let dir, t0, r, err, g;
      // A provider rate limit is not a task failure: wait and run the task again from scratch.
      for (let attempt = 1; attempt <= 3; attempt++) {
        dir = datasetTasks ? fs.mkdtempSync(path.join(os.tmpdir(), `drops-swe-${name.replace(/[^\w.-]/g, '_')}-`)) : prepare(name);
        if (datasetTasks && task.repo && fs.existsSync(task.repo)) fs.cpSync(task.repo, dir, { recursive: true });
        t0 = Date.now(); r = null; err = null;
        try {
          r = await Promise.race([
            runHeadless({ project: dir, task: task.prompt, model, effort, mode: 'yolo', maxSteps: 60 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutS * 1000)),
          ]);
        } catch (e) { err = e.message; }
        g = datasetTasks ? check(dir, task.check) : grade(name, dir);
        // A dead key / missing credentials is not a task failure: stop instead of recording fake results.
        if (!g.pass && (r?.errors || [err || '']).some((e) => /key was rejected|No API key|API key not valid|needs a key/i.test(e || ''))) {
          console.error(`\nBenchmark aborted on ${name}: the provider rejected the API key (${(r?.errors || [err])[0]}). No results saved.`);
          fs.rmSync(dir, { recursive: true, force: true });
          process.exit(1);
        }
        const quota = !g.pass && (r?.errors || []).some((e) => /quota|rate limit|busy or over quota|429/i.test(e));
        if (!quota || attempt === 3) break;
        console.log(`  (rate-limited on ${name}, waiting 70s and retrying — attempt ${attempt + 1}/3)`);
        fs.rmSync(dir, { recursive: true, force: true });
        await new Promise((res) => setTimeout(res, 70000));
      }
      const u = r?.usage || {};
      const row = {
        task: name, category: task.category, ...(runs > 1 ? { run: runIdx } : {}), pass: g.pass, seconds: Math.round((Date.now() - t0) / 1000),
        tokensIn: (u.input || 0) + (u.cacheRead || 0), tokensOut: u.output || 0, cost: u.cost || 0, costKnown: !u.costUnknown,
        tools: r?.tools || 0, toolErrors: r?.toolErrors || 0, verifyFailed: !!r?.verifyFailed, stoppedByLimit: !!r?.stoppedByLimit, models: r?.models || [], guardNudges: (r?.notices || []).filter((x) => /guard/i.test(x)).length,
        error: err || (r?.errors || [])[0] || null, failure: g.pass ? null : (g.out || '').split('\n').filter((l) => /not ok|Error|assert|FAIL/i.test(l)).slice(0, 3).join(' | '),
      };
      row.failureBucket = categorizeFailure(row);
      results.push(row);
      const tag = runs > 1 ? `${name}#${runIdx}` : name;
      console.log(`${row.pass ? 'PASS' : 'FAIL'}  ${tag.padEnd(28)} ${String(row.seconds).padStart(4)}s  ${String(row.tokensIn).padStart(7)} in ${String(row.tokensOut).padStart(6)} out  ${row.tools} tools${row.guardNudges ? `  ${row.guardNudges} guard` : ''}${row.error ? `  [${row.error.slice(0, 60)}]` : ''}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const byTask = new Map();
  for (const r of results) { if (!byTask.has(r.task)) byTask.set(r.task, []); byTask.get(r.task).push(r); }
  const passAtKTasks = [...byTask.values()].filter((list) => list.some((r) => r.pass)).length;
  const passAtK = byTask.size ? Math.round((passAtKTasks / byTask.size) * 1000) / 10 : 0;
  const byCategory = {};
  for (const r of results) {
    const c = byCategory[r.category || 'uncategorized'] ||= { total: 0, passed: 0 };
    c.total++;
    if (r.pass) c.passed++;
  }
  for (const c of Object.values(byCategory)) c.passRate = Math.round((c.passed / c.total) * 1000) / 10;

  const failures = {};
  for (const r of results) { if (r.failureBucket) failures[r.failureBucket] = (failures[r.failureBucket] || 0) + 1; }
  const sum = (k) => results.reduce((s, r) => s + r[k], 0);
  const summary = {
    date: new Date().toISOString(), model, effort, runs, tasks: byTask.size, attempts: results.length, passed,
    successRate: results.length ? Math.round((passed / results.length) * 1000) / 10 : 0, ...(runs > 1 ? { passAtK } : {}), byCategory, failures,
    totalSeconds: sum('seconds'), avgSeconds: results.length ? Math.round(sum('seconds') / results.length) : 0, tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'),
    cost: results.every((r) => r.costKnown) ? Math.round(sum('cost') * 1000) / 1000 : null, results,
  };
  console.log(`\nResult: ${passed}/${results.length} passed (${summary.successRate}%)${runs > 1 ? ` · pass@${runs}: ${passAtKTasks}/${byTask.size} (${passAtK}%)` : ''} · avg ${summary.avgSeconds}s/task · ${summary.tokensIn} in / ${summary.tokensOut} out tokens${summary.cost != null ? ` · $${summary.cost}` : ' · cost: billed by provider'}`);
  console.log('By category: ' + Object.entries(byCategory).map(([k, v]) => `${k} ${v.passed}/${v.total} (${v.passRate}%)`).join(' · '));

  if (comparePath) {
    try {
      const prev = JSON.parse(fs.readFileSync(path.resolve(comparePath), 'utf8'));
      const prevByTask = new Map();
      for (const r of prev.results || []) prevByTask.set(r.task, prevByTask.get(r.task) || r.pass);
      const regressions = [], improvements = [];
      for (const [taskName, list] of byTask.entries()) {
        if (!prevByTask.has(taskName)) continue;
        const wasPass = prevByTask.get(taskName);
        const nowPass = list.some((r) => r.pass);
        if (wasPass && !nowPass) regressions.push(taskName);
        else if (!wasPass && nowPass) improvements.push(taskName);
      }
      const dSec = summary.avgSeconds - (prev.avgSeconds || 0);
      const dTok = (summary.tokensIn + summary.tokensOut) - ((prev.tokensIn || 0) + (prev.tokensOut || 0));
      console.log(`Compare vs ${comparePath}:`);
      console.log(`  Improvements (${improvements.length}): ${improvements.join(', ') || 'none'}`);
      console.log(`  Regressions  (${regressions.length}): ${regressions.join(', ') || 'none'}`);
      console.log(`  Deltas: avg ${dSec >= 0 ? '+' : ''}${dSec}s/task · ${dTok >= 0 ? '+' : ''}${dTok} total tokens`);
    } catch (e) { console.error(`Compare failed (${comparePath}): ${e.message}`); }
  }

  const outDir = path.join(__dirname, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${summary.date.slice(0, 16).replace(/[:T]/g, '-')}-${model.replace(/[^\w.-]/g, '_')}.json`);
  fs.writeFileSync(file, JSON.stringify(summary, null, 2));
  console.log(`Saved ${path.relative(process.cwd(), file)}`);
  if (reportPath) {
    fs.writeFileSync(path.resolve(reportPath), formatScorecard(summary));
    console.log(`Saved scorecard ${reportPath}`);
  }
}

if (require.main === module) main();
module.exports = { parseSweBenchJsonl, categorizeFailure, formatScorecard };
