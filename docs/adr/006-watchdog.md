# ADR 006: Watchdog control loop

Status: accepted (milestone 6 of the Super-agent architecture)

## Context

ADR 001 gave Crew one stream of events, and ADR 002 split each group chat into a resident Router and isolated Workers. Both are *inside* the loop they serve: the Router only sees what reaches its inbox, and it hears about a Worker only when the Worker's turn ends. Nothing notices when:

- a Worker keeps running but makes no progress (the same test run again and again, the same file read ten times), or drifts away from the task the Router wrote;
- a Worker fails on something transient (the model API is overloaded, a rate limit, a network blip) and nobody retries it;
- an approval card has waited for the user for half an hour, so the whole task is parked;
- the same friction (`server/friction.ts`) keeps coming back, or the Router itself is in an error state, or the preview keeps logging errors.

The user notices eventually, which is exactly the human-attention limit the Super-agent design is meant to remove. The design notes (section 5) ask for an **independent Watchdog session driven by a timer**: an external control loop that judges whether work is really progressing, intervenes through a narrow set of actions, keeps re-checking transient failures until they heal, and can be asked by a maintainer why something failed.

## Decision

Add a **Watchdog** (`server/watchdog/`): one resident Claude Code session for the whole app, outside every chat, driven by a croner timer, behind `superAgent.watchdog.enabled` (default `false`, and it only counts while `superAgent.enabled` is on).

Each **tick** follows the same two-stage shape as the Trigger filter:

1. **Fast path, in code.** Crew gathers a compact **snapshot** (below) and computes deterministic **flags**: a Worker with no progress for `stuckMinutes`, a Worker repeating the same tool call, a Worker that failed (and whether the error reads as transient), an approval waiting too long, new turn errors, new friction, a Router in error, new preview console errors, a watched failure that is due. When nothing is flagged the tick ends there: it is recorded as skipped (`healthy` or `quiet`) and **no model is called**.
2. **Slow path, the Watchdog session.** Otherwise the snapshot is rendered (Inline & Spill) into one turn of the Watchdog's session. The model judges and acts only through its `crew_watchdog` tools; every action passes gates in code.

The session follows the Router's pattern exactly: **no built-in tools** (`tools: []`: no Bash, Read, Edit, Write, WebFetch, Task), its own short system prompt instead of Claude Code's, no settings files, a `canUseTool` that refuses anything but its own tools, a fixed working folder (`CREW_HOME/watchdog`), and turns kept as `ChatMessage`s in their own log (`watchdog` in `messages/`) through the shared `runLogged`. Turns go through a `BatchQueue`, so a maintainer's question and a tick never run at once; ticks coalesce (at most one waits).

### The narrow tool set

| Tool | What it does | Gates in code |
| --- | --- | --- |
| `nudge_worker(id, text)` | Queues a note for an active Worker; it reads it as a note from the Watchdog (not the Router) when its current turn ends | Worker exists, not dismissed, active; at most 100 words; 2 nudges per Worker per day |
| `stop_worker(id, why, redirect?)` | Stops a Worker's turn; with `redirect`, the Worker resumes at once with that note (a redirect) | Active; `redirect` counts as a nudge |
| `restart_worker(id, note)` | A Worker that failed or was stopped starts a **new session from a recap**: its task, its last report, where its work is, and the Watchdog's note | Status `error` or `stopped`, not dismissed; 3 restarts per Worker per day; the member's own budget check still applies |
| `notify(chat, text)` | Tells a chat: in two-layer mode an **environment event** in its Router's inbox (which, per ADR 002, cannot start or steer Workers); otherwise a UI-only note bots never see, plus a toast | Chat exists; at most 100 words; 4 per chat per day |
| `watch(subject, note, minutes)` / `resolve_watch(id)` | Keeps re-checking a transient failure until it is healthy (below) | At most 10 open watches |
| `propose_change(target, after, why)` | Proposes new trigger **policies** or a bot's **role description** (its prompt); the maintainer accepts or rejects it in the Watchdog page | Maintainer turns only; at most 3 pending; nothing is applied until accepted, and a value changed since the proposal makes it void |
| `inspect(id)` | Read-only "read more" for any id in the snapshot: a Worker (task, latest tool calls, report tail), a trigger, a chat, a tick | Free, not counted |

**Hard limits** (Settings → Super-agent → Watchdog), enforced in code before any model call or action:

