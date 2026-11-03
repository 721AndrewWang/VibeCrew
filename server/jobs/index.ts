// Background jobs of full-duplex bots (ADR 004): a long command or a sub-task started with
// `start`, which returns at once. Output goes to a log; when the job ends, its result is handed to
// the orchestrator (onJobDone), which delivers it into the bot's session as a new event.

import fs from 'node:fs';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { isJobRunning } from '../../shared/status';
import type { BackgroundJob, JobLog } from '../../shared/types';
import type { AgentSession, TurnHooks } from '../agents/session';
import type { TurnStream } from '../agents/stream';
import { bus } from '../bus';
import { type CleanEnvOptions, DATA } from '../config';
import { redact } from '../hardening/redactor';
import { runLogged } from '../layers/turn';
import { logger } from '../log';
import { jobs, messages, uid } from '../store';
import { MAX_RUNNING } from './gates';
import { reapOrphan } from './orphans';
import { type Run, runDirect, runSandboxed } from './runner';
import { resultText, sliceLines, splitLines } from './spill';

const log = logger('jobs');

/** A job's log stops growing here; the rest of the output is dropped. */
export const LOG_CAP = 5 * 1024 * 1024;
const KEEP_PER_CHAT = 200;
const KEEP_MS = 14 * 86_400_000;

/** What only this process knows about a running job. */
interface Live {
  run?: Run;
  session?: AgentSession;
  stream?: TurnStream;
  timer?: NodeJS.Timeout;
  /** Why it is being stopped (by the bot, the user, a timeout). */
  stopping?: string;
  /** Stopped with the chat (Stop, new topic, deleted): no result is delivered. */
  quiet?: boolean;
  /** A line not yet ended by a newline. */
  partial: string;
}
const live = new Map<string, Live>();

export interface Delivery {
  job: BackgroundJob;
  /** The result as the session reads it. */
  text: string;
  /** Start a turn for the bot (false after a restart: the process that would read it is gone). */
  turn: boolean;
}

let deliver: (d: Delivery) => void = () => {};
/** The orchestrator's way to take a finished job's result into the chat. */
export function onJobDone(fn: (d: Delivery) => void) {
  deliver = fn;
}

const logFile = (id: string) => path.join(DATA.jobLogs, `${id}.log`);

function emit(j: BackgroundJob) {
  jobs.set(j);
  bus.emit({ t: 'job', job: j });
}

export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

