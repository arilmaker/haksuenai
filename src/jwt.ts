import { createHmac, timingSafeEqual } from 'node:crypto';

const enc = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signJwt(sub: string, secret: string, ttlSec = 30 * 24 * 3600, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const head = enc(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = enc(JSON.stringify({ sub, iat, exp: iat + ttlSec }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  return `${head}.${body}.${enc(sig)}`;
}

/** Mengembalikan user id (sub) jika token sah, selain itu null. */
export function verifyJwt(token: string, secret: string, nowMs = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  try {
    const h = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    if (h?.alg !== 'HS256') return null; // tolak alg=none dan algoritma lain
    const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof p?.sub !== 'string' || typeof p?.exp !== 'number') return null;
    if (p.exp * 1000 <= nowMs) return null;
    return p.sub;
  } catch {
    return null;
  }
}
