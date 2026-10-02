import { ArrowUp, Check, Copy, CornerDownLeft, ExternalLink, Folder, FolderGit2, FolderOpen, FolderPlus, GitBranch, House, MoreHorizontal, Play, Settings, Square, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { defaultAutoChallenge } from '../../../../shared/challenge';
import type { DevServerState, Project } from '../../../../shared/types';
import { api } from '../../api';
import { listProjects, openChat, toast, useStore } from '../../store';
import { copyText, cx, shortPath } from '../../utils';
import { showWorkspaceChanges } from '../../workspace';
import { confirmDialog, Glyph, MenuButton, Modal, Toggle } from '../ui';
import { PageHead } from './BotsView';

// ---------------------------------------------------------------- shared bits

/** Project picker used by the bot editor and the chat dialogs. */
export function ProjectSelect({ value, onChange, noneLabel = '不绑定项目' }: { value: string | null; onChange: (v: string | null) => void; noneLabel?: string }) {
  const projects = useStore((s) => s.projects);
  const list = useMemo(() => listProjects(projects), [projects]);
  return (
    <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{noneLabel}</option>
      {list.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} — {shortPath(p.path)}
        </option>
      ))}
      {value && !projects[value] && <option value={value}>（项目已移除）</option>}
    </select>
  );
}

function devBadge(st: DevServerState | undefined) {
  switch (st?.status) {
    case 'running':
      return { cls: 'green', text: '运行中' };
    case 'starting':
      return { cls: 'orange', text: '启动中' };
    case 'installing':
      return { cls: 'orange', text: '安装依赖中' };
    case 'error':
      return { cls: 'red', text: '出错' };
    default:
      return { cls: '', text: '未运行' };
  }
}

// ---------------------------------------------------------------- project card

