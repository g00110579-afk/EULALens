function extractVideoResult(data) {
  const videoUrl = data?.video_url || data?.videoUrl || data?.url || data?.output?.video_url || data?.output?.videoUrl || data?.data?.video_url || data?.data?.videoUrl || '';
  const jobId = data?.task_id || data?.taskId || data?.job_id || data?.jobId || data?.id || data?.data?.id || '';
  const status = data?.status || data?.data?.status || (videoUrl ? 'completed' : 'submitted');
  const embeddedSubtitles = Boolean(data?.embeddedSubtitles || data?.embedded_subtitles || data?.postprocess?.embeddedSubtitles);
  const dialogueAudio = Boolean(data?.dialogueAudio || data?.dialogue_audio || data?.postprocess?.dialogueAudio);
  return { videoUrl, jobId, status, embeddedSubtitles, dialogueAudio, raw: data };
}

export async function generateVideo({ category, documentTitle, jobId }) {
  const provider = process.env.VIDEO_PROVIDER || 'mock';
  const apiUrl = process.env.VIDEO_API_URL;
  const apiKey = process.env.VIDEO_API_KEY;
  const videoScript = category?.video || {};
  const prompt = videoScript.modelPrompt
    || videoScript.model_prompt
    || videoScript.prompt
    || `Create a short visual explainer for ${category?.title || 'this EULA category'}.`;
  const durationSeconds = Number(videoScript.durationSeconds || videoScript.duration_seconds || process.env.VIDEO_DURATION_SECONDS || 30);
  const negativePrompt = videoScript.negativePrompt || videoScript.negative_prompt || process.env.VIDEO_NEGATIVE_PROMPT || '';

  if (provider === 'mock' || !apiUrl) {
    return {
      provider: 'mock',
      status: 'ready-for-provider',
      jobId: `mock-${Date.now()}`,
      videoUrl: '',
      prompt,
      video: videoScript,
      message: 'Mock mode: add VIDEO_API_URL in .env to call your video provider.'
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const { Agent } = await import('undici');
  const dispatcher = new Agent({ headersTimeout: 30 * 60 * 1000 });

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    dispatcher,
    body: JSON.stringify({
      jobId,
      model: process.env.VIDEO_MODEL || undefined,
      prompt,
      negative_prompt: negativePrompt || undefined,
      duration_seconds: durationSeconds,
      aspect_ratio: process.env.VIDEO_ASPECT_RATIO || '16:9',
      subtitles: videoScript.subtitleLines || videoScript.subtitle_lines || [],
      shot_plan: videoScript.shotPlan || videoScript.shot_plan || [],
      metadata: { documentTitle, categoryId: category?.id, categoryTitle: category?.title, videoScript }
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Video generation failed (${response.status}): ${details}`);
  }

  return { provider, prompt, ...extractVideoResult(await response.json()) };
}

export async function checkVideoStatus(jobId) {
  const template = process.env.VIDEO_STATUS_URL_TEMPLATE;
  const apiKey = process.env.VIDEO_API_KEY;
  if (!template || !jobId) return { status: 'unknown', jobId, videoUrl: '' };

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(template.replace('{jobId}', encodeURIComponent(jobId)), {
    headers
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Video status failed (${response.status}): ${details}`);
  }

  return extractVideoResult(await response.json());
}

export async function cancelVideoGeneration(jobId) {
  if (!jobId || typeof jobId !== 'string') {
    throw new Error('A valid video job ID is required.');
  }

  const generateUrl = process.env.VIDEO_API_URL;
  if (!generateUrl) {
    throw new Error('VIDEO_API_URL is not configured.');
  }

  const cancelUrlObject = new URL(generateUrl);
  if (!/\/generate\/?$/.test(cancelUrlObject.pathname)) {
    throw new Error('VIDEO_API_URL must end with /generate.');
  }
  cancelUrlObject.pathname = cancelUrlObject.pathname.replace(/\/generate\/?$/, '/cancel');
  const cancelUrl = cancelUrlObject.toString();
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.VIDEO_API_KEY) {
    headers.Authorization = `Bearer ${process.env.VIDEO_API_KEY}`;
  }

  const response = await fetch(cancelUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jobId }),
    signal: AbortSignal.timeout(10000)
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.error || payload.detail || `Video cancellation failed (${response.status}).`
    );
  }

  return payload;
}

