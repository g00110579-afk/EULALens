import { httpError } from './http.js';

export class Gate {
  constructor(limit = 2, maxQueued = 64, reserved = 0) {
    if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxQueued) || maxQueued < 0 || !Number.isInteger(reserved) || reserved < 0) throw new Error('Invalid queue limits.');
    this.limit = limit;
    this.reserved = reserved;
    this.maxQueued = maxQueued;
    this.active = 0;
    this.reservedActive = 0;
    this.queue = [];
    this.headBypassed = false;
  }
  admit(entry, reserved) {
    this.active++;
    if (reserved) this.reservedActive++;
    entry.resolve(reserved);
  }
  async run(task, signal, prefer) {
    signal?.throwIfAborted();
    const reservedSlot = await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, prefer };
      entry.abort = () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) { this.queue.splice(i, 1); reject(signal.reason); }
      };
      if (this.active - this.reservedActive < this.limit) this.admit(entry, false);
      else if (this.reservedActive < this.reserved && prefer?.()) this.admit(entry, true);
      else if (this.queue.length >= this.maxQueued) reject(httpError(503, 'Generation queue is full. Try again shortly.'));
      else { this.queue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true }); }
    });
    try { signal?.throwIfAborted(); return await task(); }
    finally {
      this.active--;
      if (reservedSlot) this.reservedActive--;
      while (this.queue.length && this.active < this.limit + this.reserved) {
        // A preferred job may pass the oldest waiter once. The next regular slot
        // goes to the head, even if new uploads keep arriving.
        const reservedOnly = this.active - this.reservedActive >= this.limit;
        const preferred = this.headBypassed && !reservedOnly ? -1 : this.queue.findIndex(entry => entry.prefer?.());
        if (reservedOnly && preferred < 0) break;
        this.headBypassed = preferred > 0;
        const next = this.headBypassed ? this.queue.splice(preferred, 1)[0] : this.queue.shift();
        next.signal?.removeEventListener('abort', next.abort);
        if (next.signal?.aborted) next.reject(next.signal.reason);
        else this.admit(next, reservedOnly);
      }
      if (!this.queue.length) this.headBypassed = false;
    }
  }
}

export function positiveInt(value, fallback, maximum = 100000000) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`Expected an integer between 1 and ${maximum}.`);
  return parsed;
}
