// Crew's own writes to a project (git operations on a workspace, a workspace's setup command,
// undoing a turn) are not edits someone made outside the chat. They mark the project quiet while
// they run and a moment after, as file events trail the writes.

const until = new Map<string, number>();
const active = new Map<string, number>();
const TRAIL_MS = 4000;

/** Runs `work` with the projects marked quiet, and keeps them quiet a little after it settles. */
export async function quietly<T>(projectIds: (string | null | undefined)[], work: () => Promise<T> | T): Promise<T> {
  const ids = [...new Set(projectIds.filter((p): p is string => !!p))];
  for (const id of ids) active.set(id, (active.get(id) || 0) + 1);
  try {
    return await work();
  } finally {
    for (const id of ids) {
      const n = (active.get(id) || 1) - 1;
      if (n) active.set(id, n);
      else active.delete(id);
      until.set(id, Date.now() + TRAIL_MS);
    }
  }
}

export function isQuiet(projectId: string): boolean {
  return active.has(projectId) || Date.now() < (until.get(projectId) || 0);
}
