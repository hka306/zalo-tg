/**
 * localSession.ts
 * ───────────────
 * Tái dùng phiên Zalo PC đang đăng nhập trên MÁY để khởi tạo zca-js mà không cần
 * quét QR. Đọc `imei` (localStorage `z_uuid`) và giải mã cookie `zpw_sek` đang
 * sống từ kho dữ liệu Zalo PC, trả về đúng bộ `{ imei, cookie, userAgent }` mà
 * `zalo.login()` cần.
 *
 * Giới hạn: chỉ chạy trên Windows, cùng user Windows với Zalo PC (cookie mã hoá
 * bằng DPAPI theo user). Mọi lỗi đều trả `null` để caller tự xử lý (ví dụ báo
 * Telegram là chưa có đăng nhập Zalo).
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

export interface LocalZaloSession {
  imei: string;
  cookie: Record<string, unknown>[];
  userAgent: string;
}

// UA giả lập Zalo PC. Server chỉ đối chiếu chuỗi imei, không tính lại md5(UA),
// nên UA này không cần khớp tuyệt đối với UA thật của Zalo PC.
const ZALO_PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Electron/45.3.3 Safari/537.36';

const IMEI_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{32}/i;

function zaloDataRoot(): string {
  if (process.env.ZALO_PC_DATA_DIR) return process.env.ZALO_PC_DATA_DIR;
  const roaming = process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming');
  return join(roaming, 'ZaloData');
}

/**
 * imei = localStorage `z_uuid` của webview Zalo PC. Đọc byte thô các file
 * .ldb/.log (không mở leveldb như DB) nên không vướng khoá khi Zalo đang chạy.
 */
export function readImeiFromLevelDb(dir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.ldb') || f.endsWith('.log'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs); // mới nhất trước
  } catch {
    return null;
  }
  for (const f of files) {
    const raw = readFileSync(f).toString('latin1');
    for (const s of [raw, raw.replace(/\x00/g, '')]) {
      const k = s.lastIndexOf('z_uuid');
      if (k >= 0) {
        const m = s.slice(k, k + 200).match(IMEI_RE);
        if (m) return m[0];
      }
    }
  }
  for (const f of files) {
    const s = readFileSync(f).toString('latin1');
    const m = s.match(IMEI_RE) ?? s.replace(/\x00/g, '').match(IMEI_RE);
    if (m) return m[0];
  }
  return null;
}

/** DPAPI Unprotect (CurrentUser) qua PowerShell; vào/ra base64. */
function dpapiUnprotect(b64: string): Buffer {
  const ps =
    "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;" +
    "$b=[Convert]::FromBase64String('" + b64 + "');" +
    "$d=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Convert]::ToBase64String($d)';
  const r = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    maxBuffer: 1 << 22,
  });
  return Buffer.from(r.trim(), 'base64');
}

/** Khoá AES chính từ Local State (os_crypt.encrypted_key, bỏ 5 byte tiền tố "DPAPI"). */
function masterKey(root: string): Buffer {
  const ls = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
    os_crypt?: { encrypted_key?: string };
  };
  const b64 = ls.os_crypt?.encrypted_key;
  if (!b64) throw new Error('Local State thiếu os_crypt.encrypted_key');
  const enc = Buffer.from(b64, 'base64'); // "DPAPI" + blob
  return dpapiUnprotect(enc.subarray(5).toString('base64'));
}

const isPrintable = (buf: Buffer): boolean => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(buf.toString('latin1'));

/** Giải mã một cookie Chromium (v10/v11 AES-256-GCM, hoặc DPAPI kiểu cũ). */
export function decryptCookieValue(enc: Buffer, key: Buffer): string {
  const prefix = enc.subarray(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const ct = enc.subarray(15, enc.length - 16);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    dec.setAuthTag(tag);
    const pt = Buffer.concat([dec.update(ct), dec.final()]);
    if (isPrintable(pt)) return pt.toString('utf8'); // v10 DPAPI: không có tiền tố
    if (pt.length > 32 && isPrintable(pt.subarray(32))) return pt.subarray(32).toString('utf8'); // bản mới chèn 32-byte hash(domain)
    return pt.toString('utf8');
  }
  return dpapiUnprotect(enc.toString('base64')).toString('utf8'); // cookie DPAPI kiểu cũ
}

