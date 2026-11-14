import './setup';
import { Readable } from 'node:stream';
import { app } from '../src/app';
import { signJwt } from '../src/jwt';
import { fake } from './setup';

export const UID = '11111111-1111-4111-8111-111111111111';
export const UID2 = '22222222-2222-4222-8222-222222222222';
export const CID = '33333333-3333-4333-8333-333333333333';
export const token = (uid = UID) => signJwt(uid, process.env.JWT_SECRET!);

export interface Res { status: number; body: any; text: string; headers: Record<string, string> }

export async function call(method: string, path: string, opts: { body?: unknown; uid?: string | null; raw?: Buffer; headers?: Record<string, string> } = {}): Promise<Res> {
  const payload = opts.raw ?? (opts.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(opts.body)));
  const req: any = Readable.from(payload.length ? [payload] : []);
  req.method = method;
  req.url = path;
  req.headers = { ...(opts.headers ?? {}) };
  if (opts.uid !== null && opts.uid !== undefined) req.headers.authorization = `Bearer ${token(opts.uid)}`;

  const headers: Record<string, string> = {};
  let text = '';
  const res: any = {
    statusCode: 200,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = String(v); },
    end: (s?: string) => { text = s ?? ''; },
  };
  await app(req, res);
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* bukan JSON (mis. HTML) */ }
  return { status: res.statusCode, body, text, headers };
}

/** Anggap token milik `uid` valid & akunnya ada. */
export function loginAs(uid = UID) {
  fake.on(/from users where id = \$1::uuid/, () => [{ id: uid, stale: false }]);
}
