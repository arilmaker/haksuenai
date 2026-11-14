import './setup';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signJwt, verifyJwt } from '../src/jwt';
import { hashCode, makeCode, sameHash } from '../src/otp';
import * as v from '../src/validate';
import { Router } from '../src/router';
import { mapMessage, tickStatus } from '../src/presenter';
import { otpEmailHtml, salinPageHtml } from '../src/mail';
import { HttpError } from '../src/http';

const S = 'rahasia-rahasia-rahasia-rahasia';

test('jwt: sign lalu verify mengembalikan sub', () => {
  assert.equal(verifyJwt(signJwt('abc', S), S), 'abc');
});
test('jwt: token yang diubah ditolak', () => {
  const t = signJwt('abc', S).split('.');
  t[1] = Buffer.from(JSON.stringify({ sub: 'hacker', iat: 1, exp: 9999999999 })).toString('base64url');
  assert.equal(verifyJwt(t.join('.'), S), null);
});
test('jwt: secret salah ditolak', () => assert.equal(verifyJwt(signJwt('abc', S), 'lain-lain-lain-lain'), null));
test('jwt: kedaluwarsa ditolak', () => {
  const t = signJwt('abc', S, 60, Date.now() - 120_000);
  assert.equal(verifyJwt(t, S), null);
});
test('jwt: alg none ditolak', () => {
  const e = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = `${e({ alg: 'none', typ: 'JWT' })}.${e({ sub: 'x', exp: 9999999999 })}.`;
  assert.equal(verifyJwt(t, S), null);
});
test('jwt: sampah ditolak', () => {
  for (const t of ['', 'a.b', 'a.b.c', 'x.y.z.w']) assert.equal(verifyJwt(t, S), null);
});

test('otp: kode 6 digit', () => {
  for (let i = 0; i < 200; i++) assert.match(makeCode(), /^[1-9]\d{5}$/);
});
test('otp: hash konsisten & terikat email', () => {
  const a = hashCode('a@x.com', '123456', S);
  assert.equal(a, hashCode('a@x.com', '123456', S));
  assert.notEqual(a, hashCode('b@x.com', '123456', S));
  assert.ok(sameHash(a, a));
  assert.ok(!sameHash(a, hashCode('a@x.com', '123457', S)));
  assert.ok(!sameHash(a, 'zz'));
});

test('validate: username', () => {
  assert.equal(v.username('@Budi_01'), 'budi_01');
  for (const bad of ['ab', 'a b c', 'budi!', 'x'.repeat(21), '']) assert.throws(() => v.username(bad), HttpError);
});
test('validate: email, uuid, int, b64', () => {
  assert.equal(v.email('  Budi@Gmail.COM '), 'budi@gmail.com');
  assert.throws(() => v.email('bukan-email'));
  assert.throws(() => v.uuid('123', 'id'));
  assert.equal(v.int(5, 'n', 1, 10), 5);
  assert.throws(() => v.int(11, 'n', 1, 10));
  assert.throws(() => v.int(1.5, 'n', 1, 10));
  assert.equal(v.b64('abc-_=', 'k', 20), 'abc-_=');
  assert.throws(() => v.b64('a b', 'k', 20));
  assert.throws(() => v.b64('x'.repeat(30), 'k', 20));
});
test('validate: warna & oneOf', () => {
  assert.equal(v.color('#FFD43B'), '#FFD43B');
  assert.throws(() => v.color('kuning'));
  assert.equal(v.oneOf('text', 'k', ['text', 'image'] as const), 'text');
  assert.throws(() => v.oneOf('video', 'k', ['text', 'image'] as const));
});

test('router: route spesifik menang atas yang berparameter', () => {
  const r = new Router();
  r.add('GET', '/users/search', async () => 'search');
  r.add('GET', '/users/:username', async () => 'profile');
  assert.equal(r.match('GET', '/users/search')!.params.username, undefined);
  assert.deepEqual(r.match('GET', '/users/budi')!.params, { username: 'budi' });
  assert.equal(r.match('POST', '/users/budi'), null);
  assert.ok(r.pathExists('/users/budi'));
  assert.ok(!r.pathExists('/tidak/ada'));
});
test('router: parameter di-decode', () => {
  const r = new Router();
  r.add('GET', '/a/:x/b/:y', async () => 1);
  assert.deepEqual(r.match('GET', '/a/h%C3%A9llo/b/2')!.params, { x: 'héllo', y: '2' });
});

test('centang: sent / delivered / read', () => {
  assert.equal(tickStatus(1, 0, 0), 'sent');       // penerima offline -> ✓
  assert.equal(tickStatus(1, 1, 0), 'delivered');  // ✓✓
  assert.equal(tickStatus(1, 1, 1), 'read');       // ✓✓ biru
  assert.equal(tickStatus(3, 3, 2), 'delivered');  // grup: belum semua baca
  assert.equal(tickStatus(3, 2, 0), 'sent');       // grup: belum semua terima
  assert.equal(tickStatus(3, 3, 3), 'read');
  assert.equal(tickStatus(0, 0, 0), 'sent');
});
test('mapMessage: pesan dihapus dikosongkan, status hanya untuk pesan sendiri', () => {
  const row = { id: 'm1', conversation_id: 'c', sender_id: 'me', kind: 'text', ciphertext: 'RAHASIA', nonce: 'n',
    sender_key: 'k', deleted_at: new Date(), n_others: 1, n_delivered: 1, n_read: 0 };
  const own = mapMessage(row, 'me');
  assert.equal(own.ciphertext, '');
  assert.equal(own.deleted, true);
  assert.equal(own.status, 'delivered');
  const other = mapMessage({ ...row, deleted_at: null }, 'orang-lain');
  assert.equal(other.status, null);
  assert.equal(other.receipts, null);
  assert.equal(other.ciphertext, 'RAHASIA');
});

test('email OTP: 6 kotak angka + tombol salin + warna biru/hitam/merah', () => {
  const h = otpEmailHtml('482915', 'https://api.test/');
  for (const d of '482915') assert.ok(h.includes(`>${d}</td>`));
  assert.ok(h.includes('https://api.test/api/salin?kode=482915'));
  assert.ok(h.includes('<table'));
  assert.ok(/#1e88e5/i.test(h) && /#111111/.test(h) && /#e53935/i.test(h));
  assert.ok(h.includes('SALIN KODE'));
});
test('halaman salin: hanya angka (anti XSS)', () => {
  const h = salinPageHtml('<script>alert(1)</script>123456789');
  assert.ok(!h.includes('<script>alert'));
  assert.ok(h.includes('>1</div>') || h.includes('>1'));
  assert.ok(h.includes('1'));
});
