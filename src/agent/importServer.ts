import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { writePrivateJsonFileSync, writePrivateTextFileSync } from '../utils/privateFile.js';
import { decryptSession } from './sessionBundle.js';

export interface SessionJson { imei: string; cookie: unknown; userAgent: string }

export interface ImportServerOptions { token: string; credentialsPath: string; envPath: string }

const MAX_BODY = 1_000_000;
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
const BAD_SESSION = 'File không phải phiên Zalo hợp lệ.';

// Giải mã file phiên từ agent và kiểm tra đủ trường bridge cần, trước khi ghi ra đĩa.
export function openSessionEnvelope(envelope: string, passphrase: string): SessionJson {
  let plain: string;
  try {
    plain = decryptSession(envelope, passphrase);
  } catch {
    throw new Error('Không mở được file: sai AGENT_PASSPHRASE hoặc file đã bị sửa.');
  }
  // Không đưa lỗi JSON.parse ra ngoài: nó có thể chứa một đoạn nội dung phiên.
  let session: Partial<SessionJson> | null;
  try {
    session = JSON.parse(plain) as Partial<SessionJson> | null;
  } catch {
    throw new Error(BAD_SESSION);
  }
  if (!session || typeof session.imei !== 'string' || !session.cookie || typeof session.userAgent !== 'string') {
    throw new Error(BAD_SESSION);
  }
  return session as SessionJson;
}

// Sửa giá trị các khoá trong nội dung .env, giữ nguyên dòng khác. Khoá chưa có thì thêm cuối file.
export function setEnvValues(text: string, values: Record<string, string>): string {
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  const seen = new Set<string>();
  const out = lines.map(line => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (!key || !(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) out.push(`${key}=${value}`);
  }
  return `${out.join('\n')}\n`;
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function reply(res: http.ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function parseBody(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Dữ liệu gửi lên không hợp lệ.');
  }
  if (!value || typeof value !== 'object') throw new Error('Dữ liệu gửi lên không hợp lệ.');
  return value as Record<string, unknown>;
}

function receiveImport(req: http.IncomingMessage, res: http.ServerResponse, opts: ImportServerOptions): void {
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY) {
      reply(res, 413, JSON_TYPE, JSON.stringify({ ok: false, error: 'Dữ liệu quá lớn.' }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    try {
      const { tgToken, groupId, passphrase, envelope } = parseBody(Buffer.concat(chunks).toString('utf8'));
      if (typeof tgToken !== 'string' || !/^\d+:[\w-]+$/.test(tgToken)) throw new Error('Bot token không đúng định dạng.');
      if (typeof groupId !== 'string' || !/^-[1-9]\d*$/.test(groupId)) throw new Error('Group ID phải là số âm, ví dụ -1001234567890.');
      if (typeof passphrase !== 'string' || passphrase.trim().length < 12) throw new Error('AGENT_PASSPHRASE tối thiểu 12 ký tự.');
      if (typeof envelope !== 'string') throw new Error('Thiếu file phiên.');

      const session = openSessionEnvelope(envelope, passphrase.trim());
      writePrivateJsonFileSync(opts.credentialsPath, session);
      const current = existsSync(opts.envPath) ? readFileSync(opts.envPath, 'utf8') : '';
      writePrivateTextFileSync(opts.envPath, setEnvValues(current, { TG_TOKEN: tgToken, TG_GROUP_ID: groupId }));
      reply(res, 200, JSON_TYPE, JSON.stringify({ ok: true }));
    } catch (err) {
      reply(res, 400, JSON_TYPE, JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'Lỗi không xác định.' }));
    }
  });
}

/** Trang web nhỏ để điền cấu hình VPS và nạp file phiên từ agent. Mọi đường dẫn đều cần token. */
export function createImportServer(opts: ImportServerOptions): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!tokenMatches(url.searchParams.get('t'), opts.token)) {
      return reply(res, 401, TEXT_TYPE, 'Sai hoặc thiếu token. Mở đúng đường dẫn đã in trong console.');
    }
    if (req.method === 'GET' && url.pathname === '/') return reply(res, 200, HTML_TYPE, PAGE);
    if (req.method === 'POST' && url.pathname === '/import') return receiveImport(req, res, opts);
    return reply(res, 404, TEXT_TYPE, 'Không có trang này.');
  });
}

const PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nạp phiên Zalo cho bridge</title>
<style>
body{font-family:system-ui,sans-serif;max-width:520px;margin:32px auto;padding:0 16px;color:#222}
label{display:block;margin-top:14px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:8px;margin-top:4px;font-size:15px}
button{margin-top:20px;padding:10px 16px;font-size:15px;cursor:pointer}
#msg{margin-top:16px;white-space:pre-wrap}
.ok{color:#0a7d33}.err{color:#b00020}
</style></head><body>
<h2>Nạp phiên Zalo cho bridge</h2>
<p>Điền bot token, group ID, AGENT_PASSPHRASE và chọn file <code>zalo-session.enc.json</code> do agent gửi về. Sau khi lưu, chạy <code>npm start</code> để bắt đầu.</p>
<label>Bot token (TG_TOKEN)<input id="tok" autocomplete="off"></label>
<label>Group ID (TG_GROUP_ID)<input id="grp" placeholder="-100..." autocomplete="off"></label>
<label>AGENT_PASSPHRASE<input id="pass" type="password" autocomplete="off"></label>
<label>File phiên từ agent<input id="file" type="file" accept=".json,application/json"></label>
<button id="btn">Lưu cấu hình và phiên</button>
<div id="msg"></div>
<script>
const t = new URLSearchParams(location.search).get('t');
document.getElementById('btn').onclick = async () => {
  const msg = document.getElementById('msg');
  const file = document.getElementById('file').files[0];
  if (!file) { msg.className = 'err'; msg.textContent = 'Chưa chọn file phiên.'; return; }
  msg.className = ''; msg.textContent = 'Đang lưu...';
  const body = {
    tgToken: document.getElementById('tok').value.trim(),
    groupId: document.getElementById('grp').value.trim(),
    passphrase: document.getElementById('pass').value,
    envelope: await file.text(),
  };
  const res = await fetch('/import?t=' + encodeURIComponent(t), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'Lỗi không xác định.' }));
  msg.className = data.ok ? 'ok' : 'err';
  msg.textContent = data.ok ? 'Đã lưu. Chạy npm start để bắt đầu.' : data.error;
};
</script></body></html>
`;
