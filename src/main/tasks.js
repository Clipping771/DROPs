// Independent persistent task management and background execution architecture.
// Every coding task has an independent lifecycle, independent AbortController,
// persistent state, and event stream. Sending new chat messages queues by default,
// steers on explicit request, or runs in an independent side chat.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const brand = require('./brand');

const TASKS_DIR = () => path.join(brand.appDataDir(), 'tasks');
const INDEX_FILE = () => path.join(TASKS_DIR(), 'index.json');

const STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_FOR_APPROVAL: 'waiting_for_approval',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

class TaskManager {
  constructor(deps = {}) {
    this.deps = deps; // { getAgent, sendEvent, store }
    this.activeTasks = new Map(); // taskId -> { task, abort, promise, processIds: Set }
    this.queues = new Map(); // sessionId -> [taskId]
    this.subscribers = new Map(); // taskId -> Set(fn)
    this.eventLogs = new Map(); // taskId -> [{ seq, timestamp, type, payload }]
    this.seqCounters = new Map(); // taskId -> int
    this.ensureDirs();
    this.recoverStaleTasks();
    this.pruneOrphans();
  }

  /** The index keeps the newest 200 tasks; the files of tasks it no longer lists (older than a day) are
   *  removed, so the tasks folder does not grow forever. The app never shows them anyway. */
  pruneOrphans(maxAgeMs = 24 * 3600_000) {
    try {
      const listed = new Set(this.readIndex().tasks.map((t) => `${t.task_id}.json`));
      const cutoff = Date.now() - maxAgeMs;
      let removed = 0;
      for (const f of fs.readdirSync(TASKS_DIR())) {
        if (!/^task_[\w-]+\.json$/.test(f) || listed.has(f)) continue;
        const full = path.join(TASKS_DIR(), f);
        try { if (fs.statSync(full).mtimeMs < cutoff) { fs.rmSync(full); removed++; } } catch { /* in use */ }
      }
      return removed;
    } catch { return 0; }
  }

  ensureDirs() {
    try {
      fs.mkdirSync(TASKS_DIR(), { recursive: true });
      if (!fs.existsSync(INDEX_FILE())) {
        fs.writeFileSync(INDEX_FILE(), JSON.stringify({ tasks: [] }, null, 2), 'utf8');
      }
    } catch (e) {
      console.error('TaskManager: failed to ensure dirs:', e.message);
    }
  }

  // Crash / restart recovery. A task that was running when the app stopped is marked failed (never
  // falsely claimed running). A message still waiting in the queue is kept: it goes back into its
  // session's queue, in order, and waits for the user to run or cancel it (nothing starts by itself).
  recoverStaleTasks() {
    try {
      const index = this.readIndex();
      let changed = false;
      const waiting = index.tasks.filter((e) => e.status === STATUS.QUEUED).sort((a, b) => a.created_at - b.created_at);
      for (const entry of waiting) {
        if (!this.queues.has(entry.session_id)) this.queues.set(entry.session_id, []);
        this.queues.get(entry.session_id).push(entry.task_id);
        entry.restored = true;
        changed = true;
        const f = path.join(TASKS_DIR(), `${entry.task_id}.json`);
        try { const full = JSON.parse(fs.readFileSync(f, 'utf8')); full.restored = true; fs.writeFileSync(f, JSON.stringify(full, null, 2), 'utf8'); } catch {}
      }
      for (const entry of index.tasks) {
        if (entry.status === STATUS.RUNNING) {
          entry.status = STATUS.FAILED;
          entry.error_info = 'Worker process terminated unexpectedly (app restart or crash)';
          entry.completed_at = Date.now();
          changed = true;
          // Also update individual task file if it exists
          const f = path.join(TASKS_DIR(), `${entry.task_id}.json`);
          if (fs.existsSync(f)) {
            try {
              const full = JSON.parse(fs.readFileSync(f, 'utf8'));
              full.status = STATUS.FAILED;
              full.error_info = entry.error_info;
              full.completed_at = entry.completed_at;
              fs.writeFileSync(f, JSON.stringify(full, null, 2), 'utf8');
            } catch {}
          }
        }
      }
      if (changed) this.writeIndex(index);
    } catch (e) {
      console.error('TaskManager: stale recovery error:', e.message);
    }
  }

  readIndex() {
    try {
      if (fs.existsSync(INDEX_FILE())) {
        return JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8'));
      }
    } catch {}
    return { tasks: [] };
  }

