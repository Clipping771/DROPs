# Phase 11 — Concurrency Expansion Report (`CONCURRENCY_EXPANSION_REPORT.md`)

## Deterministic Lock & Cancellation Scaling (`withFileLocks` in `src/main/agent.js`)
Tested in isolated `os.tmpdir()` workspaces (`node` script, 5 ms simulated async work per task, half targeting `hot.js` and half targeting disjoint files):

| Workers | Completed | `maxConcurrentSameFile` | `remainingLocks` After Finish | Wall Time |
|---|---|---|---|---|
| **10** | `10 / 10` | `1` (strictly serialized) | `0` | `81.16 ms` |
| **25** | `25 / 25` | `1` (strictly serialized) | `0` | `187.23 ms` |
| **50** | `50 / 50` | `1` (strictly serialized) | `0` | `372.47 ms` |

- **Cancellation Propagation:** Aborting `AbortController` while waiting on a held lock rejected the waiter immediately (`cancelledCleanly: true`) and left `locksAfterCancel: 0` once the holder finished.
- **Exception Cleanup:** Forced throw inside `withFileLocks` released the lock cleanly (`lockReleasedAfterThrow: true`).
- **Scope Note:** These results prove lock mutual exclusion, cancellation, and cleanup for `AgentSession.withFileLocks` under mocked async workloads; they do not claim 50-worker live LLM throughput.
