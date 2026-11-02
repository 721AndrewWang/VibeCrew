// Which paths an agent may not reach (ADR 104): credential stores reached by a glob or through a
// folder that contains them, another process's environment or memory under /proc, and the files
// that decide what runs later (git hooks and config, Claude Code's and editors' project settings,
// Crew's own data, shell start-up files). Pure: the caller passes the folders and, optionally, a
// way to resolve symbolic links.

import path from 'node:path';

export interface PathContext {
  /** The folder a relative path is resolved against. */
  cwd: string;
  /** The user's home directory (~). */
  home: string;
  /** Credential stores and files, as absolute paths (ADR 007's list, Crew's settings.json). */
  secretRoots: string[];
  /** Crew's data folder (CREW_HOME). */
  crewHome?: string;
  /** Where chat workspaces and Workers' worktrees live: inside crewHome, and the agents' own folders. */
  worktrees?: string;
  /** The real path of an absolute path (symbolic links followed), or null to keep it as it is. */
  realpath?: (abs: string) => string | null;
}

export function expandHome(word: string, home: string): string {
  return word.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}

export function within(abs: string, root: string): boolean {
  return abs === root || abs.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** A strict ancestor: `dir` contains `root` somewhere below it. */
export function contains(dir: string, root: string): boolean {
  return dir !== root && within(root, dir);
}

/** A shell word as an absolute path (home expanded, resolved against the folder). */
export function resolveWord(word: string, ctx: Pick<PathContext, 'cwd' | 'home'>): string {
  return path.resolve(ctx.cwd, expandHome(word, ctx.home));
}

/** Both the path as written and, when it differs, where its symbolic links lead. */
function forms(abs: string, ctx: PathContext): string[] {
  const real = ctx.realpath?.(abs);
  return real && real !== abs ? [abs, real] : [abs];
}

/** A word with glob characters the shell would expand (`[` alone is the test command). */
export function hasGlob(word: string): boolean {
  return word.length > 1 && /[*?]|\[[^\]]+\]/.test(word);
}

