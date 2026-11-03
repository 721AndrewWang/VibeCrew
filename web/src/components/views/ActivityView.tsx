// The Activity page (ADR 107): everything that runs in the background right now, across chats, in
// one list: Routers, Workers, speculative fixes, background jobs and the Watchdog. Each row says
// what it is, why it runs (the Trigger or the turn that started it), how long it has run, what it
// has cost so far, and has a Stop button; drafts and fixes waiting for the user are listed first.

import { Activity, GitBranch, MessageCircle, Network, Send, ShieldCheck, Sparkles, Square, Timer } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import type { BackgroundJob, Chat, Speculation, Worker } from '../../../../shared/types';
import { api } from '../../api';
import { openChat, openModal, setView, toast, useStore, WORKER_ACTIVE } from '../../store';
import { fmtCost, JOB_STATUS, PART, ROUTER_STATE, SPECULATION_STATUS, type StatusInfo, WATCHDOG_STATE, WORKER_STATUS } from '../../superagent';
import { cx, fmtRelative } from '../../utils';
import { fmtElapsed, jobActive } from '../JobsBar';
import { SIGNAL_LABEL } from '../SpeculativeBar';
import { Cost, EmptyState, goToPart, StatusBadge, SuperAgentPrimer, TriggerLink } from '../SuperAgentUi';
import { confirmDialog, useNow } from '../ui';
import { PageHead } from './BotsView';

const SPEC_ACTIVE = new Set(['running', 'verifying']);

/** The Trigger that started a Worker: the first Trigger id in the batch the Router dispatched it from. */
const triggerOf = (w: Worker) => w.related.find((id) => id.startsWith('tg_'));

async function act(fn: () => Promise<unknown>, what: string, done?: string) {
  try {
    await fn();
    if (done) toast(done, undefined, 'success');
  } catch (e) {
    toast(what, (e as Error).message, 'error');
  }
}

function ChatLink({ chat }: { chat?: Chat }) {
  if (!chat) return <span>a deleted chat</span>;
  return (
    <button className="link-btn" onClick={() => openChat(chat.id)} title="Open the chat">
      in “{chat.title}”
    </button>
  );
}