export function listJobs(chatId?: string): BackgroundJob[] {
  return jobs
    .all()
    .filter((j) => !chatId || j.chatId === chatId)
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function runningJobs(chatId: string): BackgroundJob[] {
  return listJobs(chatId).filter(isJobRunning);
}

/** A job is running in this project (or workspace): its writes are not edits from outside. */
export function jobsRunningIn(projectId: string): boolean {
  return jobs.all().some((j) => j.projectId === projectId && isJobRunning(j));
}

export interface JobBase {
  chatId: string;
  botId: string;
  projectId: string | null;
  cwd: string;
  title: string;
  timeoutMin: number;
  startedBy?: string;
}

export interface CommandSpec {
  command: string;
  /** The bot's sandbox options; set: the command runs as a sandboxed Bash call. */
  sandbox?: NonNullable<Options['sandbox']>;
  denyRules: string[];
  deniedReason(tool: string, input: unknown): string | null;
  env: Record<string, string>;
  /** How a command Crew runs itself has its environment cleaned: an agent's command runs without the user's credentials (ADR 007). */
  envOptions?: CleanEnvOptions;
  /** The helper session's environment (model endpoint, credentials stripped as for the bot's own session). */
  agentEnv: Record<string, string>;
}

function create(base: JobBase, kind: BackgroundJob['kind'], extra: Partial<BackgroundJob>): BackgroundJob {
  if (runningJobs(base.chatId).length >= MAX_RUNNING) throw new Error(`This chat already has ${MAX_RUNNING} jobs running`);
  const j: BackgroundJob = { id: uid('job_'), kind, status: 'running', sandboxed: false, startedAt: Date.now(), lines: 0, bytes: 0, ...base, ...extra };
  emit(j);
  // A record exists on disk before anything runs, so a crash leaves a job to mark stopped.
  jobs.flush();
  const l: Live = { partial: '' };
  live.set(j.id, l);
  l.timer = setTimeout(() => void stopJob(j.id, `Timed out after ${j.timeoutMin} min`), j.timeoutMin * 60_000);
  l.timer.unref();
  return j;
}

/** Starts a shell command in the background. */
export function startCommand(base: JobBase, spec: CommandSpec): BackgroundJob {
  const j = create(base, 'command', { command: spec.command, sandboxed: !!spec.sandbox });
  j.logFile = logFile(j.id);
  fs.mkdirSync(DATA.jobLogs, { recursive: true });
  fs.writeFileSync(j.logFile, '');
  const l = live.get(j.id)!;
  let pending = false;
  const hooks = {
    onOutput: (text: string) => {
      const cur = jobs.get(j.id);
      if (!cur || cur.truncated) return;
      // The log file, and every result read from it, holds no secret Crew knows (ADR 104).
      let chunk = redact(text);
      if (cur.bytes + chunk.length > LOG_CAP) {
        chunk = `${chunk.slice(0, Math.max(0, LOG_CAP - cur.bytes))}\n[Crew: the log reached ${LOG_CAP / 1024 / 1024} MB; later output was dropped]\n`;
        cur.truncated = true;
      }
      fs.appendFileSync(j.logFile!, chunk);
      cur.bytes += chunk.length;
      const all = l.partial + chunk;
      const nl = all.split('\n').length - 1;
      cur.lines += nl;
      l.partial = all.slice(all.lastIndexOf('\n') + 1);
      // Live counts for the UI, at most twice a second.
      if (!pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          const now = jobs.get(j.id);
          if (now && isJobRunning(now)) emit(now);
        }, 500).unref();
      }
    },
    onExit: (r: { exitCode: number | null; signal: string | null; error?: string }) => {
      const cur = jobs.get(j.id);
      if (!cur) return;
      if (l.partial) cur.lines++;
      cur.exitCode = r.exitCode;
      cur.signal = r.signal;
      const failed = r.error || (r.exitCode !== 0 && !l.stopping);
      finish(cur, l.stopping ? 'stopped' : failed ? 'failed' : 'done', l.stopping || r.error || (failed && r.exitCode !== null ? `Exit code ${r.exitCode}` : undefined));
    },
  };
  l.run = spec.sandbox
    ? runSandboxed(
        spec.command,
        { cwd: base.cwd, title: base.title, timeoutMin: base.timeoutMin, sandbox: spec.sandbox, denyRules: spec.denyRules, deniedReason: spec.deniedReason, env: spec.agentEnv },
        hooks,
      )
    : runDirect(spec.command, base.cwd, spec.env, hooks, spec.envOptions);
  if (l.run.pid) {
    // On disk at once: a crash right after this must still find the process to stop (ADR 105).
    const cur = jobs.get(j.id);
    if (cur && isJobRunning(cur)) {
      cur.pid = l.run.pid;
      jobs.set(cur);
      jobs.flush();
    }
  }
  log.info(`${j.id} started in ${base.cwd}${j.sandboxed ? ' (sandboxed)' : ''}: ${spec.command.slice(0, 200)}`);
  return j;
}

export interface TaskSpec {
  task: string;
  /** A new session of the bot for this sub-task (no start/stop tools, no resume); `jobId` is the job it runs. */
  session(jobId: string): AgentSession;
  content: string;
  /** The tool gate: the bot's own, its approval cards in the sub-task's transcript; `jobId` names it in the audit log. */
  hooks(stream: TurnStream, status: (waiting: string | null) => void, jobId: string): Omit<TurnHooks, 'onMessage'>;
}

/** Starts a sub-task: one turn of a background session of the same bot, kept in its own log. */
export function startTask(base: JobBase, spec: TaskSpec): BackgroundJob {
  const j = create(base, 'task', { task: spec.task });
  const l = live.get(j.id)!;
  const status = (waiting: string | null) => {
    const cur = jobs.get(j.id);
    if (!cur || !isJobRunning(cur)) return;
    cur.status = waiting ? 'waiting' : 'running';
    cur.detail = waiting ? `Needs your approval: ${waiting}` : undefined;
    emit(cur);
  };
  void runLogged({
    logId: j.id,
    botId: base.botId,
    cwd: base.cwd,
    trigger: { type: 'job', jobId: j.id },
    session: () => {
      l.session = spec.session(j.id);
      return l.session;
    },
    forgetResume: () => false,
    content: () => spec.content,
    hooks: (stream) => spec.hooks(stream, status, j.id),
    onActivity: (state, detail) => {
      const cur = jobs.get(j.id);
      if (!cur || cur.status === 'waiting') return;
      const d = state === 'tool' && detail ? `Using ${detail}` : undefined;
      if (cur.detail !== d) {
        cur.detail = d;
        emit(cur);
      }
    },
    started: (stream) => {
      l.stream = stream;
      if (l.stopping) stream.stopped = true;
    },
  }).then(({ msg }) => {
    l.session?.close();
    const cur = jobs.get(j.id);
    if (!cur) return;
    cur.costUsd = msg.meta?.costUsd;
    finish(cur, l.stopping || msg.status === 'stopped' ? 'stopped' : msg.status === 'error' ? 'failed' : 'done', l.stopping || (msg.status === 'error' ? msg.error?.split('\n')[0] : undefined));
  });
  return j;
}

