import { AtSign, ChevronRight, File, FileCode2, Folder, FolderOpen, Globe, PanelLeft, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Chat, Project } from '../../../../shared/types';
import { api, type FileContent, type TreeEntry } from '../../api';
import { addAttachment, attachmentId, setComputer, toast, updatePreview, useStore } from '../../store';
import { cx, fmtBytes } from '../../utils';
import { Glyph } from '../ui';
import { CodeEditor } from './CodeEditor';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico|bmp)$/i;

function fileIcon(name: string) {
  if (/\.(html?|vue|svelte|astro)$/i.test(name)) return <Globe size={14} className="fi html" />;
  if (/\.(css|scss|less)$/i.test(name)) return <FileCode2 size={14} className="fi css" />;
  if (/\.(m?[jt]sx?)$/i.test(name)) return <FileCode2 size={14} className="fi js" />;
  if (/\.json$/i.test(name)) return <FileCode2 size={14} className="fi json" />;
  return <File size={14} className="fi" />;
}

export function FilesTab({ chat, project, active }: { chat: Chat; project: Project; active: boolean }) {
  const filesVersion = useStore((s) => s.filesVersion[project.id] || 0);
  const lastChanged = useStore((s) => s.lastChanged[project.id]);
  const openReq = useStore((s) => s.openFile);
  const [children, setChildren] = useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [file, setFile] = useState<FileContent | null>(null);
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const loaded = useRef(false);

  const loadDir = useCallback(
    async (dir: string) => {
      try {
        const list = await api.tree(project.id, dir);
        setChildren((c) => ({ ...c, [dir]: list }));
      } catch (e) {
        if (dir === '') toast('Failed to load file list', (e as Error).message, 'error');
      }
    },
    [project.id],
  );

  const openFile = useCallback(
    async (path: string, keepDirtyCheck = true) => {
      if (keepDirtyCheck && dirty && openPath && path !== openPath && !window.confirm(`"${openPath}" has unsaved changes. Switch anyway?`)) return;
      setOpenPath(path);
      setDirty(false);
      if (IMAGE_EXT.test(path)) {
        setFile({ path, binary: true, size: 0 });
        return;
      }
      try {
        const f = await api.file(project.id, path);
        setFile(f);
        setText(f.content ?? '');
      } catch (e) {
        toast('Failed to open file', (e as Error).message, 'error');
      }
    },
    [project.id, dirty, openPath],
  );

  // First load when the tab is shown.
  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void loadDir('');
  }, [active, loadDir]);

  // Files changed on disk: refresh listings and the open file.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload what is shown when files change on disk
  useEffect(() => {
    if (!loaded.current || !filesVersion) return;
    for (const dir of Object.keys(children)) if (dir === '' || expanded.has(dir)) void loadDir(dir);
    if (lastChanged?.length) {
      setFlash(new Set(lastChanged));
      const t = setTimeout(() => setFlash(new Set()), 2500);
      if (openPath && lastChanged.includes(openPath) && !dirty) void openFile(openPath, false);
      return () => clearTimeout(t);
    }
  }, [filesVersion]);

  // "Open this file" requests from chat messages.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each request carries a new nonce
  useEffect(() => {
    if (!openReq || openReq.projectId !== project.id) return;
    const parts = openReq.path.split('/');
    const dirs = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    loaded.current = true;
    void loadDir('');
    for (const d of dirs) void loadDir(d);
    setExpanded((e) => new Set([...e, ...dirs]));
    void openFile(openReq.path);
  }, [openReq?.nonce]);

  const toggle = (dir: string) => {
    const next = new Set(expanded);
    if (next.has(dir)) next.delete(dir);
    else {
      next.add(dir);
      if (!children[dir]) void loadDir(dir);
    }
    setExpanded(next);
  };

  const save = async () => {
    if (!openPath || !dirty) return;
    setSaving(true);
    try {
      await api.saveFile(project.id, openPath, text);
      setFile((f) => (f && f.path === openPath ? { ...f, content: text } : f));
      setDirty(false);
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const renderDir = (dir: string, depth: number) =>
    (children[dir] || []).map((e) => (
      <div key={e.path}>
        <button
          className={cx('tree-row', e.type, openPath === e.path && 'on', e.heavy && 'heavy', flash.has(e.path) && 'flash')}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (e.type === 'dir' ? toggle(e.path) : void openFile(e.path))}
          title={e.path}
        >
          {e.type === 'dir' ? (
            <>
              <ChevronRight size={12} className={cx('chev', expanded.has(e.path) && 'open')} />
              {expanded.has(e.path) ? <FolderOpen size={14} className="fi dir" /> : <Folder size={14} className="fi dir" />}
            </>
          ) : (
            <>
              <span style={{ width: 12 }} />
              {fileIcon(e.name)}
            </>
          )}
          <span className="tree-name">{e.name}</span>
        </button>
        {e.type === 'dir' && expanded.has(e.path) && renderDir(e.path, depth + 1)}
      </div>
    ));

  const isHtml = openPath && /\.html?$/i.test(openPath);

  return (
    <div className={cx('files', !treeOpen && 'tree-hidden')}>
      <div className="tree">
        <div className="tree-head">
          <span className="tree-title" title={project.path}>
            {project.name}
          </span>
          <button className="icon-btn sm" title="Refresh" onClick={() => void loadDir('')}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="tree-body">{renderDir('', 0)}</div>
      </div>
      <div className="editor-pane">
        <div className="editor-head">
          <button className="icon-btn sm" title={treeOpen ? 'Hide file tree' : 'Show file tree'} onClick={() => setTreeOpen(!treeOpen)}>
            <PanelLeft size={14} />
          </button>
          <span className="editor-path">
            {openPath || 'Select a file'}
            {dirty && <span className="dirty-dot" title="Unsaved" />}
          </span>
          <span className="spacer" />
          {openPath && (
            <>
              {isHtml && (
                <button
                  className="btn sm ghost"
                  title="Open this page in the browser"
                  onClick={() => {
                    updatePreview(project.id, { navigate: { path: '/' + openPath, nonce: Date.now() } });
                    setComputer({ tab: 'browser' });
                  }}
                >
                  <Globe size={13} /> Preview
                </button>
              )}
              <button
                className="btn sm ghost"
                title="Attach this file to the input as context"
                onClick={() => {
                  addAttachment(chat.id, { kind: 'file', id: attachmentId(), path: openPath });
                  toast('File attached', openPath, 'success');
                }}
              >
                <AtSign size={13} /> Mention
              </button>
              <button className="btn sm" disabled={!dirty || saving} onClick={save} title="Save (Ctrl/⌘+S)">
                <Save size={13} /> Save
              </button>
            </>
          )}
        </div>
        <div className="editor-body">
          {!openPath && (
            <div className="empty">
              <div className="big">
                <Glyph emoji="📄" size={26} />
              </div>
              <p>Pick a file on the left to view or edit. This refreshes automatically when a bot changes the file.</p>
            </div>
          )}
          {openPath && file && file.path === openPath && IMAGE_EXT.test(openPath) && (
            <div className="image-view">
              <img src={`${api.rawUrl(project.id, openPath)}&v=${filesVersion}`} alt={openPath} />
            </div>
          )}
          {openPath && file && file.path === openPath && !IMAGE_EXT.test(openPath) && (file.binary || file.tooLarge) && (
            <div className="empty">
              <p>{file.tooLarge ? `File too large (${fmtBytes(file.size)}) to open here.` : 'This is a binary file and cannot be shown as text.'}</p>
            </div>
          )}
          {openPath && file && file.path === openPath && file.content !== undefined && (
            <CodeEditor
              path={openPath}
              value={text}
              onChange={(v) => {
                setText(v);
                setDirty(v !== file.content);
              }}
              onSave={save}
            />
          )}
        </div>
      </div>
    </div>
  );
}
