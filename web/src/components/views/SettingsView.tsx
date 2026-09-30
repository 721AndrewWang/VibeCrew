import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Bell, Check, Copy, Info, KeyRound, Monitor, Moon, Palette, Plug, RefreshCw, Save, SlidersHorizontal, Smartphone, Sun, Terminal, X } from 'lucide-react';
import type { AuthMode, PermissionLevel, ProviderPreset, ProviderSettings } from '../../../../shared/types';
import { api } from '../../api';
import { desktop } from '../../desktop';
import { requestTerminal, toast, useStore } from '../../store';
import { copyText, cx, fmtShort, PERMISSION_INFO, shortPath } from '../../utils';
import { Glyph, Logo, Toggle } from '../ui';
import { PageHead } from './BotsView';
import { ModelPicker } from './BotEditor';

function Section({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card settings-card">
      <div className="sc-head">
        <span className="sc-icon">{icon}</span>
        <h2>{title}</h2>
        <span className="spacer" />
        {extra}
      </div>
      <div className="sc-body">{children}</div>
    </section>
  );
}

function CodeLine({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-line">
      <code>{code}</code>
      <button
        className="icon-btn sm"
        title="复制"
        onClick={() =>
          void copyText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

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

// ---------------------------------------------------------------- 1. connection

type TestResult = { ok: boolean; text: string; models?: string[]; ms: number };

function presetSettings(p: ProviderPreset | undefined): ProviderSettings {
  return { preset: p?.id || 'custom', baseUrl: p?.baseUrl || '', model: p?.model || '', fastModel: p?.fastModel || '' };
}

function ConnectionSection() {
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

  const dirty =
    authMode !== settings.authMode ||
    baseUrl !== settings.baseUrl ||
    !!apiKey ||
    !!token ||
    (authMode === 'provider' && JSON.stringify(provider) !== JSON.stringify(settings.provider));

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
    <Section
      icon={<KeyRound size={18} />}
      title="模型连接"
      extra={<span className={cx('badge', auth.ready ? 'green' : 'red')}>{auth.ready ? '已就绪' : '未就绪'}</span>}
    >
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
          <div>没有在这台电脑上找到 Claude Code。VibeCrew 通过它来运行机器人（用其他模型服务商时也一样），请先安装（需要 Node.js 18+）：</div>
          <CodeLine code="npm i -g @anthropic-ai/claude-code" />
          <div className="hint">安装完成后点「重新检测」。</div>
        </div>
      )}
      {auth.cliFound && !auth.ready && settings.authMode === 'claude-code' && (
        <div className="callout warn">
          <div>VibeCrew 通过你电脑上的 Claude Code 运行机器人。请先登录，或者在下面改用 API Key、其他模型服务商：</div>
          <CodeLine code="claude auth login" />
          <div className="row wrap">
            <button className="btn primary sm" onClick={() => requestTerminal('claude auth login')}>
              <Terminal size={13} /> 在 VibeCrew 终端里登录
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

// ---------------------------------------------------------------- 2. defaults

function DefaultsSection() {
  const settings = useStore((s) => s.settings);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel);
  const [defaultPermission, setDefaultPermission] = useState<PermissionLevel>(settings.defaultPermission);
  const [maxHops, setMaxHops] = useState(settings.maxHops);
  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot);
  const [saving, setSaving] = useState(false);

  const dirty =
    defaultModel !== settings.defaultModel || defaultPermission !== settings.defaultPermission || maxHops !== settings.maxHops || projectsRoot !== settings.projectsRoot;

  const save = async () => {
    setSaving(true);
    try {
      const hops = Math.max(0, Math.min(30, Math.round(maxHops) || 0));
      const r = await api.updateSettings({ defaultModel: defaultModel.trim(), defaultPermission, maxHops: hops, ...(projectsRoot.trim() ? { projectsRoot: projectsRoot.trim() } : {}) });
      useStore.setState({ settings: r.settings });
      setMaxHops(r.settings.maxHops);
      setProjectsRoot(r.settings.projectsRoot);
      toast('默认设置已保存', undefined, 'success');
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<SlidersHorizontal size={18} />} title="默认值">
      <div className="form-grid">
        <div className="field">
          <label>默认模型</label>
          <ModelPicker value={defaultModel} onChange={setDefaultModel} />
          <div className="hint">机器人没有单独指定模型时使用</div>
        </div>
        <div className="field">
          <label>新机器人的默认权限</label>
          <select className="select" value={defaultPermission} onChange={(e) => setDefaultPermission(e.target.value as PermissionLevel)}>
            {(Object.keys(PERMISSION_INFO) as PermissionLevel[]).map((k) => (
              <option key={k} value={k}>
                {PERMISSION_INFO[k].label}
              </option>
            ))}
          </select>
          <div className="hint">{PERMISSION_INFO[defaultPermission].desc}</div>
        </div>
        <div className="field">
          <label>自动接力上限</label>
          <input className="input num-input" type="number" min={0} max={30} value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} />
          <div className="hint">群聊里机器人之间互相 @ 的最多次数，防止无限循环</div>
        </div>
        <div className="field">
          <label>项目文件夹</label>
          <input className="input mono" value={projectsRoot} placeholder="~/VibeCrew" onChange={(e) => setProjectsRoot(e.target.value)} />
          <div className="hint">新建的项目放在这里</div>
        </div>
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" disabled={saving || !dirty} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} 保存
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- 3. LAN access

function LanSection() {
  const enabled = useStore((s) => s.settings.lanEnabled);
  const [busy, setBusy] = useState(false);
  const [lan, setLan] = useState<{ url?: string; qr: string | null } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setLan(null);
      return;
    }
    let cancelled = false;
    api
      .lan()
      .then((r) => !cancelled && setLan(r))
      .catch((e) => !cancelled && toast('获取手机访问链接失败', (e as Error).message, 'error'));
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const toggle = async (v: boolean) => {
    setBusy(true);
    try {
      const r = await api.updateSettings({ lanEnabled: v });
      useStore.setState({ settings: r.settings, lanUrl: r.lanUrl });
    } catch (e) {
      toast('切换失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section icon={<Smartphone size={18} />} title="手机访问">
      <div className="setting-row">
        <div>
          <div className="sr-title">允许手机在局域网内访问</div>
          <div className="hint">开启后需要重启 VibeCrew；手机和电脑需在同一局域网；链接里带有访问令牌，不要分享给别人</div>
        </div>
        <Toggle on={enabled} disabled={busy} onChange={toggle} />
      </div>
      {enabled && (
        <div className="lan-box">
          {!lan ? (
            <div className="row muted">
              <span className="spinner" /> 正在生成二维码…
            </div>
          ) : lan.url ? (
            <>
              {lan.qr && <div className="qr-box" dangerouslySetInnerHTML={{ __html: lan.qr }} />}
              <div className="lan-info">
                <div className="sr-title">用手机相机扫码打开</div>
                <div className="code-line">
                  <code className="ellipsis">{lan.url}</code>
                  <button
                    className="icon-btn sm"
                    title="复制链接"
                    onClick={() =>
                      void copyText(lan.url!).then(() => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      })
                    }
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <div className="hint">打开后可以在手机浏览器里「添加到主屏幕」，像 App 一样使用。</div>
              </div>
            </>
          ) : (
            <div className="hint">没有检测到局域网地址。请确认电脑已连接 Wi-Fi 或有线网络，然后重启 VibeCrew。</div>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- 4. appearance

type Theme = 'system' | 'light' | 'dark';

/** Accent presets; the colours match the [data-accent] blocks in styles/base.css. 'mono' is none. */
const ACCENTS = [
  { id: 'mono', name: '黑白灰', from: '#111111', to: '#8c8c8c' },
  { id: 'glacier', name: '冰川蓝', from: '#2f6ff0', to: '#13aee0' },
  { id: 'ocean', name: '深海蓝', from: '#2d5be3', to: '#5a4ff0' },
  { id: 'teal', name: '青碧', from: '#0c93a3', to: '#22c3b0' },
  { id: 'indigo', name: '靛紫', from: '#5b5ff0', to: '#9068f2' },
] as const;

function readAccent(): string {
  try {
    return localStorage.getItem('vc-accent') || 'mono';
  } catch {
    return 'mono';
  }
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem('vc-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

function AppearanceSection() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [accent, setAccent] = useState(readAccent);
  const applyAccent = (id: string) => {
    setAccent(id);
    try {
      if (id === 'mono') localStorage.removeItem('vc-accent');
      else localStorage.setItem('vc-accent', id);
    } catch {
      /* storage blocked: still apply for this session */
    }
    if (id === 'mono') delete document.documentElement.dataset.accent;
    else document.documentElement.dataset.accent = id;
  };
  const apply = (v: Theme) => {
    setTheme(v);
    try {
      if (v === 'system') localStorage.removeItem('vc-theme');
      else localStorage.setItem('vc-theme', v);
    } catch {
      /* storage blocked: still apply for this session */
    }
    if (v === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = v;
  };
  const options: { id: Theme; label: string; icon: ReactNode }[] = [
    { id: 'system', label: '跟随系统', icon: <Monitor size={13} /> },
    { id: 'light', label: '浅色', icon: <Sun size={13} /> },
    { id: 'dark', label: '深色', icon: <Moon size={13} /> },
  ];
  return (
    <Section icon={<Palette size={18} />} title="外观">
      <div className="setting-row">
        <div>
          <div className="sr-title">主题</div>
          <div className="hint">只影响这台设备上的浏览器</div>
        </div>
        <div className="segmented">
          {options.map((o) => (
            <button key={o.id} className={cx(theme === o.id && 'on')} onClick={() => apply(o.id)}>
              {o.icon} {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">主题色</div>
          <div className="hint">按钮、选中状态和你发出的消息用这个颜色；选彩色时，机器人头像也会显示各自的颜色和表情</div>
        </div>
        <div className="accent-swatches" role="radiogroup" aria-label="主题色">
          {ACCENTS.map((a) => (
            <button key={a.id} role="radio" aria-checked={accent === a.id} className={cx('accent-swatch', accent === a.id && 'on')} onClick={() => applyAccent(a.id)}>
              <i style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }} />
              <span>{a.name}</span>
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- 5. notifications

function NotificationSection() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  const info: Record<string, { cls: string; text: string }> = {
    granted: { cls: 'green', text: '已允许' },
    denied: { cls: 'red', text: '已拒绝' },
    default: { cls: '', text: '未设置' },
    unsupported: { cls: '', text: '浏览器不支持' },
  };

  const ask = async () => {
    try {
      setPerm(await Notification.requestPermission());
    } catch (e) {
      toast('请求通知权限失败', (e as Error).message, 'error');
    }
  };

  const test = () => {
    try {
      new Notification('VibeCrew', { body: '桌面通知已开启：机器人完成任务或需要你确认时会提醒你。', icon: '/icon.svg' });
    } catch {
      toast('无法显示通知', '这个浏览器只允许在后台时显示通知', 'warn');
    }
  };

  return (
    <Section icon={<Bell size={18} />} title="通知">
      <div className="setting-row">
        <div>
          <div className="sr-title">
            桌面通知 <span className={cx('badge', info[perm].cls)}>{info[perm].text}</span>
          </div>
          <div className="hint">
            {perm === 'denied' ? '通知被浏览器拦截了，请在地址栏左侧的网站设置里重新允许。' : '页面在后台时，机器人完成任务或等待你确认会弹出通知。'}
          </div>
        </div>
        {perm === 'granted' ? (
          <button className="btn sm" onClick={test}>
            发送测试通知
          </button>
        ) : (
          <button className="btn sm primary" disabled={perm !== 'default'} onClick={ask}>
            允许桌面通知
          </button>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- desktop app

function DesktopSection() {
  const [info, setInfo] = useState<Awaited<ReturnType<NonNullable<typeof desktop>['info']>>>(null);
  useEffect(() => {
    void desktop?.info().then(setInfo);
  }, []);
  if (!desktop || !info) return null;
  const toggle = async (on: boolean) => {
    const now = await desktop!.setAutostart(on);
    setInfo({ ...info, autostart: !!now });
  };
  return (
    <Section icon={<AppWindow size={18} />} title="桌面应用">
      <div className="setting-row">
        <div>
          <div className="sr-title">开机自动启动</div>
          <div className="hint">登录后在后台启动 VibeCrew（只显示托盘图标），定时任务到点就能运行。</div>
        </div>
        <Toggle on={info.autostart} onChange={(v) => void toggle(v)} />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">关闭窗口时</div>
          <div className="hint">
            {info.attached
              ? '当前连接的是另一个进程启动的服务（例如终端里的 npm start），关闭窗口或退出应用都不会停止它。'
              : '窗口会隐藏到托盘，机器人继续工作。要彻底退出，请用托盘菜单或 Ctrl+Q。'}
          </div>
        </div>
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">
            运行信息 <span className={cx('badge', info.sandboxed ? 'green' : '')}>{info.sandboxed ? '沙盒已开启' : '未开启沙盒'}</span>
          </div>
          <div className="hint">
            桌面版 {info.version}
            {info.sandboxed ? '' : ' · 运行 sudo desktop/install-system.sh 可以开启 Chromium 沙盒（见 README）'}
          </div>
        </div>
        <button className="btn sm" onClick={() => desktop!.openLogs()}>
          查看服务日志
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- 6. about

function AboutSection() {
  const version = useStore((s) => s.version);
  return (
    <Section icon={<Info size={18} />} title="关于">
      <div className="about">
        <Logo size={40} />
        <div>
          <div className="sr-title">VibeCrew {version}</div>
          <div className="hint">灵感来自 xAI Grokbot，基于 Claude Code / Claude Agent SDK</div>
        </div>
      </div>
    </Section>
  );
}

export function SettingsView() {
  return (
    <div className="page">
      <div className="page-inner settings-inner">
        <PageHead title="设置" sub="连接 Claude、默认值、手机访问和外观" />
        <ConnectionSection />
        <DefaultsSection />
        <LanSection />
        <AppearanceSection />
        <NotificationSection />
        <DesktopSection />
        <AboutSection />
      </div>
    </div>
  );
}
