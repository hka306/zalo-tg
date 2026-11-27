import { tgBot } from '../telegram/bot.js';
import { loginWithSession } from '../zalo/client.js';
import { loadBrowserZaloSession, loadLocalZaloSession } from '../zalo/localSession.js';
import { escapeHtml } from '../utils/format.js';
import { getMachineInfo } from '../utils/machineInfo.js';
import { encryptSession, passphraseFromEnv } from './sessionBundle.js';
import type { ZaloAPI } from '../zalo/types.js';

// Báo về chat riêng để bạn biết agent đã chạy. Lỗi gửi chỉ in ra console.
async function notify(chatId: string, html: string): Promise<void> {
  await tgBot.telegram.sendMessage(chatId, html, { parse_mode: 'HTML' }).catch((err: unknown) => {
    console.error(`[agent] Không gửi được thông báo: ${err instanceof Error ? err.message : String(err)}`);
  });
}

// Tên tài khoản đôi khi chưa sẵn sàng ngay sau đăng nhập, nên thử lại vài lần.
async function fetchAccountName(api: ZaloAPI): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const info = await api.fetchAccountInfo().catch(() => null) as { profile?: { displayName?: string; zaloName?: string } } | null;
    const name = info?.profile?.displayName ?? info?.profile?.zaloName;
    if (name) return name;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
}

// Chạy trên máy có Zalo PC: lấy phiên đang đăng nhập, gửi tóm tắt (cùng các trường của /status)
// và file phiên đã mã hoá về chat riêng với bot.
async function main(): Promise<void> {
  const passphrase = passphraseFromEnv();
  const chatId = process.env.AGENT_CHAT_ID?.trim() ?? '';
  if (!/^-?\d+$/.test(chatId)) throw new Error('Đặt AGENT_CHAT_ID là Telegram user id của bạn trong .env.');
  const session = (await loadLocalZaloSession()) ?? loadBrowserZaloSession();
  if (!session) {
    await notify(chatId, '⚠️ Không có tài khoản Zalo nào đăng nhập trên máy này. Hãy đăng nhập Zalo PC rồi chạy lại agent.');
    throw new Error('Không đọc được phiên Zalo PC. Hãy đăng nhập Zalo PC trên máy này rồi chạy lại.');
  }

  // Đăng nhập thử để lấy tên và UID như /status. Phiên hỏng thì báo về bot rồi dừng, không gửi file.
  const api = await loginWithSession(session).catch(async (err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err);
    await notify(chatId, `⚠️ Phiên Zalo trên máy không đăng nhập được: ${escapeHtml(reason)}`);
    throw new Error(`Đăng nhập bằng phiên thất bại: ${reason}`);
  });
  const name = await fetchAccountName(api);
  if (!name) {
    await notify(chatId, '⚠️ Đã đăng nhập nhưng chưa lấy được tên tài khoản Zalo. Hãy chạy lại agent.');
    throw new Error('Chưa lấy được tên tài khoản Zalo.');
  }
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
