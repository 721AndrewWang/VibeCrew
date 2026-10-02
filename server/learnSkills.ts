// Learning skills from experience, the Hermes Agent way, but gated: a turn that took real work and
// was not refuted becomes a candidate; a draft is written only on request; a fixed safety screen
// blocks or flags what it finds; and nothing is saved until the user accepts it in the improvement
// panel. "Practice Makes Unsafe" (Mao et al., 2026) found every self-evolving setup they tested
// wrote unsafe skills: evolution optimises for the task getting done, not for the procedure being
// safe, so a lucky unsafe success becomes lasting policy.

import { z } from 'zod';
import type { ChatMessage, Improvement, SkillCandidate, SkillDraft } from '../shared/types';
import { matchingRule } from './agents/permissions';
import { FAKE_AGENT } from './config';
import { DEFAULT_ASK_RULES } from './data/catalog';
import { oneShot } from './oneShot';
import { COMPLEX_TURN_TOOLS } from './orchestrator';
import { lineChange } from './outsideEdits';
import { chatProjectId, configOf, HttpError } from './projects';
import { ALWAYS_ALLOWED, cleanDomains } from './sandbox';
import { skills } from './skills';
import { bots, chats, improvements, messages, projects, settings, uid } from './store';

const WINDOW_MS = 30 * 24 * 3600_000;
const MAX_CANDIDATES = 10;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const toolCalls = (m: ChatMessage) => (m.parts || []).filter((p) => p.type === 'tool');

/**
 * What the turn was asked to do: the teammate's handover when it was handed one (the user's last
 * message may have been addressed to someone else), else the user's last message before it.
 */
function taskOf(list: ChatMessage[], turn: ChatMessage): string {
  const before = list.filter((m) => m.seq < turn.seq);
  const user = before.filter((m) => m.role === 'user').at(-1);
  const userText = user?.prompt || user?.text || '';
  if (turn.trigger?.type === 'mention' && turn.trigger.by) {
    const handover = before.filter((m) => m.role === 'bot' && m.botId === turn.trigger!.by).at(-1);
    const by = bots.get(turn.trigger.by)?.name || '队友';
    if (handover) return `${by} 交代的任务：${handover.text.trim()}${userText ? `\n（用户最近说的：${userText}）` : ''}`;
  }
  return userText;
}

/** Recent turns worth learning from, newest first: done, complex, not refuted afterwards, not drafted yet. */
export function skillCandidates(now = Date.now()): SkillCandidate[] {
  const drafted = new Set(
    improvements
      .all()
      .filter((i) => i.field === 'skill' && i.evidence[0])
      .map((i) => i.evidence[0].messageId),
  );
  const out: SkillCandidate[] = [];
  for (const chat of chats.all()) {
    const list = messages.sorted(chat.id);
    list.forEach((m, i) => {
      if (m.role !== 'bot' || m.status !== 'done' || !m.botId || now - m.ts > WINDOW_MS || drafted.has(m.id)) return;
      const bot = bots.get(m.botId);
      if (!bot || bot.blindReview || toolCalls(m).length < COMPLEX_TURN_TOOLS) return;
      // Refuted by a later review in the same chat: not a procedure to repeat.
      if (list.slice(i + 1).some((x) => (x.meta?.verdict?.refuted || 0) > 0)) return;
      out.push({ chatId: chat.id, messageId: m.id, chatTitle: chat.title, botName: bot.name, ask: taskOf(list, m).slice(0, 300), tools: toolCalls(m).length, at: m.ts });
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_CANDIDATES);
}

const DRAFT = z.object({
  name: z.string(),
  title: z.string().max(60),
  description: z.string().max(300),
  argsHint: z.string().max(100).default(''),
  body: z.string().min(1).max(8000),
});

/** Phrases that try to override the bot's instructions: never part of a saved skill. */
const OVERRIDE =
  /忽略(之前|以上|前面|上面)?的?(所有|全部)?(指令|要求|规则|设置)|无视(之前|以上)?的?(指令|规则)|ignore (all |any )?(previous|prior|above) instructions|disregard (all |any )?(previous|prior) /i;

/**
 * The fixed screen a draft goes through. Blocking: a deny-list command, an instruction override.
 * Flagged for the user: must-ask commands, hosts the sandbox would not reach.
 */
export function screenSkill(body: string, ctx: { denyRules: string[]; askRules: string[]; allowedHosts: string[] }): { blocked: string | null; flags: string[] } {
  if (OVERRIDE.test(body)) return { blocked: '技能里有要求忽略其他指令的话', flags: [] };
  // Commands: inline `code` and the lines of fenced blocks.
  const commands = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) commands.add(m[1].trim());
  for (const block of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) if (line.trim()) commands.add(line.trim().replace(/^\$\s*/, ''));
  const flags: string[] = [];
  for (const command of commands) {
    const denied = matchingRule(ctx.denyRules, 'Bash', { command }, '/');
    if (denied) return { blocked: `技能里有被禁止的命令：${command}（规则 ${denied}）`, flags: [] };
    const ask = matchingRule(ctx.askRules, 'Bash', { command }, '/');
    if (ask) flags.push(`包含需要确认的命令：${command}`);
  }
  const allowed = ctx.allowedHosts;
  for (const m of body.matchAll(/https?:\/\/([a-z0-9.-]+)(:\d+)?/gi)) {
    const host = m[1].toLowerCase();
    const ok = allowed.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d.replace(/:\d+$/, '')));
    if (!ok) flags.push(`访问沙盒名单外的地址：${host}`);
  }
  return { blocked: null, flags: [...new Set(flags)] };
}

