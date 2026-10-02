import { KeyRound, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Bot, PluginDef } from '../../../../../shared/types';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { cx } from '../../../utils';
import { Glyph, Toggle } from '../../ui';

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

export function PluginsTab({ draft, patch, mcpText, setMcpText }: { draft: Bot; patch: (p: Partial<Bot>) => void; mcpText: string; setMcpText: (v: string) => void }) {
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
                      <div className="hint">密钥保存在本机的 Crew 设置里，所有机器人共用，不会写进项目。</div>
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
