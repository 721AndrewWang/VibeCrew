import { Check, Download, Plus, RefreshCw, Route, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { GatewayReport, GatewayRole, GatewaySettings, GatewayTry, PublicGatewaySettings, SpendWindow } from '../../../../../shared/types';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { cx, fmtClock, fmtTokens, gatewayOptions } from '../../../utils';
import { Toggle } from '../../ui';
import { Section } from './Section';

const ROLES: { id: Exclude<GatewayRole, 'bot'>; label: string; hint: string }[] = [
  { id: 'router', label: 'Router', hint: 'Routes and writes short replies: a light model is enough' },
  { id: 'worker', label: 'Workers', hint: 'Do the actual work: the strongest model' },
  { id: 'watchdog', label: 'Watchdog', hint: 'Checks on Workers on a timer' },
  { id: 'speculative', label: 'Speculative Workers', hint: 'Work ahead on environment signals' },
  { id: 'oneshot', label: 'Background calls', hint: 'Commit messages, the event filter, suggestions' },
];
const WINDOW_ROLES: { id: SpendWindow['role']; label: string }[] = [
  { id: '*', label: 'All calls' },
  { id: 'bot', label: 'Chat turns' },
  { id: 'worker', label: 'Workers' },
  { id: 'router', label: 'Router' },
  { id: 'watchdog', label: 'Watchdog' },
  { id: 'speculative', label: 'Speculative' },
  { id: 'oneshot', label: 'Background' },
];

interface ProviderForm {
  id: string;
  name: string;
  baseUrl: string;
  auth: 'bearer' | 'x-api-key';
  models: string;
  priceIn: string;
  priceOut: string;
  key: string;
  hasToken: boolean;
}

interface Form {
  providers: ProviderForm[];
  groups: { id: string; members: string }[];
  defaultTarget: string;
  fastTarget: string;
  roles: GatewaySettings['roles'];
  windows: SpendWindow[];
  masking: boolean;
  port: number;
}

function toForm(g: PublicGatewaySettings): Form {
  return {
    providers: g.providers.map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.baseUrl,
      auth: p.auth,
      models: p.models.join(', '),
      priceIn: p.price ? String(p.price.input) : '',
      priceOut: p.price ? String(p.price.output) : '',
      key: '',
      hasToken: p.hasToken,
    })),
    groups: g.groups.map((x) => ({ id: x.id, members: x.members.join('\n') })),
    defaultTarget: g.defaultTarget,
    fastTarget: g.fastTarget,
    roles: { ...g.roles },
    windows: g.windows.map((w) => ({ ...w })),
    masking: g.masking,
    port: g.port,
  };
}

const lines = (s: string, sep: RegExp) =>
  s
    .split(sep)
    .map((x) => x.trim())
    .filter(Boolean);

function fromForm(f: Form): { gateway: Partial<GatewaySettings>; gatewayTokens: Record<string, string> } {
  const tokens: Record<string, string> = {};
  for (const p of f.providers) if (p.key.trim()) tokens[p.id.trim()] = p.key.trim();
  return {
    gateway: {
      providers: f.providers.map((p) => {
        const input = Number(p.priceIn) || 0;
        const output = Number(p.priceOut) || 0;
        return { id: p.id.trim(), name: p.name.trim(), baseUrl: p.baseUrl.trim(), auth: p.auth, models: lines(p.models, /[,\n]/), ...(input || output ? { price: { input, output } } : {}) };
      }),
      groups: f.groups.map((g) => ({ id: g.id.trim(), members: lines(g.members, /\n/) })),
      defaultTarget: f.defaultTarget,
      fastTarget: f.fastTarget,
      roles: f.roles,
      windows: f.windows,
      masking: f.masking,
      port: f.port,
    },
    gatewayTokens: tokens,
  };
}

const money = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function triesText(tries: GatewayTry[]) {
  return tries.map((t) => `${t.member}: ${t.outcome}${t.status ? ` ${t.status}` : ''}${t.detail ? ` (${t.detail})` : ''}`).join('\n');
}

