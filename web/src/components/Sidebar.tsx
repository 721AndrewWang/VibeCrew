import { useMemo, useState } from 'react';
import { Bot as BotIcon, Clock, FolderGit2, GitBranch, Hourglass, MessageCircle, Pin, Search, Settings, SquarePen, Users, Zap, FolderPlus, UserPlus, Trash2, PinOff, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { Chat } from '../../../shared/types';
import { api } from '../api';
import { openChat, openModal, setView, toast, useStore, type View } from '../store';
import { cx, fmtShort, statusLabel } from '../utils';
import { Avatar, confirmDialog, GroupAvatar, Logo, Menu, MenuButton, useNow, type MenuItem } from './ui';

const NAV: { view: View; label: string; icon: typeof MessageCircle }[] = [
  { view: 'chat', label: '对话', icon: MessageCircle },
  { view: 'bots', label: '机器人', icon: BotIcon },
  { view: 'skills', label: '技能', icon: Zap },
  { view: 'routines', label: '定时', icon: Clock },
  { view: 'projects', label: '项目', icon: FolderGit2 },
  { view: 'settings', label: '设置', icon: Settings },
];

export function chatMenuItems(chat: Chat): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: chat.pinned ? '取消置顶' : '置顶',
      icon: chat.pinned ? <PinOff size={15} /> : <Pin size={15} />,
      onClick: () => void api.updateChat(chat.id, { pinned: !chat.pinned }),
    },
    { label: '对话设置', icon: <SlidersHorizontal size={15} />, onClick: () => openModal({ kind: 'chatSettings', chatId: chat.id }) },
    {
      label: '开始新话题',
      icon: <RotateCcw size={15} />,
      onClick: async () => {
        if (await confirmDialog({ title: '开始新话题？', body: '机器人会忘记这个对话之前的上下文（聊天记录仍然保留），适合切换到不相关的任务，也能节省用量。', ok: '开始新话题' }))
          void api.reset(chat.id);
      },
    },
  ];
  if (chat.kind === 'group') {
    items.push({ separator: true });
    items.push({
      label: '删除群聊',
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: async () => {
        if (await confirmDialog({ title: `删除群聊「${chat.title}」？`, body: '聊天记录和改动记录会被删除，项目文件不受影响。', ok: '删除', danger: true })) {
          await api.deleteChat(chat.id).catch((e) => toast('删除失败', e.message, 'error'));
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
  const working = members
    .map((b) => ({ b, s: statuses[b.id] }))
    .filter((x) => x.s && x.s.state !== 'idle' && x.s.state !== 'error' && x.s.chatId === chat.id);
  const waiting = working.find((x) => x.s.state === 'waiting');
  const shown = waiting || working[0];
  const dm = chat.kind === 'dm' ? members[0] : null;
  return (
    <div
      className={cx('chat-item', active && 'active')}
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
          {chat.workspaceId && <GitBranch size={11} className="ci-pin" aria-label="独立工作区" />}
          {chat.pinned && <Pin size={11} className="ci-pin" />}
          <span className="ci-time">{chat.lastMessage ? fmtShort(chat.lastMessage.ts) : ''}</span>
        </div>
        <div className="ci-bottom">
          {shown ? (
            <span className={cx('ci-status', shown.s.state === 'waiting' ? 'wait' : 'busy')}>
              {shown.s.state === 'waiting' ? <Hourglass size={11} className="wait-ic" /> : <span className="typing-mini"><i /><i /><i /></span>}
              {chat.kind === 'group' ? `${shown.b.name} ` : ''}
              {statusLabel(shown.s).text}
            </span>
          ) : (
            <span className="ci-preview">
              {chat.lastMessage ? (
                <>
                  {chat.kind === 'group' || chat.lastMessage.author === '你' ? <b>{chat.lastMessage.author}：</b> : null}
                  {chat.lastMessage.text}
                </>
              ) : dm ? (
                dm.title
              ) : (
                `${members.length} 位成员`
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
          <span>VibeCrew</span>
        </div>
        <MenuButton
          title="新建"
          align="right"
          items={[
            { label: '新建群聊', icon: <Users size={15} />, onClick: () => openModal({ kind: 'newGroup' }) },
            { label: '新建机器人', icon: <UserPlus size={15} />, onClick: () => openModal({ kind: 'newBot' }) },
            { label: '新建 / 打开项目', icon: <FolderPlus size={15} />, onClick: () => openModal({ kind: 'newProject' }) },
          ]}
        >
          <SquarePen size={18} />
        </MenuButton>
      </div>
      <div className="sb-search">
        <Search size={14} />
        <input placeholder="搜索对话" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="sb-list">
        {list.map((c) => (
          <ChatItem key={c.id} chat={c} active={view === 'chat' && c.id === activeChatId} />
        ))}
        {!list.length && <div className="empty">没有匹配的对话</div>}
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
