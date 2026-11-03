// The building blocks every Super-agent view shares (ADR 107): one status badge, one empty, loading
// and error state, one "this part is off" notice that lands on its switch, one link to a Trigger,
// one way to show a cost, and the short explanation of Router, Workers and Triggers.

import { AlertTriangle, Network, Radio, RefreshCw, ShieldCheck, Workflow } from 'lucide-react';
import { cloneElement, isValidElement, type ReactElement, type ReactNode, useId } from 'react';
import { openModal, setView } from '../store';
import { fmtCost, PART, type PartId, partAnchor, type StatusInfo, TONE_CLASS } from '../superagent';
import { cx } from '../utils';

export function StatusBadge({ status, title, className }: { status: StatusInfo; title?: string; className?: string }) {
  return (
    <span className={cx('badge', TONE_CLASS[status.tone], className)} data-tone={status.tone} title={title}>
      {status.label}
    </span>
  );
}

/** A labelled form field: the label names the control for screen readers, and the hint describes it. */
export function Field({ label, hint, children, testId }: { label: ReactNode; hint?: ReactNode; children: ReactElement<{ id?: string; 'aria-describedby'?: string }>; testId?: string }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = isValidElement(children) ? cloneElement(children, { id, 'aria-describedby': hint ? hintId : undefined }) : children;
  return (
    <div className="field" data-testid={testId}>
      <label htmlFor={id}>{label}</label>
      {control}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** Nothing to show yet: what would appear here, and how to make it appear. */
export function EmptyState({ icon, title, children, action, compact }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx('sa-state sa-empty', compact && 'compact')}>
      {icon && <span className="sa-state-icon">{icon}</span>}
      <div className="sa-state-title">{title}</div>
      {children && <div className="sa-state-body">{children}</div>}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Loading…', compact }: { label?: string; compact?: boolean }) {
  return (
    <div className={cx('sa-state sa-loading', compact && 'compact')} role="status" aria-live="polite">
      <span className="spinner" aria-hidden /> <span>{label}</span>
    </div>
  );
}

export function ErrorState({ message, onRetry, compact }: { message: string; onRetry?: () => void; compact?: boolean }) {
  return (
    <div className={cx('sa-state sa-error', compact && 'compact')} role="alert">
      <AlertTriangle size={15} aria-hidden />
      <span>{message}</span>
      {onRetry && (
        <button className="btn ghost sm" onClick={onRetry}>
          <RefreshCw size={13} /> Try again
        </button>
      )}
    </div>
  );
}

/** Opens Settings (or Projects, for a per-project part) and puts focus on the part's switch. */
export function goToPart(id: PartId) {
  const part = PART[id];
  setView(part.scope === 'project' ? 'projects' : part.scope === 'bot' ? 'bots' : 'settings');
  if (part.scope === 'project' || part.scope === 'bot') return;
  const anchor = part.scope === 'gateway' ? 'settings-gateway' : partAnchor(id);
  // The page renders on the next frames; look for the block for a moment.
  let tries = 0;
  const find = () => {
    const el = document.getElementById(anchor);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.querySelector<HTMLElement>('.toggle, button, input')?.focus({ preventScroll: true });
    } else if (tries++ < 30) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}

/** "<Part> is off": what that means here, and a button that lands on its switch. */
export function OffNotice({ part, children }: { part: PartId; children: ReactNode }) {
  const p = PART[part];
  return (
    <div className="notice sa-off" data-part={part}>
      <span>
        <b>{p.name} is off.</b> {children}
      </span>
      <button className="btn ghost sm" onClick={() => goToPart(part)}>
        Turn it on
      </button>
    </div>
  );
}

/** A Trigger id as a link: it opens the Trigger with its Thread and neighbours. */
export function TriggerLink({ id, children }: { id: string; children?: ReactNode }) {
  return (
    <button className="link-btn sa-trigger-link" onClick={() => openModal({ kind: 'trigger', triggerId: id })} aria-label={`Open Trigger ${id}`} title="Open the Trigger that started this">
      {children ?? <span className="mono">{id}</span>}
    </button>
  );
}

export function Cost({ usd, label = 'spent so far' }: { usd: number | undefined; label?: string }) {
  return (
    <span className="sa-cost" title={`Model spend ${label}`}>
      {fmtCost(usd)}
    </span>
  );
}

const PRIMER: { icon: typeof Radio; name: string; text: string }[] = [
  {
    icon: Radio,
    name: 'Triggers',
    text: 'Everything that happens (your messages, routine runs, test results, console errors, GitHub events) becomes a Trigger on a Thread of related ones. Rules in code settle most of them; a cheap model judges the rest against your policies.',
  },
  { icon: Network, name: 'Router', text: 'One per group chat. It reads what needs a decision, answers you in a few words and hands tasks to Workers. It never runs commands itself.' },
  {
    icon: Workflow,
    name: 'Workers',
    text: 'One task each, in its own session and git worktree, as one of the chat’s members. They report to the Router and their work is merged into the chat’s branch; you can watch or stop any of them.',
  },
  {
    icon: ShieldCheck,
    name: 'Watchdog',
    text: 'A timer outside the chats that notices stuck or failing work and steps in within hard limits. Anything sent in your name waits as a draft until you approve it.',
  },
];

/** Router, Workers and Triggers in four sentences, for Settings and the empty Activity page. */
export function SuperAgentPrimer() {
  return (
    <div className="sa-primer" data-testid="sa-primer">
      {PRIMER.map((p) => (
        <div key={p.name} className="sa-primer-item">
          <span className="sa-primer-icon" aria-hidden>
            <p.icon size={16} />
          </span>
          <div>
            <div className="sa-primer-name">{p.name}</div>
            <div className="hint">{p.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
