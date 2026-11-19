// @ts-check
// Evidence-based completion helpers and spec parsing for AgentSession.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fg = require('fast-glob');
const tools = require('./tools');

/**
 * When the last answer claims the work is done or verified but DROPs proved less than half of the
 * requirements, the note to append to it (or null).
 */
function unprovenClaimNote(messages, ok, total, open = []) {
  if (!total || ok * 2 >= total) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const text = (Array.isArray(last.content) ? last.content : [{ text: String(last.content || '') }]).map((b) => b.text || '').join(' ');
  if (!/\b(production[- ]ready|fully (implemented|working|functional)|all (the )?(requirements|features|functional requirements)\b.{0,40}\b(met|done|addressed|implemented|working)|everything works|verified|works end to end|complete and working)\b/i.test(text)) return null;
  if (/\b(not verified|could not verify|unverified|0 of \d+)\b/i.test(text)) return null;
  return `[DROPs] Not proven: only ${ok} of ${total} requirements passed a check that DROPs ran itself${open.length ? ` (not verified: ${open.slice(0, 12).join(', ')}${open.length > 12 ? ', …' : ''})` : ''}. Treat the claims above as unverified until those checks pass.`;
}

/** A cheap fingerprint of the project's source files (path, size, modified time). Any change, by an
 *  edit tool or by a command, gives a different value. Installed packages and build output are ignored. */
function sourceFingerprint(root) {
  try {
    const entries = fg.sync('**/*', {
      cwd: root, onlyFiles: true, stats: true, dot: true, suppressErrors: true, deep: 12,
      ignore: ['**/node_modules/**', '**/.next/**', '**/.git/**', '**/dist/**', '**/build/**', '**/coverage/**', '**/test-results/**', '**/.drops/**', '**/.h2o/**', '**/*.log', '**/.turbo/**'],
    });
    const h = crypto.createHash('sha1');
    for (const e of entries.sort((x, y) => (x.path < y.path ? -1 : 1)).slice(0, 20000)) h.update(`${e.path}|${e.stats?.size}|${Math.round(e.stats?.mtimeMs || 0)}\n`);
    return h.digest('hex').slice(0, 16);
  } catch { return null; }
}

const verifiedCount = (reqs) => (reqs || []).filter((r) => r.status === 'verified').length;

function evidenceNudgeAllowed(run, reqs) {
  if (!(reqs || []).some((r) => r.status !== 'verified')) return false;
  if ((run.evidenceTotalNudges || 0) >= 8) return false;
  // A nudge that led to a new verified requirement resets the count of fruitless nudges.
  if (run.evidenceNudges && verifiedCount(reqs) > (run.evidenceVerifiedAtNudge ?? -1)) run.evidenceNudges = 0;
  // An agent that has not run a single check gets more nudges (four), each naming where to start.
  return (run.evidenceNudges || 0) < ((run.checkCalls || 0) === 0 ? 4 : 2);
}

