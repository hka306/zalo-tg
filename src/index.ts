import { getZaloApi, resetZaloApi } from './zalo/client.js';
import { CloseReason, ThreadType } from 'zca-js';
import { setupZaloHandler } from './zalo/handler.js';
import { tgBot, syncTelegramCommands } from './telegram/bot.js';
import { setupTelegramHandler } from './telegram/handler.js';
import { config } from './config.js';
import { startUpdateChecker } from './updater.js';
import { store, userCache } from './store.js';
import { registerShutdownHandler, requestShutdown } from './lifecycle.js';
import { terminal } from './utils/terminal.js';
import { forceRestartZaloPc, loadBrowserZaloSession, loadLocalZaloSession } from './zalo/localSession.js';
import { writePrivateJsonFileSync } from './utils/privateFile.js';
import { isTransientNetworkError } from './utils/zaloRetry.js';

// Bridge cần TG_GROUP_ID ngay khi khởi động. config.ts đọc biến này lười (để agent chạy không cần), nên kiểm tra ở đây.
void config.telegram.groupId;

// ── Global safety net — prevent unhandled rejections from crashing ────────────
process.on('unhandledRejection', (reason) => {
  console.error('[Boot] Unhandled rejection (ignored):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Boot] Uncaught exception:', err);
  void requestShutdown('Uncaught exception', 43);
});

// ── Module-level ref to Telegram handler's API setter (used by reconnect) ──────
let _setZaloApi: ((api: Awaited<ReturnType<typeof getZaloApi>>) => void) | null = null;
let _reconnectInProgress = false;
let _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let _activeZaloApi: Awaited<ReturnType<typeof getZaloApi>> | null = null;
let _bridgeReadyAnnounced = false;

// ── Boot Zalo (also used when /login swaps in a fresh API) ───────────────────

/**
 * Nếu máy có phiên Zalo PC đang đăng nhập, ghi đè credentials.json bằng phiên đó
 * (imei + cookie sống) rồi reset cache API. Chỉ chạy trên Windows; trả false nếu
 * không lấy được để caller dùng tiếp credentials.json sẵn có (nếu còn).
 */
async function refreshCredentialsFromLocalSession(): Promise<boolean> {
  const session = await loadLocalZaloSession() ?? loadBrowserZaloSession();
  if (!session) return false;
  writePrivateJsonFileSync(config.zalo.credentialsPath, session);
  resetZaloApi();
  terminal.status('zalo login', 'dùng phiên Zalo PC trên máy', 'info');
  return true;
}

/**
 * Đăng nhập bằng credentials.json. Nếu lỗi không phải mạng (phiên đã lưu hỏng hoặc chưa có phiên),
 * tự đóng Zalo PC để đọc phiên mới rồi thử lại đúng một lần. Lỗi mạng thì không đóng Zalo PC.
 */
async function getZaloApiOrRecover(): Promise<Awaited<ReturnType<typeof getZaloApi>>> {
  try {
    return await getZaloApi();
  } catch (err) {
    if (process.platform !== 'win32' || isTransientNetworkError(err)) throw err;
    terminal.status('zalo login', 'phiên đã lưu không dùng được, đang đóng Zalo PC để lấy phiên mới', 'warn');
    tgBot.telegram.sendMessage(config.telegram.groupId, '🔄 Phiên đã lưu không dùng được, bot đang tự đóng Zalo PC để lấy phiên mới...').catch(() => undefined);
    const session = await forceRestartZaloPc();
    if (!session) throw err;
    writePrivateJsonFileSync(config.zalo.credentialsPath, session);
    return await getZaloApi();
  }
}

async function pruneLeftGroupTopics(api: Awaited<ReturnType<typeof getZaloApi>>): Promise<void> {
  try {
    const groups = await api.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
    const activeGroupIds = new Set(Object.keys(groups?.gridVerMap ?? {}));
    const removed: string[] = [];
    for (const entry of store.all()) {
      if (entry.type === 1 && !activeGroupIds.has(entry.zaloId)) {
        store.remove(entry.topicId);
        removed.push(`${entry.name} (${entry.zaloId})`);
      }
    }
    if (removed.length > 0) {
      terminal.status('topics', `pruned ${removed.length} stale mapping(s)`, 'warn');
    }
  } catch (err) {
    console.warn('[Boot] Could not prune stale group topics:', err);
  }
}

