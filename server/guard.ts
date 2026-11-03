// The deterministic command guard (ADR 007): hard rules every tool call passes before it runs, in
// every permission mode, whatever the model or the user's rules say. It decides by what a command
// is (credential files, actions in the user's name, network tools outside the allow-list), so
// `git -C x push` and `bash -c "git push"` are caught where a pattern is not. It also says whether
// a command only reads (never prompts) or changes something (prompts once, with a summary a person
// can judge). Pure: the caller passes the folder, the home directory and the allow-list.
//
// The sandbox is still the boundary: a script that pushes, or `base64 -d | sh`, is beyond a text
// check. The guard catches the plain and the lightly wrapped cases, and says how to do them right.

import path from 'node:path';
import type { GuardVerdict } from '../shared/types';
import { EDIT_TOOLS, harmless } from './agents/permissions';
import { cdTarget, deny, hardenedToolVerdict, hardenedVerdict, type Segment, splitSegments } from './hardening/commands';
import { expandHome, type PathContext, within } from './hardening/paths';

export interface GuardContext {
  /** The folder the command runs in. */
  cwd: string;
  /** The user's home directory (~). */
  home: string;
  /** Hosts commands may reach (the sandbox's list: this machine, global, project). */
  allowedHosts: string[];
  /** More files that hold secrets, as absolute paths (Crew's own settings.json). */
  secretFiles?: string[];
  /** Crew's data folder: agents may not write there (ADR 104), except in `worktrees`. */
  crewHome?: string;
  /** Where chat workspaces and Workers' worktrees live (inside crewHome). */
  worktrees?: string;
  /** The ports Crew's own server listens on: not a target for agents' network tools (ADR 104). */
  crewPorts?: number[];
  /** Follows symbolic links of an absolute path (null: keep it); the guard is pure without it. */
  realpath?: (abs: string) => string | null;
}

/** Credential stores, relative to the home directory. A path inside one of them is refused. */
export const CREDENTIAL_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.config/hub',
  '.config/gcloud',
  '.config/glab-cli',
  '.azure',
  '.kube',
  '.docker/config.json',
  '.netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.cargo/credentials',
  '.cargo/credentials.toml',
  '.gem/credentials',
  '.terraform.d/credentials.tfrc.json',
  '.claude/.credentials.json',
  '.password-store',
];

