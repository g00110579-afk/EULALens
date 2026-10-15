function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function readBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function extractQwenOutput(payload) {
  const message = payload?.choices?.[0]?.message || {};
  const parts = [];

  if (typeof message.content === 'string' && message.content.trim()) {
    parts.push(message.content.trim());
  }

  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === 'string' && reasoning.trim()) {
    parts.push(`Reasoning:\n${reasoning.trim()}`);
  }

  return parts.join('\n\n') || safeJsonStringify(payload);
}

function makeQwenJsonError({ rawOutput, payload, debugOutput, label, message }) {
  const error = new Error(message || `Qwen did not return the expected JSON for ${label}.`);

  if (debugOutput) {
    error.details = {
      provider: 'qwen',
      label,
      finishReason: payload?.choices?.[0]?.finish_reason || null,
      rawOutput: rawOutput || '<empty>'
    };
  }

  return error;
}

function getQwenConfig() {
  const apiKey = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY;
  const baseUrl = (process.env.QWEN_BASE_URL || process.env.DASHSCOPE_BASE_URL || 'http://localhost:8000/v1').replace(/\/$/, '');
  const model = process.env.QWEN_MODEL || process.env.DASHSCOPE_MODEL || 'qwen3.5-9b';
  const debugOutput = readBoolean(process.env.QWEN_DEBUG_OUTPUT, false);

  if (!apiKey) throw new Error('QWEN_API_KEY is missing. Add a local vLLM key, or set MOCK_MODE=true only for development mock data.');
  return { apiKey, baseUrl, model, debugOutput };
}

async function requestQwenJson({ config, messages, maxTokens, label, validate }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      reasoning_effort: 'none',
      include_reasoning: false,
      chat_template_kwargs: { enable_thinking: false },
      messages
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Qwen request failed for ${label} (${response.status}): ${details}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const rawOutput = extractQwenOutput(payload);

  const parsed = parseJson(content);
  if (!parsed || (validate && !validate(parsed))) {
    console.warn(`[Qwen] ${label}: invalid JSON, attempt ${attempt}/3, finish_reason=${payload?.choices?.[0]?.finish_reason || 'unknown'}`);
    if (attempt < 3) continue;
    throw makeQwenJsonError({
      rawOutput,
      payload,
      debugOutput: config.debugOutput,
      label,
      message: `Qwen did not return the expected JSON for ${label}.`
    });
  }

  return parsed;
  }
}

function slugify(value, fallback = 'category') {
  const slug = String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug || fallback;
}

