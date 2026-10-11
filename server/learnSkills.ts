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
    const by = bots.get(turn.trigger.by)?.name || 'A teammate';
    if (handover) return `Task handed over by ${by}: ${handover.text.trim()}${userText ? `\n(The user recently said: ${userText})` : ''}`;
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
  /ignore (all |any )?(of )?(the )?(previous|prior|above|earlier|other) (instructions|rules|requirements|settings)|disregard (all |any )?(of )?(the )?(previous|prior|above|earlier|other) /i;

/**
 * The fixed screen a draft goes through. Blocking: a deny-list command, an instruction override.
 * Flagged for the user: must-ask commands, hosts the sandbox would not reach.
 */
export function screenSkill(body: string, ctx: { denyRules: string[]; askRules: string[]; allowedHosts: string[] }): { blocked: string | null; flags: string[] } {
  if (OVERRIDE.test(body)) return { blocked: 'The skill tells the bot to ignore other instructions', flags: [] };
  // Commands: inline `code` and the lines of fenced blocks.
  const commands = new Set<string>();
  for (const m of body.matchAll(/`([^`\n]+)`/g)) commands.add(m[1].trim());
  for (const block of body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const line of block[1].split('\n')) if (line.trim()) commands.add(line.trim().replace(/^\$\s*/, ''));
  const flags: string[] = [];
  for (const command of commands) {
    const denied = matchingRule(ctx.denyRules, 'Bash', { command }, '/');
    if (denied) return { blocked: `The skill contains a forbidden command: ${command} (rule ${denied})`, flags: [] };
    const ask = matchingRule(ctx.askRules, 'Bash', { command }, '/');
    if (ask) flags.push(`Contains a command that needs approval: ${command}`);
  }
  const allowed = ctx.allowedHosts;
  for (const m of body.matchAll(/https?:\/\/([a-z0-9.-]+)(:\d+)?/gi)) {
    const host = m[1].toLowerCase();
    const ok = allowed.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) : host === d.replace(/:\d+$/, '')));
    if (!ok) flags.push(`Reaches a host outside the sandbox list: ${host}`);
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
    if (i.status === 'rejected' && i.note) lessons.push(`- Rejected /${name}: ${i.note}`);
    else if (i.status === 'accepted' && i.original) {
      const c = lineChange((i.original as SkillDraft).body, (i.after as SkillDraft).body);
      if (c)
        lessons.push(
          `- /${name} was edited by the user before accepting: removed "${c.removed.slice(0, 3).join(' / ').slice(0, 200)}", replaced with "${c.added.slice(0, 3).join(' / ').slice(0, 200)}"`,
        );
    }
    if (lessons.length >= limit) break;
  }
  return lessons;
}

export function draftPrompt(ask: string, turn: ChatMessage, existing: string[], rejected: string[] = rejectedSkillNotes()): string {
  const steps = toolCalls(turn)
    .map((p, i) => (p.type === 'tool' ? `${i + 1}. ${p.name}${p.status === 'error' ? ' (failed)' : ''}: ${JSON.stringify(p.input).slice(0, 300)}` : ''))
    .join('\n');
  return [
    'Below is a turn of work an AI bot completed successfully. Decide whether its approach is worth writing up as a reusable "skill" (instructions that guide a bot through the same kind of task), and if it is, write it.',
    'Requirements:',
    "- Write general steps; don't hard-code this turn's file names, content or data. Use {{args}} for the variable part: the arguments the user gives when calling the skill.",
    '- Only include what this turn actually did and got done; leave out steps that failed and were worked around.',
    '- No secrets, accounts or specific server addresses; nothing like "ignore other instructions".',
    '- Write in the same language as the source conversation. Be concise, keep the steps clear, and end with what counts as done.',
    `- Existing skills: ${existing.join(', ') || '(none)'}. If this duplicates one of them, or the turn was a one-off, reply {"skip": "reason"}.`,
    ...(rejected.length
      ? ["- The user's decisions on earlier skill drafts (reasons for rejecting, what was changed before accepting). The new draft must not repeat these problems:", ...rejected]
      : []),
    '- Leave out anything in this turn that the user corrected, or that later turned out to be wrong.',
    '',
    'Reply with only JSON: {"name": "kebab-case English name, at most 40 characters", "title": "short title", "description": "one sentence on when to use it", "argsHint": "hint for the arguments", "body": "the skill content"}',
    '',
    `## The task in this turn\n${ask || '(not recorded)'}`,
    `## Tools called in this turn\n${steps}`,
    `## The bot's final reply\n${(turn.text || '').slice(0, 1500)}`,
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
  if (!i) throw new HttpError(404, 'No such proposal');
  if (i.field !== 'skill') throw new HttpError(400, 'Only skill drafts can be edited before accepting');
  if (i.status !== 'pending') throw new HttpError(409, 'This proposal has already been decided');
  const name = edit.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Skill names may only use lowercase letters, digits and hyphens, up to 40 characters');
  if (skills.get(name)) throw new HttpError(409, `A skill named ${name} already exists`);
  const ev = i.evidence[0];
  const screen = screenSkill(edit.body, screenContext(ev?.chatId || '', i.botId));
  if (screen.blocked) throw new HttpError(400, `Failed the safety check: ${screen.blocked}`);
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
  if (!chat || !turn || turn.role !== 'bot' || !turn.botId) throw new HttpError(404, 'No such turn');
  if (!skillCandidates().some((c) => c.messageId === messageId)) throw new HttpError(409, "This turn can't be (or already was) used to draft a skill");
  const ask = taskOf(messages.sorted(chatId), turn);
  const existing = skills.list().map((s) => s.name);

  let raw: unknown;
  let costUsd = 0;
  if (FAKE_AGENT) {
    raw = {
      name: 'demo-page',
      title: 'Make a demo page',
      description: 'Demo: a skill learned from a turn of work',
      argsHint: 'page topic',
      body: `1. Look at the project structure first.\n2. Write the page following {{args}}.\n3. Take a screenshot to confirm.\nThe user's words: ${ask}`,
    };
  } else {
    const r = await oneShot(draftPrompt(ask, turn, existing), { model: 'sonnet', timeoutMs: 180_000 }).catch((e: Error) => {
      throw new HttpError(502, `Couldn't draft the skill: ${e.message}`);
    });
    costUsd = r.costUsd;
    const body = r.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      raw = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
    } catch {
      throw new HttpError(502, "The model's skill draft wasn't in the expected format");
    }
  }
  const skip = (raw as { skip?: string })?.skip;
  if (skip) return { skipped: String(skip).slice(0, 300), costUsd };
  const d = DRAFT.safeParse(raw);
  if (!d.success) throw new HttpError(502, "The model's skill draft has the wrong shape");
  const name = d.data.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new HttpError(502, `Invalid skill name: ${name}`);
  if (skills.get(name)) return { skipped: `A skill named ${name} already exists`, costUsd };

  const bot = bots.get(turn.botId)!;
  const screen = screenSkill(d.data.body, screenContext(chatId, bot.id));
  if (screen.blocked) return { skipped: `Failed the safety check: ${screen.blocked}`, costUsd };

  const draft: SkillDraft = { name, title: d.data.title, description: d.data.description, icon: '⚡', argsHint: d.data.argsHint, body: d.data.body, flags: screen.flags };
  const improvement: Improvement = {
    id: uid('i_'),
    createdAt: Date.now(),
    botId: bot.id,
    botName: bot.name,
    field: 'skill',
    before: null,
    after: draft,
    rationale: `Learned from a turn by ${bot.name} in "${chat.title}": ${toolCalls(turn).length} tool calls, finished cleanly, and not refuted by the adversarial review afterwards.`,
    expected: 'Next time, call /' + name + ' for the same kind of task and skip the detours',
    evidence: [{ chatId, messageId, note: ask.slice(0, 120) || 'That turn' }],
    status: 'pending',
  };
  improvements.set(improvement);
  return { improvement, costUsd };
}