function segmentRegex(seg: string): RegExp {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = seg.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${seg
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * How far an absolute glob reaches toward a path: 'inside' when it can match the path or something
 * below it, 'ancestor' when it can only match a folder that contains it, null when it cannot.
 */
export function globReach(glob: string, target: string): 'inside' | 'ancestor' | null {
  const g = glob.split('/').filter(Boolean);
  const t = target.split('/').filter(Boolean);
  for (let i = 0; i < Math.min(g.length, t.length); i++) {
    if (g[i] === '**') return 'inside';
    if (!segmentRegex(g[i]).test(t[i])) return null;
  }
  return g.length >= t.length ? 'inside' : 'ancestor';
}

export interface Reach {
  /** inside: the word names a credential store or something in it; ancestor: a folder that holds one. */
  kind: 'inside' | 'ancestor';
  /** The credential store reached. */
  root: string;
}

/** Whether a word (a path or a glob) reaches a credential store, and how. */
export function credentialReach(word: string, ctx: PathContext): Reach | null {
  if (!word || word.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) return null;
  // An option's value (--file=x) is a path too.
  const value = word.includes('=') && /^-/.test(word) ? word.slice(word.indexOf('=') + 1) : word;
  const abs = resolveWord(value, ctx);
  let best: Reach | null = null;
  for (const root of ctx.secretRoots) {
    if (hasGlob(value)) {
      const r = globReach(abs, root);
      if (r === 'inside') return { kind: 'inside', root };
      if (r === 'ancestor') best ??= { kind: 'ancestor', root };
      continue;
    }
    for (const p of forms(abs, ctx)) {
      if (within(p, root)) return { kind: 'inside', root };
      if (contains(p, root)) best ??= { kind: 'ancestor', root };
    }
  }
  return best;
}

/**
 * A credential store under the home folder named by its home-relative path anywhere in a command's
 * text (`process.env.HOME + '/.crew/settings.json'` in a script): whatever reads it.
 */
export function secretInText(text: string, ctx: Pick<PathContext, 'home' | 'secretRoots'>): string | null {
  for (const root of ctx.secretRoots) {
    if (!contains(ctx.home, root)) continue;
    const rel = path.relative(ctx.home, root);
    let at = text.indexOf(rel);
    while (at >= 0) {
      const before = text[at - 1] || '';
      const after = text[at + rel.length] || '';
      if (/[/'"`\s=:(]/.test(before) && !/[\w.-]/.test(after)) return rel;
      at = text.indexOf(rel, at + 1);
    }
  }
  return null;
}

/** Another process's environment, command line or memory (the session's own included). */
const PROC_SECRET = /\/proc\/(?:[^\s'"`;|&<>]*\/)?(environ|cmdline|mem|maps|auxv)(?![\w.-])/;

export function procSecret(text: string): string | null {
  return text.match(PROC_SECRET)?.[0] ?? null;
}

/** Shell start-up files and folders in the home directory that run code later, outside Crew. */
const HOME_RUNS_LATER = [
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.bash_logout',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.zlogout',
  '.kshrc',
  '.cshrc',
  '.tcshrc',
  '.config/fish',
  '.config/autostart',
  '.config/systemd',
  'Library/LaunchAgents',
  '.gitconfig',
  '.config/git',
  '.claude',
];

/**
 * Why writing this path would change what runs later, or null. Any repository's git folder (its
 * hooks and config), any folder's Claude Code, MCP and editor settings, Crew's data folder except
 * the agents' own worktrees, and the home directory's start-up files.
 */
export function protectedWrite(abs: string, ctx: PathContext): string | null {
  for (const p of forms(abs, ctx)) {
    const why = protectedOne(p, ctx);
    if (why) return why;
  }
  return null;
}

function protectedOne(abs: string, ctx: PathContext): string | null {
  const segs = abs.split('/').filter(Boolean);
  const git = segs.lastIndexOf('.git');
  if (git >= 0) {
    const rest = segs.slice(git + 1);
    if (!rest.length) return "the repository's .git";
    if (rest[0] === 'hooks') return 'git hooks (they run with your credentials)';
    if (rest.length === 1 && (rest[0] === 'config' || rest[0] === 'config.worktree')) return "the repository's git config";
    if (rest[0] === 'worktrees' && rest[2] === 'config.worktree') return "a worktree's git config";
  }
  if (segs.includes('.claude')) return "Claude Code's settings (hooks and permissions run outside Crew's gates)";
  if (segs.at(-1) === '.mcp.json') return "the project's MCP server list";
  if (segs.includes('.vscode') || segs.includes('.idea')) return 'editor settings (editors run tasks from them)';
  if (ctx.crewHome && within(abs, ctx.crewHome) && !(ctx.worktrees && within(abs, ctx.worktrees) && abs !== ctx.worktrees)) return "Crew's own data (settings, bots, projects, routines, skills)";
  for (const rel of HOME_RUNS_LATER) {
    if (within(abs, path.join(ctx.home, rel))) return `${rel === '.claude' ? '~/.claude (Claude Code settings and hooks)' : `~/${rel}`} (runs later, outside Crew)`;
  }
  return null;
}

/** Files that usually hold secrets: an outside-edit note names them but never copies their content. */
const SECRET_FILE =
  /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[\w.-]+)?|[^/]*\.(pem|key|p12|pfx|keystore|jks)|id_(rsa|ed25519|ecdsa|dsa)[^/]*|\.npmrc|\.netrc|\.pypirc|\.git-credentials|[^/]*credentials[^/]*\.json|service-account[^/]*\.json|secrets?\.[\w]+)$/i;

export function secretFile(rel: string): boolean {
  return SECRET_FILE.test(rel);
}
