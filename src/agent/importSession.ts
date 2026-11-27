import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { passphraseFromEnv } from './sessionBundle.js';
import { openSessionEnvelope } from './importServer.js';

// Chạy trên VPS: giải mã file phiên từ agent rồi ghi thành credentials.json cho bridge.
function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('Cách dùng: npm run agent:import -- <file.enc.json>');
  const session = openSessionEnvelope(readFileSync(file, 'utf8'), passphraseFromEnv());
  writePrivateJsonFileSync(config.zalo.credentialsPath, session);
  console.log(`[agent] Đã ghi phiên vào ${config.zalo.credentialsPath}`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
