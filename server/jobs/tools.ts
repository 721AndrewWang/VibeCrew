// The full-duplex tools a bot gets when fullDuplex is on: start, stop, status (ADR 004). The gates
// run here, in code. The same handlers serve the `crew` MCP server and the demo agent.

import type { PermissionLevel } from '../../shared/types';
import { untrusted } from '../untrusted';
import { DEFAULT_TIMEOUT_MIN, startRefusal, timeoutFor } from './gates';
import { type CommandSpec, getJob, isRunning, type JobBase, jobLog, listJobs, outputOf, runningJobs, startCommand, startTask, stopJob, type TaskSpec } from './index';
import { defuse, fmtDuration, jobLine, jobSource, resultText } from './spill';

type Result = { text: string; isError?: boolean };
export type JobHandler = (args: Record<string, unknown>) => Promise<Result>;

const ok = (text: string): Result => ({ text });
const fail = (text: string): Result => ({ text, isError: true });
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** What the tools need from the turn and the bot they serve. */
export interface JobHost {
  chatId: string;
  botId: string;
  /** The bot's permission level now (with the chat's switch). */
  level(): PermissionLevel;
  /** Where jobs run: the chat's folder now. */
  where(): { projectId: string | null; cwd: string };
  /** The turn message calling the tool, if a turn is running. */
  turnMessageId(): string | undefined;
  /**
   * Asks the running turn's gate about a Bash call with this command, exactly as for Bash (deny
   * list, rules, level, an approval card). Returns why it is refused, or null.
   */
  gateCommand(command: string, title: string): Promise<string | null>;
  /** The sandbox options a Bash call of this bot would run under, or undefined (unconfined). */
  commandSpec(command: string): CommandSpec;
  taskSpec(task: string, title: string): TaskSpec;
}

const titleOf = (args: Record<string, unknown>, what: string) => (str(args.title).trim() || what.replace(/\s+/g, ' ').trim()).slice(0, 80);

export function jobTools(host: JobHost): Record<'start' | 'stop' | 'status', JobHandler> {
  const own = (id: unknown) => {
    const j = getJob(str(id).trim());
    return j && j.chatId === host.chatId ? j : undefined;
  };

  return {
    async start(args) {
      const command = str(args.command).trim() || undefined;
      const task = str(args.task).trim() || undefined;
      const timeoutMin = num(args.timeoutMin);
      const refused = startRefusal({ command, task, timeoutMin }, { level: host.level(), running: runningJobs(host.chatId).length, hasProject: !!host.where().projectId });
      if (refused) return fail(refused);
      const title = titleOf(args, command || task || '');
      try {
        if (command) {
          const denied = await host.gateCommand(command, title);
          if (denied) return fail(`Not started. ${denied}`);
          const spec = host.commandSpec(command);
          const base: JobBase = { chatId: host.chatId, botId: host.botId, ...host.where(), title, timeoutMin: timeoutFor(timeoutMin, !!spec.sandbox), startedBy: host.turnMessageId() };
          const j = startCommand(base, spec);
          return ok(
            `Started ${j.id} (${title}) in the background${j.sandboxed ? ', as a sandboxed Bash call (output arrives when it ends)' : ''}; it times out after ${j.timeoutMin} min. Its result will arrive as a new message when it ends. Carry on with other work, or end your turn if there is nothing else to do; do not poll status in a loop.`,
          );
        }
        const base: JobBase = { chatId: host.chatId, botId: host.botId, ...host.where(), title, timeoutMin: timeoutFor(timeoutMin ?? DEFAULT_TIMEOUT_MIN, false), startedBy: host.turnMessageId() };
        const j = startTask(base, host.taskSpec(task!, title));
        return ok(
          `Started ${j.id} (${title}): a background session of you works on it. Its report will arrive as a new message when it ends. Carry on, or end your turn; do not poll status in a loop.`,
        );
      } catch (e) {
        return fail(`Not started: ${(e as Error).message}`);
      }
    },

    async stop(args) {
      const j = own(args.id);
      if (!j) return fail(`No job ${str(args.id) || '(no id)'} in this chat. Use status to list them.`);
      if (!isRunning(j)) return ok(`${j.id} already ended.\n\n${resultText(j, outputOf(j))}`);
      const after = (await stopJob(j.id, 'Stopped by the bot', { quiet: true })) ?? j;
      return ok(`Stopped.\n\n${resultText(after, outputOf(after))}`);
    },

    async status(args) {
      const id = str(args.id).trim();
      if (!id) {
        const list = listJobs(host.chatId).slice(-15);
        if (!list.length) return ok('No background jobs in this chat.');
        return ok(list.map((j) => `- ${jobLine(j)}`).join('\n'));
      }
      const j = own(id);
      if (!j) return fail(`No job ${id} in this chat.`);
      const from = num(args.from);
      const lines = num(args.lines);
      if (from !== undefined || lines !== undefined) {
        const slice = jobLog(j.id, from, lines);
        if (!slice?.total) return ok(`${jobLine(j)}\n(no output yet)`);
        const to = slice.from + slice.lines.length - 1;
        const more = to < slice.total ? `\n(lines ${slice.from}-${to} of ${slice.total}; next: status id=${j.id} from=${to + 1})` : `\n(lines ${slice.from}-${to} of ${slice.total})`;
        return ok(`${jobLine(j)}\n${untrusted(jobSource(j), defuse(slice.lines.join('\n')), { job: j.id, from: String(slice.from) })}${more}`);
      }
      const running = isRunning(j) ? `\n(still running for ${fmtDuration(Date.now() - j.startedAt)}; its result arrives by itself when it ends)` : '';
      return ok(`${resultText(j, outputOf(j))}${running}`);
    },
  };
}
