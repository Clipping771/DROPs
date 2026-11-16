// Skills (listed in the prompt, loaded with the `skill` tool) and hooks (five events).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-hooks-appdata-'));
const providers = require('../src/main/providers');
const { AgentSession } = require('../src/main/agent');
const { parseHooks, loadHooks } = require('../src/main/hooks');
const { listSkills } = require('../src/main/commands');
const realCallModel = providers.callModel;

function project(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-hooks-proj-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return dir;
}
function agentWith(dir, script, settings = {}, onEvent = () => {}) {
  let i = 0; const calls = [];
  providers.callModel = async (o) => {
    if (!o.tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
    calls.push(o);
    const st = script[i++] || { text: 'done' };
    return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 's', title: 'x', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: {} };
  const agent = new AgentSession(data, { send: (_id, type, p) => onEvent(agent, type, p), save: () => {}, getSettings: () => ({ autoVerify: false, completionAudit: false, uiCheck: false, evidenceCheck: false, ...settings }), getApiKey: () => 'x', getGeminiKey: () => '' });
  return { agent, data, calls };
}
const results = (data) => data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)));
const userText = (data) => data.messages.filter((m) => m.role === 'user').flatMap((m) => (Array.isArray(m.content) ? m.content : [{ text: m.content }])).map((b) => b.text || '').join('\n');
const run = (agent, text, mode = 'yolo') => agent.send(text, { model: 'claude-opus-5-5', effort: 'low', mode });

test('hooks: flat and nested (Claude Code) formats both load', () => {
  const a = parseHooks({ hooks: { PreToolUse: [{ matcher: 'shell', command: 'x' }], Stop: [{ hooks: [{ type: 'command', command: 'y', timeout: 5 }] }] } }, 'user');
  assert.deepEqual(a.map((h) => [h.event, h.matcher, h.command, h.timeout]), [['PreToolUse', 'shell', 'x', 60], ['Stop', '', 'y', 5]]);
  assert.equal(loadHooks(null, { hooks: '{bad' }).error.startsWith('Settings → Hooks is not valid JSON'), true);
});

test('skills: listed in the prompt, loaded with the skill tool, with their own files', async () => {
  const dir = project({
    '.drops/skills/release-notes/SKILL.md': '---\nname: release-notes\ndescription: Write release notes in our house style\n---\nUse three sections: Added, Fixed, Changed. Use template.md.',
    '.drops/skills/release-notes/template.md': '## Added\n## Fixed\n## Changed',
    '.claude/skills/old/SKILL.md': 'Old skill body',
  });
  assert.deepEqual(listSkills(dir, null).map((k) => k.name).sort(), ['old', 'release-notes']);
  const { agent, data, calls } = agentWith(dir, [
    { tool: 'skill', input: { name: 'release-notes' } },
    { tool: 'skill', input: { name: 'release-notes', file: 'template.md' } },
    { tool: 'skill', input: { name: 'release-notes', file: '../../../package.json' } },
    { text: 'ok' },
  ]);
  try {
    await run(agent, 'write the release notes');
    assert.match(calls[0].system, /# Skills[\s\S]*- release-notes: Write release notes in our house style/);
    const r = results(data);
    assert.match(r[0], /# Skill: release-notes\nUse three sections/);
    assert.match(r[0], /template\.md/);
    assert.match(r[1], /## Added/);
    assert.match(r[2], /outside the skill folder/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('hooks: PreToolUse blocks, PostToolUse adds output, UserPromptSubmit and SessionStart add context, Stop sends the agent back once', async () => {
  const dir = project({
    'a.txt': 'hello',
    'pre.js': "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);if(e.tool_name==='write_file'){process.stderr.write('No writes to '+e.tool_input.path);process.exit(2)}});",
    'post.js': "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const e=JSON.parse(s);console.log('post saw '+e.tool_name)});",
    'prompt.js': "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log('ticket: '+JSON.parse(s).prompt.length)});",
    'start.js': "console.log('branch is main')",
    'stop.js': "const fs=require('fs');if(!fs.existsSync('stopped')){fs.writeFileSync('stopped','1');process.stderr.write('Run the tests first');process.exit(2)}",
  });
  const hooks = { hooks: {
    PreToolUse: [{ matcher: 'write_file|edit_file', command: 'node pre.js' }],
    PostToolUse: [{ matcher: 'read_file', command: 'node post.js' }],
    UserPromptSubmit: [{ command: 'node prompt.js' }],
    SessionStart: [{ command: 'node start.js' }],
    Stop: [{ command: 'node stop.js' }],
  } };
  const { agent, data } = agentWith(dir, [
    { tool: 'write_file', input: { path: 'b.txt', content: 'x' } },
    { tool: 'read_file', input: { path: 'a.txt' } },
    { text: 'All done' },
    { text: 'Tests ran, done' },
  ], { hooks: JSON.stringify(hooks) });
  try {
    await run(agent, 'do it');
    const r = results(data);
    assert.match(r[0], /Blocked by a hook: No writes to b\.txt/);
    assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
    assert.match(r[1], /\[hook\] post saw read_file/);
    const u = userText(data);
    assert.match(u, /ticket: 5/);
    assert.match(u, /branch is main/);
    assert.match(u, /A Stop hook says the work is not finished:\nRun the tests first/);
    const last = data.messages[data.messages.length - 1];
    assert.match(JSON.stringify(last.content), /Tests ran, done/);
  } finally { agent.dispose(); providers.callModel = realCallModel; }
});

test('hooks: a UserPromptSubmit hook can block the request; project hooks need approval outside full auto', async () => {
  const dir = project({ '.drops/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ command: 'node block.js' }] } }), 'block.js': "process.stderr.write('Not on Fridays');process.exit(2)" });
  // Denied: the project's hooks do not run, the request goes on.
  const perms = [];
  const a1 = agentWith(dir, [{ text: 'answered' }], {}, (a, type, p) => { if (type === 'permission') { perms.push(p); setImmediate(() => a.respond(p.reqId, 'deny')); } });
  try {
    await run(a1.agent, 'hi', 'ask');
    assert.equal(perms.length, 1);
    assert.match(perms[0].summary, /Run this project's hooks/);
    assert.match(perms[0].input.command, /\[UserPromptSubmit\] node block\.js/);
    assert.equal(a1.calls.length, 1, 'the model was called');
  } finally { a1.agent.dispose(); providers.callModel = realCallModel; }
  // Full auto: the hook runs and blocks; the model is never called.
  const a2 = agentWith(dir, [{ text: 'should not happen' }]);
  try {
    await run(a2.agent, 'hi');
    assert.equal(a2.calls.length, 0);
    assert.match(JSON.stringify(a2.data.messages[a2.data.messages.length - 1].content), /A hook blocked this request: Not on Fridays/);
  } finally { a2.agent.dispose(); providers.callModel = realCallModel; }
});
