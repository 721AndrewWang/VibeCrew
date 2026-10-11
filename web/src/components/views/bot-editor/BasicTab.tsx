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
          <label>Avatar</label>
          <input className="input emoji-input" value={draft.emoji} maxLength={8} onChange={(e) => patch({ emoji: e.target.value })} />
        </div>
        <div className="field grow">
          <label>Color</label>
          <ColorPicker value={draft.color} onChange={(color) => patch({ color })} />
          <MonoAvatarHint />
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input className={cx('input', !nameOk && 'invalid')} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
          <div className={cx('hint', !nameOk && 'error-text')}>Used for @mentions, no spaces</div>
        </div>
        <div className="field">
          <label>Title</label>
          <input className="input" value={draft.title} placeholder="e.g. Frontend engineer · pages and interaction" onChange={(e) => patch({ title: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Role description (becomes its system prompt)</label>
        <textarea
          className="textarea tall"
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="Describe its expertise, what it's responsible for and how it works."
        />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Model</label>
          <ModelPicker value={draft.model} onChange={(model) => patch({ model })} />
        </div>
        <div className="field">
          <label>Effort</label>
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
          <div className="sr-title">Start each turn in a new session</div>
          <div className="hint">
            Doesn't resume the previous conversation; each turn reads only new messages, so costs don't snowball. Good for roles like QA or review that only need the current state. Leave it off for
            roles that need to remember earlier context.
          </div>
        </div>
        <Toggle on={!!draft.freshSession} onChange={(freshSession) => patch({ freshSession })} />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">Judge results only, not teammates' notes (adversarial review)</div>
          <div className="hint">
            Each turn it gets only the user's request and the changes themselves. Teammates' notes are hidden so it isn't swayed by the author's reasoning. Its verdict is recorded on the isolated
            workspace and can gate merging.
          </div>
        </div>
        <Toggle on={!!draft.blindReview} onChange={(blindReview) => patch({ blindReview })} />
      </div>
      <div className="field">
        <label>Default project</label>
        <ProjectSelect value={draft.projectId} onChange={(projectId) => patch({ projectId })} noneLabel="None" />
        <div className="hint">Its direct chat uses this project</div>
      </div>
    </div>
  );
}
