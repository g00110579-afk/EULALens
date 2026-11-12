// EULALENS_PLAYWRIGHT_MODULE points to an installed Playwright ESM entry.
// All model responses are fixtures; the real browser, API, auth, PDF parser,
// job store, media proxy, UI state and reload restoration are exercised.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import express from 'express';
import { createApp } from '../server/index.js';
import { closeProviderConnections } from '../server/providers/http-client.js';
const { chromium } = await import(process.env.EULALENS_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.EULALENS_PLAYWRIGHT_MODULE).href : 'playwright');
const root = path.resolve('.');
const pdfjsBuild = process.env.EULALENS_PDFJS_BUILD_DIR || path.resolve('node_modules/pdfjs-dist/build');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'eula-browser-'));
const servers = []; let browser; let app; let releaseMedia;
const firstAnalysis = Promise.withResolvers(), secondAnalysis = Promise.withResolvers();
const canceledStory = Promise.withResolvers();
async function listen(application) { const server = application.listen(0, '127.0.0.1'); servers.push(server); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
function pdf(text) {
  const stream = `BT /F1 12 Tf 40 750 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(data); data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
try {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=160x80', '-vf', 'drawbox=x=79:y=0:w=2:h=ih:color=white:t=fill', '-frames:v', '1', path.join(temporary, 'image.png')]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=12', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(temporary, 'video.mp4')]);
  execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=24000','-t','1.2','-codec:a','libmp3lame',path.join(temporary,'voice.mp3')]);
  const spoken=[];
  const model = express(); model.use((req, res, next) => req.get('authorization') === 'Bearer fixture-key' ? next() : res.sendStatus(401)); model.use('/outputs', express.static(temporary));
  const modelBase = await listen(model);
  process.env.HIDREAM_IMAGE_API_URL = modelBase; process.env.VIDEO_API_URL = modelBase + '/generate'; process.env.VIDEO_PROVIDER = 'ltx-local'; process.env.HIDREAM_API_KEY = process.env.VIDEO_API_KEY = 'fixture-key';
  const site = express(); site.use(express.static(root)); const siteBase = await listen(site);
  const configResponse = await fetch(siteBase + '/runtime-config.js');
  assert.equal(configResponse.status, 200, 'Published browser configuration must exist outside private .runtime');
  assert.match(await configResponse.text(), /window\.EULALENS_API_BASE/);
  const counts = { analysis: 0, cards: 0, comic: 0, image: 0, video: 0 };
  const mediaGate = new Promise(resolve => { releaseMedia = resolve; });
  const categories = [{ id: 'license', title: 'License scope', severity: 'low', summary: '<img src=x onerror="window.auditSentinel=1">', sourceSegments: ['You may use the fictional app on one device.'], lenses: { impact: 'One device only.' }, lookouts: ['Check devices.'] }];
  const comics = ['first', 'second'].map(id => ({ id, title: `${id} scenario`, storySummary:`A summary of the ${id} scenario.`, scenes:[{narration:`The ${id} story begins.`},{narration:`The ${id} story ends.`}], imagePrompt: 'Synthetic image fixture for ' + id, panels: [{ title: 'First', body: 'A source-backed example.' }, { title: 'Second', caption: 'A second scene.' }] }));
  app = createApp({ directory: path.join(temporary, 'jobs'), origins: [siteBase], cancelImage: async () => {}, handlers: {
    synthesizeComicNarration: async ({text})=>{spoken.push(text);return fs.readFileSync(path.join(temporary,'voice.mp3'));},
    analyzeEula: async ({ text, fileName }) => {
      counts.analysis++;
      assert(text.includes('fictional'));
      const second = fileName === 'Second.pdf';
      await (second ? secondAnalysis : firstAnalysis).promise;
      return { analysis: { fileName, categories: second ? [{...categories[0], title:'Second agreement scope'}] : categories } };
    },
    generateCategoryCardsBatch: async ({ onProgress }) => { counts.cards++; const entry = { ok: true, categoryId: 'license', cards: [{ question: '<b>How many devices?</b>', answer: 'One', backTitle: 'Scope', backDetail: 'One device.' }] }; await onProgress(entry, 0); return { results: [entry] }; },
    generateCategoryComic: async ({category, signal}) => {
      counts.comic++;
      if (category.title === 'Second agreement scope') {
        await new Promise((resolve, reject) => {
          function abort() { canceledStory.resolve(); reject(signal.reason); }
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, {once:true});
        });
      }
      await mediaGate;
      return { comic: { comics, selectedComicId: 'first' } };
    },
    renderCategoryComicImage: async ({comic}) => {
      counts.image++;
      return { image: { imageUrl: modelBase + '/outputs/image.png',
        frames: comic.id === 'second' ? [[.02, .04, .48, .96], [.52, .04, .98, .96]] : undefined } };
    },
    generateCategoryVideoScript: async () => { await mediaGate; return { video: { modelPrompt: 'Synthetic video fixture', subtitleLines: [] } }; },
    generateCategoryVideo: async () => { counts.video++; return { status: 'completed', videoUrl: modelBase + '/outputs/video.mp4', embeddedSubtitles: false, raw: { subtitleLines: [{ startSeconds: 0, endSeconds: 0.8, text: 'One device.', speaker: 'User' }], degraded: true } }; },
    cancelCategoryVideo: async () => ({})
  } });
  const apiBase = await listen(app);
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' }); const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('BROWSER ERROR:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('BROWSER CONSOLE:', message.text()); });
  await page.addInitScript(base => { window.EULALENS_API_BASE = base; }, apiBase);
  // Override the published config with the fixture endpoint so no test
  // request can reach production; its static file was verified above.
  await page.route('**/runtime-config.js', route => route.fulfill({
    body: `window.EULALENS_API_BASE = ${JSON.stringify(apiBase)};`, contentType: 'text/javascript'
  }));
  await page.route('https://api.eulalens.stream/**', route => route.abort('blockedbyclient'));
  // Use the same pinned PDF.js bytes already installed for the original build;
  // no CDN availability is necessary for deterministic parsing verification.
  await page.route('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/*.mjs', route => {
    const file = path.basename(new URL(route.request().url()).pathname);
    return route.fulfill({ path: path.join(pdfjsBuild, file), contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(siteBase, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Zoom', exact: true }).click();
  await page.locator('.gallery-choice').first().click();
  await page.getByRole('button', { name: 'Switch EULA' }).click();
  const switcher = page.getByRole('dialog', { name: 'Switch EULA' });
  async function chooseFile(file) {
    const chooser = page.waitForEvent('filechooser');
    await switcher.getByRole('button', { name: 'Upload a PDF' }).click();
    await (await chooser).setFiles(file);
  }
  await chooseFile([]);
  assert(await switcher.isVisible());
  await chooseFile({ name: 'other.txt', mimeType: 'text/plain', buffer: Buffer.from('Not a PDF') });
  assert.match(await page.locator('#switch-upload-status').innerText(), /upload a PDF/i);
  await chooseFile({ name: 'broken.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF- broken') });
  await page.waitForFunction(() => /invalid|could not/i.test(document.getElementById('switch-upload-status').textContent));
  assert(await switcher.isVisible());
  assert.equal(counts.analysis, 0);
  const filename = 'fixture<img src=x onerror=window.auditSentinel=2>.pdf';
  const uploadRow = name => page.locator('#upload-list li').filter({has:page.getByText(name,{exact:true})});
  const firstRow = uploadRow(filename), secondRow = uploadRow('Second.pdf');
  const openRow = row => row.getByRole('button',{name:'Open',exact:true}).click();
  await chooseFile({ name: filename, mimeType: 'application/pdf', buffer: pdf('You may use the fictional app on one device. Do not redistribute it.') });
  await firstRow.waitFor();
  assert.match(await firstRow.innerText(), /Queued|Analyzing|Reading PDF/i);
  assert(await page.locator('#upload-dropzone').isEnabled());
  const another = page.waitForEvent('filechooser');
  await page.locator('#upload-dropzone').click();
  await (await another).setFiles({name:'Second.pdf',mimeType:'application/pdf',buffer:pdf('This second fictional agreement also permits one device.')});
  await secondRow.waitFor();
  assert.equal(await page.locator('#upload-list li').count(),2);
  firstAnalysis.resolve();
  await firstRow.getByText('Waiting for first video', {exact:true}).waitFor();
  assert.equal(await firstRow.getByRole('button', {name:/First video ready/}).count(), 0);
  await openRow(firstRow);
  const galleryChoice = page.getByRole('dialog', { name: 'Choose a category' }).getByRole('button', {name:'License scope', exact:true});
  await galleryChoice.waitFor();
  await page.locator('#category-gallery.art-ready').waitFor();
  const art = galleryChoice.locator('.gallery-art');
  assert.equal(await art.getAttribute('data-topics'), 'key book');
  assert(await art.locator('[data-object="key"]').isVisible());
  assert.equal(counts.image, 0);
  assert.equal(counts.video, 0);
  const initialArtwork = await art.innerHTML();
  await page.locator('#close-gallery').click();
  assert(await page.locator('#dashboard-tab').isVisible());
  await openRow(firstRow);
  assert(await page.locator('#category-gallery').isVisible());
  await galleryChoice.click();
  secondAnalysis.resolve();
  releaseMedia();
  await page.waitForFunction(() => document.querySelector('#cat-cards')?.textContent.includes('How many devices?'), undefined, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.auditSentinel), undefined);
  assert.equal(await page.locator('#cat-summary img').count(), 0);
  assert.equal(await page.locator('#cat-cards b').count(), 0);
  assert.match(await page.locator('#doc-analysis-title').textContent(), /fixture<img/);
  assert.equal(await page.locator('#cat-summary').textContent(), '<img src=x onerror="window.auditSentinel=1">');
  assert.equal(await page.locator('#tabbtn-video').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#category-position').textContent(), /Category 1 of 1/);
  await page.getByRole('button', { name: 'Category details', exact: true }).click();
  assert.equal(await page.locator('#cat-impact li').innerText(), 'One device only.');
  assert.equal(await page.locator('#cat-lookouts li').innerText(), 'Check devices.');
  await page.locator('#source-evidence summary').click();
  assert(await page.locator('#source-evidence details').getAttribute('open') !== null);
  await page.keyboard.press('Escape');
  await page.locator('#tabbtn-comic').click();
  await page.waitForFunction(() => document.querySelector('#cat-comic-img')?.naturalWidth > 0, undefined, { timeout: 30000 });
  assert.equal(await page.locator('#comic-caption').textContent(), 'A source-backed example.');
  await page.waitForFunction(() => comicReader.boxes.length === 2);
  assert.equal(await page.locator('#comic-summary').textContent(), 'A summary of the first scenario.');
  assert(await page.locator('#comic-audio').evaluate(audio => audio.paused && !audio.hasAttribute('src')));
  await page.getByRole('button', {name:'Full comic',exact:true}).click();
  assert.deepEqual(await page.locator('#comic-crop .comic-panel-caption').allTextContents(), ['A source-backed example.','A second scene.']);
  await page.locator('#comic-crop button[data-scene="0"]').click();
  assert(await page.locator('#comic-crop .comic-panel-caption').isVisible());
  await page.getByRole('button',{name:'Play comic',exact:true}).click();
  await page.getByRole('button',{name:'Full comic',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('comic-audio').currentTime>0);
  await page.waitForFunction(()=>document.getElementById('comic-position').textContent==='Scene 2 of 2');
  assert.equal(await page.locator('#comic-reader.is-playing button[aria-current=true]').getAttribute('data-scene'), '1');
  await page.getByRole('button',{name:'Replay comic',exact:true}).waitFor();
  assert.deepEqual(spoken,['The first story begins.','The first story ends.','The second story begins.','The second story ends.']);
  assert.equal(await page.locator('#comic-caption').textContent(), 'A second scene.');
  assert.equal(await page.locator('#comic-scenarios button').count(), 2);
  // Some image hosts allow display but deny canvas pixel reads.
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.getImageData;
    window.restoreComicPixelAccess = () => { CanvasRenderingContext2D.prototype.getImageData = original; };
    CanvasRenderingContext2D.prototype.getImageData = () => { throw new DOMException('Cross-origin image', 'SecurityError'); };
  });
  await page.locator('#comic-scenarios button').nth(1).click();
  await page.waitForFunction(() => document.querySelector('#cat-comic-title')?.textContent === 'second scenario' && document.querySelector('#cat-comic-img')?.naturalWidth > 0);
  assert.equal(await page.locator('#comic-position').textContent(), 'Scene 1 of 2');
  assert.equal(await page.locator('#comic-summary').textContent(), 'A summary of the second scenario.');
  assert(await page.getByRole('button', {name:'Play comic',exact:true}).isVisible());
  assert(await page.locator('#comic-audio').evaluate(audio => audio.paused && !audio.hasAttribute('src')));
  await page.waitForFunction(() => comicReader.boxes[0]?.x === .02 && comicReader.boxes[0].y === .04);
  const legacyWidths = await page.evaluate(() => {
    const widths = comicSceneBounds(document.getElementById('cat-comic-img'), {}, 2).map(box => box.width);
    window.restoreComicPixelAccess();
    return widths;
  });
  assert.deepEqual(legacyWidths, [.5, .5]);
  assert.equal(await page.locator('#comic-narration').getAttribute('aria-pressed'), 'true');
  await page.locator('#comic-playback').click();
  await page.waitForFunction(()=>!document.getElementById('comic-audio').paused && document.getElementById('comic-audio').currentTime>0);
  await page.locator('#tabbtn-video').click();
  assert(await page.locator('#comic-audio').evaluate(a=>a.paused));
  await page.waitForFunction(() => document.querySelector('#cat-video')?.readyState >= 1, undefined, { timeout: 30000 });
  await page.locator('#view-gallery').click();
  assert.equal(await art.innerHTML(), initialArtwork, 'Finishing media must preserve an uploaded category’s illustration');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cat-video track').count(), 1);
  await page.waitForFunction(() => document.querySelector('#cat-video')?.textTracks[0]?.cues?.length === 1);
  assert.deepEqual(await page.evaluate(() => { const cue = document.querySelector('#cat-video').textTracks[0].cues[0]; return { text: cue.text, start: cue.startTime, end: cue.endTime }; }), { text: 'One device.', start: 0, end: 0.8 });
  assert.match(await page.locator('#video-degradation').textContent(), /audio/i);
  assert(await page.locator('#source-evidence details').getAttribute('open') !== null, 'Generation updates retain expanded source evidence');
  await page.locator('#tabbtn-eula').click(); assert.match(await page.locator('#source-evidence').textContent(), /one device/);
  // Abandon a replacement while its text is still being read. Its completion
  // must leave the open document, original PDF and accepted jobs intact.
  const originalPdf = await page.locator('#cat-eula-frame').getAttribute('src');
  await page.evaluate(() => {
    const original = extractPdfText;
    extractPdfText = () => new Promise(resolve => {
      window.completePendingRead = () => { extractPdfText = original; resolve('fictional replacement'); };
    });
  });
  await page.getByRole('button', { name: 'Switch EULA' }).click();
  await chooseFile({ name: 'replacement.pdf', mimeType: 'application/pdf', buffer: pdf('Another fictional license.') });
  await page.waitForFunction(() => typeof window.completePendingRead === 'function');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.completePendingRead());
  assert.equal(await page.locator('#cat-eula-frame').getAttribute('src'), originalPdf);
  assert.equal(await page.locator('#tabbtn-eula').getAttribute('aria-selected'), 'true');
  assert.equal(counts.analysis, 2);
  // Both PDFs finish analysis without stealing the current reader. The second
  // comic is deliberately held in its provider while the first reader is used.
  await page.getByRole('button',{name:'EULALens home',exact:true}).click();
  await openRow(secondRow);
  await page.getByRole('dialog',{name:'Choose a category'}).getByRole('button',{name:'Second agreement scope'}).click();
  assert.equal(await page.locator('#doc-analysis-title').innerText(),'Second.pdf');
  await page.getByRole('button',{name:'EULALens home',exact:true}).click();
  assert.match(await firstRow.innerText(), /Comics 1\/1/);
  assert.match(await secondRow.innerText(), /Comics 0\/1/);
  await page.waitForFunction(() => [...uploads.values()].every(run => run.categories[0]?.videoStatus === 'ready' && run.categories[0]?.comicJobId));
  const savedReferences = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('eulalens:active-run:')).map(key => localStorage.getItem(key)).join('\n'));
  assert(!savedReferences.includes(filename));
  assert(!savedReferences.includes('Second.pdf'));
  assert(!savedReferences.includes('You may use the fictional app'));
  const beforeReload = { ...counts };
  await page.reload({ waitUntil: 'domcontentloaded' });
  await secondRow.getByRole('button',{name:'Open',exact:true}).waitFor();
  await secondRow.getByRole('button',{name:'Cancel',exact:true}).click();
  await Promise.race([
    canceledStory.promise,
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('Cancel did not reach the second comic provider')),10000).unref()),
  ]);
  assert.equal(await secondRow.count(),0);
  await firstRow.getByRole('button', {name:'First video ready · License scope'}).click();
  assert.equal(await page.getByRole('dialog', {name:'Choose a category'}).count(), 0);
  assert.equal(await page.locator('#cat-title').innerText(), 'License scope');
  assert.equal(await page.locator('#tabbtn-video').getAttribute('aria-selected'), 'true');
  await page.waitForFunction(() => document.querySelector('#cat-video')?.readyState >= 1);
  await page.waitForFunction(() => mediaScheduler.jobs.size === 0 && categories[0].cardsStatus === 'ready' && categories[0].videoStatus === 'ready' && categories[0].selectedComicId === 'second' && categories[0].comicStatus === 'ready');
  assert.deepEqual(counts, beforeReload, 'Reload must reconnect, not regenerate');
  // Simulate a reopened browser whose anonymous session credential is gone.
  // Retained opaque run IDs must fail safely with an actionable explanation.
  await page.context().clearCookies(); await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  const expired = page.locator('#upload-list li').filter({hasText:/no longer available.*browser session/});
  await expired.waitFor();
  assert.match(await expired.textContent(), /Upload the PDF again/);
  assert.equal(await page.locator('#upload-list li').count(),1);
  assert.deepEqual(counts, beforeReload, 'An inaccessible saved run must not regenerate automatically');
  await page.getByRole('button', {name:'Reset demo'}).click();
  await page.getByText('Demo reset. Ready for a new PDF.').waitFor();
  assert.equal(await page.locator('#upload-list li').count(), 0);
  const uploadAgain = () => page.locator('#upload-input').setInputFiles({name:'Second.pdf', mimeType:'application/pdf', buffer:pdf('Another fictional license agreement.')});
  await uploadAgain();
  await openRow(secondRow);
  await page.locator('.gallery-choice').first().click();
  await page.getByRole('button', {name:'Switch EULA'}).click();
  await switcher.getByRole('button', {name:'Reset demo'}).click();
  await page.getByText('Demo reset. Ready for a new PDF.').waitFor();
  await page.reload({waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('#upload-list li').count(), 0);
  await uploadAgain();
  await secondRow.getByRole('button', {name:'Open', exact:true}).waitFor();
  await page.getByRole('button', {name:'Reset demo'}).click();
  await page.getByText('Demo reset. Ready for a new PDF.').waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', browser: 'Chromium', coverage: ['PDF picker cancel, invalid file and second PDF admission while busy', 'explicit opening from the upload queue', 'independent category/media progress for two PDFs', 'authenticated API jobs', 'escaped untrusted content', 'signed image/video media', 'narration and highlighted panels in a generated comic', 'scenario selection', 'speech captions and degradation', 'visible Impact, Lookouts and supporting clauses', 'reconnect both uploads without duplicate generation', 'cancel one provider job after reload without losing the other PDF', 'expired-session restore recovery', 'reset from home and reader, reload, and identical reupload'], requests: counts }, null, 2));
} finally {
  firstAnalysis.resolve(); secondAnalysis.resolve();
  releaseMedia?.();
  await browser?.close(); await app?.locals.close();
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  await closeProviderConnections(); fs.rmSync(temporary, { recursive: true, force: true });
}
