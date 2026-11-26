import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

const { decryptCookieValue, readImeiFromLevelDb, loadLocalZaloSession, copyLockedFile } = await import(
  '../src/zalo/localSession.js'
);

const IMEI = '90f61ac6-e190-4b44-a60c-f8d87fdba85f-5f372f8bbd6f68e531fb3a045247dad5';

await test('decryptCookieValue giải mã đúng blob v10 (AES-256-GCM)', () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const plain = 'ok8V.111416469.a1.__TEST_zpw_sek_value__';
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const blob = Buffer.concat([Buffer.from('v10'), nonce, ct, cipher.getAuthTag()]);
  assert.equal(decryptCookieValue(blob, key), plain);
});

await test('readImeiFromLevelDb lấy được imei (kể cả bản UTF-16)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ztg-imei-'));
  // bản latin1 thường
  writeFileSync(path.join(dir, '000001.ldb'), Buffer.from(`\x01\x00meta_z_uuid\x01${IMEI}\x00tail`, 'latin1'));
  assert.equal(readImeiFromLevelDb(dir), IMEI);

  // bản UTF-16 (xen \x00) — hàm phải xử lý được
  const dir16 = mkdtempSync(path.join(os.tmpdir(), 'ztg-imei16-'));
  const utf16 = `z_uuid${IMEI}`.split('').map((c) => c + '\x00').join('');
  writeFileSync(path.join(dir16, '000002.ldb'), Buffer.from(utf16, 'latin1'));
  assert.equal(readImeiFromLevelDb(dir16), IMEI);
});

await test('readImeiFromLevelDb trả null khi thư mục không tồn tại', () => {
  assert.equal(readImeiFromLevelDb(path.join(os.tmpdir(), 'khong-ton-tai-ztg-xyz')), null);
});

await test('loadLocalZaloSession trả null khi không phải Windows', async () => {
  if (process.platform === 'win32') return; // chỉ kiểm trên non-Windows (CI)
  assert.equal(await loadLocalZaloSession(), null);
});

await test('copyLockedFile copy file thường, và ném lỗi khi nguồn không tồn tại', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ztg-copy-'));
  writeFileSync(path.join(dir, 'Cookies'), 'abc');
  copyLockedFile(path.join(dir, 'Cookies'), path.join(dir, 'copy'));
  assert.equal(readFileSync(path.join(dir, 'copy'), 'utf8'), 'abc');
  assert.throws(() => copyLockedFile(path.join(dir, 'khong-co'), path.join(dir, 'x')), { code: 'ENOENT' });
});
