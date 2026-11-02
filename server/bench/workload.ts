// The bench's synthetic workload (ADR 101): a group chat plus a CI stream. A few messages ask for
// work; most are chatter, follow-ups on work already asked for, stop requests and CI results.
// Seeded, so the same options give the same stream; every time in it is multiplied by timeScale.
//
// The texts follow fixed shapes ("Please build … (task T07).", "For T07: …", "Stop T07 …"), since
// the scripted model reads them the way a model would read the user's intent.

import { type Rng, rng } from './rng';

export type WorkloadKind = 'request' | 'follow-up' | 'stop' | 'chatter' | 'ci';

export interface WorkloadEvent {
  /** msg_<seq>: also the chat message's id, which every agent quotes back. */
  id: string;
  seq: number;
  /** Milliseconds from the start of the run. */
  at: number;
  kind: WorkloadKind;
  /** T01…: the work request this event is about. */
  task?: string;
  text: string;
  /** Work it adds (requests and follow-ups), in milliseconds. */
  work?: number;
  ci?: { passed: boolean; failures: string[] };
}

export interface WorkloadOptions {
  seed: number;
  /** Events in all (chat messages and CI results). */
  messages: number;
  /** Of which work requests. */
  requests: number;
  /** How long the stream lasts, in minutes, before time scaling. */
  durationMin: number;
  /** Multiplies every time in the stream (gaps and amounts of work): below 1 is a busier chat. */
  timeScale: number;
}

export interface Workload {
  options: WorkloadOptions;
  events: WorkloadEvent[];
  counts: Record<WorkloadKind, number>;
  /** When the last event arrives, in milliseconds. */
  span: number;
}

export const DEFAULT_WORKLOAD: WorkloadOptions = { seed: 7, messages: 300, requests: 20, durationMin: 180, timeScale: 1 };

const MIN = 60_000;

const FEATURES = [
  'the pricing page',
  'a dark mode toggle',
  'signup form validation',
  'the blog index with pagination',
  'a sticky header',
  'the 404 page',
  'image lazy loading',
  'a newsletter popup',
  'the team page',
  'search with suggestions',
  'a cookie banner',
  'the checkout summary',
  'an FAQ accordion',
  'the footer sitemap',
  'a contact form with spam protection',
  'the product gallery',
  'RSS for the blog',
  'a changelog page',
  'keyboard shortcuts for the editor',
  'the settings page',
  'a status badge in the navbar',
  'print styles for invoices',
  'the onboarding checklist',
  'social share buttons',
];

const TWEAKS = [
  'make the buttons rounded',
  'add a loading state',
  'use the brand color for links',
  'it should work on mobile too',
  'add an empty state',
  'keep the old URL working',
  'add a test for it',
  'move it above the fold',
  'make the copy shorter',
  'add aria labels',
];

const CHATTER = [
  'Thanks!',
  'How is it going?',
  'Nice, looks good so far.',
  'I will be away for a bit.',
  'Back now.',
  'No rush on any of this.',
  'Coffee break.',
  'Great work, team.',
  'Can you keep me posted?',
  'Hmm, interesting.',
  'Ok.',
  'Let me know when something is ready to look at.',
];

const TESTS = [
  'header.test.ts > renders the title',
  'nav.test.ts > links work',
  'form.test.ts > shows errors',
  'api.test.ts > returns 200',
  'layout.test.ts > fits on mobile',
  'a11y.test.ts > has labels',
];

/** How the events split for a stream of this size: roughly 2 follow-ups per request, 1 stop per 5 requests, 30% CI. */
export function composition(messages: number, requests: number): Record<WorkloadKind, number> {
  const req = Math.max(1, Math.min(requests, Math.floor(messages / 3)));
  const followUps = Math.min(req * 2, Math.floor(messages * 0.15));
  const stops = Math.max(req >= 3 ? 1 : 0, Math.round(req * 0.2));
  const ci = Math.round(messages * 0.3);
  const chatter = Math.max(0, messages - req - followUps - stops - ci);
  return { request: req, 'follow-up': followUps, stop: stops, ci, chatter };
}

