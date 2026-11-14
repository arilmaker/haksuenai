import { randomUUID } from 'node:crypto';
import { requireMember, isBlockedEitherWay } from '../access';
import { sql } from '../db';
import type { Row } from '../db';
import { emitToMembers, emitToUsers } from '../events';
import { badRequest, conflict, created, forbidden, notFound, readJson } from '../http';
import { publicUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';

const TTL_OPTIONS = [86400, 604800, 7776000]; // 24 jam, 7 hari, 90 hari (null = mati)

/** Daftar chat saya (atau satu chat jika onlyId diisi), lengkap dengan anggota & pesan terakhir. */
export async function loadConversations(uid: string, onlyId: string | null = null) {
  const rows = await sql`
    select c.id, c.kind, c.title, c.icon_emoji, c.icon_color, c.ttl_seconds, c.created_at, c.updated_at,
      cm.role, cm.pinned, cm.archived, cm.muted,
      (select count(*)::int from messages m
         where m.conversation_id = c.id and m.sender_id <> ${uid}::uuid and m.deleted_at is null and m.kind <> 'vote'
           and (m.expires_at is null or m.expires_at > now())
           and m.created_at >= cm.joined_at
           and m.created_at > greatest(coalesce(cm.last_read_at, 'epoch'::timestamptz),
                                       coalesce(cm.cleared_at, 'epoch'::timestamptz))
           and not exists (select 1 from message_hidden h where h.message_id = m.id and h.user_id = ${uid}::uuid)
      ) as unread,
      lm.id as lm_id, lm.sender_id as lm_sender_id, lm.kind as lm_kind, lm.ciphertext as lm_ciphertext,
      lm.nonce as lm_nonce, lm.sender_key as lm_sender_key, lm.created_at as lm_created_at,
      lm.deleted_at as lm_deleted_at, lm.wrapped_key as lm_wrapped_key, lm.wrap_nonce as lm_wrap_nonce
    from conversation_members cm
    join conversations c on c.id = cm.conversation_id
    left join lateral (
      select m.id, m.sender_id, m.kind, m.ciphertext, m.nonce, m.sender_key, m.created_at, m.deleted_at,
             k.wrapped_key, k.wrap_nonce
      from messages m
      left join message_keys k on k.message_id = m.id and k.user_id = ${uid}::uuid
      where m.conversation_id = c.id and m.kind <> 'vote'
        and m.created_at >= cm.joined_at
        and m.created_at > coalesce(cm.cleared_at, 'epoch'::timestamptz)
        and (m.expires_at is null or m.expires_at > now())
        and not exists (select 1 from message_hidden h where h.message_id = m.id and h.user_id = ${uid}::uuid)
      order by m.created_at desc
      limit 1
    ) lm on true
    where cm.user_id = ${uid}::uuid
      and (cm.hidden = false or ${onlyId}::uuid is not null)
      and (${onlyId}::uuid is null or c.id = ${onlyId}::uuid)
    order by cm.pinned desc, c.updated_at desc`;

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [members, blockRows] = await sql.transaction([
    sql`select cm.conversation_id, cm.role, u.id, u.username, u.display_name, u.about, u.avatar_emoji,
               u.avatar_color, u.public_key,
               (u.last_seen_at > now() - interval '40 seconds') as online,
               case when u.show_last_seen then u.last_seen_at else null end as last_seen_at
        from conversation_members cm join users u on u.id = cm.user_id
        where cm.conversation_id = any(${ids}::uuid[])
        order by cm.joined_at`,
    sql`select blocker_id, blocked_id from blocks
        where blocker_id = ${uid}::uuid or blocked_id = ${uid}::uuid`,
  ]);

  const byMe = new Set<string>();
  const me = new Set<string>();
  for (const b of blockRows) {
    if (b.blocker_id === uid) byMe.add(b.blocked_id);
    else me.add(b.blocker_id);
  }
  const membersBy = new Map<string, Row[]>();
  for (const m of members) {
    if (!membersBy.has(m.conversation_id)) membersBy.set(m.conversation_id, []);
    membersBy.get(m.conversation_id)!.push(m);
  }

  return rows.map((c) => {
    const ms = membersBy.get(c.id) ?? [];
    const peer = c.kind === 'direct' ? ms.find((m) => m.id !== uid) : undefined;
    return {
      id: c.id,
      kind: c.kind,
      title: c.title,
      iconEmoji: c.icon_emoji,
      iconColor: c.icon_color,
      ttlSeconds: c.ttl_seconds,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      myRole: c.role,
      pinned: c.pinned,
      archived: c.archived,
      muted: c.muted,
      unread: c.unread,
      blockedByMe: peer ? byMe.has(peer.id) : false,
      blockedMe: peer ? me.has(peer.id) : false,
      lastMessage: c.lm_id
        ? {
            id: c.lm_id,
            senderId: c.lm_sender_id,
            kind: c.lm_kind,
            ciphertext: c.lm_deleted_at ? '' : c.lm_ciphertext,
            nonce: c.lm_deleted_at ? '' : c.lm_nonce,
            senderKey: c.lm_sender_key,
            wrappedKey: c.lm_wrapped_key,
            wrapNonce: c.lm_wrap_nonce,
            createdAt: c.lm_created_at,
            deleted: !!c.lm_deleted_at,
          }
        : null,
      members: ms.map((m) => ({
        ...publicUser(m),
        role: m.role,
        online: !!m.online,
        lastSeenAt: m.last_seen_at,
      })),
    };
  });
}

export function registerConversations(r: Router) {
  r.add('GET', '/conversations', async ({ uid }) => ({ conversations: await loadConversations(uid) }));

  r.add('GET', '/conversations/:id', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMember(id, uid);
    const [conversation] = await loadConversations(uid, id);
    if (!conversation) throw notFound('Percakapan tidak ditemukan');
    return { conversation };
  });

  // Buat chat pribadi ({kind:'direct', userId}) atau grup ({kind:'group', title, memberIds})
  r.add('POST', '/conversations', async ({ req, uid }) => {
    const b = await readJson(req);
    const kind = v.oneOf(b.kind, 'kind', ['direct', 'group'] as const);

    if (kind === 'direct') {
      const other = v.uuid(b.userId, 'userId');
      if (other === uid) throw badRequest('Tidak bisa chat dengan diri sendiri');
      const [target] = await sql`select id from users where id = ${other}::uuid and username is not null`;
      if (!target) throw notFound('Pengguna tidak ditemukan');
      if (await isBlockedEitherWay(uid, other)) throw forbidden('Tidak bisa menghubungi pengguna ini');

      const key = [uid, other].sort().join(':');
      const newId = randomUUID();
      const ins = await sql`
        with c as (
          insert into conversations (id, kind, direct_key, created_by)
          values (${newId}::uuid, 'direct', ${key}, ${uid}::uuid)
          on conflict (direct_key) do nothing returning id
        ), m as (
          insert into conversation_members (conversation_id, user_id)
          select c.id, x.u from c, unnest(array[${uid}::uuid, ${other}::uuid]) as x(u)
        )
        select id from c`;
      let id = ins[0]?.id as string | undefined;
      let createdNew = !!id;
      if (!id) {
        const [ex] = await sql`select id from conversations where direct_key = ${key}`;
        id = ex.id as string;
        await sql`update conversation_members set hidden = false
                  where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
      }
      const [conversation] = await loadConversations(uid, id);
      return createdNew ? created({ conversation, created: true }) : { conversation, created: false };
    }

    // grup
    const title = v.str(b.title, 'Nama grup', 1, 40);
    const iconEmoji = b.iconEmoji === undefined ? '👥' : v.emoji(b.iconEmoji);
    const iconColor = b.iconColor === undefined ? '#4DABF7' : v.color(b.iconColor);
    const memberIds = [...new Set(v.arr(b.memberIds, 'memberIds', 99).map((x) => v.uuid(x, 'memberIds')))]
      .filter((x) => x !== uid);
    if (memberIds.length < 1) throw badRequest('Pilih minimal 1 anggota');

    const found = await sql`select id from users where id = any(${memberIds}::uuid[]) and username is not null`;
    if (found.length !== memberIds.length) throw notFound('Ada anggota yang tidak ditemukan');
    for (const m of memberIds) {
      if (await isBlockedEitherWay(uid, m)) throw forbidden('Tidak bisa menambahkan pengguna yang diblokir');
    }

    const id = randomUUID();
    const all = [uid, ...memberIds];
    await sql.transaction([
      sql`insert into conversations (id, kind, title, icon_emoji, icon_color, created_by)
          values (${id}::uuid, 'group', ${title}, ${iconEmoji}, ${iconColor}, ${uid}::uuid)`,
      sql`insert into conversation_members (conversation_id, user_id, role)
          select ${id}::uuid, x.u, case when x.u = ${uid}::uuid then 'owner' else 'member' end
          from unnest(${all}::uuid[]) as x(u)`,
      emitToUsers(memberIds, 'conversation.update', { conversationId: id }),
    ]);
    const [conversation] = await loadConversations(uid, id);
    return created({ conversation, created: true });
  });

  // Pengaturan pribadi (pin/arsip/bisukan), info grup (admin), dan pesan hilang otomatis
  r.add('PATCH', '/conversations/:id', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const m = await requireMember(id, uid);
    const b = await readJson(req);

    const pinned = v.optBool(b.pinned, 'pinned') ?? null;
    const archived = v.optBool(b.archived, 'archived') ?? null;
    const muted = v.optBool(b.muted, 'muted') ?? null;
    if (pinned !== null || archived !== null || muted !== null) {
      await sql`update conversation_members set
                  pinned = coalesce(${pinned}::boolean, pinned),
                  archived = coalesce(${archived}::boolean, archived),
                  muted = coalesce(${muted}::boolean, muted)
                where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
    }

    let changed = false;
    if (b.title !== undefined || b.iconEmoji !== undefined || b.iconColor !== undefined) {
      if (m.kind !== 'group') throw badRequest('Hanya grup yang punya nama/ikon');
      if (m.role !== 'owner' && m.role !== 'admin') throw forbidden('Hanya admin grup yang boleh mengubah info grup');
      const title = b.title === undefined ? null : v.str(b.title, 'Nama grup', 1, 40);
      const iconEmoji = b.iconEmoji === undefined ? null : v.emoji(b.iconEmoji);
      const iconColor = b.iconColor === undefined ? null : v.color(b.iconColor);
      await sql`update conversations set
                  title = coalesce(${title}::text, title),
                  icon_emoji = coalesce(${iconEmoji}::text, icon_emoji),
                  icon_color = coalesce(${iconColor}::text, icon_color),
                  updated_at = now()
                where id = ${id}::uuid`;
      changed = true;
    }
    if ('ttlSeconds' in b) {
      const ttl = b.ttlSeconds === null ? null : v.int(b.ttlSeconds, 'ttlSeconds', 1, 31_536_000);
      if (ttl !== null && !TTL_OPTIONS.includes(ttl)) throw badRequest('ttlSeconds harus 86400, 604800, 7776000, atau null');
      await sql`update conversations set ttl_seconds = ${ttl}::int where id = ${id}::uuid`;
      changed = true;
    }
    if (changed) await emitToMembers(id, uid, 'conversation.update', { conversationId: id });
    const [conversation] = await loadConversations(uid, id);
    return { conversation };
  });

  // Hapus chat (untuk saya): riwayat dibersihkan dan chat hilang dari daftar sampai ada pesan baru
  r.add('DELETE', '/conversations/:id', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMember(id, uid);
    await sql`update conversation_members set hidden = true, pinned = false, cleared_at = now(), last_read_at = now()
              where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
    return { ok: true };
  });

  // Bersihkan riwayat (untuk saya), chat tetap ada di daftar
  r.add('POST', '/conversations/:id/clear', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMember(id, uid);
    await sql`update conversation_members set cleared_at = now(), last_read_at = now()
              where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
    return { ok: true };
  });

  // "sedang mengetik…"
  r.add('POST', '/conversations/:id/typing', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMember(id, uid);
    await sql`update conversation_members set typing_at = now()
              where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
    return { ok: true };
  });

  // Tandai sudah dibaca. Centang biru hanya terkirim jika "centang biru" saya aktif.
  r.add('POST', '/conversations/:id/read', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireMember(id, uid);
    const [me] = await sql`select read_receipts from users where id = ${uid}::uuid`;
    await sql`update conversation_members set last_read_at = now()
              where conversation_id = ${id}::uuid and user_id = ${uid}::uuid`;
    if (me?.read_receipts) {
      await sql`
        with ins as (
          insert into message_receipts (message_id, user_id, delivered_at, read_at)
          select m.id, ${uid}::uuid, now(), now()
          from messages m
          join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${uid}::uuid
          where m.conversation_id = ${id}::uuid and m.sender_id <> ${uid}::uuid
            and m.deleted_at is null and m.kind <> 'vote' and m.created_at >= cm.joined_at
            and not exists (select 1 from message_receipts r
                            where r.message_id = m.id and r.user_id = ${uid}::uuid and r.read_at is not null)
          on conflict (message_id, user_id) do update
            set read_at = now(), delivered_at = coalesce(message_receipts.delivered_at, now())
          returning message_id
        )
        insert into events (user_id, type, payload)
        select m.sender_id, 'receipt',
               jsonb_build_object('conversationId', m.conversation_id::text, 'messageId', m.id::text,
                                  'userId', ${uid}::text, 'status', 'read')
        from messages m join ins on ins.message_id = m.id`;
    }
    return { ok: true };
  });
}
