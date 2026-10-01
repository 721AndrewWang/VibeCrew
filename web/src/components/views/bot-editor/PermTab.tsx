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
        <label>权限级别</label>
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
      <RuleList label="自动允许（不用问你）" tone="green" value={draft.allowRules} onChange={(allowRules) => patch({ allowRules })} />
      <RuleList label="必须确认（无论权限级别）" tone="orange" value={draft.askRules} onChange={(askRules) => patch({ askRules })} />
      <div className="note">
        <FileQuestion size={14} />
        <span>
          规则写法：<code className="inline-code">Bash(npm run *)</code>、<code className="inline-code">Bash(git push*)</code>、<code className="inline-code">Edit</code>、
          <code className="inline-code">Edit(src/**)</code>、<code className="inline-code">WebFetch(domain:github.com)</code>、<code className="inline-code">mcp__github</code>。
          在对话里点「总是允许」也会自动加到这里。
        </span>
      </div>
    </div>
  );
}
