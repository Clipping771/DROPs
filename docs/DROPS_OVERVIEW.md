# DROPs — complete feature overview (for a weakness review)

DROPs (formerly "H2O") is an autonomous AI coding agent for Windows: an **Electron desktop app** plus a **headless CLI**. You describe a task in plain words, and the agent plans it, edits files, runs commands, tests, checks web apps in a real browser, and reports what it did. It is also the build engine of a separate product, the "AI Software Company" platform, which turns a client's requirements into a working web app.

- Repository: https://github.com/Clipping771/DROPs (code in `src/`, tests in `tests/`)
- Stack: Node.js 22, Electron 45, plain JavaScript (no frontend framework), Monaco editor, marked + DOMPurify, playwright-core, the MCP SDK, and the Anthropic / Google GenAI / OpenAI SDKs.
- Size: about 4,300 lines of main-process code (`src/main`), about 4,300 lines of UI code (`src/renderer`), 81 automated tests (`npm test`), and 9 UI tests that drive the real app window (`npm run test:ui`).

---

## 1. Architecture

```
Electron main process (src/main)
  main.js        windows, IPC handlers (~45), theme, app data folder
  agent.js       the agent loop: model call → tool calls → guards → final answer
  tools.js       tool definitions and execution, background processes, file safety
  providers.js   model routing: Anthropic, Gemini, OpenAI-compatible, Ollama; fallback chain
  gemini.js / oai.js / ollama.js   provider adapters (streaming, tool calls, fallbacks)
  shell.js       shell execution, Docker sandbox, dangerous-command checks, secret redaction
  browser.js     real headless browser (playwright-core + installed Chrome/Edge)
  guards.js      loop guard, verification detection, UI-file detection
  lessons.js     cross-session lessons learned from mistakes
  context.js     project profile (stack, verify commands), context helpers
  mcp.js         MCP client (stdio, HTTP, SSE servers)
  git.js         git status/log/commit, worktrees
  store.js       settings (keys encrypted with OS safeStorage/DPAPI) and sessions on disk
  media.js       images and PDF reading
  report.js      session export (Markdown / HTML / JSON)
  brand.js       product name, data folders, backward compatibility with the H2O names
Renderer (src/renderer): app.js (chat, tool cards), panels.js (sidebar, inspector,
  settings, palette), editor.js (Monaco), boot.js (wiring), styles.css (design system)
CLI (src/cli.js): runs one task headless, used by CI and by the Software Factory
```

## 2. Models and providers
- **Anthropic Claude** (Haiku / Sonnet / Opus tiers), **Google Gemini** (several Flash models, Gemini 4), and the **OpenAI-compatible providers** OpenAI, DeepSeek, Mistral, Groq, xAI, OpenRouter, Together, Fireworks, Cerebras, LM Studio and a custom endpoint. **Ollama** runs local models offline.
- **Auto routing** (`model: auto`) starts on the cheapest tier that fits the request and escalates when the agent struggles (repeated tool errors, failed verification).
- **Effort levels:** low, medium, high, xhigh, max.
- **Gemini fallback** moves between Gemini models on quota or overload, with waits for per-minute limits.
- **Cross-provider fallback chain** (`--fallback` / `DROPS_FALLBACK_MODELS`): when a model is out of quota or credit, or unreachable, the next model answers. Exhausted models are skipped for a while.
- **Cheap sub-agents:** research sub-tasks can use a cheaper model.
- **Cost tracking** per session (tokens, cache, dollars where the price is known), with optional per-task cost and token budgets.

## 3. The agent loop and its tools
The tools are:
- **Files:** `read_file` (text, images, PDF pages), `write_file`, `edit_file`, `multi_edit`, `list_dir`, `glob`, `grep`.
- **Commands:** `shell` (PowerShell on Windows, or bash in the sandbox), `start_process` / `process_output` / `stop_process` for dev servers.
- **Web:** `web_search` (Gemini grounding or a keyless search), `fetch_url` (page as text), and `browser` (see §5).
- **Planning and memory:**
  - `todo_write` (a live task plan in the UI);
  - `remember` (project facts saved to `DROPs.md`);
  - `learn_lesson` (cross-project lessons);
  - `ask_user` (asks a question mid-task);
  - `task` (a sub-agent in research or edit mode, queued so they do not collide).
- **MCP tools** from any configured MCP server appear as `mcp__<server>__<tool>`.

