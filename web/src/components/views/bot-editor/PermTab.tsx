import { Check, FileQuestion } from 'lucide-react';
import type { Bot, PermissionLevel } from '../../../../../shared/types';
import { cx, PERMISSION_INFO } from '../../../utils';
import { Glyph } from '../../ui';
import { RuleList } from './RuleList';

const PERMISSION_ORDER: PermissionLevel[] = ['plan', 'ask', 'review', 'edits', 'auto'];

export function PermTab({ draft, patch }: { draft: Bot; patch: (p: Partial<Bot>) => void }) {
  return (
    <div className="tab-body">
      <div className="field">
        <label>Permission level</label>
        <div className="choice-list">
          {PERMISSION_ORDER.map((level) => {
            const info = PERMISSION_INFO[level];
            const on = draft.permission === level;
            return (
              <button key={level} className={cx('choice-card row-card', on && 'on')} onClick={() => patch({ permission: level })}>
                <span className="cc-icon">
                  <Glyph emoji={info.icon} size={18} />
                </span>
                <div className="cc-text">
                  <div className="cc-title">{info.label}</div>
                  <div className="cc-desc">{info.desc}</div>
                </div>
                <span className="cc-radio">{on && <Check size={12} />}</span>
              </button>
            );
          })}
        </div>
      </div>
      <RuleList
        label="Editable paths only (its area of responsibility)"
        hint="Leave empty for no limit. Once set, it can't edit files outside this scope and will @ the teammate in charge. E.g. tests/**, src/styles/**, **/*.md"
        tone="orange"
        value={draft.editScope || []}
        onChange={(editScope) => patch({ editScope })}
      />
      <div className="field">
        <label>Monthly budget (USD)</label>
        <input
          className="input num-input"
          type="number"
          min={0}
          step={1}
          value={draft.monthlyBudgetUsd ?? ''}
          placeholder="No limit"
          onChange={(e) => patch({ monthlyBudgetUsd: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })}
        />
        <div className="hint">
          Adds up the per-turn cost Claude Code reports. Once used up, the bot takes no more tasks this month. With another model provider the cost is 0, so this has no effect.
        </div>
      </div>
      <RuleList label="Auto-allow (without asking you)" tone="green" value={draft.allowRules} onChange={(allowRules) => patch({ allowRules })} />
      <RuleList label="Always ask (any permission level)" tone="orange" value={draft.askRules} onChange={(askRules) => patch({ askRules })} />
      <div className="note">
        <FileQuestion size={14} />
        <span>
          Rule syntax: <code className="inline-code">Bash(npm run *)</code>, <code className="inline-code">Bash(git push*)</code>, <code className="inline-code">Edit</code>,
          <code className="inline-code">Edit(src/**)</code>, <code className="inline-code">WebFetch(domain:github.com)</code>, <code className="inline-code">mcp__github</code>. Clicking "Always allow"
          in a chat also adds rules here.
        </span>
      </div>
    </div>
  );
}
