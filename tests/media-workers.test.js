// Run: npm test — reading images and PDFs, and edit-mode sub-agents.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tools = require('../src/main/tools');
const media = require('../src/main/media');

// A minimal valid PDF with one line of text per page.
function makePdf(pages) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contents = pages.map((t) => { const s = `BT /F1 18 Tf 72 720 Td (${t}) Tj ET`; return add(`<< /Length ${s.length} >>\nstream\n${s}\nendstream`); });
  const pagesId = objs.length + pages.length + 1;
  const kids = pages.map((_, i) => add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contents[i]} 0 R >>`));
  add(`<< /Type /Pages /Kids [${kids.map((x) => x + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const cat = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  return Buffer.from(out + `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${x}\n%%EOF\n`, 'latin1');
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2o-mw-'));

test('read_file: PDFs return text page by page, with page ranges', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'spec.pdf'), makePdf(['Alpha requirements', 'Beta design', 'Gamma rollout']));
    const ctx = { root: dir, readFiles: new Map() };
    const all = await (await tools.prepare(ctx, 'read_file', { path: 'spec.pdf' })).run();
    assert.match(all, /pages all 3/);
    assert.match(all, /--- Page 1 ---\nAlpha requirements[\s\S]*--- Page 3 ---\nGamma rollout/);
    const some = await (await tools.prepare(ctx, 'read_file', { path: 'spec.pdf', pages: '2-3' })).run();
    assert.doesNotMatch(some, /Alpha/);
    assert.match(some, /pages 2, 3 of 3[\s\S]*Beta design[\s\S]*Gamma rollout/);
    await assert.rejects(async () => (await tools.prepare(ctx, 'read_file', { path: 'spec.pdf', pages: 'x' })).run(), /Invalid pages/);
    assert.deepStrictEqual(media.parsePages('2,4-5,4', 10), [2, 4, 5]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('read_file: images come back as image blocks', async () => {
  const dir = tmp();
  try {
    fs.copyFileSync(path.join(__dirname, '..', 'src', 'assets', 'icon.png'), path.join(dir, 'shot.PNG'));
    const r = await (await tools.prepare({ root: dir, readFiles: new Map() }, 'read_file', { path: 'shot.PNG' })).run();
    assert.match(r.text, /\[image shot\.PNG, \d+ KB: shown below\]/);
    assert.strictEqual(r.images.length, 1);
    assert.strictEqual(r.images[0].source.media_type, 'image/png');
    assert.ok(r.images[0]._toolImage);
    assert.strictEqual(Buffer.from(r.images[0].source.data, 'base64').length, fs.statSync(path.join(dir, 'shot.PNG')).size);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- scripted agent; the edit sub-agent gets its own script (told apart by its system prompt) ----
function scripted({ lead, worker = [], settings = {}, onEvent = () => {} }) {
  const providers = require('../src/main/providers');
  const { AgentSession } = require('../src/main/agent');
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'beta\n');
  let li = 0, wi = 0;
  const orig = providers.callModel;
  const seen = [];
  providers.callModel = async ({ system, messages }) => {
    const isWorker = system.includes('You are an edit sub-agent');
    seen.push({ isWorker, last: messages[messages.length - 1] });
    const s = isWorker ? worker[wi++] : lead[li++];
    const content = s?.tool ? [{ type: 'tool_use', id: (isWorker ? 'w' : 'l') + (isWorker ? wi : li), name: s.tool, input: s.input }] : [{ type: 'text', text: s?.text || 'done' }];
    return { content, model: 'fake', stop_reason: s?.tool ? 'tool_use' : 'end_turn', usage: {} };
  };
  const data = { id: 'w', title: 'New session', projectDir: dir, messages: [], archive: [], compactions: [], turns: [], toolMeta: {}, todos: [], changes: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, context: 0, requests: 0 } };
  const events = [];
  let agent;
  agent = new AgentSession(data, {
    send: (_id, type, p) => { events.push({ type, ...p }); onEvent(agent, type, p); },
    save: () => {}, getSettings: () => ({ autoVerify: false, ...settings }), getApiKey: () => 'x', getGeminiKey: () => null,
  });
  const done = () => { providers.callModel = orig; agent.dispose(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { agent, data, dir, events, seen, done };
}

test('agent: images read by a tool reach the model, and only the newest 3 stay in history', async () => {
  const t = scripted({ lead: [1, 2, 3, 4].map((n) => ({ tool: 'read_file', input: { path: `i${n}.png` } })) });
  try {
    for (const n of [1, 2, 3, 4]) fs.copyFileSync(path.join(__dirname, '..', 'src', 'assets', 'icon.png'), path.join(t.dir, `i${n}.png`));
    await t.agent.send('look at the screenshots', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    const userMsgs = t.data.messages.filter((m) => m.role === 'user' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
    const first = userMsgs[0].content;
    assert.strictEqual(first[0].type, 'tool_result', 'tool results come first');
    assert.ok(!('_images' in first[0]), 'internal field removed');
    const imgs = t.data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'image');
    assert.strictEqual(imgs.length, 3);
    assert.match(JSON.stringify(first), /an image read earlier was removed/);
  } finally { t.done(); }
});

test('agent: an edit sub-agent changes files through the normal pipeline (checkpoints, ids, report)', async () => {
  const t = scripted({
    lead: [{ tool: 'task', input: { description: 'Update a.txt', prompt: 'Change alpha to ALPHA in a.txt', mode: 'edit' } }, { text: 'All done' }],
    worker: [
      { tool: 'read_file', input: { path: 'a.txt' } },
      { tool: 'edit_file', input: { path: 'a.txt', old_string: 'alpha', new_string: 'ALPHA' } },
      { tool: 'task', input: { description: 'nested', prompt: 'x' } },
      { text: 'Changed a.txt:1. Verified by reading it back.' },
    ],
  });
  try {
    await t.agent.send('do it', { model: 'claude-opus-5-5', effort: 'low', mode: 'yolo' });
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'ALPHA\n');
    const taskResult = t.data.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.type === 'tool_result' && b.tool_use_id === 'l1');
    assert.match(taskResult.content, /Changed a\.txt:1/);
    assert.match(taskResult.content, /verify the combined result/);
    assert.ok(t.data.toolMeta['l1~w2'], 'worker tool calls are namespaced under the task id');
    assert.ok(Object.keys(t.data.turns[0].files).some((f) => f.endsWith('a.txt')), 'checkpoint recorded, so rewind works');
    const nested = t.seen.filter((x) => x.isWorker).map((x) => JSON.stringify(x.last)).join();
    assert.match(nested, /task is not available to an edit sub-agent/);
    assert.ok(t.data.changes['a.txt'], 'shows up in the Changes panel');
  } finally { t.done(); }
});

test('agent: edit sub-agents ask for permission like the lead (and respect a denial)', async () => {
  const perms = [];
  const t = scripted({
    lead: [{ tool: 'task', input: { description: 'Update b.txt', prompt: 'Change beta', mode: 'edit' } }, { text: 'ok' }],
    worker: [
      { tool: 'read_file', input: { path: 'b.txt' } },
      { tool: 'edit_file', input: { path: 'b.txt', old_string: 'beta', new_string: 'BETA' } },
      { text: 'The user denied the edit.' },
    ],
    onEvent: (agent, type, p) => { if (type === 'permission') { perms.push(p.toolId); setImmediate(() => agent.respond(p.reqId, 'deny')); } },
  });
  try {
    await t.agent.send('do it', { model: 'claude-opus-5-5', effort: 'low', mode: 'ask' });
    assert.deepStrictEqual(perms, ['l1~w2']);
    assert.strictEqual(fs.readFileSync(path.join(t.dir, 'b.txt'), 'utf8'), 'beta\n');
  } finally { t.done(); }
});