function titleize(value) {
  return String(value || 'Category')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function truncate(value, limit = 240) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 3)}...` : clean;
}

const overlayPositionLabels = {
  top_left: 'top-left',
  top_right: 'top-right',
  middle_left: 'middle-left',
  middle_right: 'middle-right',
  bottom_left: 'bottom-left',
  bottom_right: 'bottom-right',
  center: 'center'
};

const imageCellLabels = [
  'top-left',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-right',
  'lower-left',
  'lower-right'
];

function overlaySpaceInstructionFromPanels(panels = []) {
  const frameInstructions = panels
    .map((panel, index) => {
      const positions = [...new Set((panel?.slots || [])
        .map((slot) => overlayPositionLabels[slot.position])
        .filter(Boolean))];
      if (!positions.length) return '';
      return `frame ${index + 1}: ${positions.join(' and ')}`;
    })
    .filter(Boolean);

  if (!frameInstructions.length) {
    return 'Leave clean negative space for app-rendered speech/thought bubbles and callouts, but do not draw those bubbles inside the generated image.';
  }

  return `Keep these app-overlay areas uncluttered: ${frameInstructions.join('; ')}. Do not draw speech bubbles, thought bubbles, labels, titles, or readable text there; the app will render overlays later.`;
}

function gridDimensionsForCount(count) {
  const safeCount = Math.max(1, Math.min(Number(count) || 6, 8));
  return {
    count: safeCount,
    cols: 2,
    rows: safeCount <= 4 ? 2 : safeCount <= 6 ? 3 : 4
  };
}

function gridInstructionFromPanels(panels = []) {
  const count = Math.max(1, Math.min(panels.length || 6, 8));
  if (count <= 4) {
    return 'Exactly four equal unlabeled illustration frames filling the image, arranged in a strict 2-column by 2-row grid and separated only by clear gutters. No frame may span multiple cells. No page title, frame numbers, captions, labels, storyboard header, or margin text.';
  }
  if (count <= 6) {
    return 'Exactly six equal unlabeled illustration frames filling the image, arranged in a strict 2-column by 3-row grid and separated only by clear gutters. No frame may span multiple cells. No page title, frame numbers, captions, labels, storyboard header, or margin text.';
  }
  return 'Exactly eight equal unlabeled illustration frames filling the image, arranged in a strict 2-column by 4-row grid and separated only by clear gutters. No frame may span multiple cells. No page title, frame numbers, captions, labels, storyboard header, or margin text.';
}

function cleanImageSceneDescription(value) {
  return String(value || '')
    .replace(/\bFrame\s*:?/gi, '')
    .replace(/\bPanel\s*\d*\s*:?/gi, '')
    .replace(/\b(comic|panel|caption|label|title|header|heading|storyboard|contact sheet)\b/gi, 'visual detail')
    .replace(/\b(sign|whiteboard|clipboard|document|screen|tablet)\s+(?:showing|with|displaying|titled|named|reading)[^.]*\./gi, 'plain unlabeled $1 in the scene.')
    .replace(/\bwith the words?[^.]*\./gi, 'with abstract marks.')
    .replace(/\b(?:red\s+)?stop\s+sign\b/gi, 'plain red octagonal blocker with no letters')
    .replace(/\bstop\s+sticker\b/gi, 'plain red blocker with no letters')
    .replace(/\bwarning\s+sign\b/gi, 'plain abstract warning object with no letters')
    .replace(/(^|[\s([{])"[^"]{1,80}"(?=$|[\s,.;:)])/g, '$1abstract marks')
    .replace(/(^|[\s([{])'[^']{1,80}'(?=$|[\s,.;:)])/g, '$1abstract marks')
    .replace(/\b(labelled|labeled)\s+[^,.;)]*/gi, 'unlabeled')
    .replace(/\b(titled|named)\s+[^,.;)]*/gi, 'unlabeled')
    .replace(/\b(reads|reading|readable|says|saying)\s+[^,.;)]*/gi, 'showing abstract marks')
    .replace(/\b(clear|visible|readable)\s+text\b/gi, 'abstract marks')
    .replace(/\b(page|panel|frame)\s+(number|numbers|title|titles|heading|headings)\b/gi, 'plain scene detail')
    .replace(/\b(speech|thought|dialogue)\s+(bubble|bubbles|balloon|balloons)\b/gi, 'uncluttered background area')
    .replace(/\b(callout|callouts|caption box|title box|text box|text boxes)\b/gi, 'uncluttered background area')
    .replace(/\b(UI|EULA|STOP|LOGIN|ALLOW|DENY)\b/g, 'abstract mark')
    .replace(/\ba\s+a\s+/gi, 'a ')
    .replace(/\ban\s+an\s+/gi, 'an ')
    .replace(/\s+/g, ' ')
    .trim();
}

function refinedImagePromptFromScenes(scenes = [], panels = [], fallbackPrompt = '') {
  const source = scenes.length ? scenes : panels.map((panel) => ({
    visualDescription: panel.body || panel.title
  }));
  const { count, cols, rows } = gridDimensionsForCount(source.length || panels.length || 6);
  const sceneLines = source.slice(0, count)
    .map((scene, index) => {
      const description = cleanImageSceneDescription(
        scene.visualDescription
        || scene.visual_description
        || scene.visualHook
        || scene.visual_hook
        || scene.narration
        || scene.body
        || scene.title
      );
      return description ? `${imageCellLabels[index] || `cell ${index + 1}`}: ${description}` : '';
    })
    .filter(Boolean);

  const body = sceneLines.length
    ? sceneLines.join(' ')
    : cleanImageSceneDescription(fallbackPrompt);

  return [
    `One clean image mosaic containing exactly ${count} silent same-size rectangular artwork regions in a strict ${cols} column by ${rows} row grid.`,
    'Every region must have the same width and height. No region may span rows or columns, merge with another region, become a large feature panel, contain inset panels, or use an asymmetric collage layout.',
    'Begin directly with illustrated regions; no page header, no top title area, no black title strips, no typography, no letters, no numbers, no captions, no labels, no speech bubbles, no UI writing.',
    'Thin straight white gutters only. Every region is full artwork from edge to edge.',
    body,
    'Make the story understandable through actions, objects, posture, and setting changes.',
    'Avoid repeating the same close-up, lock, tablet, laptop, or server-rack shot more than once unless it visibly changes the story.',
    'Screens, documents, controls, maps, calendars, cards, signs, logos, books, folders, labels, badges, and interface elements must stay abstract and unlabeled.',
    'All readable dialogue, captions, callouts, titles, and explanations will be rendered by the app after image generation, not inside this image.'
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function sanitizeImagePrompt(prompt, panels = [], scenes = []) {
  return refinedImagePromptFromScenes(scenes, panels, prompt);
}

function sanitizeArtDescription(value) {
  return String(value || '')
    .replace(/\b(?:red\s+)?stop\s+sign\b/gi, 'plain red octagonal blocker with no letters')
    .replace(/\bstop\s+sticker\b/gi, 'plain red blocker with no letters')
    .replace(/\bwarning\s+sign\b/gi, 'plain abstract warning object with no letters')
    .replace(/(^|[\s([{])"[^"]{1,80}"(?=$|[\s,.;:)])/g, '$1a simple abstract graphic')
    .replace(/(^|[\s([{])'[^']{1,80}'(?=$|[\s,.;:)])/g, '$1a simple abstract graphic')
    .replace(/\b(labelled|labeled)\s+[^,.;)]*/gi, 'unlabeled')
    .replace(/\b(titled|named)\s+[^,.;)]*/gi, 'with a simple abstract mark')
    .replace(/\b(reads|reading|readable|says|saying)\s+[^,.;)]*/gi, 'showing abstract marks')
    .replace(/\b(clear|visible|readable)\s+text\b/gi, 'unreadable marks')
    .replace(/\b(commercial|promotional|advertising|poster|billboard)\s+text\b/gi, 'abstract promotional graphics')
    .replace(/\b(file|user|researcher'?s?|customer)\s+name\b/gi, 'unreadable identity mark')
    .replace(/\b(names|personal details)\b/gi, 'unreadable identity marks')
    .replace(/\b(displaying|showing)\s+(a|an|the)?\s*(message|text|word|title|caption)\s*[^,.;)]*/gi, 'showing abstract visual shapes')
    .replace(/\b(logo|brand mark|fine print|EULA text|EULA|text block|text section|stamp|button name|button)\b/gi, (match) => {
      const lower = match.toLowerCase();
      if (lower.includes('button')) return 'blank control shape';
      if (lower.includes('stamp')) return 'bold abstract mark';
      return 'simple abstract graphic';
    })
    .replace(/\b(represents?|symboli[sz](?:es|ing)?|as a metaphor for)\b/gi, 'shows')
    .replace(/\ba simple abstract graphic key\b/gi, 'a blank key')
    .replace(/\ba simple abstract graphic sign\b/gi, 'an unlabeled sign')
    .replace(/\bbold title a simple abstract graphic\b/gi, 'a simple abstract mark')
    .replace(/\btitle a simple abstract graphic\b/gi, 'simple abstract mark')
    .replace(/\bchecklist with a simple abstract mark\s+is\b/gi, 'checklist with a simple abstract mark is')
    .replace(/\bdocument with the words a simple abstract graphic\b/gi, 'document with abstract marks')
    .replace(/\ba\s+a\s+/gi, 'a ')
    .replace(/\ban\s+an\s+/gi, 'an ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeOverlayText(value) {
  const clean = String(value || '')
    .replace(/\bTerms?\s*:\s*/gi, '')
    .replace(/\bSource\s*(segment|clause)?\s*\d*\s*:\s*/gi, '')
    .replace(/\bSTOP\s*:\s*/gi, '')
    .replace(/\bBreach\s*:\s*/gi, '')
    .replace(/(^|[\s([{])"[^"]{1,80}"(?=$|[\s,.;:)])/g, '$1this clause')
    .replace(/(^|[\s([{])'[^']{1,80}'(?=$|[\s,.;:)])/g, '$1this clause')
    .replace(/\b(says|said|reads|reading)\s+this clause\b/gi, 'needs checking')
    .replace(/\bthis wording\b/gi, 'this clause')
    .replace(/\b(public property|sign(?:ed)? away my rights|own my content|stole my work)\b/gi, 'reuse it broadly')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^this clause\.?$/i.test(clean)) return 'Check this clause first.';
  return truncate(clean, 105);
}

function chunkText(text, maxChars) {
  const paragraphs = String(text || '').split('\n').map((item) => item.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > maxChars) {
      chunks.push(current.trim());
      current = '';
    }

    if (paragraph.length > maxChars) {
      if (current.trim()) {
        chunks.push(current.trim());
        current = '';
      }

      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars).trim());
      }
      continue;
    }

    current += `${paragraph}\n`;
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [String(text || '').trim()].filter(Boolean);
}

const highSeverityCategories = new Set([
  'access_control',
  'liability',
  'prohibited_use',
  'redistribution',
  'revocation',
  'security',
  'termination'
]);

const lowSeverityCategories = new Set(['endorsement', 'publication_requirements', 'permitted_use']);
const severityRank = { low: 1, medium: 2, high: 3 };

function normalizeSeverity(value, fallback = 'medium') {
  const severity = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high'].includes(severity) ? severity : fallback;
}

function severityFor(categoryId) {
  if (highSeverityCategories.has(categoryId)) return 'high';
  if (lowSeverityCategories.has(categoryId)) return 'low';
  return 'medium';
}

function normalizeSourceSegments(segments) {
  if (!Array.isArray(segments)) return [];
  return segments.map((segment) => String(segment || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function mergeCategoryResults(results) {
  const merged = new Map();

  for (const result of results) {
    for (const category of result?.categories || []) {
      const rawId = category.category_id || category.id || category.name || category.title;
      const categoryId = slugify(rawId, 'other').replace(/-/g, '_');
      const fallbackSeverity = severityFor(categoryId);
      const nextSeverity = normalizeSeverity(category.severity, fallbackSeverity);
      const existing = merged.get(categoryId) || {
        categoryId,
        severity: fallbackSeverity,
        summary: '',
        impact: '',
        lookouts: [],
        sourceSegments: []
      };

      existing.sourceSegments.push(...normalizeSourceSegments(category.source_segments || category.segments || category.clauses));
      existing.lookouts.push(...normalizeStringList(category.lookouts || category.key_lookouts || category.risks, 3));
      if (!existing.summary && category.summary) existing.summary = truncate(category.summary, 220);
      if (!existing.impact && category.impact) existing.impact = truncate(category.impact, 260);
      if (severityRank[nextSeverity] > severityRank[existing.severity]) existing.severity = nextSeverity;
      merged.set(categoryId, existing);
    }
  }

  return [...merged.values()]
    .map((category) => ({
      ...category,
      lookouts: [...new Set(category.lookouts)].slice(0, 3),
      sourceSegments: [...new Set(category.sourceSegments)]
    }))
    .filter((category) => category.sourceSegments.length > 0);
}

function normalizeStringList(items, limit = 3) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => truncate(item, 90))
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeExtractedCategory(category, index) {
  const id = slugify(category.categoryId, `category-${index + 1}`);
  const title = titleize(category.categoryId);
  const severity = normalizeSeverity(category.severity, severityFor(category.categoryId));
  const count = category.sourceSegments.length;
  const lookouts = category.lookouts?.length
    ? category.lookouts
    : ['Check source wording', 'Confirm exceptions', 'Review practical effect'];

  return {
    id,
    title,
    severity,
    summary: category.summary || `${count} original source ${count === 1 ? 'segment' : 'segments'} extracted for this category.`,
    lenses: {
      impact: category.impact || `${title} clauses may affect how safely you can accept or rely on this agreement.`,
      lookouts
    },
    cards: [],
    cardsStatus: 'pending',
    comic: [],
    comicStatus: 'pending',
    video: {
      prompt: `Create a short visual explainer for ${title} clauses in a EULA.`,
      videoUrl: ''
    },
    sourceSegments: category.sourceSegments
  };
}

function normalizeCategoryForCards(category = {}) {
  const rawId = category.id || category.categoryId || category.category_id || category.title;
  const id = slugify(rawId, 'category');
  const categoryId = String(category.categoryId || category.category_id || id).replace(/-/g, '_');
  const title = category.title || titleize(categoryId);
  const sourceSegments = normalizeSourceSegments(category.sourceSegments || category.source_segments || category.segments).slice(0, 8);
  const lookouts = normalizeStringList(category.lenses?.lookouts || category.lookouts, 3);

  return {
    id,
    categoryId,
    title,
    severity: normalizeSeverity(category.severity, severityFor(categoryId)),
    summary: truncate(category.summary, 260),
    impact: truncate(category.lenses?.impact || category.impact, 300),
    lookouts,
    sourceSegments
  };
}

const genericCardPills = new Set([
  'check',
  'verify',
  'review',
  'note',
  'important',
  'watch',
  'read',
  'look',
  'yes',
  'no',
  'maybe'
]);

const cardPillRules = [
  [/not\s+(allowed|permitted|authorized)|cannot|can't|prohibit|forbid|ban|without\s+permission/i, 'Not Allowed'],
  [/allow|permit|authori[sz]e|may\s+use|can\s+use/i, 'Allowed'],
  [/approval|permission|consent|authori[sz]ation/i, 'Approval'],
  [/access|account|login|credential|password/i, 'Access'],
  [/share|redistribut|transfer|third[\s-]?party|vendor|affiliate|collaborat/i, 'Sharing'],
  [/deadline|notice|renew|cancel|termination|expire|term/i, 'Deadline'],
  [/delete|remov|backup|retain|retention|keep|store/i, 'Retention'],
  [/license|content|ownership|copyright|intellectual|ip\b/i, 'License'],
  [/privacy|personal\s+data|data|telemetry|analytics/i, 'Data'],
  [/liab|damage|warrant|indemn|claim/i, 'Liability'],
  [/refund|fee|charge|payment|subscription|price/i, 'Fees'],
  [/security|encrypt|confidential|secret/i, 'Security'],
  [/export|jurisdiction|governing|law|compliance/i, 'Legal'],
  [/risk|red\s+flag|danger|unexpected/i, 'Risk'],
  [/example|scenario|case/i, 'Example'],
  [/limit|scope|only|except|restriction/i, 'Limits'],
  [/record|audit|report|log/i, 'Records'],
  [/next|ask|confirm|question/i, 'Next step']
];

const cardPillStopWords = new Set([
  'a',
  'an',
  'and',
  'are',
  'be',
  'before',
  'can',
  'could',
  'do',
  'does',
  'for',
  'from',
  'have',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'may',
  'my',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your'
]);

function titleCasePill(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function isValidCardPill(value) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > 18) return false;
  if (/[.!?;:]/.test(clean)) return false;
  const words = clean.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  return !genericCardPills.has(clean.toLowerCase());
}

function compactCardPillFromText(text) {
  const cleaned = String(text || '')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word && word.length > 2 && !cardPillStopWords.has(word.toLowerCase()));

  for (const size of [3, 2, 1]) {
    const phrase = words.slice(0, size).join(' ');
    if (isValidCardPill(phrase)) return titleCasePill(phrase);
  }

  return 'Review';
}

function normalizeAnswerPill(value, card = {}) {
  const raw = truncate(value, 60)
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (isValidCardPill(raw)) return titleCasePill(raw);

  const combined = [
    raw,
    card.question,
    card.frontDetail || card.front_detail,
    card.backTitle || card.back_title,
    card.backDetail || card.back_detail
  ].filter(Boolean).join(' ');

  for (const [pattern, label] of cardPillRules) {
    if (pattern.test(combined)) return label;
  }

  return compactCardPillFromText(combined);
}

function normalizeGeneratedCards(cards, categoryId) {
  if (!Array.isArray(cards)) return [];

  return cards
    .map((card, index) => {
      const question = truncate(card.question, 96);
      const answer = normalizeAnswerPill(card.answer || card.answerPill || card.answer_pill, card);
      const frontDetail = truncate(card.frontDetail || card.front_detail, 210);
      const backTitle = truncate(card.backTitle || card.back_title, 52);
      const backDetail = truncate(card.backDetail || card.back_detail, 420);

      if (!question || !frontDetail || !backDetail) return null;

      return {
        id: slugify(card.id, `${categoryId}-card-${index + 1}`),
        question,
        answer,
        frontDetail,
        backTitle: backTitle || 'What to check',
        backDetail
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function sanitizeVideoLegalText(value, category = {}, limit = 140) {
  const sourceText = (category.sourceSegments || []).join(' ').toLowerCase();
  let clean = truncate(value, limit);

  if (!sourceText.includes('without notice') && !sourceText.includes('prior notice')) {
    clean = clean
      .replace(/\bwithout\s+(?:any\s+)?(?:prior\s+)?notice\b/gi, 'at any time')
      .replace(/\bwithout\s+(?:any\s+)?prior\s+warning\b/gi, 'at any time')
      .replace(/\bwithout\s+warning\b/gi, 'at any time')
      .replace(/\bno\s+(?:prior\s+)?notice\s+(?:is\s+)?(?:required|given|provided)?\b/gi, 'access can change at any time')
      .replace(/\bno\s+warning\s+(?:is\s+)?(?:required|given|provided)?\b/gi, 'access can change at any time');
  }
  if (!sourceText.includes('sole discretion')) {
    clean = clean
      .replace(/\b(?:at\s+)?(?:their\s+)?sole\s+discretion\b/gi, 'under the agreement')
      .replace(/\b(?:at\s+)?(?:the\s+)?licensor'?s?\s+discretion\b/gi, "the agreement's reserved rights")
      .replace(/\bunder\s+the\s+agreement'?s\s+reserved\s+rights\b/gi, "under the agreement's reserved rights");
  }
  if (!sourceText.includes('for any reason')) {
    clean = clean
      .replace(/\bfor\s+any\s+reason\b/gi, 'for listed reasons')
      .replace(/\bwith\s+or\s+without\s+cause\b/gi, 'for listed reasons')
      .replace(/\bwithout\s+cause\b/gi, 'for listed reasons')
      .replace(/\bor\s+cause\b/gi, 'for listed reasons');
  }
  if (!sourceText.includes('immediate termination') && !sourceText.includes('immediately terminate')) {
    clean = clean
      .replace(/\bimmediate\s+termination\b/gi, 'loss of access')
      .replace(/\bterminated?\s+immediately\b/gi, 'access changed')
      .replace(/\bimmediately\b/gi, 'at any time');
  }

  return clean
    .replace(/\binstantly\b/gi, 'at any time')
    .replace(/\banytime\b/gi, 'at any time')
    .replace(/\bNo reason is stated\b/gi, 'Reasons can include breach, misuse, or legal requirements')
    .replace(/\baccess can change at any time\.\s*Reasons can include breach, misuse, or legal requirements\b/gi, 'Reasons include breach, misuse, or legal requirements')
    .replace(/\bPermanent loss of materials\b/gi, 'Loss of access to materials')
    .replace(/\bpermanent loss\b/gi, 'loss of access')
    .replace(/\bnew laws\b/gi, 'legal requirements')
    .replace(/\bunilateral decision\b/gi, 'reserved rights')
    .replace(/\bcan at any time remove access to materials at any time for listed reasons\b/gi, 'can change or remove access at any time for listed reasons')
    .replace(/\bbased on the source text\b/gi, 'under the agreement')
    .replace(/(?:access can change at any time\.\s*){2,}/gi, 'Access can change at any time. ')
    .replace(/\bat any time\s+at any time\b/gi, 'at any time')
    .replace(/\bat any time\s+or\s+at any time\b/gi, 'at any time')
    .replace(/\bAccess is entirely under the agreement\b/gi, "Access depends on the agreement's reserved rights")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^access\b/, 'Access')
    .replace(/^(.)/, (letter) => letter.toUpperCase())
    .slice(0, limit);
}

function sanitizeVideoVisualText(value, limit = 260) {
  return truncate(value, limit)
    .replace(/\b(?:wall\s+)?(?:displays?|shows?)\s+(?:a\s+)?list\s+of\s+names\b/gi, 'wall shows blank portrait icons')
    .replace(/\b(?:name|names)\s+(?:list|on\s+a\s+wall|on\s+the\s+wall)\b/gi, 'blank portrait icons')
    .replace(/\bclipboard\s+(?:showing|with|displaying|reading)\s+[^,.;]+/gi, 'blank approval token')
    .replace(/\bclipboard\b/gi, 'blank approval token')
    .replace(/\bscreen\s+(?:showing|with|displaying|reading)\s+[^,.;]+/gi, 'screen with abstract shapes')
    .replace(/\bscreen\b/gi, 'abstract display panel')
    .replace(/\bdocument\s+(?:showing|with|displaying|reading)\s+[^,.;]+/gi, 'blank approval token')
    .replace(/\b(document|form|paper|poster|wall note|wall notes)\b/gi, 'blank approval token')
    .replace(/\b(labeled|labelled|named|called|titled)\s+["'][^"']{1,80}["']/gi, 'unlabeled')
    .replace(/\b(labeled|labelled|named|called|titled)\s+[^,.;]{1,80}/gi, 'unlabeled')
    .replace(/\btoken\s+unlabeled\b/gi, 'unlabeled token')
    .replace(/["'][^"']{1,80}["']/g, 'abstract visual mark')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeVideoModelPrompt(value) {
  let clean = truncate(value, 1500)
    .replace(/\s*(?:No|Avoid|Do not use|Do not include|Explicitly avoid)\s+(?:a\s+)?(?:whiteboard|marker|visible hand drawing|drawing hand|hand[-\s]?drawn?\s+process|sketchbook|paper background|paper texture)[^.]*\./gi, ' ')
    .replace(/\s*(?:Avoid|Do not use|Do not include|Explicitly avoid)\s+(?:whiteboard|marker drawing|visible hand drawing|drawing hand|hand[-\s]?drawn?\s+process|sketchbook|paper texture)[^.]*$/gi, ' ')
    .replace(/\s*(?:No|Avoid|Do not use|Do not include|Explicitly avoid)\s+(?:clipboards?|documents?|papers?|forms?|posters?|wall notes?)[^.]*\./gi, ' ')
    .replace(/\b(?:wall\s+)?(?:displays?|shows?)\s+(?:a\s+)?list\s+of\s+names\b/gi, 'wall shows blank portrait icons')
    .replace(/\b(?:name|names)\s+(?:list|on\s+a\s+wall|on\s+the\s+wall)\b/gi, 'blank portrait icons')
    .replace(/\bclipboard\b/gi, 'blank approval token')
    .replace(/\b(document|form|paper|poster|wall note|wall notes)\b/gi, 'blank approval token')
    .replace(/\bno\s+blank\s+approval\s+token\s+words\b/gi, 'no document words')
    .replace(/\bno\s+blank\s+approval\s+tokens?\b/gi, 'no documents')
    .replace(/\bno\s+(?:yellow|sepia|parchment)[^.]*\./gi, 'Use a neutral off-white and pale gray color palette. ')
    .replace(/\bwarm empty background\b/gi, 'neutral off-white lab or office background')
    .replace(/\bwarm\s+(?:yellow|sepia|parchment)\s+background\b/gi, 'neutral off-white lab or office background')
    .replace(/\byellow\s+(?:tint|background|color cast)\b/gi, 'neutral off-white and pale gray color palette')
    .replace(/\bsepia\s+(?:tint|background|color cast|palette)\b/gi, 'neutral off-white and pale gray color palette')
    .replace(/\b(labeled|labelled|named|called|titled)\s+["'][^"']{1,80}["']/gi, 'unlabeled')
    .replace(/\b(labeled|labelled|named|called|titled)\s+[^,.;]{1,80}/gi, 'unlabeled')
    .replace(/["'][^"']{1,80}["']/g, 'abstract visual mark')
    .replace(/\s+/g, ' ')
    .replace(/\bno\s+neutral off-white and pale gray color palette\b/gi, 'Use a neutral off-white and pale gray color palette')
    .replace(/\bUse a neutral off-white and pale gray color palette,\s*no sepia,\s*no parchment\b/gi, 'Use a neutral off-white and pale gray color palette')
    .replace(/\bno documents,\s*no documents\b/gi, 'no documents')
    .replace(/\bno UI words,\s*Use\b/gi, 'no UI words, no document words, no logos. Use')
    .replace(/\bno UI words\s+Use\b/gi, 'no UI words, no document words, no logos. Use')
    .replace(/[,;]\s*$/g, '')
    .trim();

  const guardrail = 'No readable text, no labels, no model-generated subtitles, no speech bubbles, no UI words, no document words, no logos.';
  const missingGuardrail = [
    /no readable text/i,
    /no labels/i,
    /no model-generated subtitles|no subtitles/i,
    /no speech bubbles/i,
    /no UI words/i,
    /no document words/i,
    /no logos/i
  ].some((pattern) => !pattern.test(clean));

  if (missingGuardrail) {
    clean = `${clean.replace(/[. ]*$/g, '')}. ${guardrail}`;
  }

  return truncate(clean, 1700);
}

function normalizeVideoScript(script, category, durationSeconds) {
  const shotPlan = Array.isArray(script?.shot_plan || script?.shotPlan)
    ? (script.shot_plan || script.shotPlan)
      .map((shot, index) => {
        const startSeconds = Number(shot.start_seconds ?? shot.startSeconds ?? 0);
        const endSeconds = Number(shot.end_seconds ?? shot.endSeconds ?? 0);
        const visualBeat = sanitizeVideoVisualText(shot.visual_beat || shot.visualBeat || shot.beat || shot.visual || shot.description, 260);
        const camera = truncate(shot.camera || shot.composition, 90);
        const legalPoint = sanitizeVideoLegalText(shot.legal_point || shot.legalPoint, category, 180);
        if (!visualBeat) return null;

        return {
          startSeconds: Number.isFinite(startSeconds) ? startSeconds : index * 5,
          endSeconds: Number.isFinite(endSeconds) && endSeconds > startSeconds ? endSeconds : Math.min(durationSeconds, (index + 1) * 5),
          visualBeat,
          camera,
          legalPoint
        };
      })
      .filter(Boolean)
      .slice(0, 8)
    : [];

  const subtitleLines = Array.isArray(script?.subtitle_lines || script?.subtitleLines)
    ? (script.subtitle_lines || script.subtitleLines)
      .map((line, index) => {
        const startSeconds = Number(line.start_seconds ?? line.startSeconds ?? 0);
        const endSeconds = Number(line.end_seconds ?? line.endSeconds ?? 0);
        const text = sanitizeVideoLegalText(line.text || line.subtitle || line.dialogue, category, 76);
        if (!text) return null;

        return {
          startSeconds: Number.isFinite(startSeconds) ? startSeconds : index * 4,
          endSeconds: Number.isFinite(endSeconds) && endSeconds > startSeconds ? endSeconds : Math.min(durationSeconds, (index + 1) * 4),
          speaker: truncate(line.speaker, 40) || 'Narrator',
          text
        };
      })
      .filter(Boolean)
      .slice(0, 12)
    : [];

  const prompt = sanitizeVideoModelPrompt(script?.model_prompt || script?.modelPrompt || script?.prompt);
  const fallbackPrompt = [
    `${durationSeconds} second clean light line-art 2D animated explainer video, simple flat-shaded characters, smooth cartoon motion, limited camera movement.`,
    'A person tries to complete an ordinary task with a protected item, another person reaches for the same item, and the first person gently stops the handoff.',
    'A reviewer creates a separate approved item, the task continues, and the protected item stays secure.',
    'Use one plain professional setting with bare walls, readable body language, consistent character designs, simple props, clean professional educational animation, stable composition.',
    'No readable text, no labels, no posters, no signs, no screen writing, no logos, no model-generated subtitles, no speech bubbles.'
  ].join(' ');

  return {
    categoryId: category.id,
    title: truncate(script?.title, 90) || `${category.title} Video`,
    durationSeconds,
    storyGoal: sanitizeVideoLegalText(script?.story_goal || script?.storyGoal, category, 280) || category.summary,
    visualStyle: truncate(script?.visual_style || script?.visualStyle, 180) || 'clean light line-art 2D animated dialogue scene',
    shotPlan,
    subtitleLines,
    audioPlan: truncate(script?.audio_plan || script?.audioPlan, 240) || 'Add deterministic dialogue audio and matching subtitles after video generation.',
    prompt: prompt || fallbackPrompt,
    modelPrompt: prompt || fallbackPrompt,
    negativePrompt: truncate(script?.negative_prompt || script?.negativePrompt, 520) || 'whiteboard, visible hand drawing, marker drawing process, sketchbook, rough messy sketch, stick figure, tiny characters, yellow tint, sepia, parchment, paper texture, readable text, labels, subtitles, speech bubbles, UI words, document words, wall notes, posters, papers, forms, logos, distorted faces, flickering limbs'
  };
}

function videoScriptQualityIssues(script, category = {}, durationSeconds = 30) {
  const issues = [];
  const prompt = String(script?.model_prompt || script?.modelPrompt || script?.prompt || '');
  const visualStyle = String(script?.visual_style || script?.visualStyle || '');
  const combinedStyle = `${visualStyle} ${prompt}`;
  const positiveStyleText = combinedStyle
    .replace(/\b(?:no|avoid|do not use|do not include|without|explicitly avoid)\b[^.]*\b(?:whiteboard|marker|visible hand drawing|drawing hand|drawn by hand|paper background|sketchbook)[^.]*\./gi, ' ')
    .replace(/\s+/g, ' ');
  const shotPlan = Array.isArray(script?.shot_plan || script?.shotPlan) ? (script.shot_plan || script.shotPlan) : [];
  const subtitleLines = Array.isArray(script?.subtitle_lines || script?.subtitleLines) ? (script.subtitle_lines || script.subtitleLines) : [];
  const promptWords = prompt.split(/\s+/).filter(Boolean).length;
  const storyGoal = String(script?.story_goal || script?.storyGoal || '').trim();
  const beatsText = shotPlan.map((shot) => (
    typeof shot === 'string'
      ? shot
      : `${shot?.visual_beat || shot?.visualBeat || shot?.beat || shot?.visual || shot?.description || ''} ${shot?.legal_point || shot?.legalPoint || ''}`
  )).join(' ').toLowerCase();
  const positiveArtifactText = `${prompt} ${beatsText}`
    .replace(/\b(?:no|avoid|do not use|do not include|without|explicitly avoid)\b[^.]*\b(?:clipboard|document|form|paper|poster|wall note|wall notes)[^.]*\./gi, ' ')
    .replace(/\s+/g, ' ');
  const explanatoryText = [
    storyGoal,
    ...shotPlan.map((shot) => (typeof shot === 'string' ? '' : (shot?.legal_point || shot?.legalPoint || ''))),
    ...subtitleLines.map((line) => line?.text || line?.subtitle || line?.dialogue || '')
  ].join(' ').toLowerCase();
  const sourceText = (category.sourceSegments || []).join(' ').toLowerCase();

  if (!/2d|animated|animation|flat[-\s]?shaded|cartoon|educational/i.test(combinedStyle)) {
    issues.push('model_prompt must specify a clean 2D animated educational style with simple flat-shaded characters');
  }
  if (!/stable composition|limited camera|simple props|plain|stable camera|limited stable camera/i.test(combinedStyle)) {
    issues.push('model_prompt should ask for limited camera movement, stable composition, and simple props');
  }
  if (!/bare walls?|plain background|empty wall|plain professional setting/i.test(combinedStyle)) {
    issues.push('model_prompt should ask for bare walls or a plain background to reduce gibberish wall text');
  }
  if (/\bwhiteboard\b|marker|visible hand drawing|drawing hand|drawn by hand|paper background|sketchbook/i.test(positiveStyleText)) {
    issues.push('do not put whiteboard, marker, visible drawing hand, paper, or sketchbook language in model_prompt or visual_style; put those only in negative_prompt');
  }
  if (/\byellow\b|\bsepia\b|\bparchment\b|\bwarm empty background\b/i.test(positiveStyleText)) {
    issues.push('model_prompt must avoid yellow/sepia/parchment/warm background language; use neutral off-white and pale gray instead');
  }
  if (!/no readable text|no text|no labels/i.test(prompt)) {
    issues.push('model_prompt must explicitly ban readable text and labels');
  }
  if (!/no model-generated subtitles|no subtitles/i.test(prompt)) {
    issues.push('model_prompt must explicitly ban model-generated subtitles');
  }
  if (!/no document words/i.test(prompt)) {
    issues.push('model_prompt must explicitly ban document words');
  }
  if (!/no logos/i.test(prompt)) {
    issues.push('model_prompt must explicitly ban logos');
  }
  if (!storyGoal) {
    issues.push('story_goal is missing');
  }
  if (shotPlan.length < 5 || shotPlan.length > 7) {
    issues.push(`shot_plan should have 5-7 timed beats for a ${durationSeconds}s category story, not ${shotPlan.length}`);
  }
  if (subtitleLines.length < 5 || subtitleLines.length > 7) {
    issues.push(`subtitle_lines should have 5-7 app-rendered lines, not ${subtitleLines.length}`);
  }
  const narratorLines = subtitleLines.filter((line) => /narrator/i.test(String(line?.speaker || ''))).length;
  if (narratorLines > 1) {
    issues.push('subtitle_lines should be character dialogue, with at most one narrator line');
  }
  if (promptWords < 105) {
    issues.push('model_prompt is too short; write 120-180 words with a visible setup, blocked attempt, safer path, and resolved ending');
  }
  if (promptWords > 210) {
    issues.push('model_prompt is too long for the video model; keep it under about 210 words');
  }
  if (!/goal|try|attempt|reach|handoff|share|copy|upload|open|enter|use|send|approve|block|lock|close|pull|return|choose|separate|reminder|case|folder|card|drive|receipt|tray/i.test(beatsText)) {
    issues.push('shot_plan needs concrete visible actions and props, not just legal explanation');
  }
  if (/\b(?:floating|hologram|holographic|abstract icon|warning symbol|red barrier|green barrier|translucent barrier|force field|magical|gavel|scales)\b/i.test(`${prompt} ${beatsText}`)) {
    issues.push('avoid floating symbols, hologram barriers, legal icons, or magical UI effects; show physical blocking and approval actions instead');
  }
  if (/\b(?:stamp|stamped|badge|badges|poster|posters|wall note|wall notes|form|forms|document|documents|clipboard|clipboards)\b/i.test(`${prompt} ${beatsText}`)) {
    issues.push('avoid stamps, badges, posters, wall notes, forms, documents, and clipboards because they create gibberish text; use separate keycards, tokens, trays, envelopes, doors, or locked cases');
  }
  if (/\b(label(?:ed|led)?|named|called|titled|reading|says|stamped)\s+["']?[a-z0-9]/i.test(prompt) || /["'][^"']{2,80}["']/.test(prompt)) {
    issues.push('model_prompt must not ask for written labels, named objects, quoted words, readable signs, or readable document/screen text');
  }
  if (/\b(label(?:ed|led)?|named|called|titled|reading|says|stamped)\s+["']?[a-z0-9]/i.test(beatsText) || /["'][^"']{2,80}["']/.test(beatsText)) {
    issues.push('shot_plan must use unlabeled objects and actions; do not describe labels, quoted text, readable signs, or readable screens');
  }
  if (/\blist\s+of\s+names\b|\bname\s+list\b|\bnames\s+on\s+(?:a\s+)?wall\b/i.test(`${prompt} ${beatsText}`)) {
    issues.push('do not use visible name lists; use blank portrait icons or separate access cards instead');
  }
  if (/\bclipboard|document|form|paper|poster|wall note|wall notes\b/i.test(positiveArtifactText)) {
    issues.push('avoid clipboards, documents, papers, posters, forms, and wall notes; use approval tokens, cards, trays, or abstract icons instead');
  }
  for (const phrase of ['without notice', 'prior notice', 'prior warning', 'without warning', 'sole discretion', 'licensor discretion', "licensor's discretion", 'for any reason', 'without cause', 'no reason', 'permanent loss', 'unilateral decision', 'immediate termination', 'penalty', 'fine']) {
    if (explanatoryText.includes(phrase) && !sourceText.includes(phrase)) {
      issues.push(`do not claim "${phrase}" unless it appears in the source excerpt`);
    }
  }
  if (/lawyer|court|judge|lawsuit|fine|penalty|arrest/i.test(beatsText) && !/lawyer|court|judge|lawsuit|fine|penalty|arrest/i.test((category.sourceSegments || []).join(' '))) {
    issues.push('avoid invented legal-drama consequences like court, fines, or penalties unless the source says so');
  }

  for (const [index, line] of subtitleLines.entries()) {
    const text = String(line?.text || line?.subtitle || line?.dialogue || '').trim();
    if (!text) {
      issues.push(`subtitle line ${index + 1} is empty`);
      continue;
    }
    if (text.length > 76) {
      issues.push(`subtitle line ${index + 1} is too long; keep each line under 76 characters`);
    }
    if (/source segment|excerpt|clause says|eula category/i.test(text)) {
      issues.push(`subtitle line ${index + 1} sounds like metadata instead of natural narration/dialogue`);
    }
    if (/^(access is|redistribution is|this dataset is|commercial use is|ownership rights are|sharing .* is|strict control|use is permitted|the key is|the category|this clause)/i.test(text)) {
      issues.push(`subtitle line ${index + 1} sounds like narration; write it as character dialogue instead`);
    }
    if (/\b(?:send|share|give|copy|forward)\b[^.?!]{0,50}\b(?:link|file|copy|drive|login|credential|password)\b/i.test(text)
      && /\b(?:must not|may not|not share|not distribute|prohibit|forbid|restricted|only to|only the registered)\b/i.test(sourceText)) {
      issues.push(`subtitle line ${index + 1} appears to approve a forbidden sharing shortcut; end with separate approved access instead`);
    }
  }

  return issues;
}

function scenarioGuidanceForCategory(category) {
  const key = `${category.categoryId || ''} ${category.id || ''} ${category.title || ''}`.toLowerCase();

  if (/content|license|upload|user_content/.test(key)) {
    return [
      'Scenario 1: uploaded creative work gets reused in an unintended promotional/commercial place. Use concrete beats: creator uploads asset, later sees same asset on an unbranded billboard/poster/kiosk, notices it was modified or distributed, then changes upload/settings behavior. Keep screens to setup only.',
      'Scenario 2: deletion does not fully remove copies. Use concrete beats: creator deletes file, finds a copy in a backup archive/storage room/shared folder, sees another person/team still holding a copy, then locks/checks backup and sharing settings. Avoid repeated laptop scenes.'
    ].join('\n');
  }

  if (/renew|subscription|billing|refund/.test(key)) {
    return [
      'Scenario 1: missed cancellation window. Use concrete beats: person sees wall calendar/reminder too late, envelope/receipt slides in, payment card or bill arrives, person realizes the deadline mattered, then sets a physical reminder for next time.',
      'Scenario 2: refund is unavailable after renewal. Use concrete beats: person brings receipt/envelope to service counter, refund path is blocked, coins or receipt stay on their side, then they leaves with a reminder/checklist. Avoid making the whole story a phone screen.'
    ].join('\n');
  }

  if (/data|sharing|vendor|partner|analytics|cross/.test(key)) {
    return [
      'Scenario 1: uploaded file is handed to vendors/partners. Use concrete beats: user uploads or hands over a file, a sealed folder travels from main desk/server room to partner desks, user sees multiple teams handling copies, then limits settings or locks the folder.',
      'Scenario 2: data crosses borders. Use concrete beats: researcher follows a string route on a wall map, route crosses a border/checkpoint, researcher removes identifiers from paper/folder, then sends a smaller locked package by a local route. Avoid laptop/tablet diagrams after setup.'
    ].join('\n');
  }

  if (/liability|damage|cap|loss|profits|interruption/.test(key)) {
    return [
      'Scenario 1: service outage causes business loss. Use concrete beats: shop/team stops work during outage, orders/boxes pile up, owner brings invoices to provider, only a small locked payout box is available, owner plans backup budget.',
      'Scenario 2: data loss or breach costs exceed the cap. Use concrete beats: manager finds broken server/cabinet, carries invoices/repair receipts, compares large cost pile with a small capped box or receipt stack, then adds insurance/backup checklist. Avoid relying on calculator/calendar closeups.'
    ].join('\n');
  }

  return 'Create one concrete everyday workflow first. Add a second comic only if the source has a separate exception, consequence, or decision moment. Prefer people moving objects through spaces over abstract icons.';
}

const overlaySlotPositions = new Set([
  'top_left',
  'top_right',
  'middle_left',
  'middle_right',
  'bottom_left',
  'bottom_right',
  'center'
]);

const overlaySlotKinds = new Set(['speech', 'thought', 'callout', 'note', 'warning', 'caption']);
const fallbackSlotPositions = ['top_left', 'bottom_right', 'top_right'];

function normalizeOverlayPosition(value, index) {
  const position = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return overlaySlotPositions.has(position) ? position : fallbackSlotPositions[index % fallbackSlotPositions.length];
}

function normalizeOverlaySlots(slots, fallbackText) {
  const source = Array.isArray(slots) ? slots : [];
  const normalized = source
    .map((slot, index) => {
      const kind = String(slot?.kind || slot?.type || '').trim().toLowerCase();
      const text = sanitizeOverlayText(slot?.text || slot?.caption || slot?.body);
      if (!text) return null;

      return {
        kind: overlaySlotKinds.has(kind) ? kind : 'callout',
        text,
        position: normalizeOverlayPosition(slot?.position || slot?.anchor, index),
        tail: truncate(slot?.tail || slot?.points_to || slot?.pointsTo || '', 40)
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  if (normalized.length) return normalized;
  return [{
    kind: 'callout',
    text: truncate(fallbackText, 130),
    position: 'top_left',
    tail: ''
  }].filter((slot) => slot.text);
}

function rebalanceOverlayPositions(scenes) {
  const pattern = ['top_left', 'top_right', 'middle_left', 'bottom_right', 'bottom_left', 'middle_right'];
  const slots = scenes.flatMap((scene) => scene.overlaySlots || []);
  const positions = new Set(slots.map((slot) => slot.position).filter(Boolean));
  if (positions.size >= Math.min(4, slots.length)) return scenes;

  let slotIndex = 0;
  return scenes.map((scene) => ({
    ...scene,
    overlaySlots: (scene.overlaySlots || []).map((slot) => {
      const next = { ...slot, position: pattern[slotIndex % pattern.length] };
      slotIndex += 1;
      return next;
    })
  }));
}

function normalizeComicEntry(script, category, index = 0) {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  const normalizedScenes = scenes
    .map((scene, index) => {
      const sceneTitle = truncate(scene.scene_title || scene.title, 80) || `Scene ${index + 1}`;
      const purpose = truncate(scene.purpose, 60);
      const legalPoint = truncate(scene.legal_point || scene.legalPoint, 180);
      const narration = truncate(scene.narration || scene.body || scene.summary, 260);
      const dialogue = truncate(scene.dialogue, 180);
      const visualDescription = truncate(sanitizeArtDescription(scene.visual_description || scene.visualDescription), 360);
      const composition = truncate(scene.composition, 90);
      const visualHook = truncate(scene.visual_hook || scene.visualHook, 160);
      const legalBasis = normalizeStringList(scene.legal_basis || scene.legalBasis, 4);
      const overlayTitle = truncate(scene.overlay_title || scene.overlayTitle || sceneTitle, 44);
      const overlayCaption = truncate(scene.overlay_caption || scene.overlayCaption || narration || dialogue || visualDescription, 150);
      const overlaySlots = normalizeOverlaySlots(scene.overlay_slots || scene.overlaySlots, overlayCaption);

      if (!narration && !dialogue && !visualDescription) return null;

      return {
        sceneNumber: Number.isInteger(scene.scene_number) ? scene.scene_number : index + 1,
        title: sceneTitle,
        overlayTitle,
        overlayCaption,
        overlaySlots,
        purpose,
        legalPoint,
        narration,
        dialogue,
        visualDescription,
        composition,
        visualHook,
        legalBasis
      };
    })
    .filter(Boolean)
    .slice(0, 10);

  const balancedScenes = rebalanceOverlayPositions(normalizedScenes);

  const panels = balancedScenes.map((scene) => ({
    title: scene.overlayTitle || scene.title,
    body: scene.overlayCaption || scene.narration || scene.dialogue || scene.visualDescription,
    slots: scene.overlaySlots
  }));

  const title = truncate(script?.title || script?.scenario_title || script?.scenarioTitle, 80) || `${category.title} Comic`;
  const id = slugify(script?.id || script?.scenario_id || script?.scenarioId || title, `${category.id}-comic-${index + 1}`);
  const rawImagePrompt = sanitizeImagePrompt(script?.raw_image_prompt || script?.rawImagePrompt, panels, balancedScenes);

  return {
    id,
    categoryId: category.id,
    title,
    scenarioTitle: truncate(script?.scenario_title || script?.scenarioTitle || title, 90),
    scenarioType: truncate(script?.scenario_type || script?.scenarioType, 60),
    protagonistGoal: truncate(script?.protagonist_goal || script?.protagonistGoal, 180),
    storyArc: truncate(script?.story_arc || script?.storyArc || script?.story_summary || script?.storySummary, 360),
    visualReadThrough: truncate(script?.visual_read_through || script?.visualReadThrough, 420),
    mainCharacter: {
      role: truncate(script?.main_character?.role || script?.mainCharacter?.role, 80),
      appearance: truncate(script?.main_character?.appearance || script?.mainCharacter?.appearance, 180)
    },
    storySummary: truncate(script?.story_summary || script?.storySummary, 320),
    scenes: balancedScenes,
    panels,
    rawImagePrompt,
    imagePrompt: rawImagePrompt
  };
}

function normalizeComicScript(script, category) {
  const rawComics = Array.isArray(script?.comics) && script.comics.length ? script.comics : [script];
  const comics = rawComics
    .map((comic, index) => normalizeComicEntry(comic, category, index))
    .filter((comic) => comic.scenes.length && comic.rawImagePrompt)
    .slice(0, 3);
  const primary = comics[0] || normalizeComicEntry(script, category, 0);

  return {
    categoryId: category.id,
    title: truncate(script?.title, 90) || `${category.title} Comics`,
    storySummary: truncate(script?.story_summary || script?.storySummary || primary.storySummary, 420),
    selectedComicId: primary.id,
    comics,
    ...primary,
    title: primary.title,
    imagePrompt: primary.rawImagePrompt
  };
}

function visualTextLeak(value) {
  const text = String(value || '');
  return /(^|[\s([{])"[^"]{1,80}"(?=$|[\s,.;:)])/.test(text)
    || /(^|[\s([{])'[^']{1,80}'(?=$|[\s,.;:)])/.test(text)
    || /\b(labelled|labeled|reads|reading|says|saying|message|readable text|visible text|added text|fine print|eula|caption box|title box|text block|text section|logo|logos|button names?|countdown timer|stamp)\b/i.test(text);
}

function isDeviceCenteredDescription(value) {
  const description = String(value || '')
    .toLowerCase()
    .replace(/\b(?:no|not a|not an|without)\s+(?:visible\s+)?(?:screens?|phones?|laptops?|computers?|tablets?|monitors?|desks?)\b/g, '')
    .replace(/\bclosed\s+laptop\s+lid\b/g, '');
  return /\b(?:close-up|over-the-shoulder|looking|look|tapping|clicking|dragging|holding|using)\b[^.]{0,110}\b(?:laptop|computer|screen|phone|tablet|monitor)\b/.test(description)
    || /\b(?:laptop|computer|screen|phone|tablet|monitor)\b[^.]{0,110}\b(?:close-up|glow|reflects|display|shows|held|holding|tapping|clicking|dragging)\b/.test(description)
    || /\b(sits?|sitting|seated|back)\b[^.]{0,90}\bdesk\b/.test(description)
    || /\bdesk\b[^.]{0,90}\b(laptop|computer|screen|phone|tablet|monitor)\b/.test(description);
}

const sceneSimilarityStopWords = new Set([
  'about',
  'above',
  'after',
  'again',
  'against',
  'around',
  'background',
  'between',
  'character',
  'close',
  'description',
  'different',
  'from',
  'hand',
  'hands',
  'holding',
  'into',
  'looking',
  'scene',
  'shows',
  'slightly',
  'stands',
  'their',
  'there',
  'they',
  'with'
]);

function significantSceneWords(value) {
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3 && !sceneSimilarityStopWords.has(word))
    .slice(0, 80));
}

function sceneSimilarity(first, second) {
  const a = significantSceneWords(first);
  const b = significantSceneWords(second);
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function comicEntryQualityIssues(script, label = 'comic') {
  const scenes = Array.isArray(script?.scenes) ? script.scenes : [];
  if (!scenes.length) return [];

  const slots = scenes.flatMap((scene) => Array.isArray(scene.overlaySlots || scene.overlay_slots) ? (scene.overlaySlots || scene.overlay_slots) : []);
  const positions = [...new Set(slots.map((slot) => slot.position).filter(Boolean))];
  const descriptions = scenes.map((scene) => scene.visualDescription || scene.visual_description || '');
  const purposes = scenes.map((scene) => String(scene.purpose || '').toLowerCase());
  const arcText = [
    purposes.join(' '),
    script.storyArc,
    script.story_arc,
    script.visualReadThrough,
    script.visual_read_through,
    script.storySummary,
    script.story_summary
  ].join(' ').toLowerCase();
  const slotKinds = slots.map((slot) => String(slot.kind || '').toLowerCase());
  const deviceSceneNumbers = descriptions
    .map((description, index) => (isDeviceCenteredDescription(description) ? index + 1 : null))
    .filter(Boolean);
  const deviceCenteredCount = deviceSceneNumbers.length;
  const maxDeviceScenes = Math.ceil(scenes.length * 0.5);
  const concreteActionCount = descriptions.filter((description) => (
    /\b(opens?|drags?|uploads?|hands?|walks?|places?|placing|pulls?|chooses?|checks?|taps?|presses?|throws?|locks?|unlocks?|files?|marks?|points?|holds?|compares?|receives?|follows?|crosses?|splits?|deletes?|cancels?|packs?|returns?|slides?|takes?|moves?|looks?|notices?|sees?|spots?|finds?|leans?|reads?|clutches?|displays?|shows?|showing|hovers?|turns?|stands?|sits?|traces?|covers?|rings?|answers?|smiles?|flashes?|ticks?|circles?|separates?|slumps?|reaches?|stops?)\b/i.test(description)
  )).length;
  const genericVisualCount = descriptions.filter((description) => (
    /\b(represents?|symboli[sz](?:es|ing)?|abstract|conceptual|generic|icon|metaphor)\b/i.test(description)
  )).length;
  const hasStoryArc = /setup|intent|goal|attempt/.test(arcText)
    && /friction|complication|discovery|problem|blocked|cap|limit|missed|persist|shared|cross/.test(arcText)
    && /choice|decision|fork|safer|resolution|check|lock|cancel|redact|backup|reminder/.test(arcText)
    && /consequence|result|resolution|safer|loss|bill|charge|copy|reuse|payout|cost|spread/.test(arcText);
  const dialogueCount = slotKinds.filter((kind) => kind === 'speech' || kind === 'thought').length;
  const overloadedSceneNumbers = scenes
    .map((scene, index) => ((scene.overlaySlots || scene.overlay_slots || []).length > 1 ? index + 1 : null))
    .filter(Boolean);
  const duplicateScenePairs = [];
  for (let i = 0; i < descriptions.length; i += 1) {
    for (let j = i + 1; j < descriptions.length; j += 1) {
      if (sceneSimilarity(descriptions[i], descriptions[j]) >= 0.58) {
        duplicateScenePairs.push(`${i + 1}/${j + 1}`);
      }
    }
  }
  const issues = [];

  if (scenes.length < 4 || scenes.length > 6) {
    issues.push(`${label} should have 4-6 scenes for one scenario story`);
  }
  if (!script.protagonistGoal) {
    issues.push(`${label} is missing a concrete protagonist_goal`);
  }
  if (!script.visualReadThrough) {
    issues.push(`${label} is missing visual_read_through explaining what the art communicates without overlay text`);
  }
  if (!hasStoryArc) {
    issues.push(`${label} does not clearly cover setup, complication, choice, and consequence/resolution`);
  }
  if (concreteActionCount < Math.ceil(scenes.length * 0.75)) {
    issues.push(`${label} has too few concrete visible actions (${concreteActionCount}/${scenes.length})`);
  }
  if (genericVisualCount > Math.ceil(scenes.length * 0.65)) {
    issues.push(`${label} relies too much on generic icons/metaphors instead of scenario action (${genericVisualCount}/${scenes.length})`);
  }
  if (slots.length && dialogueCount < Math.ceil(slots.length * 0.5)) {
    issues.push(`${label} overlay_slots should mostly be dialogue/thought bubbles, not summary labels (${dialogueCount}/${slots.length})`);
  }
  if (deviceCenteredCount > maxDeviceScenes) {
    issues.push(`${label} has too many device/screen/desk-centered scenes (${deviceCenteredCount}/${scenes.length}; scenes ${deviceSceneNumbers.join(', ')}); keep this to ${maxDeviceScenes} or fewer`);
  }
  if (positions.length < Math.min(4, slots.length)) {
    issues.push(`${label} overlay_slots use too few distinct positions (${positions.join(', ') || 'none'}); use at least ${Math.min(4, slots.length)} varied positions`);
  }
  if (overloadedSceneNumbers.length > 2) {
    issues.push(`${label} uses multiple overlay bubbles in too many scenes (${overloadedSceneNumbers.join(', ')}); limit this to 1-2 key turning-point scenes`);
  }
  if (duplicateScenePairs.length) {
    issues.push(`${label} has visually repetitive scene descriptions (${duplicateScenePairs.join(', ')}); each scene needs a different action, setting, camera distance, and dominant object`);
  }

  return issues;
}

function comicPlanningQualityIssues(script, category = {}) {
  const comics = Array.isArray(script?.comics) && script.comics.length ? script.comics : [script];
  const issues = [];

  if (comics.length < 1 || comics.length > 3) {
    issues.push(`return 1-3 scenario comics, not ${comics.length}`);
  }
  if ((category.sourceSegments || []).length > 1 && (category.lookouts || []).length > 1 && comics.length < 2) {
    issues.push('source has multiple distinct clauses/lookouts; create at least 2 separate scenario comics instead of one compressed concept comic');
  }

  for (const [index, comic] of comics.entries()) {
    issues.push(...comicEntryQualityIssues(comic, `comic ${index + 1}`));
  }

  return issues;
}

async function runWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

export async function generateCardsWithQwen({ category, documentTitle }) {
  const config = getQwenConfig();
  const maxTokens = readPositiveInteger(process.env.QWEN_CARD_MAX_TOKENS, 1200);
  const normalized = normalizeCategoryForCards(category);

  if (!normalized.sourceSegments.length) {
    throw new Error(`Cannot generate cards for ${normalized.title}: no source segments were provided.`);
  }

  const cardPrompt = `You are an expert at explaining legal document clauses through concise flippable study cards.

