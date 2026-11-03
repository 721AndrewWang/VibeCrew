// Claude Code's command sandbox, the boundary the deny list cannot be: commands a bot runs are
// confined by bubblewrap, and their network only reaches the domains allowed here. The bot
// cannot switch it off for a command (allowUnsandboxedCommands: false), and Claude Code never
// auto-allows a command just because it is sandboxed, so Crew's own gate still decides.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { SandboxStatus } from '../shared/types';
import { DATA, HOME_DIR } from './config';
import { CREDENTIAL_PATHS } from './guard';
import { gitCommonDir, sandboxHardening } from './hardening/sandboxPolicy';
import { logger } from './log';

const log = logger('sandbox');

/** Reachable whatever the lists say: the preview, dev servers and anything else on this machine. */
export const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '[::1]'];

/** The list a new install starts with: where dependencies come from. */
export const DEFAULT_ALLOWED = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'github.com', '*.githubusercontent.com', 'codeload.github.com'];

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

/** Runs a probe command; throws when it fails (execFileSync's contract). */
export type ProbeExec = (file: string, args: string[]) => void;

const execProbe: ProbeExec = (file, args) => {
  execFileSync(file, args, { stdio: 'ignore', timeout: 5000 });
};

const RESTRICTED_HINT =
  "bubblewrap can't create a sandbox on this machine (user namespaces may be restricted). On Ubuntu, try: sudo apt install bubblewrap, and check that /etc/apparmor.d/bwrap-userns-restrict exists.";

/**
 * Claude Code applies its seccomp filter from a user namespace nested inside bubblewrap's. Ubuntu
 * 24.04's AppArmor userns restriction lets bwrap itself start but strips the capabilities of what
 * runs inside it, so that nested namespace cannot be set up and every sandboxed command fails
 * ("apply-seccomp: write /proc/self/setgroups ... Permission denied"). Reported as unavailable.
 */
const NESTED_HINT =
  "bubblewrap starts, but cannot set up the nested user namespace Claude Code's sandbox needs, so every sandboxed command would fail. On Ubuntu 24.04 this is AppArmor's restriction on unprivileged user namespaces: run sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0 (or give bwrap an AppArmor profile that allows it), then check again.";

/** Whether the sandbox can start here, by running what it runs. Pure apart from `exec`. */
export function probeSandbox(platform: NodeJS.Platform, exec: ProbeExec = execProbe): SandboxStatus {
  if (platform !== 'linux' && platform !== 'darwin') return { available: false, missing: [], hint: 'The sandbox only supports Linux and macOS.' };
  if (platform !== 'linux') return { available: true, missing: [] };
  const has = (bin: string) => {
    try {
      exec('which', [bin]);
      return true;
    } catch {
      return false;
    }
  };
  const missing = ['bwrap', 'socat'].filter((bin) => !has(bin)).map((bin) => (bin === 'bwrap' ? 'bubblewrap' : bin));
  if (missing.length) return { available: false, missing, hint: `Missing ${missing.join(' and ')}. On Ubuntu, run: sudo apt install ${missing.join(' ')}` };
  // User namespaces may be restricted (Ubuntu 24.04 does unless bwrap has its AppArmor profile).
  try {
    exec('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--', '/bin/true']);
  } catch (e) {
    log.warn('bwrap cannot create a sandbox:', (e as Error).message);
    return { available: false, missing, hint: RESTRICTED_HINT };
  }
  // The nested namespace, set up the way Claude Code's seccomp helper does (it writes setgroups and
  // the id maps). Without util-linux's unshare there is nothing to try it with; bwrap alone decides.
  if (has('unshare')) {
    try {
      exec('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '--', 'unshare', '--user', '--map-root-user', '/bin/true']);
    } catch (e) {
      log.warn('bwrap cannot create a nested user namespace:', (e as Error).message);
      return { available: false, missing, hint: NESTED_HINT };
    }
  }
  return { available: true, missing: [] };
}

function probe(): SandboxStatus {
  return probeSandbox(process.platform);
}

/**
 * The SDK's sandbox settings for a session, or undefined when the sandbox is off or unavailable
 * (the caller tells the user; the deny list and the approval gate still apply). `cwd`, the
 * session's folder, adds its git hooks and config and its tool settings to what may not be written
 * (ADR 104).
 */
export function sandboxOptions(enabled: boolean, allowedDomains: string[], projectDomains: string[] = [], cwd?: string) {
  if (!enabled || !sandboxStatus().available) return undefined;
  return sandboxSettings(allowedDomains, projectDomains, cwd);
}

/** The settings themselves, once the sandbox is known to be on and available. */
export function sandboxSettings(allowedDomains: string[], projectDomains: string[] = [], cwd?: string) {
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
      // Unlisted hosts are refused outright, never turned into a prompt the gate might wave through.
      strictAllowlist: true,
      allowLocalBinding: true,
    },
    // Credential stores unreadable, configuration that runs later unwritable, and the model's
    // own variables unset, for every command, scripts included (ADR 104).
    ...sandboxHardening({
      home: os.homedir(),
      crewHome: HOME_DIR,
      settingsFile: DATA.settings,
      worktrees: DATA.worktrees,
      credentialPaths: CREDENTIAL_PATHS,
      cwd,
      gitCommonDir: cwd ? gitCommonDir(cwd) : undefined,
    }),
  };
}
