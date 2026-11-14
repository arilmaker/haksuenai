import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { blob, fake } from './setup';
import { CID, UID, UID2, call, loginAs, token } from './harness';
import { hashCode } from '../src/otp';
import { verifyJwt } from '../src/jwt';

const K1 = 'A'.repeat(43); // kunci publik palsu (format b64 valid)
const K2 = 'B'.repeat(43);
const MSG = '44444444-4444-4444-8444-444444444444';

beforeEach(() => { fake.reset(); blob.deleted.length = 0; blob.puts.length = 0; });

/* ───────────── dasar ───────────── */
test('GET /health publik', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.app, 'R1ZCHATID');
});
test('OPTIONS -> 204 + CORS', async () => {
  const r = await call('OPTIONS', '/api/me');
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], '*');
});
test('404 & 405', async () => {
  assert.equal((await call('GET', '/api/tidak-ada', { uid: null })).status, 404);
  assert.equal((await call('POST', '/api/health')).status, 405);
});
test('endpoint privat tanpa token / token palsu / akun sudah dihapus -> 401', async () => {
  assert.equal((await call('GET', '/api/me', { uid: null })).status, 401);
  assert.equal((await call('GET', '/api/me', { uid: null, headers: { authorization: 'Bearer asal.asalan.saja' } })).status, 401);
  // token sah tapi akunnya tidak ada lagi
  assert.equal((await call('GET', '/api/me', { uid: UID })).status, 401);
});
test('presence/status/call-signal lama yang tanpa auth sudah tidak ada: semua privat', async () => {
  for (const [m, p] of [['GET', '/api/events'], ['GET', '/api/statuses'], ['POST', '/api/calls'], ['POST', '/api/media'], ['GET', '/api/conversations']]) {
    assert.equal((await call(m, p, { uid: null })).status, 401, `${m} ${p}`);
  }
});
test('JSON rusak -> 400', async () => {
  loginAs();
  const r = await call('POST', '/api/me/username', { uid: UID, raw: Buffer.from('{bukan json') });
  assert.equal(r.status, 400);
});

/* ───────────── OTP & login ───────────── */
test('request-otp: email tidak valid -> 400', async () => {
  assert.equal((await call('POST', '/api/auth/request-otp', { body: { email: 'abc' } })).status, 400);
  assert.equal(fake.mails.length, 0);
});
test('request-otp: sukses kirim email & simpan HASH (bukan kode asli)', async () => {
  const r = await call('POST', '/api/auth/request-otp', { body: { email: 'Budi@Gmail.com' } });
  assert.equal(r.status, 200);
  assert.equal(fake.mails.length, 1);
  assert.equal(fake.mails[0].to, 'budi@gmail.com');
  const code = /(\d{6})/.exec(fake.mails[0].text)![1];
  assert.ok(fake.mails[0].html.includes(code));
  const ins = fake.ran(/insert into otp_codes/)[0];
  assert.ok(ins.values.includes(hashCode('budi@gmail.com', code, process.env.OTP_SECRET!)));
  assert.ok(!ins.values.includes(code), 'kode asli tidak boleh disimpan');
});
test('request-otp: cooldown 60 detik', async () => {
  fake.on(/from otp_codes where email/, [{ sent_count: 1, since_last: 10, since_window: 10 }]);
  const r = await call('POST', '/api/auth/request-otp', { body: { email: 'a@gmail.com' } });
  assert.equal(r.status, 429);
  assert.equal(r.body.retryAfter, 50);
  assert.equal(fake.mails.length, 0);
});
test('request-otp: maksimal 5 kali per jam', async () => {
  fake.on(/from otp_codes where email/, [{ sent_count: 5, since_last: 100, since_window: 200 }]);
  assert.equal((await call('POST', '/api/auth/request-otp', { body: { email: 'a@gmail.com' } })).status, 429);
});
test('request-otp: gagal kirim email -> 502', async () => {
  fake.mailFail = true;
  const r = await call('POST', '/api/auth/request-otp', { body: { email: 'a@gmail.com' } });
  assert.equal(r.status, 502);
  assert.equal(fake.mails.length, 0);
});

const mkOtpRow = (email: string, code: string, extra: object = {}) =>
  [{ code_hash: hashCode(email, code, process.env.OTP_SECRET!), attempts: 0, expired: false, ...extra }];