How edits work:
- **Instant diagnostics after every edit:** a syntax check for JS/TS and JSON validation. Errors are fed straight back to the agent.
- **A checkpoint before every change:** the session can be rewound, or a single file reverted.
- **Read-before-write protection:** the agent cannot overwrite a file it has not read in this session.
- **Optional after-edit hook** (`afterEditCommand`, e.g. a formatter or linter).

**Steering:** messages typed while the agent works are delivered at the next step as "[User steering]" and take priority.

**Context management:** automatic compaction into a summary near the limit, plus a manual `/compact`.

## 4. Guards ("no fake done")
Each guard sends the agent back with a specific instruction when it tries to finish too early.

| Guard | Triggers when |
|---|---|
| Verification guard | Files changed but no real check (tests, build or type-check) ran after the last edit, or the last check failed, or edited files still have syntax/type errors |
| Completion guard | The final answer itself admits work remains ("ready for the remaining features…"). This is a phrase list. |
| Task-plan check | Items in the agent's own plan are still unfinished |
| Completion audit | A separate, tool-less reviewer call compares the task, the documents it names and the project's file map with the final answer, and lists what is missing. It is on by default in yolo/headless mode. |
| UI check | The agent changed web pages (`.tsx/.jsx/.vue/.html/.css`…) but never opened them in the browser |
| UI-issue check | The browser showed a problem (a click or submit that changed nothing, console errors, failed requests, missing page code), and no later working interaction cleared it. Re-opening the page does not count. |
| Loop guard | The same failing edit or command is repeated, or the agent ping-pongs between edits |
| Report nudge | The agent finished without writing anything to the user |

There is also a **spec plan note**: when the task names a requirements document (a SPEC.md with FR-n rows and journeys), the agent receives the full checklist up front and is asked to plan every item.

## 5. Real browser
- A headless Chrome or Edge, already installed on the machine, is driven by playwright-core. No browser download is needed.
- Actions: open, click, fill, select, check, press, wait, back, read, screenshot and close, plus a phone width (`width: 375`).
- Each result reports:
  - URL and HTTP status;
  - on-screen messages;
  - console errors, failed requests, and JS/CSS that failed to load;
  - clicks that changed nothing;
  - sideways scrolling;
  - interactive elements, with `data-testid` where present;
  - the visible text.
- Targets are given as visible text or a label ("Save", "Email"), `testid=…`, or CSS. Buttons are preferred over links, and links over plain text.
- Works with the Docker sandbox: dev-server ports (3000, 3001, 4173, 4321, 5000, 5173, 8000, 8080) are published to random localhost ports, and `localhost:<port>` is rewritten automatically.
- Screenshots appear in the chat inside the tool card. Clicking one enlarges it.
- The browser stays open per project (logins carry over) and closes after 10 idle minutes.

## 6. Safety
- **Permission modes:**
  - Plan: read-only plan.
  - Review: read-only.
  - Ask: asks before changes and commands.
  - Auto-edit: edits freely, asks for commands.
  - Full auto ("yolo"): asks for nothing.
- **Approvals:** dangerous commands always ask, even in yolo. Allow and deny rules can be set per command pattern.
- Sensitive files (credentials, keys, git hooks) are protected. Writes outside the project root are detected.
- **Secret shield:** keys and tokens in tool output are masked before the model sees them.
- **Docker sandbox (optional):** commands run in a container with the project mounted. Network can be on or off.
- **Network approval per host** for `fetch_url`, the `browser` and `web_search` (automatic in yolo).
- API keys are stored encrypted with OS safeStorage (DPAPI on Windows). Keys from the environment (`DROPS_*` / `H2O_*`) override saved ones in the CLI.

## 7. Memory and learning
- **Project memory:** `DROPs.md` (or the older `H2O.md`), `AGENTS.md`, `CLAUDE.md`, `.drops/instructions.md`, and team rules in `.drops/rules/*.md`. All are loaded into every session.
- **Lessons:** the agent records short rules from its mistakes, and some are recorded automatically when a guard fires or a command is missing. Near-duplicates are merged. Up to 60 lessons are kept and injected into the system prompt.

## 8. Desktop app (UI)
- **Home:**
  - greeting;
  - "Continue where you left off";
  - project stats (sessions, this week, spend, git changes);
  - four quick-start actions;
  - other projects.
