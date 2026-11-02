/* Shared by automatic preloading, user-selected media, and restored jobs. */
(function (root) {
  'use strict';
  const abortError = () => new DOMException('Canceled', 'AbortError');
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError());
      const stop = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function safeUrl(value, base) {
    try {
      const url = new URL(String(value || ''), base || root.location?.href);
      return ['http:', 'https:', 'blob:'].includes(url.protocol) && value ? url.href : '';
    } catch { return ''; }
  }
  class Scheduler {
    constructor(limits = { comic: 2, video: 1, cards: 1 }) {
      this.limits = limits; this.jobs = new Map(); this.running = {}; this.sequence = 0;
    }
    enqueue(key, kind, work, { priority = 0, signal } = {}) {
      const existing = this.jobs.get(key);
      if (existing) { existing.priority = Math.max(existing.priority, priority); this.pump(); return existing.promise; }
      if (signal?.aborted) return Promise.reject(abortError());
      const job = { key, kind, work, priority, sequence: this.sequence++, signal, started: false };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      job.abort = () => {
        if (!job.started && this.jobs.delete(key)) { job.reject(abortError()); this.pump(); }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.set(key, job); this.pump(); return job.promise;
    }
    pump() {
      const pending = [...this.jobs.values()].filter(job => !job.started)
        .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      for (const job of pending) {
        if (job.started || !this.jobs.has(job.key)) continue;
        if ((this.running[job.kind] || 0) >= (this.limits[job.kind] || 1)) continue;
        if (job.signal?.aborted) { job.abort(); continue; }
        job.started = true; this.running[job.kind] = (this.running[job.kind] || 0) + 1;
        Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
          this.running[job.kind]--; this.jobs.delete(job.key);
          job.signal?.removeEventListener('abort', job.abort); this.pump();
        });
      }
    }
  }
  function createApi(base, options = {}) {
    const fetcher = options.fetch || root.fetch.bind(root);
    const delay = options.sleep || sleep;
    const requestTimeout = options.requestTimeout || 30000;
    let csrfToken = ''; let sessionPromise; let sessionToken = '';
    const sessionKey = `eulalens:session:${base}`;
    let sessionStorage = options.sessionStorage;
    try { sessionStorage ||= root.sessionStorage; } catch {}
    try { sessionToken = sessionStorage?.getItem(sessionKey) || ''; } catch {}
    async function request(url, init = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, requestTimeout);
      if (init.signal?.aborted) controller.abort();
      init.signal?.addEventListener('abort', abort, { once: true });
      try {
        const headers = { ...(init.headers || {}) };
        if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
        const response = await fetcher(`${base}${url}`, { ...init, headers, credentials: 'include', cache: 'no-store', signal: controller.signal });
        let payload;
        try { payload = await response.json(); } catch { payload = { error: `The server returned an unreadable response (${response.status}).` }; }
        if (!response.ok) {
          const error = new Error(payload.error || `Request failed (${response.status}).`);
          error.status = response.status; throw error;
        }
        return payload;
      } finally {
        clearTimeout(timer); init.signal?.removeEventListener('abort', abort);
      }
    }
    async function session(refresh = false) {
      if (refresh) csrfToken = '';
      if (csrfToken) return;
      if (!sessionPromise) {
        sessionPromise = request('/api/session').catch(async error => {
          if (![401, 403].includes(error.status) || !sessionToken) throw error;
          sessionToken = '';
          try { sessionStorage?.removeItem(sessionKey); } catch {}
          return request('/api/session');
        }).then(data => {
          csrfToken = data.csrfToken || ''; sessionToken = data.sessionToken || sessionToken;
          try { if (sessionToken) sessionStorage?.setItem(sessionKey, sessionToken); } catch {}
        })
          .finally(() => { sessionPromise = null; });
      }
      await sessionPromise;
    }
    async function json(url, { method = 'GET', body, signal, idempotencyKey, attempts = 4 } = {}) {
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw abortError();
        try {
          await session();
          const headers = {};
          if (body !== undefined) headers['Content-Type'] = 'application/json';
          if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
          if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
          return await request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
        } catch (error) {
          if (signal?.aborted) throw abortError();
          if ([401, 403].includes(error.status) && !refreshed) { refreshed = true; await session(true); continue; }
          const retryable = !error.status || error.status === 429 || error.status >= 500;
          if (!retryable || attempt >= attempts - 1 || (method !== 'GET' && !idempotencyKey)) throw error;
          await delay(Math.min(8000, 500 * 2 ** attempt), signal);
        }
      }
    }
    async function poll(url, { signal, onUpdate = () => {}, timeoutMs = 2 * 60 * 60 * 1000, intervalMs = 2500 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let failures = 0;
      while (Date.now() < deadline) {
        if (signal?.aborted) throw abortError();
        let job;
        try { job = await json(url, { signal }); failures = 0; }
        catch (error) {
          if ([404, 410].includes(error.status)) { error.terminal = true; error.jobStatus = 'expired'; }
          if (signal?.aborted || [400, 401, 403, 404, 410].includes(error.status)) throw error;
          failures++;
          onUpdate({ status: 'reconnecting', error: 'Connection interrupted. Reconnecting to the existing job…' });
          await delay(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal); continue;
        }
        onUpdate(job);
        if (job.status === 'ready' || job.status === 'completed') return job;
        if (['error', 'failed', 'canceled', 'cancelled', 'expired'].includes(job.status)) {
          const error = new Error(job.error || (job.status.startsWith('cancel') ? 'Generation canceled.' : 'Generation failed.'));
          error.terminal = true; error.jobStatus = job.status; throw error;
        }
        await delay(intervalMs, signal);
      }
      const error = new Error('Stopped waiting for this job. Use Retry to reconnect without starting another generation.');
      error.code = 'POLL_DEADLINE'; throw error;
    }
    return { json, poll, session };
  }
  // Only opaque identifiers are retained. PDF bytes, extracted text, titles, model
  // prompts, summaries, and source clauses are never written to browser storage.
  function subtitleVtt(lines = []) {
    const stamp = seconds => {
      const ms = Math.round(seconds * 1000);
      return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    const cues = lines.flatMap(line => {
      const start = Number(line.startSeconds ?? line.start_seconds);
      const end = Number(line.endSeconds ?? line.end_seconds);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !line.text) return [];
      const text = String(line.text).replace(/[\r\n]+/g, ' ').replace(/-->/g, '→').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return [`${stamp(start)} --> ${stamp(end)}\n${text}`];
    });
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }
  function createRunStore(storage, key = 'eulalens:active-run:v1') {
    return {
      save(run) {
        try {
          const media = (run.categories || []).map(cat => ({ categoryId: cat.id, comicJobId: cat.comicJobId || '', videoJobId: cat.videoJobId || '', cardsJobId: cat.cardsJobId || '', selectedComicId: cat.selectedComicId || '', scenarioJobs: Object.fromEntries(Object.entries(cat.scenarioRenders || {}).map(([id, value]) => [id, { jobId: value.jobId || '' }])) }));
          storage.setItem(key, JSON.stringify({ version: 1, documentId: run.documentId, analysisJobId: run.analysisJobId, cardsJobId: run.cardsJobId, createdAt: run.createdAt, media }));
        } catch { /* Private browsing and quota limits must not break generation. */ }
      },
      load() {
        try {
          const value = JSON.parse(storage.getItem(key) || 'null');
          if (value?.version !== 1 || typeof value.documentId !== 'string' || !value.analysisJobId || Date.now() - value.createdAt > 24 * 60 * 60 * 1000) return null;
          return value;
        } catch { return null; }
      },
      clear() { try { storage.removeItem(key); } catch {} }
    };
  }
  root.EULALensRuntime = { Scheduler, createApi, createRunStore, escapeHtml, safeUrl, sleep, abortError, subtitleVtt };
})(globalThis);
