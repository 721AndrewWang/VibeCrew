// The sandbox's half of ADR 104: the guard reads command text, bubblewrap confines what actually
// runs (scripts included). When the sandbox is on, a session's options also deny reading every
// credential store, deny writing the files that decide what runs later, and unset the model
// connection's variables for commands, so not even the broker's or the gateway's token reaches one.

import fs from 'node:fs';
import path from 'node:path';

/** Variables a command never needs: Claude Code keeps them for itself. */
export const MODEL_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

/** Shell start-up files in the home folder (run later, outside Crew). */
const HOME_STARTUP = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.gitconfig'];

export interface PolicyInput {
  home: string;
  /** Crew's data folder, and the folder of its settings file. */
  crewHome: string;
  settingsFile: string;
  /** Where chat workspaces and Workers' worktrees live. */
  worktrees: string;
  /** Credential stores relative to home (the guard's CREDENTIAL_PATHS). */
  credentialPaths: string[];
  /** The session's folder. */
  cwd?: string;
  /** The session repository's shared git folder (a worktree's main .git), when known. */
  gitCommonDir?: string;
}

export interface SandboxHardening {
  filesystem: { denyRead: string[]; denyWrite: string[] };
  credentials: { envVars: { name: string; mode: 'deny' }[] };
}

/** The filesystem and credential rules for a session's sandbox. Pure. */
export function sandboxHardening(p: PolicyInput): SandboxHardening {
  const denyRead = [...p.credentialPaths.map((rel) => path.join(p.home, rel)), p.settingsFile];
  const denyWrite = new Set<string>();
  // Crew's data: every file and folder in it but the worktrees.
  for (const name of crewEntries(p.crewHome)) {
    const abs = path.join(p.crewHome, name);
    if (abs !== p.worktrees) denyWrite.add(abs);
  }
  for (const f of HOME_STARTUP) denyWrite.add(path.join(p.home, f));
  denyWrite.add(path.join(p.home, '.claude'));
  denyWrite.add(path.join(p.home, '.config', 'git'));
  if (p.cwd) {
    for (const rel of ['.claude', '.mcp.json', '.vscode', '.idea', path.join('.git', 'hooks'), path.join('.git', 'config')]) denyWrite.add(path.join(p.cwd, rel));
  }
  if (p.gitCommonDir) {
    denyWrite.add(path.join(p.gitCommonDir, 'hooks'));
    denyWrite.add(path.join(p.gitCommonDir, 'config'));
  }
  return { filesystem: { denyRead: [...new Set(denyRead)], denyWrite: [...denyWrite] }, credentials: { envVars: MODEL_VARS.map((name) => ({ name, mode: 'deny' as const })) } };
}

/** What sits in Crew's data folder now, plus what it will hold (so a file made later is covered too). */
function crewEntries(crewHome: string): string[] {
  const known = [
    'settings.json',
    'bots.json',
    'chats.json',
    'projects.json',
    'routines.json',
    'messages',
    'skills',
    'uploads',
    'turns',
    'memory',
    'triggers',
    'workers.json',
    'jobs',
    'watchdog',
    'gateway',
    'drafts.json',
    'audit.jsonl',
    'improvements.json',
    'routing.json',
    'friction.jsonl',
    'backups',
    'logs',
  ];
  let present: string[] = [];
  try {
    present = fs.readdirSync(crewHome);
  } catch {
    /* not there yet */
  }
  return [...new Set([...known, ...present])];
}

/** The shared git folder of the repository at `cwd` (a worktree's main .git), or undefined. */
export function gitCommonDir(cwd: string): string | undefined {
  const dotGit = path.join(cwd, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    // A worktree: ".git" is a file "gitdir: <main>/.git/worktrees/<name>", whose commondir points back.
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    if (!gitdir) return undefined;
    const abs = path.resolve(cwd, gitdir);
    const common = fs.readFileSync(path.join(abs, 'commondir'), 'utf8').trim();
    return path.resolve(abs, common);
  } catch {
    return undefined;
  }
}
