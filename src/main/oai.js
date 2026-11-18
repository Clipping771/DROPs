// OpenAI-compatible providers: OpenAI, DeepSeek, Mistral, Groq, xAI, OpenRouter, Together, Fireworks,
// Cerebras, LM Studio and any custom endpoint. Model ids look like "<provider>:<model>", e.g. "openai:gpt-5".
const OpenAIPkg = require('openai');
const OpenAI = OpenAIPkg.default || OpenAIPkg;
const { parseToolJson } = require('./ollama');

const PROVIDERS = {
  openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', reasoning: true },
  deepseek: { label: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys' },
  mistral: { label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys' },
  groq: { label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', keyUrl: 'https://console.groq.com/keys' },
  xai: { label: 'xAI (Grok)', baseURL: 'https://api.x.ai/v1', env: 'XAI_API_KEY', keyUrl: 'https://console.x.ai' },
  openrouter: { label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys', headers: { 'HTTP-Referer': 'https://github.com/Clipping771/DROPs', 'X-Title': 'DROPs' } },
  together: { label: 'Together AI', baseURL: 'https://api.together.xyz/v1', env: 'TOGETHER_API_KEY', keyUrl: 'https://api.together.ai/settings/api-keys' },
  fireworks: { label: 'Fireworks', baseURL: 'https://api.fireworks.ai/inference/v1', env: 'FIREWORKS_API_KEY', keyUrl: 'https://fireworks.ai/account/api-keys' },
  cerebras: { label: 'Cerebras', baseURL: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', keyUrl: 'https://cloud.cerebras.ai' },
  lmstudio: { label: 'LM Studio (local)', baseURL: 'http://127.0.0.1:1234/v1', noKey: true, local: true },
  custom: { label: 'Custom endpoint', baseURL: '', custom: true },
};

const providerId = (model) => (typeof model === 'string' ? model.split(':')[0] : '');
const isOai = (model) => !!PROVIDERS[providerId(model)];
const bare = (model) => model.slice(model.indexOf(':') + 1);

// settings + key resolver -> { baseURL, apiKey } for a provider
function endpoint(pid, settings, getKey) {
  const p = PROVIDERS[pid];
  const baseURL = (pid === 'custom' ? settings.customBaseUrl : pid === 'lmstudio' ? (settings.lmstudioUrl || p.baseURL) : p.baseURL || '').replace(/\/+$/, '').replace('//localhost', '//127.0.0.1');
  const apiKey = getKey(pid) || (p.noKey || pid === 'custom' ? 'not-needed' : null);
  return { baseURL, apiKey, headers: p.headers };
}

function client(pid, settings, getKey) {
  const { baseURL, apiKey, headers } = endpoint(pid, settings, getKey);
  if (!baseURL) throw Object.assign(new Error('Set the base URL for the custom endpoint in Settings → Providers.'), { needsKey: true });
  if (!apiKey) throw Object.assign(new Error(`No ${PROVIDERS[pid].label} API key. Add it in Settings → Providers.`), { needsKey: true });
  return new OpenAI({ apiKey, baseURL, defaultHeaders: headers, maxRetries: 2, timeout: 10 * 60 * 1000 });
}

// Keep chat-capable models; drop embeddings, audio, image, moderation, etc.
const NON_CHAT = /embed|whisper|tts|audio|transcri|speech|dall-e|image|moderation|rerank|realtime|search-preview|davinci|babbage|guard|vision-preview|ocr|sora|veo/i;
async function listModels(pid, settings, getKey) {
  const c = client(pid, settings, getKey);
  const out = [];
  for await (const m of c.models.list()) {
    const id = m.id;
    if (NON_CHAT.test(id)) continue;
    // OpenRouter tells us which models support tool calling.
    if (pid === 'openrouter' && Array.isArray(m.supported_parameters) && !m.supported_parameters.includes('tools')) continue;
    out.push({ id: `${pid}:${id}`, label: m.name && pid === 'openrouter' ? m.name : id, created: m.created || 0 });
    if (out.length > 400) break;
  }
  out.sort((a, b) => (b.created - a.created) || a.label.localeCompare(b.label));
  return out.slice(0, pid === 'openrouter' ? 120 : 80);
}

// canonical (Anthropic-shaped) transcript -> OpenAI chat messages
function toMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks.filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
      out.push(msg);
    } else {
      for (const b of blocks.filter((x) => x.type === 'tool_result')) {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERROR: ' : '') + text });
      }
      const parts = [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image' && b.source?.data) parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      }
      if (parts.length) out.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
    }
  }
  return out;
}

async function streamOnce({ model, system, messages, tools, effort, signal, emit, settings, getKey, state }) {
  const pid = providerId(model);
  const c = client(pid, settings, getKey);
  const params = {
    model: bare(model), stream: true, messages: toMessages(system, messages),
    ...(tools.length ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })) } : {}),
  };
  const compat = (state.oaiCompat ||= {});
  if (!compat[pid]?.noUsage) params.stream_options = { include_usage: true };
  if (PROVIDERS[pid].reasoning && /^(o\d|gpt-5)/.test(params.model) && !compat[pid]?.noEffort) params.reasoning_effort = effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';

  let stream;
  try { stream = await c.chat.completions.create(params, { signal }); } catch (e) {
    // Some compatible APIs reject optional fields: retry once without them.
    if (e?.status === 400 && (params.stream_options || params.reasoning_effort) && !signal.aborted) {
      compat[pid] = { noUsage: true, noEffort: true };
      delete params.stream_options; delete params.reasoning_effort;
      stream = await c.chat.completions.create(params, { signal });
    } else throw e;
  }

  const content = [];
  let textIdx = -1, thinkIdx = -1, usage = {}, finish = null;
  const calls = new Map(); // index -> { id, name, args, blockIndex }
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const ch = chunk.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (typeof reasoning === 'string' && reasoning) {
      if (thinkIdx < 0) { content.push({ type: 'thinking', thinking: '' }); thinkIdx = content.length - 1; emit('block-start', { index: thinkIdx, blockType: 'thinking' }); }
      content[thinkIdx].thinking += reasoning; emit('thinking-delta', { index: thinkIdx, text: reasoning });
    }
    if (d.content) {
      if (textIdx < 0) {
        if (thinkIdx >= 0) emit('block-stop', { index: thinkIdx });
        content.push({ type: 'text', text: '' }); textIdx = content.length - 1; emit('block-start', { index: textIdx, blockType: 'text' });
      }
      content[textIdx].text += d.content; emit('text-delta', { index: textIdx, text: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const key = tc.index ?? calls.size;
      let c2 = calls.get(key);
      if (!c2) {
        content.push({ type: 'tool_use', id: tc.id || `oa_${Date.now().toString(36)}_${key}`, name: tc.function?.name || '', input: {} });
        c2 = { blockIndex: content.length - 1, args: '' };
        calls.set(key, c2);
        emit('block-start', { index: c2.blockIndex, blockType: 'tool_use', name: content[c2.blockIndex].name, id: content[c2.blockIndex].id });
      }
      if (tc.function?.name && !content[c2.blockIndex].name) content[c2.blockIndex].name = tc.function.name;
      if (tc.function?.arguments) { c2.args += tc.function.arguments; emit('input-delta', { index: c2.blockIndex, partial: tc.function.arguments }); }
    }
  }
  if (textIdx >= 0) emit('block-stop', { index: textIdx }); else if (thinkIdx >= 0) emit('block-stop', { index: thinkIdx });
  for (const c2 of calls.values()) {
    const b = content[c2.blockIndex];
    try { b.input = c2.args ? parseToolJson(c2.args) : {}; } catch { throw new Error(`Malformed tool call JSON from ${model}`); }
    emit('block-stop', { index: c2.blockIndex });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  return {
    content: content.filter((b) => !(b.type === 'text' && !b.text)), model,
    stop_reason: hasTools ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end_turn',
    usage: {
      input_tokens: (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || 0),
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      ...(typeof usage.cost === 'number' ? { cost: usage.cost } : {}),
    },
  };
}

// Rate limits and overloads are normal on free and low-tier keys (OpenRouter free models allow about
// 20 requests a minute). Wait and try again instead of failing the task, as long as nothing has been
// streamed yet (a retry after partial output would show it twice). A daily cap is not worth waiting for.
const RETRY_WAITS_S = [20, 40, 60, 60];
const RETRYABLE = new Set([429, 500, 502, 503]);
const isDailyCap = (e) => /per[- ]day|daily|free-models-per-day/i.test(String(e?.message || '') + JSON.stringify(e?.error || ''));
const waitFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) return reject(new Error('aborted'));
  const t = setTimeout(() => { signal.removeEventListener('abort', on); resolve(); }, ms);
  const on = () => { clearTimeout(t); reject(new Error('aborted')); };
  signal.addEventListener('abort', on, { once: true });
});

