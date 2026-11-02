// Draft-only external actions (ADR 007): what a bot wants to send out in the user's name (a push,
// a pull request, a comment, a message), with the exact command and target. Nothing runs until the
// user clicks Approve; there is no setting that runs drafts by themselves.

import { Check, Copy, Send, Trash2, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Chat, DraftKind, ExternalDraft } from '../../../shared/types';
import { api } from '../api';
import { toast, useStore } from '../store';
import { copyText, cx, fmtRelative } from '../utils';

export const DRAFT_KIND: Record<DraftKind, string> = {
  'git-push': 'Push',
  'pr-open': 'Open pull request',
  'pr-comment': 'Comment on pull request',
  'issue-open': 'Open issue',
  'issue-comment': 'Comment on issue',
  message: 'Message',
};

const STATUS: Record<ExternalDraft['status'], { label: string; cls: string }> = {
  pending: { label: 'Waiting for you', cls: 'orange' },
  running: { label: 'Running', cls: 'accent' },
  done: { label: 'Done', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' },
  discarded: { label: 'Discarded', cls: '' },
};

/** The command as a shell would read it: what the user sees is what runs. */
export function shellLine(argv: string[] | null): string {
  if (!argv) return '';
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

async function copy(text: string) {
  try {
    await copyText(text);
    toast('Copied', undefined, 'success');
  } catch {
    toast("Couldn't copy", 'Select the text and copy it by hand.', 'error');
  }
}

export function DraftCard({ draft: d, compact }: { draft: ExternalDraft; compact?: boolean }) {
  const bot = useStore((s) => (d.botId ? s.bots[d.botId] : undefined));
  const chat = useStore((s) => (d.chatId ? s.chats[d.chatId] : undefined));
  const [busy, setBusy] = useState(false);
  const pending = d.status === 'pending';
  const st = STATUS[d.status];
  const run = async (fn: () => Promise<unknown>, what: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(what, (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const command = shellLine(d.command);
  return (
    <div className={cx('draft-card', d.status)} data-draft={d.id}>
      <div className="draft-head">
        <Send size={14} />
        <b>{DRAFT_KIND[d.kind]}</b>
        <span className="draft-target">{d.target}</span>
        <span className="spacer" />
        <span className={cx('badge', st.cls)}>{st.label}</span>
      </div>
      <div className="muted draft-by">
        Drafted by {bot?.name || (d.botId ? 'a deleted bot' : 'you')}
        {!compact && chat ? ` in "${chat.title}"` : ''} · {fmtRelative(d.at)}
        {d.why ? ` · ${d.why}` : ''}
      </div>
      {d.title && <div className="draft-title">{d.title}</div>}
      {d.body && (
        <details open={!compact && d.kind !== 'git-push'}>
          <summary>{d.kind === 'message' ? 'Message' : 'Text'}</summary>
          <pre className="draft-body">{d.body}</pre>
        </details>
      )}
      {command ? (
        <div className="draft-cmd">
          <span className="muted">
            {pending ? 'Runs exactly, in' : 'Ran, in'} <code>{d.cwd}</code>:
          </span>
          <pre>{command}</pre>
        </div>
      ) : (
        <div className="muted">Nothing runs: copy it and post it yourself, then mark it posted.</div>
      )}
      {d.result && !pending && (
        <details open={d.status === 'failed'}>
          <summary>
            Output{d.result.url ? ' · ' : ''}
            {d.result.url && (
              <a href={d.result.url} target="_blank" rel="noreferrer">
                {d.result.url}
              </a>
            )}
          </summary>
          <pre className="draft-body">{d.result.output || '(no output)'}</pre>
        </details>
      )}
      {d.reverse && (
        <div className="draft-reverse">
          <Undo2 size={13} /> To undo: <code>{d.reverse}</code>
          <button className="icon-btn sm" title="Copy" onClick={() => void copy(d.reverse || '')}>
            <Copy size={12} />
          </button>
        </div>
      )}
      {pending && (
        <div className="approval-actions">
          {d.command ? (
            <button className="btn primary sm" disabled={busy} onClick={() => void run(() => api.approveDraft(d.id), "Couldn't run it")}>
              <Check size={13} /> Approve and run
            </button>
          ) : (
            <>
              <button className="btn sm" onClick={() => void copy(d.body || '')}>
                <Copy size={13} /> Copy
              </button>
              <button className="btn primary sm" disabled={busy} onClick={() => void run(() => api.approveDraft(d.id), "Couldn't mark it")}>
                <Check size={13} /> I posted it
              </button>
            </>
          )}
          <button className="btn sm danger" disabled={busy} onClick={() => void run(() => api.discardDraft(d.id), "Couldn't discard it")}>
            <Trash2 size={13} /> Discard
          </button>
        </div>
      )}
    </div>
  );
}

/** Above the composer: the chat's drafts waiting for the user. */
export function DraftsBar({ chat }: { chat: Chat }) {
  const all = useStore((s) => s.actionDrafts);
  const pending = useMemo(
    () =>
      Object.values(all)
        .filter((d) => d.chatId === chat.id && (d.status === 'pending' || d.status === 'running'))
        .sort((a, b) => a.at - b.at),
    [all, chat.id],
  );
  if (!pending.length) return null;
  return (
    <div className="drafts-bar">
      <div className="wb-head">
        <Send size={14} />
        <span>
          {pending.length} drafted action{pending.length === 1 ? '' : 's'} waiting for you <span className="muted">· nothing leaves this machine until you approve</span>
        </span>
      </div>
      {pending.map((d) => (
        <DraftCard key={d.id} draft={d} compact />
      ))}
    </div>
  );
}
