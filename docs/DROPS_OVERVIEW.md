# DROPs: every feature, in detail

DROPs (formerly "H2O") is an autonomous AI coding agent. It comes as two things:
- a **Windows desktop app** (Electron);
- a **headless command-line tool**, used by CI and by the "AI Software Company" factory.

You describe a task in plain words, in any language. DROPs then plans it, edits files and runs commands. It also tests the result, opens web apps in a real browser and clicks through them like a user, and **proves** each requirement with a check it runs itself. Finally it reports back in your language, with a short recap and buttons for the next step.

- Repository: https://github.com/Clipping771/DROPs (code in `src/`, tests in `tests/`)
- Stack:
  - Node.js 22 and Electron 45;
  - plain JavaScript (no frontend framework);
  - Monaco editor, marked and DOMPurify;
  - playwright-core;
  - the MCP SDK;
  - the Anthropic, Google GenAI and OpenAI SDKs.
- Size:
  - about 6,000 lines in the main process and about 4,900 lines of UI (JS and CSS);
  - 61 IPC handlers;
  - 123 automated tests (`npm test`) and 13 tests that drive the real app window (`npm run test:ui`).

Updated 2026-11-16.

---

## 1. Models

| Feature | What it does |
|---|---|
| Many providers | **Anthropic Claude** (Haiku, Sonnet, Opus); **Google Gemini** (Flash models, Gemini 4); OpenAI-compatible: **OpenAI, DeepSeek, Mistral, Groq, xAI, OpenRouter, Together, Fireworks, Cerebras**, plus any custom endpoint; **Ollama** and **LM Studio** for local models that run offline and free. |
| Auto routing | With `model: auto`, DROPs starts on the cheapest model that fits the request and moves up when the agent struggles (repeated errors, failed checks). |
| Effort levels | Low, medium, high, xhigh and max: how hard the model thinks. |
| Fallback chain | When a model is out of quota, out of credit or unreachable, the next model in the list answers (`--fallback` or `DROPS_FALLBACK_MODELS`). A model that ran out is skipped for a while. Gemini also moves between its own models by itself. |
| Retry on short outages | Overload, 5xx, network drops and per-minute limits are retried twice (after 2 s and 6 s), only when nothing has been shown yet, so you never see a reply twice. |
| Cheap sub-agents | Research sub-tasks can use a cheaper model. |
| Cost control | Tokens and dollars per session (where the price is known), with an optional maximum cost and maximum tokens per task. |
| Context window per model | The context meter uses each model's own limit (for example 16K for a small local model). |

## 2. The agent and its tools

**Tools the agent can use:**
- **Files:**
  - `read_file` reads text, images and PDF pages;
  - `write_file`, `edit_file` and `multi_edit` change files;
  - `list_dir`, `glob` and `grep` find files and text.
- **Commands:**
  - `shell` runs PowerShell on Windows, or bash in the sandbox;
  - `start_process`, `process_output` and `stop_process` handle dev servers that keep running.
- **Web:**
  - `web_search` searches the web;
  - `fetch_url` reads a page as text;
  - `browser` is a real browser (see §5).
- **Planning and memory:**
  - `todo_write` keeps a live task list;
  - `remember` saves project facts to `DROPs.md`;
  - `learn_lesson` saves a rule learned from a mistake.
- **Talking to you:**
  - `ask_user` asks a question with options in the middle of a task;
  - `wrap_up` fills the next-step box at the end (§7).
- **Sub-agents:** `task` gives a piece of work its own fresh context.
  - In research mode the sub-agent only reads.
  - In edit mode it can change files and run commands, under the same rules as the main agent.
  - Several can run in parallel, each on its own files.
- **Proof:** `check_requirement` (§4).
- **MCP:** tools from any MCP server appear as `mcp__<server>__<tool>`.

**How edits stay safe:**
- An instant syntax check after every edit (JS/TS, JSON); errors go straight back to the agent.
- A checkpoint before every change: rewind a whole turn, or revert one file.
- The agent cannot overwrite a file it has not read in this session.
- An optional after-edit command, for example a formatter.

**Other features:**
- **Context:** the conversation is summarized automatically near the limit, or on demand with `/compact`.
- **Errors:** when a turn fails, the real reason is saved in the conversation ("Stopped by an error: …") and is shown again after a reload. A turn the app never finished says so too. "Stopped by you" appears only when you pressed Stop.

