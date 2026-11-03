// The Watchdog page: its state and today's usage against the hard limits, "Tick now", the changes
// it proposes (accept or reject), the failures it watches, what it did, and a chat to ask it why
// something failed. The page only shows and controls; every limit is enforced on the server.

import { Check, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Chat, WatchdogAction, WatchdogOverview, WatchdogProposal } from '../../../../shared/types';
import { api } from '../../api';
import { loadLog, openChat, toast, useStore } from '../../store';
import { fmtCost, TICK_OUTCOME, WATCHDOG_STATE } from '../../superagent';
import { cx, fmtRelative, fmtShort } from '../../utils';
import { BotMessage, UserMessage } from '../Message';
import { EmptyState, ErrorState, LoadingState, OffNotice, StatusBadge } from '../SuperAgentUi';
import { useNow } from '../ui';
import { PageHead } from './BotsView';

const LOG_ID = 'watchdog';
/** The Watchdog's log is not a chat; message rendering only needs these fields. */
const LOG_CHAT = { id: LOG_ID, kind: 'dm', title: 'Watchdog', botIds: [], projectId: null, seq: 0, createdAt: 0, updatedAt: 0, maxHops: 0 } as unknown as Chat;

const ACTION_LABEL: Record<WatchdogAction['kind'], string> = {
  nudge: 'Nudged',
  stop: 'Stopped',
  restart: 'Restarted',
  notify: 'Told a chat',
  watch: 'Watching',
  resolve: 'Resolved a watch',
  propose: 'Proposed',
};

async function run(fn: () => Promise<unknown>, what: string, done?: string) {
  try {
    await fn();
    if (done) toast(done, undefined, 'success');
  } catch (e) {
    toast(what, (e as Error).message, 'error');
  }
}

