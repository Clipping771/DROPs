# Phase 0 — Audit Baseline (`AUDIT_BASELINE.md`)

- **Target:** DROPs Agent `2.3.0` (`drops-agent@2.3.0`)
- **Repository Root:** `C:\Innovation\Coding Agent`
- **Branch:** `main`
- **Baseline Commit Hash:** `8989b14304443243dd9b0ca9fa583a7e21890a42` (`8989b14`)
- **Working Tree at Baseline:** Clean (no uncommitted user changes).
- **Runtime Environment:** Windows (`win32`), Node.js `v22.12.0`, Electron `45.3.2`, TypeScript `7.0.2`.

## Dependencies (`package.json`)
- **Production:** `@anthropic-ai/sdk` (`^1.8.0`), `@google/genai` (`^3.3.0`), `@highlightjs/cdn-assets` (`^11.12.0`), `@modelcontextprotocol/sdk` (`^1.32.2`), `diff` (`^9.0.0`), `dompurify` (`^3.4.17`), `fast-glob` (`^3.3.3`), `marked` (`^18.2.0`), `monaco-editor` (`^0.57.0`), `openai` (`^7.57.0`), `pdfjs-dist` (`6.4.299`), `playwright-core` (`1.64.1`).
- **Dev:** `@eslint/js` (`^9.39.5`), `electron` (`^45.3.2`), `electron-builder` (`^26.18.0`), `eslint` (`^9.39.5`), `globals` (`^15.15.0`), `typescript` (`^7.0.2`).

## Baseline Check Status (at `bd51fec` / `8989b14`)
- `npm run lint` (`eslint .`): **0 errors**.
- `node --import ./tests/setup.js --test tests/ui.test.js`: **16 / 16 passed**.
- `node --import ./tests/setup.js --test tests/security-attack-suite.test.js` (`8989b14`): **10 / 10 passed**.
- `npm test` (25 test files at `bd51fec`): **177 passed**, **2 skipped** (POSIX permission tests on Windows), **2 failed** (`tests/desktop.test.js` lines 46 & 134: `SetForegroundWindow` blocked in non-interactive headless shell).
- Live Cloud API Smoke Run: **NOT COMPLETED** (`GEMINI_API_KEY` rejected with HTTP 401; `OPENROUTER_API_KEY` free tier hit daily quota; `ollama:gemma4:31b-cloud` requires paid credits; `ollama:qwen3:4b` ran 56% CPU-split and was cancelled after 10+ minutes).
