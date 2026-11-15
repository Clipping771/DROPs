// Gemini provider: converts DROPs' canonical (Anthropic-shaped) transcript to
// Gemini contents, streams a turn, and converts the reply back to canonical blocks.
const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');

const isGemini = (model) => /^gemini|^gemma/.test(model || '');

// Chat-capable models worth offering for coding.
const SKIP = /image|banana|deep-research|antigravity|omni|tts|embedding|live|audio|gemma|robotics|computer-use/i;
async function listModels(apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const out = [];
  const pager = await ai.models.list({ config: { pageSize: 200 } });
  for await (const m of pager) {
    const id = (m.name || '').replace(/^models\//, '');
    if (!isGemini(id) || SKIP.test(id) || !(m.supportedActions || []).includes('generateContent')) continue;
    out.push({ id, label: m.displayName || id });
  }
  // newest first: gemini-4 > 3.x (higher minor first) > 2.5
  const rank = (id) => { const m = id.match(/gemini-(\d+)(?:\.(\d+))?/); return m ? Number(m[1]) * 100 + Number(m[2] || 0) : 0; };
  const pref = (id) => { const i = FALLBACKS.indexOf(id); return i < 0 ? 99 : i; };
  out.sort((a, b) => pref(a.id) - pref(b.id) || rank(b.id) - rank(a.id) || a.id.localeCompare(b.id));
  return out;
}

function thinkingConfig(model, effort) {
  if (/gemini-2\.5/.test(model)) {
    const budget = { low: 2048, medium: 8192, high: -1, xhigh: 24576, max: 32768 }[effort] ?? -1;
    return { includeThoughts: true, thinkingBudget: /pro/.test(model) && budget === 0 ? 128 : budget };
  }
  const level = { low: 'LOW', medium: 'MEDIUM' }[effort] || 'HIGH';
  return { includeThoughts: true, thinkingLevel: level };
}

// Gemini 3+ requires a thought signature on replayed function calls. For calls made by a
// different model (fallback switch, Claude history) Google documents this placeholder value.
const FOREIGN_SIGNATURE = 'skip_thought_signature_validator';

// canonical messages -> Gemini contents. Thought signatures only replay to the model that made them.
function toContents(messages, model) {
  const names = new Map();
  const contents = [];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      for (const b of blocks) if (b.type === 'tool_use') names.set(b.id, b.name);
      if (Array.isArray(m._gemini) && m._gemini.length) {
        if (!m._geminiModel || m._geminiModel === model) { contents.push({ role: 'model', parts: m._gemini }); continue; }
        // Produced by another model: its signatures are not valid here.
        const parts = m._gemini.filter((p) => !p.thought).map(({ thoughtSignature, ...p }) => (p.functionCall ? { ...p, thoughtSignature: FOREIGN_SIGNATURE } : p));
        if (parts.length) { contents.push({ role: 'model', parts }); continue; }
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') parts.push({ functionCall: { id: b.id, name: b.name, args: b.input || {} }, thoughtSignature: FOREIGN_SIGNATURE });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      const fnParts = [];
      const userParts = [];
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
          fnParts.push({ functionResponse: { id: b.tool_use_id, name: names.get(b.tool_use_id) || 'tool', response: b.is_error ? { error: text } : { output: text } } });
        } else if (b.type === 'text' && b.text) {
          userParts.push({ text: b.text });
        } else if (b.type === 'image' && b.source?.data) {
          userParts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
        }
      }
      if (fnParts.length) contents.push({ role: 'user', parts: fnParts });
      if (userParts.length) contents.push({ role: 'user', parts: userParts });
    }
  }
  return contents;
}

const FINISH_REFUSAL = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

