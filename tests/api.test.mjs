import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { closeProviderConnections } from '../server/providers/http-client.js';

test('the public review serves its application and PDF reader alongside the authenticated upload API', async t => {
  const { base } = await fixture(t);
  const redirect = await fetch(base + '/review', { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), '/review/');
  const page = await fetch(base + '/review/');
  assert.match(await page.text(), /id="upload-input"/);
  const config = await (await fetch(base + '/review/runtime-config.js')).text();
  assert.match(config, /EULALENS_API_BASE = location\.origin/);
  for (const file of ['pdfjs/pdf.min.mjs', 'pdfjs/pdf.worker.min.mjs', 'category-gallery.js', 'images/category-objects.webp']) {
    assert.equal((await fetch(base + '/review/' + file, { method: 'HEAD' })).status, 200, file);
  }
  for (const resource of ['.env', '.runtime/session.key', 'server/config.js']) {
    assert.equal((await fetch(base + '/review/' + resource, { method: 'HEAD' })).status, 404);
  }
  assert.equal((await fetch(base + '/api/session', { headers: { Origin: base } })).status, 200);
  assert.equal((await fetch(base + '/api/session', { headers: { Origin: 'https://raw.githack.com' } })).status, 403);
});
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, handlers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-api-'));
  const app = createApp({ directory: path.join(root, 'jobs'), origins: ['https://frontend.test'], handlers,
    cancelImage: async () => {}, secret: 'test-only-secret-with-more-than-thirty-two-characters' });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await app.locals.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const login = async () => (await fetch(base + '/api/session', { headers: { Origin: 'https://frontend.test' } })).json();
  const session = await login();
  const request = (url, body, s = session) => fetch(base + url, { method: body ? 'POST' : 'GET', headers: { Origin: 'https://frontend.test', Authorization: 'Bearer ' + s.sessionToken, 'X-CSRF-Token': s.csrfToken, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { app, base, request, login, session };
}
test('session, CSRF, origin, input validation and owner boundaries', async t => {
  const f = await fixture(t, { analyzeEula: async () => ({ analysis: { categories: [] } }) });
  assert.equal((await fetch(f.base + '/api/jobs')).status, 401);
  assert.equal((await fetch(f.base + '/api/session', { headers: { Origin: 'https://evil.test' } })).status, 403);
  const noCsrf = await fetch(f.base + '/api/analyze/start', { method: 'POST', headers: { Authorization: 'Bearer ' + f.session.sessionToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Long enough synthetic document fixture' }) });
  assert.equal(noCsrf.status, 403);
  assert.equal((await f.request('/api/analyze/start', { text: 'tiny' })).status, 400);
  const response = await f.request('/api/analyze/start', { text: 'Long enough synthetic document fixture', idempotencyKey: 'once' }); assert.equal(response.status, 202);
  const start = await response.json(); await tick();
  const owned = await (await f.request('/api/analyze/jobs/' + start.jobId)).json(); assert.equal(owned.status, 'ready'); assert.equal(owned.owner, undefined); assert.equal(owned.payload, undefined);
  const other = await f.login(); assert.equal((await f.request('/api/analyze/jobs/' + start.jobId, undefined, other)).status, 404);
  const again = await (await f.request('/api/analyze/start', { text: 'Long enough synthetic document fixture', idempotencyKey: 'once' })).json(); assert.equal(again.jobId, start.jobId);
});
test('cards publish partial results before slow sibling finishes, all stages can cancel', async t => {
  let release;
  const f = await fixture(t, { generateCategoryCardsBatch: async ({ onProgress, signal }) => {
    await onProgress({ categoryId: 'b', ok: true, cards: [] }, 1);
    await onProgress({ categoryId: 'a', ok: true, cards: [] }, 0);
    await new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    return { results: [] };
  } });
  const job = await (await f.request('/api/categories/cards/batch/start', { categories: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] })).json();
  await tick(); const progress = await (await f.request('/api/categories/cards/batch/jobs/' + job.jobId)).json();
  assert.deepEqual(progress.results.map(result => result.categoryId), ['a', 'b']); assert.notEqual(progress.status, 'ready');
  const canceled = await (await f.request('/api/categories/cards/batch/jobs/' + job.jobId + '/cancel', {})).json(); assert.equal(canceled.status, 'canceled'); release();
});
test('comic collections survive and each scenario has an owned render job', async t => {
  process.env.HIDREAM_IMAGE_API_URL = 'http://127.0.0.1:5052';
  const rendered = [];
  const comics = ['a', 'b'].map(id => ({ id, imagePrompt: 'A synthetic image prompt for ' + id }));
  const f = await fixture(t, { generateCategoryComic: async () => ({ comic: { comics, selectedComicId: 'a' } }), renderCategoryComicImage: async ({ comic }) => { rendered.push(comic.id); return { image: { imageUrl: 'http://127.0.0.1:5052/outputs/' + comic.id + '.png' } }; } });
  const start = await (await f.request('/api/categories/comic/start', { category: { id: 'c', title: 'C' } })).json(); await tick();
  const job = await (await f.request('/api/categories/comic/jobs/' + start.jobId)).json();
  assert.equal(job.status, 'ready'); assert.equal(job.comics.length, 2); assert.equal(job.assets, undefined); assert.match(job.render.image.imageUrl, /^\/api\/assets\/.+token=/);
  const next = await (await f.request('/api/categories/comic/jobs/' + start.jobId + '/scenarios/b/render', {})).json(); await tick();
  const renderedJob = await (await f.request('/api/categories/comic/jobs/' + next.jobId)).json(); assert.equal(renderedJob.comic.id, 'b'); assert.equal(renderedJob.comics.length, 2); assert.deepEqual(rendered, ['a', 'b']);
  assert.equal((await fetch(f.base + '/api/video-assets/arbitrary/metrics.json')).status, 401);
});
test.after(() => closeProviderConnections());

test('legacy synchronous and durable video routes keep distinct response contracts and dedupe within each', async t => {
  process.env.VIDEO_PROVIDER = 'ltx-local'; process.env.VIDEO_API_URL = 'http://127.0.0.1:5054/generate';
  for (const directFirst of [true, false]) {
    let generated = 0;
    const f = await fixture(t, {
      generateCategoryVideoScript: async ({ category }) => ({ video: category.video }),
      generateCategoryVideo: async () => { generated++; return { status: 'completed', videoUrl: 'http://127.0.0.1:5054/outputs/fixture.mp4' }; }
    });
    const body = { category: { id: 'c', title: 'C', video: { modelPrompt: 'Synthetic fixture video.', durationSeconds: 1 } }, idempotencyKey: 'same-input' };
    const direct = async () => {
      const response = await f.request('/api/videos/generate', body); assert.equal(response.status, 200);
      const result = await response.json(); assert.equal(result.status, 'completed'); assert.match(result.videoUrl, /^\/api\/assets\//);
    };
    const durable = async () => {
      const response = await f.request('/api/categories/video/start', body); assert.equal(response.status, 202);
      const started = await response.json(); await tick();
      const result = await (await f.request('/api/categories/video/jobs/' + started.jobId)).json();
      assert.equal(result.status, 'ready'); assert.match(result.video.videoUrl, /^\/api\/assets\//); assert.ok(result.videoScript.modelPrompt);
    };
    if (directFirst) { await direct(); await durable(); } else { await durable(); await direct(); }
    await direct(); await durable(); assert.equal(generated, 2);
  }
});

test('comic narration is owner-scoped, available as soon as the script exists, and cached per scenario', async t => {
  let started, finishImage;
  const rendering = new Promise(resolve => { started = resolve; });
  const image = new Promise(resolve => { finishImage = resolve; });
  const spoken = [];
  const comics = [
    { id: 'primary', imagePrompt: 'Original image prompt', panels: [{ body: 'Caption' }], scenes: [{ narration: 'Original narration.' }] },
    { id: 'other', imagePrompt: 'Alternative image prompt', panels: [{ body: 'A caption.', slots: [{ text: 'A caption.' }, { text: 'Spoken words.' }] }] }
  ];
  const f = await fixture(t, {
    generateCategoryComic: async () => ({ comic: { comics } }),
    renderCategoryComicImage: async () => { started(); return image; },
    synthesizeComicNarration: async ({ text }) => { spoken.push(text); return Buffer.from('synthetic audio'); }
  });
  try {
    const { jobId } = await (await f.request('/api/categories/comic/start', { category: { id: 'c', title: 'Review' } })).json();
    await rendering;
    await tick();
    assert.deepEqual(spoken, ['Original narration.', 'A caption.\nSpoken words.'],
      'Both scenarios must be prepared while artwork is pending, before any reader requests audio');
    const root = '/api/categories/comic/jobs/' + jobId + '/scenarios/';
    const primary = root + 'primary/narration/0';
    assert.equal((await f.request(primary, {}, await f.login())).status, 404);
    assert.equal((await f.request(primary, { text: 'Do not read user text' })).status, 400);
    assert.equal((await f.request(root + 'other/narration/-1', {})).status, 400);
    assert.equal((await f.request(root + 'other/narration/1', {})).status, 404);
    assert.equal((await f.request(root + 'missing/narration/0', {})).status, 404);
    const noCsrf = await fetch(f.base + primary, { method: 'POST', headers: { Authorization: 'Bearer ' + f.session.sessionToken } });
    assert.equal(noCsrf.status, 403);
    for (const url of [primary, root + 'other/narration/0', primary]) {
      const response = await f.request(url, {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'audio/mpeg');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(await response.text(), 'synthetic audio');
    }
    assert.deepEqual(spoken, ['Original narration.', 'A caption.\nSpoken words.']);
  } finally {
    finishImage({ image: { imageUrl: 'http://127.0.0.1:5052/outputs/fixture.png' } });
  }
});
