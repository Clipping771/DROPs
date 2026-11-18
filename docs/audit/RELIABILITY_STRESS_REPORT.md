# Phase 4 — Reliability & Multi-Agent Stress Report (`RELIABILITY_STRESS_REPORT.md`)

## Measured Stress Tests (Deterministic Harness, Isolated `os.tmpdir()`)
1. **10-Worker Concurrent File-Lock Stress (`withFileLocks`):**
   - 10 concurrent tasks (5 targeting `shared.js`, 5 targeting disjoint `f5.js`–`f9.js`):
   - **Result:** `10/10` completed in `110.51 ms`; `maxConcurrentSameFile = 1` (strict mutual exclusion on `shared.js`, zero overlap).
2. **Lock Release After Exception:**
   - Forced `throw new Error('boom')` inside `withFileLocks` on `err.js`, then immediately re-acquired lock on `err.js`.
   - **Result:** `lockReleasedAfterThrow = true` (no leaked lock / deadlock).
3. **Parallel `mode: 'edit'` Subagent Stale-Read Isolation (`tests/turns.test.js`):**
   - Two parallel `runWorker` subagents read `shared.txt`, Worker 1 writes first, Worker 2 attempts stale overwrite.
   - **Result:** Passed; Worker 2 was blocked (`changed since you read it`) and Worker 1's edit was preserved.
4. **In-Turn Context Compaction (`tests/turns.test.js`):**
   - 45-step single-turn task exceeding `compactAt: 2000` compacted 2+ times mid-turn (`auto-in-turn`).
   - **Result:** Passed; preserved task marker, `todos`, pinned `save_plan`, rewind `msgIndex`, and `tool_use`/`tool_result` pairing.
5. **Not Tested in This Environment:**
   - 24-hour continuous live-API endurance run (**NOT TESTED** — no valid paid cloud API key / fast GPU).
   - 100-session simultaneous Electron UI stress (**NOT TESTED**).
