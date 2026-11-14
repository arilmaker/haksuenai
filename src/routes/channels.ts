import { sql } from '../db';
import type { Row } from '../db';
import { HttpError, badRequest, conflict, created, forbidden, notFound, readJson } from '../http';
import type { Router } from '../router';
import * as v from '../validate';

const POST_KINDS = ['text', 'image', 'video', 'audio', 'document'] as const;
const MAX_CHANNELS_PER_USER = 5;
const HANDLE_RE = /^[a-z0-9_]{3,30}$/;

function channelOut(c: Row, uid: string) {
  return {
    id: c.id,
    ownerId: c.owner_id,
    name: c.name,
    handle: c.handle,
    description: c.description,
    iconEmoji: c.icon_emoji,
    iconColor: c.icon_color,
    createdAt: c.created_at,
    followerCount: Number(c.follower_count ?? 0),
    isFollowing: !!c.is_following,
    isOwner: c.owner_id === uid,
    unread: Number(c.unread ?? 0),
    lastPost: c.lp_id
      ? { id: c.lp_id, kind: c.lp_kind, body: String(c.lp_body ?? '').slice(0, 80), createdAt: c.lp_created_at }
      : null,
  };
}

/** Satu query dasar untuk semua daftar channel. `scope`: mine | following | search | one */
async function listChannels(uid: string, scope: 'mine' | 'following' | 'search' | 'one', arg: string | null) {
  const rows = await sql`
    select c.*,
      (select count(*)::int from channel_follows f where f.channel_id = c.id) as follower_count,
      exists (select 1 from channel_follows f where f.channel_id = c.id and f.user_id = ${uid}::uuid) as is_following,
      (select count(*)::int from channel_posts p
         where p.channel_id = c.id and p.expires_at > now()
           and p.created_at > coalesce((select f.last_read_at from channel_follows f
                                        where f.channel_id = c.id and f.user_id = ${uid}::uuid), now())) as unread,
      lp.id as lp_id, lp.kind as lp_kind, lp.body as lp_body, lp.created_at as lp_created_at
    from channels c
    left join lateral (
      select p.id, p.kind, p.body, p.created_at from channel_posts p
      where p.channel_id = c.id and p.expires_at > now() order by p.created_at desc limit 1
    ) lp on true
    where (${scope} = 'mine' and c.owner_id = ${uid}::uuid)
       or (${scope} = 'following' and exists (select 1 from channel_follows f where f.channel_id = c.id and f.user_id = ${uid}::uuid))
       or (${scope} = 'search' and (position(lower(${arg}::text) in lower(c.name)) > 0 or starts_with(coalesce(c.handle, ''), ${arg}::text)))
       or (${scope} = 'one' and c.id = ${arg}::uuid)
    order by lp.created_at desc nulls last, c.created_at desc
    limit 50`;
  return rows.map((c) => channelOut(c, uid));
}

async function requireOwner(channelId: string, uid: string): Promise<Row> {
  const [c] = await sql`select id, owner_id from channels where id = ${channelId}::uuid`;
  if (!c) throw notFound('Channel tidak ditemukan');
  if (c.owner_id !== uid) throw forbidden('Hanya pemilik channel yang boleh');
  return c;
}

function validMedia(x: unknown): Record<string, unknown> {
  const m = v.obj(x, 'media');
  const urls = v.arr(m.urls, 'media.urls', 10).map((u) => {
    const s = v.str(u, 'media.urls', 10, 600);
    if (!s.startsWith('https://')) throw badRequest('URL media harus https');
    return s;
  });
  if (!urls.length) throw badRequest('media.urls kosong');
  return {
    urls,
    size: v.int(m.size ?? 0, 'media.size', 0, 200_000_000),
    mime: v.optStr(m.mime, 'media.mime', 100) ?? 'application/octet-stream',
    name: v.optStr(m.name, 'media.name', 200) ?? '',
    durationMs: m.durationMs === undefined ? null : v.int(m.durationMs, 'media.durationMs', 0, 86_400_000),
    ids: v.arr(m.ids ?? [], 'media.ids', 10).map((i) => v.uuid(i, 'media.ids')),
  };
}

