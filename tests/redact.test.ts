import test from 'node:test';
import assert from 'node:assert/strict';
import { redactBotToken, redactErrorToken } from '../src/utils/redact.js';

const TOKEN = '123456789:AAFakeSecret_x-y';

await test('redactBotToken che phần secret trong URL của Telegram', () => {
  const text = `request to https://api.telegram.org/bot${TOKEN}/sendMessage failed`;
  assert.equal(redactBotToken(text), 'request to https://api.telegram.org/bot<redacted>/sendMessage failed');
});

await test('redactErrorToken che message và stack nhưng giữ code lỗi', () => {
  const err = Object.assign(new Error(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`), { code: 'ECONNRESET' });
  const out = redactErrorToken(err) as Error & { code?: string };
  assert.ok(!out.message.includes(TOKEN));
  assert.ok(!String(out.stack).includes(TOKEN));
  assert.equal(out.code, 'ECONNRESET');
});
