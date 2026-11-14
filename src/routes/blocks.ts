import { sql } from '../db';
import { badRequest, notFound, readJson } from '../http';
import { publicUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';

export function registerBlocks(r: Router) {
  r.add('GET', '/blocks', async ({ uid }) => {
    const rows = await sql`
      select u.id, u.username, u.display_name, u.about, u.avatar_emoji, u.avatar_color, u.public_key
      from blocks b join users u on u.id = b.blocked_id
      where b.blocker_id = ${uid}::uuid order by b.created_at desc`;
    return { users: rows.map(publicUser) };
  });

  r.add('POST', '/blocks', async ({ req, uid }) => {
    const target = v.uuid((await readJson(req)).userId, 'userId');
    if (target === uid) throw badRequest('Tidak bisa memblokir diri sendiri');
    const [u] = await sql`select id from users where id = ${target}::uuid`;
    if (!u) throw notFound('Pengguna tidak ditemukan');
    await sql`insert into blocks (blocker_id, blocked_id) values (${uid}::uuid, ${target}::uuid) on conflict do nothing`;
    return { ok: true };
  });

  r.add('DELETE', '/blocks/:userId', async ({ params, uid }) => {
    const target = v.uuid(params.userId, 'userId');
    await sql`delete from blocks where blocker_id = ${uid}::uuid and blocked_id = ${target}::uuid`;
    return { ok: true };
  });
}
