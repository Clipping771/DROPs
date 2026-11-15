// Ollama provider: local models, fully offline. Uses Ollama's native /api/chat (NDJSON streaming).
const crypto = require('crypto');
const os = require('os');

const isOllama = (model) => typeof model === 'string' && model.startsWith('ollama:');
const bare = (model) => String(model || '').replace(/^ollama:/, '');
// Ollama listens on IPv4 only, while Node resolves "localhost" to ::1 first — always use 127.0.0.1.
const fixUrl = (u) => (u || 'http://127.0.0.1:11434').replace(/\/+$/, '').replace('//localhost', '//127.0.0.1');

const isHeavyLocalModel = (model) => /(muse-glimmer|26b|27b|30b|31b|32b|34b|70b|72b)/i.test(bare(model));

function effectiveCtx(model, requestedCtx = 16384, totalMemBytes = os.totalmem()) {
  const req = Math.max(2048, Number(requestedCtx) || 16384);
  const totalGb = totalMemBytes / (1024 ** 3);
  if (isHeavyLocalModel(model) && totalGb <= 18) return Math.min(req, 8192);
  return req;
}

function mapEffortToThink(model, effort, totalMemBytes = os.totalmem()) {
  if (effort === false || effort === 'none' || effort === 'off') return false;
  if (!/(muse-glimmer|gpt-oss)/i.test(bare(model))) return undefined;
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  if (effort === 'high') return 'high';
  if (effort === 'xhigh' || effort === 'max') return 'max';
  const totalGb = totalMemBytes / (1024 ** 3);
  return totalGb <= 18 ? 'low' : 'medium';
}

async function listModels(baseUrl) {
  baseUrl = fixUrl(baseUrl);
  const r = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`Ollama responded ${r.status}`);
  const { models = [] } = await r.json();
  const out = [];
  for (const m of models) {
    let tools = null;
    try {
      const s = await (await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(4000) })).json();
      tools = Array.isArray(s.capabilities) ? s.capabilities.includes('tools') : null;
    } catch { /* older Ollama */ }
    const cloud = isCloud(m.name);
    const ps = String(m.details?.parameter_size || '').match(/^([\d.]+)\s*([BM])/i);
    const params = ps ? Number(ps[1]) / (ps[2].toUpperCase() === 'M' ? 1000 : 1) : null; // billions
    out.push({ id: 'ollama:' + m.name, label: `${m.name}${m.details?.parameter_size ? ` (${m.details.parameter_size})` : ''}${cloud ? ' — cloud, needs Ollama credits' : ''}${tools === false ? ' — no tool support' : ''}`, tools, cloud, params });
  }
  // Local models first; cloud models (paid) last.
  out.sort((a, b) => a.cloud - b.cloud);
  return out;
}

// Ollama "cloud" models run on ollama.com and need credits; local models are free.
const isCloud = (name) => /(^|[:-])cloud\b/i.test(name);

// Good free local models with tool support, with approximate download size.
const RECOMMENDED = [
  { name: 'qwen3:4b', size: '2.5 GB', ram: 8, note: 'Fast, good for most tasks on 8 GB RAM' },
  { name: 'qwen3:8b', size: '5.2 GB', ram: 16, note: 'Better quality, needs 16 GB RAM' },
  { name: 'qwen2.5-coder:7b', size: '4.7 GB', ram: 16, note: 'Tuned for code' },
  { name: 'llama3.1:8b', size: '4.9 GB', ram: 16, note: 'Solid general model' },
  { name: 'qwen3:14b', size: '9.3 GB', ram: 32, note: 'Strong, needs 32 GB RAM or a GPU' },
];

function parseToolJson(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const cleaned = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(cleaned);
  }
}