test('verify-otp: kode benar -> token + akun baru dibuat', async () => {
  fake.on(/select code_hash, attempts/, mkOtpRow('budi@gmail.com', '123456'));
  fake.on(/insert into users/, [{ id: UID, email: 'budi@gmail.com', username: null, show_last_seen: true, read_receipts: true }]);
  const r = await call('POST', '/api/auth/verify-otp', { body: { email: 'budi@gmail.com', code: '123456' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.isNewUser, true);
  assert.equal(r.body.needsUsername, true);
  assert.equal(verifyJwt(r.body.token, process.env.JWT_SECRET!), UID);
  assert.equal(fake.ran(/delete from otp_codes/).length, 1, 'OTP sekali pakai');
});
test('verify-otp: akun lama -> login (isNewUser=false)', async () => {
  fake.on(/select code_hash, attempts/, mkOtpRow('budi@gmail.com', '123456'));
  fake.on(/insert into users/, []); // on conflict do nothing
  fake.on(/select \* from users where email/, [{ id: UID, email: 'budi@gmail.com', username: 'budi' }]);
  const r = await call('POST', '/api/auth/verify-otp', { body: { email: 'budi@gmail.com', code: '123456' } });
  assert.equal(r.body.isNewUser, false);
  assert.equal(r.body.needsUsername, false);
});
test('verify-otp: kode salah menambah percobaan', async () => {
  fake.on(/select code_hash, attempts/, mkOtpRow('budi@gmail.com', '123456'));
  const r = await call('POST', '/api/auth/verify-otp', { body: { email: 'budi@gmail.com', code: '999999' } });
  assert.equal(r.status, 400);
  assert.equal(fake.ran(/attempts = attempts \+ 1/).length, 1);
  assert.equal(fake.ran(/insert into users/).length, 0);
});
test('verify-otp: kedaluwarsa & kebanyakan percobaan', async () => {
  fake.on(/select code_hash, attempts/, mkOtpRow('a@gmail.com', '123456', { expired: true }));
  assert.equal((await call('POST', '/api/auth/verify-otp', { body: { email: 'a@gmail.com', code: '123456' } })).status, 400);
  fake.reset();
  fake.on(/select code_hash, attempts/, mkOtpRow('a@gmail.com', '123456', { attempts: 5 }));
  assert.equal((await call('POST', '/api/auth/verify-otp', { body: { email: 'a@gmail.com', code: '123456' } })).status, 429);
});
test('verify-otp: kode harus 6 angka', async () => {
  assert.equal((await call('POST', '/api/auth/verify-otp', { body: { email: 'a@gmail.com', code: 'abcdef' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/verify-otp', { body: { email: 'a@gmail.com', code: '123' } })).status, 400);
});

/* ───────────── logout = hapus akun ───────────── */
test('logout wajib konfirmasi', async () => {
  loginAs();
  assert.equal((await call('POST', '/api/auth/logout', { uid: UID, body: {} })).status, 400);
  assert.equal(fake.ran(/delete from users/).length, 0);
});
test('logout menghapus akun, data, dan media Blob', async () => {
  loginAs();
  fake.on(/select url from media_objects/, [{ url: 'https://blob.test/a.bin' }, { url: 'https://blob.test/b.bin' }]);
  fake.on(/select conversation_id from conversation_members where user_id/, [{ conversation_id: CID }]);
  const r = await call('POST', '/api/auth/logout', { uid: UID, body: { confirm: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.deleted, true);
  assert.equal(fake.ran(/delete from users/).length, 1);
  assert.equal(fake.ran(/delete from conversations c/).length, 1, 'chat yang tinggal sendirian dibersihkan');
  assert.deepEqual(blob.deleted, ['https://blob.test/a.bin', 'https://blob.test/b.bin']);
});
test('DELETE /me sama dengan logout', async () => {
  loginAs();
  assert.equal((await call('DELETE', '/api/me', { uid: UID, body: { confirm: true } })).status, 200);
  assert.equal(fake.ran(/delete from users/).length, 1);
});

/* ───────────── profil, username, cari ───────────── */
test('username: reserved & format & dipakai orang lain', async () => {
  loginAs();
  assert.equal((await call('POST', '/api/me/username', { uid: UID, body: { username: 'admin' } })).status, 409);
  assert.equal((await call('POST', '/api/me/username', { uid: UID, body: { username: 'a!' } })).status, 400);
  fake.on(/update users set username/, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
  assert.equal((await call('POST', '/api/me/username', { uid: UID, body: { username: 'budi' } })).status, 409);
});
test('username: berhasil disimpan huruf kecil tanpa @', async () => {
  loginAs();
  fake.on(/update users set username/, (v) => [{ id: UID, username: v[0] }]);
  const r = await call('POST', '/api/me/username', { uid: UID, body: { username: '@Budi_Keren' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.username, 'budi_keren');
});
test('public key harus 32 byte X25519', async () => {
  loginAs();
  assert.equal((await call('PUT', '/api/me/keys', { uid: UID, body: { publicKey: 'AAAA' } })).status, 400);
  const ok = Buffer.alloc(32, 7).toString('base64url');
  fake.on(/update users set public_key/, [{ id: UID, public_key: ok }]);
  assert.equal((await call('PUT', '/api/me/keys', { uid: UID, body: { publicKey: ok } })).status, 200);
});
test('cari @username: terlalu pendek kosong, normal pakai starts_with', async () => {
  loginAs();
  assert.deepEqual((await call('GET', '/api/users/search?q=a', { uid: UID })).body.users, []);
  fake.on(/starts_with/, [{ id: UID2, username: 'budi', display_name: 'Budi', avatar_emoji: '😎', avatar_color: '#FFD43B', public_key: K2 }]);
  const r = await call('GET', '/api/users/search?q=%40Bu%25', { uid: UID });
  assert.equal(r.body.users[0].username, 'budi');
  assert.equal(fake.ran(/starts_with/)[0].values[0], 'bu', 'karakter aneh dibuang, tanpa LIKE wildcard');
  assert.ok(!('email' in r.body.users[0]), 'email tidak boleh bocor');
});
test('profil pengguna: privasi terakhir dilihat & blokir', async () => {
  loginAs();
  const base = { id: UID2, username: 'budi', display_name: 'Budi', about: '', avatar_emoji: '😎', avatar_color: '#FFD43B',
    public_key: K2, online: true, last_seen_at: new Date(), show_last_seen: true, blocked_by_me: false, blocked_me: false };
  fake.on(/where u.username = /, [base]);
  let r = await call('GET', '/api/users/budi', { uid: UID });
  assert.equal(r.body.online, true);
  assert.ok(r.body.lastSeenAt);
  fake.reset(); loginAs();
  fake.on(/where u.username = /, [{ ...base, show_last_seen: false }]);
  r = await call('GET', '/api/users/budi', { uid: UID });
  assert.equal(r.body.lastSeenAt, null);
  fake.reset(); loginAs();
  fake.on(/where u.username = /, [{ ...base, blocked_me: true }]);
  r = await call('GET', '/api/users/budi', { uid: UID });
  assert.equal(r.body.online, false);
  assert.equal(r.body.lastSeenAt, null);
  assert.equal(r.body.blockedMe, true);
});
test('blokir: tidak bisa blokir diri sendiri', async () => {
  loginAs();
  assert.equal((await call('POST', '/api/blocks', { uid: UID, body: { userId: UID } })).status, 400);
  fake.on(/select id from users where id/, [{ id: UID2 }]);
  assert.equal((await call('POST', '/api/blocks', { uid: UID, body: { userId: UID2 } })).status, 200);
  assert.equal(fake.ran(/insert into blocks/).length, 1);
});

/* ───────────── percakapan ───────────── */
const convRow = { id: CID, kind: 'direct', title: null, icon_emoji: '👥', icon_color: '#4DABF7', ttl_seconds: null,
  created_at: new Date(), updated_at: new Date(), role: 'member', pinned: false, archived: false, muted: false,
  unread: 2, lm_id: null };
test('buat chat pribadi baru', async () => {
  loginAs();
  fake.on(/select id from users where id = \$1::uuid and username is not null/, [{ id: UID2 }]);
  fake.on(/with c as \(/, [{ id: CID }]);
  fake.on(/from conversation_members cm\s+join conversations c/, [convRow]);
  fake.on(/select cm.conversation_id, cm.role, u.id/, [
    { conversation_id: CID, role: 'member', id: UID, username: 'aku' },
    { conversation_id: CID, role: 'member', id: UID2, username: 'budi', online: true },
  ]);
  const r = await call('POST', '/api/conversations', { uid: UID, body: { kind: 'direct', userId: UID2 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, true);
  assert.equal(r.body.conversation.unread, 2);
  assert.equal(r.body.conversation.members.length, 2);
  const key = fake.ran(/with c as \(/)[0].values.find((x) => typeof x === 'string' && x.includes(':'));
  assert.equal(key, [UID, UID2].sort().join(':'), 'direct_key terurut supaya tidak dobel');
});
test('chat pribadi: diri sendiri 400, diblokir 403, sudah ada -> dipakai ulang', async () => {
  loginAs();
  assert.equal((await call('POST', '/api/conversations', { uid: UID, body: { kind: 'direct', userId: UID } })).status, 400);
  fake.on(/select id from users where id = \$1::uuid and username is not null/, [{ id: UID2 }]);
  fake.on(/from blocks/, [{ x: 1 }]);
  assert.equal((await call('POST', '/api/conversations', { uid: UID, body: { kind: 'direct', userId: UID2 } })).status, 403);
  fake.reset(); loginAs();
  fake.on(/select id from users where id = \$1::uuid and username is not null/, [{ id: UID2 }]);
  fake.on(/with c as \(/, []);
  fake.on(/select id from conversations where direct_key/, [{ id: CID }]);
  fake.on(/from conversation_members cm\s+join conversations c/, [convRow]);
  const r = await call('POST', '/api/conversations', { uid: UID, body: { kind: 'direct', userId: UID2 } });
  assert.equal(r.body.created, false);
  assert.equal(fake.ran(/update conversation_members set hidden = false/).length, 1);
});
test('buat grup: validasi anggota & blokir', async () => {
  loginAs();
  assert.equal((await call('POST', '/api/conversations', { uid: UID, body: { kind: 'group', title: 'Geng', memberIds: [] } })).status, 400);
  assert.equal((await call('POST', '/api/conversations', { uid: UID, body: { kind: 'group', title: '', memberIds: [UID2] } })).status, 400);
  fake.on(/select id from users where id = any/, [{ id: UID2 }]);
  fake.on(/from blocks/, [{ x: 1 }]);
  assert.equal((await call('POST', '/api/conversations', { uid: UID, body: { kind: 'group', title: 'Geng', memberIds: [UID2] } })).status, 403);
});
test('buat grup berhasil: pembuat jadi owner', async () => {
  loginAs();
  fake.on(/select id from users where id = any/, [{ id: UID2 }]);
  fake.on(/from conversation_members cm\s+join conversations c/, [{ ...convRow, kind: 'group', title: 'Geng', role: 'owner' }]);
  const r = await call('POST', '/api/conversations', { uid: UID, body: { kind: 'group', title: 'Geng', memberIds: [UID2, UID2, UID] } });
  assert.equal(r.status, 201);
  const members = fake.ran(/insert into conversation_members/)[0];
  assert.deepEqual(members.values.find((x) => Array.isArray(x)), [UID, UID2], 'duplikat & diri sendiri dibuang');
});
test('hapus chat = sembunyikan + bersihkan riwayat untuk saya saja', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  assert.equal((await call('DELETE', `/api/conversations/${CID}`, { uid: UID })).status, 200);
  const q = fake.ran(/set hidden = true/)[0];
  assert.ok(/cleared_at = now\(\)/.test(q.text));
  assert.equal(fake.ran(/delete from messages/).length, 0, 'pesan lawan bicara tidak dihapus');
});
test('bukan anggota -> 403', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, []);
  assert.equal((await call('GET', `/api/conversations/${CID}/messages`, { uid: UID })).status, 403);
  assert.equal((await call('POST', `/api/conversations/${CID}/typing`, { uid: UID })).status, 403);
});
test('pesan hilang otomatis: hanya pilihan yang diizinkan', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  fake.on(/from conversation_members cm\s+join conversations c/, [convRow]);
  assert.equal((await call('PATCH', `/api/conversations/${CID}`, { uid: UID, body: { ttlSeconds: 123 } })).status, 400);
  assert.equal((await call('PATCH', `/api/conversations/${CID}`, { uid: UID, body: { ttlSeconds: 86400 } })).status, 200);
  assert.equal((await call('PATCH', `/api/conversations/${CID}`, { uid: UID, body: { ttlSeconds: null } })).status, 200);
});
test('info grup hanya boleh diubah admin; chat pribadi tak punya nama', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'group' }]);
  assert.equal((await call('PATCH', `/api/conversations/${CID}`, { uid: UID, body: { title: 'Baru' } })).status, 403);
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  assert.equal((await call('PATCH', `/api/conversations/${CID}`, { uid: UID, body: { title: 'Baru' } })).status, 400);
});
test('tandai dibaca: centang biru dikirim hanya jika read_receipts aktif', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  fake.on(/select read_receipts from users/, [{ read_receipts: true }]);
  await call('POST', `/api/conversations/${CID}/read`, { uid: UID });
  assert.equal(fake.ran(/insert into message_receipts/).length, 1);
  fake.reset(); loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  fake.on(/select read_receipts from users/, [{ read_receipts: false }]);
  await call('POST', `/api/conversations/${CID}/read`, { uid: UID });
  assert.equal(fake.ran(/insert into message_receipts/).length, 0, 'tetap centang dua abu-abu');
  assert.equal(fake.ran(/set last_read_at/).length, 1, 'badge belum dibaca tetap hilang');
});

/* ───────────── kirim pesan E2EE ───────────── */
function setupSend(opts: { ttl?: number | null; kind?: string; blocked?: boolean } = {}) {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: opts.kind ?? 'direct', ttl_seconds: opts.ttl ?? null }]);
  fake.on(/select cm.user_id, u.public_key/, [{ user_id: UID, public_key: K1 }, { user_id: UID2, public_key: K2 }]);
  if (opts.blocked) fake.on(/from blocks/, [{ x: 1 }]);
}
const sendBody = (over: object = {}) => ({
  kind: 'text', ciphertext: 'Q0lQSEVS', nonce: 'Tk9OQ0U=', senderKey: K1,
  keys: [
    { userId: UID, publicKey: K1, wrappedKey: 'V1JBUF9TRUxG', wrapNonce: 'bjE=' },
    { userId: UID2, publicKey: K2, wrappedKey: 'V1JBUF9QRUVS', wrapNonce: 'bjI=' },
  ], ...over,
});
test('kirim pesan: tersimpan sebagai ciphertext, status awal ✓ (sent), event ke penerima', async () => {
  setupSend();
  const r = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody() });
  assert.equal(r.status, 201);
  assert.equal(r.body.message.status, 'sent');
  assert.equal(r.body.message.wrappedKey, 'V1JBUF9TRUxG', 'pengirim menerima kunci miliknya sendiri');
  const insMsg = fake.ran(/insert into messages/)[0];
  assert.ok(insMsg.values.includes('Q0lQSEVS'));
  const ev = fake.ran(/'message.new'/)[0];
  assert.deepEqual(ev.values[0], [UID2], 'event hanya untuk penerima, bukan pengirim');
  const payload = JSON.parse(ev.values[1][0]);
  assert.equal(payload.message.wrappedKey, 'V1JBUF9QRUVS', 'tiap penerima hanya dapat kunci miliknya');
  assert.ok(!JSON.stringify(payload).includes('V1JBUF9TRUxG'), 'kunci pengirim tidak bocor ke penerima');
  assert.equal(fake.ran(/set hidden = false/).length, 1, 'chat yang dihapus muncul lagi');
});
test('kirim pesan: kunci publik penerima berubah -> 409 stale_keys + kunci terbaru', async () => {
  setupSend();
  const body = sendBody();
  body.keys[1].publicKey = 'C'.repeat(43);
  const r = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'stale_keys');
  assert.deepEqual(r.body.members.find((m: any) => m.id === UID2), { id: UID2, publicKey: K2 });
  assert.equal(fake.ran(/insert into messages/).length, 0);
});
test('kirim pesan: kunci untuk anggota kurang / senderKey salah -> 409', async () => {
  setupSend();
  const b1 = sendBody(); b1.keys = b1.keys.slice(0, 1);
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: b1 })).status, 409);
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ senderKey: K2 }) })).status, 409);
});
test('kirim pesan: diblokir -> 403', async () => {
  setupSend({ blocked: true });
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody() })).status, 403);
  assert.equal(fake.ran(/insert into messages/).length, 0);
});
test('kirim pesan: validasi input', async () => {
  setupSend();
  for (const bad of [{ ciphertext: '' }, { ciphertext: 'tidak valid!' }, { kind: 'gif' }, { keys: 'x' }, { nonce: undefined }]) {
    assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody(bad) })).status, 400, JSON.stringify(bad));
  }
});
test('kirim pesan: pesan hilang otomatis mengisi expires_at', async () => {
  setupSend({ ttl: 86400 });
  await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody() });
  const exp = fake.ran(/insert into messages/)[0].values.find((x) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && x !== null);
  assert.ok(exp);
  const msg = fake.ran(/insert into messages/)[0].values.filter((x) => typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x));
  const diff = new Date(msg[0]).getTime() - new Date(msg[1]).getTime();
  assert.ok(Math.abs(diff - 86_400_000) < 5, 'expires_at = created_at + 24 jam');
});
test('kirim pesan: anggota tanpa public key -> 409 member_no_key', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct', ttl_seconds: null }]);
  fake.on(/select cm.user_id, u.public_key/, [{ user_id: UID, public_key: K1 }, { user_id: UID2, public_key: null }]);
  const r = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody() });
  assert.equal(r.body.code, 'member_no_key');
});
test('kirim ke grup: semua anggota wajib punya kunci', async () => {
  loginAs();
  const U3 = '55555555-5555-4555-8555-555555555555';
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'group', ttl_seconds: null }]);
  fake.on(/select cm.user_id, u.public_key/, [
    { user_id: UID, public_key: K1 }, { user_id: UID2, public_key: K2 }, { user_id: U3, public_key: 'D'.repeat(43) }]);
  const r = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody() });
  assert.equal(r.status, 409, 'anggota ke-3 tidak punya kunci terbungkus');
  const ok = sendBody();
  ok.keys.push({ userId: U3, publicKey: 'D'.repeat(43), wrappedKey: 'V1JBUF9UMw==', wrapNonce: 'bjM=' });
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: ok })).status, 201);
  const ev = fake.ran(/'message.new'/)[0];
  assert.deepEqual(ev.values[0], [UID2, U3]);
  assert.equal(fake.ran(/from blocks/).length, 0, 'grup tidak memeriksa blokir 1-1');
});

