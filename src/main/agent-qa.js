// @ts-check
// Independent QA check authoring, adversarial checks, requirement verification, and staleness re-checks.
const providers = require('./providers');
const guards = require('./guards');
const shell = require('./shell');
const { specFacts, factsText, appDown, specRequirements, sourceFingerprint } = require('./agent-evidence');

const isPlanMode = (mode) => mode === 'plan' || mode === 'architect';
const isReviewMode = (mode) => mode === 'review';

async function writeQaChecks(session, specText, model) {
  if (!specText) return;
  const reqs = session.data.requirements;
  const system = 'You are an independent QA engineer. You have NOT seen the code and you do not trust the developer. From the specification alone, write one acceptance check per functional requirement, the way a careful user would test it. Use ONLY the routes, data-testid attributes, field labels and demo accounts the specification names, copied exactly (the list after the specification has them); never invent an email, password, route or test id. If a check needs an account and the specification names none, sign up a new account with a unique email in that check first. The app runs at the base URL given after the specification. Prefer kind "browser": steps for a real browser ({"action":"open","url":...}, {"action":"fill","target":"testid=..." or a label,"value":...}, {"action":"click","target":...}, {"action":"select",...}, {"action":"press","key":"Enter"}), ending on a page that must show the "expect" text, which only a working feature shows. When a requirement saves something (create, edit, delete, a setting), add {"action":"reload"} before the end, so the check proves the data was really stored, not only shown. Use kind "http" ({"url","method","body","expect"}) only for pure API requirements. Log in first in each check that needs an account. Reply with JSON only: [{"id":"FR-1","kind":"browser","steps":[...],"expect":"..."}, ...].';
  const facts = specFacts(specText);
  const prompt = `Specification:\n${String(specText).slice(0, 24000)}\n\n${factsText(facts)}\n\nRequirements to cover: ${reqs.map((r) => r.id).join(', ')}`;
  const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: session.abort?.signal || new AbortController().signal, emit: () => {}, deps: session.deps, state: {} });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no JSON list in the reply');
  let list;
  try { list = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('the reply was not valid JSON'); }
  let n = 0;
  session.data.qaBase = facts.base;
  for (const c of Array.isArray(list) ? list : []) {
    const r = reqs.find((x) => x.id === c?.id);
    if (!r || !['browser', 'http'].includes(c.kind) || !String(c.expect || '').trim()) continue;
    if (c.kind === 'browser' && !(Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'))) continue;
    if (c.kind === 'http' && !/^http:\/\/localhost:\d+\//.test(String(c.url || ''))) continue;
    r.qa = c.kind === 'browser' ? { kind: 'browser', steps: c.steps.slice(0, 25), expect: String(c.expect).slice(0, 200) } : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect).slice(0, 200) };
    n++;
  }
  session.emit('notice', { message: `QA agent wrote independent checks for ${n} of ${reqs.length} requirements.` });
  await writeAdversarialChecks(session, specText, model, facts).catch((e) => session.emit('notice', { message: `Adversarial QA could not write checks: ${String(e.message || e).slice(0, 120)}` }));
  session.save();
}

/** A second QA engineer tries to break each rule the spec states: wrong password, logged-out visitor,
 *  another user's data, a lower role, empty or invalid input, duplicates. Up to two attacks per requirement. */
