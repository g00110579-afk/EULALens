import { httpError } from './http.js';

export class Gate {
  constructor(limit = 2, maxQueued = 64) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueued) || maxQueued < 0) throw new Error('Invalid queue limits.');
    this.limit = limit; this.maxQueued = maxQueued; this.active = 0; this.queue = [];
  }
  async run(task, signal) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) { this.queue.splice(i, 1); reject(signal.reason); }
      };
      if (this.active < this.limit) { this.active++; resolve(); }
      else if (this.queue.length >= this.maxQueued) reject(httpError(503, 'Generation queue is full. Try again shortly.'));
      else { this.queue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true }); }
    });
    try { signal?.throwIfAborted(); return await task(); }
    finally {
      this.active--;
      while (this.queue.length && this.active < this.limit) {
        const next = this.queue.shift();
        next.signal?.removeEventListener('abort', next.abort);
        if (next.signal?.aborted) next.reject(next.signal.reason);
        else { this.active++; next.resolve(); }
      }
    }
  }
}

export function positiveInt(value, fallback, maximum = 100000000) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Expected an integer between 1 and ${maximum}.`);
  return parsed;
}