/* ───────────── riwayat, edit, hapus, reaksi ───────────── */
test('riwayat: 3 status centang dihitung dari receipts', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  const base = { conversation_id: CID, kind: 'text', ciphertext: 'c', nonce: 'n', sender_key: K1, created_at: new Date(), reactions: [] };
  fake.on(/from messages m\s+join conversation_members cm/, [
    { ...base, id: 'm3', sender_id: UID, n_others: 1, n_delivered: 1, n_read: 1 },
    { ...base, id: 'm2', sender_id: UID, n_others: 1, n_delivered: 1, n_read: 0 },
    { ...base, id: 'm1', sender_id: UID, n_others: 1, n_delivered: 0, n_read: 0 },
  ]);
  const r = await call('GET', `/api/conversations/${CID}/messages?limit=3`, { uid: UID });
  assert.deepEqual(r.body.messages.map((m: any) => m.status), ['sent', 'delivered', 'read'], 'urut lama -> baru');
  assert.equal(r.body.hasMore, true);
  assert.equal((await call('GET', `/api/conversations/${CID}/messages?before=bukan-tanggal`, { uid: UID })).status, 400);
});
function setupMsg(senderId: string, extra: object = {}) {
  loginAs();
  fake.on(/select id, conversation_id, sender_id, kind, created_at, deleted_at/, [
    { id: MSG, conversation_id: CID, sender_id: senderId, kind: 'text', created_at: new Date(), deleted_at: null, ...extra }]);
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
}
test('edit: hanya pengirim, hanya teks, maksimal 15 menit', async () => {
  const body = { ciphertext: 'QkFSVQ==', nonce: 'bm4=' };
  setupMsg(UID2);
  assert.equal((await call('PATCH', `/api/messages/${MSG}`, { uid: UID, body })).status, 403);
  fake.reset(); setupMsg(UID, { kind: 'image' });
  assert.equal((await call('PATCH', `/api/messages/${MSG}`, { uid: UID, body })).status, 400);
  fake.reset(); setupMsg(UID, { created_at: new Date(Date.now() - 16 * 60_000) });
  assert.equal((await call('PATCH', `/api/messages/${MSG}`, { uid: UID, body })).status, 400);
  fake.reset(); setupMsg(UID);
  fake.on(/update messages set ciphertext/, [{ edited_at: new Date() }]);
  assert.equal((await call('PATCH', `/api/messages/${MSG}`, { uid: UID, body })).status, 200);
  assert.equal(fake.events('message.edit').length, 1);
});
test('hapus untuk saya vs untuk semua', async () => {
  setupMsg(UID2);
  assert.equal((await call('DELETE', `/api/messages/${MSG}?scope=me`, { uid: UID })).status, 200);
  assert.equal(fake.ran(/insert into message_hidden/).length, 1);
  assert.equal(fake.ran(/deleted_at = now\(\)/).length, 0);
  assert.equal((await call('DELETE', `/api/messages/${MSG}?scope=all`, { uid: UID })).status, 403, 'bukan pengirim');
  assert.equal((await call('DELETE', `/api/messages/${MSG}?scope=xx`, { uid: UID })).status, 400);
});
test('hapus untuk semua: kosongkan isi, buang kunci, buang foto', async () => {
  setupMsg(UID);
  fake.on(/delete from media_objects/, [{ url: 'https://blob.test/foto.bin' }]);
  const mid = '66666666-6666-4666-8666-666666666666';
  const r = await call('DELETE', `/api/messages/${MSG}?scope=all&mediaId=${mid}`, { uid: UID });
  assert.equal(r.status, 200);
  assert.equal(fake.ran(/delete from message_keys/).length, 1);
  assert.equal(fake.events('message.delete').length, 1);
  assert.deepEqual(blob.deleted, ['https://blob.test/foto.bin']);
});
test('reaksi: set & hapus', async () => {
  setupMsg(UID2);
  fake.on(/from message_reactions where message_id/, [{ userId: UID, emoji: '🔥' }]);
  let r = await call('POST', `/api/messages/${MSG}/reaction`, { uid: UID, body: { emoji: '🔥' } });
  assert.equal(r.body.reactions[0].emoji, '🔥');
  assert.equal(fake.ran(/insert into message_reactions/).length, 1);
  r = await call('POST', `/api/messages/${MSG}/reaction`, { uid: UID, body: { emoji: null } });
  assert.equal(fake.ran(/delete from message_reactions where message_id = \$1::uuid and user_id/).length, 1);
});
test('bintang', async () => {
  setupMsg(UID2);
  assert.equal((await call('POST', `/api/messages/${MSG}/star`, { uid: UID, body: { starred: true } })).status, 200);
  assert.equal((await call('POST', `/api/messages/${MSG}/star`, { uid: UID, body: { starred: 'ya' } })).status, 400);
});

