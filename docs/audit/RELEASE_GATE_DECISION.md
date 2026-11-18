# Phase 12 — Release Gate Decision (`RELEASE_GATE_DECISION.md`)

## Decision: **B. CONDITIONAL RELEASE** *(pending approval & application of Phase 12 proposed fixes)* — **OR C. BLOCK RELEASE for unattended/untrusted-repo use until the 4 Phase 12 findings are patched**

### Blocking / High-Priority Findings Discovered in Phase 12 (Not Yet Patched, Awaiting User Approval)
1. **[HIGH] Shell Write-Outside-Root Bypasses (`src/main/shell.js`):** PowerShell aliases (`sc`, `ni`, `ac`), `tee`, `dd of=`, `wget -O`, `$env:USERPROFILE\`, `%APPDATA%\`, and interpreter writes (`node -e` `writeFileSync`, `python -c` `open(...,'w')`) to `../` bypass `assessCommand()`.
2. **[MEDIUM — REGRESSION] `Basic` False-Positive Redaction (`src/main/shell.js`):** `Basic authentication` / `Basic implementation` in normal text is wrongly redacted.
3. **[MEDIUM] Secret Shield Gaps (`src/main/shell.js`):** URL query secrets (`?api_key=...&token=...`) and JSON `"apiKey": "..."` are unmasked.
4. **[MEDIUM] IPC Subframe Check (`src/main/main.js`):** `handle()` should enforce `e.senderFrame === win?.webContents.mainFrame`.

### Proposed Fixes (Not Committed/Pushed Per Phase 12 Rules)
1. Narrow `Basic` redaction to `Authorization:\s*Basic\s+...` (or require `=` / non-word-only base64), add URL query secret & JSON `"apiKey"`/`"secret"`/`"token"` redaction.
2. Expand `WRITE_VERB` & `writesOutsideRoot()` for `sc`/`ni`/`ac`/`tee`/`dd of=`/`wget -O`, `$env:`/`%VAR%` paths, and `node -e` / `python -c` file-write traversal.
3. Enforce `e.senderFrame === win?.webContents.mainFrame` in `main.js` `handle()`.
