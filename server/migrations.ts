// The data folder carries a schema version (settings.json → schemaVersion). Each change to the
// shape of the stored JSON is one entry below; on start the ones newer than the folder run in
// order, after the JSON files are backed up. Folder moves from the VibeCrew days are handled
// earlier, in config.ts, because they decide where the data folder is at all.

import fs from 'node:fs';
import path from 'node:path';

export interface Migration {
  /** The schema version this migration brings the folder up to. */
  version: number;
  title: string;
  run(home: string): void;
}

export const MIGRATIONS: Migration[] = [];

export const SCHEMA_VERSION = Math.max(1, ...MIGRATIONS.map((m) => m.version));

export class NewerDataError extends Error {
  constructor(found: number, supported: number) {
    super(`数据目录是更新版本的 Crew 写的（schema ${found}，这个版本最高支持 ${supported}）。请升级 Crew，或者换一个数据目录（CREW_HOME）。`);
  }
}

function readSettings(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Backs up the JSON files (not messages or worktrees) before a migration touches them. */
function backup(home: string, fromVersion: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(home, 'backups', `schema-${fromVersion}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(home)) if (f.endsWith('.json')) fs.copyFileSync(path.join(home, f), path.join(dir, f));
  return dir;
}

/**
 * Brings the data folder up to date. Returns the migrations that ran (none on a fresh or current
 * folder). Throws NewerDataError when the folder is ahead of this build.
 */
export function migrate(home: string, migrations: Migration[] = MIGRATIONS, target = SCHEMA_VERSION): Migration[] {
  const file = path.join(home, 'settings.json');
  const settings = readSettings(file);
  const fresh = !fs.existsSync(file);
  const from = fresh ? target : Number(settings.schemaVersion) || 0;
  if (from > target) throw new NewerDataError(from, target);
  const pending = migrations.filter((m) => m.version > from && m.version <= target).sort((a, b) => a.version - b.version);
  const stamp = (version: number) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...readSettings(file), schemaVersion: version }, null, 1));
    fs.renameSync(tmp, file);
  };
  if (pending.length) backup(home, from);
  for (const m of pending) {
    m.run(home);
    // Each step is stamped as it lands, so a crash in the middle resumes from the right place.
    stamp(m.version);
  }
  if (from < target && !fresh) stamp(target);
  return pending;
}
