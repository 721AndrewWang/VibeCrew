// The scripted model (ADR 101): one pure function from a request to the next step, in the mock
// provider's Reply shape. It reads only what the request holds (the system prompt says which agent
// it is; the conversation says what happened), the way a model would, so it can run in process or
// behind the mock provider over HTTP and give the same answers.
//
// It is deliberately plain: it measures scheduling, not judgement. Each agent's choices are
// listed in ADR 101.

import { WORKER_ACTIVE } from '../../shared/workers';
import type { Block, Message, ModelRequest, Policy, Reply } from './model';
import { DELEGATE_MARK, FILTER_MARK, LEAD_MARK, SPECULATIVE_MARK, SUBTASK_MARK, WORKER_MARK } from './prompts';

export const TOOLS = {
  dispatch: 'mcp__crew_router__dispatch_worker',
  message: 'mcp__crew_router__message_worker',
  stopWorker: 'mcp__crew_router__stop_worker',
  listWorkers: 'mcp__crew_router__list_workers',
  reply: 'mcp__crew_router__reply',
  work: 'mcp__bench__work',
  start: 'mcp__crew__start',
  stop: 'mcp__crew__stop',
  status: 'mcp__crew__status',
  handBack: 'mcp__crew__hand_back',
  unsubscribe: 'mcp__crew__unsubscribe_thread',
  claim: 'mcp__crew__speculative_result',
} as const;

/** "T07 is complete": what the work tool says when a task has nothing left. */
export const COMPLETE = /\b(T\d+) is complete\b/;

// ---------------------------------------------------------------- reading a conversation

/** The index of the current turn's prompt: the last user message that is not a tool result. */
export function turnStart(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'))) return i;
  }
  return 0;
}

const textOf = (m: Message | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? b.content : '')).join('\n');

const blocks = (m: Message): Block[] => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content);

interface Call {
  name: string;
  input: Record<string, unknown>;
  result?: string;
  error?: boolean;
}

/** The tool calls in messages[from..], each with its result. */
export function callsSince(messages: Message[], from: number): Call[] {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  for (const m of messages.slice(from)) {
    for (const b of blocks(m)) {
      if (b.type === 'tool_use') {
        const c: Call = { name: b.name, input: b.input };
        calls.push(c);
        byId.set(b.id, c);
      } else if (b.type === 'tool_result') {
        const c = byId.get(b.tool_use_id);
        if (c) {
          c.result = b.content;
          c.error = !!b.is_error;
        }
      }
    }
  }
  return calls;
}

/** A tool_use id no other block in the conversation has. */
function nextId(messages: Message[]): string {
  let n = 0;
  for (const m of messages) for (const b of blocks(m)) if (b.type === 'tool_use') n++;
  return `toolu_bench_${n + 1}`;
}

const tool = (req: ModelRequest, name: string, input: Record<string, unknown>): Reply => ({ tool: { id: nextId(req.messages), name, input } });

// ---------------------------------------------------------------- the user's messages

export type Intent = { kind: 'request'; task: string } | { kind: 'follow-up'; task: string } | { kind: 'stop'; task: string } | { kind: 'chatter' };

export function intentOf(text: string): Intent {
  const t = text.trim();
  let m = /^Please build .*\(task (T\d+)\)/.exec(t);
  if (m) return { kind: 'request', task: m[1] };
  m = /^For (T\d+):/.exec(t);
  if (m) return { kind: 'follow-up', task: m[1] };
  m = /^Stop (T\d+)\b/.exec(t);
  if (m) return { kind: 'stop', task: m[1] };
  return { kind: 'chatter' };
}

// ---------------------------------------------------------------- the queue, restated in every reply

export interface QueueItem {
  task: string;
  /** The messages its work comes from: the request and any follow-ups. */
  ids: string[];
}

export function queueText(q: QueueItem[]): string {
  return q.length ? `Queued: ${q.map((i) => `${i.task} [${i.ids.join(' ')}]`).join(', ')}.` : '';
}

export function parseQueue(text: string): QueueItem[] | null {
  const m = /Queued: ([^\n]*?)\.(\s|$)/.exec(text);
  if (!m) return null;
  return [...m[1].matchAll(/(T\d+) \[([^\]]*)\]/g)].map((x) => ({ task: x[1], ids: x[2].split(/\s+/).filter(Boolean) }));
}

