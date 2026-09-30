import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, Bell, Check, Copy, Info, KeyRound, Monitor, Moon, Palette, RefreshCw, Save, SlidersHorizontal, Smartphone, Sun, Terminal } from 'lucide-react';
import type { PermissionLevel, PublicSettings } from '../../../../shared/types';
import { api } from '../../api';
import { desktop } from '../../desktop';
import { requestTerminal, toast, useStore } from '../../store';
import { copyText, cx, fmtShort, PERMISSION_INFO, shortPath } from '../../utils';
import { Toggle } from '../ui';
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

function ConnectionSection() {
  const auth = useStore((s) => s.auth);
  const settings = useStore((s) => s.settings);
  const [checking, setChecking] = useState(false);
  const [authMode, setAuthMode] = useState<PublicSettings['authMode']>(settings.authMode);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [saving, setSaving] = useState(false);

  const recheck = async () => {
    setChecking(true);
    try {
      const a = await api.auth(true);
      useStore.setState({ auth: a });
      toast(a.ready ? 'Claude 已连接' : '还没有连接好', a.ready ? '机器人可以开始工作了' : '请按提示完成登录或填写 API Key', a.ready ? 'success' : 'warn');
    } catch (e) {
      toast('检测失败', (e as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const dirty = authMode !== settings.authMode || baseUrl !== settings.baseUrl || !!apiKey;

  const save = async () => {
    if (authMode === 'api-key' && !apiKey.trim() && !settings.hasApiKey) {
      toast('请填写 API Key', '在 console.anthropic.com 创建一个 API Key', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.updateSettings({ authMode, baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setApiKey('');
      const a = await api.auth(true);
      useStore.setState({ auth: a });
      toast('连接设置已保存', a.ready ? '已连接到 Claude' : '还没有连接成功，请检查设置', a.ready ? 'success' : 'warn');
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      icon={<KeyRound size={18} />}
      title="Claude 连接"
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
          <span className="k">登录状态</span>
          <span className="v">
            {auth.loggedIn ? <span className="badge green">已登录</span> : <span className="badge red">未登录</span>}
            {auth.loggedIn && <span className="muted">{methodLabel(auth.method)}</span>}
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
          <div>没有在这台电脑上找到 Claude Code。VibeCrew 通过它来运行机器人，请先安装（需要 Node.js 18+）：</div>
          <CodeLine code="npm i -g @anthropic-ai/claude-code" />
          <div className="hint">安装完成后点「重新检测」。</div>
        </div>
      )}
      {auth.cliFound && !auth.ready && settings.authMode === 'claude-code' && (
        <div className="callout warn">
          <div>VibeCrew 通过你电脑上的 Claude Code 运行机器人。请先登录：</div>
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
            <span className="cc-icon">💻</span>
            <div className="cc-text">
              <div className="cc-title">使用本机 Claude Code 登录（推荐，可用订阅账号）</div>
              <div className="cc-desc">沿用你在终端里 claude 的登录状态，Pro / Max 订阅或 Console 账号都可以。</div>
            </div>
            <span className="cc-radio">{authMode === 'claude-code' && <Check size={12} />}</span>
          </button>
          <button className={cx('choice-card row-card', authMode === 'api-key' && 'on')} onClick={() => setAuthMode('api-key')}>
            <span className="cc-icon">🔑</span>
            <div className="cc-text">
              <div className="cc-title">使用 Anthropic API Key</div>
              <div className="cc-desc">按用量计费；也可以配合自定义 Base URL 使用兼容的网关。</div>
            </div>
            <span className="cc-radio">{authMode === 'api-key' && <Check size={12} />}</span>
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

      <div className="row">
        <span className="hint">密钥只保存在本机，不会上传到任何地方。</span>
        <span className="spacer" />
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
                {PERMISSION_INFO[k].icon} {PERMISSION_INFO[k].label}
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
        <img src="/icon.svg" alt="" />
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
