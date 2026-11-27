# Zalo Session Export — Extension trình duyệt

Extension Chrome/Edge/Cốc Cốc để xuất phiên đăng nhập Zalo Web, dùng với zalo-tg bridge.

## Cài đặt

1. Mở `chrome://extensions` (hoặc `edge://extensions`).
2. Bật **Developer mode** (Chế độ nhà phát triển).
3. Bấm **Load unpacked** (Tải tiện ích đã giải nén) → chọn thư mục `extension/` này.

## Cách dùng

1. Đăng nhập [chat.zalo.me](https://chat.zalo.me) trên trình duyệt.
2. Bấm icon extension → bấm **Xuất session**.
3. Chọn:
   - **Copy .env** — copy hai dòng `ZALO_BROWSER_IMEI` và `ZALO_BROWSER_ZPW_SEK` để dán vào file `.env` của bridge.
   - **Tải file** — tải `zalo-session.json` để nạp vào bridge qua `npm run agent:import` hoặc `npm run agent:gui`.

## Lưu ý

- Extension chỉ đọc dữ liệu từ trình duyệt, không gửi ra ngoài.
- `zalo-session.json` chứa thông tin đăng nhập đầy đủ. Xoá file sau khi nạp.
- Nếu đăng xuất Zalo Web hoặc cookie hết hạn, cần xuất lại.
