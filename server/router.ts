// Shadow routing: for a group message nobody was @-mentioned in, a cheap model guesses which
// teammate should take it, with a confidence, while the message goes to the lead as always. The
// guesses and what actually happened build the local label set a confidence gate needs.
//
// It follows "JEV-as-a-Judge" (Li et al., 2026): accept a cheap decision only when its confidence
// clears a threshold, escalate otherwise; average both candidate orders, because generative
// judges flip with presentation order; choose the threshold on ~100 local labels by a lower
// confidence bound, not a point estimate. Routing is a decision read off the request, the kind a
// cheap judge handles well; whether code is correct is not, so this never judges code.

import type { Bot, Chat, ChatMessage, RoutingRecord, RoutingReport } from '../shared/types';
import { FAKE_AGENT } from './config';
import { logger } from './log';
import { oneShot } from './oneShot';
import { parseMentions } from './orchestrator/chatLog';
import { chats, messages, routingLog, settings, uid } from './store';

const log = logger('routing');

/** Local labels before a threshold is suggested (the paper's "about 100"). */
export const LABELS_NEEDED = 100;
/** Accepted decisions must be at least this accurate, judged by the lower bound. */
const TARGET_ACCURACY = 0.9;
const GRID = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99];
const KEEP = 1000;

interface Candidate {
  id: string;
  name: string;
  title: string;
}

/** Turns a probability answer for candidates in one order into probabilities by bot id. */
export function parseProbs(text: string, order: Candidate[]): Record<string, number> {
  const body = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('不是 JSON');
  const raw = JSON.parse(body.slice(start, end + 1));
  const probs = (raw.probabilities ?? raw) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const c of order) {
    const v = Number(probs[c.name]);
    if (!Number.isFinite(v) || v < 0) throw new Error(`没有 ${c.name} 的概率`);
    out[c.id] = v;
  }
  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  // Rounded verbal probabilities: tolerate a little, refuse nonsense.
  if (Math.abs(sum - 1) > 0.05) throw new Error(`概率加起来是 ${sum.toFixed(2)}`);
  for (const k of Object.keys(out)) out[k] /= sum;
  return out;
}

/** Averages the two orders' probabilities (paper eq. 1) and reads off the choice and confidence. */
export function combine(a: Record<string, number>, b: Record<string, number>): { probs: Record<string, number>; choice: string; confidence: number } {
  const probs: Record<string, number> = {};
  for (const k of Object.keys(a)) probs[k] = (a[k] + (b[k] ?? 0)) / 2;
  const [choice, confidence] = Object.entries(probs).sort((x, y) => y[1] - x[1])[0];
  return { probs, choice, confidence };
}

function question(text: string, order: Candidate[]): string {
  return [
    '群聊里用户发了一条消息，没有 @ 任何人。判断由哪位队友来接最合适（最能独立做完、最省事的那一位；需要拆分协调的复杂任务交给负责人）。',
    '',
    '队友：',
    ...order.map((c) => `- ${c.name}：${c.title}`),
    '',
    `用户的消息：\n${text.slice(0, 2000)}`,
    '',
    `只回复 JSON，给每位队友一个概率，加起来等于 1：{"probabilities": {${order.map((c) => `"${c.name}": 0.0`).join(', ')}}}`,
  ].join('\n');
}

/** The cheap model's two-order decision. Haiku through a bare one-shot call: about $0.002. */
async function decide(text: string, candidates: Candidate[], lead: Candidate): Promise<Pick<RoutingRecord, 'choice' | 'confidence' | 'probs' | 'costUsd' | 'backend'>> {
  if (FAKE_AGENT) {
    // Demo stand-in: sure of the lead when the request asks to split work, unsure otherwise.
    const split = /交给|分派|拆分|handoff/i.test(text);
    const probs = Object.fromEntries(candidates.map((c) => [c.id, c.id === lead.id ? (split ? 0.95 : 0.55) : (split ? 0.05 : 0.45) / (candidates.length - 1)]));
    const { choice, confidence } = combine(probs, probs);
    return { choice, confidence, probs, costUsd: 0, backend: 'fake' };
  }
  const reversed = [...candidates].reverse();
  const [x, y] = await Promise.all([candidates, reversed].map((order) => oneShot(question(text, order), { model: 'haiku', timeoutMs: 60_000, system: '你是一个分类器，只回复要求的 JSON。' })));
  const costUsd = x.costUsd + y.costUsd;
  const c = combine(parseProbs(x.text, candidates), parseProbs(y.text, reversed));
  return { ...c, costUsd, backend: 'haiku' };
}

