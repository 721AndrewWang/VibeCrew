import { Bot as BotIcon, Clock, FilePen, GitMerge, GitPullRequest, MessageCircle, Radio, RefreshCw, Sparkles, TerminalSquare, Timer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Thread, Trigger, TriggerDetail, TriggerList, TriggerSource } from '../../../../shared/types';
import { api } from '../../api';
import { loadTriggers, openChat, useStore } from '../../store';
import { fmtCost, TRIGGER_VERDICT } from '../../superagent';
import { cx, fmtRelative, fmtShort } from '../../utils';
import { EmptyState, ErrorState, LoadingState, OffNotice, StatusBadge } from '../SuperAgentUi';
import { Modal, useNow } from '../ui';
import { PageHead } from './BotsView';

export const SOURCE_LABEL: Record<TriggerSource, string> = {
  user: 'User message',
  routine: 'Routine run',
  turn: 'Turn result',
  'outside-edit': 'Outside edit',
  'preview-console': 'Console error',
  landing: 'Worker merge',
  job: 'Job result',
  speculative: 'Speculative fix',
  github: 'GitHub',
};

const SOURCE_ICON: Record<TriggerSource, typeof Radio> = {
  user: MessageCircle,
  routine: Clock,
  turn: BotIcon,
  'outside-edit': FilePen,
  'preview-console': TerminalSquare,
  landing: GitMerge,
  job: Timer,
  speculative: Sparkles,
  github: GitPullRequest,
};

function VerdictBadge({ t }: { t: Trigger }) {
  const v = TRIGGER_VERDICT[t.filter.verdict];
  return <StatusBadge status={{ ...v, label: `${v.label} · ${t.filter.stage}` }} title={`${t.filter.stage === 'fast' ? 'Fast path (rules)' : 'Slow path (cheap model)'}: ${t.filter.rule}`} />;
}

function SourceTag({ source }: { source: TriggerSource }) {
  const Icon = SOURCE_ICON[source];
  return (
    <span className="trigger-source">
      <Icon size={13} aria-hidden /> {SOURCE_LABEL[source]}
    </span>
  );
}

function TriggerRow({ t, thread, onOpen }: { t: Trigger; thread?: Thread; onOpen: () => void }) {
  return (
    <button className="trigger-row" onClick={onOpen} data-trigger={t.id}>
      <span className="tr-time muted" title={new Date(t.at).toLocaleString()}>
        {fmtShort(t.at)}
      </span>
      <SourceTag source={t.source} />
      <span className="tr-main">
        <span className="tr-summary">{t.summary}</span>
        <span className="tr-meta muted">
          {thread?.title || t.threadId} · {t.filter.reason}
          {t.action ? ` · ${t.action}` : ''}
        </span>
      </span>
      <VerdictBadge t={t} />
    </button>
  );
}

