import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PROJECT_ROOT } from '../utils/paths.js';
import { createImportServer } from './importServer.js';

// Trang nạp phiên cho VPS. Chỉ lắng nghe 127.0.0.1, nên từ máy khác phải mở SSH tunnel.
// Không import config.ts ở đây vì config yêu cầu TG_TOKEN sẵn có, còn trang này dùng để điền nó.
const PORT = 3900;
const token = randomBytes(16).toString('hex');
const server = createImportServer({
  token,
  credentialsPath: path.resolve(PROJECT_ROOT, process.env.ZALO_CREDENTIALS_PATH || 'credentials.json'),
  envPath: path.join(PROJECT_ROOT, '.env'),
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[agent] Mở http://127.0.0.1:${PORT}/?t=${token}`);
  console.log(`[agent] Từ máy khác, mở SSH tunnel trước: ssh -L ${PORT}:127.0.0.1:${PORT} <user>@<vps>`);
});