- **Sidebar:** every project with its sessions (collapsible, with counts and a "+" for a new session in that project), search, rename and delete. There is also a file explorer with search, and source control (status, diff, AI-written commit messages, commit).
- **Chat:**
  - Markdown with code highlighting;
  - collapsible tool cards with live output, diffs and screenshots;
  - thinking blocks, steering, image attachments (paste or drop), and permission prompts inline.
- **Right panel:**
  - Overview: environment (machine or sandbox, folder, branch, model, mode), context meter, usage, and outputs (files changed with +/−), plus the task plan;
  - Changes: per-file diff and revert;
  - Processes: running dev servers and their output;
  - Usage.
- **Editor:** Monaco with tabs, session diffs, and live reload when the agent edits a file.
- **Navigation:**
  - command palette (Ctrl+K) and keyboard shortcuts;
  - quick buttons for Files, Changes and Processes;
  - dark and light themes, compact density.
- **Slash commands:** `/init /review /test /fix /explain /plan /compact /commit /new /export /report /share /worktree /mcp`, plus custom commands from `.drops/commands/*.md`.
- **Git worktrees:** run a parallel session on its own branch, then merge it back or discard it.
- **Session export:** Markdown, HTML report, or a shareable JSON that can be imported.
- **Settings:** providers and keys (with a test button), Ollama (pull models, test), MCP servers, sandbox, language of explanations (11 languages plus an "explain like a teacher" mode), budgets, command rules and theme.

## 9. Headless CLI
- `node src/cli.js --project <dir> --model <m> [--effort] [--mode] [--sandbox [image]] [--max-cost] [--max-steps] [--fallback m1,m2] [--mcp-config] [--lang] [--json] [--save session.json] "<task>"`
- Used by CI (an example GitHub Action is in `docs/github-action.yml`) and by the Software Factory, which runs DROPs in yolo mode inside Docker.

## 10. Measured results (Software Factory benchmarks, hidden acceptance tests)
| App | Result | Notes |
|---|---|---|
| Booking | 3/3 builds, 96% average, all critical journeys | meets the bar |
| CRM (12 requirements) | 8/11, 10/11, 11/11 → 88% average | one run failed 3 of 4 critical journeys. Baseline before the guards: 6%. |
| Inventory | latest run 9/15 on the smallest free models | below the bar |

These numbers come from free-tier Gemini models that switch as quotas run out, so they are not a single-model measurement.

## 11. Tests
There are 75 automated tests (`npm test`). They cover:
- the guards and the agent loop (with a scripted model);
- MCP (with a test server) and security (dangerous commands, redaction, sensitive files);
- worktrees, the CLI and media;
- lessons, and the browser (real headless runs: a login journey, a dead button, missing page code);
- the fallback chain (two fake servers) and backward compatibility of the rename.

**The UI itself has no automated tests.** It is checked only by screenshots.

---

## 12. Known weaknesses (the author's honest list: start the review here)

**Quality depends on the model**
1. On small or free models the results vary a lot from run to run: 3/11 to 11/11 on the same spec. Guards reduce false "done", but they cannot make a weak model write correct details (wrong value formatting, missing fields).
2. The completion guard is a phrase list (whack-a-mole). The completion audit uses the same model, so a weak model may also audit badly.
3. Lessons are recorded automatically and never reviewed by a person. A wrong lesson stays in every future prompt until it is pushed out. There is no UI to view or delete lessons.

**Browser and UI checking**
4. The UI check runs automatically only in yolo/headless mode, or when the `uiCheck` setting is on. In normal desktop use it is off unless enabled.
5. "Changed nothing" is detected by comparing the URL and the visible text. An action that only changes styling or an input value is not caught, and slow pages can cause false positives.
6. There is no visual comparison (layout or design regressions), no accessibility audit inside the agent, and no multi-tab or file-download handling. OAuth and CAPTCHA flows are impossible by design.
7. Screenshots are stored inside the session JSON as base64, so sessions with many screenshots grow large.

**Safety**
8. Yolo mode runs any command that is not flagged as dangerous. Dangerous-command and secret detection are pattern-based, so new patterns slip through.
9. MCP servers in a project's `.mcp.json` start local commands. A cloned repository could define a malicious server.
10. The Docker sandbox has network access by default, and published ports bind to localhost only. There is no CPU or memory limit for the sandbox container.

