// Two-layer mode in a chat: the Router's state and the Workers it dispatched (title, member,
// status, last report), with their transcripts, Stop and Dismiss. Workers never post in the chat;
// this is where their work can be seen.

import { ChevronDown, ChevronRight, GitBranch, Network, ScrollText, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Chat, Thread, Worker, WorkerStatus } from '../../../shared/types';
import { WORKER_ACTIVE } from '../../../shared/workers';
import { api } from '../api';
import { loadLog, openModal, routerModeOf, toast, useStore } from '../store';
import { cx, fmtRelative } from '../utils';
import { BotMessage } from './Message';
import { Avatar, Modal } from './ui';

const STATUS: Record<WorkerStatus, { label: string; cls: string }> = {
  starting: { label: 'Starting', cls: '' },
  running: { label: 'Working', cls: 'accent' },
  waiting: { label: 'Needs you', cls: 'orange' },
  done: { label: 'Done', cls: 'green' },
  error: { label: 'Failed', cls: 'red' },
  stopped: { label: 'Stopped', cls: '' },
};

/** One line about a Worker: what it is doing, or how its last turn ended and where its changes went. */
function workerNote(w: Worker): string {
  if (WORKER_ACTIVE.has(w.status)) return w.detail || (w.status === 'running' ? 'Working…' : '');
  const l = w.landing;
  const landing = l?.conflicts?.length
    ? `Conflicts in ${l.conflicts.join(', ')}; not merged`
    : l?.error
      ? l.error
      : l?.files.length
        ? `Merged ${l.files.length} file${l.files.length === 1 ? '' : 's'} into the chat's branch`
        : '';
  const report = (w.report?.text || w.detail || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  return [report, landing].filter(Boolean).join(' · ');
}

async function act(fn: () => Promise<unknown>, what: string) {
  try {
    await fn();
  } catch (e) {
    toast(what, (e as Error).message, 'error');
  }
}

function WorkerRow({ w, chat }: { w: Worker; chat: Chat }) {
  const bot = useStore((s) => s.bots[w.botId]);
  const active = WORKER_ACTIVE.has(w.status);
  const st = STATUS[w.status];
  return (
    <div className={cx('worker-row', w.status)} data-worker={w.id}>
      <Avatar bot={bot} size={22} />
      <button className="wr-main" onClick={() => openModal({ kind: 'agentLog', chatId: chat.id, workerId: w.id })} title="Open its transcript">
        <span className="wr-title">
          <b>{w.title}</b> <span className="muted">· {bot?.name || 'deleted bot'}</span>
          {w.threads?.length ? (
            <span className="muted wr-subs" title="Threads it subscribes to: their later events come to it directly, without the Router">
              {' '}
              · {w.threads.length} thread{w.threads.length === 1 ? '' : 's'}
              {w.received ? `, ${w.received} event${w.received === 1 ? '' : 's'} direct` : ''}
              {w.inbox?.length ? `, ${w.inbox.length} unread` : ''}
            </span>
          ) : null}
        </span>
        <span className="wr-note muted">{workerNote(w)}</span>
      </button>
      <span className={cx('badge', st.cls)}>{st.label}</span>
      {active ? (
        <button className="icon-btn sm" title="Stop this Worker" onClick={() => void act(() => api.stopWorker(w.id), "Couldn't stop it")}>
          <Square size={13} />
        </button>
      ) : (
        <button className="icon-btn sm" title="Dismiss (removes its workspace; unmerged work stays on its branch)" onClick={() => void act(() => api.dismissWorker(w.id), "Couldn't dismiss it")}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

export function WorkersBar({ chat }: { chat: Chat }) {
  const on = useStore((s) => routerModeOf(chat, s.settings));
  const router = useStore((s) => s.routers[chat.id]);
  const all = useStore((s) => s.workers);
  const workers = useMemo(
    () =>
      Object.values(all)
        .filter((w) => w.chatId === chat.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    [all, chat.id],
  );
  const subs = useStore((s) => s.settings.superAgent.router.subscriptions);
  const [open, setOpen] = useState(true);
  if (!on && !workers.length) return null;
  const direct = chat.router?.direct ?? 0;
  const decided = chat.router?.decided ?? 0;
  const share = direct + decided ? Math.round((direct / (direct + decided)) * 100) : 0;
  const active = workers.filter((w) => WORKER_ACTIVE.has(w.status)).length;
  const routerText =
    router?.state === 'thinking'
      ? `thinking${router.detail ? ` · ${router.detail.replace(/_/g, ' ')}` : '…'}${router.queued ? ` · ${router.queued} waiting` : ''}`
      : router?.state === 'error'
        ? 'hit an error'
        : router?.queued
          ? `${router.queued} waiting`
          : 'idle';
  return (
    <div className="workers-bar">
      <div className="wb-head">
        <button className="wb-toggle" onClick={() => setOpen(!open)} disabled={!workers.length}>
          {workers.length ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <Network size={14} />}
          <span>
            Router <span className={cx('muted', router?.state === 'thinking' && 'busy')}>{routerText}</span>
          </span>
          {workers.length > 0 && (
            <span className="muted">
              · {active ? `${active} working, ` : ''}
              {workers.length} Worker{workers.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        <span className="spacer" />
        {(subs || direct > 0) && (
          <span
            className="muted wb-direct"
            data-testid="router-avoided"
            title={`Events that went straight to the Workers subscribed to their thread, so the Router did not have to decide on them. The Router decided on ${decided} event${decided === 1 ? '' : 's'}${direct + decided ? `; ${share}% of this chat's events skipped it` : ''}.`}
          >
            {direct} Router decision{direct === 1 ? '' : 's'} avoided
          </span>
        )}
        <button className="link-btn" onClick={() => openModal({ kind: 'agentLog', chatId: chat.id })} title="Every Router turn, with the events it handled">
          <ScrollText size={12} /> Router log
        </button>
      </div>
      {open && workers.map((w) => <WorkerRow key={w.id} w={w} chat={chat} />)}
    </div>
  );
}

/** The threads a Worker subscribes to (ADR 003), each with Unsubscribe, and what came to it directly. */
function WorkerThreads({ w, known }: { w: Worker; known: Thread[] }) {
  const list = w.threads || [];
  return (
    <div className="agent-threads" data-testid="worker-threads">
      <div className="muted">
        Subscribed to {list.length} thread{list.length === 1 ? '' : 's'}: their later events come straight to it, without the Router.
        {w.received ? ` ${w.received} event${w.received === 1 ? '' : 's'} so far.` : ''}
        {w.inbox?.length ? ` ${w.inbox.length} not read yet.` : ''}
      </div>
      {list.map((id) => (
        <div key={id} className="agent-thread" data-thread={id}>
          <span>{known.find((t) => t.id === id)?.title || 'Thread'}</span> <span className="mono muted">{id}</span>
          <span className="spacer" />
          <button className="btn ghost sm" title="Its later events go to the Router again" onClick={() => void act(() => api.unsubscribeWorker(w.id, id), "Couldn't unsubscribe it")}>
            Unsubscribe
          </button>
        </div>
      ))}
    </div>
  );
}

/** A Worker's transcript (its turns, tools, approval cards), or the chat's Router log. */
export function AgentLogDialog({ chatId, workerId, onClose }: { chatId: string; workerId?: string; onClose: () => void }) {
  const logId = workerId ?? `rt_${chatId}`;
  const chat = useStore((s) => s.chats[chatId]);
  const bots = useStore((s) => s.bots);
  const live = useStore((s) => (workerId ? s.workers[workerId] : undefined));
  const [fetched, setFetched] = useState<Worker | undefined>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const st = useStore((s) => s.msgs[logId]);
  const projects = useStore((s) => s.projects);
  const names = useMemo(() => Object.values(bots).map((b) => b.name), [bots]);
  useEffect(() => {
    if (workerId)
      void loadLog(
        logId,
        api.workerLog(workerId).then((r) => {
          setFetched(r.worker);
          setThreads(r.threads || []);
          return r;
        }),
      );
    else void loadLog(logId, api.routerLog(chatId));
  }, [logId, workerId, chatId]);
  const w = live ?? fetched;
  if (!chat) return null;
  const ws = w ? projects[w.projectId || '']?.workspace : undefined;
  const root = w ? projects[w.projectId || '']?.path : undefined;
  const bot = w ? bots[w.botId] : undefined;
  const list = st?.list || [];
  return (
    <Modal
      wide
      icon={workerId ? <GitBranch size={18} /> : <Network size={18} />}
      title={w ? `Worker: ${w.title}` : workerId ? 'Worker' : `Router of "${chat.title}"`}
      onClose={onClose}
      footer={
        w && WORKER_ACTIVE.has(w.status) ? (
          <button className="btn danger sm" onClick={() => void act(() => api.stopWorker(w.id), "Couldn't stop it")}>
            <Square size={13} /> Stop
          </button>
        ) : undefined
      }
    >
      {w ? (
        <div className="agent-meta">
          <div>
            <b>{bot?.name || 'deleted bot'}</b> · <span className={cx('badge', STATUS[w.status].cls)}>{STATUS[w.status].label}</span>
            {w.detail ? ` · ${w.detail}` : ''} · started {fmtRelative(w.createdAt)} · {w.turns} turn{w.turns === 1 ? '' : 's'}
            {w.costUsd ? ` · $${w.costUsd.toFixed(3)}` : ''}
          </div>
          <div className="muted">
            {ws ? (
              <>
                Own workspace on <code>{ws.branch}</code>, merged into <code>{ws.baseBranch}</code> after each turn.
              </>
            ) : (
              `Works in the chat's folder (${w.shared || 'no workspace of its own'}).`
            )}{' '}
            {workerNote(w)}
          </div>
          {w.threads && <WorkerThreads w={w} known={threads} />}
          <details>
            <summary>The task from the Router</summary>
            <pre className="agent-task">{w.task}</pre>
          </details>
        </div>
      ) : (
        <p className="hint">Each turn is one batch of events (messages, Worker reports, things Crew noticed). Only what the Router sends with reply reaches the chat.</p>
      )}
      <div className="agent-log msg-list">
        {!st?.loaded && <div className="spinner" />}
        {st?.loaded && !list.length && <div className="muted">Nothing yet.</div>}
        {list.map((m) => (
          <div key={m.id}>
            {!workerId && m.batch?.length ? (
              <div className="agent-batch muted">
                Handled {m.batch.length} event{m.batch.length === 1 ? '' : 's'}: {m.batch.join(', ')}
              </div>
            ) : null}
            <BotMessage msg={m} chat={chat} bot={bots[m.botId || '']} showHead names={names} root={root} />
          </div>
        ))}
      </div>
    </Modal>
  );
}
