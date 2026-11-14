# R1ZCHATID — Backend

API chat end-to-end encrypted gaya komik. Jalan di **Vercel** (satu Function), database **Neon Postgres**,
OTP lewat **Gmail**, foto terenkripsi di **Vercel Blob**.

```
api/[...path].ts      → satu-satunya Vercel Function (semua /api/*)
src/app.ts            → dispatcher + CORS + penanganan error
src/router.ts         → router mini
src/routes/*.ts       → auth, me, users, blocks, conversations, groups, messages,
                        statuses, calls, media, events, misc
src/*.ts              → jwt, otp, mail, db, auth, validate, presenter, events, access
db/schema.sql         → skema (idempotent)
tests/                → 93 test (unit + route dengan database palsu)
docs/API.md           → daftar endpoint lengkap
docs/E2EE.md          → desain enkripsi
```

## Fitur

Akun & OTP Gmail · @username · profil · cari pengguna · chat pribadi & grup (peran owner/admin) ·
**kirim teks, foto, video, audio/voice note, dokumen, stiker (termasuk buatan sendiri), polling** ·
centang ✓ / ✓✓ / ✓✓ biru · online & terakhir dilihat · mengetik · balas, edit, hapus, reaksi, bintang ·
pesan hilang otomatis · pin/arsip/bisukan · blokir · **status 24 jam (teks dengan font & background, foto, video)** ·
**channel** · telepon & video call · semua pesan terenkripsi end-to-end (kecuali channel yang publik) ·
logout = hapus akun.

## Setup (±10 menit)

1. **Database** — Vercel → project → *Storage* → buat **Neon Postgres**. `DATABASE_URL` terisi otomatis.
   Buka *SQL Editor* Neon, tempel isi `db/schema.sql`, Run.
2. **Blob** — Vercel → *Storage* → buat **Blob store** (`BLOB_READ_WRITE_TOKEN` terisi otomatis).
3. **Gmail App Password** — akun Google → Keamanan → aktifkan *Verifikasi 2 Langkah* → *Sandi aplikasi*
   → buat 16 karakter. Itu isi `GMAIL_APP_PASSWORD` (bukan password akun).
4. **Environment variables** di Vercel (lihat `.env.example`): `JWT_SECRET`, `OTP_SECRET`, `CRON_SECRET`
   (isi masing-masing `openssl rand -base64 48`), `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `APP_URL`.
5. Pasang variabel sekaligus: isi `.env` (contoh: `.env.example`), lalu `npx vercel link && bash scripts/push-env.sh`.
   Deploy: `npm install && npx vercel --prod`.
6. Cek: buka `https://<domain-kamu>.vercel.app/api/health` → `{"ok":true,...}`.

## Tes lokal

```bash
npm install
npm run typecheck
npm test            # 93 test, tanpa database/email sungguhan
```

## Keputusan desain (dan kenapa)

| Hal | Pilihan | Alasan |
|---|---|---|
| Realtime | **Polling** `/events` tiap ±2,5 dtk | Vercel Functions tidak bisa menahan WebSocket. Tanpa layanan pihak ketiga. |
| Centang | ✓ terkirim ke server, ✓✓ sampai di HP penerima, ✓✓ biru dibaca | Penerima offline = tetap ✓ satu. Centang biru hormati pengaturan privasi penerima. |
| Online | `last_seen_at` < 40 dtk | Klien berhenti polling saat aplikasi di background → otomatis offline. |
| Logout | `POST /auth/logout` = **hapus akun + semua data** | Sesuai aturan R1ZCHATID (seperti hapus nomor di WhatsApp). |
| Foto | Dienkripsi di HP, diunggah sebagai byte acak | Server & Blob tidak bisa melihat isinya. Disimpan 30 hari (chat) / 25 jam (status). |
| Auth | JWT HS256 buatan sendiri (node:crypto) | Tanpa dependency; alg `none` ditolak; akun dicek ke DB tiap request. |

## Perbedaan dengan versi ChatGPT

- Endpoint `presence`, `status`, `call-signal`, `media-intent`, `metrics` versi lama **tidak memverifikasi token**
  dan memercayai `senderId`/`ownerId` dari body → siapa pun bisa menyamar. Sekarang **semua** route
  privat lewat `requireUser` dan identitas selalu dari token.
- Folder `services/` (Go, Python, worker) dibuang — hanya placeholder dan tidak bisa jalan di Vercel.
- Skema dipadatkan jadi satu file; migrasi terpisah dibuang.
- Ditambah: grup + peran, centang 3 tingkat, edit/hapus/reaksi/bintang/balas, pesan hilang otomatis,
  status terenkripsi + daftar penonton, panggilan dengan sinyal terenkripsi, pin/arsip/bisukan, privasi.

## Batasan yang jujur

- **Satu akun = satu perangkat.** Private key hanya ada di HP. Login di HP lain membuat kunci baru;
  pesan lama tidak bisa dibuka di HP baru.
- E2EE memakai X25519 + ChaCha20-Poly1305 **tanpa forward secrecy** (bukan Double Ratchet ala Signal). Lihat `docs/E2EE.md`.
- Server tetap melihat metadata: siapa chat dengan siapa, kapan, ukuran pesan, jenis pesan (teks/foto/stiker).
- Polling ≈ 20 request/menit per pengguna aktif. Cukup untuk ratusan pengguna di paket gratis; untuk
  ribuan, pindah ke Ably/Pusher (cukup ganti `/events`).
- Gmail App Password dibatasi ±500 email/hari. Untuk lebih banyak, ganti `src/mail.ts` ke Resend/SendGrid.