export function registerChannels(r: Router) {
  r.add('GET', '/channels/mine', async ({ uid }) => ({ channels: await listChannels(uid, 'mine', null) }));
  r.add('GET', '/channels/following', async ({ uid }) => ({ channels: await listChannels(uid, 'following', null) }));
  r.add('GET', '/channels/search', async ({ query, uid }) => {
    const q = (query.get('q') ?? '').toLowerCase().replace(/^@/, '').trim().slice(0, 40);
    if (q.length < 2) return { channels: [] };
    return { channels: await listChannels(uid, 'search', q) };
  });

  r.add('POST', '/channels', async ({ req, uid }) => {
    const b = await readJson(req);
    const name = v.str(b.name, 'Nama channel', 2, 40);
    const description = v.optStr(b.description, 'Deskripsi', 200) ?? '';
    const iconEmoji = b.iconEmoji === undefined ? '📢' : v.emoji(b.iconEmoji);
    const iconColor = b.iconColor === undefined ? '#FF6B6B' : v.color(b.iconColor);
    let handle: string | null = null;
    if (b.handle !== undefined && b.handle !== null && b.handle !== '') {
      handle = v.str(b.handle, 'Handle', 3, 31).toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) throw badRequest('Handle 3-30 karakter: a-z, 0-9, _');
    }
    const [{ n }] = await sql`select count(*)::int as n from channels where owner_id = ${uid}::uuid`;
    if (n >= MAX_CHANNELS_PER_USER) throw badRequest(`Maksimal ${MAX_CHANNELS_PER_USER} channel per akun`);
    try {
      const [c] = await sql`
        insert into channels (owner_id, name, handle, description, icon_emoji, icon_color)
        values (${uid}::uuid, ${name}, ${handle}, ${description}, ${iconEmoji}, ${iconColor}) returning id`;
      const [channel] = await listChannels(uid, 'one', c.id);
      return created({ channel });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('Handle channel sudah dipakai');
      throw e;
    }
  });

  r.add('GET', '/channels/:id', async ({ params, uid }) => {
    const [channel] = await listChannels(uid, 'one', v.uuid(params.id, 'id'));
    if (!channel) throw notFound('Channel tidak ditemukan');
    return { channel };
  });

  r.add('PATCH', '/channels/:id', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireOwner(id, uid);
    const b = await readJson(req);
    const name = b.name === undefined ? null : v.str(b.name, 'Nama channel', 2, 40);
    const description = b.description === undefined ? null : v.str(b.description, 'Deskripsi', 0, 200);
    const iconEmoji = b.iconEmoji === undefined ? null : v.emoji(b.iconEmoji);
    const iconColor = b.iconColor === undefined ? null : v.color(b.iconColor);
    let handle: string | null = null;
    if (b.handle !== undefined && b.handle !== null && b.handle !== '') {
      handle = v.str(b.handle, 'Handle', 3, 31).toLowerCase().replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) throw badRequest('Handle 3-30 karakter: a-z, 0-9, _');
    }
    try {
      await sql`update channels set name = coalesce(${name}::text, name),
                  description = coalesce(${description}::text, description),
                  icon_emoji = coalesce(${iconEmoji}::text, icon_emoji),
                  icon_color = coalesce(${iconColor}::text, icon_color),
                  handle = coalesce(${handle}::text, handle)
                where id = ${id}::uuid`;
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('Handle channel sudah dipakai');
      throw e;
    }
    const [channel] = await listChannels(uid, 'one', id);
    return { channel };
  });

  r.add('DELETE', '/channels/:id', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireOwner(id, uid);
    await sql`delete from channels where id = ${id}::uuid`;
    return { ok: true };
  });

  r.add('POST', '/channels/:id/follow', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const [c] = await sql`select owner_id from channels where id = ${id}::uuid`;
    if (!c) throw notFound('Channel tidak ditemukan');
    if (c.owner_id === uid) throw badRequest('Kamu pemilik channel ini');
    await sql`insert into channel_follows (channel_id, user_id) values (${id}::uuid, ${uid}::uuid) on conflict do nothing`;
    return { ok: true, following: true };
  });

  r.add('DELETE', '/channels/:id/follow', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await sql`delete from channel_follows where channel_id = ${id}::uuid and user_id = ${uid}::uuid`;
    return { ok: true, following: false };
  });

  r.add('POST', '/channels/:id/read', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await sql`update channel_follows set last_read_at = now() where channel_id = ${id}::uuid and user_id = ${uid}::uuid`;
    return { ok: true };
  });

  r.add('GET', '/channels/:id/posts', async ({ params, query, uid }) => {
    const id = v.uuid(params.id, 'id');
    const [c] = await sql`select 1 as x from channels where id = ${id}::uuid`;
    if (!c) throw notFound('Channel tidak ditemukan');
    const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '30', 10) || 30, 1), 100);
    const beforeRaw = query.get('before');
    let before: string | null = null;
    if (beforeRaw) {
      const d = new Date(beforeRaw);
      if (Number.isNaN(d.getTime())) throw badRequest('before tidak valid');
      before = d.toISOString();
    }
    const rows = await sql`
      select p.id, p.channel_id, p.kind, p.body, p.media, p.created_at,
        coalesce((select json_agg(x) from (
          select emoji, count(*)::int as count from channel_post_reactions r
          where r.post_id = p.id group by emoji order by count desc) x), '[]'::json) as reactions,
        (select emoji from channel_post_reactions r where r.post_id = p.id and r.user_id = ${uid}::uuid) as my_reaction
      from channel_posts p
      where p.channel_id = ${id}::uuid and p.expires_at > now()
        and (${before}::timestamptz is null or p.created_at < ${before}::timestamptz)
      order by p.created_at desc limit ${limit}`;
    return {
      posts: rows.reverse().map((p) => ({
        id: p.id, channelId: p.channel_id, kind: p.kind, body: p.body, media: p.media,
        createdAt: p.created_at, reactions: p.reactions ?? [], myReaction: p.my_reaction ?? null,
      })),
      hasMore: rows.length === limit,
    };
  });

  r.add('POST', '/channels/:id/posts', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireOwner(id, uid);
    const b = await readJson(req);
    const kind = v.oneOf(b.kind, 'kind', POST_KINDS);
    const body = v.optStr(b.body, 'Isi', 2000) ?? '';
    let media: Record<string, unknown> | null = null;
    if (kind === 'text') {
      if (!body) throw badRequest('Isi postingan kosong');
    } else {
      media = validMedia(b.media);
    }
    const [p] = await sql`
      insert into channel_posts (channel_id, author_id, kind, body, media)
      values (${id}::uuid, ${uid}::uuid, ${kind}, ${body}, ${media ? JSON.stringify(media) : null}::jsonb)
      returning id, created_at`;
    return created({ id: p.id, createdAt: p.created_at });
  });

  r.add('DELETE', '/channels/:id/posts/:postId', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireOwner(id, uid);
    const done = await sql`delete from channel_posts where id = ${v.uuid(params.postId, 'postId')}::uuid
                           and channel_id = ${id}::uuid returning id`;
    if (!done.length) throw new HttpError(404, 'Postingan tidak ditemukan');
    return { ok: true };
  });

  r.add('POST', '/channels/:id/posts/:postId/reaction', async ({ req, params, uid }) => {
    const postId = v.uuid(params.postId, 'postId');
    const [p] = await sql`select 1 as x from channel_posts where id = ${postId}::uuid and channel_id = ${v.uuid(params.id, 'id')}::uuid`;
    if (!p) throw notFound('Postingan tidak ditemukan');
    const b = await readJson(req);
    if (b.emoji === null || b.emoji === undefined || b.emoji === '') {
      await sql`delete from channel_post_reactions where post_id = ${postId}::uuid and user_id = ${uid}::uuid`;
    } else {
      await sql`insert into channel_post_reactions (post_id, user_id, emoji)
                values (${postId}::uuid, ${uid}::uuid, ${v.emoji(b.emoji)})
                on conflict (post_id, user_id) do update set emoji = excluded.emoji`;
    }
    return { ok: true };
  });
}