// Models tried, in order, when the chosen one is overloaded, over quota or retired.
const FALLBACKS = ['gemini-4-hydrogen', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const FIRST_CHUNK_TIMEOUT = 60_000;

class Unavailable extends Error {}

// When every model is rate-limited or overloaded at once (typical for free-tier keys, whose limits
// are per minute), wait and go round again instead of failing the whole task.
const RETRY_WAITS_S = [20, 40, 60, 60];
const abortableSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

const dailyExhausted = new Set();

// Streams one turn, falling back to another model if the first can't serve it.
async function streamTurn(opts, { waits = RETRY_WAITS_S, once = streamOnce } = {}) {
  let chain = [opts.model, ...FALLBACKS.filter((m) => m !== opts.model)];
  if (once === streamOnce) {
    const fresh = chain.filter((m) => !dailyExhausted.has(m));
    if (fresh.length) chain = fresh;
  }
  let lastErr;
  for (let round = 0; round <= waits.length; round++) {
    const missing = new Set();
    for (let i = 0; i < chain.length; i++) {
      const model = chain[i];
      try {
        const res = await once({ ...opts, model });
        res.model = model;
        return res;
      } catch (e) {
        if (opts.signal.aborted || !(e instanceof Unavailable)) throw e;
        lastErr = e;
        if (e.message === 'not available for this key' || e.message === 'daily quota reached') missing.add(model);
        if (i + 1 < chain.length) opts.emit('notice', { message: `${model}: ${e.message} — switching to ${chain[i + 1]}.` });
      }
    }
    chain = chain.filter((m) => !missing.has(m));
    if (!chain.length || round === waits.length) break;
    opts.emit('notice', { message: `Every Gemini model is busy or rate-limited; waiting ${waits[round]}s before trying again (${round + 1}/${waits.length}).` });
    await abortableSleep(waits[round] * 1000, opts.signal);
  }
  throw Object.assign(new Error(`Every Gemini model is busy or over quota right now (last: ${lastErr?.message}). Free-tier keys have per-minute limits — wait a minute and send again, or add billing in Google AI Studio.`), { status: 429 });
}

async function streamOnce({ apiKey, model, system, messages, tools, effort, signal, emit }) {
  // One quick retry, then fall back to another model instead of the SDK's long backoff.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 2, initialDelay: 1, maxDelay: 3 } } });
  // Our own controller: aborts on user stop, or if no data arrives in time.
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  let timer = setTimeout(() => { timedOut = true; ac.abort(); }, FIRST_CHUNK_TIMEOUT);
  const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; ac.abort(); }, FIRST_CHUNK_TIMEOUT); };
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
  const unavailable = (e) => {
    const st = e?.status ?? e?.code;
    const msg = String(e?.message || '');
    if (timedOut) return new Unavailable('no response in 60s');
    if (st === 503 || st === 500 || st === 502 || /"code":\s*50[023]|"status":\s*"UNAVAILABLE"|overloaded|high demand/i.test(msg)) return new Unavailable('overloaded');
    if (st === 429 || /"code":\s*429|"status":\s*"RESOURCE_EXHAUSTED"|quota/i.test(msg)) {
      if (/per day limit exceeded|GenerateRequestsPerDay/i.test(msg)) {
        dailyExhausted.add(model);
        return new Unavailable('daily quota reached');
      }
      return new Unavailable('quota/rate limit reached');
    }
    if (st === 404) return new Unavailable('not available for this key');
    if (/fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg)) return new Unavailable('connection dropped');
    return null;
  };

  let stream;
  try {
    stream = await ai.models.generateContentStream({
      model,
      contents: toContents(messages, model),
      config: {
        systemInstruction: system,
        ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] } : {}),
        thinkingConfig: thinkingConfig(model, effort),
        maxOutputTokens: 65536,
        abortSignal: ac.signal,
      },
    });
  } catch (e) { cleanup(); throw unavailable(e) || e; }

  try {
    return await consume(stream, emit, resetTimer);
  } catch (e) {
    const u = unavailable(e);
    if (u) throw u;
    throw e;
  } finally { cleanup(); }
}

