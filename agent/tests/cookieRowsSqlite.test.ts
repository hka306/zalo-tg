import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtin } from '../src/utils/sea.js';
import { readCookieRowsSqlite } from '../src/zalo/localSession.js';

type SqliteModule = { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };

await test('readCookieRowsSqlite đọc host, tên và giá trị mã hoá dạng hex', () => {
  const { DatabaseSync } = builtin<SqliteModule>('node:sqlite') ?? assert.fail('cần Node có node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'ck-'));
  const dbPath = join(dir, 'Cookies');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB); INSERT INTO cookies VALUES ('.zalo.me','zpw_sek',X'0102'),('.example.com','x',NULL);");
    db.close();
    const rows = readCookieRowsSqlite(dbPath).map((r) => [r.host, r.name, r.enc.toString('hex')]);
    assert.deepEqual(rows, [['.zalo.me', 'zpw_sek', '0102'], ['.example.com', 'x', '']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
