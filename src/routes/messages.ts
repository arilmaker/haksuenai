import { randomUUID } from 'node:crypto';
import { isBlockedEitherWay, requireMember, requireMessage } from '../access';
import { sql } from '../db';
import { emitToMembers } from '../events';
import { badRequest, conflict, created, forbidden, readJson } from '../http';
import { mapMessage } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';
import { deleteMediaByIds, parseMediaIds } from './media';

const KINDS = ['text', 'image', 'video', 'audio', 'document', 'sticker', 'poll', 'vote'] as const;
const EDIT_WINDOW_MS = 15 * 60 * 1000;

export function registerMessages(r: Router) {
  // Riwayat chat (paging: ?before=<createdAt ISO>&limit=40). Urut lama -> baru.
  r.add('GET', '/conversations/:id/messages', async ({ params, query, uid }) => {
    const cid = v.uuid(params.id, 'id');
    await requireMember(cid, uid);
    const limit = Math.min(Math.max(parseInt(query.get('limit') ?? '40', 10) || 40, 1), 100);
    const beforeRaw = query.get('before');
    let before: string | null = null;
    if (beforeRaw) {
      const d = new Date(beforeRaw);
      if (Number.isNaN(d.getTime())) throw badRequest('before tidak valid');
      before = d.toISOString();
    }
    const rows = await sql`
      select m.id, m.conversation_id, m.sender_id, m.kind, m.ciphertext, m.nonce, m.sender_key, m.reply_to,
        m.expires_at, m.edited_at, m.deleted_at, m.created_at, k.wrapped_key, k.wrap_nonce,
        exists (select 1 from message_stars s where s.message_id = m.id and s.user_id = ${uid}::uuid) as starred,
        (select count(*)::int from conversation_members x
           where x.conversation_id = m.conversation_id and x.user_id <> m.sender_id) as n_others,
        (select count(*)::int from message_receipts r where r.message_id = m.id and r.delivered_at is not null) as n_delivered,
        (select count(*)::int from message_receipts r where r.message_id = m.id and r.read_at is not null) as n_read,
        coalesce((select json_agg(json_build_object('userId', rx.user_id, 'emoji', rx.emoji))
                  from message_reactions rx where rx.message_id = m.id), '[]'::json) as reactions
      from messages m
      join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${uid}::uuid
      left join message_keys k on k.message_id = m.id and k.user_id = ${uid}::uuid
      where m.conversation_id = ${cid}::uuid and m.kind <> 'vote'
        and m.created_at >= cm.joined_at
        and m.created_at > coalesce(cm.cleared_at, 'epoch'::timestamptz)
        and (m.expires_at is null or m.expires_at > now())
        and not exists (select 1 from message_hidden h where h.message_id = m.id and h.user_id = ${uid}::uuid)
        and (${before}::timestamptz is null or m.created_at < ${before}::timestamptz)
      order by m.created_at desc
      limit ${limit}`;
    const messages = rows.map((row) => mapMessage(row, uid)).reverse();
    return { messages, hasMore: rows.length === limit };
  });

  // Kirim pesan E2EE. Klien mengirim ciphertext + kunci isi yang dibungkus untuk SETIAP anggota (termasuk dirinya).
  r.add('POST', '/conversations/:id/messages', async ({ req, params, uid }) => {
    const cid = v.uuid(params.id, 'id');
    const conv = await requireMember(cid, uid);
    const b = await readJson(req);

    const kind = v.oneOf(b.kind ?? 'text', 'kind', KINDS);
    const ciphertext = v.b64(b.ciphertext, 'ciphertext', 100_000);
    const nonce = v.b64(b.nonce, 'nonce', 64);
    const senderKey = v.b64(b.senderKey, 'senderKey', 64);
    const replyTo = b.replyTo === undefined || b.replyTo === null ? null : v.uuid(b.replyTo, 'replyTo');
    const keys = v.arr(b.keys, 'keys', 200).map((k) => {
      const o = v.obj(k, 'keys');
      return {
        userId: v.uuid(o.userId, 'keys.userId'),
        publicKey: v.b64(o.publicKey, 'keys.publicKey', 64),
        wrappedKey: v.b64(o.wrappedKey, 'keys.wrappedKey', 160),
        wrapNonce: v.b64(o.wrapNonce, 'keys.wrapNonce', 64),
      };
    });

    const members = await sql`
      select cm.user_id, u.public_key from conversation_members cm join users u on u.id = cm.user_id
      where cm.conversation_id = ${cid}::uuid`;
    const memberIds: string[] = members.map((m) => m.user_id);

    if (conv.kind === 'direct') {
      const peer = memberIds.find((id) => id !== uid);
      if (!peer) throw forbidden('Lawan bicara sudah tidak ada');
      if (await isBlockedEitherWay(uid, peer)) throw forbidden('Tidak bisa mengirim pesan ke pengguna ini');
    }
    if (members.some((m) => !m.public_key)) {
      throw conflict('Ada anggota yang belum siap menerima pesan terenkripsi', { code: 'member_no_key' });
    }

    // Kunci yang dipakai klien harus kunci terbaru. Kalau ada yang berganti (mis. login di HP baru), klien ulangi.
    const keyBy = new Map(keys.map((k) => [k.userId, k]));
    const me = members.find((m) => m.user_id === uid)!;
    const stale =
      senderKey !== me.public_key ||
      keys.length !== members.length ||
      members.some((m) => keyBy.get(m.user_id)?.publicKey !== m.public_key);
    if (stale) {
      throw conflict('Kunci enkripsi berubah, coba kirim ulang', {
        code: 'stale_keys',
        members: members.map((m) => ({ id: m.user_id, publicKey: m.public_key })),
      });
    }

    if (kind === 'vote' && !replyTo) throw badRequest('Suara harus menunjuk ke pesan polling (replyTo)');
    if (replyTo) {
      const [ok] = await sql`select kind, deleted_at from messages where id = ${replyTo}::uuid and conversation_id = ${cid}::uuid`;
      if (!ok) throw badRequest('Pesan yang dibalas tidak ditemukan');
      if (kind === 'vote' && (ok.kind !== 'poll' || ok.deleted_at)) throw badRequest('Pesan itu bukan polling yang aktif');
    }

    const id = randomUUID();
    const createdAt = new Date();
    const expiresAt = conv.ttl_seconds ? new Date(createdAt.getTime() + conv.ttl_seconds * 1000) : null;
    const nOthers = members.length - 1;

    const recipients = members.filter((m) => m.user_id !== uid);
    const rUids = recipients.map((m) => m.user_id as string);
    const rPayloads = recipients.map((m) => {
      const k = keyBy.get(m.user_id)!;
      return JSON.stringify({
        message: {
          id, conversationId: cid, senderId: uid, kind, ciphertext, nonce, senderKey,
          wrappedKey: k.wrappedKey, wrapNonce: k.wrapNonce, replyTo,
          expiresAt, editedAt: null, deleted: false, createdAt, starred: false, reactions: [],
          receipts: null, status: null,
        },
      });
    });

    const isVote = kind === 'vote';
    await sql.transaction([
      sql`insert into messages (id, conversation_id, sender_id, kind, ciphertext, nonce, sender_key, reply_to, expires_at, created_at)
          values (${id}::uuid, ${cid}::uuid, ${uid}::uuid, ${kind}, ${ciphertext}, ${nonce}, ${senderKey},
                  ${replyTo}::uuid, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz, ${createdAt.toISOString()}::timestamptz)`,
      sql`insert into message_keys (message_id, user_id, wrapped_key, wrap_nonce)
          select ${id}::uuid, x.u, x.w, x.n
          from unnest(${keys.map((k) => k.userId)}::uuid[], ${keys.map((k) => k.wrappedKey)}::text[],
                      ${keys.map((k) => k.wrapNonce)}::text[]) as x(u, w, n)`,
      // suara polling tidak menaikkan chat ke atas dan tidak memunculkan chat yang disembunyikan
      sql`update conversations set updated_at = now() where id = ${cid}::uuid and not ${isVote}::boolean`,
      sql`update conversation_members set hidden = false where conversation_id = ${cid}::uuid and hidden and not ${isVote}::boolean`,
      sql`insert into events (user_id, type, payload)
          select x.u, 'message.new', x.p::jsonb
          from unnest(${rUids}::uuid[], ${rPayloads}::text[]) as x(u, p)`,
    ]);

    return created({
      message: mapMessage({
        id, conversation_id: cid, sender_id: uid, kind, ciphertext, nonce, sender_key: senderKey,
        wrapped_key: keyBy.get(uid)!.wrappedKey, wrap_nonce: keyBy.get(uid)!.wrapNonce,
        reply_to: replyTo, expires_at: expiresAt, edited_at: null, deleted_at: null, created_at: createdAt,
        starred: false, reactions: [], n_others: nOthers, n_delivered: 0, n_read: 0,
      }, uid),
    });
  });

  // Edit pesan teks: pengirim saja, maksimal 15 menit. Isi diganti dengan kunci isi yang sama + nonce baru.
  r.add('PATCH', '/messages/:id', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const m = await requireMessage(id, uid);
    if (m.sender_id !== uid) throw forbidden('Hanya pengirim yang bisa mengedit');
    if (m.deleted_at) throw badRequest('Pesan sudah dihapus');
    if (m.kind !== 'text') throw badRequest('Hanya pesan teks yang bisa diedit');
    if (Date.now() - new Date(m.created_at).getTime() > EDIT_WINDOW_MS) throw badRequest('Batas edit 15 menit sudah lewat');

    const b = await readJson(req);
    const ciphertext = v.b64(b.ciphertext, 'ciphertext', 100_000);
    const nonce = v.b64(b.nonce, 'nonce', 64);
    const [row] = await sql`update messages set ciphertext = ${ciphertext}, nonce = ${nonce}, edited_at = now()
                            where id = ${id}::uuid returning edited_at`;
    await emitToMembers(m.conversation_id, uid, 'message.edit', {
      conversationId: m.conversation_id, messageId: id, ciphertext, nonce, editedAt: row.edited_at,
    });
    return { ok: true, editedAt: row.edited_at };
  });

  // Hapus: ?scope=me (untuk saya) | ?scope=all (untuk semua, pengirim saja). Opsional ?mediaId= untuk membuang fotonya.
  r.add('DELETE', '/messages/:id', async ({ params, query, uid }) => {
    const id = v.uuid(params.id, 'id');
    const scope = v.oneOf(query.get('scope') ?? 'me', 'scope', ['me', 'all'] as const);
    const m = await requireMessage(id, uid);

    if (scope === 'me') {
      await sql`insert into message_hidden (message_id, user_id) values (${id}::uuid, ${uid}::uuid) on conflict do nothing`;
      return { ok: true };
    }
    if (m.sender_id !== uid) throw forbidden('Hanya pengirim yang bisa menghapus untuk semua');
    await sql.transaction([
      sql`update messages set deleted_at = now(), ciphertext = '', nonce = '' where id = ${id}::uuid`,
      sql`delete from message_keys where message_id = ${id}::uuid`,
      sql`delete from message_reactions where message_id = ${id}::uuid`,
      sql`delete from message_stars where message_id = ${id}::uuid`,
      emitToMembers(m.conversation_id, uid, 'message.delete', { conversationId: m.conversation_id, messageId: id }),
    ]);
    await deleteMediaByIds(uid, parseMediaIds(query));
    return { ok: true };
  });

  // Reaksi emoji (kirim emoji: null untuk menghapus)
  r.add('POST', '/messages/:id/reaction', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const m = await requireMessage(id, uid);
    if (m.deleted_at) throw badRequest('Pesan sudah dihapus');
    const b = await readJson(req);
    if (b.emoji === null || b.emoji === undefined || b.emoji === '') {
      await sql`delete from message_reactions where message_id = ${id}::uuid and user_id = ${uid}::uuid`;
    } else {
      const emoji = v.emoji(b.emoji);
      await sql`insert into message_reactions (message_id, user_id, emoji)
                values (${id}::uuid, ${uid}::uuid, ${emoji})
                on conflict (message_id, user_id) do update set emoji = excluded.emoji`;
    }
    const reactions = (await sql`select user_id as "userId", emoji from message_reactions where message_id = ${id}::uuid`);
    await emitToMembers(m.conversation_id, uid, 'message.reaction', {
      conversationId: m.conversation_id, messageId: id, reactions,
    });
    return { reactions };
  });

  // Bintangi / batal bintangi
  r.add('POST', '/messages/:id/star', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMessage(id, uid);
    const starred = v.bool((await readJson(req)).starred, 'starred');
    if (starred) {
      await sql`insert into message_stars (message_id, user_id) values (${id}::uuid, ${uid}::uuid) on conflict do nothing`;
    } else {
      await sql`delete from message_stars where message_id = ${id}::uuid and user_id = ${uid}::uuid`;
    }
    return { ok: true, starred };
  });

  // Semua suara pada sebuah polling: suara TERBARU tiap orang (terenkripsi; klien yang menghitung)
  r.add('GET', '/messages/:id/votes', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const m = await requireMessage(id, uid);
    if (m.kind !== 'poll') throw badRequest('Bukan pesan polling');
    const rows = await sql`
      select distinct on (m.sender_id) m.id, m.conversation_id, m.sender_id, m.kind, m.ciphertext, m.nonce,
        m.sender_key, m.reply_to, m.expires_at, m.edited_at, m.deleted_at, m.created_at,
        k.wrapped_key, k.wrap_nonce, false as starred, 0 as n_others, 0 as n_delivered, 0 as n_read,
        '[]'::json as reactions
      from messages m
      join message_keys k on k.message_id = m.id and k.user_id = ${uid}::uuid
      where m.kind = 'vote' and m.reply_to = ${id}::uuid and m.deleted_at is null
      order by m.sender_id, m.created_at desc`;
    return { votes: rows.map((row) => mapMessage(row, uid)) };
  });

  // Daftar pesan berbintang saya
  r.add('GET', '/starred', async ({ uid }) => {
    const rows = await sql`
      select m.id, m.conversation_id, m.sender_id, m.kind, m.ciphertext, m.nonce, m.sender_key, m.reply_to,
        m.expires_at, m.edited_at, m.deleted_at, m.created_at, k.wrapped_key, k.wrap_nonce, true as starred,
        0 as n_others, 0 as n_delivered, 0 as n_read, '[]'::json as reactions
      from message_stars s
      join messages m on m.id = s.message_id
      join message_keys k on k.message_id = m.id and k.user_id = ${uid}::uuid
      where s.user_id = ${uid}::uuid and m.deleted_at is null
        and (m.expires_at is null or m.expires_at > now())
      order by m.created_at desc limit 100`;
    return { messages: rows.map((row) => mapMessage(row, uid)) };
  });
}

