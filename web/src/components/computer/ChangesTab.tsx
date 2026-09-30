import { useEffect, useRef, useState } from 'react';
import { ChevronRight, FileCode2, GitBranch, GitCommitHorizontal, RefreshCw, Undo2 } from 'lucide-react';
import type { Chat, Project, TurnSummary } from '../../../../shared/types';
import { api, type GitStatus, type TurnDiff } from '../../api';
import { loadTurns, openFileInEditor, toast, useStore } from '../../store';
import { cx, fmtClock, fmtShort } from '../../utils';
import { Avatar, confirmDialog } from '../ui';
import { DiffView, UnifiedDiff } from './DiffView';

const STATUS_LABEL = { added: '新增', modified: '修改', deleted: '删除', unknown: '命令改动' } as const;

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
      {d.current !== undefined && d.after !== undefined && d.current !== d.after && <div className="diff-note">⚠️ 这个文件在这一轮之后又被修改过，下面显示的是这一轮本身的改动。</div>}
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
          {fmtShort(turn.startedAt)} {fmtClock(turn.startedAt)} · {turn.files.length} 个文件
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

export function ChangesTab({ chat, project, active }: { chat: Chat; project: Project; active: boolean }) {
  const turns = useStore((s) => s.turns[chat.id]);
  const focus = useStore((s) => s.focusTurn);
  useEffect(() => {
    if (active) void loadTurns(chat.id);
  }, [active, chat.id]);
  return (
    <div className="changes">
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
