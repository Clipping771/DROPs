// Custom slash commands: Markdown files whose body is a prompt. The file name is the command name
// (`review-pr.md` → `/review-pr`). Optional front matter sets the menu text:
//   ---
//   description: Review the open pull request
//   ---
// `$ARGUMENTS` in the body is replaced by the text typed after the command (done in the renderer).
const fs = require('fs');
const path = require('path');

function parseCommandFile(fileName, text) {
  let body = String(text || '').replace(/^\uFEFF/, '');
  let description = '';
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    description = ((fm[1].match(/^description:\s*(.+)$/m) || [])[1] || '').trim();
    body = body.slice(fm[0].length);
  }
  body = body.trim();
  if (!body) return null;
  if (!description) description = body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
  const name = path.basename(fileName, path.extname(fileName)).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  if (!name) return null;
  return { name, description, prompt: body.slice(0, 20000) };
}

function readCommandDir(dir, source) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')); } catch { return []; }
  return names.slice(0, 200).map((f) => {
    try { const c = parseCommandFile(f, fs.readFileSync(path.join(dir, f), 'utf8')); return c && { ...c, source }; } catch { return null; }
  }).filter(Boolean);
}

// Project commands win over the user's commands of the same name.
function listCommands(projectDir, userDir) {
  const project = projectDir ? require('./brand').PROJECT_DIRS.flatMap((d) => readCommandDir(path.join(projectDir, d, 'commands'), 'project')) : [];
  const user = userDir ? readCommandDir(userDir, 'user') : [];
  const seen = new Set();
  return [...project, ...user].filter((c) => (seen.has(c.name) ? false : seen.add(c.name)));
}

// ---------- skills ----------
// A skill is a folder with SKILL.md (or a single .md file) in .drops/skills, .h2o/skills or .claude/skills
// of the project, or in DROPs' own skills folder. Front matter gives its name and when to use it:
//   ---
//   name: release-notes
//   description: Write release notes from the git log in our house style
//   ---
// The agent sees every skill's name and description, and loads the full instructions with the
// `skill` tool when a task matches. Files next to SKILL.md (templates, scripts) can be read through it.
function parseSkill(text, fallbackName) {
  let body = String(text || '').replace(/^\uFEFF/, '');
  let name = '', description = '';
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fm) {
    name = ((fm[1].match(/^name:\s*(.+)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    description = ((fm[1].match(/^description:\s*(.+)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    body = body.slice(fm[0].length);
  }
  body = body.trim();
  if (!body) return null;
  name = (name || fallbackName || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!name) return null;
  if (!description) description = body.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 160) || name;
  return { name, description: description.slice(0, 300), body: body.slice(0, 40000) };
}

function readSkillDir(dir, source) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.slice(0, 200)) {
    try {
      if (e.isDirectory()) {
        const file = ['SKILL.md', 'skill.md'].map((n) => path.join(dir, e.name, n)).find((p) => fs.existsSync(p));
        if (!file) continue;
        const sk = parseSkill(fs.readFileSync(file, 'utf8'), e.name);
        if (sk) out.push({ ...sk, dir: path.join(dir, e.name), file, source });
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const file = path.join(dir, e.name);
        const sk = parseSkill(fs.readFileSync(file, 'utf8'), path.basename(e.name, '.md'));
        if (sk) out.push({ ...sk, dir, file, source });
      }
    } catch { /* unreadable skill */ }
  }
  return out;
}

/** Project skills win over the user's skills of the same name. */
function listSkills(projectDir, userDir) {
  const dirs = [...require('./brand').PROJECT_DIRS, '.claude'];
  const project = projectDir ? dirs.flatMap((d) => readSkillDir(path.join(projectDir, d, 'skills'), 'project')) : [];
  const user = userDir ? readSkillDir(userDir, 'user') : [];
  const seen = new Set();
  return [...project, ...user].filter((c) => (seen.has(c.name) ? false : seen.add(c.name)));
}

/** A skill's own file (a template, a script) by a path inside its folder. */
function readSkillFile(skill, rel) {
  const p = path.resolve(skill.dir, String(rel || ''));
  if (!p.startsWith(path.resolve(skill.dir) + path.sep)) throw new Error('That file is outside the skill folder.');
  const st = fs.statSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).slice(0, 200).join('\n');
  if (st.size > 400000) throw new Error('That file is too large to read.');
  return fs.readFileSync(p, 'utf8');
}

module.exports = { parseCommandFile, readCommandDir, listCommands, parseSkill, readSkillDir, listSkills, readSkillFile };
