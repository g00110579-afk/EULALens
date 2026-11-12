import express from 'express';
import path from 'node:path';
import { projectRoot } from './config.js';

// The review workspace and its upload API share an origin. Only the public
// application files and demo media are served from this checkout.
export function mountReviewSite(app) {
  const review = express.Router();
  app.get(/^\/review$/, (_req, res) => res.redirect(308, '/review/'));
  app.use('/review', review);
  review.use((_req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });
  review.get('/runtime-config.js', (_req, res) => res.type('js').send(
    "window.EULALENS_API_BASE = location.origin;\nwindow.EULALENS_PDFJS_BASE = new URL('./pdfjs/', document.baseURI).href;\n"
  ));

  const send = (root, file) => (_req, res) => res.sendFile(file, { root, cacheControl: false });
  review.get(['/', '/index.html'], send(projectRoot, 'index.html'));
  for (const file of ['ui.css', 'ui.js', 'live-runtime.js', 'category-gallery.js', 'comic-reader.js',
    'comic-playback.js', 'sample-narration.js', 'EULALens_SEE_What_YOU_Agree.pdf']) {
    review.get('/' + file, send(projectRoot, file));
  }
  const pdfjs = path.join(projectRoot, 'node_modules/pdfjs-dist/build');
  for (const file of ['pdf.min.mjs', 'pdf.worker.min.mjs']) review.get('/pdfjs/' + file, send(pdfjs, file));
  for (const dir of ['images', 'people', 'zoom', 'spotify', 'steam', 'windows11', 'adobe', 'deepfake', 'sample-audio']) {
    review.use('/' + dir, (req, res, next) =>
      /\.(?:pdf|png|jpe?g|webp|mp4|mp3)$/i.test(req.path) ? next() : res.sendStatus(404),
    express.static(path.join(projectRoot, dir), { dotfiles: 'deny', index: false, redirect: false, cacheControl: false }));
  }
}
