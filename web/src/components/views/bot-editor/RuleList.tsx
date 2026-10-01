import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { cx } from '../../../utils';

export function RuleList({ label, hint, value, onChange, tone }: { label: string; hint?: string; value: string[]; onChange: (v: string[]) => void; tone: 'green' | 'orange' }) {
  const [text, setText] = useState('');
  const add = () => {
    const r = text.trim();
    if (!r) return;
    if (!value.includes(r)) onChange([...value, r]);
    setText('');
  };
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <div className="hint">{hint}</div>}
      <div className={cx('rule-box', tone)}>
        {value.length === 0 && <span className="muted rule-empty">（没有规则）</span>}
        {value.map((r) => (
          <span key={r} className="rule-tag mono">
            {r}
            <button type="button" aria-label="移除" onClick={() => onChange(value.filter((x) => x !== r))}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="row">
        <input
          className="input mono"
          value={text}
          placeholder="例如 Bash(npm run *)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn" disabled={!text.trim()} onClick={add}>
          <Plus size={14} /> 添加
        </button>
      </div>
    </div>
  );
}
