import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { bus, internal } from './bus';
import { projects } from './store';
import { decorate, detectFramework, HEAVY_DIRS } from './projects';

interface Watch {
  watcher: FSWatcher;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
  gitLog: string;
  gitSize: number;
}

const watches = new Map<string, Watch>();

function ignored(root: string) {
  return (p: string) => {
    const rel = path.relative(root, p);
    if (!rel || rel.startsWith('..')) return false;
    return rel.split(path.sep).some((seg) => HEAVY_DIRS.has(seg) || seg === '.DS_Store');
  };
}

/** Starts watching a project's files (idempotent). */
export function ensureWatch(projectId: string) {
  if (watches.has(projectId)) return;
  const project = projects.get(projectId);
  if (!project || !fs.existsSync(project.path)) return;
  const root = path.resolve(project.path);
  const watcher = chokidar.watch(root, { ignored: ignored(root), ignoreInitial: true, persistent: true });
  const w: Watch = { watcher, pending: new Set(), timer: null, gitLog: path.join(root, '.git', 'logs', 'HEAD'), gitSize: -1 };
  watches.set(projectId, w);

  const flush = () => {
    w.timer = null;
    const paths = [...w.pending];
    w.pending.clear();
    if (!paths.length) return;
    if (paths.includes('package.json')) {
      // The dev command and framework may have changed.
      const p = projects.get(projectId);
      if (p) {
        p.framework = detectFramework(p.path);
        projects.save();
        bus.emit({ t: 'project', project: decorate(p) });
      }
    }
    internal.emit('files', projectId, paths);
    bus.emit({ t: 'files_changed', projectId, paths });
  };
  watcher.on('all', (_event, p) => {
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (!rel) return;
    w.pending.add(rel);
    if (!w.timer) w.timer = setTimeout(flush, 120);
  });
  watcher.on('error', (e) => console.warn(`[watch] ${project.name}:`, (e as Error).message));

  // Commits append a "commit:" line to the reflog.
  try {
    w.gitSize = fs.statSync(w.gitLog).size;
  } catch {
    w.gitSize = -1;
  }
  fs.watchFile(w.gitLog, { interval: 2000 }, (cur) => {
    const grew = cur.size > w.gitSize && w.gitSize >= 0;
    const prev = w.gitSize;
    w.gitSize = cur.size;
    if (!grew && !(prev < 0 && cur.size > 0)) return;
    try {
      const lines = fs.readFileSync(w.gitLog, 'utf8').trim().split('\n');
      if (/\tcommit/.test(lines[lines.length - 1] || '')) internal.emit('commit', projectId);
    } catch {
      /* ignore */
    }
  });
}

export async function stopWatch(projectId: string) {
  const w = watches.get(projectId);
  if (!w) return;
  watches.delete(projectId);
  fs.unwatchFile(w.gitLog);
  await w.watcher.close();
}

export async function stopAllWatches() {
  await Promise.all([...watches.keys()].map(stopWatch));
}
