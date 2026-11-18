# Phase 12 — Independent Break-the-Fix Audit (`PHASE12_INDEPENDENT_AUDIT.md`)

- **Baseline Commit Audited:** `63d7361` (`main`)
- **Methodology:** Adversarial source inspection of `git diff c94d789..63d7361`, independent shell/secret-shield/IPC break probes, 100-worker stress, and 1,000-turn endurance execution.

## Summary of Findings by Classification

### CONFIRMED
1. **[HIGH] Shell Write-Outside-Root Bypasses (`src/main/shell.js`):**
   - PowerShell aliases (`sc`, `ni`, `ac`, `tee`) and Unix/POSIX file writers (`dd of=...`, `wget -O...`) are absent from `WRITE_VERB`.
   - Windows/POSIX env-var home/profile paths (`$env:USERPROFILE\...`, `%APPDATA%\...`) are missed by `writesOutsideRoot()`.
   - Interpreter file writes outside project root (`node -e "require('fs').writeFileSync('../evil.txt','x')"`, `python -c "open('../evil.txt','w').write('x')"`) return `dangerous: false`.
2. **[MEDIUM — PHASE 11 REGRESSION] False-Positive Redaction on English Prose (`src/main/shell.js`):**
   - Phase 11's `[/\b(Basic\s+)([A-Za-z0-9+/=]{12,})/gi, 'basic-auth']` corrupts normal prose: `"Basic authentication is required"` -> `"Basic [REDACTED basic-auth] is required"`.
3. **[MEDIUM] Secret Shield Gaps (`src/main/shell.js`):**
   - URL query secrets (`?api_key=...&token=...`) and single-line JSON keys (`{"apiKey": "my_json_secret_value_12345"}`) return `count: 0` (unmasked).
4. **[MEDIUM] IPC Subframe Trust Gap (`src/main/main.js`):**
   - `handle()` checks `e.sender === win?.webContents` and `url.startsWith('file://')`, which does not reject a subframe (`e.senderFrame !== win?.webContents.mainFrame`) if an iframe ever loaded a `file://` document.

### SUSPECTED (Not Directly Exploited)
- Trailing-whitespace/NTFS alternate data streams (`file.txt:zone`) on Windows `fs:openPath` — `resolveInRoot` allows colons only in drive prefix, though `:stream` inside a relative path could behave differently across Windows APIs.

### NOT TESTED
- Live funded cloud API runs & competitive benchmarks (invalid `GEMINI_API_KEY`, OpenRouter quota exhausted, slow CPU-split Ollama).
- Interactive Windows foreground focus (`tests/desktop.test.js` lines 46 & 134).
- Live Electron subframe IPC attack inside a running Chromium window.
