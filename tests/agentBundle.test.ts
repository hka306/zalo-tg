import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptSession, encryptSession } from '../src/agent/sessionBundle.js';

const PLAIN = JSON.stringify({ imei: 'abc-123', cookie: [{ name: 'zpw_sek', value: 'SECRET_VALUE_XYZ' }], userAgent: 'UA' });
const PASS = 'correct horse battery';

await test('encryptSession rồi decryptSession trả lại đúng nội dung', () => {
  assert.equal(decryptSession(encryptSession(PLAIN, PASS), PASS), PLAIN);
});

await test('file mã hoá không chứa cookie dạng thô', () => {
  const envelope = encryptSession(PLAIN, PASS);
  assert.ok(!envelope.includes('SECRET_VALUE_XYZ'));
  assert.ok(!envelope.includes('zpw_sek'));
});

await test('sai passphrase hoặc dữ liệu bị sửa thì không giải mã được', () => {
  const envelope = encryptSession(PLAIN, PASS);
  assert.throws(() => decryptSession(envelope, 'wrong passphrase!!'));
  const tampered = JSON.parse(envelope) as { data: string };
  tampered.data = Buffer.from('evil').toString('base64');
  assert.throws(() => decryptSession(JSON.stringify(tampered), PASS));
});
