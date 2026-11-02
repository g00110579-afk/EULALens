import { Agent } from 'undici';
import { httpError } from '../http.js';

const dispatcher = new Agent({ headersTimeout: 3600000, bodyTimeout: 3600000, connect: { timeout: 10000 }, connections: 8 });
export const closeProviderConnections = () => dispatcher.close();
export async function requestJson(url, { body, headers = {}, signal, timeoutMs = 900000, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const timer = new AbortController(); const timeout = setTimeout(() => timer.abort(new DOMException('Provider deadline exceeded.', 'TimeoutError')), timeoutMs); timeout.unref();
  const combined = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
  try {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: combined, dispatcher });
    const reader = response.body?.getReader(); let length = 0; const chunks = [];
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw httpError(502, 'Provider response is too large.'); }
      chunks.push(Buffer.from(value));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let payload; try { payload = JSON.parse(text); } catch { throw httpError(response.ok ? 502 : response.status, `Provider returned an invalid response (${response.status}).`); }
    if (!response.ok) throw httpError(response.status, String(payload.detail || payload.error || `Provider failed (${response.status}).`).slice(0, 600));
    return payload;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (timer.signal.aborted) throw httpError(504, 'Provider deadline exceeded.');
    if (error.statusCode) throw error;
    throw httpError(502, 'Could not reach the configured model service.');
  } finally { clearTimeout(timeout); }
}
export function bearer(key) { return key ? { Authorization: `Bearer ${key}` } : {}; }
export function requiredEndpoint(value, label) {
  let url; try { url = new URL(value); } catch { throw httpError(503, `${label} is not configured.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw httpError(503, `${label} must be an HTTP endpoint without embedded credentials.`);
  return url;
}
export async function delay(ms, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
