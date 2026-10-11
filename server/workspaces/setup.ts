import { spawn } from 'node:child_process';
import type { Chat, Project } from '../../shared/types';
import { cleanEnv } from '../config';
import { holdTurns, systemMessage } from '../orchestrator';
import { chats } from '../store';

const SETUP_TIMEOUT_MS = 15 * 60_000;

/**
 * Runs the project's setup command (installing dependencies, say) in a new workspace. The chat's
 * bots wait for it: messages sent meanwhile are queued.
 */
export function prepareWorkspace(chat: Chat, ws: Project, command: string) {
  systemMessage(chat, `Preparing the workspace: ${command}`, { uiOnly: true });
  const started = Date.now();
  const work = new Promise<void>((resolve) => {
    let tail = '';
    const keep = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-4000);
    };
    const child = spawn('bash', ['-c', command], { cwd: ws.path, env: cleanEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, SETUP_TIMEOUT_MS);
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const secs = Math.round((Date.now() - started) / 1000);
      const c = chats.get(chat.id);
      if (c && code === 0) systemMessage(c, `The workspace is ready (${secs}s).`, { uiOnly: true });
      else if (c) {
        const out = tail
          .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
          .trim()
          .split('\n')
          .slice(-15)
          .join('\n');
        systemMessage(
          c,
          `The workspace setup command didn't succeed (${signal === 'SIGKILL' ? 'timed out' : `exit code ${code}`}, ${secs}s), so some dependencies may be missing.\n\`\`\`\n${out || '(no output)'}\n\`\`\``,
        );
      }
      resolve();
    };
    child.on('error', (e) => {
      tail += `\n${e.message}`;
      finish(1, null);
    });
    child.on('close', finish);
  });
  holdTurns(chat.id, work);
}
