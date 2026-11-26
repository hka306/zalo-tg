import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dirCache = new Map<string, string>();

function sanitizePathSegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function currentUserToken(): string {
  if (typeof process.getuid === 'function') return String(process.getuid());
  try {
    return sanitizePathSegment(os.userInfo().username, 'user');
  } catch {
    return 'user';
  }
}

function verifyWritableDirectory(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best-effort on POSIX only */ }
    accessSync(dir, constants.W_OK | constants.X_OK);

    const probe = path.join(
      dir,
      `.zalo-tg-write-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    writeFileSync(probe, '', { mode: 0o600 });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Root for the bridge's own temp files. */
export function getSharedTempRoot(): string {
  return os.tmpdir();
}

/**
 * Return a writable, Bot-API-readable temp directory for a namespace.
 *
 * Older releases used fixed paths such as /tmp/zalo-tg/zalo-qr.png. In Docker,
 * those paths can be left behind as root-owned files/directories by a previous
 * run or by the host bind mount, causing EACCES for the non-root runtime user.
 * This resolver first tries the stable path, then falls back to a user-scoped
 * and finally a unique directory under the same shared root.
 */
export function getSharedTempDir(namespace = 'zalo-tg'): string {
  const root = getSharedTempRoot();
  const safeNamespace = sanitizePathSegment(namespace, 'zalo-tg');
  const cacheKey = `${root}\0${safeNamespace}`;
  const cached = dirCache.get(cacheKey);
  if (cached && verifyWritableDirectory(cached)) return cached;

  const candidates = [
    path.join(root, safeNamespace),
    path.join(root, `${safeNamespace}-${currentUserToken()}`),
  ];

  for (const candidate of candidates) {
    if (verifyWritableDirectory(candidate)) {
      dirCache.set(cacheKey, candidate);
      return candidate;
    }
  }

  try {
    const uniqueDir = mkdtempSync(path.join(root, `${safeNamespace}-${currentUserToken()}-`));
    if (verifyWritableDirectory(uniqueDir)) {
      dirCache.set(cacheKey, uniqueDir);
      return uniqueDir;
    }
  } catch { /* fall through to explicit error below */ }

  throw new Error(`Cannot create a writable temp directory under ${root}.`);
}

export function createSharedTempPath(namespace: string, prefix: string, extension: string): string {
  const safePrefix = sanitizePathSegment(prefix, 'file');
  const safeExtension = extension
    ? `.${extension.replace(/^\.+/, '').replace(/[^a-zA-Z0-9]+/g, '').slice(0, 16)}`
    : '';
  return path.join(
    getSharedTempDir(namespace),
    `${safePrefix}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 9)}${safeExtension}`,
  );
}

export function prepareSharedTempFile(filePath: string): void {
  try { chmodSync(filePath, 0o600); } catch { /* Windows/non-POSIX FS */ }
}
