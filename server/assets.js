import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { httpError } from './http.js';
import { requiredEndpoint, bearer } from './providers/http-client.js';

const extensions = { image: /\.(png|webp|jpe?g)$/i, video: /\.mp4$/i };
export function artifactSource(value, kind) {
  const base = requiredEndpoint(kind === 'image' ? process.env.HIDREAM_IMAGE_API_URL : process.env.VIDEO_API_URL, 'Model asset endpoint');
  let url; try { url = new URL(value, base); } catch { throw httpError(502, 'Provider returned an invalid media URL.'); }
  if (!extensions[kind]?.test(url.pathname) || url.username || url.password) throw httpError(502, 'Provider returned an unsupported media asset.');
  const localProvider = kind === 'image' ? Boolean(process.env.HIDREAM_IMAGE_API_URL) : (process.env.VIDEO_PROVIDER || 'ltx-local') === 'ltx-local';
  if (localProvider && url.pathname.startsWith('/outputs/')) url = new URL(url.pathname + url.search, base.origin);
  const allowed = new Set([base.origin, ...(process.env.MEDIA_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)]);
  if (!['http:', 'https:'].includes(url.protocol) || !allowed.has(url.origin)) throw httpError(502, 'Media host is not configured in MEDIA_ALLOWED_ORIGINS.');
  return { url: url.href, kind, authenticated: url.origin === base.origin };
}
export function attachArtifact(job, value, kind, security, update) {
  const source = artifactSource(value, kind); const id = randomUUID();
  update({ assets: { ...(job.assets || {}), [id]: source } });
  return security.assetUrl(job, id);
}
export async function serveArtifact(req, res, store, security) {
  const job = store.jobs.get(req.params.jobId); const asset = job?.assets?.[req.params.assetId];
  if (!job || !asset || !security.ownsAsset(req, job, req.params.assetId)) throw httpError(404, 'Media not found or link expired.');
  const current = artifactSource(asset.url, asset.kind);
  const key = asset.kind === 'image' ? process.env.HIDREAM_API_KEY : process.env.VIDEO_API_KEY;
  const headers = { ...(current.authenticated ? bearer(key) : {}), ...(req.get('range') ? { Range: req.get('range') } : {}) };
  const controller = new AbortController();
  const abort = () => controller.abort(); req.on('aborted', abort); res.on('close', abort);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
  try {
    const response = await fetch(current.url, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal, redirect: 'manual' });
    if (![200, 206, 416].includes(response.status)) { await response.body?.cancel(); throw httpError(502, 'Generated media is unavailable.'); }
    res.status(response.status);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) if (response.headers.has(header)) res.set(header, response.headers.get(header));
    res.set('Cache-Control', 'private, max-age=300'); res.set('X-Content-Type-Options', 'nosniff');
    if (req.method === 'HEAD' || !response.body) { await response.body?.cancel(); res.end(); }
    else await pipeline(Readable.fromWeb(response.body), res);
  } finally { req.off('aborted', abort); res.off('close', abort); }
}
