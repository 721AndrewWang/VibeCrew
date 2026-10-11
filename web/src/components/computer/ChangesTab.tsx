import { ChevronRight, FileCode2, GitBranch, GitCommitHorizontal, GitMerge, RefreshCw, Scale, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Chat, Project, TurnSummary, WorkspaceStatus } from '../../../../shared/types';
import { api, type GitStatus, type TurnDiff } from '../../api';
import { loadTurns, openFileInEditor, sendMessage, toast, useStore } from '../../store';
import { cx, fmtWhen } from '../../utils';
import { closeWorkspace } from '../../workspace';
import { Avatar, confirmDialog, Glyph } from '../ui';
import { DiffView, UnifiedDiff } from './DiffView';

const STATUS_LABEL = { added: 'Added', modified: 'Modified', deleted: 'Deleted', unknown: 'Changed by command', renamed: 'Renamed' } as const;

function TurnFileDiff({ chatId, turnId, path }: { chatId: string; turnId: string; path: string }) {
  const [d, setD] = useState<TurnDiff | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .turnDiff(chatId, turnId, path)
      .then(setD)
      .catch((e) => setErr(e.message));
  }, [chatId, turnId, path]);
  if (err) return <div className="muted pad">{err}</div>;
  if (!d)
    return (
      <div className="pad">
        <span className="spinner" />
      </div>
    );
  if (d.binary || d.tooLarge) return <div className="muted pad">{d.binary ? 'Binary file, no diff available' : 'File too large, no snapshot saved'}</div>;
  if (d.before === undefined)
    return <div className="muted pad">This file was changed by a command (like npm install or a script). There is no snapshot from before, so no diff or automatic revert is available.</div>;
  return (
    <>
      {d.current !== undefined && d.after !== undefined && d.current !== d.after && (
        <div className="diff-note">
          <Glyph emoji="⚠️" size={12} /> This file was changed again after this turn. Below are only the changes from this turn.
        </div>
      )}
      <DiffView before={d.before ?? ''} after={d.after ?? ''} />
    </>
  );
}

