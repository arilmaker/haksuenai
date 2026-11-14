import { deleteAccount } from '../account';
import { sql } from '../db';
import { jwtSecret, otpSecret } from '../env';
import { HttpError, badRequest, readJson } from '../http';
import { signJwt } from '../jwt';
import { sendOtpMail } from '../mail';
import { hashCode, makeCode, sameHash } from '../otp';
import { selfUser } from '../presenter';
import type { Router } from '../router';
import * as v from '../validate';

const MAX_SENDS_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

export function registerAuth(r: Router) {
  // Satu alur untuk daftar & login: email -> OTP -> (akun baru dibuat otomatis jika belum ada)
  r.add('POST', '/auth/request-otp', async ({ req }) => {
    const email = v.email((await readJson(req)).email);

    const [prev] = await sql`
      select sent_count,
             extract(epoch from (now() - last_sent_at))::int as since_last,
             extract(epoch from (now() - window_started_at))::int as since_window
      from otp_codes where email = ${email}`;
    if (prev && prev.since_last < 60) {
      const wait = 60 - prev.since_last;
      throw new HttpError(429, `Tunggu ${wait} detik sebelum minta kode lagi.`, { retryAfter: wait });
    }
    if (prev && prev.since_window < 3600 && prev.sent_count >= MAX_SENDS_PER_HOUR) {
      throw new HttpError(429, 'Terlalu banyak permintaan kode. Coba lagi dalam 1 jam.', { retryAfter: 3600 });
    }

    const code = makeCode();
    const hash = hashCode(email, code, otpSecret());
    await sql`
      insert into otp_codes (email, code_hash, expires_at, attempts, sent_count, window_started_at, last_sent_at)
      values (${email}, ${hash}, now() + interval '10 minutes', 0, 1, now(), now())
      on conflict (email) do update set
        code_hash = excluded.code_hash,
        expires_at = excluded.expires_at,
        attempts = 0,
        sent_count = case when otp_codes.window_started_at < now() - interval '1 hour'
                          then 1 else otp_codes.sent_count + 1 end,
        window_started_at = case when otp_codes.window_started_at < now() - interval '1 hour'
                                 then now() else otp_codes.window_started_at end,
        last_sent_at = now()`;

    try {
      await sendOtpMail(email, code);
    } catch (e) {
      console.error('[R1ZCHATID] gagal kirim email OTP', e);
      throw new HttpError(502, 'Gagal mengirim email OTP. Coba lagi sebentar.');
    }
    return { ok: true, expiresIn: 600, resendIn: 60 };
  }, { public: true });

  r.add('POST', '/auth/verify-otp', async ({ req }) => {
    const body = await readJson(req);
    const email = v.email(body.email);
    const code = v.str(body.code, 'Kode', 6, 6);
    if (!/^\d{6}$/.test(code)) throw badRequest('Kode harus 6 angka');

    const [row] = await sql`
      select code_hash, attempts, (expires_at < now()) as expired from otp_codes where email = ${email}`;
    if (!row || row.expired) throw badRequest('Kode kedaluwarsa. Minta kode baru.');
    if (row.attempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Terlalu banyak percobaan. Minta kode baru.');

    if (!sameHash(hashCode(email, code, otpSecret()), row.code_hash)) {
      await sql`update otp_codes set attempts = attempts + 1 where email = ${email}`;
      throw badRequest('Kode salah');
    }
    await sql`delete from otp_codes where email = ${email}`; // sekali pakai

    let [user] = await sql`insert into users (email) values (${email}) on conflict (email) do nothing returning *`;
    const isNewUser = !!user;
    if (!user) [user] = await sql`select * from users where email = ${email}`;

    return {
      token: signJwt(user.id, jwtSecret()),
      user: selfUser(user),
      isNewUser,
      needsUsername: !user.username,
    };
  }, { public: true });

  // Logout = hapus akun beserta semua data (aturan R1ZCHATID, seperti hapus nomor di WhatsApp)
  r.add('POST', '/auth/logout', async ({ req, uid }) => {
    const body = await readJson(req);
    if (body.confirm !== true) throw badRequest('Kirim {"confirm": true} untuk menghapus akun');
    await deleteAccount(uid);
    return { ok: true, deleted: true };
  });
}
