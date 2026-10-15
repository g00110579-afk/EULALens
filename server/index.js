import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { host, port, maxAnalyzePayloadMb, presentationPrecomputedRoot } from './config.js';
import {
  analyzeEula,
  generateCategoryCards,
  generateCategoryCardsBatch,
  generateCategoryComic,
  generateCategoryVideo,
  generateCategoryVideoScript,
  getVideoStatus,
  cancelCategoryVideo,
  health,
  renderCategoryComicImage
} from './handlers.js';
import { errorPayload, getErrorStatus } from './http.js';
import { cancelHiDreamJob } from './providers/hidream.js';

const app = express();

// In-memory jobs for long-running live comic generation.
// The browser starts a job, then polls its status so Cloudflare does not
// have to keep one HTTP request open while Qwen and HiDream are running.
const analysisJobs = new Map();
const cardJobs = new Map();
const comicJobs = new Map();
const videoJobs = new Map();

function createComicJobId() {
  return `comic-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createVideoJobId() {
  return `video-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

app.use(cors());
app.use(express.json({ limit: `${maxAnalyzePayloadMb}mb` }));
app.use('/api/presentation/assets', express.static(presentationPrecomputedRoot));

// Serve generated HiDream comic images through the EULALens backend.
// This allows remote browsers to access images without exposing port 5052.
const hiDreamOutputRoot =
  '/data/d1/vanishri/EULALens/Data/experiments/image-generation/hidream-o1/app-renders';

app.use('/api/comic-assets', express.static(hiDreamOutputRoot));

// Serve generated LTX videos through the EULALens backend.
// This avoids exposing the separate LTX service or depending on its tunnel.
const ltxVideoOutputRoot =
  '/data/d1/vanishri/EULALens/Data/experiments/video-generation/ltx-2.3/app-renders';

app.use('/api/video-assets', express.static(ltxVideoOutputRoot));

app.get('/api/health', (_req, res) => {
  res.json(health());
});

app.post('/api/analyze', asyncRoute(async (req, res) => {
  res.json(await analyzeEula(req.body));
}));

app.post('/api/analyze/start', (req, res) => {
  const jobId = `analysis-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const payload = req.body;

  analysisJobs.set(jobId, {
    jobId,
    status: 'processing',
    createdAt: Date.now()
  });

  res.status(202).json({ jobId, status: 'processing' });

  void (async () => {
    try {
      const result = await analyzeEula(payload);
      const job = analysisJobs.get(jobId);
      if (!job) return;
      job.status = 'ready';
      job.result = result;
      job.completedAt = Date.now();
    } catch (error) {
      const job = analysisJobs.get(jobId);
      if (!job) return;
      job.status = 'error';
      job.error = error?.message || 'EULA analysis failed.';
      job.completedAt = Date.now();
      console.error(`Analysis job ${jobId} failed:`, error);
    }
  })();
});

app.get('/api/analyze/jobs/:jobId', (req, res) => {
  const job = analysisJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Analysis job not found.' });
  return res.json(job);
});

app.post('/api/categories/cards', asyncRoute(async (req, res) => {
  res.json(await generateCategoryCards(req.body));
}));

app.post('/api/categories/cards/batch', asyncRoute(async (req, res) => {
  res.json(await generateCategoryCardsBatch(req.body));
}));

app.post('/api/categories/cards/batch/start', (req, res) => {
  const jobId = `cards-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  cardJobs.set(jobId, {
    jobId,
    status: 'processing',
    createdAt: Date.now()
  });

  res.status(202).json({ jobId, status: 'processing' });

  void (async () => {
    try {
      const result = await generateCategoryCardsBatch(req.body);
      const job = cardJobs.get(jobId);
      if (!job) return;
      job.status = 'ready';
      job.result = result;
      job.completedAt = Date.now();
    } catch (error) {
      const job = cardJobs.get(jobId);
      if (!job) return;
      job.status = 'error';
      job.error = error?.message || 'Cue-card generation failed.';
      job.completedAt = Date.now();
      console.error(`Cue-card job ${jobId} failed:`, error);
    }
  })();
});

app.get('/api/categories/cards/batch/jobs/:jobId', (req, res) => {
  const job = cardJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Cue-card job not found.' });
  res.set('Cache-Control', 'no-store');
  return res.json(job);
});

app.post('/api/categories/comic', asyncRoute(async (req, res) => {
  res.json(await generateCategoryComic(req.body));
}));

app.post('/api/categories/comic/start', (req, res) => {
  const jobId = createComicJobId();

  comicJobs.set(jobId, {
    jobId,
    status: 'queued',
    createdAt: Date.now()
  });

  // Return immediately. Qwen and HiDream continue after the response.
  res.status(202).json({
    jobId,
    status: 'queued'
  });

  void (async () => {
    try {
      const job = comicJobs.get(jobId);
      job.status = 'generating-story';

      const comicResult = await generateCategoryComic(req.body);
      if (job.status === 'canceled') return;
      const comicPayload = comicResult.comic || comicResult;

      let selectedComic = comicPayload;

      if (Array.isArray(comicPayload?.comics)) {
        selectedComic =
          comicPayload.comics.find(
            comic => comic.id === comicPayload.selectedComicId
          ) ||
          comicPayload.comics[0];
      }

      if (!selectedComic) {
        throw new Error('Qwen did not return a usable comic.');
      }

      if (job.status === 'canceled') return;
      job.status = 'rendering-image';
      job.comic = selectedComic;

      if (job.status === 'canceled') return;
      const renderResult = await renderCategoryComicImage({
        ...req.body,
        comic: selectedComic,
        jobId
      });

      if (job.status === 'canceled') return;
      job.status = 'ready';
      job.render = renderResult;
      job.completedAt = Date.now();
    } catch (error) {
      const job = comicJobs.get(jobId);

      if (job && job.status !== 'canceled') {
        job.status = 'error';
        job.error = error?.message || 'Comic generation failed.';
        job.completedAt = Date.now();
      }

      console.error(`Comic job ${jobId} failed:`, error);
    }
  })();
});

app.post('/api/categories/comic/jobs/:jobId/cancel', asyncRoute(async (req, res) => {
  const job = comicJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Comic job not found.' });
  }

  if (['ready', 'error', 'canceled'].includes(job.status)) {
    return res.json(job);
  }

  const previousStatus = job.status;
  job.status = 'canceled';
  job.completedAt = Date.now();

  if (previousStatus === 'rendering-image') {
    try {
      await cancelHiDreamJob(job.jobId);
    } catch (error) {
      // HiDream may have finished before cancellation arrived.
      console.warn(`HiDream cancellation for ${job.jobId}:`, error.message);
    }
  }

  return res.json(job);
}));

