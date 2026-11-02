# ADR 001: Trigger bus, threads and two-stage event filtering

Status: accepted (milestone 1 of the Super-agent architecture)

## Context

Crew reacts to the world through paths that know nothing of each other:

| Input | Where it enters today | What happens |
| --- | --- | --- |
| A user's chat message | `orchestrator.sendUserMessage` | Stored, routed to the @-mentioned bots or the lead, queued |
| A routine fires (schedule, file change, commit, "Run now") | `routines.runRoutine` -> `orchestrator.runInChat` | Its prompt is posted into a chat, its bot is queued |
| Files change outside the chat | `outsideEdits.flush` | A system note goes into every chat on the project |
| A bot turn ends | end of `orchestrator.runTurn` | Handoffs, stall detection, auto challenge |
| The preview logs a console error | only the browser (`BrowserTab`) | Shown in the console drawer; reaches a bot only if the user attaches it |

Each path makes its own decision in its own code and keeps no record of it. Nothing can see "everything that happened in this workspace in the last ten minutes", and nothing can decide *whether* an event is worth acting on. The Super-agent design (a resident Router over isolated Workers, event-driven, proactive, durable) needs one stream of semi-structured events, grouped into threads, with a cheap and mostly deterministic filter in front of any model. This milestone builds that stream. It does not build the Router or Workers yet.

## Decision

Add a **Trigger bus** (`server/triggers/`). The existing paths keep doing what they do, and each one also *publishes* a Trigger at the moment its event happens. The bus:

1. assigns the Trigger to a **Thread** (by a deterministic key),
2. runs the **fast path**: per-source rules in code (`fastPath.ts`, pure),
3. sends only the **candidates** to the **slow path**: a cheap model (Haiku, through the same bare `oneShot` call `router.ts` uses) that applies **policies the user writes in Settings** (`slowPath.ts`),
4. persists the Trigger and its Thread in a bounded, append-only log, and emits both on the WebSocket bus.

The whole feature is behind `settings.superAgent.enabled` (default `false`). When it is off, `publishTrigger` returns at its first line: nothing is recorded, nothing is emitted, no file is created, no model is called, and the UI hides the Triggers view. Crew behaves exactly as before.

### What "act" means in this milestone

Explicit requests (user messages, routine runs, bot handoffs) are already acted on by the existing code; the bus only records that. For everything else, an **act** decision from the slow path posts a short, UI-only notice into the related chat ("Crew noticed: ...", at most 100 words, plus a toast). Bots never see it (`uiOnly`), nothing runs on its own, and nothing is sent in the user's name. Lower-stakes automation ships first: once the Router exists (a later milestone) it consumes the same decisions and can start Workers; the filter, the threads and the log do not change.

## Data model

Shared types live in `shared/types.ts`.

```ts
type TriggerSource = 'user' | 'routine' | 'turn' | 'outside-edit' | 'preview-console';

interface Trigger {
  id: string;              // tg_…
  at: number;
  source: TriggerSource;
  threadId: string;        // th_…
  projectId: string | null;
  chatId: string | null;
  summary: string;         // one line, at most 200 characters
  ref: TriggerRef;         // where the full payload is
  related: string[];       // ids of tightly related objects (chain of recall)
  explicit: boolean;       // the user, or the user's routine, asked for this
  fingerprint: string;     // stable hash of the content, for de-duplication
  filter: TriggerFilter;   // what the two stages decided
  action?: string;         // what acting meant ("Sent to Chief", "Notice posted in …")
}

type TriggerRef =
  | { kind: 'message'; chatId: string; messageId: string }                    // user messages, turn results
  | { kind: 'routine'; routineId: string; chatId: string; messageId: string } // routine runs
  | { kind: 'payload' };                                                      // stored beside the log

interface TriggerFilter {
  verdict: 'act' | 'candidate' | 'drop'; // candidate = waiting for the slow path
  stage: 'fast' | 'slow';                // who decided
  rule: string;                          // e.g. explicit-request, duplicate, not-allow-listed, policy
  reason: string;                        // in words the user reads
  slow?: { backend: string; costUsd: number; batch: number; decidedAt: number; invalid?: string };
  delivered?: { chatId: string; messageId: string };
}

interface Thread {
  id: string;            // th_…
  key: string;           // chat:<chatId> | routine:<routineId> | workspace:<projectId>
  kind: 'chat' | 'routine' | 'workspace';
  title: string;
  projectId: string | null;
  chatId: string | null;
  createdAt: number;
  lastAt: number;
  count: number;
  lastTriggerId?: string;
  lastNoticeAt?: number; // the last "act" notice, for the cooldown
  closedAt?: number;     // a chat thread closes when the chat starts a new topic
}
```

