import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

export const makeCode = (): string => String(randomInt(100000, 1000000));

export function hashCode(email: string, code: string, secret: string): string {
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');
}

export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