/** Facts a QA check must copy exactly: demo accounts, routes, test ids and the app's base URL. */
function specFacts(doc) {
  const text = String(doc || '');
  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [])].slice(0, 12);
  const accounts = emails.map((email) => {
    const i = text.indexOf(email);
    const near = text.slice(i, i + 160);
    // A password is either labelled ("password: x") or the very next quoted token after the email,
    // with letters and digits ("`a@b.test` – `Admin12345`"). An email with no password is not an account.
    const pw = /\b(?:password|pwd)\b(?:\s*(?:[:=]|is)\s*[`"']?|\s*[`"'])([^\s`"'|,;)]{4,40})/i.exec(text.slice(Math.max(0, i - 60), i + 160))
      || /^[`"']?\s*[–:|,/-]\s*[`"']((?=[^\s`"']*\d)(?=[^\s`"']*[a-z])[^\s`"']{6,40})[`"']/i.exec(near.slice(email.length));
    return { email, password: pw ? pw[1] : null };
  }).filter((a) => a.password);
  const routes = [...new Set((text.match(/(?<![\w:/.])\/[a-z0-9][\w\-/[\]:]*/gi) || []).filter((r) => !/\.(md|ts|tsx|js|json|css)$/i.test(r)))].slice(0, 40);
  const testIds = [...new Set([...text.matchAll(/data-testid=["'`]?([\w-]+)|testid=([\w-]+)|`([a-z]+(?:-[a-z0-9]+)+)`/g)].map((m) => m[1] || m[2] || m[3]).filter(Boolean))].slice(0, 80);
  const port = /localhost:(\d{2,5})/.exec(text)?.[1] || '3000';
  return { accounts, routes, testIds, base: `http://localhost:${port}` };
}

function factsText(f) {
  return [
    `Base URL: ${f.base}`,
    `Demo accounts named in the specification: ${f.accounts.length ? f.accounts.map((a) => `${a.email}${a.password ? ` / ${a.password}` : ''}`).join('; ') : 'none (sign up a new account where one is needed)'}`,
    `Routes named: ${f.routes.join(', ') || 'none'}`,
    `Test ids named: ${f.testIds.join(', ') || 'none (use labels and visible text)'}`,
  ].join('\n');
}

/** The app's origin when nothing answers there (connection refused or no reply in 3 s); null when it is up. */
async function appDown(url, sandbox) {
  let target;
  try { target = new URL(sandbox ? sandbox.mapUrl(String(url)) : String(url)); } catch { return null; }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname)) return null;
  try { await fetch(target.origin + '/', { signal: AbortSignal.timeout(3000), redirect: 'manual' }); return null; } catch { return target.origin; }
}

/** The functional requirements of the first requirements document named in the task (>= 4), or []. */
function specRequirements(root, task) {
  const names = [...new Set((String(task).match(/[\w./-]+\.(?:md|txt)\b/gi) || []))].slice(0, 3);
  for (const n of names) {
    let doc;
    try { doc = fs.readFileSync(path.resolve(root, n), 'utf8'); } catch { continue; }
    const fr = [...doc.matchAll(/^\|\s*(FR-\d+)\s*\|\s*([^|\n]+)/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    if (fr.length >= 4) return Object.assign(fr, { doc });
  }
  return [];
}

/** Keeps earlier evidence for requirements that are unchanged; new or reworded ones start unverified. */
function mergeRequirements(old = [], fresh = []) {
  return fresh.map((r) => {
    const prev = old.find((o) => o.id === r.id && o.text === r.text);
    return prev ? prev : { id: r.id, text: r.text, status: 'unverified', evidence: null };
  });
}

const CHECK_REQUIREMENT_DEF = {
  name: 'check_requirement',
  description: 'Prove that one requirement from the spec works. You describe a check; DROPs runs it itself and records VERIFIED or NOT verified from the real result (your own statement is never evidence). Kinds: "command" — a test or script that exercises this requirement (exit code 0, and `expect` text in its output if given); "browser" — browser steps like the browser tool ({action, url|target|value|key}) ending on a page that must show `expect`; "http" — a request to the running app whose response must be 2xx and contain `expect`. Check each requirement after building it; re-check after fixing it.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Requirement id, e.g. FR-3' },
      kind: { type: 'string', enum: ['command', 'browser', 'http'] },
      command: { type: 'string', description: 'kind=command: the test or script to run' },
      steps: { type: 'array', items: { type: 'object' }, description: 'kind=browser: steps, e.g. [{"action":"open","url":"http://localhost:3000/login"},{"action":"fill","target":"Email","value":"a@b.co"},{"action":"click","target":"Log in"}]' },
      url: { type: 'string', description: 'kind=http' },
      method: { type: 'string', description: 'kind=http, default GET' },
      body: { type: 'string', description: 'kind=http, JSON text for POST/PUT' },
      expect: { type: 'string', description: 'Text that must appear in the output / final page / response. Required for browser and http.' },
      use_qa: { type: 'boolean', description: 'Run the independent QA check written for this requirement (when one exists, only it can verify the requirement).' },
      dispute: { type: 'string', description: 'Only with use_qa, once per requirement: say why the QA check itself is wrong (e.g. it logs in with an account the spec does not name, or expects text the spec does not ask for). The QA agent re-reads the spec and decides; it never sees your code.' },
    },
    required: ['id'],
  },
};
tools.registerDef(CHECK_REQUIREMENT_DEF);

function specPlanNote(root, task) {
  const names = [...new Set((String(task).match(/[\w./-]+\.(?:md|txt)\b/gi) || []))].slice(0, 3);
  for (const n of names) {
    let doc;
    try { doc = fs.readFileSync(path.resolve(root, n), 'utf8'); } catch { continue; }
    const reqs = [...doc.matchAll(/^\|\s*((?:FR|NFR)-\d+)\s*\|\s*([^|\n]+)/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    const journeys = [...doc.matchAll(/^\s*[-*]\s*\*{0,2}(J\d+)\*{0,2}[\s:.–-]+(.+)$/gm)].map((m) => ({ id: m[1], text: m[2].trim() }));
    const fr = reqs.filter((r) => r.id.startsWith('FR'));
    if (fr.length < 4) continue;
    const short = (s) => (s.length > 90 ? s.slice(0, 87) + '…' : s);
    const lines = [...fr, ...reqs.filter((r) => r.id.startsWith('NFR')), ...journeys].map((r) => `- ${r.id}: ${short(r.text)}`);
    let body = lines.join('\n');
    if (body.length > 4000) body = body.slice(0, 4000) + '\n- … (see the document for the rest)';
    return `[DROPs plan] ${n} lists ${fr.length} functional requirements${journeys.length ? ` and ${journeys.length} key journeys` : ''}. The task is all of them, not a first part. Before writing code, make a todo_write plan that covers every requirement (group related ones, e.g. "Contacts: FR-3, FR-4, FR-5"), then work through it one item at a time. Each functional requirement counts as done only when check_requirement has VERIFIED it (DROPs runs the check itself; your word is not evidence):\n${body}`;
  }
  return null;
}

/** A phrase in an agent's final answer that admits part of the task is still undone, or null. */
function admitsUnfinished(text) {
  const t = String(text || '');
  const pats = [
    /\b(?:ready for|prepared for|foundation for)\s+the\s+remaining\s+\w+(?:\s+\w+)?/i,
    /\bthe\s+remaining\s+(?:features|requirements|pages|screens|functionality|work|items|parts|endpoints)\b(?!\s+(?:are|were|have been)\s+(?:done|complete|completed|implemented))/i,
    /\b(?:not|n't)\s+(?:yet\s+)?(?:been\s+)?(?:implemented|built|done)\s+yet\b/i,
    /\b(?:still|yet)\s+(?:needs?|has|have)\s+to\s+be\s+(?:implemented|built|added|done)\b/i,
    /\b(?:left|remain(?:s|ing)?)\s+to\s+(?:implement|build|do)\b/i,
    /\b(?:ready|about|going)\s+to\s+(?:proceed|start|begin|move on|continue)\s+(?:with|to|on)?\s*(?:implementing|building|the|adding|work)\b/i,
    /\bI(?:'ll|\s+will)\s+(?:now|next)\s+(?:implement|build|add|proceed|continue|work on)\b/i,
    /\bnext(?:\s+step)?,?\s+I(?:'ll|\s+will)\s+(?:implement|build|add)\b/i,
    /\b(?:will|can)\s+be\s+(?:implemented|added|built)\s+(?:later|next|in a (?:later|future|follow-up))\b/i,
    /\bcan\s+now\s+be\s+(?:layered|added|built|implemented)\b/i,
    /\bI(?:'m|\s+am)\s+(?:now\s+)?(?:proceeding|moving\s+on|continuing|going)\s+(?:to|with)\s+(?:implement|build|add|the)\w*\b/i,
    /\bfurther\s+feature\s+(?:implementation|work|development)\b/i,
    /\b(?:further|additional|remaining)\s+(?:specific\s+)?(?:functional\s+)?(?:logic|development|functionality)\b[^.]{0,60}\b(?:can|will|should|needs?)\b/i,
  ];
  for (const p of pats) { const m = t.match(p); if (m) return m[0].trim(); }
  return null;
}

/** Builds a structured execution ledger (todos, modified files, open requirements, decisions) for compaction handoffs. */
function buildExecutionLedger(data = {}) {
  const lines = [];
  if (data.todos?.length) {
    const counts = { completed: 0, in_progress: 0, pending: 0, blocked: 0 };
    for (const t of data.todos) counts[t.status] = (counts[t.status] || 0) + 1;
    lines.push(`Active task plan (completed=${counts.completed}, in_progress=${counts.in_progress}, pending=${counts.pending}, blocked=${counts.blocked}):\n`
      + data.todos.map((t) => `- [${t.status}] ${t.content}${t.blocker ? ` (blocked: ${t.blocker})` : ''}`).join('\n'));
  }
  const changed = Object.keys(data.changes || {});
  if (changed.length) lines.push('Files modified in this session: ' + changed.join(', '));
  const openReqs = (data.requirements || []).filter((r) => r.status !== 'verified');
  if (openReqs.length) lines.push(`Requirements not verified yet (${openReqs.length} of ${data.requirements.length}): ${openReqs.slice(0, 30).map((r) => r.id).join(', ')}`);
  if (data.decisions?.length) {
    lines.push('Key implementation decisions:\n' + data.decisions.slice(-15).map((d) => `- ${d}`).join('\n'));
  }
  if (data.plan?.goal) lines.push(`A saved implementation plan is pinned in the system prompt (goal: ${data.plan.goal}).`);
  return lines;
}

module.exports = {
  unprovenClaimNote,
  sourceFingerprint,
  verifiedCount,
  evidenceNudgeAllowed,
  specFacts,
  factsText,
  appDown,
  specRequirements,
  mergeRequirements,
  CHECK_REQUIREMENT_DEF,
  specPlanNote,
  admitsUnfinished,
  buildExecutionLedger,
};