app.get('/api/categories/comic/jobs/:jobId', (req, res) => {
  const job = comicJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Comic job not found.'
    });
  }

  return res.json(job);
});

app.post('/api/categories/video/start', (req, res) => {
  const jobId = createVideoJobId();

  videoJobs.set(jobId, {
    jobId,
    status: 'queued',
    createdAt: Date.now()
  });

  // Return immediately. Qwen and LTX continue after the response.
  res.status(202).json({
    jobId,
    status: 'queued'
  });

  void (async () => {
    try {
      const job = videoJobs.get(jobId);
      job.status = 'generating-script';

      const scriptResult = await generateCategoryVideoScript(req.body);
      if (job.status === 'canceled') return;
      const videoScript = scriptResult.video;

      if (!videoScript?.modelPrompt) {
        throw new Error('Qwen did not return a usable video script.');
      }

      job.videoScript = videoScript;
      job.status = 'generating-video';

      const category = {
        ...req.body.category,
        video: videoScript
      };

      const videoResult = await generateCategoryVideo({
        ...req.body,
        category,
        jobId
      });

      if (job.status === 'canceled') return;

      // LTX returns its own public URL, which may point to an ephemeral
      // tunnel. When the local output path is available, expose the video
      // through the EULALens backend instead.
      const outputFile =
        videoResult?.raw?.outputFile ||
        videoResult?.raw?.output_file ||
        videoResult?.raw?.postprocess?.finalOutputFile;

      let videoUrl = videoResult?.videoUrl || '';

      if (outputFile) {
        const relativePath = path.relative(ltxVideoOutputRoot, outputFile);

        if (
          relativePath &&
          !relativePath.startsWith('..') &&
          !path.isAbsolute(relativePath)
        ) {
          videoUrl = `/api/video-assets/${relativePath
            .split(path.sep)
            .map(encodeURIComponent)
            .join('/')}`;
        }
      }

      job.status = 'ready';
      job.video = {
        ...videoResult,
        videoUrl
      };
      job.completedAt = Date.now();
    } catch (error) {
      const job = videoJobs.get(jobId);

      if (job && job.status !== 'canceled') {
        job.status = 'error';
        job.error = error?.message || 'Video generation failed.';
        job.completedAt = Date.now();
      }

      console.error(`Video job ${jobId} failed:`, error);
    }
  })();
});

app.get('/api/categories/video/jobs/:jobId', (req, res) => {
  const job = videoJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Video job not found.'
    });
  }

  return res.json(job);
});

app.post('/api/categories/video/jobs/:jobId/cancel', asyncRoute(async (req, res) => {
  const job = videoJobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Video job not found.' });
  }

  if (['ready', 'error', 'canceled'].includes(job.status)) {
    return res.status(409).json({
      error: `Video job is already ${job.status}.`,
      job
    });
  }

  // Mark canceled first so the background task cannot overwrite this state.
  job.status = 'canceled';
  job.canceledAt = Date.now();
  job.completedAt = Date.now();

  try {
    const result = await cancelCategoryVideo(job.jobId);
    return res.json({
      jobId: job.jobId,
      status: 'canceled',
      cancellation: result
    });
  } catch (error) {
    // Keep the canceled state, but report that provider cancellation failed.
    return res.status(502).json({
      jobId: job.jobId,
      status: 'canceled',
      error: error?.message || 'Could not contact the video provider.'
    });
  }
}));

app.post('/api/categories/video/script', asyncRoute(async (req, res) => {
  res.json(await generateCategoryVideoScript(req.body));
}));

app.post('/api/categories/comic/render', asyncRoute(async (req, res) => {
  res.json(await renderCategoryComicImage(req.body));
}));

app.post('/api/videos/generate', asyncRoute(async (req, res) => {
  res.json(await generateCategoryVideo(req.body));
}));

app.get('/api/videos/:jobId', asyncRoute(async (req, res) => {
  res.json(await getVideoStatus(req.params.jobId));
}));

app.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `This EULA is too large to analyze in one request. Try a shorter document or paste the relevant sections.`
    });
  }

  const statusCode = getErrorStatus(error, 500);
  if (statusCode >= 400 && statusCode < 600) {
    return res.status(statusCode).json(errorPayload(error, 'Request failed.'));
  }

  return next(error);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(port, host, () => console.log(`EULALens API listening on http://${host}:${port}`));
}

export default app;