## 3. Guards: no fake "done"

Each guard sends the agent back with a specific instruction when it tries to finish too early.

| Guard | When it fires |
|---|---|
| Verification guard | Files changed, but no real check (tests, build, type-check) ran after the last edit, the last check failed, or syntax errors remain |
| Completion guard | The final answer admits work remains ("ready for the remaining features…") |
| Task-list check | Items on the agent's own task list are unfinished |
| Completion audit | A separate reviewer call compares the task and its documents with the answer and lists what is missing (on by default in full-auto and headless runs) |
| UI check | Web pages changed but were never opened in the browser |
| UI-issue check | The browser showed a problem (a click that changed nothing, console errors, failed requests, missing page code) that no later working step cleared |
| Evidence check | Requirements of the spec have no passing proof (§4). It keeps going while checks make progress, and stops after two fruitless tries in a row (eight in all). |
| Loop guard | The same failing command or edit is repeated, or edits ping-pong |
| Report nudge | The agent finished without writing anything to you |

## 4. Proof of every requirement (evidence engine)

When a task names a requirements document (a `SPEC.md` with FR-n rows):

1. **Checklist.** DROPs lists every requirement up front and asks the agent to plan all of them.
2. **Independent QA agent.**
   - A separate model call, with no tools and without ever seeing the code, writes one browser or HTTP check per requirement from the spec alone.
   - It gets the spec's facts as a list it must copy exactly: demo accounts and passwords, routes, test ids and the app's address. So it never invents a login.
3. **The agent proves each requirement with `check_requirement`.** DROPs runs the check itself:
   - a test or script (exit code, plus expected text);
   - browser steps that must end on a page showing the expected text, with no browser problem along the way;
   - an HTTP call to the local app.
4. **Only the QA check can verify** a requirement that has one. The agent's own passing check counts as "own check passed" and nothing more.
5. **A stopped app is not a failure.** If nothing answers at the app's address, the result is "Not checked: start the app", and the requirement keeps its status.
6. **Dispute, once.** If the agent believes a QA check contradicts the spec, it can dispute it once. The QA agent re-reads the spec (never the code) and keeps or revises the check.
7. **Plain count at the end.** Every spec task ends with "Evidence: N of M requirements verified", listing the ones that are not.
8. **Overview panel:** "Requirements N/M verified", one dot per requirement, and the evidence on hover.

Commands that test nothing (`echo`, `true`…) are refused, and HTTP checks may only call the local app.

## 5. Real browser

- Uses the Chrome or Edge already installed on the machine, driven by playwright-core. Nothing extra is downloaded.
- **Actions:** open, click, fill, select, check, press, wait, back, read and screenshot, plus a phone width (375 px).
- **Each step reports:**
  - the URL and HTTP status, and the messages on screen;
  - console errors, failed requests, and page code that did not load;
  - clicks that changed nothing, and sideways scrolling;
  - the interactive elements (with `data-testid`) and the visible text.
- Requests the page cancels itself (for example Next.js prefetches) are not counted as problems.
- **Targets** can be visible text or a label ("Save", "Email"), `testid=…`, or CSS. Buttons win over links, and links over plain text.
- **With the Docker sandbox,** dev-server ports are published to random local ports and addresses are rewritten automatically.
- **Screenshots** appear inside the tool card; click to enlarge.
- **Sessions:** one browser per project (logins carry over), closed after 10 idle minutes.

## 6. Safety

- **Permission modes:**
  - Plan: read-only, ends with a plan.
  - Review: read-only.
  - Ask: asks before every change and command.
  - Auto-edit: edits freely, asks before commands.
  - Full auto: asks for nothing except dangerous commands.
  - Shift+Tab cycles through the modes.
- **Dangerous commands always ask,** even in full auto. Your own "always allow" and "never run" rules work per command pattern.
- **Protected files:** credentials, keys and git hooks. Writes outside the project are detected.
- **Secret shield:** keys and tokens in command output are masked before the model sees them.
- **Docker sandbox (optional):** commands run in a container with the project mounted.
  - Limits: 4 GB memory, 2 CPUs and 1,024 processes (adjustable).
  - Network can be on or off.