/** The output a result shows: a command's log, or a sub-task's report so far. */
export function outputOf(j: BackgroundJob): string[] {
  if (j.kind === 'command') {
    try {
      return splitLines(fs.readFileSync(j.logFile || logFile(j.id), 'utf8'));
    } catch {
      return [];
    }
  }
  const last = messages.sorted(j.id).at(-1);
  return splitLines((last?.text || '').trim());
}

/** Crew is shutting down: jobs are killed but stay "running" on disk, so the next start reports them. */
let shuttingDown = false;

function finish(j: BackgroundJob, status: BackgroundJob['status'], detail?: string) {
  if (!isJobRunning(j) || shuttingDown) return;
  const l = live.get(j.id);
  if (l?.timer) clearTimeout(l.timer);
  live.delete(j.id);
  j.status = status;
  j.detail = detail;
  j.endedAt = Date.now();
  emit(j);
  jobs.flush();
  log.info(`${j.id} ${status}${detail ? `: ${detail}` : ''}`);
  if (l?.quiet) return;
  try {
    deliver({ job: j, text: resultText(j, outputOf(j)), turn: true });
  } catch (e) {
    log.error('delivering a job result failed', e);
  }
}

/** Stops a running job; its result is still delivered (unless quiet). Resolves once it has ended. */
export async function stopJob(id: string, why: string, opts: { quiet?: boolean } = {}): Promise<BackgroundJob | undefined> {
  const j = jobs.get(id);
  const l = live.get(id);
  if (!j || !isJobRunning(j) || !l) return j;
  l.stopping ??= why;
  if (opts.quiet) l.quiet = true;
  if (l.run) await l.run.stop();
  else {
    if (l.stream) l.stream.stopped = true;
    await l.session?.interrupt();
    // A sub-task that does not wind down is closed.
    const s = l.session;
    setTimeout(() => {
      if (live.has(id)) s?.close();
    }, 5000).unref();
  }
  return jobs.get(id);
}

/** The chat's Stop, "Start new topic", or the chat deleted: every running job stops, nothing is delivered. */
export async function stopChatJobs(chatId: string, why: string) {
  await Promise.all(runningJobs(chatId).map((j) => stopJob(j.id, why, { quiet: true })));
}

/** The chat is deleted: its jobs stop and their records and logs go. */
export async function forgetChatJobs(chatId: string) {
  await stopChatJobs(chatId, 'The chat was deleted');
  for (const j of listJobs(chatId)) removeJob(j);
}

function removeJob(j: BackgroundJob) {
  jobs.delete(j.id);
  if (j.kind === 'command') fs.rmSync(j.logFile || logFile(j.id), { force: true });
  else messages.deleteChat(j.id);
  bus.emit({ t: 'job_deleted', id: j.id });
}

/** On shutdown: kills every running job; the next start marks them stopped and tells their chats. */
export async function stopAllJobs() {
  shuttingDown = true;
  await Promise.all(
    jobs
      .all()
      .filter(isJobRunning)
      .map((j) => stopJob(j.id, 'Crew is shutting down', { quiet: true })),
  );
}

/** A slice of a job's output, 1-based ("read more"). */
export function jobLog(id: string, from?: number, count?: number): JobLog | null {
  const j = jobs.get(id);
  if (!j) return null;
  const all = outputOf(j);
  const s = sliceLines(all, from, count);
  return { job: j, from: s.from, lines: s.lines, total: all.length };
}

/**
 * On start: jobs a restart cut off are marked stopped and their result is posted, without a turn
 * (the session that would read it ended with Crew). Then old records are pruned, and hourly after.
 */
export function recoverJobs() {
  for (const j of jobs.all()) {
    if (!isJobRunning(j)) continue;
    // Its command may outlive Crew (its own process group): stop it, so nothing runs unreported.
    const reaped = reapOrphan(j);
    j.status = 'stopped';
    j.detail = reaped ? 'Crew restarted; its command was still running and was stopped' : 'Crew restarted';
    j.endedAt = Date.now();
    jobs.set(j);
    try {
      deliver({ job: j, text: resultText(j, outputOf(j)), turn: false });
    } catch (e) {
      log.warn('could not report a job a restart cut off:', e);
    }
  }
  sweepJobs();
  setInterval(() => sweepJobs(), 3600_000).unref();
}

export function sweepJobs(now = Date.now()) {
  const byChat = new Map<string, BackgroundJob[]>();
  for (const j of jobs.all()) {
    if (isJobRunning(j)) continue;
    const list = byChat.get(j.chatId) ?? [];
    list.push(j);
    byChat.set(j.chatId, list);
  }
  for (const list of byChat.values()) {
    list.sort((a, b) => b.startedAt - a.startedAt);
    list.forEach((j, i) => {
      if (i >= KEEP_PER_CHAT || now - (j.endedAt ?? j.startedAt) > KEEP_MS) removeJob(j);
    });
  }
}