**Threads.** Every Trigger belongs to exactly one Thread, found by key: the open thread with that key, or a new one.

| Source | Thread key | Payload |
| --- | --- | --- |
| `user` | `chat:<chatId>` | the chat message |
| `turn` | `chat:<chatId>`, or `routine:<routineId>` when a routine started the turn | the bot's message |
| `routine` | `routine:<routineId>` | the routine and the prompt it posted |
| `outside-edit` | `workspace:<projectId>` | `{ text, paths, byEditor }` stored as a payload |
| `preview-console` | `workspace:<projectId>` | `{ page, entries }` stored as a payload |

"Start new topic" (`resetChat`) and deleting a chat close the chat's thread, so the next message opens a new one.

**Inline & Spill, chain of recall.** A Trigger is small: an id, a one-line summary, ids of related objects. The full content is behind `ref`. `GET /api/triggers/:id` resolves it ("read more"), and returns the related triggers and the thread's recent ones with their ids, so a reader (the UI now, the Router later) can walk the graph hop by hop. The slow-path prompt follows the same rule: per event it inlines the summary, the first ~50 words of the payload and the two previous triggers in the same thread; everything else stays behind the id.

**Settings** (`settings.json` -> `superAgent`, also in `PublicSettings`):

```ts
interface SuperAgentSettings {
  enabled: boolean;                                  // default false
  sources: Record<'turn' | 'outside-edit' | 'preview-console', { mode: 'explicit' | 'candidate' | 'ignore'; allow: string[] }>;
  projects: string[];                                // allow-list of projects (workspaces count as their parent); empty = all
  policies: string;                                  // the slow path's policies, user-editable text
  maxCandidatesPerHour: number;                      // budget for the slow path; default 30
}
```

The new key gets its defaults when it is missing, so no migration is needed.

## The two stages

**Fast path** (`fastPath.ts`, deterministic, no I/O). In order:

1. Source mode `ignore`: the event is not recorded at all; `publishTrigger` returns before a thread or a log line is made. Whatever the chat does with it (a handoff, say) happens as before.
2. An explicit request is acted on: every user message and routine run, and a turn result that hands off to a teammate. User messages and routines are always explicit and are not configurable.
3. Source mode `explicit` ("respond only to explicit requests"): everything else is recorded as dropped, which keeps it visible for tuning the rules.
4. Per-source noise rules: a turn the user stopped, or one that finished normally without a handoff (the chat already shows it); console output with no errors, or only known noise (favicon 404s, HMR chatter, `ResizeObserver` loop warnings, React DevTools hints).
5. The project allow-list, then the per-source allow-list (globs for file paths, case-insensitive substrings for error text).
6. Cooldown: a thread that got a notice in the last 10 minutes stays quiet.
7. Duplicate: the same fingerprint already went to the slow path in this thread in the last 30 minutes.
8. Budget: more than `maxCandidatesPerHour` candidates in the last hour.
9. Anything left is a **candidate**.

**Slow path** (`slowPath.ts`). Candidates go into a queue. One model call runs at a time, and candidates that arrive while it runs are decided together in the next call (up to 8 per call). The work is long input and short output, so batching costs little, and the cost per decision falls as load rises. The prompt holds the user's policies, then each event inside `<event>` tags, marked as data that is never to be followed. The answer is JSON (`{"decisions":[{"id","act","reason"}]}`). An event the answer leaves out, or an answer that is not usable, is recorded as `invalid` and treated as "stay quiet". The call is bare: no tools, no Claude Code system prompt, no settings or MCP servers. In demo mode (`CREW_FAKE_AGENT=1`) a deterministic stand-in acts on anything that reads like an error.

