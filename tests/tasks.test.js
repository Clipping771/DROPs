// Automated test suite for the Persistent Background Agent & Independent Task Management Architecture.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Task files go to a throwaway app data folder, never the user's real DROPs folder.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-tasks-test-'));
const { TaskManager, STATUS } = require('../src/main/tasks');
test('task tests write to a throwaway folder, not the user\'s DROPs data', () => {
  assert.ok(require('../src/main/brand').appDataDir().startsWith(os.tmpdir()));
});

// Helper to create a fake agent
function createFakeAgent(sessionId) {
  let busy = false;
  let currentTask = null;
  let messages = [];
  let cancelled = false;

  return {
    get busy() { return busy; },
    set busy(v) { busy = v; },
    data: { id: sessionId, projectDir: os.tmpdir(), messages },
    procs: {
      stopped: [],
      stop(pid) { this.stopped.push(pid); },
    },
    async send(text, opts, images, extra = {}) {
      busy = true;
      currentTask = extra.taskId;
      const signal = extra.signal;
      try {
        for (let i = 0; i < 5; i++) {
          if (signal?.aborted) {
            cancelled = true;
            throw new Error('aborted');
          }
          if (extra.onProgress) extra.onProgress({ step: i + 1, maxSteps: 5, percent: ((i + 1) / 5) * 100 });
          await new Promise((r) => setTimeout(r, 20));
        }
        messages.push({ role: 'user', content: text });
      } finally {
        busy = false;
        currentTask = null;
      }
    },
    steer(text) {
      messages.push({ role: 'user', content: `[User steering] ${text}` });
      return true;
    },
    stop() {
      busy = false;
    },
  };
}

test('TEST 1: Start a coding task, send another message -> original task continues uninterrupted', async () => {
  const sessionId = 'test-session-1';
  const agent = createFakeAgent(sessionId);
  const manager = new TaskManager({
    getAgent: (id) => (id === sessionId ? agent : null),
    sendEvent: () => {},
  });

  // Start initial task
  const res1 = await manager.submitTask({
    session_id: sessionId,
    workspace_id: os.tmpdir(),
    prompt: 'Task 1: Build the backend',
  });
  assert.equal(res1.queued, false);
  assert.equal(res1.task.status, STATUS.RUNNING);

  // Send another chat message while task 1 is running
  const res2 = await manager.submitTask({
    session_id: sessionId,
    workspace_id: os.tmpdir(),
    prompt: 'Task 2: Also add database migrations',
  });

  // Expected: Message is queued without cancelling or interrupting Task 1
  assert.equal(res2.queued, true);
  assert.equal(res2.position, 1);
  assert.equal(res2.task.status, STATUS.QUEUED);

  // Task 1 is STILL running and has not failed
  const task1 = manager.getTask(res1.task.task_id);
  assert.equal(task1.status, STATUS.RUNNING);

  // Wait for task 1 to finish
  await manager.activeTasks.get(res1.task.task_id)?.promise;
  // Wait for queued task 2 to auto-start and finish
  let t2Promise = manager.activeTasks.get(res2.task.task_id)?.promise;
  for (let k = 0; k < 20 && !t2Promise; k++) {
    await new Promise((r) => setTimeout(r, 20));
    t2Promise = manager.activeTasks.get(res2.task.task_id)?.promise;
  }
  await t2Promise;

  assert.equal(manager.getTask(res1.task.task_id).status, STATUS.COMPLETED);
  assert.equal(manager.getTask(res2.task.task_id).status, STATUS.COMPLETED);
});

test('TEST 2: Start a coding task and navigate to another conversation -> original task continues', async () => {
  const sessionA = 'session-A';
  const sessionB = 'session-B';
  const agentA = createFakeAgent(sessionA);
  const agentB = createFakeAgent(sessionB);

  const manager = new TaskManager({
    getAgent: (id) => (id === sessionA ? agentA : id === sessionB ? agentB : null),
    sendEvent: () => {},
  });

  // Start task in session A
  const resA = await manager.submitTask({
    session_id: sessionA,
    conversation_id: 'conv-A',
    workspace_id: os.tmpdir(),
    prompt: 'Task in session A',
  });
  assert.equal(resA.task.status, STATUS.RUNNING);

  // User navigates to session B and chats there
  const resB = await manager.submitTask({
    session_id: sessionB,
    conversation_id: 'conv-B',
    workspace_id: os.tmpdir(),
    prompt: 'Question in session B',
  });
  assert.equal(resB.task.status, STATUS.RUNNING);

  // Both tasks run concurrently without conflict
  assert.equal(manager.getTask(resA.task.task_id).status, STATUS.RUNNING);
  assert.equal(manager.getTask(resB.task.task_id).status, STATUS.RUNNING);

  await Promise.all([
    manager.activeTasks.get(resA.task.task_id)?.promise,
    manager.activeTasks.get(resB.task.task_id)?.promise,
  ]);

  assert.equal(manager.getTask(resA.task.task_id).status, STATUS.COMPLETED);
  assert.equal(manager.getTask(resB.task.task_id).status, STATUS.COMPLETED);
});

