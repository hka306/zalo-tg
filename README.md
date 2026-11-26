# Cầu nối Zalo → Telegram (chỉ theo dõi)

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

> **Một app chạy ngay trên máy đang đăng nhập Zalo PC**: theo dõi tin nhắn Zalo (DM và nhóm) và đẩy sang **bot Telegram bạn đã cấu hình sẵn**. Chỉ một chiều Zalo → Telegram (monitoring only) — không gửi ngược từ Telegram sang Zalo, và không cần quét QR.

Repo: `hka306/zalo-tg`.

## Bridge làm gì

`zalo-tg` biến một Telegram supergroup (bật forum topic) thành nơi đọc/theo dõi Zalo:

- mỗi DM hoặc nhóm Zalo được ánh xạ vào một Telegram topic riêng;
- tin nhắn, ảnh, file, sticker, GIF, voice, poll, album, phản ứng (reaction) và sự kiện nhóm từ Zalo được chuyển vào đúng topic;
- khi một tin Zalo bị **thu hồi**, bridge **giữ nguyên nội dung đã chuyển** và chỉ reply một dòng báo `🗑 Tin nhắn này đã bị thu hồi trên Zalo`;
- đăng nhập **không dùng QR**: dùng lại phiên Zalo PC đã đăng nhập trên máy (xem [Đăng nhập](#đăng-nhập-không-qr) và [Agent đồng bộ phiên](#agent-đồng-bộ-phiên-máy-windows--vps)).

Bridge dùng **một** tài khoản Zalo. Trạng thái Zalo API, credentials, topic mapping và cache đều là global singleton.

### Không còn những gì (so với bản gốc)

Bản này đã **bỏ hẳn** để chỉ phục vụ việc theo dõi:

- Đăng nhập QR (`/login`, `/loginweb`, `/loginapp`).
- Chiều Telegram → Zalo: không gương tin nhắn/ảnh/sticker/reaction/poll sang Zalo; bỏ các lệnh ghi (`/addfriend`, `/addgroup`, `/joingroup`, `/leavegroup`, `/friendrequests`, `/recall`).
- Tự trả lời DM (`/autoreply`).

## Yêu cầu

- Node.js `>=20.11` và npm
- Git
- Một Telegram bot token (từ @BotFather)
- Một Telegram supergroup đã **bật forum topics**, và bot là **admin** trong group đó
- Một tài khoản Zalo đã đăng nhập **Zalo PC trên máy Windows** (để lấy phiên, không cần QR)

## Cài đặt & chạy

Chạy **ngay trên máy Windows đang đăng nhập Zalo PC** (đơn giản nhất, không cần server riêng). Cấu hình bot Telegram **trước khi chạy** (điền `.env` bên dưới), rồi khởi động là app tự đăng nhập Zalo và bắt đầu theo dõi.

```bash
git clone https://github.com/hka306/zalo-tg.git
cd zalo-tg
npm ci
# tạo file .env (xem bên dưới)
npm run build
npm start          # hoặc: npm run dev (chạy bằng tsx, không cần build)
```

Hai biến `.env` **bắt buộc**:

```env
TG_TOKEN=123456:telegram-bot-token
TG_GROUP_ID=-1001234567890
```

Các biến còn lại có thể cấu hình qua bot: điền 2 biến trên rồi gửi `/setup` trong group bridge (chỉ admin) — wizard hỏi từng biến tuỳ chọn rồi ghi vào `.env` (áp dụng bằng `/restart`).

## Đăng nhập (không QR)

Chạy trên máy có Zalo PC thì **không cần làm gì thêm**: lúc khởi động, app tự đọc phiên Zalo PC đang đăng nhập trên máy (giải mã `imei` + cookie `zpw_sek` sống từ kho dữ liệu Zalo PC) và đăng nhập ngay — không QR. Khi mất kết nối, app tự đọc lại phiên mới trên máy để nối lại.

Muốn nạp phiên thủ công: gõ **`/loginlocal`** trong group Telegram. Nếu chưa có phiên hợp lệ, app báo `⚠️ Không có đăng nhập Zalo.`

Phiên được lưu trong `credentials.json` (`{imei, cookie, userAgent}`, **portable** theo imei). Chỉ chạy trên **Windows**, cùng user Windows với Zalo PC (cookie mã hoá bằng DPAPI theo user).

> Tính năng **xem đầy đủ thành viên nhóm ẩn danh sách** vẫn hoạt động: sau mỗi lần đăng nhập, bridge tự sinh `app-session.json` (khoá `zpw_enk` + cookie từ chính phiên đang đăng nhập) để gọi PC App API — không cần QR. Nếu không sẵn sàng, bridge tự fallback sang web API (nhóm ẩn có thể chỉ thấy một phần).

## Tuỳ chọn: chạy trên VPS (agent đồng bộ phiên)

> Chỉ cần khi bạn muốn app chạy trên **VPS/máy chủ khác** (để máy có Zalo tắt vẫn theo dõi được), thay vì chạy thẳng trên máy Zalo PC. Chạy local thì **bỏ qua cả phần này**.

Thư mục `agent/` chứa agent 1 file (`zalo-session-agent.mjs`, chỉ dùng builtin của Node) chạy trên **máy Windows đang đăng nhập Zalo PC**. Mỗi lần chạy, agent kiểm tra máy có đang đăng nhập Zalo PC hay không:

- **Có** → trích phiên; **chỉ khi cookie đổi** mới đẩy `credentials.json` mới sang VPS qua `scp`. Bridge trên VPS theo dõi `credentials.json`, tự đăng nhập lại và báo lên Telegram (`🔄 đã đăng nhập lại` / `⚠️ cần đăng nhập lại`) — không cần quét QR.
- **Không** → báo `⚠️ Không có đăng nhập Zalo trên máy` lên bot Telegram (chỉ báo khi trạng thái đổi, không spam mỗi lần chạy).

```
Windows (Zalo PC)                         VPS (bridge)
┌──────────────────────┐   scp phiên mới  ┌──────────────────────────┐
│ zalo-session-agent   │ ───────────────▶ │ credentials.json          │
│  (mỗi 60 phút,       │                  │   ▼ watchFile phát hiện   │
│   chỉ gửi khi đổi)   │                  │ đăng nhập lại → Telegram  │
└──────────────────────┘                  └──────────────────────────┘
```

**Yêu cầu agent:** Windows (cùng user với Zalo PC), Zalo PC đã đăng nhập, Node `>=22.5` (cần `node:sqlite` đọc cookie DB), OpenSSH client (`scp`), và SSH key sang VPS.

**Cấu hình** — tạo `agent/zalo-agent.config.json` (xem `agent/zalo-agent.config.example.json`):

```json
{
  "scpTarget": "user@your-vps:/opt/zalo-tg/credentials.json",
  "sshKey": "C:\\Users\\YOU\\.ssh\\id_ed25519",
  "scpPort": 22,
  "intervalMinutes": 60,
  "telegram": { "botToken": "123456:...", "chatId": "-1001234567890" }
}
```

- `scpTarget`: `user@host:<đường dẫn credentials.json của bridge>` (phải trùng `ZALO_CREDENTIALS_PATH` trên VPS).
- `telegram` (tuỳ chọn): để agent báo khi máy mất phiên Zalo; dùng cùng bot token + chat id với bridge.
- Có thể thay bằng biến môi trường: `ZALO_AGENT_SCP_TARGET`, `ZALO_AGENT_SSH_KEY`, `ZALO_AGENT_SCP_PORT`, `ZALO_AGENT_TG_BOT_TOKEN`, `ZALO_AGENT_TG_CHAT_ID`.

**Chạy agent:**

```powershell
node zalo-session-agent.mjs --selftest   # tự kiểm tra logic so cookie
node zalo-session-agent.mjs --once       # trích + đẩy 1 lần (nếu cookie đổi)
node zalo-session-agent.mjs              # chạy ngầm, lặp mỗi intervalMinutes phút
```

Bền hơn: tạo Windows Task Scheduler chạy `node C:\path\agent\zalo-session-agent.mjs --once` mỗi 60 phút (chạy trong phiên user có Zalo PC).

> `credentials.json` = toàn quyền tài khoản Zalo. Agent đẩy qua SSH (mã hoá), không mở cổng mới trên VPS. Giữ SSH key và file cấu hình an toàn. `credentials.json`, `app-session.json`, `agent/zalo-agent.config.json`, `agent/zalo-agent-state.json` đều nằm trong `.gitignore` — không commit.

## Biến môi trường

| Biến | Mặc định / ví dụ | Công dụng |
| --- | --- | --- |
| `TG_TOKEN` | bắt buộc | Telegram bot token từ @BotFather. |
| `TG_GROUP_ID` | bắt buộc, ví dụ `-1001234567890` | ID Telegram supergroup/forum (số âm; bot là admin; bật Topics). |
| `DATA_DIR` | `./data` | Thư mục lưu topic map, message map, user cache, poll. |
| `ZALO_CREDENTIALS_PATH` | `./credentials.json` | File phiên Zalo. Phải trùng `scpTarget` của agent. Không commit. |
| `ZALO_PC_DATA_DIR` | tự dò `%APPDATA%\ZaloData` | Nơi `/loginlocal` đọc dữ liệu Zalo PC (Windows). |
| `ZALO_SKIP_MUTED_GROUPS` | `0` | `1` bỏ qua tin từ nhóm Zalo đã mute. |
| `ZALO_MUTE_SILENT` | `1` | `1` mirror thread đã mute thành tin Telegram silent; `0` luôn notify. |
| `ZALO_DM_NATIVE_REACTION` | `1` | `1` hiện reaction DM dạng native trên Telegram; `0` dùng reply tổng hợp. |
| `ZALO_EXCLUDE_THREADS` | trống | Danh sách thread không mirror: `type:id` (0=DM, 1=nhóm), phân tách bằng dấu phẩy. |
| `LOCAL_BOT_API` | `0` | `1` gửi Bot API qua `TG_LOCAL_SERVER` (xử lý file lớn ổn hơn). |
| `TG_LOCAL_SERVER` | `http://127.0.0.1:8081` | Endpoint Local Bot API (chỉ khi `LOCAL_BOT_API=1`). |
| `ZALO_TG_TUI` | bật | `0` tắt dashboard TUI, in log thường. |

Xem [.env.example](.env.example) để có template đầy đủ (gồm các biến TUI/Docker khác).

## Lệnh Telegram

| Lệnh | Công dụng |
| --- | --- |
| `/loginlocal` | Đăng nhập bằng phiên Zalo PC trên máy (Windows), không QR. |
| `/search` | Tìm bạn bè / nhóm Zalo và tạo/mở topic. |
| `/group_info` | Xem thông tin & thành viên nhóm Zalo của topic hiện tại. |
| `/group_infoall` | Xem đầy đủ thành viên nhóm (kể cả nhóm ẩn danh sách). |
| `/topic` | Liệt kê, xem, xoá hoặc quản lý mapping topic. |
| `/history` | Nạp lịch sử chat nhóm Zalo vào topic hiện tại. |
| `/status` | Xem trạng thái bridge: uptime, số topic, Zalo. |
| `/admin` | Công cụ diagnostic / cache / tra mapping. |
| `/setup` | Cấu hình biến `.env` qua wizard (chỉ admin). |
| `/restart` | Khởi động lại bridge (chỉ admin). |
| `/update` | Kiểm tra bản cập nhật. |
| `/seed` | Xem mã seed (dkey) giải mã backup Zalo, nếu phiên có. |

## Scripts

| Script | Công dụng |
| --- | --- |
| `npm run dev` | Chạy app TypeScript bằng `tsx`. |
| `npm run build` | Compile TypeScript vào `dist/`. |
| `npm start` | Chạy app đã compile. |
| `npm test` | Chạy toàn bộ test. |
| `npm run check` | Build và chạy full test suite. |

## Dữ liệu & persistence

| Dữ liệu | Vị trí mặc định | Công dụng |
| --- | --- | --- |
| Zalo credentials | `credentials.json` | Cookie đăng nhập zca-js, imei, user agent. **Nhạy cảm.** |
| PC App session | `app-session.json` (cạnh credentials) | `zpw_enk` + cookie cho PC App API (tự sinh từ phiên khi đăng nhập). **Nhạy cảm.** |
| Topic mappings | `data/topics.json` | Telegram topic ↔ hội thoại Zalo. |
| Message mappings | `data/msg-map.json` (hoặc gzip) | Zalo msgId ↔ Telegram msgId + metadata quote. |
| User cache | `data/user-cache.json.gz` | Lookup UID / tên / alias / tên thành viên theo nhóm. |
| Poll cache | `data/polls.json.gz` | Mapping poll Zalo ↔ Telegram. |

## Bản đồ codebase

| Đường dẫn | Vai trò |
| --- | --- |
| `src/index.ts` | Boot process, start Telegram, đăng nhập Zalo, theo dõi `credentials.json`, reconnect, shutdown. |
| `src/config.ts` | Đọc biến môi trường và resolve path. |
| `src/telegram/bot.ts` | Tạo Telegraf bot và đồng bộ menu lệnh. |
| `src/telegram/handler.ts` | Lệnh Telegram, callback (quản lý topic) và các lệnh đọc/quản trị. |
| `src/zalo/client.ts` | Singleton login/session zca-js; tự sinh `app-session.json` từ phiên. |
| `src/zalo/localSession.ts` | Trích phiên Zalo PC đang đăng nhập trên máy (Windows), dùng cho `/loginlocal`. |
| `src/zalo/handler.ts` | Nhận event từ Zalo listener và forward sang Telegram. |
| `src/zalo/appApi.ts` | Gọi PC App API để lấy đầy đủ thành viên nhóm (kể cả nhóm ẩn). |
| `src/store.ts` | Topic/message mapping, cache, media buffer, reaction/poll store. |
| `src/utils/` | media, format, privateFile, terminal, tgQueue, zaloRetry… |
| `src/lifecycle.ts`, `src/updater.ts` | Điều phối shutdown/restart; kiểm tra cập nhật. |
| `agent/zalo-session-agent.mjs` | Agent 1 file trên máy Windows đẩy phiên Zalo sang VPS. |
| `tests/*.test.ts` | Unit/regression test cho store, media, format, config, agent. |

## Ghi chú vận hành

- Bot Telegram phải là admin và group phải bật forum topics.
- Chạy `npm run check` trước khi push.
- Chạy local: nên **đóng app Zalo PC sau khi app đã có phiên** để tránh tranh chấp kết nối (app và Zalo PC là hai client cùng loại, có thể kick nhau). App đọc phiên từ đĩa nên không cần Zalo PC mở sẵn.
- Nếu Zalo báo duplicate/kicked session: trên máy có Zalo PC gõ `/loginlocal` để nối lại; chạy VPS thì agent tự đẩy phiên mới.
- `credentials.json` và `app-session.json` là dữ liệu nhạy cảm — không commit, giữ quyền chỉ chủ sở hữu đọc.
