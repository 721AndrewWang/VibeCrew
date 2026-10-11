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
  description: 'role description',
  model: 'model',
  effort: 'effort',
  permission: 'permission level',
  allowRules: 'auto-allow rules',
  askRules: 'always-ask rules',
  editScope: 'editable paths',
  freshSession: 'fresh session per turn',
  monthlyBudgetUsd: 'monthly budget',
  skill: 'new skill',
};

const STATUS_LABEL: Record<Improvement['status'], string> = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected', reverted: 'Reverted', stale: 'Outdated' };

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '(default)' : typeof v === 'string' ? v : JSON.stringify(v));

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
      const cost = r.costUsd ? ` (cost ${fmtUsd(r.costUsd)})` : '';
      if (r.added.length)
        toast(
          `${r.added.length} new suggestion${r.added.length === 1 ? '' : 's'}${cost}`,
          r.dropped.length ? `${r.dropped.length} more failed the checks: ${r.dropped.join('; ')}` : undefined,
          'success',
        );
      else toast(`Nothing worth changing this time${cost}`, r.dropped.length ? `Failed the checks: ${r.dropped.join('; ')}` : 'No recurring problems in how the bots did lately.', 'info');
      load();
    } catch (e) {
      toast('Analysis failed', (e as Error).message, 'error');
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
        <h2>Suggested improvements</h2>
        <span className="spacer" />
        <button
          className="btn sm"
          disabled={running}
          onClick={run}
          title="Reads recent turns, costs, refutation results and your approvals, and proposes up to 3 small changes (uses Sonnet, about $0.05–0.15)"
        >
          {running ? <span className="spinner tiny" /> : <Lightbulb size={13} />} Analyze recent performance
        </button>
      </div>
      <div className="hint improve-hint">
        Each one changes a single setting on one bot, backed by real turns as evidence. You decide whether to accept it; once accepted, you can compare before and after, or revert it.
      </div>
      {pending.map((i) => (
        <ProposalCard key={i.id} item={i} onDone={load} />
      ))}
      {items && !pending.length && <div className="muted improve-empty">No pending suggestions right now.</div>}
      <SkillCandidates onDrafted={load} />
      <FrictionReportView />
      {done.length > 0 && (
        <>
          <button className="link-btn improve-toggle" onClick={() => setShowDone(!showDone)}>
            <ChevronRight size={12} className={cx('chev', showDone && 'open')} /> {done.length} handled
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
              <div key={f}>Note: {f}</div>
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
      toast('Action failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="improve-item">
      <div className="improve-title">
        <b>{item.botName}</b>: {FIELD_LABEL[item.field]}
      </div>
      {editing && item.field !== 'skill' ? (
        <SettingEditor
          item={item}
          onCancel={() => setEditing(false)}
          onSave={async (value) => {
            try {
              await api.editImprovement(item.id, { value });
              toast('Suggestion updated', 'Review it before accepting', 'success');
              setEditing(false);
              onDone();
            } catch (e) {
              toast("Couldn't save changes", (e as Error).message, 'error');
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
              toast('Draft updated', 'Safety checks ran again. Review it before accepting', 'success');
              setEditing(false);
              onDone();
            } catch (e) {
              toast("Couldn't save changes", (e as Error).message, 'error');
            }
          }}
        />
      ) : (
        <Change item={item} />
      )}
      {item.original !== undefined && (
        <div className="hint">
          {item.field === 'skill'
            ? 'You edited this draft. If you accept it, future skill drafts will learn from your edits.'
            : `You edited this suggestion (the model originally proposed ${show(item.original)}). The next analysis will learn from your edit.`}
        </div>
      )}
      <div className="improve-why">{item.rationale}</div>
      {item.expected && <div className="hint">Expected: {item.expected}</div>}
      <div className="improve-evidence">
        {item.evidence.map((e) => (
          <button key={e.messageId} className="link-btn" onClick={() => openChat(e.chatId)} title="Open this chat">
            {e.note || 'View this turn'}
          </button>
        ))}
      </div>
      {rejecting ? (
        <div className="row">
          <input className="input" autoFocus placeholder="Why not? (optional, used by the next analysis)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm danger solid" disabled={busy} onClick={() => act(() => api.rejectImprovement(item.id, note), 'Rejected')}>
            Reject
          </button>
          <button className="btn sm" onClick={() => setRejecting(false)}>
            Back
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="btn sm primary" disabled={busy} onClick={() => act(() => api.acceptImprovement(item.id), `Applied to ${item.botName}`)}>
            <Check size={13} /> Accept
          </button>
          <button className="btn sm" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> Reject
          </button>
          {!editing && (
            <button className="btn sm" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={13} /> Edit
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
      toast(`Reverted this change to ${item.botName}`, undefined, 'success');
    } catch (e) {
      toast('Revert failed', (e as Error).message, 'error');
    }
    onDone();
  };
  return (
    <div className="improve-row">
      <span className={cx('badge', item.status === 'accepted' && 'accent')}>{STATUS_LABEL[item.status]}</span>
      <span>
        {item.botName}: {FIELD_LABEL[item.field]}: {show(item.after).slice(0, 60)}
        {item.decidedAt ? ` · ${fmtWhen(item.decidedAt)}` : ''}
        {item.note ? ` · You said: ${item.note}` : ''}
      </span>
      <span className="spacer" />
      {effect && (
        <span className="muted improve-effect" title="Compared with the same number of turns before the change">
          {effect.after.turns
            ? `${effect.after.turns} turn${effect.after.turns === 1 ? '' : 's'} since: avg ${fmtUsd(effect.after.avgCostUsd)}, before ${fmtUsd(effect.before.avgCostUsd)}${effect.after.refuted || effect.before.refuted ? `; refuted ${effect.before.refuted}→${effect.after.refuted}` : ''}`
            : 'No turns since'}
        </span>
      )}
      {item.status === 'accepted' && (
        <button className="btn sm ghost" onClick={revert} title="Change this setting back">
          <RotateCcw size={12} /> Revert
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
      const cost = r.costUsd ? ` (cost ${fmtUsd(r.costUsd)})` : '';
      if ('skipped' in r) toast(`No draft written${cost}`, r.skipped, 'info');
      else toast(`Draft ready${cost}`, "It's in the suggestions above. Review it before deciding", 'success');
      onDrafted();
    } catch (e) {
      toast('Drafting failed', (e as Error).message, 'error');
    } finally {
      setBusy(null);
      load();
    }
  };
  return (
    <div className="improve-candidates">
      <div className="hint">
        These turns did a lot, finished cleanly, and held up under adversarial review. You can turn the approach into a skill (about $0.02–0.05 each; nothing is saved until you accept it):
      </div>
      {list.map((c) => (
        <div key={c.messageId} className="improve-row">
          <span>
            {c.botName} in &quot;{c.chatTitle}&quot;: {c.ask || '(no request recorded)'}
          </span>
          <span className="spacer" />
          <span className="muted">
            {c.tools} tool call{c.tools === 1 ? '' : 's'}
          </span>
          <button className="btn sm" disabled={!!busy} onClick={() => draft(c)}>
            {busy === c.messageId ? <span className="spinner tiny" /> : null} Draft a skill
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
          <label>Name (invoke with /name)</label>
          <input className="input mono" value={d.name} onChange={set('name')} />
        </div>
        <div className="field">
          <label>Title</label>
          <input className="input" value={d.title} onChange={set('title')} />
        </div>
      </div>
      <div className="field">
        <label>When to use</label>
        <input className="input" value={d.description} onChange={set('description')} />
      </div>
      <div className="field">
        <label>Argument hint</label>
        <input className="input" value={d.argsHint} onChange={set('argsHint')} />
      </div>
      <div className="field">
        <label>Skill content ({'{{args}}'} stands for the arguments given when invoked)</label>
        <textarea className="textarea tall mono" value={d.body} onChange={set('body')} />
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn sm" onClick={onCancel}>
          Cancel
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
          {saving ? <span className="spinner tiny" /> : null} Save changes
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
  else if (isList) control = <textarea className="textarea mono" rows={5} value={text} placeholder="One per line" onChange={(e) => setText(e.target.value)} />;
  else if (field === 'freshSession')
    control = (
      <div className="setting-row">
        <span>Start each turn in a fresh session</span>
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
        placeholder="No limit"
        onChange={(e) => setValue(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
      />
    );
  return (
    <div className="improve-editor">
      <div className="field">
        <label>Change to</label>
        {control}
      </div>
      {unchanged && <div className="hint">This is the same as now. If you don't want a change, just reject the suggestion.</div>}
      <div className="row">
        <span className="spacer" />
        <button className="btn sm" onClick={onCancel}>
          Cancel
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
          {saving ? <span className="spinner tiny" /> : null} Save changes
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
      .catch((e) => toast("Couldn't load the friction report", (e as Error).message, 'error'));
  }, [open, days]);

  const send = async () => {
    const chat = chats[target];
    const lead = chat?.leadBotId ? bots[chat.leadBotId] : undefined;
    if (!report?.brief || !chat || !lead) return;
    setSending(true);
    try {
      await api.send(chat.id, report.brief.replace('{lead}', lead.name), []);
      toast(`Handed to "${chat.title}"`, `${lead.name} will pick one to fix`, 'success');
      openChat(chat.id);
    } catch (e) {
      toast('Send failed', (e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="friction">
      <button className="link-btn improve-toggle friction-toggle" onClick={() => setOpen(!open)}>
        <ChevronRight size={12} className={cx('chev', open && 'open')} /> Friction report: where Crew got in the way
      </button>
      {open && (
        <div className="friction-body">
          <div className="row wrap">
            <span className="hint">Last</span>
            {[7, 14, 30].map((d) => (
              <button key={d} className={cx('btn sm', days === d && 'primary')} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
          {!report && <span className="spinner tiny" />}
          {report && !report.kinds.length && <div className="muted improve-empty">No friction recorded in this period.</div>}
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
                            Open &quot;{chats[g.examples[0].chatId].title}&quot;
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
                <option value="">Pick a group chat that fixes Crew…</option>
                {groups.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} (led by {bots[c.leadBotId!].name})
                  </option>
                ))}
              </select>
              <button
                className="btn sm primary"
                disabled={!target || sending}
                onClick={send}
                title="Sends the report to this group's lead so the team picks one to fix. Merging, building and restarting stay with you"
              >
                Hand to the team to fix
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