/** Credential files recognisable anywhere in a command, even relative to an unknown folder. */
const CREDENTIAL_ANYWHERE =
  /(^|[\s'"=:/(])(\.ssh\/|\.aws\/(credentials|config)\b|\.git-credentials\b|\.netrc\b|\.config\/(gh|hub|gcloud|glab-cli)\/|\.docker\/config\.json\b|\.kube\/config\b|\.gnupg\/|\.claude\/\.credentials\.json\b|\.pypirc\b|\.cargo\/credentials|\.password-store\b|id_(rsa|ed25519|ecdsa|dsa)\b)/;

const LOCAL_HOSTS = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1|\[::1\])$/i;

const MAX_DEPTH = 4;
const MAX_EFFECTS = 8;

const READ: GuardVerdict = { kind: 'read' };
const change = (...effects: string[]): GuardVerdict => ({ kind: 'change', effects });

const short = (s: string, n = 100) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const EXTERNAL_HINT =
  "It would act in the user's name outside this machine. Don't do it, and don't try another way: call draft_external_action with what you want to send, and the user approves and runs it with one click.";

// ---------------------------------------------------------------- the words of a command

/** Shell words of one simple command, quotes removed (enough for rule checks, not a full parser). */
export function shellWords(seg: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) {
      cur += seg[++i];
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const SYNTAX = new Set(['{', '}', '(', ')', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'time', '[[', ']]']);

/** Wrappers that run the command after them; the value is the options that take an argument. */
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group']),
  doas: new Set(['-u', '-C']),
  nohup: new Set(),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace']),
  watch: new Set(['-n', '--interval', '-d']),
  chronic: new Set(),
  unbuffer: new Set(),
  time: new Set(['-f', '-o']),
};

/** The words from the command that actually runs: syntax, VAR=value and wrappers skipped. */
export function commandOf(words: string[]): string[] {
  const w = [...words];
  for (let guard = 0; guard < 50 && w.length; guard++) {
    const first = w[0];
    if (SYNTAX.has(first)) {
      w.shift();
      continue;
    }
    if (/^\(+./.test(first)) {
      w[0] = first.replace(/^\(+/, '');
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      w.shift();
      continue;
    }
    const name = path.basename(first);
    const takesArg = WRAPPERS[name];
    if (!takesArg) break;
    w.shift();
    // The wrapper's own options (and `timeout 30`'s duration), then the command.
    while (w.length) {
      const o = w[0];
      if (o === '--') {
        w.shift();
        break;
      }
      if (o.startsWith('-')) {
        w.shift();
        if (takesArg.has(o) && !o.includes('=')) w.shift();
        continue;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(o)) {
        w.shift();
        continue;
      }
      if (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(o)) {
        w.shift();
        continue;
      }
      break;
    }
  }
  if (w.length) w[0] = path.basename(w[0]);
  return w;
}

/** Commands nested inside a command: $(…), `…` and <(…). */
export function substitutions(cmd: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "'" && !quote) {
      quote = "'";
      continue;
    }
    if (c === '"') quote = quote === '"' ? null : '"';
    if (c === '`') {
      const end = cmd.indexOf('`', i + 1);
      if (end < 0) break;
      out.push(cmd.slice(i + 1, end));
      i = end;
      continue;
    }
    if ((c === '$' || c === '<' || c === '>') && cmd[i + 1] === '(' && cmd[i + 2] !== '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')' && --depth === 0) break;
      }
      out.push(cmd.slice(i + 2, j));
      i = j;
    }
  }
  return out.filter((s) => s.trim());
}

// ---------------------------------------------------------------- credentials

function secretRoots(ctx: GuardContext): string[] {
  return [...CREDENTIAL_PATHS.map((p) => path.join(ctx.home, p)), ...(ctx.secretFiles || [])];
}

/** The credential store a path points into, or null. */
export function credentialPath(p: string, ctx: GuardContext): string | null {
  if (!p) return null;
  const abs = path.resolve(ctx.cwd, expandHome(p, ctx.home));
  return secretRoots(ctx).find((root) => within(abs, root)) ?? null;
}

/** A credential file named anywhere in a command's text (whatever reads it: cat, cp, a script). */
function credentialInText(text: string, ctx: GuardContext): string | null {
  const m = text.match(CREDENTIAL_ANYWHERE);
  if (m) return m[2];
  for (const root of secretRoots(ctx)) {
    const rel = path.relative(ctx.home, root);
    const forms = rel.startsWith('..') ? [root] : [root, `~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`];
    for (const f of forms) {
      const at = text.indexOf(f);
      if (at >= 0 && !/[\w.-]/.test(text[at + f.length] || '')) return f;
    }
  }
  return null;
}

const credentialDeny = (what: string) =>
  deny(
    'credentials',
    `Blocked by Crew's command guard: ${what} holds credentials, and agents may not read or change credential files. Don't look for another way to get at them; if a task needs a credential, tell the user.`,
  );

// ---------------------------------------------------------------- hosts

function hostOf(target: string): string | null {
  let t = target.trim();
  if (!t) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    try {
      return new URL(t).hostname.toLowerCase();
    } catch {
      return null;
    }
  }
  t = t.replace(/^[^@/]*@/, '');
  if (t.startsWith('[')) return t.slice(0, t.indexOf(']') + 1).toLowerCase();
  return t.split(/[/:]/)[0].toLowerCase() || null;
}

const isLocal = (host: string) => LOCAL_HOSTS.test(host);

/** Whether commands may reach this host: this machine, or an entry of the allow-list (`*.x` covers subdomains). */
export function hostAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (isLocal(h)) return true;
  for (const raw of allowed) {
    const e = raw.toLowerCase().replace(/:\d+$/, '');
    if (e.startsWith('*.')) {
      const base = e.slice(2);
      if (h === base || h.endsWith(`.${base}`)) return true;
    } else if (h === e) return true;
  }
  return false;
}

