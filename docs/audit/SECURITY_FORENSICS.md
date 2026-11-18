# Phase 3 — Security Forensics (`SECURITY_FORENSICS.md`)

## Confirmed Findings & Harmless PoCs (Isolated Temp Directories)

### 1. [HIGH] Dangling Symlink Escape in `tools.resolveInRoot` (`src/main/tools.js`)
- **Root Cause:** `realish(p)` caught `ENOENT` from `fs.realpathSync.native(cur)` and walked up to the parent directory without checking whether `cur` itself was a dangling symlink (`fs.lstatSync(cur).isSymbolicLink()`).
- **PoC (Observed Before Fix):**
  - Created `dangling.txt` in `proj/` pointing to `../outside/nonexistent.txt`.
  - `tools.resolveInRoot(root, 'dangling.txt')` returned `...\proj\dangling.txt` without throwing (`PROBE1_DANGLING_SYMLINK: BYPASSED`).
- **Fix Applied:** `realish()` now checks `fs.lstatSync(cur).isSymbolicLink()` on `ENOENT`/`ENOTDIR`, resolves `fs.readlinkSync(cur)` relative to `path.dirname(cur)`, and recurses with a cycle guard (`seen`).

### 2. [HIGH] Relative Path Traversal & Home-Dir Writes Missed in `shell.writesOutsideRoot` (`src/main/shell.js`)
- **Root Cause:** `writesOutsideRoot(cmd, root)` only matched absolute drive/slash paths (`[A-Za-z]:[\\/]`, `\\`, `/...`) and missed relative parent escapes (`../`, `..\`) and home-dir writes (`~/`).
- **PoC (Observed Before Fix):**
  - `shell.assessCommand('rm -f ../../outside.txt', 'C:\\proj').dangerous` -> `false`
  - `shell.assessCommand('del ..\\..\\outside.txt', 'C:\\proj').dangerous` -> `false`
  - `shell.assessCommand('Set-Content ~/.bashrc evil', 'C:\\proj').dangerous` -> `false`
  - `shell.assessCommand('cp a.txt ~/outside.txt', 'C:\\proj').dangerous` -> `false`
- **Fix Applied:** Added `/(?:^|[\s"'=(])(?:\.\.[\\/]|~[\\/])/` check inside `writesOutsideRoot()`.

### 3. [MEDIUM] Opaque `Authorization: Bearer` Tokens Unmasked in `shell.redact` (`src/main/shell.js`)
- **Root Cause:** `SECRET_PATTERNS` matched JWTs (`eyJ...`) and known key prefixes (`sk-ant-`, `ghp_`, etc.), but opaque Bearer tokens were unmasked.
- **PoC (Observed Before Fix):**
  - `shell.redact('Authorization: Bearer opaque_secret_token_9876543210')` -> `count: 0` (plain text leaked).
- **Fix Applied:** Added `Bearer <token>` pattern to `SECRET_CONTEXT`.

### 4. [MEDIUM] Unvalidated IPC Sender & Executable `fs:openPath` Launch (`src/main/main.js`)
- **Root Cause:**
  1. `handle(ch, fn)` ignored `IpcMainInvokeEvent` without verifying `e.sender === win.webContents` or `file://` frame origin.
  2. `fs:openPath` passed any in-root path directly to `shell.openPath()`, which executes `.exe`/`.bat`/`.cmd`/`.ps1` files on Windows.
- **Fix Applied:**
  1. `handle()` now enforces `e.sender === win?.webContents` and `file://` frame origin.
  2. `fs:openPath` redirects executable extensions (`EXEC_EXT`) to `shell.showItemInFolder()` instead of `shell.openPath()`.
