import os from 'node:os';
import { isIP } from 'node:net';

export interface MachineInfo {
  hostname: string;
  user: string;
  osName: string;
  lanIps: string[];
  publicIp: string | null;
}

type IfaceAddr = { address: string; family: string | number; internal: boolean };

// Chỉ lấy IPv4 nội bộ, bỏ loopback và IPv6. Node có thể trả family là chuỗi hoặc số.
export function lanIpv4s(ifaces: Record<string, IfaceAddr[] | undefined> = os.networkInterfaces()): string[] {
  return Object.values(ifaces)
    .flatMap((list) => list ?? [])
    .filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map((a) => a.address);
}

// IP mà internet thấy từ máy này. Lỗi mạng hoặc dịch vụ trả về không phải IP thì trả null.
export async function fetchPublicIp(timeoutMs = 5000): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return isIP(text) ? text : null;
  } catch {
    return null;
  }
}

export async function getMachineInfo(): Promise<MachineInfo> {
  return {
    hostname: os.hostname(),
    user: os.userInfo().username,
    osName: os.version(),
    lanIps: lanIpv4s(),
    publicIp: await fetchPublicIp(),
  };
}
