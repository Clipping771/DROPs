// Tool schemas registered by the agent session (kept separate from agent.js to keep the loop readable).
const tools = require('./tools');

const TASK_DEF = {
  name: 'task',
  description: 'Delegate a self-contained task to a sub-agent with its own fresh context; it returns a concise report and its file dumps never enter your context. mode "research" (default): read-only tools, for exploring large codebases, tracing how something works, or investigating several areas in parallel (call task several times in one turn). mode "edit": the sub-agent can also edit files and run commands, under the same permissions, checkpoints and checks as you; use it to split a large change into independent parts that run in parallel, and give each edit sub-agent its own files so they never edit the same file. Always give a complete brief: goal, files, constraints, how to verify, what to report. Check edit sub-agents\' work yourself before finishing.',
  input_schema: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '3-6 word label' },
      prompt: { type: 'string', description: 'Full brief for the sub-agent' },
      mode: { type: 'string', enum: ['research', 'edit'], description: 'research (default, read-only) or edit (can change files and run commands)' },
    },
    required: ['description', 'prompt'],
  },
};

const WEB_SEARCH_DEF = {
  name: 'web_search',
  description: 'Search the web and get results with sources. Use for current library versions, API changes, error messages and docs. Follow up with fetch_url to read a result in full.',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const ASK_USER_DEF = {
  name: 'ask_user',
  description: 'Ask the user a question and wait for the answer. Use only when you are blocked on a decision that is genuinely theirs (choice between approaches, a missing requirement, an ambiguous goal) and it cannot be settled from the code or a sensible default. Offer 2-4 short concrete options when possible; the user can also type their own answer. Do not use it for permission to run tools: the app asks for that itself.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'One clear question' },
      options: { type: 'array', items: { type: 'string' }, description: '2-4 short choices (optional)' },
      multi_select: { type: 'boolean', description: 'Allow selecting multiple options (default false)' },
    },
    required: ['question'],
  },
};

const IMPACT_DEF = {
  name: 'impact',
  description: 'Before changing something shared, see what depends on it: target is a file path (relative to the project), a function/component/class name, a database model name (Prisma), or "cycles" for import cycles. Returns the files that import it (directly and through others), where a name is used, the API route callers, and the tests to run afterwards. A static map from imports and names, not proof: still run those tests.',
  input_schema: { type: 'object', properties: { target: { type: 'string', description: 'File path, symbol name, model name, or "cycles"' } }, required: ['target'] },
};

const CODE_SEARCH_DEF = {
  name: 'code_search',
  description: 'Ranked keyword search across the codebase when exact grep is not enough: splits camelCase/snake_case names and ranks files by how many of your words appear in file paths, function/class/type names, comments and code (e.g. "user authentication middleware", "stripe webhook invoice"). It matches words, not meaning: searching "login" does not find a function named signIn, so try two or three wordings when the first finds nothing.',
  input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Natural-language concepts or keywords' }, limit: { type: 'integer', description: 'Max files to return (default 12)' } }, required: ['query'] },
};

const AUDIT_DEF = {
  name: 'audit',
  description: 'Static security and performance audit of the project, by fixed rules (not guesses): secrets in code, SQL built from strings, eval, raw HTML from data, shell commands from request data, open CORS, cookies without httpOnly, plain passwords, TLS turned off, open redirects; database calls inside loops (N+1), blocking file calls in request code, unpaginated queries, very large files. Each finding has file:line, severity and a fix hint. Run it before finishing work that adds logins, forms, APIs or database code; fix every high finding. area: "security", "performance" or "all".',
  input_schema: { type: 'object', properties: { area: { type: 'string', enum: ['all', 'security', 'performance'] } } },
};

const FIND_BREAK_DEF = {
  name: 'find_breaking_change',
  description: 'When a check (tests, build, a script) fails after your changes in this request, find which changed file causes it: DROPs puts each changed file back to its state before this request, one at a time, runs the command, and then restores every file exactly as it is now. Use it before reverting anything, so you undo only the culprit. Give the failing command.',
  input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The failing check, e.g. npm test' } }, required: ['command'] },
};

const CHAPTER_DEF = {
  name: 'mark_chapter',
  description: 'Start a new chapter in the conversation when the work moves to a clearly different phase (for example from investigating to building, or from building to verifying). The user sees a divider and a table of contents to jump between chapters. Use it sparingly: two to six times in a long task, never for every step, and not in short answers. title: a short noun phrase.',
  input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Under 40 characters, e.g. "Checkout fix"' }, summary: { type: 'string', description: 'Optional one line' } }, required: ['title'] },
};

