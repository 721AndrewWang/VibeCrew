// The Watchdog page: its state and today's usage against the hard limits, "Tick now", the changes
// it proposes (accept or reject), the failures it watches, what it did, and a chat to ask it why
// something failed. The page only shows and controls; every limit is enforced on the server.

import { Check, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Chat, WatchdogAction, WatchdogOverview, WatchdogProposal, WatchdogTick } from '../../../../shared/types';
import { api } from '../../api';
import { loadLog, openChat, setView, toast, useStore } from '../../store';
import { cx, fmtRelative, fmtShort } from '../../utils';
import { BotMessage, UserMessage } from '../Message';
import { useNow } from '../ui';
import { fmtUsd, PageHead } from './BotsView';

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

const OUTCOME: Record<WatchdogTick['outcome'], { label: string; cls: string }> = {
  ran: { label: 'Looked', cls: 'accent' },
  skipped: { label: 'Skipped', cls: '' },
  error: { label: 'Failed', cls: 'red' },
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
    <div className="wd-meter" title={`${fmt(used)} of ${fmt(max)}`}>
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
        {p.status !== 'pending' && <span className="badge">{p.status}</span>}
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
            <X size={13} /> Reject
          </button>
          <button className="btn primary sm" disabled={busy} onClick={() => void decide(true)}>
            <Check size={13} /> Accept
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
        {!st?.loaded && <div className="spinner" />}
        {st?.loaded && !list.length && <div className="muted">Nothing yet. Ticks that find nothing flagged do not call the model, so they do not show here.</div>}
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
        <button className="btn primary" disabled={!enabled || sending || !text.trim()} onClick={() => void send()} title="Send">
          {sending ? <span className="spinner" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}

export function WatchdogView() {
  const live = useStore((s) => s.watchdog);
  const settingsOn = useStore((s) => s.settings.superAgent.enabled && s.settings.superAgent.watchdog.enabled);
  const [o, setO] = useState<WatchdogOverview | null>(null);
  useNow(30_000);
  const refresh = () =>
    void api
      .watchdog()
      .then(setO)
      .catch((e) => toast("Couldn't load the Watchdog", (e as Error).message, 'error'));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the lists whenever the live state moves on
  useEffect(() => {
    refresh();
  }, [live]);

  const info = live ?? o;
  const pending = (o?.proposals || []).filter((p) => p.status === 'pending');
  const decided = (o?.proposals || []).filter((p) => p.status !== 'pending').slice(0, 5);
  const watches = (o?.watches || []).filter((w) => !w.resolvedAt);
  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Watchdog" sub="An external control loop: it checks Workers and errors on a timer, and steps in within hard limits">
          <button className="btn" onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn primary" disabled={!settingsOn || info?.state === 'thinking'} onClick={() => void run(() => api.watchdogTick(), "Couldn't tick")}>
            <ShieldCheck size={14} /> Tick now
          </button>
        </PageHead>
        {!settingsOn && (
          <div className="notice">
            The Watchdog is off: no timer runs and nothing is checked.{' '}
            <button className="btn ghost sm" onClick={() => setView('settings')}>
              Open Settings
            </button>
          </div>
        )}
        {info && o && (
          <div className="wd-status" data-testid="watchdog-status">
            <div className="wd-state">
              <span className={cx('badge', info.state === 'thinking' ? 'accent' : info.state === 'error' ? 'red' : '')}>{info.state === 'thinking' ? 'Looking' : info.state}</span>
              {info.detail && <span className="muted">{info.detail}</span>}
              {info.nextTickAt && <span className="muted">Next tick {fmtRelative(info.nextTickAt)}</span>}
              {info.lastTick && (
                <span className="muted">
                  Last: {OUTCOME[info.lastTick.outcome].label.toLowerCase()} {fmtRelative(info.lastTick.at)} ({info.lastTick.reason})
                </span>
              )}
            </div>
            <div className="wd-meters">
              <Meter label="Ticks this hour" used={info.ticksLastHour} max={o.settings.maxTicksPerHour} />
              <Meter label="Spent today" used={info.spentTodayUsd} max={o.settings.dailyBudgetUsd} fmt={fmtUsd} />
              {info.speculative && (
                <Meter
                  label={`Speculative runs today${info.speculative.running ? ` (${info.speculative.running} running)` : ''}`}
                  used={info.speculative.spentTodayUsd}
                  max={info.speculative.dailyBudgetUsd}
                  fmt={fmtUsd}
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
            <h3>Proposed changes</h3>
            {!pending.length && <div className="muted">None waiting. Ask the Watchdog in the chat, and it may propose a change to the trigger policies or a bot's role.</div>}
            {pending.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={refresh} />
            ))}
            {decided.map((p) => (
              <ProposalCard key={p.id} p={p} onDone={refresh} />
            ))}
            <h3>Watching</h3>
            {!watches.length && <div className="muted">No failures being re-checked.</div>}
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
                <button className="btn ghost sm" onClick={() => void run(() => api.resolveWatchdogWatch(w.id), "Couldn't resolve").then(refresh)}>
                  Resolve
                </button>
              </div>
            ))}
            <h3>What it did</h3>
            {!o?.actions.length && <div className="muted">Nothing yet.</div>}
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
            <h3>Ticks</h3>
            {o?.ticks.map((t) => (
              <div key={t.id} className="wd-row" data-tick={t.id}>
                <span className="tr-time muted" title={new Date(t.at).toLocaleString()}>
                  {fmtShort(t.at)}
                </span>
                <span className={cx('badge', OUTCOME[t.outcome].cls)}>{t.kind === 'maintainer' ? 'Question' : OUTCOME[t.outcome].label}</span>
                <span className="wd-row-main muted">
                  {t.reason}
                  {t.actions ? ` · ${t.actions} action${t.actions === 1 ? '' : 's'}` : ''}
                  {t.costUsd ? ` · ${fmtUsd(t.costUsd)}` : ''}
                </span>
              </div>
            ))}
          </div>
          <div className="wd-col">
            <h3>Ask the Watchdog</h3>
            <WatchdogChat enabled={settingsOn} />
          </div>
        </div>
      </div>
    </div>
  );
}