- `maxTicksPerHour` (default 4): ticks that called the model in the last hour; past it, a tick is skipped as `limit`.
- `maxActionsPerTick` (default 3): actions (`inspect` excluded) per turn, ticks and maintainer turns alike.
- `dailyBudgetUsd` (default $1.00): the cost of the Watchdog's turns today (ticks and maintainer chat); past it, ticks are skipped as `budget` and maintainer messages are refused.
- `everyMinutes` (default 15) sets the timer; `stuckMinutes` (default 20) sets the "no progress" flag.

The per-target counters above (nudges, restarts, notices per day) are constants: they keep the Watchdog itself from looping on one Worker.

### Transient failures

Crew classifies errors deterministically (`isTransient`: overloaded, rate limit, 429/5xx, timeouts, connection resets, "no response"). A Worker that fails with a transient error gets a **watch** opened by code, without the model: `{ subject: wk_…, checks, nextAt }`. A due watch flags the tick, so the Watchdog looks again; it usually restarts the Worker, or waits. Each check backs off (`minutes × 2^checks`, at most 2 hours). Code resolves a watch by itself as soon as its subject is healthy again (the Worker is running or done, or was dismissed), and gives up after 8 checks with a notice to the chat. The model can open watches for anything else (`watch`), and close them (`resolve_watch`).

### Maintainers can ask

