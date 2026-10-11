// Friction: the moments Crew got in the way. A chain that stopped with no handoff, the hop limit,
// approvals the user denied or waited long for, approvals for read-only commands (a rule that is
// too broad), notes about files that changed outside the chat, turns that errored. Each is one line
// in an append-only log; the report groups them so the worst problems, with the chats they came
// from, can be handed to a team that fixes Crew. Nothing here changes how Crew behaves.

import fs from 'node:fs';
import type { FrictionEvent, FrictionKind, FrictionReport } from '../shared/types';
import { DATA } from './config';
import { logger } from './log';

const log = logger('friction');

export const FRICTION_LABEL: Record<FrictionKind, string> = {
  stall: 'Handoff chain stalled; stall detection woke the lead',
  'hop-limit': 'Automatic handoffs hit the limit',
  'approval-denied': 'Approvals you denied',
  'approval-readonly': 'Read-only commands asked for approval (a rule may be too broad)',
  'approval-slow': 'Approvals that waited over 10 minutes',
  'outside-edit': '"Files changed outside the chat" notices',
  'turn-error': 'Bot turns that errored',
};

/** Approvals answered later than this count as slow. */
export const SLOW_APPROVAL_MS = 10 * 60_000;

export function recordFriction(e: Omit<FrictionEvent, 'at'> & { at?: number }) {
  const event: FrictionEvent = { ...e, at: e.at ?? Date.now(), detail: e.detail.replace(/\s+/g, ' ').slice(0, 300) };
  try {
    fs.appendFileSync(DATA.friction, `${JSON.stringify(event)}\n`);
  } catch (err) {
    log.warn('could not record:', (err as Error).message);
  }
}

export function readFriction(since: number): FrictionEvent[] {
  let text = '';
  try {
    text = fs.readFileSync(DATA.friction, 'utf8');
  } catch {
    return [];
  }
  const out: FrictionEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as FrictionEvent;
      if (e.at >= since && e.kind in FRICTION_LABEL) out.push(e);
    } catch {
      /* a torn last line */
    }
  }
  return out;
}

/** Events grouped by kind, then by what lies behind them (the rule, the path, the bot), worst first. */
export function frictionReport(days: number, now = Date.now()): FrictionReport {
  const since = now - days * 86_400_000;
  const events = readFriction(since);
  const kinds = (Object.keys(FRICTION_LABEL) as FrictionKind[])
    .map((kind) => {
      const of = events.filter((e) => e.kind === kind);
      const byKey = new Map<string, FrictionEvent[]>();
      for (const e of of) byKey.set(e.key, [...(byKey.get(e.key) || []), e]);
      const groups = [...byKey.entries()]
        .map(([key, list]) => ({ key, count: list.length, examples: list.slice(-3).reverse() }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);
      return { kind, label: FRICTION_LABEL[kind], count: of.length, groups };
    })
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count);
  return { days, since, total: events.length, kinds, brief: frictionBrief(days, kinds) };
}

/** Files a fix may only touch after asking: the code that decides what bots are allowed to do. */
export const GUARDED_FILES = ['server/agents/permissions.ts', 'server/orchestrator/permissionGate.ts', 'server/sandbox.ts', 'server/security.ts', 'server/data/catalog.ts'];

/**
 * The message that hands the report to a group working on Crew's own code. `{lead}` is replaced
 * with the group's lead by the app. The user stays the one who merges, packages and restarts.
 */
export function frictionBrief(days: number, kinds: FrictionReport['kinds']): string {
  if (!kinds.length) return '';
  const lines = kinds.flatMap((k) => [
    `- ${k.label}: ${k.count}x`,
    ...k.groups.slice(0, 3).map((g) => `  - ${g.key} (${g.count}x) e.g. ${g.examples[0].detail}${g.examples[0].chatTitle ? ` ("${g.examples[0].chatTitle}")` : ''}`),
  ]);
  return [
    `@{lead} Here's Crew's friction report for the last ${days} days, most frequent first:`,
    '',
    ...lines,
    '',
    'Please pick the problem with the biggest impact that can be fixed within one branch:',
    "1. First restate the problem and the evidence (use chat_history to read the original chat if needed) and explain the root cause before changing anything. If it can't or shouldn't be fixed (for example, it's the user's own choice), say why and move on to the next one.",
    "2. Make the change in this chat's own workspace (branch), add a test that reproduces the problem, and get npm run check fully passing.",
    '3. Hand it to Lens for review and Skeptic to refute, and fix everything they refute.',
    `4. Before touching ${GUARDED_FILES.join(', ')}, stop and ask the user: these files decide what bots are allowed to do.`,
    "5. Don't merge, push, package or restart Crew, and don't touch the data in ~/.crew. At the end, sum up the branch name, the changes, the test results and anything still uncertain for the user, who decides.",
  ].join('\n');
}
