// A fixed group chat for measuring what Inline & Spill saves (ADR 005): long teammate reports, a
// long handoff, short replies, a Router batch and an environment that changed by one line.
// Deterministic: the text comes from a seeded generator, so the numbers only move when the rules do.

import type { RouterEvent, WorkerLine } from '../../server/layers/prompts';
import type { ChatMessage } from '../../shared/types';

const VOCAB =
  'the page header footer pricing table card button layout grid spacing mobile desktop breakpoint color contrast token theme dark light test check build run fix change file component style route API request response error state form input validation copy text image icon font weight padding margin'.split(
    ' ',
  );

/** `n` words of plausible report text, in sentences, with a line break now and then. */
export function words(n: number, seed: number): string {
  let x = seed;
  const next = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let w = VOCAB[next() % VOCAB.length];
    if (i % 12 === 0) w = w[0].toUpperCase() + w.slice(1);
    out.push(i % 12 === 11 ? `${w}.${i % 48 === 47 ? '\n' : ''}` : w);
  }
  return out.join(' ').replace(/\n /g, '\n');
}

export const NAMES = new Map([
  ['b_chief', 'Chief'],
  ['b_pixel', 'Pixel'],
  ['b_probe', 'Probe'],
  ['b_lens', 'Lens'],
]);

const msg = (seq: number, role: ChatMessage['role'], text: string, botId?: string, trigger?: ChatMessage['trigger']): ChatMessage => ({
  id: `m_${seq}`,
  chatId: 'c_fixture',
  seq,
  ts: 1_700_000_000_000 + seq * 60_000,
  role,
  text,
  botId,
  trigger,
  status: 'done',
});

/** Twelve messages since Probe last spoke; the last one hands the turn to Probe. */
export const MESSAGES: ChatMessage[] = [
  msg(1, 'user', 'Build a pricing page with three plans, a monthly/yearly switch and a FAQ. It has to look right on phones and in dark mode.'),
  msg(2, 'bot', `@Pixel please build the page.\n${words(260, 2)}`, 'b_chief', { type: 'user' }),
  msg(3, 'bot', `Done: the pricing page is in place.\n${words(420, 3)}`, 'b_pixel', { type: 'mention', by: 'b_chief' }),
  msg(4, 'bot', 'Thanks, checking it now.', 'b_chief', { type: 'mention', by: 'b_pixel' }),
  msg(5, 'bot', `@Lens please review the change.\n${words(180, 5)}`, 'b_chief', { type: 'mention', by: 'b_pixel' }),
  msg(6, 'bot', `Review: two issues, nothing blocking.\n${words(380, 6)}`, 'b_lens', { type: 'mention', by: 'b_chief' }),
  msg(7, 'user', 'Also make the yearly price show the saving in percent.'),
  msg(8, 'bot', `@Pixel please add the saving and fix the review issues.\n${words(150, 8)}`, 'b_chief', { type: 'user' }),
  msg(9, 'bot', `Saving added, both review issues fixed.\n${words(340, 9)}`, 'b_pixel', { type: 'mention', by: 'b_chief' }),
  msg(10, 'system', `Files changed outside the chat: src/pricing.css (lines 10-40), src/faq.ts (lines 3-9). ${words(40, 10)}`),
  msg(11, 'bot', 'Noted the outside edit; it does not conflict.', 'b_chief', { type: 'mention', by: 'b_pixel' }),
  msg(12, 'bot', `@Probe please check the page end to end.\n${words(520, 12)}`, 'b_chief', { type: 'mention', by: 'b_pixel' }),
];

export const CONTEXT_FIRST = [
  'Time: 11/2/2026, 10:00:00 (Monday)',
  'Dev server: running at http://localhost:5173 (command: npm run dev)',
  'Page the user is previewing: /pricing',
  'Blocked actions (the system refuses them outright; do not try them or work around them with a different command): Bash(*prod-server*), Bash(*db-server*)',
  `Your commands run in a sandbox: they can only reach this machine and these domains: registry.npmjs.org, github.com. ${words(60, 99)}`,
  'Commit message rules for this project: imperative English, at most 72 characters.',
];
export const CONTEXT_NEXT = ['Time: 11/2/2026, 10:20:00 (Monday)', CONTEXT_FIRST[1], 'Page the user is previewing: /pricing#faq', ...CONTEXT_FIRST.slice(3)];

const AT = 1_700_000_000_000;
export const BATCH: RouterEvent[] = [
  { kind: 'user', id: 'm_20', at: AT, seq: 20, text: `Here is the full spec for the account area.\n${words(1100, 20)}`, triggerId: 'tg_user20' },
  {
    kind: 'worker',
    id: 'wk_pricing',
    at: AT,
    bot: 'Pixel',
    title: 'Build the pricing page',
    status: 'done',
    report: `Pricing page done.\n${words(420, 21)}`,
    landing: 'Merged 4 files into crew/pricing.',
  },
  { kind: 'worker', id: 'wk_faq', at: AT, bot: 'Pixel', title: 'FAQ section', status: 'done', report: `FAQ done.\n${words(260, 22)}` },
];
export const BATCH_WORKERS: WorkerLine[] = [
  { id: 'wk_pricing', bot: 'Pixel', status: 'done', title: 'Build the pricing page', note: 'Pricing page done.' },
  { id: 'wk_faq', bot: 'Pixel', status: 'done', title: 'FAQ section', note: 'FAQ done.' },
];
