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
      return 'Claude 账号';
    case 'api-key':
    case 'api_key':
    case 'apiKey':
      return 'API Key';
    case 'none':
      return '未登录';
    case 'unknown':
      return '未知方式';
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
      toast(a.ready ? '模型已连接' : '还没有连接好', a.ready ? '机器人可以开始工作了' : '请按提示完成登录，或填写 API Key / 模型服务商', a.ready ? 'success' : 'warn');
    } catch (e) {
      toast('检测失败', (e as Error).message, 'error');
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
    if (authMode === 'api-key' && !apiKey.trim() && !settings.hasApiKey) return '请填写 API Key（在 console.anthropic.com 创建）';
    if (authMode !== 'provider') return null;
    if (!provider.baseUrl.trim()) return '请填写服务商的地址（Base URL）';
    if (!provider.model.trim()) return '请填写主力模型的名字';
    if (needsKey) return `请填写 ${preset?.name || '服务商'} 的 API Key`;
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
      toast('连接设置已保存', a.ready ? '机器人可以开始工作了' : '还没有连接成功，请检查设置', a.ready ? 'success' : 'warn');
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<KeyRound size={18} />} title="模型连接" extra={<span className={cx('badge', auth.ready ? 'green' : 'red')}>{auth.ready ? '已就绪' : '未就绪'}</span>}>
      <div className="kv-list">
        <div className="kv">
          <span className="k">Claude Code</span>
          <span className="v">
            {auth.cliFound ? (
              <>
                <span className="badge green">已安装</span>
                {auth.cliVersion && <span className="mono">v{auth.cliVersion.replace(/^v/, '')}</span>}
                {auth.cliPath && (
                  <span className="mono muted ellipsis" title={auth.cliPath}>
                    {shortPath(auth.cliPath)}
                  </span>
                )}
              </>
            ) : (
              <span className="badge red">未找到</span>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">{settings.authMode === 'provider' ? '模型服务商' : '登录状态'}</span>
          <span className="v">
            {settings.authMode === 'provider' ? (
              <>
                {auth.loggedIn ? <span className="badge green">已配置</span> : <span className="badge red">未配置</span>}
                <span className="muted">{savedPreset?.name || '自定义'}</span>
                {settings.provider.model && <span className="mono">{settings.provider.model}</span>}
              </>
            ) : (
              <>
                {auth.loggedIn ? <span className="badge green">已登录</span> : <span className="badge red">未登录</span>}
                {auth.loggedIn && <span className="muted">{methodLabel(auth.method)}</span>}
              </>
            )}
          </span>
        </div>
        <div className="kv">
          <span className="k">上次检测</span>
          <span className="v">
            <span className="muted">{auth.checkedAt ? fmtShort(auth.checkedAt) : '—'}</span>
            <button className="btn sm" disabled={checking} onClick={recheck}>
              {checking ? <span className="spinner tiny" /> : <RefreshCw size={13} />} 重新检测
            </button>
          </span>
        </div>
      </div>

      {!auth.cliFound && (
        <div className="callout warn">
          <div>没有在这台电脑上找到 Claude Code。Crew 通过它来运行机器人（用其他模型服务商时也一样），请先安装（需要 Node.js 18+）：</div>
          <CodeLine code="npm i -g @anthropic-ai/claude-code" />
          <div className="hint">安装完成后点「重新检测」。</div>
        </div>
      )}
      {auth.cliFound && !auth.ready && settings.authMode === 'claude-code' && (
        <div className="callout warn">
          <div>Crew 通过你电脑上的 Claude Code 运行机器人。请先登录，或者在下面改用 API Key、其他模型服务商：</div>
          <CodeLine code="claude auth login" />
          <div className="row wrap">
            <button className="btn primary sm" onClick={() => requestTerminal('claude auth login')}>
              <Terminal size={13} /> 在 Crew 终端里登录
            </button>
            <span className="hint">登录完成后回到这里点「重新检测」。</span>
          </div>
        </div>
      )}

      <div className="field" style={{ marginTop: 16 }}>
        <label>连接方式</label>
        <div className="choice-list">
          <button className={cx('choice-card row-card', authMode === 'claude-code' && 'on')} onClick={() => setAuthMode('claude-code')}>
            <span className="cc-icon">
              <Glyph emoji="💻" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">使用本机 Claude Code 登录（可用订阅账号）</div>
              <div className="cc-desc">沿用你在终端里 claude 的登录状态，Pro / Max 订阅或 Console 账号都可以。</div>
            </div>
            <span className="cc-radio">{authMode === 'claude-code' && <Check size={12} />}</span>
          </button>
          <button className={cx('choice-card row-card', authMode === 'api-key' && 'on')} onClick={() => setAuthMode('api-key')}>
            <span className="cc-icon">
              <Glyph emoji="🔑" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">使用 Anthropic API Key</div>
              <div className="cc-desc">按用量计费；也可以配合自定义 Base URL 使用兼容的网关。</div>
            </div>
            <span className="cc-radio">{authMode === 'api-key' && <Check size={12} />}</span>
          </button>
          <button className={cx('choice-card row-card', authMode === 'provider' && 'on')} onClick={() => setAuthMode('provider')}>
            <span className="cc-icon">
              <Glyph emoji="🌐" size={18} />
            </span>
            <div className="cc-text">
              <div className="cc-title">使用其他模型服务商</div>
              <div className="cc-desc">DeepSeek、Kimi、智谱 GLM、通义千问、MiniMax、OpenRouter，或本机的 Ollama。机器人仍然由 Claude Code 驱动，只是换了背后的模型。</div>
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
              placeholder={settings.hasApiKey ? '已保存（留空则不修改）' : 'sk-ant-…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>
          <div className="field">
            <label>Base URL（可选）</label>
            <input className="input mono" value={baseUrl} placeholder="https://api.anthropic.com" onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
        </div>
      )}

      {authMode === 'provider' && (
        <>
          <div className="field">
            <label>服务商</label>
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
                  {preset.name} 的官方接入说明 ↗
                </a>
              )}
            </div>
          )}
          <div className="form-grid">
            <div className="field">
              <label>地址（Base URL）</label>
              <input className="input mono" value={provider.baseUrl} placeholder="https://…/anthropic" onChange={(e) => edit({ baseUrl: e.target.value })} />
            </div>
            <div className="field">
              <label>API Key</label>
              <input
                className="input mono"
                type="password"
                autoComplete="off"
                value={token}
                placeholder={preset?.defaultToken ? '不需要' : keySaved ? '已保存（留空则不修改）' : `${preset?.name || '服务商'} 的 API Key`}
                onChange={(e) => {
                  setToken(e.target.value);
                  setTest(null);
                }}
              />
            </div>
            <div className="field">
              <label>主力模型</label>
              <input className="input mono" list="provider-models" value={provider.model} onChange={(e) => edit({ model: e.target.value })} />
              <div className="hint">机器人默认用它；每个机器人也可以在自己的设置里单独选</div>
            </div>
            <div className="field">
              <label>后台小模型</label>
              <input className="input mono" list="provider-models" value={provider.fastModel} placeholder="留空则和主力模型相同" onChange={(e) => edit({ fastModel: e.target.value })} />
              <div className="hint">Claude Code 用它做总结、起标题这类轻量的活，便宜一些</div>
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
              <span className="spinner tiny" /> 正在用这些设置发一条很短的消息试试…
            </div>
          ) : test.ok ? (
            <div>
              <Check size={13} className="test-ic" /> 连接成功（{(test.ms / 1000).toFixed(1)} 秒{test.models?.length ? `，模型 ${test.models.join('、')}` : ''}），回复：{test.text}
              {dirty && <div className="hint">别忘了点「保存连接设置」。</div>}
            </div>
          ) : (
            <div>
              <X size={13} className="test-ic" /> 连接失败：{test.text}
            </div>
          )}
        </div>
      )}

      <div className="row wrap">
        <span className="hint">密钥只保存在本机，不会上传到任何地方（只会发给你选的服务商）。</span>
        <span className="spacer" />
        <button className="btn" disabled={test === 'running' || !auth.cliFound} onClick={runTest} title="用下面的设置真实发一条很短的消息，确认机器人能用">
          {test === 'running' ? <span className="spinner tiny" /> : <Plug size={14} />} 测试连接
        </button>
        <button className="btn primary" disabled={saving || !dirty} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} 保存连接设置
        </button>
      </div>
    </Section>
  );
}
