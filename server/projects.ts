import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Chat, Project } from '../shared/types';
import { bus } from './bus';
import { PROJECT_TEMPLATES, slugify } from './data/projectTemplates';
import { cleanDomains } from './sandbox';
import { projects, settings, uid } from './store';

const run = promisify(execFile);

/** Directories that are listed lazily and never watched. */
export const HEAVY_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.cache',
  '.turbo',
  '.vercel',
  'coverage',
  '.parcel-cache',
  'test-results',
  'playwright-report',
]);

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getProject(id: string | null | undefined): Project {
  const p = projects.get(id);
  if (!p) throw new HttpError(404, 'Project not found');
  return p;
}

/** The project a chat's bots work in: its isolated workspace when it has one, otherwise its project. */
export function chatProjectId(chat: Chat | null | undefined): string | null {
  if (!chat) return null;
  if (chat.workspaceId && projects.has(chat.workspaceId)) return chat.workspaceId;
  return chat.projectId;
}

/** Where a project's dev command and static root are configured: a workspace follows its parent. */
/** Where a project's settings live: a workspace uses its parent's. */
export function configOf(project: Project): Project {
  return (project.workspace && projects.get(project.workspace.parentId)) || project;
}

/** Resolves a project-relative path, refusing anything outside the project. */
export function resolveInProject(project: Project, rel: string): string {
  const root = path.resolve(project.path);
  const abs = path.resolve(root, rel.replace(/^[/\\]+/, ''));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'Path is outside the project folder');
  return abs;
}

export function relInProject(project: Project, abs: string): string | null {
  const root = path.resolve(project.path);
  const full = path.resolve(root, abs);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return path.relative(root, full).split(path.sep).join('/');
}

function readPackageJson(dir: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function detectFramework(dir: string): string {
  const pkg = readPackageJson(dir);
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return 'Next.js';
    if (deps.nuxt) return 'Nuxt';
    if (deps['@sveltejs/kit']) return 'SvelteKit';
    if (deps.astro) return 'Astro';
    if (deps['@remix-run/react'] || (deps['react-router'] && deps['@react-router/dev'])) return 'React Router';
    if (deps.vite) {
      if (deps.react) return 'Vite + React';
      if (deps.vue) return 'Vite + Vue';
      if (deps.svelte) return 'Vite + Svelte';
      if (deps['solid-js']) return 'Vite + Solid';
      return 'Vite';
    }
    if (deps['react-scripts']) return 'Create React App';
    if (deps['@angular/core']) return 'Angular';
    return 'Node.js';
  }
  if (fs.existsSync(path.join(dir, 'index.html'))) return 'Static site';
  return 'Unknown';
}

export function packageManager(dir: string): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

/** The command that starts the project's dev server, or null for static projects. */
export function devCommand(project: Project): string | null {
  const configured = configOf(project).devCommand;
  if (configured === 'static') return null;
  if (configured) return configured;
  const pkg = readPackageJson(project.path);
  const scripts = pkg?.scripts || {};
  const pm = packageManager(project.path);
  const runCmd = pm === 'npm' ? 'npm run' : pm;
  if (scripts.dev) return `${runCmd} dev`;
  if (scripts.start && !/node\s|nodemon/.test(scripts.start)) return pm === 'npm' ? 'npm start' : `${pm} start`;
  if (scripts.serve) return `${runCmd} serve`;
  return null;
}

export function needsInstall(project: Project): boolean {
  return !!readPackageJson(project.path) && !fs.existsSync(path.join(project.path, 'node_modules'));
}

export function staticRoot(project: Project): string {
  const configured = configOf(project).staticRoot;
  if (configured) return resolveInProject(project, configured);
  if (!fs.existsSync(path.join(project.path, 'index.html')) && fs.existsSync(path.join(project.path, 'public', 'index.html'))) {
    return path.join(project.path, 'public');
  }
  return project.path;
}

/** A project as sent to the browser, with its detected dev command. */
export function decorate(p: Project): Project {
  let dev: string | null = null;
  try {
    dev = devCommand(p);
  } catch {
    /* folder gone */
  }
  return { ...p, devDetected: dev };
}

