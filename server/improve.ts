// Self-improvement, lightly: a model reads how the team actually did (turn costs, errors, what the
// adversarial reviewer refuted, approvals the user denied, a ledger of earlier proposals) and
// proposes small changes to the bots' setup. The user is the evaluator: nothing changes until a
// proposal is accepted, and every decision is kept so later proposals learn from it.
//
// The constraints follow what keeps self-improvement honest without a benchmark: few edits at a
// time, one field each, each tied to turns that really happened; prefer proposing nothing.

import { z } from 'zod';
import type { Bot, ChatMessage, ImprovableField, Improvement, ImprovementEffect, SkillDraft } from '../shared/types';
import { FAKE_AGENT } from './config';
import { updateBot } from './entities';
import { logger } from './log';
import { oneShot } from './oneShot';
import { HttpError } from './projects';
import { BotPatch } from './schemas';
import { skills } from './skills';
import { bots, chats, improvements, messages, uid } from './store';

const log = logger('improve');

/** At most this many proposals per run (the edit budget). */
export const MAX_PROPOSALS = 3;
/** A description edit may change at most this many lines: small, attributable steps. */
const MAX_DESCRIPTION_LINES = 8;
/** Recent turns the proposer sees. */
const RECENT_TURNS = 60;
/** Turns compared on each side of an accepted change. */
const EFFECT_WINDOW = 20;
/** Evidence must come from at least this many separate user requests: one incident is not a pattern. */
export const MIN_REQUESTS = 2;

/** What the analysis may propose; skills come from learnSkills.ts, one turn at a time. */
const FIELDS: Exclude<ImprovableField, 'skill'>[] = ['description', 'model', 'effort', 'permission', 'allowRules', 'askRules', 'editScope', 'freshSession', 'monthlyBudgetUsd'];
const FIELD_LABEL: Record<ImprovableField, string> = {
  description: '角色说明',
  model: '模型',
  effort: '思考强度',
  permission: '权限级别',
  allowRules: '自动允许',
  askRules: '必须确认',
  editScope: '只能修改的路径',
  freshSession: '每轮新会话',
  monthlyBudgetUsd: '每月预算',
  skill: '新技能',
};

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

interface Turn {
  chatId: string;
  chatTitle: string;
  msg: ChatMessage;
}

function recentTurns(limit = RECENT_TURNS): Turn[] {
  const out: Turn[] = [];
  for (const chat of chats.all()) for (const m of messages.sorted(chat.id)) if (m.role === 'bot' && m.botId && m.status !== 'streaming') out.push({ chatId: chat.id, chatTitle: chat.title, msg: m });
  return out.sort((a, b) => a.msg.ts - b.msg.ts).slice(-limit);
}

