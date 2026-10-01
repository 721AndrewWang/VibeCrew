// Claude Code's command sandbox, the boundary the deny list cannot be: commands a bot runs are
// confined by bubblewrap, and their network only reaches the domains allowed here. The bot
// cannot switch it off for a command (allowUnsandboxedCommands: false), and Claude Code never
// auto-allows a command just because it is sandboxed, so Crew's own gate still decides.

import { execFileSync } from 'node:child_process';
import type { SandboxStatus } from '../shared/types';
import { logger } from './log';

const log = logger('sandbox');

/** Reachable whatever the lists say: the preview, dev servers and anything else on this machine. */
export const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '[::1]'];

/** The list a new install starts with: where dependencies come from. */
export const DEFAULT_ALLOWED = ['registry.npmjs.org', 'registry.npmmirror.com', 'pypi.org', 'files.pythonhosted.org', 'github.com', '*.githubusercontent.com', 'codeload.github.com'];

const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/;
const IPV6 = /^\[[0-9a-f:]+\](:\d{1,5})?$/i;

/**
 * Domains as the sandbox accepts them: a host, `*.host`, an IPv4, or a bracketed IPv6, with an
 * optional port. A pasted URL is reduced to its host; anything else is dropped.
 */
export function cleanDomains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    let d = raw.trim().toLowerCase();
    if (!d || d.startsWith('#')) continue;
    d = d
      .replace(/^[a-z]+:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*$/, '*.');
    if (d === '*.') continue;
    if (DOMAIN.test(d) || IPV4.test(d) || IPV6.test(d)) out.add(d);
  }
  return [...out].slice(0, 200);
}

let cached: SandboxStatus | null = null;

/** Whether the sandbox can run here (bubblewrap and socat present and working). Cached; refresh to re-check. */
export function sandboxStatus(refresh = false): SandboxStatus {
  if (cached && !refresh) return cached;
  cached = probe();
  return cached;
}

function probe(): SandboxStatus {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return { available: false, missing: [], hint: '沙盒只支持 Linux 和 macOS。' };
  if (process.platform !== 'linux') return { available: true, missing: [] };
  const missing: string[] = [];
  for (const bin of ['bwrap', 'socat']) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
    } catch {
      missing.push(bin === 'bwrap' ? 'bubblewrap' : bin);
    }
  }
  if (missing.length) return { available: false, missing, hint: `缺少 ${missing.join(' 和 ')}。Ubuntu 上运行：sudo apt install ${missing.join(' ')}` };
  // User namespaces may be restricted (Ubuntu 24.04 does unless bwrap has its AppArmor profile).
  try {
    execFileSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--', '/bin/true'], { stdio: 'ignore', timeout: 5000 });
  } catch (e) {
    log.warn('bwrap cannot create a sandbox:', (e as Error).message);
    return {
      available: false,
      missing,
      hint: 'bubblewrap 在这台机器上建不了沙盒（可能是用户命名空间被限制了）。Ubuntu 上试试：sudo apt install bubblewrap，并确认 /etc/apparmor.d/bwrap-userns-restrict 存在。',
    };
  }
  return { available: true, missing: [] };
}

/**
 * The SDK's sandbox settings for a session, or undefined when the sandbox is off or unavailable
 * (the caller tells the user; the deny list and the approval gate still apply).
 */
export function sandboxOptions(enabled: boolean, allowedDomains: string[], projectDomains: string[] = []) {
  if (!enabled || !sandboxStatus().available) return undefined;
  return {
    enabled: true,
    // Checked by sandboxStatus() already; a surprise at start should not strand the turn silently.
    failIfUnavailable: true,
    // Crew's gate decides what runs; sandboxing a command is not a reason to skip asking.
    autoAllowBashIfSandboxed: false,
    // The bot cannot retry a blocked command outside the sandbox.
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [...new Set([...ALWAYS_ALLOWED, ...cleanDomains(allowedDomains), ...cleanDomains(projectDomains)])],
      allowLocalBinding: true,
    },
  };
}
