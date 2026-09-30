import type { BotStatus, PermissionLevel, ToolPart } from '../../shared/types';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

const pad = (n: number) => String(n).padStart(2, '0');

export function fmtClock(ts: number) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function isSameDay(a: number, b: number) {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** Sidebar-style time: 14:03 / 昨天 / 周三 / 9月3日 */
export function fmtShort(ts: number) {
  const now = Date.now();
  if (isSameDay(ts, now)) return fmtClock(ts);
  if (isSameDay(ts, now - 86_400_000)) return '昨天';
  const d = new Date(ts);
  if (now - ts < 6 * 86_400_000) return `周${'日一二三四五六'[d.getDay()]}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtDay(ts: number) {
  const now = Date.now();
  if (isSameDay(ts, now)) return '今天';
  if (isSameDay(ts, now - 86_400_000)) return '昨天';
  const d = new Date(ts);
  const w = `周${'日一二三四五六'[d.getDay()]}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${w}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? `${s % 60}秒` : ''}`;
  return `${Math.floor(m / 60)}小时${m % 60}分`;
}

export function fmtRelative(ts: number) {
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const unit = abs < 3_600_000 ? [60_000, '分钟'] : abs < 86_400_000 ? [3_600_000, '小时'] : [86_400_000, '天'];
  const n = Math.max(1, Math.round(abs / (unit[0] as number)));
  return diff >= 0 ? `${n} ${unit[1]}后` : `${n} ${unit[1]}前`;
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
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

export interface ToolInfo {
  icon: string;
  verb: string;
  target: string;
}

/** Human-readable description of a tool call. */
export function toolInfo(name: string, input: any, root?: string): ToolInfo {
  const fp = (p: unknown) => shortPath(String(p || ''), root);
  switch (name) {
    case 'Read':
      return { icon: '📖', verb: '读取', target: fp(input?.file_path) };
    case 'Write':
      return { icon: '📝', verb: '写入', target: fp(input?.file_path) };
    case 'Edit':
      return { icon: '✏️', verb: '编辑', target: fp(input?.file_path) };
    case 'MultiEdit':
      return { icon: '✏️', verb: '编辑', target: `${fp(input?.file_path)}${input?.edits?.length ? `（${input.edits.length} 处）` : ''}` };
    case 'NotebookEdit':
      return { icon: '📓', verb: '编辑笔记本', target: fp(input?.notebook_path) };
    case 'Bash':
      return { icon: '▶️', verb: '运行', target: trunc(input?.command, 80) };
    case 'BashOutput':
    case 'TaskOutput':
      return { icon: '📟', verb: '查看输出', target: '' };
    case 'KillShell':
    case 'KillBash':
      return { icon: '⏹', verb: '结束后台命令', target: '' };
    case 'Glob':
      return { icon: '🗂️', verb: '查找文件', target: trunc(input?.pattern) };
    case 'Grep':
      return { icon: '🔎', verb: '搜索', target: `“${trunc(input?.pattern, 40)}”` };
    case 'LS':
      return { icon: '🗂️', verb: '列出', target: fp(input?.path) };
    case 'WebFetch':
      return { icon: '🌐', verb: '访问', target: trunc(input?.url, 70) };
    case 'WebSearch':
      return { icon: '🌐', verb: '搜索网页', target: `“${trunc(input?.query, 40)}”` };
    case 'Task':
    case 'Agent':
      return { icon: '🧑‍🚀', verb: '派出子代理', target: trunc(input?.description || input?.prompt, 50) };
    case 'TodoWrite':
      return { icon: '✅', verb: '更新任务清单', target: '' };
    case 'Skill':
      return { icon: '⚡', verb: '使用技能', target: trunc(input?.skill || input?.name) };
    case 'ExitPlanMode':
      return { icon: '📋', verb: '提交方案', target: '' };
    case 'mcp__crew__preview_screenshot':
      return { icon: '📸', verb: '截图预览', target: `${input?.path || '当前页面'}${input?.device && input.device !== 'desktop' ? ` · ${input.device === 'mobile' ? '手机' : '平板'}` : ''}${input?.fullPage ? ' · 整页' : ''}` };
    case 'mcp__crew__preview_console':
      return { icon: '🩺', verb: '检查控制台', target: input?.path || '当前页面' };
    case 'mcp__crew__browser_act':
      return { icon: '🖱️', verb: '操作浏览器', target: `${input?.path ? input.path + ' · ' : ''}${input?.steps?.length || 0} 步` };
    case 'mcp__crew__dev_server':
      return { icon: '🚀', verb: '开发服务器', target: ({ start: '启动', stop: '停止', restart: '重启', status: '查看状态', logs: '查看日志' } as Record<string, string>)[input?.action] || '' };
    case 'mcp__crew__remember':
      return { icon: '🧠', verb: '记住', target: trunc(input?.note, 60) };
    case 'mcp__crew__notify_user':
      return { icon: '🔔', verb: '通知你', target: trunc(input?.title, 40) };
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...rest] = name.split('__');
        return { icon: '🧩', verb: `${server} ·`, target: rest.join('__') };
      }
      return { icon: '🔧', verb: name, target: '' };
  }
}

export function toolDuration(p: ToolPart) {
  if (!p.endedAt) return '';
  return fmtDuration(p.endedAt - p.startedAt);
}

export function statusLabel(s: BotStatus | undefined): { text: string; tone: 'idle' | 'busy' | 'wait' | 'error' | 'queued' } {
  if (!s || s.state === 'idle') return { text: '空闲', tone: 'idle' };
  switch (s.state) {
    case 'queued':
      return { text: '排队中', tone: 'queued' };
    case 'thinking':
      return { text: s.detail || '思考中…', tone: 'busy' };
    case 'tool': {
      const d = s.detail || '';
      const info = d.includes(' · ') ? null : toolInfo(d, {});
      return { text: info ? `${info.verb}中…` : d, tone: 'busy' };
    }
    case 'waiting':
      return { text: `等待你确认：${s.detail || ''}`, tone: 'wait' };
    case 'error':
      return { text: s.detail ? `出错：${s.detail}` : '出错了', tone: 'error' };
    default:
      return { text: '', tone: 'idle' };
  }
}

export const PERMISSION_INFO: Record<PermissionLevel, { label: string; icon: string; desc: string }> = {
  auto: { label: '全自动', icon: '🚀', desc: '自主改文件、跑命令；只有「必须确认」规则里的操作会问你' },
  edits: { label: '自动改文件', icon: '✏️', desc: '可直接修改项目文件；运行命令前先问你（白名单命令除外）' },
  ask: { label: '每步确认', icon: '✋', desc: '每次修改和命令都要你点头（白名单除外）' },
  review: { label: 'AI 审查员', icon: '🛡️', desc: '由 Claude Code 的 AI 审查员实时把关，高风险操作会被拦截' },
  plan: { label: '只读', icon: '👀', desc: '只能阅读和分析，给出方案，不改任何东西' },
};

export const EFFORT_OPTIONS = [
  { id: '', label: '默认' },
  { id: 'low', label: '低（最快）' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '很高' },
  { id: 'max', label: '最大' },
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
