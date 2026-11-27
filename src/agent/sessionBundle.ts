import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Gói phiên mã hoá AES-256-GCM. Khoá lấy từ AGENT_PASSPHRASE qua scrypt, nên
// file gửi qua Telegram không chứa cookie dạng thô và không chứa passphrase.
const VERSION = 1;

export function passphraseFromEnv(): string {
  const passphrase = process.env.AGENT_PASSPHRASE?.trim() ?? '';
  if (passphrase.length < 12) throw new Error('Đặt AGENT_PASSPHRASE trong .env (tối thiểu 12 ký tự).');
  return passphrase;
}

export function encryptSession(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  }, null, 2);
}

export function decryptSession(envelope: string, passphrase: string): string {
  const e = JSON.parse(envelope) as { v: number; salt: string; iv: string; tag: string; data: string };
  if (e.v !== VERSION) throw new Error(`Không hỗ trợ phiên bản file ${String(e.v)}`);
  const key = scryptSync(passphrase, Buffer.from(e.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf8');
}
