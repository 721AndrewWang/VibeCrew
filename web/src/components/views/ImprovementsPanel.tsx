import { Check, ChevronRight, Lightbulb, Pencil, RotateCcw, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { Effort, FrictionReport, ImprovableField, Improvement, ImprovementEffect, PermissionLevel, SkillCandidate, SkillDraft } from '../../../../shared/types';
import { api } from '../../api';
import { openChat, toast, useStore } from '../../store';
import { cx, EFFORT_OPTIONS, fmtWhen, PERMISSION_INFO } from '../../utils';
import { Toggle } from '../ui';
import { fmtUsd } from './BotsView';
import { ModelPicker } from './bot-editor/ModelPicker';

const FIELD_LABEL: Record<ImprovableField, string> = {
  description: '角色说明',
  model: '模型',
  effort: '思考强度',
  permission: '权限级别',
  allowRules: '自动允许',
  askRules: '必须确认',
  editScope: '只能修改的路径',
  freshSession: '每轮新会话',
  monthlyBudgetUsd: '每月预算',
  skill: '新技能',
};

const STATUS_LABEL: Record<Improvement['status'], string> = { pending: '待定', accepted: '已接受', rejected: '已拒绝', reverted: '已撤回', stale: '已作废' };

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '（默认）' : typeof v === 'string' ? v : JSON.stringify(v));

