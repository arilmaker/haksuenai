import { sql } from './db';
import type { Row } from './db';
import { forbidden, notFound } from './http';

/** Pastikan `uid` anggota percakapan. Mengembalikan baris keanggotaan + jenis percakapan. */
export async function requireMember(conversationId: string, uid: string): Promise<Row> {
  const [m] = await sql`
    select cm.role, cm.joined_at, cm.cleared_at, c.kind, c.ttl_seconds
    from conversation_members cm join conversations c on c.id = cm.conversation_id
    where cm.conversation_id = ${conversationId}::uuid and cm.user_id = ${uid}::uuid`;
  if (!m) throw forbidden('Kamu bukan anggota percakapan ini');
  return m;
}

export async function requireAdmin(conversationId: string, uid: string): Promise<Row> {
  const m = await requireMember(conversationId, uid);
  if (m.kind !== 'group') throw forbidden('Hanya untuk grup');
  if (m.role !== 'owner' && m.role !== 'admin') throw forbidden('Hanya admin grup yang boleh');
  return m;
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
  const [r] = await sql`
    select 1 as x from blocks
    where (blocker_id = ${a}::uuid and blocked_id = ${b}::uuid)
       or (blocker_id = ${b}::uuid and blocked_id = ${a}::uuid)
    limit 1`;
  return !!r;
}

/** Ambil pesan + pastikan pemanggil anggota percakapannya. */
export async function requireMessage(messageId: string, uid: string): Promise<Row> {
  const [m] = await sql`
    select id, conversation_id, sender_id, kind, created_at, deleted_at
    from messages where id = ${messageId}::uuid`;
  if (!m) throw notFound('Pesan tidak ditemukan');
  await requireMember(m.conversation_id, uid);
  return m;
}