/**
 * What the user taught by deciding on earlier drafts: why some were turned down, and what was
 * changed in the ones accepted after editing. The next draft must not repeat either.
 */
export function rejectedSkillNotes(limit = 10): string[] {
  const lessons: string[] = [];
  const decided = improvements
    .all()
    .filter((i) => i.field === 'skill' && i.decidedAt)
    .sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0));
  for (const i of decided) {
    const name = (i.after as SkillDraft).name;
    if (i.status === 'rejected' && i.note) lessons.push(`- 拒绝了 /${name}：${i.note}`);
    else if (i.status === 'accepted' && i.original) {
      const c = lineChange((i.original as SkillDraft).body, (i.after as SkillDraft).body);
      if (c) lessons.push(`- /${name} 用户改过再接受：删掉「${c.removed.slice(0, 3).join(' / ').slice(0, 200)}」，改成「${c.added.slice(0, 3).join(' / ').slice(0, 200)}」`);
    }
    if (lessons.length >= limit) break;
  }
  return lessons;
}

export function draftPrompt(ask: string, turn: ChatMessage, existing: string[], rejected: string[] = rejectedSkillNotes()): string {
  const steps = toolCalls(turn)
    .map((p, i) => (p.type === 'tool' ? `${i + 1}. ${p.name}${p.status === 'error' ? '（出错）' : ''}：${JSON.stringify(p.input).slice(0, 300)}` : ''))
    .join('\n');
  return [
    '下面是一个 AI 机器人成功完成的一轮工作。判断其中的做法是否值得写成一个以后能复用的「技能」（一段指导机器人做同类事情的说明），值得就写出来。',
    '要求：',
    '- 写成通用的步骤，不要写死这次的文件名、内容或数据；可变的部分用 {{args}} 表示用户调用时给的参数。',
    '- 只写这一轮真正做了、而且做成了的事；出错又绕过去的步骤不要写进去。',
    '- 不要包含密钥、账号、具体的服务器地址；不要包含任何「忽略其他指令」之类的话。',
    '- 用中文写，简洁，步骤清楚，最后写怎样算做完。',
    `- 已有的技能：${existing.join('、') || '（无）'}。和已有的重复，或者这一轮只是一次性的事，就回复 {"skip": "理由"}。`,
    ...(rejected.length ? ['- 用户以前对技能草稿的决定（拒绝的理由、接受前改掉的地方），新写的不能再犯同样的问题：', ...rejected] : []),
    '- 这一轮里如果有被用户纠正、或者后来证明是错的做法，不要写进去。',
    '',
    '只回复 JSON：{"name": "kebab-case 英文名，最多 40 个字符", "title": "中文标题", "description": "一句话说明什么时候用", "argsHint": "参数提示", "body": "技能内容"}',
    '',
    `## 这一轮的任务\n${ask || '（没有记录）'}`,
    `## 这一轮调用的工具\n${steps}`,
    `## 机器人最后的回复\n${(turn.text || '').slice(0, 1500)}`,
  ].join('\n');
}

/** The rules a draft is screened against: the deny list, must-ask rules and sandbox hosts of where it was learned. */
function screenContext(chatId: string, botId: string) {
  const chat = chats.get(chatId);
  const project = projects.get(chatProjectId(chat));
  const conf = project ? configOf(project) : null;
  const sb = settings.get().sandbox;
  return {
    denyRules: settings.get().denyRules || [],
    askRules: [...new Set([...DEFAULT_ASK_RULES, ...(bots.get(botId)?.askRules || []), ...(conf?.askRules || [])])],
    allowedHosts: [...ALWAYS_ALLOWED, ...cleanDomains(sb.allowedDomains), ...cleanDomains(conf?.allowedDomains || [])],
  };
}

