import fs from 'node:fs';
import path from 'node:path';
import type { TurnFile, TurnRecord, TurnSummary } from '../../shared/types';
import { DATA } from '../config';
import { isBinary } from '../projects';

const MAX_SNAPSHOT = 1024 * 1024;

type Snapshot = { content: string | null; binary?: boolean; tooLarge?: boolean };

function snapshot(abs: string): Snapshot {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { content: null };
    if (st.size > MAX_SNAPSHOT) return { content: null, tooLarge: true };
    const buf = fs.readFileSync(abs);
    if (isBinary(buf)) return { content: null, binary: true };
    return { content: buf.toString('utf8') };
  } catch {
    return { content: null };
  }
}

function turnDir(chatId: string) {
  return path.join(DATA.turns, chatId);
}

/** Tracks the files one bot turn touches so the turn can be reviewed and undone. */
export class TurnRecorder {
  readonly record: TurnRecord;
  private files = new Map<string, TurnFile>();

  constructor(
    opts: { id: string; chatId: string; botId: string; messageId: string; projectId: string },
    private root: string,
  ) {
    this.record = { ...opts, startedAt: Date.now(), files: [] };
  }

  private rel(p: string): string | null {
    const abs = path.resolve(this.root, p);
    const root = path.resolve(this.root);
    if (!abs.startsWith(root + path.sep)) return null;
    return path.relative(root, abs).split(path.sep).join('/');
  }

  /** Called before an edit tool runs. */
  beforeEdit(filePath: string | undefined) {
    if (!filePath) return;
    const rel = this.rel(filePath);
    if (!rel || this.files.has(rel)) return;
    const s = snapshot(path.join(this.root, rel));
    this.files.set(rel, { path: rel, before: s.binary || s.tooLarge ? undefined : s.content, binary: s.binary, tooLarge: s.tooLarge, source: 'tool' });
  }

  /** Files that changed on disk during the turn (e.g. by a shell command). */
  watched(paths: string[]) {
    for (const rel of paths) {
      if (this.files.has(rel)) continue;
      this.files.set(rel, { path: rel, before: undefined, source: 'watch' });
    }
  }

  finish(): TurnRecord | null {
    this.record.endedAt = Date.now();
    const files: TurnFile[] = [];
    for (const f of this.files.values()) {
      const abs = path.join(this.root, f.path);
      let isDir = false;
      try {
        isDir = fs.statSync(abs).isDirectory();
      } catch {
        /* deleted */
      }
      if (isDir) continue;
      const s = snapshot(abs);
      const after = s.binary || s.tooLarge ? undefined : s.content;
      if (f.source === 'tool' && f.before !== undefined && f.before === after) continue;
      if (f.source === 'watch' && f.before === undefined && after === null && !fs.existsSync(abs)) {
        // Created and removed again within the turn (temp files).
        continue;
      }
      files.push({ ...f, after, binary: f.binary || s.binary, tooLarge: f.tooLarge || s.tooLarge });
    }
    if (!files.length) return null;
    this.record.files = files.sort((a, b) => a.path.localeCompare(b.path));
    fs.mkdirSync(turnDir(this.record.chatId), { recursive: true });
    fs.writeFileSync(path.join(turnDir(this.record.chatId), `${this.record.id}.json`), JSON.stringify(this.record));
    return this.record;
  }
}

export function summarize(t: TurnRecord): TurnSummary {
  return {
    ...t,
    files: t.files.map((f) => ({
      path: f.path,
      source: f.source,
      status: f.before === undefined ? 'unknown' : f.before === null ? 'added' : f.after === null ? 'deleted' : 'modified',
    })),
  };
}

export function loadTurn(chatId: string, turnId: string): TurnRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(turnDir(chatId), `${turnId}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export function listTurns(chatId: string): TurnSummary[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(turnDir(chatId)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((n) => loadTurn(chatId, n.slice(0, -5)))
    .filter((t): t is TurnRecord => !!t)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(summarize);
}

export function deleteTurns(chatId: string) {
  fs.rmSync(turnDir(chatId), { recursive: true, force: true });
}

export function turnFileDiff(chatId: string, turnId: string, rel: string) {
  const t = loadTurn(chatId, turnId);
  const f = t?.files.find((x) => x.path === rel);
  if (!t || !f) return null;
  return { path: rel, before: f.before, after: f.after, binary: f.binary, tooLarge: f.tooLarge, source: f.source };
}

/**
 * Restores the files of a turn. Files edited again since the turn are reported as conflicts
 * and left alone unless force is set.
 */
export function revertTurn(chatId: string, turnId: string, root: string, force = false) {
  const t = loadTurn(chatId, turnId);
  if (!t) throw new Error('找不到这一轮的记录');
  const reverted: string[] = [];
  const conflicts: string[] = [];
  const skipped: string[] = [];
  for (const f of t.files) {
    const abs = path.join(root, f.path);
    if (f.before === undefined) {
      skipped.push(f.path);
      continue;
    }
    const now = snapshot(abs);
    const current = now.binary || now.tooLarge ? undefined : now.content;
    if (!force && f.after !== undefined && current !== f.after) {
      conflicts.push(f.path);
      continue;
    }
    if (f.before === null) fs.rmSync(abs, { force: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, f.before);
    }
    reverted.push(f.path);
  }
  if (!conflicts.length) {
    t.reverted = true;
    fs.writeFileSync(path.join(turnDir(chatId), `${turnId}.json`), JSON.stringify(t));
  }
  return { turn: t, reverted, conflicts, skipped };
}