async function startZalo(
  api: Awaited<ReturnType<typeof getZaloApi>>,
  isReconnect = false,
): Promise<void> {
  _activeZaloApi = api;
  if (!isReconnect) void pruneLeftGroupTopics(api);
  await setupZaloHandler(api);
  if (isReconnect) {
    api.listener.once('connected', () => {
      try {
        // Recover recent gap after disconnect (messages + reactions in both DM/group).
        api.listener.requestOldMessages(ThreadType.User);
        api.listener.requestOldMessages(ThreadType.Group);
        api.listener.requestOldReactions(ThreadType.User);
        api.listener.requestOldReactions(ThreadType.Group);
        terminal.status('sync', 'catch-up requested after reconnect', 'info');
      } catch (err) {
        console.warn('[Boot] Failed to request catch-up sync:', err);
      }
    });
  }
  api.listener.start();
  terminal.status('zalo', `listener ${isReconnect ? 're' : ''}started`, 'success');
  if (!_bridgeReadyAnnounced) {
    _bridgeReadyAnnounced = true;
    terminal.status('bridge', 'ready · forwarding active', 'success');
    terminal.section('LIVE ACTIVITY');
  }

  const scheduleReconnect = (delayMs: number): void => {
    if (_reconnectTimer || _reconnectInProgress) return;
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      void (async () => {
        if (_reconnectInProgress) return;
        _reconnectInProgress = true;
        try {
          await refreshCredentialsFromLocalSession();
          resetZaloApi();
          const newApi = await getZaloApiOrRecover();
          _setZaloApi?.(newApi);
          await startZalo(newApi, true);
          tgBot.telegram.sendMessage(config.telegram.groupId, '✅ Zalo đã kết nối lại và đang đồng bộ lại tin gần đây.').catch(() => undefined);
          terminal.status('zalo', 'reconnected and syncing', 'success');
        } catch (err) {
          console.error('[Boot] Zalo reconnect failed:', err);
          tgBot.telegram.sendMessage(
            config.telegram.groupId,
            '⚠️ Không có đăng nhập Zalo.',
            { parse_mode: 'HTML' },
          ).catch(() => undefined);
        } finally {
          _reconnectInProgress = false;
        }
      })();
    }, delayMs);
  };

  // Auto-reconnect only on closings that are safe to recover automatically.
  api.listener.once('disconnected', (code: CloseReason, reason: string) => {
    if (code === CloseReason.ManualClosure) return;
    if (code === CloseReason.DuplicateConnection) {
      console.warn(`[Boot] Zalo disconnected: duplicate connection (code=${code}, reason=${reason})`);
      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Zalo bị ngắt do đăng nhập trùng phiên (duplicate connection). Đóng bớt phiên Zalo Web/PC khác rồi gõ /loginlocal để nối lại.',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
      return;
    }
    if (code === CloseReason.KickConnection) {
      console.warn(`[Boot] Zalo disconnected: kicked connection (code=${code}, reason=${reason})`);
      tgBot.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Zalo đã ngắt phiên bridge (kick connection). Gõ <b>/loginlocal</b> trên máy có Zalo PC để nối lại.',
        { parse_mode: 'HTML' },
      ).catch(() => undefined);
      return;
    }
    console.warn(`[Boot] Zalo disconnected (code=${code}, reason=${reason}), reconnecting in 5 s…`);
    tgBot.telegram.sendMessage(
      config.telegram.groupId,
      '⚠️ Zalo bị ngắt kết nối, đang thử kết nối lại…',
    ).catch(() => undefined);
    scheduleReconnect(5_000);
  });
}