/** What the proposer reads: the team's setup, what happened, and what was decided before. */
export function evidencePack(): string {
  const team = bots.all();
  const turns = recentTurns();
  const lines: string[] = ['## 团队现在的设置'];
  for (const b of team) {
    lines.push(
      `### ${b.name}（id ${b.id}）：${b.title}`,
      `model=${b.model || '默认'} effort=${b.effort || '默认'} permission=${b.permission} freshSession=${!!b.freshSession} blindReview=${!!b.blindReview} editScope=${JSON.stringify(b.editScope || [])} monthlyBudgetUsd=${b.monthlyBudgetUsd ?? '不限'}`,
      `allowRules=${JSON.stringify(b.allowRules)}`,
      `askRules=${JSON.stringify(b.askRules)}`,
      `角色说明：\n${b.description}`,
    );
  }

  lines.push('', `## 最近 ${turns.length} 轮（从早到晚）。引用时用 [chatId/messageId]`);
  const names = new Map(team.map((b) => [b.id, b.name]));
  for (const { chatId, chatTitle, msg } of turns) {
    const meta = msg.meta || {};
    const approvals = (msg.parts || []).filter((p) => p.type === 'approval').map((p) => (p.type === 'approval' ? `${p.status}:${clip(p.title, 60)}（${p.because || ''}）` : ''));
    const toolErrors = (msg.parts || []).filter((p) => p.type === 'tool' && p.status === 'error').map((p) => (p.type === 'tool' ? p.name : ''));
    lines.push(
      `- [${chatId}/${msg.id}] ${names.get(msg.botId!) || '?'} 在「${chatTitle}」 状态=${msg.status} 费用=$${(meta.costUsd || 0).toFixed(3)} 模型=${meta.model || '?'}` +
        (meta.verdict ? ` 证伪结论=推翻${meta.verdict.refuted}条` : '') +
        (approvals.length ? ` 审批=${approvals.join('；')}` : '') +
        (toolErrors.length ? ` 工具出错=${toolErrors.join('、')}` : '') +
        (msg.error ? ` 错误=${clip(msg.error, 120)}` : ''),
      `  回复开头：${clip(msg.text || '', 240)}`,
    );
  }

  const refutations = turns.filter((t) => t.msg.meta?.verdict?.refuted).slice(-4);
  if (refutations.length) {
    lines.push('', '## 对抗审查推翻的内容（原文）');
    for (const t of refutations) lines.push(`### [${t.chatId}/${t.msg.id}]`, (t.msg.text || '').slice(-2500));
  }

  const asks: string[] = [];
  for (const chat of chats.all()) for (const m of messages.sorted(chat.id).slice(-30)) if (m.role === 'user') asks.push(`- [${chat.id}/${m.id}] ${clip(m.text, 200)}`);
  if (asks.length) lines.push('', '## 用户最近说的话（看有没有在纠正机器人）', ...asks.slice(-20));

  const decided = improvements
    .all()
    .filter((i) => i.status !== 'pending')
    .slice(-20);
  if (decided.length) {
    lines.push('', '## 以前的建议和用户的决定（不要重复被拒绝的）');
    for (const i of decided) lines.push(`- ${i.botName} 的 ${FIELD_LABEL[i.field]} → ${clip(JSON.stringify(i.after), 160)}：${i.status}${i.note ? `（用户说：${i.note}）` : ''}`);
  }
  return lines.join('\n');
}

const PROPOSAL = z.object({
  bot: z.string(),
  field: z.enum(FIELDS as [Exclude<ImprovableField, 'skill'>, ...Exclude<ImprovableField, 'skill'>[]]),
  after: z.unknown(),
  rationale: z.string().min(1).max(1500),
  expected: z.string().max(500).default(''),
  evidence: z.array(z.object({ ref: z.string(), note: z.string().max(300).default('') })).min(1),
});

function prompt(pack: string): string {
  return [
    '你在帮一个 AI 机器人小队变得更好。下面是团队的设置和最近真实发生的情况。',
    `提出最多 ${MAX_PROPOSALS} 条对机器人设置的修改建议。规则：`,
    '- 每条只改一个机器人的一个字段：' + FIELDS.map((f) => `${f}（${FIELD_LABEL[f]}）`).join('、') + '。',
    `- 改动要小，能看出是哪一处起作用：description 最多改 ${MAX_DESCRIPTION_LINES} 行，其余保持原样；列表字段给出完整的新列表。`,
    '- 每条都要引用至少一轮真实发生的事作为证据（[chatId/messageId]），说明哪里出了问题、改了之后应该变好什么。',
    `- 只为反复出现的问题提建议：证据必须来自至少 ${MIN_REQUESTS} 个不同的用户请求，同一件事拆成几条证据不算。一个问题只提一条建议，不要把一次事故扩散成好几条。没有值得改的就返回空数组，这比硬凑好。`,
    '- 不要重复用户拒绝过的建议。不要为了省钱牺牲正确性（比如把审查的角色换成太弱的模型）。',
    '',
    '只回复 JSON 数组，不要别的文字。格式：',
    '[{"bot":"机器人名字或 id","field":"字段","after":新的值,"rationale":"为什么，指向证据","expected":"应该变好什么","evidence":[{"ref":"chatId/messageId","note":"这一轮发生了什么"}]}]',
    '',
    pack,
  ].join('\n');
}

