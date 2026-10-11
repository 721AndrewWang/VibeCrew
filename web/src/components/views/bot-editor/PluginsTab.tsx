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
      toast(v ? `Saved ${name}` : `Cleared ${name}`, undefined, 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="secret-row">
      <KeyRound size={14} className="muted" />
      <span className="mono secret-name">{name}</span>
      {stored && <span className="badge green">Set</span>}
      <input
        className="input mono"
        type="password"
        autoComplete="off"
        value={value}
        placeholder={stored ? 'Enter a new value to replace' : `Enter ${name}`}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value && void save(value)}
      />
      <button className="btn sm" disabled={!value || busy} onClick={() => save(value)}>
        Save
      </button>
      {stored && (
        <button className="btn sm ghost danger" disabled={busy} onClick={() => save('')}>
          Clear
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
      if (!v || typeof v !== 'object' || Array.isArray(v)) jsonError = 'Must be an object: { "name": { … } }';
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
                    <Toggle on={on} onChange={(v) => toggle(p.id, v)} title={on ? 'Enabled' : 'Disabled'} />
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
                      <div className="hint">Keys are stored in Crew settings on this machine, shared by all bots, and never written into projects.</div>
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
              <div className="plugin-name">Load my Claude Code user settings</div>
              <div className="plugin-desc">Includes MCP servers, plugins, skills and CLAUDE.md from ~/.claude</div>
            </div>
            <Toggle on={draft.loadUserSettings} onChange={(v) => patch({ loadUserSettings: v })} />
          </div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 18 }}>
        <label>Custom MCP servers</label>
        <div className="hint">
          JSON, same as the Claude Code <span className="mono">mcpServers</span> config. For example:
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
        {jsonError && <div className="hint error-text">Invalid JSON: {jsonError}</div>}
      </div>
    </div>
  );
}
