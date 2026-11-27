# zalo-tg

Repo gồm hai phần tách riêng. Mỗi thư mục có `package.json`, lockfile, `.env.example` và README riêng.

| Thư mục | Chạy ở đâu | Làm gì |
| --- | --- | --- |
| [`vps/`](vps/README.md) | Máy đang đăng nhập Zalo PC (Windows), hoặc VPS | Bridge Zalo → Telegram, chỉ theo dõi. Cài đặt, lệnh, biến môi trường, nạp phiên trên VPS. |
| [`agent/`](agent/README.md) | Máy Windows có Zalo PC | Lấy phiên đăng nhập và gửi về chat riêng với bot Telegram. Không cần bridge hay VPS. |

## Cách dùng

1. **Chạy bridge ngay trên máy có Zalo PC:** làm theo mục "Cài đặt & chạy" trong [vps/README.md](vps/README.md).
2. **Chạy bridge trên VPS:** trên máy Windows, chạy `agent/` để gửi phiên về chat Telegram riêng. Trên VPS, dùng `vps/` để nạp phiên và chạy bridge (mục "Chạy trên VPS bằng phiên từ máy Zalo").

## Lưu ý

- 13 file dùng chung (ví dụ `src/config.ts`, `src/telegram/bot.ts`, `src/utils/redact.ts`, `src/zalo/client.ts`) được sao chép sang cả hai thư mục. Sửa một file thì sửa bản còn lại.
- `zalo-session.json` và `credentials.json` là đăng nhập Zalo đầy đủ. Không commit, và xoá tin nhắn chứa `zalo-session.json` sau khi nạp.
- Cài bridge bằng installer: `sh vps/install.sh`, chạy từ gốc repo.