  writeIndex(index) {
    try {
      fs.writeFileSync(INDEX_FILE(), JSON.stringify(index, null, 2), 'utf8');
    } catch (e) {
      console.error('TaskManager: writeIndex failed:', e.message);
    }
  }

  saveTask(task) {
    try {
      fs.writeFileSync(path.join(TASKS_DIR(), `${task.task_id}.json`), JSON.stringify(task, null, 2), 'utf8');
      const index = this.readIndex();
      const existingIdx = index.tasks.findIndex((t) => t.task_id === task.task_id);
      const summary = {
        task_id: task.task_id,
        session_id: task.session_id,
        conversation_id: task.conversation_id,
        workspace_id: task.workspace_id,
        agent_id: task.agent_id,
        parent_task_id: task.parent_task_id,
        title: task.title,
        status: task.status,
        created_at: task.created_at,
        started_at: task.started_at,
        completed_at: task.completed_at,
        error_info: task.error_info,
        progress: task.progress,
        idempotency_key: task.idempotency_key,
      };
      if (existingIdx >= 0) index.tasks[existingIdx] = summary;
      else index.tasks.unshift(summary);
      if (index.tasks.length > 200) index.tasks = index.tasks.slice(0, 200);
      this.writeIndex(index);
    } catch (e) {
      console.error('TaskManager: saveTask failed:', e.message);
    }
  }

  getTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active) return active.task;
    try {
      const f = path.join(TASKS_DIR(), `${taskId}.json`);
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {}
    return null;
  }

  listTasks(filter = {}) {
    const index = this.readIndex();
    return index.tasks.filter((t) => {
      if (filter.session_id && t.session_id !== filter.session_id) return false;
      if (filter.status && t.status !== filter.status) return false;
      return true;
    });
  }

  // Create an independent task
  createTask({
    session_id,
    conversation_id,
    workspace_id,
    agent_id = 'primary',
    parent_task_id = null,
    prompt,
    images = [],
    opts = {},
    idempotency_key = null,
  }) {
    // Idempotency check: avoid duplicate execution
    if (idempotency_key) {
      const existing = this.listTasks().find((t) => t.idempotency_key === idempotency_key && t.status !== STATUS.FAILED && t.status !== STATUS.CANCELLED);
      if (existing) return this.getTask(existing.task_id);
    }

    const taskId = 'task_' + crypto.randomUUID();
    const task = {
      task_id: taskId,
      session_id,
      conversation_id: conversation_id || session_id,
      workspace_id,
      agent_id,
      parent_task_id,
      title: prompt.trim().split('\n')[0].slice(0, 80) || 'Coding task',
      prompt,
      images,
      opts: { ...opts },
      status: STATUS.PENDING,
      progress: { percent: 0, step: 0, maxSteps: opts.maxSteps || 250, currentAction: 'Pending' },
      created_at: Date.now(),
      started_at: null,
      completed_at: null,
      error_info: null,
      execution_metadata: { toolCalls: 0, durationMs: 0, cost: 0, tokens: {} },
      checkpoint_data: {},
      idempotency_key,
    };

    this.saveTask(task);
    return task;
  }

  // Submit a task into the system. If session has an active running task,
  // queue it by default, unless action === 'steer' or concurrent === true.
  async submitTask(taskParams, { action = 'queue', concurrent = false, front = false } = {}) {
    const task = this.createTask(taskParams);
    const sid = task.session_id;

    if (!this.queues.has(sid)) this.queues.set(sid, []);
    const queue = this.queues.get(sid);

    const isRunning = this.isSessionRunning(sid);

    if (action === 'steer' && isRunning) {
      // Steer active agent safely at turn boundary
      const agent = this.deps.getAgent?.(sid);
      if (agent && agent.busy) {
        agent.steer(task.prompt, task.images);
        task.status = STATUS.COMPLETED;
        task.completed_at = Date.now();
        task.execution_metadata.steered = true;
        this.saveTask(task);
        this.emitTaskEvent(task.task_id, 'steered', { text: task.prompt });
        return { task, queued: false, steered: true };
      }
    }

    if (isRunning && !concurrent) {
      // Default: Queue message without interrupting active task
      task.status = STATUS.QUEUED;
      // Steering left over from the turn that just ended goes first: the user sent it before anything queued.
      if (front) queue.unshift(task.task_id); else queue.push(task.task_id);
      const position = front ? 1 : queue.length;
      this.saveTask(task);
      this.emitTaskEvent(task.task_id, 'queued', { queuePosition: position });
      this.notifySession(sid, 'task-queued', { task_id: task.task_id, position });
      return { task, queued: true, position };
    }

    // Run immediately in background
    this.startTask(task);
    return { task, queued: false };
  }

  isSessionRunning(sessionId) {
    for (const active of this.activeTasks.values()) {
      if (active.task.session_id === sessionId && active.task.status === STATUS.RUNNING) {
        return true;
      }
    }
    const a = this.deps.getAgent?.(sessionId);
    return !!(a && a.busy);
  }

  getActiveTaskForSession(sessionId) {
    for (const active of this.activeTasks.values()) {
      if (active.task.session_id === sessionId && active.task.status === STATUS.RUNNING) {
        return active.task;
      }
    }
    return null;
  }

  // Start background task execution with its own isolated AbortController
  async startTask(task) {
    const taskId = task.task_id;
    const sid = task.session_id;
    const abort = new AbortController();

    task.status = STATUS.RUNNING;
    task.started_at = Date.now();
    task.progress.currentAction = 'Executing';
    this.saveTask(task);

    const activeRecord = {
      task,
      abort,
      processIds: new Set(),
      promise: null,
    };
    this.activeTasks.set(taskId, activeRecord);

    this.emitTaskEvent(taskId, 'started', { task_id: taskId });
    this.notifySession(sid, 'task-started', { task_id: taskId, title: task.title });

    const runPromise = (async () => {
      const agent = this.deps.getAgent?.(sid);
      if (!agent) {
        throw new Error(`Session ${sid} not found.`);
      }

      // Associate task with agent for process tracking & safety
      agent._currentTaskId = taskId;

      try {
        await agent.send(task.prompt, task.opts, task.images || [], {
          signal: abort.signal,
          abortController: abort, // so agent.stop() works for a task-run turn too
          taskId,
          onProgress: (p) => {
            task.progress = { ...task.progress, ...p };
            this.emitTaskEvent(taskId, 'progress', p);
          },
        });

        if (abort.signal.aborted) {
          task.status = STATUS.CANCELLED;
          task.completed_at = Date.now();
          this.emitTaskEvent(taskId, 'cancelled', { task_id: taskId });
        } else {
          task.status = STATUS.COMPLETED;
          task.completed_at = Date.now();
          task.progress.percent = 100;
          task.progress.currentAction = 'Completed';
          this.emitTaskEvent(taskId, 'completed', { task_id: taskId });
        }
      } catch (err) {
        if (abort.signal.aborted || err.message === 'aborted') {
          task.status = STATUS.CANCELLED;
          task.error_info = 'Cancelled by user';
        } else {
          task.status = STATUS.FAILED;
          task.error_info = String(err.message || err);
        }
        task.completed_at = Date.now();
        this.emitTaskEvent(taskId, task.status, { task_id: taskId, error: task.error_info });
      } finally {
        if (agent._currentTaskId === taskId) agent._currentTaskId = null;
        this.activeTasks.delete(taskId);
        this.saveTask(task);
        this.notifySession(sid, 'task-ended', { task_id: taskId, status: task.status, error: task.error_info });

        // Process next item in queue for this session
        this.drainQueue(sid);
      }
    })();

    activeRecord.promise = runPromise;
    return activeRecord;
  }

  // Drain the next queued task for a session. Messages restored after a restart wait for the user.
  drainQueue(sessionId) {
    const queue = this.queues.get(sessionId);
    if (!queue || !queue.length) return;

    if (this.isSessionRunning(sessionId)) return;

    const nextTask = this.getTask(queue[0]);
    if (nextTask?.restored) return;
    queue.shift();
    if (nextTask && nextTask.status === STATUS.QUEUED) {
      this.startTask(nextTask);
    }
  }

  /** Queued messages of one session, in order (for the list above the composer). */
  queuedFor(sessionId) {
    return (this.queues.get(sessionId) || []).map((id) => this.getTask(id)).filter((t) => t && t.status === STATUS.QUEUED)
      .map((t) => ({ task_id: t.task_id, title: t.title, prompt: t.prompt, created_at: t.created_at, restored: !!t.restored }));
  }

  /** The user runs a queued message now: when the session is idle it starts at once; when it is busy,
   *  it is delivered to the running agent as steering. */
  runQueuedNow(taskId) {
    for (const [sid, q] of this.queues) {
      const idx = q.indexOf(taskId);
      if (idx < 0) continue;
      const task = this.getTask(taskId);
      if (!task) return { error: 'Task not found' };
      q.splice(idx, 1);
      delete task.restored;
      const agent = this.deps.getAgent?.(sid);
      if (this.isSessionRunning(sid) && agent?.busy) {
        agent.steer(task.prompt, task.images);
        task.status = STATUS.COMPLETED;
        task.completed_at = Date.now();
        task.execution_metadata = { ...(task.execution_metadata || {}), steered: true };
        this.saveTask(task);
        this.notifySession(sid, 'queue-updated', { queue: q, steeredTask: taskId });
        return { steered: true };
      }
      task.status = STATUS.QUEUED;
      this.startTask(task);
      return { started: true };
    }
    return { error: 'That message is no longer waiting.' };
  }

  // Explicit user cancellation: cancels ONLY the target task
  cancelTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active) {
      active.abort.abort();
      active.task.status = STATUS.CANCELLED;
      active.task.completed_at = Date.now();
      active.task.error_info = 'Explicitly cancelled by user';
      this.saveTask(active.task);

      // Kill any shell processes owned specifically by this task
      const agent = this.deps.getAgent?.(active.task.session_id);
      if (agent?.procs) {
        for (const pid of active.processIds) {
          try { agent.procs.stop(pid); } catch {}
        }
      }

      this.emitTaskEvent(taskId, 'cancelled', { task_id: taskId });
      this.notifySession(active.task.session_id, 'task-cancelled', { task_id: taskId });
      return true;
    }

    // If task was in queue, remove from queue
    for (const [sid, q] of this.queues) {
      const idx = q.indexOf(taskId);
      if (idx >= 0) {
        q.splice(idx, 1);
        const task = this.getTask(taskId);
        if (task) {
          task.status = STATUS.CANCELLED;
          task.completed_at = Date.now();
          task.error_info = 'Cancelled while queued';
          this.saveTask(task);
          this.emitTaskEvent(taskId, 'cancelled', { task_id: taskId });
          this.notifySession(sid, 'task-cancelled', { task_id: taskId });
        }
        return true;
      }
    }

    return false;
  }

  // Reorder task in session queue
  reorderQueue(sessionId, fromIndex, toIndex) {
    const queue = this.queues.get(sessionId);
    if (!queue || fromIndex < 0 || fromIndex >= queue.length || toIndex < 0 || toIndex >= queue.length) return false;
    const [moved] = queue.splice(fromIndex, 1);
    queue.splice(toIndex, 0, moved);
    this.notifySession(sessionId, 'queue-reordered', { queue });
    return true;
  }

  // Remove task from queue
  removeFromQueue(sessionId, taskId) {
    const queue = this.queues.get(sessionId);
    if (!queue) return false;
    const idx = queue.indexOf(taskId);
    if (idx >= 0) {
      queue.splice(idx, 1);
      const task = this.getTask(taskId);
      if (task) {
        task.status = STATUS.CANCELLED;
        task.completed_at = Date.now();
        this.saveTask(task);
      }
      this.notifySession(sessionId, 'queue-updated', { queue });
      return true;
    }
    return false;
  }

  // Event stream management with sequence numbers for reconnect & replay
  emitTaskEvent(taskId, type, payload = {}) {
    const seq = (this.seqCounters.get(taskId) || 0) + 1;
    this.seqCounters.set(taskId, seq);

    const event = {
      task_id: taskId,
      seq,
      timestamp: Date.now(),
      type,
      payload,
    };

    if (!this.eventLogs.has(taskId)) this.eventLogs.set(taskId, []);
    const log = this.eventLogs.get(taskId);
    log.push(event);
    if (log.length > 500) log.shift();

    const subs = this.subscribers.get(taskId);
    if (subs) {
      for (const fn of subs) {
        try { fn(event); } catch {}
      }
    }

    const task = this.getTask(taskId);
    if (task) {
      this.notifySession(task.session_id, 'task-event', event);
    }
  }

  // Subscribe to task events, optionally replaying from lastSeq
  subscribeTask(taskId, fn, fromSeq = 0) {
    if (!this.subscribers.has(taskId)) this.subscribers.set(taskId, new Set());
    this.subscribers.get(taskId).add(fn);

    const log = this.eventLogs.get(taskId) || [];
    for (const ev of log) {
      if (ev.seq > fromSeq) {
        try { fn(ev); } catch {}
      }
    }

    return () => {
      const subs = this.subscribers.get(taskId);
      if (subs) subs.delete(fn);
    };
  }

  notifySession(sessionId, type, payload) {
    try {
      this.deps.sendEvent?.(sessionId, type, payload);
    } catch {}
  }
}

let instance = null;
function getTaskManager(deps) {
  if (!instance && deps) instance = new TaskManager(deps);
  return instance;
}

module.exports = {
  TaskManager,
  getTaskManager,
  STATUS,
};