- **Network approval per website** for `fetch_url`, `browser` and `web_search` (automatic in full auto).
- **MCP trust:** a project's own `.mcp.json` servers start only after you trust that exact project and configuration. Any change asks again.
- **API keys** are encrypted with the operating system's protection (DPAPI on Windows). Keys from environment variables override saved ones in the CLI.
- **GitHub:** the agent never asks for, reads or types a token.

## 7. The chat

- **Messages:**
  - Markdown with code highlighting.
  - Your messages and DROPs' answers in any language.
  - Each paragraph takes its own direction, so Arabic, Urdu, Hebrew and Persian read right to left; code stays left to right.
  - Fonts cover every writing system: Bangla, Devanagari, Arabic, Chinese, Japanese, Korean, Thai and more.
- **Answer language: "Auto"** (the default). DROPs answers in the language **and** the writing system of your latest message:
  - Banglish → Banglish, Hindi in Latin letters → the same;
  - Bangla script → Bangla script, Arabic → Arabic.
  - A fixed language can be chosen instead (11 languages), plus a teaching mode that explains each change.
- **Answer style:** the outcome first, short, plain words, no internal mechanics (process ids, pipes) unless you need them.
- **Tool cards:** compact, collapsible steps with live output, diffs, screenshots and **elapsed time** while a tool runs (for example "npm test · 14s").
- **Live task list** under the latest message, updated as the agent works (done, in progress, waiting).
- **Next-step box** at the end of a working turn: a two- or three-sentence recap and, when the next move is yours, one question with up to three buttons. A click sends that answer. It still works after a reload.
- **Under each answer:** time, cost and context used, plus **Copy**, **Retry** and **Fork**.
  - Retry undoes the answer and its file changes, then asks again.
  - Fork starts a new session with this conversation so far.
  - Every message of yours has **Rewind**, which restores the files as they were and puts your message back in the box to edit.
- **Writing while the agent works:**
  - **Enter** queues your message for after the current task.
  - **Alt+Enter** tells the agent now, at its next step.
  - Queued messages show **above the message box** with "Run now" (or "Tell agent now") and Cancel.
  - Queued messages survive an app restart and wait for you; they never start by themselves.
  - If you press Stop before the agent read your message, the text goes back into the box instead of being lost.
- **Other:** thinking blocks, image attachments (paste or drop), approval prompts inside the chat, and questions from the agent with option buttons.
- **Desktop notifications** when a task finishes, asks a question, or needs approval while the app is in the background.

## 8. The app around the chat

- **Home:**
  - a greeting and "Continue where you left off";
  - project numbers (sessions, this week, spend, git changes);
  - four quick starts, and your other projects.
- **Sidebar:**
  - every project with its sessions (collapsible, with counts and a "+" for a new session), plus search, rename and delete;
  - a file explorer with search;
  - source control: status, diffs, AI-written commit messages, commit.
- **Right panel:**
  - **Overview:** environment (this computer or the sandbox, folder, branch, model, mode), context meter, cost, requirements and their evidence, files changed (+/−), and the task plan.
  - **Tasks:** running, queued and past tasks, with progress and Cancel.
  - **Changes:** a diff per file, and revert.
  - **Processes:** running dev servers and their output.
  - **Usage:** tokens and cost.
- **Editor:** Monaco with tabs, session diffs, and live reload when the agent edits a file.
- **Command palette (Ctrl+K):** every command, files and sessions.
- **Keyboard shortcuts:**

  | Keys | Action |
  |---|---|
  | Ctrl+K | Command palette |
  | Ctrl+N | New session |
  | Ctrl+O | Open project |
  | Ctrl+, | Settings |
  | Ctrl+B | Sidebar |
  | Ctrl+J | Right panel |
  | Ctrl+L | Message box |
  | Ctrl+Shift+L | Theme |
  | Shift+Tab | Permission mode |
  | Esc | Stop |
  | Alt+Enter | Tell the working agent now |

- **Slash commands:**

  | Command | What it does |
  |---|---|
  | `/init` | Write the project memory file |
  | `/review` | Review uncommitted changes for bugs |
  | `/test` | Run the tests and fix failures |
  | `/fix` | Build or type-check, and fix every error |
  | `/explain` | Explain how the codebase works |
  | `/plan` | Switch to plan mode |
  | `/compact` | Summarize the conversation now |
  | `/pr` | Branch, commit, push, open a pull request and report its checks (never merges) |
  | `/ci` | Read failing CI checks, fix, push, repeat |
  | `/commit` | AI commit message and commit |
  | `/new` | New session |
  | `/export`, `/report`, `/share` | Markdown, HTML report, shareable session file |
  | `/worktree` | Parallel session on its own git branch |
  | `/mcp` | MCP servers |

  Your own commands can live in `.drops/commands/*.md`. `/pr` and `/ci` need the GitHub CLI (`gh`) installed and signed in.
