# Phase 12 — 100-Worker & 1,000-Turn Endurance Report (`ENDURANCE_1000_TURN_REPORT.md`)

## 100-Worker Mixed-File Stress (`withFileLocks`, 50 on `shared.js`, 50 on `f-0..9.js`, 10 simulated throws)
- **Completed:** `90` succeeded, `10` threw as injected (`100 / 100` settled)
- **Max Concurrent Same-File (`shared.js`):** `1`
- **Remaining Locks After Finish:** `0`
- **Total Wall Time:** `762.79 ms`

## 1,000 Mocked Sequential Turns (`AgentSession.send`)
- **Turns Completed:** `1,000 / 1,000`
- **Process RSS:** `88.0 MB` (start) -> `129.0 MB` (end)
- **Active Handles:** `1` (start) -> `4` (end)
- **CPU Time:** `12,219 ms` user, `19,078 ms` system
- **Wall Time:** `271,866.2 ms` (~4.5 min)
- **Honest Scope Note:** `compactions` was `0` in this 1,000-turn run because each mocked response reported `input_tokens: 1500 < compactAt (8000)` (in-turn compaction was separately verified in `tests/turns.test.js`). Does not prove 24-hour live LLM stability.