const LIKE_HOST = /^([\w-]+\.)+[a-z]{2,}(:\d+)?(\/.*)?$/i;

/** Short options of a tool that take a value (the value is not a URL), and long ones. */
const ARG_OPTIONS: Record<string, { short: string; long: Set<string> }> = {
  curl: {
    short: 'dDeEFHKoTuUxXAbcCmrwyYzPQ',
    long: new Set([
      '--data',
      '--data-raw',
      '--data-binary',
      '--data-urlencode',
      '--data-ascii',
      '--json',
      '--form',
      '--form-string',
      '--header',
      '--output',
      '--user',
      '--user-agent',
      '--referer',
      '--cookie',
      '--cookie-jar',
      '--request',
      '--upload-file',
      '--write-out',
      '--config',
      '--max-time',
      '--connect-timeout',
      '--retry',
      '--proxy',
      '--resolve',
      '--cacert',
      '--cert',
      '--key',
      '--range',
      '--output-dir',
      '--url-query',
    ]),
  },
  wget: {
    short: 'OoaPUetTwiQlAR',
    long: new Set(['--output-document', '--output-file', '--header', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--user', '--password', '--user-agent', '--input-file']),
  },
};

interface Targets {
  hosts: string[];
  /** Words that may be targets but whose host cannot be read ($URL). */
  unreadable: string[];
  sends: boolean;
  outputs: string[];
}

function httpTargets(cmd: string, args: string[]): Targets {
  const t: Targets = { hosts: [], unreadable: [], sends: false, outputs: [] };
  const opts = ARG_OPTIONS[cmd];
  const isHttpie = cmd === 'http' || cmd === 'https' || cmd === 'xh' || cmd === 'xhs';
  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (opts && a.startsWith('--')) {
      const [name, inline] = a.split('=', 2);
      const value = inline ?? (opts.long.has(name) ? args[++i] : undefined);
      if (/^--(data|json|form|upload-file|post-data|post-file|body-data|body-file)/.test(name)) t.sends = true;
      if ((name === '--request' || name === '--method') && value && !/^(GET|HEAD|OPTIONS)$/i.test(value)) t.sends = true;
      if (name === '--url' && value) addTarget(t, value);
      if ((name === '--output' || name === '--output-document') && value) t.outputs.push(value);
      if (name === '--input-file') t.unreadable.push(value || a);
      continue;
    }
    if (opts && /^-[A-Za-z]/.test(a)) {
      // A group of short flags: the first one that takes a value takes the rest of the word or the next word.
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (!opts.short.includes(f)) continue;
        const value = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if ('dFT'.includes(f) && cmd === 'curl') t.sends = true;
        if (f === 'X' && cmd === 'curl' && value && !/^(GET|HEAD|OPTIONS)$/i.test(value)) t.sends = true;
        if (f === 'o' && cmd === 'curl' && value) t.outputs.push(value);
        if (f === 'O' && cmd === 'wget' && value) t.outputs.push(value);
        if (f === 'i' && cmd === 'wget') t.unreadable.push(value || a);
        break;
      }
      continue;
    }
    if (a.startsWith('-')) continue;
    if (isHttpie) {
      positional++;
      if (positional === 1 && /^[A-Z]+$/.test(a)) {
        if (!/^(GET|HEAD|OPTIONS)$/.test(a)) t.sends = true;
        positional = 0;
        continue;
      }
      if (positional === 1) {
        addTarget(t, a.startsWith(':') ? `localhost${a}` : a);
        continue;
      }
      // Request items: Header:value and query==value only shape the request; field=value, field:=json and field@file send data.
      if (!a.includes('==') && !/^[\w-]+:(?!=)/.test(a) && /=|@/.test(a)) t.sends = true;
      continue;
    }
    addTarget(t, a);
  }
  return t;
}

