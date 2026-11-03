// What the command guard (ADR 007) missed when the model is assumed compromised (ADR 104): a
// single `&` between commands, `cd` before a relative path, command names computed at run time,
// scripts piped into a shell, programs hidden in variables and git settings, credential stores
// reached by glob or through a folder, other processes' environments, writes to configuration that
// runs later, Crew's own API, and publishing or cloud tools that act with the user's accounts.
// Pure: the guard calls it per simple command and passes a way to judge a nested command.

import type { GuardRule, GuardVerdict } from '../../shared/types';
import { credentialReach, expandHome, hasGlob, type PathContext, procSecret, protectedWrite, resolveWord, secretInText } from './paths';

export interface Segment {
  text: string;
  /** What joined it to the command before it: '|' for a pipe; '' for the first. */
  after: '' | '|' | '&&' | '||' | ';' | '&' | '\n';
}

/**
 * Simple commands of a command line, with what joined each to the one before. Like `splitCommand`
 * (`&&`, `||`, `;`, `|`, newline), and a single `&` too (a command sent to the background is still
 * a command), but not the `&` of a redirection (`2>&1`, `&>`, `>&2`, `|&`).
 */
export function splitSegments(cmd: string): Segment[] {
  const out: Segment[] = [];
  let cur = '';
  let quote: string | null = null;
  let after: Segment['after'] = '';
  const push = (next: Segment['after']) => {
    if (cur.trim()) out.push({ text: cur.trim(), after });
    cur = '';
    after = next;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      push(two);
      i++;
      continue;
    }
    if (c === '|') {
      push('|');
      // `|&` pipes stderr too.
      if (cmd[i + 1] === '&') i++;
      continue;
    }
    if (c === ';' || c === '\n') {
      push(c);
      continue;
    }
    if (c === '&' && cmd[i - 1] !== '>' && cmd[i - 1] !== '<' && cmd[i + 1] !== '>') {
      push('&');
      continue;
    }
    cur += c;
  }
  push('');
  return out;
}

export const deny = (rule: GuardRule, reason: string): GuardVerdict => ({ kind: 'deny', rule, reason });

const CRED = (what: string) =>
  deny(
    'credentials',
    `Blocked by Crew's command guard: ${what}. Agents may not read credentials, other processes' environments or their memory. Don't look for another way to get at them; if a task needs a credential, tell the user.`,
  );

const CONFIG = (what: string) =>
  deny(
    'config',
    `Blocked by Crew's command guard: this would change ${what}, which decides what runs later, outside Crew's gates. Don't work around it; tell the user what you would change and why, and let them do it.`,
  );

const OPAQUE = (what: string) =>
  deny(
    'opaque',
    `Blocked by Crew's command guard: ${what}, so the guard cannot tell what would run. Write the command out plainly (no computed command names, no scripts piped into a shell or an interpreter).`,
  );

const CREW_API = (what: string) =>
  deny(
    'crew-api',
    `Blocked by Crew's command guard: ${what} is Crew's own API. Agents may not change Crew's settings, approve drafts or answer approvals; Crew refuses such requests from agent processes anyway. If something in Crew needs changing, tell the user.`,
  );

const EXTERNAL = (what: string) =>
  deny(
    'external',
    `Blocked by Crew's command guard: ${what} acts with the user's accounts outside this machine. Don't do it, and don't try another way: call draft_external_action for a push, a pull request, an issue, a comment or a message, or tell the user what should be deployed or changed.`,
  );

const NETWORK = (what: string) =>
  deny(
    'network',
    `Blocked by Crew's command guard: ${what}. Commands may only reach this machine and the domains allowed in Settings → Sandbox (or the project's own list). Don't look for another way to connect; if the task needs that host, ask the user to add it.`,
  );

/** What the guard knows about where it runs, beyond the paths. */
export interface CommandContext extends PathContext {
  /** Ports Crew's own server listens on. */
  crewPorts?: number[];
}

/** Judges a nested command (a variable's or a git setting's program) with the guard's full rules. */
export type Judge = (command: string) => GuardVerdict;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'mksh']);
const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'Rscript', 'osascript', 'pwsh', 'powershell']);
/** The flag that makes an interpreter run its next argument as code. */
const INLINE_CODE = /^-(c|e|-eval|-print|p|E|r|-command|Command)$/;

