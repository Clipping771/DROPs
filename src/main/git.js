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
  // This text goes to the AI provider (commit message): keys and passwords in it are masked first, as in
  // every tool output.
  d = require('./shell').redact(d).text;
  return d.length > limit ? d.slice(0, limit) + '\n…(diff truncated)' : d;
}

/** New files that look like secrets (.env, keys, certificates): never committed by the Commit button. */
async function secretUntracked(root) {
  const { isSensitiveFile } = require('./tools');
  const st = await status(root);
  return (st.files || []).filter((f) => f.status === 'untracked' && /(^|\/)(\.env(\.[^/]+)?|\.npmrc|id_rsa|id_ed25519|[^/]*\.(pem|key|pfx|p12))$/i.test(f.path) && isSensitiveFile(f.path)).map((f) => f.path);
}

async function commit(root, message) {
  // "Commit" stages everything; a secret file nobody added before must not slip in with it.
  const secrets = await secretUntracked(root);
  if (secrets.length) {
    throw new Error(`Not committed: ${secrets.slice(0, 5).join(', ')}${secrets.length > 5 ? ', …' : ''} ${secrets.length === 1 ? 'looks like a secret' : 'look like secrets'} (keys or credentials). Add ${secrets.length === 1 ? 'it' : 'them'} to .gitignore, or commit ${secrets.length === 1 ? 'it' : 'them'} yourself with git if that is really intended.`);
  }
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

// ---------- working-folder snapshots (for rewinding what shell commands changed) ----------
// A snapshot is a git tree of every non-ignored file in the folder as it is now. It is built with a
// throwaway index (seeded from the real one, so unchanged files are not re-hashed): the user's staging
// area, branches and history are never touched. Unreferenced objects are cleaned up by git's own gc.
const os = require('os');
function gitEnv(root, args, env, { encoding = 'utf8', maxBuffer = 50 * 1024 * 1024, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', root, '-c', 'core.quotepath=false', ...args], { windowsHide: true, maxBuffer, encoding, timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      resolve(stdout);
    });
  });
}
/** Tree id of the folder's current files, or null when it is not in a git repository (or git fails). */
async function snapshot(root) {
  try {
    const realIndex = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'index'])).trim());
    const tmp = path.join(os.tmpdir(), `drops-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmp);
      const env = { GIT_INDEX_FILE: tmp };
      await gitEnv(root, ['add', '-A', '--', '.'], env, { timeout: 60_000 });
      return (await gitEnv(root, ['write-tree'], env)).trim() || null;
    } finally { fs.rmSync(tmp, { force: true }); }
  } catch { return null; }
}
/** Paths (relative to root) that differ between two snapshots of root. */
async function snapshotDiff(root, a, b) {
  const out = await git(root, ['diff-tree', '-r', '--no-renames', '--relative', '--name-only', '-z', a, b]);
  return out.split('\0').filter(Boolean);
}
const treePath = (rel) => './' + rel.replace(/\\/g, '/');
/** Blob id of rel in a snapshot, or null when the file is not in it. */
async function snapshotBlob(root, tree, rel) {
  try { return (await git(root, ['rev-parse', '--verify', '--quiet', `${tree}:${treePath(rel)}`])).trim() || null; } catch { return null; }
}
/** Blob id the file has now (as git would store it), or null when it does not exist. */
async function currentBlob(root, rel) {
  if (!fs.existsSync(path.join(root, rel))) return null;
  try { return (await git(root, ['hash-object', '--', rel])).trim(); } catch { return null; }
}
/** Puts rel back as it was in the snapshot (deletes it when it was not there). */
async function restoreFromSnapshot(root, tree, rel) {
  const abs = path.join(root, rel);
  const blob = await snapshotBlob(root, tree, rel);
  if (!blob) { fs.rmSync(abs, { force: true }); return 'deleted'; }
  // --filters applies the checkout conversions (line endings, filters), as `git checkout` would.
  const buf = await gitEnv(root, ['cat-file', '--filters', `${tree}:${treePath(rel)}`], {}, { encoding: 'buffer' });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
  return 'restored';
}

module.exports = { snapshot, snapshotDiff, snapshotBlob, currentBlob, restoreFromSnapshot, status, fileVersions, diffText, commit, log, init, worktreeAdd, worktreeMerge, worktreeRemove, repoRoot };
