import { useEffect } from 'react';
import { closeModal, useStore } from './store';
import { cx } from './utils';
import { Sidebar } from './components/Sidebar';
import { Toasts } from './components/ui';
import { ChatView } from './components/ChatView';
import { BotsView } from './components/views/BotsView';
import { BotEditorDialog, NewBotDialog } from './components/views/BotEditor';
import { SkillsView } from './components/views/SkillsView';
import { RoutinesView } from './components/views/RoutinesView';
import { NewProjectDialog, ProjectsView } from './components/views/ProjectsView';
import { SettingsView } from './components/views/SettingsView';
import { ChatSettingsDialog, NewGroupDialog } from './components/views/GroupDialogs';
import { SaveRecordingDialog } from './components/computer/SaveRecordingDialog';

function Modals() {
  const modal = useStore((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'newGroup':
      return <NewGroupDialog onClose={closeModal} />;
    case 'newBot':
      return <NewBotDialog onClose={closeModal} />;
    case 'botEditor':
      return <BotEditorDialog botId={modal.botId} onClose={closeModal} />;
    case 'newProject':
      return <NewProjectDialog onClose={closeModal} />;
    case 'chatSettings':
      return <ChatSettingsDialog chatId={modal.chatId} onClose={closeModal} />;
    case 'saveRecording':
      return <SaveRecordingDialog projectId={modal.projectId} onClose={closeModal} />;
    default:
      return null;
  }
}

export function App() {
  const booted = useStore((s) => s.booted);
  const bootError = useStore((s) => s.bootError);
  const connected = useStore((s) => s.connected);
  const view = useStore((s) => s.view);
  const mobilePane = useStore((s) => s.mobilePane);
  const unread = useStore((s) => Object.values(s.chats).reduce((n, c) => n + (c.unread || 0), 0));

  useEffect(() => {
    document.title = unread ? `(${unread}) VibeCrew` : 'VibeCrew';
  }, [unread]);

  if (!booted) {
    return (
      <div className="boot">
        <img src="/icon.svg" alt="" />
        {bootError ? (
          <>
            <div>无法连接到 VibeCrew 服务：{bootError}</div>
            <button className="btn" onClick={() => location.reload()}>
              重试
            </button>
          </>
        ) : (
          <div className="spinner" />
        )}
      </div>
    );
  }

  return (
    <div className={cx('app', `pane-${mobilePane}`, view !== 'chat' && 'view-other')}>
      <Sidebar />
      <main className="main">
        {view === 'chat' && <ChatView />}
        {view === 'bots' && <BotsView />}
        {view === 'skills' && <SkillsView />}
        {view === 'routines' && <RoutinesView />}
        {view === 'projects' && <ProjectsView />}
        {view === 'settings' && <SettingsView />}
      </main>
      <Modals />
      <Toasts />
      {!connected && <div className="offline-bar">与 VibeCrew 的连接已断开，正在重连…</div>}
    </div>
  );
}
