# ADR 003: Thread subscriptions and direct routing to Workers

Status: accepted (milestone 3 of the Super-agent architecture)

## Context

After ADR 002, every event in a router-mode chat that needs a decision goes through the chat's Router: the user's messages, routine runs, Workers' reports, and environment Triggers the slow path acted on. The Router is a model call; it batches, but it still sits on the hot path of everything, including events whose owner is obvious:

- **A routine the Router already gave to a Worker.** "Every morning, run the tests and fix what fails": the Router dispatches a Worker on the first run. On every later run it reads the same prompt again, works out again that the same Worker should take it, and messages it.
- **Events in a workspace Workers are working in.** A preview console error, or a file edited by hand on the chat's branch, goes to the cheap model, then (if it acts) to the Router, which cannot start or steer Workers for an environment event (ADR 002's gate). The Workers that could use it, the ones editing that code right now, never hear of it.
- **Workers that share a branch.** Parallel Workers land their changes in the chat's branch one after the other. When Worker A merges `src/App.tsx`, Worker B, which is editing the same file, finds out only when its own landing conflicts, after its whole turn. Landings go through `whenChatFree`, which marks the chat's workspace quiet, so not even an outside-edit note is produced.

ADR 001 shaped Threads for this ("a `subscribers` list can be added later") and ADR 002 left it out. The Super-agent design: when the Router starts a Worker for a Thread, the Worker subscribes to it, and later Triggers on that Thread go straight to the subscribers in code. The Router observes everything but only decides on Threads nobody is subscribed to.

## Decision

Behind a new switch, `superAgent.router.subscriptions` (default **off**), which only counts while two-layer mode is on (`routerMode(chat)`): a Worker subscribes to the Threads it is dispatched for, and the Trigger bus delivers later Triggers on those Threads to the subscribed Workers directly, before the slow path and without a Router call. With the switch off, nothing below runs: no subscription is made, no landing Trigger is published, every prompt and tool list is what it was.

- **Subscribed (fast path).** In `publishTrigger`, the bus looks up the Thread's *receivers* (below). If there are any, the fast path settles the Trigger as `act` with rule `subscribed`, records the Workers on it (`filter.direct`), puts it in each Worker's inbox and does nothing else: no cheap model, no Router turn.
- **Unsubscribed (slow path).** Exactly as before: rules, then the cheap model, then the Router.
- **The Router observes.** Triggers that went straight to a chat's Workers are listed in its next batch (`<direct>`), whenever that batch comes; they never start a Router turn by themselves. The `<workers>` lines show each Worker's subscriptions.
- **Workers can leave.** Two Worker tools: `unsubscribe_thread` stops a Thread's events, and `hand_back` unsubscribes and passes the event to the Router, which decides on it as on any other. The user can unsubscribe a Worker from the Workers bar.
- **Shared Threads, no direct talk.** Every Worker of a chat subscribes to the chat's workspace Thread, so all of them receive its events: hand edits, preview console errors, and a new **landing** Trigger Crew publishes when it merges a Worker's branch into the chat's branch. A Worker learns that another merged files it is editing, and can bring the chat's branch in early. The landing Trigger is written by Crew from facts (who, which files, which commit), never from the other Worker's words, so this is not a channel between Workers; anything that needs coordinating goes through the Router (reports, `message_worker`).
- **Counting.** Each chat counts the events its Router decided on and the events that went straight to its Workers instead (Router decisions avoided). The Workers bar shows both.

### What a Worker subscribes to

| Thread | When | What arrives on it |
| --- | --- | --- |
| `workspace:<id>` of the chat's workspace (or of the chat's folder, for a Worker without a worktree) | When the Worker's workspace is ready | Other Workers' landings, files edited outside the chat, preview console errors |
| `routine:<id>` of each routine run in the dispatching batch | At dispatch | The routine's later runs |

`dispatch_worker` takes `subscribe: false` for a one-off task. **Chat threads (`chat:<id>`) are never subscribable**: they carry the user's messages, and the Router is the only one who talks to the user. A Worker does not subscribe to its own worktree's Thread: nothing but its own work happens there.

### Receivers: who gets a Trigger

A Worker is a receiver of a Trigger when it subscribes to the Trigger's Thread, is not dismissed, did not cause the Trigger (a Worker is not told of its own landing), its chat is in two-layer mode with subscriptions on, and:

