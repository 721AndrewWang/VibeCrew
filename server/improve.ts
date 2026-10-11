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
  description: 'role description',
  model: 'model',
  effort: 'thinking effort',
  permission: 'permission level',
  allowRules: 'auto-allow rules',
  askRules: 'must-ask rules',
  editScope: 'editable paths',
  freshSession: 'fresh session each turn',
  monthlyBudgetUsd: 'monthly budget',
  skill: 'new skill',
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
  const lines: string[] = ["## The team's current setup"];
  for (const b of team) {
    lines.push(
      `### ${b.name} (id ${b.id}): ${b.title}`,
      `model=${b.model || 'default'} effort=${b.effort || 'default'} permission=${b.permission} freshSession=${!!b.freshSession} blindReview=${!!b.blindReview} editScope=${JSON.stringify(b.editScope || [])} monthlyBudgetUsd=${b.monthlyBudgetUsd ?? 'unlimited'}`,
      `allowRules=${JSON.stringify(b.allowRules)}`,
      `askRules=${JSON.stringify(b.askRules)}`,
      `Role description:\n${b.description}`,
    );
  }

  lines.push('', `## The last ${turns.length} turns (oldest first). Cite them as [chatId/messageId]`);
  const names = new Map(team.map((b) => [b.id, b.name]));
  for (const { chatId, chatTitle, msg } of turns) {
    const meta = msg.meta || {};
    const approvals = (msg.parts || []).filter((p) => p.type === 'approval').map((p) => (p.type === 'approval' ? `${p.status}:${clip(p.title, 60)} (${p.because || ''})` : ''));
    const toolErrors = (msg.parts || []).filter((p) => p.type === 'tool' && p.status === 'error').map((p) => (p.type === 'tool' ? p.name : ''));
    lines.push(
      `- [${chatId}/${msg.id}] ${names.get(msg.botId!) || '?'} in "${chatTitle}" status=${msg.status} cost=$${(meta.costUsd || 0).toFixed(3)} model=${meta.model || '?'}` +
        (meta.verdict ? ` review-verdict=refuted ${meta.verdict.refuted}` : '') +
        (approvals.length ? ` approvals=${approvals.join('; ')}` : '') +
        (toolErrors.length ? ` tool-errors=${toolErrors.join(', ')}` : '') +
        (msg.error ? ` error=${clip(msg.error, 120)}` : ''),
      `  Reply starts: ${clip(msg.text || '', 240)}`,
    );
  }

  const refutations = turns.filter((t) => t.msg.meta?.verdict?.refuted).slice(-4);
  if (refutations.length) {
    lines.push('', '## What the adversarial review refuted (verbatim)');
    for (const t of refutations) lines.push(`### [${t.chatId}/${t.msg.id}]`, (t.msg.text || '').slice(-2500));
  }

  const asks: string[] = [];
  for (const chat of chats.all()) for (const m of messages.sorted(chat.id).slice(-30)) if (m.role === 'user') asks.push(`- [${chat.id}/${m.id}] ${clip(m.text, 200)}`);
  if (asks.length) lines.push('', '## What the user said recently (look for corrections to the bots)', ...asks.slice(-20));

  const decided = improvements
    .all()
    .filter((i) => i.status !== 'pending')
    .slice(-20);
  if (decided.length) {
    lines.push('', "## Earlier proposals and the user's decisions (don't repeat rejected ones)");
    for (const i of decided) {
      const edited = i.original !== undefined ? ` (the model proposed ${clip(JSON.stringify(i.original), 120)}; the user changed it to the above before deciding)` : '';
      lines.push(`- ${i.botName}'s ${FIELD_LABEL[i.field]} → ${clip(JSON.stringify(i.after), 160)}: ${i.status}${edited}${i.note ? ` (the user said: ${i.note})` : ''}`);
    }
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
    "You're helping a team of AI bots get better. Below is the team's setup and what actually happened recently.",
    `Propose at most ${MAX_PROPOSALS} changes to the bots' settings. Rules:`,
    '- Each proposal changes one field of one bot: ' + FIELDS.map((f) => `${f} (${FIELD_LABEL[f]})`).join(', ') + '.',
    `- Keep changes small, so it's clear which one made the difference: change at most ${MAX_DESCRIPTION_LINES} lines of a description and leave the rest as is; for list fields, give the complete new list.`,
    '- Each proposal must cite at least one real turn as evidence ([chatId/messageId]), saying what went wrong and what should get better after the change.',
    `- Only propose fixes for problems that keep happening: the evidence must come from at least ${MIN_REQUESTS} separate user requests; splitting one incident into several pieces of evidence doesn't count. One proposal per problem; don't spread one incident across several proposals. If nothing is worth changing, return an empty array. That beats forcing something.`,
    "- Don't repeat proposals the user rejected. Don't trade correctness for savings (for example, moving a reviewer onto a model that's too weak).",
    '',
    'Reply with only a JSON array, no other text. Format:',
    '[{"bot":"bot name or id","field":"field","after":new value,"rationale":"why, pointing to the evidence","expected":"what should get better","evidence":[{"ref":"chatId/messageId","note":"what happened in this turn"}]}]',
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
  if (!p.success) return `Wrong format: ${p.error.issues[0]?.message}`;
  const { field, rationale, expected } = p.data;
  const bot = bots.get(p.data.bot) || bots.all().find((b) => b.name.toLowerCase() === p.data.bot.toLowerCase());
  if (!bot) return `No bot named ${p.data.bot}`;
  const check = BotPatch.shape[field].safeParse(p.data.after);
  if (!check.success) return `Invalid new value for ${field}`;
  const after = check.data;
  const before = (bot as unknown as Record<string, unknown>)[field];
  if (same(before, after)) return 'Same as the current value';
  if (field === 'description' && changedLines(String(before || ''), String(after)) > MAX_DESCRIPTION_LINES * 2) return 'Too many changes to the role description';
  const evidence = p.data.evidence
    .map((e) => {
      const [chatId, messageId] = e.ref.replace(/[[\]]/g, '').split('/');
      return messages.get(chatId, messageId) ? { chatId, messageId, note: e.note } : null;
    })
    .filter((e): e is NonNullable<typeof e> => !!e);
  if (!evidence.length) return "The cited evidence doesn't exist";
  if (requestsBehind(evidence) < MIN_REQUESTS) return `The evidence comes from a single request (at least ${MIN_REQUESTS} separate requests are needed); a one-off is not a pattern`;
  const dup = improvements.all().find((i) => i.botId === bot.id && i.field === field && same(i.after, after) && (i.status === 'pending' || i.status === 'rejected'));
  if (dup) return dup.status === 'pending' ? 'The same proposal is already pending' : 'The user already rejected the same proposal';
  return { id: uid('i_'), createdAt: Date.now(), botId: bot.id, botName: bot.name, field, before: before ?? null, after, rationale, expected, evidence, status: 'pending' };
}