// emit(type, payload) mirrors the Anthropic stream events the UI understands.
async function consume(stream, emit, onFirstChunk) {
  let emitted = false;
  const rawEmit = emit;
  emit = (t, p) => { emitted = true; rawEmit(t, p); };

  const content = [];   // canonical blocks
  const raw = [];       // exact model parts, replayed verbatim next turn (keeps thought signatures)
  let cur = null;       // { kind: 'text'|'thinking', index }
  let usage = null, finish = null, blocked = null;

  const pushRaw = (p) => {
    const last = raw[raw.length - 1];
    const textual = (x) => x && typeof x.text === 'string' && !x.functionCall;
    if (textual(p) && textual(last) && !!last.thought === !!p.thought && !(last.thoughtSignature && p.thoughtSignature)) {
      last.text += p.text;
      if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
    } else raw.push({ ...p });
  };
  const closeCur = () => { if (cur) { emit('block-stop', { index: cur.index }); cur = null; } };

  try {
    for await (const chunk of stream) {
      onFirstChunk();
      handle(chunk);
    }
  } catch (e) { e.emitted = emitted; throw e; }
  function handle(chunk) {
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason;
    const cand = chunk.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) finish = cand.finishReason;
    for (const p of cand.content?.parts || []) {
      pushRaw(p);
      if (p.functionCall) {
        closeCur();
        const id = p.functionCall.id || 'gfc_' + crypto.randomBytes(6).toString('hex');
        const block = { type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} };
        if (!p.functionCall.id) raw[raw.length - 1] = { ...raw[raw.length - 1], functionCall: { ...p.functionCall, id } };
        content.push(block);
        const index = content.length - 1;
        emit('block-start', { index, blockType: 'tool_use', name: block.name, id });
        emit('input-delta', { index, partial: JSON.stringify(block.input) });
        emit('block-stop', { index });
      } else if (typeof p.text === 'string' && p.text) {
        const kind = p.thought ? 'thinking' : 'text';
        if (!cur || cur.kind !== kind) {
          closeCur();
          content.push(kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' });
          cur = { kind, index: content.length - 1 };
          emit('block-start', { index: cur.index, blockType: kind });
        }
        const b = content[cur.index];
        if (kind === 'text') { b.text += p.text; emit('text-delta', { index: cur.index, text: p.text }); }
        else { b.thinking += p.text; emit('thinking-delta', { index: cur.index, text: p.text }); }
      }
    }
  }
  closeCur();

  const hasTools = content.some((b) => b.type === 'tool_use');
  let stop_reason = 'end_turn';
  let stop_details = null;
  if (blocked || FINISH_REFUSAL.has(finish)) { stop_reason = 'refusal'; stop_details = { category: (blocked || finish).toLowerCase() }; }
  else if (hasTools) stop_reason = 'tool_use';
  else if (finish === 'MAX_TOKENS') stop_reason = 'max_tokens';
  else if (finish === 'MALFORMED_FUNCTION_CALL') throw new Error('Gemini produced a malformed function call (json)');

  const cached = usage?.cachedContentTokenCount || 0;
  return {
    content: content.filter((b) => !(b.type === 'text' && !b.text)),
    raw,
    stop_reason,
    stop_details,
    usage: {
      input_tokens: Math.max(0, (usage?.promptTokenCount || 0) - cached),
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
      output_tokens: (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0),
    },
  };
}

// Google-Search-grounded answer, used as the `web_search` tool for Gemini sessions.
async function webSearch(apiKey, model, query, signal) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 2 } } });
  const chain = [model, ...FALLBACKS.filter((m) => m !== model)];
  let last;
  for (const m of chain) {
    try {
      const r = await ai.models.generateContent({
        model: m,
        contents: `Search the web and answer concisely with concrete facts, versions and code where relevant:\n${query}`,
        config: { tools: [{ googleSearch: {} }], abortSignal: signal },
      });
      const g = r.candidates?.[0]?.groundingMetadata;
      const sources = (g?.groundingChunks || []).map((c) => c.web).filter(Boolean).slice(0, 8);
      return { text: r.text || '(no answer)', sources: sources.map((s) => ({ title: s.title, url: s.uri })) };
    } catch (e) {
      last = e;
      if (signal?.aborted || ![429, 500, 503, 404].includes(e?.status)) throw e;
    }
  }
  throw last;
}

module.exports = { isGemini, listModels, streamTurn, webSearch, FALLBACKS, Unavailable };
