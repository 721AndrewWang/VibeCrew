import { useMemo, useState } from 'react';
import { useStore } from '../../../store';

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
        <input className="input mono" value={shown} placeholder={viaProvider ? '服务商的模型 ID' : '模型 ID，例如 claude-sonnet-5 或 opus'} onChange={(e) => onChange(e.target.value.trim())} />
      )}
      {ignored && <div className="hint">现在用的是其他模型服务商，之前选的 {value} 不会生效，机器人会用连接设置里的主力模型。</div>}
    </div>
  );
}
