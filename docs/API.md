# R1ZCHATID API

Basis URL: `https://<domain>/api`. Semua endpoint JSON. Kecuali yang ditandai **publik**, kirim header
`Authorization: Bearer <token>`. Error: `{ "error": "pesan", ...info }` dengan status 4xx/5xx.

## Akun & login
| Method | Path | Body | Keterangan |
|---|---|---|---|
| POST | `/auth/request-otp` **publik** | `{email}` | Kirim OTP 6 digit ke Gmail. Jeda 60 dtk, maks 5/jam, berlaku 10 menit. |
| POST | `/auth/verify-otp` **publik** | `{email, code}` | Benar → `{token, user, isNewUser, needsUsername}`. Akun baru otomatis dibuat. Maks 5 percobaan. |
| POST | `/auth/logout` | `{confirm:true}` | **Menghapus akun & semua data.** Harus daftar ulang. |
| GET | `/me` | | Profil sendiri. |
| PATCH | `/me` | `{displayName?, about?, avatarEmoji?, avatarColor?, showLastSeen?, readReceipts?}` | |
| POST | `/me/username` | `{username}` | Set/ganti @username (3–20: a-z 0-9 _). 409 jika dipakai. |
| GET | `/users/username-available?u=` | | `{available}` |
| PUT | `/me/keys` | `{publicKey}` | Upload public key X25519 (base64url, 32 byte). |
| DELETE | `/me` | `{confirm:true}` | Sama dengan logout. |

## Pengguna & blokir
| GET | `/users/search?q=` | Cari @username (awalan, min 2 huruf). Yang saling blokir disembunyikan. |
|---|---|---|
| GET | `/users/:username` | Profil + `online` + `lastSeenAt` (null jika disembunyikan) + `blockedByMe/blockedMe`. |
| GET | `/blocks` | Daftar yang saya blokir. |
| POST | `/blocks` `{userId}` | Blokir. |
| DELETE | `/blocks/:userId` | Buka blokir. |

## Percakapan & grup
| GET | `/conversations` | Daftar chat (pin dulu, terbaru) + anggota + pesan terakhir (ciphertext) + `unread`. |
|---|---|---|
| GET | `/conversations/:id` | Satu chat. |
| POST | `/conversations` | `{kind:'direct', userId}` atau `{kind:'group', title, memberIds[], iconEmoji?, iconColor?}` |
| PATCH | `/conversations/:id` | Pribadi: `{pinned?, archived?, muted?}`. Admin grup: `{title?, iconEmoji?, iconColor?}`. Semua anggota: `{ttlSeconds}` (86400 / 604800 / 7776000 / null). |
| DELETE | `/conversations/:id` | Hapus chat (untuk saya). Muncul lagi jika ada pesan baru. |
| POST | `/conversations/:id/clear` | Bersihkan riwayat, chat tetap di daftar. |
| POST | `/conversations/:id/typing` | "sedang mengetik". |
| POST | `/conversations/:id/read` | Tandai dibaca (centang biru jika `readReceipts` aktif). |
| POST | `/conversations/:id/members` | `{userIds[]}` tambah anggota (admin). |
| PATCH | `/conversations/:id/members/:userId` | `{role:'admin'|'member'}` (owner). |
| DELETE | `/conversations/:id/members/:userId` | Keluarkan anggota (admin) / keluar sendiri. |

## Pesan (E2EE)
| GET | `/conversations/:id/messages?before=&limit=` | Riwayat, lama → baru. Pesan sendiri membawa `status` (`sent`/`delivered`/`read`). |
|---|---|---|
| POST | `/conversations/:id/messages` | `kind` = `text`, `image`, `video`, `audio`, `document`, `sticker`, `poll`, `vote`. `{kind, ciphertext, nonce, senderKey, replyTo?, keys:[{userId, publicKey, wrappedKey, wrapNonce}]}` — `keys` WAJIB untuk semua anggota termasuk pengirim. 409 `stale_keys` jika ada kunci berubah (balasan berisi kunci terbaru). |
| PATCH | `/messages/:id` | `{ciphertext, nonce}` edit teks (maks 15 menit, pengirim). |
| DELETE | `/messages/:id?scope=me|all&mediaIds=a,b,c` | Hapus untuk saya / untuk semua (pengirim). `mediaIds` = potongan media yang ikut dibuang. |
| POST | `/messages/:id/reaction` | `{emoji}` atau `{emoji:null}`. |
| POST | `/messages/:id/star` | `{starred:boolean}` |
| GET | `/starred` | Pesan berbintang. |
| GET | `/messages/:id/votes` | Suara TERBARU tiap orang pada sebuah `poll` (pesan `vote` terenkripsi; klien yang menghitung). |