function addTarget(t: Targets, word: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(word) || LIKE_HOST.test(word) || /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(word)) {
    const h = hostOf(word);
    if (h && !/\$/.test(h)) t.hosts.push(h);
    else t.unreadable.push(word);
  } else if (/\$/.test(word)) t.unreadable.push(word);
}

const networkDeny = (what: string) =>
  deny(
    'network',
    `Blocked by Crew's command guard: ${what}. Commands may only reach this machine and the domains allowed in Settings → Sandbox (or the project's own list). Don't look for another way to connect; if the task needs that host, ask the user to add it.`,
  );

// ---------------------------------------------------------------- per tool

/** Read-only subcommands of git. */
const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'shortlog',
  'describe',
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'merge-base',
  'grep',
  'whatchanged',
  'show-ref',
  'name-rev',
  'for-each-ref',
  'count-objects',
  'check-ignore',
  'var',
  'help',
  'version',
]);
const GIT_GLOBAL_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** gh/hub/glab: the subcommands that only read. Everything else writes somewhere in the user's name. */
const FORGE_READ: Record<string, Set<string>> = {
  gh: new Set([
    'pr list',
    'pr view',
    'pr diff',
    'pr checks',
    'pr status',
    'issue list',
    'issue view',
    'issue status',
    'repo view',
    'repo list',
    'run list',
    'run view',
    'run watch',
    'workflow list',
    'workflow view',
    'release list',
    'release view',
    'release download',
    'auth status',
    'search',
    'status',
    'browse',
    'help',
    'version',
    'gist list',
    'gist view',
    'label list',
    'cache list',
    'ruleset list',
    'ruleset view',
  ]),
  glab: new Set(['mr list', 'mr view', 'mr diff', 'issue list', 'issue view', 'repo view', 'ci list', 'ci view', 'ci status', 'release list', 'release view', 'auth status', 'help', 'version']),
  hub: new Set(['pr list', 'pr show', 'issue', 'browse', 'compare', 'ci-status', 'help', 'version', 'status', 'log', 'diff', 'show']),
};

const PUBLISH: Record<string, Set<string>> = {
  npm: new Set(['publish', 'unpublish', 'deprecate', 'dist-tag', 'owner', 'access', 'token', 'adduser', 'login']),
  pnpm: new Set(['publish']),
  yarn: new Set(['publish', 'npm']),
  bun: new Set(['publish']),
  cargo: new Set(['publish', 'yank', 'owner', 'login']),
  gem: new Set(['push', 'yank', 'owner']),
  twine: new Set(['upload', 'register']),
  poetry: new Set(['publish']),
  flit: new Set(['publish']),
  hatch: new Set(['publish']),
  docker: new Set(['push', 'login']),
  podman: new Set(['push', 'login']),
  vsce: new Set(['publish', 'unpublish']),
  ovsx: new Set(['publish']),
  deno: new Set(['publish']),
  jsr: new Set(['publish']),
  helm: new Set(['push']),
};

const RAW_NETWORK = new Set(['ssh', 'mosh', 'sftp', 'telnet', 'ftp', 'nc', 'ncat', 'netcat', 'scp', 'rsync', 'socat', 'sshpass']);

/** Commands that only read and print (on top of permissions.ts's helpers). */
const READERS = new Set([
  'rg',
  'egrep',
  'fgrep',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'which',
  'type',
  'whereis',
  'realpath',
  'readlink',
  'diff',
  'cmp',
  'comm',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'jq',
  'hexdump',
  'od',
  'strings',
  'uname',
  'whoami',
  'id',
  'hostname',
  'test',
  '[',
  'less',
  'more',
  'sort',
  'uniq',
  'paste',
  'fold',
  'fmt',
  'expand',
  'rev',
  'tac',
  'seq',
  'sleep',
  'exit',
  'cd',
  'pwd',
  'true',
  'false',
  'echo',
  'printf',
  'head',
  'tail',
  'wc',
  'cut',
  'tr',
  'nl',
  'cat',
  'basename',
  'dirname',
  'date',
  'column',
  'grep',
  'ls',
  'find',
]);

