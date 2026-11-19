// @ts-check
// One interface over Claude (Anthropic) and Gemini.
// callModel() streams a turn and returns a canonical, Anthropic-shaped message:
//   { content: [blocks], raw?, model, stop_reason, stop_details, usage }
const Anthropic = require('@anthropic-ai/sdk');
const gemini = require('./gemini');
const ollama = require('./ollama');
const oai = require('./oai');

const CLAUDE = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', in: 4, out: 20, web: true, fallback: true, ctx: 1_000_000 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', in: 2, out: 10, web: true, fallback: true, ctx: 1_000_000 },
  'claude-fable-5-2': { label: 'Claude Fable 5.2', in: 8, out: 40, web: true, fallback: true, ctx: 1_000_000 },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', in: 0.1, out: 0.5, web: false, fallback: false, ctx: 1_000_000 },
};
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const providerOf = (model) => (ollama.isOllama(model) ? 'ollama' : oai.isOai(model) ? 'oai' : gemini.isGemini(model) ? 'gemini' : 'anthropic');

// ---------- Auto routing ----------
// Cheapest capable tier first; escalate when the task proves hard (failed checks, loops, errors).
const TIERS = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  gemini: ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-4-hydrogen'],
  ollama: ['ollama:muse-glimmer:latest', 'ollama:muse-glimmer:latest', 'ollama:muse-glimmer:latest'],
};
function autoProvider(settings = {}) {
  const pref = settings.autoProvider;
  if (pref === 'anthropic' && settings.hasAnthropic) return 'anthropic';
  if (pref === 'gemini' && settings.hasGemini) return 'gemini';
  if (pref === 'ollama') return 'ollama';
  if (settings.hasAnthropic) return 'anthropic';
  if (settings.hasGemini) return 'gemini';
  if (settings.ollamaEnabled) return 'ollama';
  return 'gemini';
}
// 0 = quick question / small change, 1 = normal coding task, 2 = large or hard task.
function initialTier(prompt) {
  const p = prompt.toLowerCase();
  const hard = /\b(refactor|architecture|redesign|migrat|rewrite|concurren|race condition|deadlock|memory leak|performance|security|across the (code|repo)|entire|whole (project|codebase)|from scratch|build (an?|the) (app|system|service)|implement .{0,40}(system|engine|framework))/.test(p);
  const trivial = /^(what|why|how|where|which|explain|show|list|find|is|are|does|can)\b/.test(p) && p.length < 220 && !/\b(fix|add|implement|change|write|create|update|refactor)\b/.test(p);
  if (hard || prompt.length > 1500) return 2;
  if (trivial) return 0;
  return 1;
}
const resolveAuto = (settings = {}, tier = 1) => {
  const prov = autoProvider(settings);
  const ollamaModel = /** @type {any} */ (settings).ollamaDefaultModel;
  if (prov === 'ollama' && ollamaModel) return ollamaModel;
  return TIERS[prov][Math.max(0, Math.min(2, tier))];
};

/** Classifies a user prompt into a coarse task category for historical model routing. */
function inferTaskCategory(prompt = '') {
  const p = String(prompt || '');
  if (/\b(bug|fix|broken|crash|error|fail|regression)\b/i.test(p)) return 'bugfix';
  if (/\b(refactor|clean ?up|extract|modular|rename|reorganize)\b/i.test(p)) return 'refactor';
  if (/\b(test|spec|coverage|benchmark)\b/i.test(p)) return 'test';
  if (/\b(add|implement|build|create|feature|support)\b/i.test(p)) return 'feature';
  if (/^(what|why|how|where|which|explain|show|list)\b/i.test(p.trim())) return 'question';
  return 'general';
}

/**
 * Scores a model candidate using historical verified pass rate and cost-per-success.
 * Higher is better; returns null when insufficient samples (< 3) exist.
 */
function scoreModelCandidate(stat) {
  if (!stat || (stat.total || 0) < 3) return null;
  const passRate = (stat.passed || 0) / stat.total;
  const costPerSuccess = stat.passed > 0 ? (stat.totalCost || 0) / stat.passed : (stat.totalCost || 1);
  return passRate * 100 - costPerSuccess * 25;
}

/**
 * Selects the lowest-cost model that maintains high verified success for the task tier,
 * using historical performance stats when available and falling back to resolveAuto().
 */
