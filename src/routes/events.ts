import { sql } from '../db';
import type { Row } from '../db';
import type { Router } from '../router';

/** Tandai pesan yang baru diterima sebagai "terkirim ke perangkat" (centang dua) & kabari pengirimnya. */
async function markDelivered(uid: string, messageIds: string[]) {
  if (!messageIds.length) return;
  await sql`
    with ins as (
      insert into message_receipts (message_id, user_id, delivered_at)
      select x.id, ${uid}::uuid, now() from unnest(${messageIds}::uuid[]) as x(id)
      on conflict (message_id, user_id) do nothing
      returning message_id
    )
    insert into events (user_id, type, payload)
    select m.sender_id, 'receipt',
           jsonb_build_object('conversationId', m.conversation_id::text, 'messageId', m.id::text,
                              'userId', ${uid}::text, 'status', 'delivered')
    from messages m join ins on ins.message_id = m.id`;
}

export function registerEvents(r: Router) {
  /**
   * Dipanggil sekali saat aplikasi dibuka: semua pesan yang tertunda (saat saya offline) ditandai terkirim,
   * lalu klien mulai polling dari kursor ini. Pesan lama diambil lewat REST, bukan event.
   */
  r.add('GET', '/events/cursor', async ({ uid }) => {
    await sql`
      with pending as (
        select m.id from messages m
        join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${uid}::uuid
        where m.sender_id <> ${uid}::uuid and m.deleted_at is null and m.kind <> 'vote'
          and m.created_at >= cm.joined_at and m.created_at > now() - interval '30 days'
          and (m.expires_at is null or m.expires_at > now())
          and not exists (select 1 from message_receipts r where r.message_id = m.id and r.user_id = ${uid}::uuid)
      ), ins as (
        insert into message_receipts (message_id, user_id, delivered_at)
        select id, ${uid}::uuid, now() from pending
        on conflict (message_id, user_id) do nothing
        returning message_id
      )
      insert into events (user_id, type, payload)
      select m.sender_id, 'receipt',
             jsonb_build_object('conversationId', m.conversation_id::text, 'messageId', m.id::text,
                                'userId', ${uid}::text, 'status', 'delivered')
      from messages m join ins on ins.message_id = m.id`;
    const [row] = await sql`select coalesce(max(id), 0)::bigint as cursor from events where user_id = ${uid}::uuid`;
    return { cursor: Number(row.cursor), serverTime: new Date().toISOString() };
  });

  /**
   * Polling: ?after=<cursor>&presence=1
   * - `after` sekaligus meng-ack event lama (dihapus), jadi tabel events tetap kecil.
   * - presence=1 menambahkan online/terakhir dilihat lawan chat pribadi.
   */
  r.add('GET', '/events', async ({ query, uid }) => {
    const after = Math.max(0, Number(query.get('after') ?? '0') || 0);
    const wantPresence = query.get('presence') === '1';

    const queries = [
      sql`delete from events where user_id = ${uid}::uuid and (id <= ${after}::bigint or expires_at < now())`,
      sql`select id, type, payload, created_at from events
          where user_id = ${uid}::uuid and id > ${after}::bigint and expires_at >= now()
          order by id limit 200`,
      sql`select cm.conversation_id, cm.user_id from conversation_members cm
          where cm.typing_at > now() - interval '5 seconds' and cm.user_id <> ${uid}::uuid
            and cm.conversation_id in (select conversation_id from conversation_members where user_id = ${uid}::uuid)`,
      ...(wantPresence
        ? [sql`select u.id, (u.last_seen_at > now() - interval '40 seconds') as online,
                      case when u.show_last_seen then u.last_seen_at else null end as last_seen_at
               from conversation_members a
               join conversations c on c.id = a.conversation_id and c.kind = 'direct'
               join conversation_members b on b.conversation_id = a.conversation_id and b.user_id <> a.user_id
               join users u on u.id = b.user_id
               where a.user_id = ${uid}::uuid
                 and not exists (select 1 from blocks x
                   where (x.blocker_id = ${uid}::uuid and x.blocked_id = u.id)
                      or (x.blocker_id = u.id and x.blocked_id = ${uid}::uuid))`]
        : []),
    ];
    const results = (await sql.transaction(queries)) as Row[][];
    const events = results[1];

    await markDelivered(
      uid,
      events.filter((e) => e.type === 'message.new').map((e) => e.payload?.message?.id as string).filter(Boolean),
    );

    const typing: Record<string, string[]> = {};
    for (const t of results[2]) (typing[t.conversation_id] ??= []).push(t.user_id);

    return {
      events: events.map((e) => ({ id: Number(e.id), type: e.type, payload: e.payload, createdAt: e.created_at })),
      cursor: events.length ? Number(events[events.length - 1].id) : after,
      typing,
      presence: wantPresence
        ? results[3].map((p) => ({ userId: p.id, online: !!p.online, lastSeenAt: p.last_seen_at }))
        : undefined,
      serverTime: new Date().toISOString(),
    };
  });
}