/** One trigger, its full payload and its neighbours; ids are links, so the graph can be walked hop by hop. */
export function TriggerDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const [cur, setCur] = useState(id);
  const [d, setD] = useState<TriggerDetail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry button's way to load again
  useEffect(() => {
    setD(null);
    setError('');
    api
      .trigger(cur)
      .then(setD)
      .catch((e) => setError((e as Error).message));
  }, [cur, attempt]);
  const t = d?.trigger;
  const link = (x: Trigger) => (
    <button key={x.id} className="trigger-link" onClick={() => setCur(x.id)} disabled={x.id === cur}>
      <span className="mono">{x.id}</span> <span className="muted">{SOURCE_LABEL[x.source]}</span> {x.summary}
    </button>
  );
  return (
    <Modal title={t ? SOURCE_LABEL[t.source] : 'Trigger'} icon={<Radio size={20} className="modal-icon" />} onClose={onClose} wide>
      {error && <ErrorState message={`Couldn't load this Trigger: ${error}`} onRetry={() => setAttempt(attempt + 1)} />}
      {!d && !error && <LoadingState label="Loading the Trigger…" />}
      {t && d && (
        <div className="trigger-detail">
          <div className="trigger-facts">
            <span className="mono">{t.id}</span>
            <span>{new Date(t.at).toLocaleString()}</span>
            <VerdictBadge t={t} />
            {t.explicit && <span className="badge accent">Explicit request</span>}
          </div>
          <div className="tr-summary">{t.summary}</div>
          <div className="hint">
            {t.filter.stage === 'fast' ? 'Rules' : `Cheap model (${t.filter.slow?.backend}, batch of ${t.filter.slow?.batch}, ${fmtCost(t.filter.slow?.costUsd)})`}: {t.filter.reason}
            {t.action ? `. ${t.action}.` : ''}
          </div>
          <div className="trigger-facts">
            <span>
              Thread <b>{d.thread?.title || t.threadId}</b> <span className="mono muted">{t.threadId}</span>
            </span>
            {d.thread?.closedAt && <span className="muted">closed {fmtRelative(d.thread.closedAt)}</span>}
            {t.chatId && (
              <button
                className="btn sm"
                onClick={() => {
                  onClose();
                  openChat(t.chatId!);
                }}
              >
                <MessageCircle size={13} aria-hidden /> Open chat
              </button>
            )}
          </div>
          <pre className="trigger-payload">{d.detail}</pre>
          {d.related.length > 0 && (
            <div className="field">
              <label>Related</label>
              <div className="trigger-links">{d.related.map(link)}</div>
            </div>
          )}
          {d.recent.length > 1 && (
            <div className="field">
              <label>Latest in this thread</label>
              <div className="trigger-links">{d.recent.map(link)}</div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function TriggersView() {
  const { list, threads, loaded } = useStore((s) => s.triggers);
  const enabled = useStore((s) => s.settings.superAgent.enabled);
  const [stats, setStats] = useState<TriggerList['stats'] | null>(null);
  const [source, setSource] = useState<TriggerSource | ''>('');
  const [verdict, setVerdict] = useState<Trigger['filter']['verdict'] | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  useNow(30_000);

  const refresh = () => {
    setRefreshing(true);
    void loadTriggers()
      .then((r) => {
        setFailed(!r);
        if (r) setStats(r.stats);
      })
      .finally(() => setRefreshing(false));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, and again after a reconnect resets the list
  useEffect(() => {
    if (!loaded) refresh();
  }, [loaded]);

  const shown = useMemo(() => list.filter((t) => (!source || t.source === source) && (!verdict || t.filter.verdict === verdict)), [list, source, verdict]);

  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Triggers" sub="Events Crew saw, the thread each one joined, and what the two-stage filter decided">
          <button className="btn" onClick={refresh} disabled={refreshing}>
            {refreshing ? <span className="spinner" aria-hidden /> : <RefreshCw size={14} aria-hidden />} Refresh
          </button>
        </PageHead>
        {!enabled && <OffNotice part="triggers">No new events are recorded; the ones below are from before.</OffNotice>}
        {stats && (
          <div className="routing-totals trigger-stats">
            <span>
              In the log <b>{stats.total}</b>
            </span>
            <span>Acted on {stats.act}</span>
            {stats.direct > 0 && <span title="Went straight to the Workers subscribed to their thread, with no Router decision">Straight to Workers {stats.direct}</span>}
            <span>Dropped {stats.drop}</span>
            {stats.candidate > 0 && <span>Deciding {stats.candidate}</span>}
            <span>
              Model calls {stats.slowCalls} ({fmtCost(stats.slowCostUsd)})
            </span>
          </div>
        )}
        <div className="trigger-filters">
          <span className="segmented wrap" role="group" aria-label="Filter by source">
            <button className={cx(!source && 'on')} aria-pressed={!source} onClick={() => setSource('')}>
              All
            </button>
            {(Object.keys(SOURCE_LABEL) as TriggerSource[]).map((s) => (
              <button key={s} className={cx(source === s && 'on')} aria-pressed={source === s} onClick={() => setSource(s)}>
                {SOURCE_LABEL[s]}
              </button>
            ))}
          </span>
          <span className="segmented" role="group" aria-label="Filter by verdict">
            <button className={cx(!verdict && 'on')} aria-pressed={!verdict} onClick={() => setVerdict('')}>
              Any
            </button>
            {(Object.keys(TRIGGER_VERDICT) as Trigger['filter']['verdict'][]).map((v) => (
              <button key={v} className={cx(verdict === v && 'on')} aria-pressed={verdict === v} onClick={() => setVerdict(v)}>
                {TRIGGER_VERDICT[v].label}
              </button>
            ))}
          </span>
        </div>
        {!loaded ? (
          <div className="card">{failed && !refreshing ? <ErrorState message="Couldn't load the Triggers." onRetry={refresh} /> : <LoadingState label="Loading Triggers…" />}</div>
        ) : !shown.length ? (
          <div className="card">
            {list.length ? (
              <EmptyState
                title="No Triggers match these filters"
                action={
                  <button
                    className="btn sm"
                    onClick={() => {
                      setSource('');
                      setVerdict('');
                    }}
                  >
                    Show all
                  </button>
                }
              />
            ) : (
              <EmptyState icon={<Radio size={18} />} title="No Triggers yet">
                {enabled
                  ? 'Send a message, run a routine or edit a file: each event shows up here with the Thread it joined and what the filter decided.'
                  : 'Turn on Triggers in Settings → Super-agent and events start showing up here.'}
              </EmptyState>
            )}
          </div>
        ) : (
          <div className="card trigger-list">
            {shown.map((t) => (
              <TriggerRow key={t.id} t={t} thread={threads[t.threadId]} onOpen={() => setOpen(t.id)} />
            ))}
          </div>
        )}
      </div>
      {open && <TriggerDialog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
