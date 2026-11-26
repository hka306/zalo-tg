import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'zalo-session-agent.mjs');

await test('agent --selftest: fingerprint bỏ qua timestamp & thứ tự, bắt được đổi cookie', () => {
  const out = execFileSync(process.execPath, [AGENT, '--selftest'], { encoding: 'utf8' });
  assert.match(out, /selftest OK/);
});