- **Git worktrees:** run a session on its own branch next to your main work, then merge it back or discard it.
- **Export and import:** Markdown, an HTML review report, or a `.drops.json` file that someone else can import.
- **Lessons window** (command palette): every lesson with its status, each removable.
- **Settings** has nine sections:
  - **General:** default model, effort and mode; open the last project; notifications; send with Enter or Ctrl+Enter.
  - **API keys and providers:** keys with a test button, LM Studio, custom endpoints.
  - **Models and cost:** auto routing, cheap sub-agents, cost and token limits, Ollama (download models, test).
  - **Agent:**
    - verification guard and independent QA agent switches;
    - auto-compact point and maximum steps;
    - after-edit command;
    - answer language and teaching mode;
    - instructions for every session.
  - **Tools and MCP:** MCP servers (JSON) and your own commands.
  - **Safety and sandbox:** always-allow and never-run commands; the Docker sandbox, its image and its network.
  - **Appearance:** theme, text size, conversation width and density.
  - **Keyboard shortcuts.**
  - **About:** version and where your data lives.
- **First run:** with no API key, Settings opens so you can add one. Local models need no key.

## 9. Memory and learning

- **Project memory:**
  - `DROPs.md` (or the older `H2O.md`), `AGENTS.md`, `CLAUDE.md`;
  - `.drops/instructions.md` and team rules in `.drops/rules/*.md`.
  - All of them are loaded into every session.
- **Lessons:**
  - **Active at once:** a lesson the agent writes after fixing its own mistake.
  - **Pending:** a lesson DROPs noticed by itself stays out of the prompt until the same mistake happens again.
  - Near-duplicates are merged, and up to 60 lessons are kept.

## 10. Headless CLI

```
node src/cli.js --project <dir> --model <m> [--effort e] [--mode m] [--sandbox [image]]
  [--max-cost usd] [--max-steps n] [--fallback m1,m2] [--mcp-config file] [--lang code]
  [--json] [--save session.json] "<task>"
```

- Prints every step and notice, ends with the evidence count, and can write the whole session to a file.
- Used by CI (an example GitHub Action is in `docs/github-action.yml`) and by the AI Software Company factory, which runs DROPs in full-auto mode inside Docker.

## 11. Backward compatibility

The old name still works:
- `H2O_*` environment variables (new: `DROPS_*`);
- the `%APPDATA%\H2O` data folder and `~/.h2o`;
- `H2O.md` and `.h2o/` project files.

Nobody loses settings, sessions, lessons or project memory.

## 12. Tests

104 automated tests and 13 real-window UI tests.

**Automated tests** (`npm test`), using scripted fake models and real local servers:
- the guards and the agent loop;
- evidence: spec facts, a stopped app, a disputed QA check, the final count;
- errors and retries, steering and Stop;
- the task queue, including restart;
- MCP and security;
- worktrees, the CLI and media;
- lessons;
- the real browser (journeys, dead buttons, missing page code, cancelled prefetches);
- the fallback chain and the H2O compatibility.

**UI tests** (`npm run test:ui`) launch the real app with throwaway data and no keys, and check:
- first-run Settings and the home screen;
- the sidebar, every panel tab and the palette;
- the lessons window, every Settings section and the theme;
- a full chat turn;
- queue and steer while the agent works;
- the live task list, the next-step box and its buttons, Retry and Fork;
- the `/pr` and `/ci` commands;
- that no page error was logged.

## 13. Measured results

From the AI Software Company factory: hidden acceptance tests that the agent never sees.

| App | Result |
|---|---|
| Booking | 3/3 builds, 96% average, every critical journey: meets the bar |
| Inventory | 98% average (44/45) with DeepSeek Flash, 11 of 12 critical journeys |
| CRM | 79–88% on free Gemini models. The evidence engine now verifies requirements (11 of 12 in the latest run, versus 0 before). A new 3-run benchmark is in progress. |

Free-tier runs mix models as quotas run out, so they are not single-model measurements.