Create 4-6 practical cards for the provided category. Use only the supplied metadata and evidence excerpts.

Cards should be varied: include user questions, detailed lookouts, examples, red flags, next checks, or plain-English meaning. The front should give a quick insight; the back should explain the practical point more clearly.

Rules:
1. Do not simply repeat the evidence excerpt.
2. Do not invent rights, exceptions, processes, or consequences.
3. Do not add consequences such as lawsuits, penalties, termination, charges, data use, or damages unless the evidence says so.
4. Keep high-severity cards direct, medium-severity cards practical, and low-severity cards informative.
5. Do not mention excerpt numbers, labels, or source references.
6. The "answer" field is a compact front-side pill label, not a sentence. It must be 1-3 words, 18 characters or fewer, and should be specific to the card.
7. Avoid generic pill labels such as "Check", "Review", or "Important". Prefer labels like "Access", "Approval", "Sharing", "Deadline", "Retention", "Liability", "Not allowed", "Next step", or another short category-specific label.
8. Treat the summary, impact, and lookouts as context only. If they add details not present in the evidence excerpts, omit those details.
9. Do not infer extra permissions from a prohibition boundary. If a clause says something is prohibited beyond a team, without approval, or under a condition, phrase the card around the restriction unless the excerpt explicitly says the opposite is allowed.
10. Do not infer "without notice", "immediate", "automatic", or "termination" unless that idea appears in the evidence excerpt.

