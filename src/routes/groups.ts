import { isBlockedEitherWay, requireAdmin, requireMember } from '../access';
import { sql } from '../db';
import { emitToMembers, emitToUsers } from '../events';
import { badRequest, forbidden, notFound, readJson } from '../http';
import type { Router } from '../router';
import * as v from '../validate';
import { loadConversations } from './conversations';

export function registerGroups(r: Router) {
  // Tambah anggota (admin)
  r.add('POST', '/conversations/:id/members', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    await requireAdmin(id, uid);
    const ids = [...new Set(v.arr((await readJson(req)).userIds, 'userIds', 50).map((x) => v.uuid(x, 'userIds')))];
    if (!ids.length) throw badRequest('Pilih minimal 1 pengguna');
    const [{ n }] = await sql`select count(*)::int as n from conversation_members where conversation_id = ${id}::uuid`;
    if (n + ids.length > 100) throw badRequest('Grup maksimal 100 anggota');

    const found = await sql`select id from users where id = any(${ids}::uuid[]) and username is not null`;
    if (found.length !== ids.length) throw notFound('Ada pengguna yang tidak ditemukan');
    for (const u of ids) {
      if (await isBlockedEitherWay(uid, u)) throw forbidden('Tidak bisa menambahkan pengguna yang diblokir');
    }
    await sql.transaction([
      sql`insert into conversation_members (conversation_id, user_id)
          select ${id}::uuid, x.u from unnest(${ids}::uuid[]) as x(u)
          on conflict (conversation_id, user_id) do nothing`,
      sql`update conversations set updated_at = now() where id = ${id}::uuid`,
      emitToMembers(id, uid, 'conversation.update', { conversationId: id }),
    ]);
    const [conversation] = await loadConversations(uid, id);
    return { conversation };
  });

  // Ubah peran anggota (hanya owner): admin <-> member
  r.add('PATCH', '/conversations/:id/members/:userId', async ({ req, params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const target = v.uuid(params.userId, 'userId');
    const me = await requireMember(id, uid);
    if (me.kind !== 'group' || me.role !== 'owner') throw forbidden('Hanya pemilik grup yang boleh mengubah peran');
    const role = v.oneOf((await readJson(req)).role, 'role', ['admin', 'member'] as const);
    const done = await sql`update conversation_members set role = ${role}
                           where conversation_id = ${id}::uuid and user_id = ${target}::uuid and role <> 'owner'
                           returning user_id`;
    if (!done.length) throw notFound('Anggota tidak ditemukan');
    await emitToMembers(id, uid, 'conversation.update', { conversationId: id });
    return { ok: true };
  });

  // Keluarkan anggota (admin) ATAU keluar sendiri (userId = saya)
  r.add('DELETE', '/conversations/:id/members/:userId', async ({ params, uid }) => {
    const id = v.uuid(params.id, 'id');
    const target = v.uuid(params.userId, 'userId');
    const me = await requireMember(id, uid);
    if (me.kind !== 'group') throw badRequest('Hanya untuk grup');

    if (target !== uid) {
      if (me.role !== 'owner' && me.role !== 'admin') throw forbidden('Hanya admin grup yang boleh mengeluarkan anggota');
      const [t] = await sql`select role from conversation_members
                            where conversation_id = ${id}::uuid and user_id = ${target}::uuid`;
      if (!t) throw notFound('Anggota tidak ditemukan');
      if (t.role === 'owner') throw forbidden('Pemilik grup tidak bisa dikeluarkan');
      if (t.role === 'admin' && me.role !== 'owner') throw forbidden('Hanya pemilik yang boleh mengeluarkan admin');
    }

    const wasOwner = target === uid && me.role === 'owner';
    await sql.transaction([
      sql`delete from conversation_members where conversation_id = ${id}::uuid and user_id = ${target}::uuid`,
      // pemilik keluar -> serahkan ke admin / anggota tertua
      sql`update conversation_members t set role = 'owner'
          from (select user_id from conversation_members
                where conversation_id = ${id}::uuid and ${wasOwner}::boolean
                order by (role = 'admin') desc, joined_at limit 1) pick
          where t.conversation_id = ${id}::uuid and t.user_id = pick.user_id`,
      sql`delete from conversations c where c.id = ${id}::uuid
          and not exists (select 1 from conversation_members m where m.conversation_id = c.id)`,
      emitToUsers([target], 'conversation.update', { conversationId: id }),
      emitToMembers(id, target, 'conversation.update', { conversationId: id }),
    ]);
    return { ok: true };
  });
}