const APP_DEF = {
  name: 'app',
  description: 'Test a desktop app you are building (Electron) the way a user would: launch it, click, type, read what its window shows, take a screenshot, close it. It runs with its own empty data folder, so it never touches the user\'s real settings, and it is closed at the end of every request. Each step reports the window\'s text, interactive elements, messages, console errors and clicks that changed nothing, like the browser tool. Actions: launch {path?: the app folder, default the project}; click {target}; fill {target, value}; select {target, value}; check {target}; press {key, target?}; wait {target? | seconds}; read; screenshot; close. target = visible text or label, "testid=<id>", or a CSS selector.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['launch', 'click', 'fill', 'select', 'check', 'press', 'wait', 'read', 'screenshot', 'close'] },
      path: { type: 'string', description: 'For launch: the app folder relative to the project (default ".")' },
      target: { type: 'string' }, value: { type: 'string' }, key: { type: 'string' }, seconds: { type: 'number' }, full: { type: 'boolean' },
      width: { type: 'integer' }, height: { type: 'integer' },
    },
    required: ['action'],
  },
};

const COMPUTER_DEF = {
  name: 'computer',
  description: 'Use the apps on the user\'s Windows computer (Notepad, Excel, Paint, any desktop program) with the mouse and keyboard, when the user asks for something done in an app. Not for web pages (use browser) or the app you are building (use app). The user approves each app first; system programs (Explorer, terminals, Settings, Task Manager, password managers) can never be used. DROPs never types passwords, card numbers or keys, asks the user before clicking anything like delete, send, pay or confirm, and stops if the user moves the mouse or presses Esc. Work like this: open or focus the app; read it (its controls with numbers and exact names: works with any model and does not move the mouse); click/type by element number or name; take a screenshot only when you need to see layout or the app has no readable controls, then use x,y in that screenshot\'s pixels. Check the result after each step. Actions: windows; open {app: name like "notepad" or a full path}; focus {app?, title?}; read; screenshot; click {element | target | x,y, button?, double?}; type {text, element? | target?, append?}; key {keys: e.g. "ctrl+s", "enter", "alt+f4"}; scroll {x, y, amount}; drag {x, y, x2, y2}; wait {seconds}.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['windows', 'open', 'focus', 'read', 'screenshot', 'click', 'type', 'key', 'scroll', 'drag', 'wait'] },
      app: { type: 'string' }, title: { type: 'string' }, args: { type: 'string' },
      element: { type: 'integer', description: 'An element number from the latest read' },
      target: { type: 'string', description: 'An element\'s visible name, e.g. "Save"' },
      x: { type: 'number' }, y: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' },
      text: { type: 'string' }, append: { type: 'boolean', description: 'Type at the cursor instead of replacing the field' },
      keys: { type: 'string' }, amount: { type: 'number' }, seconds: { type: 'number' },
    },
    required: ['action'],
  },
};

const SKILL_DEF = {
  name: 'skill',
  description: 'Load a skill: written instructions for a kind of task (a house style, a release process, a checklist), listed under "Skills" in your instructions. Call it with the skill name before starting a task that matches its description, then follow it. A skill may point to its own files (templates, scripts): read them with {name, file}.',
  input_schema: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', description: 'A file inside the skill folder, e.g. "template.md"' } }, required: ['name'] },
};

const SCHEDULE_DEF = {
  name: 'schedule',
  description: 'Scheduled tasks: a prompt DROPs runs by itself later, in a new session of this project ("every weekday at 9 run the tests and tell me what broke"). Use it only when the user asks for something to happen later or on a repeat. Creating or deleting asks the user. Actions: list; create {name, prompt, repeat: once|hourly|daily|weekdays|weekly, time: "HH:MM", weekday: 0-6 (weekly, 0 = Sunday), at: "YYYY-MM-DDTHH:MM" (once), mode: ask|auto-edit|yolo}; delete {id}. Write the prompt so it stands alone: the later session has none of this conversation.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'delete'] },
      id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' },
      repeat: { type: 'string', enum: ['once', 'hourly', 'daily', 'weekdays', 'weekly'] },
      time: { type: 'string' }, weekday: { type: 'integer' }, at: { type: 'string' },
      mode: { type: 'string', enum: ['ask', 'auto-edit', 'yolo'] },
    },
    required: ['action'],
  },
};

