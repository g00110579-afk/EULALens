import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { presentationPrecomputedRoot } from './config.js';

const ASSET_ROUTE = '/api/presentation/assets';
const EXTRA_ALIASES = {
  '01-eula-terms-of-service-zoom': [
    'zoom',
    'zoom terms',
    'zoom terms of service',
    'eula terms of service zoom'
  ],
  '02-eula-explainable-deepfake-detection-challenge-2026': [
    'deepfake',
    'deepfake detection challenge',
    'explainable deepfake detection challenge',
    'eula explainable deepfake detection challenge'
  ],
  '03-reader-eula-adobe': [
    'adobe',
    'adobe reader',
    'adobe reader eula',
    'reader eula adobe'
  ],
  '04-steam-subscriber-agreement': [
    'steam',
    'steam subscriber agreement'
  ],
  '05-terms-and-conditions-of-use-spotify': [
    'spotify',
    'spotify terms',
    'spotify terms of use',
    'terms and conditions of use spotify'
  ],
  '07-useterms-oem-windows-11-english': [
    'windows',
    'windows 11',
    'windows 11 oem',
    'oem windows 11',
    'windows 11 english',
    'useter ms oem windows 11 english'
  ]
};

let cachedIndex = null;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripOrdinalSlug(value) {
  return slugify(value).replace(/^\d+-/, '');
}

function compactText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/');
}

function routeUrl(routePath) {
  const normalized = normalizePath(routePath).replace(/^\/+/, '');
  const webpRoute = normalized.replace(/(\.png)$/i, '.webp');
  const preferredRoute = normalized.includes('/assets/comics/')
    && webpRoute !== normalized
    && fs.existsSync(path.join(presentationPrecomputedRoot, webpRoute))
    ? webpRoute
    : normalized;

  return `${ASSET_ROUTE}/${preferredRoute}`;
}

function documentContext(documentOrSlug) {
  if (typeof documentOrSlug === 'string') {
    return {
      slug: documentOrSlug,
      assetPrefix: `documents/${documentOrSlug}`
    };
  }

  return {
    slug: documentOrSlug?.slug || '',
    assetPrefix: documentOrSlug?.assetPrefix || `documents/${documentOrSlug?.slug || ''}`
  };
}

function assetUrlFromPath(value, documentOrSlug) {
  const document = documentContext(documentOrSlug);
  const { slug, assetPrefix } = document;
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || raw.startsWith(ASSET_ROUTE)) return raw;

  const normalized = normalizePath(raw);
  const root = normalizePath(presentationPrecomputedRoot);
  if (normalized.startsWith(`${root}/`)) {
    return routeUrl(normalized.slice(root.length + 1));
  }

  const documentsMarker = `documents/${slug}/`;
  const documentsIndex = normalized.indexOf(documentsMarker);
  if (documentsIndex >= 0) {
    return routeUrl(`${assetPrefix}/${normalized.slice(documentsIndex + documentsMarker.length)}`);
  }

  if (normalized.startsWith('assets/')) {
    return routeUrl(`${assetPrefix}/${normalized}`);
  }

  if (normalized === 'source.pdf') {
    return routeUrl(`${assetPrefix}/source.pdf`);
  }

  return raw;
}

function normalizeImage(image, document) {
  if (!image || typeof image !== 'object') return image;
  const imageUrl = assetUrlFromPath(image.localPath || image.imageUrl || image.url || image.imagePath, document);
  return imageUrl ? { ...image, imageUrl } : image;
}

function normalizeVideo(video, document) {
  if (!video || typeof video !== 'object') return video;
  const videoUrl = assetUrlFromPath(video.localPath || video.videoUrl || video.video_url, document);
  return videoUrl ? { ...video, videoUrl, status: video.status || 'completed' } : video;
}

function comicHasPanels(comic) {
  if (Array.isArray(comic?.panels) && comic.panels.length) return true;
  return Array.isArray(comic?.comics) && comic.comics.some((item) => Array.isArray(item?.panels) && item.panels.length);
}

function categoryHasComicImage(category) {
  if (category?.comicImage?.imageUrl || category?.comicImage?.localPath) return true;
  if (!category?.comicImages || typeof category.comicImages !== 'object') return false;
  return Object.values(category.comicImages).some((image) => image?.imageUrl || image?.localPath);
}

function categoryHasVideo(category) {
  const video = category?.videoResult || category?.video || {};
  return Boolean(video.videoUrl || video.video_url || video.localPath);
}

