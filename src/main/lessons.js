// Lessons: what DROPs learned from its own mistakes, kept across sessions and projects.
// A lesson is a short, general rule ("in the Docker sandbox `fuser` is missing; use `pkill -f`").
// Lessons come from two places: the agent itself (`learn_lesson` tool, after it hits and fixes a
// mistake) and deterministic events the agent loop sees (a guard firing, a missing command).
// They are loaded into the system prompt of every later session, most useful first.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LESSONS = 60;
const MAX_TEXT = 300;
const PROMPT_BUDGET = 3500; // characters of lessons put into the system prompt

function file() {
  const brand = require('./brand');
  if (brand.env('LESSONS_FILE')) return brand.env('LESSONS_FILE');
  // Test runs never touch the user's real lessons.
  if (process.env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `drops-lessons-test-${process.pid}.json`);
  return path.join(brand.homeDir(), 'lessons.json');
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(data.lessons) ? data.lessons.filter((l) => l && typeof l.text === 'string') : [];
  } catch { return []; }
}

function save(lessons) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, lessons }, null, 2));
  fs.renameSync(tmp, f);
}

/** Words that identify a lesson, so near-duplicates merge instead of piling up. */
function keyOf(text) {
  const stop = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'and', 'or', 'is', 'are', 'it', 'for', 'on', 'with', 'use', 'do', 'not', 'be', 'when', 'before', 'instead', 'that', 'this']);
  return [...new Set(String(text).toLowerCase().replace(/[^a-z0-9_\-\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stop.has(w)))].sort();
}

function similar(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return false;
  let both = 0; for (const w of A) if (B.has(w)) both++;
  return both / Math.min(A.size, B.size) >= 0.7;
}

/** Score for ordering and pruning: lessons seen often and recently matter most. */
const score = (l) => (l.count || 1) * 2 + (l.source === 'agent' ? 1 : 0) + Math.max(0, 30 - (Date.now() - (l.last || 0)) / 86_400_000) / 10;

/**
 * Record a lesson; a near-duplicate bumps the existing one instead. Returns the stored lesson.
 * `source` is 'agent' (the model's own words) or 'auto' (an event the loop detected).
 */
function add(text, source = 'agent', context = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (clean.length < 12) throw new Error('A lesson needs a short, specific sentence (what to do or avoid, and when).');
  const lessons = load();
  const key = keyOf(clean);
  const now = Date.now();
  let hit = lessons.find((l) => similar(keyOf(l.text), key));
  if (hit) {
    hit.count = (hit.count || 1) + 1; hit.last = now;
    // The agent's own wording is usually more specific than an automatic note: prefer it.
    if (source === 'agent' && hit.source === 'auto') { hit.text = clean; hit.source = 'agent'; }
  } else {
    hit = { text: clean, source, context: String(context || '').slice(0, 80), count: 1, first: now, last: now };
    lessons.push(hit);
  }
  lessons.sort((a, b) => score(b) - score(a));
  save(lessons.slice(0, MAX_LESSONS));
  return hit;
}

/**
 * Governance: a lesson the loop inferred by itself (source 'auto') stays pending until the same mistake
 * happens again (count ≥ 2); one the agent wrote after fixing its own mistake is active at once. Pending
 * and removed lessons never reach the prompt, so one odd event cannot steer every future session.
 */
const isActive = (l) => !l.disabled && (l.source === 'agent' || (l.count || 1) >= 2);
function list() { return load().sort((a, b) => score(b) - score(a)).map((l) => ({ ...l, active: isActive(l) })); }
function remove(text) {
  const lessons = load();
  const i = lessons.findIndex((l) => l.text === text);
  if (i >= 0) { lessons.splice(i, 1); save(lessons); }
  return list();
}

/** The lessons section of the system prompt: active lessons only (empty string when there are none). */
function promptSection() {
  const lessons = load().filter(isActive).sort((a, b) => score(b) - score(a));
  if (!lessons.length) return '';
  const lines = [];
  let used = 0;
  for (const l of lessons) {
    const line = `- ${l.text}${(l.count || 1) > 1 ? ` (seen ${l.count}×)` : ''}`;
    if (used + line.length > PROMPT_BUDGET) break;
    lines.push(line); used += line.length;
  }
  return `# Lessons from your past runs\nYou made these mistakes before and learned from them. Apply them; do not repeat the mistakes.\n${lines.join('\n')}`;
}

/** Lessons the loop can infer from a tool result without asking the model. */
function fromToolResult(name, input, output, sandboxed) {
  const out = String(output || '');
  if (!/^(shell|powershell)$/.test(name)) return null;
  const m = out.match(/(?:^|\n)(?:bash: )?(?:line \d+: )?([A-Za-z0-9_.-]+): (?:command )?not found/);
  if (m && !/^(npm|node|npx)$/.test(m[1])) {
    return `\`${m[1]}\` is not installed in the ${sandboxed ? 'Docker sandbox' : 'shell'}; do not rely on it, use a command that exists (or install it first).`;
  }
  return null;
}

module.exports = { file, load, add, list, remove, isActive, promptSection, fromToolResult, keyOf, similar };
