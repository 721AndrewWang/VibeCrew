import { Save, Shield } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { Toggle } from '../../ui';
import { CodeLine, Section } from './Section';

export function SandboxSection() {
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.features.sandbox);
  const [enabled, setEnabled] = useState(settings.sandbox.enabled);
  const [domains, setDomains] = useState(settings.sandbox.allowedDomains.join('\n'));
  const [saving, setSaving] = useState(false);
  const list = domains
    .split('\n')
    .map((d) => d.trim())
    .filter(Boolean);
  const dirty = enabled !== settings.sandbox.enabled || list.join('\n') !== settings.sandbox.allowedDomains.join('\n');

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateSettings({ sandbox: { enabled, allowedDomains: list } });
      useStore.setState({ settings: r.settings });
      setDomains(r.settings.sandbox.allowedDomains.join('\n'));
      toast('Sandbox settings saved', 'Takes effect from the next turn', 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<Shield size={18} />} title="Sandbox">
      <div className="setting-row">
        <div>
          <div className="sr-title">Run bot commands in a sandbox</div>
          <div className="hint">
            Commands can only write to the project folder, and the network can only reach this machine and the domains listed below. This is a real boundary: "Forbidden actions" only guard against
            mistakes, while the sandbox can't be bypassed at all. Bots can't turn it off themselves.
          </div>
        </div>
        <Toggle on={enabled} onChange={setEnabled} />
      </div>
      {enabled && !status.available && (
        <div className="notice warn" data-testid="sandbox-unavailable">
          <div>The sandbox isn't available on this machine yet, so bot commands are not isolated right now. {status.hint}</div>
          {status.missing.length > 0 && <CodeLine code={`sudo apt install ${status.missing.join(' ')}`} />}
        </div>
      )}
      <div className="field span-all">
        <label>Allowed domains</label>
        <textarea
          className="input mono"
          rows={5}
          value={domains}
          placeholder={'One per line, e.g.\nregistry.npmjs.org\n*.githubusercontent.com\n10.0.0.5:8080'}
          onChange={(e) => setDomains(e.target.value)}
        />
        <div className="hint">This machine (localhost) is always allowed. Each project can add more domains in its own settings. Format: domain, *.domain or IP, optionally with a port.</div>
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn primary" disabled={saving || !dirty} onClick={save}>
          {saving ? <span className="spinner" /> : <Save size={14} />} Save
        </button>
      </div>
    </Section>
  );
}