/**
 * The queue as the session last stated it before messages[before]: its latest reply (a `reply`
 * call, or a final text for a classic lead), else the latest line of its own in a recap.
 */
export function queueBefore(messages: Message[], before: number, replyTool?: string): QueueItem[] {
  for (let i = before - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (const b of [...blocks(m)].reverse()) {
      if (replyTool && b.type === 'tool_use' && b.name === replyTool) return parseQueue(String(b.input.text ?? '')) ?? [];
      if (!replyTool && b.type === 'text') return parseQueue(b.text) ?? [];
    }
  }
  const recap = textOf(messages[0]);
  const mine = recap.split('\n').filter((l) => /^\[You · #\d+\]/.test(l));
  return mine.length ? (parseQueue(mine[mine.length - 1]) ?? []) : [];
}

function addToQueue(q: QueueItem[], task: string, id: string) {
  const item = q.find((i) => i.task === task);
  if (item) {
    if (!item.ids.includes(id)) item.ids.push(id);
  } else q.push({ task, ids: [id] });
}

const briefOf = (item: QueueItem, texts: Map<string, string>) =>
  `${item.task}: ${item.ids.map((id) => texts.get(id) || `as the user asked in ${id}`).join(' ')} (from ${item.ids.join(', ')}). Done means it works and is checked.`;

function list(tasks: string[]): string {
  return tasks.length <= 1 ? tasks.join('') : `${tasks.slice(0, -1).join(', ')} and ${tasks[tasks.length - 1]}`;
}

// ---------------------------------------------------------------- Router

interface RouterEventSeen {
  id: string;
  kind: string;
  text: string;
  title?: string;
  status?: string;
  source?: string;
}

export function parseWorkers(batch: string): Map<string, { id: string; status: string }> {
  const out = new Map<string, { id: string; status: string }>();
  const section = /<workers>\n([\s\S]*?)\n<\/workers>/.exec(batch)?.[1] || '';
  for (const l of section.split('\n')) {
    const m = /^(wk_\w+) · [^·]+ · (\w+) · "(T\d+)/.exec(l);
    // The latest Worker for a task wins: a stopped task's Worker stays listed.
    if (m) out.set(m[3], { id: m[1], status: m[2] });
  }
  return out;
}

export function parseEvents(batch: string): RouterEventSeen[] {
  return [...batch.matchAll(/<event id="([^"]+)" kind="(\w+)"([^>]*)>\n([\s\S]*?)\n<\/event>/g)].map((m) => ({
    id: m[1],
    kind: m[2],
    text: m[4],
    title: /title="([^"]*)"/.exec(m[3])?.[1],
    status: /status="(\w+)"/.exec(m[3])?.[1],
    source: /source="([^"]*)"/.exec(m[3])?.[1],
  }));
}

