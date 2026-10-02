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
    rotateK * 1000 !== settings.rotateAtTokens;

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
        ...(projectsRoot.trim() ? { projectsRoot: projectsRoot.trim() } : {}),
      });
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
          <label>上下文超过多少换新会话（k token）</label>
          <input className="input num-input" type="number" min={0} step={10} value={rotateK} onChange={(e) => setRotateK(Number(e.target.value))} />
          <div className="hint">续上的会话每次调用都要把全部历史重读一遍，越聊越贵。超过这个大小，下一轮换成新会话，带上最近 12 条消息。新会话本身大约 40k。填 0 就不换。</div>
        </div>
        <div className="field">
          <label>项目文件夹</label>
          <input className="input mono" value={projectsRoot} placeholder="~/CrewProjects" onChange={(e) => setProjectsRoot(e.target.value)} />
          <div className="hint">新建的项目放在这里</div>
        </div>
        <div className="field span-all">
          <label>禁止的操作</label>
          <textarea className="input mono" rows={3} value={denyRules} placeholder={'每行一条，例如\nBash(*prod-server*)\nBash(rm -rf /*)'} onChange={(e) => setDenyRules(e.target.value)} />
          <div className="hint">
            所有机器人、所有项目、任何权限模式下都直接拒绝，连「全自动」也不行。写法和「必须确认」一样，* 匹配任意内容。这是按命令文字匹配的，只能防误操作；真正挡住网络访问的是下面的沙盒。
          </div>
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
