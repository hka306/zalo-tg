import { Telegraf } from 'telegraf';
import https from 'https';
import { config } from '../config.js';
import { redactErrorToken } from '../utils/redact.js';

// Force IPv4 to avoid ETIMEDOUT on systems where IPv6 is blocked/unreachable
const agent = new https.Agent({ family: 4 });

const BOT_COMMANDS = [
  { command: 'loginlocal',     description: 'Đăng nhập bằng phiên Zalo PC trên máy (Windows)' },
  { command: 'search',         description: 'Tìm tên, nhóm hoặc số điện thoại' },
  { command: 'group_info',     description: 'Xem thông tin & thành viên nhóm Zalo hiện tại' },
  { command: 'group_infoall',  description: 'Xem toàn bộ thành viên nhóm Zalo hiện tại' },
  { command: 'topic',          description: 'Quản lý topic: list | info | delete' },
  { command: 'history',        description: 'Nạp lịch sử chat nhóm vào topic hiện tại' },
  { command: 'status',         description: 'Xem trạng thái kết nối & thống kê bridge' },
  { command: 'restart',        description: 'Khởi động lại bridge (chỉ admin)' },
  { command: 'setup',          description: 'Cấu hình biến env qua wizard (chỉ admin)' },
  { command: 'admin',          description: 'Admin panel: trạng thái, cache, tra mapping' },
  { command: 'update',         description: 'Kiểm tra bản cập nhật mới cho bridge' },
  { command: 'seed',           description: 'Xem mã seed giải mã backup Zalo' },
];

/** Singleton Telegraf bot instance shared across the app. */
export const tgBot = new Telegraf(config.telegram.token, {
  telegram: { agent },
});

// Lỗi mạng của Telegraf (FetchError) có URL chứa token. Che ở callApi để mọi log
// và tin báo lỗi đều sạch; code lỗi vẫn giữ nguyên để logic retry hoạt động.
const telegramClient = tgBot.telegram as unknown as { callApi: (...args: unknown[]) => Promise<unknown> };
const rawCallApi = telegramClient.callApi.bind(tgBot.telegram);
telegramClient.callApi = async (...args) => {
  try {
    return await rawCallApi(...args);
  } catch (err) {
    throw redactErrorToken(err);
  }
};

// Keep polling alive when one update handler fails. Without an explicit catch,
// Telegraf can reject launch() and leave the process half-alive: Zalo→Telegram
// listeners still work while Telegram→Zalo silently stops consuming updates.
tgBot.catch((err, ctx) => {
  console.error(`[Telegram] Update ${ctx.update.update_id} failed:`, err);
});

export async function syncTelegramCommands(): Promise<void> {
  await tgBot.telegram.setMyCommands(BOT_COMMANDS);
}
