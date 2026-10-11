import { Check, KeyRound, Plug, RefreshCw, Save, Terminal, X } from 'lucide-react';
import { useState } from 'react';
import type { AuthMode, ProviderPreset, ProviderSettings } from '../../../../../shared/types';
import { api } from '../../../api';
import { requestTerminal, toast, useStore } from '../../../store';
import { cx, fmtShort, shortPath } from '../../../utils';
import { Glyph } from '../../ui';
import { CodeLine, Section } from './Section';

function methodLabel(m: string) {
  switch (m) {
    case 'claude.ai':
    case 'claudeai':
    case 'oauth':
    case 'oauth_token':
      return 'Claude account';
    case 'api-key':
    case 'api_key':
    case 'apiKey':
      return 'API Key';
    case 'none':
      return 'Not signed in';
    case 'unknown':
      return 'Unknown';
    default:
      return m;
  }
}

type TestResult = { ok: boolean; text: string; models?: string[]; ms: number };

function presetSettings(p: ProviderPreset | undefined): ProviderSettings {
  return { preset: p?.id || 'custom', baseUrl: p?.baseUrl || '', model: p?.model || '', fastModel: p?.fastModel || '' };
}

export function ConnectionSection() {
  const auth = useStore((s) => s.auth);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const [checking, setChecking] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>(settings.authMode);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [provider, setProvider] = useState<ProviderSettings>(() => (settings.provider.preset ? settings.provider : presetSettings(providers[0])));
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult | 'running' | null>(null);
  const preset = providers.find((p) => p.id === provider.preset);
  const savedPreset = providers.find((p) => p.id === settings.provider.preset);
  // A saved key belongs to the provider it was saved for.
  const keySaved = settings.hasProviderToken && provider.preset === settings.provider.preset;
  const needsKey = authMode === 'provider' && !preset?.defaultToken && !token.trim() && !keySaved;

  const recheck = async () => {
    setChecking(true);
    try {
      const a = await api.auth(true);
      useStore.setState({ auth: a });
      toast(
        a.ready ? 'Model connected' : 'Not connected yet',
        a.ready ? 'Bots can start working' : 'Finish signing in as prompted, or enter an API key / model provider',
        a.ready ? 'success' : 'warn',
      );
    } catch (e) {
      toast('Check failed', (e as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const pick = (p: ProviderPreset) => {
    setProvider(p.id === settings.provider.preset ? settings.provider : presetSettings(p));
    setToken('');
    setTest(null);
  };
  const edit = (patch: Partial<ProviderSettings>) => {
    setProvider((cur) => ({ ...cur, ...patch }));
    setTest(null);
  };

  const payload = () => ({
    authMode,
    baseUrl: baseUrl.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    provider,
    ...(token.trim() ? { providerToken: token.trim() } : {}),
  });

  /** What is missing before this connection can work, if anything. */
  const missing = (): string | null => {
    if (authMode === 'api-key' && !apiKey.trim() && !settings.hasApiKey) return 'Enter an API key (create one at console.anthropic.com)';
    if (authMode !== 'provider') return null;
    if (!provider.baseUrl.trim()) return 'Enter the provider address (Base URL)';
    if (!provider.model.trim()) return 'Enter the main model name';
    if (needsKey) return `Enter the ${preset?.name || 'provider'} API key`;
    return null;
  };

  const dirty = authMode !== settings.authMode || baseUrl !== settings.baseUrl || !!apiKey || !!token || (authMode === 'provider' && JSON.stringify(provider) !== JSON.stringify(settings.provider));

  const runTest = async () => {
    const why = missing();
    if (why) return toast(why, undefined, 'error');
    setTest('running');
    try {
      setTest(await api.testConnection(payload()));
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message, ms: 0 });
    }
  };

  const save = async () => {
    const why = missing();
    if (why) return toast(why, undefined, 'error');
    setSaving(true);
    try {
      await api.updateSettings(payload());
      setApiKey('');
      setToken('');
      const a = await api.auth(true);
      useStore.setState({ auth: a });
      toast('Connection settings saved', a.ready ? 'Bots can start working' : 'Not connected yet, check the settings', a.ready ? 'success' : 'warn');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<KeyRound size={18} />} title="Model connection" extra={<span className={cx('badge', auth.ready ? 'green' : 'red')}>{auth.ready ? 'Ready' : 'Not ready'}</span>}>
      <div className="kv-list">
        <div className="kv">
          <span className="k">Claude Code</span>
          <span className="v">
            {auth.cliFound ? (
              <>
                <span className="badge green">Installed</span>
                {auth.cliVersion && <span className="mono">v{auth.cliVersion.replace(/^v/, '')}</span>}
                {auth.cliPath && (
                  <span className="mono muted ellipsis" title={auth.cliPath}>
                    {shortPath(auth.cliPath)}
                  </span>
                )}
              </>
            ) : (
              <span className="badge red">Not found</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">{settings.authMode === 'provider' ? 'Model provider' : 'Sign-in status'}</span>
          <span className="v">
            {settings.authMode === 'provider' ? (
              <>
                {auth.loggedIn ? <span className="badge green">Configured</span> : <span className="badge red">Not configured</span>}
                <span className="muted">{savedPreset?.name || 'Custom'}</span>
                {settings.provider.model && <span className="mono">{settings.provider.model}</span>}
              </>
            ) : (
              <>
                {auth.loggedIn ? <span className="badge green">Signed in</span> : <span className="badge red">Not signed in</span>}
                {auth.loggedIn && <span className="muted">{methodLabel(auth.method)}</span>}
              </>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">Last checked</span>
          <span className="v">
            <span className="muted">{auth.checkedAt ? fmtShort(auth.checkedAt) : '—'}</span>
            <button className="btn sm" disabled={checking} onClick={recheck}>
              {checking ? <span className="spinner tiny" /> : <RefreshCw size={13} />} Check again
            </button>
          </span>
        </div>
      </div>

      {!auth.cliFound && (
        <div className="callout warn">
          <div>Claude Code was not found on this computer. Crew runs bots through it (even with another model provider). Install it first (requires Node.js 18+):</div>
          <CodeLine code="npm i -g @anthropic-ai/claude-code" />
          <div className="hint">After installing, click "Check again".</div>
        </div>
      )}
      {auth.cliFound && !auth.ready && settings.authMode === 'claude-code' && (
        <div className="callout warn">
          <div>Crew runs bots through Claude Code on your computer. Sign in first, or switch to an API key or another model provider below:</div>
          <CodeLine code="claude auth login" />
          <div className="row wrap">
            <button className="btn primary sm" onClick={() => requestTerminal('claude auth login')}>
              <Terminal size={13} /> Sign in from Crew terminal
            </button>
            <span className="hint">After signing in, come back and click "Check again".</span>
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 16 }}>
        <label>Connection method</label>
        <div className="choice-list">
          <button className={cx('choice-card row-card', authMode === 'claude-code' && 'on')} onClick={() => setAuthMode('claude-code')}>
            <span className="cc-icon">
              <Glyph emoji="💻" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">Use local Claude Code sign-in (subscriptions work)</div>
              <div className="cc-desc">Reuses your claude sign-in from the terminal. Pro / Max subscriptions and Console accounts both work.</div>
            </div>
            <span className="cc-radio">{authMode === 'claude-code' && <Check size={12} />}</span>
          </button>
          <button className={cx('choice-card row-card', authMode === 'api-key' && 'on')} onClick={() => setAuthMode('api-key')}>
            <span className="cc-icon">
              <Glyph emoji="🔑" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">Use an Anthropic API key</div>
              <div className="cc-desc">Billed by usage. Can also use a compatible gateway with a custom Base URL.</div>
            </div>
            <span className="cc-radio">{authMode === 'api-key' && <Check size={12} />}</span>
          </button>
          <button className={cx('choice-card row-card', authMode === 'provider' && 'on')} onClick={() => setAuthMode('provider')}>
            <span className="cc-icon">
              <Glyph emoji="🌐" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">Use another model provider</div>
              <div className="cc-desc">DeepSeek, Kimi, Zhipu GLM, Qwen, MiniMax, OpenRouter, or a local Ollama. Bots still run on Claude Code, just with a different model behind it.</div>
            </div>
            <span className="cc-radio">{authMode === 'provider' && <Check size={12} />}</span>
          </button>
        </div>
      </div>

      {authMode === 'api-key' && (
        <div className="form-grid">
          <div className="field">
            <label>API Key</label>
            <input
              className="input mono"
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={settings.hasApiKey ? 'Saved (leave empty to keep)' : 'sk-ant-…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Base URL (optional)</label>
            <input className="input mono" value={baseUrl} placeholder="https://api.anthropic.com" onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        </div>
      )}

      {authMode === 'provider' && (
        <>
          <div className="field">
            <label>Provider</label>
            <div className="pick-grid provider-grid">
              {providers.map((p) => (
                <button key={p.id} type="button" className={cx('pick-card', provider.preset === p.id && 'on')} onClick={() => pick(p)}>
                  <div className="pick-text">
                    <div className="pick-name">{p.name}</div>
                    <div className="pick-title">{p.description}</div>
                  </div>
                  <span className="pick-check">{provider.preset === p.id && <Check size={12} />}</span>
                </button>
              ))}
            </div>
          </div>
          {(preset?.hint || preset?.docsUrl) && (
            <div className="hint provider-hint">
              {preset.hint}{' '}
              {preset.docsUrl && (
                <a href={preset.docsUrl} target="_blank" rel="noreferrer">
                  {preset.name} setup guide ↗
                </a>
              )}
            </div>
          )}
          <div className="form-grid">
            <div className="field">
              <label>Address (Base URL)</label>
              <input className="input mono" value={provider.baseUrl} placeholder="https://…/anthropic" onChange={(e) => edit({ baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>API Key</label>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={token}
                placeholder={preset?.defaultToken ? 'Not needed' : keySaved ? 'Saved (leave empty to keep)' : `${preset?.name || 'Provider'} API key`}
                onChange={(e) => {
                  setToken(e.target.value);
                  setTest(null);
                }}
              />
            </div>
            <div className="field">
              <label>Main model</label>
              <input className="input mono" list="provider-models" value={provider.model} onChange={(e) => edit({ model: e.target.value })} />
              <div className="hint">Bots use it by default. Each bot can also pick its own in its settings</div>
            </div>
            <div className="field">
              <label>Background small model</label>
              <input className="input mono" list="provider-models" value={provider.fastModel} placeholder="Leave empty to use the main model" onChange={(e) => edit({ fastModel: e.target.value })} />
              <div className="hint">Claude Code uses it for light work like summaries and titles, which is cheaper</div>
            </div>
          </div>
          <datalist id="provider-models">
            {(preset?.models || []).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </>
      )}

      {test && (
        <div className={cx('callout', test === 'running' ? '' : test.ok ? 'ok' : 'error')}>
          {test === 'running' ? (
            <div>
              <span className="spinner tiny" /> Sending a very short test message with these settings…
            </div>
          ) : test.ok ? (
            <div>
              <Check size={13} className="test-ic" /> Connected ({(test.ms / 1000).toFixed(1)}s{test.models?.length ? `, model ${test.models.join(', ')}` : ''}), reply: {test.text}
              {dirty && <div className="hint">Don't forget to click "Save connection settings".</div>}
            </div>
          ) : (
            <div>
              <X size={13} className="test-ic" /> Connection failed: {test.text}
            </div>
          )}
        </div>
      )}

      <div className="row wrap">
        <span className="hint">Keys are stored only on this machine and never uploaded anywhere (only sent to the provider you choose).</span>
        <span className="spacer" />
        <button className="btn" disabled={test === 'running' || !auth.cliFound} onClick={runTest} title="Send a real, very short message with the settings below to confirm bots will work">
          {test === 'running' ? <span className="spinner tiny" /> : <Plug size={14} />} Test connection
        </button>
        <button className="btn primary" disabled={saving || !dirty} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save connection settings
        </button>
      </div>
    </Section>
  );
}
