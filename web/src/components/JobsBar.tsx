// Full duplex (ADR 004): the background jobs a chat's bots started with `start`, above the
// composer (title, bot, status, time, Stop, Log), and the dialog with a job's full log or a
// sub-task's transcript.

import { ChevronDown, ChevronRight, ListTree, ScrollText, Square, TerminalSquare, Timer } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { BackgroundJob, JobStatus } from '../../../shared/types';
import { api } from '../api';
import { loadLog, openModal, requestTerminal, toast, useStore } from '../store';
import { cx, fmtRelative } from '../utils';
import { BotMessage } from './Message';
import { Avatar, Modal, useNow } from './ui';

const STATUS: Record<JobStatus, { label: string; cls: string }> = {
  running: { label: 'Running', cls: 'accent' },
  waiting: { label: 'Needs you', cls: 'orange' },
  done: { label: 'Done', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' },
  stopped: { label: 'Stopped', cls: '' },
};

/** Finished jobs the bar keeps showing. */
const RECENT = 4;

export const jobActive = (j: BackgroundJob) => j.status === 'running' || j.status === 'waiting';

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function jobNote(j: BackgroundJob, now: number): string {
  const bits = [fmtElapsed((j.endedAt ?? now) - j.startedAt)];
  if (j.kind === 'command') {
    if (j.exitCode !== undefined && j.exitCode !== null) bits.push(`exit ${j.exitCode}`);
    bits.push(`${j.lines.toLocaleString('en-US')} line${j.lines === 1 ? '' : 's'}`);
  } else bits.push('sub-task');
  if (j.sandboxed) bits.push('sandboxed');
  if (j.detail) bits.push(j.detail);
  return bits.join(' · ');
}

async function stop(j: BackgroundJob) {
  try {
    await api.stopJob(j.id);
  } catch (e) {
    toast("Couldn't stop it", (e as Error).message, 'error');
  }
}

function JobRow({ j, now }: { j: BackgroundJob; now: number }) {
  const bot = useStore((s) => s.bots[j.botId]);
  const st = STATUS[j.status];
  return (
    <div className={cx('worker-row', j.status)} data-job={j.id}>
      <Avatar bot={bot} size={22} />
      <button className="wr-main" onClick={() => openModal({ kind: 'jobLog', jobId: j.id })} title={j.kind === 'command' ? 'Open its log' : 'Open its transcript'}>
        <span className="wr-title">
          <b>{j.title}</b> <span className="muted">· {bot?.name || 'deleted bot'}</span>
        </span>
        <span className="wr-note muted">
          {j.kind === 'command' ? <code>{j.command}</code> : null} {jobNote(j, now)}
        </span>
      </button>
      <span className={cx('badge', st.cls)}>{st.label}</span>
      {jobActive(j) && (
        <button className="icon-btn sm" title="Stop this job" onClick={() => void stop(j)}>
          <Square size={13} />
        </button>
      )}
    </div>
  );
}

export function JobsBar({ chatId }: { chatId: string }) {
  const all = useStore((s) => s.jobs);
  const list = useMemo(
    () =>
      Object.values(all)
        .filter((j) => j.chatId === chatId)
        .sort((a, b) => a.startedAt - b.startedAt),
    [all, chatId],
  );
  const [open, setOpen] = useState(true);
  const now = useNow(1000);
  const active = list.filter(jobActive);
  // Running jobs, and the last few that ended within the hour.
  const recent = list.filter((j) => !jobActive(j) && now - (j.endedAt ?? 0) < 3600_000).slice(-RECENT);
  const shown = [...recent, ...active].sort((a, b) => a.startedAt - b.startedAt);
  if (!shown.length) return null;
  return (
    <div className="workers-bar jobs-bar">
      <div className="wb-head">
        <button className="wb-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Timer size={13} />
          <span>
            Background jobs <span className={cx('muted', active.length > 0 && 'busy')}>{active.length ? `${active.length} running` : 'none running'}</span>
          </span>
        </button>
      </div>
      {open && shown.map((j) => <JobRow key={j.id} j={j} now={now} />)}
    </div>
  );
}

const PAGE = 400;

/** A command's full log, page by page, or a sub-task's transcript. */
export function JobLogDialog({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const live = useStore((s) => s.jobs[jobId]);
  const chat = useStore((s) => (live ? s.chats[live.chatId] : undefined));
  const bots = useStore((s) => s.bots);
  const [lines, setLines] = useState<string[] | null>(null);
  const [total, setTotal] = useState(0);
  // A sub-task's transcript is a log of its own in the store, kept live like a Worker's.
  const transcript = useStore((s) => s.msgs[jobId]);
  const [fetched, setFetched] = useState<BackgroundJob | undefined>();
  const j = live ?? fetched;
  const now = useNow(1000);
  const names = useMemo(() => Object.values(bots).map((b) => b.name), [bots]);
  const version = live ? `${live.status}:${live.lines}` : '';

  // Reloaded as the job writes more (the first page, and as many pages as were already open).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` is the trigger; `lines` would loop.
  useEffect(() => {
    let off = false;
    api
      .jobLog(jobId, 1, Math.max(PAGE, lines?.length ?? 0))
      .then((r) => {
        if (off) return;
        setFetched(r.job);
        setLines(r.lines);
        setTotal(r.total);
        if (r.messages) void loadLog(jobId, Promise.resolve({ messages: r.messages }));
      })
      .catch((e) => !off && toast("Couldn't load the log", (e as Error).message, 'error'));
    return () => {
      off = true;
    };
  }, [jobId, version]);

  const more = async () => {
    const r = await api.jobLog(jobId, (lines?.length ?? 0) + 1, PAGE);
    setLines([...(lines || []), ...r.lines]);
    setTotal(r.total);
  };
  const bot = j ? bots[j.botId] : undefined;
  const follow = j?.kind === 'command' && j.logFile && jobActive(j) && !j.sandboxed;
  return (
    <Modal
      wide
      icon={j?.kind === 'task' ? <ListTree size={18} /> : <ScrollText size={18} />}
      title={j ? `Job: ${j.title}` : 'Job'}
      onClose={onClose}
      footer={
        j && (
          <>
            {follow && (
              <button className="btn sm" title="Open a terminal that follows this log as it grows" onClick={() => requestTerminal(`tail -n +1 -f '${j.logFile!.replace(/'/g, `'\\''`)}'`)}>
                <TerminalSquare size={13} /> Follow in terminal
              </button>
            )}
            {jobActive(j) && (
              <button className="btn danger sm" onClick={() => void stop(j)}>
                <Square size={13} /> Stop
              </button>
            )}
          </>
        )
      }
    >
      {j && (
        <div className="agent-meta">
          <div>
            <b>{bot?.name || 'deleted bot'}</b> · <span className={cx('badge', STATUS[j.status].cls)}>{STATUS[j.status].label}</span> · {j.id} · started {fmtRelative(j.startedAt)} · {jobNote(j, now)}
            {j.costUsd ? ` · $${j.costUsd.toFixed(3)}` : ''}
          </div>
          <pre className="agent-task">{j.kind === 'command' ? `$ ${j.command}` : j.task}</pre>
          {j.sandboxed && <div className="muted">Ran as a Bash call inside the sandbox: its output arrives when it ends.</div>}
        </div>
      )}
      {j?.kind === 'task' ? (
        <div className="agent-log msg-list">
          {!transcript?.loaded && <div className="spinner" />}
          {transcript?.loaded && !transcript.list.length && <div className="muted">Nothing yet.</div>}
          {chat && transcript?.list.map((m) => <BotMessage key={m.id} msg={m} chat={chat} bot={bots[m.botId || '']} showHead names={names} />)}
        </div>
      ) : (
        <div className="job-log">
          {!lines && <div className="spinner" />}
          {lines && !lines.length && <div className="muted">No output yet.</div>}
          {lines && lines.length > 0 && <pre>{lines.join('\n')}</pre>}
          {lines && lines.length < total && (
            <button className="link-btn" onClick={() => void more()}>
              Show more ({lines.length.toLocaleString('en-US')} of {total.toLocaleString('en-US')} lines)
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
