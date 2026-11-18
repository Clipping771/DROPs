# Phase 11 — Endurance & Live Execution Report (`ENDURANCE_TEST_REPORT.md`)

## Bounded Deterministic Endurance Run (60 Sequential Turns, Mocked Model)
- **Turns Completed:** `60 / 60` (`0` errors, `0` session corruptions)
- **Process RSS:** `88.2 MB` (start) -> `129.2 MB` (end)
- **Active Node Handles:** `1` (start) -> `4` (end)
- **CPU Time:** `1,625.0 ms` user, `1,281.0 ms` system (`17,194.3 ms` wall time)

## Live Execution & Environment Limitations (`NOT TESTED`)
- **Live Cloud Providers:** **NOT TESTED** — `GEMINI_API_KEY` returned HTTP 401 (invalid), `OPENROUTER_API_KEY` free tier hit daily quota, `ollama:gemma4:31b-cloud` requires paid credits.
- **Local Ollama (`ollama:qwen3:4b`):** Ran `56%/44% CPU/GPU` split (`5.4 GB` memory) and did not complete within 10 minutes (cancelled).
- **Interactive Windows Desktop (`tests/desktop.test.js`):** Foreground focus tests (`SetForegroundWindow`) require an unlocked interactive Windows session and cannot pass inside a non-interactive background shell.
