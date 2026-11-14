import { deleteAccount } from '../account';
import { sql } from '../db';
import { badRequest, conflict, readJson } from '../http';
import { selfUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';

export function registerMe(r: Router) {
  r.add('GET', '/me', async ({ uid }) => {
    const [u] = await sql`select * from users where id = ${uid}::uuid`;
    return { user: selfUser(u) };
  });

  r.add('PATCH', '/me', async ({ req, uid }) => {
    const b = await readJson(req);
    const displayName = b.displayName === undefined ? null : v.str(b.displayName, 'Nama', 1, 40);
    const about = b.about === undefined ? null : v.str(b.about, 'Tentang', 0, 140);
    const avatarEmoji = b.avatarEmoji === undefined ? null : v.emoji(b.avatarEmoji);
    const avatarColor = b.avatarColor === undefined ? null : v.color(b.avatarColor);
    const showLastSeen = v.optBool(b.showLastSeen, 'showLastSeen') ?? null;
    const readReceipts = v.optBool(b.readReceipts, 'readReceipts') ?? null;
    const [u] = await sql`
      update users set
        display_name   = coalesce(${displayName}::text, display_name),
        about          = coalesce(${about}::text, about),
        avatar_emoji   = coalesce(${avatarEmoji}::text, avatar_emoji),
        avatar_color   = coalesce(${avatarColor}::text, avatar_color),
        show_last_seen = coalesce(${showLastSeen}::boolean, show_last_seen),
        read_receipts  = coalesce(${readReceipts}::boolean, read_receipts)
      where id = ${uid}::uuid returning *`;
    return { user: selfUser(u) };
  });

  // Set / ganti username @
  r.add('POST', '/me/username', async ({ req, uid }) => {
    const username = v.username((await readJson(req)).username);
    if (v.RESERVED_USERNAMES.has(username)) throw conflict('Username ini tidak tersedia');
    try {
      const [u] = await sql`update users set username = ${username} where id = ${uid}::uuid returning *`;
      return { user: selfUser(u) };
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('Username sudah dipakai orang lain');
      throw e;
    }
  });

  r.add('GET', '/users/username-available', async ({ query, uid }) => {
    let username: string;
    try { username = v.username(query.get('u') ?? ''); } catch { return { available: false, reason: 'format' }; }
    if (v.RESERVED_USERNAMES.has(username)) return { available: false, reason: 'reserved' };
    const [row] = await sql`select id from users where username = ${username}`;
    return { available: !row || row.id === uid, reason: row && row.id !== uid ? 'taken' : null };
  });

  // Upload public key E2EE (private key tetap di HP)
  r.add('PUT', '/me/keys', async ({ req, uid }) => {
    const publicKey = v.b64((await readJson(req)).publicKey, 'publicKey', 44);
    if (Buffer.from(publicKey, 'base64url').length !== 32) throw badRequest('publicKey harus 32 byte (X25519)');
    const [u] = await sql`update users set public_key = ${publicKey} where id = ${uid}::uuid returning *`;
    return { user: selfUser(u) };
  });

  r.add('DELETE', '/me', async ({ req, uid }) => {
    const b = await readJson(req);
    if (b.confirm !== true) throw badRequest('Kirim {"confirm": true} untuk menghapus akun');
    await deleteAccount(uid);
    return { ok: true, deleted: true };
  });
}
