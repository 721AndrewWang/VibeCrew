// Speculative execution (ADR 008): fixes Crew made and verified in the background, before anyone
// asked. Only verified ones are shown: the problem was reproduced, and the project's checks fail
// without the fix and pass with it. Merge applies exactly the diff shown; Discard throws it away.

import { FileDiff, GitMerge, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Speculation, SpeculationStatus, SpeculativeSignal } from '../../../shared/types';
import { api } from '../api';
import { toast, useStore } from '../store';
import { cx, fmtRelative } from '../utils';
import { UnifiedDiff } from './computer/DiffView';
import { Modal } from './ui';

export const SIGNAL_LABEL: Record<SpeculativeSignal, string> = {
  'failing-check': 'Failing check',
  'console-error': 'Console error',
  'bug-report': 'Bug report',
};

export const SPECULATION_STATUS: Record<SpeculationStatus, { label: string; cls: string }> = {
  skipped: { label: 'Skipped', cls: '' },
  running: { label: 'Working', cls: 'accent' },
  verifying: { label: 'Running the checks', cls: 'accent' },
  ready: { label: 'Fix ready', cls: 'orange' },
  merged: { label: 'Merged', cls: 'green' },
  discarded: { label: 'Discarded', cls: '' },
};

function DiffDialog({ sp, onClose }: { sp: Speculation; onClose: () => void }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.speculationDiff(sp.id).then(
      (r) => setDiff(r.diff),
      (e) => setError((e as Error).message),
    );
  }, [sp.id]);
  return (
    <Modal title="Speculative fix" icon={<FileDiff size={16} />} onClose={onClose} wide>
      <div className="muted spec-diff-head">
        {sp.summary}
        <br />
        <code>
          git diff {sp.base?.slice(0, 8)} {sp.head?.slice(0, 8)}
        </code>
        : exactly what Merge applies.
      </div>
      {error ? <div className="muted pad">{error}</div> : diff === null ? <div className="muted pad">Loading…</div> : <UnifiedDiff text={diff} />}
    </Modal>
  );
}

/** One run: a verified fix with its evidence and actions, or how a run ended. */
export function SpeculationCard({ sp, compact }: { sp: Speculation; compact?: boolean }) {
  const bot = useStore((s) => (sp.botId ? s.bots[sp.botId] : undefined));
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState(false);
  const st = SPECULATION_STATUS[sp.status];
  const ready = sp.status === 'ready';
  const run = async (fn: () => Promise<unknown>, what: string, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast(what, (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const fix = (sp.files || []).filter((f) => !f.test);
  const tests = (sp.files || []).filter((f) => f.test);
  return (
    <div className={cx('draft-card spec-card', sp.status)} data-speculation={sp.id}>
      <div className="draft-head">
        <Sparkles size={14} />
        <b>{SIGNAL_LABEL[sp.signal]}</b>
        <span className="draft-target">{sp.summary}</span>
        <span className="spacer" />
        <span className={cx('badge', st.cls)}>{st.label}</span>
      </div>
      <div className="muted draft-by">
        Found in the background{bot ? ` as ${bot.name}` : ''} · {fmtRelative(sp.at)}
        {sp.costUsd ? ` · $${sp.costUsd.toFixed(2)}` : ''}
      </div>
      {sp.claim?.summary && <div>{sp.claim.summary}</div>}
      {!!fix.length && (
        <div className="spec-files">
          <span className="muted">Fix:</span>{' '}
          {fix.map((f) => (
            <code key={f.path}>
              {f.path} <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
            </code>
          ))}
          {!!tests.length && (
            <>
              {' '}
              <span className="muted">Reproduction:</span>{' '}
              {tests.map((f) => (
                <code key={f.path}>{f.path}</code>
              ))}
            </>
          )}
        </div>
      )}
      {sp.checks?.after && sp.checks.before && !compact && (
        <div className="muted">
          <code>{sp.checkCommand}</code> fails without the fix (exit code {sp.checks.before.exitCode ?? '?'}) and passes with it.
        </div>
      )}
      {sp.why && sp.status !== 'ready' && <div className="muted">{sp.why}</div>}
      {ready && (
        <div className="approval-actions">
          <button className="btn sm" onClick={() => setDiff(true)}>
            <FileDiff size={13} /> View diff
          </button>
          <button className="btn primary sm" disabled={busy} onClick={() => void run(() => api.mergeSpeculation(sp.id), "Couldn't merge it", 'Fix merged')}>
            <GitMerge size={13} /> Merge
          </button>
          <button className="btn sm danger" disabled={busy} onClick={() => void run(() => api.discardSpeculation(sp.id), "Couldn't discard it")}>
            <Trash2 size={13} /> Discard
          </button>
        </div>
      )}
      {diff && <DiffDialog sp={sp} onClose={() => setDiff(false)} />}
    </div>
  );
}

/** The note a ready fix posted in the chat: one line, its status kept live; the actions are in the bar above the composer. */
export function SpeculationNotice({ id, fallback }: { id: string; fallback: string }) {
  const sp = useStore((s) => s.speculations[id]);
  const [diff, setDiff] = useState(false);
  const st = sp ? SPECULATION_STATUS[sp.status] : undefined;
  return (
    <div className="msg-system trigger-notice spec-notice" data-speculation={id}>
      <span>
        <Sparkles size={12} /> {fallback} {st && <span className={cx('badge', st.cls)}>{sp?.status === 'ready' ? 'Fix ready: merge it above the composer' : st.label}</span>}{' '}
        {sp?.status === 'ready' && (
          <button className="link-btn" onClick={() => setDiff(true)}>
            View diff
          </button>
        )}
      </span>
      {diff && sp && <DiffDialog sp={sp} onClose={() => setDiff(false)} />}
    </div>
  );
}

/** Above the composer: the chat's verified fixes waiting for the user. */
export function SpeculativeBar({ chatId }: { chatId: string }) {
  const all = useStore((s) => s.speculations);
  const ready = useMemo(
    () =>
      Object.values(all)
        .filter((sp) => sp.chatId === chatId && sp.status === 'ready')
        .sort((a, b) => a.at - b.at),
    [all, chatId],
  );
  if (!ready.length) return null;
  return (
    <div className="drafts-bar spec-bar">
      <div className="wb-head">
        <Sparkles size={14} />
        <span>
          {ready.length} speculative fix{ready.length === 1 ? '' : 'es'} ready <span className="muted">· reproduced and checked in the background; nothing changes until you merge</span>
        </span>
      </div>
      {ready.map((sp) => (
        <SpeculationCard key={sp.id} sp={sp} />
      ))}
    </div>
  );
}
