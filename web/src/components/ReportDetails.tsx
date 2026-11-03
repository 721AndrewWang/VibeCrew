// A Router reply under the chat profile (ADR 103): what kind of message it is, and the Worker
// reports behind it, collapsed. The chat shows the Router's few words and each report's gist; the
// full report is one click away, and the Worker's transcript one more while the Worker exists.

import { ChevronRight, ScrollText } from 'lucide-react';
import type { ChannelMeta, Chat, ReplyKind, ReportDetail } from '../../../shared/types';
import { openModal, useStore } from '../store';
import { cx } from '../utils';
import { Markdown } from './Markdown';

const KIND: Partial<Record<ReplyKind, string>> = { question: 'Question', acceptance: 'Needs your OK' };

/** A label for replies that need the user; decisions need none. */
export function ReplyKindLabel({ channel }: { channel?: ChannelMeta }) {
  const label = channel && KIND[channel.kind];
  return label ? <span className={cx('msg-meta reply-kind', channel.kind)}>{label}</span> : null;
}

const STATUS: Record<ReportDetail['status'], string> = { done: 'done', error: 'failed', stopped: 'stopped' };

function DetailRow({ d, chat }: { d: ReportDetail; chat: Chat }) {
  const exists = useStore((s) => !!s.workers[d.workerId]);
  return (
    <details className="report-detail" data-worker={d.workerId}>
      <summary>
        <ChevronRight size={13} className="rd-chevron" />
        <span className="rd-title">
          <b>{d.title}</b>{' '}
          <span className="muted">
            · {d.bot} · {STATUS[d.status]}
          </span>
        </span>
        {d.gist && <span className="rd-gist muted">{d.gist}</span>}
      </summary>
      <div className="rd-body">
        {d.report.trim() ? <Markdown text={d.report} /> : <div className="muted">No written report.</div>}
        {d.landing && <div className="hint">{d.landing}</div>}
        {exists && (
          <button className="link-btn" onClick={() => openModal({ kind: 'agentLog', chatId: chat.id, workerId: d.workerId })}>
            <ScrollText size={12} /> Open transcript
          </button>
        )}
      </div>
    </details>
  );
}

export function ReportDetails({ channel, chat }: { channel?: ChannelMeta; chat: Chat }) {
  if (!channel?.details?.length) return null;
  return (
    <section className="report-details" aria-label="Details">
      <div className="rd-head muted">Details</div>
      {channel.details.map((d) => (
        <DetailRow key={d.workerId} d={d} chat={chat} />
      ))}
    </section>
  );
}