/** Variables whose value is a program something will run. */
const PROGRAM_VARS =
  /^(GIT_SSH_COMMAND|GIT_SSH|GIT_ASKPASS|SSH_ASKPASS|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|PAGER|MANPAGER|EDITOR|VISUAL|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|BROWSER|LESSOPEN|LESSCLOSE|PROMPT_COMMAND|FCEDIT)$/;
/** Variables that load code into whatever runs next, or rewrite git's settings. */
const LOADER_VARS =
  /^(LD_PRELOAD|LD_AUDIT|DYLD_INSERT_LIBRARIES|BASH_ENV|ENV|PYTHONSTARTUP|PERL5OPT|RUBYOPT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_EXEC_PATH|GIT_TEMPLATE_DIR)$/;

/** git settings whose value is a program (or a folder of programs) git runs. */
const GIT_PROGRAM_KEY =
  /^(core\.(sshcommand|pager|editor|fsmonitor|askpass|gitproxy|hookspath)|credential\..*|alias\..*|diff\.external|diff\..*\.(textconv|command)|merge\..*\.driver|filter\..*|gpg\.program|gpg\..*\.program|sequence\.editor|pager\..*|uploadpack\.packobjectshook|submodule\..*\.update|instaweb\..*|sendemail\..*|man\..*\.(cmd|path)|web\.browser|browser\..*\.(cmd|path)|difftool\..*|mergetool\..*)$/i;
/** git settings that redirect where git connects or what it loads. */
const GIT_REDIRECT_KEY =
  /^(url\..*\.(insteadof|pushinsteadof)|remote\..*\.(url|pushurl|receivepack|uploadpack|proxy)|include\..*|includeif\..*|protocol\..*|http\..*proxy|core\.attributesfile|init\.templatedir)$/i;

/** Tools that act with the user's hosting or cloud accounts; the words that only read or print. */
const ACCOUNT_TOOLS: Record<string, { what: string; reads?: RegExp }> = {
  'gh-pages': { what: 'gh-pages publishes to GitHub Pages' },
  vercel: { what: 'vercel deploys', reads: /^(dev|build|--version|-v|help|--help|whoami|ls|list|inspect|logs)$/ },
  now: { what: 'now deploys' },
  netlify: { what: 'netlify acts on your site', reads: /^(dev|build|status|--version|help|--help|serve|watch)$/ },
  firebase: { what: 'firebase acts on your project', reads: /^(emulators:start|emulators:exec|serve|--version|help|--help|login:list|projects:list)$/ },
  surge: { what: 'surge publishes' },
  wrangler: { what: 'wrangler deploys', reads: /^(dev|--version|-v|help|--help|whoami|types|tail)$/ },
  fly: { what: 'fly acts on your apps', reads: /^(version|--version|help|--help|status|logs|apps|auth)$/ },
  flyctl: { what: 'flyctl acts on your apps', reads: /^(version|--version|help|--help|status|logs|apps|auth)$/ },
  heroku: { what: 'heroku acts on your apps', reads: /^(--version|help|--help|logs|apps|ps|config:get)$/ },
  railway: { what: 'railway deploys', reads: /^(--version|help|--help|status|logs|whoami)$/ },
  aws: { what: 'aws acts with your AWS credentials', reads: /^(--version|help)$/ },
  gcloud: { what: 'gcloud acts with your Google Cloud credentials', reads: /^(--version|version|help)$/ },
  gsutil: { what: 'gsutil acts with your Google Cloud credentials', reads: /^(--version|version|help)$/ },
  az: { what: 'az acts with your Azure credentials', reads: /^(--version|version|help)$/ },
  doctl: { what: 'doctl acts with your DigitalOcean credentials', reads: /^(version|--version|help)$/ },
  kubectl: { what: 'kubectl acts on your clusters', reads: /^(version|--version|help|explain|api-resources|completion)$/ },
  terraform: { what: 'terraform acts with your cloud credentials', reads: /^(version|-version|--version|help|-help|fmt|validate)$/ },
  pulumi: { what: 'pulumi acts with your cloud credentials', reads: /^(version|--version|help|about)$/ },
  serverless: { what: 'serverless deploys', reads: /^(--version|help|--help|print|offline)$/ },
  sls: { what: 'serverless deploys', reads: /^(--version|help|--help|print|offline)$/ },
  cdk: { what: 'cdk deploys', reads: /^(--version|help|--help|synth|ls|list|diff|doctor)$/ },
};

