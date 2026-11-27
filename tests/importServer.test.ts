import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createImportServer, parseSession, setEnvValues } from '../src/agent/importServer.js';

const SESSION = { imei: 'imei-test', cookie: [{ key: 'zpw_sek', value: 'x' }], userAgent: 'ua-test' };

await test('setEnvValues sửa khoá có sẵn, giữ dòng khác và thêm khoá mới', () => {
  const out = setEnvValues('# ghi chú\nTG_TOKEN=cu\nKHAC=1\n\n', { TG_TOKEN: 'moi', TG_GROUP_ID: '-100' });
  assert.equal(out, '# ghi chú\nTG_TOKEN=moi\nKHAC=1\nTG_GROUP_ID=-100\n');
});

await test('parseSession nhận đúng phiên, từ chối JSON hỏng hoặc thiếu trường', () => {
  assert.deepEqual(parseSession(JSON.stringify(SESSION)), SESSION);
  assert.throws(() => parseSession('{không phải json'), /không phải phiên Zalo/);
  assert.throws(() => parseSession(JSON.stringify({ cookie: [] })), /không phải phiên Zalo/);
});

await test('import server chặn khi sai token, và ghi phiên cùng .env khi đúng', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-'));
  const credentialsPath = join(dir, 'credentials.json');
  const envPath = join(dir, '.env');
  const token = 'test-token-123';
  const server = createImportServer({ token, credentialsPath, envPath });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${base}/`);
    assert.equal(denied.status, 401);

    const body = JSON.stringify({
      tgToken: '123456:ABCdef_-xyz',
      groupId: '-1001234567890',
      session: JSON.stringify(SESSION),
    });
    const ok = await fetch(`${base}/import?t=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(credentialsPath, 'utf8')), SESSION);
    assert.equal(readFileSync(envPath, 'utf8'), 'TG_TOKEN=123456:ABCdef_-xyz\nTG_GROUP_ID=-1001234567890\n');
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
