// Minimal git service for the Source Control panel.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function git(root, args, { maxBuffer = 20 * 1024 * 1024, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, '-c', 'core.quotepath=false', ...args], { windowsHide: true, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
    if (input != null) { child.stdin.write(input); child.stdin.end(); }
  });
}

async function status(root) {
  try {
    const out = await git(root, ['status', '--porcelain=v1', '-b', '-uall']);
    const lines = out.split('\n').filter(Boolean);
    const head = lines.shift() || '';
    const m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
    const files = lines.map((l) => {
      const x = l[0], y = l[1];
      let p = l.slice(3);
      if (p.includes(' -> ')) p = p.split(' -> ')[1];
      p = p.replace(/^"|"$/g, '');
      const st = x === '?' ? 'untracked' : (x === 'A' || y === 'A') ? 'added' : (x === 'D' || y === 'D') ? 'deleted' : (x === 'R') ? 'renamed' : 'modified';
      return { path: p, status: st, staged: x !== ' ' && x !== '?' };
    });
    return { isRepo: true, branch: m?.[1] || 'HEAD', upstream: m?.[2] || null, ahead: Number(m?.[3] || 0), behind: Number(m?.[4] || 0), files };
  } catch (e) {
    return { isRepo: false, error: (e.stderr || e.message || '').split('\n')[0] };
  }
}

async function fileVersions(root, rel) {
  let original = '';
  try { original = await git(root, ['show', `HEAD:${rel.replace(/\\/g, '/')}`]); } catch { original = ''; }
  let modified = '';
  try { modified = fs.readFileSync(path.resolve(root, rel), 'utf8'); } catch { modified = ''; }
  return { original, modified };
}

async function diffText(root, limit = 60000) {
  let d = '';
  try { d = await git(root, ['diff', 'HEAD', '--stat', '--patch', '--no-color']); } catch {
    try { d = await git(root, ['diff', '--cached', '--patch', '--no-color']); } catch { d = ''; }
  }
  const st = await status(root);
  const untracked = (st.files || []).filter((f) => f.status === 'untracked').map((f) => f.path);
  if (untracked.length) d += `\n\nNew untracked files:\n${untracked.slice(0, 100).join('\n')}`;
  return d.length > limit ? d.slice(0, limit) + '\n…(diff truncated)' : d;
}

async function commit(root, message) {
  await git(root, ['add', '-A']);
  const out = await git(root, ['commit', '-F', '-'], { input: message });
  return out.trim().split('\n')[0];
}

async function log(root, n = 20) {
  try {
    const out = await git(root, ['log', `-${n}`, '--pretty=format:%h%x09%an%x09%ar%x09%s']);
    return out.split('\n').filter(Boolean).map((l) => { const [hash, author, when, subject] = l.split('\t'); return { hash, author, when, subject }; });
  } catch { return []; }
}

async function init(root) { await git(root, ['init']); return status(root); }

// ---------- worktrees: run several agents in parallel, each on its own branch ----------
async function repoRoot(dir) { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim().replace(/\//g, path.sep); }
async function currentBranch(dir) { return (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); }

// Creates <repo>/../.drops-worktrees/<repo>/<slug> on a new branch drops/<slug>, based on the current branch.
async function worktreeAdd(projectDir, label) {
  const top = await repoRoot(projectDir);
  const head = (await git(top, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim();
  if (!head) throw new Error('The repository has no commits yet. Commit once before creating a worktree.');
  const base = await currentBranch(top);
  const slug = (label || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
  const id = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const dir = path.join(path.dirname(top), '.drops-worktrees', path.basename(top), id);
  const branch = `drops/${id}`;
  await git(top, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  // Same relative sub-folder as the original project, if it was inside the repo.
  const rel = path.relative(top, projectDir);
  return { dir: rel && !rel.startsWith('..') ? path.join(dir, rel) : dir, worktree: dir, branch, base, repo: top };
}

// Commits pending work on the worktree branch, then merges it into the base branch of the main checkout.
async function worktreeMerge(wt, message) {
  const st = await status(wt.worktree);
  if (st.files?.length) { await git(wt.worktree, ['add', '-A']); await git(wt.worktree, ['commit', '-m', message || `DROPs: ${wt.branch}`]); }
  const mainBranch = await currentBranch(wt.repo);
  if (mainBranch !== wt.base) throw new Error(`The main checkout is on "${mainBranch}", not "${wt.base}". Switch it back to "${wt.base}" first.`);
  const dirty = await status(wt.repo);
  if (dirty.files?.length) throw new Error(`The main checkout has uncommitted changes. Commit or stash them before merging.`);
  try { await git(wt.repo, ['merge', '--no-ff', '-m', `Merge ${wt.branch}`, wt.branch]); } catch (e) {
    await git(wt.repo, ['merge', '--abort']).catch(() => {});
    throw new Error(`Merge conflict between ${wt.branch} and ${wt.base}. Resolve it manually (git merge ${wt.branch}) or ask the agent in the worktree to rebase.`);
  }
  return `Merged ${wt.branch} into ${wt.base}.`;
}

async function worktreeRemove(wt, deleteBranch = true) {
  await git(wt.repo, ['worktree', 'remove', '--force', wt.worktree]);
  if (deleteBranch) await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => {});
  return true;
}

module.exports = { status, fileVersions, diffText, commit, log, init, worktreeAdd, worktreeMerge, worktreeRemove, repoRoot };
