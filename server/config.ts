import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json';
import { migrate } from './migrations';

export const APP_VERSION: string = pkg.version;
export const APP_NAME = 'Crew';
/** Demo mode: scripted bots instead of a model (CREW_FAKE_AGENT=1). */
export const FAKE_AGENT = process.env.CREW_FAKE_AGENT === '1';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');
export const INJECT_SCRIPT = path.join(ROOT_DIR, 'server', 'inject', 'preview-inject.js');

export const HOME_DIR = path.resolve(process.env.CREW_HOME || path.join(os.homedir(), '.crew'));
migrateFromVibeCrew();
export const DATA = {
  settings: path.join(HOME_DIR, 'settings.json'),
  bots: path.join(HOME_DIR, 'bots.json'),
  chats: path.join(HOME_DIR, 'chats.json'),
  projects: path.join(HOME_DIR, 'projects.json'),
  routines: path.join(HOME_DIR, 'routines.json'),
  messages: path.join(HOME_DIR, 'messages'),
  skills: path.join(HOME_DIR, 'skills'),
  uploads: path.join(HOME_DIR, 'uploads'),
  turns: path.join(HOME_DIR, 'turns'),
  memory: path.join(HOME_DIR, 'memory'),
  /** Git worktrees of chats that work in an isolated workspace. */
  worktrees: path.join(HOME_DIR, 'worktrees'),
  /** Proposed changes to bots and what the user decided (the improvement ledger). */
  improvements: path.join(HOME_DIR, 'improvements.json'),
  /** Shadow routing decisions. */
  routing: path.join(HOME_DIR, 'routing.json'),
};

for (const dir of [HOME_DIR, DATA.messages, DATA.skills, DATA.uploads, DATA.turns, DATA.memory, DATA.worktrees]) {
  fs.mkdirSync(dir, { recursive: true });
}
// Before any store reads its file. A folder written by a newer Crew stops the start here.
for (const m of migrate(HOME_DIR)) console.warn(`[migrate] ${m.title} (schema ${m.version})`);

export const DEFAULT_PROJECTS_ROOT = path.resolve(process.env.CREW_PROJECTS || path.join(os.homedir(), 'CrewProjects'));

/**
 * Variables that describe the Claude Code session Crew itself may have been launched from.
 * Passing them on would make the bots' Claude Code processes think they are nested sessions.
 */
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PREVIEW_.*|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE)$/;
/** Set by the desktop app (Electron runs the server as plain Node) and the AppImage runtime. */
const DESKTOP_VARS = /^(ELECTRON_.*|CHROME_DESKTOP|APPIMAGE|APPDIR|OWD|ARGV0)$/;
const KEEP_CLAUDE_CODE_VARS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_GIT_BASH_PATH',
]);

/** process.env without the variables of an enclosing Claude Code session. */
export function cleanEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (SESSION_VARS.test(k) || DESKTOP_VARS.test(k)) continue;
    if (k.startsWith('CLAUDE_CODE_') && !KEEP_CLAUDE_CODE_VARS.has(k)) continue;
    if (k.startsWith('CREW_')) continue;
    out[k] = v;
  }
  // The desktop app runs this server without the user's NODE_OPTIONS; programs we start get them back.
  if (process.env.CREW_USER_NODE_OPTIONS && out.NODE_OPTIONS === undefined) out.NODE_OPTIONS = process.env.CREW_USER_NODE_OPTIONS;
  // Paths the AppImage launcher prepended (its bundled libraries break system programs).
  for (const k of ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']) {
    if (!out[k]) continue;
    const v = out[k]
      .split(':')
      .filter((p) => p && !p.includes('/.mount_'))
      .join(':');
    if (v) out[k] = v;
    else delete out[k];
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

/** Where `claude` was found (often a symlink the native installer repoints on each update). */
let claudeCandidate: string | undefined;

function resolveExecutable(candidate: string): string | null {
  try {
    const real = fs.realpathSync(candidate);
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/**
 * Locates the Claude Code CLI the bots run on. The candidate is re-resolved on every call, so an
 * auto-update that repoints the symlink (and deletes the old version) is followed; a miss is
 * never cached, so a later install is found.
 */
export function findClaudeExecutable(refresh = false): string | null {
  if (claudeCandidate && !refresh) {
    const real = resolveExecutable(claudeCandidate);
    if (real) return real;
  }
  const candidates = [process.env.CREW_CLAUDE_PATH, process.env.CLAUDE_PATH].filter(Boolean) as string[];
  try {
    const found = execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (found) candidates.push(found);
  } catch {
    /* not on PATH */
  }
  candidates.push(path.join(os.homedir(), '.local', 'bin', 'claude'), path.join(os.homedir(), '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  for (const c of candidates) {
    const real = resolveExecutable(c);
    if (real) {
      claudeCandidate = c;
      return real;
    }
  }
  claudeCandidate = undefined;
  return null;
}

let chromePath: string | undefined;

/**
 * Locates a Chrome/Chromium binary for headless screenshots and browser tests. The cached path is
 * checked again on every call: Playwright deletes old ms-playwright/chromium-NNNN builds on upgrade.
 */
export function findChrome(): string | null {
  if (chromePath) {
    try {
      fs.accessSync(chromePath, fs.constants.X_OK);
      return chromePath;
    } catch {
      chromePath = undefined;
    }
  }
  const home = os.homedir();
  const candidates = [
    process.env.CREW_CHROME_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean) as string[];
  try {
    const pw = path.join(home, '.cache', 'ms-playwright');
    for (const d of fs
      .readdirSync(pw)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse()) {
      candidates.push(path.join(pw, d, 'chrome-linux64', 'chrome'), path.join(pw, d, 'chrome-linux', 'chrome'));
    }
  } catch {
    /* no playwright cache */
  }
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      chromePath = c;
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

export function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) return i.address;
    }
  }
  return null;
}

/**
 * Crew used to be called VibeCrew. On the first start after the rename its data folder
 * (~/.vibecrew) and default projects folder (~/VibeCrewProjects) move to the new names, and the
 * saved paths follow. Folders given through CREW_HOME / CREW_PROJECTS are left alone.
 */
function migrateFromVibeCrew() {
  if (process.env.CREW_HOME) return;
  const home = os.homedir();
  const move = (from: string, to: string) => {
    try {
      if (fs.existsSync(to) || !fs.lstatSync(from).isDirectory()) return false;
      fs.renameSync(from, to);
      return true;
    } catch {
      return false;
    }
  };
  move(path.join(home, '.vibecrew'), HOME_DIR);
  if (process.env.CREW_PROJECTS) return;
  const oldRoot = path.join(home, 'VibeCrewProjects');
  const newRoot = path.join(home, 'CrewProjects');
  if (!move(oldRoot, newRoot)) return;
  // The projects folder moved: settings.json and projects.json keep absolute paths.
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  for (const name of ['settings.json', 'projects.json']) {
    const file = path.join(HOME_DIR, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes(esc(oldRoot))) fs.writeFileSync(file, text.split(esc(oldRoot)).join(esc(newRoot)));
    } catch {
      /* not there yet */
    }
  }
}