/** Output written by the shell: `> file`, `>> file`, `&> file` (to /dev/null or another stream is fine). */
export function redirections(seg: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^<>&\d])(?:\d|&)?>{1,2}\|?\s*(&\d|[^\s;&|<>]+)/g;
  let quote: string | null = null;
  let plain = '';
  for (const c of seg) {
    if (quote) {
      if (c === quote) quote = null;
      plain += c === quote ? c : ' ';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    plain += c;
  }
  for (const m of plain.matchAll(re)) {
    const target = m[1];
    if (target.startsWith('&') || target === '/dev/null' || target === '/dev/stderr' || target === '/dev/stdout') continue;
    out.push(target);
  }
  return out;
}

function gitVerdict(args: string[], ctx: GuardContext): GuardVerdict {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const o = args[i].split('=')[0];
    i += GIT_GLOBAL_ARG.has(o) && !args[i].includes('=') ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (!sub) return READ;
  if (sub === 'push' || sub === 'send-email' || sub === 'request-pull') return deny('external', `Blocked by Crew's command guard: git ${sub}. ${EXTERNAL_HINT}`);
  const words = rest.filter((a) => !a.startsWith('-'));
  if (sub === 'clone' || sub === 'fetch' || sub === 'pull' || sub === 'ls-remote' || (sub === 'remote' && (words[0] === 'add' || words[0] === 'set-url')) || sub === 'submodule') {
    for (const w of words) {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(w) && !/^[\w.-]+@[\w.-]+:/.test(w)) continue;
      const h = hostOf(w.replace(/^([\w.-]+@[\w.-]+):/, 'ssh://$1/'));
      if (h && !hostAllowed(h, ctx.allowedHosts)) return networkDeny(`git ${sub} would connect to ${h}`);
    }
    return change(`Changes git state and may connect to a remote: git ${short(args.slice(i).join(' '), 80)}`);
  }
  const optionsOnly = rest.every((a) => a.startsWith('-'));
  if (GIT_READ.has(sub) && !rest.some((a) => a.startsWith('--output'))) return READ;
  if (
    sub === 'branch' &&
    (optionsOnly || rest.includes('--list') || rest.includes('--show-current')) &&
    !rest.some((a) => /^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream|unset-upstream|edit-description)/.test(a))
  )
    return READ;
  if (sub === 'tag' && (rest.length === 0 || rest[0] === '-l' || rest[0] === '--list')) return READ;
  if (sub === 'remote' && (words.length === 0 || words[0] === 'get-url' || words[0] === 'show')) return READ;
  if (sub === 'stash' && (words[0] === 'list' || words[0] === 'show')) return READ;
  if (sub === 'config' && rest.some((a) => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a))) return READ;
  if ((sub === 'reflog' && (words.length === 0 || words[0] === 'show')) || (sub === 'worktree' && words[0] === 'list')) return READ;
  return change(`Changes git state: git ${short(args.slice(i).join(' '), 80)}`);
}

function forgeVerdict(cmd: string, args: string[]): GuardVerdict {
  const words = args.filter((a) => !a.startsWith('-'));
  const two = words.slice(0, 2).join(' ');
  const reads = FORGE_READ[cmd];
  if (cmd === 'gh' && words[0] === 'api') {
    const method = args.find((_, i) => args[i - 1] === '-X' || args[i - 1] === '--method') || (args.find((a) => /^--method=/.test(a)) || '').split('=')[1] || '';
    const fields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(a));
    if ((method && !/^GET$/i.test(method)) || (!method && fields))
      return deny('external', `Blocked by Crew's command guard: gh api ${short(words.slice(1).join(' '), 60)} writes to GitHub. ${EXTERNAL_HINT}`);
    return change(`Reads from GitHub: gh api ${short(words.slice(1).join(' '), 60)}`);
  }
  if (!words.length || reads.has(words[0]) || reads.has(two)) return change(`Reads from the forge: ${cmd} ${short(words.join(' '), 60)}`);
  return deny('external', `Blocked by Crew's command guard: ${cmd} ${short(two || words[0], 40)} acts on the forge in the user's name. ${EXTERNAL_HINT}`);
}

