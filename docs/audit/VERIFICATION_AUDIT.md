# Phase 5 — Verification Engine Audit (`VERIFICATION_AUDIT.md`)

## Audited Guards (`src/main/guards.js`, `src/main/agent.js`)
1. **Unrelated Command Rejection (`isVerificationCommand`):** Commands like `Get-ChildItem`, `ls`, `echo`, `git status`, `npm install` do NOT clear `verifiedAfterEdit`. (Verified in `tests/guards.test.js`.)
2. **Failed Verification Blocking:** If the last verification command exited non-zero (`lastVerify === 'fail'`), the verification guard blocks completion and returns the agent to fix the cause.
3. **Cross-File Regression Guard (`captureTsBaseline` / `crossFileRegressions`):** Captures pre-existing TypeScript diagnostics for edited files and up to 2-hop importers before editing; blocks finishing if new cross-file errors are introduced while ignoring pre-existing errors and line shifts. (Verified in `tests/guards.test.js`.)
4. **Root-Cause Debug Protocol (`DEBUG_PROTOCOL` / `projectFrames`):** Triggers after 2 failures of the same check, injects up to 5 project stack frames, and nudges for a regression test.
5. **Evidence Check (`check_requirement`):** Requirements-doc tasks are tracked per requirement (`verified` / `stale` / `failed`) via independent test/HTTP/browser checks rather than trusting agent summaries.
6. **Honest Gaps / Limitations:**
   - Cross-file regression guard targets TypeScript/JS via `codegraph.typeCheck`; non-TS languages (Python, Rust, Go) rely on the project's `run.verify` shell commands (e.g., `pytest`, `cargo test`, `go test`).
   - Browser/UI verification (`uiCheckOn`) requires Playwright + an interactive/headed or reachable local server; `desktop.test.js` foreground focus fails in non-interactive headless Windows shells.