OUTPUT FORMAT:

{
  "cards": [
    {
      "id": "short_stable_id",
      "question": "Can they revoke my access?",
      "answer": "Access",
      "frontDetail": "One concise sentence for the card front.",
      "backTitle": "What to verify",
      "backDetail": "One or two concise sentences for the flipped side."
    }
  ]
}

IMPORTANT:
- Return JSON only
- No comments
- No thinking
- Escape quotes, backslashes, and newlines inside JSON string values`;

  const sourceBlock = normalized.sourceSegments
    .map((segment) => `- ${segment}`)
    .join('\n');

  const parsed = await requestQwenJson({
    config,
    maxTokens,
    label: `card generation for ${normalized.title}`,
    validate: (value) => Array.isArray(value.cards),
    messages: [
      { role: 'system', content: cardPrompt },
      {
        role: 'user',
        content: `Document: ${documentTitle || 'EULA'}\nCategory: ${normalized.title}\nSeverity: ${normalized.severity}\n\nEvidence excerpts for grounding only. Do not mention excerpt numbers, labels, or source references in card text:\n${sourceBlock}\n\nGenerate cards for this category and return JSON only.`
      }
    ]
  });

  const cards = normalizeGeneratedCards(parsed.cards, normalized.id);
  if (!cards.length) throw new Error(`Qwen did not generate usable cards for ${normalized.title}.`);

  return { categoryId: normalized.id, cards };
}

export async function generateComicWithQwen({ category, documentTitle }) {
  const config = getQwenConfig();
  const scriptMaxTokens = readPositiveInteger(process.env.QWEN_COMIC_SCRIPT_MAX_TOKENS, 3600);
  const normalized = normalizeCategoryForCards(category);

  if (!normalized.sourceSegments.length) {
    throw new Error(`Cannot generate comic for ${normalized.title}: no source segments were provided.`);
  }

  const sourceBlock = normalized.sourceSegments
    .map((segment) => `- ${segment}`)
    .join('\n');
  const scenarioGuidance = scenarioGuidanceForCategory(normalized);

  const scriptPrompt = `You are an expert legal visual storyteller and image-prompt planner.

