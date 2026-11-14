import { del } from '@vercel/blob';
import { sql } from '../db';
import { salinPageHtml } from '../mail';
import { HttpError, html } from '../http';
import type { Router } from '../router';
import { opt } from '../env';

export function registerMisc(r: Router) {
  r.add('GET', '/health', async () => {
    await sql`select 1`;
    return { ok: true, app: 'R1ZCHATID', time: new Date().toISOString() };
  }, { public: true });

  // Halaman tombol "Salin Kode" dari email OTP
  r.add('GET', '/salin', async ({ query }) => html(salinPageHtml(query.get('kode') ?? '')), { public: true });

  // Dipanggil Vercel Cron tiap hari (header Authorization: Bearer CRON_SECRET)
  r.add('GET', '/cron/purge', async ({ req }) => {
    const secret = opt('CRON_SECRET');
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) throw new HttpError(401, 'Tidak diizinkan');

    const expiredMedia = await sql`select id, url from media_objects where expires_at < now() limit 500`;
    if (expiredMedia.length) {
      try { await del(expiredMedia.map((m) => m.url as string)); } catch (e) { console.error('purge blob', e); }
      await sql`delete from media_objects where id = any(${expiredMedia.map((m) => m.id)}::uuid[])`;
    }
    const [msg, st, ev, otp, calls, posts] = await sql.transaction([
      sql`with d as (delete from messages where expires_at is not null and expires_at < now() returning 1) select count(*)::int as n from d`,
      sql`with d as (delete from statuses where expires_at < now() returning 1) select count(*)::int as n from d`,
      sql`with d as (delete from events where expires_at < now() returning 1) select count(*)::int as n from d`,
      sql`with d as (delete from otp_codes where expires_at < now() - interval '1 day' returning 1) select count(*)::int as n from d`,
      sql`with d as (update calls set status = 'missed' where status = 'ringing' and created_at < now() - interval '2 minutes' returning 1) select count(*)::int as n from d`,
      sql`with d as (delete from channel_posts where expires_at < now() returning 1) select count(*)::int as n from d`,
    ]);
    return {
      ok: true,
      purged: {
        media: expiredMedia.length, messages: msg[0]?.n ?? 0, statuses: st[0]?.n ?? 0,
        events: ev[0]?.n ?? 0, otp: otp[0]?.n ?? 0, callsMarkedMissed: calls[0]?.n ?? 0, channelPosts: posts[0]?.n ?? 0,
      },
    };
  }, { public: true });
}