export const DraftEdit = z.object({
  name: z.string().max(40),
  title: z.string().min(1).max(60),
  description: z.string().max(300),
  argsHint: z.string().max(100),
  body: z.string().min(1).max(8000),
});

/**
 * The user's own version of a pending draft. It goes through the same screen (a blocked edit is
 * refused, flags are recomputed), and the model's version is kept as `original`, so the ledger shows
 * what the user changed.
 */
export function editSkillDraft(id: string, edit: z.infer<typeof DraftEdit>): Improvement {
  const i = improvements.get(id);
  if (!i) throw new HttpError(404, '没有这条建议');
  if (i.field !== 'skill') throw new HttpError(400, '只有技能草稿可以在接受前修改');
  if (i.status !== 'pending') throw new HttpError(409, '这条建议已经处理过了');
  const name = edit.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, '技能名只能用小写字母、数字和连字符，最多 40 个字符');
  if (skills.get(name)) throw new HttpError(409, `已经有叫 ${name} 的技能了`);
  const ev = i.evidence[0];
  const screen = screenSkill(edit.body, screenContext(ev?.chatId || '', i.botId));
  if (screen.blocked) throw new HttpError(400, `安全检查没通过：${screen.blocked}`);
  const prev = i.after as SkillDraft;
  if (!i.original) i.original = prev;
  i.after = { ...prev, name, title: edit.title.trim(), description: edit.description.trim(), argsHint: edit.argsHint.trim(), body: edit.body.trim(), flags: screen.flags } satisfies SkillDraft;
  i.editedAt = Date.now();
  improvements.set(i);
  return i;
}

/** Writes a draft for one candidate turn and stores it as a pending proposal. */
export async function draftSkill(chatId: string, messageId: string): Promise<{ improvement: Improvement; costUsd: number } | { skipped: string; costUsd: number }> {
  const chat = chats.get(chatId);
  const turn = messages.get(chatId, messageId);
  if (!chat || !turn || turn.role !== 'bot' || !turn.botId) throw new HttpError(404, '没有这一轮');
  if (!skillCandidates().some((c) => c.messageId === messageId)) throw new HttpError(409, '这一轮不能（或者已经）用来起草技能');
  const ask = taskOf(messages.sorted(chatId), turn);
  const existing = skills.list().map((s) => s.name);

  let raw: unknown;
  let costUsd = 0;
  if (FAKE_AGENT) {
    raw = {
      name: 'demo-page',
      title: '做一个演示页面',
      description: '演示：从一轮工作学来的技能',
      argsHint: '页面主题',
      body: `1. 先看项目结构。\n2. 按 {{args}} 写页面。\n3. 截图确认。\n用户原话：${ask}`,
    };
  } else {
    const r = await oneShot(draftPrompt(ask, turn, existing), { model: 'sonnet', timeoutMs: 180_000 }).catch((e: Error) => {
      throw new HttpError(502, `没能起草技能：${e.message}`);
    });
    costUsd = r.costUsd;
    const body = r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      raw = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    } catch {
      throw new HttpError(502, '模型没有按格式起草技能');
    }
  }
  const skip = (raw as { skip?: string })?.skip;
  if (skip) return { skipped: String(skip).slice(0, 300), costUsd };
  const d = DRAFT.safeParse(raw);
  if (!d.success) throw new HttpError(502, '模型起草的技能格式不对');
  const name = d.data.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(502, `技能名不合法：${name}`);
  if (skills.get(name)) return { skipped: `已经有叫 ${name} 的技能了`, costUsd };

  const bot = bots.get(turn.botId)!;
  const screen = screenSkill(d.data.body, screenContext(chatId, bot.id));
  if (screen.blocked) return { skipped: `安全检查没通过：${screen.blocked}`, costUsd };

  const draft: SkillDraft = { name, title: d.data.title, description: d.data.description, icon: '⚡', argsHint: d.data.argsHint, body: d.data.body, flags: screen.flags };
  const improvement: Improvement = {
    id: uid('i_'),
    createdAt: Date.now(),
    botId: bot.id,
    botName: bot.name,
    field: 'skill',
    before: null,
    after: draft,
    rationale: `从「${chat.title}」里 ${bot.name} 的一轮学来：调用了 ${toolCalls(turn).length} 次工具，顺利完成，之后没有被对抗审查推翻。`,
    expected: '以后做同类事情时用 /' + name + ' 调用，少走弯路',
    evidence: [{ chatId, messageId, note: ask.slice(0, 120) || '那一轮' }],
    status: 'pending',
  };
  improvements.set(improvement);
  return { improvement, costUsd };
}