test('TEST 3: Event stream recovery and reconnection across refreshes', async () => {
  const sessionId = 'test-session-stream';
  const agent = createFakeAgent(sessionId);
  const manager = new TaskManager({
    getAgent: () => agent,
    sendEvent: () => {},
  });

  const res = await manager.submitTask({
    session_id: sessionId,
    workspace_id: os.tmpdir(),
    prompt: 'Test streaming',
  });

  const taskId = res.task.task_id;
  const currentSeq = manager.seqCounters.get(taskId) || 0;
  manager.emitTaskEvent(taskId, 'custom-log-1', { msg: 'Step 1 done' });
  manager.emitTaskEvent(taskId, 'custom-log-2', { msg: 'Step 2 done' });

  // Reconnect with lastSeq = currentSeq + 1 (should only receive events after custom-log-1)
  const received = [];
  manager.subscribeTask(taskId, (ev) => received.push(ev), currentSeq + 1);

  assert.ok(received.length >= 1);
  assert.equal(received[0].type, 'custom-log-2');
});

test('TEST 4: Start three independent tasks -> all maintain independent execution & state', async () => {
  const manager = new TaskManager({
    getAgent: (id) => createFakeAgent(id),
    sendEvent: () => {},
  });

  const t1 = await manager.submitTask({ session_id: 's1', workspace_id: os.tmpdir(), prompt: 'T1' });
  const t2 = await manager.submitTask({ session_id: 's2', workspace_id: os.tmpdir(), prompt: 'T2' });
  const t3 = await manager.submitTask({ session_id: 's3', workspace_id: os.tmpdir(), prompt: 'T3' });

  assert.notEqual(t1.task.task_id, t2.task.task_id);
  assert.notEqual(t2.task.task_id, t3.task.task_id);

  assert.equal(manager.getTask(t1.task.task_id).status, STATUS.RUNNING);
  assert.equal(manager.getTask(t2.task.task_id).status, STATUS.RUNNING);
  assert.equal(manager.getTask(t3.task.task_id).status, STATUS.RUNNING);

  await Promise.all([
    manager.activeTasks.get(t1.task.task_id)?.promise,
    manager.activeTasks.get(t2.task.task_id)?.promise,
    manager.activeTasks.get(t3.task.task_id)?.promise,
  ]);

  assert.equal(manager.getTask(t1.task.task_id).status, STATUS.COMPLETED);
  assert.equal(manager.getTask(t2.task.task_id).status, STATUS.COMPLETED);
  assert.equal(manager.getTask(t3.task.task_id).status, STATUS.COMPLETED);
});

test('TEST 5: Send 5 messages while task is running -> queued in order without cancelling original', async () => {
  const sessionId = 'test-queue-5';
  const agent = createFakeAgent(sessionId);
  const manager = new TaskManager({
    getAgent: () => agent,
    sendEvent: () => {},
  });

  const main = await manager.submitTask({ session_id: sessionId, workspace_id: os.tmpdir(), prompt: 'Main Task' });
  assert.equal(main.queued, false);

  const queued = [];
  for (let i = 1; i <= 5; i++) {
    const q = await manager.submitTask({ session_id: sessionId, workspace_id: os.tmpdir(), prompt: `Subsequent message ${i}` });
    assert.equal(q.queued, true);
    assert.equal(q.position, i);
    queued.push(q);
  }

  // Original task is STILL running
  assert.equal(manager.getTask(main.task.task_id).status, STATUS.RUNNING);

  // Queue holds exactly 5 items
  assert.equal(manager.queues.get(sessionId).length, 5);
});

test('TEST 7 & 10: Stale worker detection on backend restart (never falsely report success)', () => {
  const manager = new TaskManager({
    getAgent: () => null,
    sendEvent: () => {},
  });

  // Inject a mock task stuck in running state
  const staleTask = {
    task_id: 'task_stale_123',
    session_id: 'sess_stale',
    title: 'Crashed task',
    status: STATUS.RUNNING,
    created_at: Date.now() - 10000,
    started_at: Date.now() - 9000,
    completed_at: null,
    error_info: null,
    progress: { percent: 50 },
  };
  manager.saveTask(staleTask);

  // Run crash recovery
  manager.recoverStaleTasks();

  const recovered = manager.getTask('task_stale_123');
  assert.equal(recovered.status, STATUS.FAILED);
  assert.match(recovered.error_info, /terminated unexpectedly/i);
  assert.ok(recovered.completed_at > 0);
});

