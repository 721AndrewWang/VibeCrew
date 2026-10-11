import {
  Bot as BotIcon,
  Clock,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Hourglass,
  MessageCircle,
  Pin,
  PinOff,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Trash2,
  UserPlus,
  Users,
  Zap,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Chat } from '../../../shared/types';
import { api } from '../api';
import { openChat, openModal, setView, toast, useStore, type View } from '../store';
import { cx, fmtShort, statusLabel } from '../utils';
import { Avatar, confirmDialog, GroupAvatar, Logo, Menu, MenuButton, type MenuItem, useNow } from './ui';

const NAV: { view: View; label: string; icon: typeof MessageCircle }[] = [
  { view: 'chat', label: 'Chats', icon: MessageCircle },
  { view: 'bots', label: 'Bots', icon: BotIcon },
  { view: 'skills', label: 'Skills', icon: Zap },
  { view: 'routines', label: 'Routines', icon: Clock },
  { view: 'projects', label: 'Projects', icon: FolderGit2 },
  { view: 'settings', label: 'Settings', icon: Settings },
];

export function chatMenuItems(chat: Chat): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: chat.pinned ? 'Unpin' : 'Pin',
      icon: chat.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onClick: () => void api.updateChat(chat.id, { pinned: !chat.pinned }),
    },
    { label: 'Chat settings', icon: <SlidersHorizontal size={15} />, onClick: () => openModal({ kind: 'chatSettings', chatId: chat.id }) },
    {
      label: 'Start new topic',
      icon: <RotateCcw size={15} />,
      onClick: async () => {
        if (
          await confirmDialog({
            title: 'Start new topic?',
            body: "Bots will forget this chat's earlier context (the chat history is kept). Good when switching to an unrelated task, and it saves usage.",
            ok: 'Start new topic',
          })
        )
          void api.reset(chat.id);
      },
    },
  ];
  if (chat.kind === 'group') {
    items.push({ separator: true });
    items.push({
      label: 'Delete group chat',
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: async () => {
        if (
          await confirmDialog({ title: `Delete group chat "${chat.title}"?`, body: 'The chat history and change records will be deleted. Project files are not affected.', ok: 'Delete', danger: true })
        ) {
          await api.deleteChat(chat.id).catch((e) => toast('Delete failed', e.message, 'error'));
        }
      },
    });
  }
  return items;
}

function ChatItem({ chat, active }: { chat: Chat; active: boolean }) {
  const bots = useStore((s) => s.bots);
  const statuses = useStore((s) => s.statuses);
  const [menu, setMenu] = useState<DOMRect | null>(null);
  useNow(60_000);
  const members = chat.botIds.map((id) => bots[id]).filter(Boolean);
  const working = members.map((b) => ({ b, s: statuses[b.id] })).filter((x) => x.s && x.s.state !== 'idle' && x.s.state !== 'error' && x.s.chatId === chat.id);
  const waiting = working.find((x) => x.s.state === 'waiting');
  const shown = waiting || working[0];
  const dm = chat.kind === 'dm' ? members[0] : null;
  return (
    <div
      className={cx('chat-item', active && 'active')}
      data-chat={chat.id}
      onClick={() => openChat(chat.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(new DOMRect(e.clientX, e.clientY, 0, 0));
      }}
    >
      {dm ? <Avatar bot={dm} size={42} status={statuses[dm.id]} /> : <GroupAvatar bots={members} size={42} />}
      <div className="ci-main">
        <div className="ci-top">
          <span className="ci-title">{chat.title}</span>
          {chat.workspaceId && <GitBranch size={11} className="ci-pin" aria-label="Isolated workspace" />}
          {chat.pinned && <Pin size={11} className="ci-pin" />}
          <span className="ci-time">{chat.lastMessage ? fmtShort(chat.lastMessage.ts) : ''}</span>
        </div>
        <div className="ci-bottom">
          {shown ? (
            <span className={cx('ci-status', shown.s.state === 'waiting' ? 'wait' : 'busy')}>
              {shown.s.state === 'waiting' ? (
                <Hourglass size={11} className="wait-ic" />
              ) : (
                <span className="typing-mini">
                  <i />
                  <i />
                  <i />
                </span>
              )}
              {chat.kind === 'group' ? `${shown.b.name} ` : ''}
              {statusLabel(shown.s).text}
            </span>
          ) : (
            <span className="ci-preview">
              {chat.lastMessage ? (
                <>
                  {chat.kind === 'group' || chat.lastMessage.author === 'You' ? <b>{chat.lastMessage.author}: </b> : null}
                  {chat.lastMessage.text}
                </>
              ) : dm ? (
                dm.title
              ) : (
                `${members.length} member${members.length === 1 ? '' : 's'}`
              )}
            </span>
          )}
          {chat.unread > 0 && !active && <span className="ci-unread">{chat.unread > 99 ? '99+' : chat.unread}</span>}
        </div>
      </div>
      {menu && <Menu anchor={menu} items={chatMenuItems(chat)} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function Sidebar() {
  const chats = useStore((s) => s.chats);
  const bots = useStore((s) => s.bots);
  const activeChatId = useStore((s) => s.activeChatId);
  const view = useStore((s) => s.view);
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(chats)
      .filter((c) => {
        if (!q) return true;
        const names = c.botIds.map((id) => bots[id]?.name || '').join(' ');
        return `${c.title} ${names} ${c.lastMessage?.text || ''}`.toLowerCase().includes(q);
      })
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
  }, [chats, bots, query]);

  const unreadTotal = Object.values(chats).reduce((n, c) => n + (c.id === activeChatId ? 0 : c.unread || 0), 0);

  return (
    <aside className="sidebar">
      <div className="sb-head">
        <div className="brand">
          <Logo />
          <span>Crew</span>
        </div>
        <MenuButton
          title="New"
          align="right"
          items={[
            { label: 'New group chat', icon: <Users size={15} />, onClick: () => openModal({ kind: 'newGroup' }) },
            { label: 'New bot', icon: <UserPlus size={15} />, onClick: () => openModal({ kind: 'newBot' }) },
            { label: 'New / open project', icon: <FolderPlus size={15} />, onClick: () => openModal({ kind: 'newProject' }) },
          ]}
        >
          <SquarePen size={18} />
        </MenuButton>
      </div>
      <div className="sb-search">
        <Search size={14} />
        <input placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sb-list">
        {list.map((c) => (
          <ChatItem key={c.id} chat={c} active={view === 'chat' && c.id === activeChatId} />
        ))}
        {!list.length && <div className="empty">No matching chats</div>}
      </div>
      <nav className="sb-nav">
        {NAV.map((n) => (
          <button key={n.view} className={cx('sb-nav-item', view === n.view && 'on')} onClick={() => setView(n.view)} title={n.label}>
            <n.icon size={18} />
            <span>{n.label}</span>
            {n.view === 'chat' && unreadTotal > 0 && view !== 'chat' && <i className="nav-dot" />}
          </button>
        ))}
      </nav>
    </aside>
  );
}