function selectOptimalModel({ prompt = '', category = '', settings = {}, stats = {} } = {}) {
  const tier = initialTier(prompt);
  const prov = autoProvider(settings);
  const ollamaModel = /** @type {any} */ (settings).ollamaDefaultModel;
  if (prov === 'ollama' && ollamaModel) return ollamaModel;
  const candidates = TIERS[prov] || TIERS.gemini;
  const scored = candidates.map((m, idx) => {
    const key = category ? `${m}::${category}` : m;
    const s = stats[key] || stats[m];
    return { model: m, idx, score: scoreModelCandidate(s), passRate: s?.total ? (s.passed || 0) / s.total : null };
  }).filter((x) => x.score !== null);
  if (!scored.length) return resolveAuto(settings, tier);
  // Prefer the cheapest tier that achieves >= 80% verified pass rate,
  // or otherwise pick the highest cost-adjusted score.
  const reliableCheap = scored.find((x) => (x.passRate || 0) >= 0.8);
  if (reliableCheap) return reliableCheap.model;
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored[0].model;
}
const cheapModelFor = (model, settings = {}) => {
  const prov = model === 'auto' ? autoProvider(settings) : providerOf(model);
  if (prov === 'ollama' && model !== 'auto') return model;
  return TIERS[prov] ? TIERS[prov][0] : model;
};
const contextWindow = (model, settings = {}) => {
  if (providerOf(model) === 'ollama') return ollama.effectiveCtx(model, settings?.ollamaCtx || 16384);
  return CLAUDE[model]?.ctx || 1_000_000;
};

const MODEL_PRICES = {
  'gemini-4-hydrogen': { in: 1.25, out: 5 },
  'gemini-3.8-flash': { in: 0.3, out: 1.2 },
  'gemini-3.6-flash': { in: 0.15, out: 0.6 },
  'gemini-3.5-flash': { in: 0.15, out: 0.6 },
  'gemini-3.5-flash-lite': { in: 0.075, out: 0.3 },
  'gemini-3.1-flash-lite': { in: 0.075, out: 0.3 },
  'gpt-5': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  o3: { in: 2, out: 8 },
  'o4-mini': { in: 1.1, out: 4.4 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'deepseek/deepseek-v4-flash': { in: 0.09, out: 0.18 },
  'deepseek/deepseek-v4.1-flash-1017': { in: 0.036, out: 0.5 },
  'deepseek/deepseek-chat': { in: 0.27, out: 1.1 },
  'qwen/qwen3.7-flash': { in: 0.03, out: 0.13 },
  'google/gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
};
const PRICE_PREFIXES = Object.entries(MODEL_PRICES).sort((a, b) => b[0].length - a[0].length);

function costOf(model, u) {
  if (!model || ollama.isOllama(model) || oai.providerId(model) === 'lmstudio') return 0;
  if (typeof u?.cost === 'number' && Number.isFinite(u.cost)) return u.cost;
  const bare = model.includes(':') ? model.slice(model.indexOf(':') + 1) : model;
  const p = CLAUDE[model] || MODEL_PRICES[bare] || PRICE_PREFIXES.find(([k]) => bare.startsWith(k))?.[1];
  if (!p) return null;
  return ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out +
    (u.cache_read_input_tokens || 0) * p.in * 0.1 + (u.cache_creation_input_tokens || 0) * p.in * 1.25) / 1e6;
}

// Strip provider-private data so a transcript is valid for the Anthropic API.
function anthropicMessages(messages) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const content = m.content
      .filter((b) => !(b.type === 'thinking' && !b.signature))
      .map((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith('_'))));
    return { role: m.role, content: content.length ? content : [{ type: 'text', text: '(no content)' }] };
  });
}

function anthropicClient(deps) {
  const key = deps.getApiKey();
  if (!key) throw Object.assign(new Error('No Anthropic API key set. Open Settings and add one, or pick a Gemini model.'), { needsKey: true });
  const AnthropicCtor = /** @type {any} */ (Anthropic).default || /** @type {any} */ (Anthropic);
  return new AnthropicCtor({ apiKey: key, maxRetries: 3 });
}

