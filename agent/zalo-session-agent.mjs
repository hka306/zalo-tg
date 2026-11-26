#!/usr/bin/env node
/**
 * zalo-session-agent.mjs
 * ──────────────────────
 * Agent 1-file chạy trên MÁY WINDOWS đang đăng nhập Zalo PC. Mỗi `intervalMinutes`
 * (mặc định 60) nó trích phiên Zalo PC (imei + cookie zpw_sek đã giải mã), so với
 * lần trước; nếu cookie ĐỔI thì đẩy `credentials.json` mới lên bridge trên VPS qua
 * SCP. Bridge tự phát hiện file đổi → đăng nhập lại → báo trên Telegram.
 *
 * Standalone: chỉ dùng Node built-in + PowerShell + `node --experimental-sqlite`,
 * KHÔNG cần cài gì thêm, không cần build cả project trên máy Windows.
 *
 * shortcut: phần trích phiên dưới đây sao từ src/zalo/localSession.ts để chạy
 * standalone; nếu localSession.ts đổi cách giải mã thì cập nhật cả file này.
 *
 * Yêu cầu: Windows, cùng user với Zalo PC; Node >= 22.5 (có node:sqlite);
 * OpenSSH client (`scp`) có sẵn trên Windows 10/11.
 *
 * Dùng:
 *   node zalo-session-agent.mjs                # chạy ngầm, lặp mỗi 60 phút
 *   node zalo-session-agent.mjs --once         # chạy 1 lần (cho Task Scheduler)
 *   node zalo-session-agent.mjs --selftest     # tự kiểm tra logic fingerprint
 *   node zalo-session-agent.mjs --config C:\path\zalo-agent.config.json
 */
import {
  readdirSync, readFileSync, writeFileSync, statSync,
  copyFileSync, existsSync, mkdtempSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── Trích phiên Zalo PC (sao từ localSession.ts) ──────────────────────────────

const ZALO_PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Electron/45.3.3 Safari/537.36';
const IMEI_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{32}/i;

function zaloDataRoot() {
  if (process.env.ZALO_PC_DATA_DIR) return process.env.ZALO_PC_DATA_DIR;
  const roaming = process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming');
  return join(roaming, 'ZaloData');
}

function readImeiFromLevelDb(dir) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.ldb') || f.endsWith('.log'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
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

function dpapiUnprotect(b64) {
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

function masterKey(root) {
  const ls = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
  const b64 = ls.os_crypt?.encrypted_key;
  if (!b64) throw new Error('Local State thiếu os_crypt.encrypted_key');
  const enc = Buffer.from(b64, 'base64'); // "DPAPI" + blob
  return dpapiUnprotect(enc.subarray(5).toString('base64'));
}

const isPrintable = (buf) => /^[\x09\x0a\x0d\x20-\x7e]*$/.test(buf.toString('latin1'));

function decryptCookieValue(enc, key) {
  const prefix = enc.subarray(0, 3).toString('latin1');
  if (prefix === 'v10' || prefix === 'v11') {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const ct = enc.subarray(15, enc.length - 16);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    dec.setAuthTag(tag);
    const pt = Buffer.concat([dec.update(ct), dec.final()]);
    if (isPrintable(pt)) return pt.toString('utf8');
    if (pt.length > 32 && isPrintable(pt.subarray(32))) return pt.subarray(32).toString('utf8');
    return pt.toString('utf8');
  }
  return dpapiUnprotect(enc.toString('base64')).toString('utf8');
}

function readCookieRows(dbPath) {
  const inline =
    "const {DatabaseSync}=require('node:sqlite');" +
    'const db=new DatabaseSync(process.argv[1],{readOnly:true});' +
    "for(const r of db.prepare('SELECT host_key,name,hex(encrypted_value) v FROM cookies').all()){" +
    "process.stdout.write(r.host_key+'\\t'+r.name+'\\t'+(r.v||'')+'\\n')}";
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '-e', inline, dbPath], {
    encoding: 'utf8',
    maxBuffer: 1 << 22,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const rows = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [host, name, hex] = line.split('\t');
    if (host === undefined || name === undefined) continue;
    rows.push({ host, name, enc: hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0) });
  }
  return rows;
}

