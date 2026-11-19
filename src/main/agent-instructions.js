// @ts-check
// Project instruction hierarchy (global ~/.drops/AGENTS.md, root files, nested **/AGENTS.md, team rules)
// and per-project unfinished-work progress tracking.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const brand = require('./brand');
const tools = require('./tools');

const progressFile = (root) => path.join(
  brand.appDataDir(),
  'progress',
  crypto.createHash('sha1').update(path.resolve(root || '').toLowerCase()).digest('hex').slice(0, 16) + '.json'
);

function readProgress(root) {
  try { return JSON.parse(fs.readFileSync(progressFile(root), 'utf8')); } catch { return { sessions: {} }; }
}

/** Records what this session left open (or clears it when nothing is open). */
function writeProgress(root, session) {
  const p = readProgress(root);
  const open = (session.todos || []).filter((t) => t.status !== 'completed').map((t) => t.content);
  const reqs = (session.requirements || []).filter((r) => r.status !== 'verified').map((r) => `${r.id} ${r.text}`.slice(0, 120));
  if (!open.length && !reqs.length) delete p.sessions[session.id];
  else p.sessions[session.id] = { title: session.title, at: Date.now(), open, reqs };
  try { fs.mkdirSync(path.dirname(progressFile(root)), { recursive: true }); fs.writeFileSync(progressFile(root), JSON.stringify(p, null, 2)); } catch { /* best effort */ }
}

/** Other sessions' unfinished work in this project, for the system prompt. */
function progressSection(root, currentId) {
  const items = Object.entries(readProgress(root).sessions).filter(([id]) => id !== currentId).sort((a, b) => b[1].at - a[1].at).slice(0, 4);
  if (!items.length) return '';
  const body = items.map(([, s]) => `- "${s.title}" (${new Date(s.at).toISOString().slice(0, 10)}):${s.open.length ? ` open tasks: ${s.open.slice(0, 8).join('; ')}.` : ''}${s.reqs.length ? ` Requirements not verified: ${s.reqs.slice(0, 8).join('; ')}.` : ''}`).join('\n');
  return `# Unfinished work from earlier sessions in this project\nThis was open when those sessions ended. It may be out of date: check it against the current code before relying on it, and continue it only if the user's request is about it.\n${body}`.slice(0, 2500);
}

function readProjectInstructions(root) {
  const out = [];
  // Global user instructions (~/.drops/AGENTS.md) apply across all projects unless overridden locally.
  try {
    const globalPath = path.join(os.homedir(), '.drops', 'AGENTS.md');
    if (fs.existsSync(globalPath)) {
      const t = fs.readFileSync(globalPath, 'utf8').trim();
      if (t) out.push(`## Global ~/.drops/AGENTS.md\n${t.slice(0, 20000)}`);
    }
  } catch { /* not present */ }
  for (const name of ['DROPs.md', 'H2O.md', 'FORGE.md', 'AGENTS.md', 'CLAUDE.md', '.drops/instructions.md', '.h2o/instructions.md', '.cursorrules']) {
    try {
      const t = fs.readFileSync(path.join(root, name), 'utf8');
      if (t.trim()) out.push(`## From ${name}\n${t.trim().slice(0, 40000)}`);
    } catch { /* not present */ }
  }
  // Nested subfolder AGENTS.md hierarchy (closest/deepest instructions win over parent defaults).
  try {
    const fg = require('fast-glob');
    const nested = fg.sync('**/AGENTS.md', {
      cwd: root,
      ignore: [...(tools.IGNORE || ['node_modules/**', '.git/**']), 'AGENTS.md'],
      onlyFiles: true,
      suppressErrors: true,
    }).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 8);
    for (const rel of nested) {
      const t = fs.readFileSync(path.join(root, rel), 'utf8').trim();
      if (t) out.push(`## Subfolder ${rel}\n${t.slice(0, 6000)}`);
    }
  } catch { /* no nested AGENTS.md */ }
  // Team rules: every .md file in .drops/rules/ (or the older .h2o/rules/), committed to the repo and shared by the team.
  try {
    const dir = brand.PROJECT_DIRS.map((d) => path.join(root, d, 'rules')).find((d) => fs.existsSync(d)) || path.join(root, '.drops', 'rules');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8').trim();
      if (t) out.push(`## Team rule: ${f}\n${t.slice(0, 20000)}`);
    }
  } catch { /* no rules folder */ }
  return out.join('\n\n');
}

module.exports = { progressFile, readProgress, writeProgress, progressSection, readProjectInstructions };
