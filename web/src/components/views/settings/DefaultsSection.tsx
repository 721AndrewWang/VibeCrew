import { Save, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { PermissionLevel } from '../../../../../shared/types';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { PERMISSION_INFO } from '../../../utils';
import { ModelPicker } from '../bot-editor/ModelPicker';
import { Section } from './Section';

export function DefaultsSection() {
  const settings = useStore((s) => s.settings);
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel);
  const [defaultPermission, setDefaultPermission] = useState<PermissionLevel>(settings.defaultPermission);
  const [maxHops, setMaxHops] = useState(settings.maxHops);
  const [projectsRoot, setProjectsRoot] = useState(settings.projectsRoot);
  const [denyRules, setDenyRules] = useState((settings.denyRules || []).join('\n'));
  const [rotateK, setRotateK] = useState(Math.round(settings.rotateAtTokens / 1000));
  const [wrapUpK, setWrapUpK] = useState(Math.round(settings.wrapUpAtTokens / 1000));
  const [saving, setSaving] = useState(false);
  const denyList = denyRules
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);

  const dirty =
    defaultModel !== settings.defaultModel ||
    defaultPermission !== settings.defaultPermission ||
    maxHops !== settings.maxHops ||
    projectsRoot !== settings.projectsRoot ||
    denyList.join('\n') !== (settings.denyRules || []).join('\n') ||
    rotateK * 1000 !== settings.rotateAtTokens ||
    wrapUpK * 1000 !== settings.wrapUpAtTokens;

  const save = async () => {
    setSaving(true);
    try {
      const hops = Math.max(0, Math.min(30, Math.round(maxHops) || 0));
      const r = await api.updateSettings({
        defaultModel: defaultModel.trim(),
        defaultPermission,
        maxHops: hops,
        denyRules: denyList,
        rotateAtTokens: Math.max(0, Math.round(rotateK) || 0) * 1000,
        wrapUpAtTokens: Math.max(0, Math.round(wrapUpK) || 0) * 1000,
        ...(projectsRoot.trim() ? { projectsRoot: projectsRoot.trim() } : {}),
      });
      useStore.setState({ settings: r.settings });
      setMaxHops(r.settings.maxHops);
      setProjectsRoot(r.settings.projectsRoot);
      toast('Defaults saved', undefined, 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section icon={<SlidersHorizontal size={18} />} title="Defaults">
      <div className="form-grid">
        <div className="field">
          <label>Default model</label>
          <ModelPicker value={defaultModel} onChange={setDefaultModel} />
          <div className="hint">Used when a bot doesn't set its own model</div>
        </div>
        <div className="field">
          <label>Default permission for new bots</label>
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
          <label>Auto hand-off limit</label>
          <input className="input num-input" type="number" min={0} max={30} value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} />
          <div className="hint">Max times bots can @ each other in a group chat, to prevent endless loops</div>
        </div>
        <div className="field">
          <label>Start a new session above this context (k tokens)</label>
          <input className="input num-input" type="number" min={0} step={10} value={rotateK} onChange={(e) => setRotateK(Number(e.target.value))} />
          <div className="hint">
            A resumed session rereads the whole history on every call, so long chats get pricier. Above this size, the next turn starts a new session that carries the last 12 messages. A new session
            itself is about 40k. Set 0 to never switch.
          </div>
        </div>
        <div className="field">
          <label>Ask to wrap up above this context in one turn (k tokens)</label>
          <input className="input num-input" type="number" min={0} step={10} value={wrapUpK} onChange={(e) => setWrapUpK(Number(e.target.value))} />
          <div className="hint">
            Every tool call in a turn rereads the whole context, so long tasks get pricier. Above this size, the bot is told to wrap up after its current step: note what's done and what's left, hand
            back, and continue in a new session next turn. Set 0 to never remind.
          </div>
        </div>
        <div className="field">
          <label>Projects folder</label>
          <input className="input mono" value={projectsRoot} placeholder="~/CrewProjects" onChange={(e) => setProjectsRoot(e.target.value)} />
          <div className="hint">New projects go here</div>
        </div>
        <div className="field span-all">
          <label>Forbidden actions</label>
          <textarea className="input mono" rows={3} value={denyRules} placeholder={'One per line, e.g.\nBash(*prod-server*)\nBash(rm -rf /*)'} onChange={(e) => setDenyRules(e.target.value)} />
          <div className="hint">
            Always denied for every bot and project in any permission mode, even "Full auto". Same syntax as "Always ask"; * matches anything. This matches command text, so it only guards against
            mistakes. The sandbox below is what actually blocks network access.
          </div>
        </div>
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
