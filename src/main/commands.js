// Custom slash commands: Markdown files whose body is a prompt. The file name is the command name
// (`review-pr.md` → `/review-pr`). Optional front matter sets the menu text:
//   ---
//   description: Review the open pull request
//   ---
// `$ARGUMENTS` in the body is replaced by the text typed after the command (done in the renderer).
const fs = require('fs');
const path = require('path');

function parseCommandFile(fileName, text) {
  let body = String(text || '').replace(/^﻿/, '');
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

module.exports = { parseCommandFile, readCommandDir, listCommands };
