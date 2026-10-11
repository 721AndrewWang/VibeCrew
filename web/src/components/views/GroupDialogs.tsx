import { Check, FolderPlus, GitBranch, GitMerge, LogOut, Save, SlidersHorizontal, Trash2, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Bot, Chat } from '../../../../shared/types';
import { api } from '../../api';
import { listProjects, openChat, openModal, toast, useStore } from '../../store';
import { cx } from '../../utils';
import { closeWorkspace, enableWorkspace, showWorkspaceChanges } from '../../workspace';
import { Avatar, confirmDialog, GroupAvatar, Modal, Toggle } from '../ui';
import { ProjectSelect } from './ProjectsView';

function useBotList() {
  const bots = useStore((s) => s.bots);
  return useMemo(() => Object.values(bots).sort((a, b) => a.createdAt - b.createdAt), [bots]);
}

/** Multi-select grid of bot cards. */
function BotPicker({ bots, selected, onChange }: { bots: Bot[]; selected: string[]; onChange: (ids: string[]) => void }) {
  if (!bots.length) return <div className="empty">No bots yet. Add a few on the Bots page first.</div>;
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
      {!bots.length && <option value="">Pick members first</option>}
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
      else toast('Group chat created', chat.title, 'success');
      onClose();
    } catch (e) {
      toast("Couldn't create group chat", (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New group chat"
      icon={members.length > 1 ? <GroupAvatar bots={members} size={32} /> : <Users size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="muted foot-left">{selected.length ? `${selected.length} member${selected.length === 1 ? '' : 's'} selected` : 'Select at least 1 member'}</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !selected.length} onClick={create}>
            {busy ? <span className="spinner" /> : <Users size={15} />} Create group chat
          </button>
        </>
      }
    >
      <div className="field">
        <label>Group chat name</label>
        <input className="input" autoFocus value={title} placeholder="e.g. Landing page squad (leave blank to use member names)" onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Members</label>
        <BotPicker bots={botList} selected={selected} onChange={setSelected} />
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Default lead</label>
          <LeadSelect bots={members} value={leadId} onChange={setLead} />
          <div className="hint">Replies and delegates when nobody is @-mentioned</div>
        </div>
        <div className="field">
          <label>Project</label>
          <ProjectSelect value={projectId} onChange={setProjectId} />
          <div className="hint">All bots in the group work in this project folder</div>
        </div>
      </div>
      {projectId && (
        <div className="setting-row">
          <div>
            <div className="sr-title">
              <GitBranch size={14} /> Work on a separate branch
            </div>
            <div className="hint">
              Creates a Git branch and a separate working directory, leaving the main project folder and other chats untouched. Good for running several tasks at once; when done, merge back from
              Changes. The project must be a Git repository.
            </div>
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
          <GitBranch size={14} /> Isolated workspace
        </div>
        <div className="hint">
          {ws
            ? `Bots work in a separate directory on branch ${ws.branch} (from ${ws.baseBranch}), leaving the main project folder and other chats untouched.`
            : 'Give this chat its own Git branch and working directory so tasks can run in parallel, then merge back into the main branch.'}
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
            <GitMerge size={13} /> Changes / merge
          </button>
          <button className="btn sm" disabled={busy} onClick={() => run(() => closeWorkspace(chat))}>
            <LogOut size={13} /> Close
          </button>
        </div>
      ) : (
        <button className="btn sm" disabled={busy} onClick={() => run(() => enableWorkspace(chat))}>
          {busy ? <span className="spinner tiny" /> : <GitBranch size={13} />} Enable
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
      if (!members.length) return toast('A group chat needs at least one bot', undefined, 'error');
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
        title: 'Switch project?',
        body: "This chat's isolated workspace belongs to the current project and will be closed. Unmerged changes stay on its branch.",
        ok: 'Switch',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.updateChat(chat.id, patch);
      toast('Settings saved', undefined, 'success');
      onClose();
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Delete group chat "${chat.title}"?`,
      body: 'Chat history and change history will be deleted. Project files are not affected.',
      ok: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteChat(chat.id);
      toast('Group chat deleted', chat.title, 'success');
      onClose();
    } catch (e) {
      toast('Delete failed', (e as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={isGroup ? 'Group chat settings' : `Chat settings: ${chat.title}`}
      icon={isGroup ? <GroupAvatar bots={memberBots} size={32} /> : dmBot ? <Avatar bot={dmBot} size={32} /> : <SlidersHorizontal size={20} className="modal-icon" />}
      onClose={onClose}
      wide={isGroup}
      footer={
        <>
          {isGroup && (
            <button className="btn danger foot-left" onClick={remove}>
              <Trash2 size={15} /> Delete group chat
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (isGroup && !members.length)} onClick={save}>
            {busy ? <span className="spinner" /> : <Save size={15} />} Save
          </button>
        </>
      }
    >
      {isGroup ? (
        <>
          <div className="field">
            <label>Group chat name</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>Members</label>
            <BotPicker bots={botList} selected={members} onChange={setMembers} />
            {!members.length && <div className="hint error-text">A group chat needs at least one bot</div>}
          </div>
          <div className="form-grid">
            <div className="field">
              <label>Default lead</label>
              <LeadSelect bots={memberBots} value={leadId} onChange={setLead} />
              <div className="hint">Replies and delegates when nobody is @-mentioned</div>
            </div>
            <div className="field">
              <label>Auto-relay limit</label>
              <input className="input num-input" type="number" min={0} max={30} value={maxHops} onChange={(e) => setMaxHops(Number(e.target.value))} />
              <div className="hint">Max times bots can @-mention each other after one message from you, to prevent endless loops</div>
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
              <SlidersHorizontal size={13} /> Bot settings
            </button>
          </div>
        )
      )}

      <div className="field">
        <label>Project</label>
        <div className="row">
          <div className="grow">
            <ProjectSelect value={projectId} onChange={setProjectId} />
          </div>
          <button className="btn" onClick={() => openModal({ kind: 'newProject' })} title="New or open project (closes this window)">
            <FolderPlus size={14} /> New/open project
          </button>
        </div>
        <div className="hint">
          {projectId !== chat.projectId
            ? `After switching, bots start a fresh session context in the new project (chat history is kept).${chat.workspaceId ? " This chat's isolated workspace will close; unmerged changes stay on its branch." : ''}`
            : 'Bots work in this project folder; the right panel previews it.'}
          {!isGroup && " A direct chat's project is also this bot's default project."}
        </div>
      </div>

      {chat.projectId && projectId === chat.projectId && <WorkspaceRow chat={chat} onDone={onClose} />}

      <div className="setting-row">
        <div>
          <div className="sr-title">Pin</div>
          <div className="hint">Always show at the top of the chat list</div>
        </div>
        <Toggle on={pinned} onChange={setPinned} />
      </div>
    </Modal>
  );
}