/**
 * Đọc (host, name, encrypted_value) từ Cookies DB. Dùng tiến trình con
 * `node --experimental-sqlite` để không phải thêm cờ vào lệnh chạy chính của
 * bridge (và chạy được cả khi Node bản cũ hơn chưa bật mặc định).
 */
function readCookieRows(dbPath: string): Array<{ host: string; name: string; enc: Buffer }> {
  const inline =
    "const {DatabaseSync}=require('node:sqlite');" +
    'const db=new DatabaseSync(process.argv[1],{readOnly:true});' +
    "for(const r of db.prepare('SELECT host_key,name,hex(encrypted_value) v FROM cookies').all()){" +
    "process.stdout.write(r.host_key+'\\t'+r.name+'\\t'+(r.v||'')+'\\n')}";
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '-e', inline, dbPath], {
    encoding: 'utf8',
    maxBuffer: 1 << 22,
    stdio: ['ignore', 'pipe', 'pipe'], // stderr chỉ hiện khi lỗi, để báo lý do
  });
  const rows: Array<{ host: string; name: string; enc: Buffer }> = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [host, name, hex] = line.split('\t');
    if (host === undefined || name === undefined) continue;
    rows.push({ host, name, enc: hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0) });
  }
  return rows;
}

/** Ghi lý do lỗi ra console. Hàm đọc phiên trả null thay vì ném lỗi, nên không có log thì không biết bước nào chặn. */
function logFail(step: string, err?: unknown): null {
  let detail = '';
  if (err instanceof Error) {
    const { stderr, status } = err as Error & { stderr?: unknown; status?: unknown };
    detail = stderr ? String(stderr).trim() : status !== undefined ? `exit ${status}` : err.message;
  }
  console.warn(`[Zalo PC] ${step}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  return null;
}

/**
 * Copy file mà Zalo PC có thể đang mở. Đọc thường bị EBUSY lúc đó, nên thử bản chụp VSS (cần quyền Administrator).
 */
export function copyLockedFile(src: string, dst: string): void {
  try {
    writeFileSync(dst, readFileSync(src));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
    try {
      execFileSync('esentutl', ['/y', src, '/d', dst, '/vss'], { stdio: 'ignore', timeout: 60_000 });
    } catch {
      throw new Error('file đang bị Zalo PC khoá, copy bằng VSS cũng lỗi (cần chạy bot với quyền Administrator)');
    }
  }
}

/** Phiên từ trình duyệt đã đăng nhập chat.zalo.me, khai báo trong .env. Không cần quyền admin và không cần đóng Zalo PC. */
export function loadBrowserZaloSession(): LocalZaloSession | null {
  const imei = process.env.ZALO_BROWSER_IMEI?.trim();
  const zpwSek = process.env.ZALO_BROWSER_ZPW_SEK?.trim();
  if (!imei || !zpwSek) return null;
  const now = new Date().toISOString();
  return {
    imei,
    cookie: [{ key: 'zpw_sek', value: zpwSek, domain: 'zalo.me', path: '/', secure: true, httpOnly: true, hostOnly: false, sameSite: 'none', creation: now, lastAccessed: now }],
    userAgent: ZALO_PC_UA,
  };
}

/**
 * Lấy phiên Zalo PC đang đăng nhập trên máy, hoặc `null` nếu không khả dụng
 * (không phải Windows, Zalo PC chưa đăng nhập, hoặc không giải mã được).
 */
export async function loadLocalZaloSession(): Promise<LocalZaloSession | null> {
  if (process.platform !== 'win32') return null;
  let step = 'đọc imei';
  try {
    const root = zaloDataRoot();
    const imei = readImeiFromLevelDb(join(root, 'Partitions', 'zalo', 'Local Storage', 'leveldb'));
    if (!imei) return logFail('không tìm thấy imei (z_uuid) trong Local Storage');

    step = 'sao chép file Cookies';
    const srcCookies = join(root, 'Partitions', 'zalo', 'Network', 'Cookies');
    if (!existsSync(srcCookies)) return logFail('không thấy file Cookies của Zalo PC');
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'ztg-ck-'));
    const tmpCookies = join(tmpDir, 'Cookies');
    copyLockedFile(srcCookies, tmpCookies);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(srcCookies + ext)) copyLockedFile(srcCookies + ext, tmpCookies + ext);
    }

    step = 'giải khoá Local State (DPAPI)';
    const key = masterKey(root);
    const now = new Date().toISOString();
    const cookie: Record<string, unknown>[] = [];
    step = 'đọc file Cookies (sqlite)';
    const rows = readCookieRows(tmpCookies);
    const zaloRows = rows.filter((r) => /zalo/.test(r.host) && r.enc.length > 0).length;
    step = 'giải mã cookie';
    for (const r of rows) {
      if (!/zalo/.test(r.host) || r.enc.length === 0) continue;
      let value: string;
      try {
        value = decryptCookieValue(r.enc, key);
      } catch {
        continue;
      }
      if (!value) continue;
      cookie.push({
        key: r.name,
        value,
        domain: r.host.replace(/^\./, ''),
        path: '/',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        sameSite: 'none',
        creation: now,
        lastAccessed: now,
      });
    }
    if (!cookie.some((c) => c.key === 'zpw_sek')) {
      return logFail(
        zaloRows === 0 ? 'file Cookies không có cookie Zalo nào (Zalo PC có thể chưa đăng nhập)'
          : cookie.length === 0 ? `có ${zaloRows} cookie Zalo nhưng không giải mã được`
          : `giải mã được ${cookie.length} cookie Zalo nhưng thiếu zpw_sek (có thể đã đăng xuất)`,
      );
    }
    return { imei, cookie, userAgent: ZALO_PC_UA };
  } catch (err) {
    return logFail(`lỗi ở bước "${step}"`, err);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** taskkill Zalo.exe (có /T thì kèm tiến trình con); không có tiến trình nào thì lỗi bị bỏ qua. */
function taskkillZalo(flags: string[]): void {
  try {
    execFileSync('taskkill', [...flags, '/IM', 'Zalo.exe'], { stdio: 'ignore' });
  } catch { /* không có tiến trình nào để đóng */ }
}

/** Đường dẫn Zalo.exe lấy từ tiến trình đang chạy; không có thì dùng vị trí cài mặc định. */
function zaloPcExePath(): string {
  try {
    const running = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Name Zalo -ErrorAction SilentlyContinue | Select-Object -First 1).Path'],
      { encoding: 'utf8' },
    ).trim();
    if (running) return running;
  } catch { /* không đọc được tiến trình: dùng đường dẫn mặc định */ }
  return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Zalo', 'Zalo.exe');
}

/**
 * Đóng hẳn Zalo PC, đọc phiên khi file đã nhả khoá, rồi mở lại Zalo PC. Không cần quyền Administrator.
 * Chỉ gọi khi operator gõ `/loginlocal`: Zalo PC có thể mất nháp tin nhắn chưa gửi.
 */
export async function forceRestartZaloPc(): Promise<LocalZaloSession | null> {
  if (process.platform !== 'win32') return null;
  const exe = zaloPcExePath();
  taskkillZalo([]); // đóng êm trước, cho Zalo cơ hội tự lưu
  await sleep(3_000);
  taskkillZalo(['/F', '/T']); // còn sót thì ép đóng cả cây tiến trình
  await sleep(2_000);
  try {
    return await loadLocalZaloSession();
  } finally {
    if (existsSync(exe)) {
      const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => console.warn(`[Zalo PC] không mở lại được Zalo: ${err.message}`));
      child.unref();
    } else {
      console.warn(`[Zalo PC] không thấy ${exe}, hãy mở Zalo PC thủ công`);
    }
  }
}