const WRAP_UP_DEF = {
  name: 'wrap_up',
  description: 'Fill the "next step" box the user sees at the end of your turn. Call it once, as your last tool call, in every turn where you changed files or ran commands; skip it for a short answer or a question. recap: two or three short sentences in the user\'s language saying what is now true and what is not done or not verified. ask + options: only when the next move is the user\'s decision (a choice, a go-ahead): one short question and 1-3 button labels of 1-4 words, your recommendation first. After calling it, write your final message as usual.',
  input_schema: {
    type: 'object',
    properties: {
      recap: { type: 'string', description: 'Two or three short sentences: what is now true, what is not done or not verified.' },
      ask: { type: 'string', description: 'One short question, only when the user must decide something.' },
      options: { type: 'array', items: { type: 'string' }, description: '1-3 short answers (1-4 words each), recommended first. A click sends it as the user\'s reply.' },
    },
    required: ['recap'],
  },
};

const SAVE_PLAN_DEF = {
  name: 'save_plan',
  description: 'Record a structured implementation plan for multi-file or complex tasks. It stays pinned in your system context across compactions so you never lose track of target files, architectural steps, or how to verify.',
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Short summary of what we are building or fixing' },
      files: { type: 'array', items: { type: 'string' }, description: 'Target files to create or modify' },
      steps: { type: 'array', items: { type: 'string' }, description: 'Ordered implementation steps' },
      verification: { type: 'string', description: 'Exact command(s) or checks to prove it works' },
    },
    required: ['goal', 'steps'],
  },
};

const FIND_REFS_DEF = {
  name: 'find_references',
  description: 'IDE-grade Go-to-Definition and Find All References across the project: returns exact file:line locations where a function, class, type or variable is defined and used (AST-powered for TypeScript/JS).',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact symbol name' },
      file: { type: 'string', description: 'Optional relative path where the symbol is defined' },
    },
    required: ['name'],
  },
};

const TYPE_CHECK_DEF = {
  name: 'type_check',
  description: 'Fast in-memory TypeScript/JS project type & syntax check using the TypeScript LanguageService (no slow tsc spawn). Returns exact file:line diagnostics across the project or specific files.',
  input_schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: 'Optional list of relative file paths to check (default: whole project)' },
    },
  },
};

const SWARM_DEF = {
  name: 'swarm',
  description: 'Shared peer-to-peer message board for coordinating multiple parallel agents/workers. Post updates, read messages from other workers, or check active board status.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['post', 'read', 'status'], description: 'Board action' },
      from: { type: 'string', description: 'Sender agent name (e.g. "lead" or "worker-1")' },
      to: { type: 'string', description: 'Optional recipient ("all" or specific worker)' },
      message: { type: 'string', description: 'Message content for action="post"' },
    },
    required: ['action'],
  },
};

const WORKFLOW_DEF = {
  name: 'run_workflow',
  description: 'Execute a staged multi-agent workflow: stages run sequentially, while tasks inside each stage run in parallel (with per-file locking for edit tasks).',
  input_schema: {
    type: 'object',
    properties: {
      stages: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  prompt: { type: 'string' },
                  mode: { type: 'string', enum: ['research', 'edit'] },
                },
                required: ['description', 'prompt'],
              },
            },
          },
          required: ['tasks'],
        },
      },
    },
    required: ['stages'],
  },
};

const IMAGE_GEN_DEF = {
  name: 'generate_image',
  description: 'Generate a PNG image from a text prompt using Gemini Imagen and save it inside the project folder.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed visual prompt' },
      path: { type: 'string', description: 'Relative output path inside the project (e.g. "assets/hero.png")' },
      aspect_ratio: { type: 'string', description: 'Optional aspect ratio (e.g. "16:9", "1:1", "4:3")' },
    },
    required: ['prompt', 'path'],
  },
};

const ALL = [TASK_DEF, WEB_SEARCH_DEF, ASK_USER_DEF, IMPACT_DEF, CODE_SEARCH_DEF, FIND_REFS_DEF, TYPE_CHECK_DEF, AUDIT_DEF, FIND_BREAK_DEF, CHAPTER_DEF, APP_DEF, COMPUTER_DEF, SKILL_DEF, SCHEDULE_DEF, WRAP_UP_DEF, SAVE_PLAN_DEF, SWARM_DEF, WORKFLOW_DEF, IMAGE_GEN_DEF];
for (const d of ALL) tools.registerDef(d);

module.exports = { TASK_DEF, WEB_SEARCH_DEF, ASK_USER_DEF, IMPACT_DEF, CODE_SEARCH_DEF, FIND_REFS_DEF, TYPE_CHECK_DEF, AUDIT_DEF, FIND_BREAK_DEF, CHAPTER_DEF, APP_DEF, COMPUTER_DEF, SKILL_DEF, SCHEDULE_DEF, WRAP_UP_DEF, SAVE_PLAN_DEF, SWARM_DEF, WORKFLOW_DEF, IMAGE_GEN_DEF };