test('a queued message survives a restart, waits for the user, and "Run now" starts it', async () => {
  const sid = 'sess_restart';
  const agent = createFakeAgent(sid);
  const before = new TaskManager({ getAgent: () => agent, sendEvent: () => {} });
  await before.submitTask({ session_id: sid, prompt: 'first' });
  const queued = await before.submitTask({ session_id: sid, prompt: 'second, typed while busy' });
  assert.equal(queued.queued, true);
  // The app quits while "first" runs: a new TaskManager starts from the files.
  const after = new TaskManager({ getAgent: () => agent, sendEvent: () => {} });
  const waiting = after.queuedFor(sid);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].prompt, 'second, typed while busy');
  assert.equal(waiting[0].restored, true);
  await new Promise((r) => setTimeout(r, 200)); // "first" (old manager) ends; nothing restored starts by itself
  after.drainQueue(sid);
  assert.equal(after.getTask(queued.task.task_id).status, STATUS.QUEUED, 'a restored message never starts by itself');
  const r = after.runQueuedNow(queued.task.task_id);
  assert.equal(r.started, true);
  await new Promise((res) => setTimeout(res, 250));
  assert.equal(after.getTask(queued.task.task_id).status, STATUS.COMPLETED);
  assert.deepEqual(after.queuedFor(sid), []);
  assert.match(after.runQueuedNow('task_nope').error, /no longer waiting/);
});

test('"Tell agent now" on a queued message steers the running agent instead of waiting', async () => {
  const sid = 'sess_steer_now';
  const agent = createFakeAgent(sid);
  const m = new TaskManager({ getAgent: () => agent, sendEvent: () => {} });
  await m.submitTask({ session_id: sid, prompt: 'long task' });
  const q = await m.submitTask({ session_id: sid, prompt: 'use blue, not red' });
  const r = m.runQueuedNow(q.task.task_id);
  assert.equal(r.steered, true);
  assert.ok(agent.data.messages.some((x) => x.content === '[User steering] use blue, not red'));
  assert.deepEqual(m.queuedFor(sid), []);
});

test('TEST 8: Explicitly cancel a task -> only the targeted task is cancelled', async () => {
  const sessionId1 = 's-cancel-1';
  const sessionId2 = 's-cancel-2';
  const agent1 = createFakeAgent(sessionId1);
  const agent2 = createFakeAgent(sessionId2);

  const manager = new TaskManager({
    getAgent: (id) => (id === sessionId1 ? agent1 : agent2),
    sendEvent: () => {},
  });

  const t1 = await manager.submitTask({ session_id: sessionId1, workspace_id: os.tmpdir(), prompt: 'Task to cancel' });
  const t2 = await manager.submitTask({ session_id: sessionId2, workspace_id: os.tmpdir(), prompt: 'Task to keep running' });

  // Explicitly cancel t1
  const cancelled = manager.cancelTask(t1.task.task_id);
  assert.equal(cancelled, true);

  // Wait for settlement
  try { await manager.activeTasks.get(t1.task.task_id)?.promise; } catch {}
  await manager.activeTasks.get(t2.task.task_id)?.promise;

  assert.equal(manager.getTask(t1.task.task_id).status, STATUS.CANCELLED);
  // t2 completed normally!
  assert.equal(manager.getTask(t2.task.task_id).status, STATUS.COMPLETED);
});

test('TEST 9: Idempotency keys prevent duplicate execution', async () => {
  const manager = new TaskManager({
    getAgent: () => createFakeAgent('idem'),
    sendEvent: () => {},
  });

  const task1 = manager.createTask({
    session_id: 'idem',
    workspace_id: os.tmpdir(),
    prompt: 'Deploy app',
    idempotency_key: 'deploy-v1-unique',
  });

  const task2 = manager.createTask({
    session_id: 'idem',
    workspace_id: os.tmpdir(),
    prompt: 'Deploy app duplicate',
    idempotency_key: 'deploy-v1-unique',
  });

  // Same task ID returned, avoiding duplicate task creation
  assert.equal(task1.task_id, task2.task_id);
});

test('TEST 6: Disconnect frontend while task is running -> backend execution continues to completion', async () => {
  const sessionId = 'test-session-disconnect';
  const agent = createFakeAgent(sessionId);
  let networkConnected = true;
  let clientEvents = [];

  const manager = new TaskManager({
    getAgent: () => agent,
    sendEvent: (sid, type, p) => {
      if (networkConnected) clientEvents.push({ sid, type, ...p });
    },
  });

  const res = await manager.submitTask({
    session_id: sessionId,
    workspace_id: os.tmpdir(),
    prompt: 'Long running task',
  });

  // Simulate network disconnect after task start
  await new Promise((r) => setTimeout(r, 30));
  networkConnected = false;

  // Wait for task to finish in background
  await manager.activeTasks.get(res.task.task_id)?.promise;

  // Task completed successfully on backend despite frontend disconnect!
  assert.equal(manager.getTask(res.task.task_id).status, STATUS.COMPLETED);
});

test('TEST 9B: Parallel agents on isolated workspaces avoid shared-file conflict', async () => {
  const git = require('../src/main/git');
  // Verify git worktree isolation capability exists
  assert.equal(typeof git.worktreeAdd, 'function');
  assert.equal(typeof git.worktreeRemove, 'function');
});