function ProjectSettingsForm({ project, onDone }: { project: Project; onDone: () => void }) {
  const [name, setName] = useState(project.name);
  const [devCommand, setDevCommand] = useState(project.devCommand || '');
  const [staticRoot, setStaticRoot] = useState(project.staticRoot || '');
  const [setupCommand, setSetupCommand] = useState(project.setupCommand || '');
  const [commitGuide, setCommitGuide] = useState(project.commitGuide || '');
  const [noAttribution, setNoAttribution] = useState(!!project.noAttribution);
  const [askRules, setAskRules] = useState((project.askRules || []).join('\n'));
  const [allowedDomains, setAllowedDomains] = useState((project.allowedDomains || []).join('\n'));
  const [requireChallenge, setRequireChallenge] = useState(!!project.requireChallenge);
  const [auto, setAuto] = useState(project.autoChallenge || { ...defaultAutoChallenge(), enabled: false });
  const [autoPaths, setAutoPaths] = useState(auto.paths.join('\n'));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const rules = askRules
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean);
      const domains = allowedDomains
        .split('\n')
        .map((d) => d.trim())
        .filter(Boolean);
      await api.updateProject(project.id, {
        name,
        devCommand,
        staticRoot,
        setupCommand,
        commitGuide,
        noAttribution,
        askRules: rules,
        allowedDomains: domains,
        requireChallenge,
        autoChallenge: {
          ...auto,
          paths: autoPaths
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });
      toast('项目设置已保存', undefined, 'success');
      onDone();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pc-settings">
      <div className="form-grid">
        <div className="field">
          <label>名称</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>启动命令</label>
          <input className="input mono" value={devCommand} placeholder="自动检测（如 npm run dev）；填 static 表示纯静态" onChange={(e) => setDevCommand(e.target.value)} />
        </div>
        <div className="field">
          <label>静态文件目录</label>
          <input className="input mono" value={staticRoot} placeholder="静态文件目录，默认项目根目录" onChange={(e) => setStaticRoot(e.target.value)} />
          <div className="hint">没有开发服务器时，预览直接托管这个目录（相对项目根目录，例如 public 或 dist）。</div>
        </div>
        <div className="field">
          <label>新工作区准备命令</label>
          <input className="input mono" value={setupCommand} placeholder="例如 npm ci，或 uv sync && cd frontend && bun install" onChange={(e) => setSetupCommand(e.target.value)} />
          <div className="hint">每开一个独立工作区都先在里面跑一遍（比如装依赖），跑完机器人才开始工作。</div>
        </div>
        <div className="field span-all">
          <label>提交信息要求</label>
          <textarea className="input" rows={2} value={commitGuide} placeholder="例如：英文，祈使句，第一行不超过 72 个字符，正文说明为什么改" onChange={(e) => setCommitGuide(e.target.value)} />
          <div className="hint">机器人提交时照这个写；合并独立工作区时，合并说明也必须按它写，可以一键生成。</div>
        </div>
        <div className="field span-all">
          <label>必须确认的操作</label>
          <textarea className="input mono" rows={3} value={askRules} placeholder={'每行一条，例如\nBash(ssh:*)\nBash(docker compose down:*)'} onChange={(e) => setAskRules(e.target.value)} />
          <div className="hint">在这个项目里工作的所有机器人，碰到这些操作都要先问你。写法和机器人设置里的「必须确认」一样。</div>
        </div>
        <div className="field span-all">
          <label>沙盒里允许访问的域名</label>
          <textarea className="input mono" rows={2} value={allowedDomains} placeholder={'每行一个，例如\napi.example.com\n10.0.0.5:8080'} onChange={(e) => setAllowedDomains(e.target.value)} />
          <div className="hint">在「设置 → 沙盒」的全局列表之外，这个项目的命令还能连这些主机。</div>
        </div>
        <div className="field span-all">
          <div className="setting-row">
            <div>
              <div className="sr-title">提交不加 AI 署名</div>
              <div className="hint">机器人的提交和 PR 不带 Co-Authored-By 之类的署名，合并提交里也不写 Crew。</div>
            </div>
            <Toggle on={noAttribution} onChange={setNoAttribution} />
          </div>
          <div className="setting-row">
            <div>
              <div className="sr-title">合并前必须通过对抗审查</div>
              <div className="hint">独立工作区合并前，Skeptic 要针对最新的提交审一次，而且一条都没推翻才能合并（/challenge）。每次大约花 $0.3～0.6。</div>
            </div>
            <Toggle on={requireChallenge} onChange={setRequireChallenge} />
          </div>
          <div className="setting-row">
            <div>
              <div className="sr-title">按规则自动对抗审查</div>
              <div className="hint">
                一串机器人的活干完、改动又碰到下面的文件或者超过行数时，自动请 Skeptic 审一次。每个请求最多两次（审、修、再审），同样的改动不审第二遍。规则是固定的，不让模型判断「有没有风险」。
              </div>
            </div>
            <Toggle on={auto.enabled} onChange={(enabled) => setAuto({ ...auto, enabled })} />
          </div>
          {auto.enabled && (
            <div className="form-grid">
              <div className="field">
                <label>碰到这些文件就审（每行一个）</label>
                <textarea className="input mono" rows={5} value={autoPaths} onChange={(e) => setAutoPaths(e.target.value)} />
              </div>
              <div className="field">
                <label>或者改动至少多少行</label>
                <input className="input num-input" type="number" min={0} step={10} value={auto.minLines} onChange={(e) => setAuto({ ...auto, minLines: Math.max(0, Number(e.target.value) || 0) })} />
                <div className="hint">加的行和删的行加起来；0 表示不按行数。</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn" onClick={onDone}>
          取消
        </button>
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? <span className="spinner" /> : <Check size={15} />} 保存
        </button>
      </div>
    </div>
  );
}

