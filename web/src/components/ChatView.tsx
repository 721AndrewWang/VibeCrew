import {
  ArrowDown,
  ChevronLeft,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitMerge,
  LogOut,
  Monitor,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  Settings2,
  Unlink,
  Users,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Chat } from '../../../shared/types';
import { api } from '../api';
import { chatProjectId, listProjects, loadMessages, openModal, requestTerminal, setComputer, setDraft, setView, toast, useStore } from '../store';
import { cx, fmtDay, isSameDay, statusLabel } from '../utils';
import { closeWorkspace, enableWorkspace, showWorkspaceChanges } from '../workspace';
import { Composer } from './Composer';
import { ComputerPane } from './computer/ComputerPane';
import { BotMessage, SystemMessage, UserMessage } from './Message';
import { chatMenuItems } from './Sidebar';
import { Avatar, confirmDialog, Glyph, GroupAvatar, MenuButton, type MenuItem } from './ui';

/** Switching the project closes the chat's workspace (a branch with unmerged work is kept). */
async function switchProject(chat: Chat, projectId: string | null) {
  if (chat.workspaceId) {
    const ok = await confirmDialog({
      title: '切换项目？',
      body: '这个对话的独立工作区属于当前项目，切换后会关闭它。还没合并的改动会保留在它的分支里。',
      ok: '切换',
    });
    if (!ok) return;
  }
  await api.updateChat(chat.id, { projectId }).catch((e) => toast('切换失败', e.message, 'error'));
}

function ProjectPicker({ chat }: { chat: Chat }) {
  const projects = useStore((s) => s.projects);
  const project = chat.projectId ? projects[chat.projectId] : null;
  const ws = chat.workspaceId ? projects[chat.workspaceId]?.workspace : undefined;
  const items = (): MenuItem[] => [
    { heading: '切换项目' },
    ...listProjects(projects).map((p) => ({
      label: p.name,
      hint: p.id === chat.projectId ? '当前' : p.framework,
      icon: <FolderGit2 size={15} />,
      onClick: () => {
        if (p.id !== chat.projectId) void switchProject(chat, p.id);
      },
    })),
    ...(project
      ? ws
        ? [
            { separator: true },
            { heading: `独立工作区 · ${ws.branch}` },
            { label: '查看改动 / 合并', icon: <GitMerge size={15} />, onClick: showWorkspaceChanges },
            { label: '关闭独立工作区…', icon: <LogOut size={15} />, onClick: () => void closeWorkspace(chat) },
          ]
        : [{ separator: true }, { label: '在独立分支中工作…', hint: '新建 Git 分支', icon: <GitBranch size={15} />, onClick: () => void enableWorkspace(chat) }]
      : []),
    { separator: true },
    { label: '新建 / 打开项目…', icon: <FolderPlus size={15} />, onClick: () => openModal({ kind: 'newProject' }) },
    ...(project ? [{ label: '解除绑定', icon: <Unlink size={15} />, onClick: () => void switchProject(chat, null) }] : []),
  ];
  const title = !project ? '绑定一个项目' : ws ? `${project.path}\n独立工作区：分支 ${ws.branch}（从 ${ws.baseBranch} 分出）` : project.path;
  return (
    <MenuButton className={cx('project-pill', !project && 'none', ws && 'isolated')} items={items} align="right" title={title}>
      {ws ? <GitBranch size={14} /> : <FolderGit2 size={14} />}
      <span>{project ? project.name : '未绑定项目'}</span>
      {ws && <span className="pill-branch">{ws.branch}</span>}
    </MenuButton>
  );
}