**Engineering**
11. The renderer is large vanilla JS (`app.js` and `panels.js` are about 1,000 lines each) with no component structure. UI tests now cover the main screens (see below), but deeper flows such as a full chat turn are not yet tested in the window.
12. The context limit is a single constant (1M tokens) for every model. Compaction quality depends on the model.
13. Cost is unknown for models without a price entry. Free-tier fallbacks mix models silently except for notices.
14. Windows-first: PowerShell versus bash differences, CRLF files, and a Windows-only data folder. macOS and Linux builds exist but are barely tested.
15. There is no auto-update, crash reporting, signed installer or telemetry. Multi-user collaboration is not supported.
16. The backward-compatibility layer for the rename (H2O → DROPs) adds two names for every folder, file and environment variable.

### Fixed after the first review (2026-11-15)
- **#3 Lessons:**
  - A lesson the loop noticed by itself now stays **pending**, out of the prompt, until the same mistake happens again.
  - A lesson the agent writes after fixing its own mistake is active at once.
  - A **"Lessons learned"** window (command palette) lists every lesson with its status and lets you remove it.
- **#9 MCP:**
  - A project's own `.mcp.json` servers start only after you **trust that exact project and configuration**. The review dialog shows the commands it would run.
  - Any change to the file asks again. Servers from your own Settings are unaffected.
- **#10 Sandbox:** containers now have **memory (4 GB), CPU (2) and process (1024) limits**, adjustable with `DROPS_SANDBOX_MEMORY`, `DROPS_SANDBOX_CPUS` and `DROPS_SANDBOX_PIDS`. Network access is still on by default, because installs need it.
- **#12 Context:** the context meters now use **each model's own window** (for example, 16K for a local Ollama model) instead of one constant.
- **README:** the leftover H2O names are fixed.
- **#2 Evidence-based completion** (the review's top recommendation):
  - When a task names a requirements document, DROPs keeps a checklist of every FR.
  - The new `check_requirement` tool lets the agent describe a check, and **DROPs runs it itself**:
    - a test or script (the exit code, plus expected text in the output);
    - browser steps that must end on a page showing the expected text, with no browser problem on the way;
    - an HTTP call to the local app (2xx plus the expected text).
  - Commands that exercise nothing (`echo`, `true`…) are refused, and only the local app can be checked over HTTP.
  - A requirement is **verified only by a passing check**. Its evidence is stored with it: kind, check, expected text, result and time.
  - The **evidence check** guard refuses "done" while requirements lack evidence, and lists them.
  - The Overview panel shows "Requirements N/M verified" with a dot per requirement and its evidence on hover.
  - It can be turned off with the setting `evidenceCheck: false`.
- **Independent QA agent** (fixes the limit above, where the agent chose its own check):
  - Right after the checklist is made, a separate model call with no tools acts as a QA engineer. It sees **only the spec**, never the code, and writes one browser or HTTP check per requirement.
  - When a requirement has a QA check, **only that check can verify it**. The coder's own passing check is recorded as "own check passed" but the requirement stays unverified until `check_requirement` with `use_qa: true` passes.
  - The coder cannot edit the QA check; the evidence guard tells it to fix the app, never the check.
  - Malformed QA checks (no steps, no expected text, a non-local URL) are dropped, and those requirements fall back to the coder's own checks.
  - On by default in yolo/headless mode; setting `qaAgent: true` turns it on everywhere, `false` turns it off.
  - Limit: the QA agent can guess a test id or route the spec does not name. A wrong QA check blocks verification of that requirement, so specs should name their routes and test ids.
- **#11 UI tests:** `npm run test:ui` launches the real Electron app with empty, throwaway data and home folders (and no API keys), then checks: first-run Settings, the home screen, the sidebar (Ctrl+B), every right-panel tab, the Ctrl+K palette, the Lessons window, every Settings section, the theme toggle, and that no page error was logged.

## 13. Questions for the reviewer
1. Which guard would you trust least, and what would a non-phrase-based completion check look like?
2. Is the browser's "issue" signal (no change, console errors, failed requests) the right definition of "broken", and what is missing?
3. Where is the safety model weakest for yolo/headless use? Think of sandbox network, MCP and command patterns.
4. How should lessons be validated before they influence every future session?
5. What would make results on small, free models more consistent: a better plan, test-first generation, or smaller steps?
6. Which UI parts most need tests, and what is the cheapest way to add them to a vanilla-JS Electron renderer?
7. Which missing features matter most compared with Claude Code, Cursor and similar agents?
