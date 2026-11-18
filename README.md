# DROPs — autonomous coding agent

A desktop coding agent that plans, edits, runs and verifies code in your projects. It works with **Claude**, **Gemini** and **local models (Ollama)**, has a headless CLI for CI, and connects to tools via **MCP**.

```bash
npm install
npm start                # desktop app from source
npm test                 # offline test suite (guards, MCP, security, worktrees, CLI, type-checks)
npm run dist             # Windows installer + zip   (dist:mac / dist:linux on those systems)
node src/cli.js --help   # headless agent for scripts and CI
npm run bench -- --model auto   # benchmark (needs an API key with quota)
```

## Models and cost
- **Auto (cost-optimized):** each request starts on the cheapest tier that fits:
  - quick question → Haiku / Flash Lite
  - normal task → Sonnet / Flash
  - complex task → Opus / Gemini 4

  It **escalates** to a stronger model when a check fails, it loops, or tools keep erroring. Research sub-agents always use the cheapest model.
- **Budgets:** max cost and/or max tokens per task. The agent stops cleanly and you can send "continue".
- **Local models:** any Ollama model with tool support. Private, offline, free.
- **Gemini fallback:** an overloaded or over-quota model hands off to the next one mid-task. Claude uses server-side fallback.

## Reliability guards
| Problem | What DROPs does |
|---|---|
| "Done" without testing | **Verification guard**: after editing, only a real test, build, type-check or lint (or running the edited file) counts, and it must pass, or the agent must prove the failure was already there. |
| Broken code goes unnoticed | **Instant diagnostics** after every edit: JSON, JS and Python syntax, plus **TypeScript type errors (tsc, incremental)**, ruff, `php -l`, `gofmt`. |
| Overwriting unseen changes | Read-before-write, and stale-file protection. |
| Loops | **Loop guard** catches identical repeats *and* repeated failures with varied arguments (same file, same command family). Real progress resets it. |
| Long sessions lose track | Auto-compaction into a structured handoff. Full history stays visible. |
| Context bloat | Parallel **sub-agents** with their own context. |

## Safety
- **4 permission modes** (Plan, Ask, Auto-edit, Full auto). Destructive commands always ask, and so do commands that write outside the project or send secrets over the network.
- **Docker sandbox** (optional): shell commands and dev servers run in a container with only the project mounted. Network can be turned off.
- **Secret shield**: API keys, tokens, private keys and JWTs in tool output are masked before they reach the model or the UI.
- Keys are stored with the OS key store (DPAPI on Windows).

## Tools and integrations
- **Code Intelligence & Editing:** True **LSP client** (`lsp_query` for TypeScript, Python, Go, Rust), semantic `rename_symbol`, `impact`, `type_check`, and atomic multi-file **`apply_patch`** alongside `edit_file` / `multi_edit`.
- **Interactive Browser & IDE:** Shared **Playwright Interactive Browser** (user + AI control the same tab with live frame sync, URL bar, Back/Forward/Refresh), **Monaco editor** with inline `Ctrl+K` AI edit, and embedded terminal.
- **Orchestration:** Scoped `task` sub-agents, `swarm` shared message board, `run_workflow` staged pipelines, and `AsyncTaskQueue` background runner.
- **MCP servers** (stdio and HTTP/SSE), using the same JSON format as Claude Desktop and VS Code. Optional project `.mcp.json`. Per-server trust.
- **Git:** source control panel, AI-written commit messages, and **worktrees**: run several agents in parallel, each on its own branch, then merge with one click.
- **Headless CLI & GitHub PR Agent:** `src/cli.js` with `--json`, `--jsonl` real-time event streaming, `--save` / `--resume <file>`, and exit codes for CI. See `.github/workflows/drops-agent.yml` for automated issue-to-PR workflows.

## Team and learning
- Nested `AGENTS.md` hierarchy (`~/.drops/AGENTS.md` → root `DROPs.md` / `AGENTS.md` / `CLAUDE.md` / `.cursorrules` → subfolder `**/AGENTS.md`), plus team rules in `.drops/rules/*.md`.
- Share a session as an **HTML review report** or a **.drops.json** file that teammates can import.
- **Explanations language** (বাংলা, Hindi and more) and **Teaching mode**, which explains each change and the concept behind it.

## Platforms
Windows (tested, NSIS installer + Portable `.exe`), macOS & Linux (`electron-builder` + cross-platform Desktop Use backends in `src/main/desktop.js`, verified via `.github/workflows/ci.yml`).

## Benchmark
`bench/` holds 12 tasks (bug fixes, features, refactor, diagnosis; JS and Python) plus `--jsonl-dataset` (SWE-bench/Terminal-Bench format) and `--report <out.md>` scorecard generation. Each task has **hidden tests** copied in only for grading, so an agent can't pass by editing tests.

### Verified Live Scorecards (`effort: medium`)
| Model (via OpenRouter) | Pass Rate | Avg Time | Total Tokens (In / Out) | Total Cost |
|---|---:|---:|---:|---:|
| `anthropic/claude-haiku-5.5` | **11/12 (91.7%)** | **27s/task** | 1,605,221 / 42,795 | **$0.182** |
| `deepseek/deepseek-v4-flash` | **11/12 (91.7%)** | 42s/task | 1,747,516 / 41,398 | ~$0.165 (est.) |

## Code layout
- `src/main/agent.js`, `agent-defs.js`, `agent-instructions.js`: agent loop, tool schemas, nested `AGENTS.md` hierarchy
- `src/main/lsp.js`, `codegraph.js`: JSON-RPC stdio LSP client & project symbol graph
- `src/main/providers.js`, `gemini.js`, `oai.js`, `ollama.js`: model providers, Auto routing, OpenRouter cost tracking
- `src/main/tools.js`, `shell.js`, `guards.js`: tools (`apply_patch`, etc.), shell, sandbox, security, prefix approvals
- `src/main/async-runner.js`, `mcp.js`, `git.js`, `context.js`, `report.js`: async job queue, MCP client, git/worktrees, repo map, exports
- `src/cli.js`: headless CLI (`--jsonl`, `--resume`) · `bench/`: benchmark + SWE-bench adapter · `tests/`: test suite
- `src/renderer/`: UI (Monaco `Ctrl+K`, Interactive Browser, Terminal, Plan Cards)