/** One running thing: what (opens its log), why, how long, what it cost, its status, and Stop. */
function Row({
  icon,
  title,
  why,
  status,
  cost,
  onOpen,
  openLabel,
  onStop,
  stopLabel,
  testId,
}: {
  icon: ReactNode;
  title: ReactNode;
  why: ReactNode[];
  status: StatusInfo;
  cost?: number;
  onOpen?: () => void;
  openLabel?: string;
  onStop?: () => void;
  stopLabel: string;
  testId: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <li className={cx('sa-row', status.tone === 'attention' && 'attention')} data-activity={testId}>
      <div className="sa-row-main">
        <div className="sa-row-title">
          {icon}
          {onOpen ? (
            <button className="link-btn sa-row-open" onClick={onOpen} aria-label={openLabel}>
              <b>{title}</b>
            </button>
          ) : (
            <b>{title}</b>
          )}
        </div>
        <div className="sa-row-why">
          {why.filter(Boolean).map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      </div>
      {cost === undefined ? <span /> : <Cost usd={cost} />}
      <StatusBadge status={status} />
      {onStop ? (
        <button
          className="btn sm danger"
          disabled={busy}
          aria-label={stopLabel}
          title={stopLabel}
          onClick={() => {
            setBusy(true);
            Promise.resolve(onStop()).finally(() => setBusy(false));
          }}
        >
          <Square size={12} aria-hidden /> Stop
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

function Group({ title, count, children, testId }: { title: string; count: number; children: ReactNode; testId: string }) {
  if (!count) return null;
  return (
    <section className="sa-group" data-testid={testId} aria-label={title}>
      <h2 className="sa-section-title">
        {title} <span className="muted">{count}</span>
      </h2>
      <ul className="card sa-list">{children}</ul>
    </section>
  );
}

/** What the Activity page lists, also counted by the sidebar. */
export function useActivity() {
  const workers = useStore((s) => s.workers);
  const jobs = useStore((s) => s.jobs);
  const speculations = useStore((s) => s.speculations);
  const routers = useStore((s) => s.routers);
  const drafts = useStore((s) => s.actionDrafts);
  return useMemo(() => {
    const w = Object.values(workers)
      .filter((x) => !x.speculation && WORKER_ACTIVE.has(x.status))
      .sort((a, b) => a.createdAt - b.createdAt);
    const j = Object.values(jobs)
      .filter(jobActive)
      .sort((a, b) => a.startedAt - b.startedAt);
    const sp = Object.values(speculations)
      .filter((x) => SPEC_ACTIVE.has(x.status))
      .sort((a, b) => a.at - b.at);
    const r = Object.values(routers).filter((x) => x.state === 'thinking' || x.queued > 0);
    const waiting = {
      drafts: Object.values(drafts).filter((d) => d.status === 'pending'),
      fixes: Object.values(speculations).filter((x) => x.status === 'ready'),
    };
    const running = w.length + j.length + sp.length + r.length;
    const needsYou = waiting.drafts.length + waiting.fixes.length + w.filter((x) => x.status === 'waiting').length + j.filter((x) => x.status === 'waiting').length;
    return { workers: w, jobs: j, speculations: sp, routers: r, waiting, running, needsYou };
  }, [workers, jobs, speculations, routers, drafts]);
}

export function ActivityView() {
  const a = useActivity();
  const chats = useStore((s) => s.chats);
  const bots = useStore((s) => s.bots);
  const settings = useStore((s) => s.settings);
  const watchdog = useStore((s) => s.watchdog);
  const now = useNow(1000);
  const enabled = settings.superAgent.enabled;
  const watchdogOn = enabled && settings.superAgent.watchdog.enabled;
  // The live state arrives with the Watchdog's next change; read it now so its row shows from the start.
  useEffect(() => {
    if (watchdogOn && !useStore.getState().watchdog)
      api.watchdog().then(
        (o) => useStore.setState({ watchdog: o }),
        () => {},
      );
  }, [watchdogOn]);
  const spent = [...a.workers, ...a.speculations].reduce((n, x) => n + (x.costUsd || 0), 0) + a.jobs.reduce((n, x) => n + (x.costUsd || 0), 0);
  // Waiting items are grouped per chat: the chat is where they are decided.
  const waitingChats = useMemo(() => {
    const by = new Map<string, { drafts: number; fixes: number }>();
    for (const d of a.waiting.drafts) if (d.chatId) by.set(d.chatId, { ...(by.get(d.chatId) || { drafts: 0, fixes: 0 }), drafts: (by.get(d.chatId)?.drafts || 0) + 1 });
    for (const f of a.waiting.fixes) if (f.chatId) by.set(f.chatId, { ...(by.get(f.chatId) || { drafts: 0, fixes: 0 }), fixes: (by.get(f.chatId)?.fixes || 0) + 1 });
    return [...by.entries()];
  }, [a.waiting]);

  const stopAll = async () => {
    const ok = await confirmDialog({
      title: 'Stop everything running in the background?',
      body: `${a.running} item${a.running === 1 ? '' : 's'} stop: Workers and background jobs end their current step, speculative fixes are discarded, and Routers drop their queued events. Drafts and fixes waiting for you are kept.`,
      ok: 'Stop all',
      danger: true,
    });
    if (!ok) return;
    const chatIds = new Set([...a.routers.map((r) => r.chatId), ...a.workers.map((w) => w.chatId)]);
    await act(
      () =>
        Promise.all([
          ...[...chatIds].map((id) => api.stop(id)),
          ...a.workers.filter((w) => !chatIds.has(w.chatId)).map((w) => api.stopWorker(w.id)),
          ...a.speculations.filter((s) => s.workerId).map((s) => api.stopWorker(s.workerId!)),
          ...a.jobs.map((j) => api.stopJob(j.id)),
        ]),
      "Couldn't stop everything",
      'Stopped',
    );
  };

  const workerRow = (w: Worker) => {
    const tg = triggerOf(w);
    return (
      <Row
        key={w.id}
        testId={w.id}
        icon={<GitBranch size={14} aria-hidden />}
        title={w.title}
        openLabel={`Open the transcript of Worker ${w.title}`}
        onOpen={() => openModal({ kind: 'agentLog', chatId: w.chatId, workerId: w.id })}
        why={[
          <span key="who">
            {bots[w.botId]?.name || 'a deleted bot'} <ChatLink chat={chats[w.chatId]} />
          </span>,
          tg ? (
            <span key="tg">
              dispatched for <TriggerLink id={tg} />
            </span>
          ) : (
            'dispatched by the Router'
          ),
          `for ${fmtElapsed(now - w.createdAt)}`,
          w.detail || '',
        ]}
        status={WORKER_STATUS[w.status]}
        cost={w.costUsd}
        stopLabel={`Stop Worker ${w.title}`}
        onStop={() => act(() => api.stopWorker(w.id), "Couldn't stop it")}
      />
    );
  };
  const specRow = (sp: Speculation) => (
    <Row
      key={sp.id}
      testId={sp.id}
      icon={<Sparkles size={14} aria-hidden />}
      title={`${SIGNAL_LABEL[sp.signal]}: ${sp.summary}`}
      why={[
        <span key="tg">
          started by <TriggerLink id={sp.triggerId} />
        </span>,
        sp.chatId ? <ChatLink key="chat" chat={chats[sp.chatId]} /> : '',
        `for ${fmtElapsed(now - sp.at)}`,
        sp.status === 'verifying' ? `running ${sp.checkCommand || 'the checks'}` : 'quiet until a fix is proven',
      ]}
      status={SPECULATION_STATUS[sp.status]}
      cost={sp.costUsd}
      stopLabel={`Stop and discard the speculative fix for ${sp.summary}`}
      onStop={sp.workerId ? () => act(() => api.stopWorker(sp.workerId!), "Couldn't stop it") : undefined}
    />
  );
  const jobRow = (j: BackgroundJob) => (
    <Row
      key={j.id}
      testId={j.id}
      icon={<Timer size={14} aria-hidden />}
      title={j.title}
      openLabel={`Open the log of job ${j.title}`}
      onOpen={() => openModal({ kind: 'jobLog', jobId: j.id })}
      why={[
        <span key="who">
          started by {bots[j.botId]?.name || 'a deleted bot'} <ChatLink chat={chats[j.chatId]} />
        </span>,
        j.kind === 'command' ? <code key="cmd">{j.command}</code> : 'sub-task',
        `for ${fmtElapsed(now - j.startedAt)}`,
      ]}
      status={JOB_STATUS[j.status]}
      cost={j.kind === 'task' ? j.costUsd || 0 : undefined}
      stopLabel={`Stop job ${j.title}`}
      onStop={() => act(() => api.stopJob(j.id), "Couldn't stop it")}
    />
  );

  const nothing = !a.running && !waitingChats.length;
  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="Activity" sub="What runs in the background right now, why it started, what it has cost so far, and how to stop it">
          {a.running > 0 && (
            <button className="btn danger" onClick={() => void stopAll()}>
              <Square size={14} aria-hidden /> Stop all
            </button>
          )}
        </PageHead>
        <div className="sa-activity-totals" role="status" aria-live="polite" data-testid="activity-totals">
          <span>
            <b>{a.running}</b> running
          </span>
          <span>
            <b>{a.needsYou}</b> waiting for you
          </span>
          {a.running > 0 && (
            <span>
              <b>{fmtCost(spent)}</b> spent so far by what is running
            </span>
          )}
        </div>
        {nothing && (
          <div className="card">
            <EmptyState icon={<Activity size={18} />} title="Nothing runs in the background">
              {enabled
                ? 'When a Router dispatches a Worker, a bot starts a background job or Crew tries a speculative fix, it shows up here with the Trigger that started it, what it costs and a Stop button.'
                : `${PART.triggers.name} are off, so nothing starts on its own. Turn Super-agent mode on part by part in Settings.`}
            </EmptyState>
            {!enabled && (
              <div className="sa-activity-primer">
                <SuperAgentPrimer />
                <button className="btn primary sm" onClick={() => goToPart('triggers')}>
                  Set up Super-agent mode
                </button>
              </div>
            )}
          </div>
        )}
        <Group title="Waiting for you" count={waitingChats.length} testId="activity-waiting">
          {waitingChats.map(([chatId, n]) => (
            <li key={chatId} className="sa-row attention" data-activity={`waiting-${chatId}`}>
              <div className="sa-row-main">
                <div className="sa-row-title">
                  <Send size={14} aria-hidden />
                  <b>{chats[chatId]?.title || 'A deleted chat'}</b>
                </div>
                <div className="sa-row-why">
                  {n.drafts > 0 && <span>{`${n.drafts} drafted action${n.drafts === 1 ? '' : 's'} to approve or discard`}</span>}
                  {n.fixes > 0 && <span>{`${n.fixes} speculative fix${n.fixes === 1 ? '' : 'es'} to merge or discard`}</span>}
                </div>
              </div>
              <span />
              <StatusBadge status={{ label: 'Needs you', tone: 'attention' }} />
              <button className="btn sm" onClick={() => openChat(chatId)}>
                <MessageCircle size={12} aria-hidden /> Open chat
              </button>
            </li>
          ))}
        </Group>
        <Group title="Routers" count={a.routers.length} testId="activity-routers">
          {a.routers.map((r) => (
            <Row
              key={r.chatId}
              testId={`rt_${r.chatId}`}
              icon={<Network size={14} aria-hidden />}
              title={`Router of “${chats[r.chatId]?.title || 'a deleted chat'}”`}
              openLabel="Open the Router log"
              onOpen={() => openModal({ kind: 'agentLog', chatId: r.chatId })}
              why={[r.queued ? `${r.queued} event${r.queued === 1 ? '' : 's'} waiting` : 'deciding on a batch of events', `since ${fmtRelative(r.since)}`, r.detail?.replace(/_/g, ' ') || '']}
              status={ROUTER_STATE[r.state]}
              stopLabel={`Stop the Router and Workers of ${chats[r.chatId]?.title || 'this chat'}`}
              onStop={() => act(() => api.stop(r.chatId), "Couldn't stop it")}
            />
          ))}
        </Group>
        <Group title="Workers" count={a.workers.length} testId="activity-workers">
          {a.workers.map(workerRow)}
        </Group>
        <Group title={PART.speculative.name} count={a.speculations.length} testId="activity-speculative">
          {a.speculations.map(specRow)}
        </Group>
        <Group title={PART.jobs.name} count={a.jobs.length} testId="activity-jobs">
          {a.jobs.map(jobRow)}
        </Group>
        {watchdogOn && watchdog && (
          <section className="sa-group" aria-label="Watchdog" data-testid="activity-watchdog">
            <h2 className="sa-section-title">Watchdog</h2>
            <ul className="card sa-list">
              <li className="sa-row">
                <div className="sa-row-main">
                  <div className="sa-row-title">
                    <ShieldCheck size={14} aria-hidden />
                    <button className="link-btn" onClick={() => setView('watchdog')}>
                      <b>Watchdog</b>
                    </button>
                  </div>
                  <div className="sa-row-why">
                    {watchdog.nextTickAt && <span>next tick {fmtRelative(watchdog.nextTickAt)}</span>}
                    <span>{`${watchdog.ticksLastHour} look${watchdog.ticksLastHour === 1 ? '' : 's'} this hour`}</span>
                    <span>{`${fmtCost(watchdog.spentTodayUsd)} of ${fmtCost(settings.superAgent.watchdog.dailyBudgetUsd)} today`}</span>
                  </div>
                </div>
                <Cost usd={watchdog.spentTodayUsd} label="today" />
                <StatusBadge status={WATCHDOG_STATE[watchdog.state]} />
                <button
                  className="btn sm danger"
                  aria-label="Turn the Watchdog off"
                  title="Turns its switch in Settings → Super-agent off; turn it on there again"
                  onClick={() =>
                    void act(
                      async () => useStore.setState({ settings: (await api.updateSettings({ superAgent: { watchdog: { ...settings.superAgent.watchdog, enabled: false } } })).settings }),
                      "Couldn't turn it off",
                      'Watchdog off',
                    )
                  }
                >
                  <Square size={12} aria-hidden /> Turn off
                </button>
              </li>
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/**
 * Above the sidebar's navigation: how many things run in the background and wait for the user,
 * and what they cost so far. Always there while the Super-agent is on or something runs; one click
 * opens the Activity page.
 */
export function ActivityStrip() {
  const a = useActivity();
  const on = useStore((s) => s.settings.superAgent.enabled);
  const view = useStore((s) => s.view);
  if (!on && !a.running && !a.needsYou) return null;
  const spent = [...a.workers, ...a.speculations, ...a.jobs].reduce((n, x) => n + (x.costUsd || 0), 0);
  const label =
    a.running || a.needsYou ? [a.running ? `${a.running} running` : '', a.needsYou ? `${a.needsYou} waiting for you` : ''].filter(Boolean).join(' · ') : 'Nothing running in the background';
  return (
    <button
      className={cx('sb-activity', a.running > 0 && 'busy', a.needsYou > 0 && 'attention', view === 'activity' && 'on')}
      onClick={() => setView('activity')}
      aria-current={view === 'activity' ? 'page' : undefined}
      data-testid="activity-strip"
      title="Open Activity: what runs in the background, why, what it costs, and Stop"
    >
      <Activity size={14} aria-hidden />
      <span className="sb-activity-text" aria-live="polite">
        {label}
      </span>
      {a.running > 0 && <span className="sa-cost">{fmtCost(spent)}</span>}
    </button>
  );
}