function categoryIsPresentationReady(category) {
  const precompute = category?.precompute || {};
  const hasPrecomputeStatus = ['cards', 'comic', 'comicImages', 'videoScript', 'video'].some((key) => key in precompute);

  if (hasPrecomputeStatus) {
    return precompute.cards === 'ready'
      && precompute.comic === 'ready'
      && precompute.comicImages === 'ready'
      && precompute.videoScript === 'ready'
      && precompute.video === 'ready';
  }

  return Array.isArray(category?.cards)
    && category.cards.length > 0
    && comicHasPanels(category.comic)
    && categoryHasComicImage(category)
    && categoryHasVideo(category);
}

function attachComicImages(comic, comicImages = {}) {
  if (!comic || typeof comic !== 'object') return comic;
  const next = { ...comic };
  if (Array.isArray(next.comics)) {
    next.comics = next.comics.map((item) => {
      const image = item?.image || comicImages[item?.id] || comicImages[item?.scenarioId] || comicImages[item?.scenario_id];
      return image ? { ...item, image } : item;
    });
  }

  const selectedId = next.selectedComicId || next.selected_comic_id || next.comics?.[0]?.id;
  if (selectedId && comicImages[selectedId] && !next.image) next.image = comicImages[selectedId];
  return next;
}

function normalizeCategory(category, document) {
  const next = cloneJson(category);

  if (next.comicImages && typeof next.comicImages === 'object') {
    next.comicImages = Object.fromEntries(
      Object.entries(next.comicImages).map(([key, image]) => [key, normalizeImage(image, document)])
    );
  }

  if (next.comicImage) next.comicImage = normalizeImage(next.comicImage, document);
  if (next.comic) next.comic = attachComicImages(next.comic, next.comicImages || {});

  const normalizedVideo = normalizeVideo(next.video, document);
  const normalizedResult = normalizeVideo(next.videoResult, document);
  next.videoResult = normalizedResult;

  if (normalizedVideo || normalizedResult) {
    next.video = {
      ...(normalizedVideo || {}),
      ...(normalizedResult?.videoUrl ? normalizedResult : {}),
      categoryId: next.id || normalizedVideo?.categoryId || normalizedResult?.categoryId
    };
  }

  next.mediaAvailability = {
    cards: Array.isArray(next.cards) && next.cards.length > 0,
    comic: comicHasPanels(next.comic),
    comicImages: categoryHasComicImage(next),
    videoScript: Boolean(next.video?.modelPrompt || next.video?.model_prompt || next.video?.shotPlan?.length || next.video?.shot_plan?.length),
    video: categoryHasVideo(next)
  };
  next.cardsStatus = next.mediaAvailability.cards ? 'ready' : 'pending';
  next.comicStatus = next.mediaAvailability.comic ? 'ready' : 'pending';
  next.videoScriptStatus = next.mediaAvailability.videoScript ? 'ready' : 'pending';
  next.precomputed = true;
  return next;
}

function documentSlug(document, index) {
  if (document?.slug) return document.slug;
  const title = document?.title || document?.path || `document-${index + 1}`;
  return `${String(index + 1).padStart(2, '0')}-${slugify(title)}`;
}

function documentAliases({ manifestDocument, precomputed, slug }) {
  const aliases = new Set([
    slug,
    stripOrdinalSlug(slug),
    precomputed?.source?.title,
    precomputed?.source?.slug,
    precomputed?.document?.title,
    manifestDocument?.title,
    manifestDocument?.path ? path.basename(manifestDocument.path) : '',
    ...(EXTRA_ALIASES[slug] || [])
  ].filter(Boolean));

  return Array.from(aliases)
    .flatMap((alias) => [slugify(alias), stripOrdinalSlug(alias)])
    .filter(Boolean);
}

function textAnchors(textCompact) {
  if (!textCompact || textCompact.length < 600) return [];
  const width = 220;
  const positions = [0, 0.2, 0.5, 0.8]
    .map((ratio) => Math.max(0, Math.floor(textCompact.length * ratio) - Math.floor(width / 2)));
  return Array.from(new Set(positions))
    .map((start) => textCompact.slice(start, start + width))
    .filter((anchor) => anchor.length >= 160);
}

