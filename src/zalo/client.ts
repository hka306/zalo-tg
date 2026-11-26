import { Zalo } from 'zca-js';
import { existsSync, readFileSync, statSync } from 'fs';
import { imageSizeFromFile } from 'image-size/fromFile';
import { config } from '../config.js';
import type { ZaloAPI } from './types.js';
import { terminal } from '../utils/terminal.js';

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

  return _api as ZaloAPI;
}