/** Proposed changes to the bots, backed by real turns: the user accepts or rejects each one. */
export function ImprovementsPanel() {
  const [items, setItems] = useState<Improvement[] | null>(null);
  const [effects, setEffects] = useState<Record<string, ImprovementEffect>>({});
  const [running, setRunning] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(() => {
    api
      .improvements()
      .then((r) => {
        setItems(r.items);
        setEffects(r.effects);
      })
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  const run = async () => {
    setRunning(true);
    try {
      const r = await api.runImprovements();
      const cost = r.costUsd ? `（花了 ${fmtUsd(r.costUsd)}）` : '';
      if (r.added.length) toast(`有 ${r.added.length} 条新建议${cost}`, r.dropped.length ? `另有 ${r.dropped.length} 条没通过检查：${r.dropped.join('；')}` : undefined, 'success');
      else toast(`这次没有值得改的地方${cost}`, r.dropped.length ? `没通过检查的：${r.dropped.join('；')}` : '机器人最近的表现没有反复出现的问题。', 'info');
      load();
    } catch (e) {
      toast('分析失败', (e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const pending = (items || []).filter((i) => i.status === 'pending');
  const done = (items || []).filter((i) => i.status !== 'pending');
  return (
    <section className="card improve-card">
      <div className="sc-head">
        <span className="sc-icon">
          <Lightbulb size={18} />
        </span>
        <h2>改进建议</h2>
        <span className="spacer" />
        <button className="btn sm" disabled={running} onClick={run} title="读最近的轮次、费用、证伪结果和你的审批，提出最多 3 条小改动（用 Sonnet，大约 $0.05～0.15）">
          {running ? <span className="spinner tiny" /> : <Lightbulb size={13} />} 分析最近的表现
        </button>
      </div>
      <div className="hint improve-hint">每条只改一个机器人的一项设置，并附上真实发生过的轮次作为证据。由你决定接不接受；接受之后可以对比前后的表现，也可以撤回。</div>
      {pending.map((i) => (
        <ProposalCard key={i.id} item={i} onDone={load} />
      ))}
      {items && !pending.length && <div className="muted improve-empty">现在没有待定的建议。</div>}
      <SkillCandidates onDrafted={load} />
      <FrictionReportView />
      {done.length > 0 && (
        <>
          <button className="link-btn improve-toggle" onClick={() => setShowDone(!showDone)}>
            <ChevronRight size={12} className={cx('chev', showDone && 'open')} /> 处理过的 {done.length} 条
          </button>
          {showDone && done.map((i) => <DecidedRow key={i.id} item={i} effect={effects[i.id]} onDone={load} />)}
        </>
      )}
    </section>
  );
}

function Change({ item }: { item: Improvement }) {
  if (item.field === 'skill') {
    const d = item.after as SkillDraft;
    return (
      <div className="improve-skill">
        <div className="mono">
          /{d.name} · {d.title}
        </div>
        <div className="hint">{d.description}</div>
        {d.flags.length > 0 && (
          <div className="improve-flags">
            {d.flags.map((f) => (
              <div key={f}>注意：{f}</div>
            ))}
          </div>
        )}
        <pre className="improve-diff">{d.body}</pre>
      </div>
    );
  }
  if (item.field === 'description') {
    const before = String(item.before || '').split('\n');
    const after = String(item.after || '').split('\n');
    const b = new Set(before);
    const a = new Set(after);
    return (
      <pre className="improve-diff">
        {before
          .filter((l) => !a.has(l))
          .map((l, k) => (
            <div key={`d${k}`} className="del">
              - {l}
            </div>
          ))}
        {after
          .filter((l) => !b.has(l))
          .map((l, k) => (
            <div key={`a${k}`} className="add">
              + {l}
            </div>
          ))}
      </pre>
    );
  }
  return (
    <div className="improve-change mono">
      <span className="del">{show(item.before)}</span> → <span className="add">{show(item.after)}</span>
    </div>
  );
}

function ProposalCard({ item, onDone }: { item: Improvement; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, undefined, 'success');
    } catch (e) {
      toast('操作失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="improve-item">
      <div className="improve-title">
        <b>{item.botName}</b> 的{FIELD_LABEL[item.field]}
      </div>
      {editing && item.field !== 'skill' ? (
        <SettingEditor
          item={item}
          onCancel={() => setEditing(false)}
          onSave={async (value) => {
            try {
              await api.editImprovement(item.id, { value });
              toast('建议已修改', '看过再接受', 'success');
              setEditing(false);
              onDone();
            } catch (e) {
              toast('没能保存修改', (e as Error).message, 'error');
            }
          }}
        />
      ) : editing && item.field === 'skill' ? (
        <SkillEditor
          draft={item.after as SkillDraft}
          onCancel={() => setEditing(false)}
          onSave={async (d) => {
            try {
              await api.editImprovement(item.id, d);
              toast('草稿已修改', '安全检查重新过了一遍，看过再接受', 'success');
              setEditing(false);
              onDone();
            } catch (e) {
              toast('没能保存修改', (e as Error).message, 'error');
            }
          }}
        />
      ) : (
        <Change item={item} />
      )}
      {item.original !== undefined && (
        <div className="hint">
          {item.field === 'skill' ? '这份草稿你改过；接受后，下次起草技能会参考你改掉的地方。' : `你改过这条建议（模型原来提的是 ${show(item.original)}）；下次分析会参考你的改法。`}
        </div>
      )}
      <div className="improve-why">{item.rationale}</div>
      {item.expected && <div className="hint">期望：{item.expected}</div>}
      <div className="improve-evidence">
        {item.evidence.map((e) => (
          <button key={e.messageId} className="link-btn" onClick={() => openChat(e.chatId)} title="打开这个对话">
            {e.note || '查看这一轮'}
          </button>
        ))}
      </div>
      {rejecting ? (
        <div className="row">
          <input className="input" autoFocus placeholder="为什么不要（可选，下次分析会参考）" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm danger solid" disabled={busy} onClick={() => act(() => api.rejectImprovement(item.id, note), '已拒绝')}>
            拒绝
          </button>
          <button className="btn sm" onClick={() => setRejecting(false)}>
            返回
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="btn sm primary" disabled={busy} onClick={() => act(() => api.acceptImprovement(item.id), `已应用到 ${item.botName}`)}>
            <Check size={13} /> 接受
          </button>
          <button className="btn sm" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> 拒绝
          </button>
          {!editing && (
            <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={13} /> 修改
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DecidedRow({ item, effect, onDone }: { item: Improvement; effect?: ImprovementEffect; onDone: () => void }) {
  const revert = async () => {
    try {
      await api.revertImprovement(item.id);
      toast(`已撤回 ${item.botName} 的这项改动`, undefined, 'success');
    } catch (e) {
      toast('撤回失败', (e as Error).message, 'error');
    }
    onDone();
  };
  return (
    <div className="improve-row">
      <span className={cx('badge', item.status === 'accepted' && 'accent')}>{STATUS_LABEL[item.status]}</span>
      <span>
        {item.botName} 的{FIELD_LABEL[item.field]}：{show(item.after).slice(0, 60)}
        {item.decidedAt ? ` · ${fmtWhen(item.decidedAt)}` : ''}
        {item.note ? ` · 你说：${item.note}` : ''}
      </span>
      <span className="spacer" />
      {effect && (
        <span className="muted improve-effect" title="和改动之前同样数量的轮次比较">
          {effect.after.turns
            ? `之后 ${effect.after.turns} 轮平均 ${fmtUsd(effect.after.avgCostUsd)}，之前 ${fmtUsd(effect.before.avgCostUsd)}${effect.after.refuted || effect.before.refuted ? `；被推翻 ${effect.before.refuted}→${effect.after.refuted}` : ''}`
            : '之后还没有轮次'}
        </span>
      )}
      {item.status === 'accepted' && (
        <button className="btn sm ghost" onClick={revert} title="把这项设置改回去">
          <RotateCcw size={12} /> 撤回
        </button>
      )}
    </div>
  );
}

/** Turns worth learning from: drafting one into a skill costs a small Sonnet call, so it is on request. */
function SkillCandidates({ onDrafted }: { onDrafted: () => void }) {
  const [list, setList] = useState<SkillCandidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .skillCandidates()
      .then(setList)
      .catch(() => {});
  }, []);
  useEffect(load, [load]);
  if (!list.length) return null;
  const draft = async (c: SkillCandidate) => {
    setBusy(c.messageId);
    try {
      const r = await api.draftSkill(c.chatId, c.messageId);
      const cost = r.costUsd ? `（花了 ${fmtUsd(r.costUsd)}）` : '';
      if ('skipped' in r) toast(`没有起草${cost}`, r.skipped, 'info');
      else toast(`起草好了${cost}`, '在上面的建议里，看过再决定要不要', 'success');
      onDrafted();
    } catch (e) {
      toast('起草失败', (e as Error).message, 'error');
    } finally {
      setBusy(null);
      load();
    }
  };
  return (
    <div className="improve-candidates">
      <div className="hint">这些轮次做了不少事、顺利完成、之后也没被对抗审查推翻，可以把做法写成技能（每次大约 $0.02～0.05，写好后要你接受才会保存）：</div>
      {list.map((c) => (
        <div key={c.messageId} className="improve-row">
          <span>
            {c.botName} 在「{c.chatTitle}」：{c.ask || '（没有记录要求）'}
          </span>
          <span className="spacer" />
          <span className="muted">{c.tools} 次工具</span>
          <button className="btn sm" disabled={!!busy} onClick={() => draft(c)}>
            {busy === c.messageId ? <span className="spinner tiny" /> : null} 起草技能
          </button>
        </div>
      ))}
    </div>
  );
}

/** Editing a skill draft before accepting it: the fields the skill will be saved with. */
function SkillEditor({ draft, onSave, onCancel }: { draft: SkillDraft; onSave: (d: Omit<SkillDraft, 'flags' | 'icon'>) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState({ name: draft.name, title: draft.title, description: draft.description, argsHint: draft.argsHint, body: draft.body });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <div className="improve-editor">
      <div className="form-grid">
        <div className="field">
          <label>名字（用 /名字 调用）</label>
          <input className="input mono" value={d.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label>标题</label>
          <input className="input" value={d.title} onChange={set('title')} />
        </div>
      </div>
      <div className="field">
        <label>什么时候用</label>
        <input className="input" value={d.description} onChange={set('description')} />
      </div>
      <div className="field">
        <label>参数提示</label>
        <input className="input" value={d.argsHint} onChange={set('argsHint')} />
      </div>
      <div className="field">
        <label>技能内容（用 {'{{args}}'} 表示调用时给的参数）</label>
        <textarea className="textarea tall mono" value={d.body} onChange={set('body')} />
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn sm primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await onSave(d);
            setSaving(false);
          }}
        >
          {saving ? <span className="spinner tiny" /> : null} 保存修改
        </button>
      </div>
    </div>
  );
}

const lines = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '');

/** Editing a proposed change to a bot's setting: the same kind of control the bot's settings use. */
function SettingEditor({ item, onSave, onCancel }: { item: Improvement; onSave: (value: unknown) => Promise<void>; onCancel: () => void }) {
  const field = item.field;
  const [value, setValue] = useState<unknown>(item.after);
  const [text, setText] = useState(lines(item.after));
  const [saving, setSaving] = useState(false);
  const isList = field === 'allowRules' || field === 'askRules' || field === 'editScope';
  const next = isList
    ? text
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
    : value;
  // Same as the bot has now (an unset switch is off): nothing to accept, so nothing to save.
  const unchanged = typeof next === 'boolean' ? !!item.before === next : JSON.stringify(next ?? null) === JSON.stringify(item.before ?? null);
  let control: ReactNode;
  if (field === 'description') control = <textarea className="textarea tall" value={String(value ?? '')} onChange={(e) => setValue(e.target.value)} />;
  else if (field === 'model') control = <ModelPicker value={String(value ?? '')} onChange={setValue} />;
  else if (field === 'effort')
    control = (
      <select className="select" value={String(value ?? '')} onChange={(e) => setValue(e.target.value as Effort)}>
        {EFFORT_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  else if (field === 'permission')
    control = (
      <select className="select" value={String(value)} onChange={(e) => setValue(e.target.value as PermissionLevel)}>
        {(Object.keys(PERMISSION_INFO) as PermissionLevel[]).map((k) => (
          <option key={k} value={k}>
            {PERMISSION_INFO[k].label}
          </option>
        ))}
      </select>
    );
  else if (isList) control = <textarea className="textarea mono" rows={5} value={text} placeholder="每行一条" onChange={(e) => setText(e.target.value)} />;
  else if (field === 'freshSession')
    control = (
      <div className="setting-row">
        <span>每轮从新会话开始</span>
        <Toggle on={!!value} onChange={setValue} />
      </div>
    );
  else
    control = (
      <input
        className="input num-input"
        type="number"
        min={0}
        step={1}
        value={value === null || value === undefined ? '' : String(value)}
        placeholder="不限"
        onChange={(e) => setValue(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
      />
    );
  return (
    <div className="improve-editor">
      <div className="field">
        <label>改成</label>
        {control}
      </div>
      {unchanged && <div className="hint">这样就和现在一样了；不想改的话，直接拒绝这条建议就行。</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn sm" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn sm primary"
          disabled={saving || unchanged}
          onClick={async () => {
            setSaving(true);
            await onSave(next);
            setSaving(false);
          }}
        >
          {saving ? <span className="spinner tiny" /> : null} 保存修改
        </button>
      </div>
    </div>
  );
}

/**
 * Where Crew got in the way lately, grouped by cause, with a button that hands the report to a
 * group working on Crew's own code. Nothing is sent until the user picks the group and clicks.
 */
function FrictionReportView() {
  const [days, setDays] = useState(7);
  const [report, setReport] = useState<FrictionReport | null>(null);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [sending, setSending] = useState(false);
  const chats = useStore((s) => s.chats);
  const bots = useStore((s) => s.bots);
  const groups = Object.values(chats).filter((c) => c.kind === 'group' && c.leadBotId && bots[c.leadBotId]);

  useEffect(() => {
    if (!open) return;
    api
      .friction(days)
      .then(setReport)
      .catch((e) => toast('读取摩擦报告失败', (e as Error).message, 'error'));
  }, [open, days]);

  const send = async () => {
    const chat = chats[target];
    const lead = chat?.leadBotId ? bots[chat.leadBotId] : undefined;
    if (!report?.brief || !chat || !lead) return;
    setSending(true);
    try {
      await api.send(chat.id, report.brief.replace('{lead}', lead.name), []);
      toast(`已交给「${chat.title}」`, `${lead.name} 会挑一条来修`, 'success');
      openChat(chat.id);
    } catch (e) {
      toast('发送失败', (e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="friction">
      <button className="link-btn improve-toggle friction-toggle" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={cx('chev', open && 'open')} /> 摩擦报告：Crew 哪里碍事了
      </button>
      {open && (
        <div className="friction-body">
          <div className="row wrap">
            <span className="hint">最近</span>
            {[7, 14, 30].map((d) => (
              <button key={d} className={cx('btn sm', days === d && 'primary')} onClick={() => setDays(d)}>
                {d} 天
              </button>
            ))}
          </div>
          {!report && <span className="spinner tiny" />}
          {report && !report.kinds.length && <div className="muted improve-empty">这段时间没有记录到摩擦。</div>}
          {report?.kinds.map((k) => (
            <div key={k.kind} className="friction-kind">
              <div className="sr-title">
                {k.label} <span className="badge">{k.count}</span>
              </div>
              {k.groups.map((g) => (
                <div key={g.key} className="friction-group">
                  <span className="mono">{g.key}</span> <span className="muted">× {g.count}</span>
                  {g.examples[0] && (
                    <div className="hint">
                      {g.examples[0].detail}
                      {g.examples[0].chatId && chats[g.examples[0].chatId] && (
                        <>
                          {' '}
                          <button className="link-btn" onClick={() => openChat(g.examples[0].chatId!)}>
                            打开「{chats[g.examples[0].chatId].title}」
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {report && report.kinds.length > 0 && (
            <div className="row wrap">
              <select className="input sm" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">选一个负责修 Crew 的群聊…</option>
                {groups.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}（{bots[c.leadBotId!].name} 负责）
                  </option>
                ))}
              </select>
              <button className="btn sm primary" disabled={!target || sending} onClick={send} title="把报告发给这个群的负责人，让小队挑一条来修；合并、打包、重启仍然由你来">
                交给小队去修
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
