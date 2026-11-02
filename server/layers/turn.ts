// One turn of a Router or a Worker, kept as a ChatMessage in its own log (the Router's `rt_<chat>`,
// a Worker's `wk_…`) instead of in the chat: the same streaming, saving, tracing and cost
// accounting as a bot turn in a chat, so the transcript dialog, approval cards and Trace just work.

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ChatMessage, MessageTrigger } from '../../shared/types';
import type { AgentSession, TurnHooks } from '../agents/session';
import { TurnStream } from '../agents/stream';
import { bus } from '../bus';
import { messages, uid } from '../store';
import { shareOfTurn, usageOf } from '../usage';

const PROGRESS_SAVE_MS = 3000;

type UserContent = SDKUserMessage['message']['content'];

/** The next sequence number in a log. */
export function nextSeq(logId: string): number {
  return (messages.sorted(logId).at(-1)?.seq ?? 0) + 1;
}

export interface LoggedTurn {
  logId: string;
  botId: string;
  /** The session's working directory: where Claude Code keeps its transcript, for Trace. */
  cwd: string;
  trigger: MessageTrigger;
  /** The event ids a Router turn handles. */
  batch?: string[];
  /** The live session, or a new one. */
  session(): AgentSession;
  /** The session's resume id failed: forget it, so session() starts a new conversation. */
  forgetResume(): boolean;
  /** The prompt; `msg` is the turn's message, for what the prompt measured (meta.injected). */
  content(session: AgentSession, msg: ChatMessage): UserContent | Promise<UserContent>;
  hooks(stream: TurnStream): Omit<TurnHooks, 'onMessage'>;
  onActivity(state: 'thinking' | 'tool', detail?: string): void;
  /** The turn is under way: where to stop it. */
  started?(stream: TurnStream, session: AgentSession): void;
}

/** Runs one turn and returns its finished message (done, error or stopped) and the session it ran in. */
export async function runLogged(t: LoggedTurn): Promise<{ msg: ChatMessage; session: AgentSession | null }> {
  const msg: ChatMessage = {
    id: uid('m_'),
    chatId: t.logId,
    seq: nextSeq(t.logId),
    ts: Date.now(),
    role: 'bot',
    botId: t.botId,
    text: '',
    parts: [],
    status: 'streaming',
    trigger: t.trigger,
    turnId: uid('t_'),
    batch: t.batch,
  };
  // Saved at once, so a restart mid-turn leaves a "stopped" turn rather than a gap.
  messages.put(msg);
  bus.emit({ t: 'msg', msg });

  let timer: NodeJS.Timeout | null = null;
  const progress = () => {
    timer ??= setTimeout(() => {
      timer = null;
      messages.put(msg);
    }, PROGRESS_SAVE_MS);
  };
  const stream = new TurnStream(msg, (state, detail) => t.onActivity(state, detail), progress);
  const hooks = { ...t.hooks(stream), onMessage: (m: Parameters<TurnStream['handle']>[0]) => stream.handle(m) };

  let session: AgentSession | null = null;
  try {
    session = t.session();
    t.started?.(stream, session);
    let result: Awaited<ReturnType<AgentSession['run']>>;
    try {
      result = await session.run(await t.content(session, msg), hooks);
    } catch (e) {
      // A stale resume id fails before anything streams: start a fresh session once.
      const resumeFailed = !stream.parts.length && !stream.stopped && /conversation|session|resume/i.test(String((e as Error)?.message));
      if (!resumeFailed || !t.forgetResume()) throw e;
      session = t.session();
      t.started?.(stream, session);
      result = await session.run(await t.content(session, msg), hooks);
    }
    stream.finish(result);
    const sid = session.sessionId;
    if (sid && !sid.startsWith('fake-')) msg.meta = { ...msg.meta, trace: { sessionId: sid, cwd: t.cwd, from: msg.ts, to: Date.now() } };
    if (sid) msg.meta = { ...msg.meta, sessionId: sid };
    shareOfTurn(msg);
  } catch (e) {
    stream.fail(e);
    session?.close();
    session = null;
  } finally {
    if (timer) clearTimeout(timer);
  }
  msg.text = stream.finalText();
  messages.put(msg);
  bus.emit({ t: 'msg', msg });
  bus.emit({ t: 'usage', usage: usageOf() });
  return { msg, session };
}
