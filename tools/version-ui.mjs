import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const html = new URL('index.html', root);
const source = readFileSync(html, 'utf8');
// runtime-config.js is supplied by the host. The other local scripts and CSS
// are shipped with this HTML and must have matching browser cache keys.
const updated = source.replace(/\b(src|href)="([\w-]+\.(?:js|css))(?:\?v=[a-f0-9]+)?"/g, (ref, attr, file) => {
  if (file === 'runtime-config.js') return ref;
  const bytes = readFileSync(new URL(file, root));
  const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `${attr}="${file}?v=${version}"`;
});
if (source !== updated) {
  if (process.argv.includes('--check')) throw new Error('Run node tools/version-ui.mjs to refresh the review asset URLs.');
  writeFileSync(html, updated);
}
