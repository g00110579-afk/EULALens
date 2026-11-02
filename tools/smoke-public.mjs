// Read-only public UI/API verification; no inference jobs are submitted.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.env.EULALENS_PLAYWRIGHT_MODULE || '/tmp/eulalens-browser-tests/node_modules/playwright/index.mjs'));
const site = process.env.EULALENS_PUBLIC_SITE || 'https://g00110579-afk.github.io/EULALens/';
const destination = process.env.EULALENS_ACCEPTANCE_DIR || path.resolve('../audit-2026-11-02/evidence/activation');
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const pageErrors = []; const networkErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('requestfailed', r => networkErrors.push({ url: r.url().split('?')[0], error: r.failure()?.errorText }));
  const response = await page.goto(site, { waitUntil: 'domcontentloaded', timeout: 60000 }); assert.equal(response.status(), 200);
  await page.waitForFunction(() => Boolean(window.EULALensRuntime) && typeof liveApi !== 'undefined', undefined, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    await liveApi.session();
    const readiness = await liveApi.json('/api/readiness');
    const unauthorized = await fetch(LIVE_API_BASE + '/api/jobs', { credentials: 'omit' });
    const pdf = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.mjs');
    return { apiBase: LIVE_API_BASE, readiness, unauthenticatedJobsStatus: unauthorized.status, pdfjsVersion: pdf.version, documentTitle: document.title };
  });
  assert.equal(result.readiness.ready, true); assert.equal(result.unauthenticatedJobsStatus, 401); assert.equal(result.pdfjsVersion, '6.5.438'); assert.deepEqual(pageErrors, []);
  if (process.env.EULALENS_MEDIA_JOB_ID) {
    const id = process.env.EULALENS_MEDIA_JOB_ID;
    assert.match(id, /^clip-[a-f0-9-]+$/);
    const job = JSON.parse(fs.readFileSync(path.join('.runtime/jobs', id + '.json'), 'utf8'));
    const url = new URL(job.video.videoUrl, result.apiBase).href;
    result.generatedVideoPlayback = await page.evaluate(async source => {
      const video = document.createElement('video'); video.muted = true; video.playsInline = true;
      video.style.cssText = 'position:fixed;right:12px;bottom:12px;width:352px;z-index:99999';
      document.body.append(video); video.src = source;
      await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('Generated video failed to load')); });
      await video.play(); await new Promise(resolve => setTimeout(resolve, 500)); video.pause();
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime, readyState: video.readyState };
    }, url);
    assert(result.generatedVideoPlayback.currentTime > 0); assert.equal(result.generatedVideoPlayback.width, 704);
  }
  await page.screenshot({ path: path.join(destination, 'published-ui.png'), fullPage: false });
  const report = { passed: true, site, ...result, pageErrors, networkErrors, inferenceSubmitted: false };
  fs.writeFileSync(path.join(destination, 'public-browser.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
