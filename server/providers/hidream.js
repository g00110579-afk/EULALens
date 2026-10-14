import { httpError } from '../http.js';

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

async function readResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) return response.json();
  const text = await response.text();
  return text ? { detail: text } : {};
}

function resolveImageUrl(imageUrl, baseUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
        return `${baseUrl}${url.pathname}${url.search}${url.hash}`;
      }
    } catch {
      return value;
    }
    return value;
  }
  if (value.startsWith('/')) return `${baseUrl}${value}`;
  return value;
}

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

export async function renderComicWithHiDream({ category, comic, documentTitle, jobId } = {}) {
  const baseUrl = (process.env.HIDREAM_IMAGE_API_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw httpError(503, 'HiDream image service is not configured. Set HIDREAM_IMAGE_API_URL.');
  }

  const prompt = String(comic?.imagePrompt || comic?.rawImagePrompt || '').trim();
  if (!prompt) throw httpError(400, 'Comic image prompt is required before rendering.');

  const timeoutMs = readPositiveInteger(process.env.HIDREAM_IMAGE_TIMEOUT_MS, 900000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.HIDREAM_API_KEY) {
      headers.Authorization = `Bearer ${process.env.HIDREAM_API_KEY}`;
    }

    response = await fetch(`${baseUrl}/generate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jobId,
        categoryId: [category?.id || comic?.categoryId || 'category', comic?.id].filter(Boolean).join('-'),
        title: comic?.title || category?.title || documentTitle || 'EULA comic',
        prompt,
        layoutBboxes: layoutBboxesForPanels(Array.isArray(comic?.panels) ? comic.panels.length : 6)
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw httpError(504, 'HiDream image generation timed out.');
    }
    throw httpError(502, `Could not reach HiDream image service at ${baseUrl}. Start the HiDream server or update HIDREAM_IMAGE_API_URL. ${error?.message || 'Request failed.'}`);
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readResponse(response);
  if (!response.ok) {
    const detail = payload.detail || payload.error || 'HiDream image generation failed.';
    throw httpError(response.status, detail);
  }

  if (!payload.imageUrl) {
    throw httpError(502, 'HiDream did not return an image URL.');
  }

  // Serve generated artwork through the EULALens backend rather than
  // exposing the internal HiDream service on port 5052.
  const imageFilename = payload.imagePath
    ? payload.imagePath.split('/').pop()
    : String(payload.imageUrl || '').split('/').pop();

  const publicImageUrl = imageFilename
    ? `/api/comic-assets/${encodeURIComponent(imageFilename)}`
    : '';

  return {
    categoryId: payload.categoryId || category?.id || comic?.categoryId || 'category',
    image: {
      imageUrl: publicImageUrl,
      imagePath: payload.imagePath || '',
      prompt: payload.prompt || prompt,
      refinedPrompt: payload.refinedPrompt || '',
      seed: payload.seed,
      height: payload.height,
      width: payload.width,
      scheduler: payload.scheduler || ''
    }
  };
}

export async function cancelHiDreamJob(jobId) {
  if (!jobId || typeof jobId !== 'string') {
    throw httpError(400, 'A valid HiDream job ID is required.');
  }

  const baseUrl = (process.env.HIDREAM_IMAGE_API_URL || '').replace(/\/+$/, '');
  if (!baseUrl) {
    throw httpError(503, 'HiDream image service is not configured.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.HIDREAM_API_KEY) {
    headers.Authorization = `Bearer ${process.env.HIDREAM_API_KEY}`;
  }

  let response;
  try {
    response = await fetch(`${baseUrl}/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    throw httpError(502, `Could not send HiDream cancellation request: ${error.message}`);
  }

  const payload = await readResponse(response);

  if (!response.ok) {
    throw httpError(
      response.status,
      payload.detail || payload.error || 'HiDream cancellation failed.'
    );
  }

  return payload;
}
