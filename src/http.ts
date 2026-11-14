import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const badRequest = (m: string, extra?: Record<string, unknown>) => new HttpError(400, m, extra);
export const unauthorized = () => new HttpError(401, 'Sesi tidak valid. Silakan masuk lagi.');
export const forbidden = (m = 'Tidak diizinkan') => new HttpError(403, m);
export const notFound = (m = 'Tidak ditemukan') => new HttpError(404, m);
export const conflict = (m: string, extra?: Record<string, unknown>) => new HttpError(409, m, extra);

/** Balasan khusus (status selain 200 atau body bukan JSON). */
export class Reply {
  constructor(
    public status: number,
    public body: unknown,
    public headers: Record<string, string> = {},
    public raw = false,
  ) {}
}
export const created = (body: unknown) => new Reply(201, body);
export const html = (body: string, status = 200) =>
  new Reply(status, body, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  }, true);

export function applyCors(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

export function sendReply(res: ServerResponse, reply: Reply) {
  for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
  res.statusCode = reply.status;
  if (reply.raw) {
    res.end(String(reply.body));
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(reply.body));
}

export function sendError(res: ServerResponse, err: unknown) {
  if (err instanceof HttpError) {
    return sendReply(res, new Reply(err.status, { error: err.message, ...err.extra }));
  }
  console.error('[R1ZCHATID] error tak terduga:', err);
  return sendReply(res, new Reply(500, { error: 'Terjadi kesalahan di server' }));
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += b.length;
    if (size > limit) throw new HttpError(413, 'Data terlalu besar');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('bukan objek');
    return v as Record<string, unknown>;
  } catch {
    throw badRequest('JSON tidak valid');
  }
}
