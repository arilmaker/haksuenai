import { sql } from './db';

/**
 * Antrean event per pengguna. Klien mengambilnya lewat GET /events (polling),
 * karena Vercel Functions tidak bisa menahan koneksi WebSocket.
 * Fungsi ini mengembalikan query yang BELUM dieksekusi supaya bisa masuk sql.transaction([...]).
 */
export const emitToUsers = (uids: string[], type: string, payload: unknown) =>
  sql`insert into events (user_id, type, payload)
      select x.u, ${type}, ${JSON.stringify(payload)}::jsonb
      from unnest(${uids}::uuid[]) as x(u)`;

export const emitToMembers = (conversationId: string, exceptUid: string, type: string, payload: unknown) =>
  sql`insert into events (user_id, type, payload)
      select m.user_id, ${type}, ${JSON.stringify(payload)}::jsonb
      from conversation_members m
      where m.conversation_id = ${conversationId}::uuid and m.user_id <> ${exceptUid}::uuid`;
