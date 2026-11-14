import type { IncomingMessage } from 'node:http';
import { sql } from './db';
import { jwtSecret } from './env';
import { unauthorized } from './http';
import { verifyJwt } from './jwt';

/** Verifikasi token, pastikan akun masih ada, dan perbarui "terakhir dilihat" (maks sekali per 15 detik). */
export async function requireUser(req: IncomingMessage): Promise<string> {
  const h = String(req.headers.authorization ?? '');
  if (!h.startsWith('Bearer ')) throw unauthorized();
  const uid = verifyJwt(h.slice(7), jwtSecret());
  if (!uid) throw unauthorized();

  const [u] = await sql`
    select id, (last_seen_at is null or last_seen_at < now() - interval '15 seconds') as stale
    from users where id = ${uid}::uuid`;
  if (!u) throw unauthorized(); // akun sudah dihapus
  if (u.stale) await sql`update users set last_seen_at = now() where id = ${uid}::uuid`;
  return uid;
}
