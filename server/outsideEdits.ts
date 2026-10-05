// Edits made outside the chat (by hand, in another editor, in Crew's own editor, by git) leave
// the bots working from what the chat last said. When files change while no bot is working in the
// project and Crew is not writing itself, a note goes into the project's chats: which files, and
// for text files what changed, so later turns and blind reviewers start from the files as they are.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { internal } from './bus';
import { devServer } from './devserver';
import { projectBusy, systemMessage } from './orchestrator';
import { chatProjectId } from './projects';
import { isQuiet } from './quietWrites';
import { chats, projects } from './store';
import { ensureWatch } from './watcher';

/** Changes settle for this long before the note goes out, so a burst of saves is one note. */
const SETTLE_MS = 3000;
const MAX_TEXT = 200_000;
const MAX_FILES = 10;
const MAX_DIFFS = 3;
const MAX_LINES = 12;

interface Pending {
  timer: NodeJS.Timeout | null;
  /** path -> content before this burst (null: unknown or new), and whether Crew's editor wrote it. */
  files: Map<string, { before: string | null; editor: boolean }>;
}

/**
 * Paths that change without anyone editing them:
 * - Claude Code's sandbox mounts placeholders over protected paths (.claude/ settings, hooks and
 *   skills, .mcp.json, shell and git dotfiles, the .vscode and .idea editor folders) for each
 *   sandboxed command and removes them after, in whatever folder the command runs in.
 * - Atomic writes go through a temporary "<file>.tmp.<pid>.<hex>" that is renamed over the file.
 */
const NOT_EDITS = [
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.mcp\.json$/,
  /(^|\/)\.(vscode|idea)(\/|$)/,
  /(^|\/)\.(bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zshenv|zprofile|zlogin|gitconfig|gitmodules|ripgreprc)$/,
  /\.tmp\.\d+\.[0-9a-f]+$/,
];

export function notAnEdit(rel: string): boolean {
  return NOT_EDITS.some((re) => re.test(rel));
}

/** Last content seen per project and path, so an outside edit can be shown as a change. */
const seen = new Map<string, Map<string, string>>();
const pending = new Map<string, Pending>();
const editorWrites = new Map<string, number>();

/** Crew's code editor is about to save this file: the note says so. */
export function noteEditorWrite(projectId: string, rel: string) {
  editorWrites.set(`${projectId}:${rel.replace(/^\/+/, '')}`, Date.now());
}

function readText(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_TEXT) return null;
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** The committed version, when there is no earlier sighting. */
function committed(root: string, rel: string): string | null {
  try {
    return execFileSync('git', ['show', `HEAD:./${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_TEXT * 2 });
  } catch {
    return null;
  }
}

/** The changed region of two texts: first to last differing line, as removed and added lines. */
export function lineChange(before: string, after: string): { line: number; removed: string[]; added: string[] } | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { line: start + 1, removed: a.slice(start, endA + 1), added: b.slice(start, endB + 1) };
}

function describe(rel: string, before: string | null, after: string | null): string {
  if (after === null) return `- ${rel}：改了（不是文本文件，或者太大）`;
  // Neither seen before nor committed: a new file, or one Crew has no earlier copy of.
  if (before === null) return `- ${rel}：新文件，或者之前没有记录过的文件（${after.split('\n').length} 行）`;
  const c = lineChange(before, after);
  if (!c) return `- ${rel}：内容没变`;
  const cut = (xs: string[], sign: string) => [...xs.slice(0, MAX_LINES).map((l) => `    ${sign} ${l}`), ...(xs.length > MAX_LINES ? [`    …另外 ${xs.length - MAX_LINES} 行`] : [])];
  return [`- ${rel} 第 ${c.line} 行起：`, ...cut(c.removed, '-'), ...cut(c.added, '+')].join('\n');
}

function flush(projectId: string) {
  const p = pending.get(projectId);
  pending.delete(projectId);
  const project = projects.get(projectId);
  if (!p || !project || !p.files.size) return;
  const root = path.resolve(project.path);
  const entries = [...p.files.entries()];
  const lines: string[] = [];
  entries.slice(0, MAX_FILES).forEach(([rel, f], i) => {
    const after = readText(path.join(root, rel));
    const gone = !fs.existsSync(path.join(root, rel));
    if (i < MAX_DIFFS) lines.push(gone ? `- ${rel}：删除了` : describe(rel, f.before, after));
    else lines.push(`- ${rel}${gone ? '（删除了）' : ''}`);
  });
  if (entries.length > MAX_FILES) lines.push(`…另外 ${entries.length - MAX_FILES} 个文件`);
  const byEditor = entries.every(([, f]) => f.editor);
  const who = byEditor ? '用户在 Crew 的编辑器里改了文件' : '有文件在聊天之外被改了（不是这个对话里的机器人改的，可能是用户手动改的，或者别的程序、git 操作）';
  const text = `${who}：\n${lines.join('\n')}\n以文件现在的内容为准；如果和聊天里之前的要求不一致，按现在的文件来，拿不准就先问用户。`;
  for (const chat of chats.all()) if (chatProjectId(chat) === projectId) systemMessage(chat, text, { notice: 'outside-edit' });
}

function onFiles(projectId: string, paths: string[]) {
  const project = projects.get(projectId);
  if (!project) return;
  const root = path.resolve(project.path);
  let known = seen.get(projectId);
  if (!known) {
    known = new Map();
    seen.set(projectId, known);
  }
  // Bots at work, Crew's own writes and dependency installs are not outside edits: just keep up.
  const crewWriting = projectBusy(projectId) || isQuiet(projectId) || devServer(projectId).state.status === 'installing';
  for (const rel of paths) {
    if (notAnEdit(rel)) continue;
    const abs = path.join(root, rel);
    // Folders come and go with their files; the files are what the note is about.
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) continue;
    const now = readText(abs);
    if (!crewWriting) {
      let p = pending.get(projectId);
      if (!p) {
        p = { timer: null, files: new Map() };
        pending.set(projectId, p);
      }
      if (!p.files.has(rel)) {
        const before = known.has(rel) ? known.get(rel)! : committed(root, rel);
        const editor = Date.now() - (editorWrites.get(`${projectId}:${rel}`) || 0) < 10_000;
        p.files.set(rel, { before, editor });
      }
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => flush(projectId), SETTLE_MS);
    }
    if (now === null) known.delete(rel);
    else known.set(rel, now);
  }
}

/** Starts listening, and watching every project a chat works in; called once at startup. */
export function startOutsideEditNotes() {
  internal.on('files', onFiles);
  for (const chat of chats.all()) {
    const id = chatProjectId(chat);
    if (id) ensureWatch(id);
  }
}