function loadLocalZaloSession() {
  if (process.platform !== 'win32') return null;
  try {
    const root = zaloDataRoot();
    const imei = readImeiFromLevelDb(join(root, 'Partitions', 'zalo', 'Local Storage', 'leveldb'));
    if (!imei) return null;

    const srcCookies = join(root, 'Partitions', 'zalo', 'Network', 'Cookies');
    if (!existsSync(srcCookies)) return null;
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'ztg-ck-'));
    const tmpCookies = join(tmpDir, 'Cookies');
    copyFileSync(srcCookies, tmpCookies);
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(srcCookies + ext)) copyFileSync(srcCookies + ext, tmpCookies + ext);
    }

    const key = masterKey(root);
    const now = new Date().toISOString();
    const cookie = [];
    for (const r of readCookieRows(tmpCookies)) {
      if (!/zalo/.test(r.host) || r.enc.length === 0) continue;
      let value;
      try {
        value = decryptCookieValue(r.enc, key);
      } catch {
        continue;
      }
      if (!value) continue;
      cookie.push({
        key: r.name, value,
        domain: r.host.replace(/^\./, ''),
        path: '/', secure: true, httpOnly: true, hostOnly: false,
        sameSite: 'none', creation: now, lastAccessed: now,
      });
    }
    rmSync(tmpDir, { recursive: true, force: true });
    if (!cookie.some((c) => c.key === 'zpw_sek')) return null;
    return { imei, cookie, userAgent: ZALO_PC_UA };
  } catch {
    return null;
  }
}

// ── Fingerprint: ổn định qua các lần trích (bỏ qua creation/lastAccessed) ──────

/** Chỉ đổi khi imei hoặc giá trị cookie đổi — KHÔNG đổi theo timestamp hay thứ tự. */
function fingerprint(session) {
  const cookies = (session.cookie ?? []).map((c) => `${c.key}=${c.value}`).sort();
  return crypto.createHash('sha256')
    .update(JSON.stringify({ imei: session.imei, cookies }))
    .digest('hex');
}

// ── Config / state ────────────────────────────────────────────────────────────

function loadConfig(args) {
  const i = args.indexOf('--config');
  const configPath = i >= 0 ? args[i + 1] : join(SCRIPT_DIR, 'zalo-agent.config.json');
  let file = {};
  if (existsSync(configPath)) {
    try { file = JSON.parse(readFileSync(configPath, 'utf8')); }
    catch (e) { throw new Error(`Config không đọc được (${configPath}): ${e.message}`); }
  }
  const cfg = {
    scpTarget: process.env.ZALO_AGENT_SCP_TARGET ?? file.scpTarget,
    sshKey: process.env.ZALO_AGENT_SSH_KEY ?? file.sshKey,
    scpPort: process.env.ZALO_AGENT_SCP_PORT ?? file.scpPort,
    intervalMinutes: Number(process.env.ZALO_AGENT_INTERVAL_MINUTES ?? file.intervalMinutes ?? 60),
    stateFile: file.stateFile ?? join(SCRIPT_DIR, 'zalo-agent-state.json'),
    telegram: {
      botToken: process.env.ZALO_AGENT_TG_BOT_TOKEN ?? file.telegram?.botToken,
      chatId: process.env.ZALO_AGENT_TG_CHAT_ID ?? file.telegram?.chatId,
    },
  };
  if (!cfg.scpTarget) {
    throw new Error(
      'Thiếu scpTarget. Tạo zalo-agent.config.json với ví dụ:\n' +
      '  { "scpTarget": "user@vps:/opt/zalo-tg/credentials.json", "sshKey": "C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519" }',
    );
  }
  return cfg;
}