Convert the provided legal category into 1-3 grounded scenario comics. Each comic is a separate short story, not a list of legal facts.

The goal is visual storytelling: if someone hides the overlay text, they should still understand the rough situation, the obstacle, and the changed decision from the pictures alone.

Choose the number of comics:
1. Use 1 comic when one concrete scenario explains the category well.
2. Use 2 comics when the category has two meaningfully different clauses, user workflows, risks, exceptions, or decision moments.
3. Use 3 comics only when the source segments clearly support three distinct scenarios. Never use more than 3.
4. Prefer splitting distinct issues into separate comics instead of cramming them into one page. For example: broad content reuse and deletion/backups are separate scenarios; renewal deadline and refund limit can be separate scenarios; vendor sharing and cross-country processing can be separate scenarios; damage cap and excluded damages can be separate scenarios.
5. When the source has multiple clauses or lookouts, default to 2 comics unless they are truly the same user moment.

Each comic should depict one concrete event:
1. protagonist goal - what the person wants to do;
2. ordinary action - what they try first;
3. clause friction - what the agreement changes or complicates;
4. visible consequence - what could happen in the workflow;
5. decision - what they do differently after noticing the issue.

Scenario quality test:
1. A viewer should be able to narrate "because this happened, that moved/changed/was blocked, so the protagonist chose this next step."
2. The panels should not look interchangeable with any other legal category. Use category-specific objects, places, handoffs, deadlines, or consequences.
3. Every scene should answer: what visibly changed since the previous scene?