/** The arrival rate's shape over the run (relative, peak 1): a quiet baseline and three bursts. */
export function rateShape(f: number): number {
  const burst = (c: number, w: number) => Math.exp(-((f - c) ** 2) / (2 * w * w));
  return Math.min(1, 0.25 + 0.75 * Math.max(burst(0.15, 0.05), burst(0.45, 0.06), burst(0.78, 0.05)));
}

/** A time in [from, to) drawn from the rate's shape (rejection sampling). */
function arrival(r: Rng, from: number, to: number, span: number): number {
  for (let i = 0; i < 1000; i++) {
    const t = r.range(from, to);
    if (r.next() < rateShape(t / span)) return t;
  }
  return r.range(from, to);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function generateWorkload(opts: Partial<WorkloadOptions> = {}): Workload {
  const o: WorkloadOptions = { ...DEFAULT_WORKLOAD, ...opts };
  const r = rng(o.seed);
  const span = o.durationMin * MIN;
  const counts = composition(o.messages, o.requests);
  type Draft = Omit<WorkloadEvent, 'id' | 'seq'>;
  const drafts: Draft[] = [];

  // Requests come in over the first 70% of the run, so most of them can finish inside it.
  const features = r.shuffle(FEATURES);
  const requestTimes = Array.from({ length: counts.request }, () => arrival(r, 0, span * 0.7, span)).sort((a, b) => a - b);
  const tasks = requestTimes.map((at, i) => ({ id: `T${pad(i + 1)}`, at, feature: features[i % features.length], work: (10 + 30 * r.next() ** 2) * MIN }));
  for (const t of tasks) drafts.push({ at: t.at, kind: 'request', task: t.id, text: `Please build ${t.feature} (task ${t.id}).`, work: t.work });

  // Stops: some tasks are called off a few minutes after they were asked for; they get no follow-ups.
  const stopped = new Set(r.shuffle(tasks.slice(1)).slice(0, counts.stop));
  for (const t of stopped) drafts.push({ at: t.at + r.range(3, 15) * MIN, kind: 'stop', task: t.id, text: `Stop ${t.id}, we do not need it anymore.` });

  const open = tasks.filter((t) => !stopped.has(t));
  for (let i = 0; i < counts['follow-up']; i++) {
    const t = open.length ? r.pick(open) : tasks[0];
    drafts.push({ at: t.at + r.range(2, 30) * MIN, kind: 'follow-up', task: t.id, text: `For ${t.id}: ${r.pick(TWEAKS)}.`, work: r.range(2, 8) * MIN });
  }

  // CI runs on the branches of tasks asked for in the last hour.
  const first = tasks[0]?.at ?? 0;
  for (let i = 0; i < counts.ci; i++) {
    const at = arrival(r, Math.min(span, first + 5 * MIN), span, span);
    const recent = tasks.filter((t) => t.at <= at && at - t.at <= 60 * MIN);
    const t = recent.length ? r.pick(recent) : tasks.filter((x) => x.at <= at).at(-1) || tasks[0];
    const passed = !r.chance(0.35);
    const failures = passed ? [] : r.shuffle(TESTS).slice(0, r.int(1, 3));
    const text = passed ? `CI on crew/${t.id}: all checks passed.` : `CI on crew/${t.id}: ${failures.length} failed (${failures.join('; ')}).`;
    drafts.push({ at, kind: 'ci', task: t.id, text, ci: { passed, failures } });
  }

  for (let i = 0; i < counts.chatter; i++) drafts.push({ at: arrival(r, 0, span, span), kind: 'chatter', text: r.pick(CHATTER) });

  const events = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => a.d.at - b.d.at || a.i - b.i)
    .map(({ d }, i) => {
      const at = Math.round(d.at * o.timeScale);
      return { ...d, at, ...(d.work !== undefined ? { work: Math.max(1000, Math.round(d.work * o.timeScale)) } : {}), id: `msg_${i + 1}`, seq: i + 1 };
    });
  return { options: o, events, counts, span: events.at(-1)?.at ?? 0 };
}
