# Changelog

## 2.2.0 (2026-11-16)

Everything since the 2.1.0 installer of 2026-11-15.

### Computer and apps
- **Computer use (Windows).** DROPs can use the apps on your computer (Notepad, Excel, Paint, any program) with the mouse and keyboard when you ask. It reads each window's controls by name, so many clicks need no mouse. It takes screenshots of that one window only. Its safety rules:
  - you approve each app, in every mode;
  - system and security programs and DROPs itself are never touched;
  - it never types passwords, card numbers or keys;
  - it asks before clicking things like delete, send, pay or confirm;
  - moving the mouse or pressing Esc stops it.
- **Desktop app testing.** The `app` tool launches the Electron app you are building, uses it like a user, takes screenshots, and always closes it at the end of the request.
- **Screenshots for any model.** Models that cannot see images get a description of each screenshot instead.

### Working like Claude Code
- **Skills.** Put a `SKILL.md` in `.drops/skills/<name>/` (or `.claude/skills`). The agent loads it when a task matches, and each skill is also a `/` command.
- **Hooks.** These events can run your own commands: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`. Set them in Settings or in `.drops/hooks.json`.
- **Scheduled tasks.** A prompt can run by itself once, hourly, daily, on weekdays or weekly. Manage them in the Tasks panel, or ask the agent.
- **Chat that keeps working:**
  - Enter tells the agent something now; Ctrl+Enter queues it for after the current task.
  - Send now, a live status line, background tasks, and a queue that survives a restart.
- **Layout:**
  - chapters with a table of contents and split view (Ctrl+\);
  - a live browser pane;
  - pinned sessions;
  - a calmer, plainer interface.

### A more careful engineer
- **Evidence:**
  - a requirement is re-checked when the code changed after it was verified;
  - adversarial QA tries wrong passwords, other users' data and bad input.
- **Debugging:** root-cause debugging with the failing line in your own code, and a regression test afterwards.
- **Code tools:**
  - an import graph with an `impact` tool;
  - `find_breaking_change` names which change broke a check;
  - a fixed-rule `audit` for security and performance.
- **Memory:** decisions are remembered, and unfinished work carries over to the next session.

### Reliability
- **Crash reports:** kept on this computer only, with secrets removed. The next start tells you when DROPs did not close normally.
- **Update check:** once a day DROPs looks for a newer release on GitHub. Download opens the release page; nothing installs by itself.
- **Errors and retries:** short outages are retried, and real errors are saved in the conversation.

### Known limits
- The installer is not code-signed yet, so Windows shows "Unknown publisher".
- Computer use works on Windows only. Scheduled tasks run while DROPs is open.
