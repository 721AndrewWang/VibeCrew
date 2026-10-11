import { CalendarClock, Clock, FileClock, GitCommitHorizontal, Hand, MessageCircle, Pencil, Play, Plus, Save, Timer, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Bot, Chat, Routine, RoutineTrigger } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, openChat, toast, useStore } from '../../store';
import { cx, fmtRelative, fmtShort } from '../../utils';
import { Avatar, confirmDialog, Glyph, Modal, Toggle, useNow } from '../ui';
import { PageHead } from './BotsView';

type TriggerType = RoutineTrigger['type'];

const TRIGGER_TYPES: { id: TriggerType; label: string; icon: typeof Clock }[] = [
  { id: 'interval', label: 'Interval', icon: Timer },
  { id: 'daily', label: 'Daily', icon: Clock },
  { id: 'cron', label: 'Cron', icon: CalendarClock },
  { id: 'file_change', label: 'File change', icon: FileClock },
  { id: 'git_commit', label: 'Git commit', icon: GitCommitHorizontal },
  { id: 'manual', label: 'Manual', icon: Hand },
];

/** Weekday chips in Monday-first order, mapped to cron day numbers. */
const WEEK: { day: number; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' },
];
const ORDER = WEEK.map((w) => w.day);

function weekdaysText(days?: number[]): string {
  if (!days?.length) return '';
  const uniq = [...new Set(days)].filter((d) => ORDER.includes(d)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!uniq.length || uniq.length === 7) return '';
  if (uniq.length === 2 && uniq[0] === 6 && uniq[1] === 0) return ' (weekends)';
  const idx = uniq.map((d) => ORDER.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const label = (d: number) => WEEK.find((w) => w.day === d)!.label;
  if (contiguous && uniq.length >= 3) return ` (${label(uniq[0])}–${label(uniq[uniq.length - 1])})`;
  return ` (${uniq.map(label).join(', ')})`;
}

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.type) {
    case 'interval':
      return t.minutes >= 60 && t.minutes % 60 === 0 ? `Every ${t.minutes / 60} hour${t.minutes === 60 ? '' : 's'}` : `Every ${t.minutes} minute${t.minutes === 1 ? '' : 's'}`;
    case 'daily':
      return `Daily at ${t.time || '09:00'}${weekdaysText(t.days)}`;
    case 'cron':
      return `Cron: ${t.expr}`;
    case 'file_change':
      return `After you save a file (wait ${t.debounceSec}s)`;
    case 'git_commit':
      return 'After every Git commit';
    case 'manual':
      return 'Manual only';
    default:
      return '';
  }
}

const STATUS_BADGE: Record<NonNullable<Routine['lastStatus']>, { cls: string; text: string }> = {
  ok: { cls: 'green', text: 'Success' },
  error: { cls: 'red', text: 'Failed' },
  running: { cls: 'accent', text: 'Running' },
  skipped: { cls: '', text: 'Skipped' },
};

// ---------------------------------------------------------------- editor

interface Form {
  name: string;
  botId: string;
  chatId: string | null;
  prompt: string;
  type: TriggerType;
  minutes: number;
  time: string;
  days: number[];
  expr: string;
  debounceSec: number;
}

interface Preset {
  label: string;
  icon: string;
  form: Partial<Form>;
}

const PRESETS: Preset[] = [
  { label: 'Check console errors daily at 9', icon: '🩺', form: { name: 'Daily console error check', type: 'daily', time: '09:00', days: [], prompt: '/fix-console' } },
  { label: 'Code review after each commit', icon: '🔍', form: { name: 'Post-commit code review', type: 'git_commit', prompt: '/review' } },
  {
    label: 'Check page after saving',
    icon: '👀',
    form: { name: 'Check page after save', type: 'file_change', debounceSec: 10, prompt: 'Use preview_console to check the current page for new errors. If there are any, fix them and tell me.' },
  },
];

function formFrom(r: Routine | undefined, defaultBot: string): Form {
  const base: Form = { name: '', botId: defaultBot, chatId: null, prompt: '', type: 'daily', minutes: 60, time: '09:00', days: [], expr: '0 9 * * 1-5', debounceSec: 10 };
  if (!r) return base;
  const t = r.trigger;
  return {
    ...base,
    name: r.name,
    botId: r.botId,
    chatId: r.chatId,
    prompt: r.prompt,
    type: t.type,
    ...(t.type === 'interval' ? { minutes: t.minutes } : {}),
    ...(t.type === 'daily' ? { time: t.time, days: t.days || [] } : {}),
    ...(t.type === 'cron' ? { expr: t.expr } : {}),
    ...(t.type === 'file_change' ? { debounceSec: t.debounceSec } : {}),
  };
}