function routerPolicy(req: ModelRequest): Reply {
  const max = Number(/at most (\d+) Workers at once/.exec(req.system)?.[1] ?? 3);
  const start = turnStart(req.messages);
  const batch = textOf(req.messages[start]);
  const workers = parseWorkers(batch);
  const events = parseEvents(batch);
  const done = callsSince(req.messages, start + 1);

  // The plan, from what the turn started with.
  const queue = queueBefore(req.messages, start, TOOLS.reply).filter((i) => !workers.has(i.task));
  const texts = new Map<string, string>();
  const actions: { name: string; input: Record<string, unknown>; task: string }[] = [];
  const ack = { stopped: [] as string[], followed: [] as string[], finished: [] as string[], halted: [] as string[], fixes: [] as string[], relayed: [] as string[], heard: false };
  // With channel norms (ADR 103) the system prompt says a Worker's report goes under Details; a Router
  // without them relays what the report says.
  const norms = req.system.includes('under Details');
  let active = [...workers.values()].filter((w) => WORKER_ACTIVE.has(w.status)).length;
  const resumed = new Set<string>();
  for (const e of events) {
    if (e.kind === 'worker') {
      const task = /^(T\d+)/.exec(e.title || '')?.[1];
      if (task) (e.status === 'done' ? ack.finished : ack.halted).push(task);
      if (task && !norms) ack.relayed.push(`${task}: ${e.text.split('\n')[0].trim()}`);
      continue;
    }
    // A verified speculative fix (ADR 008) waits for the user's merge: worth an acceptance reply (ADR 011).
    if (e.kind === 'environment' && e.source === 'speculative') {
      const task = /\b(T\d+)\b/.exec(e.text)?.[1];
      if (task) ack.fixes.push(task);
      continue;
    }
    if (e.kind !== 'user') continue;
    ack.heard = true;
    const text = e.text.trim();
    const intent = intentOf(text);
    if (intent.kind === 'chatter') continue;
    const w = workers.get(intent.task);
    if (intent.kind === 'request') {
      texts.set(e.id, text);
      if (!w) addToQueue(queue, intent.task, e.id);
    } else if (intent.kind === 'follow-up') {
      texts.set(e.id, text);
      if (w && w.status !== 'stopped') {
        actions.push({ name: TOOLS.message, input: { id: w.id, text: `${text} (${e.id})` }, task: intent.task });
        ack.followed.push(intent.task);
        if (!WORKER_ACTIVE.has(w.status) && !resumed.has(w.id)) {
          resumed.add(w.id);
          active++;
        }
      } else if (queue.some((i) => i.task === intent.task)) addToQueue(queue, intent.task, e.id);
    } else {
      const i = queue.findIndex((x) => x.task === intent.task);
      if (i >= 0) queue.splice(i, 1);
      if (w && (WORKER_ACTIVE.has(w.status) || resumed.has(w.id))) {
        actions.unshift({ name: TOOLS.stopWorker, input: { id: w.id }, task: intent.task });
        active--;
      }
      ack.stopped.push(intent.task);
    }
  }
  const dispatched: QueueItem[] = [];
  while (queue.length && active < max) {
    const item = queue.shift()!;
    dispatched.push(item);
    actions.push({ name: TOOLS.dispatch, input: { title: `${item.task}: ${(texts.get(item.ids[0]) || 'the requested task').slice(0, 60)}`, task: briefOf(item, texts) }, task: item.task });
    active++;
  }

  if (done.length < actions.length) {
    const a = actions[done.length];
    return tool(req, a.name, a.input);
  }
  const needsReply = ack.heard || ack.finished.length > 0 || ack.halted.length > 0 || ack.fixes.length > 0;
  if (needsReply && done.length === actions.length) {
    // A refused dispatch goes back to the head of the queue.
    // Dispatches are the plan's last actions, and calls run in plan order.
    const refused = dispatched.filter((_, i) => done[actions.length - dispatched.length + i]?.error);
    const started = dispatched.filter((d) => !refused.includes(d)).map((d) => d.task);
    const left = [...refused, ...queue];
    const parts = [
      queueText(left),
      started.length ? `Started ${list(started)}.` : '',
      ack.followed.length ? `Passed on the follow-up for ${list([...new Set(ack.followed)])}.` : '',
      ack.stopped.length ? `Stopped ${list(ack.stopped)}.` : '',
      ack.finished.length ? `${list(ack.finished)} ${ack.finished.length === 1 ? 'is' : 'are'} done.` : '',
      ack.halted.length ? `${list(ack.halted)} stopped.` : '',
      ack.fixes.length ? `A verified fix for ${list(ack.fixes)} is ready to merge.` : '',
      ...ack.relayed,
    ].filter(Boolean);
    const kind = ack.finished.length || ack.fixes.length ? 'acceptance' : 'decision';
    return tool(req, TOOLS.reply, norms ? { text: parts.join(' ') || 'Noted.', kind } : { text: parts.join(' ') || 'Noted.' });
  }
  return { text: needsReply ? 'Handled.' : 'Nothing needs the user.' };
}

// ---------------------------------------------------------------- Worker and sub-task

function workerPolicy(req: ModelRequest): Reply {
  const first = textOf(req.messages[0]);
  const task = /\b(T\d+)\b/.exec(first)?.[1] || 'T00';
  const start = turnStart(req.messages);
  const calls = callsSince(req.messages, start + 1);
  const last = calls[calls.length - 1];
  if (last?.name === TOOLS.work && COMPLETE.test(last.result || '')) return { text: `Report: ${task} is done and checked (${calls.length} steps this turn).` };
  if (calls.length > 400) return { text: `Report: gave up on ${task} after ${calls.length} steps.` };
  return tool(req, TOOLS.work, { task });
}

// ---------------------------------------------------------------- the classic lead

interface LeadItem {
  who: string;
  seq?: number;
  text: string;
}