async function writeAdversarialChecks(session, specText, model, facts) {
  const reqs = session.data.requirements;
  const system = 'You are an adversarial QA engineer. You have NOT seen the code. Your job is to find where the app accepts what it must refuse. For each functional requirement whose rule can be misused, write at most two attack checks, only for rules the specification states or clearly implies: a wrong password, a logged-out visitor opening a protected page, a user opening another user\'s data, a lower role opening an admin page, empty or invalid input, a duplicate. Each attack must end on a page that proves the app refused correctly: "expect" = text that must appear (e.g. the error message the spec names), and/or "expect_url" = the path the final page must be on (e.g. "/login"), and/or "forbid" = text that must NOT appear (e.g. another user\'s record). Use ONLY accounts, routes, test ids and texts from the list after the specification. Browser steps: {"action":"open","url":...}, {"action":"fill","target":...,"value":...}, {"action":"click","target":...}, {"action":"press","key":"Enter"}. For HTTP attacks use kind "http" with "expect_status" (401, 403, 404 or 400). Reply with JSON only: [{"id":"FR-1","kind":"browser","steps":[...],"expect_url":"/login","why":"logged-out visitors are sent to log in"}, ...].';
  const prompt = `Specification:\n${String(specText).slice(0, 24000)}\n\n${factsText(facts)}\n\nRequirements: ${reqs.map((r) => `${r.id}: ${r.text}`).join('; ')}`;
  const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: session.abort?.signal || new AbortController().signal, emit: () => {}, deps: session.deps, state: {} });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('no JSON list in the reply');
  let list; try { list = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error('the reply was not valid JSON'); }
  let n = 0;
  for (const c of Array.isArray(list) ? list : []) {
    const r = reqs.find((x) => x.id === c?.id);
    if (!r || !['browser', 'http'].includes(c.kind)) continue;
    if (!String(c.expect || '').trim() && !String(c.expect_url || '').trim() && !String(c.forbid || '').trim() && !c.expect_status) continue;
    if (c.kind === 'browser' && !(Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'))) continue;
    if (c.kind === 'http' && !/^http:\/\/localhost:\d+\//.test(String(c.url || ''))) continue;
    r.qaNeg = r.qaNeg || [];
    if (r.qaNeg.length >= 2) continue;
    r.qaNeg.push(c.kind === 'browser'
      ? { kind: 'browser', steps: c.steps.slice(0, 20), expect: String(c.expect || '').slice(0, 200), expect_url: String(c.expect_url || '').slice(0, 100), forbid: String(c.forbid || '').slice(0, 200), why: String(c.why || '').slice(0, 160) }
      : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect || '').slice(0, 200), expect_status: Number(c.expect_status) || 0, forbid: String(c.forbid || '').slice(0, 200), why: String(c.why || '').slice(0, 160) });
    n++;
  }
  session.emit('notice', { message: `Adversarial QA wrote ${n} attack check${n === 1 ? '' : 's'} (wrong input, other users' data, logged-out access).` });
}

