import { Link2, Network, Radio, Save, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FilteredSource, RecallSettings, RouterSettings, SourceMode, SpeculativeSettings, SuperAgentSettings, WatchdogSettings } from '../../../../../shared/types';
import { api } from '../../../api';
import { listProjects, setView, toast, useStore } from '../../../store';
import { cx, gatewayOptions, toggled } from '../../../utils';
import { SIGNAL_LABEL, SPECULATION_STATUS } from '../../SpeculativeBar';
import { Toggle } from '../../ui';
import { Section } from './Section';

const SOURCES: { id: FilteredSource; title: string; hint: string; allowHint: string; placeholder: string }[] = [
  {
    id: 'preview-console',
    title: 'Preview console errors',
    hint: "Errors the preview's page logs while you have it open. Warnings, dev-server chatter and the favicon never count.",
    allowHint: 'Substrings of the error text, one per line',
    placeholder: 'e.g.\nTypeError\nFailed to fetch',
  },
  {
    id: 'turn',
    title: 'Bot turn results',
    hint: 'How each bot turn ended. A handoff to a teammate is an explicit request; only failed turns can become candidates.',
    allowHint: 'Substrings of the error text, one per line',
    placeholder: 'e.g.\nbudget\nnot logged in',
  },
  {
    id: 'outside-edit',
    title: 'Files changed outside the chat',
    hint: 'Edits made by hand, in another editor, or by git, while no bot was working. The note in the chat is posted either way.',
    allowHint: 'Path globs relative to the project, one per line',
    placeholder: 'e.g.\npackage.json\nsrc/**\n**/*.config.*',
  },
];

const MODES: { id: SourceMode; label: string; title: string }[] = [
  { id: 'candidate', label: 'Candidate', title: 'What passes the rules and the allow-list goes to the cheap model, which decides from your policies' },
  { id: 'explicit', label: 'Explicit only', title: 'Act only on explicit requests; everything else is recorded as dropped' },
  { id: 'ignore', label: 'Ignore', title: 'Not recorded at all' },
];

interface Form {
  sources: Record<FilteredSource, { mode: SourceMode; allow: string }>;
  projects: string[];
  policies: string;
  maxCandidatesPerHour: number;
}

function toForm(s: SuperAgentSettings): Form {
  const sources = {} as Form['sources'];
  for (const { id } of SOURCES) sources[id] = { mode: s.sources[id].mode, allow: s.sources[id].allow.join('\n') };
  return { sources, projects: s.projects, policies: s.policies, maxCandidatesPerHour: s.maxCandidatesPerHour };
}

function fromForm(f: Form): Omit<SuperAgentSettings, 'enabled' | 'router' | 'recall' | 'watchdog' | 'speculative'> {
  const sources = {} as SuperAgentSettings['sources'];
  for (const { id } of SOURCES) {
    sources[id] = {
      mode: f.sources[id].mode,
      allow: f.sources[id].allow
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
    };
  }
  return { sources, projects: f.projects, policies: f.policies, maxCandidatesPerHour: f.maxCandidatesPerHour };
}

