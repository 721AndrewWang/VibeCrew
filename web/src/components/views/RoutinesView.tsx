import { useMemo, useState } from 'react';
import { CalendarClock, Clock, FileClock, GitCommitHorizontal, Hand, MessageCircle, Pencil, Play, Plus, Save, Timer, Trash2 } from 'lucide-react';
import type { Bot, Chat, Routine, RoutineTrigger } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, openChat, toast, useStore } from '../../store';
import { cx, fmtRelative, fmtShort } from '../../utils';
import { Avatar, confirmDialog, Glyph, Modal, Toggle, useNow } from '../ui';
import { PageHead } from './BotsView';

type TriggerType = RoutineTrigger['type'];

const TRIGGER_TYPES: { id: TriggerType; label: string; icon: typeof Clock }[] = [
  { id: 'interval', label: '间隔', icon: Timer },
  { id: 'daily', label: '每天', icon: Clock },
  { id: 'cron', label: 'Cron', icon: CalendarClock },
  { id: 'file_change', label: '文件变化', icon: FileClock },
  { id: 'git_commit', label: 'Git 提交', icon: GitCommitHorizontal },
  { id: 'manual', label: '手动', icon: Hand },
];

/** Weekday chips in Monday-first order, mapped to cron day numbers. */
const WEEK: { day: number; label: string }[] = [
  { day: 1, label: '一' },
  { day: 2, label: '二' },
  { day: 3, label: '三' },
  { day: 4, label: '四' },
  { day: 5, label: '五' },
  { day: 6, label: '六' },
  { day: 0, label: '日' },
];
const ORDER = WEEK.map((w) => w.day);

function weekdaysText(days?: number[]): string {
  if (!days?.length) return '';
  const uniq = [...new Set(days)].filter((d) => ORDER.includes(d)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  if (!uniq.length || uniq.length === 7) return '';
  if (uniq.length === 2 && uniq[0] === 6 && uniq[1] === 0) return '（周末）';
  const idx = uniq.map((d) => ORDER.indexOf(d));
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  const label = (d: number) => WEEK.find((w) => w.day === d)!.label;
  if (contiguous && uniq.length >= 3) return `（周${label(uniq[0])}至周${label(uniq[uniq.length - 1])}）`;
  return `（周${uniq.map(label).join('、')}）`;
}

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.type) {
    case 'interval':
      return t.minutes >= 60 && t.minutes % 60 === 0 ? `每 ${t.minutes / 60} 小时` : `每 ${t.minutes} 分钟`;
    case 'daily':
      return `每天 ${t.time || '09:00'}${weekdaysText(t.days)}`;
    case 'cron':
      return `Cron：${t.expr}`;
    case 'file_change':
      return `你保存文件后（等待 ${t.debounceSec} 秒）`;
    case 'git_commit':
      return '每次 Git 提交后';
    case 'manual':
      return '仅手动运行';
    default:
      return '';
  }
}

