// Time arithmetic and "how long ago" for prompts. Pure.

export const HOUR = 3_600_000;

/** Start of the local day `now` falls in. */
export function startOfDay(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** How long ago, as a prompt says it: seconds, then minutes, then hours. */
export function ago(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/** The same, in days from two days on: recalled objects can be old. */
export function agoLong(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 172_800 ? ago(at, now) : `${Math.round(s / 86_400)} days ago`;
}
