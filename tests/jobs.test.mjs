import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from '../server/jobs.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Gate } from '../server/concurrency.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function make(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-jobs-'));
  const store = new JobStore({ directory, ...options });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return store;
}
test('global worker bounds, idempotency, owner isolation and queued cancel', async t => {
  const store = make(t, { limits: { analysis: 1 } }); let active = 0; let peak = 0; const release = [];
  const runner = async ({ signal }) => { active++; peak = Math.max(peak, active); await new Promise((resolve, reject) => { release.push(resolve); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); active--; return { result: { ok: true } }; };
  const a = store.start({ kind: 'analysis', owner: 'A', payload: { text: 'a' }, idempotencyKey: 'same', runner });
  assert.equal(store.start({ kind: 'analysis', owner: 'A', payload: { text: 'a' }, idempotencyKey: 'same', runner }).jobId, a.jobId);
  assert.throws(() => store.start({ kind: 'analysis', owner: 'A', payload: { text: 'different' }, idempotencyKey: 'same', runner }), /different input/);
  const b = store.start({ kind: 'analysis', owner: 'B', payload: { text: 'b' }, runner });
  assert.throws(() => store.get(a.jobId, 'B'), /not found/);
  await tick(); assert.equal(peak, 1); assert.equal(b.status, 'queued');
  await store.cancel(b.jobId, 'B'); release.shift()(); await tick();
  assert.equal(a.status, 'ready'); assert.equal(b.status, 'canceled'); assert.equal(peak, 1);
});
test('bounded admission, progress persistence, deadline and retention', async t => {
  const store = make(t, { maxPending: 1, deadlineMs: 40, ttlMs: 30 });
  const job = store.start({ kind: 'cards', owner: 'A', payload: {}, runner: async ({ update, signal }) => {
    update({ results: [{ ok: true, categoryId: 'done' }] });
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  assert.throws(() => store.start({ kind: 'cards', owner: 'B', payload: {}, runner: async () => ({}) }), /queue is full/);
  await tick(); assert.equal(JSON.parse(fs.readFileSync(path.join(store.directory, job.jobId + '.json'))).results[0].categoryId, 'done');
  await new Promise(resolve => setTimeout(resolve, 55)); assert.equal(job.status, 'expired');
  await new Promise(resolve => setTimeout(resolve, 40)); store.prune(); assert.equal(store.jobs.size, 0);
});
test('restart retains completed jobs and fails interrupted work without re-running it', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-restart-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'worker.lock'), '');
  const first = new JobStore({ directory });
  const job = first.start({ kind: 'analysis', owner: 'A', payload: {}, runner: async () => ({ result: { answer: 42 } }) });
  await tick(); await first.close();
  const interrupted = { ...JSON.parse(fs.readFileSync(path.join(directory, job.jobId + '.json'))), jobId: 'video-12345678-abcd', kind: 'video', status: 'generating-video', key: 'interrupted', completedAt: undefined };
  fs.writeFileSync(path.join(directory, interrupted.jobId + '.json'), JSON.stringify(interrupted));
  const recovered = []; const second = new JobStore({ directory, onRecover: async job => recovered.push(job.jobId) });
  await second.ready;
  assert.equal(second.get(job.jobId, 'A').result.answer, 42);
  assert.equal(second.get(interrupted.jobId, 'A').errorCode, 'INTERRUPTED'); assert.deepEqual(recovered, [interrupted.jobId]);
  assert.throws(() => new JobStore({ directory }), /already owned/);
  await second.close();
});
test('abort after acquiring a permit releases capacity and queued abort never runs', async () => {
  const gate = new Gate(1, 1); let release; let ran = false;
  const first = gate.run(() => new Promise(resolve => { release = resolve; })); await tick();
  const abort = new AbortController(); const next = gate.run(() => { ran = true; }, abort.signal); abort.abort();
  await assert.rejects(next, { name: 'AbortError' }); release(); await first;
  assert.equal(ran, false); assert.equal(gate.active, 0); assert.equal(gate.queue.length, 0);
});

test('cancel deduplicates upstream requests and retains ownership until acknowledgment', async t => {
  const store = make(t, { maxRecords: 1 }); let acknowledge; let calls = 0;
  const job = store.start({ kind: 'video', owner: 'A', payload: {},
    runner: ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    onCancel: () => { calls++; return new Promise(resolve => { acknowledge = resolve; }); }
  });
  await tick(); const first = store.cancel(job.jobId, 'A'); const second = store.cancel(job.jobId, 'A');
  await tick(); store.prune();
  assert.equal(calls, 1); assert.equal(job.status, 'canceling'); assert.ok(store.runtime.has(job.jobId));
  assert.throws(() => store.start({ kind: 'analysis', owner: 'B', payload: {}, runner: async () => ({}) }), /queue is full/);
  acknowledge(); await Promise.all([first, second]); await tick();
  const next = store.start({ kind: 'analysis', owner: 'B', payload: {}, runner: async () => ({}) }); await tick();
  assert.equal(store.jobs.has(job.jobId), false);
  assert.equal(fs.existsSync(path.join(store.directory, job.jobId + '.json')), false);
  assert.equal(fs.readdirSync(store.directory).filter(name => name.endsWith('.json')).length, 1);
  assert.equal(store.get(next.jobId, 'B').status, 'ready');
});
test('a crashed worker releases its OS lease and corrupt startup releases its lease', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-crash-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const moduleUrl = new URL('../server/jobs.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {JobStore} from ${JSON.stringify(moduleUrl)}; new JobStore({directory:process.argv[1]}); console.log('ready'); setInterval(()=>{},1000);`, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child.stdout, 'data'); assert.throws(() => new JobStore({ directory }), /already owned/);
  const died = once(child, 'exit'); child.kill('SIGKILL'); await died;
  const next = new JobStore({ directory }); await next.close();
  const corrupt = path.join(directory, 'video-abcdef.json'); fs.writeFileSync(corrupt, '{bad');
  assert.throws(() => new JobStore({ directory }), /JSON/); fs.unlinkSync(corrupt);
  const repaired = new JobStore({ directory }); await repaired.close();
});

test('a full retained store deduplicates completed retries before making room for new work', async t => {
  const store = make(t, { maxRecords: 1 }); let runs = 0;
  const request = { kind: 'analysis', owner: 'A', payload: {}, idempotencyKey: 'accepted', runner: async () => { runs++; return { result: 'done' }; } };
  const first = store.start(request); await tick(); store.prune();
  assert.equal(store.jobs.size, 1);
  assert.equal(store.start(request).jobId, first.jobId); await tick(); assert.equal(runs, 1);
  const next = store.start({ ...request, idempotencyKey: 'new' }); await tick();
  assert.notEqual(next.jobId, first.jobId); assert.equal(runs, 2); assert.equal(store.jobs.size, 1);
});
