import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './http.js';

const equal = (a, b) => { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); };
export function createSecurity({ directory, origins = [], sessionMs = 7 * 86400000, secret, accessToken = '', sessionLimit = 30, writeLimit = 120 } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, 'session.key');
  if (!secret) {
    try { fs.writeFileSync(keyPath, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    secret = fs.readFileSync(keyPath, 'utf8').trim();
  }
  if (secret.length < 32) throw new Error('Session signing key must contain at least 32 characters.');
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const buckets = new Map();
  function consume(key, limit, windowMs = 600000) {
    const now = Date.now();
    for (const [id, bucket] of buckets) if (bucket.until <= now) buckets.delete(id);
    if (!buckets.has(key)) {
      if (buckets.size >= 10000) throw httpError(503, 'Server is busy. Try again shortly.');
      buckets.set(key, { count: 0, until: now + windowMs });
    }
    const entry = buckets.get(key);
    if (++entry.count > limit) throw httpError(429, 'Request limit reached. Please wait before trying again.');
  }
  function checkOrigin(req) {
    const origin = req.get('origin');
    if (!origin) return;
    let sameOrigin = false;
    try { sameOrigin = new URL(origin).host === req.get('host'); } catch {}
    if (!sameOrigin && !origins.includes(origin)) throw httpError(403, 'This origin is not allowed.');
  }
  function unpack(token) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const [payload, signature, extra] = token.split('.');
    if (extra || !signature || !equal(sign(`session:${payload}`), signature)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url'));
      return typeof session.id === 'string' && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() ? session : null;
    } catch { return null; }
  }
  function read(req) {
    const bearer = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    const cookie = req.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('eulalens_session='))?.slice(17);
    return unpack(bearer || cookie);
  }
  function csrf(session) { return sign(`csrf:${session.id}`); }
  function bootstrap(req, res) {
    checkOrigin(req);
    let session = read(req);
    if (!session) {
      consume(`sessions:${req.ip}`, sessionLimit);
      if (accessToken && !equal(req.get('x-access-token') || '', accessToken)) throw httpError(401, 'An access token is required.');
      session = { id: randomUUID(), expiresAt: Date.now() + sessionMs };
    }
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const token = `${payload}.${sign(`session:${payload}`)}`;
    const secure = req.secure;
    res.set('Set-Cookie', `eulalens_session=${token}; Path=/; HttpOnly; Max-Age=${Math.floor((session.expiresAt - Date.now()) / 1000)}; SameSite=${secure ? 'None; Secure; Partitioned' : 'Lax'}`);
    res.set('Cache-Control', 'no-store');
    res.json({ csrfToken: csrf(session), sessionToken: token, expiresAt: session.expiresAt });
  }
  function authenticate(req, _res, next) {
    try {
      checkOrigin(req); const session = read(req);
      if (!session) throw httpError(401, 'Session expired. Reconnect to continue.');
      req.owner = session.id;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (!equal(req.get('x-csrf-token') || '', csrf(session))) throw httpError(403, 'Invalid request token.');
        if (req.path.endsWith('/cancel')) consume(`cancels:${session.id}`, 2000);
        else { consume(`writes:owner:${session.id}`, writeLimit); consume(`writes:ip:${req.ip}`, writeLimit * 2); }
      }
      next();
    } catch (error) { next(error); }
  }
  function assetUrl(job, assetId) {
    const expiresAt = job.createdAt + 86400000;
    const token = `${expiresAt}.${sign(`asset:${job.jobId}:${assetId}:${job.owner}:${expiresAt}`)}`;
    return `/api/assets/${encodeURIComponent(job.jobId)}/${encodeURIComponent(assetId)}?token=${encodeURIComponent(token)}`;
  }
  function ownsAsset(req, job, assetId) {
    const session = read(req); if (session?.id === job.owner) return true;
    const [expires, signature, extra] = String(req.query.token || '').split('.');
    return !extra && Number(expires) > Date.now() && Number(expires) <= job.createdAt + 86400000
      && equal(signature || '', sign(`asset:${job.jobId}:${assetId}:${job.owner}:${expires}`));
  }
  return { checkOrigin, bootstrap, authenticate, assetUrl, ownsAsset };
}