async function anthropicTurn({ model, system, messages, tools, effort, signal, emit, deps, state, web = true }) {
  const m = CLAUDE[model] || CLAUDE['claude-opus-5-5'];
  const client = anthropicClient(deps);
  for (; ;) {
    const serverWeb = web && m.web && !state.compat;
    // Claude has its own server-side web_search/web_fetch; drop the client-side tool of the same
    // name so the request never carries two tools called "web_search".
    const toolList = tools.filter((t) => !(serverWeb && (t.name === 'web_search' || t.name === 'web_fetch'))).map((t) => ({ ...t, eager_input_streaming: true }));
    if (serverWeb) {
      toolList.push({ type: 'web_search_20260209', name: 'web_search', max_uses: 8 });
      toolList.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8 });
    }
    const p = {
      model, max_tokens: 64000, system, messages: anthropicMessages(messages), tools: toolList,
      thinking: state.compat ? { type: 'adaptive' } : { type: 'adaptive', display: 'summarized' },
      output_config: { effort: EFFORTS.includes(effort) ? effort : 'high' },
    };
    if (!toolList.length) delete p.tools;
    if (!state.compat) {
      p.cache_control = { type: 'ephemeral' };
      if (m.fallback) { p.betas = ['server-side-fallback-2026-07-01']; p.fallbacks = 'default'; }
    }
    try {
      const stream = client.beta.messages.stream(p, { signal });
      for await (const ev of stream) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          const payload = { index: ev.index, blockType: b.type, name: b.name, id: b.id };
          if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) payload.results = b.content.slice(0, 8).map((r) => ({ title: r.title, url: r.url }));
          emit('block-start', payload);
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta;
          if (d.type === 'text_delta') emit('text-delta', { index: ev.index, text: d.text });
          else if (d.type === 'thinking_delta') emit('thinking-delta', { index: ev.index, text: d.thinking });
          else if (d.type === 'input_json_delta') emit('input-delta', { index: ev.index, partial: d.partial_json });
        } else if (ev.type === 'content_block_stop') emit('block-stop', { index: ev.index });
      }
      const msg = await stream.finalMessage();
      for (const b of msg.content) if (b.type === 'fallback') emit('notice', { message: `${b.from?.model} declined; continued on ${b.to?.model}.` });
      return { content: msg.content, model, stop_reason: msg.stop_reason, stop_details: msg.stop_details, usage: msg.usage || {} };
    } catch (err) {
      if (!signal.aborted && err instanceof Anthropic.BadRequestError && !state.compat) {
        state.compat = true;
        emit('notice', { message: 'The API rejected an advanced option; retrying in compatibility mode.' });
        continue;
      }
      throw err;
    }
  }
}

// ---- Fallback chain across providers ------------------------------------------------------------
// settings.fallbackModels (e.g. free models on other providers, then a local model) is tried in order
// when the chosen model is out of quota, rate-limited, out of credit or unreachable. A model that ran
// out is skipped for a while so later turns go straight to one that works.
const exhaustedUntil = new Map();
function isCapacityError(e) {
  const msg = String(e?.message || e);
  return [0, 402, 408, 429, 500, 502, 503, 504, 529].includes(e?.status)
    || /quota|rate.?limit|credits?|overloaded|busy|unavailable|cannot reach|ECONNREFUSED|timed? ?out|no response/i.test(msg);
}
function cooldownMs(e) {
  return /daily|per.?day|credits?|\b402\b|quota/i.test(String(e?.message || e)) || e?.status === 402 ? 6 * 3600_000 : 2 * 60_000;
}

// A short outage (overloaded, 5xx, dropped connection, a per-minute rate limit) should not end the turn.
// Retried only when nothing has streamed yet, so the user never sees a reply twice. Quota and credit
// errors are not retried here: they go to the fallback chain.
const RETRY_DELAYS = [2000, 6000];
function isTransientError(e) {
  const msg = String(e?.message || e);
  if (/quota|daily|per.?day|credits?|billing|api.?key|unauthori[sz]ed|invalid/i.test(msg) || [400, 401, 402, 403, 404].includes(e?.status)) return false;
  return [408, 429, 500, 502, 503, 504, 529].includes(e?.status)
    || /overloaded|temporarily|try again|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network|terminated|timed? ?out|no response/i.test(msg);
}
async function callWithRetry(opts) {
  for (let attempt = 0; ; attempt++) {
    let streamed = false;
    const emit = (type, p) => { if (/delta|block-start/.test(type)) streamed = true; opts.emit?.(type, p); };
    try {
      return await callOne({ ...opts, emit });
    } catch (e) {
      if (opts.signal?.aborted || streamed || attempt >= RETRY_DELAYS.length || !isTransientError(e)) throw e;
      const wait = RETRY_DELAYS[attempt];
      opts.emit?.('notice', { message: `${opts.model}: ${String(e.message || e).split('\n')[0].slice(0, 100)}. Trying again in ${wait / 1000}s…` });
      await new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), wait);
        opts.signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
      });
      if (opts.signal?.aborted) throw e;
    }
  }
}

