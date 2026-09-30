import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FileCode2, GitBranch, GitCommitHorizontal, GitMerge, RefreshCw, Sparkles, Trash2, Undo2 } from 'lucide-react';
import type { Chat, Project, TurnSummary, WorkspaceStatus } from '../../../../shared/types';
import { api, type GitStatus, type TurnDiff } from '../../api';
import { loadTurns, openFileInEditor, toast, useStore } from '../../store';
import { cx, fmtWhen } from '../../utils';
import { Avatar, confirmDialog, Glyph } from '../ui';
import { closeWorkspace } from '../../workspace';
import { DiffView, UnifiedDiff } from './DiffView';

const STATUS_LABEL = { added: '新增', modified: '修改', deleted: '删除', unknown: '命令改动', renamed: '重命名' } as const;

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
  if (!d) return <div className="pad"><span className="spinner" /></div>;
  if (d.binary || d.tooLarge) return <div className="muted pad">{d.binary ? '二进制文件，无法显示差异' : '文件太大，没有保存快照'}</div>;
  if (d.before === undefined) return <div className="muted pad">这个文件是被命令（比如 npm install 或脚本）修改的，没有修改前的快照，无法显示差异或自动撤销。</div>;
  return (
    <>
      {d.current !== undefined && d.after !== undefined && d.current !== d.after && (
        <div className="diff-note">
          <Glyph emoji="⚠️" size={12} /> 这个文件在这一轮之后又被修改过，下面显示的是这一轮本身的改动。
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

  useEffect(() => {
    if (!focus) return;
    setOpen(focus.path || turn.files[0]?.path || null);
    setTimeout(() => ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);

  const revert = async () => {
    if (!(await confirmDialog({ title: '撤销这一轮的改动？', body: `恢复 ${turn.files.length} 个文件到 ${bot?.name || '机器人'} 修改之前的样子。`, ok: '撤销', danger: true }))) return;
    setBusy(true);
    try {
      let r = await api.revertTurn(chat.id, turn.id);
      if (r.conflicts.length) {
        if (!(await confirmDialog({ title: '有文件之后又被改过', body: `${r.conflicts.join('、')} 在这一轮之后又被修改过，强制撤销会覆盖之后的修改。`, ok: '强制撤销', danger: true }))) return;
        r = await api.revertTurn(chat.id, turn.id, true);
      }
      toast('已撤销', `恢复了 ${r.reverted.length} 个文件`, 'success');
      void loadTurns(chat.id);
    } catch (e) {
      toast('撤销失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cx('turn-card', turn.reverted && 'reverted')} ref={ref}>
      <div className="turn-head">
        <Avatar bot={bot} size={22} />
        <b>{bot?.name || '机器人'}</b>
        <span className="muted">
          {fmtWhen(turn.startedAt)} · {turn.files.length} 个文件
        </span>
        <span className="spacer" />
        {turn.reverted ? (
          <span className="badge">已撤销</span>
        ) : (
          <button className="btn sm ghost" disabled={busy} onClick={revert}>
            <Undo2 size={13} /> 撤销
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
                title="在编辑器中打开"
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

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(refresh, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, filesVersion, project.id]);

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
      toast('已提交', undefined, 'success');
    } catch (e) {
      toast('提交失败', (e as Error).message, 'error');
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
        <button className="icon-btn sm" title="刷新" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      {!st.repo ? (
        <div className="muted pad">这个项目还不是 Git 仓库。提交一次就会自动初始化，之后可以随时回退。</div>
      ) : !st.files?.length ? (
        <div className="muted pad">工作区很干净，没有未提交的改动。</div>
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
          <input className="input" placeholder="提交说明，例如：完成首页布局" value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && msg.trim() && commit()} />
          <button className="btn primary" disabled={!msg.trim() || busy} onClick={commit}>
            <GitCommitHorizontal size={14} /> 提交全部
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
      if (review) toast('已按项目要求写好提交说明', '看一下没问题，再点一次合并', 'info');
    } catch (e) {
      toast('没能生成提交说明', (e as Error).message, 'error');
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

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, filesVersion, turns, working, chat.id, project.id]);

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
          toast(`已合并到 ${base}`, `${r.files} 个文件 · 提交 ${r.commit}`, 'success');
          setMsg('');
          setConflicts(null);
        } else setConflicts(r.conflicts);
      } else if (kind === 'sync') {
        const r = await api.syncWorkspace(chat.id);
        if (r.ok) toast(`已同步 ${base} 的最新改动`, `${r.files} 个文件`, 'success');
        else setConflicts(r.conflicts);
      } else if (kind === 'resolve') {
        const r = await api.resolveConflicts(chat.id);
        setConflicts(null);
        if (r.started) toast('已交给机器人解决冲突', r.conflicts.join('、'), 'info');
        else toast('没有冲突了', `已同步 ${base} 的最新改动`, 'success');
      } else {
        await api.abortSync(chat.id);
        setConflicts(null);
      }
    } catch (e) {
      toast({ merge: '合并失败', sync: '同步失败', resolve: '操作失败', abort: '操作失败' }[kind], (e as Error).message, 'error');
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
        <GitBranch size={14} /> 独立工作区 <span className="badge accent">{info.branch}</span>
        <span className="muted ws-base">从 {base} 分出</span>
        <span className="spacer" />
        <button className="icon-btn sm" title="刷新" onClick={refresh}>
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
            {st.files.length ? `${st.files.length} 个文件和 ${base} 不同` : pending ? `有还没合并到 ${base} 的提交` : `和 ${base} 没有区别`}
            {st.behind > 0 && ` · ${base} 有 ${st.behind} 个新提交`}
            {st.mergedAt ? ` · 上次合并于 ${fmtWhen(st.mergedAt)}` : ''}
          </div>
          {(st.merging || (conflicts && conflicts.length > 0)) && (
            <div className="ws-alert">
              {st.merging
                ? `正在同步 ${base}，${conflicts?.length ? `${conflicts.join('、')} 里` : ''}还有冲突需要处理。`
                : `${conflicts!.join('、')} 在 ${base} 上也被改过了，需要先把两边的改动合在一起。`}
              <div className="row">
                <button className="btn sm primary" disabled={blocked} onClick={() => act('resolve')}>
                  {busy === 'resolve' ? <span className="spinner tiny" /> : <Sparkles size={13} />} 让机器人解决冲突
                </button>
                {st.merging ? (
                  <button className="btn sm" disabled={blocked} onClick={() => act('abort')}>
                    放弃这次同步
                  </button>
                ) : (
                  <button className="btn sm ghost" onClick={() => setConflicts(null)}>
                    稍后
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
                        title="在编辑器中打开"
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
                placeholder={`提交说明，要按项目要求写：${guide}`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
              />
            ) : (
              <input
                className="input"
                placeholder={`合并说明（默认用对话名「${chat.title}」）`}
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pending && !blocked && !st.merging && act('merge')}
              />
            )}
            <div className="commit-actions">
              <button className="btn" disabled={!pending || blocked || st.merging} onClick={() => suggest(false)} title="让模型根据这个分支的改动写提交说明">
                {busy === 'suggest' ? <span className="spinner tiny" /> : <Sparkles size={14} />} 生成
              </button>
              <button
                className="btn primary"
                disabled={!pending || blocked || st.merging}
                onClick={() => (guide && !msg.trim() ? suggest(true) : act('merge'))}
                title={`把这个分支的改动合成一个提交，放进 ${base}`}
              >
                {busy === 'merge' ? <span className="spinner tiny" /> : <GitMerge size={14} />} 合并到 {base}
              </button>
            </div>
          </div>
          <div className="ws-actions">
            {st.behind > 0 && !st.merging && (
              <button className="btn sm" disabled={blocked} onClick={() => act('sync')} title={`把 ${base} 的新提交合进这个分支`}>
                {busy === 'sync' ? <span className="spinner tiny" /> : <RefreshCw size={13} />} 同步 {base} 的新提交
              </button>
            )}
            <span className="spacer" />
            <button className="btn sm ghost danger-text" disabled={blocked} onClick={() => void closeWorkspace(chat, { discard: true })}>
              <Trash2 size={13} /> 丢弃分支
            </button>
          </div>
          {working && <div className="hint">机器人正在工作，这一轮结束后才能合并或同步。</div>}
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
      <div className="section-title">机器人在这个对话里的改动</div>
      {!turns ? (
        <div className="pad">
          <span className="spinner" />
        </div>
      ) : !turns.length ? (
        <div className="muted pad">还没有改动。机器人每一轮修改的文件都会记录在这里，可以查看差异、一键撤销。</div>
      ) : (
        turns.map((t) => <TurnCard key={t.id} turn={t} chat={chat} project={project} focus={focus && focus.turnId === t.id && focus.chatId === chat.id ? focus : undefined} />)
      )}
      <GitSection project={project} active={active} />
    </div>
  );
}
