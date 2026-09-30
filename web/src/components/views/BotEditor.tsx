import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Brain, Check, FileQuestion, KeyRound, Plus, Puzzle, Save, Shield, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import type { Bot, BotTemplate, Effort, McpServerEntry, PermissionLevel, PluginDef } from '../../../../shared/types';
import { api } from '../../api';
import { dmOf, openChat, setView, toast, useStore } from '../../store';
import { cx, EFFORT_OPTIONS, PERMISSION_INFO } from '../../utils';
import { Avatar, confirmDialog, Glyph, Modal, Toggle } from '../ui';
import { deleteBotFlow } from './BotsView';
import { ProjectSelect } from './ProjectsView';

export const BOT_NAME_RE = /^[\p{L}\p{N}_-]{1,24}$/u;

const PRESET_COLORS = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- shared inputs

/** Claude model names, which another provider does not understand. */
const CLAUDE_MODEL = /^claude-|^(opus|sonnet|haiku|fable)$/i;

/** Model dropdown with a free-form "custom" option; lists the provider's models when one is used. */
export function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const claudeModels = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const viaProvider = settings.authMode === 'provider';
  const models = useMemo(() => {
    if (!viaProvider) return claudeModels;
    const p = settings.provider;
    const preset = providers.find((x) => x.id === p.preset);
    const ids = [...new Set([p.model, ...(preset?.models || []), p.fastModel].filter(Boolean))];
    return [{ id: '', label: `跟随连接设置（${p.model || '未设置'}）` }, ...ids.map((id) => ({ id, label: id }))];
  }, [viaProvider, claudeModels, settings.provider, providers]);
  // A Claude model chosen earlier is ignored while another provider is used.
  const ignored = viaProvider && CLAUDE_MODEL.test(value);
  const shown = ignored ? '' : value;
  const known = models.some((m) => m.id === shown);
  const [custom, setCustom] = useState(!known && shown !== '');
  return (
    <div className="stack-sm">
      <select
        className="select"
        value={custom ? '__custom__' : known ? shown : ''}
        onChange={(e) => {
          if (e.target.value === '__custom__') setCustom(true);
          else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
        {!models.some((m) => m.id === '') && <option value="">默认模型</option>}
        <option value="__custom__">自定义…</option>
      </select>
      {custom && (
        <input
          className="input mono"
          value={shown}
          placeholder={viaProvider ? '服务商的模型 ID' : '模型 ID，例如 claude-sonnet-5 或 opus'}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      )}
      {ignored && <div className="hint">现在用的是其他模型服务商，之前选的 {value} 不会生效，机器人会用连接设置里的主力模型。</div>}
    </div>
  );
}

/** In the black / white / grey look avatars show a grey line icon; colour and emoji apply with a colour accent. */
function MonoAvatarHint() {
  if (document.documentElement.dataset.accent) return null;
  return <div className="hint">现在是黑白灰外观，头像统一显示为灰色线条图标；在「设置 → 外观」选彩色主题色后，会显示这里的颜色和表情。</div>;
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="swatches">
      {PRESET_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={cx('swatch', value.toLowerCase() === c && 'on')}
          style={{ background: c }}
          title={c}
          aria-label={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch custom" title="自定义颜色">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#0a84ff'} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

function firstLine(s: string) {
  return (s.split('\n').find((l) => l.trim()) || '').trim();
}

// ---------------------------------------------------------------- new bot

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const templates = useStore((s) => s.templates);
  const bots = useStore((s) => s.bots);
  const [mode, setMode] = useState<'gallery' | 'blank'>('gallery');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', emoji: '🤖', color: '#0a84ff', title: '', description: '' });

  const usage = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of Object.values(bots)) if (b.template) m[b.template] = (m[b.template] || 0) + 1;
    return m;
  }, [bots]);

  const nameOk = BOT_NAME_RE.test(form.name.trim());

  const afterCreate = async (bot: Bot) => {
    toast(`已添加 ${bot.name}`, bot.title, 'success');
    // The direct chat arrives over the websocket; give it a moment.
    for (let i = 0; i < 20; i++) {
      const dm = dmOf(bot.id);
      if (dm) {
        openChat(dm.id);
        onClose();
        return;
      }
      await sleep(100);
    }
    setView('bots');
    onClose();
  };

  const fromTemplate = async (t: BotTemplate) => {
    if (busy) return;
    setBusy(t.id);
    try {
      const bot = await api.createBot({ template: t.id });
      await afterCreate(bot);
    } catch (e) {
      toast('添加失败', (e as Error).message, 'error');
      setBusy(null);
    }
  };

  const createBlank = async () => {
    if (!nameOk || busy) return;
    setBusy('blank');
    try {
      const bot = await api.createBot({
        name: form.name.trim(),
        emoji: form.emoji.trim() || '🤖',
        color: form.color,
        title: form.title.trim(),
        description: form.description.trim(),
      });
      await afterCreate(bot);
    } catch (e) {
      toast('创建失败', (e as Error).message, 'error');
      setBusy(null);
    }
  };

  return (
    <Modal
      title="添加机器人"
      icon={<Sparkles size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        mode === 'blank' ? (
          <>
            <button className="btn foot-left" onClick={() => setMode('gallery')}>
              <ArrowLeft size={15} /> 返回模板
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" disabled={!nameOk || !!busy} onClick={createBlank}>
              {busy ? <span className="spinner" /> : <Plus size={15} />} 创建
            </button>
          </>
        ) : undefined
      }
    >
      {mode === 'gallery' ? (
        <>
          <div className="hint" style={{ marginBottom: 12 }}>
            选一个角色模板，马上就能在单聊里和它对话；之后可以随时修改它的角色说明、权限和插件。
          </div>
          <div className="tpl-grid">
            {templates.map((t) => {
              const perm = PERMISSION_INFO[t.permission];
              return (
                <button key={t.id} className={cx('tpl-card', busy === t.id && 'busy')} disabled={!!busy} onClick={() => fromTemplate(t)}>
                  <div className="tpl-top">
                    <Avatar bot={{ emoji: t.emoji, color: t.color, name: t.name }} size={40} />
                    <div className="tpl-id">
                      <div className="tpl-name">{t.name}</div>
                      <div className="tpl-title">{t.title}</div>
                    </div>
                    {busy === t.id && <span className="spinner" />}
                  </div>
                  <div className="tpl-desc">{firstLine(t.description)}</div>
                  <div className="tpl-foot">
                    <span className="badge" title={perm.desc}>
                      <Glyph emoji={perm.icon} size={11} /> {perm.label}
                    </span>
                    {usage[t.id] ? <span className="badge green">队伍里已有 {usage[t.id]} 位</span> : null}
                  </div>
                </button>
              );
            })}
            <button className="tpl-card blank" disabled={!!busy} onClick={() => setMode('blank')}>
              <div className="tpl-top">
                <span className="tpl-emoji blank">
                  <Plus size={22} />
                </span>
                <div className="tpl-id">
                  <div className="tpl-name">空白机器人</div>
                  <div className="tpl-title">从零定义角色</div>
                </div>
              </div>
              <div className="tpl-desc">自己写名字、头像和角色说明，打造专属队友。</div>
            </button>
          </div>
        </>
      ) : (
        <div className="blank-form">
          <div className="identity-row">
            <Avatar bot={{ emoji: form.emoji || '🤖', color: form.color, name: form.name }} size={56} />
            <div className="field emoji-field">
              <label>头像</label>
              <input className="input emoji-input" value={form.emoji} maxLength={8} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
            </div>
            <div className="field grow">
              <label>名字</label>
              <input className="input" autoFocus value={form.name} placeholder="例如 Nova" onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && void createBlank()} />
              <div className={cx('hint', form.name && !nameOk && 'error-text')}>用于 @提及，不能有空格（字母、数字、中文、_ 或 -，最多 24 个字符）</div>
            </div>
          </div>
          <div className="field">
            <label>颜色</label>
            <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
            <MonoAvatarHint />
          </div>
          <div className="field">
            <label>职位</label>
            <input className="input" value={form.title} placeholder="例如 动效工程师 · 过渡与微交互" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field">
            <label>角色说明（会成为它的系统提示词）</label>
            <textarea
              className="textarea"
              rows={7}
              value={form.description}
              placeholder={'你是……，负责……\n工作方式：\n- 先……\n- 完成后……'}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- rule list editor

function RuleList({ label, hint, value, onChange, tone }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; tone: 'green' | 'orange' }) {
  const [text, setText] = useState('');
  const add = () => {
    const r = text.trim();
    if (!r) return;
    if (!value.includes(r)) onChange([...value, r]);
    setText('');
  };
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="hint">{hint}</div>}
      <div className={cx('rule-box', tone)}>
        {value.length === 0 && <span className="muted rule-empty">（没有规则）</span>}
        {value.map((r) => (
          <span key={r} className="rule-tag mono">
            {r}
            <button type="button" aria-label="移除" onClick={() => onChange(value.filter((x) => x !== r))}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          className="input mono"
          value={text}
          placeholder="例如 Bash(npm run *)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn" disabled={!text.trim()} onClick={add}>
          <Plus size={14} /> 添加
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- plugins tab

function PluginSecret({ name, stored, onSaved }: { name: string; stored: boolean; onSaved: (key: string, set: boolean) => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (v: string) => {
    setBusy(true);
    try {
      await api.updateSettings({ pluginSecrets: { [name]: v } });
      onSaved(name, !!v);
      setValue('');
      toast(v ? `已保存 ${name}` : `已清除 ${name}`, undefined, 'success');
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="secret-row">
      <KeyRound size={14} className="muted" />
      <span className="mono secret-name">{name}</span>
      {stored && <span className="badge green">已设置</span>}
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        value={value}
        placeholder={stored ? '输入新值可替换' : `填写 ${name}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value && void save(value)}
      />
      <button className="btn sm" disabled={!value || busy} onClick={() => save(value)}>
        保存
      </button>
      {stored && (
        <button className="btn sm ghost danger" disabled={busy} onClick={() => save('')}>
          清除
        </button>
      )}
    </div>
  );
}

function PluginsTab({ draft, patch, mcpText, setMcpText }: { draft: Bot; patch: (p: Partial<Bot>) => void; mcpText: string; setMcpText: (v: string) => void }) {
  const plugins = useStore((s) => s.plugins);
  const [secretKeys, setSecretKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!plugins.some((p) => p.needs?.length)) return;
    api
      .lan()
      .then((r) => setSecretKeys(new Set(r.pluginSecretKeys)))
      .catch(() => {});
  }, [plugins]);

  const groups = useMemo(() => {
    const m = new Map<string, PluginDef[]>();
    for (const p of plugins) {
      if (!m.has(p.category)) m.set(p.category, []);
      m.get(p.category)!.push(p);
    }
    return [...m.entries()];
  }, [plugins]);

  const toggle = (id: string, on: boolean) => patch({ plugins: on ? [...draft.plugins.filter((x) => x !== id), id] : draft.plugins.filter((x) => x !== id) });

  let jsonError = '';
  if (mcpText.trim()) {
    try {
      const v = JSON.parse(mcpText);
      if (!v || typeof v !== 'object' || Array.isArray(v)) jsonError = '需要是一个对象：{ "名字": { … } }';
    } catch (e) {
      jsonError = (e as Error).message;
    }
  }

  return (
    <div className="tab-body">
      {groups.map(([cat, list]) => (
        <div key={cat} className="plugin-group">
          <div className="group-label">{cat}</div>
          <div className="card list-card">
            {list.map((p) => {
              const on = draft.plugins.includes(p.id);
              return (
                <div key={p.id} className="plugin-row">
                  <div className="plugin-main">
                    <span className="plugin-icon">
                      <Glyph emoji={p.icon} size={18} />
                    </span>
                    <div className="plugin-text">
                      <div className="plugin-name">{p.name}</div>
                      <div className="plugin-desc">{p.description}</div>
                    </div>
                    <Toggle on={on} onChange={(v) => toggle(p.id, v)} title={on ? '已启用' : '未启用'} />
                  </div>
                  {p.needs?.length ? (
                    <div className="plugin-secrets">
                      {p.needs.map((k) => (
                        <PluginSecret
                          key={k}
                          name={k}
                          stored={secretKeys.has(k)}
                          onSaved={(key, set) =>
                            setSecretKeys((prev) => {
                              const next = new Set(prev);
                              if (set) next.add(key);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                      ))}
                      <div className="hint">密钥保存在本机的 VibeCrew 设置里，所有机器人共用，不会写进项目。</div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="card list-card">
        <div className="plugin-row">
          <div className="plugin-main">
            <span className="plugin-icon">
              <UserRound size={18} />
            </span>
            <div className="plugin-text">
              <div className="plugin-name">加载我的 Claude Code 用户设置</div>
              <div className="plugin-desc">包括 ~/.claude 里的 MCP 服务器、插件、技能和 CLAUDE.md</div>
            </div>
            <Toggle on={draft.loadUserSettings} onChange={(v) => patch({ loadUserSettings: v })} />
          </div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 18 }}>
        <label>自定义 MCP 服务器</label>
        <div className="hint">
          JSON 格式，和 Claude Code 的 <span className="mono">mcpServers</span> 配置相同。例如：
          <code className="inline-code">{'{"my-server": {"type":"stdio","command":"npx","args":["-y","some-mcp"]}}'}</code>
        </div>
        <textarea
          className={cx('textarea mono', jsonError && 'invalid')}
          rows={8}
          spellCheck={false}
          value={mcpText}
          placeholder={'{\n  "my-server": {\n    "type": "stdio",\n    "command": "npx",\n    "args": ["-y", "some-mcp"]\n  }\n}'}
          onChange={(e) => setMcpText(e.target.value)}
        />
        {jsonError && <div className="hint error-text">JSON 有误：{jsonError}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bot editor

type Tab = 'basic' | 'perm' | 'plugins' | 'memory';

const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'basic', label: '基本', icon: UserRound },
  { id: 'perm', label: '权限', icon: Shield },
  { id: 'plugins', label: '插件', icon: Puzzle },
  { id: 'memory', label: '记忆', icon: Brain },
];

const PERMISSION_ORDER: PermissionLevel[] = ['plan', 'ask', 'review', 'edits', 'auto'];

export function BotEditorDialog({ botId, onClose }: { botId: string; onClose: () => void }) {
  const bot = useStore((s) => s.bots[botId]);
  const [draft, setDraft] = useState<Bot | null>(() => (bot ? structuredClone(bot) : null));
  const [tab, setTab] = useState<Tab>('basic');
  const [saving, setSaving] = useState(false);
  const [mcpText, setMcpText] = useState(() => (bot && Object.keys(bot.mcpServers || {}).length ? JSON.stringify(bot.mcpServers, null, 2) : ''));
  const [memory, setMemory] = useState<string | null>(null);
  const [memoryOrig, setMemoryOrig] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);

  // Deleted elsewhere: close.
  useEffect(() => {
    if (!bot) onClose();
  }, [bot, onClose]);

  useEffect(() => {
    let cancelled = false;
    api
      .memory(botId)
      .then((r) => {
        if (cancelled) return;
        setMemory(r.text);
        setMemoryOrig(r.text);
      })
      .catch((e) => {
        if (cancelled) return;
        setMemory('');
        toast('加载记忆失败', (e as Error).message, 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (!bot || !draft) return null;

  const patch = (p: Partial<Bot>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const nameOk = BOT_NAME_RE.test(draft.name.trim());
  const memoryDirty = memory !== null && memory !== memoryOrig;

  const saveMemory = async () => {
    if (memory === null) return;
    setMemoryBusy(true);
    try {
      await api.saveMemory(botId, memory);
      setMemoryOrig(memory);
      toast('记忆已保存', undefined, 'success');
    } catch (e) {
      toast('保存记忆失败', (e as Error).message, 'error');
    } finally {
      setMemoryBusy(false);
    }
  };

  const save = async () => {
    if (!nameOk) {
      setTab('basic');
      toast('名字不合法', '只能包含字母、数字、中文、下划线或连字符（最多 24 个字符），不能有空格', 'error');
      return;
    }
    let mcpServers: Record<string, McpServerEntry> = {};
    if (mcpText.trim()) {
      try {
        const v = JSON.parse(mcpText);
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('需要是一个对象：{ "名字": { … } }');
        mcpServers = v;
      } catch (e) {
        setTab('plugins');
        toast('自定义 MCP 服务器配置有误', (e as Error).message, 'error');
        return;
      }
    }
    if (draft.projectId !== bot.projectId && dmOf(botId)?.workspaceId) {
      const ok = await confirmDialog({
        title: '切换项目？',
        body: `和 ${bot.name} 的单聊正在独立工作区里工作，切换项目会关闭这个工作区。还没合并的改动会保留在它的分支里。`,
        ok: '切换',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await api.updateBot(botId, {
        name: draft.name.trim(),
        emoji: draft.emoji.trim() || '🤖',
        color: draft.color,
        title: draft.title,
        description: draft.description,
        model: draft.model.trim(),
        effort: draft.effort,
        permission: draft.permission,
        allowRules: draft.allowRules,
        askRules: draft.askRules,
        plugins: draft.plugins,
        loadUserSettings: draft.loadUserSettings,
        projectId: draft.projectId,
        mcpServers,
      });
      if (memoryDirty && memory !== null) await api.saveMemory(botId, memory);
      toast(`已保存 ${draft.name.trim()} 的设置`, undefined, 'success');
      onClose();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (await deleteBotFlow(bot)) onClose();
  };

  return (
    <Modal
      title={`${bot.name} 的设置`}
      icon={<Avatar bot={draft} size={32} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger foot-left" onClick={remove}>
            <Trash2 size={15} /> 删除机器人
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? <span className="spinner" /> : <Save size={15} />} 保存
          </button>
        </>
      }
    >
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={cx('tab', tab === t.id && 'on')} onClick={() => setTab(t.id)}>
            <t.icon size={15} /> {t.label}
            {t.id === 'memory' && memoryDirty && <span className="tab-dot" />}
          </button>
        ))}
      </div>

      {tab === 'basic' && (
        <div className="tab-body">
          <div className="identity-row">
            <div className="field emoji-field">
              <label>头像</label>
              <input className="input emoji-input" value={draft.emoji} maxLength={8} onChange={(e) => patch({ emoji: e.target.value })} />
            </div>
            <div className="field grow">
              <label>颜色</label>
              <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
              <MonoAvatarHint />
            </div>
          </div>
          <div className="form-grid">
            <div className="field">
              <label>名字</label>
              <input className={cx('input', !nameOk && 'invalid')} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
              <div className={cx('hint', !nameOk && 'error-text')}>用于 @提及，不能有空格</div>
            </div>
            <div className="field">
              <label>职位</label>
              <input className="input" value={draft.title} placeholder="例如 前端工程师 · 页面与交互" onChange={(e) => patch({ title: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>角色说明（会成为它的系统提示词）</label>
            <textarea className="textarea tall" value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="描述它的专长、负责的工作和做事方式。" />
          </div>
          <div className="form-grid">
            <div className="field">
              <label>模型</label>
              <ModelPicker value={draft.model} onChange={(model) => patch({ model })} />
            </div>
            <div className="field">
              <label>思考强度</label>
              <select className="select" value={draft.effort} onChange={(e) => patch({ effort: e.target.value as Effort })}>
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>默认项目</label>
            <ProjectSelect value={draft.projectId} onChange={(projectId) => patch({ projectId })} noneLabel="不绑定" />
            <div className="hint">它的单聊使用这个项目</div>
          </div>
        </div>
      )}

      {tab === 'perm' && (
        <div className="tab-body">
          <div className="field">
            <label>权限级别</label>
            <div className="choice-list">
              {PERMISSION_ORDER.map((level) => {
                const info = PERMISSION_INFO[level];
                const on = draft.permission === level;
                return (
                  <button key={level} className={cx('choice-card row-card', on && 'on')} onClick={() => patch({ permission: level })}>
                    <span className="cc-icon">
                      <Glyph emoji={info.icon} size={18} />
                    </span>
                    <div className="cc-text">
                      <div className="cc-title">{info.label}</div>
                      <div className="cc-desc">{info.desc}</div>
                    </div>
                    <span className="cc-radio">{on && <Check size={12} />}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <RuleList label="自动允许（不用问你）" tone="green" value={draft.allowRules} onChange={(allowRules) => patch({ allowRules })} />
          <RuleList label="必须确认（无论权限级别）" tone="orange" value={draft.askRules} onChange={(askRules) => patch({ askRules })} />
          <div className="note">
            <FileQuestion size={14} />
            <span>
              规则写法：<code className="inline-code">Bash(npm run *)</code>、<code className="inline-code">Bash(git push*)</code>、<code className="inline-code">Edit</code>、
              <code className="inline-code">Edit(src/**)</code>、<code className="inline-code">WebFetch(domain:github.com)</code>、<code className="inline-code">mcp__github</code>。
              在对话里点「总是允许」也会自动加到这里。
            </span>
          </div>
        </div>
      )}

      {tab === 'plugins' && <PluginsTab draft={draft} patch={patch} mcpText={mcpText} setMcpText={setMcpText} />}

      {tab === 'memory' && (
        <div className="tab-body">
          <div className="field">
            <label>长期记忆（机器人通过 remember 工具写入，每次对话都能看到）</label>
            {memory === null ? (
              <div className="row muted">
                <span className="spinner" /> 正在加载…
              </div>
            ) : (
              <textarea
                className="textarea mono tall"
                value={memory}
                spellCheck={false}
                placeholder={'还没有记忆。可以写下项目约定、你的偏好等，例如：\n- 用户喜欢简洁的界面，主色 #0a84ff\n- 提交信息用中文'}
                onChange={(e) => setMemory(e.target.value)}
              />
            )}
          </div>
          <div className="row">
            <span className="hint">记忆太长会占用上下文，可以定期整理。</span>
            <span className="spacer" />
            <button className="btn" disabled={!memoryDirty || memoryBusy} onClick={saveMemory}>
              {memoryBusy ? <span className="spinner" /> : <Save size={14} />} 保存记忆
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
