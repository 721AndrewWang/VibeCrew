import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const s = { lanEnabled: true };
vi.mock('../../server/store', () => ({ settings: { get: () => s } }));

const { isTailscaleIp, lanAddress, tailscaleAddress } = await import('../../server/config');
const { hostAllowed } = await import('../../server/security');

const iface = (address: string) => [{ address, family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }] as any;

afterEach(() => vi.restoreAllMocks());

describe('Tailscale addresses', () => {
  it('are 100.64.0.0/10 only', () => {
    for (const ip of ['100.64.0.1', '100.101.102.103', '100.127.255.254']) expect(isTailscaleIp(ip), ip).toBe(true);
    for (const ip of ['100.63.0.1', '100.128.0.1', '10.0.0.1', '192.168.1.50']) expect(isTailscaleIp(ip), ip).toBe(false);
  });

  it('are told apart from the LAN address, and containers are neither', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      docker0: iface('10.192.0.1'),
      tailscale0: iface('100.101.102.103'),
      wlan0: iface('192.168.1.50'),
    });
    expect(lanAddress()).toBe('192.168.1.50');
    expect(tailscaleAddress()).toBe('100.101.102.103');
  });

  it('a machine without Tailscale has no tailnet address', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({ eth0: iface('192.168.1.5') });
    expect(tailscaleAddress()).toBeNull();
  });
});

describe('hostAllowed', () => {
  it('takes the tailnet address and MagicDNS names when phone access is on', () => {
    s.lanEnabled = true;
    for (const h of ['100.101.102.103:4321', 'box.tail1234.ts.net', 'box.tail1234.ts.net:4321', 'localhost:4321']) expect(hostAllowed(h), h).toBe(true);
    for (const h of ['crew.example.com', '100.128.0.1:4321', 'ts.net.evil.com']) expect(hostAllowed(h), h).toBe(false);
  });

  it('takes only this machine when phone access is off', () => {
    s.lanEnabled = false;
    expect(hostAllowed('box.tail1234.ts.net')).toBe(false);
    expect(hostAllowed('100.101.102.103:4321')).toBe(false);
    expect(hostAllowed('127.0.0.1:4321')).toBe(true);
  });
});