/* ───────────── polling / sync ───────────── */
test('events/cursor: tandai pesan tertunda terkirim lalu beri kursor', async () => {
  loginAs();
  fake.on(/select coalesce\(max\(id\), 0\)/, [{ cursor: '42' }]);
  const r = await call('GET', '/api/events/cursor', { uid: UID });
  assert.equal(r.body.cursor, 42);
  assert.equal(fake.ran(/insert into message_receipts/).length, 1);
});
test('events: ack kursor lama, kembalikan event baru, typing, tandai terkirim', async () => {
  loginAs();
  const MID = '77777777-7777-4777-8777-777777777777';
  fake.on(/select id, type, payload, created_at from events/, [
    { id: '6', type: 'message.new', payload: { message: { id: MID } }, created_at: new Date() },
    { id: '7', type: 'receipt', payload: { messageId: 'x' }, created_at: new Date() }]);
  fake.on(/typing_at > now/, [{ conversation_id: CID, user_id: UID2 }]);
  const r = await call('GET', '/api/events?after=5', { uid: UID });
  assert.equal(r.status, 200);
  assert.equal(r.body.cursor, 7);
  assert.equal(r.body.events.length, 2);
  assert.deepEqual(r.body.typing, { [CID]: [UID2] });
  assert.equal(r.body.presence, undefined);
  assert.equal(fake.ran(/delete from events/)[0].values[1], 5, 'event lama di-ack');
  assert.deepEqual(fake.ran(/insert into message_receipts/)[0].values[1], [MID]);
});
test('events: tanpa event kursor tetap; presence=1 menambah presence', async () => {
  loginAs();
  fake.on(/from conversation_members a\s+join conversations c/, [{ id: UID2, online: true, last_seen_at: null }]);
  const r = await call('GET', '/api/events?after=9&presence=1', { uid: UID });
  assert.equal(r.body.cursor, 9);
  assert.deepEqual(r.body.presence, [{ userId: UID2, online: true, lastSeenAt: null }]);
  assert.equal(fake.ran(/insert into message_receipts/).length, 0);
});

