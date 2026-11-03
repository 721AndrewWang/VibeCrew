import { Link2, Network, Radio, Save, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { FilteredSource, RecallSettings, RouterSettings, SourceMode, SpeculativeSettings, SuperAgentSettings, WatchdogSettings } from '../../../../../shared/types';
import { api } from '../../../api';
import { listProjects, setView, toast, useStore } from '../../../store';
import { blockedBy, corePatch, fmtCost, PART, PARTS, type Part, type PartId, partAnchor, partPatch, SPECULATION_STATUS, type StatusInfo, switchOn } from '../../../superagent';
import { cx, gatewayOptions } from '../../../utils';
import { SIGNAL_LABEL } from '../../SpeculativeBar';
import { Field, goToPart, StatusBadge, SuperAgentPrimer } from '../../SuperAgentUi';
import { confirmDialog, Toggle } from '../../ui';
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

type SaveFn = (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>;

/** How many projects (or bots) have a per-project (per-bot) part on: the parts list says so next to the link. */
function useScopedCounts() {
  const projects = useStore((s) => s.projects);
  const bots = useStore((s) => s.bots);
  return useMemo(() => {
    const list = listProjects(projects);
    return {
      speculative: list.filter((p) => p.speculative?.enabled).length,
      github: list.filter((p) => p.github?.enabled).length,
      jobs: Object.values(bots).filter((b) => b.fullDuplex).length,
    } as Partial<Record<PartId, number>>;
  }, [projects, bots]);
}

/** One row of the parts list: what the part does, what it costs, what it needs, and its switch (or where its switch is). */
function PartRow({ part, save, saving }: { part: Part; save: SaveFn; saving: boolean }) {
  const settings = useStore((s) => s.settings);
  const counts = useScopedCounts();
  const on = switchOn(part.id, settings);
  const blocked = blockedBy(part.id, settings);
  const count = counts[part.id];
  const status: StatusInfo =
    part.scope === 'global' || part.scope === 'gateway'
      ? on
        ? blocked
          ? { label: `Waiting for ${blocked.name}`, tone: 'attention' }
          : { label: 'On', tone: 'ok' }
        : { label: 'Off', tone: 'neutral' }
      : count
        ? { label: `On in ${count} ${part.scope === 'bot' ? 'bot' : 'project'}${count === 1 ? '' : 's'}`, tone: blocked ? 'attention' : 'ok' }
        : { label: 'Off', tone: 'neutral' };
  const descId = `${partAnchor(part.id)}-desc`;
  return (
    <div className="sa-part" id={partAnchor(part.id)} data-part={part.id} role="listitem">
      <div className="sa-part-main">
        <div className="sa-part-name">
          {part.name} <StatusBadge status={status} />
        </div>
        <div className="hint" id={descId}>
          {part.does}
        </div>
        <div className="sa-part-cost">
          <b>Costs:</b> {part.cost(settings)}
        </div>
        {blocked && <div className="sa-part-cost">Needs {blocked.name} on first.</div>}
      </div>
      <div className="sa-part-side">
        {part.scope === 'global' ? (
          <Toggle
            label={part.name}
            on={on}
            disabled={saving || (!on && !!blocked)}
            title={!on && blocked ? `Turn on ${blocked.name} first` : undefined}
            onChange={(v) => void save(partPatch(part.id, v, settings), `${part.name} ${v ? 'on' : 'off'}`)}
          />
        ) : (
          <button className="btn sm" aria-describedby={descId} onClick={() => goToPart(part.id)}>
            {part.scope === 'project' ? 'Set up in Projects' : part.scope === 'bot' ? 'Set on a bot' : 'Open its settings'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings → Super-agent: what the mode is, every part with its switch and its cost, then each part's own settings. */
export function SuperAgentSection() {
  const settings = useStore((s) => s.settings);
  const saved = settings.superAgent;
  const [saving, setSaving] = useState(false);
  const enabled = saved.enabled;
  const anyOn = PARTS.some((p) => p.scope === 'global' && switchOn(p.id, settings));
  const coreOn = PARTS.filter((p) => p.core).every((p) => switchOn(p.id, settings));

  const save: SaveFn = async (patch, done) => {
    setSaving(true);
    try {
      const r = await api.updateSettings({ superAgent: patch });
      useStore.setState({ settings: r.settings });
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const turnOnCore = async () => {
    const core = PARTS.filter((p) => p.core);
    const ok = await confirmDialog({
      title: 'Turn on the core of Super-agent mode?',
      body: (
        <div className="sa-confirm">
          <p>This turns on {core.map((p) => p.name).join(', ')}. What it costs:</p>
          <ul>
            {core.map((p) => (
              <li key={p.id}>
                <b>{p.name}:</b> {p.cost(settings)}
              </li>
            ))}
          </ul>
          <p>The Watchdog, speculative fixes and the GitHub channel stay off until you turn them on. Anything sent in your name still waits as a draft for your approval.</p>
        </div>
      ),
      ok: 'Turn them on',
    });
    if (ok) await save(corePatch(settings), 'Super-agent core on');
  };
  const turnAllOff = async () => {
    const ok = await confirmDialog({
      title: 'Turn Super-agent mode off?',
      body: 'Routers and Workers stop, the Watchdog stops ticking and no new Trigger is recorded. Your settings below are kept for next time. Per-project parts stay as they are but do nothing while this is off.',
      ok: 'Turn it off',
      danger: true,
    });
    if (ok)
      await save(
        { enabled: false, router: { ...saved.router, enabled: false, subscriptions: false }, recall: { ...saved.recall, enabled: false }, watchdog: { ...saved.watchdog, enabled: false } },
        'Super-agent off',
      );
  };

  return (
    <Section
      icon={<Radio size={18} />}
      id="settings-superagent"
      title="Super-agent (preview)"
      extra={
        enabled ? (
          <span className="row">
            <button className="btn ghost sm" onClick={() => setView('activity')}>
              Open Activity
            </button>
            <button className="btn ghost sm" onClick={() => setView('triggers')}>
              Open Triggers
            </button>
          </span>
        ) : undefined
      }
    >
      <p className="hint sa-intro">
        Super-agent mode turns a group chat into one agent that takes events from anywhere, works on several tasks at once in the background and watches its own progress. It is a set of parts you turn
        on one by one; with all of them off Crew works exactly as before and makes no extra model call.
      </p>
      <details className="sa-howto" open={!anyOn}>
        <summary>How it works: Triggers, Router, Workers and the Watchdog</summary>
        <SuperAgentPrimer />
      </details>
      <div className="sa-quick">
        {!coreOn && (
          <button className="btn primary sm" disabled={saving} onClick={() => void turnOnCore()}>
            <Sparkles size={14} aria-hidden /> Turn on the core
          </button>
        )}
        {anyOn && (
          <button className="btn sm" disabled={saving} onClick={() => void turnAllOff()}>
            Turn everything off
          </button>
        )}
        <span className="hint">{coreOn ? 'The core is on. Add the other parts when you need them.' : 'The core is Triggers, Router and Workers, Direct routing and the Chain of recall.'}</span>
      </div>
      <div className="sa-parts" role="list" aria-label="Super-agent parts" data-testid="sa-parts">
        {PARTS.map((p) => (
          <PartRow key={p.id} part={p} save={save} saving={saving} />
        ))}
      </div>
      {enabled && <TriggerRulesBlock save={save} saving={saving} />}
      {saved.router.enabled && <RouterSettingsBlock saved={saved.router} save={save} saving={saving} />}
      {saved.recall.enabled && <RecallSettingsBlock saved={saved.recall} save={save} saving={saving} />}
      {saved.watchdog.enabled && <WatchdogSettingsBlock saved={saved.watchdog} save={save} saving={saving} />}
      {enabled && <SpeculativeSettingsBlock saved={saved.speculative} save={save} saving={saving} />}
    </Section>
  );
}

/** Triggers: the fast path's rules per source, and the slow path's policies and budget. */
function TriggerRulesBlock({ save, saving }: { save: SaveFn; saving: boolean }) {
  const saved = useStore((s) => s.settings.superAgent);
  const projects = useStore((s) => s.projects);
  const [form, setForm] = useState(() => toForm(saved));
  const dirty = JSON.stringify(fromForm(form)) !== JSON.stringify(fromForm(toForm(saved)));
  const setSource = (id: FilteredSource, p: Partial<Form['sources'][FilteredSource]>) => setForm({ ...form, sources: { ...form.sources, [id]: { ...form.sources[id], ...p } } });
  const toggleProject = (id: string) => setForm({ ...form, projects: form.projects.includes(id) ? form.projects.filter((x) => x !== id) : [...form.projects, id] });
  return (
    <details className="sa-details" data-testid="trigger-rules">
      <summary>
        <Radio size={14} aria-hidden /> {PART.triggers.name}: sources, policies and the model budget
      </summary>
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
              <div className="sr-title" id={`src-${s.id}`}>
                {s.title}
              </div>
              <div className="hint">{s.hint}</div>
            </div>
            <span className="segmented" role="group" aria-labelledby={`src-${s.id}`}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={cx(form.sources[s.id].mode === m.id && 'on')}
                  aria-pressed={form.sources[s.id].mode === m.id}
                  title={m.title}
                  onClick={() => setSource(s.id, { mode: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </span>
          </div>
          {form.sources[s.id].mode === 'candidate' && (
            <Field label={`Allow-list: ${s.title.toLowerCase()}`} hint={`${s.allowHint}. Empty: everything that passes the rules.`}>
              <textarea className="input mono" rows={2} value={form.sources[s.id].allow} placeholder={s.placeholder} onChange={(e) => setSource(s.id, { allow: e.target.value })} />
            </Field>
          )}
        </div>
      ))}
      <div className="field">
        <span className="field-label" id="sa-projects-label">
          Projects
        </span>
        <div className="day-chips" role="group" aria-labelledby="sa-projects-label">
          {listProjects(projects).map((p) => (
            <button key={p.id} className={cx('preset-chip sm', form.projects.includes(p.id) && 'on')} aria-pressed={form.projects.includes(p.id)} onClick={() => toggleProject(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <div className="hint">Only events from the selected projects (and their workspaces) can reach the model. None selected: every project.</div>
      </div>
      <Field
        label="Policies"
        hint="In your own words: which events are worth telling you about. The model sees these, never the other way round: text inside events is treated as data. A line you keep as Crew wrote it is applied by rules where it is plain (a failing check on a pull request, a changed dependency manifest, a network blip, errors from extensions or ads), with no model call; edit the line and the model reads your words instead."
      >
        <textarea className="input" rows={6} value={form.policies} onChange={(e) => setForm({ ...form, policies: e.target.value })} />
      </Field>
      <Field label="Model decisions per hour, at most" hint="0 keeps everything on the rules alone, and costs nothing.">
        <input
          className="input num-input"
          type="number"
          min={0}
          max={1000}
          value={form.maxCandidatesPerHour}
          onChange={(e) => setForm({ ...form, maxCandidatesPerHour: Math.max(0, Number(e.target.value) || 0) })}
        />
      </Field>
      <div className="row">
        <span className="spacer" />
        <button
          className="btn primary"
          disabled={saving || !dirty}
          onClick={() =>
            // The server cleans lists up (blank lines, duplicates): show what it kept.
            void save(fromForm(form), 'Trigger rules saved').then(() => setForm(toForm(useStore.getState().settings.superAgent)))
          }
        >
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
    </details>
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

/** Router and Workers: their models and how many Workers a chat runs at once. The switches are in the parts list above. */
function RouterSettingsBlock({ saved, save, saving }: { saved: RouterSettings; save: SaveFn; saving: boolean }) {
  const options = useModelOptions();
  const [form, setForm] = useState({ model: saved.model, workerModel: saved.workerModel, maxWorkers: saved.maxWorkers });
  const dirty = form.model !== saved.model || form.workerModel !== saved.workerModel || form.maxWorkers !== saved.maxWorkers;
  return (
    <details className="sa-details router-settings" data-testid="router-settings">
      <summary>
        <Network size={14} aria-hidden /> {PART.router.name}: models and limits
      </summary>
      <Field label="Router model" hint="It routes and writes short replies; a lighter model is usually enough.">
        <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {options(form.model, 'Claude Code default')}
        </select>
      </Field>
      <Field label="Worker model" hint="Workers do the actual work. A chat's own model switch, when set, takes precedence.">
        <select className="input" value={form.workerModel} onChange={(e) => setForm({ ...form, workerModel: e.target.value })}>
          {options(form.workerModel, 'The default model (strongest)')}
        </select>
      </Field>
      <Field label="Workers at once, per chat" hint="Each is a session and a git worktree of its own.">
        <input
          className="input num-input"
          type="number"
          min={1}
          max={8}
          value={form.maxWorkers}
          onChange={(e) => setForm({ ...form, maxWorkers: Math.max(1, Math.min(8, Number(e.target.value) || 1)) })}
        />
      </Field>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" disabled={saving || !dirty} onClick={() => void save({ router: { ...saved, ...form } }, 'Router settings saved')}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
    </details>
  );
}

/** Chain of recall (Inline & Spill, ADR 005): how much of an older object a prompt carries before the rest spills behind its id. */
function RecallSettingsBlock({ saved, save, saving }: { saved: RecallSettings; save: SaveFn; saving: boolean }) {
  const [words, setWords] = useState(saved.inlineWords);
  return (
    <details className="sa-details router-settings" data-testid="recall-settings">
      <summary>
        <Link2 size={14} aria-hidden /> {PART.recall.name}: how much is inlined
      </summary>
      <Field
        label="Words inlined before the rest spills"
        hint="For anything not next to the current turn: older messages, Worker reports, recalled objects. The latest message and your own words get more. Fewer words: smaller prompts, more lookups."
      >
        <input className="input num-input" type="number" min={20} max={200} value={words} onChange={(e) => setWords(Math.max(20, Math.min(200, Number(e.target.value) || 20)))} />
      </Field>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" disabled={saving || words === saved.inlineWords} onClick={() => void save({ recall: { ...saved, inlineWords: words } }, 'Recall settings saved')}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
    </details>
  );
}

const WATCHDOG_LIMITS: { key: keyof Omit<WatchdogSettings, 'enabled' | 'model'>; label: string; min: number; max: number; step?: number; hint: string }[] = [
  { key: 'everyMinutes', label: 'Tick every (minutes)', min: 1, max: 60, hint: 'A tick with nothing flagged by the rules costs nothing: no model is called.' },
  { key: 'maxTicksPerHour', label: 'Ticks that call the model, per hour at most', min: 1, max: 60, hint: 'The rest are skipped and recorded.' },
  { key: 'maxActionsPerTick', label: 'Actions per tick at most', min: 0, max: 10, hint: '0 lets it look and explain, but never act.' },
  { key: 'dailyBudgetUsd', label: 'Budget per day (USD)', min: 0, max: 100, step: 0.1, hint: 'Ticks and your questions together; past it the Watchdog waits for tomorrow.' },
  { key: 'stuckMinutes', label: 'Flag a Worker as stuck after (minutes)', min: 5, max: 240, hint: 'No tool call or other progress for this long.' },
];

/** The Watchdog's model and hard limits; its switch is in the parts list above. */
function WatchdogSettingsBlock({ saved, save, saving }: { saved: WatchdogSettings; save: SaveFn; saving: boolean }) {
  const options = useModelOptions();
  const [form, setForm] = useState(saved);
  const dirty = JSON.stringify({ ...form, enabled: saved.enabled }) !== JSON.stringify(saved);
  return (
    <details className="sa-details router-settings" data-testid="watchdog-settings">
      <summary>
        <ShieldCheck size={14} aria-hidden /> {PART.watchdog.name}: model and hard limits
      </summary>
      <p className="hint">It never does the work, never answers approvals, and only proposes changes to policies or prompts, which you accept or reject on its page.</p>
      <Field label="Watchdog model" hint="It judges and steers; a lighter model is usually enough. With the model gateway on, its watchdog route (if set) takes precedence.">
        <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {options(form.model, 'Claude Code default')}
        </select>
      </Field>
      {WATCHDOG_LIMITS.map((l) => (
        <Field key={l.key} label={l.label} hint={l.hint}>
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
        </Field>
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
    </details>
  );
}

const SPECULATIVE_LIMITS: { key: keyof Omit<SpeculativeSettings, 'model'>; label: string; min: number; max: number; step?: number; hint: string }[] = [
  { key: 'dailyBudgetUsd', label: 'Budget per day (USD)', min: 0, max: 100, step: 0.1, hint: "What today's runs may cost, across projects; past it, signals are skipped until tomorrow." },
  { key: 'maxConcurrent', label: 'Runs at once, at most', min: 1, max: 4, hint: 'Across projects; never more than one per project. Each is a full session and a worktree.' },
  { key: 'maxMinutes', label: 'Stop a run after (minutes)', min: 5, max: 120, hint: 'A run still working then is stopped and discarded.' },
];

/** Speculative execution (ADR 008): the limits all projects share, and what recent runs came to. Each project has its own switch. */
function SpeculativeSettingsBlock({ saved, save, saving }: { saved: SpeculativeSettings; save: SaveFn; saving: boolean }) {
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
    <details className="sa-details router-settings" data-testid="speculative-settings">
      <summary>
        <Sparkles size={14} aria-hidden /> {PART.speculative.name}: limits for every project
      </summary>
      <p className="hint">
        Each project turns {PART.speculative.name.toLowerCase()} on in its own settings, with the check command that proves a fix
        {optedIn.length ? ` (on now: ${optedIn.map((p) => p.name).join(', ')})` : ' (none has yet)'}. These limits apply to all of them together.
      </p>
      <Field label="Model for speculative runs" hint="With the model gateway on, its speculative route and spend windows apply.">
        <select className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
          {options(form.model, "The Workers' model")}
        </select>
      </Field>
      {SPECULATIVE_LIMITS.map((l) => (
        <Field key={l.key} label={l.label} hint={l.hint}>
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
        </Field>
      ))}
      <div className="row">
        <span className="muted">{spent === null ? '' : `Spent today: ${fmtCost(spent)} of ${fmtCost(saved.dailyBudgetUsd)}`}</span>
        <span className="spacer" />
        <button className="btn primary" disabled={saving || !dirty} onClick={() => void save({ speculative: form }, 'Speculative fix limits saved')}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
      {!!recent.length && (
        <div className="field">
          <span className="field-label">Recent runs</span>
          <div className="audit-list spec-runs">
            {recent.map((sp) => (
              <div key={sp.id} className="audit-row" data-speculation={sp.id}>
                <span className="muted">{new Date(sp.at).toLocaleString()}</span>
                <StatusBadge status={SPECULATION_STATUS[sp.status]} />
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
    </details>
  );
}