**Polling (voting):** pesan `poll` berisi pertanyaan + pilihan (terenkripsi). Memilih = mengirim pesan `kind:'vote'` dengan `replyTo` = id poll. Pesan `vote` tidak muncul di riwayat/badge/pesan terakhir. Server hanya tahu *siapa* yang memilih, bukan *apa* yang dipilih.

## Status 24 jam
| GET | `/statuses/audience` | Kontak + public key (untuk enkripsi di HP). |
|---|---|---|
| GET | `/statuses` | Feed (milik saya + kontak). |
| POST | `/statuses` | `{ciphertext, nonce, senderKey, keys[]}` |
| POST | `/statuses/:id/view` | Tandai dilihat. |
| GET | `/statuses/:id/views` | Penonton (pemilik saja). |
| DELETE | `/statuses/:id?mediaIds=a,b` | Hapus. |

## Panggilan (1-1)
| GET | `/calls/ice` | `{iceServers}` (STUN + TURN opsional). |
|---|---|---|
| GET | `/calls` | Riwayat panggilan. |
| POST | `/calls` | `{conversationId, kind:'voice'|'video'}` → `{callId, iceServers}`. 409 `busy`. |
| POST | `/calls/:id/signal` | `{type:'offer'|'answer'|'ice', data}` (data terenkripsi dari klien). |
| POST | `/calls/:id/accept` / `/decline` | Penerima. |
| POST | `/calls/:id/end` | `{reason?:'timeout'}` |

## Media
| POST | `/media?purpose=chat|status|channel` | Satu **potongan** (`application/octet-stream`, maks 4 MB). Video/dokumen/audio besar dipotong di aplikasi (3 MB per potongan) dan tiap potongan diunggah sendiri. Chat & status: potongan **terenkripsi**. Channel: file asli (publik). → `{id, url}`. 413 jika kuota penuh (default 300 MB, env `MEDIA_QUOTA_MB`). |
|---|---|---|
| GET | `/media/usage` | `{usedBytes, files, quotaBytes}` |
| DELETE | `/media/:id` | |

Penyimpanan: media chat 30 hari, status 25 jam, channel 180 hari.

## Channel (siaran satu arah — PUBLIK, tidak E2EE)
| GET | `/channels/mine` · `/channels/following` | Channel milik saya / yang saya ikuti (+`unread`, `lastPost`, `followerCount`). |
|---|---|---|
| GET | `/channels/search?q=` | Cari nama atau @handle. |
| POST | `/channels` | `{name, handle?, description?, iconEmoji?, iconColor?}` (maks 5 per akun). |
| GET / PATCH / DELETE | `/channels/:id` | Detail / ubah / hapus (ubah & hapus: pemilik). |
| POST / DELETE | `/channels/:id/follow` | Ikuti / berhenti. |
| POST | `/channels/:id/read` | Tandai sudah dibaca. |
| GET | `/channels/:id/posts?before=&limit=` | Postingan (lama → baru) + ringkasan reaksi. |
| POST | `/channels/:id/posts` | Pemilik: `{kind:'text'|'image'|'video'|'audio'|'document', body?, media:{urls[https], size, mime, name, durationMs?, ids[]}}` |
| DELETE | `/channels/:id/posts/:postId` | Pemilik. |
| POST | `/channels/:id/posts/:postId/reaction` | `{emoji}` / `{emoji:null}` |

## Sinkronisasi (pengganti WebSocket)
| GET | `/events/cursor` | Dipanggil sekali saat aplikasi dibuka. Menandai pesan tertunda sebagai terkirim → `{cursor}`. |
|---|---|---|
| GET | `/events?after=<cursor>&presence=1` | `{events[], cursor, typing{}, presence[]}`. `after` sekaligus meng-ack event lama. |

Tipe event: `message.new`, `message.edit`, `message.delete`, `message.reaction`, `receipt`,
`conversation.update`, `status.new`, `call.incoming`, `call.signal`, `call.state`.

## Lainnya
| GET | `/health` **publik** | Cek hidup. |
|---|---|---|
| GET | `/salin?kode=` **publik** | Halaman tombol "Salin Kode" dari email. |
| GET | `/cron/purge` | Dipanggil Vercel Cron (`Bearer CRON_SECRET`): hapus pesan/status/media/event kedaluwarsa. |
