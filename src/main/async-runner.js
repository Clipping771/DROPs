// Async background task queue for DROPs: queues autonomous coding jobs,
// runs them sequentially or with bounded concurrency in isolated worktrees/branches,
// and tracks status, branch, cost, and summary for UI or headless workers.
const crypto = require('crypto');
const EventEmitter = require('events');

class AsyncTaskQueue extends EventEmitter {
  constructor({ concurrency = 1, runner } = {}) {
    super();
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.runner = runner;
    this.jobs = new Map();
    this.queue = [];
    this.active = 0;
  }

  enqueue({ projectDir, prompt, model = 'auto', effort = 'high', branch = null } = {}) {
    if (!projectDir || !prompt) throw new Error('projectDir and prompt are required.');
    const id = crypto.randomUUID().slice(0, 8);
    const job = {
      id,
      projectDir,
      prompt,
      model,
      effort,
      branch: branch || `drops/job-${id}`,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.emit('queued', job);
    this.pump();
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list() { return [...this.jobs.values()]; }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'queued') return false;
    this.queue = this.queue.filter((x) => x !== id);
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    this.emit('cancelled', job);
    return true;
  }

  async pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift();
      const job = this.jobs.get(id);
      if (!job || job.status !== 'queued') continue;
      this.active++;
      job.status = 'running';
      job.startedAt = Date.now();
      this.emit('started', job);
      Promise.resolve()
        .then(() => {
          if (this.runner) return this.runner(job);
          const { runHeadless } = require('../cli');
          return runHeadless({ project: job.projectDir, task: job.prompt, model: job.model, effort: job.effort, mode: 'yolo' });
        })
        .then((res) => {
          job.status = res?.ok === false ? 'failed' : 'done';
          job.result = res || null;
          job.error = res?.errors?.[0] || null;
        })
        .catch((err) => {
          job.status = 'failed';
          job.error = err?.message || String(err);
        })
        .finally(() => {
          job.finishedAt = Date.now();
          this.active--;
          this.emit('finished', job);
          this.pump();
        });
    }
  }

  async drain() {
    while (this.active > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

module.exports = { AsyncTaskQueue };
