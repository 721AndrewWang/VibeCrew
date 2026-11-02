import { spawn } from 'node:child_process';
import type { Chat, Project } from '../../shared/types';
import { cleanEnv } from '../config';
import { holdTurns, systemMessage } from '../orchestrator';
import { chats } from '../store';

const SETUP_TIMEOUT_MS = 15 * 60_000;

export interface SetupResult {
  ok: boolean;
  secs: number;
  /** How it failed: "timed out" or "exit code N". */
  how: string;
  /** The last lines of its output, without colour codes. */
  out: string;
}

/** Runs a project's setup command (installing dependencies, say) in a fresh workspace folder. */
export function runSetup(cwd: string, command: string): Promise<SetupResult> {
  const started = Date.now();
  return new Promise<SetupResult>((resolve) => {
    let tail = '';
    const keep = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-4000);
    };
    const child = spawn('bash', ['-c', command], { cwd, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, SETUP_TIMEOUT_MS);
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = tail
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .trim()
        .split('\n')
        .slice(-15)
        .join('\n');
      resolve({ ok: code === 0, secs: Math.round((Date.now() - started) / 1000), how: signal === 'SIGKILL' ? 'timed out' : `exit code ${code}`, out });
    };
    child.on('error', (e) => {
      tail += `\n${e.message}`;
      finish(1, null);
    });
    child.on('close', finish);
  });
}

/**
 * Runs the project's setup command in a new chat workspace. The chat's bots wait for it: messages
 * sent meanwhile are queued.
 */
export function prepareWorkspace(chat: Chat, ws: Project, command: string) {
  systemMessage(chat, `Preparing the workspace: ${command}`, { uiOnly: true });
  const work = runSetup(ws.path, command).then((r) => {
    const c = chats.get(chat.id);
    if (c && r.ok) systemMessage(c, `The workspace is ready (${r.secs}s).`, { uiOnly: true });
    else if (c) {
      systemMessage(c, `The workspace setup command didn't succeed (${r.how}, ${r.secs}s), so some dependencies may be missing.\n\`\`\`\n${r.out || '(no output)'}\n\`\`\``);
    }
  });
  holdTurns(chat.id, work);
}