function triggerFrom(f: Form): RoutineTrigger {
  switch (f.type) {
    case 'interval':
      return { type: 'interval', minutes: Math.max(1, Math.round(f.minutes) || 1) };
    case 'daily':
      return { type: 'daily', time: f.time || '09:00', ...(f.days.length ? { days: [...f.days].sort((a, b) => a - b) } : {}) };
    case 'cron':
      return { type: 'cron', expr: f.expr.trim() };
    case 'file_change':
      return { type: 'file_change', debounceSec: Math.max(2, Math.round(f.debounceSec) || 10) };
    case 'git_commit':
      return { type: 'git_commit' };
    default:
      return { type: 'manual' };
  }
}

const CRON_EXAMPLES = [
  { expr: '0 9 * * 1-5', label: 'Weekdays at 9' },
  { expr: '*/30 * * * *', label: 'Every 30 min' },
  { expr: '0 18 * * 5', label: 'Fridays at 18:00' },
  { expr: '0 0 1 * *', label: '1st of month, midnight' },
];

function RoutineEditor({ routine, preset, onClose }: { routine?: Routine; preset?: Preset; onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const chats = useStore((s) => s.chats);
  const projects = useStore((s) => s.projects);
  const botList = useMemo(() => Object.values(bots).sort((a, b) => a.createdAt - b.createdAt), [bots]);
  const [f, setF] = useState<Form>(() => ({ ...formFrom(routine, botList[0]?.id || ''), ...preset?.form }));
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Form>) => setF((cur) => ({ ...cur, ...p }));

  const bot = bots[f.botId];
  const groups = useMemo(() => Object.values(chats).filter((c) => c.kind === 'group' && c.botIds.includes(f.botId)), [chats, f.botId]);
  const targetChat: Chat | undefined = f.chatId ? chats[f.chatId] : Object.values(chats).find((c) => c.kind === 'dm' && c.botIds[0] === f.botId);
  const targetProject = targetChat?.projectId ? projects[targetChat.projectId] : undefined;

  const save = async () => {
    if (!bot) return toast('Choose a bot', undefined, 'error');
    if (!f.prompt.trim()) return toast('Enter the task', 'Tell the bot what to do each time', 'error');
    if (f.type === 'cron' && !f.expr.trim()) return toast('Enter a cron expression', undefined, 'error');
    if (f.type === 'interval' && !(f.minutes >= 1)) return toast('Interval must be at least 1 minute', undefined, 'error');
    const payload: Partial<Routine> = {
      name: f.name.trim() || f.prompt.trim().split('\n')[0].slice(0, 24),
      botId: f.botId,
      chatId: f.chatId && groups.some((g) => g.id === f.chatId) ? f.chatId : null,
      prompt: f.prompt.trim(),
      trigger: triggerFrom(f),
    };
    setSaving(true);
    try {
      if (routine) await api.updateRoutine(routine.id, payload);
      else await api.saveRoutine({ ...payload, enabled: true });
      toast(routine ? 'Routine saved' : 'Routine created', payload.name, 'success');
      onClose();
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={routine ? 'Edit routine' : 'New routine'}
      icon={<Clock size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !botList.length} onClick={save}>
            {saving ? <span className="spinner" /> : <Save size={15} />} {routine ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      {!routine && (
        <div className="field">
          <label>Quick start</label>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button key={p.label} className="preset-chip" onClick={() => set(p.form)}>
                <Glyph emoji={p.icon} size={14} /> {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field">
        <label>Name</label>
        <input className="input" value={f.name} placeholder="e.g. Daily console error check" onChange={(e) => set({ name: e.target.value })} />
      </div>

      <div className="form-grid">
        <div className="field">
          <label>Bot</label>
          <select
            className="select"
            value={f.botId}
            onChange={(e) => {
              const botId = e.target.value;
              const keep = f.chatId && chats[f.chatId]?.botIds.includes(botId);
              set({ botId, chatId: keep ? f.chatId : null });
            }}
          >
            {botList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.emoji} {b.name} — {b.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Run in chat</label>
          <select className="select" value={f.chatId || ''} onChange={(e) => set({ chatId: e.target.value || null })}>
            <option value="">{bot ? `Direct chat with ${bot.name}` : 'Direct chat'}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                Group chat: {g.title}
              </option>
            ))}
          </select>
          <div className="hint">{targetProject ? `Project: ${targetProject.name}` : 'This chat has no project bound yet'}</div>
        </div>
      </div>

      <div className="field">
        <label>Task</label>
        <textarea className="textarea" rows={4} value={f.prompt} placeholder="Message sent to the bot on each run" onChange={(e) => set({ prompt: e.target.value })} />
        <div className="hint">
          You can write /skill-name directly, e.g. <code className="inline-code">/fix-console</code>
        </div>
      </div>

      <div className="field">
        <label>When to run</label>
        <div className="segmented wrap">
          {TRIGGER_TYPES.map((t) => (
            <button key={t.id} className={cx(f.type === t.id && 'on')} onClick={() => set({ type: t.id })}>
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="trigger-box">
        {f.type === 'interval' && (
          <div className="row wrap">
            <span>Every</span>
            <input className="input num-input" type="number" min={1} value={f.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} />
            <span>minutes</span>
          </div>
        )}
        {f.type === 'daily' && (
          <>
            <div className="row wrap">
              <span>Time</span>
              <input className="input time-input" type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} />
            </div>
            <div className="row wrap" style={{ marginTop: 10 }}>
              <span>Days</span>
              <div className="day-chips">
                {WEEK.map((w) => {
                  const on = f.days.includes(w.day);
                  return (
                    <button key={w.day} className={cx('day-chip', on && 'on')} onClick={() => set({ days: on ? f.days.filter((d) => d !== w.day) : [...f.days, w.day] })}>
                      {w.label}
                    </button>
                  );
                })}
              </div>
              {f.days.length > 0 && (
                <button className="btn ghost sm" onClick={() => set({ days: [] })}>
                  Every day
                </button>
              )}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              {f.days.length ? describeTrigger(triggerFrom(f)) : 'None selected means every day'}
            </div>
          </>
        )}
        {f.type === 'cron' && (
          <>
            <input className="input mono" value={f.expr} placeholder="min hour day month weekday, e.g. 0 9 * * 1-5" onChange={(e) => set({ expr: e.target.value })} />
            <div className="preset-row" style={{ marginTop: 8 }}>
              {CRON_EXAMPLES.map((c) => (
                <button key={c.expr} className="preset-chip sm" onClick={() => set({ expr: c.expr })}>
                  <span className="mono">{c.expr}</span> <span className="muted">{c.label}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {f.type === 'file_change' && (
          <>
            <div className="row wrap">
              <span>After you save a file, wait</span>
              <input className="input num-input" type="number" min={2} value={f.debounceSec} onChange={(e) => set({ debounceSec: Number(e.target.value) })} />
              <span>seconds, then run</span>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              Watches the project bound to the target chat. Files changed by bots don't trigger it, and repeated saves within the wait run only once.
            </div>
          </>
        )}
        {f.type === 'git_commit' && <div className="hint">Runs once for every Git commit in the project bound to the target chat. Good for code review or updating docs.</div>}
        {f.type === 'manual' && <div className="hint">Never runs automatically; only when you click "Run now" in the list. Good for saving one-click workflows.</div>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- list

function RoutineCard({ routine, bot, chat, onEdit }: { routine: Routine; bot?: Bot; chat?: Chat; onEdit: () => void }) {
  const [busy, setBusy] = useState(false);
  const TypeIcon = TRIGGER_TYPES.find((t) => t.id === routine.trigger.type)?.icon || Clock;
  const status = routine.lastStatus ? STATUS_BADGE[routine.lastStatus] : null;

  const setEnabled = async (enabled: boolean) => {
    useStore.setState((s) => ({ routines: { ...s.routines, [routine.id]: { ...routine, enabled } } }));
    try {
      await api.updateRoutine(routine.id, { enabled });
    } catch (e) {
      useStore.setState((s) => ({ routines: { ...s.routines, [routine.id]: routine } }));
      toast('Toggle failed', (e as Error).message, 'error');
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runRoutine(routine.id);
      if (r?.lastStatus === 'error') toast('Run failed', 'Target chat not found, or the bot is no longer in that group chat', 'error');
      else toast('Run started', `${bot?.name || 'Bot'} is working on "${routine.name}"`, 'success');
    } catch (e) {
      toast('Run failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const view = () => {
    const id = chat?.id || dmOf(routine.botId)?.id;
    if (id) openChat(id);
    else toast('Chat not found', undefined, 'warn');
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: `Delete routine "${routine.name}"?`, body: 'Chat history from past runs will be kept.', ok: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.deleteRoutine(routine.id);
      toast('Routine deleted', routine.name, 'success');
    } catch (e) {
      toast('Delete failed', (e as Error).message, 'error');
    }
  };

  return (
    <div className={cx('card routine-card', !routine.enabled && 'disabled')}>
      <div className="rc-head">
        <span className="rc-icon">
          <TypeIcon size={18} />
        </span>
        <div className="rc-title">
          <div className="rc-name">{routine.name}</div>
          <div className="rc-trigger">{describeTrigger(routine.trigger)}</div>
        </div>
        <Toggle on={routine.enabled} onChange={setEnabled} title={routine.enabled ? 'Enabled' : 'Paused'} />
      </div>

      <div className={cx('rc-prompt', routine.prompt.startsWith('/') && 'mono')}>{routine.prompt}</div>

      <div className="rc-meta">
        <span className="rc-bot">
          <Avatar bot={bot} size={20} />
          {bot?.name || '(bot deleted)'}
          <span className="muted">· {chat ? chat.title : 'Direct chat'}</span>
        </span>
        {routine.enabled && routine.nextRunAt ? <span>Next: {fmtRelative(routine.nextRunAt)}</span> : null}
        {!routine.enabled && <span className="muted">Paused</span>}
        {routine.lastRunAt ? (
          <span className="rc-last">
            Last: {fmtShort(routine.lastRunAt)}
            {status && <span className={cx('badge', status.cls)}>{status.text}</span>}
          </span>
        ) : (
          <span className="muted">Never run</span>
        )}
        {routine.runCount > 0 && (
          <span className="muted">
            Ran {routine.runCount} time{routine.runCount === 1 ? '' : 's'}
          </span>
        )}
      </div>

      <div className="rc-actions">
        <button className="btn sm primary" disabled={busy || !bot} onClick={run}>
          {busy ? <span className="spinner tiny" /> : <Play size={13} />} Run now
        </button>
        <button className="btn sm" onClick={view}>
          <MessageCircle size={13} /> View chat
        </button>
        <button className="btn sm" onClick={onEdit}>
          <Pencil size={13} /> Edit
        </button>
        <span className="spacer" />
        <button className="icon-btn sm danger-hover" title="Delete" onClick={remove}>
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

export function RoutinesView() {
  const routines = useStore((s) => s.routines);
  const bots = useStore((s) => s.bots);
  const chats = useStore((s) => s.chats);
  const hasBots = useStore((s) => Object.keys(s.bots).length > 0);
  const [editing, setEditing] = useState<null | { routine?: Routine; preset?: Preset }>(null);
  useNow(30_000);

  const list = useMemo(() => Object.values(routines).sort((a, b) => a.createdAt - b.createdAt), [routines]);

  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Routines" sub="Have bots work automatically on a schedule or when events happen">
          <button className="btn primary" disabled={!hasBots} onClick={() => setEditing({})}>
            <Plus size={15} /> New routine
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty routines-empty">
            <div className="big">
              <Glyph emoji="⏰" size={26} />
            </div>
            <h3>No routines yet</h3>
            <div>
              Routines have a bot do something automatically at a set time, on an interval, after you save a file, or after each Git commit,
              <br className="wide-only" />
              like checking for errors every morning or reviewing code after a commit. Results show up in the matching chat.
            </div>
            {hasBots ? (
              <div className="preset-row center">
                {PRESETS.map((p) => (
                  <button key={p.label} className="preset-chip" onClick={() => setEditing({ preset: p })}>
                    <Glyph emoji={p.icon} size={14} /> {p.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="muted">Add a bot first.</div>
            )}
          </div>
        ) : (
          <div className="routine-grid">
            {list.map((r) => (
              <RoutineCard key={r.id} routine={r} bot={bots[r.botId]} chat={r.chatId ? chats[r.chatId] : undefined} onEdit={() => setEditing({ routine: r })} />
            ))}
          </div>
        )}
      </div>
      {editing && <RoutineEditor routine={editing.routine} preset={editing.preset} onClose={() => setEditing(null)} />}
    </div>
  );
}
