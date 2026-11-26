# Zalo session agent (máy Windows → bridge trên VPS)

Agent 1-file chạy trên **máy Windows đang đăng nhập Zalo PC**. Mỗi lần chạy nó
kiểm tra máy có đang đăng nhập Zalo PC hay không:

- **Có** → trích phiên (imei + cookie `zpw_sek` đã giải mã); **chỉ khi cookie đổi**
  mới đẩy `credentials.json` mới lên bridge trên VPS qua `scp`. Bridge tự phát hiện
  file đổi, đăng nhập lại và báo trên bot Telegram — bạn không cần quét lại QR.
- **Không** → báo "không có đăng nhập Zalo" lên bot Telegram (chỉ báo khi trạng
  thái đổi, không spam mỗi lần chạy).

```
Windows (Zalo PC)                         VPS (bridge)
┌──────────────────────┐   scp phiên mới  ┌──────────────────────────┐
│ zalo-session-agent   │ ───────────────▶ │ credentials.json          │
│  (mỗi 60 phút,       │                  │   ▼ watchFile phát hiện   │
│   chỉ gửi khi đổi)   │                  │ đăng nhập lại → Telegram  │
└──────────────────────┘                  └──────────────────────────┘
```

## Yêu cầu

- **Windows**, đăng nhập đúng user Windows với Zalo PC (cookie mã hoá theo user).
- **Zalo PC đã đăng nhập** (không cần mở sẵn — agent đọc cookie đã lưu trên đĩa).
- **Node >= 22.5** (cần `node:sqlite` để đọc cookie DB).
- **OpenSSH client** (`scp`) — có sẵn trên Windows 10/11.
- **SSH key** từ máy Windows tới VPS (khuyến nghị, để không phải nhập mật khẩu).

## Cài đặt

1. Copy cả thư mục `agent/` sang máy Windows (hoặc chỉ `zalo-session-agent.mjs`).

2. Tạo SSH key và đưa public key lên VPS (nếu chưa có):
   ```powershell
   ssh-keygen -t ed25519            # tạo C:\Users\YOU\.ssh\id_ed25519[.pub]
   type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@your-vps "cat >> ~/.ssh/authorized_keys"
   ```

3. Tạo `zalo-agent.config.json` cạnh script (xem `zalo-agent.config.example.json`):
   ```json
   {
     "scpTarget": "user@your-vps:/opt/zalo-tg/credentials.json",
     "sshKey": "C:\\Users\\YOU\\.ssh\\id_ed25519",
     "scpPort": 22,
     "intervalMinutes": 60
   }
   ```
   - `scpTarget`: `user@host:<đường dẫn credentials.json của bridge>`. Đường dẫn này
     phải trùng `ZALO_CREDENTIALS_PATH` của bridge trên VPS (mặc định là
     `credentials.json` trong thư mục chạy bridge).
   - `sshKey`, `scpPort` không bắt buộc. Có thể thay bằng biến môi trường
     `ZALO_AGENT_SCP_TARGET`, `ZALO_AGENT_SSH_KEY`, `ZALO_AGENT_SCP_PORT`.
   - `telegram.botToken` + `telegram.chatId` (không bắt buộc): để agent báo
     "không có đăng nhập Zalo" lên bot Telegram khi máy không còn phiên Zalo PC.
     Dùng cùng bot token và chat id (group) mà bridge đang dùng. Hoặc đặt qua
     `ZALO_AGENT_TG_BOT_TOKEN`, `ZALO_AGENT_TG_CHAT_ID`.

4. Kiểm tra nhanh:
   ```powershell
   node zalo-session-agent.mjs --selftest   # tự kiểm tra logic so cookie
   node zalo-session-agent.mjs --once       # trích + đẩy 1 lần (nếu cookie đổi)
   ```

## Chạy ngầm

**Cách 1 — để script tự lặp** (đơn giản):
```powershell
node zalo-session-agent.mjs      # chạy mãi, kiểm tra mỗi intervalMinutes phút
```

**Cách 2 — Windows Task Scheduler** (bền hơn, tự chạy lại sau reboot): tạo task
chạy mỗi 60 phút với:
- Program: `node` (hoặc đường dẫn đầy đủ tới node.exe)
- Arguments: `C:\path\agent\zalo-session-agent.mjs --once`
- "Run whether user is logged on or not" **tắt** (cần chạy trong phiên user có Zalo).

## Bridge trên VPS phản ứng thế nào

Bridge theo dõi `credentials.json`; khi nội dung đổi (agent đẩy phiên mới) nó dừng
listener cũ, đăng nhập lại bằng phiên mới và gắn lại listener, rồi báo vào group
Telegram:
- `🔄 Zalo đã đăng nhập lại bằng phiên mới (đồng bộ từ máy).`
- `⚠️ Cần đăng nhập lại Zalo — phiên mới đẩy lên không dùng được.` (nếu phiên lỗi)

## Bảo mật

`credentials.json` chứa phiên Zalo = **toàn quyền tài khoản**. Agent đẩy qua SSH
(mã hoá), không mở cổng mới trên VPS. Giữ SSH key và file cấu hình an toàn, phân
quyền chỉ chủ sở hữu đọc được. `credentials.json` và `zalo-agent-state.json` đã
nằm trong `.gitignore` — không commit.

## Lưu ý vận hành

- Nếu vừa dùng Zalo PC trên Windows vừa chạy VPS cùng một phiên, Zalo có thể luân
  chuyển cookie liên tục (thấy 2 client PC). Gọn nhất: đăng nhập Zalo PC một lần
  rồi để VPS làm phiên chạy chính; agent lo đồng bộ khi cookie đổi.
- Nếu phiên hỏng hẳn mà agent chưa cứu kịp, trên VPS vẫn gõ `/login` (quét QR bằng
  điện thoại) để đăng nhập lại.
