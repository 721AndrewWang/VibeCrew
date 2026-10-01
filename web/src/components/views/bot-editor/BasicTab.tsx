import type { Bot, Effort } from '../../../../../shared/types';
import { cx, EFFORT_OPTIONS } from '../../../utils';
import { Toggle } from '../../ui';
import { ProjectSelect } from '../ProjectsView';
import { ColorPicker, MonoAvatarHint } from './identity';
import { ModelPicker } from './ModelPicker';

export function BasicTab({ draft, patch, nameOk }: { draft: Bot; patch: (p: Partial<Bot>) => void; nameOk: boolean }) {
  return (
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
      <div className="setting-row">
        <div>
          <div className="sr-title">每轮从新会话开始</div>
          <div className="hint">不续上之前的对话，每轮只读新消息，费用不会越滚越大。适合验收、审查这类每次看当前状态就够的角色；需要记得前情的角色别开。</div>
        </div>
        <Toggle on={!!draft.freshSession} onChange={(freshSession) => patch({ freshSession })} />
      </div>
      <div className="field">
        <label>默认项目</label>
        <ProjectSelect value={draft.projectId} onChange={(projectId) => patch({ projectId })} noneLabel="不绑定" />
        <div className="hint">它的单聊使用这个项目</div>
      </div>
    </div>
  );
}