/** The event-driven core: on/off, the fast path's rules per source, and the slow path's policies. */
export function SuperAgentSection() {
  const saved = useStore((s) => s.settings.superAgent);
  const projects = useStore((s) => s.projects);
  const [form, setForm] = useState(() => toForm(saved));
  const [saving, setSaving] = useState(false);
  const enabled = saved.enabled;
  const dirty = JSON.stringify(fromForm(form)) !== JSON.stringify(fromForm(toForm(saved)));

  const save = async (patch: Partial<SuperAgentSettings>, done?: string) => {
    setSaving(true);
    try {
      const r = await api.updateSettings({ superAgent: patch });
      useStore.setState({ settings: r.settings });
      // The server cleans lists up (blank lines, duplicates): show what it kept.
      if (patch.sources) setForm(toForm(r.settings.superAgent));
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const setSource = (id: FilteredSource, p: Partial<Form['sources'][FilteredSource]>) => setForm({ ...form, sources: { ...form.sources, [id]: { ...form.sources[id], ...p } } });
  const toggleProject = (id: string) => setForm({ ...form, projects: toggled(form.projects, id) });

  return (
    <Section
      icon={<Radio size={18} />}
      title="Super-agent (preview)"
      extra={
        enabled ? (
          <button className="btn ghost sm" onClick={() => setView('triggers')}>
            Open Triggers
          </button>
        ) : undefined
      }
    >
      <div className="setting-row">
        <div>
          <div className="sr-title">Watch events and filter them</div>
          <div className="hint">
            Every message, routine run, turn result, outside edit and preview console error becomes a trigger in a thread. Rules in code settle most of them; what is left goes to Haiku (about $0.002
            per batch), which decides from your policies below. Acting means a short note for you in the chat (with the Router on, an event for the chat's Router, which can tell you but cannot start
            work for it); nothing runs on its own. Off: Crew works exactly as before.
          </div>
        </div>
        <Toggle on={enabled} onChange={(v) => void save({ enabled: v }, v ? 'Super-agent on' : 'Super-agent off')} />
      </div>
      {enabled && (
        <>
          <div className="setting-row">
            <div>
              <div className="sr-title">Your messages and routine runs</div>
              <div className="hint">Always explicit requests: recorded, and handled by the chat as before.</div>
            </div>
          </div>
          {SOURCES.map((s) => (
            <div key={s.id} className="trigger-source-rule" data-source={s.id}>
              <div className="setting-row">
                <div>
                  <div className="sr-title">{s.title}</div>
                  <div className="hint">{s.hint}</div>
                </div>
                <span className="segmented">
                  {MODES.map((m) => (
                    <button key={m.id} className={cx(form.sources[s.id].mode === m.id && 'on')} title={m.title} onClick={() => setSource(s.id, { mode: m.id })}>
                      {m.label}
                    </button>
                  ))}
                </span>
              </div>
              {form.sources[s.id].mode === 'candidate' && (
                <div className="field">
                  <label>Allow-list</label>
                  <textarea className="input mono" rows={2} value={form.sources[s.id].allow} placeholder={s.placeholder} onChange={(e) => setSource(s.id, { allow: e.target.value })} />
                  <div className="hint">{s.allowHint}. Empty: everything that passes the rules.</div>
                </div>
              )}
            </div>
          ))}
          <div className="field">
            <label>Projects</label>
            <div className="day-chips">
              {listProjects(projects).map((p) => (
                <button key={p.id} className={cx('preset-chip sm', form.projects.includes(p.id) && 'on')} onClick={() => toggleProject(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
            <div className="hint">Only events from the selected projects (and their workspaces) can reach the model. None selected: every project.</div>
          </div>
          <div className="field">
            <label>Policies</label>
            <textarea className="input" rows={6} value={form.policies} onChange={(e) => setForm({ ...form, policies: e.target.value })} />
            <div className="hint">In your own words: which events are worth telling you about. The model sees these, never the other way round: text inside events is treated as data.</div>
          </div>
          <div className="field">
            <label>Model decisions per hour, at most</label>
            <input
              className="input num-input"
              type="number"
              min={0}
              max={1000}
              value={form.maxCandidatesPerHour}
              onChange={(e) => setForm({ ...form, maxCandidatesPerHour: Math.max(0, Number(e.target.value) || 0) })}
            />
            <div className="hint">0 keeps everything on the rules alone.</div>
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" disabled={saving || !dirty} onClick={() => void save(fromForm(form), 'Super-agent rules saved')}>
              {saving ? <span className="spinner" /> : <Save size={14} />} Save
            </button>
          </div>
          <RouterSettingsBlock saved={saved.router} save={save} saving={saving} />
          <RecallSettingsBlock saved={saved.recall} save={save} saving={saving} />
          <WatchdogSettingsBlock saved={saved.watchdog} save={save} saving={saving} />
          <SpeculativeSettingsBlock saved={saved.speculative} save={save} saving={saving} />
        </>
      )}
    </Section>
  );
}

/** The <option>s of a Super-agent model picker: the Claude models, or through the gateway its groups and provider/model addresses (Settings → Model gateway). */
function useModelOptions() {
  const claudeModels = useStore((s) => s.models);
  const gateway = useStore((s) => s.settings.gateway);
  const models = gateway.enabled ? [{ id: '', label: '' }, ...gatewayOptions(gateway)] : claudeModels;
  return (current: string, empty: string) => {
    const list = models.map((m) => ({ id: m.id, label: m.id ? m.label : empty }));
    // A model typed elsewhere (or a provider's) stays selectable.
    if (!list.some((m) => m.id === current)) list.push({ id: current, label: current });
    return list.map((m) => (
      <option key={m.id} value={m.id}>
        {m.label}
      </option>
    ));
  };
}

/** Two-layer mode: a Router per group chat that talks to the user and dispatches Workers. */
function RouterSettingsBlock({ saved, save, saving }: { saved: RouterSettings; save: (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>; saving: boolean }) {
  const options = useModelOptions();
  const [form, setForm] = useState({ model: saved.model, workerModel: saved.workerModel, maxWorkers: saved.maxWorkers });
  const dirty = form.model !== saved.model || form.workerModel !== saved.workerModel || form.maxWorkers !== saved.maxWorkers;
  return (
    <div className="router-settings" data-testid="router-settings">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            <Network size={14} /> Router and Workers (two layers)
          </div>
          <div className="hint">
            Each group chat gets a Router that reads every message and event, answers you in a few words, and dispatches Workers. Each Worker does one task in its own session and its own git worktree,
            as one of the chat's members (with its permissions and editable paths), and reports back to the Router; its changes are merged into the chat's branch. The chat stays free while they work.
            Direct chats are not affected. Off: the lead does everything, as before.
          </div>
        </div>
        <Toggle on={saved.enabled} onChange={(v) => void save({ router: { ...saved, enabled: v } }, v ? 'Router and Workers on' : 'Router and Workers off')} />
      </div>
      {saved.enabled && (
        <>
          <div className="setting-row" data-testid="router-subscriptions">
            <div>
              <div className="sr-title">Direct routing to Workers</div>
              <div className="hint">
                Each Worker subscribes to the threads it works on: the chat's workspace and the routine it was dispatched for. Later events there (the routine's next runs, other Workers' merges, files
                edited by hand, preview console errors) go straight to those Workers without a Router call; the Router still sees them, and a Worker can hand one back. Events from the environment only
                reach Workers that are already working; they never start work. Off: every event goes through the Router.
              </div>
            </div>
            <Toggle on={saved.subscriptions} onChange={(v) => void save({ router: { ...saved, subscriptions: v } }, v ? 'Direct routing on' : 'Direct routing off')} />
          </div>
          <div className="field">
            <label>Router model</label>
            <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {options(form.model, 'Claude Code default')}
            </select>
            <div className="hint">It routes and writes short replies; a lighter model is usually enough.</div>
          </div>
          <div className="field">
            <label>Worker model</label>
            <select className="input" value={form.workerModel} onChange={(e) => setForm({ ...form, workerModel: e.target.value })}>
              {options(form.workerModel, 'The default model (strongest)')}
            </select>
            <div className="hint">Workers do the actual work. A chat's own model switch, when set, takes precedence.</div>
          </div>
          <div className="field">
            <label>Workers at once, per chat</label>
            <input
              className="input num-input"
              type="number"
              min={1}
              max={8}
              value={form.maxWorkers}
              onChange={(e) => setForm({ ...form, maxWorkers: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
            />
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" disabled={saving || !dirty} onClick={() => void save({ router: { ...saved, ...form } }, 'Router settings saved')}>
              {saving ? <span className="spinner" /> : <Save size={14} />} Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Inline & Spill context and the recall tool (ADR 005). */
function RecallSettingsBlock({ saved, save, saving }: { saved: RecallSettings; save: (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>; saving: boolean }) {
  const [words, setWords] = useState(saved.inlineWords);
  return (
    <div className="router-settings" data-testid="recall-settings">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            <Link2 size={14} /> Chain of recall (Inline &amp; Spill)
          </div>
          <div className="hint">
            Prompts carry the id of every message, trigger, thread and Worker they mention. What is next to the current turn is sent generously, everything else only its first words, and the rest
            stays behind its id; bots and Routers read it with a recall tool that also lists the ids of related objects, so they can follow a trigger to its thread and its Workers. It replaces
            chat_history. Usually fewer tokens per call, sometimes an extra lookup. Off: prompts are built as before.
          </div>
        </div>
        <Toggle on={saved.enabled} onChange={(v) => void save({ recall: { ...saved, enabled: v } }, v ? 'Chain of recall on' : 'Chain of recall off')} />
      </div>
      {saved.enabled && (
        <>
          <div className="field">
            <label>Words inlined before the rest spills</label>
            <input className="input num-input" type="number" min={20} max={200} value={words} onChange={(e) => setWords(Math.max(20, Math.min(200, Number(e.target.value) || 20)))} />
            <div className="hint">For anything not next to the current turn: older messages, Worker reports, recalled objects. The latest message and the user&apos;s words get more.</div>
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" disabled={saving || words === saved.inlineWords} onClick={() => void save({ recall: { ...saved, inlineWords: words } }, 'Recall settings saved')}>
              {saving ? <span className="spinner" /> : <Save size={14} />} Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const WATCHDOG_LIMITS: { key: keyof Omit<WatchdogSettings, 'enabled' | 'model'>; label: string; min: number; max: number; step?: number; hint: string }[] = [
  { key: 'everyMinutes', label: 'Tick every (minutes)', min: 1, max: 60, hint: 'A tick with nothing flagged by the rules costs nothing: no model is called.' },
  { key: 'maxTicksPerHour', label: 'Ticks that call the model, per hour at most', min: 1, max: 60, hint: 'The rest are skipped and recorded.' },
  { key: 'maxActionsPerTick', label: 'Actions per tick at most', min: 0, max: 10, hint: '0 lets it look and explain, but never act.' },
  { key: 'dailyBudgetUsd', label: 'Budget per day (USD)', min: 0, max: 100, step: 0.1, hint: 'Ticks and your questions together; past it the Watchdog waits for tomorrow.' },
  { key: 'stuckMinutes', label: 'Flag a Worker as stuck after (minutes)', min: 5, max: 240, hint: 'No tool call or other progress for this long.' },
];

/** The Watchdog: a timer-driven session outside the chats that checks Workers and errors, within hard limits. */
function WatchdogSettingsBlock({ saved, save, saving }: { saved: WatchdogSettings; save: (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>; saving: boolean }) {
  const options = useModelOptions();
  const [form, setForm] = useState(saved);
  const dirty = JSON.stringify({ ...form, enabled: saved.enabled }) !== JSON.stringify(saved);
  return (
    <div className="router-settings" data-testid="watchdog-settings">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            <ShieldCheck size={14} /> Watchdog
          </div>
          <div className="hint">
            An independent session on a timer. Each tick, rules in code look at the Workers (progress, repeated tool calls, failures), approvals waiting for you, turn errors, friction and interface
            errors; only when something is flagged does the Watchdog's model look. It can nudge, stop or restart a Worker and tell a chat, and it re-checks transient failures until they heal. It never
            does the work, never answers approvals, and only proposes changes to policies or prompts. Off: nothing runs.
          </div>
        </div>
        <Toggle on={saved.enabled} onChange={(v) => void save({ watchdog: { ...saved, enabled: v } }, v ? 'Watchdog on' : 'Watchdog off')} />
      </div>
      {saved.enabled && (
        <>
          <div className="field">
            <label>Watchdog model</label>
            <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
              {options(form.model, 'Claude Code default')}
            </select>
            <div className="hint">It judges and steers; a lighter model is usually enough. With the model gateway on, its watchdog route (if set) takes precedence.</div>
          </div>
          {WATCHDOG_LIMITS.map((l) => (
            <div className="field" key={l.key}>
              <label>{l.label}</label>
              <input
                className="input num-input"
                type="number"
                data-limit={l.key}
                min={l.min}
                max={l.max}
                step={l.step ?? 1}
                value={form[l.key]}
                onChange={(e) => setForm({ ...form, [l.key]: Math.max(l.min, Math.min(l.max, Number(e.target.value) || 0)) })}
              />
              <div className="hint">{l.hint}</div>
            </div>
          ))}
          <div className="row">
            <button className="btn ghost sm" onClick={() => setView('watchdog')}>
              Open Watchdog
            </button>
            <span className="spacer" />
            <button className="btn primary" disabled={saving || !dirty} onClick={() => void save({ watchdog: { ...form, enabled: saved.enabled } }, 'Watchdog settings saved')}>
              {saving ? <span className="spinner" /> : <Save size={14} />} Save
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const SPECULATIVE_LIMITS: { key: keyof Omit<SpeculativeSettings, 'model'>; label: string; min: number; max: number; step?: number; hint: string }[] = [
  { key: 'dailyBudgetUsd', label: 'Budget per day (USD)', min: 0, max: 100, step: 0.1, hint: "What today's runs may cost, across projects; past it, signals are skipped until tomorrow." },
  { key: 'maxConcurrent', label: 'Runs at once, at most', min: 1, max: 4, hint: 'Across projects; never more than one per project. Each is a full session and a worktree.' },
  { key: 'maxMinutes', label: 'Stop a run after (minutes)', min: 5, max: 120, hint: 'A run still working then is stopped and discarded.' },
];

/** Speculative execution (ADR 008): the limits all projects share, and what recent runs came to. Each project has its own switch. */
function SpeculativeSettingsBlock({ saved, save, saving }: { saved: SpeculativeSettings; save: (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>; saving: boolean }) {
  const options = useModelOptions();
  const [form, setForm] = useState(saved);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const live = useStore((s) => s.speculations);
  const projects = useStore((s) => s.projects);
  const [spent, setSpent] = useState<number | null>(null);
  // Read again when a run changes state or cost (not on every store update: the fetch below updates it too).
  const changes = Object.values(live)
    .map((x) => `${x.id}:${x.status}:${x.costUsd}`)
    .join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: today's spend is read again whenever a run changes
  useEffect(() => {
    api.speculations().then(
      (r) => {
        setSpent(r.spentTodayUsd);
        useStore.setState((s) => ({ speculations: { ...Object.fromEntries(r.speculations.map((x) => [x.id, x])), ...s.speculations } }));
      },
      () => setSpent(null),
    );
  }, [changes]);
  const recent = useMemo(
    () =>
      Object.values(live)
        .sort((a, b) => b.at - a.at)
        .slice(0, 20),
    [live],
  );
  const optedIn = listProjects(projects).filter((p) => p.speculative?.enabled);
  return (
    <div className="router-settings" data-testid="speculative-settings">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            <Sparkles size={14} /> Speculative runs (silent reproduce-and-fix)
          </div>
          <div className="hint">
            When a check fails, the preview logs an error, or you describe a problem without asking for the fix yet, fixed rules may start a background Worker in a throwaway worktree that tries to
            reproduce it and find a small fix. Crew then runs the project's check command itself: only a fix that passes it, and without which it fails, is shown in the chat with its diff and a
            one-click merge. Anything else is thrown away without a word. Each project turns this on in its own settings
            {optedIn.length ? ` (on now: ${optedIn.map((p) => p.name).join(', ')})` : ' (none has yet)'}.
          </div>
        </div>
      </div>
      <div className="field">
        <label>Model for speculative runs</label>
        <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {options(form.model, "The Workers' model")}
        </select>
        <div className="hint">With the model gateway on, its speculative route and spend windows apply.</div>
      </div>
      {SPECULATIVE_LIMITS.map((l) => (
        <div className="field" key={l.key}>
          <label>{l.label}</label>
          <input
            className="input num-input"
            type="number"
            data-limit={l.key}
            min={l.min}
            max={l.max}
            step={l.step ?? 1}
            value={form[l.key]}
            onChange={(e) => setForm({ ...form, [l.key]: Math.max(l.min, Math.min(l.max, Number(e.target.value) || 0)) })}
          />
          <div className="hint">{l.hint}</div>
        </div>
      ))}
      <div className="row">
        <span className="muted">{spent === null ? '' : `Spent today: $${spent.toFixed(2)} of $${saved.dailyBudgetUsd.toFixed(2)}`}</span>
        <span className="spacer" />
        <button className="btn primary" disabled={saving || !dirty} onClick={() => void save({ speculative: form }, 'Speculative run settings saved')}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
      {!!recent.length && (
        <div className="field">
          <label>Recent runs</label>
          <div className="audit-list spec-runs">
            {recent.map((sp) => (
              <div key={sp.id} className="audit-row" data-speculation={sp.id}>
                <span className="muted">{new Date(sp.at).toLocaleString()}</span>
                <span className={cx('badge', SPECULATION_STATUS[sp.status].cls)}>{SPECULATION_STATUS[sp.status].label}</span>
                <span>
                  <b>{SIGNAL_LABEL[sp.signal]}</b>: {sp.summary}
                  {sp.why && <div className="muted">{sp.why}</div>}
                </span>
              </div>
            ))}
          </div>
          <div className="hint">Kept for tuning: why a signal was skipped, or why a run was thrown away. None of this is shown in the chats.</div>
        </div>
      )}
    </div>
  );
}
