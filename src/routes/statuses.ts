import { randomUUID } from 'node:crypto';
import { sql } from '../db';
import { emitToUsers } from '../events';
import { badRequest, conflict, created, forbidden, notFound, readJson } from '../http';
import { publicUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';
import { deleteMediaByIds, parseMediaIds } from './media';

/** Kontak = orang yang satu chat pribadi dengan saya & tidak saling blokir. Merekalah yang boleh melihat status saya. */
async function audience(uid: string) {
  return sql`
    select u.id, u.public_key
    from conversation_members a
    join conversations c on c.id = a.conversation_id and c.kind = 'direct'
    join conversation_members b on b.conversation_id = a.conversation_id and b.user_id <> a.user_id
    join users u on u.id = b.user_id
    where a.user_id = ${uid}::uuid and u.public_key is not null
      and not exists (select 1 from blocks x
        where (x.blocker_id = ${uid}::uuid and x.blocked_id = u.id)
           or (x.blocker_id = u.id and x.blocked_id = ${uid}::uuid))`;
}

export function registerStatuses(r: Router) {
  // Siapa saja yang akan bisa melihat status saya (dan public key mereka, untuk enkripsi di HP)
  r.add('GET', '/statuses/audience', async ({ uid }) => {
    const rows = await audience(uid);
    return { contacts: rows.map((x) => ({ id: x.id, publicKey: x.public_key })) };
  });

  // Feed status 24 jam: milik saya + milik kontak (hanya yang kuncinya dibungkus untuk saya)
  r.add('GET', '/statuses', async ({ uid }) => {
    const rows = await sql`
      select s.id, s.user_id, s.ciphertext, s.nonce, s.sender_key, s.created_at, s.expires_at,
             k.wrapped_key, k.wrap_nonce,
             u.username, u.display_name, u.about, u.avatar_emoji, u.avatar_color, u.public_key,
             exists (select 1 from status_views w where w.status_id = s.id and w.viewer_id = ${uid}::uuid) as viewed,
             (select count(*)::int from status_views w where w.status_id = s.id) as view_count
      from statuses s
      join users u on u.id = s.user_id
      join status_keys k on k.status_id = s.id and k.user_id = ${uid}::uuid
      where s.expires_at > now()
        and not exists (select 1 from blocks x
          where (x.blocker_id = ${uid}::uuid and x.blocked_id = s.user_id)
             or (x.blocker_id = s.user_id and x.blocked_id = ${uid}::uuid))
      order by s.created_at asc`;
    return {
      statuses: rows.map((s) => ({
        id: s.id,
        userId: s.user_id,
        user: publicUser({ ...s, id: s.user_id }),
        ciphertext: s.ciphertext,
        nonce: s.nonce,
        senderKey: s.sender_key,
        wrappedKey: s.wrapped_key,
        wrapNonce: s.wrap_nonce,
        createdAt: s.created_at,
        expiresAt: s.expires_at,
        viewed: s.user_id === uid ? true : s.viewed,
        viewCount: s.user_id === uid ? s.view_count : null,
        mine: s.user_id === uid,
      })),
    };
  });

  // Posting status. keys = kunci isi untuk saya + kontak yang dipilih (boleh sebagian dari audience).
  r.add('POST', '/statuses', async ({ req, uid }) => {
    const b = await readJson(req);
    const ciphertext = v.b64(b.ciphertext, 'ciphertext', 100_000);
    const nonce = v.b64(b.nonce, 'nonce', 64);
    const senderKey = v.b64(b.senderKey, 'senderKey', 64);
    const keys = v.arr(b.keys, 'keys', 500).map((k) => {
      const o = v.obj(k, 'keys');
      return {
        userId: v.uuid(o.userId, 'keys.userId'),
        publicKey: v.b64(o.publicKey, 'keys.publicKey', 64),
        wrappedKey: v.b64(o.wrappedKey, 'keys.wrappedKey', 160),
        wrapNonce: v.b64(o.wrapNonce, 'keys.wrapNonce', 64),
      };
    });

    const [me] = await sql`select public_key from users where id = ${uid}::uuid`;
    const allowed = new Map<string, string>((await audience(uid)).map((x) => [x.id as string, x.public_key as string]));
    allowed.set(uid, me.public_key);
    if (!me.public_key || senderKey !== me.public_key) {
      throw conflict('Kunci enkripsi berubah, coba lagi', { code: 'stale_keys' });
    }
    if (!keys.some((k) => k.userId === uid)) throw badRequest('keys harus berisi kunci untuk dirimu sendiri');
    for (const k of keys) {
      if (!allowed.has(k.userId)) throw forbidden('Ada penerima yang bukan kontakmu');
      if (allowed.get(k.userId) !== k.publicKey) {
        throw conflict('Kunci enkripsi kontak berubah, coba lagi', {
          code: 'stale_keys',
          contacts: [...allowed].map(([id, publicKey]) => ({ id, publicKey })),
        });
      }
    }

    const id = randomUUID();
    const others = keys.map((k) => k.userId).filter((x) => x !== uid);
    const [, , , st] = await sql.transaction([
      sql`insert into statuses (id, user_id, ciphertext, nonce, sender_key)
          values (${id}::uuid, ${uid}::uuid, ${ciphertext}, ${nonce}, ${senderKey})`,
      sql`insert into status_keys (status_id, user_id, wrapped_key, wrap_nonce)
          select ${id}::uuid, x.u, x.w, x.n
          from unnest(${keys.map((k) => k.userId)}::uuid[], ${keys.map((k) => k.wrappedKey)}::text[],
                      ${keys.map((k) => k.wrapNonce)}::text[]) as x(u, w, n)`,
      emitToUsers(others, 'status.new', { statusId: id, userId: uid }),
      sql`select created_at, expires_at from statuses where id = ${id}::uuid`,
    ]);
    return created({ id, createdAt: st[0].created_at, expiresAt: st[0].expires_at });
  });

  // Tandai dilihat
  r.add('POST', '/statuses/:id/view', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const [ok] = await sql`
      select s.user_id from statuses s join status_keys k on k.status_id = s.id and k.user_id = ${uid}::uuid
      where s.id = ${id}::uuid and s.expires_at > now()`;
    if (!ok) throw notFound('Status tidak ditemukan');
    if (ok.user_id !== uid) {
      await sql`insert into status_views (status_id, viewer_id) values (${id}::uuid, ${uid}::uuid) on conflict do nothing`;
    }
    return { ok: true };
  });

  // Siapa yang melihat status saya
  r.add('GET', '/statuses/:id/views', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const [s] = await sql`select user_id from statuses where id = ${id}::uuid`;
    if (!s) throw notFound('Status tidak ditemukan');
    if (s.user_id !== uid) throw forbidden('Hanya pemilik status yang bisa melihat daftar penonton');
    const rows = await sql`
      select u.id, u.username, u.display_name, u.about, u.avatar_emoji, u.avatar_color, u.public_key, w.viewed_at
      from status_views w join users u on u.id = w.viewer_id
      where w.status_id = ${id}::uuid order by w.viewed_at desc`;
    return { views: rows.map((x) => ({ user: publicUser(x), viewedAt: x.viewed_at })) };
  });

  r.add('DELETE', '/statuses/:id', async ({ params, query, uid }) => {
    const id = v.uuid(params.id, 'id');
    const done = await sql`delete from statuses where id = ${id}::uuid and user_id = ${uid}::uuid returning id`;
    if (!done.length) throw notFound('Status tidak ditemukan');
    await deleteMediaByIds(uid, parseMediaIds(query));
    return { ok: true };
  });
}
