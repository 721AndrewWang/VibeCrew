import { ChevronLeft, FileCode2, FolderPlus, GitBranch, GitCompareArrows, Globe, Maximize2, Minimize2, Play, RotateCw, Square, SquareTerminal, X } from 'lucide-react';
import type { Chat } from '../../../../shared/types';
import { api } from '../../api';
import { type ComputerTab, chatProjectId, openModal, setComputer, toast, useStore } from '../../store';
import { cx } from '../../utils';
import { Glyph } from '../ui';
import { BrowserTab } from './BrowserTab';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { TerminalTab } from './TerminalTab';

const TABS: { id: ComputerTab; label: string; icon: typeof Globe }[] = [
  { id: 'browser', label: '浏览器', icon: Globe },
  { id: 'files', label: '文件', icon: FileCode2 },
  { id: 'terminal', label: '终端', icon: SquareTerminal },
  { id: 'changes', label: '改动', icon: GitCompareArrows },
];

function DevControls({ projectId }: { projectId: string }) {
  const ds = useStore((s) => s.devServers[projectId]);
  const project = useStore((s) => s.projects[projectId]);
  if (!project?.devDetected)
    return (
      <span className="dev-pill static" title="静态网页由 Crew 直接提供，保存即刷新">
        静态站点
      </span>
    );
  const status = ds?.status || 'stopped';
  const run = (action: 'start' | 'stop' | 'restart') => api.dev(projectId, action).catch((e) => toast('操作失败', e.message, 'error'));
  const label = { stopped: '未启动', installing: '安装依赖中', starting: '启动中', running: '运行中', error: '出错了' }[status];
  return (
    <div className="dev-controls">
      <span className={cx('dev-pill', status)} title={ds?.error || ds?.url || project.devDetected}>
        <span className={cx('dot', status === 'running' ? 'green' : status === 'error' ? 'red' : status === 'stopped' ? '' : 'orange pulse')} />
        {label}
      </span>
      {status === 'stopped' || status === 'error' ? (
        <button className="icon-btn sm" title={`启动：${project.devDetected}`} onClick={() => run('start')}>
          <Play size={14} />
        </button>
      ) : (
        <>
          <button className="icon-btn sm" title="重启" onClick={() => run('restart')}>
            <RotateCw size={13} />
          </button>
          <button className="icon-btn sm" title="停止" onClick={() => run('stop')}>
            <Square size={12} />
          </button>
        </>
      )}
    </div>
  );
}

export function ComputerPane({ chat, visible }: { chat: Chat; visible: boolean }) {
  const tab = useStore((s) => s.computer.tab);
  const maximized = useStore((s) => s.computer.maximized);
  // The chat's isolated workspace when it has one: preview, files and terminal all follow it.
  const projectId = useStore((s) => chatProjectId(chat, s.projects));
  const project = useStore((s) => (projectId ? s.projects[projectId] : null));
  const errors = useStore((s) => (projectId ? (s.preview[projectId]?.console || []).filter((c) => c.level === 'error').length : 0));

  return (
    <section className={cx('computer', !visible && 'hidden')}>
      <div className="comp-head">
        <button className="icon-btn only-mobile" onClick={() => useStore.setState({ mobilePane: 'chat' })} aria-label="返回聊天">
          <ChevronLeft size={20} />
        </button>
        <div className="comp-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className={cx('comp-tab', tab === t.id && 'on')} onClick={() => setComputer({ tab: t.id })}>
              <t.icon size={15} />
              <span>{t.label}</span>
              {t.id === 'browser' && errors > 0 && <span className="tab-badge">{errors}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {project?.workspace && (
          <button className="branch-pill" title={`独立工作区：${project.path}`} onClick={() => setComputer({ tab: 'changes' })}>
            <GitBranch size={12} />
            <span>{project.workspace.branch}</span>
          </button>
        )}
        {project && <DevControls projectId={project.id} />}
        <button className="icon-btn hide-mobile" title={maximized ? '还原' : '放大'} onClick={() => setComputer({ maximized: !maximized })}>
          {maximized ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button className="icon-btn hide-mobile" title="收起" onClick={() => setComputer({ open: false, maximized: false })}>
          <X size={16} />
        </button>
      </div>
      {!project ? (
        <div className="empty" style={{ flex: 1 }}>
          <div className="big">
            <Glyph emoji="🗂️" size={26} />
          </div>
          <h3>这个对话还没有绑定项目</h3>
          <p>绑定一个项目文件夹后，机器人就能在里面写代码，这里会显示实时预览、文件和终端。</p>
          <div className="row">
            <button className="btn primary" onClick={() => openModal({ kind: 'newProject' })}>
              <FolderPlus size={15} /> 新建或打开项目
            </button>
          </div>
        </div>
      ) : (
        <div className="comp-body">
          {/* Tabs stay mounted so the preview, editor and terminals keep their state. */}
          <div className={cx('comp-panel', tab !== 'browser' && 'hidden')}>
            <BrowserTab key={project.id} chat={chat} project={project} active={visible && tab === 'browser'} />
          </div>
          <div className={cx('comp-panel', tab !== 'files' && 'hidden')}>
            <FilesTab key={project.id} chat={chat} project={project} active={visible && tab === 'files'} />
          </div>
          <div className={cx('comp-panel', tab !== 'terminal' && 'hidden')}>
            <TerminalTab key={project.id} project={project} active={visible && tab === 'terminal'} />
          </div>
          <div className={cx('comp-panel', tab !== 'changes' && 'hidden')}>
            <ChangesTab key={project.id} chat={chat} project={project} active={visible && tab === 'changes'} />
          </div>
        </div>
      )}
    </section>
  );
}