async function reviseQaCheck(session, req, dispute, model) {
  const specText = /** @type {any} */ (specRequirements(session.data.projectDir, 'SPEC.md')).doc || '';
  const facts = specFacts(specText);
  const system = 'You are the independent QA engineer who wrote this acceptance check. The developer disputes it. You have NOT seen the code and you do not trust the developer: change the check only if it contradicts the specification (an account, route, test id, label or text the specification does not name, or a wrong order of steps). Never weaken it to accept behaviour the specification does not describe. Reply with JSON only: {"decision":"keep"|"revise","reason":"...","check":{...same shape as before...}}.';
  const prompt = `Specification:\n${String(specText).slice(0, 20000)}\n\n${factsText(facts)}\n\nRequirement ${req.id}: ${req.text}\nYour check: ${JSON.stringify(req.qa)}\nLast result: ${req.evidence?.summary || 'not run'}\nDeveloper's dispute: ${dispute}`;
  const res = await providers.callModel({ model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [], effort: 'low', signal: session.abort?.signal || new AbortController().signal, emit: () => {}, deps: session.deps, state: {} });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  let out; try { out = JSON.parse(text.slice(a, b + 1)); } catch { throw new Error('the QA reply was not valid JSON'); }
  req.qaRevised = true;
  const c = out.check || {};
  const valid = out.decision === 'revise' && ['browser', 'http'].includes(c.kind) && String(c.expect || '').trim()
    && (c.kind === 'http' ? /^http:\/\/localhost:\d+\//.test(String(c.url || '')) : Array.isArray(c.steps) && c.steps.length && c.steps.every((st) => st && typeof st.action === 'string'));
  if (valid) req.qa = c.kind === 'browser' ? { kind: 'browser', steps: c.steps.slice(0, 25), expect: String(c.expect).slice(0, 200) } : { kind: 'http', url: c.url, method: c.method || 'GET', body: c.body, expect: String(c.expect).slice(0, 200) };
  session.emit('notice', { message: `QA agent ${valid ? 'revised' : 'kept'} its check for ${req.id}: ${String(out.reason || '').slice(0, 160)}` });
  session.save();
  return valid ? `revised (${String(out.reason || '').slice(0, 200)})` : `kept the check (${String(out.reason || 'it matches the specification').slice(0, 200)})`;
}

// ---------- evidence: run a requirement check and record the real result ----------
async function runCheckRequirement(session, u, meta, ctx, run) {
  const finish = (text, ok) => {
    meta.status = ok ? 'done' : 'error'; meta.output = text;
    session.emit('tool-end', { id: u.id, ok, output: text });
    return { type: 'tool_result', tool_use_id: u.id, content: text, ...(ok ? {} : { is_error: true }) };
  };
  const reqs = session.data.requirements || [];
  const req = reqs.find((r) => r.id === String(u.input.id || '').trim());
  if (!req) return finish(`Unknown requirement "${u.input.id}". Requirements: ${reqs.map((r) => r.id).join(', ') || 'none'}.`, false);
  if (isPlanMode(session.data.mode) || isReviewMode(session.data.mode)) return finish('Checks run commands and a browser, which this read-only mode does not allow.', false);
  // The independent QA check (with its adversarial checks), when one exists, is the only check that can verify the requirement.
  const useQa = !!req.qa && (u.input.use_qa === true || !u.input.kind);
  const dispute = useQa ? String(u.input.dispute || '').trim() : '';
  const { dispute: _d, ...asked } = u.input;
  if (dispute) {
    if (req.qaRevised) return finish(`The QA check for ${req.id} was already revised once. Make the app match the specification so this check passes.`, false);
    const changed = await reviseQaCheck(session, req, dispute.slice(0, 600), run.model).catch((e) => `could not revise: ${String(e.message || e).slice(0, 120)}`);
    return finish(`QA agent reviewed the dispute on ${req.id}: ${changed}. Run check_requirement with use_qa: true again.`, true);
  }
  const checks = useQa
    ? [{ ...req.qa, label: 'main' }, ...(req.qaNeg || []).map((c, i) => ({ ...c, negative: true, label: `attack ${i + 1}: ${c.why || 'misuse'}` }))]
    : [{ ...asked, label: 'own' }];
  if (!checks[0].kind) return finish(`Say how to check ${req.id}: kind command, browser or http${req.qa ? ', or use_qa: true to run its QA check' : ''}.`, false);
  const bad = checks.find((c) => !['command', 'browser', 'http'].includes(c.kind));
  if (bad) return finish('kind must be command, browser or http.', false);

  // A stopped app is not a failed requirement: say so and keep the status.
  const firstUrl = checks.map((c) => (c.kind === 'http' ? c.url : (Array.isArray(c.steps) ? c.steps.find((st) => st && st.url) : null)?.url)).find(Boolean);
  if (firstUrl) {
    const down = await appDown(firstUrl, session.procs.sandbox);
    if (down) {
      run.appDownChecks = (run.appDownChecks || 0) + 1;
      return finish(`Not checked: the app is not running at ${down}. Start it with start_process (and wait until it says it is ready), then run this check again. ${req.id} keeps its status.`, false);
    }
  }

  if (run) run.checkCalls = (run.checkCalls || 0) + 1;
  const results = [];
  for (const c of checks) {
    const r = await runOneCheck(session, c, req.id, ctx, run);
    if (r.refused) return finish(r.refused, false);
    results.push({ ...r, label: c.label, negative: !!c.negative });
    if (!r.passed && !c.negative) break; // the main check failed: attacks add nothing yet
  }
  const passed = results.every((r) => r.passed) && results.length === checks.length;
  const first = results[0];
  // With a QA check, the agent's own check is recorded but cannot verify the requirement.
  req.status = passed && (useQa || !req.qa) ? 'verified' : passed ? 'unverified' : 'failed';
  req.lastCheck = asked; // re-run as is when the code changes later (freshness)
  req.evidence = {
    kind: checks[0].kind, byQa: useQa, check: first.check.slice(0, 200), expect: String(checks[0].expect || '').slice(0, 120), passed,
    summary: (results.find((r) => !r.passed) || first).detail.split('\n')[0].slice(0, 200), at: Date.now(),
    attacks: results.filter((r) => r.negative).map((r) => ({ label: r.label.slice(0, 120), passed: r.passed })),
    // The code this proof belongs to: a later change makes it stale and DROPs re-checks it.
    fingerprint: sourceFingerprint(session.data.projectDir), files: run.editedFiles ? [...run.editedFiles].slice(0, 30) : [],
  };
  session.emit('requirements', { requirements: reqs });
  session.save();
  const lines = results.map((r) => `- ${r.label}: ${r.passed ? 'passed' : 'FAILED'} (${r.check}) ${r.detail.split('\n')[0]}`);
  const failedAttack = results.find((r) => r.negative && !r.passed);
  const note = passed && req.qa && !useQa ? ` Your own check passed, but ${req.id} has an independent QA check: run check_requirement with use_qa: true to verify it.`
    : failedAttack ? ` The app accepted misuse it must refuse (${failedAttack.label}). Fix the app so it refuses it, then run the check again.` : '';
  const body = results.length > 1 ? `\n${lines.join('\n')}` : `: ${first.detail}`;
  // The same requirement failing again: debug it, do not guess.
  let debug = '';
  if (!passed && run) {
    run.reqFails = run.reqFails || new Map();
    run.reqFails.set(req.id, (run.reqFails.get(req.id) || 0) + 1);
    if (run.reqFails.get(req.id) >= 2 && !run.debugMode) { run.debugMode = true; run.debugTestFiles = new Set(); debug = `\n${guards.DEBUG_PROTOCOL}`; session.emit('notice', { message: `${req.id} failed twice: DROPs switched the agent to step-by-step root-cause debugging.` }); }
  }
  return finish(`${req.id} ${req.status === 'verified' ? 'VERIFIED' : 'NOT verified'} (${useQa ? 'QA ' : ''}${checks[0].kind}${(req.qaNeg || []).length && useQa ? ` + ${req.qaNeg.length} adversarial` : ''})${body}${note}${debug}`, passed);
}

/** Runs one check definition. Browser checks use a fresh browser (no leftover login). */
async function runOneCheck(session, c, reqId, ctx, run) {
  const expect = String(c.expect || '').trim(), expectUrl = String(c.expect_url || '').trim(), forbid = String(c.forbid || '').trim();
  let passed = false, detail = '', check = '';
  try {
    if (c.kind === 'command') {
      const cmd = String(c.command || '').trim();
      check = cmd;
      if (!cmd) return { refused: 'kind=command needs a command.' };
      // A command that exercises nothing (echo, true, exit 0) proves nothing.
      if (/^(echo|printf|true|exit\s+0|:|Write-(Host|Output))\b/i.test(cmd) || (!expect && !guards.isVerificationCommand(cmd, run.verify, [...(run.editedFiles || [])]))) {
        return { refused: 'That command does not exercise the requirement. Use a test (npm test -- <name>, a script that calls the code) or add `expect` text that only the working feature prints.' };
      }
      if ((session.procs.sandbox ? shell.assessCommand(cmd, null) : shell.assessCommand(cmd, session.data.projectDir)).dangerous) return { refused: 'Refused: that command is flagged as dangerous.' };
      const r = await shell.run(cmd, { cwd: session.data.projectDir, sandbox: session.procs.sandbox, signal: ctx.signal, timeoutMs: 180000 });
      const out = shell.redact(shell.stripAnsi(r.output || '')).text;
      const found = !expect || out.includes(expect);
      passed = r.code === 0 && found;
      detail = `exit ${r.code}${expect ? `, expected text ${found ? 'found' : 'NOT found'}` : ''}\n${out.trim().slice(-1500)}`;
      if (run.verify && guards.isVerificationCommand(cmd, run.verify, [...(run.editedFiles || [])])) { run.verifiedAfterEdit = true; run.lastVerify = r.code === 0 ? 'pass' : 'fail'; }
    } else if (c.kind === 'browser') {
      const steps = Array.isArray(c.steps) ? c.steps.slice(0, 25) : [];
      check = `${steps.length} browser step(s)`;
      if (!steps.length || (!expect && !expectUrl)) return { refused: 'kind=browser needs steps and `expect` text (or `expect_url`) that the final page must show.' };
      const browser = require('./browser');
      const sb = session.procs.sandbox;
      const key = `${session.data.projectDir}::check::${reqId}::${Date.now()}`;
      let last = null, issue = null;
      try {
        for (const st of steps) {
          last = await /** @type {any} */ (browser).act(key, st, { mapUrl: (x) => (sb ? sb.mapUrl(x) : x), signal: ctx.signal });
          await session.emitFrame(key, `${reqId} check: ${st.action}`);
          // A refusal (401, an error message) is the expected result of an attack, not a broken app.
          if (last.issue && !c.negative) { issue = last.issue; break; }
        }
      } finally { await browser.act(key, { action: 'close' }).catch(() => {}); }
      const text = last?.text || '';
      const url = /URL: (\S+)/.exec(text)?.[1] || '';
      const okText = !expect || text.includes(expect);
      let okUrl = true;
      if (expectUrl) { try { okUrl = new URL(url).pathname.startsWith(expectUrl); } catch { okUrl = false; } }
      const okForbid = !forbid || !text.includes(forbid);
      passed = !issue && okText && okUrl && okForbid;
      detail = issue ? `the browser showed a problem: ${issue}`
        : `${steps.length} step(s) ran;${expect ? ` expected text ${okText ? 'found' : 'NOT found'};` : ''}${expectUrl ? ` page ${okUrl ? 'is' : 'is NOT'} on ${expectUrl} (${url || 'no URL'});` : ''}${forbid ? ` forbidden text ${okForbid ? 'absent' : 'SHOWN'};` : ''}\n${text.slice(0, 1200)}`;
    } else if (c.kind === 'http') {
      const sb = session.procs.sandbox;
      const url = sb ? sb.mapUrl(String(c.url || '')) : String(c.url || '');
      check = `${(c.method || 'GET').toUpperCase()} ${c.url}`;
      const wantStatus = Number(c.expect_status) || 0;
      if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(url) || (!expect && !wantStatus)) return { refused: 'kind=http needs a local URL of the running app (http://localhost:<port>/…) and `expect` text (or `expect_status`).' };
      const res = await fetch(url, { method: (c.method || 'GET').toUpperCase(), headers: c.body ? { 'content-type': 'application/json' } : {}, body: c.body ? (typeof c.body === 'string' ? c.body : JSON.stringify(c.body)) : undefined, redirect: 'manual', signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) });
      const body = await res.text();
      const okText = !expect || body.includes(expect);
      const okStatus = wantStatus ? res.status === wantStatus : (res.ok || (c.negative && res.status >= 300));
      const okForbid = !forbid || !body.includes(forbid);
      passed = okText && okStatus && okForbid;
      detail = `HTTP ${res.status}${wantStatus ? ` (expected ${wantStatus})` : ''}${expect ? `, expected text ${okText ? 'found' : 'NOT found'}` : ''}${forbid ? `, forbidden text ${okForbid ? 'absent' : 'SHOWN'}` : ''}\n${body.slice(0, 1200)}`;
    }
  } catch (e) {
    passed = false; detail = `the check could not run: ${String(e.message || e).split('\n')[0]}`;
  }
  return { passed, detail, check };
}