/** The [User · #12] / [System] lines of a prompt or a <new_input> block. */
export function leadItems(text: string): LeadItem[] {
  return [...text.matchAll(/^\[(User|System|You)(?: · #(\d+))?\] (.*)$/gm)].map((m) => ({ who: m[1], seq: m[2] ? Number(m[2]) : undefined, text: m[3] }));
}

/** Items in the order the current turn received them: its prompt, then each <new_input>. */
function turnItems(messages: Message[], start: number): LeadItem[] {
  const prompt = textOf(messages[start]);
  const body = prompt.slice(prompt.indexOf('since you last spoke:'));
  const out = leadItems(body);
  for (const m of messages.slice(start + 1)) {
    if (m.role !== 'user') continue;
    for (const b of blocks(m)) if (b.type === 'text' && b.text.startsWith('<new_input>')) out.push(...leadItems(b.text));
  }
  return out;
}

function neutralLeadPolicy(req: ModelRequest): Reply {
  const start = turnStart(req.messages);
  const items = turnItems(req.messages, start).filter((i) => i.who === 'User');
  const calls = callsSince(req.messages, start + 1);
  const finished = new Set(calls.flatMap((c) => (c.name === TOOLS.work ? [COMPLETE.exec(c.result || '')?.[1]] : [])).filter((t): t is string => !!t));
  const todo: string[] = [];
  for (const i of items) {
    const intent = intentOf(i.text);
    if (intent.kind === 'request' || intent.kind === 'follow-up') {
      if (!todo.includes(intent.task)) todo.push(intent.task);
    } else if (intent.kind === 'stop') {
      const k = todo.indexOf(intent.task);
      // Not started in this turn yet: drop it. Once started, the stop came too late for this turn.
      if (k >= 0 && !calls.some((c) => c.input.task === intent.task)) todo.splice(k, 1);
    }
  }
  const next = todo.find((t) => !finished.has(t));
  if (next) return tool(req, TOOLS.work, { task: next });
  return { text: finished.size ? `Done: ${list([...finished])}.` : 'Noted.' };
}

interface JobSeen {
  id: string;
  task: string;
  running: boolean;
}

/** Jobs as this session can see them: started, listed by status, ended, stopped. */
function jobsSeen(messages: Message[]): Map<string, JobSeen> {
  const jobs = new Map<string, JobSeen>();
  for (const c of callsSince(messages, 0)) {
    if (c.name === TOOLS.start && !c.error) {
      const m = /Started (job_\d+) \(sub-task "(T\d+)/.exec(c.result || '');
      if (m) jobs.set(m[1], { id: m[1], task: m[2], running: true });
    } else if (c.name === TOOLS.status) {
      for (const m of (c.result || '').matchAll(/^(job_\d+) · (T\d+) · (\w+)/gm)) jobs.set(m[1], { id: m[1], task: m[2], running: m[3] === 'running' });
    } else if (c.name === TOOLS.stop) {
      const j = jobs.get(String(c.input.id));
      if (j) j.running = false;
    }
  }
  for (const m of messages) for (const x of textOf(m).matchAll(/Background job (job_\d+) \(sub-task "(T\d+)"\) ended/g)) jobs.set(x[1], { id: x[1], task: x[2], running: false });
  return jobs;
}

function delegateLeadPolicy(req: ModelRequest): Reply {
  const start = turnStart(req.messages);
  const items = turnItems(req.messages, start);
  const calls = callsSince(req.messages, start + 1);
  const jobs = jobsSeen(req.messages);
  const queue = queueBefore(req.messages, start);
  const texts = new Map<string, string>();
  const known = new Set([...jobs.values()].map((j) => j.task));
  const stops: string[] = [];
  const finished: string[] = [];
  let heard = false;
  for (const i of items) {
    const ended = /^Background job job_\d+ \(sub-task "(T\d+)"\) ended: (\w+)/.exec(i.text);
    if (ended) {
      if (ended[2] === 'done') finished.push(ended[1]);
      continue;
    }
    if (i.who !== 'User' || i.seq === undefined) continue;
    heard = true;
    const id = `msg_${i.seq}`;
    const intent = intentOf(i.text);
    if (intent.kind === 'request') {
      texts.set(id, i.text);
      if (!known.has(intent.task)) addToQueue(queue, intent.task, id);
    } else if (intent.kind === 'follow-up') {
      texts.set(id, i.text);
      if (!stops.includes(intent.task)) addToQueue(queue, intent.task, id);
    } else if (intent.kind === 'stop') {
      stops.push(intent.task);
      const k = queue.findIndex((q) => q.task === intent.task);
      if (k >= 0) queue.splice(k, 1);
    }
  }
  // Stops first: the running sub-tasks of a task the user called off.
  const stopped = new Set(calls.filter((c) => c.name === TOOLS.stop).map((c) => String(c.input.id)));
  for (const task of stops) {
    const running = [...jobs.values()].filter((j) => j.task === task && j.running && !stopped.has(j.id));
    if (running.length) return tool(req, TOOLS.stop, { id: running[0].id });
    // After a new session the ids may be gone: look them up once.
    if (!known.has(task) && !calls.some((c) => c.name === TOOLS.status)) return tool(req, TOOLS.status, {});
  }
  // Then starts, oldest first, while it knows of a free slot and until one is refused. A task whose
  // sub-task still runs waits for it: they would edit the same folder at once.
  const max = Number(/At most (\d+) run at once/.exec(req.system)?.[1] ?? 4);
  const starts = calls.filter((c) => c.name === TOOLS.start);
  const startedNow = starts.filter((c) => !c.error).map((c) => String(c.input.title));
  // What a start covered, by message: a follow-up that arrived after it stays queued.
  const covered = new Set(starts.filter((c) => !c.error).flatMap((c) => [...String(c.input.task).matchAll(/\bmsg_\d+\b/g)].map((m) => m[0])));
  const live = [...jobs.values()].filter((j) => j.running);
  const busy = new Set(live.map((j) => j.task));
  const running = live.length;
  const full = starts.some((c) => c.error) || running >= max;
  const left = queue.map((q) => ({ ...q, ids: q.ids.filter((id) => !covered.has(id)) })).filter((q) => q.ids.length);
  const next = left.find((q) => !busy.has(q.task));
  if (!full && next) return tool(req, TOOLS.start, { title: next.task, task: briefOf(next, texts) });
  const parts = [
    queueText(left),
    startedNow.length ? `Started ${list(startedNow)} in the background.` : '',
    stops.length ? `Stopped ${list(stops)}.` : '',
    finished.length ? `${list(finished)} ${finished.length === 1 ? 'is' : 'are'} done.` : '',
  ].filter(Boolean);
  return { text: parts.join(' ') || (heard ? 'Noted.' : 'Ok.') };
}

// ---------------------------------------------------------------- the event filter

function filterPolicy(req: ModelRequest): Reply {
  const prompt = textOf(req.messages[turnStart(req.messages)]);
  const seen = new Set<string>();
  const decisions = [...prompt.matchAll(/<event id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/event>/g)].map((m) => {
    const branch = /crew\/(T\d+)/.exec(m[2])?.[1] || '';
    const failed = /\bfailed\b/.test(m[2]);
    const act = failed && !seen.has(branch);
    seen.add(branch);
    return { id: m[1], act, reason: act ? `A check fails on ${branch}` : failed ? `Same branch as an earlier event in this batch` : 'Passing run' };
  });
  return { text: JSON.stringify({ decisions }) };
}

/** The one scripted model: which agent it plays comes from the system prompt. */
/** A speculative run (ADR 008): works its steps, then claims what it reproduced. */
function speculativePolicy(req: ModelRequest): Reply {
  const run = /\b(sp_\d+)\b/.exec(textOf(req.messages[0]))?.[1] || 'sp_0';
  const calls = callsSince(req.messages, turnStart(req.messages) + 1);
  const last = calls[calls.length - 1];
  if (last?.name === TOOLS.claim) return { text: 'Reported.' };
  if (last?.name === TOOLS.work && /\bis complete\b/.test(last.result || ''))
    return tool(req, TOOLS.claim, { reproduced: true, testFiles: ['test/repro.test.ts'], summary: `Reproduced the failing check and fixed it (${run}).` });
  return tool(req, TOOLS.work, { task: run });
}

export const scriptedPolicy: Policy = (req) => {
  if (req.system.includes('coordinator of the group chat')) return routerPolicy(req);
  if (req.system.includes(SPECULATIVE_MARK)) return speculativePolicy(req);
  if (req.system.includes(WORKER_MARK) || req.system.includes(SUBTASK_MARK)) return workerPolicy(req);
  if (req.system.includes(FILTER_MARK)) return filterPolicy(req);
  if (req.system.includes(LEAD_MARK)) return req.system.includes(DELEGATE_MARK) ? delegateLeadPolicy(req) : neutralLeadPolicy(req);
  return { text: 'OK.' };
};