const STATUS_BADGE: Record<NonNullable<Routine['lastStatus']>, { cls: string; text: string }> = {
  ok: { cls: 'green', text: '成功' },
  error: { cls: 'red', text: '失败' },
  running: { cls: 'accent', text: '运行中' },
  skipped: { cls: '', text: '已跳过' },
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
  { label: '每天 9 点检查控制台报错', icon: '🩺', form: { name: '每天检查控制台报错', type: 'daily', time: '09:00', days: [], prompt: '/fix-console' } },
  { label: '每次提交后代码审查', icon: '🔍', form: { name: '提交后代码审查', type: 'git_commit', prompt: '/review' } },
  { label: '保存文件后检查页面', icon: '👀', form: { name: '保存后检查页面', type: 'file_change', debounceSec: 10, prompt: '用 preview_console 检查当前页面有没有新的报错，有就修复并告诉我' } },
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
  { expr: '0 9 * * 1-5', label: '工作日 9 点' },
  { expr: '*/30 * * * *', label: '每 30 分钟' },
  { expr: '0 18 * * 5', label: '每周五 18 点' },
  { expr: '0 0 1 * *', label: '每月 1 号零点' },
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
    if (!bot) return toast('请选择机器人', undefined, 'error');
    if (!f.prompt.trim()) return toast('请填写任务内容', '告诉机器人每次要做什么', 'error');
    if (f.type === 'cron' && !f.expr.trim()) return toast('请填写 Cron 表达式', undefined, 'error');
    if (f.type === 'interval' && !(f.minutes >= 1)) return toast('间隔至少 1 分钟', undefined, 'error');
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
      toast(routine ? '任务已保存' : '已创建定时任务', payload.name, 'success');
      onClose();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={routine ? '编辑定时任务' : '新建定时任务'}
      icon={<Clock size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving || !botList.length} onClick={save}>
            {saving ? <span className="spinner" /> : <Save size={15} />} {routine ? '保存' : '创建'}
          </button>
        </>
      }
    >
      {!routine && (
        <div className="field">
          <label>快速开始</label>
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
        <label>任务名称</label>
        <input className="input" value={f.name} placeholder="例如 每天检查控制台报错" onChange={(e) => set({ name: e.target.value })} />
      </div>

      <div className="form-grid">
        <div className="field">
          <label>由谁来做</label>
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
          <label>在哪个对话里运行</label>
          <select className="select" value={f.chatId || ''} onChange={(e) => set({ chatId: e.target.value || null })}>
            <option value="">{bot ? `${bot.name} 的单聊` : '单聊'}</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                群聊：{g.title}
              </option>
            ))}
          </select>
          <div className="hint">{targetProject ? `项目：${targetProject.name}` : '这个对话还没有绑定项目'}</div>
        </div>
      </div>

      <div className="field">
        <label>任务内容</label>
        <textarea className="textarea" rows={4} value={f.prompt} placeholder="每次运行时发给机器人的话" onChange={(e) => set({ prompt: e.target.value })} />
        <div className="hint">
          可以直接写 /技能名，例如 <code className="inline-code">/fix-console</code>
        </div>
      </div>

      <div className="field">
        <label>什么时候运行</label>
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
            <span>每隔</span>
            <input className="input num-input" type="number" min={1} value={f.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} />
            <span>分钟运行一次</span>
          </div>
        )}
        {f.type === 'daily' && (
          <>
            <div className="row wrap">
              <span>时间</span>
              <input className="input time-input" type="time" value={f.time} onChange={(e) => set({ time: e.target.value })} />
            </div>
            <div className="row wrap" style={{ marginTop: 10 }}>
              <span>星期</span>
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
                  每天
                </button>
              )}
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              {f.days.length ? describeTrigger(triggerFrom(f)) : '不选表示每天'}
            </div>
          </>
        )}
        {f.type === 'cron' && (
          <>
            <input className="input mono" value={f.expr} placeholder="分 时 日 月 周，例如 0 9 * * 1-5" onChange={(e) => set({ expr: e.target.value })} />
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
              <span>你保存文件后，等待</span>
              <input className="input num-input" type="number" min={2} value={f.debounceSec} onChange={(e) => set({ debounceSec: Number(e.target.value) })} />
              <span>秒再运行</span>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              监听目标对话所绑定的项目；机器人自己改的文件不会触发，这段时间内连续保存只运行一次。
            </div>
          </>
        )}
        {f.type === 'git_commit' && <div className="hint">目标对话所绑定的项目每产生一次 Git 提交就运行一次，适合做代码审查或更新文档。</div>}
        {f.type === 'manual' && <div className="hint">不会自动运行，在任务列表里点「立即运行」时才执行。适合保存常用的一键流程。</div>}
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
      toast('切换失败', (e as Error).message, 'error');
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const r = await api.runRoutine(routine.id);
      if (r?.lastStatus === 'error') toast('运行失败', '找不到目标对话，或机器人已经不在那个群聊里了', 'error');
      else toast('已开始运行', `${bot?.name || '机器人'} 正在处理「${routine.name}」`, 'success');
    } catch (e) {
      toast('运行失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const view = () => {
    const id = chat?.id || dmOf(routine.botId)?.id;
    if (id) openChat(id);
    else toast('找不到对话', undefined, 'warn');
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: `删除任务「${routine.name}」？`, body: '已经运行产生的聊天记录会保留。', ok: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteRoutine(routine.id);
      toast('已删除任务', routine.name, 'success');
    } catch (e) {
      toast('删除失败', (e as Error).message, 'error');
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
        <Toggle on={routine.enabled} onChange={setEnabled} title={routine.enabled ? '已启用' : '已暂停'} />
      </div>

      <div className={cx('rc-prompt', routine.prompt.startsWith('/') && 'mono')}>{routine.prompt}</div>

      <div className="rc-meta">
        <span className="rc-bot">
          <Avatar bot={bot} size={20} />
          {bot?.name || '（机器人已删除）'}
          <span className="muted">· {chat ? chat.title : '单聊'}</span>
        </span>
        {routine.enabled && routine.nextRunAt ? <span>下次：{fmtRelative(routine.nextRunAt)}</span> : null}
        {!routine.enabled && <span className="muted">已暂停</span>}
        {routine.lastRunAt ? (
          <span className="rc-last">
            上次：{fmtShort(routine.lastRunAt)}
            {status && <span className={cx('badge', status.cls)}>{status.text}</span>}
          </span>
        ) : (
          <span className="muted">还没有运行过</span>
        )}
        {routine.runCount > 0 && <span className="muted">已运行 {routine.runCount} 次</span>}
      </div>

      <div className="rc-actions">
        <button className="btn sm primary" disabled={busy || !bot} onClick={run}>
          {busy ? <span className="spinner tiny" /> : <Play size={13} />} 立即运行
        </button>
        <button className="btn sm" onClick={view}>
          <MessageCircle size={13} /> 查看对话
        </button>
        <button className="btn sm" onClick={onEdit}>
          <Pencil size={13} /> 编辑
        </button>
        <span className="spacer" />
        <button className="icon-btn sm danger-hover" title="删除" onClick={remove}>
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
        <PageHead title="定时任务" sub="让机器人按时间表或在事件发生时自动工作（像 Grokbot 的 Routines）">
          <button className="btn primary" disabled={!hasBots} onClick={() => setEditing({})}>
            <Plus size={15} /> 新建任务
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty routines-empty">
            <div className="big">
              <Glyph emoji="⏰" size={26} />
            </div>
            <h3>还没有定时任务</h3>
            <div>
              定时任务会在固定时间、每隔一段时间、你保存文件后或每次 Git 提交后，自动让机器人做一件事，
              <br className="wide-only" />
              比如每天早上检查报错、提交后做代码审查。结果会出现在对应的对话里。
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
              <div className="muted">先添加一个机器人吧。</div>
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
