import { useEffect, useMemo, useState } from 'react';
import { Check, FolderPlus, GitBranch, GitMerge, LogOut, Save, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import type { Bot, Chat } from '../../../../shared/types';
import { api } from '../../api';
import { listProjects, openChat, openModal, toast, useStore } from '../../store';
import { closeWorkspace, enableWorkspace, showWorkspaceChanges } from '../../workspace';
import { cx } from '../../utils';
import { Avatar, confirmDialog, GroupAvatar, Modal, Toggle } from '../ui';
import { ProjectSelect } from './ProjectsView';

function useBotList() {
  const bots = useStore((s) => s.bots);
  return useMemo(() => Object.values(bots).sort((a, b) => a.createdAt - b.createdAt), [bots]);
}

/** Multi-select grid of bot cards. */
function BotPicker({ bots, selected, onChange }: { bots: Bot[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (!bots.length) return <div className="empty">还没有机器人，先去「机器人」页面添加几位吧。</div>;
  return (
    <div className="pick-grid">
      {bots.map((b) => {
        const on = selected.includes(b.id);
        return (
          <button key={b.id} type="button" className={cx('pick-card', on && 'on')} onClick={() => onChange(on ? selected.filter((x) => x !== b.id) : [...selected, b.id])}>
            <Avatar bot={b} size={36} />
            <div className="pick-text">
              <div className="pick-name">{b.name}</div>
              <div className="pick-title">{b.title}</div>
            </div>
            <span className="pick-check">{on && <Check size={12} />}</span>
          </button>
        );
      })}
    </div>
  );
}

function LeadSelect({ bots, value, onChange }: { bots: Bot[]; value: string | null; onChange: (v: string) => void }) {
  return (
    <select className="select" value={value || ''} disabled={!bots.length} onChange={(e) => onChange(e.target.value)}>
      {!bots.length && <option value="">先选择成员</option>}
      {bots.map((b) => (
        <option key={b.id} value={b.id}>
          {b.emoji} {b.name} — {b.title}
        </option>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------- new group

export function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const botList = useBotList();
  const projects = useStore((s) => s.projects);
  const [title, setTitle] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(() => {
    const s = useStore.getState();
    const active = s.activeChatId ? s.chats[s.activeChatId] : undefined;
    if (active?.projectId && s.projects[active.projectId]) return active.projectId;
    return listProjects(s.projects)[0]?.id ?? null;
  });
  const [isolated, setIsolated] = useState(false);
  const [busy, setBusy] = useState(false);

  const members = useMemo(() => selected.map((id) => botList.find((b) => b.id === id)).filter((b): b is Bot => !!b), [selected, botList]);
  const leadId = lead && selected.includes(lead) ? lead : (selected[0] ?? null);

  const create = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const chat = await api.createGroup({ title: title.trim() || undefined, botIds: selected, leadBotId: leadId, projectId: projectId && projects[projectId] ? projectId : null });
      // Make it available immediately; the websocket event will follow.
      useStore.setState((s) => ({ chats: { ...s.chats, [chat.id]: chat } }));
      openChat(chat.id);
      if (isolated && chat.projectId) await enableWorkspace(chat, { confirm: false });
      else toast('群聊已创建', chat.title, 'success');
      onClose();
    } catch (e) {
      toast('创建群聊失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建群聊"
      icon={members.length > 1 ? <GroupAvatar bots={members} size={32} /> : <Users size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted foot-left">{selected.length ? `已选择 ${selected.length} 位成员` : '至少选择 1 位成员'}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !selected.length} onClick={create}>
            {busy ? <span className="spinner" /> : <Users size={15} />} 创建群聊
          </button>
        </>
      }
    >
      <div className="field">
        <label>群聊名称</label>
        <input className="input" autoFocus value={title} placeholder="例如 落地页小分队（留空则用成员名字）" onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>成员</label>
        <BotPicker bots={botList} selected={selected} onChange={setSelected} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>默认负责人</label>
          <LeadSelect bots={members} value={leadId} onChange={setLead} />
          <div className="hint">没有 @ 任何人时由他来回复和分派</div>
        </div>
        <div className="field">
          <label>项目</label>
          <ProjectSelect value={projectId} onChange={setProjectId} />
          <div className="hint">群里的机器人都在这个项目文件夹里工作</div>
        </div>
      </div>
      {projectId && (
        <div className="setting-row">
          <div>
            <div className="sr-title">
              <GitBranch size={14} /> 在独立分支中工作
            </div>
            <div className="hint">新建 Git 分支和单独的工作目录，不影响项目主目录和其他对话，适合同时推进几个任务；做完在「改动」里合并回主分支。项目需要是 Git 仓库。</div>
          </div>
          <Toggle on={isolated} onChange={setIsolated} />
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------- chat settings

/** Workspace status plus the actions that change it (applied right away, not on save). */
function WorkspaceRow({ chat, onDone }: { chat: Chat; onDone: () => void }) {
  const ws = useStore((s) => (chat.workspaceId ? s.projects[chat.workspaceId]?.workspace : undefined));
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await fn()) onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting-row">
      <div>
        <div className="sr-title">
          <GitBranch size={14} /> 独立工作区
        </div>
        <div className="hint">
          {ws
            ? `机器人在分支 ${ws.branch}（从 ${ws.baseBranch} 分出）的单独目录里工作，不影响项目主目录和其他对话。`
            : '给这个对话新建 Git 分支和单独的工作目录，多个任务可以并行，做完再合并回主分支。'}
        </div>
      </div>
      {ws ? (
        <div className="row">
          <button
            className="btn sm"
            onClick={() => {
              showWorkspaceChanges();
              onDone();
            }}
          >
            <GitMerge size={13} /> 改动 / 合并
          </button>
          <button className="btn sm" disabled={busy} onClick={() => run(() => closeWorkspace(chat))}>
            <LogOut size={13} /> 关闭
          </button>
        </div>
      ) : (
        <button className="btn sm" disabled={busy} onClick={() => run(() => enableWorkspace(chat))}>
          {busy ? <span className="spinner tiny" /> : <GitBranch size={13} />} 开启
        </button>
      )}
    </div>
  );
}

export function ChatSettingsDialog({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const chat = useStore((s) => s.chats[chatId]);
  const [init] = useState<Chat | undefined>(chat);

  useEffect(() => {
    if (!chat) onClose();
  }, [chat, onClose]);

  if (!chat || !init) return null;
  return <ChatSettingsForm chat={chat} init={init} onClose={onClose} />;
}

function ChatSettingsForm({ chat, init, onClose }: { chat: Chat; init: Chat; onClose: () => void }) {
  const botList = useBotList();
  const bots = useStore((s) => s.bots);
  const isGroup = chat.kind === 'group';
  const [title, setTitle] = useState(init.title);
  const [members, setMembers] = useState<string[]>(init.botIds);
  const [lead, setLead] = useState<string | null>(init.leadBotId);
  const [maxHops, setMaxHops] = useState(init.maxHops);
  const [projectId, setProjectId] = useState<string | null>(init.projectId);
  const [pinned, setPinned] = useState(!!init.pinned);
  const [busy, setBusy] = useState(false);

  const memberBots = useMemo(() => members.map((id) => bots[id]).filter((b): b is Bot => !!b), [members, bots]);
  const leadId = lead && members.includes(lead) ? lead : (members[0] ?? null);
  const dmBot = !isGroup ? bots[chat.botIds[0]] : undefined;

  const save = async () => {
    const patch: Partial<Chat> = {};
    if (isGroup) {
      if (!members.length) return toast('群聊里至少要有一个机器人', undefined, 'error');
      if (title.trim() && title.trim() !== chat.title) patch.title = title.trim();
      const sameMembers = members.length === chat.botIds.length && members.every((m) => chat.botIds.includes(m));
      if (!sameMembers) patch.botIds = members;
      if (leadId !== chat.leadBotId) patch.leadBotId = leadId;
      const hops = Math.max(0, Math.min(30, Math.round(maxHops) || 0));
      if (hops !== chat.maxHops) patch.maxHops = hops;
    }
    if (projectId !== chat.projectId) patch.projectId = projectId;
    if (pinned !== !!chat.pinned) patch.pinned = pinned;
    if (!Object.keys(patch).length) return onClose();
    if (patch.projectId !== undefined && chat.workspaceId) {
      const ok = await confirmDialog({
        title: '切换项目？',
        body: '这个对话的独立工作区属于当前项目，切换后会关闭它。还没合并的改动会保留在它的分支里。',
        ok: '切换',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.updateChat(chat.id, patch);
      toast('设置已保存', undefined, 'success');
      onClose();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({ title: `删除群聊「${chat.title}」？`, body: '聊天记录和改动记录会被删除，项目文件不受影响。', ok: '删除', danger: true });
    if (!ok) return;
    try {
      await api.deleteChat(chat.id);
      toast('已删除群聊', chat.title, 'success');
      onClose();
    } catch (e) {
      toast('删除失败', (e as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={isGroup ? '群聊设置' : `与 ${chat.title} 的对话设置`}
      icon={isGroup ? <GroupAvatar bots={memberBots} size={32} /> : dmBot ? <Avatar bot={dmBot} size={32} /> : <SlidersHorizontal size={20} className="modal-icon" />}
      onClose={onClose}
      wide={isGroup}
      footer={
        <>
          {isGroup && (
            <button className="btn danger foot-left" onClick={remove}>
              <Trash2 size={15} /> 删除群聊
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || (isGroup && !members.length)} onClick={save}>
            {busy ? <span className="spinner" /> : <Save size={15} />} 保存
          </button>
        </>
      }
    >
      {isGroup ? (
        <>
          <div className="field">
            <label>群聊名称</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>成员</label>
            <BotPicker bots={botList} selected={members} onChange={setMembers} />
            {!members.length && <div className="hint error-text">群聊里至少要有一个机器人</div>}
          </div>
          <div className="form-grid">
            <div className="field">
              <label>默认负责人</label>
              <LeadSelect bots={memberBots} value={leadId} onChange={setLead} />
              <div className="hint">没有 @ 任何人时由他来回复和分派</div>
            </div>
            <div className="field">
              <label>自动接力上限</label>
              <input className="input num-input" type="number" min={0} max={30} value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} />
              <div className="hint">你发一条消息后，机器人之间互相 @ 的最多次数，防止无限循环</div>
            </div>
          </div>
        </>
      ) : (
        dmBot && (
          <div className="dm-card">
            <Avatar bot={dmBot} size={44} />
            <div className="dm-text">
              <div className="dm-name">{dmBot.name}</div>
              <div className="muted">{dmBot.title}</div>
            </div>
            <span className="spacer" />
            <button className="btn sm" onClick={() => openModal({ kind: 'botEditor', botId: dmBot.id })}>
              <SlidersHorizontal size={13} /> 机器人设置
            </button>
          </div>
        )
      )}

      <div className="field">
        <label>项目</label>
        <div className="row">
          <div className="grow">
            <ProjectSelect value={projectId} onChange={setProjectId} />
          </div>
          <button className="btn" onClick={() => openModal({ kind: 'newProject' })} title="新建或打开项目（会关闭这个窗口）">
            <FolderPlus size={14} /> 新建/打开项目
          </button>
        </div>
        <div className="hint">
          {projectId !== chat.projectId
            ? `切换项目后，机器人会在新项目里开始新的会话上下文（聊天记录保留）。${chat.workspaceId ? '这个对话的独立工作区会关闭，没合并的改动保留在它的分支里。' : ''}`
            : '机器人在这个项目文件夹里工作，右侧面板预览它。'}
          {!isGroup && ' 单聊的项目也是这个机器人的默认项目。'}
        </div>
      </div>

      {chat.projectId && projectId === chat.projectId && <WorkspaceRow chat={chat} onDone={onClose} />}

      <div className="setting-row">
        <div>
          <div className="sr-title">置顶</div>
          <div className="hint">在对话列表中始终显示在最上面</div>
        </div>
        <Toggle on={pinned} onChange={setPinned} />
      </div>
    </Modal>
  );
}
