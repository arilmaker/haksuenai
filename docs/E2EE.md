# Desain enkripsi R1ZCHATID

**Tujuan:** server hanya menyimpan byte acak; hanya anggota percakapan yang bisa membaca isi.

## Kunci
- Tiap perangkat membuat pasangan kunci **X25519** saat pertama kali masuk.
- **Private key tidak pernah keluar dari HP** (disimpan di Keychain / Keystore lewat `flutter_secure_storage`).
- **Public key** diunggah ke server (`PUT /me/keys`) dan dibagikan ke lawan chat.

## Mengirim pesan (satu jalur untuk chat pribadi & grup)
1. Buat **kunci isi** acak 32 byte.
2. Enkripsi JSON pesan dengan **ChaCha20-Poly1305** (nonce acak) → `ciphertext`, `nonce`.
3. Untuk **setiap anggota** (termasuk diri sendiri): turunkan *wrap key* = `HKDF-SHA256( X25519(privSaya, pubAnggota), salt = urut(pubA‖pubB), info = "r1zchatid/wrap/v1" )`,
   lalu bungkus kunci isi dengan ChaCha20-Poly1305 → `wrappedKey`, `wrapNonce`.
4. Kirim `ciphertext`, `nonce`, `senderKey` (pub saya), dan daftar `keys[]`. Server memeriksa bahwa
   public key yang dipakai **sama dengan yang tersimpan** — kalau ada yang berganti → `409 stale_keys`
   beserta kunci terbaru, klien mengenkripsi ulang.

## Menerima
Turunkan wrap key dari `X25519(privSaya, senderKey)` → buka `wrappedKey` → buka `ciphertext`.

## Foto
Foto dienkripsi dengan kunci acak sendiri sebelum diunggah. URL + kunci foto ada **di dalam** JSON pesan
yang terenkripsi, jadi server/Blob hanya melihat byte acak.

## Video, audio, dokumen, stiker buatan sendiri
Semua dienkripsi seperti foto. File besar dipotong 3 MB; tiap potongan dienkripsi dengan **kunci file yang sama
dan nonce acak sendiri**, lalu diunggah terpisah. URL potongan + kunci file + nama/ukuran/jenis file hanya
ada **di dalam** JSON pesan terenkripsi.

## Polling
Pertanyaan & pilihan terenkripsi di pesan `poll`. Suara = pesan `vote` terenkripsi yang menunjuk ke poll;
tiap anggota menghitung sendiri. Server tahu siapa yang memilih, tidak tahu pilihannya.

## Channel — tidak E2EE
Channel itu siaran publik (siapa pun bisa mencari & mengikuti), jadi isinya **sengaja tidak dienkripsi**,
sama seperti channel WhatsApp. Jangan kirim hal rahasia ke channel.

## Panggilan
Audio/video lewat WebRTC peer-to-peer (DTLS-SRTP). Sinyal SDP/ICE dienkripsi dengan wrap key yang sama
sebelum lewat server, jadi server tidak bisa menyisipkan diri (MITM) tanpa memalsukan public key.

## Safety number (emoji)
`SHA-256(urut(pubA, pubB))` → 12 emoji. Bandingkan dengan lawan chat lewat jalur lain untuk memastikan
tidak ada yang mengganti kunci di server.

## Batasan
- **Tidak ada forward secrecy** dan tidak ada post-compromise security: jika private key bocor, semua pesan
  lama yang dienkripsi untuk kunci itu bisa dibuka. Protokol Signal (X3DH + Double Ratchet) memperbaiki ini
  tetapi jauh lebih kompleks; ini bisa jadi tahap berikutnya.
- Server bisa menukar public key (TOFU). Pakai safety number untuk memeriksa.
- Metadata (siapa–siapa, kapan, ukuran, jenis pesan) terlihat oleh server.
- Satu akun = satu perangkat.
- Kode ini **belum diaudit** oleh ahli kriptografi. Jangan dipakai untuk melindungi hal yang membahayakan nyawa.
