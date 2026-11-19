// @ts-check
// Scheduled tasks: a prompt that runs by itself in a new session, once or on a repeat.
//   { id, name, prompt, projectDir, model, effort, mode, repeat, time: "09:00", weekday: 1, at, enabled, nextRun, lastRun }
// repeat: once (at a date and time) | hourly (at minute MM of `time`) | daily | weekdays (Mon–Fri) | weekly (on `weekday`, 0 = Sunday).
// A run missed while DROPs was closed happens once when it opens again, not once per missed time.
const crypto = require('crypto');

const REPEATS = ['once', 'hourly', 'daily', 'weekdays', 'weekly'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function parseTime(t) {
  const m = String(t || '09:00').match(/^(\d{1,2}):(\d{2})$/);
  const h = m ? Math.min(23, +m[1]) : 9, min = m ? Math.min(59, +m[2]) : 0;
  return [h, min];
}

/** The next time strictly after `from` (ms), or null for a finished one-off. */
function nextRun(s, from = Date.now()) {
  const [h, min] = parseTime(s.time);
  if (s.repeat === 'once') { const at = +s.at || 0; return at > from ? at : null; }
  const d = new Date(from);
  if (s.repeat === 'hourly') {
    const c = new Date(d); c.setMinutes(min, 0, 0);
    if (c.getTime() <= from) c.setHours(c.getHours() + 1);
    return c.getTime();
  }
  for (let i = 0; i < 9; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, min, 0, 0);
    if (c.getTime() <= from) continue;
    const wd = c.getDay();
    if (s.repeat === 'weekdays' && (wd === 0 || wd === 6)) continue;
    if (s.repeat === 'weekly' && wd !== (Number.isInteger(+s.weekday) ? +s.weekday : 1)) continue;
    return c.getTime();
  }
  return null;
}

function describe(s) {
  const t = String(s.time || '09:00');
  if (s.repeat === 'once') return s.at ? `once, ${new Date(+s.at).toLocaleString()}` : 'once';
  if (s.repeat === 'hourly') return `every hour at :${t.split(':')[1] || '00'}`;
  if (s.repeat === 'weekdays') return `weekdays at ${t}`;
  if (s.repeat === 'weekly') return `every ${DAYS[+s.weekday || 0]} at ${t}`;
  return `every day at ${t}`;
}

/** Checks and fills in a schedule from the UI or the agent. Throws a readable error. */
function normalize(input, defaults = {}) {
  const s = { ...defaults, ...input };
  s.name = String(s.name || '').trim().slice(0, 80);
  s.prompt = String(s.prompt || '').trim().slice(0, 20000);
  if (!s.prompt) throw new Error('A scheduled task needs a prompt: what DROPs should do.');
  if (!s.name) s.name = s.prompt.replace(/\s+/g, ' ').slice(0, 50);
  if (!s.projectDir) throw new Error('A scheduled task needs a project folder.');
  s.repeat = REPEATS.includes(s.repeat) ? s.repeat : 'daily';
  if (!/^\d{1,2}:\d{2}$/.test(String(s.time || ''))) s.time = '09:00';
  if (s.repeat === 'once') {
    const at = typeof s.at === 'string' ? Date.parse(s.at) : +s.at;
    if (!Number.isFinite(at)) throw new Error('A one-time task needs a date and time.');
    s.at = at;
  }
  if (s.repeat === 'weekly') s.weekday = Number.isInteger(+s.weekday) ? ((+s.weekday % 7) + 7) % 7 : 1;
  s.id = s.id || crypto.randomBytes(6).toString('hex');
  s.enabled = s.enabled !== false;
  s.mode = ['plan', 'ask', 'auto-edit', 'yolo'].includes(s.mode) ? s.mode : 'auto-edit';
  s.nextRun = nextRun(s);
  if (s.repeat === 'once' && !s.nextRun) throw new Error('That time has already passed.');
  return s;
}

/**
 * Runs due schedules. deps: list() → schedules, save(list), run(schedule) → Promise (starts it),
 * now() for tests. Checks every `every` ms.
 */
class Scheduler {
  constructor(deps, every = 30_000) { this.deps = deps; this.every = every; this.timer = null; this.busy = false; }
  start() { this.stop(); this.tick(); this.timer = setInterval(() => this.tick(), this.every); this.timer.unref?.(); }
  stop() { clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      const now = (this.deps.now || Date.now)();
      const list = this.deps.list() || [];
      let changed = false;
      for (const s of list) {
        if (s.enabled === false || !s.nextRun || s.nextRun > now) continue;
        s.lastRun = now; s.nextRun = nextRun(s, now + 1000);
        if (!s.nextRun) s.enabled = false;
        changed = true;
        try { await this.deps.run(s); s.lastError = null; } catch (e) { s.lastError = String(e.message || e).slice(0, 200); }
      }
      if (changed) this.deps.save(list);
    } finally { this.busy = false; }
  }
}

module.exports = { REPEATS, nextRun, describe, normalize, Scheduler };
