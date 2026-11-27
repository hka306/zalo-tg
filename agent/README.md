# Agent lấy phiên Zalo (máy Windows có Zalo PC)

Thư mục này chỉ có phần agent. Agent đọc phiên Zalo đang đăng nhập trên máy, rồi gửi tóm tắt và file `zalo-session.json` vào chat riêng với bot Telegram. Không cần bridge, không cần VPS để chạy agent.

## Cài đặt (làm một lần)

1. Cài Node.js 22.5 trở lên.
2. Mở thư mục này trong terminal, chạy `npm install`.
3. Copy `.env.example` thành `.env`, rồi điền:
   - `TG_TOKEN`: token bot lấy từ @BotFather.
   - `AGENT_CHAT_ID`: Telegram user id của bạn. Nhắn `/start` cho bot trước.

## Chạy

    npm run agent:export

Lệnh chạy một lần rồi thoát. Nếu Zalo PC đang đăng nhập, bot gửi tóm tắt và `zalo-session.json` vào chat riêng. Nếu không, bot chỉ báo lại.

Sau đó nạp file phiên lên VPS theo hướng dẫn trong thư mục `vps/`.

## Lưu ý

- `zalo-session.json` là đăng nhập Zalo đầy đủ và **chưa mã hoá**. Ai có file, hoặc đọc được chat với bot, đều dùng được tài khoản. Xoá tin nhắn có file sau khi nạp.
- Không commit `.env` và `zalo-session.json`.
- Khi Zalo PC đang mở và khoá file Cookies, agent có thể báo không có tài khoản. Lý do thật chỉ hiện trong console, với tiền tố `[Zalo PC]`.