/** git subcommands that send commits somewhere, beyond push (which the guard refuses already). */
const GIT_SENDS = new Set(['send-pack', 'http-push', 'svn', 'p4']);

/** Commands that write to the paths they are given. */
const WRITERS = new Set([
  'cp',
  'mv',
  'ln',
  'install',
  'tee',
  'touch',
  'truncate',
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'chmod',
  'chown',
  'chgrp',
  'mkdir',
  'rsync',
  'dd',
  'patch',
  'unzip',
  'tar',
  'sed',
  'perl',
  'cpio',
  'ditto',
  'setfacl',
  'xattr',
  'chattr',
]);

/** Commands that read every file under a folder. */
function recursiveReader(cmd: string, args: string[], wholeCommand: string): boolean {
  if (/^(rg|ag|ack|ugrep|tar|zip|7z|7za|cpio|rsync|ditto|bsdtar|duplicity|restic|borg)$/.test(cmd)) return true;
  if (/^(grep|egrep|fgrep|zgrep)$/.test(cmd)) return args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^--(recursive|dereference-recursive|directories=recurse)$/.test(a) || a === 'recurse');
  if (cmd === 'cp' || cmd === 'scp') return args.some((a) => /^-[a-zA-Z]*[rRa]/.test(a) || a === '--recursive' || a === '--archive');
  if (cmd === 'find' || cmd === 'fd' || cmd === 'ls' || cmd === 'tree' || cmd === 'du') {
    if (args.some((a) => /^-(exec|execdir|ok|okdir|x|X|fprint|fprint0|fprintf|fls)$/.test(a) || a === '--exec' || a === '--exec-batch')) return true;
    // Names fed to a reader on the other side of a pipe.
    return /\|\s*(xargs|parallel)\b|\|\s*while\s+read\b/.test(wholeCommand);
  }
  return false;
}

/** Host and port of a word that names a target (a URL, host:port), or null. */
function hostPort(word: string): { host: string; port: number | null } | null {
  let w = word.trim();
  if (!w) return null;
  if (w.startsWith(':')) w = `localhost${w}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) w = `http://${w}`;
  try {
    const u = new URL(w);
    const port = u.port ? Number(u.port) : null;
    return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

const LOCAL = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|::1|0:0:0:0:0:0:0:1|::ffff:127(\.\d{1,3}){3})$/i;

/** A word of a network tool that reaches Crew's own server on this machine. */
function crewTarget(args: string[], ports: number[]): string | null {
  if (!ports.length) return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // curl --connect-to/--resolve can send a request for any name to a local port.
    for (const m of a.matchAll(/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)[:](\d{1,5})/gi)) {
      if (ports.includes(Number(m[2]))) return a;
    }
    const hp = hostPort(a);
    if (hp?.port && LOCAL.test(hp.host) && ports.includes(hp.port)) return a;
    // nc localhost 4321, telnet 127.0.0.1 4321
    if (LOCAL.test(a) && args[i + 1] && /^\d+$/.test(args[i + 1]) && ports.includes(Number(args[i + 1]))) return `${a} ${args[i + 1]}`;
  }
  return null;
}

const NET_TOOLS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'xhs', 'aria2c', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'websocat', 'wscat']);

/** The package a package runner is asked to run (npx gh-pages, pnpm dlx vercel, npm exec -- netlify). */
function runnerTarget(cmd: string, args: string[]): { cmd: string; args: string[] } | null {
  let rest: string[] | null = null;
  if (cmd === 'npx' || cmd === 'bunx' || cmd === 'pnpx') rest = args;
  else if ((cmd === 'pnpm' || cmd === 'yarn') && args[0] === 'dlx') rest = args.slice(1);
  else if (cmd === 'npm' && (args[0] === 'exec' || args[0] === 'x')) rest = args.slice(1);
  if (!rest) return null;
  const i = rest.findIndex((a) => !a.startsWith('-'));
  if (i < 0) return null;
  // gh-pages@6 -> gh-pages; @scope/name@1 -> name
  const pkg = rest[i].replace(/(.)@[^/]*$/, '$1').replace(/^.*\//, '');
  return { cmd: pkg, args: rest.slice(i + 1) };
}

/** What a `git config` call does: the key and value it writes, and whether it writes outside the repository. */
function gitConfigWrite(args: string[]): { key?: string; value?: string; scoped: boolean; write: boolean } {
  const scoped = args.some((a) => /^--(global|system|file|blob)(=|$)/.test(a) || a === '-f');
  const words = args.filter((a) => !a.startsWith('-'));
  const readFlag = args.some((a) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--get-color|--get-colorbool|--show-origin|--show-scope|--name-only)$/.test(a));
  const writeFlag = args.some((a) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(a));
  // `git config set|unset|get|list` (git 2.46+)
  if (words[0] === 'get' || words[0] === 'list') return { scoped, write: false };
  if (words[0] === 'set' || words[0] === 'unset' || words[0] === 'rename-section' || words[0] === 'remove-section' || words[0] === 'edit')
    return { key: words[1], value: words[2], scoped, write: true };
  if (readFlag && !writeFlag) return { scoped, write: false };
  if (writeFlag) return { key: words[0], value: words[1], scoped, write: true };
  return { key: words[0], value: words[1], scoped, write: words.length >= 2 };
}

