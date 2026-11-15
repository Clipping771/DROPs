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
- **MCP servers** (stdio and HTTP/SSE), using the same JSON format as Claude Desktop and VS Code. Optional project `.mcp.json`. Per-server trust.
- **Git**: source control panel, AI-written commit messages, and **worktrees**: run several agents in parallel, each on its own branch, then merge with one click.
- Web search and URL fetch, image input, background processes, Monaco editor with diff review.
- **Headless CLI** (`src/cli.js`) with JSON output and exit codes for CI. See `docs/github-action.yml`.

## Team and learning
- Team rules in `.drops/rules/*.md` and project memory in `DROPs.md` (also reads AGENTS.md, CLAUDE.md, .cursorrules, and the older `.h2o/` and `H2O.md` names).
- Share a session as an **HTML review report** or a **.drops.json** file that teammates can import.
- **Explanations language** (বাংলা, Hindi and more) and **Teaching mode**, which explains each change and the concept behind it.

## Platforms
Windows (tested). macOS and Linux builds are configured: the shell switches to bash and macOS gets native title-bar buttons. They have not been tested on those systems yet.

## Benchmark
`bench/` holds 12 tasks (bug fixes, features, refactor, diagnosis; JS and Python). Each task has **hidden tests** that are copied in only for grading, so an agent can't pass by editing tests. `node bench/run.js --baseline` checks that every task starts out failing. Results are saved to `bench/results/` with success rate, time, tokens and cost.

## Code layout
- `src/main/agent.js`: agent loop (routing, guards, sub-agents, MCP, compaction, checkpoints)
- `src/main/providers.js`, `gemini.js`, `ollama.js`: model providers and Auto routing
- `src/main/tools.js`, `shell.js`, `guards.js`: tools, shell, sandbox, security, guards
- `src/main/mcp.js`, `git.js`, `context.js`, `report.js`: MCP client, git and worktrees, repo map, exports
- `src/cli.js`: headless CLI · `bench/`: benchmark · `tests/`: test suite
- `src/renderer/`: UI
