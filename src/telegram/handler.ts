import { Reactions, ThreadType, type AttachmentSource, type SendMessageQuote } from 'zca-js';
import type { Context } from 'telegraf';

const MAX_ZALO_TEXT_LENGTH = 2000;

function splitLongText(text: string): string[] {
  if (text.length <= MAX_ZALO_TEXT_LENGTH) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = start + MAX_ZALO_TEXT_LENGTH;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }
    // Try to break at paragraph boundary
    const paraBreak = text.lastIndexOf('\n\n', end);
    if (paraBreak > start) { end = paraBreak; }
    else {
      const lineBreak = text.lastIndexOf('\n', end);
      if (lineBreak > start) { end = lineBreak; }
      else {
        const spaceBreak = text.lastIndexOf(' ', end);
        if (spaceBreak > start) { end = spaceBreak; }
      }
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

import type { ZaloAPI, ZaloMessage } from '../zalo/types.js';
import { ZALO_MSG_TYPES } from '../zalo/types.js';
import { store, msgStore, userCache, friendsCache, groupsCache, sentMsgStore, pollStore, mediaGroupStore, reactionEchoStore, reactionSummaryStore, reactionEventDedupeStore, aliasCache, markRecalled, type ZaloQuoteData } from '../store.js';
import { replayHistoryMessages, requestGroupHistory } from '../zalo/handler.js';
import { tgBot } from './bot.js';
import { config } from '../config.js';
import { downloadToTemp, cleanTemp, convertStickerToPng, convertTgsToGif, convertToM4a, extractVideoThumbnail, convertWebmToGif } from '../utils/media.js';
import { getZaloApi, resetZaloApi } from '../zalo/client.js';
import { forceRestartZaloPc, loadBrowserZaloSession } from '../zalo/localSession.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { loadAppSession, invalidateAppSession, appGetReceivedFriendRequests, appGetSentFriendRequests, appGetGroupInfo, appGetGroupMembersInfo } from '../zalo/appApi.js';
import { resetMemberCacheLoaded } from '../zalo/handler.js';
import { escapeHtml } from '../utils/format.js';
import { zaloApiWithRetry, isTransientNetworkError } from '../utils/zaloRetry.js';
import { tgQueue } from '../utils/tgQueue.js';
import { requestShutdown } from '../lifecycle.js';
import { startSetupWizard, handleSetupCallback, hasActiveSetup, consumeSetupTextAndAdvance } from './setupWizard.js';

// Bridge start time (module load = process start)
const _bridgeStartTime = Date.now();



// ── Mention resolution helper ──────────────────────────────────────────────

type TgEntity = { type: string; offset: number; length: number; user?: { first_name: string; last_name?: string } };

/**
 * Resolve TG mention entities (or plain-text @Name patterns) in a string
 * to Zalo mention objects. Works for both msg.text+entities and
 * msg.caption+caption_entities.
 */
function resolveTgMentions(
  text: string,
  entities: ReadonlyArray<TgEntity> | undefined,
  forZaloGroup: boolean,
  zaloId?: string,
): Array<{ pos: number; uid: string; len: number }> {
  const result: Array<{ pos: number; uid: string; len: number }> = [];
  if (!forZaloGroup) return result;

  // 1. Named TG entities (@username or text_mention with user object)
  if (entities) {
    for (const e of entities) {
      if (e.type === 'mention') {
        const rawName = text.slice(e.offset + 1, e.offset + e.length); // strip leading @
        const uid = (zaloId
          ? userCache.resolveByNameInGroup(rawName, zaloId)
          : userCache.resolveByName(rawName))
          ?? aliasCache.resolveByAlias(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      } else if (e.type === 'text_mention' && e.user) {
        const rawName = e.user.first_name + (e.user.last_name ? ` ${e.user.last_name}` : '');
        const uid = (zaloId
          ? userCache.resolveByNameInGroup(rawName, zaloId)
          : userCache.resolveByName(rawName))
          ?? aliasCache.resolveByAlias(rawName);
        if (uid) result.push({ pos: e.offset, uid, len: e.length });
      }
    }
  }

  // 2. Plain-text @Name patterns (only if no entity matched above)
  if (result.length === 0) {
    const atPattern = /@([\p{L}\p{N}_]+(?:\s[\p{L}\p{N}_]+){0,3})/gu;
    let m: RegExpExecArray | null;
    while ((m = atPattern.exec(text)) !== null) {
      const captured = m[1];
      if (/^(all|everyone|tất\s*cả)$/i.test(captured)) {
        result.push({ pos: m.index, uid: '-1', len: m[0].length });
        continue;
      }
      const words = captured.split(' ');
      for (let end = words.length; end >= 1; end--) {
        const candidate = words.slice(0, end).join(' ');
        const uid = (zaloId
          ? userCache.resolveByNameInGroup(candidate, zaloId)
          : userCache.resolveByName(candidate))
          ?? aliasCache.resolveByAlias(candidate);
        if (uid) {
          result.push({ pos: m.index, uid, len: ('@' + candidate).length });
          break;
        }
      }
    }
  }

  return result;
}

/**
 * When a TG user replies to a forwarded Zalo message from ANOTHER person,
 * prepend "@Name " to the message so the recipient on Zalo sees who is being
 * addressed. Returns null when:
 *  - not a group (mentions don't apply in DMs)
 *  - replying to our own sent message (TG→Zalo direction)
 *  - no quote data / display name found
 */
function buildReplyAutoMention(
  replyToMsgId: number | undefined,
  threadType: ThreadType,
): { prefix: string; mention: { pos: number; uid: string; len: number } } | null {
  if (replyToMsgId === undefined) return null;
  if (threadType !== ThreadType.Group) return null;
  // Skip if replying to a message WE sent (TG→Zalo direction)
  if (sentMsgStore.get(replyToMsgId) !== undefined) return null;
  const quote = msgStore.getQuote(replyToMsgId);
  if (!quote) return null;
  const name = userCache.getName(quote.uidFrom)?.trim();
  if (!name) return null;
  const mentionText = `@${name}`;
  return {
    prefix: `${mentionText} `,
    mention: { pos: 0, uid: quote.uidFrom, len: mentionText.length },
  };
}

function normalizePhoneSearchQuery(query: string): string | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (!/^[+()\d.\s-]+$/.test(trimmed)) return null;

  const digitsOnly = trimmed.replace(/\D/g, '');
  if (digitsOnly.length < 9 || digitsOnly.length > 15) return null;

  return digitsOnly;
}

function buildTopicUrl(topicId: number): string {
  const chatId = String(config.telegram.groupId);
  const internalChatId = chatId.startsWith('-100') ? chatId.slice(4) : chatId.replace(/^-/, '');
  return `https://t.me/c/${internalChatId}/${topicId}`;
}

async function isTelegramGroupAdmin(userId: number): Promise<boolean> {
  try {
    const member = await tgBot.telegram.getChatMember(config.telegram.groupId, userId);
    return member.status === 'creator' || member.status === 'administrator';
  } catch {
    return false;
  }
}

async function requireTelegramOperator(ctx: Context, action: string): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId !== undefined && await isTelegramGroupAdmin(userId)) return true;
  await ctx.reply(`⛔ Chỉ admin Telegram mới có thể ${action}.`).catch(() => undefined);
  return false;
}