/** Lines that differ between two texts (a rough size of a description edit). */
function changedLines(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  const sx = new Set(x);
  const sy = new Set(y);
  return x.filter((l) => !sy.has(l)).length + y.filter((l) => !sx.has(l)).length;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * How many separate user requests the evidence comes from: each cited message counts as the
 * user message it answers (the last one before it in its chat), or itself if it is one.
 */
export function requestsBehind(evidence: { chatId: string; messageId: string }[]): number {
  const requests = new Set<string>();
  for (const e of evidence) {
    const list = messages.sorted(e.chatId);
    const m = list.find((x) => x.id === e.messageId);
    if (!m) continue;
    const asked = m.role === 'user' ? m : list.filter((x) => x.role === 'user' && x.seq < m.seq).at(-1);
    requests.add(`${e.chatId}/${asked?.id ?? m.id}`);
  }
  return requests.size;
}

/** Checks one proposal from the model; returns the stored improvement or why it was dropped. */
export function vetProposal(raw: unknown): Improvement | string {
  const p = PROPOSAL.safeParse(raw);
  if (!p.success) return `格式不对：${p.error.issues[0]?.message}`;
  const { field, rationale, expected } = p.data;
  const bot = bots.get(p.data.bot) || bots.all().find((b) => b.name.toLowerCase() === p.data.bot.toLowerCase());
  if (!bot) return `没有叫 ${p.data.bot} 的机器人`;
  const check = BotPatch.shape[field].safeParse(p.data.after);
  if (!check.success) return `${field} 的新值不合法`;
  const after = check.data;
  const before = (bot as unknown as Record<string, unknown>)[field];
  if (same(before, after)) return '和现在一样';
  if (field === 'description' && changedLines(String(before || ''), String(after)) > MAX_DESCRIPTION_LINES * 2) return '角色说明改得太多';
  const evidence = p.data.evidence
    .map((e) => {
      const [chatId, messageId] = e.ref.replace(/[[\]]/g, '').split('/');
      return messages.get(chatId, messageId) ? { chatId, messageId, note: e.note } : null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e);
  if (!evidence.length) return '引用的证据不存在';
  if (requestsBehind(evidence) < MIN_REQUESTS) return `证据只来自同一个请求（至少要 ${MIN_REQUESTS} 个不同的请求），一次的事不算规律`;
  const dup = improvements.all().find((i) => i.botId === bot.id && i.field === field && same(i.after, after) && (i.status === 'pending' || i.status === 'rejected'));
  if (dup) return dup.status === 'pending' ? '已经有一样的建议' : '用户拒绝过一样的建议';
  return { id: uid('i_'), createdAt: Date.now(), botId: bot.id, botName: bot.name, field, before: before ?? null, after, rationale, expected, evidence, status: 'pending' };
}

function parseProposals(text: string): unknown[] {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) throw new HttpError(502, '模型没有按格式给出建议');
  const arr = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new HttpError(502, '模型没有按格式给出建议');
  return arr;
}

/** The demo agent's stand-in: the costliest resumed bot is proposed to start fresh each turn. */
function fakeProposals(): unknown[] {
  const turns = recentTurns();
  const cost = new Map<string, { sum: number; n: number; refs: string[] }>();
  for (const t of turns) {
    const c = cost.get(t.msg.botId!) || { sum: 0, n: 0, refs: [] };
    c.sum += t.msg.meta?.costUsd || 0;
    c.n += 1;
    c.refs = [...c.refs, `${t.chatId}/${t.msg.id}`].slice(-2);
    cost.set(t.msg.botId!, c);
  }
  const top = [...cost.entries()].filter(([id]) => bots.get(id) && !bots.get(id)!.freshSession).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)[0];
  if (!top) return [];
  return [
    { bot: top[0], field: 'freshSession', after: true, rationale: '演示：这个机器人平均每轮最贵。', expected: '每轮费用下降', evidence: top[1].refs.map((ref) => ({ ref, note: '最近的一轮' })) },
  ];
}

/** Runs the proposer once and stores what survives vetting. */
export async function proposeImprovements(): Promise<{ added: Improvement[]; dropped: string[]; costUsd: number }> {
  if (!recentTurns().length) throw new HttpError(409, '还没有机器人干过活，没有可以分析的东西');
  let raw: unknown[];
  let costUsd = 0;
  if (FAKE_AGENT) raw = fakeProposals();
  else {
    const r = await oneShot(prompt(evidencePack()), { model: 'sonnet', timeoutMs: 240_000 }).catch((e: Error) => {
      throw new HttpError(502, `没能生成建议：${e.message}`);
    });
    costUsd = r.costUsd;
    raw = parseProposals(r.text);
  }
  const added: Improvement[] = [];
  const dropped: string[] = [];
  for (const p of raw.slice(0, MAX_PROPOSALS)) {
    const v = vetProposal(p);
    if (typeof v === 'string') dropped.push(v);
    else {
      improvements.set(v);
      added.push(v);
    }
  }
  if (raw.length > MAX_PROPOSALS) dropped.push(`超出每次 ${MAX_PROPOSALS} 条的上限，多出的 ${raw.length - MAX_PROPOSALS} 条没看`);
  log.info(`proposed ${added.length}, dropped ${dropped.length}: ${dropped.join('; ')}`);
  return { added, dropped, costUsd };
}

