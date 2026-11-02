import { Network, Radio, Save } from 'lucide-react';
import { useState } from 'react';
import type { FilteredSource, RouterSettings, SourceMode, SuperAgentSettings } from '../../../../../shared/types';
import { api } from '../../../api';
import { listProjects, setView, toast, useStore } from '../../../store';
import { cx, gatewayOptions } from '../../../utils';
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

function fromForm(f: Form): Omit<SuperAgentSettings, 'enabled' | 'router'> {
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
  const toggleProject = (id: string) => setForm({ ...form, projects: form.projects.includes(id) ? form.projects.filter((x) => x !== id) : [...form.projects, id] });

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
        </>
      )}
    </Section>
  );
}

/** Two-layer mode: a Router per group chat that talks to the user and dispatches Workers. */
function RouterSettingsBlock({ saved, save, saving }: { saved: RouterSettings; save: (patch: Partial<SuperAgentSettings>, done?: string) => Promise<void>; saving: boolean }) {
  const claudeModels = useStore((s) => s.models);
  const gateway = useStore((s) => s.settings.gateway);
  // Through the gateway, its groups and provider/model addresses (Settings → Model gateway).
  const models = gateway.enabled ? [{ id: '', label: '' }, ...gatewayOptions(gateway)] : claudeModels;
  const [form, setForm] = useState({ model: saved.model, workerModel: saved.workerModel, maxWorkers: saved.maxWorkers });
  const dirty = form.model !== saved.model || form.workerModel !== saved.workerModel || form.maxWorkers !== saved.maxWorkers;
  const options = (current: string, empty: string) => {
    const list = models.map((m) => ({ id: m.id, label: m.id ? m.label : empty }));
    // A model typed elsewhere (or a provider's) stays selectable.
    if (!list.some((m) => m.id === current)) list.push({ id: current, label: current });
    return list.map((m) => (
      <option key={m.id} value={m.id}>
        {m.label}
      </option>
    ));
  };
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
