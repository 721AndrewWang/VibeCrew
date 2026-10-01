import { AlertTriangle, Check, ChevronRight, CircleSlash, Clock, FileCode2, Film, MousePointerClick, ShieldCheck, Undo2, X, Zap } from 'lucide-react';
import { type CSSProperties, memo, type ReactNode, useState } from 'react';
import type { ApprovalPart, Attachment, Bot, Chat, ChatMessage, MessagePart, ToolPart } from '../../../shared/types';
import { api } from '../api';
import { chatProjectId, focusTurn, openFileInEditor, toast, useStore } from '../store';
import { cx, fmtClock, fmtDuration, modelLabel, toolDuration, toolInfo } from '../utils';
import { Markdown } from './Markdown';
import { Avatar, confirmDialog, Glyph } from './ui';

// ---------------------------------------------------------------- attachments

export function AttachmentChips({ items, onRemove, projectId }: { items: Attachment[]; onRemove?: (id: string) => void; projectId?: string | null }) {
  if (!items.length) return null;
  return (
    <div className="att-chips">
      {items.map((a) => {
        let icon: ReactNode;
        let label: ReactNode;
        let title = '';
        let onClick: (() => void) | undefined;
        switch (a.kind) {
          case 'image':
            return (
              <span key={a.id} className="att-image">
                <a href={a.url} target="_blank" rel="noreferrer">
                  <img src={a.url} alt={a.name} />
                </a>
                {onRemove && (
                  <button className="att-x" onClick={() => onRemove(a.id)} aria-label="移除">
                    <X size={11} />
                  </button>
                )}
              </span>
            );
          case 'element':
            icon = <MousePointerClick size={13} />;
            label = (
              <>
                <b>{a.tag}</b>
                {a.text ? `「${a.text.slice(0, 18)}${a.text.length > 18 ? '…' : ''}」` : ` ${a.selector.split(' > ').pop()}`}
              </>
            );
            title = `${a.selector}${a.source ? `\n${a.source}` : ''}${a.component ? `\n${a.component}` : ''}`;
            break;
          case 'console':
            icon = <AlertTriangle size={13} />;
            label = `控制台 ${a.entries.length} 条`;
            title = a.entries
              .map((e) => `[${e.level}] ${e.text}`)
              .join('\n')
              .slice(0, 1500);
            break;
          case 'file':
            icon = <FileCode2 size={13} />;
            label = a.path.split('/').pop();
            title = a.path;
            if (projectId) onClick = () => openFileInEditor(projectId, a.path);
            break;
          case 'recording':
            icon = <Film size={13} />;
            label = `录制的 ${a.steps.length} 步操作`;
            title = a.steps.map((s, i) => `${i + 1}. ${s.type} ${s.text || s.selector || s.url || ''}`).join('\n');
            break;
        }
        return (
          <span key={a.id} className={cx('att-chip', `att-${a.kind}`, onClick && 'clickable')} title={title} onClick={onClick}>
            {icon}
            <span className="att-label">{label}</span>
            {onRemove && (
              <button
                className="att-x"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(a.id);
                }}
                aria-label="移除"
              >
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- tools

function ToolDetail({ part, root }: { part: ToolPart; root?: string }) {
  const input = part.input || {};
  let body: ReactNode = null;
  if (part.name === 'Bash') body = <pre className="tool-code">$ {input.command}</pre>;
  else if (part.name === 'Edit') {
    body = (
      <pre className="tool-code diff">
        {String(input.old_string || '')
          .split('\n')
          .map((l, i) => (
            <div key={`o${i}`} className="del">
              - {l}
            </div>
          ))}
        {String(input.new_string || '')
          .split('\n')
          .map((l, i) => (
            <div key={`n${i}`} className="add">
              + {l}
            </div>
          ))}
      </pre>
    );
  } else if (part.name === 'Write') {
    const lines = String(input.content || '').split('\n');
    body = (
      <pre className="tool-code">
        {lines.slice(0, 40).join('\n')}
        {lines.length > 40 ? `\n…（共 ${lines.length} 行）` : ''}
      </pre>
    );
  } else if (part.name === 'TodoWrite') {
    body = null;
  } else if (Object.keys(input).length) {
    body = <pre className="tool-code">{JSON.stringify(input, null, 2).slice(0, 3000)}</pre>;
  }
  const fp = input.file_path as string | undefined;
  const projectId = useStore((s) => (s.activeChatId ? chatProjectId(s.chats[s.activeChatId], s.projects) : null));
  return (
    <div className="tool-detail">
      {fp && projectId && root && fp.startsWith(root) && (
        <button className="btn sm ghost" onClick={() => openFileInEditor(projectId, fp.slice(root.length + 1))}>
          <FileCode2 size={13} /> 在编辑器中打开
        </button>
      )}
      {body}
      {part.result !== undefined && part.result !== '' && (
        <>
          <div className="tool-sub">{part.status === 'error' ? '错误' : '结果'}</div>
          <pre className={cx('tool-code', part.status === 'error' && 'err')}>{part.result}</pre>
        </>
      )}
      {!!part.images?.length && (
        <div className="tool-images">
          {part.images.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">
              <img src={u} alt="截图" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function TodoList({ todos }: { todos: { content: string; status: string; activeForm?: string }[] }) {
  return (
    <ul className="todo-list">
      {todos.map((t, i) => (
        <li key={i} className={t.status}>
          <span className="todo-box">
            {t.status === 'completed' ? <Check size={11} /> : t.status === 'in_progress' ? <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> : null}
          </span>
          <span>{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
        </li>
      ))}
    </ul>
  );
}

function ToolRow({ part, root }: { part: ToolPart; root?: string }) {
  const [open, setOpen] = useState(false);
  const info = toolInfo(part.name, part.input, root);
  if (part.name === 'TodoWrite' && Array.isArray(part.input?.todos)) {
    return (
      <div className="tool-todo">
        <div className="tool-row static">
          <span className="tool-icon">
            <Glyph emoji="✅" size={13} />
          </span>
          <span className="tool-verb">任务清单</span>
        </div>
        <TodoList todos={part.input.todos} />
      </div>
    );
  }
  return (
    <div className={cx('tool', open && 'open', part.parent && 'nested')}>
      <button className="tool-row" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="chev" />
        <span className="tool-icon">
          <Glyph emoji={info.icon} size={13} />
        </span>
        <span className="tool-verb">{info.verb}</span>
        <span className="tool-target">{info.target}</span>
        <span className="tool-state">
          {part.status === 'running' ? <span className="spinner" /> : part.status === 'error' ? <X size={13} className="err-ic" /> : <Check size={13} className="ok-ic" />}
          {part.status !== 'running' && <span className="tool-dur">{toolDuration(part)}</span>}
        </span>
      </button>
      {open && <ToolDetail part={part} root={root} />}
    </div>
  );
}

function ToolGroup({ parts, live, root }: { parts: ToolPart[]; live: boolean; root?: string }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  const edits = new Set(parts.filter((p) => ['Edit', 'Write', 'MultiEdit'].includes(p.name)).map((p) => p.input?.file_path)).size;
  const commands = parts.filter((p) => p.name === 'Bash').length;
  const running = parts.filter((p) => p.status === 'running').length;
  const errors = parts.filter((p) => p.status === 'error').length;
  const shots = parts.flatMap((p) => p.images || []).slice(-3);
  const summary = [`${parts.length} 个操作`, edits ? `改了 ${edits} 个文件` : '', commands ? `运行了 ${commands} 条命令` : '', errors ? `${errors} 个出错` : ''].filter(Boolean).join(' · ');
  const visible = expanded ? parts : [];
  return (
    <div className={cx('tool-group', expanded && 'expanded')}>
      <button className="tool-group-head" onClick={() => setOpen(!expanded)}>
        <ChevronRight size={14} className="chev" />
        {running ? <span className="spinner" /> : <Zap size={13} />}
        <span>{running ? `正在${toolInfo(parts.find((p) => p.status === 'running')!.name, {}).verb}… · ${summary}` : summary}</span>
      </button>
      {expanded && (
        <div className="tool-list">
          {visible.map((p) => (
            <ToolRow key={p.id} part={p} root={root} />
          ))}
        </div>
      )}
      {!expanded && shots.length > 0 && (
        <div className="tool-images compact">
          {shots.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" title="机器人看到的页面截图">
              <img src={u} alt="截图" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- approvals

/** "Bash(git log*)" → "git log"; several joined for the "always allow" button. */
function ruleNames(rules: string[]): string {
  const names = rules.map((r) => r.replace(/^Bash\((.*?)(:?\*)?\)$/, '$1'));
  return names.length > 4 ? `${names.slice(0, 4).join('、')} 等 ${names.length} 个` : names.join('、');
}

function ApprovalCard({ part }: { part: ApprovalPart }) {
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [denying, setDenying] = useState(false);
  const decide = async (d: 'allow' | 'always' | 'deny') => {
    setBusy(true);
    try {
      await api.approve(part.id, d, d === 'deny' ? reason.trim() || undefined : undefined);
    } catch (e) {
      toast('操作失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const pending = part.status === 'pending';
  return (
    <div className={cx('approval', part.status)}>
      <div className="approval-head">
        <ShieldCheck size={16} />
        <span className="approval-title">{part.title}</span>
        {!pending && (
          <span className={cx('badge', part.status === 'allowed' ? 'green' : part.status === 'denied' ? 'red' : '')}>
            {part.status === 'allowed' ? '已允许' : part.status === 'denied' ? '已拒绝' : '已失效'}
          </span>
        )}
      </div>
      {part.detail && <pre className="approval-detail">{part.detail}</pre>}
      {part.because && <div className="approval-reason">为什么要问：{part.because}</div>}
      {part.reason && pending && <div className="approval-reason">{part.reason}</div>}
      {pending && !denying && (
        <div className="approval-actions">
          <button className="btn primary sm" disabled={busy} onClick={() => decide('allow')}>
            允许
          </button>
          {(part.rules?.length || part.rule) && (
            <button className="btn sm" disabled={busy} onClick={() => decide('always')} title={`以后自动允许：${(part.rules || [part.rule]).join('、')}`}>
              总是允许 <code>{ruleNames(part.rules || [part.rule!])}</code>
            </button>
          )}
          <button className="btn sm danger" disabled={busy} onClick={() => setDenying(true)}>
            拒绝
          </button>
        </div>
      )}
      {pending && denying && (
        <div className="approval-actions">
          <input
            className="input"
            autoFocus
            placeholder="告诉它为什么 / 应该怎么做（可选）"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && decide('deny')}
          />
          <button className="btn sm danger solid" disabled={busy} onClick={() => decide('deny')}>
            拒绝
          </button>
          <button className="btn sm" onClick={() => setDenying(false)}>
            返回
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- messages

type Block = { kind: 'part'; part: MessagePart; index: number } | { kind: 'tools'; parts: ToolPart[]; key: string };

function groupParts(parts: MessagePart[]): Block[] {
  const out: Block[] = [];
  parts.forEach((part, index) => {
    if (part.type === 'tool' && part.name !== 'TodoWrite') {
      const last = out[out.length - 1];
      if (last && last.kind === 'tools') last.parts.push(part);
      else out.push({ kind: 'tools', parts: [part], key: part.id });
    } else out.push({ kind: 'part', part, index });
  });
  return out;
}

function ChangesBar({ msg, chat }: { msg: ChatMessage; chat: Chat }) {
  const [busy, setBusy] = useState(false);
  const files = msg.changes?.files || [];
  if (!files.length || !msg.turnId) return null;
  const revert = async () => {
    if (
      !(await confirmDialog({
        title: '撤销这一轮的改动？',
        body: `会把 ${files.length} 个文件恢复到 ${useStore.getState().bots[msg.botId || '']?.name || '机器人'} 修改之前的样子。`,
        ok: '撤销',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      let r = await api.revertTurn(chat.id, msg.turnId!);
      if (r.conflicts.length) {
        const force = await confirmDialog({
          title: '有文件在之后又被改过',
          body: (
            <>
              这些文件在这一轮之后又被修改了：<code>{r.conflicts.join('、')}</code>。强制撤销会覆盖之后的修改。
            </>
          ),
          ok: '强制撤销',
          danger: true,
        });
        if (!force) return;
        r = await api.revertTurn(chat.id, msg.turnId!, true);
      }
      toast('已撤销', `恢复了 ${r.reverted.length} 个文件${r.skipped.length ? `，${r.skipped.length} 个由命令改动的文件无法自动恢复` : ''}`, 'success');
    } catch (e) {
      toast('撤销失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="changes-bar">
      <FileCode2 size={13} />
      <button className="link" onClick={() => focusTurn(chat.id, msg.turnId!)}>
        改动了 {files.length} 个文件
      </button>
      <span className="files">
        {files
          .slice(0, 3)
          .map((f) => f.split('/').pop())
          .join('、')}
        {files.length > 3 ? ' 等' : ''}
      </span>
      <span className="spacer" />
      {msg.changes?.reverted ? (
        <span className="badge">已撤销</span>
      ) : (
        <button className="btn sm ghost" disabled={busy || msg.status === 'streaming'} onClick={revert} title="撤销这一轮">
          <Undo2 size={13} /> 撤销
        </button>
      )}
    </div>
  );
}

export const BotMessage = memo(function BotMessage({ msg, chat, bot, showHead, names, root }: { msg: ChatMessage; chat: Chat; bot?: Bot; showHead: boolean; names: string[]; root?: string }) {
  const live = msg.status === 'streaming';
  const workProjectId = useStore((s) => chatProjectId(chat, s.projects));
  const blocks = groupParts(msg.parts || []);
  const hasText = (msg.parts || []).some((p) => p.type === 'text' && p.text.trim());
  const by = msg.trigger?.type === 'mention' && msg.trigger.by ? useStore.getState().bots[msg.trigger.by]?.name : null;
  return (
    <div className={cx('msg bot', !showHead && 'cont')}>
      <div className="msg-avatar">{showHead && <Avatar bot={bot} size={32} />}</div>
      <div className="msg-body">
        {showHead && (
          <div className="msg-head">
            <span className="msg-name" style={{ '--bot-color': bot?.color } as CSSProperties}>
              {bot?.name || '已删除的机器人'}
            </span>
            {by && <span className="msg-meta">回应 @{by}</span>}
            {msg.trigger?.type === 'routine' && (
              <span className="msg-meta">
                <Clock size={11} /> 定时任务
              </span>
            )}
            <span className="msg-time">{fmtClock(msg.ts)}</span>
          </div>
        )}
        {blocks.map((b) =>
          b.kind === 'tools' ? (
            <ToolGroup key={b.key} parts={b.parts} live={live} root={root} />
          ) : b.part.type === 'text' ? (
            b.part.text.trim() ? (
              <div key={b.index} className="bubble bot-bubble">
                <Markdown text={b.part.text} names={names} projectId={workProjectId} />
              </div>
            ) : null
          ) : b.part.type === 'thinking' ? (
            b.part.text.trim() ? (
              <details key={b.index} className="thinking">
                <summary>
                  <Glyph emoji="💭" size={13} /> 思考过程
                </summary>
                <div className="thinking-text">{b.part.text}</div>
              </details>
            ) : null
          ) : b.part.type === 'approval' ? (
            <ApprovalCard key={b.part.id} part={b.part} />
          ) : b.part.type === 'tool' ? (
            <ToolRow key={b.part.id} part={b.part} root={root} />
          ) : null,
        )}
        {live && !hasText && !(msg.parts || []).length && (
          <div className="bubble bot-bubble typing">
            <span className="typing-mini big">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        {live && (msg.parts || []).length > 0 && (
          <div className="msg-live">
            <span className="typing-mini">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
        {msg.status === 'error' && (
          <div className="msg-error">
            <AlertTriangle size={14} />
            <Markdown text={msg.error || '出错了'} />
          </div>
        )}
        {msg.status === 'stopped' && (
          <div className="msg-stopped">
            <CircleSlash size={12} /> {msg.interrupted ? 'Crew 重启时中断了这一轮，写到一半的内容已保留' : '已停止'}
          </div>
        )}
        <ChangesBar msg={msg} chat={chat} />
        {!live && msg.meta?.durationMs !== undefined && msg.status === 'done' && (
          <div className="msg-foot">
            用时 {fmtDuration(msg.meta.durationMs)}
            {msg.meta.model ? ` · ${modelLabel(msg.meta.model)}` : ''}
            {msg.meta.costUsd ? ` · $${msg.meta.costUsd.toFixed(3)}` : ''}
          </div>
        )}
      </div>
    </div>
  );
});

function renderUserText(text: string, names: string[]) {
  if (!names.length) return text;
  const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|所有人|all)(?![A-Za-z0-9_-]))`, 'gi');
  return text.split(re).map((seg, i) =>
    i % 2 === 1 ? (
      <span key={i} className="mention">
        {seg}
      </span>
    ) : (
      seg
    ),
  );
}

export const UserMessage = memo(function UserMessage({ msg, chat, names, showTime }: { msg: ChatMessage; chat: Chat; names: string[]; showTime: boolean }) {
  const skill = msg.skill ? useStore.getState().skills.find((s) => s.name === msg.skill) : null;
  const workProjectId = useStore((s) => chatProjectId(chat, s.projects));
  return (
    <div className="msg me">
      <div className="msg-body">
        {(msg.trigger?.type === 'routine' || skill) && (
          <div className="msg-tags">
            {msg.trigger?.type === 'routine' && (
              <span className="badge accent">
                <Clock size={11} /> 定时任务
              </span>
            )}
            {skill && (
              <span className="badge accent" title={skill.description}>
                <Glyph emoji={skill.icon} size={11} /> {skill.title}
              </span>
            )}
          </div>
        )}
        {msg.text && <div className="bubble me-bubble">{renderUserText(msg.text, names)}</div>}
        {!!msg.attachments?.length && <AttachmentChips items={msg.attachments} projectId={workProjectId} />}
        {showTime && <div className="msg-time right">{fmtClock(msg.ts)}</div>}
      </div>
    </div>
  );
});

export function SystemMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="msg-system">
      <span>{msg.text}</span>
    </div>
  );
}
