# Phase 11 — Final Release Decision (`FINAL_RELEASE_DECISION.md`)

## Post-Hardening Verification Summary
- `npm run lint` (`eslint .`): **0 errors**.
- `node --import ./tests/setup.js --test tests/security.test.js tests/security-attack-suite.test.js tests/ui.test.js` (`task-1076`): **36 passed, 0 failed, 0 skipped**.
- Concurrency Expansion (`10`, `25`, `50` workers + cancellation + exception cleanup): **All passed** (`maxConcurrentSameFile = 1`, `remainingLocks = 0`).
- Bounded Endurance (`60` mocked sequential turns): **60 / 60 passed** (`88.2 MB -> 129.2 MB` RSS, `1 -> 4` active handles, `0` errors).

## Release Decision: **C. CONDITIONAL RELEASE**
1. Every confirmed vulnerability from Phases 2–11 (dangling symlink escape, relative/tilde/`curl -o`/`iwr -OutFile` shell writes, opaque `Bearer`/`Basic`/hyphenated-header secret leaks, IPC sender validation, `fs:openPath` trailing-dot/extension guard, and `will-navigate` `file://` restriction) is patched and verified by deterministic regression tests.
2. Unconditional `PRODUCTION READY (E)` is **not claimed** because:
   - Live cloud provider calls and fallback could not be executed (invalid `GEMINI_API_KEY`, OpenRouter daily quota exhausted, local `ollama:qwen3:4b` CPU-split slow).
   - Interactive Windows UIA foreground focus (`tests/desktop.test.js`) requires an unlocked interactive Windows session.
   - Multi-day / 24h endurance under live LLM traffic was not executed.