Rules:
1. Use only the category metadata and source segments provided by the user.
2. Choose a realistic main character and workflow based on the category, such as a developer, researcher, student, employee, manager, creator, or platform user.
3. Keep the story educational and practical. Avoid courtroom scenes, punishment, panic, or legal doom unless the source segments explicitly support that.
4. Use only the important legal ideas. Do not force every small detail into the story.
5. Keep legal wording short and natural. Do not quote long clauses in dialogue.
6. Each comic must have one protagonist, one goal, and a cause-effect story.
7. Every scene must introduce a new action or decision point, not a new summary bullet.
8. Every scene must include action, setting, mood, important objects, facial expression cues, and a distinct composition.
9. Use 4-6 scenes per comic. Prefer 5 or 6 scenes when the scenario needs setup, friction, consequence, and safer choice.
10. Do not add scenes just to reach a count.
11. Do not invent consequences, exceptions, approvals, or processes beyond the source segments.
12. Do not invent exact dollar amounts, dates, percentages, deadlines, counts, or numeric examples unless they appear in the source segments.
13. Do not suggest lawsuits, legal claims, legal counsel, filing incident reports, negotiation, amendments, or enforcement steps unless those actions appear in the source segments.
14. Use scene purpose labels to make the story shape explicit: every comic should include setup, attempt or discovery, friction, consequence, and decision/resolution/safer_action.

Visual storytelling rules:
1. Do not make every panel the same person at the same laptop angle.
2. Build a real mini-story: setup, attempt, discovery, practical fork, consequence preview, safer choice.
3. Prefer visible causality over legal symbolism. Show a file being copied, an invoice arriving, a folder becoming locked, a renewal reminder being missed, a dataset moving to another team, a tool breaking during a deadline, or a user choosing a different path.
4. The legal category must become visible through actions and objects, not through printed legal text.
5. Use metaphors only when they are part of a concrete scene. A lock should lock a folder; a split path should be walked by the character; a receipt should be handed over; a server corridor should contain the copied asset.
6. Each visual_description should make it obvious what happened before and what changes after.
7. Give every scene a different dominant visual anchor, such as an uploaded asset, a copied file, a locked folder, a renewal receipt, a missed reminder, a server corridor, a handoff, a split path, a broken tool, a backup shelf, a checklist, or a settings drawer.
8. At most half of the scenes may center on a screen, phone, laptop, computer, or person sitting at a desk with a device. A device may appear in the background, but it should not be the repeated main subject.
   For a 6-scene comic, aim for 2 device/screen/desk-centered scenes at most; 3 is the absolute maximum.
