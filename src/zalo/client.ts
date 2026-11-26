import { Zalo } from 'zca-js';
import { existsSync, readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { imageSizeFromFile } from 'image-size/fromFile';
import { config } from '../config.js';
import type { ZaloAPI } from './types.js';
import { terminal } from '../utils/terminal.js';
import { writePrivateJsonFileSync } from '../utils/privateFile.js';
import { reloadAppSession } from './appApi.js';

let _api: ZaloAPI | null = null;

// ── imageMetadataGetter ───────────────────────────────────────────────────────
// Required by zca-js when the client uploads attachments.
const ZALO_OPTIONS = {
  logging:      false,
  checkUpdate:  false,
  selfListen:   true,
  imageMetadataGetter: async (filePath: string) => {
    try {
      const { width, height } = await imageSizeFromFile(filePath);
      const { size } = statSync(filePath);
      return { width: width ?? 0, height: height ?? 0, size };
    } catch {
      return null;
    }
  },
} as const;

/** Clear the cached API instance so the next `getZaloApi()` call re-authenticates. */
export function resetZaloApi(): void {
  _api = null;
}

/**
 * Regenerate `app-session.json` (PC App API) from the live logged-in session so
 * the full-member-list feature for hidden-member groups keeps working without QR.
 * The PC App endpoints need `zpw_enk` (= the account secret key zca-js negotiated
 * at login) plus the session cookies — both available from the authenticated
 * session. Best-effort: on any failure the member fetch falls back to the zca-js
 * web API (partial for hidden-member groups), so this can only improve coverage.
 */
function syncAppSession(api: ZaloAPI, credentials: { imei: string; cookie: unknown; userAgent: string }): void {
  try {
    const ctx = api.getContext() as unknown as { secretKey?: string | null; loginInfo?: Record<string, unknown> | null };
    const secretKey = ctx?.secretKey;
    if (!secretKey) return;

    const rawCookies = Array.isArray(credentials.cookie) ? credentials.cookie as Array<Record<string, unknown>> : [];
    const cookies = rawCookies
      .map((c) => ({
        name:   String(c.key ?? c.name ?? ''),
        value:  String(c.value ?? ''),
        domain: String(c.domain ?? '').replace(/^\./, ''),
      }))
      .filter((c) => c.name && c.value);

    const dkeyRaw = ctx?.loginInfo?.dkey;
    const dkey = typeof dkeyRaw === 'string' ? dkeyRaw : undefined;

    const appSessionPath = join(dirname(config.zalo.credentialsPath), 'app-session.json');
    writePrivateJsonFileSync(appSessionPath, { zpw_enk: secretKey, dkey, imei: credentials.imei, cookies });
    reloadAppSession();
    terminal.status('zalo', 'app-session.json synced from live session', 'muted');
  } catch {
    /* best-effort; group-member fetch falls back to the zca-js web API */
  }
}

/**
 * Return (and lazily initialise) the Zalo API singleton from saved credentials.
 * Chỉ dùng phiên đã lưu (agent đẩy credentials.json, hoặc /loginlocal) — không còn QR.
 * Thiếu hoặc hỏng credentials thì ném lỗi để caller báo Telegram.
 */
export async function getZaloApi(): Promise<ZaloAPI> {
  if (_api) return _api;

  if (!existsSync(config.zalo.credentialsPath)) {
    throw new Error('Chưa có file credentials.json — nạp phiên Zalo (agent đẩy credentials hoặc /loginlocal).');
  }

  const zalo = new Zalo(ZALO_OPTIONS);

  const credentials = JSON.parse(
    readFileSync(config.zalo.credentialsPath, 'utf8'),
  ) as { imei: string; cookie: unknown; userAgent: string };

  terminal.status('zalo login', 'loading saved credentials…', 'info');
  _api = (await zalo.login(credentials as Parameters<typeof zalo.login>[0])) as ZaloAPI;
  terminal.status('zalo login', 'saved session authenticated', 'success');

  syncAppSession(_api, credentials);

  return _api as ZaloAPI;
}