function rawNetworkVerdict(cmd: string, args: string[]): GuardVerdict {
  const words = args.filter((a) => !a.startsWith('-'));
  let hosts: string[] = [];
  if (cmd === 'scp' || cmd === 'rsync') {
    hosts = words.filter((w) => /^rsync:\/\//.test(w) || /^([^/\s]+@)?[^/\s:]+:/.test(w)).map((w) => hostOf(w.replace(/^rsync:\/\//, '').replace(/:.*$/, '')) || w);
    if (!hosts.length) return change(`Copies files: ${cmd} ${short(words.join(' '), 80)}`);
  } else if (cmd === 'socat') {
    hosts = words.flatMap((w) => [...w.matchAll(/(?:tcp[46]?|udp[46]?|openssl|ssl)[\w-]*:([^:,]+)/gi)].map((m) => m[1]));
    if (!hosts.length) return change(`Runs: socat ${short(words.join(' '), 60)}`);
  } else {
    const h = words.find((w) => !/^\d+$/.test(w));
    hosts = h ? [hostOf(h) || h] : [];
    if (!hosts.length) return networkDeny(`${cmd} without a host it can read`);
  }
  const outside = hosts.find((h) => !isLocal(h.replace(/^.*@/, '')));
  if (outside) return networkDeny(`${cmd} would connect to ${outside} (remote shells and raw connections only reach this machine)`);
  return change(`Connects to this machine: ${cmd} ${short(words.join(' '), 60)}`);
}

function httpVerdict(cmd: string, args: string[], ctx: GuardContext): GuardVerdict {
  const t = httpTargets(cmd, args);
  if (!t.hosts.length && !t.unreadable.length) return change(`Runs: ${cmd} ${short(args.join(' '), 60)}`);
  if (t.unreadable.length) return networkDeny(`${cmd} ${short(t.unreadable[0], 60)} connects to a host the guard cannot read`);
  const outside = t.hosts.find((h) => !hostAllowed(h, ctx.allowedHosts));
  if (outside) return networkDeny(`${cmd} would connect to ${outside}, which is not on the allow-list`);
  const remote = t.hosts.find((h) => !isLocal(h));
  if (t.sends && remote) return deny('external', `Blocked by Crew's command guard: ${cmd} would send data to ${remote}. ${EXTERNAL_HINT}`);
  return change(`Connects to: ${[...new Set(t.hosts)].join(', ')}`, ...t.outputs.map((o) => `Writes file: ${o}`));
}

/** What one simple command does, in words a person can judge. */
function changeEffect(words: string[]): string {
  const [cmd, ...args] = words;
  const files = args.filter((a) => !a.startsWith('-'));
  const list = (xs: string[]) => short(xs.join(', '), 90) || '(nothing named)';
  switch (cmd) {
    case 'rm':
    case 'rmdir':
    case 'unlink':
    case 'shred':
      return `Deletes: ${list(files)}`;
    case 'mv':
      return `Moves: ${list(files.slice(0, -1))} → ${files.at(-1) || '?'}`;
    case 'cp':
      return `Copies: ${list(files.slice(0, -1))} → ${files.at(-1) || '?'}`;
    case 'mkdir':
      return `Creates folder: ${list(files)}`;
    case 'touch':
      return `Creates or touches: ${list(files)}`;
    case 'chmod':
    case 'chown':
    case 'chgrp':
      return `Changes permissions: ${short(args.join(' '), 90)}`;
    case 'ln':
      return `Creates link: ${list(files)}`;
    case 'kill':
    case 'pkill':
    case 'killall':
      return `Stops processes: ${short(args.join(' '), 90)}`;
    case 'sed':
    case 'perl':
      if (args.some((a) => /^-i|^--in-place/.test(a) || /^-[a-z]*i/.test(a))) return `Edits files in place: ${list(files.slice(-3))}`;
      break;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'pip':
    case 'pip3':
    case 'uv':
    case 'poetry':
    case 'cargo':
    case 'gem':
    case 'composer':
      if (/^(install|i|ci|add|remove|rm|uninstall|update|up|upgrade|sync)$/.test(files[0] || '') || (cmd === 'yarn' && !files.length)) return `Installs packages: ${cmd} ${short(args.join(' '), 80)}`;
      if (/^(run|run-script|test|build|start|exec|x|dlx)$/.test(files[0] || '')) return `Runs a project script: ${cmd} ${short(args.join(' '), 80)}`;
      break;
    case 'npx':
    case 'bunx':
    case 'pnpx':
    case 'uvx':
      return `Downloads and runs: ${cmd} ${short(args.join(' '), 80)}`;
    case 'make':
      return `Runs a project script: make ${short(args.join(' '), 80)}`;
  }
  return `Runs: ${short(words.join(' '), 90)}`;
}

/** One simple command (no separators): a refusal, a read, or a change; output redirected to a file makes it a change. */
function segmentVerdict(seg: string, ctx: GuardContext, depth: number): GuardVerdict {
  const v = commandVerdict(seg, ctx, depth);
  const writes = redirections(seg);
  if (!writes.length || v.kind === 'deny') return v;
  return change(...writes.map((w) => `Writes file: ${w}`), ...(v.kind === 'change' ? v.effects : []));
}

function commandVerdict(seg: string, ctx: GuardContext, depth: number): GuardVerdict {
  const words = commandOf(shellWords(seg));
  if (!words.length) return READ;
  const [cmd, ...args] = words;
  // Nested shells and eval: the command inside is what runs.
  if (/^(sh|bash|zsh|dash|ksh|fish)$/.test(cmd)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (c >= 0 && args[c + 1] !== undefined) return verdictOf(args[c + 1], ctx, depth + 1);
    return change(`Runs a shell: ${short(words.join(' '), 80)}`);
  }
  if (cmd === 'eval') return verdictOf(args.join(' '), ctx, depth + 1);
  if (cmd === 'find' || cmd === 'fd') {
    const execAt = args.findIndex((a) => /^-(exec|execdir|ok|okdir|x|X)$/.test(a) || a === '--exec' || a === '--exec-batch');
    if (execAt >= 0) {
      const inner = args.slice(execAt + 1);
      const end = inner.findIndex((a) => a === ';' || a === '+' || a === '\\;');
      const v = verdictOf(inner.slice(0, end < 0 ? undefined : end).join(' '), ctx, depth + 1);
      return v.kind === 'deny' ? v : change(`Runs a command on every file found: ${short(inner.join(' '), 80)}`);
    }
    if (args.some((a) => /^-(delete|fprint|fprint0|fprintf|fls)$/.test(a))) return change(`Deletes or writes files found by find: ${short(args.join(' '), 80)}`);
  }
  if (cmd === 'git') return gitVerdict(args, ctx);
  if (cmd in FORGE_READ) return forgeVerdict(cmd, args);
  const sub = args.find((a) => !a.startsWith('-'));
  if (PUBLISH[cmd] && sub && PUBLISH[cmd].has(sub)) return deny('external', `Blocked by Crew's command guard: ${cmd} ${sub} publishes in the user's name. ${EXTERNAL_HINT}`);
  if (cmd === 'curl' || cmd === 'wget' || cmd === 'http' || cmd === 'https' || cmd === 'xh' || cmd === 'xhs' || cmd === 'aria2c') return httpVerdict(cmd, args, ctx);
  if (RAW_NETWORK.has(cmd)) return rawNetworkVerdict(cmd, args);
  if (READERS.has(cmd) || harmless(seg)) {
    if (cmd === 'sort' && args.some((a) => a === '-o' || a.startsWith('--output'))) return change(changeEffect(words));
    return READ;
  }
  if (args.length === 1 && /^(--version|-v|-V|version|--help|-h|help)$/.test(args[0])) return READ;
  return change(changeEffect(words));
}

function combine(verdicts: GuardVerdict[]): GuardVerdict {
  const refused = verdicts.find((v) => v.kind === 'deny');
  if (refused) return refused;
  const effects = [...new Set(verdicts.flatMap((v) => (v.kind === 'change' ? v.effects : [])))];
  if (verdicts.every((v) => v.kind === 'read')) return READ;
  return { kind: 'change', effects: effects.slice(0, MAX_EFFECTS).concat(effects.length > MAX_EFFECTS ? [`…and ${effects.length - MAX_EFFECTS} more`] : []) };
}

function pathContext(ctx: GuardContext): PathContext {
  return { cwd: ctx.cwd, home: ctx.home, secretRoots: secretRoots(ctx), crewHome: ctx.crewHome, worktrees: ctx.worktrees, realpath: ctx.realpath };
}

/** ADR 104's rules for one simple command, judged where it runs, with nested programs judged in full. */
function hardened(seg: Segment, ctx: GuardContext, whole: string, depth: number): GuardVerdict | null {
  const raw = shellWords(seg.text);
  const info = { words: commandOf(raw), raw, redirects: redirections(seg.text), whole };
  return hardenedVerdict(seg, info, { ...pathContext(ctx), crewPorts: ctx.crewPorts }, (inner) => verdictOf(inner, ctx, depth + 1));
}

function verdictOf(cmd: string, ctx: GuardContext, depth: number): GuardVerdict {
  if (depth > MAX_DEPTH) return change(`Runs: ${short(cmd, 90)}`);
  const secret = credentialInText(cmd, ctx);
  if (secret) return credentialDeny(secret);
  const verdicts: GuardVerdict[] = substitutions(cmd).map((inner) => verdictOf(inner, ctx, depth + 1));
  // A process or command substitution makes the outer command depend on code the read list never saw.
  if (verdicts.length) verdicts.push(change(`Runs commands inside: ${short(cmd, 80)}`));
  // `cd` moves the folder the rest of the line is judged in (ADR 104).
  let here = ctx;
  for (const seg of splitSegments(cmd)) {
    for (const w of shellWords(seg.text)) {
      const hit = credentialPath(w, here);
      if (hit) return credentialDeny(w);
    }
    const extra = hardened(seg, here, cmd, depth);
    if (extra) verdicts.push(extra);
    verdicts.push(segmentVerdict(seg.text, here, depth));
    const to = cdTarget(commandOf(shellWords(seg.text)), here);
    if (to) here = { ...here, cwd: to };
  }
  return combine(verdicts);
}

/** What the guard makes of a shell command. */
export function guardCommand(cmd: string, ctx: GuardContext): GuardVerdict {
  return verdictOf(String(cmd || ''), ctx, 0);
}

const PATH_FIELDS = ['file_path', 'notebook_path', 'path'];

/** What the guard makes of any tool call. Only Bash can be a change; other tools are judged by Crew's usual rules. */
export function guardTool(toolName: string, input: unknown, ctx: GuardContext): GuardVerdict {
  const i = (input || {}) as Record<string, unknown>;
  if (toolName === 'Bash') return guardCommand(String(i.command || ''), ctx);
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS' || toolName === 'WebFetch' || EDIT_TOOLS.has(toolName)) {
    const v = hardenedToolVerdict(toolName, i, { ...pathContext(ctx), crewPorts: ctx.crewPorts }, EDIT_TOOLS.has(toolName));
    if (v) return v;
  }
  if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob' || toolName === 'LS' || EDIT_TOOLS.has(toolName)) {
    // Glob's pattern is a path; Grep's is a regular expression.
    for (const f of toolName === 'Glob' ? [...PATH_FIELDS, 'pattern'] : PATH_FIELDS) {
      const v = i[f];
      if (typeof v !== 'string' || !v) continue;
      // A glob is checked by the folder it starts in, and by its text.
      const base = f === 'pattern' ? v.replace(/[*?[{].*$/, '') : v;
      if ((base && credentialPath(base, ctx)) || credentialInText(v, ctx)) return credentialDeny(v);
    }
  }
  return READ;
}
