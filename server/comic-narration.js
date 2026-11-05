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
  async function audio(job, scenarioId, index, signal) {
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
      const owned = [...pending.values()].filter(work => work.owner === job.owner && !work.controller.signal.aborted);
      if (owned.length >= 4) throw httpError(429, 'Too many narration requests. Wait for a scene to finish.');
      const controller = new AbortController();
      const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]);
      const work = { owner: job.owner, controller, waiters: 0 };
      work.promise = gate.run(async () => {
        const bytes = await speak({ text, signal: deadline });
        deadline.throwIfAborted();
        return remember(key, bytes);
      }, deadline).finally(() => { if (pending.get(key) === work) pending.delete(key); });
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
  async function close() {
    closed = true;
    const work = [...pending.values()];
    for (const entry of work) entry.controller.abort();
    await Promise.allSettled(work.map(entry => entry.promise));
    worker.close();
    cache.clear();
    cachedBytes = 0;
  }
  return { audio, close };
}
