import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { host, port, maxAnalyzePayloadMb, presentationPrecomputedRoot, projectRoot } from './config.js';
import * as handlers from './handlers.js';
import { httpError, errorPayload, getErrorStatus } from './http.js';
import { cancelHiDreamJob } from './providers/hidream.js';
import { closeProviderConnections } from './providers/http-client.js';
import { JobStore } from './jobs.js';
import { Gate, positiveInt } from './concurrency.js';
import { createSecurity } from './security.js';
import { attachArtifact, serveArtifact } from './assets.js';

const asyncRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const routes = { analysis: '/api/analyze', cards: '/api/categories/cards/batch', comic: '/api/categories/comic', video: '/api/categories/video' };
function validate(kind, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'A JSON object is required.');
  if (kind === 'analysis' && (typeof body.text !== 'string' || body.text.trim().length < 20 || body.text.length > 500000)) throw httpError(400, 'Provide between 20 and 500,000 characters of document text.');
  const categories = kind === 'cards' ? body.categories : ['comic', 'video', 'render', 'clip', 'card', 'script'].includes(kind) ? [body.category] : [];
  if (!Array.isArray(categories) || categories.length > 100 || categories.some(c => !c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id.trim() || c.id.length > 200 || typeof c.title !== 'string' || !c.title.trim() || c.title.length > 500)) throw httpError(400, 'Provide at most 100 categories, each with an ID and title.');
  if (new Set(categories.map(category => category.id)).size !== categories.length) throw httpError(400, 'Category IDs must be unique.');
  if (body.fileName !== undefined && (typeof body.fileName !== 'string' || body.fileName.length > 300)) throw httpError(400, 'Invalid document filename.');
  if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length > 200)) throw httpError(400, 'Invalid idempotency key.');
  return body;
}

