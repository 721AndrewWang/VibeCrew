import { Play, Plus, Rocket, RotateCw, Square, SquareTerminal, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project } from '../../../../shared/types';
import { api } from '../../api';
import { send } from '../../socket';
import { toast, useStore } from '../../store';
import { cx } from '../../utils';
import { LiveTerminal, LogTerminal } from './XTerm';

interface TermTab {
  id: string;
  title: string;
  command?: string;
}

const lsKey = (projectId: string) => `vc-terms-${projectId}`;

function loadTabs(projectId: string): TermTab[] {
  try {
    return JSON.parse(localStorage.getItem(lsKey(projectId)) || '[]');
  } catch {
    return [];
  }
}

function newId() {
  return `term_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function DevServerPanel({ project, active }: { project: Project; active: boolean }) {
  const ds = useStore((s) => s.devServers[project.id]);
  const logs = useStore((s) => s.devLogs[project.id]) || '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: load the logs once per project
  useEffect(() => {
    if (logs) return;
    api
      .devLogs(project.id)
      .then((r) => {
        if (r.logs) useStore.setState((s) => ({ devLogs: { ...s.devLogs, [project.id]: r.logs + (s.devLogs[project.id] || '') } }));
      })
      .catch(() => {});
  }, [project.id]);
  const status = ds?.status || 'stopped';
  const run = (a: 'start' | 'stop' | 'restart') => api.dev(project.id, a).catch((e) => toast('操作失败', e.message, 'error'));
  return (
    <div className="dev-panel">
      <div className="dev-panel-head">
        <span className={cx('dot', status === 'running' ? 'green' : status === 'error' ? 'red' : status === 'stopped' ? '' : 'orange pulse')} />
        <code>{ds?.command || project.devDetected || '（没有检测到启动命令）'}</code>
        {ds?.url && (
          <a href={ds.url} target="_blank" rel="noreferrer" className="muted">
            {ds.url}
          </a>
        )}
        <span className="spacer" />
        {status === 'stopped' || status === 'error' ? (
          <button className="btn sm" onClick={() => run('start')} disabled={!project.devDetected}>
            <Play size={13} /> 启动
          </button>
        ) : (
          <>
            <button className="btn sm" onClick={() => run('restart')}>
              <RotateCw size={13} /> 重启
            </button>
            <button className="btn sm" onClick={() => run('stop')}>
              <Square size={11} /> 停止
            </button>
          </>
        )}
      </div>
      {ds?.error && <div className="dev-error">{ds.error}</div>}
      <LogTerminal content={logs || '\x1b[90m开发服务器的输出会显示在这里。\x1b[0m\r\n'} active={active} />
    </div>
  );
}

export function TerminalTab({ project, active }: { project: Project; active: boolean }) {
  const [tabs, setTabs] = useState<TermTab[]>(() => loadTabs(project.id));
  const hasDev = !!project.devDetected;
  const [current, setCurrent] = useState<string>(() => (hasDev ? 'dev' : loadTabs(project.id)[0]?.id || 'dev'));
  const request = useStore((s) => s.terminalRequest);

  useEffect(() => {
    try {
      localStorage.setItem(lsKey(project.id), JSON.stringify(tabs));
    } catch {
      /* ignore */
    }
  }, [tabs, project.id]);

  // Drop tabs whose shells no longer exist on the server (e.g. after a restart).
  useEffect(() => {
    api
      .terminals(project.id)
      .then((list) => {
        const alive = new Set(list.map((t) => t.id));
        setTabs((cur) => cur.filter((t) => alive.has(t.id) || t.command === undefined));
      })
      .catch(() => {});
  }, [project.id]);

  const add = (command?: string) => {
    const t: TermTab = { id: newId(), title: command ? command.split(' ').slice(0, 3).join(' ') : `终端 ${tabs.length + 1}`, command };
    setTabs((cur) => [...cur, t]);
    setCurrent(t.id);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: each request carries a new nonce
  useEffect(() => {
    if (request && Date.now() - request.nonce < 5000) add(request.command);
  }, [request?.nonce]);

  // Start with one shell if there is nothing else to show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: open a first terminal when the tab is shown
  useEffect(() => {
    if (active && !hasDev && !tabs.length) add();
  }, [active]);

  const close = (id: string) => {
    send({ t: 'term_close', id });
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (current === id) setCurrent(rest[rest.length - 1]?.id || 'dev');
  };

  const shown = current === 'dev' && !hasDev ? tabs[0]?.id || '' : current;

  return (
    <div className="terminals">
      <div className="term-tabs">
        {hasDev && (
          <button className={cx('term-tab', shown === 'dev' && 'on')} onClick={() => setCurrent('dev')}>
            <Rocket size={13} /> 开发服务器
          </button>
        )}
        {tabs.map((t) => (
          <div key={t.id} className={cx('term-tab', shown === t.id && 'on')} onClick={() => setCurrent(t.id)}>
            <SquareTerminal size={13} />
            <span>{t.title}</span>
            <button
              className="term-close"
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
              title="关闭"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button className="icon-btn sm" title="新终端" onClick={() => add()}>
          <Plus size={14} />
        </button>
      </div>
      <div className="term-body">
        {hasDev && (
          <div className={cx('term-pane', shown !== 'dev' && 'hidden')}>
            <DevServerPanel project={project} active={active && shown === 'dev'} />
          </div>
        )}
        {tabs.map((t) => (
          <div key={t.id} className={cx('term-pane', shown !== t.id && 'hidden')}>
            <LiveTerminal id={t.id} projectId={project.id} command={t.command} active={active && shown === t.id} />
          </div>
        ))}
        {!hasDev && !tabs.length && (
          <div className="empty">
            <button className="btn" onClick={() => add()}>
              <SquareTerminal size={14} /> 打开终端
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