9. Include at least two scenes built around non-device imagery such as maps, timelines, file cabinets, receipts, locks, warning signs, server paths, split paths, or physical objects.
10. Do not reuse the same composition label or dominant visual anchor more than twice.
11. Do not repeat the same beat with only minor wording changes. No two visual_description values should share the same main character, same object, same room, and same action.
12. visual_description should describe the literal art. It may mention where the app overlay should have clean space, but the generated image must not include bubbles, UI labels, document words, page headings, frame numbers, logos, or signs.
13. Before returning, self-check the scenes: if more than half are device/screen/desk-centered, rewrite some panels into physical metaphors, environment shots, object close-ups, or split-path visuals.
14. Avoid vague panels that only show an icon or abstract concept. Every panel should show someone doing something, something changing hands, something moving, something being blocked, or a visible before/after state.
15. Do not write visual_description using "represents", "symbolizes", "symbolizing", or "as a metaphor". Describe the literal scene instead. Bad: "a globe symbolizing worldwide reach." Good: "the creator's photo appears in several distant city kiosks while the creator watches from the sidewalk."
16. Avoid floating icons as the main event. If an icon appears, make it part of an object or action: a receipt in a hand, a locked folder in a drawer, a copied file on a shelf, a route on a physical map, a renewal envelope on a table.
17. For data-sharing, vendor, analytics, integration, or cross-border scenarios, do not make the story mostly laptop/tablet diagrams. After the setup panel, use physical routing and handoff scenes: sealed folders moving between desks, server-room handoffs, file carts, a wall map with string routes, border/checkpoint imagery, locked cabinets, redacted paper, and people deciding what data to remove.

Overlay text rules:
1. overlay_title is a short planning title for the UI card, not for the image model.
2. overlay_caption is a plain-English summary for the UI card, not for the image model.
3. overlay_slots are comic text bubbles/callouts that the app will render over the image.
4. Use 1 overlay_slot for most scenes. Use 2 in 1-2 key turning-point scenes when the second line adds distinct context, such as a rule plus consequence or action plus warning.
5. Keep overlay text readable but informative: usually 6-12 words, maximum 16 words. Prefer one complete idea over clipped labels.
6. Prefer dialogue and thoughts over summary labels. Let characters ask, notice, misunderstand, decide, or warn each other.
7. Give every overlay slot a position: top_left, top_right, middle_left, middle_right, bottom_left, bottom_right, or center.
8. Place overlay slots where the art should leave uncluttered background. Avoid covering faces, hands, key objects, or important screen areas.
9. Across the page, use at least 4 distinct overlay positions when there are 4 or more slots. Avoid repeating the same side in most panels.
10. Do not include source segment numbers, quote labels, exact clause quotes, or vague phrases like "this wording".
11. Do not use emoji, decorative symbols, or exact numeric examples not present in the source segments.
12. Keep dialogue short enough for bubbles. Good: "Can I use this dataset for my thesis?", "Sharing my login would bypass approval.", "Ask for written permission first."
13. Use callouts sparingly for concrete lookouts. Avoid making every bubble a summary sentence.

Raw image prompt rules:
1. Each comic has its own raw_image_prompt describing one full art-only image mosaic in one self-contained English prompt.
2. Do not request readable text anywhere in the generated image: no page title, panel title, frame number, caption, label, speech bubble, thought bubble, UI writing, document writing, logo, brand mark, or sign text.
3. Preserve story flow and character consistency across panels.
4. Use a clear grid that matches the scene count: 2x2 for 4 scenes, 2x3 for 5-6 scenes.
5. Describe each panel's action, composition, and dominant visual anchor separately so the image model does not repeat the same shot.
6. Leave clean negative space near each scene's overlay slot positions, but do not draw the bubbles or callouts; the app will render them later.
7. Computer screens and documents should use abstract blocks, icons, and unreadable interface lines only.
8. Never request page titles, panel titles, frame numbers, logos, brand marks, readable UI text, readable document text, button names, exact quoted clause text, EULA text, fine print, signage text, speech bubbles, or thought bubbles as the explanation.
9. Never write raw_image_prompt using numbered labels like "Panel 1", "Frame 1", or "Cell 1"; image models often turn those into visible title bands.
10. Avoid photorealism and infographic style.
11. This prompt can be rough but complete; a downstream image prompt refiner may polish it later.
12. The raw_image_prompt should pass the hidden-text test: without overlay text, the image sequence still reads like a scenario with cause and effect.

OUTPUT FORMAT:

{
  "category_id": "string",
  "title": "string",
  "story_summary": "string",
  "comics": [
    {
      "id": "short_stable_id",
      "title": "string",
      "scenario_title": "string",
      "scenario_type": "string",
      "protagonist_goal": "concrete goal in this scenario",
      "visual_read_through": "what a viewer should understand from the images before reading overlays",
      "main_character": {
        "role": "string",
        "appearance": "string"
      },
      "story_summary": "string",
      "story_arc": "setup -> friction -> consequence -> decision",
      "raw_image_prompt": "one complete art-only image-mosaic prompt for this scenario; no generated text, titles, labels, or bubbles",
      "scenes": [
        {
          "scene_number": 1,
          "scene_title": "string",
          "overlay_title": "short title to render outside/over the image later",
          "overlay_caption": "short caption to render outside/over the image later",
          "overlay_slots": [
            {
              "kind": "speech|thought|callout|note|warning|caption",
              "text": "short dialogue, thought, or occasional callout",
              "position": "top_left|top_right|middle_left|middle_right|bottom_left|bottom_right|center",
              "tail": "optional target such as character, screen, document, file, folder"
            }
          ],
          "purpose": "setup|attempt|discovery|friction|choice|consequence|resolution|safer_action",
          "legal_point": "string",
          "legal_basis": ["short source-grounded point"],
          "narration": "string",
          "dialogue": "string",
          "composition": "wide shot|close-up|over-the-shoulder|split-screen|object metaphor|timeline|workflow view|other",
          "visual_hook": "what makes this scene visually distinct",
          "visual_description": "string"
        }
      ]
    }
  ]
}

IMPORTANT:
- Return JSON only
- No comments
- No thinking
- Escape quotes, backslashes, and newlines inside JSON string values`;

  const userPrompt = `Document: ${documentTitle || 'EULA'}\nCategory: ${normalized.title}\nSeverity: ${normalized.severity}\nSummary: ${normalized.summary || 'Not provided'}\nImpact: ${normalized.impact || 'Not provided'}\nLookouts: ${normalized.lookouts.join(', ') || 'Not provided'}\n\nScenario guidance:\n${scenarioGuidance}\n\nSource segments:\n${sourceBlock}\n\nCreate 1-3 scenario comics for this category and return JSON only.`;

  let rawScript = await requestQwenJson({
    config,
    maxTokens: scriptMaxTokens,
    label: `scenario comic scripts and image prompts for ${normalized.title}`,
    validate: (value) => (
      Array.isArray(value.comics)
      || (Array.isArray(value.scenes) && typeof (value.raw_image_prompt || value.rawImagePrompt) === 'string')
    ),
    messages: [
      { role: 'system', content: scriptPrompt },
      { role: 'user', content: userPrompt }
    ]
  });

  let script = normalizeComicScript(rawScript, normalized);
  const qualityIssues = comicPlanningQualityIssues(script, normalized);

  if (qualityIssues.length) {
    rawScript = await requestQwenJson({
      config,
      maxTokens: scriptMaxTokens,
      label: `scenario comic repair for ${normalized.title}`,
      validate: (value) => (
        Array.isArray(value.comics)
        || (Array.isArray(value.scenes) && typeof (value.raw_image_prompt || value.rawImagePrompt) === 'string')
      ),
      messages: [
        { role: 'system', content: scriptPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: JSON.stringify(rawScript) },
        {
          role: 'user',
          content: `Revise the JSON to fix these quality issues:
- ${qualityIssues.join('\n- ')}

Keep the same legal grounding and overall category, but rewrite scenario comics from scratch where needed. Each comic must be one concrete user story with setup, attempt, friction/discovery, choice, consequence, and safer action/resolution. If a comic is just legal concepts illustrated by icons, replace it with a real scenario. If the source has multiple distinct clauses/lookouts, split them into separate comics rather than compressing them.

For a 6-scene comic, use this device-light structure unless the source absolutely requires otherwise:
1. setup may include one device or desk;
2. visible attempt/action;
3. physical clause clue, handoff, map, folder, receipt, key, path, or environment shot;
4. consequence preview as an action or before/after state;
5. human reaction, split path, or decision moment;
6. safer action with checklist, shield, magnifying glass, folder, lock, or other physical object rather than a screen.

Story/visual repair:
- Keep the cause-effect story visible through character action and object movement. Do not rely on legal summaries, labels, or icons to do the work.
- Remove text-like marks from visual_description and raw_image_prompt. Keep readable words only in overlay_slots; the generated image should have no UI words, document words, logos, EULA text, fine print, labels, stamps, button names, quoted UI text, speech bubbles, or thought bubbles.
- Remove repeated visual beats. If two scenes use the same person, same object, same room, and same action, rewrite one as a different camera distance, physical handoff, blocked path, consequence preview, permission step, or safer next action.
- Do not use numbered labels like "Panel 1", "Frame 1", or "Cell 1" in raw_image_prompt.
- Remove words like "represents", "symbolizes", "symbolizing", and "metaphor" from visual_description. Describe what the viewer literally sees happening.
- Replace floating icons with concrete scenario actions: a reused image on an unbranded display, a copied file staying on a backup shelf, a renewal receipt arriving, a folder being handed to a partner, a broken tool during a deadline.

Overlay repair: use mostly speech/thought bubbles, not summary labels. Keep most scenes to one clear 6-12 word overlay slot; use a second bubble in at most 1-2 turning-point scenes only when it adds a different idea. Use at least 4 distinct overlay positions across the page when there are 4 or more slots, and avoid phrases like "this wording".

Return the full corrected JSON only.`
        }
      ]
    });
    script = normalizeComicScript(rawScript, normalized);
  }

  if (!script.comics.length || !script.scenes.length) throw new Error(`Qwen did not generate usable comic scenarios for ${normalized.title}.`);
  if (!script.rawImagePrompt) throw new Error(`Qwen did not generate a usable raw image prompt for ${normalized.title}.`);

  return {
    categoryId: normalized.id,
    comic: {
      ...script,
      imagePrompt: script.rawImagePrompt
    }
  };
}

export async function generateVideoScriptWithQwen({ category, documentTitle }) {
  const config = getQwenConfig();
  const maxTokens = readPositiveInteger(process.env.QWEN_VIDEO_SCRIPT_MAX_TOKENS, 2400);
  const durationSeconds = readPositiveInteger(process.env.QWEN_VIDEO_DURATION_SECONDS || process.env.VIDEO_DURATION_SECONDS, 30);
  const qualityAttempts = Math.min(readPositiveInteger(process.env.QWEN_VIDEO_SCRIPT_QUALITY_ATTEMPTS, 2), 3);
  const normalized = normalizeCategoryForCards(category);

  if (!normalized.sourceSegments.length) {
    throw new Error(`Cannot generate video script for ${normalized.title}: no source segments were provided.`);
  }

  const sourceBlock = normalized.sourceSegments
    .slice(0, 5)
    .map((segment) => `- ${segment}`)
    .join('\n');

  const videoPrompt = `You are an expert legal visual storyteller and 2D animation director.

