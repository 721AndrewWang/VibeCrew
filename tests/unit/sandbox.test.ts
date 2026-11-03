import { describe, expect, it } from 'vitest';
import { ALWAYS_ALLOWED, cleanDomains, type ProbeExec, probeSandbox, sandboxOptions, sandboxStatus } from '../../server/sandbox';

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

describe('probeSandbox', () => {
  /** A machine where `which` finds `bins` and `fails(args)` says which bwrap runs fail. */
  const machine =
    (bins: string[], fails: (args: string[]) => boolean = () => false): ProbeExec =>
    (file, args) => {
      if (file === 'which' && !bins.includes(args[0])) throw new Error('not found');
      if (file === 'bwrap' && fails(args)) throw new Error('Permission denied');
    };
  const nested = (args: string[]) => args.includes('unshare');

  it('is available where bwrap starts and can nest the user namespace Claude Code needs', () => {
    expect(probeSandbox('linux', machine(['bwrap', 'socat', 'unshare']))).toEqual({ available: true, missing: [] });
  });
  it('names what is missing', () => {
    expect(probeSandbox('linux', machine(['unshare']))).toMatchObject({ available: false, missing: ['bubblewrap', 'socat'] });
  });
  it('is unavailable when bwrap itself cannot create a namespace', () => {
    expect(
      probeSandbox(
        'linux',
        machine(['bwrap', 'socat', 'unshare'], () => true),
      ),
    ).toMatchObject({ available: false, hint: expect.stringContaining('user namespaces') });
  });
  it('is unavailable when bwrap starts but the nested namespace is refused (Ubuntu 24.04 AppArmor)', () => {
    const s = probeSandbox('linux', machine(['bwrap', 'socat', 'unshare'], nested));
    expect(s).toMatchObject({ available: false, missing: [] });
    expect(s.hint).toMatch(/nested user namespace/);
    expect(s.hint).toContain('apparmor_restrict_unprivileged_userns');
  });
  it('leaves the decision to bwrap alone where unshare is not installed', () => {
    expect(probeSandbox('linux', machine(['bwrap', 'socat'], nested))).toEqual({ available: true, missing: [] });
  });
  it('needs no probe on macOS and is unsupported elsewhere', () => {
    expect(
      probeSandbox('darwin', () => {
        throw new Error('never run');
      }),
    ).toEqual({ available: true, missing: [] });
    expect(probeSandbox('win32')).toMatchObject({ available: false });
  });
});
