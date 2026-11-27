import { tgBot } from '../telegram/bot.js';
import { loadBrowserZaloSession, loadLocalZaloSession } from '../zalo/localSession.js';
import { encryptSession, passphraseFromEnv } from './sessionBundle.js';

// Chạy trên máy có Zalo PC: lấy phiên đang đăng nhập, mã hoá, rồi gửi về chat riêng với bot.
async function main(): Promise<void> {
  const passphrase = passphraseFromEnv();
  const chatId = process.env.AGENT_CHAT_ID?.trim() ?? '';
  if (!/^-?\d+$/.test(chatId)) throw new Error('Đặt AGENT_CHAT_ID là Telegram user id của bạn trong .env.');
  const session = (await loadLocalZaloSession()) ?? loadBrowserZaloSession();
  if (!session) throw new Error('Không đọc được phiên Zalo PC. Hãy đăng nhập Zalo PC trên máy này rồi chạy lại.');
  const envelope = encryptSession(JSON.stringify(session), passphrase);
  try {
    await tgBot.telegram.sendDocument(
      chatId,
      { source: Buffer.from(envelope, 'utf8'), filename: 'zalo-session.enc.json' },
      { caption: '🔐 Phiên Zalo đã mã hoá. Cần AGENT_PASSPHRASE để mở.' },
    );
  } catch (err) {
    // Không in err.message: lỗi mạng có thể chứa URL kèm token bot
    const tg = (err as { response?: { error_code?: number; description?: string } }).response;
    throw new Error(
      `Gửi thất bại [${tg?.error_code ?? '-'}] ${tg?.description ?? 'lỗi mạng'}. ` +
      'Nếu lỗi 403, hãy nhắn /start cho bot trong chat riêng rồi chạy lại.',
    );
  }
  console.log('[agent] Đã gửi phiên đã mã hoá về chat riêng.');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