async function main(): Promise<void> {
  await terminal.intro('1.0.0');
  terminal.installConsoleTheme();
  terminal.section('STARTUP');
  terminal.status('runtime', `${process.version} · pid ${process.pid}`, 'muted');
  terminal.status('cache', `${userCache.stats().users} users · ${store.all().length} topics restored`, 'muted');

  // ── Auto update checker — must register BEFORE setupTelegramHandler ─────────
  // bot.action() is middleware; the catch-all on('callback_query') in handler.ts
  // doesn't call next(), so ua: callbacks must be registered first in the chain.
  startUpdateChecker(tgBot);

  // ── Wire up Telegram handler BEFORE launching the bot ─────────────────────
  // setupTelegramHandler returns a setter to inject the Zalo API after auto-login.
  const setZaloApi = setupTelegramHandler(null, async (newApi) => {
    await startZalo(newApi, true);
  });
  _setZaloApi = setZaloApi;

  // ── Register bot commands for Telegram menu ───────────────────────────────
  tgBot.telegram.setMyCommands([
    { command: 'loginlocal',     description: 'Đăng nhập bằng phiên Zalo PC trên máy (Windows)' },
    { command: 'search',         description: 'Tìm bạn bè / nhóm Zalo để tạo topic' },
    { command: 'group_info',     description: 'Xem thông tin & thành viên nhóm Zalo hiện tại' },
    { command: 'group_infoall',  description: 'Xem toàn bộ thành viên nhóm Zalo hiện tại' },
    { command: 'topic',          description: 'Quản lý topic: list / info / delete' },
    { command: 'history',        description: 'Nạp lịch sử chat nhóm vào topic (dùng trong topic nhóm)' },
    { command: 'admin',          description: 'Admin panel: trạng thái, cache, tra mapping' },
    { command: 'status',         description: 'Xem trạng thái bridge, máy, IP, uptime và Zalo' },
    { command: 'restart',        description: 'Khởi động lại bridge (chỉ admin)' },
    { command: 'setup',          description: 'Cấu hình biến env qua wizard (chỉ admin)' },
    { command: 'update',         description: 'Kiểm tra bản cập nhật mới' },
    { command: 'contacts', description: 'Gửi danh bạ Zalo kèm ID vào chat riêng (chỉ admin)' },
  ]).catch(() => undefined);

  // ── Graceful shutdown/restart shared by signals, commands and polling ──────
  registerShutdownHandler(async (reason, exitCode) => {
    // Animate while listeners stop and debounced stores flush, so shutdown is
    // both visually smooth and operationally useful rather than a fixed delay.
    const outro = terminal.shutdown(`${reason} · exit ${exitCode}`);
    if (_reconnectTimer) {
      clearTimeout(_reconnectTimer);
      _reconnectTimer = null;
    }
    try { _activeZaloApi?.listener.stop(); } catch { /* ignore */ }
    try { await tgBot.stop(reason); } catch { /* bot may not have launched yet */ }
    // Let debounced msg/user-cache persistence finish before process exit.
    await new Promise(r => setTimeout(r, 2500));
    await outro;
    process.exit(exitCode);
  });

  // ── Start Telegram bot so /login can be received immediately ───────────────
  // NOTE: tgBot.launch() runs the polling loop forever, so we must NOT await it.
  // The second argument callback fires once getMe() + deleteWebhook() succeed.
  void tgBot.launch({ allowedUpdates: ['message', 'callback_query', 'message_reaction', 'poll_answer', 'poll'] }, () => {
    terminal.status('telegram', 'polling connected', 'success');

    syncTelegramCommands()
      .then(() => terminal.status('commands', 'menu synchronized', 'success'))
      .catch((err: unknown) => console.warn('[Boot] Failed to sync Telegram commands:', err));

    // ── Attempt Zalo login in background ────────────────────────────────────
    // Ưu tiên phiên Zalo PC đang đăng nhập trên máy (Windows); nếu không có thì
    // dùng credentials.json sẵn có. Không fallback QR — lỗi thì báo Telegram.
    void (async () => {
      try {
        await refreshCredentialsFromLocalSession();
        const api = await getZaloApiOrRecover();
        setZaloApi(api);   // ← inject into Telegram handler so TG→Zalo works
        await startZalo(api);
      } catch (err) {
        console.warn('[Boot] Zalo auto-login failed:', err);
        tgBot.telegram
          .sendMessage(
            config.telegram.groupId,
            '⚠️ Không có đăng nhập Zalo.',
            { parse_mode: 'HTML' },
          )
          .catch(() => undefined);
      }
    })();
  }).catch((err: unknown) => {
    console.error('[Boot] Telegram polling stopped:', err);
    // Do not leave a half-alive Zalo-only bridge. A supervisor/run.sh can
    // restart exit code 43; a direct npm start exits visibly instead of lying.
    void requestShutdown('Telegram polling failure', 43);
  });

  terminal.status('bridge', 'starting services…', 'info');

  process.once('SIGINT',  () => { void requestShutdown('Received SIGINT', 0); });
  process.once('SIGTERM', () => { void requestShutdown('Received SIGTERM', 0); });
}

main().catch((err: unknown) => {
  console.error('[Boot] Fatal error:', err);
  process.exit(1);
});
