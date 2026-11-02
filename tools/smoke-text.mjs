// Exercises the repaired HTTP/job/auth/Qwen path using a synthetic document.
// Does not submit image or video rendering. Reads .env from the project directory.
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { closeProviderConnections } from '../server/providers/http-client.js';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-live-smoke-'));
const app = createApp({ directory: path.join(temporary, 'jobs') });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const started = Date.now();
try {
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { Authorization: 'Bearer ' + session.sessionToken, 'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/json' };
  async function request(route, body) {
    const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180000) });
    const data = await response.json(); if (!response.ok) throw new Error(JSON.stringify(data)); return data;
  }
  async function complete(route, jobId) {
    for (let i = 0; i < 180; i++) {
      const job = await request(`${route}/jobs/${jobId}`);
      if (job.status === 'ready') return job;
      if (['error', 'canceled', 'expired'].includes(job.status)) throw new Error(job.error || job.status);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Smoke job did not complete.');
  }
  const text = 'Synthetic license fixture. You may use this fictional software on one device. You may make one backup copy. You must not redistribute copies of the software. You must immediately notify the provider of unauthorized use.';
  const start = await request('/api/analyze/start', { text, fileName: 'synthetic-regression.txt', idempotencyKey: 'smoke-analysis' });
  const analysis = (await complete('/api/analyze', start.jobId)).result.analysis;
  assert(analysis.categories.length > 0);
  for (const category of analysis.categories) for (const quote of category.sourceSegments) assert(text.includes(quote), `Unverified quote: ${quote}`);
  const categories = analysis.categories.slice(0, 2);
  const cardsStart = await request('/api/categories/cards/batch/start', { categories, documentTitle: 'Synthetic fixture', idempotencyKey: 'smoke-cards' });
  const cards = await complete('/api/categories/cards/batch', cardsStart.jobId);
  assert.equal(cards.result.results.length, categories.length);
  assert(cards.result.results.every(result => result.ok && result.cards.length));
  console.log(JSON.stringify({ status: 'passed', seconds: (Date.now() - started) / 1000, analyzedCategories: analysis.categories.length, validatedQuotes: analysis.categories.reduce((n, c) => n + c.sourceSegments.length, 0), cardCategories: cards.result.results.length }, null, 2));
} finally {
  await app.locals.close(); await new Promise(resolve => server.close(resolve)); await closeProviderConnections(); fs.rmSync(temporary, { recursive: true, force: true });
}
