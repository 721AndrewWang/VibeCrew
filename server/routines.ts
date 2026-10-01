import { Cron } from 'croner';
import type { Chat, Routine, RoutineTrigger } from '../shared/types';
import { bus, internal } from './bus';
import { isChatBusy, projectBusy, runInChat } from './orchestrator';
import { chatProjectId } from './projects';
import { bots, chats, routines, uid } from './store';
import { ensureWatch } from './watcher';

function cronFor(t: RoutineTrigger): string | null {
  if (t.type === 'cron') return t.expr;
  if (t.type === 'daily') {
    const [h, m] = (t.time || '09:00').split(':').map((x) => parseInt(x, 10) || 0);
    const days = t.days?.length ? t.days.join(',') : '*';
    return `${m} ${h} * * ${days}`;
  }
  return null;
}

export function validateTrigger(t: RoutineTrigger) {
  if (t.type === 'interval' && !(t.minutes >= 1)) throw new Error('间隔至少 1 分钟');
  const expr = cronFor(t);
  if (expr) {
    try {
      new Cron(expr, { paused: true }).stop();
    } catch {
      throw new Error(`无效的时间表达式：${expr}`);
    }
  }
}

export function nextRun(r: Routine, from = Date.now()): number | undefined {
  const t = r.trigger;
  if (!r.enabled) return undefined;
  if (t.type === 'interval') {
    const base = r.lastRunAt ?? from;
    return Math.max(base + t.minutes * 60_000, from + 5_000);
  }
  const expr = cronFor(t);
  if (!expr) return undefined;
  try {
    const job = new Cron(expr, { paused: true });
    const next = job.nextRun(new Date(from));
    job.stop();
    return next?.getTime();
  } catch {
    return undefined;
  }
}

/** The chat a routine posts into: its own chat, or the bot's direct chat. */
export function routineChat(r: Routine): Chat | undefined {
  if (r.chatId) {
    const c = chats.get(r.chatId);
    if (c) return c;
  }
  return chats.all().find((c) => c.kind === 'dm' && c.botIds[0] === r.botId);
}

function emit(r: Routine) {
  routines.set(r);
  bus.emit({ t: 'routine', routine: r });
}

export function runRoutine(r: Routine, reason: 'schedule' | 'manual' | 'event' = 'manual') {
  const chat = routineChat(r);
  const bot = bots.get(r.botId);
  if (!chat || !bot) {
    r.lastStatus = 'error';
    emit(r);
    return;
  }
  if (reason === 'event' && isChatBusy(chat.id)) {
    r.lastStatus = 'skipped';
    emit(r);
    return;
  }
  if (!chat.botIds.includes(bot.id)) {
    r.lastStatus = 'error';
    emit(r);
    return;
  }
  runInChat(chat.id, bot.id, r.prompt, { type: 'routine', routineId: r.id }, r.name);
  r.lastRunAt = Date.now();
  r.runCount = (r.runCount || 0) + 1;
  r.lastStatus = 'running';
  r.nextRunAt = nextRun(r);
  emit(r);
}

export function saveRoutine(input: Partial<Routine> & Pick<Routine, 'name' | 'botId' | 'prompt' | 'trigger'>): Routine {
  validateTrigger(input.trigger);
  if (!bots.get(input.botId)) throw new Error('机器人不存在');
  if (!input.prompt.trim()) throw new Error('任务内容不能为空');
  const existing = input.id ? routines.get(input.id) : undefined;
  const r: Routine = {
    id: existing?.id || uid('r_'),
    name: input.name.trim() || '未命名任务',
    enabled: input.enabled ?? existing?.enabled ?? true,
    botId: input.botId,
    chatId: input.chatId ?? null,
    prompt: input.prompt.trim(),
    trigger: input.trigger,
    lastRunAt: existing?.lastRunAt,
    lastStatus: existing?.lastStatus,
    runCount: existing?.runCount || 0,
    createdAt: existing?.createdAt || Date.now(),
  };
  r.nextRunAt = nextRun(r);
  emit(r);
  watchFor(r);
  return r;
}

export function deleteRoutine(id: string) {
  routines.delete(id);
  bus.emit({ t: 'routine_deleted', id });
}

function watchFor(r: Routine) {
  if (r.trigger.type !== 'file_change' && r.trigger.type !== 'git_commit') return;
  const chat = routineChat(r);
  if (chat?.projectId) ensureWatch(chat.projectId);
  const active = chatProjectId(chat);
  if (active && active !== chat?.projectId) ensureWatch(active);
}

/** Your edits in the chat's project folder, or in its isolated workspace. */
function watchesProject(r: Routine, projectId: string): boolean {
  const chat = routineChat(r);
  return !!chat && (chat.projectId === projectId || chatProjectId(chat) === projectId);
}

const debounce = new Map<string, NodeJS.Timeout>();

export function startRoutines() {
  for (const r of routines.all()) {
    r.nextRunAt = nextRun(r);
    if (r.lastStatus === 'running') r.lastStatus = undefined;
    watchFor(r);
  }
  routines.save();

  setInterval(() => {
    const now = Date.now();
    for (const r of routines.all()) {
      if (!r.enabled || !r.nextRunAt || r.nextRunAt > now) continue;
      if (r.trigger.type !== 'interval' && r.trigger.type !== 'daily' && r.trigger.type !== 'cron') continue;
      runRoutine(r, 'schedule');
    }
  }, 15_000).unref();

  // Your own edits (not the bots') trigger "on file change" routines.
  internal.on('files', (projectId) => {
    if (projectBusy(projectId)) return;
    for (const r of routines.all()) {
      if (!r.enabled || r.trigger.type !== 'file_change') continue;
      if (!watchesProject(r, projectId)) continue;
      const wait = Math.max(2, r.trigger.debounceSec || 10) * 1000;
      clearTimeout(debounce.get(r.id));
      debounce.set(
        r.id,
        setTimeout(() => {
          debounce.delete(r.id);
          if (!projectBusy(projectId)) runRoutine(r, 'event');
        }, wait),
      );
    }
  });

  internal.on('commit', (projectId) => {
    for (const r of routines.all()) {
      if (!r.enabled || r.trigger.type !== 'git_commit') continue;
      if (routineChat(r)?.projectId === projectId) runRoutine(r, 'event');
    }
  });

  // Record how each run ended.
  bus.on((ev) => {
    if (ev.t !== 'msg' || ev.msg.role !== 'bot' || ev.msg.trigger?.type !== 'routine') return;
    if (ev.msg.status !== 'done' && ev.msg.status !== 'error' && ev.msg.status !== 'stopped') return;
    const r = routines.get(ev.msg.trigger.routineId);
    if (r?.lastStatus !== 'running') return;
    r.lastStatus = ev.msg.status === 'done' ? 'ok' : 'error';
    emit(r);
  });
}
