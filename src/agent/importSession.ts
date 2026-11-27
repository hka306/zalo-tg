import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { parseSession } from './importServer.js';

// Chạy trên VPS: đọc file phiên từ agent rồi ghi thành credentials.json cho bridge.
function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('Cách dùng: npm run agent:import -- <zalo-session.json>');
  const session = parseSession(readFileSync(file, 'utf8'));
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
