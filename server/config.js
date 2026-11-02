import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(serverDir, '..');
const publicPrecomputedRoot = path.join(projectRoot, 'public/precomputed_data');
const distPrecomputedRoot = path.join(projectRoot, 'dist/precomputed_data');
const defaultPresentationPrecomputedRoot = fs.existsSync(publicPrecomputedRoot)
  ? publicPrecomputedRoot
  : distPrecomputedRoot;

function readBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function readPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export const port = Number(process.env.PORT || 5050);
export const host = process.env.HOST || '127.0.0.1';
export const maxAnalyzePayloadMb = readPositiveNumber(process.env.MAX_ANALYZE_PAYLOAD_MB, 25);
export const presentationPrecomputedRoot = path.resolve(
  projectRoot,
  process.env.PRESENTATION_PRECOMPUTED_ROOT || defaultPresentationPrecomputedRoot
);

export function isMockMode() {
  return readBoolean(process.env.MOCK_MODE, false);
}

export function isPresentationMode() {
  return readBoolean(process.env.PRESENTATION_MODE, false);
}