function readManifest(manifestDir) {
  const manifestPath = path.join(manifestDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  return {
    manifest: readJson(manifestPath),
    manifestDir,
    setId: normalizePath(path.relative(presentationPrecomputedRoot, manifestDir))
  };
}

function discoverManifests() {
  const rootManifest = readManifest(presentationPrecomputedRoot);
  if (!rootManifest) return [];

  const rootStudySets = Array.isArray(rootManifest.manifest.studySets) ? rootManifest.manifest.studySets : [];
  const childNames = rootStudySets.length
    ? rootStudySets
    : fs.readdirSync(presentationPrecomputedRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const childManifests = childNames
    .map((name) => readManifest(path.join(presentationPrecomputedRoot, name)))
    .filter(Boolean);

  return [
    ...(Array.isArray(rootManifest.manifest.documents) && rootManifest.manifest.documents.length ? [rootManifest] : []),
    ...childManifests
  ];
}

function documentsFromManifest({ manifest, manifestDir, setId }) {
  const manifestDocuments = Array.isArray(manifest.documents) ? manifest.documents : [];
  const resultSlugs = new Map(
    (Array.isArray(manifest.results) ? manifest.results : [])
      .filter((item) => item?.slug)
      .map((item) => [item.title || item.slug, item.slug])
  );

  return manifestDocuments.map((manifestDocument, index) => {
    const slug = manifestDocument.slug || resultSlugs.get(manifestDocument.title) || documentSlug(manifestDocument, index);
    const documentRoot = path.join(manifestDir, 'documents', slug);
    const precomputedPath = path.join(documentRoot, 'precomputed.json');
    const extractedTextPath = path.join(documentRoot, 'extracted_text.txt');
    if (!fs.existsSync(precomputedPath)) return null;

    const precomputed = readJson(precomputedPath);
    const extractedText = fs.existsSync(extractedTextPath) ? fs.readFileSync(extractedTextPath, 'utf8') : '';
    const textCompact = compactText(extractedText || precomputed?.sourceText || '');
    const assetPrefix = normalizePath(path.relative(presentationPrecomputedRoot, documentRoot));

    return {
      slug,
      setId,
      assetPrefix,
      documentRoot,
      title: precomputed?.source?.title || manifestDocument.title || slug,
      aliases: documentAliases({ manifestDocument, precomputed, slug }),
      textCompact,
      contentHash: textCompact ? createHash('sha256').update(textCompact).digest('hex') : '',
      anchors: textAnchors(textCompact),
      precomputed
    };
  }).filter(Boolean);
}

function buildIndex() {
  const manifestPath = path.join(presentationPrecomputedRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { documents: [], manifest: null, error: `Presentation manifest not found at ${manifestPath}` };
  }

  const manifest = readJson(manifestPath);
  const manifests = discoverManifests();
  const documents = manifests.flatMap((entry) => documentsFromManifest(entry));

  return {
    manifest,
    sets: manifests.map((entry) => entry.setId || 'root'),
    documents,
    error: documents.length ? '' : `No presentation documents found under ${presentationPrecomputedRoot}`
  };
}

function getIndex() {
  if (!cachedIndex) cachedIndex = buildIndex();
  return cachedIndex;
}

function findPresentationDocument({ text } = {}) {
  const canonical = compactText(text);
  if (!canonical) return null;
  const contentHash = createHash('sha256').update(canonical).digest('hex');
  const document = getIndex().documents.find((item) => item.contentHash === contentHash && item.textCompact === canonical);
  // A familiar filename or matching introduction does not establish document identity.
  return document ? { document, matchedBy: 'content-sha256' } : null;
}

export function getPresentationHealth() {
  const index = getIndex();
  return {
    enabled: true,
    root: presentationPrecomputedRoot,
    documentCount: index.documents.length,
    sets: index.sets || [],
    error: index.error || ''
  };
}

export function buildPresentationAnalysis({ text, fileName } = {}) {
  const match = findPresentationDocument({ text, fileName });
  if (!match) return null;

  const { document, matchedBy } = match;
  const precomputed = document.precomputed;
  const categories = Array.isArray(precomputed?.categories)
    ? precomputed.categories.filter((category) => category && typeof category === 'object')
    : [];
  const pdfUrl = assetUrlFromPath(precomputed?.source?.copiedPath || 'source.pdf', document);

  return {
    document: {
      ...(precomputed?.document || {}),
      title: precomputed?.source?.title || precomputed?.document?.title || document.title,
      sourceType: 'pdf',
      parsedAt: `${precomputed?.generatedAt || precomputed?.updatedAt || document.slug}::presentation`,
      pdfUrl,
      presentationSlug: document.slug,
      presentationMatch: matchedBy
    },
    summary: precomputed?.summary || undefined,
    categories: categories.map((category) => normalizeCategory(category, document)),
    presentation: {
      mode: 'presentation',
      precomputed: true,
      slug: document.slug,
      title: document.title,
      matchedBy
    },
    sourceText: document.textCompact ? text : ''
  };
}
