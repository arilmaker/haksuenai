import { del } from '@vercel/blob';
import { sql } from './db';

/**
 * Logout = hapus akun. Semua data pengguna ikut terhapus (pesan, status, panggilan, media),
 * sama seperti menghapus nomor di WhatsApp. Pengguna harus mendaftar ulang.
 */
export async function deleteAccount(uid: string): Promise<void> {
  const media = await sql`select url from media_objects where owner_id = ${uid}::uuid`;
  const convs = await sql`select conversation_id from conversation_members where user_id = ${uid}::uuid`;
  const convIds: string[] = convs.map((r) => r.conversation_id);

  await sql.transaction([
    // beri tahu anggota lain supaya daftar chat mereka diperbarui
    sql`insert into events (user_id, type, payload)
        select m.user_id, 'conversation.update', jsonb_build_object('conversationId', m.conversation_id::text)
        from conversation_members m
        where m.conversation_id = any(${convIds}::uuid[]) and m.user_id <> ${uid}::uuid`,
    // grup yang dimiliki: serahkan kepemilikan ke admin / anggota tertua
    sql`update conversation_members t set role = 'owner'
        from (
          select distinct on (m.conversation_id) m.conversation_id, m.user_id
          from conversation_members m
          where m.conversation_id in (
                  select conversation_id from conversation_members
                  where user_id = ${uid}::uuid and role = 'owner')
            and m.user_id <> ${uid}::uuid
          order by m.conversation_id, (m.role = 'admin') desc, m.joined_at
        ) pick
        where t.conversation_id = pick.conversation_id and t.user_id = pick.user_id`,
    sql`delete from users where id = ${uid}::uuid`,
  ]);

  // buang percakapan yang tersisa kosong / chat pribadi tinggal satu orang
  if (convIds.length) {
    await sql`
      delete from conversations c
      where c.id = any(${convIds}::uuid[])
        and (select count(*) from conversation_members m where m.conversation_id = c.id)
            < (case when c.kind = 'direct' then 2 else 1 end)`;
  }

  const urls = media.map((r) => r.url as string);
  if (urls.length) {
    try {
      await del(urls);
    } catch (e) {
      console.error('[R1ZCHATID] gagal menghapus media Blob', e);
    }
  }
}
