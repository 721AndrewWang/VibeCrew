import { useMemo, useState } from 'react';
import type { ModelOption } from '../../../../../shared/types';
import { useStore } from '../../../store';
import { gatewayOptions } from '../../../utils';

/** Claude model names, which another provider does not understand. */
const CLAUDE_MODEL = /^claude-|^(opus|sonnet|haiku|fable)$/i;

const TIER_LABEL = { high: 'Premium $$$', mid: 'Mid $$', low: 'Cheap $' } as const;

/** Model dropdown with a free-form "custom" option; lists the provider's models when one is used. */
export function ModelPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const claudeModels = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const gateway = settings.gateway.enabled ? settings.gateway : null;
  const viaProvider = !gateway && settings.authMode === 'provider';
  const models = useMemo(() => {
    // Through the gateway: its groups and provider/model addresses; anything else goes to its default.
    if (gateway) return [{ id: '', label: `Gateway default (${gateway.defaultTarget || 'not set'})` }, ...gatewayOptions(gateway)];
    if (!viaProvider) return claudeModels;
    const p = settings.provider;
    const preset = providers.find((x) => x.id === p.preset);
    const ids = [...new Set([p.model, ...(preset?.models || []), p.fastModel].filter(Boolean))];
    return [{ id: '', label: `Use connection setting (${p.model || 'not set'})` }, ...ids.map((id) => ({ id, label: id }))];
  }, [gateway, viaProvider, claudeModels, settings.provider, providers]);
  // A Claude model chosen earlier is ignored while another provider is used.
  const ignored = viaProvider && CLAUDE_MODEL.test(value);
  const offGateway = !!gateway && !!value && !models.some((m) => m.id === value);
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
            {(m as ModelOption).tier ? ` · ${TIER_LABEL[(m as ModelOption).tier!]}` : ''}
          </option>
        ))}
        {!models.some((m) => m.id === '') && <option value="">Default model</option>}
        <option value="__custom__">Custom…</option>
      </select>
      {custom && (
        <input className="input mono" value={shown} placeholder={viaProvider ? 'Provider model ID' : 'Model ID, e.g. claude-sonnet-5 or opus'} onChange={(e) => onChange(e.target.value.trim())} />
      )}
      {offGateway && <div className="hint">The model gateway is on and {value} is not one of its groups or provider/model addresses, so this bot's calls go to the gateway's default.</div>}
      {ignored && <div className="hint">Another model provider is in use, so the earlier choice {value} won't apply. The bot will use the main model from the connection settings.</div>}
    </div>
  );
}