/** The chats working on this project in their own branch. */
function WorkspaceList({ workspaces }: { workspaces: Project[] }) {
  const chats = useStore((s) => s.chats);
  if (!workspaces.length) return null;
  return (
    <div className="pc-workspaces">
      <span className="muted">独立工作区：</span>
      {workspaces.map((w) => {
        const chat = chats[w.workspace!.chatId];
        return (
          <button
            key={w.id}
            className="branch-pill"
            title={`${w.path}\n打开对话「${chat?.title ?? ''}」查看改动`}
            onClick={() => {
              if (!chat) return;
              openChat(chat.id);
              showWorkspaceChanges();
            }}
          >
            <GitBranch size={12} />
            <span>{w.workspace!.branch}</span>
            {chat && <span className="muted">· {chat.title}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ProjectCard({ project, chatCount, workspaces }: { project: Project; chatCount: number; workspaces: Project[] }) {
  const dev = useStore((s) => s.devServers[project.id]);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const status = dev?.status || 'stopped';
  const active = status === 'running' || status === 'starting' || status === 'installing';
  const badge = devBadge(dev);
  // devDetected === null: a plain static site (served directly, no dev server needed).
  const isStatic = project.devDetected === null && !active;

  // A status change from the server means the click took effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the pending flag when a new status arrives
  useEffect(() => setPending(false), [status]);

  const toggleDev = () => {
    setPending(true);
    api
      .dev(project.id, active ? 'stop' : 'start')
      .then((st) => {
        if (st.status === 'error' && st.error) toast('开发服务器没有启动', st.error, 'warn');
      })
      .catch((e) => toast(active ? '停止失败' : '启动失败', (e as Error).message, 'error'))
      .finally(() => setPending(false));
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `从列表移除「${project.name}」？`,
      body: `只是从 Crew 移除，不会删除文件。使用这个项目的对话会解除绑定${workspaces.length ? `，它们的 ${workspaces.length} 个独立工作区也会关闭（没合并的改动保留在各自的分支里）` : ''}。`,
      ok: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeProject(project.id);
      toast('已从列表移除', project.name, 'success');
    } catch (e) {
      toast('移除失败', (e as Error).message, 'error');
    }
  };

  return (
    <div className={cx('card project-card', editing && 'editing')}>
      <div className="pc-row">
        <div className="pc-icon">
          <FolderGit2 size={20} />
        </div>
        <div className="pc-info">
          <div className="pc-name">
            <span className="ellipsis">{project.name}</span>
            {project.framework && <span className="badge accent">{project.framework}</span>}
          </div>
          <div className="pc-path mono" title={project.path}>
            {shortPath(project.path)}
          </div>
          <div className="pc-meta">
            <span className="pc-dev">
              开发服务器：
              {isStatic ? (
                <span className="badge">不需要 · 静态网页直接预览</span>
              ) : (
                <>
                  <span className={cx('badge', badge.cls)}>
                    {(status === 'starting' || status === 'installing') && <span className="spinner tiny" />}
                    {badge.text}
                  </span>
                  {status === 'running' && dev?.url ? (
                    <a href={dev.url} target="_blank" rel="noreferrer" className="mono pc-url">
                      {dev.url.replace(/^https?:\/\//, '')} <ExternalLink size={11} />
                    </a>
                  ) : (
                    (dev?.command || project.devDetected) && <span className="mono muted pc-cmd">{dev?.command || project.devDetected}</span>
                  )}
                </>
              )}
            </span>
            <span className="muted">{chatCount ? `${chatCount} 个对话在用` : '没有对话在用'}</span>
          </div>
          <WorkspaceList workspaces={workspaces} />
          {status === 'error' && dev?.error && <div className="pc-error">{dev.error}</div>}
        </div>
        <div className="pc-actions">
          {!isStatic && (
            <button className="btn sm" disabled={pending} onClick={toggleDev} title={active ? '停止开发服务器' : '启动开发服务器'}>
              {pending ? <span className="spinner tiny" /> : active ? <Square size={12} /> : <Play size={13} />}
              {active ? '停止' : '启动'}
            </button>
          )}
          <button className={cx('btn sm', editing && 'on')} onClick={() => setEditing((v) => !v)}>
            <Settings size={13} /> 设置
          </button>
          <MenuButton
            align="right"
            title="更多"
            items={[
              {
                label: '复制路径',
                icon: <Copy size={15} />,
                onClick: () => void copyText(project.path).then(() => toast('已复制路径', project.path, 'success')),
              },
              { separator: true },
              { label: '从列表移除', icon: <Trash2 size={15} />, danger: true, onClick: () => void remove() },
            ]}
          >
            <MoreHorizontal size={18} />
          </MenuButton>
        </div>
      </div>
      {editing && <ProjectSettingsForm project={project} onDone={() => setEditing(false)} />}
    </div>
  );
}

export function ProjectsView() {
  const projects = useStore((s) => s.projects);
  const chats = useStore((s) => s.chats);
  const [dialog, setDialog] = useState<null | 'create' | 'open'>(null);
  const list = useMemo(() => listProjects(projects), [projects]);
  const workspaces = useMemo(() => {
    const m: Record<string, Project[]> = {};
    for (const p of Object.values(projects))
      if (p.workspace) {
        m[p.workspace.parentId] ??= [];
        m[p.workspace.parentId].push(p);
      }
    return m;
  }, [projects]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const c of Object.values(chats)) if (c.projectId) m[c.projectId] = (m[c.projectId] || 0) + 1;
    return m;
  }, [chats]);

  return (
    <div className="page">
      <div className="page-inner">
        <PageHead title="项目" sub="每个对话绑定一个项目文件夹，机器人在里面工作，右侧面板实时预览">
          <button className="btn" onClick={() => setDialog('open')}>
            <FolderOpen size={15} /> 打开文件夹
          </button>
          <button className="btn primary" onClick={() => setDialog('create')}>
            <FolderPlus size={15} /> 新建项目
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty">
            <div className="big">
              <Glyph emoji="📁" size={26} />
            </div>
            <h3>还没有项目</h3>
            <div>新建一个网站，或者打开电脑上已有的项目文件夹，机器人就能在里面工作。</div>
            <div className="row">
              <button className="btn" onClick={() => setDialog('open')}>
                <FolderOpen size={15} /> 打开文件夹
              </button>
              <button className="btn primary" onClick={() => setDialog('create')}>
                <FolderPlus size={15} /> 新建项目
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            {list.map((p) => (
              <ProjectCard key={p.id} project={p} chatCount={counts[p.id] || 0} workspaces={workspaces[p.id] || []} />
            ))}
          </div>
        )}
      </div>
      {dialog && <NewProjectDialog initialTab={dialog} onClose={() => setDialog(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- new / open dialog

type FsListing = Awaited<ReturnType<typeof api.fs>>;
type ProjectTemplateInfo = Awaited<ReturnType<typeof api.projectTemplates>>[number];

function FolderBrowser({ listing, loading, onGo }: { listing: FsListing | null; loading: boolean; onGo: (path?: string) => void }) {
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (listing) setTyped(listing.path);
  }, [listing]);

  return (
    <div className="folder-browser">
      <div className="fb-bar">
        <button className="icon-btn" title="上一级" disabled={!listing?.parent || loading} onClick={() => listing?.parent && onGo(listing.parent)}>
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" title="主目录" disabled={loading} onClick={() => onGo(listing?.home)}>
          <House size={16} />
        </button>
        <input
          className="input mono"
          value={typed}
          placeholder="粘贴文件夹路径，例如 ~/code/my-site"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && typed.trim() && onGo(typed.trim())}
        />
        <button className="btn" disabled={!typed.trim() || loading} onClick={() => onGo(typed.trim())}>
          <CornerDownLeft size={14} /> 前往
        </button>
      </div>
      <div className="fb-list">
        {loading && !listing && (
          <div className="fb-empty">
            <span className="spinner" />
          </div>
        )}
        {listing && listing.entries.length === 0 && <div className="fb-empty muted">这个文件夹里没有子文件夹</div>}
        {listing?.entries.map((e) => (
          <button key={e.path} className="fb-item" onClick={() => onGo(e.path)} disabled={loading}>
            {e.isProject ? <FolderGit2 size={16} className="fb-ico proj" /> : <Folder size={16} className="fb-ico" />}
            <span className="ellipsis">{e.name}</span>
            {e.isProject && <span className="badge accent">项目</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NewProjectDialog({ onClose, initialTab = 'create' }: { onClose: () => void; initialTab?: 'create' | 'open' }) {
  const settings = useStore((s) => s.settings);
  const activeChatId = useStore((s) => s.activeChatId);
  const activeChat = useStore((s) => (s.activeChatId ? s.chats[s.activeChatId] : undefined));
  const [tab, setTab] = useState<'create' | 'open'>(initialTab);
  const [busy, setBusy] = useState(false);
  const [useInChat, setUseInChat] = useState(!!activeChat);

  // create
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<ProjectTemplateInfo[] | null>(null);
  const [template, setTemplate] = useState('static');

  // open
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loadingFs, setLoadingFs] = useState(false);

  useEffect(() => {
    api
      .projectTemplates()
      .then((list) => {
        setTemplates(list);
        if (list.length && !list.some((t) => t.id === 'static')) setTemplate(list[0].id);
      })
      .catch((e) => {
        setTemplates([]);
        toast('加载项目模板失败', (e as Error).message, 'error');
      });
  }, []);

  const go = async (path?: string) => {
    setLoadingFs(true);
    try {
      setListing(await api.fs(path));
    } catch (e) {
      toast('无法打开文件夹', (e as Error).message, 'error');
    } finally {
      setLoadingFs(false);
    }
  };

  useEffect(() => {
    if (tab !== 'open' || listing) return;
    (async () => {
      setLoadingFs(true);
      try {
        setListing(await api.fs(settings.projectsRoot || undefined));
      } catch {
        try {
          setListing(await api.fs());
        } catch (e) {
          toast('无法读取文件夹', (e as Error).message, 'error');
        }
      } finally {
        setLoadingFs(false);
      }
    })();
  }, [tab, listing, settings.projectsRoot]);

  const finish = async (project: Project, verb: string) => {
    if (useInChat && activeChatId) {
      try {
        await api.updateChat(activeChatId, { projectId: project.id });
      } catch (e) {
        toast('切换对话项目失败', (e as Error).message, 'error');
      }
    }
    toast(`${verb}「${project.name}」`, useInChat && activeChat ? `已在「${activeChat.title}」中使用` : shortPath(project.path), 'success');
    onClose();
  };

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject({ name: name.trim() || '我的网站', template });
      await finish(p, '已创建项目');
    } catch (e) {
      toast('创建项目失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      const p = await api.openProject(listing.path);
      await finish(p, '已打开项目');
    } catch (e) {
      toast('打开项目失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const tpl = templates?.find((t) => t.id === template);

  return (
    <Modal
      title="新建或打开项目"
      icon={<FolderPlus size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          {activeChat && (
            <label className="check-row foot-left">
              <input type="checkbox" checked={useInChat} onChange={(e) => setUseInChat(e.target.checked)} />
              <span>
                在当前对话<span className="muted">「{activeChat.title}」</span>中使用
              </span>
            </label>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {tab === 'create' ? (
            <button className="btn primary" disabled={busy || !templates?.length} onClick={create}>
              {busy ? <span className="spinner" /> : <FolderPlus size={15} />} 创建项目
            </button>
          ) : (
            <button className="btn primary" disabled={busy || loadingFs || !listing} onClick={open}>
              {busy ? <span className="spinner" /> : <Check size={15} />} 使用这个文件夹
            </button>
          )}
        </>
      }
    >
      <div className="tabs">
        <button className={cx('tab', tab === 'create' && 'on')} onClick={() => setTab('create')}>
          <FolderPlus size={15} /> 新建
        </button>
        <button className={cx('tab', tab === 'open' && 'on')} onClick={() => setTab('open')}>
          <FolderOpen size={15} /> 打开已有文件夹
        </button>
      </div>

      {tab === 'create' ? (
        <div className="tab-body">
          <div className="field">
            <label>项目名称</label>
            <input className="input" autoFocus value={name} placeholder="我的网站" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void create()} />
          </div>
          <div className="field">
            <label>模板</label>
            {!templates ? (
              <div className="row muted">
                <span className="spinner" /> 正在加载模板…
              </div>
            ) : (
              <div className="choice-grid">
                {templates.map((t) => (
                  <button key={t.id} className={cx('choice-card', template === t.id && 'on')} onClick={() => setTemplate(t.id)}>
                    <div className="cc-head">
                      <span className="cc-title">{t.name}</span>
                      {t.needsInstall && <span className="badge orange">需要安装依赖</span>}
                      <span className="spacer" />
                      <span className="cc-check">{template === t.id && <Check size={13} />}</span>
                    </div>
                    <div className="cc-desc">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
            {tpl?.needsInstall && <div className="hint">第一次启动开发服务器时会自动安装依赖，可能需要一两分钟。</div>}
          </div>
          <div className="note">
            <Folder size={14} />
            <span>
              将创建在 <span className="mono">{shortPath(settings.projectsRoot) || '项目目录'}/</span> 下（可在设置里修改），并自动初始化 Git 仓库。
            </span>
          </div>
        </div>
      ) : (
        <div className="tab-body">
          <FolderBrowser listing={listing} loading={loadingFs} onGo={go} />
          {listing && (
            <div className="note">
              <FolderOpen size={14} />
              <span>
                将打开 <span className="mono">{shortPath(listing.path)}</span>
                {listing.entries.length > 0 && '（点击子文件夹可以进入）'}
              </span>
            </div>
          )}
        </div>
      )}
      {!activeChat && (
        <div className="hint" style={{ marginTop: 10 }}>
          之后可以在对话设置里把项目绑定到任意对话。
        </div>
      )}
    </Modal>
  );
}