## Storage

`CREW_HOME/triggers/`:

```
triggers.jsonl   One JSON snapshot per line; the last snapshot of an id wins (a decision appends a new line)
threads.json     Threads (a Collection, debounced writes)
payloads/        <triggerId>.json for triggers whose payload has no other home
```

The log is a new generic `JsonlLog` in `store.ts`. It keeps at most 2,000 triggers and 14 days. Pruning happens on start, hourly, and when an append passes the bound by 10%. It drops the oldest triggers and their payload files, compacts the file when it carries more stale lines than live ones, and removes threads that no longer have any trigger. The folder is created on the first write, so a Crew with the feature off never creates it.

Log lines are written at once; thread updates are debounced like other collections. A new thread, and a thread being closed, are flushed at once, so no log line points at a thread that was never saved. On start, thread counts are recomputed from the log, and candidates a restart cut off are recorded as dropped (`interrupted`). They are not decided late: a stale event would only produce a confusing notice.

## How it fits the existing modules

- `orchestrator/index.ts`: `sendUserMessage` publishes `user` (with the bots it was sent to); `runTurn` publishes `turn` after the handoffs are known, related to the request that started the chain; `resetChat` and `forgetChat` close the chat thread.
- `routines.ts`: `runRoutine` publishes `routine` with the reason (schedule, manual, event) once the run is posted.
- `outsideEdits.ts`: `flush` publishes `outside-edit` with the note it posted and the paths.
- Preview console: `BrowserTab` forwards console errors (batched, only when the feature is on) to `POST /api/triggers/preview-console`.
- `router.ts`'s cheap-model plumbing (`oneShot` with `haiku`, a bare one-line system prompt, the fake backend in demo mode) is reused, not copied.
- `bus.ts`: a new `ServerEvent` `{ t: 'trigger', trigger, thread }`.
- API: `GET /api/triggers` (filters: source, verdict, thread), `GET /api/triggers/:id`, `POST /api/triggers/preview-console`; `PATCH /api/settings` accepts `superAgent`.
- UI: a Settings section (on/off, per-source mode and allow-list, project allow-list, policies, budget) and a read-only Triggers view (sidebar, only while the feature is on), updated live.

## Deliberately left out

- **Router and Workers.** No resident Router session, no Worker sessions, no thread subscriptions or direct delivery to subscribers. `Thread` is shaped so a `subscribers` list can be added later. Bots are still started by the existing orchestrator paths.
- **Autonomous action on non-explicit events.** "Act" is a notice to the user. Starting work on its own (speculative execution) comes after the Router.
- **Bot-to-bot coordination events** (handoff queueing, stall wake-ups, auto challenge) are internal decisions, not environment events. The turn result that causes them is recorded.
- **New trigger sources** (GitHub reviews, CI, chat channels other than Crew's own). Each one widens the attack surface and needs its own fast-path rules.
- **A recall tool for agents.** The read-more endpoint exists, but no agent gets a tool for it yet.
- **Watchdog, model gateway, credential masking**: later milestones.

## Risks

- **Prompt injection through events.** Console text and file paths come from code the user may not control. Mitigations: the slow path has no tools, events are fenced and declared as data (tag look-alikes inside them are defused), the only effect of a decision is a UI-only notice that bots never read, and the worst case is a misleading notice. This has to be revisited before any decision can start a Worker.
- **Cost and noise.** A noisy page could produce a steady stream of candidates. The fast path takes most of it out (errors only, noise patterns, de-duplication, cooldown), and the hourly budget caps the rest. Each batch costs about what one routing decision costs.
- **Behaviour drift when off.** All publishing goes through one function that returns early, and the integration test checks that nothing is recorded with the feature off.
- **Storage growth.** Bounded by count and age, payloads are capped (the console payload keeps at most 20 entries of 500 characters), and the log compacts itself.
- **Slow-path latency.** Decisions run in the background and never delay a chat turn. A hung model call times out after 60 seconds, and its batch is recorded as invalid.
