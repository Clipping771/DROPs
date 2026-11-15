// Session exports: Markdown transcript, self-contained HTML review report, and shareable JSON.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const blocksOf = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || []);
const isInternal = (t) => /^\[(DROPs verification guard|Request interrupted|Context summary)/.test(t);

function toMarkdown(data) {
  const lines = [`# ${data.title}`, '', `Project: \`${data.projectDir}\``, ''];
  for (const m of [...(data.archive || []), ...data.messages]) {
    for (const b of blocksOf(m)) {
      if (b.type === 'text' && !isInternal(b.text)) lines.push(`**${m.role === 'user' ? 'You' : 'DROPs'}:** ${b.text}`, '');
      else if (b.type === 'tool_use') lines.push(`> \`${b.name}\` ${JSON.stringify(b.input).slice(0, 200)}`, '');
    }
  }
  return lines.join('\n');
}

// Shareable session: strips provider-private data and image payloads; keeps transcript, diffs and plan.
function toShareJson(data) {
  const clean = (m) => ({ role: m.role, content: blocksOf(m).filter((b) => b.type !== 'thinking').map((b) => (b.type === 'image' ? { type: 'text', text: '[image]' } : Object.fromEntries(Object.entries(b).filter(([k]) => !k.startsWith('_'))))) });
  return JSON.stringify({
    h2oSession: 1, title: data.title, exported: new Date().toISOString(), model: data.model,
    messages: [...(data.archive || []), ...data.messages].map(clean), toolMeta: data.toolMeta, todos: data.todos, changes: data.changes, usage: data.usage,
  }, null, 2);
}

function diffHtml(d) {
  if (!d?.hunks) return '';
  const rows = d.hunks.map((h) => `<tr class="hh"><td colspan="3">${esc(h.header)}</td></tr>` + h.lines.map((l) => `<tr class="${l.t === '+' ? 'a' : l.t === '-' ? 'd' : ''}"><td class="n">${l.o ?? ''}</td><td class="n">${l.n ?? ''}</td><td><code>${l.t === ' ' ? ' ' : l.t}${esc(l.s)}</code></td></tr>`).join('')).join('');
  return `<table class="diff">${rows}</table>`;
}

function mdLite(text) {
  return esc(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, l, c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6} (.*)$/gm, '<h4>$1</h4>')
    .replace(/^[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}

function toHtml(data) {
  const parts = [];
  for (const m of [...(data.archive || []), ...data.messages]) {
    for (const b of blocksOf(m)) {
      if (b.type === 'text' && !isInternal(b.text)) parts.push(`<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? 'You' : 'DROPs'}</div><div class="body">${mdLite(b.text)}</div></div>`);
      else if (b.type === 'tool_use' && b.name !== 'todo_write') {
        const meta = data.toolMeta?.[b.id] || {};
        const summary = meta.summary || b.input?.path || b.input?.command || '';
        const st = meta.status === 'done' ? 'ok' : meta.status === 'error' || meta.status === 'denied' ? 'bad' : '';
        const out = meta.diff ? diffHtml(meta.diff) : meta.output ? `<pre>${esc(String(meta.output).slice(0, 4000))}</pre>` : '';
        parts.push(`<details class="tool ${st}"${meta.diff ? ' open' : ''}><summary><b>${esc(b.name)}</b> <span>${esc(summary)}</span>${meta.diff ? ` <i class="a">+${meta.diff.added}</i> <i class="d">−${meta.diff.removed}</i>` : ''}</summary>${out}</details>`);
      }
    }
  }
  const changes = Object.entries(data.changes || {}).map(([f, c]) => `<li><code>${esc(f)}</code> <i class="a">+${c.added}</i> <i class="d">−${c.removed}</i></li>`).join('');
  const todos = (data.todos || []).map((t) => `<li class="${t.status}">${t.status === 'completed' ? '✓' : '○'} ${esc(t.content)}</li>`).join('');
  const u = data.usage || {};
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(data.title)} — DROPs review</title>
<style>
:root{--bg:#fff;--fg:#18181b;--mut:#6b6b76;--line:#e5e5ea;--card:#fafafb;--add:#16a34a1a;--del:#dc26261a;--acc:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c0f;--fg:#ececef;--mut:#8a8a96;--line:#ffffff14;--card:#131418;--add:#4ade8020;--del:#f8717120;--acc:#60a5fa}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 'Segoe UI',system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:32px 20px}
h1{font-size:22px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:24px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:12px 14px}.card h3{margin:0 0 6px;font-size:12px;text-transform:uppercase;color:var(--mut);letter-spacing:.06em}
ul{margin:0;padding-left:18px}li.completed{color:var(--mut)}.msg{margin:14px 0}.who{font-size:12px;color:var(--mut);font-weight:600}.msg.user .body{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
code{font-family:'Cascadia Code',Consolas,monospace;font-size:12.5px;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto;font-size:12px}pre code{border:0;padding:0}
details.tool{border:1px solid var(--line);border-radius:8px;margin:6px 0;background:var(--card)}details.tool summary{padding:6px 10px;cursor:pointer}details.tool summary span{color:var(--mut);font-family:Consolas,monospace;font-size:12px}
details.tool.bad{border-color:#dc262666}.a{color:#16a34a;font-style:normal}.d{color:#dc2626;font-style:normal}
table.diff{width:100%;border-collapse:collapse;font:12px Consolas,monospace}table.diff td{padding:0 6px;white-space:pre-wrap;word-break:break-all}table.diff td code{border:0;background:none;padding:0}
table.diff td.n{color:var(--mut);text-align:right;width:36px;user-select:none}tr.a{background:var(--add)}tr.d{background:var(--del)}tr.hh td{color:var(--mut);background:var(--card)}
footer{color:var(--mut);font-size:12px;margin-top:32px;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><main>
<h1>${esc(data.title)}</h1><div class="sub">DROPs session review · ${esc(new Date().toLocaleString())}${data.model ? ` · model ${esc(data.model)}` : ''}</div>
<div class="grid"><div class="card"><h3>Files changed</h3>${changes ? `<ul>${changes}</ul>` : '<span class="sub">none</span>'}</div><div class="card"><h3>Plan</h3>${todos ? `<ul style="list-style:none;padding:0">${todos}</ul>` : '<span class="sub">none</span>'}</div></div>
${parts.join('\n')}
<footer>Tokens: ${(u.input || 0) + (u.cacheRead || 0)} in / ${u.output || 0} out${u.cost ? ` · cost $${u.cost.toFixed(3)}` : ''} · Generated by DROPs</footer>
</main></body></html>`;
}

module.exports = { toMarkdown, toHtml, toShareJson };
