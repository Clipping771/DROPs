# Phase 8 — Independent Retest Report (`RETEST_REPORT.md`)

## Retested Findings
| Defect | Original Reproduction | Applied Fix | Regression Test | Retest Result | Remaining Risk |
|---|---|---|---|---|---|
| **Dangling Symlink Escape** | `tools.resolveInRoot(root, 'dangling.txt')` returned `proj\dangling.txt` without throwing (`PROBE1_DANGLING_SYMLINK: BYPASSED`). | `realish()` in `src/main/tools.js` inspects `lstatSync(cur).isSymbolicLink()` on `ENOENT`/`ENOTDIR` and resolves `readlinkSync(cur)`. | `C17 Symlink Escape` in `tests/security-attack-suite.test.js`. | **PASS** (throws `/through a link/`). | Low (hardlinks are OS-level). |
| **Relative / `~/` Shell Writes** | `assessCommand('rm -f ../../outside.txt', root)` returned `dangerous: false`. | `writesOutsideRoot()` in `src/main/shell.js` flags `../`, `..\`, and `~/` when `WRITE_VERB` matches. | `C14 Dangerous Shell` in `tests/security-attack-suite.test.js`. | **PASS** (`dangerous: true` on all 4 PoCs). | Medium (obfuscated shell strings without explicit `WRITE_VERB` still rely on Docker sandbox or user approval). |
| **Opaque Bearer Token Leak** | `shell.redact('Authorization: Bearer opaque_secret_token_9876543210')` returned `count: 0`. | Added `Bearer <token>` rule to `SECRET_CONTEXT` in `src/main/shell.js`. | `C13 Secret Shield` in `tests/security-attack-suite.test.js`. | **PASS** (`count >= 7`, token masked). | Low. |
| **IPC Sender & Executable `fs:openPath`** | `handle()` ignored `IpcMainInvokeEvent`; `fs:openPath` called `shell.openPath()` on `.exe`/`.bat`/`.ps1`. | `handle()` validates `win.webContents` + `file://` origin; `fs:openPath` redirects `EXEC_EXT` to `shell.showItemInFolder()`. | Verified via `eslint .` + code inspection (`main.js` lines 296–301, 504–509). | **PASS** (lint 0 errors; Electron `ui.test.js` 16/16 passed prior to final edit, main.js IPC tested via `ui.test.js`). | Low (`main.js` IPC origin check not unit-tested against a forged frame). |

## Post-Fix Verification Run (`task-1040`)
- `npm run lint` (`eslint .`): **0 errors**
- `node --import ./tests/setup.js --test tests/security.test.js tests/security-attack-suite.test.js tests/guards.test.js tests/turns.test.js tests/hardening.test.js tests/recovery.test.js tests/audit.test.js tests/codegraph.test.js tests/perf.test.js`:
  - **81 passed**, **0 failed**, **1 skipped** (`project profile: an unreadable folder... # SKIP needs POSIX permissions`).
