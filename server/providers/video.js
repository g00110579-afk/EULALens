import { httpError } from '../http.js';
import { positiveInt } from '../concurrency.js';
import { requestJson, bearer, requiredEndpoint, delay } from './http-client.js';

function extractVideoResult(data) {
  const videoUrl = data?.video_url || data?.videoUrl || data?.url || data?.output?.video_url || data?.output?.videoUrl || data?.data?.video_url || data?.data?.videoUrl || '';
  const jobId = data?.task_id || data?.taskId || data?.job_id || data?.jobId || data?.id || data?.data?.id || '';
  const status = data?.status || data?.data?.status || (videoUrl ? 'completed' : 'submitted');
  return { videoUrl, jobId, status, embeddedSubtitles: Boolean(data?.embeddedSubtitles || data?.embedded_subtitles || data?.postprocess?.embeddedSubtitles), dialogueAudio: Boolean(data?.dialogueAudio || data?.dialogue_audio || data?.postprocess?.dialogueAudio), raw: data };
}
export async function generateVideo({ category, documentTitle, jobId, signal, onProviderJobId } = {}) {
  const provider = process.env.VIDEO_PROVIDER || 'ltx-local';
  const apiUrl = requiredEndpoint(process.env.VIDEO_API_URL, 'VIDEO_API_URL');
  const apiKey = process.env.VIDEO_API_KEY;
  if (provider === 'ltx-local' && !apiKey) throw httpError(503, 'VIDEO_API_KEY is required for the local model service.');
  const script = category?.video || {};
  const prompt = String(script.modelPrompt || script.model_prompt || script.prompt || '').trim();
  if (!prompt) throw httpError(400, 'A validated video script is required.');
  const duration = Number(script.durationSeconds || script.duration_seconds || process.env.VIDEO_DURATION_SECONDS || 30);
  if (!Number.isFinite(duration) || duration < 1 || duration > 60) throw httpError(400, 'Video duration must be between 1 and 60 seconds.');
  const timeoutMs = positiveInt(process.env.VIDEO_TIMEOUT_MS, 1800000);
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let providerId = jobId;
  try {
    let data = await requestJson(apiUrl, { signal: combined, headers: bearer(apiKey), timeoutMs, body: {
      jobId, model: process.env.VIDEO_MODEL || undefined, prompt, negative_prompt: script.negativePrompt || script.negative_prompt || '', duration_seconds: duration,
      aspect_ratio: process.env.VIDEO_ASPECT_RATIO || '16:9', subtitles: script.subtitleLines || script.subtitle_lines || [],
      shot_plan: script.shotPlan || script.shot_plan || [], metadata: { documentTitle, categoryId: category?.id, categoryTitle: category?.title, videoScript: script }
    } });
    let result = extractVideoResult(data);
    providerId = result.jobId || jobId; onProviderJobId?.(providerId);
    while (!result.videoUrl || !['completed', 'ready', 'succeeded', 'success'].includes(result.status)) {
      if (['failed', 'error', 'canceled', 'cancelled', 'expired'].includes(result.status)) throw httpError(502, `Video provider reported ${result.status}.`);
      if (!providerId || !process.env.VIDEO_STATUS_URL_TEMPLATE) throw httpError(502, 'Video provider returned no playable video and no configured status endpoint.');
      await delay(positiveInt(process.env.VIDEO_POLL_INTERVAL_MS, 2000), combined);
      result = await checkVideoStatus(providerId, { signal: combined });
    }
    if (['failed', 'error', 'canceled', 'cancelled', 'expired'].includes(result.status)) throw httpError(502, `Video provider reported ${result.status}.`);
    return { provider, prompt, ...result, status: 'completed' };
  } catch (error) {
    if (providerId) await cancelVideoGeneration(providerId).catch(() => {});
    if (signal?.aborted) throw signal.reason;
    if (deadline.aborted) throw httpError(504, 'Video generation deadline exceeded.');
    throw error;
  }
}
export async function checkVideoStatus(jobId, { signal } = {}) {
  if (!process.env.VIDEO_STATUS_URL_TEMPLATE || !jobId) throw httpError(503, 'Video status endpoint is not configured.');
  const url = requiredEndpoint(process.env.VIDEO_STATUS_URL_TEMPLATE.replace('{jobId}', encodeURIComponent(jobId)), 'VIDEO_STATUS_URL_TEMPLATE');
  return extractVideoResult(await requestJson(url, { headers: bearer(process.env.VIDEO_API_KEY), signal, timeoutMs: 30000 }));
}
export async function cancelVideoGeneration(jobId) {
  if (!jobId || typeof jobId !== 'string') throw httpError(400, 'A valid video job ID is required.');
  const url = process.env.VIDEO_CANCEL_URL_TEMPLATE
    ? requiredEndpoint(process.env.VIDEO_CANCEL_URL_TEMPLATE.replace('{jobId}', encodeURIComponent(jobId)), 'VIDEO_CANCEL_URL_TEMPLATE')
    : requiredEndpoint(process.env.VIDEO_API_URL, 'VIDEO_API_URL');
  if (!process.env.VIDEO_CANCEL_URL_TEMPLATE) {
    if (!/\/generate\/?$/.test(url.pathname)) throw httpError(503, 'Configure VIDEO_CANCEL_URL_TEMPLATE for this provider.');
    url.pathname = url.pathname.replace(/\/generate\/?$/, '/cancel');
  }
  return requestJson(url, { headers: bearer(process.env.VIDEO_API_KEY), timeoutMs: 10000, body: { jobId } });
}