function TurnCard({ turn, chat, project, focus }: { turn: TurnSummary; chat: Chat; project: Project; focus?: { path?: string; nonce: number } }) {
  const bot = useStore((s) => s.bots[turn.botId]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: each request carries a new nonce
  useEffect(() => {
    if (!focus) return;
    setOpen(focus.path || turn.files[0]?.path || null);
    setTimeout(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
  }, [focus?.nonce]);

  const revert = async () => {
    if (
      !(await confirmDialog({
        title: "Revert this turn's changes?",
        body: `Restore ${turn.files.length} file${turn.files.length === 1 ? '' : 's'} to how they were before ${bot?.name || 'the bot'} changed them.`,
        ok: 'Revert',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      let r = await api.revertTurn(chat.id, turn.id);
      if (r.conflicts.length) {
        if (
          !(await confirmDialog({
            title: 'Some files changed since',
            body: `${r.conflicts.join(', ')} changed again after this turn. Force revert will overwrite those later changes.`,
            ok: 'Force revert',
            danger: true,
          }))
        )
          return;
        r = await api.revertTurn(chat.id, turn.id, true);
      }
      toast('Reverted', `Restored ${r.reverted.length} file${r.reverted.length === 1 ? '' : 's'}`, 'success');
      void loadTurns(chat.id);
    } catch (e) {
      toast('Revert failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('turn-card', turn.reverted && 'reverted')} ref={ref}>
      <div className="turn-head">
        <Avatar bot={bot} size={22} />
        <b>{bot?.name || 'Bot'}</b>
        <span className="muted">
          {fmtWhen(turn.startedAt)} · {turn.files.length} file{turn.files.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        {turn.reverted ? (
          <span className="badge">Reverted</span>
        ) : (
          <button className="btn sm ghost" disabled={busy} onClick={revert}>
            <Undo2 size={13} /> Revert
          </button>
        )}
      </div>
      <div className="turn-files">
        {turn.files.map((f) => (
          <div key={f.path}>
            <button className={cx('turn-file', open === f.path && 'on')} onClick={() => setOpen(open === f.path ? null : f.path)}>
              <ChevronRight size={12} className={cx('chev', open === f.path && 'open')} />
              <span className={cx('fstat', f.status)}>{STATUS_LABEL[f.status]}</span>
              <span className="fpath">{f.path}</span>
              <span
                className="icon-btn sm"
                role="button"
                title="Open in editor"
                onClick={(e) => {
                  e.stopPropagation();
                  openFileInEditor(project.id, f.path);
                }}
              >
                <FileCode2 size={13} />
              </span>
            </button>
            {open === f.path && <TurnFileDiff chatId={chat.id} turnId={turn.id} path={f.path} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function GitSection({ project, active }: { project: Project; active: boolean }) {
  const filesVersion = useStore((s) => s.filesVersion[project.id] || 0);
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api
      .git(project.id)
      .then(setSt)
      .catch(() => setSt({ repo: false }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when files change on disk
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(refresh, 400);
    return () => clearTimeout(t);
  }, [active, filesVersion, project.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the diff when files change on disk
  useEffect(() => {
    if (!open) return;
    api
      .gitDiff(project.id, open)
      .then((r) => setDiff(r.diff))
      .catch(() => setDiff(''));
  }, [open, filesVersion, project.id]);

  const commit = async () => {
    setBusy(true);
    try {
      setSt(await api.commit(project.id, msg.trim()));
      setMsg('');
      toast('Committed', undefined, 'success');
    } catch (e) {
      toast('Commit failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!st) return null;
  return (
    <div className="git-section">
      <div className="section-title">
        <GitBranch size={14} /> Git {st.repo && st.branch ? <span className="badge">{st.branch}</span> : null}
        <span className="spacer" />
        <button className="icon-btn sm" title="Refresh" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      {!st.repo ? (
        <div className="muted pad">This project is not a Git repo yet. Your first commit sets it up, and you can roll back any time after that.</div>
      ) : !st.files?.length ? (
        <div className="muted pad">Working tree is clean. No uncommitted changes.</div>
      ) : (
        <div className="turn-files">
          {st.files.map((f) => (
            <div key={f.path}>
              <button className={cx('turn-file', open === f.path && 'on')} onClick={() => setOpen(open === f.path ? null : f.path)}>
                <ChevronRight size={12} className={cx('chev', open === f.path && 'open')} />
                <span className={cx('fstat', f.code.includes('?') || f.code.includes('A') ? 'added' : f.code.includes('D') ? 'deleted' : 'modified')}>{f.code.trim() || 'M'}</span>
                <span className="fpath">{f.path}</span>
              </button>
              {open === f.path && <UnifiedDiff text={diff} />}
            </div>
          ))}
        </div>
      )}
      {(!st.repo || !!st.files?.length) && (
        <div className="commit-box">
          <input
            className="input"
            placeholder="Commit message, e.g. Finish home page layout"
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && msg.trim() && commit()}
          />
          <button className="btn primary" disabled={!msg.trim() || busy} onClick={commit}>
            <GitCommitHorizontal size={14} /> Commit all
          </button>
        </div>
      )}
      {!!st.commits?.length && (
        <div className="commits">
          {st.commits.map((c) => (
            <div key={c.hash} className="commit">
              <code>{c.hash}</code>
              <span className="c-subject">{c.subject}</span>
              <span className="muted">{c.when}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The chat's own branch: what differs from the base branch, and merging it back. */
function WorkspaceSection({ chat, project, active }: { chat: Chat; project: Project; active: boolean }) {
  const info = project.workspace!;
  const base = info.baseBranch;
  const filesVersion = useStore((s) => s.filesVersion[project.id] || 0);
  // Every finished turn is committed on the branch; the turn list changes with it.
  const turns = useStore((s) => s.turns[chat.id]);
  const working = useStore((s) => Object.values(s.statuses).some((st) => st.chatId === chat.id && st.state !== 'idle' && st.state !== 'error'));
  const [st, setSt] = useState<WorkspaceStatus | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState('');
  const [msg, setMsg] = useState('');
  const [conflicts, setConflicts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'' | 'merge' | 'sync' | 'resolve' | 'abort' | 'suggest'>('');
  // The project's commit rules (Settings of the project): merges then need a message that follows them.
  const guide = useStore((s) => s.projects[info.parentId]?.commitGuide);

  /** The model writes the merge message; with `review`, the user reads it before merging. */
  const suggest = async (review: boolean) => {
    setBusy('suggest');
    try {
      const r = await api.suggestCommitMessage(chat.id);
      setMsg(r.message);
      if (review) toast('Commit message written to project rules', 'Check it, then click Merge again', 'info');
    } catch (e) {
      toast('Could not generate commit message', (e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const refresh = () =>
    api
      .workspace(chat.id)
      .then((r) => {
        setSt(r);
        setErr('');
      })
      .catch((e) => setErr((e as Error).message));

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh when files, turns or the workspace change
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [active, filesVersion, turns, working, chat.id, project.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload the diff when files or the workspace change
  useEffect(() => {
    if (!open) return;
    api
      .workspaceDiff(chat.id, open)
      .then((r) => setDiff(r.diff))
      .catch(() => setDiff(''));
  }, [open, filesVersion, st, chat.id]);

  const act = async (kind: 'merge' | 'sync' | 'resolve' | 'abort') => {
    setBusy(kind);
    try {
      if (kind === 'merge') {
        const r = await api.mergeWorkspace(chat.id, msg.trim() || undefined);
        if (r.ok) {
          toast(`Merged into ${base}`, `${r.files} file${r.files === 1 ? '' : 's'} · commit ${r.commit}`, 'success');
          setMsg('');
          setConflicts(null);
        } else setConflicts(r.conflicts);
      } else if (kind === 'sync') {
        const r = await api.syncWorkspace(chat.id);
        if (r.ok) toast(`Synced latest changes from ${base}`, `${r.files} file${r.files === 1 ? '' : 's'}`, 'success');
        else setConflicts(r.conflicts);
      } else if (kind === 'resolve') {
        const r = await api.resolveConflicts(chat.id);
        setConflicts(null);
        if (r.started) toast('A bot is resolving the conflicts', r.conflicts.join(', '), 'info');
        else toast('No conflicts left', `Synced latest changes from ${base}`, 'success');
      } else {
        await api.abortSync(chat.id);
        setConflicts(null);
      }
    } catch (e) {
      toast({ merge: 'Merge failed', sync: 'Sync failed', resolve: 'Action failed', abort: 'Action failed' }[kind], (e as Error).message, 'error');
    } finally {
      setBusy('');
      void refresh();
    }
  };

  const blocked = !!busy || working;
  // Work the base branch does not have yet (files may net out, or sit outside a monorepo package).
  const pending = !!st && (st.ahead > 0 || st.dirty);
  // Paths are from the repository's top; only files inside the project folder open in the editor.
  const inProject = (p: string) => !!st && (!st.prefix || p.startsWith(st.prefix + '/'));
  const projectPath = (p: string) => (st?.prefix ? p.slice(st.prefix.length + 1) : p);
  return (
    <div className="ws-section">
      <div className="section-title">
        <GitBranch size={14} /> Isolated workspace <span className="badge accent">{info.branch}</span>
        <span className="muted ws-base">from {base}</span>
        <span className="spacer" />
        <button className="icon-btn sm" title="Refresh" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      {err ? (
        <div className="muted pad">{err}</div>
      ) : !st ? (
        <div className="pad">
          <span className="spinner" />
        </div>
      ) : (
        <>
          <div className="ws-meta muted">
            {st.files.length ? `${st.files.length} file${st.files.length === 1 ? '' : 's'} differ from ${base}` : pending ? `Commits not yet merged into ${base}` : `No differences from ${base}`}
            {st.behind > 0 && ` · ${base} has ${st.behind} new commit${st.behind === 1 ? '' : 's'}`}
            {st.mergedAt ? ` · last merged ${fmtWhen(st.mergedAt)}` : ''}
          </div>
          {(st.requireChallenge || st.challenge) && <ChallengeLine st={st} chatId={chat.id} blocked={blocked} />}
          {(st.merging || (conflicts && conflicts.length > 0)) && (
            <div className="ws-alert">
              {st.merging
                ? `Syncing ${base}. There are still conflicts to resolve${conflicts?.length ? ` in ${conflicts.join(', ')}` : ''}.`
                : `${conflicts!.join(', ')} also changed on ${base}. Both sides need to be combined first.`}
              <div className="row">
                <button className="btn sm primary" disabled={blocked} onClick={() => act('resolve')}>
                  {busy === 'resolve' ? <span className="spinner tiny" /> : <Sparkles size={13} />} Let a bot resolve conflicts
                </button>
                {st.merging ? (
                  <button className="btn sm" disabled={blocked} onClick={() => act('abort')}>
                    Abort this sync
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConflicts(null)}>
                    Later
                  </button>
                )}
              </div>
            </div>
          )}
          {!!st.files.length && (
            <div className="turn-files">
              {st.files.map((f) => (
                <div key={f.path}>
                  <button className={cx('turn-file', open === f.path && 'on')} onClick={() => setOpen(open === f.path ? null : f.path)}>
                    <ChevronRight size={12} className={cx('chev', open === f.path && 'open')} />
                    <span className={cx('fstat', f.status === 'renamed' ? 'modified' : f.status)}>{STATUS_LABEL[f.status]}</span>
                    <span className="fpath">{f.path}</span>
                    {f.status !== 'deleted' && inProject(f.path) && (
                      <span
                        className="icon-btn sm"
                        role="button"
                        title="Open in editor"
                        onClick={(e) => {
                          e.stopPropagation();
                          openFileInEditor(project.id, projectPath(f.path));
                        }}
                      >
                        <FileCode2 size={13} />
                      </span>
                    )}
                  </button>
                  {open === f.path && <UnifiedDiff text={diff} />}
                </div>
              ))}
            </div>
          )}
          <div className={cx('commit-box', guide && 'stacked')}>
            {guide ? (
              <textarea
                className="input mono"
                rows={msg ? Math.min(8, msg.split('\n').length + 1) : 2}
                placeholder={`Commit message, following project rules: ${guide}`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
              />
            ) : (
              <input
                className="input"
                placeholder={`Merge message (defaults to chat name "${chat.title}")`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pending && !blocked && !st.merging && act('merge')}
              />
            )}
            <div className="commit-actions">
              <button className="btn" disabled={!pending || blocked || st.merging} onClick={() => suggest(false)} title="Have the model write a commit message from this branch's changes">
                {busy === 'suggest' ? <span className="spinner tiny" /> : <Sparkles size={14} />} Generate
              </button>
              <button
                className="btn primary"
                disabled={!pending || blocked || st.merging}
                onClick={() => (guide && !msg.trim() ? suggest(true) : act('merge'))}
                title={`Squash this branch's changes into one commit on ${base}`}
              >
                {busy === 'merge' ? <span className="spinner tiny" /> : <GitMerge size={14} />} Merge into {base}
              </button>
            </div>
          </div>
          <div className="ws-actions">
            {st.behind > 0 && !st.merging && (
              <button className="btn sm" disabled={blocked} onClick={() => act('sync')} title={`Bring new commits from ${base} into this branch`}>
                {busy === 'sync' ? <span className="spinner tiny" /> : <RefreshCw size={13} />} Sync from {base}
              </button>
            )}
            <span className="spacer" />
            <button className="btn sm ghost danger-text" disabled={blocked} onClick={() => void closeWorkspace(chat, { discard: true })}>
              <Trash2 size={13} /> Discard branch
            </button>
          </div>
          {working && <div className="hint">A bot is working. You can merge or sync after this turn ends.</div>}
        </>
      )}
    </div>
  );
}

export function ChangesTab({ chat, project, active }: { chat: Chat; project: Project; active: boolean }) {
  const turns = useStore((s) => s.turns[chat.id]);
  const focus = useStore((s) => s.focusTurn);
  useEffect(() => {
    if (active) void loadTurns(chat.id);
  }, [active, chat.id]);
  return (
    <div className="changes">
      {project.workspace && <WorkspaceSection chat={chat} project={project} active={active} />}
      <div className="section-title">Bot changes in this chat</div>
      {!turns ? (
        <div className="pad">
          <span className="spinner" />
        </div>
      ) : !turns.length ? (
        <div className="muted pad">No changes yet. Files bots change in each turn are logged here, where you can view diffs and revert in one click.</div>
      ) : (
        turns.map((t) => <TurnCard key={t.id} turn={t} chat={chat} project={project} focus={focus && focus.turnId === t.id && focus.chatId === chat.id ? focus : undefined} />)
      )}
      <GitSection project={project} active={active} />
    </div>
  );
}

/** Where the branch stands with adversarial review: needed, passed at this commit, or refuted. */
function ChallengeLine({ st, chatId, blocked }: { st: WorkspaceStatus; chatId: string; blocked: boolean }) {
  const c = st.challenge;
  // The status lists files, not the head; the verdict is current when nothing changed after it.
  const stale = !!c && !!st.dirty;
  const text = !c
    ? 'No adversarial review yet'
    : c.refuted > 0
      ? `Adversarial review refuted ${c.refuted} claim${c.refuted === 1 ? '' : 's'} (${fmtWhen(c.at)})`
      : `Adversarial review found nothing to refute (${fmtWhen(c.at)})${stale ? ', changed since' : ''}`;
  return (
    <div className={cx('ws-challenge', c && c.refuted > 0 && 'refuted')}>
      <Scale size={13} />
      <span>
        {text}
        {st.requireChallenge && (!c || c.refuted > 0) ? ' · this project requires passing before merge' : ''}
      </span>
      <span className="spacer" />
      <button className="btn sm" disabled={blocked} onClick={() => void sendMessage(chatId, '/challenge')} title="Have the Skeptic look only at the requirements and changes, and try to disprove them">
        {c ? 'Review again' : 'Adversarial review'}
      </button>
    </div>
  );
}
