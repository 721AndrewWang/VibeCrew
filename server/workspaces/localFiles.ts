import fs from 'node:fs';
import path from 'node:path';
import { gitWithInput, zList } from '../gitops';
import { gitIn } from '../projects';

/** The agents' own context and settings, often kept out of git: CLAUDE.md, AGENTS.md, .claude/. */
const AGENT_FILES = /(^|\/)(CLAUDE(\.local)?\.md|AGENTS\.md)$|(^|\/)\.claude\//;
/** Never worth copying: dependencies, caches and build output. */
const NOT_COPIED = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', '.next']);
const COPY_LIMIT = { files: 2000, bytes: 50 * 1024 * 1024 };
/** Dotfiles inside .claude/ are tools' state (e.g. a hook's pending-validation marker), not settings. */
const TOOL_STATE = /(^|\/)\.claude\/(.+\/)?\.[^/]+$/;

/**
 * Files a new worktree lacks because git ignores them, but the work needs: .env files, the agents'
 * context (CLAUDE.md, AGENTS.md, .claude/ settings, hooks and skills) and whatever the user keeps
 * locally through .git/info/exclude. Only files the new worktree ignores as well are copied:
 * anything else would be committed on the branch and merged back. Returns the top-level names.
 */
export async function copyLocalFiles(fromRepo: string, toRepo: string, prefix: string): Promise<string[]> {
  let entries: string[];
  try {
    // Whole ignored folders come as one "dir/" entry.
    entries = zList(await gitIn(fromRepo, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']));
  } catch {
    return [];
  }
  if (!entries.length) return [];
  // Which ignore file matched each entry: .git/info/exclude means the user keeps it locally on purpose.
  const localOnly = new Set<string>();
  const v = await gitWithInput(fromRepo, ['check-ignore', '-v', '-z', '--stdin'], entries.join('\0') + '\0').catch(() => ({ stdout: '', code: 1 }));
  const fields = v.stdout.split('\0');
  for (let i = 0; i + 3 < fields.length; i += 4) if (/(^|\/)info\/exclude$/.test(fields[i])) localOnly.add(fields[i + 3]);
  const envFile = (rel: string) => rel === `${prefix}${path.posix.basename(rel)}` && /^\.env(\..+)?$/.test(path.posix.basename(rel));
  const picked = entries.filter((e) => {
    const rel = e.replace(/\/$/, '');
    if (rel.split('/').some((part) => NOT_COPIED.has(part)) || TOOL_STATE.test(rel)) return false;
    return envFile(rel) || /^\.env(\..+)?$/.test(rel) || AGENT_FILES.test(e) || localOnly.has(e) || localOnly.has(rel);
  });

  // Folders become their files, within limits; tools' state files inside .claude/ stay behind.
  const files: string[] = [];
  let bytes = 0;
  const add = (rel: string) => {
    const abs = path.join(fromRepo, rel);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        const child = path.posix.join(rel, name);
        if (!NOT_COPIED.has(name) && !TOOL_STATE.test(child)) add(child);
      }
    } else if (st.isFile() && files.length < COPY_LIMIT.files && bytes + st.size <= COPY_LIMIT.bytes) {
      files.push(rel);
      bytes += st.size;
    }
  };
  for (const e of picked) add(e.replace(/\/$/, ''));
  if (!files.length) return [];

  const check = await gitWithInput(toRepo, ['check-ignore', '-z', '--stdin'], files.join('\0') + '\0').catch(() => ({ stdout: '', code: 1 }));
  const ignored = new Set(zList(check.stdout));
  const copied = new Set<string>();
  for (const rel of files) {
    const dest = path.join(toRepo, rel);
    if (!ignored.has(rel) || fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(fromRepo, rel), dest);
    const top = picked.find((e) => rel === e.replace(/\/$/, '') || rel.startsWith(e.endsWith('/') ? e : `${e}/`));
    copied.add(top || rel);
  }
  return [...copied].sort();
}
