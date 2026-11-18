# Phase 7 — Hardening Changelog (`HARDENING_CHANGELOG.md`)

## Patches Applied After Phase 2–3 Forensic Findings
1. **Dangling Symlink Escape Fix (`src/main/tools.js`, `realish()`):**
   - On `ENOENT`/`ENOTDIR` from `fs.realpathSync.native(cur)`, `realish()` now checks `fs.lstatSync(cur).isSymbolicLink()`, reads `fs.readlinkSync(cur)`, resolves the target relative to `path.dirname(cur)`, and recurses with a cycle guard (`seen`).
   - **Regression Test:** `C17 Symlink Escape` in `tests/security-attack-suite.test.js` (dangling symlink `dangling.txt` -> `../outside/nonexistent-target.txt` throws `/through a link/`).
2. **Relative Traversal & Home-Dir Shell Write Detection (`src/main/shell.js`, `writesOutsideRoot()`):**
   - Added `/(?:^|[\s"'=(])(?:\.\.[\\/]|~[\\/])/` check when `WRITE_VERB.test(cmd)` is true, flagging `rm -f ../../outside.txt`, `del ..\..\outside.txt`, `Set-Content ~/.bashrc evil`, and `cp a.txt ~/outside.txt` as `dangerous: true`.
   - **Regression Test:** `C14 Dangerous Shell` in `tests/security-attack-suite.test.js`.
3. **Opaque `Authorization: Bearer` Secret Redaction (`src/main/shell.js`, `SECRET_CONTEXT`):**
   - Added `/\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})\b/gi` (`bearer-token`) to `SECRET_CONTEXT`.
   - **Regression Test:** `C13 Secret Shield` in `tests/security-attack-suite.test.js`.
4. **IPC Sender Validation & `fs:openPath` Executable Guard (`src/main/main.js`):**
   - `handle()` now validates `e.sender === win?.webContents` and `file://` frame origin.
   - `fs:openPath` redirects executable extensions (`EXEC_EXT`) to `shell.showItemInFolder()` instead of `shell.openPath()`.