/**
 * Freshness: a requirement verified on older code is not verified now. When the project's files
 * changed since a proof, DROPs re-runs that check itself (no model call) before the agent may finish.
 */
async function reverifyStale(session, ctx, run) {
  const reqs = session.data.requirements || [];
  const fp = sourceFingerprint(session.data.projectDir);
  const stale = reqs.filter((r) => r.status === 'verified' && r.evidence?.fingerprint && r.evidence.fingerprint !== fp && r.lastCheck);
  if (!stale.length) return 0;
  session.emit('notice', { message: `The code changed after ${stale.length} requirement${stale.length > 1 ? 's were' : ' was'} verified; DROPs is checking ${stale.length > 1 ? 'them' : 'it'} again.` });
  let broken = 0;
  for (const r of stale) {
    r.status = 'stale';
    const res = await runCheckRequirement(session, { id: `refresh-${r.id}-${Date.now()}`, input: { ...r.lastCheck, id: r.id } }, {}, ctx, run).catch(() => null);
    if (r.status !== 'verified') broken++;
    if (res && r.status === 'stale') r.evidence = { ...(r.evidence || {}), summary: String(res.content || '').split('\n')[0].slice(0, 200) };
  }
  session.emit('requirements', { requirements: reqs });
  session.save();
  if (broken) session.emit('notice', { message: `Re-check after the change: ${broken} of ${stale.length} no longer verified.` });
  return broken;
}

module.exports = {
  writeQaChecks,
  writeAdversarialChecks,
  reviseQaCheck,
  runCheckRequirement,
  runOneCheck,
  reverifyStale,
};
