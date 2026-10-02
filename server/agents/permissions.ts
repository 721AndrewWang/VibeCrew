import path from 'node:path';
import type { Bot, PermissionLevel } from '../../shared/types';

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
/** Tools without side effects; Claude Code normally runs them without asking. */
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'BashOutput', 'TaskOutput', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

/** The outcome and, in words the user sees, what settled it. */
export type Decision = { behavior: 'allow'; because: string } | { behavior: 'ask'; because: string } | { behavior: 'deny'; message: string; because: string };

export const LEVEL_LABEL: Record<PermissionLevel, string> = { auto: '全自动', edits: '自动改文件', ask: '每步确认', review: '自动（AI 把关）', plan: '只读' };

function parseRule(rule: string): { tool: string; spec?: string } {
  const m = rule.trim().match(/^([^()]+?)(?:\((.*)\))?$/);
  if (!m) return { tool: rule.trim() };
  return { tool: m[1].trim(), spec: m[2]?.trim() };
}

function wildcard(spec: string): RegExp {
  // Legacy "prefix:*" means "starts with prefix".
  let s = spec.endsWith(':*') ? spec.slice(0, -2) + '*' : spec;
  s = s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${s}$`, 's');
}

export function glob(spec: string): RegExp {
  let s = '';
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === '*' && spec[i + 1] === '*') {
      s += '.*';
      i++;
      if (spec[i + 1] === '/') i++;
    } else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${s}$`);
}

/** Splits a shell command into its simple commands (quote-aware enough for rule checks). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote && cmd[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function filePathOf(input: any): string | undefined {
  return input?.file_path || input?.notebook_path || input?.path;
}

function matchOne(rule: string, toolName: string, input: any, cwd: string, segment?: string): boolean {
  const { tool, spec } = parseRule(rule);
  if (tool.startsWith('mcp__')) return toolName === tool || toolName.startsWith(tool + '__');
  const sameTool = tool === toolName || (tool === 'Edit' && EDIT_TOOLS.has(toolName));
  if (!sameTool) return false;
  if (!spec || spec === '*') return true;
  if (toolName === 'Bash') return wildcard(spec).test(segment ?? String(input?.command || '').trim());
  if (EDIT_TOOLS.has(toolName) || toolName === 'Read') {
    const fp = filePathOf(input);
    if (!fp) return false;
    const abs = path.resolve(cwd, fp);
    const rel = path.relative(cwd, abs).split(path.sep).join('/');
    const pattern = spec.replace(/^\.\//, '');
    if (path.isAbsolute(pattern) || pattern.startsWith('~')) return glob(pattern.replace(/^~/, process.env.HOME || '~')).test(abs);
    return !rel.startsWith('..') && glob(pattern).test(rel);
  }
  if (toolName === 'WebFetch') {
    const m = spec.match(/^domain:(.+)$/);
    if (!m) return false;
    try {
      const host = new URL(String(input?.url)).hostname;
      return host === m[1] || host.endsWith('.' + m[1]);
    } catch {
      return false;
    }
  }
  return true;
}

/** True when the rules cover the whole action (every part of a compound shell command). */
/** Commands that only read or print, and cannot write files themselves. */
const HELPERS = new Set(['cd', 'pwd', 'true', 'false', 'echo', 'printf', 'head', 'tail', 'wc', 'cut', 'tr', 'nl', 'cat', 'basename', 'dirname', 'date', 'column', 'grep', 'ls']);

/**
 * A part of a command that needs no rule: a helper above, without command substitution or output
 * written to a file (2>&1 and /dev/null are fine).
 */
