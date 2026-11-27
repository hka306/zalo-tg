// Chạy trong file .exe đóng gói bằng Node SEA: process.execPath là chính file .exe,
// nên không chạy được node con kiểu `node --experimental-sqlite -e ...`.
type BuiltinLoader = { getBuiltinModule?: (id: string) => unknown };

/** Nạp module tích hợp của Node. Trả undefined nếu bản Node này không có (ví dụ node:sqlite trước 22.13). */
export function builtin<T>(id: string): T | undefined {
  return (process as unknown as BuiltinLoader).getBuiltinModule?.(id) as T | undefined;
}

export function isSeaExe(): boolean {
  return builtin<{ isSea(): boolean }>('node:sea')?.isSea() ?? false;
}