function parseProposals(text: string): unknown[] {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) throw new HttpError(502, "The model's proposals weren't in the expected format");
  const arr = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new HttpError(502, "The model's proposals weren't in the expected format");
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
    {
      bot: top[0],
      field: 'freshSession',
      after: true,
      rationale: 'Demo: this bot costs the most per turn on average.',
      expected: 'Lower cost per turn',
      evidence: top[1].refs.map((ref) => ({ ref, note: 'A recent turn' })),
    },
  ];
}

/** Runs the proposer once and stores what survives vetting. */
export async function proposeImprovements(): Promise<{ added: Improvement[]; dropped: string[]; costUsd: number }> {
  if (!recentTurns().length) throw new HttpError(409, "No bot has done any work yet, so there's nothing to analyze");
  let raw: unknown[];
  let costUsd = 0;
  if (FAKE_AGENT) raw = fakeProposals();
  else {
    const r = await oneShot(prompt(evidencePack()), { model: 'sonnet', timeoutMs: 240_000 }).catch((e: Error) => {
      throw new HttpError(502, `Couldn't generate proposals: ${e.message}`);
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
  if (raw.length > MAX_PROPOSALS) dropped.push(`Over the limit of ${MAX_PROPOSALS} per run; the extra ${raw.length - MAX_PROPOSALS} weren't looked at`);
  log.info(`proposed ${added.length}, dropped ${dropped.length}: ${dropped.join('; ')}`);
  return { added, dropped, costUsd };
}

function requireImprovement(id: string): Improvement {
  const i = improvements.get(id);
  if (!i) throw new HttpError(404, 'No such proposal');
  return i;
}

export function acceptImprovement(id: string): { improvement: Improvement; bot?: Bot } {
  const i = requireImprovement(id);
  if (i.status !== 'pending') throw new HttpError(409, 'This proposal has already been decided');
  if (i.field === 'skill') {
    const draft = i.after as SkillDraft;
    if (skills.get(draft.name)) {
      i.status = 'stale';
      i.decidedAt = Date.now();
      improvements.set(i);
      throw new HttpError(409, `A skill named ${draft.name} already exists, so this proposal is void.`);
    }
    skills.save({ name: draft.name, title: draft.title, description: draft.description, icon: draft.icon, argsHint: draft.argsHint, body: draft.body });
    i.status = 'accepted';
    i.decidedAt = Date.now();
    improvements.set(i);
    return { improvement: i };
  }
  const bot = bots.get(i.botId);
  if (!bot) throw new HttpError(404, 'That bot no longer exists');
  // Changed by hand since the proposal: applying it would overwrite that.
  if (!same((bot as unknown as Record<string, unknown>)[i.field] ?? null, i.before)) {
    i.status = 'stale';
    i.decidedAt = Date.now();
    improvements.set(i);
    throw new HttpError(409, `${bot.name}'s ${FIELD_LABEL[i.field]} was changed after this proposal, so it is void.`);
  }
  const updated = updateBot(bot.id, { [i.field]: i.after } as never);
  i.status = 'accepted';
  i.decidedAt = Date.now();
  improvements.set(i);
  return { improvement: i, bot: updated };
}

/**
 * The user's own value for a pending change to a bot's setting. It must pass the same checks as
 * the bot's settings page and still change something; the model's value is kept as `original`.
 */
export function editSettingProposal(id: string, value: unknown): Improvement {
  const i = requireImprovement(id);
  if (i.field === 'skill') throw new HttpError(400, 'Edit skill drafts through the skill edit instead');
  if (i.status !== 'pending') throw new HttpError(409, 'This proposal has already been decided');
  const check = BotPatch.shape[i.field].safeParse(value);
  if (!check.success) throw new HttpError(400, `Invalid value for ${FIELD_LABEL[i.field]}: ${check.error.issues[0]?.message}`);
  const after = typeof check.data === 'string' ? check.data.trim() : Array.isArray(check.data) ? [...new Set(check.data.map((x) => String(x).trim()).filter(Boolean))] : check.data;
  // An unset switch is off: turning it "off" is no change.
  const unchanged = typeof after === 'boolean' ? !!i.before === after : same(i.before, after);
  if (unchanged) throw new HttpError(400, "That's the same as the current value; just reject the proposal instead");
  if (i.original === undefined) i.original = i.after;
  i.after = after;
  i.editedAt = Date.now();
  improvements.set(i);
  return i;
}

export function rejectImprovement(id: string, note?: string): Improvement {
  const i = requireImprovement(id);
  if (i.status !== 'pending') throw new HttpError(409, 'This proposal has already been decided');
  i.status = 'rejected';
  i.decidedAt = Date.now();
  if (note?.trim()) i.note = note.trim().slice(0, 500);
  improvements.set(i);
  return i;
}

export function revertImprovement(id: string): { improvement: Improvement; bot?: Bot } {
  const i = requireImprovement(id);
  if (i.status !== 'accepted') throw new HttpError(409, 'Only accepted proposals can be reverted');
  if (i.field === 'skill') {
    skills.remove((i.after as SkillDraft).name);
    i.status = 'reverted';
    improvements.set(i);
    return { improvement: i };
  }
  const bot = bots.get(i.botId);
  if (!bot) throw new HttpError(404, 'That bot no longer exists');
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
