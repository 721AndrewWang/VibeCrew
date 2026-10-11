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
      title: 'Switch project?',
      body: "This chat's isolated workspace belongs to the current project and will be closed when you switch. Unmerged changes stay on its branch.",
      ok: 'Switch',
    });
    if (!ok) return;
  }
  await api.updateChat(chat.id, { projectId }).catch((e) => toast('Switch failed', e.message, 'error'));
}

function ProjectPicker({ chat }: { chat: Chat }) {
  const projects = useStore((s) => s.projects);
  const project = chat.projectId ? projects[chat.projectId] : null;
  const ws = chat.workspaceId ? projects[chat.workspaceId]?.workspace : undefined;
  const items = (): MenuItem[] => [
    { heading: 'Switch project' },
    ...listProjects(projects).map((p) => ({
      label: p.name,
      hint: p.id === chat.projectId ? 'Current' : p.framework,
      icon: <FolderGit2 size={15} />,
      onClick: () => {
        if (p.id !== chat.projectId) void switchProject(chat, p.id);
      },
    })),
    ...(project
      ? ws
        ? [
            { separator: true },
            { heading: `Isolated workspace · ${ws.branch}` },
            { label: 'View changes / merge', icon: <GitMerge size={15} />, onClick: showWorkspaceChanges },
            { label: 'Close isolated workspace…', icon: <LogOut size={15} />, onClick: () => void closeWorkspace(chat) },
          ]
        : [{ separator: true }, { label: 'Work on a separate branch…', hint: 'Creates a Git branch', icon: <GitBranch size={15} />, onClick: () => void enableWorkspace(chat) }]
      : []),
    { separator: true },
    { label: 'New / open project…', icon: <FolderPlus size={15} />, onClick: () => openModal({ kind: 'newProject' }) },
    ...(project ? [{ label: 'Unlink', icon: <Unlink size={15} />, onClick: () => void switchProject(chat, null) }] : []),
  ];
  const title = !project ? 'Link a project' : ws ? `${project.path}\nIsolated workspace: branch ${ws.branch} (from ${ws.baseBranch})` : project.path;
  return (
    <MenuButton className={cx('project-pill', !project && 'none', ws && 'isolated')} items={items} align="right" title={title}>
      {ws ? <GitBranch size={14} /> : <FolderGit2 size={14} />}
      <span>{project ? project.name : 'No project'}</span>
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
      <button className="icon-btn mobile-back" onClick={() => useStore.setState({ mobilePane: 'list' })} aria-label="Back">
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
                {busy.map((b) => b.name).join(', ')} {busy.some((b) => statuses[b.id]?.state === 'waiting') ? 'waiting for you' : 'working…'}
              </span>
            ) : (
              <>
                <Users size={11} /> {members.map((b) => b.name).join(', ')}
              </>
            )}
          </div>
        </div>
      </button>
      <span className="spacer" />
      <ProjectPicker chat={chat} />
      <button
        className="icon-btn"
        title="Start new topic (bots forget earlier context)"
        onClick={async () => {
          if (
            await confirmDialog({
              title: 'Start new topic?',
              body: "Bots will forget this chat's earlier context (the chat history is kept). Do this when switching to an unrelated task: replies get faster and use less.",
              ok: 'Start new topic',
            })
          )
            void api.reset(chat.id);
        }}
      >
        <RotateCcw size={17} />
      </button>
      <button className="icon-btn only-mobile" title="Computer" onClick={() => useStore.setState({ mobilePane: 'computer' })}>
        <Monitor size={18} />
      </button>
      <button className="icon-btn hide-mobile" title={computerOpen ? 'Hide computer panel' : 'Show computer panel'} onClick={() => setComputer({ open: !computerOpen })}>
        {computerOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
      </button>
      <MenuButton
        align="right"
        items={() => [...(dm ? [{ label: `${dm.name} settings`, icon: <Settings2 size={15} />, onClick: () => openModal({ kind: 'botEditor', botId: dm.id }) }] : []), ...chatMenuItems(chat)]}
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
      <b>Bots can't work yet:</b>
      {!auth.cliFound ? (
        <>
          Claude Code not found. Install it in a terminal first: <code>npm i -g @anthropic-ai/claude-code</code>
        </>
      ) : settings.authMode === 'api-key' ? (
        <>API key is not set.</>
      ) : settings.authMode === 'provider' ? (
        <>The model provider isn't fully set up (missing URL, key, or model name).</>
      ) : (
        <>Claude Code on this machine isn't signed in. You can also switch to an API key or another model provider (DeepSeek, Kimi, Zhipu GLM…) in Settings.</>
      )}
      <span className="spacer" />
      {auth.cliFound && settings.authMode === 'claude-code' && (
        <button className="btn sm" onClick={() => requestTerminal('claude auth login')}>
          Sign in via terminal
        </button>
      )}
      <button className="btn sm" onClick={() => setView('settings')}>
        Settings
      </button>
      <button
        className="btn sm ghost"
        onClick={async () => {
          const a = await api.auth(true);
          useStore.setState({ auth: a });
          toast(a.ready ? 'Model connected' : 'Not connected yet', a.ready ? 'Bots can start working now' : 'Finish signing in or setup, then click "Check again"', a.ready ? 'success' : 'warn');
        }}
      >
        Check again
      </button>
    </div>
  );
}

const SUGGESTIONS: Record<string, string[]> = {
  group: ['Build a landing page for a coffee shop with a menu, locations, and reservations', 'Review the current page and list the top 3 things to improve', '/responsive', '/polish'],
  chief: ['Plan a personal portfolio site and assign the work to the team', 'How is the project going? What should we do next?'],
  pixel: ['Give the home page a modern dark look', '/landing a Pomodoro timer app', '/component a searchable dropdown select', '/responsive'],
  forge: ['Add a backend endpoint for a contact form', 'Convert the project to Vite + React + TypeScript'],
  probe: ['Click through the main flows and look for bugs', '/fix-console', '/e2e what happens when the home page buttons are clicked'],
  lens: ['/review', 'Check recent changes for security issues'],
  muse: ['Design a more refined color palette and typography for this page', '/polish'],
  quill: ['/seo', 'Rewrite the home page copy to be tighter and punchier'],
  default: ['/explain', 'Build a simple to-do list page', '/fix-console'],
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
      <p>{dm ? dm.title : `${members.map((b) => b.name).join(', ')} · ${bots[chat.leadBotId || '']?.name || members[0]?.name} replies when no one is @mentioned`}</p>
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
              {st.loading ? 'Loading…' : 'Load earlier messages'}
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
            <span>Queued, up next…</span>
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
        <h3>Pick a chat</h3>
        <p>Choose a bot or group chat on the left to get started.</p>
        <button className="btn primary" onClick={() => openModal({ kind: 'newGroup' })}>
          New group chat
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
