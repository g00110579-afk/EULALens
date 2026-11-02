// Explicit opt-in: submits one native image and one short video via the live API.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
if (!process.argv.includes('--run')) throw new Error('Use --run to authorize real GPU generation.');
const base = process.env.EULALENS_PUBLIC_API || 'https://api.eulalens.stream';
const destination = process.env.EULALENS_ACCEPTANCE_DIR || path.resolve('../audit-2026-11-02/evidence/activation');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const session = await (await fetch(base + '/api/session')).json();
assert(session.sessionToken && session.csrfToken);
const headers = { Authorization: `Bearer ${session.sessionToken}`, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
const jobs = [];
async function request(route, body, extra = {}) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const result = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${result.error || 'API failed'}`); return result;
}
async function complete(route, jobId) {
  for (let i = 0; i < 600; i++) {
    const job = await request(`${route}/jobs/${jobId}`);
    if (job.status === 'ready') return job;
    if (['error', 'canceled', 'expired'].includes(job.status)) throw new Error(`${job.status}: ${job.error}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Live media job exceeded the acceptance deadline.');
}
async function checkAsset(relative, filename) {
  assert.match(relative, /^\/api\/assets\//); const url = new URL(relative, base);
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200);
  const range = await fetch(url, { headers: { Range: 'bytes=0-31' } }); assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 32);
  const raw = await fetch(url); assert.equal(raw.status, 200); const buffer = Buffer.from(await raw.arrayBuffer());
  fs.writeFileSync(path.join(destination, filename), buffer, { mode: 0o600 });
  url.search = ''; const forbidden = await fetch(url, { method: 'HEAD' }); assert.equal(forbidden.status, 404);
  return { bytes: buffer.length, signedHead: 200, signedRange: 206, unsignedHead: 404, localFile: path.join(destination, filename) };
}
const category = { id: 'acceptance_privacy', title: 'Synthetic privacy example', sourceSegments: ['Only your email is shared.'] };
const reports = {}; const started = Date.now();
try {
  const comic = { id: 'acceptance', title: 'A short privacy conversation', imagePrompt: 'A clean friendly editorial illustration in four panels of two adults reading a privacy notice at a desk, an envelope icon and a small lock icon, warm daylight, clear flat colors, coherent hands, no lettering, no watermark.', panels: [{}, {}, {}, {}] };
  const imageRoute = '/api/categories/comic'; const imageStart = await request(imageRoute + '/render/start', { category, comic, documentTitle: 'Synthetic acceptance fixture' }, { 'Idempotency-Key': randomUUID() }); jobs.push([imageRoute, imageStart.jobId]);
  const imageJob = await complete(imageRoute, imageStart.jobId);
  reports.image = { jobId: imageJob.jobId, seconds: (Date.now() - started) / 1000, ...await checkAsset(imageJob.render.image.imageUrl, 'api-comic.png') };
  console.log('Live API image, ownership and signed media passed.');
  const video = { durationSeconds: 4, modelPrompt: 'A calm locked camera medium shot of two friendly adults sitting across a small desk in a bright office. One asks a short question and the other answers. Gentle natural head movements, coherent faces and hands, warm daylight, no visible text, no subtitles, no watermark.', subtitleLines: [{ startSeconds: 0, endSeconds: 1.5, text: 'What is shared?', speaker: 'Customer' }, { startSeconds: 1.6, endSeconds: 3.8, text: 'Only your email.', speaker: 'Provider' }] };
  const videoStarted = Date.now(); const videoRoute = '/api/categories/video';
  const videoStart = await request('/api/videos/generate/start', { category: { ...category, video }, documentTitle: 'Synthetic acceptance fixture' }, { 'Idempotency-Key': randomUUID() }); jobs.push([videoRoute, videoStart.jobId]);
  const videoJob = await complete(videoRoute, videoStart.jobId); assert.equal(videoJob.video.degradation, null); assert.equal(videoJob.video.subtitleLines.length, 2); assert.equal(videoJob.video.dialogueAudio, true);
  reports.video = { jobId: videoJob.jobId, seconds: (Date.now() - videoStarted) / 1000, subtitleLines: videoJob.video.subtitleLines, embeddedSubtitles: videoJob.video.embeddedSubtitles, ...await checkAsset(videoJob.video.videoUrl, 'api-video.mp4') };
  const report = { passed: true, api: base, ...reports };
  fs.writeFileSync(path.join(destination, 'api-media-acceptance.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const [route, jobId] of jobs) await request(`${route}/jobs/${jobId}/cancel`, {}).catch(() => {});
}