/** The local model gateway (ADR 009): providers, routing groups, per-role routes, spend windows, masking and the usage log. */
export function GatewaySection() {
  const saved = useStore((s) => s.settings.gateway);
  const botMap = useStore((s) => s.bots);
  const bots = Object.values(botMap);
  const [form, setForm] = useState(() => toForm(saved));
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<GatewayReport | null>(null);
  const [testTarget, setTestTarget] = useState('');
  const [test, setTest] = useState<Awaited<ReturnType<typeof api.testGateway>> | 'running' | null>(null);
  const dirty = JSON.stringify(fromForm(form)) !== JSON.stringify(fromForm(toForm(saved)));
  const options = gatewayOptions({
    groups: form.groups.map((g) => ({ id: g.id.trim(), members: lines(g.members, /\n/) })).filter((g) => g.id),
    providers: form.providers.map((p) => ({ id: p.id.trim(), models: lines(p.models, /[,\n]/) })) as PublicGatewaySettings['providers'],
  });

  const refresh = useCallback(async () => {
    try {
      setReport(await api.gateway(50));
    } catch {
      /* shown as not running */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const apply = async (body: Record<string, unknown>, done: string) => {
    setSaving(true);
    try {
      const r = await api.updateSettings(body);
      useStore.setState({ settings: r.settings });
      setForm(toForm(r.settings.gateway));
      useStore.setState({ auth: await api.auth(true) });
      toast(done, undefined, 'success');
      await refresh();
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const importConnection = async () => {
    try {
      const r = await api.importConnection();
      useStore.setState({ settings: r.settings });
      setForm(toForm(r.settings.gateway));
      toast(`Added provider ${r.provider.id}`, 'Its key was copied on the server', 'success');
    } catch (e) {
      toast("Couldn't copy the connection", (e as Error).message, 'error');
    }
  };

  const runTest = async () => {
    setTest('running');
    try {
      setTest(await api.testGateway(testTarget || form.defaultTarget));
      await refresh();
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message, status: 0, tries: [], ms: 0 });
    }
  };

  const setP = (i: number, patch: Partial<ProviderForm>) => setForm({ ...form, providers: form.providers.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const setG = (i: number, patch: Partial<Form['groups'][number]>) => setForm({ ...form, groups: form.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  const setW = (i: number, patch: Partial<SpendWindow>) => setForm({ ...form, windows: form.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

  const targetSelect = (value: string, onChange: (v: string) => void, empty: string) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      {value && !options.some((o) => o.id === value) && <option value={value}>{value}</option>}
    </select>
  );

  return (
    <Section
      icon={<Route size={18} />}
      id="settings-gateway"
      title="Model gateway (preview)"
      extra={saved.enabled ? <span className={cx('badge', report?.running ? 'green' : 'red')}>{report?.running ? 'Running' : 'Not running'}</span> : undefined}
    >
      <div className="setting-row">
        <div>
          <div className="sr-title">Route every agent through a local gateway</div>
          <div className="hint">
            Claude Code sessions talk to a gateway on 127.0.0.1 inside Crew instead of one provider. Models are addressed as provider/model; a routing group tries its members in order, and when one
            answers with a rate limit, an outage or a quota error, the next answers instead, without the agent noticing. Spend windows, a per-call usage log and optional masking of secrets come with
            it. Keys stay in ~/.crew/settings.json. Off: the model connection above is used, as before.
          </div>
          {saved.enabled && report?.error && <div className="callout error">{report.error}</div>}
        </div>
        <Toggle label="Model gateway" on={saved.enabled} disabled={saving} onChange={(v) => void apply({ gateway: { enabled: v } }, v ? 'Model gateway on' : 'Model gateway off')} />
      </div>

      <div className="gateway-block" data-testid="gateway-providers">
        <div className="row">
          <div className="sr-title">Providers</div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => void importConnection()} title="Add the provider or API key from Model connection, key included">
            <Download size={13} /> Copy current connection
          </button>
          <button
            className="btn ghost sm"
            onClick={() => setForm({ ...form, providers: [...form.providers, { id: '', name: '', baseUrl: '', auth: 'bearer', models: '', priceIn: '', priceOut: '', key: '', hasToken: false }] })}
          >
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="hint">
          One Anthropic-compatible endpoint and key each. Several accounts at one provider are several providers (deepseek, deepseek-2). Prices are USD per million tokens, for the estimates.
        </div>
        {form.providers.map((p, i) => (
          <div key={i} className="gateway-provider" data-provider={p.id}>
            <input className="input mono" placeholder="id, e.g. deepseek" value={p.id} onChange={(e) => setP(i, { id: e.target.value })} />
            <input className="input mono wide" placeholder="https://api.example.com/anthropic" value={p.baseUrl} onChange={(e) => setP(i, { baseUrl: e.target.value })} />
            <select className="input" value={p.auth} onChange={(e) => setP(i, { auth: e.target.value as ProviderForm['auth'] })} title="How the key is sent">
              <option value="bearer">Bearer</option>
              <option value="x-api-key">x-api-key</option>
            </select>
            <input className="input mono" type="password" placeholder={p.hasToken ? 'Key saved' : 'Key'} value={p.key} onChange={(e) => setP(i, { key: e.target.value })} autoComplete="off" />
            <input className="input mono wide" placeholder="Models, comma separated" value={p.models} onChange={(e) => setP(i, { models: e.target.value })} />
            <input className="input num-input" placeholder="$ in" value={p.priceIn} onChange={(e) => setP(i, { priceIn: e.target.value })} title="USD per million input tokens" />
            <input className="input num-input" placeholder="$ out" value={p.priceOut} onChange={(e) => setP(i, { priceOut: e.target.value })} title="USD per million output tokens" />
            <button className="icon-btn sm" title="Remove" onClick={() => setForm({ ...form, providers: form.providers.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="gateway-block" data-testid="gateway-groups">
        <div className="row">
          <div className="sr-title">Routing groups</div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => setForm({ ...form, groups: [...form.groups, { id: '', members: '' }] })}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="hint">Members in order, one provider/model per line. provider/* passes on the model the agent asked for.</div>
        {form.groups.map((g, i) => (
          <div key={i} className="gateway-group">
            <input className="input mono" placeholder="name, e.g. strong" value={g.id} onChange={(e) => setG(i, { id: e.target.value })} />
            <textarea
              className="input mono"
              rows={Math.max(2, g.members.split('\n').length)}
              placeholder={'anthropic/claude-opus-5-5\ndeepseek/deepseek-v4-pro'}
              value={g.members}
              onChange={(e) => setG(i, { members: e.target.value })}
            />
            <button className="icon-btn sm" title="Remove" onClick={() => setForm({ ...form, groups: form.groups.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="gateway-block">
        <div className="sr-title">Routes</div>
        <div className="hint">Each bot picks a group or provider/model in its own model setting (and the chat's model switch). The routes below override the role's own model when set.</div>
        <div className="field">
          <label>Default</label>
          {targetSelect(form.defaultTarget, (v) => setForm({ ...form, defaultTarget: v }), 'None')}
          <div className="hint">Where a call that names no group or provider/model goes (a Claude model name, say).</div>
        </div>
        <div className="field">
          <label>Fast tier</label>
          {targetSelect(form.fastTarget, (v) => setForm({ ...form, fastTarget: v }), "The session's own target")}
          <div className="hint">Claude Code's small background calls (titles, summaries).</div>
        </div>
        {ROLES.map((r) => (
          <div key={r.id} className="field" data-role={r.id}>
            <label>{r.label}</label>
            {targetSelect(form.roles[r.id] || '', (v) => setForm({ ...form, roles: { ...form.roles, [r.id]: v || undefined } }), "The role's own model")}
            <div className="hint">{r.hint}</div>
          </div>
        ))}
      </div>

      <div className="gateway-block" data-testid="gateway-windows">
        <div className="row">
          <div className="sr-title">Spend windows</div>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => setForm({ ...form, windows: [...form.windows, { id: `w${form.windows.length + 1}`, role: 'worker', hours: 5, maxUsd: 5, maxTokens: 0 }] })}>
            <Plus size={13} /> Add
          </button>
        </div>
        <div className="hint">
          A rolling limit (0 = none). Once used up, calls are answered with 429 and Retry-After before any provider is asked, until the oldest calls age out. On top of each bot's monthly budget.
        </div>
        {form.windows.map((w, i) => {
          const state = report?.windows.find((x) => x.id === w.id);
          return (
            <div key={i} className="gateway-window">
              <input className="input mono" value={w.id} onChange={(e) => setW(i, { id: e.target.value })} title="Name" />
              <select className="input" value={w.role} onChange={(e) => setW(i, { role: e.target.value as SpendWindow['role'] })}>
                {WINDOW_ROLES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
              <select className="input" value={w.botId || ''} onChange={(e) => setW(i, { botId: e.target.value || undefined })}>
                <option value="">Every bot</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <label className="inline">
                <input className="input num-input" type="number" min={0.1} value={w.hours} onChange={(e) => setW(i, { hours: Number(e.target.value) || 1 })} /> h
              </label>
              <label className="inline">
                $<input className="input num-input" type="number" min={0} value={w.maxUsd} onChange={(e) => setW(i, { maxUsd: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
              <label className="inline">
                <input className="input num-input" type="number" min={0} value={w.maxTokens} onChange={(e) => setW(i, { maxTokens: Math.max(0, Math.round(Number(e.target.value) || 0)) })} /> tokens
              </label>
              {state && (
                <span className="hint">
                  {money(state.usedUsd)} · {fmtTokens(state.usedTokens)}
                  {state.spent ? ' · used up' : ''}
                </span>
              )}
              <button className="icon-btn sm" title="Remove" onClick={() => setForm({ ...form, windows: form.windows.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="setting-row">
        <div>
          <div className="sr-title">Mask secrets in prompts</div>
          <div className="hint">
            Keys, passwords and email addresses in what leaves this machine are replaced with placeholders and put back in the reply, so the provider never sees them. Best effort: unusual secret
            shapes can slip through.
          </div>
        </div>
        <Toggle label="Mask secrets in prompts" on={form.masking} onChange={(v) => setForm({ ...form, masking: v })} />
      </div>

      <div className="row">
        <span className="spacer" />
        {dirty && (
          <button className="btn ghost" onClick={() => setForm(toForm(saved))}>
            <X size={14} /> Discard
          </button>
        )}
        <button className="btn primary" disabled={saving || !dirty} onClick={() => void apply(fromForm(form), 'Gateway settings saved')}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>

      <div className="gateway-block" data-testid="gateway-usage">
        <div className="row">
          <div className="sr-title">Usage</div>
          <span className="spacer" />
          {saved.enabled && (
            <>
              {targetSelect(testTarget, setTestTarget, 'Test the default')}
              <button className="btn ghost sm" disabled={test === 'running' || !report?.running} onClick={() => void runTest()}>
                {test === 'running' ? <span className="spinner" /> : null} Test
              </button>
            </>
          )}
          <button className="icon-btn sm" title="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </div>
        {test && test !== 'running' && (
          <div className={cx('callout', test.ok ? 'ok' : 'error')} title={triesText(test.tries)}>
            {test.ok ? <Check size={13} className="test-ic" /> : <X size={13} className="test-ic" />}{' '}
            {test.ok ? `Answered by ${test.provider}/${test.model} in ${(test.ms / 1000).toFixed(1)}s: ${test.text}` : test.text}
            {test.tries.some((t) => t.outcome === 'handed-on') && ` (handed on ${test.tries.filter((t) => t.outcome === 'handed-on').length}×)`}
          </div>
        )}
        {report && Object.keys(report.byProvider).length > 0 && (
          <div className="hint">
            Last 7 days:{' '}
            {Object.entries(report.byProvider)
              .map(([id, t]) => `${id} ${t.calls} calls, ${money(t.costUsd)}, ${fmtTokens(t.tokens)} tokens${t.handedOn ? `, ${t.handedOn} handed on` : ''}`)
              .join(' · ')}
          </div>
        )}
        {report?.calls.length ? (
          <table className="routing-bins gateway-calls">
            <thead>
              <tr>
                <th>Time</th>
                <th>For</th>
                <th>Target</th>
                <th>Answered by</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {report.calls.map((c) => (
                <tr key={c.id} className={cx(c.outcome !== 'ok' && 'err')} title={triesText(c.tries) || c.detail}>
                  <td>{fmtClock(c.at)}</td>
                  <td>{c.botId ? `${c.role} · ${bots.find((b) => b.id === c.botId)?.name || c.botId}` : c.role}</td>
                  <td className="mono">{c.target}</td>
                  <td className="mono">
                    {c.outcome === 'limited' ? `window ${c.window}` : c.provider ? `${c.provider}/${c.model}` : `failed ${c.status}`}
                    {c.tries.some((t) => t.outcome === 'handed-on') ? ` (after ${c.tries.filter((t) => t.outcome === 'handed-on').length} handed on)` : ''}
                    {c.masked ? ` · ${c.masked} masked` : ''}
                  </td>
                  <td>{c.tokens ? fmtTokens(c.tokens.input + c.tokens.output + c.tokens.cacheRead + c.tokens.cacheWrite) : '-'}</td>
                  <td>{money(c.costUsd)}</td>
                  <td>{(c.latencyMs / 1000).toFixed(1)}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="hint">No calls yet.</div>
        )}
      </div>
    </Section>
  );
}
