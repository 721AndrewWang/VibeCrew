import { describe, expect, it } from 'vitest';
import { ALWAYS_ALLOWED, cleanDomains, sandboxOptions, sandboxStatus } from '../../server/sandbox';

describe('cleanDomains', () => {
  it('keeps hosts, wildcards, IPs and ports; reduces URLs to their host', () => {
    expect(cleanDomains(['Registry.NPMJS.org', '*.githubusercontent.com', '10.0.0.5:8080', '[::1]', 'https://api.example.com/v1/x', ' pypi.org '])).toEqual([
      'registry.npmjs.org',
      '*.githubusercontent.com',
      '10.0.0.5:8080',
      '[::1]',
      'api.example.com',
      'pypi.org',
    ]);
  });
  it('drops what the sandbox would not accept, comments, duplicates and non-strings', () => {
    expect(cleanDomains(['# comment', '', 'example.*', 'a b', 'ssh prod-server', 42, 'pypi.org', 'pypi.org', '*'])).toEqual(['pypi.org']);
    expect(cleanDomains('pypi.org')).toEqual([]);
  });
});

describe('sandboxOptions', () => {
  it('is off when disabled', () => {
    expect(sandboxOptions(false, ['pypi.org'])).toBeUndefined();
  });
  it('confines the bot: no escape hatch, no auto-allow, this machine plus the lists', () => {
    const o = sandboxOptions(true, ['pypi.org', 'https://api.example.com/'], ['10.0.0.5:8080', 'pypi.org']);
    if (!sandboxStatus().available) {
      expect(o).toBeUndefined();
      return;
    }
    expect(o).toMatchObject({ enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: false });
    expect(o!.network.allowedDomains).toEqual([...ALWAYS_ALLOWED, 'pypi.org', 'api.example.com', '10.0.0.5:8080']);
  });
});