Create one source-grounded ${durationSeconds} second video script for the provided EULA category.
The result should be a short character interaction: people discover the rule through a practical situation and dialogue, not a narrator reading a summary.

The video model generates visuals only. Dialogue audio and subtitles are added separately after generation.

Write a simple visual story:
1. a person has an ordinary goal involving a protected item, account, file, dataset, payment, license, deadline, or shared workspace
2. another person tries a tempting but risky shortcut
3. a visible boundary stops the shortcut: blocked door, withheld item, locked case, separate token, returned folder, closed tray, declined handoff, or failed upload
4. a reviewer/teammate shows the safer approved path
5. the work continues, but the protected item or rule stays intact

Keep it easy for LTX: two or three characters, one plain professional setting, two or three important physical props, readable body language, and stable composition.
Prefer props and gestures over abstract icons: keycards, locked cases, envelopes, shelves, doors, trays, receipts, folders, drives, handoffs, refusals, returns, approvals, and separate approved items.
For approval, prefer a separate new keycard, token, envelope, tray item, or unlocked case. Avoid stamps, badges, wall notes, posters, signs, forms, and documents because the video model often turns them into gibberish text.
Avoid floating warning symbols, red hologram barriers, check marks, abstract legal icons, scales, gavels, or magical UI effects. If something is blocked, show a physical stop: closed case, locked door, pulled-back hand, returned folder, separate tray, or withheld token.
Do not invent penalties, deadlines, prices, legal processes, or exceptions unless the source says them.

model_prompt rules:
- Start with: "${durationSeconds} second clean light line-art 2D animated explainer video"
- Keep it 120-180 words, never above 210.
- Match this style: simple flat-shaded characters, smooth cartoon motion, limited camera movement, clean professional educational animation, stable composition.
- Use a plain lab, office, data room, counter, storage shelf, or doorway that fits the category, with bare walls or a plain background.
- Use the same prompt rhythm as a compact storyboard paragraph: one opening style sentence, then 5-7 action sentences, then one final guardrail sentence.
- Do not over-describe style. Focus on character action, object movement, and simple props.
- Use physical cause and effect, bare walls/plain background, and no floating warning graphics, abstract barriers, stamps, badges, forms, posters, or wall notes.
- The model prompt must not ask for generated voices, dialogue, captions, or subtitles.
- The model prompt must include: no readable text anywhere, no labels, no posters, no signs, no screen writing, no logos.
- Avoid yellow tint, sepia, parchment, paper texture, whiteboard, marker drawing, visible drawing hand, sketchbook, courtroom, panic, or legal doom.

subtitle_lines rules:
- Write 5-7 short character dialogue lines, 76 characters or fewer.
- Use role speakers such as Researcher, Visitor, Teammate, Organizer, Supervisor, Creator, Reviewer, User, or Collaborator.
- Avoid narrator lines unless absolutely necessary.
- Avoid category-reading lines like "Access is limited..." or "Commercial use is not allowed." Turn the rule into dialogue in context.
- Dialogue should explain the rule through disagreement, clarification, and agreement, not through labels.
- The final agreement must use the safer approved path. If the source forbids sharing links, files, copies, credentials, resale, redistribution, or outside use, do not make a character accept that forbidden shortcut in the ending.
- Do not mention source segments, excerpts, schemas, dashboards, or this app.

OUTPUT FORMAT:

{
  "category_id": "string",
  "title": "string",
  "duration_seconds": ${durationSeconds},
  "story_goal": "what the viewer should understand",
  "visual_style": "clean 2D animated explainer video",
  "shot_plan": [
    {
      "start_seconds": 0,
      "end_seconds": 5,
      "visual_beat": "literal visual action",
      "camera": "stable wide shot|simple push-in|object close-up|side view",
      "legal_point": "source-grounded point"
    }
  ],
  "subtitle_lines": [
    {
      "start_seconds": 0,
      "end_seconds": 4,
      "speaker": "character role",
      "text": "short character dialogue"
    }
  ],
  "audio_plan": "brief deterministic dialogue audio direction",
  "model_prompt": "single text-to-video prompt under 230 words",
  "negative_prompt": "photorealistic, live action, readable text, words, captions, subtitles, logos, watermarks, posters, signs, UI labels, screen writing, brand names, yellow tint, sepia, parchment, paper texture, whiteboard, marker drawing, visible drawing hand, distorted hands, extra fingers, duplicated faces, jitter, flicker, blurry, low quality, clutter"
}

IMPORTANT:
- Return JSON only
- No comments
- No thinking
- Escape quotes, backslashes, and newlines inside JSON string values`;

  const userContent = `Document: ${documentTitle || 'EULA'}\nCategory: ${normalized.title}\nSeverity: ${normalized.severity}\n\nSource segments:\n${sourceBlock}\n\nGenerate the video script and return JSON only.`;
  let parsed = null;
  let feedback = '';

  for (let attempt = 1; attempt <= qualityAttempts; attempt += 1) {
    parsed = await requestQwenJson({
      config,
      maxTokens,
      label: `video script for ${normalized.title}`,
      validate: (value) => typeof (value.model_prompt || value.modelPrompt || value.prompt) === 'string',
      messages: [
        { role: 'system', content: videoPrompt },
        {
          role: 'user',
          content: feedback ? `${userContent}\n\nRevise the previous attempt to fix these issues:\n${feedback}` : userContent
        }
      ]
    });

    const issues = videoScriptQualityIssues(parsed, normalized, durationSeconds);
    if (!issues.length) break;
    feedback = issues.map((issue) => `- ${issue}`).join('\n');
  }

  const video = normalizeVideoScript(parsed, normalized, durationSeconds);
  if (!video.modelPrompt) throw new Error(`Qwen did not generate a usable video prompt for ${normalized.title}.`);

  return {
    categoryId: normalized.id,
    video
  };
}

export async function generateCardsBatchWithQwen({ categories = [], documentTitle }) {
  const concurrency = Math.min(readPositiveInteger(process.env.QWEN_CARD_BATCH_CONCURRENCY, 3), 8);

  return runWithConcurrency(categories, concurrency, async (category) => {
    const normalized = normalizeCategoryForCards(category);
    try {
      const result = await generateCardsWithQwen({ category, documentTitle });
      return { ok: true, categoryId: result.categoryId, cards: result.cards };
    } catch (error) {
      return {
        ok: false,
        categoryId: normalized.id,
        error: error?.message || 'Card generation failed.',
        details: error?.details
      };
    }
  });
}

export async function analyzeWithQwen({ text, fileName }) {
  const config = getQwenConfig();
  const chunkChars = readPositiveInteger(process.env.QWEN_CHUNK_CHARS, 3500);
  const maxTokens = readPositiveInteger(process.env.QWEN_MAX_TOKENS, 4096);

  const categoryPrompt = `You are an expert in legal document analysis, especially EULAs, software licenses, SaaS terms, dataset licenses, and privacy-linked terms.

Identify the meaningful legal/practical categories in the agreement chunk.

A category is a coherent issue a reader should review as one unit: a right, restriction, obligation, permission, risk, process, or remedy. It is not just a heading or keyword. Use precise snake_case names such as ai_training, content_license, auto_renewal, termination, class_action_waiver, data_retention, liability, prohibited_use, refunds, arbitration, or create a better category if needed.

For each category:
1. preserve exact supporting clauses in source_segments;
2. choose a precise category_id;
3. rate severity as low, medium, or high;
4. write a concise summary;
5. explain practical impact;
6. list 2-3 specific lookouts.

Clause rules:
1. Quote source_segments exactly; do not paraphrase them.
2. Extract complete clauses or complete logical statements, not fragments.
3. Preserve conditions, exceptions, time limits, and party names.
4. Each source segment should appear in only one category.
5. If a segment fits multiple categories, choose the most specific useful category.
6. Do not force a clause into a known category if a clearer custom category fits.
7. Ignore text with no practical effect unless it changes rights, duties, access, money, data, remedies, or dispute process.

Severity guide:
- high: can materially affect money, data, rights, access, legal exposure, uploaded content, remedies, dispute process, or intended use; also broad one-sided discretion like "at any time", "for any reason", or "sole discretion" tied to those interests.
- medium: worth checking but narrower, more standard, conditional, manageable, or dependent on linked details.
- low: mostly informational, narrow, expected, user-controlled, or unlikely to change the decision by itself.

Metadata rules:
1. summary says what the extracted language does.
2. impact explains why it matters in practice.
3. lookouts should name concrete issues like "AI training language", "automatic renewal window", "sole discretion", "refund limits", or "data retention period".
4. Do not invent facts beyond source_segments.
5. If the chunk has no meaningful category, return {"categories": []}.

OUTPUT FORMAT:

Return ONLY valid JSON in the following structure:

{
  "categories": [
    {
      "category_id": "category_name",
      "severity": "low|medium|high",
      "summary": "one concise sentence",
      "impact": "one concise user-facing sentence",
      "lookouts": ["short phrase 1", "short phrase 2"],
      "source_segments": [
        "full original text segment 1",
        "full original text segment 2"
      ]
    }
  ]
}

IMPORTANT:
- No explanations
- No comments
- No thinking
- No extra text outside JSON
- Escape quotes, backslashes, and newlines inside JSON string values
- Ensure JSON is valid and complete`;

  const chunks = chunkText(text, chunkChars);
  const results = [];

  for (const [index, chunk] of chunks.entries()) {
    const parsed = await requestQwenJson({
      config,
      maxTokens,
      label: `category extraction chunk ${index + 1}/${chunks.length}`,
      validate: (value) => Array.isArray(value.categories),
      messages: [
        { role: 'system', content: categoryPrompt },
        { role: 'user', content: `Analyze this agreement chunk and return JSON only:\n\n${chunk}` }
      ]
    });
    results.push(parsed);
  }

  const categories = mergeCategoryResults(results).map(normalizeExtractedCategory);
  if (!categories.length) throw new Error('Qwen did not extract any supported EULA categories.');

  return {
    document: {
      title: fileName || 'Pasted_EULA.txt',
      sourceType: fileName?.toLowerCase().endsWith('.pdf') ? 'pdf' : 'text',
      parsedAt: new Date().toISOString(),
      textPreview: truncate(text, 1400)
    },
    overview: {
      summary: `Extracted ${categories.length} source-backed EULA ${categories.length === 1 ? 'category' : 'categories'} from ${chunks.length} text ${chunks.length === 1 ? 'chunk' : 'chunks'}.`
    },
    categories,
    sourceText: text
  };
}
