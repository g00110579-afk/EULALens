import { buildMockAnalysis } from './mockAnalysis.js';
import { isMockMode, isPresentationMode } from './config.js';
import { httpError } from './http.js';
import { buildPresentationAnalysis, getPresentationHealth } from './presentationMode.js';
import {
  analyzeWithQwen,
  generateCardsBatchWithQwen,
  generateCardsWithQwen,
  generateComicWithQwen,
  generateVideoScriptWithQwen
} from './providers/qwen.js';
import { renderComicWithHiDream } from './providers/hidream.js';
import {
  generateVideo,
  checkVideoStatus,
  cancelVideoGeneration
} from './providers/video.js';

function withoutSourceText(analysis) {
  if (!analysis || typeof analysis !== 'object') return analysis;
  const { sourceText: _sourceText, ...rest } = analysis;
  return rest;
}

export function health() {
  const presentation = isPresentationMode();
  return {
    ok: true,
    mode: isMockMode() ? 'mock' : (presentation ? 'presentation' : 'live'),
    mockMode: isMockMode(),
    presentationMode: presentation,
    presentation: presentation ? getPresentationHealth() : { enabled: false }
  };
}

export async function analyzeEula({ text, fileName } = {}) {
  const eulaText = String(text || '').trim();
  const documentName = String(fileName || 'Pasted_EULA.txt');

  if (eulaText.length < 20) {
    throw httpError(400, 'Please paste or upload a longer EULA before analyzing.');
  }

  if (isPresentationMode()) {
    const presentationAnalysis = buildPresentationAnalysis({ text: eulaText, fileName: documentName });
    if (presentationAnalysis) return { analysis: withoutSourceText(presentationAnalysis) };
  }

  if (isMockMode()) {
    return { analysis: withoutSourceText(buildMockAnalysis(eulaText, documentName)) };
  }

  try {
    return { analysis: withoutSourceText(await analyzeWithQwen({ text: eulaText, fileName: documentName })) };
  } catch (error) {
    if (isPresentationMode() && /QWEN_API_KEY/i.test(error?.message || '')) {
      throw httpError(
        400,
        `No precomputed presentation match was found for "${documentName}", and live Qwen is not configured. Upload one of the seven bundled EULAs or set QWEN_API_KEY to analyze a new document.`
      );
    }
    throw error;
  }
}

function fallbackCards(category = {}) {
  const id = category.id || 'category';
  const title = category.title || 'Category';

  return [
    {
      id: `${id}-meaning`,
      question: `What does ${title} mean?`,
      answer: 'Meaning',
      frontDetail: category.summary || `This category highlights terms related to ${title.toLowerCase()}.`,
      backTitle: 'What to check',
      backDetail: category.lenses?.impact || 'Review the wording and confirm whether it affects your intended use.'
    }
  ];
}

export async function generateCategoryCards({ category, documentTitle } = {}) {
  if (!category?.id && !category?.title) throw httpError(400, 'Category is required.');

  if (isMockMode()) {
    return {
      categoryId: category.id || 'category',
      cards: Array.isArray(category.cards) && category.cards.length ? category.cards : fallbackCards(category)
    };
  }

  return generateCardsWithQwen({ category, documentTitle });
}

export async function generateCategoryCardsBatch({ categories, documentTitle } = {}) {
  if (!Array.isArray(categories)) throw httpError(400, 'Categories must be an array.');

  if (isMockMode()) {
    return {
      results: categories.map((category) => ({
        ok: true,
        categoryId: category.id || 'category',
        cards: Array.isArray(category.cards) && category.cards.length ? category.cards : fallbackCards(category)
      }))
    };
  }

  return {
    results: await generateCardsBatchWithQwen({ categories, documentTitle })
  };
}

function fallbackComic(category = {}) {
  const title = category.title || 'Category';
  const panels = Array.isArray(category.comic) && category.comic.length
    ? category.comic
    : [
      { title: 'Clause Appears', body: `${title} language appears in the agreement.` },
      { title: 'User Checks Impact', body: category.lenses?.impact || 'The user reviews what this category changes in practice.' },
      { title: 'Decision Point', body: 'The user compares the wording against their intended use before accepting.' }
    ];

  return {
    categoryId: category.id || 'category',
    comic: {
      id: `${category.id || 'category'}-scenario`,
      categoryId: category.id || 'category',
      title: `${title} Comic`,
      scenarioTitle: `${title} Scenario`,
      protagonistGoal: `Understand how ${title.toLowerCase()} affects the intended use.`,
      visualReadThrough: 'A user notices agreement wording, checks the practical effect, and changes their decision.',
      storySummary: category.summary || `${title} explained as a short story.`,
      mainCharacter: {
        role: 'User',
        appearance: 'A focused person reviewing an agreement on a laptop'
      },
      scenes: panels.map((panel, index) => ({
        sceneNumber: index + 1,
        title: panel.title,
        narration: panel.body,
        dialogue: '',
        visualDescription: panel.body,
        legalBasis: []
      })),
      panels,
      comics: [{
        id: `${category.id || 'category'}-scenario`,
        categoryId: category.id || 'category',
        title: `${title} Comic`,
        scenarioTitle: `${title} Scenario`,
        protagonistGoal: `Understand how ${title.toLowerCase()} affects the intended use.`,
        visualReadThrough: 'A user notices agreement wording, checks the practical effect, and changes their decision.',
        storySummary: category.summary || `${title} explained as a short story.`,
        panels,
        scenes: panels.map((panel, index) => ({
          sceneNumber: index + 1,
          title: panel.title,
          narration: panel.body,
          dialogue: '',
          visualDescription: panel.body,
          legalBasis: []
        })),
        imagePrompt: ''
      }],
      imagePrompt: ''
    }
  };
}

