import { Check, Copy } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { copyText } from '../../../utils';

export function Section({ icon, title, extra, children }: { icon: ReactNode; title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="card settings-card">
      <div className="sc-head">
        <span className="sc-icon">{icon}</span>
        <h2>{title}</h2>
        <span className="spacer" />
        {extra}
      </div>
      <div className="sc-body">{children}</div>
    </section>
  );
}

export function CodeLine({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-line">
      <code>{code}</code>
      <button
        className="icon-btn sm"
        title="Copy"
        onClick={() =>
          void copyText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}
