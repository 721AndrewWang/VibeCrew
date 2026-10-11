import type { BotStatus, PermissionLevel, ToolPart } from '../../shared/types';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtClock(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isSameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Sidebar-style time: 14:03 / Yesterday / Wed / Sep 3 */
export function fmtShort(ts: number) {
  const now = Date.now();
  if (isSameDay(ts, now)) return fmtClock(ts);
  if (isSameDay(ts, now - 86_400_000)) return 'Yesterday';
  const d = new Date(ts);
  if (now - ts < 6 * 86_400_000) return WEEKDAYS[d.getDay()];
  if (d.getFullYear() === new Date().getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** "22:52" today, otherwise "Yesterday 22:52", "Mon 22:52", "Sep 3 22:52". */
export function fmtWhen(ts: number) {
  return isSameDay(ts, Date.now()) ? fmtClock(ts) : `${fmtShort(ts)} ${fmtClock(ts)}`;
}

export function fmtDay(ts: number) {
  const now = Date.now();
  if (isSameDay(ts, now)) return 'Today';
  if (isSameDay(ts, now - 86_400_000)) return 'Yesterday';
  const d = new Date(ts);
  const w = WEEKDAYS[d.getDay()];
  if (d.getFullYear() === new Date().getFullYear()) return `${w}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "claude-opus-5-5" → "Opus 5.5" (a date suffix dropped); other providers' model ids stay as they are. */
export function modelLabel(id: string | undefined): string {
  if (!id) return '';
  const m = id.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/i);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}${m[4] ? ' (1M)' : ''}`;
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "1 file" / "3 files". */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function fmtRelative(ts: number) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [60_000, 'minute'] : abs < 86_400_000 ? [3_600_000, 'hour'] : [86_400_000, 'day'];
  const n = Math.max(1, Math.round(abs / (unit[0] as number)));
  const label = `${n} ${unit[1]}${n === 1 ? '' : 's'}`;
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

/** Token counts: 950, 1.2k, 45k, 1.3M. */
export function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n?: number) {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function basename(p: string) {
  return p.split('/').filter(Boolean).pop() || p;
}

export function shortPath(p: string | undefined, root?: string) {
  if (!p) return '';
  let s = p;
  if (root && s.startsWith(root + '/')) s = s.slice(root.length + 1);
  const home = s.match(/^\/(home|Users)\/[^/]+/);
  if (home) s = '~' + s.slice(home[0].length);
  return s;
}

function trunc(s: unknown, n = 60) {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export interface ToolInfo {
  icon: string;
  verb: string;
  /** Progressive form for "busy" status lines, e.g. "Reading". */
  doing: string;
  target: string;
}

/** Human-readable description of a tool call. */
export function toolInfo(name: string, input: any, root?: string): ToolInfo {
  const fp = (p: unknown) => shortPath(String(p || ''), root);
  switch (name) {
    case 'Read':
      return { icon: '📖', verb: 'Read', doing: 'Reading', target: fp(input?.file_path) };
    case 'Write':
      return { icon: '📝', verb: 'Write', doing: 'Writing', target: fp(input?.file_path) };
    case 'Edit':
      return { icon: '✏️', verb: 'Edit', doing: 'Editing', target: fp(input?.file_path) };
    case 'MultiEdit':
      return { icon: '✏️', verb: 'Edit', doing: 'Editing', target: `${fp(input?.file_path)}${input?.edits?.length ? ` (${input.edits.length} edit${input.edits.length === 1 ? '' : 's'})` : ''}` };
    case 'NotebookEdit':
      return { icon: '📓', verb: 'Edit notebook', doing: 'Editing notebook', target: fp(input?.notebook_path) };
    case 'Bash':
      return { icon: '▶️', verb: 'Run', doing: 'Running', target: trunc(input?.command, 80) };
    case 'BashOutput':
    case 'TaskOutput':
      return { icon: '📟', verb: 'Check output', doing: 'Checking output', target: '' };
    case 'KillShell':
    case 'KillBash':
      return { icon: '⏹', verb: 'Stop background command', doing: 'Stopping background command', target: '' };
    case 'Glob':
      return { icon: '🗂️', verb: 'Find files', doing: 'Finding files', target: trunc(input?.pattern) };
    case 'Grep':
      return { icon: '🔎', verb: 'Search', doing: 'Searching', target: `“${trunc(input?.pattern, 40)}”` };
    case 'LS':
      return { icon: '🗂️', verb: 'List', doing: 'Listing', target: fp(input?.path) };
    case 'WebFetch':
      return { icon: '🌐', verb: 'Fetch', doing: 'Fetching', target: trunc(input?.url, 70) };
    case 'WebSearch':
      return { icon: '🌐', verb: 'Search web', doing: 'Searching the web', target: `“${trunc(input?.query, 40)}”` };
    case 'Task':
    case 'Agent':
      return { icon: '🧑‍🚀', verb: 'Spawn subagent', doing: 'Running subagent', target: trunc(input?.description || input?.prompt, 50) };
    case 'TodoWrite':
      return { icon: '✅', verb: 'Update todo list', doing: 'Updating todo list', target: '' };
    case 'Skill':
      return { icon: '⚡', verb: 'Use skill', doing: 'Using skill', target: trunc(input?.skill || input?.name) };
    case 'ExitPlanMode':
      return { icon: '📋', verb: 'Submit plan', doing: 'Submitting plan', target: '' };
    case 'mcp__crew__preview_screenshot':
      return {
        icon: '📸',
        verb: 'Screenshot preview',
        doing: 'Taking screenshot',
        target: `${input?.path || 'current page'}${input?.device && input.device !== 'desktop' ? ` · ${input.device === 'mobile' ? 'phone' : 'tablet'}` : ''}${input?.fullPage ? ' · full page' : ''}`,
      };
    case 'mcp__crew__preview_console':
      return { icon: '🩺', verb: 'Check console', doing: 'Checking console', target: input?.path || 'current page' };
    case 'mcp__crew__browser_act':
      return { icon: '🖱️', verb: 'Use browser', doing: 'Using browser', target: `${input?.path ? input.path + ' · ' : ''}${input?.steps?.length || 0} step${input?.steps?.length === 1 ? '' : 's'}` };
    case 'mcp__crew__dev_server':
      return {
        icon: '🚀',
        verb: 'Dev server',
        doing: 'Managing dev server',
        target: ({ start: 'start', stop: 'stop', restart: 'restart', status: 'status', logs: 'logs' } as Record<string, string>)[input?.action] || '',
      };
    case 'mcp__crew__remember':
      return { icon: '🧠', verb: 'Remember', doing: 'Saving memory', target: trunc(input?.note, 60) };
    case 'mcp__crew__notify_user':
      return { icon: '🔔', verb: 'Notify you', doing: 'Notifying you', target: trunc(input?.title, 40) };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { icon: '🧩', verb: `${server} ·`, doing: `Using ${server}`, target: rest.join('__') };
      }
      return { icon: '🔧', verb: name, doing: `Running ${name}`, target: '' };
  }
}

export function toolDuration(p: ToolPart) {
  if (!p.endedAt) return '';
  return fmtDuration(p.endedAt - p.startedAt);
}

export function statusLabel(s: BotStatus | undefined): { text: string; tone: 'idle' | 'busy' | 'wait' | 'error' | 'queued' } {
  if (!s || s.state === 'idle') return { text: 'Idle', tone: 'idle' };
  switch (s.state) {
    case 'queued':
      return { text: 'Queued', tone: 'queued' };
    case 'thinking':
      return { text: s.detail || 'Thinking…', tone: 'busy' };
    case 'tool': {
      const d = s.detail || '';
      const info = d.includes(' · ') ? null : toolInfo(d, {});
      return { text: info ? `${info.doing}…` : d, tone: 'busy' };
    }
    case 'waiting':
      return { text: `Waiting for your approval: ${s.detail || ''}`, tone: 'wait' };
    case 'error':
      return { text: s.detail ? `Error: ${s.detail}` : 'Something went wrong', tone: 'error' };
    default:
      return { text: '', tone: 'idle' };
  }
}

export const PERMISSION_INFO: Record<PermissionLevel, { label: string; icon: string; desc: string }> = {
  auto: { label: 'Full auto', icon: '🚀', desc: 'Edits files and runs commands without asking; only actions on the "Always ask" list need your approval' },
  edits: { label: 'Auto-edit files', icon: '✏️', desc: 'Edits project files directly; asks before running commands (except read-only and allowlisted ones)' },
  ask: { label: 'Ask every step', icon: '✋', desc: 'Every edit and command needs your OK (except allowlisted ones)' },
  review: { label: 'Auto (AI-reviewed)', icon: '🛡️', desc: "Like Claude Code's Auto mode: an AI reviewer lets safe actions through and blocks risky ones" },
  plan: { label: 'Read-only', icon: '👀', desc: 'Can only read, analyze, and propose a plan; changes nothing' },
};

export const EFFORT_OPTIONS = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'Low (fastest)' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

export function isMac() {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}