function ChatHeader({ chat }: { chat: Chat }) {
  const bots = useStore((s) => s.bots);
  const statuses = useStore((s) => s.statuses);
  const computerOpen = useStore((s) => s.computer.open);
  const members = chat.botIds.map((id) => bots[id]).filter(Boolean);
  const dm = chat.kind === 'dm' ? members[0] : null;
  const st = dm ? statuses[dm.id] : undefined;
  const busy = members.filter((b) => statuses[b.id]?.chatId === chat.id && statuses[b.id]?.state !== 'idle' && statuses[b.id]?.state !== 'error');
  return (
    <header className="chat-head">
      <button className="icon-btn mobile-back" onClick={() => useStore.setState({ mobilePane: 'list' })} aria-label="返回">
        <ChevronLeft size={20} />
      </button>
      <button className="ch-who" onClick={() => (dm ? openModal({ kind: 'botEditor', botId: dm.id }) : openModal({ kind: 'chatSettings', chatId: chat.id }))}>
        {dm ? <Avatar bot={dm} size={34} status={st} /> : <GroupAvatar bots={members} size={34} />}
        <div className="ch-text">
          <div className="ch-title">{chat.title}</div>
          <div className="ch-sub">
            {dm ? (
              st && st.state !== 'idle' && st.chatId === chat.id ? (
                <span className={cx('ch-status', statusLabel(st).tone)}>{statusLabel(st).text}</span>
              ) : (
                dm.title
              )
            ) : busy.length ? (
              <span className="ch-status busy">
                {busy.map((b) => b.name).join('、')} {busy.some((b) => statuses[b.id]?.state === 'waiting') ? '等待你确认' : '正在工作…'}
              </span>
            ) : (
              <>
                <Users size={11} /> {members.map((b) => b.name).join('、')}
              </>
            )}
          </div>
        </div>
      </button>
      <span className="spacer" />
      <ProjectPicker chat={chat} />
      <button
        className="icon-btn"
        title="开始新话题（机器人忘记之前的上下文）"
        onClick={async () => {
          if (await confirmDialog({ title: '开始新话题？', body: '机器人会忘记这个对话之前的上下文（聊天记录仍然保留）。切换到不相关的任务时这样做，回复会更快、更省用量。', ok: '开始新话题' }))
            void api.reset(chat.id);
        }}
      >
        <RotateCcw size={17} />
      </button>
      <button className="icon-btn only-mobile" title="电脑" onClick={() => useStore.setState({ mobilePane: 'computer' })}>
        <Monitor size={18} />
      </button>
      <button className="icon-btn hide-mobile" title={computerOpen ? '收起电脑面板' : '打开电脑面板'} onClick={() => setComputer({ open: !computerOpen })}>
        {computerOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
      <MenuButton
        align="right"
        items={() => [...(dm ? [{ label: `${dm.name} 的设置`, icon: <Settings2 size={15} />, onClick: () => openModal({ kind: 'botEditor', botId: dm.id }) }] : []), ...chatMenuItems(chat)]}
      >
        <MoreHorizontal size={18} />
      </MenuButton>
    </header>
  );
}

function AuthBanner() {
  const auth = useStore((s) => s.auth);
  const settings = useStore((s) => s.settings);
  if (auth.ready || !auth.checkedAt) return null;
  return (
    <div className="auth-banner">
      <b>机器人还不能工作：</b>
      {!auth.cliFound ? (
        <>
          没有找到 Claude Code。请先在终端安装：<code>npm i -g @anthropic-ai/claude-code</code>
        </>
      ) : settings.authMode === 'api-key' ? (
        <>API Key 未设置。</>
      ) : settings.authMode === 'provider' ? (
        <>模型服务商还没配置好（缺少地址、Key 或模型名）。</>
      ) : (
        <>本机的 Claude Code 还没有登录。也可以在设置里改用 API Key 或其他模型服务商（DeepSeek、Kimi、智谱 GLM…）。</>
      )}
      <span className="spacer" />
      {auth.cliFound && settings.authMode === 'claude-code' && (
        <button className="btn sm" onClick={() => requestTerminal('claude auth login')}>
          在终端登录
        </button>
      )}
      <button className="btn sm" onClick={() => setView('settings')}>
        设置
      </button>
      <button
        className="btn sm ghost"
        onClick={async () => {
          const a = await api.auth(true);
          useStore.setState({ auth: a });
          toast(a.ready ? '模型已连接' : '还没有连接好', a.ready ? '机器人可以开始工作了' : '完成登录或设置后再点一次「重新检测」', a.ready ? 'success' : 'warn');
        }}
      >
        重新检测
      </button>
    </div>
  );
}

const SUGGESTIONS: Record<string, string[]> = {
  group: ['做一个咖啡店的落地页，要有菜单、门店和预约', '检查一下现在的页面，列出最该改进的 3 件事', '/responsive', '/polish'],
  chief: ['帮我规划一个个人作品集网站，并分派给大家', '现在项目的进度怎么样？下一步该做什么？'],
  pixel: ['把首页改成现代的深色风格', '/landing 一款番茄钟 App', '/component 带搜索的下拉选择框', '/responsive'],
  forge: ['给项目加一个联系表单的后端接口', '把项目改成 Vite + React + TypeScript'],
  probe: ['把主要流程都点一遍，找找 bug', '/fix-console', '/e2e 首页按钮点击后的交互'],
  lens: ['/review', '审查一下最近的改动有没有安全问题'],
  muse: ['给这个页面设计一套更有质感的配色和字体', '/polish'],
  quill: ['/seo', '重写首页文案，更简洁有力'],
  default: ['/explain', '做一个简单的待办清单页面', '/fix-console'],
};

function EmptyChat({ chat }: { chat: Chat }) {
  const bots = useStore((s) => s.bots);
  const members = chat.botIds.map((id) => bots[id]).filter(Boolean);
  const dm = chat.kind === 'dm' ? members[0] : null;
  const list = dm ? SUGGESTIONS[dm.template || ''] || SUGGESTIONS.default : SUGGESTIONS.group;
  return (
    <div className="chat-empty">
      {dm ? <Avatar bot={dm} size={64} /> : <GroupAvatar bots={members} size={64} />}
      <h3>{dm ? dm.name : chat.title}</h3>
      <p>{dm ? dm.title : `${members.map((b) => b.name).join('、')} · 没有 @ 人时由 ${bots[chat.leadBotId || '']?.name || members[0]?.name} 回复`}</p>
      <div className="suggestions">
        {list.map((s) => (
          <button key={s} className="suggestion" onClick={() => setDraft(chat.id, { text: s })}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageList({ chat }: { chat: Chat }) {
  const st = useStore((s) => s.msgs[chat.id]);
  const bots = useStore((s) => s.bots);
  const statuses = useStore((s) => s.statuses);
  const root = useStore((s) => {
    const id = chatProjectId(chat, s.projects);
    return id ? s.projects[id]?.path : undefined;
  });
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef<number | null>(null);
  const [showDown, setShowDown] = useState(false);
  const names = useMemo(() => Object.values(bots).map((b) => b.name), [bots]);
  const list = st?.list || [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: stick to the bottom again whenever the chat changes
  useEffect(() => {
    stick.current = true;
  }, [chat.id]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = ref.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setShowDown(!near);
  };

  const queued = chat.botIds.map((id) => bots[id]).filter((b) => b && statuses[b.id]?.state === 'queued' && statuses[b.id]?.chatId === chat.id);

  return (
    <div className="msg-scroll" ref={ref} onScroll={onScroll}>
      <div className="msg-list">
        {st?.hasMore && (
          <div className="load-more">
            <button
              className="btn sm"
              disabled={st.loading}
              onClick={() => {
                prevHeight.current = ref.current?.scrollHeight ?? null;
                void loadMessages(chat.id, true);
              }}
            >
              {st.loading ? '加载中…' : '加载更早的消息'}
            </button>
          </div>
        )}
        {!st?.loaded && (
          <div className="empty">
            <div className="spinner" />
          </div>
        )}
        {list.map((m, i) => {
          const prev = list[i - 1];
          const next = list[i + 1];
          const day = !prev || !isSameDay(prev.ts, m.ts);
          const sameBotRun = prev && prev.role === 'bot' && m.role === 'bot' && prev.botId === m.botId && m.ts - prev.ts < 5 * 60_000 && !day;
          return (
            <div key={m.id}>
              {day && <div className="day-sep">{fmtDay(m.ts)}</div>}
              {m.role === 'system' ? (
                <SystemMessage msg={m} />
              ) : m.role === 'user' ? (
                <UserMessage msg={m} chat={chat} names={names} showTime={next?.role !== 'user' || next.ts - m.ts > 5 * 60_000} />
              ) : (
                <BotMessage msg={m} chat={chat} bot={bots[m.botId || '']} showHead={!sameBotRun} names={names} root={root} />
              )}
            </div>
          );
        })}
        {st?.loaded && !list.some((m) => m.role !== 'system') && <EmptyChat chat={chat} />}
        {queued.length > 0 && (
          <div className="queued-line">
            {queued.map((b) => (
              <span key={b.id}>
                <Avatar bot={b} size={18} /> {b.name}
              </span>
            ))}
            <span>排队中，马上轮到…</span>
          </div>
        )}
      </div>
      {showDown && (
        <button
          className="scroll-down"
          onClick={() => {
            stick.current = true;
            ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
          }}
        >
          <ArrowDown size={16} />
        </button>
      )}
    </div>
  );
}

function Resizer() {
  const onDown = (e: React.PointerEvent) => {
    const layout = (e.currentTarget as HTMLElement).parentElement!;
    const rect = layout.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = ((rect.right - ev.clientX) / rect.width) * 100;
      setComputer({ width: Math.max(25, Math.min(75, pct)) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="resizer" onPointerDown={onDown} />;
}

export function ChatView() {
  const chatId = useStore((s) => s.activeChatId);
  const chat = useStore((s) => (s.activeChatId ? s.chats[s.activeChatId] : undefined));
  const computer = useStore((s) => s.computer);
  const mobilePane = useStore((s) => s.mobilePane);

  useEffect(() => {
    if (chatId) void loadMessages(chatId);
  }, [chatId]);

  if (!chat) {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <div className="big">
          <Glyph emoji="💬" size={26} />
        </div>
        <h3>选择一个对话</h3>
        <p>从左侧选择机器人或群聊开始工作。</p>
        <button className="btn primary" onClick={() => openModal({ kind: 'newGroup' })}>
          新建群聊
        </button>
      </div>
    );
  }

  return (
    <div className={cx('chat-layout', computer.open && 'with-computer', computer.maximized && 'computer-max', `m-${mobilePane}`)} style={{ ['--computer-w' as string]: `${computer.width}%` }}>
      <section className="chat-col">
        <ChatHeader chat={chat} />
        <AuthBanner />
        <MessageList chat={chat} />
        <Composer chat={chat} />
      </section>
      {computer.open && <Resizer />}
      <ComputerPane chat={chat} visible={computer.open} />
    </div>
  );
}