/** git's own words: global options (with -c settings) and the subcommand with its arguments. */
function gitParts(args: string[]): { settings: string[]; sub?: string; rest: string[] } {
  const settings: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-c') {
      if (args[i + 1] !== undefined) settings.push(args[i + 1]);
      i += 2;
      continue;
    }
    if (a.startsWith('-c') && a.length > 2) {
      settings.push(a.slice(2));
      i++;
      continue;
    }
    if (a === '--config-env' || a.startsWith('--config-env=')) {
      const v = a === '--config-env' ? String(args[++i] || '') : a.slice('--config-env='.length);
      settings.push(`${v.split('=')[0]}=$${v.split('=')[1] || 'ENV'}`);
      i++;
      continue;
    }
    i += /^(-C|--git-dir|--work-tree|--namespace|--exec-path)$/.test(a) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  // `git clone -c key=value` writes the setting into the new repository.
  if (sub === 'clone') {
    for (let j = 0; j < rest.length; j++) {
      if ((rest[j] === '-c' || rest[j] === '--config') && rest[j + 1] !== undefined) settings.push(rest[++j]);
      else if (rest[j].startsWith('--config=')) settings.push(rest[j].slice('--config='.length));
    }
  }
  return { settings, sub, rest };
}

/** A program-valued setting's value as a command to judge, or a refusal when it cannot be judged. */
function judgeProgram(what: string, value: string, judge: Judge): GuardVerdict | null {
  const v = value.trim().replace(/^!/, '').replace(/^\|/, '');
  if (!v || /^(true|false|0|1|yes|no|on|off|cat|less|more)$/i.test(v)) return null;
  const inner = judge(v);
  return inner.kind === 'deny' ? inner : { kind: 'change', effects: [`Runs a program through ${what}: ${v.slice(0, 80)}`] };
}

export interface SegmentInfo {
  /** The words of the command that runs (wrappers and VAR=value removed), the first being its name. */
  words: string[];
  /** All words of the segment as written. */
  raw: string[];
  /** Files the shell writes to (`>`, `>>`). */
  redirects: string[];
  /** The whole command line the segment belongs to. */
  whole: string;
}

/**
 * The refusals ADR 104 adds for one simple command, or extra effects to show; null when it has
 * nothing to say. Checked before the guard's own rules for that command.
 */
