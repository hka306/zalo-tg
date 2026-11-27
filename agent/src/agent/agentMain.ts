// Điểm vào của `npm run agent:export` và của file .exe (Node SEA).
// Đọc .env (với .exe: .env nằm cạnh file), chạy agent, rồi với .exe thì giữ cửa sổ để đọc kết quả.
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { isSeaExe } from '../utils/sea.js';

const exe = isSeaExe();
// Double-click .exe thì thư mục đang mở có thể không phải thư mục chứa .exe.
if (exe) process.chdir(path.dirname(process.execPath));
loadEnv();

async function run(): Promise<number> {
  try {
    // Nạp muộn để config.ts (đọc TG_TOKEN lúc import) chạy sau khi .env đã được nạp.
    const { runExport } = await import('./exportSession.js');
    await runExport();
    return 0;
  } catch (err) {
    console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

run().then(async (code) => {
  if (exe && process.stdin.isTTY) {
    console.log('\nNhấn Enter để đóng cửa sổ.');
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  }
  process.exit(code);
});