/* ───────────── status ───────────── */
const stBody = (over: object = {}) => ({
  ciphertext: 'U1RBVFVT', nonce: 'bm4=', senderKey: K1,
  keys: [{ userId: UID, publicKey: K1, wrappedKey: 'a2V5', wrapNonce: 'bg==' },
         { userId: UID2, publicKey: K2, wrappedKey: 'a2V5Mg==', wrapNonce: 'bg==' }], ...over });
function setupStatus() {
  loginAs();
  fake.on(/select public_key from users where id/, [{ public_key: K1 }]);
  fake.on(/from conversation_members a\s+join conversations c/, [{ id: UID2, public_key: K2 }]);
  fake.on(/select created_at, expires_at from statuses/, [{ created_at: new Date(), expires_at: new Date() }]);
}
test('status: hanya untuk kontak dengan kunci terbaru', async () => {
  setupStatus();
  assert.equal((await call('POST', '/api/statuses', { uid: UID, body: stBody() })).status, 201);
  assert.deepEqual(fake.events('status.new')[0].values[2], [UID2], 'hanya kontak yang diberi tahu');
  const stranger = '88888888-8888-4888-8888-888888888888';
  const b = stBody(); b.keys.push({ userId: stranger, publicKey: K2, wrappedKey: 'a2V5', wrapNonce: 'bg==' });
  assert.equal((await call('POST', '/api/statuses', { uid: UID, body: b })).status, 403, 'orang asing tidak boleh melihat');
  const stale = stBody(); stale.keys[1].publicKey = 'E'.repeat(43);
  assert.equal((await call('POST', '/api/statuses', { uid: UID, body: stale })).status, 409);
  const noSelf = stBody(); noSelf.keys = noSelf.keys.slice(1);
  assert.equal((await call('POST', '/api/statuses', { uid: UID, body: noSelf })).status, 400);
});
test('status: daftar penonton hanya untuk pemilik', async () => {
  loginAs();
  const SID = '99999999-9999-4999-8999-999999999999';
  fake.on(/select user_id from statuses where id/, [{ user_id: UID2 }]);
  assert.equal((await call('GET', `/api/statuses/${SID}/views`, { uid: UID })).status, 403);
});

