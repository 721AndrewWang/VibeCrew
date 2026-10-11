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
export function ProjectSelect({ value, onChange, noneLabel = 'No project' }: { value: string | null; onChange: (v: string | null) => void; noneLabel?: string }) {
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
      {value && !projects[value] && <option value={value}>(project removed)</option>}
    </select>
  );
}

function devBadge(st: DevServerState | undefined) {
  switch (st?.status) {
    case 'running':
      return { cls: 'green', text: 'Running' };
    case 'starting':
      return { cls: 'orange', text: 'Starting' };
    case 'installing':
      return { cls: 'orange', text: 'Installing dependencies' };
    case 'error':
      return { cls: 'red', text: 'Error' };
    default:
      return { cls: '', text: 'Stopped' };
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
      toast('Project settings saved', undefined, 'success');
      onDone();
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pc-settings">
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Dev command</label>
          <input className="input mono" value={devCommand} placeholder="Auto-detected (e.g. npm run dev); enter static for a static site" onChange={(e) => setDevCommand(e.target.value)} />
        </div>
        <div className="field">
          <label>Static files folder</label>
          <input className="input mono" value={staticRoot} placeholder="Static files folder, defaults to the project root" onChange={(e) => setStaticRoot(e.target.value)} />
          <div className="hint">Without a dev server, the preview serves this folder directly (relative to the project root, e.g. public or dist).</div>
        </div>
        <div className="field">
          <label>Workspace setup command</label>
          <input className="input mono" value={setupCommand} placeholder="e.g. npm ci, or uv sync && cd frontend && bun install" onChange={(e) => setSetupCommand(e.target.value)} />
          <div className="hint">Runs in every new isolated workspace (e.g. to install dependencies) before the bot starts working.</div>
        </div>
        <div className="field span-all">
          <label>Commit message guidelines</label>
          <textarea
            className="input"
            rows={2}
            value={commitGuide}
            placeholder="e.g. English, imperative mood, first line under 72 characters, body explains why"
            onChange={(e) => setCommitGuide(e.target.value)}
          />
          <div className="hint">Bots follow this when committing. Merge messages for isolated workspaces must follow it too, and can be generated in one click.</div>
        </div>
        <div className="field span-all">
          <label>Actions that need approval</label>
          <textarea className="input mono" rows={3} value={askRules} placeholder={'One per line, e.g.\nBash(ssh:*)\nBash(docker compose down:*)'} onChange={(e) => setAskRules(e.target.value)} />
          <div className="hint">Every bot working in this project must ask you before these actions. Same syntax as "Needs approval" in bot settings.</div>
        </div>
        <div className="field span-all">
          <label>Allowed domains in the sandbox</label>
          <textarea className="input mono" rows={2} value={allowedDomains} placeholder={'One per line, e.g.\napi.example.com\n10.0.0.5:8080'} onChange={(e) => setAllowedDomains(e.target.value)} />
          <div className="hint">On top of the global list in Settings → Sandbox, commands in this project can also reach these hosts.</div>
        </div>
        <div className="field span-all">
          <div className="setting-row">
            <div>
              <div className="sr-title">No AI attribution in commits</div>
              <div className="hint">Bot commits and PRs carry no Co-Authored-By or similar lines, and merge commits don't mention Crew.</div>
            </div>
            <Toggle on={noAttribution} onChange={setNoAttribution} />
          </div>
          <div className="setting-row">
            <div>
              <div className="sr-title">Require adversarial review before merge</div>
              <div className="hint">
                Before an isolated workspace merges, Skeptic reviews the latest commit, and it can only merge if nothing is overturned (/challenge). Costs about $0.3–0.6 each time.
              </div>
            </div>
            <Toggle on={requireChallenge} onChange={setRequireChallenge} />
          </div>
          <div className="setting-row">
            <div>
              <div className="sr-title">Auto adversarial review by rules</div>
              <div className="hint">
                When a chain of bot work finishes and the changes touch the files below or exceed the line count, Skeptic reviews automatically. At most twice per request (review, fix, re-review), and
                the same changes are never reviewed twice. The rules are fixed; the model doesn't decide what is "risky".
              </div>
            </div>
            <Toggle on={auto.enabled} onChange={(enabled) => setAuto({ ...auto, enabled })} />
          </div>
          {auto.enabled && (
            <div className="form-grid">
              <div className="field">
                <label>Review when these files change (one per line)</label>
                <textarea className="input mono" rows={5} value={autoPaths} onChange={(e) => setAutoPaths(e.target.value)} />
              </div>
              <div className="field">
                <label>Or when at least this many lines change</label>
                <input className="input num-input" type="number" min={0} step={10} value={auto.minLines} onChange={(e) => setAuto({ ...auto, minLines: Math.max(0, Number(e.target.value) || 0) })} />
                <div className="hint">Added plus deleted lines. 0 means no line threshold.</div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={saving} onClick={save}>
          {saving ? <span className="spinner" /> : <Check size={15} />} Save
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
      <span className="muted">Isolated workspaces:</span>
      {workspaces.map((w) => {
        const chat = chats[w.workspace!.chatId];
        return (
          <button
            key={w.id}
            className="branch-pill"
            title={`${w.path}\nOpen chat "${chat?.title ?? ''}" to see changes`}
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
        if (st.status === 'error' && st.error) toast('Dev server failed to start', st.error, 'warn');
      })
      .catch((e) => toast(active ? 'Failed to stop' : 'Failed to start', (e as Error).message, 'error'))
      .finally(() => setPending(false));
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: `Remove "${project.name}" from the list?`,
      body: `This only removes it from Crew; no files are deleted. Chats using this project will be unbound${workspaces.length ? `, and their ${workspaces.length} isolated workspace${workspaces.length === 1 ? '' : 's'} will be closed (unmerged changes stay on their branches)` : ''}.`,
      ok: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeProject(project.id);
      toast('Removed from list', project.name, 'success');
    } catch (e) {
      toast('Remove failed', (e as Error).message, 'error');
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
              Dev server:{' '}
              {isStatic ? (
                <span className="badge">Not needed · static site previews directly</span>
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
            <span className="muted">{chatCount ? `Used by ${chatCount} chat${chatCount === 1 ? '' : 's'}` : 'Not used by any chat'}</span>
          </div>
          <WorkspaceList workspaces={workspaces} />
          {status === 'error' && dev?.error && <div className="pc-error">{dev.error}</div>}
        </div>
        <div className="pc-actions">
          {!isStatic && (
            <button className="btn sm" disabled={pending} onClick={toggleDev} title={active ? 'Stop dev server' : 'Start dev server'}>
              {pending ? <span className="spinner tiny" /> : active ? <Square size={12} /> : <Play size={13} />}
              {active ? 'Stop' : 'Start'}
            </button>
          )}
          <button className={cx('btn sm', editing && 'on')} onClick={() => setEditing((v) => !v)}>
            <Settings size={13} /> Settings
          </button>
          <MenuButton
            align="right"
            title="More"
            items={[
              {
                label: 'Copy path',
                icon: <Copy size={15} />,
                onClick: () => void copyText(project.path).then(() => toast('Path copied', project.path, 'success')),
              },
              { separator: true },
              { label: 'Remove from list', icon: <Trash2 size={15} />, danger: true, onClick: () => void remove() },
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
        <PageHead title="Projects" sub="Each chat is bound to a project folder. Bots work inside it, with a live preview in the right panel.">
          <button className="btn" onClick={() => setDialog('open')}>
            <FolderOpen size={15} /> Open folder
          </button>
          <button className="btn primary" onClick={() => setDialog('create')}>
            <FolderPlus size={15} /> New project
          </button>
        </PageHead>

        {list.length === 0 ? (
          <div className="card empty">
            <div className="big">
              <Glyph emoji="📁" size={26} />
            </div>
            <h3>No projects yet</h3>
            <div>Create a new site, or open an existing project folder on your computer, and bots can work in it.</div>
            <div className="row">
              <button className="btn" onClick={() => setDialog('open')}>
                <FolderOpen size={15} /> Open folder
              </button>
              <button className="btn primary" onClick={() => setDialog('create')}>
                <FolderPlus size={15} /> New project
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
        <button className="icon-btn" title="Up one level" disabled={!listing?.parent || loading} onClick={() => listing?.parent && onGo(listing.parent)}>
          <ArrowUp size={16} />
        </button>
        <button className="icon-btn" title="Home folder" disabled={loading} onClick={() => onGo(listing?.home)}>
          <House size={16} />
        </button>
        <input
          className="input mono"
          value={typed}
          placeholder="Paste a folder path, e.g. ~/code/my-site"
          onChange={(e) => setTyped(e.target.value)}
          // The box starts out holding the current folder, so typing or pasting a path would append
          // to it. Clicking in selects it all, and a pasted full path replaces it whatever is selected.
          onMouseDown={(e) => {
            if (document.activeElement === e.currentTarget) return;
            e.preventDefault();
            e.currentTarget.focus();
          }}
          onFocus={(e) => e.currentTarget.select()}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text').trim();
            if (!/^(~|\/|[A-Za-z]:[\\/])/.test(pasted)) return;
            e.preventDefault();
            setTyped(pasted);
          }}
          onKeyDown={(e) => e.key === 'Enter' && typed.trim() && onGo(typed.trim())}
        />
        <button className="btn" disabled={!typed.trim() || loading} onClick={() => onGo(typed.trim())}>
          <CornerDownLeft size={14} /> Go
        </button>
      </div>
      <div className="fb-list">
        {loading && !listing && (
          <div className="fb-empty">
            <span className="spinner" />
          </div>
        )}
        {listing && listing.entries.length === 0 && <div className="fb-empty muted">No subfolders in this folder</div>}
        {listing?.entries.map((e) => (
          <button key={e.path} className="fb-item" onClick={() => onGo(e.path)} disabled={loading}>
            {e.isProject ? <FolderGit2 size={16} className="fb-ico proj" /> : <Folder size={16} className="fb-ico" />}
            <span className="ellipsis">{e.name}</span>
            {e.isProject && <span className="badge accent">Project</span>}
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
        toast('Failed to load project templates', (e as Error).message, 'error');
      });
  }, []);

  const go = async (path?: string) => {
    setLoadingFs(true);
    try {
      setListing(await api.fs(path));
    } catch (e) {
      toast('Could not open folder', (e as Error).message, 'error');
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
          toast('Could not read folder', (e as Error).message, 'error');
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
        toast('Failed to switch chat project', (e as Error).message, 'error');
      }
    }
    toast(`${verb} "${project.name}"`, useInChat && activeChat ? `Now used in "${activeChat.title}"` : shortPath(project.path), 'success');
    onClose();
  };

  const create = async () => {
    setBusy(true);
    try {
      const p = await api.createProject({ name: name.trim() || 'My site', template });
      await finish(p, 'Created project');
    } catch (e) {
      toast('Failed to create project', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (!listing) return;
    setBusy(true);
    try {
      const p = await api.openProject(listing.path);
      await finish(p, 'Opened project');
    } catch (e) {
      toast('Failed to open project', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const tpl = templates?.find((t) => t.id === template);

  return (
    <Modal
      title="New or open project"
      icon={<FolderPlus size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        <>
          {activeChat && (
            <label className="check-row foot-left">
              <input type="checkbox" checked={useInChat} onChange={(e) => setUseInChat(e.target.checked)} />
              <span>
                Use in current chat <span className="muted">&quot;{activeChat.title}&quot;</span>
              </span>
            </label>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {tab === 'create' ? (
            <button className="btn primary" disabled={busy || !templates?.length} onClick={create}>
              {busy ? <span className="spinner" /> : <FolderPlus size={15} />} Create project
            </button>
          ) : (
            <button className="btn primary" disabled={busy || loadingFs || !listing} onClick={open}>
              {busy ? <span className="spinner" /> : <Check size={15} />} Use this folder
            </button>
          )}
        </>
      }
    >
      <div className="tabs">
        <button className={cx('tab', tab === 'create' && 'on')} onClick={() => setTab('create')}>
          <FolderPlus size={15} /> New
        </button>
        <button className={cx('tab', tab === 'open' && 'on')} onClick={() => setTab('open')}>
          <FolderOpen size={15} /> Open existing folder
        </button>
      </div>

      {tab === 'create' ? (
        <div className="tab-body">
          <div className="field">
            <label>Project name</label>
            <input className="input" autoFocus value={name} placeholder="My site" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && void create()} />
          </div>
          <div className="field">
            <label>Template</label>
            {!templates ? (
              <div className="row muted">
                <span className="spinner" /> Loading templates…
              </div>
            ) : (
              <div className="choice-grid">
                {templates.map((t) => (
                  <button key={t.id} className={cx('choice-card', template === t.id && 'on')} onClick={() => setTemplate(t.id)}>
                    <div className="cc-head">
                      <span className="cc-title">{t.name}</span>
                      {t.needsInstall && <span className="badge orange">Needs install</span>}
                      <span className="spacer" />
                      <span className="cc-check">{template === t.id && <Check size={13} />}</span>
                    </div>
                    <div className="cc-desc">{t.description}</div>
                  </button>
                ))}
              </div>
            )}
            {tpl?.needsInstall && <div className="hint">Dependencies install automatically the first time the dev server starts, which may take a minute or two.</div>}
          </div>
          <div className="note">
            <Folder size={14} />
            <span>
              Will be created in <span className="mono">{shortPath(settings.projectsRoot) || 'projects folder'}/</span> (changeable in Settings), with a Git repo initialized automatically.
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
                Will open <span className="mono">{shortPath(listing.path)}</span>
                {listing.entries.length > 0 && ' (click a subfolder to open it)'}
              </span>
            </div>
          )}
        </div>
      )}
      {!activeChat && (
        <div className="hint" style={{ marginTop: 10 }}>
          You can bind the project to any chat later in Chat settings.
        </div>
      )}
    </Modal>
  );
}