function requireImprovement(id: string): Improvement {
  const i = improvements.get(id);
  if (!i) throw new HttpError(404, '没有这条建议');
  return i;
}

export function acceptImprovement(id: string): { improvement: Improvement; bot?: Bot } {
  const i = requireImprovement(id);
  if (i.status !== 'pending') throw new HttpError(409, '这条建议已经处理过了');
  if (i.field === 'skill') {
    const draft = i.after as SkillDraft;
    if (skills.get(draft.name)) {
      i.status = 'stale';
      i.decidedAt = Date.now();
      improvements.set(i);
      throw new HttpError(409, `已经有叫 ${draft.name} 的技能了，这条建议作废。`);
    }
    skills.save({ name: draft.name, title: draft.title, description: draft.description, icon: draft.icon, argsHint: draft.argsHint, body: draft.body });
    i.status = 'accepted';
    i.decidedAt = Date.now();
    improvements.set(i);
    return { improvement: i };
  }
  const bot = bots.get(i.botId);
  if (!bot) throw new HttpError(404, '机器人已经不在了');
  // Changed by hand since the proposal: applying it would overwrite that.
  if (!same((bot as unknown as Record<string, unknown>)[i.field] ?? null, i.before)) {
    i.status = 'stale';
    i.decidedAt = Date.now();
    improvements.set(i);
    throw new HttpError(409, `${bot.name} 的${FIELD_LABEL[i.field]}在建议之后被改过了，这条建议作废。`);
  }
  const updated = updateBot(bot.id, { [i.field]: i.after } as never);
  i.status = 'accepted';
  i.decidedAt = Date.now();
  improvements.set(i);
  return { improvement: i, bot: updated };
}

export function rejectImprovement(id: string, note?: string): Improvement {
  const i = requireImprovement(id);
  if (i.status !== 'pending') throw new HttpError(409, '这条建议已经处理过了');
  i.status = 'rejected';
  i.decidedAt = Date.now();
  if (note?.trim()) i.note = note.trim().slice(0, 500);
  improvements.set(i);
  return i;
}

export function revertImprovement(id: string): { improvement: Improvement; bot?: Bot } {
  const i = requireImprovement(id);
  if (i.status !== 'accepted') throw new HttpError(409, '只有接受过的建议能撤回');
  if (i.field === 'skill') {
    skills.remove((i.after as SkillDraft).name);
    i.status = 'reverted';
    improvements.set(i);
    return { improvement: i };
  }
  const bot = bots.get(i.botId);
  if (!bot) throw new HttpError(404, '机器人已经不在了');
  const updated = updateBot(bot.id, { [i.field]: i.before ?? (Array.isArray(i.after) ? [] : null) } as never);
  i.status = 'reverted';
  improvements.set(i);
  return { improvement: i, bot: updated };
}

/** Before and after an accepted change: the bot's turns on each side, same count at most. */
export function effectOf(i: Improvement): ImprovementEffect | null {
  if (i.status !== 'accepted' || !i.decidedAt || i.field === 'skill') return null;
  const turns = recentTurns(Number.MAX_SAFE_INTEGER).filter((t) => t.msg.botId === i.botId);
  const stats = (list: Turn[]) => ({
    turns: list.length,
    avgCostUsd: list.length ? list.reduce((s, t) => s + (t.msg.meta?.costUsd || 0), 0) / list.length : 0,
    refuted: list.filter((t) => t.msg.meta?.verdict?.refuted).length,
    errors: list.filter((t) => t.msg.status === 'error').length,
  });
  const after = turns.filter((t) => t.msg.ts > i.decidedAt!).slice(0, EFFECT_WINDOW);
  const before = turns.filter((t) => t.msg.ts <= i.decidedAt!).slice(-EFFECT_WINDOW);
  return { before: stats(before), after: stats(after) };
}

export function listImprovements() {
  const items = improvements.all().sort((a, b) => b.createdAt - a.createdAt);
  return { items, effects: Object.fromEntries(items.map((i) => [i.id, effectOf(i)]).filter(([, e]) => e)) as Record<string, ImprovementEffect> };
}
