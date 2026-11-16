// Scheduled tasks: when they run, the scheduler, and the agent's `schedule` tool.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nextRun, normalize, describe, Scheduler } = require('../src/main/schedule');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
// 2026-11-16 is a Monday.
const MON_8 = at(2026, 11, 16, 8, 0), MON_10 = at(2026, 11, 16, 10, 0), FRI_10 = at(2026, 11, 20, 10, 0);

test('schedule: next run for every repeat', () => {
  assert.equal(nextRun({ repeat: 'daily', time: '09:00' }, MON_8), at(2026, 11, 16, 9, 0));
  assert.equal(nextRun({ repeat: 'daily', time: '09:00' }, MON_10), at(2026, 11, 17, 9, 0));
  assert.equal(nextRun({ repeat: 'weekdays', time: '09:00' }, FRI_10), at(2026, 11, 23, 9, 0), 'skips the weekend');
  assert.equal(nextRun({ repeat: 'weekly', time: '18:30', weekday: 0 }, MON_10), at(2026, 11, 22, 18, 30));
  assert.equal(nextRun({ repeat: 'hourly', time: '00:15' }, MON_10), at(2026, 11, 16, 10, 15));
  assert.equal(nextRun({ repeat: 'once', at: MON_10 }, MON_8), MON_10);
  assert.equal(nextRun({ repeat: 'once', at: MON_8 }, MON_10), null);
  assert.equal(describe({ repeat: 'weekdays', time: '09:00' }), 'weekdays at 09:00');
});

test('schedule: a schedule needs a prompt and a project; a past one-off is refused', () => {
  assert.throws(() => normalize({ projectDir: 'x' }), /needs a prompt/);
  assert.throws(() => normalize({ prompt: 'p' }), /project folder/);
  assert.throws(() => normalize({ prompt: 'p', projectDir: 'x', repeat: 'once', at: Date.now() - 1000 }), /already passed/);
  const s = normalize({ prompt: 'Run the tests and report', projectDir: 'x', repeat: 'bogus', time: '7am', mode: 'weird' });
  assert.equal(s.repeat, 'daily'); assert.equal(s.time, '09:00'); assert.equal(s.mode, 'auto-edit'); assert.equal(s.name, 'Run the tests and report');
  assert.ok(s.nextRun > Date.now() && s.id);
});

test('scheduler: runs a due task once (a missed run is caught up once), moves it on, and switches a one-off off', async () => {
  let now = at(2026, 11, 18, 12, 0);
  const list = [
    { id: 'a', name: 'daily', prompt: 'p', repeat: 'daily', time: '09:00', enabled: true, nextRun: at(2026, 11, 16, 9, 0) }, // missed twice while closed
    { id: 'b', name: 'once', prompt: 'p', repeat: 'once', at: at(2026, 11, 18, 11, 0), enabled: true, nextRun: at(2026, 11, 18, 11, 0) },
    { id: 'c', name: 'later', prompt: 'p', repeat: 'daily', time: '20:00', enabled: true, nextRun: at(2026, 11, 18, 20, 0) },
    { id: 'd', name: 'paused', prompt: 'p', repeat: 'daily', time: '09:00', enabled: false, nextRun: at(2026, 11, 16, 9, 0) },
  ];
  const ran = []; let saved = null;
  const sch = new Scheduler({ list: () => list, save: (l) => { saved = l; }, run: async (s) => { ran.push(s.id); }, now: () => now });
  await sch.tick();
  assert.deepEqual(ran, ['a', 'b']);
  assert.equal(list[0].nextRun, at(2026, 11, 19, 9, 0));
  assert.equal(list[1].enabled, false);
  assert.ok(saved);
  await sch.tick();
  assert.deepEqual(ran, ['a', 'b'], 'nothing runs twice');
  now = at(2026, 11, 18, 20, 0);
  await sch.tick();
  assert.deepEqual(ran, ['a', 'b', 'c']);
});

test('schedule tool: creating asks the user even in full auto; denied means nothing is saved', async () => {
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-sched-'));
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const real = providers.callModel;
  const store = [];
  const schedules = { list: () => store.map((s) => ({ ...s, when: describe(s) })), save: (i) => { const s = normalize(i); store.push(s); return { ...s, when: describe(s) }; }, remove: () => true };
  const runWith = async (answer) => {
    let i = 0;
    const script = [{ tool: 'schedule', input: { action: 'create', name: 'Morning tests', prompt: 'Run npm test and report failures', repeat: 'weekdays', time: '09:00' } }, { tool: 'schedule', input: { action: 'list' } }, { text: 'ok' }];
    providers.callModel = async (o) => {
      if (!o.tools.length) return { content: [{ type: 'text', text: '[]' }], usage: {} };
      const st = script[i++] || { text: 'done' };
      return { content: st.tool ? [{ type: 'tool_use', id: 't' + i, name: st.tool, input: st.input }] : [{ type: 'text', text: st.text }], stop_reason: st.tool ? 'tool_use' : 'end_turn', usage: {} };
    };
    const perms = [];
    const data = { id: 's', title: 'x', projectDir: os.tmpdir(), messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: {} };
    const agent = new AgentSession(data, { schedules, send: (_id, type, p) => { if (type === 'permission') { perms.push(p); setImmediate(() => agent.respond(p.reqId, answer)); } }, save: () => {}, getSettings: () => ({ autoVerify: false, completionAudit: false }), getApiKey: () => 'x', getGeminiKey: () => '' });
    try { await agent.send('every weekday at 9 run the tests', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' }); } finally { agent.dispose(); providers.callModel = real; }
    const r = data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_result').map((b) => String(b.content));
    return { perms, r };
  };
  const no = await runWith('deny');
  assert.equal(no.perms.length, 1);
  assert.equal(no.perms[0].kind, 'schedule');
  assert.match(no.perms[0].summary, /Schedule "Morning tests" weekdays at 09:00/);
  assert.match(no.r[0], /did not schedule it/);
  assert.equal(store.length, 0);
  const yes = await runWith('allow');
  assert.match(yes.r[0], /Scheduled "Morning tests" \(weekdays at 09:00\)/);
  assert.match(yes.r[1], /Morning tests" weekdays at 09:00/);
  assert.equal(store.length, 1);
});