/** Records what the router would have done for this message. Never changes where it goes. */
export async function shadowRoute(chat: Chat, msg: ChatMessage, members: Bot[], lead: Bot): Promise<void> {
  if (settings.get().routing?.mode !== 'shadow' || chat.kind !== 'group' || members.length < 2) return;
  const candidates = members.map((b) => ({ id: b.id, name: b.name, title: b.title }));
  const rec: RoutingRecord = {
    id: uid('r_'),
    at: Date.now(),
    chatId: chat.id,
    messageId: msg.id,
    text: (msg.prompt || msg.text).slice(0, 300),
    candidates: candidates.map(({ id, name }) => ({ id, name })),
    leadId: lead.id,
    backend: 'haiku',
    costUsd: 0,
  };
  try {
    Object.assign(rec, await decide(msg.prompt || msg.text, candidates, { id: lead.id, name: lead.name, title: lead.title }));
  } catch (e) {
    rec.invalid = (e as Error).message.slice(0, 200);
    log.info(`invalid decision for ${msg.id}: ${rec.invalid}`);
  }
  routingLog.set(rec);
  const all = routingLog.all();
  if (all.length > KEEP) for (const old of all.sort((a, b) => a.at - b.at).slice(0, all.length - KEEP)) routingLog.delete(old.id);
}

/**
 * What actually happened, as the label: the lead's reply to the message. Handing over to exactly
 * one teammate labels that teammate; doing it alone labels the lead; several is ambiguous.
 */
export function outcome(rec: RoutingRecord): { label: string | 'multi' | null; leadReply?: ChatMessage } {
  const list = messages.sorted(rec.chatId);
  const asked = list.find((m) => m.id === rec.messageId);
  if (!asked) return { label: null };
  const next = list.find((m) => m.role === 'user' && m.seq > asked.seq);
  const reply = list.find((m) => m.role === 'bot' && m.botId === rec.leadId && m.seq > asked.seq && (!next || m.seq < next.seq) && m.status === 'done');
  if (!reply) return { label: null };
  const chat = chats.get(rec.chatId);
  const teammates = rec.candidates.filter((c) => c.id !== rec.leadId).map((c) => ({ id: c.id, name: c.name })) as Bot[];
  const handed = chat ? parseMentions(reply.text, teammates) : [];
  return { label: handed.length === 0 ? rec.leadId : handed.length === 1 ? handed[0].id : 'multi', leadReply: reply };
}

/** Mann-Whitney AUROC of confidence against correctness (ties count half); null without both classes. */
export function auroc(scored: { q: number; ok: boolean }[]): number | null {
  const right = scored.filter((s) => s.ok).map((s) => s.q);
  const wrong = scored.filter((s) => !s.ok).map((s) => s.q);
  if (!right.length || !wrong.length) return null;
  let wins = 0;
  for (const r of right) for (const w of wrong) wins += r > w ? 1 : r === w ? 0.5 : 0;
  return wins / (right.length * wrong.length);
}

/** Lower bound of the Wilson score interval (95%). */
export function wilsonLower(correct: number, n: number, z = 1.96): number {
  if (!n) return 0;
  const p = correct / n;
  const d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
}

export function routingReport(): RoutingReport {
  const recs = routingLog.all().sort((a, b) => b.at - a.at);
  const rows = recs.map((r) => ({ r, ...outcome(r) }));
  const usable = rows.filter((x) => x.label && x.label !== 'multi');
  const scored = usable.map((x) => ({ q: x.r.invalid ? 0 : (x.r.confidence ?? 0), ok: !x.r.invalid && x.r.choice === x.label }));
  const bins = [
    [0, 0.6],
    [0.6, 0.8],
    [0.8, 0.9],
    [0.9, 0.95],
    [0.95, 1.01],
  ].map(([lo, hi]) => {
    const inBin = scored.filter((s) => s.q >= lo && s.q < hi);
    return { lo, hi: Math.min(hi, 1), n: inBin.length, correct: inBin.filter((s) => s.ok).length };
  });
  let threshold: RoutingReport['threshold'] = null;
  if (usable.length >= LABELS_NEEDED) {
    for (const tau of GRID) {
      const accepted = scored.filter((s) => s.q >= tau);
      if (accepted.length < 20) continue;
      const correct = accepted.filter((s) => s.ok).length;
      const lower = wilsonLower(correct, accepted.length);
      if (lower >= TARGET_ACCURACY) {
        threshold = { tau, coverage: accepted.length / scored.length, accuracy: correct / accepted.length, lower };
        break;
      }
    }
  }
  const routingTurns = usable.filter((x) => x.label !== x.r.leadId && x.leadReply).map((x) => x.leadReply!.meta?.costUsd || 0);
  return {
    mode: settings.get().routing?.mode || 'off',
    labeled: usable.length,
    agreement: scored.length ? scored.filter((s) => s.ok).length / scored.length : null,
    bins,
    needed: Math.max(0, LABELS_NEEDED - usable.length),
    auroc: auroc(scored),
    confident: { n: scored.filter((s) => s.q >= 0.9).length, wrong: scored.filter((s) => s.q >= 0.9 && !s.ok).length },
    threshold,
    avgRoutingTurnUsd: routingTurns.length ? routingTurns.reduce((a, b) => a + b, 0) / routingTurns.length : null,
    costUsd: recs.reduce((s, r) => s + r.costUsd, 0),
    recent: rows.slice(0, 30).map((x) => ({ ...x.r, label: x.label })),
  };
}
