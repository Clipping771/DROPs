# Phase 1 — Complete Architecture Autopsy (`ARCHITECTURE_AUTOPSY.md`)

## 1. Execution & Trust Boundaries
| Layer | Key Files | Trust Boundary & Privileges |
|---|---|---|
| **Main Process** | `src/main/main.js` (743L), `preload.js` (87L) | Full OS access; `BrowserWindow` enforces `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; `will-navigate` & `setWindowOpenHandler` block non-`file:` navigation. |
| **Agent Orchestrator** | `src/main/agent.js` (2201L), `agent-defs.js` (161L), `guards.js` (176L) | Untrusted model outputs (`tool_use`) are validated against schemas (`tools.validate`), checked by `LoopGuard`, gated by permission mode (`plan`, `review`, `code`, `auto-edit`, `yolo`), and verified by `VerificationGuard`, `CrossFileGuard`, `EvidenceCheck`, and `auditCompletion`. |
| **Filesystem & Tools** | `src/main/tools.js` (1142L), `media.js` (70L) | `resolveInRoot(root, p)` canonicalizes paths and rejects escapes; `readFiles` enforces read-before-overwrite and `mtimeMs` freshness. |
| **Shell & Sandbox** | `src/main/shell.js` (238L) | `assessCommand()` classifies dangerous/destructive/exfiltration commands (`always ask`); `redact()` masks secrets; optional Docker `Sandbox` mounts project at `/workspace` with CPU/RAM/PID limits. |
| **Code Intelligence** | `src/main/codegraph.js` (513L), `context.js` (172L) | Disk-persisted `code-index`, reverse dependency graph, cycle detection, AST/TS `LanguageService` or `tsc --noEmit` fallback. |
| **Providers** | `providers.js` (252L), `oai.js` (185L), `gemini.js` (267L), `ollama.js` (214L) | 14+ providers, tier auto-routing (`initialTier`, `resolveAuto`), error escalation, provider fallback, per-task cost/token budgets. |
| **Browser & Desktop** | `browser.js` (348L), `desktop.js` (353L), `desktop-helper.cs` (324L) | Browser blocks non-HTTP(S), private IPs, and cloud metadata (`hostAllowed`); Desktop UIA blocks sensitive input (`sensitiveText`), OS-switching hotkeys (`blockedKeys`), and prompts per app even in `yolo`. |
| **MCP & Hooks** | `mcp.js` (126L), `hooks.js` (110L) | Project `.mcp.json` requires SHA-256 hash-pinned user trust (`isProjectTrusted`); `PreToolUse` / `PostToolUse` hooks can block or annotate calls. |
| **Persistence & Tasks** | `store.js` (462L), `tasks.js` (488L), `schedule.js` (89L), `git.js` (165L) | Session JSON persistence, background task queue, scheduled runs with unattended permission timeout, git worktree isolation, and file/shell rewind. |
| **Renderer** | `src/renderer/` (`app.js`, `panels.js`, `settings-ui.js`, `boot.js`, `editor.js`, `i18n.js`) | Sandboxed renderer; communicates only via `contextBridge` (`window.api` in `preload.js`). |
