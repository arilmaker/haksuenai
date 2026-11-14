import { sql } from '../db';
import { notFound } from '../http';
import { publicUser } from '../presenter';
import type { Router } from '../router';

export function registerUsers(r: Router) {
  // Cari @username (awalan). Pengguna yang saling blokir disembunyikan.
  r.add('GET', '/users/search', async ({ query, uid }) => {
    const q = (query.get('q') ?? '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 20);
    if (q.length < 2) return { users: [] };
    const rows = await sql`
      select u.id, u.username, u.display_name, u.about, u.avatar_emoji, u.avatar_color, u.public_key
      from users u
      where u.username is not null
        and starts_with(u.username, ${q})
        and u.id <> ${uid}::uuid
        and not exists (
          select 1 from blocks b
          where (b.blocker_id = ${uid}::uuid and b.blocked_id = u.id)
             or (b.blocker_id = u.id and b.blocked_id = ${uid}::uuid))
      order by (u.username = ${q}) desc, u.username
      limit 20`;
    return { users: rows.map(publicUser) };
  });

  // Profil pengguna lain (+ online / terakhir dilihat, menghormati privasi & blokir)
  r.add('GET', '/users/:username', async ({ params, uid }) => {
    const name = params.username.toLowerCase().replace(/^@/, '');
    const [u] = await sql`
      select u.*,
        (u.last_seen_at > now() - interval '40 seconds') as online,
        exists (select 1 from blocks where blocker_id = ${uid}::uuid and blocked_id = u.id) as blocked_by_me,
        exists (select 1 from blocks where blocker_id = u.id and blocked_id = ${uid}::uuid) as blocked_me
      from users u where u.username = ${name}`;
    if (!u) throw notFound('Pengguna tidak ditemukan');
    const hidePresence = u.blocked_me || u.blocked_by_me;
    return {
      user: publicUser(u),
      online: hidePresence ? false : !!u.online,
      lastSeenAt: hidePresence || !u.show_last_seen ? null : u.last_seen_at,
      blockedByMe: u.blocked_by_me,
      blockedMe: u.blocked_me,
      isMe: u.id === uid,
    };
  });
}