async function callModel(opts) {
  const fallbacks = (opts.deps?.getSettings?.()?.fallbackModels || []).filter((m) => m && m !== opts.model);
  if (!fallbacks.length) return callWithRetry(opts);
  const chain = [opts.model, ...fallbacks];
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i], last = i === chain.length - 1;
    if (!last && (exhaustedUntil.get(model) || 0) > Date.now()) continue;
    try {
      const res = await callWithRetry({ ...opts, model });
      if (!res.model) res.model = model;
      return res;
    } catch (e) {
      if (opts.signal?.aborted || !isCapacityError(e) || last) throw e;
      lastErr = e;
      exhaustedUntil.set(model, Date.now() + cooldownMs(e));
      opts.emit?.('notice', { message: `${model}: ${String(e.message).split('\n')[0].slice(0, 120)} — falling back to ${chain[i + 1]}.` });
    }
  }
  throw lastErr || new Error('No model in the fallback chain could answer.');
}

async function callOne(opts) {
  if (providerOf(opts.model) === 'oai') {
    return oai.streamTurn({ ...opts, settings: opts.deps.getSettings(), getKey: (id) => opts.deps.getProviderKey?.(id) });
  }
  if (providerOf(opts.model) === 'ollama') {
    const st = opts.deps.getSettings();
    return ollama.streamTurn({
      ...opts,
      baseUrl: (st.ollamaUrl || 'http://localhost:11434').replace(/\/+$/, ''),
      numCtx: ollama.effectiveCtx(opts.model, st.ollamaCtx || 16384),
      effort: opts.effort,
    });
  }
  if (providerOf(opts.model) === 'gemini') {
    const apiKey = opts.deps.getGeminiKey();
    if (!apiKey) throw Object.assign(new Error('No Gemini API key set. Open Settings and add one.'), { needsKey: true });
    return gemini.streamTurn({ ...opts, apiKey });
  }
  return anthropicTurn(opts);
}

// Plain, tool-less completion (summaries, commit messages). Returns text.
async function complete({ model, system, prompt, deps, signal = new AbortController().signal, effort }) {
  const eff = effort !== undefined ? effort : (providerOf(model) === 'ollama' ? false : 'low');
  const res = await callModel({
    model, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [],
    effort: eff, signal, emit: () => { }, deps, state: { compat: false }, web: false,
  });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

function friendlyError(err, model) {
  let msg = err?.message || String(err);
  if (providerOf(model) === 'oai') { const f = oai.friendly(err, model); if (f) return f; }
  if (providerOf(model) === 'ollama') { const f = ollama.friendly(err, model); if (f) return f; }
  if (err instanceof Anthropic.AuthenticationError) return { message: 'Invalid Anthropic API key. Open Settings to update it.', needsKey: true };
  if (err instanceof Anthropic.RateLimitError) return { message: 'Rate limited by the Anthropic API. Wait a moment and send again.' };
  if (err instanceof Anthropic.APIConnectionError) return { message: 'Could not reach the Anthropic API. Check your internet connection.' };
  if (providerOf(model) === 'gemini' && err?.status) {
    if (err.status === 429) return { message: msg };
    if (err.status === 401 || err.status === 403 || /API_KEY|API key/i.test(msg)) return { message: `The Gemini API key was rejected (HTTP ${err.status}: ${msg.slice(0, 200)}). Open Settings to update it.`, needsKey: true };
    return { message: `Gemini API error ${err.status}: ${msg.slice(0, 400)}` };
  }
  return { message: msg, needsKey: !!err?.needsKey };
}

module.exports = { TIERS, autoProvider, initialTier, inferTaskCategory, resolveAuto, scoreModelCandidate, selectOptimalModel, cheapModelFor, CLAUDE, EFFORTS, providerOf, contextWindow, costOf, callModel, complete, friendlyError, isGemini: gemini.isGemini, isCapacityError, isTransientError, exhaustedUntil };