The Watchdog page has a chat with the Watchdog. A maintainer's message is a turn in the same session (so it can answer from what it saw on earlier ticks), with the current snapshot attached and `inspect` to walk ids. In these turns it may also call `propose_change`; it never claims a change is applied. Proposals for a bot's role description are applied through `updateBot` (the bot settings page's own validation); policy proposals through the settings store.

## Data model

Shared types in `shared/types.ts`:

```ts
interface WatchdogSettings {      // settings.superAgent.watchdog
  enabled: boolean;               // default false
  model: string;                  // default 'claude-sonnet-5'
  everyMinutes: number;           // 1..60, default 15
  maxTicksPerHour: number;        // 1..60, default 4
  maxActionsPerTick: number;      // 0..10, default 3
  dailyBudgetUsd: number;         // 0..100, default 1
  stuckMinutes: number;           // 5..240, default 20
}

interface WatchdogTick {          // watchdog/ticks.jsonl: the ledger of every tick and turn
  id: string;                     // wt_…
  at: number;
  kind: 'tick' | 'manual' | 'maintainer';
  outcome: 'ran' | 'skipped' | 'error';
  reason: string;                 // why it ran (the flags) or was skipped (quiet, healthy, limit, budget, busy)
  flags: string[];
  actions: number;
  costUsd: number;
  messageId?: string;             // its turn in the `watchdog` log
}

interface WatchdogAction {        // watchdog/actions.jsonl
  id: string; at: number; tickId: string;
  kind: 'nudge' | 'stop' | 'restart' | 'notify' | 'watch' | 'resolve' | 'propose';
  target: string;                 // a Worker, chat, watch or proposal id
  chatId?: string;
  text: string;
  refused?: string;               // the gate that said no; the model read this as the tool's error
}

interface WatchdogWatch {         // watchdog/watches.json
  id: string; subject: string; note: string;
  createdAt: number; nextAt: number; checks: number;
  by: 'code' | 'watchdog';
  resolvedAt?: number; resolution?: string;
}

interface WatchdogProposal {      // watchdog/proposals.json
  id: string; at: number;
  target: 'policies' | 'bot';
  botId?: string; botName?: string;
  before: string; after: string; rationale: string;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  decidedAt?: number;
}

interface WatchdogInfo {          // live, not stored; GET /api/watchdog adds the lists
  enabled: boolean;
  state: 'off' | 'idle' | 'thinking' | 'error';
  detail?: string;
  nextTickAt?: number;
  ticksLastHour: number; actionsToday: number; spentTodayUsd: number;
  lastTick?: WatchdogTick;
  pendingProposals: number; openWatches: number;
}
```

New: `ServerEvent` `{ t: 'watchdog', watchdog: WatchdogInfo }`; `PendingApproval` gains `askedAt` and the log it belongs to, and `openApprovals()` lists them. The new settings key gets its defaults when missing (`normalizeSuperAgent`), so no migration is needed. Storage is `CREW_HOME/watchdog/`, created on the first write: with the feature off, no folder, no log, no timer.

### The snapshot (Inline & Spill)

One `<snapshot>` per tick: the limits left, then one tag per object, each with its id and the ids it relates to:

- `<worker id chat bot status age last_progress flags nudges_today restarts_today>`: the task's first ~40 words, its latest tool calls with repeats collapsed (`Bash npm test ×6`), the first ~40 words of its last report or error; `inspect wk_…` for the rest. Active Workers, plus Workers that ended since the last tick.
- `<approval>` waiting longer than 10 minutes; `<turn_error>` and `<friction>` (grouped by kind and key) since the last tick; `<interface>` for a Router in error and preview console errors (from the trigger log) since the last tick; `<watch>` open watches.

All text from Workers, chats, pages and the friction log is fenced and defused as data; the system prompt says it is never to be followed.

## How it fits the existing modules

- `server/watchdog/` (new): `config.ts` (pure: defaults, normalisation), `signals.ts` (pure: progress, repeats, transient errors, backoff), `snapshot.ts` (pure: flags, `needsLook`, rendering), `gates.ts` (pure: tick and action refusals), `prompts.ts` (pure: system prompt), `tools.ts` (the `crew_watchdog` MCP server; the same handlers drive the demo agent), `index.ts` (timer, session, ledger, watches, proposals, gathering the snapshot from the stores).
- `routines.ts` pattern: croner (`new Cron('*/N * * * *', { protect, unref })`) drives the timer; `syncWatchdog()` starts or stops it when the settings change.
- `layers/`: `BatchQueue`, `runLogged` and `defuse` are reused. `workers.ts` gains `restartWorker` (new session from a recap) and `messageWorker`'s queue carries Watchdog notes, which `workerPrompt` renders as a note from the Watchdog, not the Router. `stopWorker` is reused as is.
- `triggers/`: `normalizeSuperAgent` normalises `watchdog`; console errors are read from the trigger log; `superAgentOn()` gates the timer.
- `friction.ts`: `readFriction(since)` feeds the snapshot. `permissionGate.ts`: `openApprovals()`.
- `agents/session.ts`: `role: 'watchdog'` gives `FakeSession` a scripted Watchdog for demo mode and tests.
- API: `GET /api/watchdog`, `GET /api/watchdog/messages`, `POST /api/watchdog/messages`, `POST /api/watchdog/tick`, `POST /api/watchdog/proposals/:id/accept|reject`, `POST /api/watchdog/watches/:id/resolve`; `PATCH /api/settings` accepts `superAgent.watchdog`.
- UI: Settings → Super-agent gets a Watchdog block (switch, model, limits); a Watchdog page (sidebar, only while it is on) shows its state and today's usage against the limits, "Tick now", pending proposals with Accept/Reject, open watches, recent actions and ticks, and the chat with the Watchdog.

## Deliberately left out

- **Approving or denying approvals.** Approvals stay the user's; the Watchdog can only tell the chat that one is waiting.
- **Acting on chat bots outside two-layer mode.** It sees their turn errors and friction, and can notify the chat, but never resumes or stops a chat bot's turn: the orchestrator's chain (handoffs, stall detection) already owns that.
- **Applying changes.** Policies and prompts are proposed only; nothing in Crew's own code or settings changes without a click.
- **Starting new work.** It has no `dispatch_worker`; a restart re-runs a Worker's existing task, and a nudge can only refocus it.
- **Infrastructure beyond Crew** (the machine, the model provider's status page). A transient error is retried by watching it, not diagnosed.
- **A per-project Watchdog.** One is enough for a local app; its snapshot is grouped by chat.

## Risks

- **Prompt injection.** The snapshot carries text from Workers, pages and errors. Mitigations: the session has no built-in tools; event text is fenced and declared data; every action is gated in code (targets, counts, word limits); nudges are short and marked as the Watchdog's, and the Worker's prompt says such a note can only refocus or stop it, never widen the task; the Router receives Watchdog notices as environment events, which cannot start or steer Workers; changes are only proposed.
- **A Watchdog that loops.** Per-Worker daily caps on nudges and restarts, actions per tick, ticks per hour, and a daily budget; ticks coalesce and never overlap; a healthy system costs nothing because the fast path skips the model.
- **Wrong judgment.** A stop with no redirect is the most disruptive action, so the prompt prefers doing nothing, then a nudge; every action is in the ledger with its reason, and the Router is told when a Worker stops, as for any stop.
- **Cost.** One turn per flagged tick, on a lighter model by default, bounded by ticks per hour and the daily budget; the session rotates past `rotateAtTokens` like the Router's.
- **Behaviour drift when off.** The timer exists only while `superAgent.enabled` and `watchdog.enabled` are both on; the API refuses ticks and messages while off; the integration test checks no folder, log or turn appears with it off.