- for an **explicit** Trigger (a routine run, the user's own request): it is active (`starting`, `running`, `waiting`) or `done`. A finished Worker is woken for it, like a follow-up from the Router; a busy one takes it after its current turn.
- for an **environment** Trigger (console, outside edit, landing): it is active. Environment events never start work (ADR 002's gate still holds); they only reach sessions that are already working. With no active subscriber, the Trigger takes the normal path.

A Worker that failed or was stopped keeps its subscriptions but receives nothing until the Router messages it again; meanwhile its Threads' events go to the Router. Many-to-many: a Worker subscribes to several Threads, a Thread has several subscribers, and each receiver gets its own copy.

### How a delivered Trigger reaches a Worker's session

Each Worker has an inbox (at most 20 items, oldest dropped). An item is small (Inline & Spill): the Trigger and Thread ids, source, summary, and the first ~60 words of the payload, or, for a routine run, the user's prompt.

- **While a turn runs**, the session's existing `PostToolUse` hook (the one that sends the wrap-up reminder) takes what is in the inbox at the next tool call of the main loop and adds it to the model's context as `additionalContext`, fenced in `<event>` tags and marked as data. This is the "notice and resolve" part: a running Worker hears of a landing or a console error within one step, without Crew having to interrupt it.
- **At the start of a turn**, the prompt carries what is in the inbox.
- **When the Worker goes idle** with items it never read (they came after its last tool call): an environment Trigger nobody else read either goes back to the normal path (the rules, the cheap model, the Router) as if it had not been subscribed; an explicit one goes to the Router. If the user stopped the whole chat, they are dropped, as the Router's inbox is.

### Hand back

`hand_back({ thread, event?, note? })` unsubscribes the Worker and sends the event (by default the latest one it received from that Thread) to its Router: a routine run as a routine event (explicit: the Router can dispatch someone else), an environment Trigger as an environment event (which still cannot start or steer Workers), each with "wk_… handed it back: note". A Trigger is handed back once, however many Workers received it.

## Data model

```ts
interface RouterSettings { …; subscriptions: boolean }  // default false

type TriggerSource = 'user' | 'routine' | 'turn' | 'outside-edit' | 'preview-console' | 'landing';
type FilteredSource = Exclude<TriggerSource, 'user' | 'routine' | 'landing'>;  // landing has no settings: it only ever goes to subscribers

interface TriggerFilter {
  …
  direct?: ID[];                     // the subscribed Workers it went straight to
  handedBack?: { by: ID; at: number };
}

interface WorkerDelivery {            // one Trigger in a Worker's inbox
  triggerId: ID; threadId: ID; at: number;
  source: TriggerSource;
  explicit: boolean;                 // a routine run: the user's words; else data from the environment
  summary: string;
  text: string;                      // inlined: the prompt, or the payload's first words
}

interface Worker {
  …
  threads?: ID[];                    // the Threads it subscribes to
  inbox?: WorkerDelivery[];          // delivered, not read by its session yet
  received?: number;                 // Triggers it got directly, in all
}

Chat.router: { sessionId?; cursor?; decided?: number; direct?: number }  // events its Router decided on; events that went straight to its Workers
TriggerList.stats.direct                                                // Triggers in the log that went straight to Workers
```

**Subscriptions live on the Worker** (`Worker.threads`), not on the Thread. A subscription's lifetime is its Worker's (dismissed: gone; failed: inert; restarted: kept), the Worker record is already saved on change and sent live to the UI, and Threads have their own lifecycle (pruned with their last Trigger, chat threads closed on a new topic). The reverse lookup (a Thread's subscribers) is a scan over the Workers that are not dismissed, a handful per chat. `pruneTriggers` keeps any Thread a Worker still subscribes to, and subscribing to a Thread that has no Trigger yet stores it.

All new fields are optional and `normalizeRouter` fills in the new setting, so no migration is needed.

### Counting Router decisions avoided

`Chat.router.decided` grows by the number of events in each Router turn's batch. `Chat.router.direct` grows by one for each Trigger that went straight to at least one of the chat's Workers, and shrinks again if that Trigger ends up with the Router anyway (handed back, or read by nobody). So `direct` is the number of Router decisions avoided, and `direct / (direct + decided)` is the share of the chat's events the Router never had to look at (the essay's experiment saw about 30%). Both are cumulative and survive "Start new topic".

## Life of a routine with direct routing

1. The routine runs. `runInChat` posts its message and now publishes the `routine` Trigger itself (passed in by `runRoutine`), before deciding where it goes.
2. First run: nobody subscribes to `routine:<id>`. The Router gets it as before; the event now carries its Trigger and Thread ids. The Router dispatches a Worker, which subscribes to the routine's Thread and, once its workspace is ready, to the chat's workspace Thread. Its report goes to the Router, which tells the user.
3. Next run: the Worker is `done`, so it is a receiver. The fast path settles the Trigger as `subscribed`; the run goes into the Worker's inbox and wakes it; the Router is not called (`direct` +1), and its next batch lists the run under `<direct>`. The Worker's report goes to the Router, which decides what the user hears.

## How it fits the existing modules

- `triggers/fastPath.ts`: `FastContext.subscribers` (the receivers' ids); rule `subscribed` for explicit requests and for environment events that pass the noise rules (noise, "ignore" and "explicit only" still apply; the allow-lists, cooldown and hourly budget do not, since no model is called); a duplicate of a Trigger already delivered to the Thread's subscribers in the last 30 minutes is dropped; `landing` goes to subscribers or is dropped (`no-subscribers`).
- `triggers/index.ts`: receivers lookup and delivery in `publish`; `ensureThread`; `publishLanding`; `rerouteTrigger` (back to the normal path); `handBackTrigger`; pruning keeps subscribed Threads; `stats.direct`.
- `layers/subscriptions.ts` (new, pure): the receiver rule, the inbox bound, the setting check.
- `layers/workers.ts`: subscribing at dispatch and at launch, `deliverToWorker`, draining the inbox into the session or the turn prompt, settling unread items when the Worker goes idle, the Worker's thread tools, cleanup on dismiss, delete and restart, and the landing Trigger after a merge.
- `layers/router.ts` / `layers/tools.ts` / `layers/prompts.ts`: `decided` counting, the `<direct>` block and per-Worker subscriptions in the batch prompt, a paragraph in the Router's system prompt (only when on), `dispatch_worker`'s `subscribe` flag, routine and environment events that were handed back, and the Worker's delivered-event rendering.
- `agents/session.ts`: `SessionConfig.deliveries()`, read by the `PostToolUse` hook beside the wrap-up note; the demo agent reads it too (a "slow" demo Worker stops waiting when an event arrives, and its report lists the events it read, which makes delivery testable without a model).
- `agents/crewTools.ts` and `agents/prompts.ts`: a Worker gets `unsubscribe_thread` and `hand_back`, and a paragraph on events, only while subscriptions are on.
- `orchestrator/index.ts`: `runInChat` publishes the routine Trigger and skips the Router when it went straight to Workers; `resumeRouters` does not hand a directly delivered routine run to the Router again after a restart, but does hand over runs a restart cut off in a Worker's inbox.
- API: `POST /api/workers/:id/unsubscribe` (`{ threadId }`), `GET /api/workers/:id/messages` also returns the Worker's Threads; `PATCH /api/settings` accepts `superAgent.router.subscriptions` and refreshes Worker sessions when it changes.
- UI: Settings → Router gets the switch; the Workers bar shows events that went straight to Workers next to the Router's own count, and each Worker's subscriptions and unread events; a Worker's dialog lists its Threads with Unsubscribe; the Triggers view labels landings and counts direct deliveries.

## Deliberately left out

- **Subscribing to other Threads on request.** The Router cannot name arbitrary Threads for a Worker, and a Worker cannot subscribe to more on its own. The two kinds above cover what Crew's events are about today; new trigger sources (CI, review comments) will bring their own Threads and are the natural place for this.
- **Waking idle Workers for environment events** (speculative execution). A finished Worker that subscribes to the workspace does not get to fix a console error on its own; the error takes the normal path to the Router, which tells the user.
- **Mid-tool input.** A delivered event waits for the next tool call; a long Bash command is not interrupted. That is the full-duplex milestone.
- **A recall tool.** Delivered events inline about 60 words; the Worker reads files, `git log` and the preview console itself for the rest. Walking Triggers by id came with ADR 005: with the chain of recall on, a cut delivery names `recall id=tg_…`, and recall lists a Thread's subscribers, a Worker's subscriptions and the Workers a Trigger went straight to.
- **Direct routing of user messages.** Chat threads stay with the Router.
- **Persisting the Router's `<direct>` list and unread environment events across a restart.** They are dropped, as candidates cut off by a restart are; unread routine runs are handed to the Router.

## Risks

- **Prompt injection through events.** Console text and file paths now reach Workers that have full tools, without a model in between. Mitigations: an environment event never starts a turn, it only rides along in a turn the user's request started; it is fenced and marked as data, and tag look-alikes inside it are defused; the Worker could already read the same content (the preview console, the files), so the sandbox and the permission level stay the boundary, as ADR 002 says. The Router's `<direct>` lines carry no environment text, only ids, sources and Thread titles, so nothing untrusted rides along with the user's next message. A handed-back environment event is still an environment event at the Router.
- **Workers drifting off task.** An event is not an instruction; the Worker's system prompt says to act on one only when it bears on its task and to hand back the rest. The inbox is bounded and duplicates are dropped.
- **Cost.** Each delivery adds a few hundred tokens to each active subscriber's context; a routine run delivered to a Worker costs the turn the Router would have started anyway, minus the Router call.
- **Lost events.** A Worker that finishes before reading an event does not swallow it: unread environment events go back to the normal path, unread routine runs to the Router.
- **Behaviour drift when off.** One switch, default off; with it off `receivers` is empty, nothing subscribes, no landing is published and no prompt changes. The integration test runs the routine and console flows with the switch off and on.