function fallbackVideoScript(category = {}) {
  const title = category.title || 'Category';
  return {
    categoryId: category.id || 'category',
    video: {
      categoryId: category.id || 'category',
      title: `${title} Video`,
      durationSeconds: Number(process.env.VIDEO_DURATION_SECONDS || 30),
      storyGoal: category.summary || `Explain ${title.toLowerCase()} through one practical workflow.`,
      visualStyle: 'clean light line-art 2D animated explainer video',
      shotPlan: [
        {
          startSeconds: 0,
          endSeconds: 8,
          visualBeat: `A user starts a normal workflow affected by ${title.toLowerCase()}.`,
          camera: 'stable wide shot',
          legalPoint: category.lenses?.impact || category.impact || ''
        },
        {
          startSeconds: 8,
          endSeconds: 20,
          visualBeat: 'The workflow hits a visible restriction, handoff, lock, receipt, or blocked path.',
          camera: 'simple object close-up',
          legalPoint: 'Check the source wording before relying on the workflow.'
        },
        {
          startSeconds: 20,
          endSeconds: 30,
          visualBeat: 'The user chooses a safer next step with a checklist, approval, reminder, or locked folder.',
          camera: 'stable closing shot',
          legalPoint: 'Use the clause as a practical decision point.'
        }
      ],
      subtitleLines: [
        { startSeconds: 0, endSeconds: 6, speaker: 'User', text: 'Can I do this the usual way?' },
        { startSeconds: 8, endSeconds: 15, speaker: 'Reviewer', text: 'Pause first. This agreement changes that step.' },
        { startSeconds: 20, endSeconds: 28, speaker: 'User', text: 'Then I will use the approved path.' }
      ],
      audioPlan: 'Add deterministic character dialogue audio and matching subtitles after video generation.',
      prompt: `30 second clean light line-art 2D animated explainer video, simple flat-shaded characters, smooth cartoon motion, limited camera movement. A person tries an ordinary workflow for ${title}, another person tries a risky shortcut, and a visible boundary stops the shortcut. A reviewer shows the approved path with a separate token, folder, tray, receipt, or locked item, then the work continues safely. Use one plain professional setting with bare walls, readable body language, consistent character designs, simple props, clean professional educational animation, stable composition. No readable text anywhere, no labels, no posters, no signs, no screen writing, no logos, no model-generated subtitles, no speech bubbles.`,
      modelPrompt: `30 second clean light line-art 2D animated explainer video, simple flat-shaded characters, smooth cartoon motion, limited camera movement. A person tries an ordinary workflow for ${title}, another person tries a risky shortcut, and a visible boundary stops the shortcut. A reviewer shows the approved path with a separate token, folder, tray, receipt, or locked item, then the work continues safely. Use one plain professional setting with bare walls, readable body language, consistent character designs, simple props, clean professional educational animation, stable composition. No readable text anywhere, no labels, no posters, no signs, no screen writing, no logos, no model-generated subtitles, no speech bubbles.`,
      negativePrompt: 'photorealistic, live action, readable text, words, captions, subtitles, logos, watermarks, posters, signs, UI labels, screen writing, brand names, yellow tint, sepia, parchment, paper texture, whiteboard, marker drawing, visible drawing hand, distorted hands, extra fingers, duplicated faces, jitter, flicker, blurry, low quality, clutter'
    }
  };
}

export async function generateCategoryComic({ category, documentTitle } = {}) {
  if (!category?.id && !category?.title) throw httpError(400, 'Category is required.');

  if (isMockMode()) return fallbackComic(category);

  return generateComicWithQwen({ category, documentTitle });
}

export async function generateCategoryVideoScript({ category, documentTitle } = {}) {
  if (!category?.id && !category?.title) throw httpError(400, 'Category is required.');

  if (isMockMode()) return fallbackVideoScript(category);

  return generateVideoScriptWithQwen({ category, documentTitle });
}

export async function renderCategoryComicImage({ category, comic, documentTitle, jobId } = {}) {
  if (!category?.id && !category?.title) throw httpError(400, 'Category is required.');
  if (!comic) throw httpError(400, 'Comic is required.');

  return renderComicWithHiDream({ category, comic, documentTitle, jobId });
}

export async function generateCategoryVideo({ category, documentTitle, jobId } = {}) {
  if (!category?.title) throw httpError(400, 'Category is required.');
  return generateVideo({ category, documentTitle, jobId });
}

export async function getVideoStatus(jobId) {
  return checkVideoStatus(jobId);
}

export async function cancelCategoryVideo(jobId) {
  return cancelVideoGeneration(jobId);
}
