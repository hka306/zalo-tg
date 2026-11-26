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
- đăng nhập **không dùng QR**: dùng lại phiên Zalo PC đã đăng nhập trên máy (xem [Đăng nhập](#đăng-nhập-không-qr)).

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

## Cách sử dụng

Luồng dùng từ đầu đến cuối:

**1. Chuẩn bị Telegram (làm một lần)**

- Tạo bot với [@BotFather](https://t.me/BotFather) → lấy `TG_TOKEN`.
- Tạo một **supergroup**, vào *Manage group → Topics* để **bật forum topics**.
- Thêm bot vào group và đặt làm **admin**.
- Lấy `TG_GROUP_ID` (số âm, dạng `-100…`): tạm thêm `@getidsbot` / `@RawDataBot` vào group để đọc ID, hoặc xem trong log khi app khởi động.

**2. Chạy app trên máy có Zalo PC**

- Đảm bảo đang **đăng nhập Zalo PC** trên máy Windows.
- Điền `TG_TOKEN` + `TG_GROUP_ID` vào `.env`, rồi `npm ci && npm run build && npm start` (chi tiết ở [Cài đặt & chạy](#cài-đặt--chạy)).
- App tự đọc phiên Zalo PC và bắt đầu theo dõi — **không quét QR**.

**3. Bắt đầu theo dõi một hội thoại**

- Trong group Telegram, gõ `/search Tên hoặc số điện thoại` để tìm bạn bè / nhóm Zalo, chọn kết quả → bridge tạo một **topic** riêng cho hội thoại đó.
- Từ đó, mọi tin nhắn mới của hội thoại (DM hoặc nhóm) sẽ chảy vào đúng topic.
- Với nhóm: gõ `/history` trong topic để nạp lịch sử gần đây; `/group_infoall` để xem đầy đủ thành viên (kể cả nhóm ẩn danh sách).

**4. Hằng ngày**

- Tin nhắn, ảnh, file, sticker, GIF, voice, poll, reaction… hiện trong topic tương ứng.
- Tin bị **thu hồi** trên Zalo vẫn giữ nguyên nội dung, chỉ thêm một dòng `🗑 Tin nhắn này đã bị thu hồi trên Zalo`.
- Kiểm tra trạng thái bằng `/status`. Xem toàn bộ lệnh ở [Lệnh Telegram](#lệnh-telegram).

**5. Khi mất kết nối**

- App tự đọc lại phiên Zalo PC để nối lại. Nếu phiên đã lưu không dùng được (không phải lỗi mạng), app tự đóng Zalo PC, lấy phiên mới, rồi mở lại Zalo PC nếu nó đang chạy trước đó. Nếu Zalo báo trùng/kick phiên, gõ `/loginlocal` trên máy có Zalo PC.
- Nên **đóng app Zalo PC sau khi bridge đã có phiên** để tránh hai client tranh chấp kết nối (xem [Ghi chú vận hành](#ghi-chú-vận-hành)).

## Biến môi trường

| Biến | Mặc định / ví dụ | Công dụng |
| --- | --- | --- |
| `TG_TOKEN` | bắt buộc | Telegram bot token từ @BotFather. |
| `TG_GROUP_ID` | bắt buộc, ví dụ `-1001234567890` | ID Telegram supergroup/forum (số âm; bot là admin; bật Topics). |
| `DATA_DIR` | `./data` | Thư mục lưu topic map, message map, user cache, poll. |
| `ZALO_CREDENTIALS_PATH` | `./credentials.json` | File phiên Zalo. Không commit. |
| `ZALO_PC_DATA_DIR` | tự dò `%APPDATA%\ZaloData` | Nơi `/loginlocal` đọc dữ liệu Zalo PC (Windows). |
| `ZALO_SKIP_MUTED_GROUPS` | `0` | `1` bỏ qua tin từ nhóm Zalo đã mute. |
| `ZALO_MUTE_SILENT` | `1` | `1` mirror thread đã mute thành tin Telegram silent; `0` luôn notify. |
| `ZALO_DM_NATIVE_REACTION` | `1` | `1` hiện reaction DM dạng native trên Telegram; `0` dùng reply tổng hợp. |
| `ZALO_EXCLUDE_THREADS` | trống | Danh sách thread không mirror: `type:id` (0=DM, 1=nhóm), phân tách bằng dấu phẩy. |
| `ZALO_TG_TUI` | bật | `0` tắt dashboard TUI, in log thường. |

Xem [.env.example](.env.example) để có template đầy đủ (gồm các biến TUI khác).

## Lệnh Telegram

| Lệnh | Công dụng |
| --- | --- |
| `/loginlocal` | Đăng nhập bằng phiên Zalo PC trên máy (Windows), không QR. Lệnh tự đóng Zalo PC, lấy phiên rồi mở lại (có thể mất nháp chưa gửi). |
| `/search` | Tìm bạn bè / nhóm Zalo và tạo/mở topic. |
| `/contacts` | Gửi toàn bộ bạn bè Zalo kèm ID vào chat riêng của operator, dạng file `.txt`. |
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
| `tests/*.test.ts` | Unit/regression test cho store, media, format, config. |

## Ghi chú vận hành

- Bot Telegram phải là admin và group phải bật forum topics.
- Chạy `npm run check` trước khi push.
- Chạy local: nên **đóng app Zalo PC sau khi app đã có phiên** để tránh tranh chấp kết nối (app và Zalo PC là hai client cùng loại, có thể kick nhau). App đọc phiên từ đĩa nên không cần Zalo PC mở sẵn.
- Nếu Zalo báo duplicate/kicked session: gõ `/loginlocal` trên máy có Zalo PC để nối lại.
- `credentials.json` và `app-session.json` là dữ liệu nhạy cảm — không commit, giữ quyền chỉ chủ sở hữu đọc.