// Downloads a model; onProgress({ status, completed, total }).
async function pull(baseUrl, name, onProgress, signal) {
  baseUrl = fixUrl(baseUrl);
  const r = await fetch(`${baseUrl}/api/pull`, { method: 'POST', body: JSON.stringify({ model: name, stream: true }), signal });
  if (!r.ok) throw new Error(`Ollama responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const dec = new TextDecoder();
  let buf = '', last = null;
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(ev.error);
      last = ev;
      onProgress?.({ status: ev.status, completed: ev.completed || 0, total: ev.total || 0 });
    }
  }
  if (last?.status !== 'success') throw new Error('Download did not finish.');
  return true;
}

function friendly(err, model) {
  const msg = err?.message || '';
  if (err?.status === 402 || /402|usage credits|subscribe/i.test(msg)) {
    return { message: `"${bare(model)}" is an Ollama cloud model — it runs on ollama.com and needs paid credits. Pick a free local model instead: Settings → Models & cost → Download a local model (e.g. qwen3:4b).`, needsKey: false, action: 'ollama-download' };
  }
  if (/not found|pull/i.test(msg) && err?.status === 404) return { message: `Model "${bare(model)}" is not downloaded. Download it in Settings → Models & cost.`, action: 'ollama-download' };
  return null;
}

// canonical (Anthropic-shaped) transcript -> Ollama messages
function toMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  const names = new Map();
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use');
      calls.forEach((c) => names.set(c.id, c.name));
      out.push({
        role: 'assistant',
        content: text,
        ...(thinking ? { thinking } : {}),
        ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input || {} } })) } : {}),
      });
    } else {
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
        out.push({ role: 'tool', content: (b.is_error ? 'ERROR: ' : '') + text, tool_name: names.get(b.tool_use_id) });
      }
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const images = blocks.filter((b) => b.type === 'image').map((b) => b.source.data);
      if (text || images.length) out.push({ role: 'user', content: text, ...(images.length ? { images } : {}) });
    }
  }
  return out;
}

// POST with no idle timeout. Node's fetch (undici) aborts a response body that stays silent for 300 s
// ("terminated"); Ollama sends a tool call only once it is fully generated, which on a slow local model
// can take far longer. node:http has no such timeout; the caller's AbortSignal still cancels the request.
function postNoTimeout(url, payload, signal) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? require('node:https') : require('node:http');
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json' }, signal }, (res) => {
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: res,
        text: async () => { let t = ''; for await (const c of res) t += c; return t; },
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function streamTurn({ baseUrl: rawUrl, model, system, messages, tools = [], signal, emit, numCtx = 16384, effort }) {
  const baseUrl = fixUrl(rawUrl);
  const actualCtx = effectiveCtx(model, numCtx);
  const think = mapEffortToThink(model, effort);
  const body = {
    model: bare(model), stream: true, messages: toMessages(system, messages),
    options: { num_ctx: actualCtx },
    ...(think !== undefined ? { think } : {}),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
  };
  let r;
  try { r = await postNoTimeout(`${baseUrl}/api/chat`, JSON.stringify(body), signal); } catch (e) {
    if (signal?.aborted) throw e;
    throw Object.assign(new Error(`Cannot reach Ollama at ${baseUrl}. Start Ollama (or check the URL in Settings).`), { status: 0 });
  }
  if (!r.ok) {
    let t = await r.text();
    if (r.status === 400 && think !== undefined && /think/i.test(t)) {
      delete body.think;
      r = await postNoTimeout(`${baseUrl}/api/chat`, JSON.stringify(body), signal);
      if (!r.ok) t = await r.text();
    }
    if (!r.ok) {
      throw Object.assign(new Error(`Ollama error ${r.status}: ${t.slice(0, 300)}${/does not support tools/i.test(t) ? ' — pick a model with tool support (e.g. qwen3, llama3.1, mistral-nemo).' : ''}`), { status: r.status });
    }
  }
  const content = [];
  let textIdx = -1, thinkIdx = -1, usage = {}, doneReason = null;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.error) throw new Error(`Ollama: ${ev.error}`);
      const msg = ev.message || {};
      if (msg.thinking) {
        if (thinkIdx < 0) { content.push({ type: 'thinking', thinking: '' }); thinkIdx = content.length - 1; emit('block-start', { index: thinkIdx, blockType: 'thinking' }); }
        content[thinkIdx].thinking += msg.thinking; emit('thinking-delta', { index: thinkIdx, text: msg.thinking });
      }
      if (msg.content) {
        if (thinkIdx >= 0 && textIdx < 0) emit('block-stop', { index: thinkIdx });
        if (textIdx < 0) { content.push({ type: 'text', text: '' }); textIdx = content.length - 1; emit('block-start', { index: textIdx, blockType: 'text' }); }
        content[textIdx].text += msg.content; emit('text-delta', { index: textIdx, text: msg.content });
      }
      for (const tc of msg.tool_calls || []) {
        let args = tc.function?.arguments ?? {};
        if (typeof args === 'string') {
          try { args = parseToolJson(args); }
          catch { throw new Error(`Malformed tool call JSON from ${model}`); }
        }
        const block = { type: 'tool_use', id: 'ol_' + crypto.randomBytes(6).toString('hex'), name: tc.function?.name, input: args };
        content.push(block);
        const index = content.length - 1;
        emit('block-start', { index, blockType: 'tool_use', name: block.name, id: block.id });
        emit('input-delta', { index, partial: JSON.stringify(args) });
        emit('block-stop', { index });
      }
      if (ev.done) { usage = { input_tokens: ev.prompt_eval_count || 0, output_tokens: ev.eval_count || 0 }; doneReason = ev.done_reason; }
    }
  }
  if (textIdx >= 0) emit('block-stop', { index: textIdx });
  else if (thinkIdx >= 0) emit('block-stop', { index: thinkIdx });
  const hasTools = content.some((b) => b.type === 'tool_use');
  return { content: content.filter((b) => !(b.type === 'text' && !b.text)), model, stop_reason: hasTools ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end_turn', usage };
}

module.exports = { isOllama, isCloud, listModels, streamTurn, pull, friendly, RECOMMENDED, parseToolJson, effectiveCtx, mapEffortToThink, toMessages };
