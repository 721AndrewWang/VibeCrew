// How a background command runs (ADR 004). Without the sandbox, Crew runs it itself with the
// dev server's process handling (procs.ts). With the sandbox on, it runs as a real Bash call in a
// helper Claude Code session that has only the Bash tool and the bot's sandbox options, so it is
// confined exactly as a Bash call would be; the helper may make that one call and nothing else.

import type { ChildProcess } from 'node:child_process';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { BotSession } from '../agents/session';
import { botModel } from '../claudeAuth';
import { logger } from '../log';
import { ANSI, killGroup, spawnGroup } from '../procs';
import { SANDBOX_TIMEOUT_MIN } from './gates';

const log = logger('jobs');

export interface Run {
  /** Ends the run; it still reports through onExit. */
  stop(): Promise<void>;
}

export interface RunHooks {
  onOutput(text: string): void;
  onExit(r: { exitCode: number | null; signal: string | null; error?: string }): void;
}

/** Plain text of a chunk of terminal output: no colour codes, no carriage-return redraws. */
export function plain(chunk: string): string {
  return chunk.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
}

/** Runs the command in its own process group in `cwd`; output streams as it comes. */
export function runDirect(command: string, cwd: string, env: Record<string, string>, hooks: RunHooks): Run {
  let child: ChildProcess;
  try {
    child = spawnGroup(command, cwd, env);
  } catch (e) {
    queueMicrotask(() => hooks.onExit({ exitCode: null, signal: null, error: (e as Error).message }));
    return { stop: async () => {} };
  }
  let ended = false;
  const end = (r: Parameters<RunHooks['onExit']>[0]) => {
    if (ended) return;
    ended = true;
    hooks.onExit(r);
  };
  const onData = (b: Buffer) => hooks.onOutput(plain(b.toString('utf8')));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  // 'close' (not 'exit') so the last output is read before the result is built.
  child.on('close', (code, signal) => end({ exitCode: code, signal }));
  child.on('error', (e) => end({ exitCode: null, signal: null, error: e.message }));
  return { stop: () => killGroup(child) };
}

export const HELPER_SYSTEM = 'You run one shell command for Crew. Call the Bash tool exactly once with the command you are given, then reply with the single word: done.';

/**
 * The input the helper's one Bash call is rewritten to, whatever the model wrote: the approved
 * command, in the foreground, with the job's timeout (at most what Bash allows).
 */
export function helperBashInput(command: string, title: string, timeoutMin: number): Record<string, unknown> {
  return { command, description: title.slice(0, 80), timeout: Math.min(timeoutMin, SANDBOX_TIMEOUT_MIN) * 60_000 };
}

/** The text of a tool result block (a string, or a list of text blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('\n');
  return '';
}

/**
 * Runs the command as a Bash call inside Claude Code's sandbox. The helper session gets nothing
 * but the Bash tool, the sandbox and the deny list; its permission hook allows one Bash call, with
 * the input rewritten to the approved command. Output arrives when the call ends.
 */
export function runSandboxed(
  command: string,
  opts: {
    cwd: string;
    title: string;
    timeoutMin: number;
    sandbox: NonNullable<Options['sandbox']>;
    denyRules: string[];
    deniedReason(tool: string, input: unknown): string | null;
    env: Record<string, string>;
  },
  hooks: RunHooks,
): Run {
  let used = false;
  let isError = false;
  let got = false;
  const session = new BotSession(
    {
      cwd: opts.cwd,
      model: botModel('haiku'),
      systemAppend: '',
      systemPrompt: HELPER_SYSTEM,
      tools: ['Bash'],
      permissionMode: 'default',
      allowRules: [],
      askRules: [],
      denyRules: opts.denyRules,
      deniedReason: opts.deniedReason,
      sandbox: opts.sandbox,
      mcpServers: {},
      settingSources: [],
      env: opts.env,
    },
    () => {},
  );
  let ended = false;
  const end = (r: Parameters<RunHooks['onExit']>[0]) => {
    if (ended) return;
    ended = true;
    hooks.onExit(r);
    session.close();
  };
  session
    .run(`Run this command with the Bash tool:\n\n${command}`, {
      beforeEdit: () => {},
      canUseTool: async (name) => {
        if (name !== 'Bash' || used) return { behavior: 'deny', message: 'Only one Bash call is allowed.' };
        used = true;
        return { behavior: 'allow', updatedInput: helperBashInput(command, opts.title, opts.timeoutMin) };
      },
      onMessage: (m: SDKMessage) => {
        if (m.type !== 'user' || got) return;
        const content = m.message?.content;
        if (!Array.isArray(content)) return;
        for (const c of content) {
          if (c.type !== 'tool_result') continue;
          got = true;
          isError = !!c.is_error;
          hooks.onOutput(plain(resultText(c.content)));
        }
      },
    })
    .then(
      () => end(got ? { exitCode: isError ? 1 : 0, signal: null } : { exitCode: null, signal: null, error: 'The sandboxed command did not run' }),
      (e) => end({ exitCode: null, signal: null, error: (e as Error).message }),
    );
  return {
    stop: async () => {
      await session.interrupt();
      setTimeout(() => {
        if (!ended) {
          log.warn('sandboxed helper did not stop; closing it');
          end({ exitCode: null, signal: 'SIGTERM' });
        }
      }, 3000).unref();
    },
  };
}
