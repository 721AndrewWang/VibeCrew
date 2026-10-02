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
      toast('沙盒设置已保存', '下一轮开始生效', 'success');
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<Shield size={18} />} title="沙盒">
      <div className="setting-row">
        <div>
          <div className="sr-title">把机器人运行的命令关进沙盒</div>
          <div className="hint">命令只能写项目目录，网络只能连本机和下面列出的域名。这是真正的边界：「禁止的操作」只能防误操作，沙盒连绕过都做不到。机器人自己关不掉它。</div>
        </div>
        <Toggle on={enabled} onChange={setEnabled} />
      </div>
      {enabled && !status.available && (
        <div className="notice warn" data-testid="sandbox-unavailable">
          <div>这台机器上沙盒还用不了，机器人的命令目前没有被隔离。{status.hint}</div>
          {status.missing.length > 0 && <CodeLine code={`sudo apt install ${status.missing.join(' ')}`} />}
        </div>
      )}
      <div className="field span-all">
        <label>允许访问的域名</label>
        <textarea
          className="input mono"
          rows={5}
          value={domains}
          placeholder={'每行一个，例如\nregistry.npmjs.org\n*.githubusercontent.com\n10.0.0.5:8080'}
          onChange={(e) => setDomains(e.target.value)}
        />
        <div className="hint">本机（localhost）始终允许。每个项目还可以在自己的设置里追加域名。写法：域名、*.域名、IP，可以带端口。</div>
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
