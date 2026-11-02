import { httpError } from '../http.js';
import { positiveInt } from '../concurrency.js';
import { requestJson, bearer, requiredEndpoint } from './http-client.js';

function layoutBboxesForPanels(panelCount = 6) {
  const count = Math.max(1, Math.min(Number(panelCount) || 6, 8));
  const cols = 2;
  const rows = count <= 4 ? 2 : count <= 6 ? 3 : 4;
  const margin = 0.02;
  const gutter = 0.02;
  const width = (1 - margin * 2 - gutter * (cols - 1)) / cols;
  const height = (1 - margin * 2 - gutter * (rows - 1)) / rows;
  const boxes = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x1 = margin + col * (width + gutter);
      const y1 = margin + row * (height + gutter);
      boxes.push([
        Number(x1.toFixed(4)),
        Number((x1 + width).toFixed(4)),
        Number(y1.toFixed(4)),
        Number((y1 + height).toFixed(4))
      ]);
    }
  }

  return boxes.slice(0, count);
}

export async function renderComicWithHiDream({ category, comic, documentTitle, jobId, signal } = {}) {
  const base = requiredEndpoint(process.env.HIDREAM_IMAGE_API_URL, 'HIDREAM_IMAGE_API_URL');
  const key = process.env.HIDREAM_API_KEY;
  if (!key) throw httpError(503, 'HIDREAM_API_KEY is required.');
  const prompt = String(comic?.imagePrompt || comic?.rawImagePrompt || '').trim();
  if (prompt.length < 20 || prompt.length > 20000) throw httpError(400, 'A validated comic image prompt of 20 to 20,000 characters is required.');
  try {
    const payload = await requestJson(new URL('generate', base.href.replace(/\/?$/, '/')), {
      signal, timeoutMs: positiveInt(process.env.HIDREAM_IMAGE_TIMEOUT_MS, 900000), headers: bearer(key),
      body: { jobId, categoryId: category?.id || comic?.categoryId || 'category',
        title: comic?.title || category?.title || documentTitle || 'EULA comic', prompt,
        layoutBboxes: layoutBboxesForPanels(Array.isArray(comic?.panels) ? comic.panels.length : 6) }
    });
    if (!payload.imageUrl) throw httpError(502, 'HiDream did not return an image URL.');
    const imageUrl = new URL(payload.imageUrl, base).href;
    if (!/^https?:\/\//.test(imageUrl)) throw httpError(502, 'HiDream returned an invalid image URL.');
    return { categoryId: category?.id || payload.categoryId, image: {
      imageUrl, imagePath: payload.imagePath || '', prompt: payload.prompt || prompt,
      seed: payload.seed, height: payload.height, width: payload.width, scheduler: payload.scheduler || '', jobId: payload.jobId || jobId
    } };
  } catch (error) {
    if (jobId) await cancelHiDreamJob(jobId).catch(() => {});
    throw error;
  }
}
export async function cancelHiDreamJob(jobId) {
  if (!jobId || typeof jobId !== 'string') throw httpError(400, 'A valid image job ID is required.');
  const base = requiredEndpoint(process.env.HIDREAM_IMAGE_API_URL, 'HIDREAM_IMAGE_API_URL');
  return requestJson(new URL('cancel', base.href.replace(/\/?$/, '/')), {
    timeoutMs: 10000, headers: bearer(process.env.HIDREAM_API_KEY), body: { jobId }
  });
}