export function hardenedVerdict(seg: Segment, info: SegmentInfo, ctx: CommandContext, judge: Judge): GuardVerdict | null {
  const { words, raw, redirects } = info;
  const [cmd = '', ...args] = words;
  const effects: string[] = [];

  // Programs and loaders handed over in variables (VAR=value cmd, env VAR=value cmd, export VAR=value).
  for (const w of raw) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w);
    if (!m) continue;
    if (LOADER_VARS.test(m[1])) return OPAQUE(`${m[1]} loads code into what runs next`);
    if (m[1] === 'NODE_OPTIONS' && /(^|\s)(--require|-r|--import|--loader|--experimental-loader)\b/.test(m[2])) return OPAQUE('NODE_OPTIONS loads a module into what runs next');
    if (PROGRAM_VARS.test(m[1])) {
      const v = judgeProgram(m[1], m[2], judge);
      if (v?.kind === 'deny') return v;
      if (v?.kind === 'change') effects.push(...v.effects);
    }
  }

  // A command name computed when it runs: the guard cannot know what it is. (`$HOME/bin/tool` is
  // fine: the guard reads a command by its file name.)
  if (words.length && /[$`]/.test(words[0])) return OPAQUE(`the command name ${words[0].slice(0, 40)} is computed when it runs`);

  // A script fed to a shell or an interpreter on its standard input.
  if (SHELLS.has(cmd) || INTERPRETERS.has(cmd)) {
    const code = args.findIndex((a) => INLINE_CODE.test(a) || (SHELLS.has(cmd) && /^-[a-z]*c[a-z]*$/.test(a)));
    // Redirections and what they take are not the script: `bash <<< "…"`, `python3 < x`.
    const plain = args.filter((a, i) => !/^\d*[<>]/.test(a) && !/^\d*[<>]+&?$/.test(args[i - 1] || ''));
    const script = plain.find((a) => !a.startsWith('-') && a !== '-' && a !== '/dev/stdin');
    const stdin = seg.after === '|' || /<<</.test(seg.text) || /(^|\s)<\s*\(/.test(seg.text);
    if (code < 0 && !script && stdin) return OPAQUE(`a script is piped into ${cmd}`);
  }

  // Credential stores reached by glob, or through a folder that holds them, and process secrets.
  const reader = recursiveReader(cmd, args, info.whole);
  for (const w of [...raw, ...redirects]) {
    const reach = credentialReach(w, ctx);
    if (!reach) continue;
    if (reach.kind === 'inside' && hasGlob(w)) return CRED(`${w} can match ${reach.root}, which holds credentials`);
    if (reach.kind === 'inside') return CRED(`${w} holds credentials`);
    if (reader) return CRED(`${cmd} would read everything under ${w}, including ${reach.root}, which holds credentials`);
  }
  if (cmd === 'ps' && args.some((a) => !a.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(a))) return CRED('ps with e prints other processes’ environments');
  if (/^(gdb|lldb|strace|ltrace|dtrace|perf)$/.test(cmd) && args.some((a) => /^(-p|--pid|attach|--attach-pid)$/.test(a) || /^-p\d+$/.test(a))) return CRED(`${cmd} attaches to another process`);
  const named = secretInText(info.whole, ctx);
  if (named) return CRED(`the command names ~/${named}, which holds credentials`);
  const proc = procSecret(info.whole);
  if (proc) return CRED(`${proc} is another process's environment, command line or memory`);

  // Crew's own server.
  if (NET_TOOLS.has(cmd)) {
    const t = crewTarget(args, ctx.crewPorts || []);
    if (t) return CREW_API(t);
    // A network tool fed its targets by xargs/parallel: the guard cannot read them.
    if (raw.slice(0, raw.indexOf(words[0])).some((w) => w === 'xargs' || w === 'parallel') && !args.some((a) => /^[a-z][a-z0-9+.-]*:\/\//i.test(a)))
      return NETWORK(`${cmd} is given its targets by ${raw.includes('parallel') ? 'parallel' : 'xargs'}, so the guard cannot read where it connects`);
  }

  // Configuration that runs later: the files themselves.
  const targets = [...redirects];
  if (WRITERS.has(cmd)) {
    const inPlace = cmd !== 'sed' && cmd !== 'perl' ? true : args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
    if (inPlace) targets.push(...args.filter((a) => !a.startsWith('-') || /^of=/.test(a)).map((a) => a.replace(/^of=/, '')));
    for (const a of args) if (/^--?(target-directory|directory|output)=/.test(a)) targets.push(a.slice(a.indexOf('=') + 1));
  }
  if (cmd === 'curl' || cmd === 'wget') {
    for (let i = 0; i < args.length; i++) if (/^(-o|-O|--output|--output-document)$/.test(args[i]) && args[i + 1]) targets.push(args[i + 1]);
  }
  for (const t of targets) {
    if (!t || hasGlob(t) || /^\d+$/.test(t)) continue;
    const why = protectedWrite(resolveWord(t, ctx), ctx);
    if (why) return CONFIG(why);
  }
  if (cmd === 'crontab' && !args.includes('-l')) return CONFIG('your crontab');
  if ((cmd === 'systemctl' || cmd === 'launchctl') && args.some((a) => /^(enable|link|load|bootstrap|edit|set-environment|import-environment)$/.test(a)))
    return CONFIG(`${cmd} services that start later`);

  // git: settings that run programs, settings it is handed with -c, remotes, more ways to send.
  if (cmd === 'git') {
    const g = gitParts(args);
    for (const s of g.settings) {
      const at = s.indexOf('=');
      const key = (at < 0 ? s : s.slice(0, at)).toLowerCase();
      const value = at < 0 ? 'true' : s.slice(at + 1);
      if (key === 'core.hookspath') return OPAQUE('git -c core.hooksPath runs hooks from a folder the guard never sees');
      if (GIT_REDIRECT_KEY.test(key)) return CONFIG(`where git connects (git -c ${key})`);
      if (GIT_PROGRAM_KEY.test(key)) {
        const v = judgeProgram(`git -c ${key}`, value, judge);
        if (v?.kind === 'deny') return v;
        if (v?.kind === 'change') effects.push(...v.effects);
      }
    }
    if (g.sub === 'config') {
      const c = gitConfigWrite(g.rest);
      if (c.write && c.scoped) return CONFIG('git settings outside this repository (--global, --system or --file)');
      if (c.write && c.key && (GIT_PROGRAM_KEY.test(c.key) || GIT_REDIRECT_KEY.test(c.key))) return CONFIG(`the git setting ${c.key}`);
    }
    if (g.sub === 'remote' && /^(set-url|rename|remove|rm|set-head|set-branches)$/.test(g.rest.find((a) => !a.startsWith('-')) || ''))
      return CONFIG("the repository's remotes (a push draft sends to them)");
    if (g.sub && GIT_SENDS.has(g.sub) && (g.sub !== 'svn' || g.rest.includes('dcommit')) && (g.sub !== 'p4' || g.rest.includes('submit'))) return EXTERNAL(`git ${g.sub}`);
    if (g.sub === 'subtree' && g.rest.includes('push')) return EXTERNAL('git subtree push');
    if (g.sub === 'init' && g.rest.some((a) => a.startsWith('--template'))) return CONFIG('git hooks (through a template folder)');
  }

  // Hosting and cloud tools act with the user's stored accounts (their files, not the environment).
  const run = runnerTarget(cmd, args) || { cmd, args };
  const account = ACCOUNT_TOOLS[run.cmd];
  if (account) {
    const first = run.args.find((a) => !a.startsWith('-')) ?? run.args[0];
    if (!(account.reads && first !== undefined && account.reads.test(first))) return EXTERNAL(account.what);
  }

  return effects.length ? { kind: 'change', effects } : null;
}

/** The folder a `cd`/`pushd` segment moves to, or null when it is not one. */
export function cdTarget(words: string[], ctx: Pick<PathContext, 'cwd' | 'home'>): string | null {
  const [cmd, ...args] = words;
  if (cmd !== 'cd' && cmd !== 'pushd') return null;
  const dir = args.find((a) => !a.startsWith('-') || a === '-');
  if (!dir) return ctx.home;
  if (dir === '-' || /[$`]/.test(expandHome(dir, ctx.home))) return null;
  return resolveWord(dir, ctx);
}

/** A tool path (Read, Grep, Edit…) checked against the hardened rules; null when nothing applies. */
export function hardenedToolVerdict(toolName: string, input: Record<string, unknown>, ctx: CommandContext, edit: boolean): GuardVerdict | null {
  const paths = ['file_path', 'notebook_path', 'path'].map((f) => input[f]).filter((v): v is string => typeof v === 'string' && !!v);
  if (toolName === 'Glob' && typeof input.pattern === 'string') paths.push(input.pattern);
  for (const p of paths) {
    const proc = procSecret(resolveWord(p, ctx));
    if (proc) return CRED(`${proc} is another process's environment, command line or memory`);
    const reach = credentialReach(p, ctx);
    if (reach?.kind === 'inside') return CRED(`${p} holds credentials`);
    // Grep reads every file under its folder.
    if (reach?.kind === 'ancestor' && toolName === 'Grep') return CRED(`Grep would read everything under ${p}, including ${reach.root}, which holds credentials`);
    if (edit) {
      const why = protectedWrite(resolveWord(p, ctx), ctx);
      if (why) return CONFIG(why);
    }
  }
  if (toolName === 'WebFetch' && typeof input.url === 'string') {
    const t = crewTarget([input.url], ctx.crewPorts || []);
    if (t) return CREW_API(t);
  }
  return null;
}