/* ───────────── panggilan ───────────── */
test('panggilan: hanya chat pribadi, tolak jika sibuk / diblokir', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'group' }]);
  assert.equal((await call('POST', '/api/calls', { uid: UID, body: { conversationId: CID, kind: 'voice' } })).status, 400);
  fake.reset(); loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  fake.on(/select user_id from conversation_members where conversation_id/, [{ user_id: UID2 }]);
  fake.on(/status = 'ringing' and created_at/, [{ x: 1 }]);
  const busy = await call('POST', '/api/calls', { uid: UID, body: { conversationId: CID, kind: 'video' } });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'busy');
});
test('panggilan: mulai -> event call.incoming ke penerima + ICE servers', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  fake.on(/select user_id from conversation_members where conversation_id/, [{ user_id: UID2 }]);
  fake.on(/insert into calls/, [{ id: 'call-1' }]);
  fake.on(/select \* from users where id/, [{ id: UID, username: 'aku' }]);
  const r = await call('POST', '/api/calls', { uid: UID, body: { conversationId: CID, kind: 'video' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.callId, 'call-1');
  assert.ok(r.body.iceServers[0].urls[0].startsWith('stun:'));
  const ev = fake.events('call.incoming')[0];
  assert.deepEqual(ev.values[2], [UID2]);
});
const CALL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('panggilan: sinyal hanya antar peserta; hanya callee yang bisa menjawab', async () => {
  loginAs(UID2);
  fake.on(/select \* from calls where id/, [{ id: CALL, caller_id: UID, callee_id: UID2, status: 'ringing' }]);
  const sig = await call('POST', `/api/calls/${CALL}/signal`, { uid: UID2, body: { type: 'answer', data: 'ZW5jcnlwdGVk' } });
  assert.equal(sig.status, 200);
  assert.deepEqual(fake.events('call.signal')[0].values[2], [UID], 'sinyal diteruskan ke lawan, bukan ke diri sendiri');
  assert.equal((await call('POST', `/api/calls/${CALL}/signal`, { uid: UID2, body: { type: 'hack', data: 'x' } })).status, 400);
  fake.reset(); loginAs(UID);
  fake.on(/select \* from calls where id/, [{ id: CALL, caller_id: UID, callee_id: UID2, status: 'ringing' }]);
  assert.equal((await call('POST', `/api/calls/${CALL}/accept`, { uid: UID })).status, 403, 'penelepon tidak bisa menjawab panggilannya sendiri');
});
test('panggilan: caller timeout -> missed; hangup saat tersambung -> ended', async () => {
  loginAs(UID);
  fake.on(/select \* from calls where id/, [{ id: CALL, caller_id: UID, callee_id: UID2, status: 'ringing' }]);
  assert.equal((await call('POST', `/api/calls/${CALL}/end`, { uid: UID, body: { reason: 'timeout' } })).body.status, 'missed');
  fake.reset(); loginAs(UID);
  fake.on(/select \* from calls where id/, [{ id: CALL, caller_id: UID, callee_id: UID2, status: 'answered' }]);
  assert.equal((await call('POST', `/api/calls/${CALL}/end`, { uid: UID, body: {} })).body.status, 'ended');
});
test('panggilan: ICE server TURN dari environment', async () => {
  process.env.TURN_URLS = 'turn:t.test:3478';
  process.env.TURN_USERNAME = 'u'; process.env.TURN_CREDENTIAL = 'p';
  loginAs();
  const r = await call('GET', '/api/calls/ice', { uid: UID });
  delete process.env.TURN_URLS;
  assert.equal(r.body.iceServers.length, 2);
  assert.equal(r.body.iceServers[1].credential, 'p');
});

/* ───────────── media & cron ───────────── */
test('media: upload terenkripsi, batas ukuran, tujuan', async () => {
  loginAs();
  const ok = await call('POST', '/api/media?purpose=status', { uid: UID, raw: Buffer.alloc(200, 1) });
  assert.equal(ok.status, 201);
  assert.ok(blob.puts[0].startsWith(`media/${UID}/`));
  assert.equal(ok.body.expiresInHours, 25);
  assert.equal((await call('POST', '/api/media', { uid: UID, raw: Buffer.alloc(5) })).status, 400);
  assert.equal((await call('POST', '/api/media', { uid: UID, raw: Buffer.alloc(4 * 1024 * 1024 + 1) })).status, 413);
  assert.equal((await call('POST', '/api/media?purpose=iklan', { uid: UID, raw: Buffer.alloc(200) })).status, 400);
});
test('cron purge butuh CRON_SECRET', async () => {
  assert.equal((await call('GET', '/api/cron/purge')).status, 401);
  assert.equal((await call('GET', '/api/cron/purge', { headers: { authorization: 'Bearer salah' } })).status, 401);
  fake.on(/select id, url from media_objects/, [{ id: 'm1', url: 'https://blob.test/x' }]);
  fake.on(/delete from messages where expires_at/, [{ n: 3 }]);
  const r = await call('GET', '/api/cron/purge', { headers: { authorization: 'Bearer cron-secret' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.purged.media, 1);
  assert.equal(r.body.purged.messages, 3);
  assert.deepEqual(blob.deleted, ['https://blob.test/x']);
});
test('halaman salin kode', async () => {
  const r = await call('GET', '/api/salin?kode=482915');
  assert.equal(r.status, 200);
  assert.ok(r.headers['content-type'].startsWith('text/html'));
  assert.ok(r.text.includes('482915'));
});

/* ───────────── jenis pesan baru: video, audio, dokumen, stiker, polling ───────────── */
test('kirim berbagai jenis pesan', async () => {
  for (const kind of ['image', 'video', 'audio', 'document', 'sticker', 'poll']) {
    fake.reset(); setupSend();
    const r = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind }) });
    assert.equal(r.status, 201, kind);
    assert.equal(r.body.message.kind, kind);
  }
  fake.reset(); setupSend();
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind: 'gif' }) })).status, 400);
});
test('polling: suara wajib menunjuk ke pesan poll yang aktif', async () => {
  setupSend();
  const POLL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind: 'vote' }) })).status, 400, 'tanpa replyTo');
  fake.on(/select kind, deleted_at from messages where id/, [{ kind: 'text', deleted_at: null }]);
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind: 'vote', replyTo: POLL }) })).status, 400, 'bukan poll');
  fake.on(/select kind, deleted_at from messages where id/, [{ kind: 'poll', deleted_at: new Date() }]);
  assert.equal((await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind: 'vote', replyTo: POLL }) })).status, 400, 'poll sudah dihapus');
  fake.on(/select kind, deleted_at from messages where id/, [{ kind: 'poll', deleted_at: null }]);
  const ok = await call('POST', `/api/conversations/${CID}/messages`, { uid: UID, body: sendBody({ kind: 'vote', replyTo: POLL }) });
  assert.equal(ok.status, 201);
  const bump = fake.ran(/update conversations set updated_at/)[0];
  assert.ok(bump.values.includes(true), 'suara tidak menaikkan chat ke atas');
});
test('polling: daftar suara terbaru per orang, hanya untuk pesan poll', async () => {
  setupMsg(UID2, { kind: 'text' });
  assert.equal((await call('GET', `/api/messages/${MSG}/votes`, { uid: UID })).status, 400);
  fake.reset(); setupMsg(UID2, { kind: 'poll' });
  fake.on(/select distinct on \(m.sender_id\)/, [
    { id: 'v1', conversation_id: CID, sender_id: UID2, kind: 'vote', ciphertext: 'c', nonce: 'n', sender_key: K2,
      reply_to: MSG, created_at: new Date(), wrapped_key: 'w', wrap_nonce: 'x', starred: false, reactions: [],
      n_others: 0, n_delivered: 0, n_read: 0 }]);
  const r = await call('GET', `/api/messages/${MSG}/votes`, { uid: UID });
  assert.equal(r.status, 200);
  assert.equal(r.body.votes.length, 1);
  assert.equal(r.body.votes[0].kind, 'vote');
  assert.ok(/order by m.sender_id, m.created_at desc/.test(fake.ran(/distinct on/)[0].text));
});
test('suara polling tidak muncul di riwayat, badge, maupun pesan terakhir', async () => {
  loginAs();
  fake.on(/select cm.role, cm.joined_at/, [{ role: 'member', kind: 'direct' }]);
  await call('GET', `/api/conversations/${CID}/messages`, { uid: UID });
  assert.ok(/m\.kind <> 'vote'/.test(fake.ran(/from messages m\s+join conversation_members cm/)[0].text), 'riwayat');
  fake.reset(); loginAs();
  await call('GET', '/api/conversations', { uid: UID });
  const q = fake.ran(/from conversation_members cm\s+join conversations c/)[0].text;
  assert.equal((q.match(/m\.kind <> 'vote'/g) ?? []).length, 2, 'unread + pesan terakhir');
});

