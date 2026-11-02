import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateVideo } from '../server/providers/video.js';
import { renderComicWithHiDream } from '../server/providers/hidream.js';
import { closeProviderConnections, requestJson } from '../server/providers/http-client.js';
import { artifactSource } from '../server/assets.js';
async function provider(t, handler) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.VIDEO_API_URL = base + '/generate'; process.env.VIDEO_API_KEY = 'test-only-key'; process.env.VIDEO_PROVIDER = 'ltx-local';
  process.env.VIDEO_STATUS_URL_TEMPLATE = base + '/status/{jobId}'; process.env.VIDEO_POLL_INTERVAL_MS = '1';
  process.env.HIDREAM_IMAGE_API_URL = base; process.env.HIDREAM_API_KEY = 'test-only-key';
  return base;
}
const json = (res, value) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const category = { id: 'test', title: 'Test', video: { modelPrompt: 'A synthetic video fixture.', durationSeconds: 1 } };
test('async provider is polled until success even when a future URL exists', async t => {
  let calls = 0; let body;
  await provider(t, async (req, res) => {
    if (req.url === '/generate') { let raw = ''; for await (const chunk of req) raw += chunk; body = JSON.parse(raw); return json(res, { status: 'processing', jobId: 'upstream', output: { videoUrl: 'https://future.test/video.mp4' } }); }
    calls++; json(res, { status: 'completed', data: { videoUrl: 'https://future.test/video.mp4' } });
  });
  process.env.VIDEO_MODEL = 'fixture-model';
  const result = await generateVideo({ category, jobId: 'caller' }); assert.equal(result.status, 'completed'); assert.equal(calls, 1); assert.equal(body.model, 'fixture-model');
});
test('expired provider with URL is rejected and cleaned up', async t => {
  let cancellations = 0;
  await provider(t, (req, res) => { if (req.url === '/cancel') { cancellations++; return json(res, { status: 'cancellation-requested' }); } json(res, { status: 'expired', jobId: 'expired-job', videoUrl: 'https://future.test/video.mp4' }); });
  await assert.rejects(generateVideo({ category, jobId: 'caller' }), /expired/); assert.equal(cancellations, 1);
});
test('ambiguous post-submission transport failure cancels both model kinds', async t => {
  const canceled = [];
  await provider(t, async (req, res) => {
    if (req.url === '/cancel') { let raw = ''; for await (const chunk of req) raw += chunk; canceled.push(JSON.parse(raw).jobId); return json(res, { status: 'cancellation-requested' }); }
    req.socket.destroy();
  });
  await assert.rejects(generateVideo({ category, jobId: 'video-a' }));
  await assert.rejects(renderComicWithHiDream({ category, comic: { id: 'a', imagePrompt: 'Synthetic fixture comic prompt.' }, jobId: 'comic-a' }));
  assert.deepEqual(canceled.sort(), ['comic-a', 'video-a']);
});
test('deadline protects stalled JSON body after headers and preserves image URL', async t => {
  const base = await provider(t, (req, res) => { if (req.url === '/stall') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); } else json(res, { imageUrl: 'https://cdn.fixture.test/fixture.png' }); });
  await assert.rejects(requestJson(base + '/stall', { timeoutMs: 30 }), /deadline/);
  const image = await renderComicWithHiDream({ category, comic: { imagePrompt: 'Synthetic fixture comic prompt.' } });
  assert.equal(image.image.imageUrl, 'https://cdn.fixture.test/fixture.png');
});
test('maximum-length category IDs remain valid image metadata across scenarios', async t => {
  let submitted;
  await provider(t, async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; submitted = JSON.parse(raw); json(res, { imageUrl: '/outputs/fixture.png' }); });
  const id = 'x'.repeat(200);
  await renderComicWithHiDream({ category: { id, title: 'Test' }, comic: { id: 'scenario-one', imagePrompt: 'Synthetic fixture comic prompt.' }, jobId: 'image-a' });
  assert.equal(submitted.categoryId, id); assert.equal(submitted.jobId, 'image-a');
});
test('local video default rebases only output assets; diagnostics and unknown hosts rejected', () => {
  delete process.env.VIDEO_PROVIDER; process.env.VIDEO_API_URL = 'http://127.0.0.1:5054/generate';
  assert.equal(artifactSource('https://expired-tunnel.test/outputs/one/movie.mp4', 'video').url, 'http://127.0.0.1:5054/outputs/one/movie.mp4');
  assert.throws(() => artifactSource('http://127.0.0.1:5054/outputs/metrics.json', 'video'), /unsupported/);
  assert.throws(() => artifactSource('https://unknown.test/movie.mp4', 'video'), /not configured/);
});
test.after(() => closeProviderConnections());