function Meter({ label, used, max, fmt = String }: { label: string; used: number; max: number; fmt?: (n: number) => string }) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 100;
  return (
    <div
      className="wd-meter"
      title={`${fmt(used)} of ${fmt(max)}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={used}
      aria-valuetext={`${fmt(used)} of ${fmt(max)}`}
    >
      <div className="wd-meter-head">
        <span>{label}</span>
        <b>
          {fmt(used)} / {fmt(max)}
        </b>
      </div>
      <div className="wd-meter-bar">
        <i style={{ width: `${pct}%` }} className={cx(pct >= 100 && 'full')} />
      </div>
    </div>
  );
}

function ProposalCard({ p, onDone }: { p: WatchdogProposal; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const decide = async (accept: boolean) => {
    setBusy(true);
    await run(() => (accept ? api.acceptWatchdogProposal(p.id) : api.rejectWatchdogProposal(p.id)), "Couldn't decide", accept ? 'Change applied' : 'Proposal rejected');
    setBusy(false);
    onDone();
  };
  return (
    <div className={cx('wd-card', p.status)} data-proposal={p.id}>
      <div className="wd-card-head">
        <b>{p.target === 'bot' ? `${p.botName || 'A bot'}: role description` : 'Trigger policies'}</b>
        <span className="muted">{fmtRelative(p.at)}</span>
        {p.status !== 'pending' && (
          <StatusBadge status={{ label: p.status === 'accepted' ? 'Accepted' : p.status === 'rejected' ? 'Rejected' : 'Out of date', tone: p.status === 'accepted' ? 'ok' : 'neutral' }} />
        )}
      </div>
      <div className="hint">{p.rationale}</div>
      <details>
        <summary>Current and proposed text</summary>
        <div className="wd-diff">
          <pre className="before">{p.before || '(empty)'}</pre>
          <pre className="after">{p.after}</pre>
        </div>
      </details>
      {p.status === 'pending' && (
        <div className="row">
          <span className="spacer" />
          <button className="btn sm" disabled={busy} onClick={() => void decide(false)}>
            <X size={13} aria-hidden /> Reject
          </button>
          <button className="btn primary sm" disabled={busy} onClick={() => void decide(true)}>
            <Check size={13} aria-hidden /> Accept
          </button>
        </div>
      )}
    </div>
  );
}

/** The conversation with the Watchdog: its ticks and answers, and the maintainers' questions. */
function WatchdogChat({ enabled }: { enabled: boolean }) {
  const st = useStore((s) => s.msgs[LOG_ID]);
  const bots = useStore((s) => s.bots);
  const names = useMemo(() => Object.values(bots).map((b) => b.name), [bots]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  useEffect(() => {
    void loadLog(LOG_ID, api.watchdogLog());
  }, []);
  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      await api.askWatchdog(text.trim());
      setText('');
    } catch (e) {
      toast("Couldn't send", (e as Error).message, 'error');
    } finally {
      setSending(false);
    }
  };
  const list = st?.list || [];
  return (
    <div className="wd-chat">
      <div className="agent-log msg-list" data-testid="watchdog-log">
        {!st?.loaded && <LoadingState label="Loading the Watchdog's log…" />}
        {st?.loaded && !list.length && (
          <EmptyState compact title="Nothing yet.">
            Ticks that find nothing flagged do not call the model, so they do not show here.
          </EmptyState>
        )}
        {list.map((m) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} msg={m} chat={LOG_CHAT} names={names} showTime />
          ) : (
            <div key={m.id}>
              {m.trigger?.type === 'system' && <div className="agent-batch muted">Tick {m.batch?.[0] || ''}</div>}
              <BotMessage msg={m} chat={LOG_CHAT} showHead names={names} label="Watchdog" />
            </div>
          ),
        )}
      </div>
      <div className="wd-compose">
        <textarea
          className="input"
          rows={2}
          value={text}
          aria-label="Ask the Watchdog"
          disabled={!enabled}
          placeholder={enabled ? 'Ask why something failed, or what it did…' : 'The Watchdog is off'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn primary" disabled={!enabled || sending || !text.trim()} onClick={() => void send()} title="Send" aria-label="Send the question">
          {sending ? <span className="spinner" /> : <Send size={14} aria-hidden />}
        </button>
      </div>
    </div>
  );
}

export function WatchdogView() {
  const live = useStore((s) => s.watchdog);
  // Speculative runs do not move the Watchdog's own state, so their spend is reloaded when they change.
  const runs = useStore((s) =>
    Object.values(s.speculations)
      .map((x) => `${x.id}:${x.status}:${x.costUsd}`)
      .join(),
  );
  const settingsOn = useStore((s) => s.settings.superAgent.enabled && s.settings.superAgent.watchdog.enabled);
  const [o, setO] = useState<WatchdogOverview | null>(null);
  const [error, setError] = useState('');
  useNow(30_000);
  const refresh = () =>
    void api
      .watchdog()
      .then((x) => {
        setO(x);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the lists whenever the live state moves on
  useEffect(() => {
    refresh();
  }, [live, runs]);

  const info = live ?? o;
  // The overview is reloaded on both kinds of change, so its figure for speculative runs is the newer one.
  const speculative = o?.speculative ?? info?.speculative;
  const pending = (o?.proposals || []).filter((p) => p.status === 'pending');
  const decided = (o?.proposals || []).filter((p) => p.status !== 'pending').slice(0, 5);
  const watches = (o?.watches || []).filter((w) => !w.resolvedAt);
  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Watchdog" sub="An external control loop: it checks Workers and errors on a timer, and steps in within hard limits">
          <button className="btn" onClick={refresh}>
            <RefreshCw size={14} aria-hidden /> Refresh
          </button>
          <button className="btn primary" disabled={!settingsOn || info?.state === 'thinking'} onClick={() => void run(() => api.watchdogTick(), "Couldn't tick")}>
            <ShieldCheck size={14} aria-hidden /> Tick now
          </button>
        </PageHead>
        {!settingsOn && <OffNotice part="watchdog">No timer runs and nothing is checked; what it did before is below.</OffNotice>}
        {error && <ErrorState message={`Couldn't load the Watchdog: ${error}`} onRetry={refresh} />}
        {!o && !error && <LoadingState label="Loading the Watchdog…" />}
        {info && o && (
          <div className="wd-status" data-testid="watchdog-status">
            <div className="wd-state">
              <StatusBadge status={WATCHDOG_STATE[info.state]} />
              {info.detail && <span className="muted">{info.detail}</span>}
              {info.nextTickAt && <span className="muted">Next tick {fmtRelative(info.nextTickAt)}</span>}
              {info.lastTick && (
                <span className="muted">
                  Last: {TICK_OUTCOME[info.lastTick.outcome].label.toLowerCase()} {fmtRelative(info.lastTick.at)} ({info.lastTick.reason})
                </span>
              )}
            </div>
            <div className="wd-meters">
              <Meter label="Ticks this hour" used={info.ticksLastHour} max={o.settings.maxTicksPerHour} />
              <Meter label="Spent today" used={info.spentTodayUsd} max={o.settings.dailyBudgetUsd} fmt={fmtCost} />
              {speculative && (
                <Meter
                  label={`Speculative runs today${speculative.running ? ` (${speculative.running} running)` : ''}`}
                  used={speculative.spentTodayUsd}
                  max={speculative.dailyBudgetUsd}
                  fmt={fmtCost}
                />
              )}
              <div className="wd-meter">
                <div className="wd-meter-head">
                  <span>Actions today</span>
                  <b>{info.actionsToday}</b>
                </div>
                <div className="hint">At most {o.settings.maxActionsPerTick} per tick</div>
              </div>
            </div>
          </div>
        )}
        <div className="wd-grid">
          <div className="wd-col">
            <h2 className="sa-section-title">Proposed changes</h2>
            {!pending.length && (
              <EmptyState compact title="None waiting.">
                Ask the Watchdog, and it may propose a change to the Trigger policies or a bot's role.
              </EmptyState>
            )}
            {pending.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={refresh} />
            ))}
            {decided.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={refresh} />
            ))}
            <h2 className="sa-section-title">Watching</h2>
            {!watches.length && <EmptyState compact title="No failures being re-checked." />}
            {watches.map((w) => (
              <div key={w.id} className="wd-row" data-watch={w.id}>
                <span className="mono">{w.subject}</span>
                <span className="wd-row-main">
                  {w.note}
                  <span className="muted">
                    {' '}
                    · {w.checks} check{w.checks === 1 ? '' : 's'} · next {fmtRelative(w.nextAt)} · {w.by === 'code' ? 'opened by Crew' : 'opened by the Watchdog'}
                  </span>
                </span>
                <button className="btn ghost sm" aria-label={`Resolve the watch on ${w.subject}`} onClick={() => void run(() => api.resolveWatchdogWatch(w.id), "Couldn't resolve").then(refresh)}>
                  Resolve
                </button>
              </div>
            ))}
            <h2 className="sa-section-title">What it did</h2>
            {o && !o.actions.length && <EmptyState compact title="Nothing yet." />}
            {o?.actions.map((a) => (
              <div key={a.id} className={cx('wd-row', a.refused && 'refused')} data-action={a.kind}>
                <span className="tr-time muted" title={new Date(a.at).toLocaleString()}>
                  {fmtShort(a.at)}
                </span>
                <span className="wd-row-main">
                  <b>{ACTION_LABEL[a.kind]}</b> <span className="mono">{a.target}</span> {a.text}
                  {a.refused && <span className="muted"> · refused: {a.refused}</span>}
                </span>
                {a.chatId && (
                  <button className="btn ghost sm" onClick={() => openChat(a.chatId!)}>
                    Open chat
                  </button>
                )}
              </div>
            ))}
            <h2 className="sa-section-title">Ticks</h2>
            {o && !o.ticks.length && <EmptyState compact title="No tick yet." />}
            {o?.ticks.map((t) => (
              <div key={t.id} className="wd-row" data-tick={t.id}>
                <span className="tr-time muted" title={new Date(t.at).toLocaleString()}>
                  {fmtShort(t.at)}
                </span>
                <StatusBadge status={t.kind === 'maintainer' ? { label: 'Question', tone: 'neutral' } : TICK_OUTCOME[t.outcome]} />
                <span className="wd-row-main muted">
                  {t.reason}
                  {t.actions ? ` · ${t.actions} action${t.actions === 1 ? '' : 's'}` : ''}
                  {t.costUsd ? ` · ${fmtCost(t.costUsd)}` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="wd-col">
            <h2 className="sa-section-title">Ask the Watchdog</h2>
            <WatchdogChat enabled={settingsOn} />
          </div>
        </div>
      </div>
    </div>
  );
}