/* ───────────── media berpotongan & kuota ───────────── */
test('media: kuota penyimpanan', async () => {
  loginAs();
  fake.on(/sum\(size_bytes\)/, [{ total: String(300 * 1024 * 1024 - 100) }]);
  const r = await call('POST', '/api/media', { uid: UID, raw: Buffer.alloc(500, 1) });
  assert.equal(r.status, 413);
  assert.equal(blob.puts.length, 0);
});
test('media: tujuan channel disimpan 180 hari; usage', async () => {
  loginAs();
  const ok = await call('POST', '/api/media?purpose=channel', { uid: UID, raw: Buffer.alloc(100, 1) });
  assert.equal(ok.body.expiresInHours, 24 * 180);
  fake.on(/as files/, [{ total: '2048', files: 2 }]);
  const u = await call('GET', '/api/media/usage', { uid: UID });
  assert.equal(u.body.usedBytes, 2048);
  assert.equal(u.body.quotaBytes, 300 * 1024 * 1024);
});
test('hapus pesan untuk semua: banyak potongan media sekaligus', async () => {
  setupMsg(UID);
  fake.on(/delete from media_objects/, [{ url: 'https://blob.test/1' }, { url: 'https://blob.test/2' }]);
  const a = '66666666-6666-4666-8666-666666666666';
  const b = '77777777-7777-4777-8777-777777777777';
  const r = await call('DELETE', `/api/messages/${MSG}?scope=all&mediaIds=${a},${b},bukan-uuid`, { uid: UID });
  assert.equal(r.status, 200);
  assert.deepEqual(fake.ran(/delete from media_objects/)[0].values[0], [a, b], 'id tidak valid dibuang');
  assert.deepEqual(blob.deleted, ['https://blob.test/1', 'https://blob.test/2']);
});

/* ───────────── channel ───────────── */
const CH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const chRow = (over: object = {}) => ({ id: CH, owner_id: UID, name: 'Berita Komik', handle: 'komik', description: '', icon_emoji: '📢',
  icon_color: '#FF6B6B', created_at: new Date(), follower_count: 3, is_following: false, unread: 0, lp_id: null, ...over });
