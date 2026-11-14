import { randomUUID } from 'node:crypto';
import { del, put } from '@vercel/blob';
import { sql } from '../db';
import { opt } from '../env';
import { HttpError, badRequest, created, readBody } from '../http';
import type { Router } from '../router';
import * as v from '../validate';

const MAX_CHUNK_BYTES = 4 * 1024 * 1024; // batas body Vercel Functions ~4,5 MB; file besar dikirim per potongan
const RETENTION_HOURS = { chat: 24 * 30, status: 25, channel: 24 * 180 } as const;

const quotaBytes = () => (parseInt(opt('MEDIA_QUOTA_MB', '300'), 10) || 300) * 1024 * 1024;

/** ?mediaIds=a,b,c (atau ?mediaId=a) -> daftar uuid valid (maks 20). */
export function parseMediaIds(query: URLSearchParams): string[] {
  const raw = [query.get('mediaIds'), query.get('mediaId')].filter(Boolean).join(',');
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => v.isUuid(s)))].slice(0, 20);
}

export async function deleteMediaByIds(uid: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const rows = await sql`delete from media_objects where id = any(${ids}::uuid[]) and owner_id = ${uid}::uuid returning url`;
  if (!rows.length) return;
  try { await del(rows.map((m) => m.url as string)); } catch (e) { console.error('[R1ZCHATID] gagal hapus blob', e); }
}
export const deleteMediaById = (uid: string, id: string) => deleteMediaByIds(uid, [id]);

export function registerMedia(r: Router) {
  /**
   * Unggah SATU potongan (maks 4 MB). File besar (video, dokumen, audio) dipotong di aplikasi lalu
   * tiap potongan diunggah sendiri. Untuk chat & status potongan sudah dienkripsi di HP; untuk
   * channel (publik) potongan berisi file asli.
   */
  r.add('POST', '/media', async ({ req, query, uid }) => {
    const purpose = v.oneOf(query.get('purpose') ?? 'chat', 'purpose', ['chat', 'status', 'channel'] as const);
    const buf = await readBody(req, MAX_CHUNK_BYTES);
    if (buf.length < 16) throw badRequest('File kosong');

    const [usage] = await sql`select coalesce(sum(size_bytes), 0)::bigint as total from media_objects where owner_id = ${uid}::uuid`;
    if (Number(usage?.total ?? 0) + buf.length > quotaBytes()) {
      throw new HttpError(413, 'Kuota penyimpanan media penuh. Hapus beberapa pesan/status berisi media dulu.');
    }

    const id = randomUUID();
    const blob = await put(`media/${uid}/${id}.bin`, buf, {
      access: 'public', // URL acak & tak bisa ditebak
      contentType: 'application/octet-stream',
      addRandomSuffix: true,
    });
    const hours = RETENTION_HOURS[purpose];
    await sql`insert into media_objects (id, owner_id, url, size_bytes, purpose, expires_at)
              values (${id}::uuid, ${uid}::uuid, ${blob.url}, ${buf.length}, ${purpose},
                      now() + (${hours}::int * interval '1 hour'))`;
    return created({ id, url: blob.url, expiresInHours: hours });
  });

  r.add('DELETE', '/media/:id', async ({ params, uid }) => {
    await deleteMediaByIds(uid, [v.uuid(params.id, 'id')]);
    return { ok: true };
  });

  r.add('GET', '/media/usage', async ({ uid }) => {
    const [u] = await sql`select coalesce(sum(size_bytes), 0)::bigint as total, count(*)::int as files
                          from media_objects where owner_id = ${uid}::uuid`;
    return { usedBytes: Number(u?.total ?? 0), files: u?.files ?? 0, quotaBytes: quotaBytes() };
  });
}