export function createApp(options = {}) {
  const app = express(); const api = { ...handlers, ...options.handlers };
  const jobDirectory = options.directory || process.env.EULALENS_JOB_DIR || path.join(projectRoot, '.runtime', 'jobs');
  const origins = options.origins || (process.env.EULALENS_ALLOWED_ORIGINS || 'https://g00110579-afk.github.io,http://localhost:5173,http://127.0.0.1:5173').split(',').map(x => x.trim()).filter(Boolean);
  const security = createSecurity({ directory: path.dirname(jobDirectory), origins, secret: options.secret, accessToken: process.env.EULALENS_ACCESS_TOKEN || '', ...options.security });
  const cancelImage = options.cancelImage || cancelHiDreamJob;
  const media = new Gate(positiveInt(process.env.MEDIA_CONCURRENCY, 2, 8), 64);
  const modelGates = { image: new Gate(1, 64), video: new Gate(1, 64) };
  const render = (kind, work, signal) => modelGates[kind].run(() => media.run(work, signal), signal);
  const cancelUpstream = async job => {
    if (!job.upstreamStarted) return;
    if (job.kind === 'comic' || job.kind === 'render') await cancelImage(job.jobId);
    if (['video', 'clip'].includes(job.kind)) await api.cancelCategoryVideo(job.providerJobId || job.jobId);
  };
  const store = new JobStore({ directory: jobDirectory,
    maxPending: positiveInt(process.env.JOB_MAX_PENDING, 64, 1000), maxPerOwner: positiveInt(process.env.JOB_MAX_PER_SESSION, 32, 200),
    maxRecords: positiveInt(process.env.JOB_MAX_RECORDS, 1000, 10000), ttlMs: positiveInt(process.env.JOB_RETENTION_MS, 86400000),
    deadlineMs: positiveInt(process.env.JOB_DEADLINE_MS, 3600000), limits: { analysis: 2, cards: 2, comic: 2, video: 2 }, onRecover: cancelUpstream, ...options.store });
  app.locals.jobs = store; app.locals.security = security;
  app.locals.close = () => store.close();
  app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  app.use((req, res, next) => { try { security.checkOrigin(req); next(); } catch (e) { next(e); } });
  app.use(cors({ origin: true, credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Access-Token', 'Range'], exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'], maxAge: 600 }));
  app.use(express.json({ limit: `${Math.min(maxAnalyzePayloadMb, 4)}mb` }));
  app.get('/api/health', (_req, res) => res.json({ ...api.health(), dependenciesChecked: false }));
  app.get('/api/session', asyncRoute((req, res) => security.bootstrap(req, res)));
  app.get('/api/assets/:jobId/:assetId', asyncRoute((req, res) => serveArtifact(req, res, store, security)));
  app.use('/api/presentation/assets', (req, res, next) => {
    if (!/\.(pdf|png|webp|jpe?g|mp4)$/i.test(req.path)) return res.status(404).end();
    next();
  }, express.static(presentationPrecomputedRoot, { dotfiles: 'deny', index: false }));
  app.use('/api', security.authenticate);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/jobs', (req, res) => res.json({ jobs: [...store.jobs.values()].filter(j => j.owner === req.owner).map(j => ({ jobId: j.jobId, kind: j.kind, status: j.status, createdAt: j.createdAt })) }));
  app.get('/api/readiness', asyncRoute(async (_req, res) => {
    const targets = { qwen: new URL('/health', process.env.QWEN_BASE_URL || 'http://127.0.0.1:8000').href,
      image: new URL('/health', process.env.HIDREAM_IMAGE_API_URL || 'http://127.0.0.1:5052').href,
      video: new URL('/health', process.env.VIDEO_API_URL || 'http://127.0.0.1:5054').href };
    const states = await Promise.all(Object.entries(targets).map(async ([name, url]) => {
      try { const r = await fetch(url, { signal: AbortSignal.timeout(3000) }); const text = await r.text(); const data = text ? JSON.parse(text) : {};
        const configured = Boolean(name === 'qwen' ? process.env.QWEN_API_KEY : name === 'image' ? process.env.HIDREAM_API_KEY : process.env.VIDEO_API_KEY);
        return [name, { ready: configured && r.ok && data.ready !== false && !data.loadError, configured, loaded: data.loaded ?? data.modelLoaded }];
      } catch { return [name, { ready: false }]; }
    }));
    const ready = states.every(([, state]) => state.ready); res.status(ready ? 200 : 503).json({ ready, dependencies: Object.fromEntries(states) });
  }));

  const run = kind => async ({ job, payload, signal, update }) => {
    if (kind === 'analysis') return { result: await api.analyzeEula({ ...payload, signal }) };
    if (kind === 'cards') {
      update({ results: [] });
      const result = await api.generateCategoryCardsBatch({ ...payload, signal, onProgress: async (entry, index) => {
        const progress = new Map((job.results || []).map(item => [item.categoryId, item]));
        progress.set(entry.categoryId, entry);
        update({ results: payload.categories.map(category => progress.get(category.id)).filter(Boolean) });
      } });
      return { result, results: result.results };
    }
    if (kind === 'comic' || kind === 'render') {
      let collection = payload.comics; let selectedId = payload.selectedComicId;
      if (kind === 'comic') {
        update({ status: 'generating-story' });
        const result = await api.generateCategoryComic({ ...payload, signal });
        const comic = result.comic || result;
        collection = Array.isArray(comic.comics) && comic.comics.length ? comic.comics : [comic];
        selectedId ||= comic.selectedComicId || collection[0]?.id;
      }
      signal.throwIfAborted();
      const selected = collection?.find(c => c.id === selectedId) || collection?.[0];
      if (!selected?.imagePrompt) throw httpError(502, 'No validated comic scenario was returned.');
      update({ comics: collection, selectedComicId: selected.id, comic: selected, status: 'rendering-image' });
      const result = await render('image', () => { update({ upstreamStarted: true }); return api.renderCategoryComicImage({ ...payload, comic: selected, jobId: job.jobId, signal }); }, signal);
      signal.throwIfAborted();
      const imageUrl = attachArtifact(job, result.image.imageUrl, 'image', security, update);
      const { imagePath, ...image } = result.image;
      return { render: { ...result, image: { ...image, imageUrl } } };
    }
    update({ status: 'generating-script' });
    const scriptResult = kind === 'clip' ? { video: payload.category.video } : await api.generateCategoryVideoScript({ ...payload, signal });
    signal.throwIfAborted();
    if (!scriptResult.video?.modelPrompt) throw httpError(502, 'No validated video script was returned.');
    update({ videoScript: scriptResult.video, status: 'generating-video' });
    const result = await render('video', () => { update({ upstreamStarted: true }); return api.generateCategoryVideo({ ...payload, category: { ...payload.category, video: scriptResult.video }, jobId: job.jobId, signal,
      onProviderJobId: id => update({ providerJobId: id }) }); }, signal);
    signal.throwIfAborted();
    if (!result.videoUrl || !['ready', 'completed', 'succeeded', 'success'].includes(result.status)) throw httpError(502, 'Video provider has not completed a playable video.');
    const videoUrl = attachArtifact(job, result.videoUrl, 'video', security, update);
    const { raw, ...video } = result;
    return { video: { ...video, videoUrl, degradation: raw?.degraded || raw?.postprocess?.degraded || raw?.postprocess?.degradation || raw?.postprocess?.audio?.degradation || null, subtitleLines: raw?.subtitleLines || scriptResult.video.subtitleLines } };
  };
  function start(req, res, kind, override) {
    const body = validate(kind, override || req.body);
    const { idempotencyKey, ...payload } = body;
    const headerKey = req.get('idempotency-key');
    if (headerKey?.length > 200) throw httpError(400, 'Invalid idempotency key.');
    const job = store.start({ kind, owner: req.owner, payload, idempotencyKey: headerKey || idempotencyKey, runner: run(kind), onCancel: cancelUpstream });
    res.status(202).json({ jobId: job.jobId, status: job.status });
  }
  for (const [kind, route] of Object.entries(routes)) {
    app.post(`${route}/start`, asyncRoute((req, res) => start(req, res, kind)));
    app.get(`${route}/jobs/:jobId`, asyncRoute((req, res) => {
      const job = store.get(req.params.jobId, req.owner);
      if (job.kind !== kind && !(kind === 'comic' && job.kind === 'render') && !(kind === 'video' && job.kind === 'clip')) throw httpError(404, 'Job not found.');
      res.json(store.public(job));
    }));
    app.post(`${route}/jobs/:jobId/cancel`, asyncRoute(async (req, res) => {
      const job = store.get(req.params.jobId, req.owner);
      if (job.kind !== kind && !(kind === 'comic' && job.kind === 'render') && !(kind === 'video' && job.kind === 'clip')) throw httpError(404, 'Job not found.');
      res.json(store.public(await store.cancel(job.jobId, req.owner)));
    }));
  }
  app.post('/api/categories/comic/render/start', asyncRoute((req, res) => {
    if (!req.body?.comic?.id || !req.body.comic?.imagePrompt) throw httpError(400, 'A validated comic scenario is required.');
    start(req, res, 'render', { ...req.body, comics: [req.body.comic], selectedComicId: req.body.comic.id });
  }));
  app.post('/api/videos/generate/start', asyncRoute((req, res) => {
    if (!req.body?.category?.video?.modelPrompt) throw httpError(400, 'A validated video script is required.');
    start(req, res, 'clip');
  }));
  app.post('/api/categories/comic/jobs/:jobId/scenarios/:scenarioId/render', asyncRoute((req, res) => {
    const parent = store.get(req.params.jobId, req.owner);
    if (!['comic', 'render'].includes(parent.kind) || !parent.comics?.some(c => c.id === req.params.scenarioId)) throw httpError(404, 'Scenario not found.');
    start(req, res, 'render', { ...parent.payload, ...req.body, category: parent.payload.category, comics: parent.comics, selectedComicId: req.params.scenarioId });
  }));

  // Compatibility endpoints share the same limits, deadlines and ownership as jobs.
  const direct = new Gate(4, 32);
  const synchronous = (kind, handler) => asyncRoute(async (req, res) => {
    validate(kind, req.body);
    const controller = new AbortController(); const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    req.on('aborted', disconnected); res.on('close', disconnected);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)]);
    try { res.json(await direct.run(() => handler({ ...req.body, signal }), signal)); }
    finally { req.off('aborted', disconnected); res.off('close', disconnected); }
  });
  app.post('/api/analyze', synchronous('analysis', api.analyzeEula));
  app.post('/api/categories/cards', synchronous('card', api.generateCategoryCards));
  app.post('/api/categories/cards/batch', synchronous('cards', api.generateCategoryCardsBatch));
  app.post('/api/categories/comic', synchronous('comic', api.generateCategoryComic));
  app.post('/api/categories/video/script', synchronous('script', api.generateCategoryVideoScript));
  const directMedia = (kind, fn) => asyncRoute(async (req, res) => {
    validate(kind, req.body);
    if (kind === 'render' && !req.body.comic?.imagePrompt) throw httpError(400, 'Comic scenario is required.');
    const job = store.start({ kind, namespace: 'synchronous', owner: req.owner, payload: req.body, idempotencyKey: req.get('idempotency-key') || req.body.idempotencyKey,
      onCancel: cancelUpstream, runner: async ({ job, signal, update }) => {
        const result = await render(kind === 'render' ? 'image' : 'video', () => { update({ upstreamStarted: true }); return fn({ ...req.body, jobId: job.jobId, signal }); }, signal);
        signal.throwIfAborted();
        if (kind === 'render') {
          const imageUrl = attachArtifact(job, result.image.imageUrl, 'image', security, update);
          return { result: { categoryId: result.categoryId, image: { ...result.image, imagePath: undefined, imageUrl } } };
        }
        const videoUrl = attachArtifact(job, result.videoUrl, 'video', security, update); const { raw, ...video } = result;
        return { result: { ...video, videoUrl } };
      } });
    const abort = () => { if (!res.writableFinished) void store.cancel(job.jobId, req.owner); };
    res.on('close', abort);
    try {
      await store.runtime.get(job.jobId)?.promise;
      if (job.status !== 'ready') throw httpError(job.status === 'expired' ? 504 : 502, job.error || 'Media generation was canceled.');
      res.json(job.result);
    } finally { res.off('close', abort); }
  });
  app.post('/api/categories/comic/render', directMedia('render', api.renderCategoryComicImage));
  app.post('/api/videos/generate', directMedia('video', api.generateCategoryVideo));
  app.get('/api/videos/:jobId', asyncRoute((req, res) => res.json(store.public(store.get(req.params.jobId, req.owner)))));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Document request exceeds the size limit.' });
    const status = error?.name === 'AbortError' ? 499 : error?.name === 'TimeoutError' ? 504 : getErrorStatus(error, error?.status || 500);
    if (status === 429 || status === 503) res.set('Retry-After', '10');
    res.status(status >= 400 && status <= 599 ? status : 500).json(errorPayload(error, 'Request failed.'));
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  const server = app.listen(port, host, () => console.log(`EULALens API listening on http://${host}:${port}`));
  let stopping = false;
  const shutdown = async () => { if (stopping) return; stopping = true; server.close(); await app.locals.close(); await closeProviderConnections(); };
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
}
export default createApp;