test('channel: buat, validasi handle, batas 5, handle dobel', async () => {
  loginAs();
  fake.on(/select count\(\*\)::int as n from channels/, [{ n: 0 }]);
  fake.on(/insert into channels/, [{ id: CH }]);
  fake.on(/from channels c\s+left join lateral/, [chRow()]);
  const r = await call('POST', '/api/channels', { uid: UID, body: { name: 'Berita Komik', handle: '@Komik', description: 'halo' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.channel.isOwner, true);
  assert.ok(fake.ran(/insert into channels/)[0].values.includes('komik'), 'handle huruf kecil tanpa @');
  assert.equal((await call('POST', '/api/channels', { uid: UID, body: { name: 'X', handle: 'komik' } })).status, 400, 'nama terlalu pendek');
  assert.equal((await call('POST', '/api/channels', { uid: UID, body: { name: 'Bagus', handle: 'a!' } })).status, 400);
  fake.on(/select count\(\*\)::int as n from channels/, [{ n: 5 }]);
  assert.equal((await call('POST', '/api/channels', { uid: UID, body: { name: 'Keenam' } })).status, 400);
  fake.on(/select count\(\*\)::int as n from channels/, [{ n: 0 }]);
  fake.on(/insert into channels/, () => { throw Object.assign(new Error('dup'), { code: '23505' }); });
  assert.equal((await call('POST', '/api/channels', { uid: UID, body: { name: 'Bagus', handle: 'komik' } })).status, 409);
});
test('channel: daftar saya / diikuti / cari', async () => {
  loginAs();
  fake.on(/from channels c\s+left join lateral/, [chRow({ unread: 4, lp_id: 'p1', lp_kind: 'text', lp_body: 'Halo semua', lp_created_at: new Date() })]);
  const mine = await call('GET', '/api/channels/mine', { uid: UID });
  assert.equal(mine.body.channels[0].unread, 4);
  assert.equal(mine.body.channels[0].lastPost.body, 'Halo semua');
  assert.equal(fake.ran(/from channels c/)[0].values[2], 'mine');
  await call('GET', '/api/channels/following', { uid: UID });
  assert.equal(fake.ran(/from channels c/)[1].values[2], 'following');
  assert.deepEqual((await call('GET', '/api/channels/search?q=k', { uid: UID })).body.channels, []);
  await call('GET', '/api/channels/search?q=%40Komik', { uid: UID });
  const s = fake.ran(/from channels c/)[2];
  assert.equal(s.values[2], 'search');
  assert.ok(s.values.includes('komik'));
});
test('channel: hanya pemilik yang boleh posting, ubah, hapus', async () => {
  loginAs();
  fake.on(/select id, owner_id from channels where id/, [{ id: CH, owner_id: UID2 }]);
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'text', body: 'hai' } })).status, 403);
  assert.equal((await call('PATCH', `/api/channels/${CH}`, { uid: UID, body: { name: 'Baru' } })).status, 403);
  assert.equal((await call('DELETE', `/api/channels/${CH}`, { uid: UID })).status, 403);
  assert.equal(fake.ran(/delete from channels/).length, 0);
  fake.on(/select id, owner_id from channels where id/, []);
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'text', body: 'hai' } })).status, 404);
});
test('channel: posting teks / media divalidasi', async () => {
  loginAs();
  fake.on(/select id, owner_id from channels where id/, [{ id: CH, owner_id: UID }]);
  fake.on(/insert into channel_posts/, [{ id: 'p1', created_at: new Date() }]);
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'text', body: '' } })).status, 400);
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'text', body: 'Halo!' } })).status, 201);
  const media = { urls: ['https://blob.test/a'], size: 1000, mime: 'video/mp4', name: 'a.mp4', durationMs: 5000 };
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'video', body: 'cek', media } })).status, 201);
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'video' } })).status, 400, 'media wajib');
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'image', media: { ...media, urls: ['http://tidak-aman'] } } })).status, 400, 'harus https');
  assert.equal((await call('POST', `/api/channels/${CH}/posts`, { uid: UID, body: { kind: 'story' } })).status, 400);
});
test('channel: ikuti, berhenti, tidak bisa ikuti channel sendiri', async () => {
  loginAs();
  fake.on(/select owner_id from channels where id/, [{ owner_id: UID }]);
  assert.equal((await call('POST', `/api/channels/${CH}/follow`, { uid: UID })).status, 400);
  fake.on(/select owner_id from channels where id/, [{ owner_id: UID2 }]);
  assert.equal((await call('POST', `/api/channels/${CH}/follow`, { uid: UID })).body.following, true);
  assert.equal(fake.ran(/insert into channel_follows/).length, 1);
  assert.equal((await call('DELETE', `/api/channels/${CH}/follow`, { uid: UID })).body.following, false);
  fake.on(/select owner_id from channels where id/, []);
  assert.equal((await call('POST', `/api/channels/${CH}/follow`, { uid: UID })).status, 404);
});
test('channel: baca postingan (publik) dengan paging & reaksi', async () => {
  loginAs();
  fake.on(/select 1 as x from channels where id/, [{ x: 1 }]);
  fake.on(/from channel_posts p\s+where p.channel_id/, [
    { id: 'p2', channel_id: CH, kind: 'text', body: 'dua', media: null, created_at: new Date(), reactions: [{ emoji: '🔥', count: 2 }], my_reaction: '🔥' },
    { id: 'p1', channel_id: CH, kind: 'image', body: '', media: { urls: ['https://blob.test/x'] }, created_at: new Date(), reactions: [], my_reaction: null }]);
  const r = await call('GET', `/api/channels/${CH}/posts?limit=2`, { uid: UID });
  assert.deepEqual(r.body.posts.map((p: any) => p.id), ['p1', 'p2'], 'lama -> baru');
  assert.equal(r.body.hasMore, true);
  assert.equal(r.body.posts[1].myReaction, '🔥');
  assert.equal((await call('GET', `/api/channels/${CH}/posts?before=xx`, { uid: UID })).status, 400);
});
test('channel: reaksi & hapus postingan', async () => {
  loginAs();
  const P = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  fake.on(/select 1 as x from channel_posts where id/, [{ x: 1 }]);
  assert.equal((await call('POST', `/api/channels/${CH}/posts/${P}/reaction`, { uid: UID, body: { emoji: '😂' } })).status, 200);
  assert.equal(fake.ran(/insert into channel_post_reactions/).length, 1);
  await call('POST', `/api/channels/${CH}/posts/${P}/reaction`, { uid: UID, body: { emoji: null } });
  assert.equal(fake.ran(/delete from channel_post_reactions/).length, 1);
  fake.on(/select id, owner_id from channels where id/, [{ id: CH, owner_id: UID }]);
  fake.on(/delete from channel_posts where id/, []);
  assert.equal((await call('DELETE', `/api/channels/${CH}/posts/${P}`, { uid: UID })).status, 404);
  fake.on(/delete from channel_posts where id/, [{ id: P }]);
  assert.equal((await call('DELETE', `/api/channels/${CH}/posts/${P}`, { uid: UID })).status, 200);
});
test('channel: semua endpoint butuh login', async () => {
  for (const [m, p] of [['GET', '/api/channels/search?q=ab'], ['GET', `/api/channels/${CH}/posts`], ['POST', `/api/channels/${CH}/follow`]]) {
    assert.equal((await call(m, p, { uid: null })).status, 401, p);
  }
});

void token;