function hasRestartSupervisor(): boolean {
  return process.env.ZALO_TG_RUNNER === '1'
    || process.execArgv.some(arg => arg.includes('tsx'));
}


/**
 * Wire up Telegram → Zalo forwarding.
 *
 * @param initialApi  Starting Zalo API (null if not yet logged in).
 * @param onZaloLogin Called with the new API after a successful /login so the
 *                    caller can re-attach the Zalo listener on the fresh API.
 */
export function setupTelegramHandler(
  initialApi: ZaloAPI | null,
  onZaloLogin: (api: ZaloAPI) => Promise<void>,
): (api: ZaloAPI) => void {
  /** Mutable reference so /login can swap in a new API instance. */
  let currentApi: ZaloAPI | null = initialApi;

  /** Exposed setter so index.ts can inject the auto-logged-in API. */
  const setCurrentApi = (api: ZaloAPI) => { currentApi = api; };

  // /loginlocal — đăng nhập bằng phiên Zalo PC đang đăng nhập trên máy (Windows), không cần QR
  tgBot.command('loginlocal', async (ctx) => {
    const isPrivate   = ctx.chat.type === 'private';
    const isFromGroup = ctx.chat.id === config.telegram.groupId;
    if (!isPrivate && !isFromGroup) return;
    if (!await requireTelegramOperator(ctx, 'đăng nhập lại Zalo')) return;
    const threadId = isFromGroup ? ctx.message.message_thread_id : undefined;
    const msgOpts  = threadId ? { message_thread_id: threadId } : {};

    await ctx.reply('🔄 Đang đóng Zalo PC để lấy phiên, rồi sẽ mở lại...', msgOpts).catch(() => undefined);
    try {
      const session = (await forceRestartZaloPc()) ?? loadBrowserZaloSession();
      if (!session) {
        await ctx.reply(
          '❌ Không tìm thấy phiên Zalo PC trên máy (chỉ hỗ trợ Windows, cùng user Windows, và Zalo PC đang đăng nhập).',
          msgOpts,
        );
        return;
      }
      writePrivateJsonFileSync(config.zalo.credentialsPath, session);
      resetZaloApi();
      const newApi = await getZaloApi();
      currentApi = newApi;
      resetMemberCacheLoaded();
      void onZaloLogin(newApi).catch((e: unknown) => console.error('[/loginlocal] onZaloLogin error:', e));
      await ctx.reply('🎉 Đăng nhập Zalo bằng phiên trên máy thành công!', msgOpts);
    } catch (err) {
      await ctx.reply(`❌ Đăng nhập bằng phiên Zalo PC thất bại: ${String(err)}`, msgOpts).catch(() => undefined);
    }
  });

  tgBot.command('restart', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? ctx.message.message_thread_id
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    if (!await isTelegramGroupAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ admin Telegram mới có thể khởi động lại bridge.', replyOpts);
      return;
    }
    if (!hasRestartSupervisor()) {
      await ctx.reply(
        '⚠️ Không có process supervisor. Hãy chạy bridge bằng <code>./run.sh</code> rồi thử lại; nếu tiếp tục, lệnh này sẽ chỉ tắt bot.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }
    await ctx.reply(
      '⚠️ Khởi động lại bridge? Bot sẽ gián đoạn vài giây.',
      {
        ...replyOpts,
        reply_markup: {
          inline_keyboard: [[
            { text: '🔄 Khởi động lại', callback_data: `restart:confirm:${ctx.from.id}` },
            { text: '❌ Huỷ', callback_data: `restart:cancel:${ctx.from.id}` },
          ]],
        },
      },
    );
  });

  // /setup – interactive env wizard (bool via inline buttons, free-form via chat input)
  tgBot.command('setup', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? ctx.message.message_thread_id
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};
    if (!await isTelegramGroupAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Chỉ admin Telegram mới có thể cấu hình bridge.', replyOpts);
      return;
    }
    if (hasActiveSetup(ctx.from.id)) {
      await ctx.reply('⚙️ Đang có phiên cấu hình — hoàn tất nó trước (hoặc bấm Huỷ).', replyOpts);
      return;
    }
    await ctx.reply(
      '⚙️ Bắt đầu cấu hình bridge. Trả lời từng bước — các biến boolean dùng nút bấm, các biến khác nhập tin nhắn trong nhóm.',
      replyOpts,
    );
    startSetupWizard(ctx.from.id, threadId, (text, opts) => ctx.reply(text, { ...replyOpts, ...opts }));
  });

  // /topic – manage bridge topic mappings
  // Usage inside a topic:  /topic info | /topic delete
  // Usage from General:    /topic list
  tgBot.command('topic', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const arg = (ctx.message.text ?? '').split(/\s+/)[1]?.toLowerCase() ?? '';
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (arg === 'list' || !arg) {
      const all = store.all();
      if (all.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '📭 Chưa có topic nào.', replyOpts);
        return;
      }
      const lines = all.map(e =>
        `• <b>${e.name}</b> — topicId=${e.topicId}, zaloId=${e.zaloId}, type=${e.type === 1 ? 'group' : 'dm'}`,
      );
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `📋 <b>Bridge topics</b> (${all.length}):\n${lines.join('\n')}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Lệnh này phải được gửi trong một topic cụ thể.',
        replyOpts,
      );
      return;
    }

    if (arg === 'info') {
      const entry = store.getEntryByTopic(topicId);
      if (!entry) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `ℹ️ <b>${entry.name}</b>\nzaloId: <code>${entry.zaloId}</code>\ntype: ${entry.type === 1 ? 'group' : 'dm'}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (arg === 'delete') {
      const removed = store.remove(topicId);
      if (!removed) {
        await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
        return;
      }
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🗑️ Đã xoá mapping: <b>${removed.name}</b> (zaloId=${removed.zaloId})`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      '❓ Dùng: <code>/topic list</code> | <code>/topic info</code> | <code>/topic delete</code>',
      { ...replyOpts, parse_mode: 'HTML' },
    );
  });

  // /group_info — show Zalo group metadata and member names for the current topic.
  // Usage inside a Zalo group topic: /group_info [all] or /group_infoall
  const handleGroupInfoCommand = async (ctx: Context & { message: { text?: string; message_thread_id?: number } }, forceAll = false) => {
    if (!ctx.chat || ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Hãy gửi <code>/group_info</code> trong topic của nhóm Zalo cần xem.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const entry = store.getEntryByTopic(topicId);
    if (!entry || entry.type !== 1) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này không phải nhóm Zalo.', replyOpts);
      return;
    }

    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    const showAll = forceAll || /\ball\b/i.test(ctx.message.text ?? '');
    const groupId = entry.zaloId;

    try {
      let groupData = await appGetGroupInfo(groupId);
      if (!groupData) {
        const info = await currentApi.getGroupInfo(groupId) as {
          gridInfoMap?: Record<string, {
            name?: string;
            avt?: string;
            memVerList?: string[];
            currentMems?: Array<{ id: string; dName?: string; zaloName?: string }>;
            totalMember?: number;
            hasMoreMember?: number;
          }>;
        } | undefined;
        groupData = info?.gridInfoMap?.[groupId] ?? null;
      }

      if (!groupData) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          '❌ Không lấy được thông tin nhóm từ Zalo API. Có thể session hết hạn hoặc Zalo đang giới hạn request.',
          replyOpts,
        );
        return;
      }

      const knownNames = new Map<string, string>();
      for (const m of groupData.currentMems ?? []) {
        const name = m.dName?.trim() || m.zaloName?.trim();
        if (m.id && name) knownNames.set(m.id, name);
      }

      const memberUids = Array.from(new Set(
        (groupData.memVerList ?? [])
          .map(s => String(s).split('_')[0])
          .filter(Boolean),
      ));

      const missingUids = memberUids.filter(uid => !knownNames.has(uid));
      if (missingUids.length > 0) {
        const appNames = await appGetGroupMembersInfo(missingUids).catch(() => null);
        for (const uid of missingUids) {
          const name = appNames?.get(uid);
          if (name) knownNames.set(uid, name);
        }
      }

      const members = memberUids
        .map(uid => {
          const profileName = knownNames.get(uid);
          return {
            uid,
            name: aliasCache.get(uid)?.trim() || profileName || uid,
            profileName,
            isAlias: Boolean(aliasCache.get(uid)?.trim()),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'vi'));

      const groupName = groupData.name?.trim() || entry.name;
      const totalMember = groupData.totalMember ?? memberUids.length;
      const resolvedCount = members.filter(m => m.name !== m.uid).length;
      const displayLimit = showAll ? members.length : 120;
      const visibleMembers = members.slice(0, displayLimit);

      const headerLines = [
        `👥 <b>${escapeHtml(groupName)}</b>`,
        `Zalo ID: <code>${escapeHtml(groupId)}</code>`,
        `Thành viên: <b>${totalMember ?? '?'}</b>`,
        `Đọc được tên: <b>${resolvedCount}/${memberUids.length}</b>`,
      ];
      if (totalMember && memberUids.length < totalMember) {
        headerLines.push(``, `⚠️ Nhóm đã bật chế độ ẩn danh sách thành viên. Web API chỉ trả ${memberUids.length}/${totalMember} người.`);
      }
      if (!showAll && members.length > displayLimit) {
        headerLines.push(``, `ℹ️ Đang hiện ${displayLimit}/${members.length} người. Gõ <code>/group_info all</code> để xem hết.`);
      }

      const lines = visibleMembers.map((m, idx) => {
        const suffix = m.name === m.uid
          ? ` <code>${escapeHtml(m.uid)}</code>`
          : (m.isAlias && m.profileName && m.profileName !== m.name ? ` <i>(${escapeHtml(m.profileName)})</i>` : '');
        return `${idx + 1}. ${escapeHtml(m.name)}${suffix}`;
      });

      if (lines.length === 0) {
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `${headerLines.join('\n')}\n\n⚠️ Zalo API không trả danh sách UID thành viên cho nhóm này.`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }

      let chunk = `${headerLines.join('\n')}\n\n<b>Danh sách:</b>`;
      for (const line of lines) {
        const next = `${chunk}\n${line}`;
        if (next.length > 3500) {
          await ctx.telegram.sendMessage(config.telegram.groupId, chunk, { ...replyOpts, parse_mode: 'HTML' });
          chunk = line;
        } else {
          chunk = next;
        }
      }
      if (chunk) {
        await ctx.telegram.sendMessage(config.telegram.groupId, chunk, { ...replyOpts, parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('[/group_info]', err);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `❌ Lỗi lấy thông tin nhóm: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
    }
  };

  tgBot.command('group_info', async (ctx) => handleGroupInfoCommand(ctx));
  tgBot.command('group_infoall', async (ctx) => handleGroupInfoCommand(ctx, true));

  // /history [N] — backfill old GROUP chat history into the current topic.
  // The old HTTP getGroupChatHistory endpoint now returns 404; use the live
  // listener's requestOldMessages WebSocket protocol instead.
  tgBot.command('history', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const topicId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = topicId ? { message_thread_id: topicId } : {};

    if (!topicId) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Hãy gửi <code>/history</code> trong topic của nhóm Zalo cần lấy lịch sử.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const entry = store.getEntryByTopic(topicId);
    if (!entry) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Topic này chưa được map.', replyOpts);
      return;
    }
    if (entry.type !== 1) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '⚠️ Zalo chỉ cho lấy lịch sử của <b>nhóm</b>. Tin nhắn riêng (DM) cũ không lấy được qua API.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }
    if (!currentApi) {
      await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts);
      return;
    }

    const arg = (ctx.message.text ?? '').split(/\s+/)[1];
    let count = Number.parseInt(arg ?? '', 10);
    if (!Number.isFinite(count) || count <= 0) count = 30;
    count = Math.min(count, 50);

    try {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `⏳ Đang lấy ${count} tin nhắn gần nhất của nhóm...`,
        replyOpts,
      );
      const msgs = await requestGroupHistory(currentApi, entry.zaloId, count);
      if (msgs.length === 0) {
        await ctx.telegram.sendMessage(config.telegram.groupId, 'ℹ️ Không có tin nhắn lịch sử nào.', replyOpts);
        return;
      }
      // Oldest → newest so the replayed order matches a natural conversation.
      // Skip polls: replaying a poll-create event would spawn a duplicate live
      // Telegram poll. Reactions/undo/seen arrive on separate listeners (not as
      // 'message'), so they are never replayed here.
      const sorted = (msgs as ZaloMessage[])
        .filter(m => (m as { data?: { msgType?: string } })?.data?.msgType !== ZALO_MSG_TYPES.POLL)
        .sort((a, b) => Number(a?.data?.ts ?? 0) - Number(b?.data?.ts ?? 0));
      // Reuse the live pipeline and AWAIT each message so order is preserved even
      // for slow media; already-synced messages dedupe themselves.
      const replayed = await replayHistoryMessages(sorted);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `✅ Đã nạp ${replayed} tin nhắn lịch sử (tin đã đồng bộ sẽ tự bỏ qua).`,
        replyOpts,
      );
    } catch (err) {
      console.error('[/history]', err);
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `❌ Lỗi lấy lịch sử: ${escapeHtml(err instanceof Error ? err.message : String(err))}`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
    }
  });


  tgBot.command('search', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const threadId = 'message_thread_id' in ctx.message
      ? (ctx.message.message_thread_id as number | undefined)
      : undefined;
    const replyOpts = threadId ? { message_thread_id: threadId } : {};

    const query = (ctx.message.text ?? '').replace(/^\/search(?:@[A-Za-z0-9_]+)?\s*/i, '').trim();
    if (!query) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        '🔍 Cú pháp: <code>/search Tên hoặc số điện thoại</code>\nHỗ trợ cả <code>/search ...</code> lẫn <code>/search@zalo_tele_bridge_bot ...</code>.\nVí dụ số: <code>094.495.3545</code> hoặc <code>094 593 5345</code>.',
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    if (!currentApi) { await ctx.telegram.sendMessage(config.telegram.groupId, '❌ Zalo chưa kết nối', replyOpts); return; }

    const phoneQuery = normalizePhoneSearchQuery(query);
    if (phoneQuery) {
      try {
        const user = await currentApi.findUser(phoneQuery) as {
          uid?: string;
          display_name?: string;
          zalo_name?: string;
        } | undefined;

        if (!user?.uid) {
          await ctx.telegram.sendMessage(
            config.telegram.groupId,
            `🔍 Không tìm thấy tài khoản Zalo cho số <b>${phoneQuery}</b>.`,
            { ...replyOpts, parse_mode: 'HTML' },
          );
          return;
        }

        const displayName = user.display_name || user.zalo_name || `Zalo ${user.uid}`;
        const existingTopicId = store.getTopicByZalo(user.uid, 0);
        const button: { text: string; callback_data: string } = existingTopicId !== undefined
          ? { text: `👤 ${displayName} ✅`, callback_data: `sc:${user.uid}` }
          : { text: `👤 ${displayName}`, callback_data: `sc:${user.uid}` };

        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `📱 Tìm thấy theo số <b>${phoneQuery}</b>:

✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có`,
          {
            ...replyOpts,
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[button]],
            },
          },
        );
        return;
      } catch (err) {
        console.error('[/search] findUser failed:', err);
        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `❌ Lỗi tìm số điện thoại <b>${phoneQuery}</b>: ${err instanceof Error ? err.message : String(err)}`,
          { ...replyOpts, parse_mode: 'HTML' },
        );
        return;
      }
    }

    // Fallback: try username search if query is not a phone number
    try {
      const user = await currentApi.findUserByUsername(query) as {
        uid?: string;
        display_name?: string;
        zalo_name?: string;
      } | undefined;

      if (user?.uid) {
        const displayName = user.display_name || user.zalo_name || `Zalo ${user.uid}`;
        const existingTopicId = store.getTopicByZalo(user.uid, 0);
        const button: { text: string; callback_data: string } = existingTopicId !== undefined
          ? { text: `👤 ${displayName} ✅`, callback_data: `sc:${user.uid}` }
          : { text: `👤 ${displayName}`, callback_data: `sc:${user.uid}` };

        await ctx.telegram.sendMessage(
          config.telegram.groupId,
          `🔍 Tìm thấy theo username <b>${escapeHtml(query)}</b>:
✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có`,
          {
            ...replyOpts,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[button]] },
          },
        );
        return;
      }
    } catch { /* username search failed, continue to cache search */ }

    // Refresh friends cache if stale
    if (!friendsCache.isFresh()) {
      try {
        const raw = await currentApi.getAllFriends() as Array<{ userId: string; displayName: string }> | undefined;
        if (raw) {
          friendsCache.set(raw.map(f => ({
            userId:      f.userId,
            displayName: f.displayName,
            alias:       aliasCache.get(f.userId),
          })));
        }
      } catch (err) { console.error('[/search] getAllFriends failed:', err); }
    }

    // Refresh groups cache if stale
    if (!groupsCache.isFresh()) {
      try {
        const rawGroups = await currentApi.getAllGroups() as { gridVerMap?: Record<string, string> } | undefined;
        const groupIds = Object.keys(rawGroups?.gridVerMap ?? {});
        if (groupIds.length > 0) {
          // Fetch info in batches of 50
          const BATCH = 50;
          const allGroupInfo: Array<{ groupId: string; name: string; totalMember: number }> = [];
          for (let i = 0; i < groupIds.length; i += BATCH) {
            const batch = groupIds.slice(i, i + BATCH);
            try {
              const info = await currentApi.getGroupInfo(batch) as {
                gridInfoMap?: Record<string, { name: string; totalMember: number }>;
              } | undefined;
              for (const [gid, g] of Object.entries(info?.gridInfoMap ?? {})) {
                allGroupInfo.push({ groupId: gid, name: g.name, totalMember: g.totalMember });
              }
            } catch { /* skip batch on error */ }
          }
          groupsCache.set(allGroupInfo);
        }
      } catch (err) { console.error('[/search] getAllGroups failed:', err); }
    }

    const friendResults = friendsCache.search(query, 8);
    const groupResults  = groupsCache.search(query, 8);

    if (friendResults.length === 0 && groupResults.length === 0) {
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        `🔍 Không tìm thấy bạn bè hay nhóm nào có tên chứa "<b>${query}</b>".`,
        { ...replyOpts, parse_mode: 'HTML' },
      );
      return;
    }

    const buttons: Array<Array<{ text: string; callback_data: string } | { text: string; url: string }>> = [];
    for (const f of friendResults) {
      const existingTopicId = store.getTopicByZalo(f.userId, 0);
      const label = aliasCache.label(f.userId, f.displayName);
      buttons.push([existingTopicId !== undefined
        ? { text: `👤 ${label} ✅`, callback_data: `sc:${f.userId}` }
        : { text: `👤 ${label}`, callback_data: `sc:${f.userId}` }]);
    }
    for (const g of groupResults) {
      const existingTopicId = store.getTopicByZalo(g.groupId, 1);
      buttons.push([existingTopicId !== undefined
        ? { text: `👥 ${g.name} (${g.totalMember} TV) ✅`, callback_data: `sg:${g.groupId}` }
        : { text: `👥 ${g.name} (${g.totalMember} TV)`, callback_data: `sg:${g.groupId}` }]);
    }

    const parts: string[] = [`🔍 Kết quả "<b>${query}</b>":`, ''];
    if (friendResults.length > 0) parts.push(`👤 <b>Bạn bè</b> (${friendResults.length}):`);
    if (groupResults.length > 0)  parts.push(`👥 <b>Nhóm</b> (${groupResults.length}):`);
    parts.push('', '✅ = đã có topic • Nhấn để mở nếu đã map, hoặc tạo nếu chưa có');

    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      parts.join('\n'),
      { ...replyOpts, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } },
    );
  });


  // /status — bridge uptime, topic count, Zalo account
  tgBot.command('status', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    const replyOpts = ctx.message.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    const uptimeSec = Math.floor((Date.now() - _bridgeStartTime) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;
    const uptimeStr = `${h}g ${m}p ${s}s`;
    const all = store.all();
    const groupCount = all.filter(e => e.type === 1).length;
    const dmCount    = all.length - groupCount;
    let accountLine = '\n👤 Zalo: <b>chưa kết nối</b>';
    if (currentApi) {
      try {
        const info = await currentApi.fetchAccountInfo() as {
          profile?: { displayName?: string; zaloName?: string };
        };
        const name = info?.profile?.displayName ?? info?.profile?.zaloName ?? '?';
        accountLine = `\n👤 Zalo: <b>${escapeHtml(name)}</b> 🟢`;
      } catch {
        accountLine = '\n👤 Zalo: đã kết nối 🟢';
      }
      accountLine += `\n🆔 ID: <code>${escapeHtml(currentApi.getOwnId())}</code>`;
    }
    await ctx.telegram.sendMessage(
      config.telegram.groupId,
      `📊 <b>Trạng thái Bridge</b>${accountLine}\n` +
      `⏱ Uptime: <code>${uptimeStr}</code>\n` +
      `📌 Topics: <b>${all.length}</b> (${groupCount} nhóm, ${dmCount} DM)`,
      { parse_mode: 'HTML' },
    );
  });

  // ── /seed — show backup decryption seed ──────────────────────────────────
  tgBot.command('seed', async (ctx) => {
    if (ctx.chat.type !== 'private') {
      await ctx.reply('🔒 Hãy gửi <code>/seed</code> trong tin nhắn riêng với bot để tránh lộ khoá.', { parse_mode: 'HTML' });
      return;
    }
    if (!await requireTelegramOperator(ctx, 'xem khoá giải mã backup')) return;
    const replyOpts = ctx.message.message_thread_id
      ? { message_thread_id: ctx.message.message_thread_id }
      : {};
    const sess = loadAppSession();
    if (!sess) {
      await ctx.reply('❌ Chưa có session App API (app-session.json chưa sẵn sàng).', { parse_mode: 'HTML', ...replyOpts });
      return;
    }
    if (!sess.dkey) {
      await ctx.reply('❌ Không tìm thấy <code>dkey</code> trong session App API.', { parse_mode: 'HTML', ...replyOpts });
      return;
    }
    await ctx.reply(
      `🔑 <b>Backup decryption seed (dkey)</b>\n\n<code>${sess.dkey}</code>`,
      { parse_mode: 'HTML', ...replyOpts },
    );
  });

  // ── Admin panel ──────────────────────────────────────────────────────────

  // ── /update — manual update check ────────────────────────────────────────
  tgBot.command('update', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    if (!await requireTelegramOperator(ctx, 'cập nhật bridge')) return;
    const { triggerUpdateCheck } = await import('../updater.js');
    const found = await triggerUpdateCheck(ctx.telegram);
    if (!found) {
      await ctx.reply('✅ Bridge đã ở phiên bản mới nhất.', { parse_mode: 'HTML' });
    }
  });

  /** Reusable back-to-menu markup */
  const adminBackMarkup = () => ({
    inline_keyboard: [[{ text: '◀️ Quay lại', callback_data: 'admin:menu' }]],
  });

  tgBot.command('admin', async (ctx) => {
    if (ctx.chat.id !== config.telegram.groupId) return;
    if (!await requireTelegramOperator(ctx, 'mở admin panel')) return;

    // /admin lookup — reply to a message to see its mapping
    const text = 'text' in ctx.message ? ctx.message.text ?? '' : '';
    const parts = text.split(/\s+/);
    if (parts.length >= 2 && parts[1] === 'lookup') {
      const reply = 'reply_to_message' in ctx.message
        ? (ctx.message as { reply_to_message?: { message_id: number } }).reply_to_message
        : undefined;
      if (!reply) {
        await ctx.reply('ℹ️ Reply vào tin nhắn muốn tra mapping rồi gõ /admin lookup');
        return;
      }
      const sent = sentMsgStore.get(reply.message_id);
      const quote = msgStore.getQuote(reply.message_id);
      const lines: string[] = [
        `🔍 <b>Mapping tgMsgId=${reply.message_id}</b>`,
        `━━━━━━━━━━━━━━━━`,
      ];
      if (sent) {
        lines.push(`📤 <b>sentMsgStore</b>`);
        lines.push(`   MsgIds: <code>[${sent.msgIds.join(', ')}]</code>`);
        lines.push(`   ZaloId: <code>${sent.zaloId}</code>`);
        lines.push(`   Type:   <code>${sent.threadType === 1 ? 'Group' : 'User'}</code>`);
      } else {
        lines.push(`📤 sentMsgStore: <i>không tìm thấy</i>`);
      }
      if (quote) {
        lines.push(`💬 <b>msgStore quote</b>`);
        lines.push(`   MsgId:    <code>${quote.msgId}</code>`);
        lines.push(`   CliMsgId: <code>${quote.cliMsgId}</code>`);
        lines.push(`   UidFrom:  <code>${quote.uidFrom}</code>`);
      } else {
        lines.push(`💬 msgStore quote: <i>không tìm thấy</i>`);
      }
      await ctx.reply(lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup: adminBackMarkup(),
      });
      return;
    }

    const markup = {
      inline_keyboard: [
        [{ text: '📊 Trạng thái', callback_data: 'admin:status' }],
        [{ text: '🗄 Dung lượng cache', callback_data: 'admin:cache' }],
        [{ text: '🔍 Tra mapping', callback_data: 'admin:lookup' }],
        [{ text: '↩️ Đóng', callback_data: 'admin:close' }],
      ],
    };
    await ctx.reply(
      '🛠 <b>ADMIN PANEL</b>\nChọn một mục bên dưới:',
      { parse_mode: 'HTML', reply_markup: markup },
    );
  });

  tgBot.on('callback_query', async (ctx) => {
    const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

    if (data?.startsWith('setup:')) {
      const callbackMessage = ctx.callbackQuery.message;
      const setupChatId = callbackMessage?.chat.id;
      const setupThreadId = callbackMessage && 'message_thread_id' in callbackMessage
        ? callbackMessage.message_thread_id
        : undefined;
      if (setupChatId === undefined) return;
      const send = (text: string, opts?: object) => ctx.telegram.sendMessage(setupChatId, text, {
        ...(setupThreadId !== undefined ? { message_thread_id: setupThreadId } : {}),
        ...opts,
      });
      await handleSetupCallback(ctx, data, isTelegramGroupAdmin, send);
      return;
    }

    if (data?.startsWith('restart:')) {
      const [, action, ownerId] = data.split(':');
      if (String(ctx.from.id) !== ownerId || !await isTelegramGroupAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Bạn không có quyền thao tác.', { show_alert: true });
        return;
      }
      if (action === 'cancel') {
        await ctx.answerCbQuery('Đã huỷ.');
        await ctx.editMessageText('❌ Đã huỷ khởi động lại.').catch(() => undefined);
        return;
      }
      if (action === 'confirm') {
        if (!hasRestartSupervisor()) {
          await ctx.answerCbQuery('Không có process supervisor.', { show_alert: true });
          return;
        }
        await ctx.answerCbQuery('Đang khởi động lại…');
        await ctx.editMessageText('🔄 Bridge đang khởi động lại…').catch(() => undefined);
        setTimeout(() => { void requestShutdown('Restart requested from Telegram', 43); }, 500);
        return;
      }
    }

    // ── admin: admin panel callbacks ───────────────────────────────────────
    if (data?.startsWith('admin:')) {
      if (!await isTelegramGroupAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Chỉ admin Telegram mới có thể thao tác.', { show_alert: true });
        return;
      }
      const action = data.slice(6);
      if (action === 'close') {
        await ctx.deleteMessage().catch(() => undefined);
        return;
      }
      if (action === 'menu') {
        const markup = {
          inline_keyboard: [
            [{ text: '📊 Trạng thái', callback_data: 'admin:status' }],
            [{ text: '🗄 Dung lượng cache', callback_data: 'admin:cache' }],
            [{ text: '🔍 Tra mapping', callback_data: 'admin:lookup' }],
            [{ text: '↩️ Đóng', callback_data: 'admin:close' }],
          ],
        };
        await ctx.editMessageText(
          '🛠 <b>ADMIN PANEL</b>\nChọn một mục bên dưới:',
          { parse_mode: 'HTML', reply_markup: markup },
        );
        return;
      }
      if (action === 'status') {
        const uptimeSec = Math.floor((Date.now() - _bridgeStartTime) / 1000);
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const s = uptimeSec % 60;
        const all = store.all();
        const topicStats = store.stats();
        const uptimeBar = '█'.repeat(Math.min(h, 24)) + '░'.repeat(Math.max(0, 24 - h));
        let zaloStatus = '🔴 Chưa kết nối';
        if (currentApi) {
          try {
            const info = await currentApi.fetchAccountInfo() as { profile?: { displayName?: string } };
            zaloStatus = `🟢 ${escapeHtml(info?.profile?.displayName ?? '?')}`;
          } catch { zaloStatus = '🟢 Đã kết nối'; }
        }
        const text =
          `📊 <b>TRẠNG THÁI</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `⏱ <b>Uptime</b>\n` +
          `   ${uptimeBar} <code>${h}g ${m}p ${s}s</code>\n` +
          `👤 <b>Zalo</b>\n` +
          `   ${zaloStatus}\n` +
          `📌 <b>Topics</b>\n` +
          `   Tổng: <b>${all.length}</b> | Nhóm: <code>${all.filter(e => e.type === 1).length}</code> | DM: <code>${all.filter(e => e.type === 0).length}</code>\n` +
          `💾 <b>Topic file</b>\n` +
          `   ${(topicStats.sizeBytes / 1024).toFixed(1)} KB`;
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminBackMarkup() });
        return;
      }
      if (action === 'cache') {
        const m = msgStore.stats();
        const uc = userCache.stats();
        const fc = friendsCache.stats();
        const gc = groupsCache.stats();
        const sm = sentMsgStore.stats();
        const rs = reactionSummaryStore.stats();
        const mPct = Math.round((m.cacheSize / 2000) * 100);
        const smPct = Math.round((sm.entries / 5000) * 100);
        const ucPct = Math.round((uc.users / 5000) * 100);
        const mBar = '█'.repeat(Math.min(Math.round(mPct / 5), 20)) + '░'.repeat(Math.max(0, 20 - Math.round(mPct / 5)));
        const text =
          `🗄 <b>DUNG LƯỢNG CACHE</b>\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📨 <b>msgStore</b>\n` +
          `   ${mBar} <code>${m.cacheSize}/2000</code> (${mPct}%)\n` +
          `   Keys: <code>${m.cacheSize}</code> | Order: <code>${m.keyOrderLen}</code> | Quotes: <code>${m.quoteCount}</code>\n` +
          `📤 <b>sentMsgStore</b>\n` +
          `   <code>${sm.entries}/5000</code> (${smPct}%)\n` +
          `👥 <b>userCache</b>\n` +
          `   <code>${uc.users}/5000</code> (${ucPct}%) | Groups: <code>${uc.groups}</code>\n` +
          `👫 <b>friendsCache</b>: <code>${fc.count}</code>\n` +
          `🏘 <b>groupsCache</b>: <code>${gc.count}</code>\n` +
          `❤️ <b>reactionSummaries</b>: <code>${rs.entries}</code>`;
        await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: adminBackMarkup() });
        return;
      }
      if (action === 'lookup') {
        await ctx.editMessageText(
          '🔍 <b>TRA MAPPING</b>\n' +
          '━━━━━━━━━━━━━━━━\n' +
          'Reply vào tin nhắn cần tra rồi gõ:\n' +
          '<code>/admin lookup</code>',
          { parse_mode: 'HTML', reply_markup: adminBackMarkup() },
        );
        return;
      }
      return;
    }

    if (!data?.startsWith('sc:') && !data?.startsWith('sg:')) return;

    const isGroup = data.startsWith('sg:');
    const entityId = data.slice(3);
    if (!entityId) { await ctx.answerCbQuery('❌ Dữ liệu không hợp lệ'); return; }
    const threadType: 0 | 1 = isGroup ? 1 : 0;

    // Check if topic already exists and is still alive on Telegram
    const existing = store.getTopicByZalo(entityId, threadType);
    if (existing !== undefined) {
      // Verify the topic still exists by sending a test (or use getForumTopicIconStickers as a proxy)
      // Verify the topic is still alive by actually sending a message to it.
      // sendChatAction doesn't validate thread existence — sendMessage does.
      let topicAlive = false;
      let probeMsg: { message_id: number } | undefined;
      try {
        probeMsg = await ctx.telegram.sendMessage(
          config.telegram.groupId,
          '💬 Topic đang hoạt động. Nhấn để xem.',
          {
            message_thread_id: existing,
            reply_markup: { inline_keyboard: [[{ text: 'Mở topic ↗', url: buildTopicUrl(existing) }]] },
          },
        );
        topicAlive = true;
      } catch (checkErr) {
        const checkMsg = checkErr instanceof Error ? checkErr.message : String(checkErr);
        if (
          checkMsg.includes('thread not found') ||
          checkMsg.includes('message thread not found') ||
          checkMsg.includes('TOPIC_CLOSED') ||
          checkMsg.includes('the message thread is closed')
        ) {
          console.warn(`[sc/sg] Topic ${existing} is gone — removing stale mapping for ${entityId}`);
          store.remove(existing);
        } else {
          // Unknown error (e.g. rate limit) — assume alive, don't recreate
          topicAlive = true;
        }
      }
      if (topicAlive) {
        await ctx.answerCbQuery('ℹ️ Topic đã tồn tại');
        return;
      }
      // Topic gone — fall through to recreate
    }

    // Resolve display name — for DMs: alias (tên danh bạ) takes priority
    let displayName: string | undefined;
    if (!isGroup) {
      // Check alias first
      displayName = aliasCache.get(entityId);
      if (!displayName) {
        // Fallback: friendsCache, then getUserInfo
        displayName = friendsCache.get(entityId)?.displayName;
      }
      if (!displayName) {
        try {
          const resp = await currentApi?.getUserInfo(entityId) as {
            changed_profiles?: Record<string, { displayName?: string }>;
          } | undefined;
          displayName = resp?.changed_profiles?.[entityId]?.displayName;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Zalo ${entityId}`;
    } else {
      displayName = groupsCache.search('', Number.MAX_SAFE_INTEGER).find(g => g.groupId === entityId)?.name;
      if (!displayName) {
        try {
          const info = await currentApi?.getGroupInfo(entityId) as {
            gridInfoMap?: Record<string, { name: string }>;
          } | undefined;
          displayName = info?.gridInfoMap?.[entityId]?.name;
        } catch { /* ignore */ }
      }
      if (!displayName) displayName = `Nhóm ${entityId}`;
    }

    // Create TG forum topic
    try {
      const icon = isGroup ? 0x6FB9F0 : 0xFF93B2;
      const prefix = isGroup ? '👥' : '👤';
      const topic = await ctx.telegram.createForumTopic(
        config.telegram.groupId,
        `${prefix} ${displayName}`.slice(0, 128),
        { icon_color: icon },
      );
      const topicId = topic.message_thread_id;
      store.set({ topicId, zaloId: entityId, type: threadType, name: displayName });
      console.log(`[search/cb] Created ${isGroup ? 'group' : 'DM'} topic "${displayName}" (topicId=${topicId})`);

      await ctx.answerCbQuery('✅ Đã tạo topic!');
      await ctx.telegram.sendMessage(
        config.telegram.groupId,
        isGroup
          ? `✅ Đã tạo topic cho nhóm <b>${displayName}</b>.\nTin nhắn từ nhóm sẽ xuất hiện tại đây.`
          : `✅ Đã tạo topic cho <b>${displayName}</b>.\nTin nhắn từ họ sẽ xuất hiện tại đây.`,
        { message_thread_id: topicId, parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[search/cb] createForumTopic failed:', err);
      await ctx.answerCbQuery('❌ Tạo topic thất bại');
    }
  });


  return setCurrentApi;
}

// Called by setupTelegramHandler, but defined after so we can reference tgBot directly.