function readState(cfg) {
  try { return JSON.parse(readFileSync(cfg.stateFile, 'utf8')); } catch { return {}; }
}
function writeState(cfg, state) {
  writeFileSync(cfg.stateFile, JSON.stringify(state, null, 2));
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/** Báo lên bot Telegram (dùng cùng token/chat của bridge). Bỏ qua nếu chưa cấu hình. */
async function notifyTelegram(cfg, text) {
  const { botToken, chatId } = cfg.telegram ?? {};
  if (!botToken || !chatId) {
    log('(Chưa cấu hình telegram.botToken/chatId — bỏ qua báo Telegram.)');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) log(`Báo Telegram lỗi HTTP ${res.status}`);
  } catch (e) {
    log(`Báo Telegram lỗi: ${e.message}`);
  }
}

// ── Đẩy phiên lên VPS qua SCP ───────────────────────────────────────────────

function scpPush(localFile, cfg) {
  const a = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
  if (cfg.scpPort) a.push('-P', String(cfg.scpPort));
  if (cfg.sshKey) a.push('-i', cfg.sshKey);
  a.push(localFile, cfg.scpTarget);
  try {
    execFileSync('scp', a, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    throw new Error(`scp thất bại: ${stderr || e.message}`);
  }
}

async function checkAndPush(cfg) {
  const prev = readState(cfg);
  const session = loadLocalZaloSession();
  if (!session) {
    log('Không có đăng nhập Zalo PC trên máy.');
    // Chỉ báo khi trạng thái đổi (vừa mất đăng nhập) để không spam mỗi lần chạy.
    if (prev.loggedIn !== false) {
      await notifyTelegram(cfg, '⚠️ Không có đăng nhập Zalo trên máy — agent không lấy được phiên để đồng bộ lên bridge.');
    }
    writeState(cfg, { ...prev, loggedIn: false });
    return;
  }
  const fp = fingerprint(session);
  if (fp === prev.fingerprint) {
    log('Có đăng nhập Zalo, cookie không đổi — bỏ qua.');
    writeState(cfg, { ...prev, loggedIn: true });
    return;
  }
  const tmpDir = mkdtempSync(join(os.tmpdir(), 'ztg-agent-'));
  const tmp = join(tmpDir, 'credentials.json');
  try {
    writeFileSync(tmp, JSON.stringify(session, null, 2));
    scpPush(tmp, cfg);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  writeState(cfg, { fingerprint: fp, pushedAt: new Date().toISOString(), loggedIn: true });
  log(`Đã đẩy phiên mới lên ${cfg.scpTarget}. Bridge sẽ đăng nhập lại và báo trên Telegram.`);
}

// ── Self-test logic fingerprint (không cần Windows) ──────────────────────────

function selftest() {
  const base = { imei: 'IMEI-1', userAgent: 'UA', cookie: [
    { key: 'zpw_sek', value: 'SECRET', creation: '2020-01-01T00:00:00Z', lastAccessed: '2020-01-01T00:00:00Z' },
    { key: 'other', value: 'x', creation: '2020', lastAccessed: '2020' },
  ] };
  const newTimes = structuredClone(base);
  newTimes.cookie[0].creation = '2099-12-31T23:59:59Z';
  newTimes.cookie[0].lastAccessed = '2099-12-31T23:59:59Z';
  assert.equal(fingerprint(base), fingerprint(newTimes), 'timestamp không được ảnh hưởng fingerprint');

  const reordered = structuredClone(base);
  reordered.cookie.reverse();
  assert.equal(fingerprint(base), fingerprint(reordered), 'thứ tự cookie không được ảnh hưởng fingerprint');

  const changed = structuredClone(base);
  changed.cookie[0].value = 'NEW_SECRET';
  assert.notEqual(fingerprint(base), fingerprint(changed), 'đổi giá trị cookie phải đổi fingerprint');
  console.log('selftest OK');
}

// ── main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.includes('--selftest')) {
  selftest();
} else {
  const cfg = loadConfig(args);
  const tick = async () => { try { await checkAndPush(cfg); } catch (e) { log(`Lỗi: ${e.message}`); } };
  await tick();
  if (!args.includes('--once')) {
    log(`Chạy ngầm — kiểm tra mỗi ${cfg.intervalMinutes} phút. Ctrl+C để dừng.`);
    setInterval(tick, cfg.intervalMinutes * 60_000);
  }
}
