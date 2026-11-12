import { createHash } from 'node:crypto';
import { Gate } from './concurrency.js';
import { httpError } from './http.js';
import { createKokoroWorker, maxAudioBytes } from './providers/kokoro.js';

const clean = value => typeof value === 'string' ? value.trim() : '';

// Historical jobs can have only display panels. Keep their exact caption and
// dialogue, and avoid reading a caption twice when it doubles as a bubble.
export function comicSceneText(comic, index) {
  const panels = comic.panels || [];
  const scenes = comic.scenes || [];
  if (!Number.isSafeInteger(index) || index < 0 || index >= (panels.length || scenes.length)) throw httpError(404, 'Comic scene not found.');
  const scene = scenes[index] || {};
  const panel = panels[index] || scene;
  const narration = clean(scene.narration) || clean(panel.narration);
  let text = narration;
  if (!text) {
    const caption = clean(panel.caption) || clean(panel.body) || clean(scene.overlayCaption) || clean(scene.overlay_caption) || clean(scene.caption) || clean(scene.body);
    const slots = panel.slots || panel.overlaySlots || panel.overlay_slots || panel.bubbles || scene.overlaySlots || scene.overlay_slots || [];
    const dialogue = Array.isArray(slots) ? slots.map(slot => clean(slot?.text)).filter(Boolean) : [];
    // Older generators sometimes emitted the caption as the only overlay slot,
    // even when they also supplied separate character dialogue.
    if (!dialogue.some(line => line !== caption)) dialogue.push(clean(scene.dialogue) || clean(panel.dialogue));
    text = [...new Set([caption, ...dialogue].filter(Boolean))].join('\n') || clean(panel.title) || clean(scene.title);
  }
  if (!text || text.length > 4096) throw httpError(422, 'This scene has no suitable narration text.');
  return text;
}

export function createComicNarration({ synthesize } = {}) {
  const worker = createKokoroWorker();
  const speak = synthesize || worker.synthesize;
  const gate = new Gate(1, 12);
  const pending = new Map();
  const cache = new Map();
  const stories = new Map();
  let preparing = false;
  let cachedBytes = 0;
  let closed = false;
  function remember(key, audio) {
    if (!Buffer.isBuffer(audio) || !audio.length || audio.length > maxAudioBytes) throw httpError(502, 'The narration worker returned invalid audio.');
    // Only authenticated, existing jobs can look up audio. Nothing private is written to disk.
    cache.set(key, audio);
    cachedBytes += audio.length;
    while (cachedBytes > 32 * 1024 * 1024 || cache.size > 256) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    return audio;
  }
  function* scenes(job) {
    const selected = job.selectedComicId;
    const ordered = [...job.comics].sort((a, b) => Number(b.id === selected) - Number(a.id === selected));
    for (const comic of ordered) {
      const count = comic.panels?.length || comic.scenes?.length || 0;
      for (let index = 0; index < count; index++) yield [comic.id, index];
    }
  }

  // Admit just one speculative clip while the CPU is idle. A Play request
  // can join that clip or take the next turn, even with many uploaded stories.
  function prepareNext() {
    if (closed || preparing || pending.size) return;
    for (const [id, story] of stories) {
      stories.delete(id);
      if (story.signal.aborted) continue;
      const clip = story.scenes.next();
      if (clip.done) continue;
      stories.set(id, story); // Round-robin across published stories.
      preparing = true;
      audio(story.job, ...clip.value, story.signal, true).catch(error => {
        // Skip a malformed historical scene. A broken worker can retry on Play.
        if (error.statusCode !== 422) stories.delete(id);
      }).finally(() => {
        preparing = false;
        prepareNext();
      });
      return;
    }
  }

  function prepare(job, signal) {
    if (closed || signal.aborted || job.kind !== 'comic' || !job.comics?.length ||
        stories.has(job.jobId) || stories.size >= 128) return;
    stories.set(job.jobId, { job, signal, scenes: scenes(job) });
    prepareNext();
  }

  async function audio(job, scenarioId, index, signal, background = false) {
    signal.throwIfAborted();
    if (closed) throw httpError(503, 'Narration is shutting down.');
    if (job.kind !== 'comic') throw httpError(404, 'Comic job not found.');
    const comics = job.comics?.length ? job.comics : job.comic ? [job.comic] : [];
    if (!comics.length) throw httpError(409, 'The comic story is unavailable.');
    const scenario = comics.find(item => item.id === scenarioId);
    if (!scenario) throw httpError(404, 'Comic scenario not found.');
    const text = comicSceneText(scenario, index);
    const key = createHash('sha256').update(JSON.stringify([job.jobId, scenarioId, index, text])).digest('hex');
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    let entry = pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      const owned = [...pending.values()].filter(work => work.owner === job.owner && !work.background && !work.controller.signal.aborted);
      if (owned.length >= 4) throw httpError(429, 'Too many narration requests. Wait for a scene to finish.');
      const controller = new AbortController();
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
      const work = { owner: job.owner, documentId: job.payload?.documentId, background, controller, waiters: 0 };
      work.promise = gate.run(async () => {
        const bytes = await speak({ text, signal: deadline });
        deadline.throwIfAborted();
        return remember(key, bytes);
      }, deadline).finally(() => {
        if (pending.get(key) === work) pending.delete(key);
        prepareNext();
      });
      pending.set(key, work);
      entry = work;
    }
    entry.waiters++;
    // One reader may navigate away while another still needs this same audio.
    const disconnected = Promise.withResolvers();
    const abort = () => disconnected.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    try { return await Promise.race([entry.promise, disconnected.promise]); }
    finally {
      signal.removeEventListener('abort', abort);
      if (--entry.waiters === 0 && pending.get(key) === entry) entry.controller.abort();
    }
  }
  async function cancelDocuments(owner, documents) {
    for (const [id, story] of stories) {
      if (story.job.owner === owner && documents.has(story.job.payload?.documentId)) stories.delete(id);
    }
    const work = [...pending.values()].filter(entry => entry.owner === owner && documents.has(entry.documentId));
    for (const entry of work) entry.controller.abort();
    await Promise.allSettled(work.map(entry => entry.promise));
  }
  async function close() {
    closed = true;
    stories.clear();
    const work = [...pending.values()];
    for (const entry of work) entry.controller.abort();
    await Promise.allSettled(work.map(entry => entry.promise));
    worker.close();
    cache.clear();
    cachedBytes = 0;
  }
  return { prepare, audio, cancelDocuments, close };
}
