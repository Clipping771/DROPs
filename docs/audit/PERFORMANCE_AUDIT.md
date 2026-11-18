# Phase 6 — Performance & Cost Audit (`PERFORMANCE_AUDIT.md`)

## Measured Benchmarks (Observed in This Session)
- **Repository:** `C:\Innovation\Coding Agent` (`105` indexed source files in `codegraph`).
- **Graph Build (`codegraph.buildGraph(cwd, { cache: false })`):** `135.5 ms`
- **Code Search (`codegraph.searchCode`):** `180.01 ms`
- **Impact Analysis (`codegraph.impactReport`):** `4.42 ms`
- **Node.js Process RSS:** `82.6 MB` (before graph build) -> `98.7 MB` (after graph build, `+16.1 MB`).
- **10-Worker File-Lock Stress (`withFileLocks`):** `110.51 ms` total for 10 concurrent tasks (5 serialized on `shared.js` with 15 ms simulated work each, 5 parallel on disjoint files).
- **Security Attack Suite (`tests/security-attack-suite.test.js`, 10 tests):** `4.36 s` total.

## Not Tested (Environmental / Credential Limits)
- Live cloud provider latency & cost-per-successful-task across Anthropic/Gemini/OpenRouter (**NOT TESTED** — `GEMINI_API_KEY` rejected 401, OpenRouter free tier hit daily quota, Ollama cloud requires paid credits).
- Local `ollama:qwen3:4b` inference latency: observed running `56%/44% CPU/GPU` split (`5.4 GB` RSS) and did not complete within 10 minutes (cancelled).
