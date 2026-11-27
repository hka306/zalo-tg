import { tgBot } from '../telegram/bot.js';
import { loginWithSession } from '../zalo/client.js';
import { loadBrowserZaloSession, loadLocalZaloSession } from '../zalo/localSession.js';
import { escapeHtml } from '../utils/format.js';
import { getMachineInfo } from '../utils/machineInfo.js';
import { encryptSession, passphraseFromEnv } from './sessionBundle.js';

// Chạy trên máy có Zalo PC: lấy phiên đang đăng nhập, gửi tóm tắt (cùng các trường của /status)
// và file phiên đã mã hoá về chat riêng với bot.
async function main(): Promise<void> {
  const passphrase = passphraseFromEnv();
  const chatId = process.env.AGENT_CHAT_ID?.trim() ?? '';
  if (!/^-?\d+$/.test(chatId)) throw new Error('Đặt AGENT_CHAT_ID là Telegram user id của bạn trong .env.');
  const session = (await loadLocalZaloSession()) ?? loadBrowserZaloSession();
  if (!session) throw new Error('Không đọc được phiên Zalo PC. Hãy đăng nhập Zalo PC trên máy này rồi chạy lại.');

  // Đăng nhập thử để lấy tên và UID như /status. Phiên hỏng thì dừng, không gửi đi.
  const api = await loginWithSession(session).catch((err: unknown) => {
    throw new Error(`Đăng nhập bằng phiên thất bại: ${err instanceof Error ? err.message : String(err)}`);
  });
  const info = await api.fetchAccountInfo().catch(() => null) as { profile?: { displayName?: string; zaloName?: string } } | null;
  const name = info?.profile?.displayName ?? info?.profile?.zaloName ?? '?';
  const machine = await getMachineInfo();
  const lanText = machine.lanIps.length ? machine.lanIps.map((ip) => `<code>${ip}</code>`).join(', ') : 'không có';
  const pubText = machine.publicIp ? `<code>${machine.publicIp}</code>` : 'không lấy được';
  const summary = [
    '📊 <b>Phiên Zalo lấy từ máy</b>',
    `👤 Zalo: <b>${escapeHtml(name)}</b> 🟢`,
    `🆔 ID: <code>${escapeHtml(api.getOwnId())}</code>`,
    `🖥 Máy: <code>${escapeHtml(machine.hostname)}</code> (${escapeHtml(machine.user)}, ${escapeHtml(machine.osName)})`,
    `🌐 IP nội bộ: ${lanText}`,
    `🌍 IP công cộng: ${pubText}`,
  ].join('\n');
  const envelope = encryptSession(JSON.stringify(session), passphrase);
  try {
    await tgBot.telegram.sendMessage(chatId, summary, { parse_mode: 'HTML' });
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
  console.log('[agent] Đã gửi tóm tắt và file phiên đã mã hoá về chat riêng.');
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
