import { useEffect } from 'react';
import { ChatView } from './components/ChatView';
import { SaveRecordingDialog } from './components/computer/SaveRecordingDialog';
import { Sidebar } from './components/Sidebar';
import { Logo, Toasts } from './components/ui';
import { BotEditorDialog } from './components/views/BotEditor';
import { BotsView } from './components/views/BotsView';
import { NewBotDialog } from './components/views/bot-editor/NewBotDialog';
import { ChatSettingsDialog, NewGroupDialog } from './components/views/GroupDialogs';
import { NewProjectDialog, ProjectsView } from './components/views/ProjectsView';
import { RoutinesView } from './components/views/RoutinesView';
import { SettingsView } from './components/views/SettingsView';
import { SkillsView } from './components/views/SkillsView';
import { closeModal, useStore } from './store';
import { cx } from './utils';

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
    document.title = unread ? `(${unread}) Crew` : 'Crew';
  }, [unread]);

  // The browser tab's icon (served by the server) and the boot screen follow the chosen logo.
  const logo = useStore((s) => s.settings.logo);
  useEffect(() => {
    try {
      localStorage.setItem('vc-logo', logo);
    } catch {
      /* storage blocked */
    }
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = `/icon.svg?logo=${logo}`;
  }, [logo]);

  if (!booted) {
    return (
      <div className="boot">
        <Logo size={56} />
        {bootError ? (
          <>
            <div>无法连接到 Crew 服务：{bootError}</div>
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
      {!connected && <div className="offline-bar">与 Crew 的连接已断开，正在重连…</div>}
    </div>
  );
}
