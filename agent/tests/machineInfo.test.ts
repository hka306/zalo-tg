import test from 'node:test';
import assert from 'node:assert/strict';
import { lanIpv4s } from '../src/utils/machineInfo.js';

await test('lanIpv4s chỉ lấy IPv4 nội bộ, bỏ loopback và IPv6', () => {
  const ips = lanIpv4s({
    Ethernet: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
    Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    Unused: undefined,
    Wifi: [{ address: '10.0.0.5', family: 4, internal: false }],
  });
  assert.deepEqual(ips, ['192.168.1.20', '10.0.0.5']);
});
