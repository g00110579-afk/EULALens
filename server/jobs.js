import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { httpError } from './http.js';
import { Gate } from './concurrency.js';

const terminal = new Set(['ready', 'error', 'canceled', 'expired']);
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

export class JobStore {
  constructor({ directory, limits = {}, maxPending = 64, maxPerOwner = 32, maxRecords = 1000, ttlMs = 86400000, deadlineMs = 3600000, onRecover = async () => {} }) {
    this.directory = directory; this.maxPending = maxPending; this.maxPerOwner = maxPerOwner;
    this.maxRecords = maxRecords; this.ttlMs = ttlMs; this.deadlineMs = deadlineMs;
    this.jobs = new Map(); this.runtime = new Map(); this.keys = new Map(); this.gates = new Map(); this.limits = limits;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    // SQLite's OS-backed lock is released even after SIGKILL. A PID file cannot
    // safely recover an empty write or PID reuse, and must not fence workers.
    const lockPath = path.join(directory, 'worker.sqlite');
    this.lease = new DatabaseSync(lockPath);
    fs.chmodSync(lockPath, 0o600);
    try { this.lease.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;'); }
    catch (error) { this.lease.close(); throw new Error('Job directory is already owned by another worker.', { cause: error }); }
    const recovery = [];
    try {
    for (const name of fs.readdirSync(directory).filter(name => /^[a-z]+-[a-f0-9-]+\.json$/.test(name))) {
      const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (!job.jobId || !job.owner || !job.kind) throw new Error(`Invalid persisted job ${name}`);
      if (!terminal.has(job.status)) {
        job.status = 'error'; job.error = 'Server restarted before this job finished. Retry explicitly.';
        job.errorCode = 'INTERRUPTED'; job.completedAt = Date.now();
        recovery.push(Promise.resolve().then(() => onRecover(job)).catch(() => {}));
        this.persist(job);
      }
      this.jobs.set(job.jobId, job); this.keys.set(job.key, job.jobId);
    }
    this.ready = Promise.all(recovery);
    this.prune();
    } catch (error) { this.lease.exec('ROLLBACK'); this.lease.close(); throw error; }
    this.timer = setInterval(() => this.prune(), Math.min(ttlMs, 60000)); this.timer.unref();
  }
  persist(job) {
    const content = JSON.stringify(job);
    if (Buffer.byteLength(content) > 12 * 1024 * 1024) throw httpError(413, 'Job result exceeds the storage limit. Split this document.');
    const target = path.join(this.directory, `${job.jobId}.json`); const temporary = `${target}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, content, { mode: 0o600 }); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  prune(reserve = 0) {
    const finished = [...this.jobs.values()].filter(j => terminal.has(j.status) && !this.runtime.has(j.jobId)).sort((a, b) => a.completedAt - b.completedAt);
    for (const job of finished) {
      if (Date.now() - job.completedAt < this.ttlMs && this.jobs.size <= this.maxRecords - reserve) continue;
      this.jobs.delete(job.jobId); if (this.keys.get(job.key) === job.jobId) this.keys.delete(job.key);
      fs.rmSync(path.join(this.directory, `${job.jobId}.json`), { force: true });
    }
  }
  get(id, owner) {
    const job = this.jobs.get(id);
    if (!job || job.owner !== owner) throw httpError(404, 'Job not found or expired.');
    return job;
  }
  public(job) {
    const { owner, payload, key, fingerprint, assets, ...view } = job;
    return structuredClone(view);
  }
  update(job, fields) {
    if (terminal.has(job.status) || this.runtime.get(job.jobId)?.controller.signal.aborted) return;
    const next = { ...job, ...fields, updatedAt: Date.now() }; this.persist(next); Object.assign(job, next);
  }
  start({ kind, owner, payload, idempotencyKey, namespace = 'durable', runner, onCancel = async () => {}, deadlineMs = this.deadlineMs }) {
    this.prune();
    const fingerprint = digest({ namespace, kind, payload });
    const key = digest({ owner, namespace, kind, idempotencyKey: idempotencyKey || fingerprint });
    const previous = this.jobs.get(this.keys.get(key));
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw httpError(409, 'Idempotency key was already used for different input.');
      return previous;
    }
    this.prune(1);
    const pending = [...this.jobs.values()].filter(j => !terminal.has(j.status));
    if (pending.length >= this.maxPending || this.jobs.size >= this.maxRecords) throw httpError(503, 'Server generation queue is full. Try again shortly.');
    if (pending.filter(j => j.owner === owner).length >= this.maxPerOwner) throw httpError(429, 'Too many unfinished jobs. Wait for existing work to finish.');
    const job = { jobId: `${kind}-${randomUUID()}`, kind, owner, key, fingerprint, payload, status: 'queued', createdAt: Date.now(), deadlineAt: Date.now() + deadlineMs };
    this.persist(job); this.jobs.set(job.jobId, job); this.keys.set(key, job.jobId);
    const controller = new AbortController();
    const state = { controller, onCancel, finished: false, cancelFinished: false, cancelPromise: null, timer: setTimeout(() => void this.cancel(job.jobId, owner, 'deadline'), deadlineMs) };
    state.timer.unref(); this.runtime.set(job.jobId, state);
    const queueKind = kind === 'render' ? 'comic' : kind === 'clip' ? 'video' : kind;
    if (!this.gates.has(queueKind)) this.gates.set(queueKind, new Gate(this.limits[queueKind] || 2, this.maxPending));
    state.promise = this.ready.then(() => this.gates.get(queueKind).run(async () => {
      this.update(job, { status: 'processing', startedAt: Date.now() });
      const result = await runner({ job, payload, signal: controller.signal, update: fields => this.update(job, fields) });
      controller.signal.throwIfAborted();
      const completed = { ...job, ...result, status: 'ready', completedAt: Date.now() }; this.persist(completed); Object.assign(job, completed);
    }, controller.signal)).catch(error => {
      if (!terminal.has(job.status) && !state.cancelPromise) {
        job.status = controller.signal.aborted ? (job.cancelReason === 'deadline' ? 'expired' : 'canceled') : 'error';
        job.error = controller.signal.aborted ? (job.status === 'expired' ? 'Job deadline exceeded.' : undefined) : error.message;
        job.errorCode = job.status === 'expired' ? 'DEADLINE' : error.code;
        job.completedAt = Date.now(); this.persist(job);
      }
    }).finally(() => { clearTimeout(state.timer); state.finished = true; this.releaseRuntime(job.jobId, state); });
    return job;
  }
  releaseRuntime(id, state) {
    if (state.finished && (!state.cancelPromise || state.cancelFinished)) this.runtime.delete(id);
  }
  async cancel(id, owner, reason = 'user') {
    const job = this.get(id, owner);
    const runtime = this.runtime.get(id);
    if (runtime?.cancelPromise) return runtime.cancelPromise;
    if (terminal.has(job.status)) return job;
    // Install the promise before aborting: a fast runner rejection must not
    // release retention ownership while upstream cancellation is still pending.
    const operation = Promise.resolve().then(async () => {
      job.cancelReason = reason; job.status = 'canceling'; job.cancellation = { upstream: 'requested' }; this.persist(job);
      runtime?.controller.abort(new DOMException(reason === 'deadline' ? 'Job deadline exceeded.' : 'Canceled.', 'AbortError'));
      try { if (runtime) await runtime.onCancel(job); job.cancellation.upstream = 'request-acknowledged'; }
      catch { job.cancellation.upstream = 'unconfirmed'; }
      job.status = reason === 'deadline' ? 'expired' : 'canceled'; job.completedAt = Date.now();
      if (reason === 'deadline') { job.error = 'Job deadline exceeded.'; job.errorCode = 'DEADLINE'; }
      this.persist(job); return job;
    }).finally(() => {
      if (runtime) { runtime.cancelFinished = true; this.releaseRuntime(id, runtime); }
    });
    if (runtime) runtime.cancelPromise = operation;
    return operation;
  }
  async close() {
    clearInterval(this.timer);
    const running = [...this.runtime.entries()];
    await Promise.all(running.map(([id]) => this.cancel(id, this.jobs.get(id).owner)));
    await Promise.all(running.map(([, state]) => state.promise));
    this.lease.exec('ROLLBACK'); this.lease.close();
  }
}
