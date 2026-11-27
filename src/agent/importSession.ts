import { readFileSync } from 'node:fs';
import { config } from '../config.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { decryptSession, passphraseFromEnv } from './sessionBundle.js';

// Chạy trên VPS: giải mã file phiên từ agent rồi ghi thành credentials.json cho bridge.
function main(): void {
  const file = process.argv[2];
  if (!file) throw new Error('Cách dùng: npm run agent:import -- <file.enc.json>');
  const passphrase = passphraseFromEnv();
  let plain: string;
  try {
    plain = decryptSession(readFileSync(file, 'utf8'), passphrase);
  } catch {
    throw new Error('Không mở được file: sai AGENT_PASSPHRASE hoặc file đã bị sửa.');
  }
  writePrivateJsonFileSync(config.zalo.credentialsPath, JSON.parse(plain));
  console.log(`[agent] Đã ghi phiên vào ${config.zalo.credentialsPath}`);
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