/** The user's projects, without the chats' isolated workspaces. */
export function listProjects(): Project[] {
  return projects
    .all()
    .filter((p) => !p.workspace)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Everything the browser needs to know about, workspaces included. */
export function allProjects(): Project[] {
  return projects.all().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function touchProject(id: string) {
  const p = projects.get(id);
  if (!p) return;
  p.updatedAt = Date.now();
  projects.save();
}

export function openExistingProject(dir: string, name?: string): Project {
  const abs = path.resolve(dir.replace(/^~(?=$|\/)/, process.env.HOME || '~'));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new HttpError(400, `Folder doesn't exist: ${abs}`);
  const existing = listProjects().find((p) => path.resolve(p.path) === abs);
  if (existing) return existing;
  const now = Date.now();
  const project: Project = {
    id: uid('p_'),
    name: name?.trim() || path.basename(abs),
    path: abs,
    createdAt: now,
    updatedAt: now,
    framework: detectFramework(abs),
  };
  projects.set(project);
  bus.emit({ t: 'project', project: decorate(project) });
  return project;
}

export async function createProject(input: { name: string; template: string; parentDir?: string; folder?: string }): Promise<Project> {
  const tpl = PROJECT_TEMPLATES.find((t) => t.id === input.template) || PROJECT_TEMPLATES[0];
  const title = input.name.trim() || 'My site';
  const root = path.resolve(input.parentDir || settings.get().projectsRoot);
  fs.mkdirSync(root, { recursive: true });
  const base = slugify(input.folder || '') || slugify(title) || `site-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  let dir = path.join(root, base);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(root, `${base}-${i}`);
  for (const [rel, content] of Object.entries(tpl.files(title))) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  try {
    await run('git', ['init', '-q'], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '-q', '-m', 'Initialize project (Crew)'], { cwd: dir });
  } catch {
    /* git missing or no identity configured; the project still works */
  }
  return openExistingProject(dir, title);
}

type ProjectPatch = Partial<
  Pick<Project, 'name' | 'devCommand' | 'staticRoot' | 'setupCommand' | 'commitGuide' | 'noAttribution' | 'askRules' | 'allowedDomains' | 'requireChallenge' | 'autoChallenge'>
>;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) || undefined : undefined);

export function updateProject(id: string, patch: ProjectPatch): Project {
  const p = getProject(id);
  if (p.workspace) throw new HttpError(400, "Workspaces use the original project's settings; change them in the original project");
  if (patch.name !== undefined) p.name = patch.name.trim() || p.name;
  if (patch.devCommand !== undefined) p.devCommand = patch.devCommand.trim() || undefined;
  if (patch.staticRoot !== undefined) p.staticRoot = patch.staticRoot.trim() || undefined;
  if (patch.setupCommand !== undefined) p.setupCommand = text(patch.setupCommand, 2000);
  if (patch.commitGuide !== undefined) p.commitGuide = text(patch.commitGuide, 2000);
  if (patch.noAttribution !== undefined) p.noAttribution = patch.noAttribution === true || undefined;
  if (patch.requireChallenge !== undefined) p.requireChallenge = patch.requireChallenge === true || undefined;
  if (patch.autoChallenge !== undefined) {
    const paths = [...new Set(patch.autoChallenge.paths.map((x) => x.trim()).filter(Boolean))];
    p.autoChallenge = { enabled: patch.autoChallenge.enabled, paths, minLines: patch.autoChallenge.minLines };
  }
  if (patch.askRules !== undefined) {
    const rules = Array.isArray(patch.askRules) ? patch.askRules.map((r) => text(r, 300)).filter((r): r is string => !!r) : [];
    p.askRules = rules.length ? [...new Set(rules)].slice(0, 50) : undefined;
  }
  if (patch.allowedDomains !== undefined) {
    const domains = cleanDomains(patch.allowedDomains);
    p.allowedDomains = domains.length ? domains : undefined;
  }
  p.framework = detectFramework(p.path);
  p.updatedAt = Date.now();
  projects.set(p);
  bus.emit({ t: 'project', project: decorate(p) });
  // Workspaces use their parent's dev command and static root.
  for (const w of projects.all()) if (w.workspace?.parentId === p.id) bus.emit({ t: 'project', project: decorate(w) });
  return p;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  heavy?: boolean;
}

export function listDir(project: Project, rel = ''): TreeEntry[] {
  const abs = resolveInProject(project, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const out: TreeEntry[] = [];
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.DS_Store') continue;
    const childRel = rel ? `${rel.replace(/\/$/, '')}/${e.name}` : e.name;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(abs, e.name)).isDirectory();
      } catch {
        continue;
      }
    }
    if (isDir) out.push({ name: e.name, path: childRel, type: 'dir', heavy: HEAVY_DIRS.has(e.name) || undefined });
    else {
      let size: number | undefined;
      try {
        size = fs.statSync(path.join(abs, e.name)).size;
      } catch {
        /* broken link */
      }
      out.push({ name: e.name, path: childRel, type: 'file', size });
    }
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function readProjectFile(project: Project, rel: string): { path: string; content?: string; binary?: boolean; size: number; tooLarge?: boolean } {
  const abs = resolveInProject(project, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new HttpError(400, 'This is a folder');
  if (st.size > 2 * 1024 * 1024) return { path: rel, size: st.size, tooLarge: true };
  const buf = fs.readFileSync(abs);
  if (isBinary(buf)) return { path: rel, size: st.size, binary: true };
  return { path: rel, content: buf.toString('utf8'), size: st.size };
}

export function writeProjectFile(project: Project, rel: string, content: string) {
  const abs = resolveInProject(project, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export function projectTemplates() {
  return PROJECT_TEMPLATES.map(({ id, name, description, needsInstall }) => ({ id, name, description, needsInstall }));
}

export async function git(project: Project, args: string[]): Promise<string> {
  return gitIn(project.path, args);
}

export async function gitIn(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: dir, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

export async function gitStatus(project: Project) {
  try {
    const inside = (await git(project, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
    if (!inside) return { repo: false as const };
  } catch {
    return { repo: false as const };
  }
  const branch = (await git(project, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  const porcelain = await git(project, ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-uall']);
  const files = porcelain
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).replace(/^"|"$/g, '') }));
  const log = await git(project, ['log', '-8', '--pretty=format:%h%x09%s%x09%cr']).catch(() => '');
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, subject, when] = l.split('\t');
      return { hash, subject, when };
    });
  return { repo: true as const, branch, files, commits };
}