async function streamTurn(opts, { waits = RETRY_WAITS_S, once = streamOnce } = {}) {
  for (let attempt = 0; ; attempt++) {
    let emitted = false;
    const emit = (t, p) => { emitted = true; opts.emit(t, p); };
    try {
      return await once({ ...opts, emit });
    } catch (e) {
      const st = e?.status;
      const retryable = RETRYABLE.has(st) && !emitted && !opts.signal.aborted && attempt < waits.length && !(st === 429 && isDailyCap(e));
      if (!retryable) {
        if (st === 429 && isDailyCap(e)) throw Object.assign(new Error(`${PROVIDERS[providerId(opts.model)]?.label || 'Provider'}: daily limit for this model reached. Try again tomorrow, add credits, or pick another model.`), { status: 429 });
        throw e;
      }
      opts.emit('notice', { message: `${bare(opts.model)}: ${st === 429 ? 'rate limit reached' : 'temporarily unavailable'}; waiting ${waits[attempt]}s before trying again (${attempt + 1}/${waits.length}).` });
      await waitFor(waits[attempt] * 1000, opts.signal);
    }
  }
}

function friendly(err, model) {
  const label = PROVIDERS[providerId(model)]?.label || 'Provider';
  const st = err?.status;
  if (st === 401 || st === 403) return { message: `${label} rejected the API key (${st}). Check it in Settings → Providers.`, needsKey: true };
  if (st === 402) return { message: `${label}: out of credits or billing not set up (402). Add credits in your ${label} account.` };
  if (st === 429 && /daily limit for this model reached/.test(err.message || '')) return { message: err.message };
  if (st === 429) return { message: `${label} rate limit or quota reached. Wait a moment, or pick another model.` };
  if (st === 404) return { message: `${label}: model "${bare(model)}" was not found (404). Pick another model from the list.` };
  if (st === 400 && /tool|function/i.test(err.message || '')) return { message: `${label}: the model "${bare(model)}" does not support tool calling, which DROPs needs. Pick a different model.` };
  if (!st && /ECONNREFUSED|fetch failed|Connection error/i.test(err?.message || '')) return { message: `Cannot reach ${label}${PROVIDERS[providerId(model)]?.local ? ' — is the local server running?' : ''}.` };
  return null;
}

module.exports = { PROVIDERS, providerId, isOai, listModels, streamTurn, friendly, endpoint };