## 14. Engineer features added on 2026-11-16 (evening)

| Feature | What it does |
|---|---|
| **Verification freshness** | Every proof records a fingerprint of the project's source files, the files edited and the check that was run. If the code changed after a requirement was verified, DROPs re-runs that check itself before the agent may finish. "Verified" means verified on the current code. |
| **Adversarial QA** | A second QA call, which never sees the code, writes up to two attacks per requirement from the spec: wrong password, logged-out access, another user's data, a lower role, invalid input, duplicates. Checks can require a final page (`expect_url`), forbid text (`forbid`) or an HTTP status (`expect_status`). A requirement is verified only when its main check **and** every attack pass. Each browser check runs in a fresh browser, so no login leaks between checks. |
| **Root-cause debugging** | A failed command shows where it failed in the project's own code (file:line from Node, TypeScript and Python output). When the same check fails twice, the agent gets an engineer's procedure: reproduce, follow the first project frame, list 2–3 possible causes, test each with evidence, fix the cause, add a regression test, re-run. Finishing without a regression test after such a failure is sent back once. |
| **Codebase intelligence** (`impact` tool) | An import graph of the project (JS/TS with `@/` aliases, Python). For a file: direct and indirect dependents, what it imports, the tests to run, the frontend files calling its API route, import cycles. For a name: where it is defined and used. For a Prisma model: the files using it and related models. The agent runs it before changing anything shared. |
| **Smarter context** | The repository map in the prompt ranks files connected by imports to the task's words, not only files named like them. |
| **Find the breaking change** (`find_breaking_change`) | When a check fails after this request's changes, DROPs puts each changed file back one at a time, runs the check, names the culprit, and restores every file exactly as it was. It also says when the failure was already there. |
| **Safe rewind** | Rewind and Retry undo DROPs' changes but keep a file you edited afterwards, and say which. |
| **Decision and task memory** | `remember` with kind "decision" stores design decisions with their reason. What a session leaves open (tasks, unverified requirements) is kept in DROPs' own data folder and shown to later sessions in the same project, marked as possibly out of date. |
| **Runtime checks** | Every browser step lists the API calls the page made with their status ("POST /api/items → 201"). A `reload` action shows whether saved data survives; QA checks for requirements that save something end with a reload. |
| **Audit** (`audit` tool) | Fixed-rule security and performance audit with file:line: secrets, SQL built from strings, eval, raw HTML, shell commands from request data, open CORS, cookie flags, plain passwords, TLS off, open redirects; database calls in loops (N+1), blocking file calls, unpaginated queries, very large files. Secret values are never printed. |
| **Benchmarks B–E** (factory) | `factory scenario --type debug | change | adversarial | long`: seeded logic bugs with user-style reports; a change request scored on regressions; seeded security holes with no reports; one app built over three sessions. |
| **Desktop app testing** (`app` tool) | Launches an Electron app from the project and uses it like a user: click, type, select, press keys, read the window, take screenshots. Each step reports the window's text, console errors and clicks that changed nothing, like the browser tool. The app runs with its own empty data folder and gets no API keys. It can only start an app inside the project, asks first outside full auto, and is always closed at the end of the request (the process is ended if it does not quit). |
| **Screenshots for text-only models** | When the model in use cannot read images (DeepSeek, local Qwen and similar), a Gemini vision model describes each screenshot (layout, visible text, anything broken) and the description goes to the model instead. |
| **Chat interface** | Sidebar status per session, a live line while the agent works, Enter steers and Ctrl+Enter queues during a task, Send now, Claude-style task list, background tasks, chapters with a table of contents in the title bar, a live browser pane, split view (Ctrl+\\), icon tabs in the right panel. |

## 15. Known limits (short)

- **Quality depends on the model.** Small free models vary a lot from run to run.
- **Still missing:**
  - in the app: pinned sessions;
  - control of the whole desktop (other programs, the user's screen): left out on purpose for safety; DROPs tests only web pages and Electron apps it starts from the project;
  - in the agent: scheduled tasks, skills, full hooks;
  - for releasing DROPs: auto-update, crash reports, a signed installer;
  - tested Mac and Linux builds.
- The renderer is large vanilla JavaScript without components. The UI tests guard it.

The full list with priorities lives in the private AI Software Company repository (`docs/WEAKNESSES.md`).