export function harmless(seg: string): boolean {
  const s = seg.trim().replace(/\s*(\d?>&\d|&?\d?>{1,2}\s*\/dev\/null)/g, '');
  if (!s || /[`>]|\$\(/.test(s)) return false;
  return HELPERS.has(s.split(/\s+/)[0]);
}

export function rulesAllow(rules: string[], toolName: string, input: any, cwd: string): boolean {
  if (!rules.length) return false;
  if (toolName === 'Bash') {
    const segs = splitCommand(String(input?.command || '')).filter((seg) => seg.trim());
    // `cd dir; git log | head`: only git log needs a rule.
    return segs.length > 0 && segs.every((seg) => harmless(seg) || rules.some((r) => matchOne(r, toolName, input, cwd, seg)));
  }
  return rules.some((r) => matchOne(r, toolName, input, cwd));
}

/** The first rule that matches any part of the action, or null. */
export function matchingRule(rules: string[], toolName: string, input: any, cwd: string): string | null {
  if (!rules.length) return null;
  if (toolName === 'Bash') {
    const segs = splitCommand(String(input?.command || ''));
    for (const seg of segs) for (const r of rules) if (matchOne(r, toolName, input, cwd, seg)) return r;
    return null;
  }
  return rules.find((r) => matchOne(r, toolName, input, cwd)) ?? null;
}

/** True when any rule matches any part of the action. */
export function rulesTouch(rules: string[], toolName: string, input: any, cwd: string): boolean {
  return matchingRule(rules, toolName, input, cwd) !== null;
}

export function insideDir(dir: string, p: string | undefined): boolean {
  if (!p) return false;
  const root = path.resolve(dir);
  const abs = path.resolve(root, p);
  return abs === root || abs.startsWith(root + path.sep);
}

/**
 * Crew's approval gate. Claude Code has already applied the bot's allow/ask rules
 * (passed as settings); this sees whatever it would have prompted for.
 * `projectRules` are the project's own must-ask rules, named apart from the bot's.
 */
export function decide(bot: Bot, level: PermissionLevel, toolName: string, input: any, cwd: string, opts: { matchedAskRule?: unknown; projectRules?: string[] }): Decision {
  const mode = `权限是「${LEVEL_LABEL[level]}」`;
  if (toolName.startsWith('mcp__crew__')) return { behavior: 'allow', because: 'Crew 自己的工具' };
  if (READ_ONLY.has(toolName) && !opts.matchedAskRule) return { behavior: 'allow', because: '只读操作' };
  if (toolName === 'ExitPlanMode' && level === 'plan') {
    return { behavior: 'deny', message: '你是只读角色，不能执行修改。请直接在回复中给出方案或结论，由用户或队友来实施。', because: `${mode}，不能开始修改` };
  }
  // A role's lane: edits outside it are refused, so the work goes to the teammate whose lane it is.
  if (
    EDIT_TOOLS.has(toolName) &&
    bot.editScope?.length &&
    !rulesAllow(
      bot.editScope.map((g) => `Edit(${g})`),
      toolName,
      input,
      cwd,
    )
  ) {
    const scope = bot.editScope.join('、');
    return {
      behavior: 'deny',
      message: `这个文件不在你负责的范围内（你只能修改：${scope}）。不要用命令行绕过去改它；请 @ 负责它的队友来改，或者让用户在你的设置里调整「只能修改的路径」。`,
      because: `角色范围只包括 ${scope}`,
    };
  }
  const botRule = matchingRule(bot.askRules, toolName, input, cwd);
  if (botRule) return { behavior: 'ask', because: `机器人的「必须确认」规则 ${botRule}` };
  const projectRule = opts.projectRules?.length ? matchingRule(opts.projectRules, toolName, input, cwd) : null;
  if (projectRule) return { behavior: 'ask', because: `项目的「必须确认」规则 ${projectRule}` };
  if (opts.matchedAskRule) return { behavior: 'ask', because: `Claude Code 设置里的 ask 规则 ${String(opts.matchedAskRule)}` };
  // Only reading and printing (cd, cat, head, echo…): no need to ask when edits are allowed anyway.
  if (toolName === 'Bash' && (level === 'edits' || level === 'review')) {
    const segs = splitCommand(String(input?.command || '')).filter((seg) => seg.trim());
    if (segs.length && segs.every(harmless)) return { behavior: 'allow', because: `${mode}，这条命令只读取和打印` };
  }
  // Rules added with "always allow" during this session.
  const allowRule = matchingRule(bot.allowRules, toolName, input, cwd);
  if (allowRule && rulesAllow(bot.allowRules, toolName, input, cwd)) return { behavior: 'allow', because: `「总是允许」规则 ${allowRule}` };
  switch (level) {
    case 'auto':
      return { behavior: 'allow', because: mode };
    case 'edits':
      if (EDIT_TOOLS.has(toolName)) {
        return insideDir(cwd, filePathOf(input)) ? { behavior: 'allow', because: `${mode}，文件在项目里` } : { behavior: 'ask', because: `${mode}，但这个文件在项目外` };
      }
      if (WEB_TOOLS.has(toolName)) return { behavior: 'allow', because: `${mode}，联网查资料不改东西` };
      return allowRule ? { behavior: 'ask', because: `${mode}；「总是允许」规则 ${allowRule} 只覆盖了命令的一部分` } : { behavior: 'ask', because: `${mode}，运行命令要先问` };
    default:
      return { behavior: 'ask', because: allowRule ? `${mode}；「总是允许」规则 ${allowRule} 只覆盖了命令的一部分` : mode };
  }
}

export function permissionModeFor(level: PermissionLevel): 'default' | 'acceptEdits' | 'plan' | 'auto' {
  switch (level) {
    case 'edits':
      return 'acceptEdits';
    case 'review':
      return 'auto';
    case 'plan':
      return 'plan';
    default:
      return 'default';
  }
}

function short(s: string, n = 80) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Title and details for an approval card. */
export function describeAction(toolName: string, input: any, cwd: string): { title: string; detail?: string } {
  const rel = (p?: string) => (p ? path.relative(cwd, path.resolve(cwd, p)) || '.' : '');
  switch (toolName) {
    case 'Bash':
      return { title: input?.description ? `运行命令：${short(input.description, 60)}` : '运行命令', detail: String(input?.command || '') };
    case 'Write':
      return {
        title: `写入文件 ${rel(input?.file_path)}`,
        detail: String(input?.content || '')
          .split('\n')
          .slice(0, 40)
          .join('\n'),
      };
    case 'Edit':
      return {
        title: `修改文件 ${rel(input?.file_path)}`,
        detail: `- ${String(input?.old_string || '')
          .split('\n')
          .join('\n- ')}\n+ ${String(input?.new_string || '')
          .split('\n')
          .join('\n+ ')}`,
      };
    case 'MultiEdit':
      return { title: `修改文件 ${rel(input?.file_path)}（${input?.edits?.length || 0} 处）` };
    case 'NotebookEdit':
      return { title: `修改笔记本 ${rel(input?.notebook_path)}` };
    case 'WebFetch':
      return { title: `访问网页 ${short(String(input?.url || ''), 70)}`, detail: input?.prompt };
    case 'WebSearch':
      return { title: `搜索网页「${short(String(input?.query || ''), 50)}」` };
    case 'Read':
      return { title: `读取文件 ${rel(input?.file_path)}` };
    default:
      if (toolName.startsWith('mcp__')) {
        const [, server, ...rest] = toolName.split('__');
        return { title: `使用插件 ${server} · ${rest.join('__')}`, detail: JSON.stringify(input, null, 2).slice(0, 2000) };
      }
      return { title: `使用工具 ${toolName}`, detail: JSON.stringify(input, null, 2).slice(0, 2000) };
  }
}

/** The rule "always allow" adds for this action. */
/** The rule for one simple command, e.g. "git log --oneline" → Bash(git log*). */
function commandRule(seg: string): string | undefined {
  // Leading VAR=value assignments are not the command.
  const tokens = seg.trim().split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return undefined;
  if (/^(npm|pnpm|yarn|bun)$/.test(tokens[0]) && tokens[1] === 'run' && tokens[2]) return `Bash(${tokens.slice(0, 3).join(' ')}*)`;
  if (/^(npm|pnpm|yarn|bun|npx|bunx|uv|uvx|git|node|python3?|pip3?|docker|cargo|go|make)$/.test(tokens[0]) && tokens[1] && !tokens[1].startsWith('-')) return `Bash(${tokens[0]} ${tokens[1]}*)`;
  return `Bash(${tokens[0]}*)`;
}

/**
 * What "always allow" should add. For a compound command that is one rule per command it runs
 * (helpers like cd or head need none): a rule for its first command alone would not cover the rest.
 */
export function suggestRules(toolName: string, input: any, cwd: string): string[] {
  if (toolName !== 'Bash') {
    const r = suggestRule(toolName, input, cwd);
    return r ? [r] : [];
  }
  const segs = splitCommand(String(input?.command || '')).filter((seg) => seg.trim());
  const needed = segs.filter((seg) => !harmless(seg));
  return [...new Set((needed.length ? needed : segs.slice(0, 1)).map(commandRule).filter((r): r is string => !!r))];
}

export function suggestRule(toolName: string, input: any, cwd: string): string | undefined {
  if (toolName === 'Bash') {
    const first = splitCommand(String(input?.command || '')).find((seg) => seg.trim());
    return first ? commandRule(first) : undefined;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const fp = filePathOf(input);
    if (!fp || insideDir(cwd, fp)) return 'Edit';
    return `Edit(${path.dirname(path.resolve(cwd, fp))}/**)`;
  }
  if (toolName === 'WebFetch') {
    try {
      return `WebFetch(domain:${new URL(String(input?.url)).hostname})`;
    } catch {
      return 'WebFetch';
    }
  }
  return toolName;
}
