# ADR 005: Inline & Spill context and the chain of recall

Status: accepted (milestone 5 of the Super-agent architecture)

## Context

Every call re-reads the whole context, so what Crew injects into a prompt is paid for again on every later call of the session. Crew already saves in a few places, each in its own way:

| Where | What it does today |
| --- | --- |
| `contextDelta` (`agents/prompts.ts`) | The environment lines are sent in full on a session's first turn, then only the time and the lines that changed, plus "(The rest of the environment is unchanged.)" |
| `turnBody` / `recapPrompt` (`agents/prompts.ts`) | In a group chat, a teammate's message over 240 characters becomes one line (`digest`) with "read it with chat_history"; the latest message and the handoff stay in full, however long |
| `chat_history` (`agents/crewTools.ts`) | Reads messages of the current chat by `#seq`, or the latest few, in full |
| The slow path (`triggers/slowPath.ts`) | Per event: summary, first ~50 words, the thread's two previous triggers by id |
| The Router's batch (`layers/prompts.ts`) | User messages cut at 4,000 characters, Worker reports at ~80 words with `list_workers id=` as the read-more handle |
| `GET /api/triggers/:id` | A Trigger with its payload and neighbours, for the UI only |

ADR 001 and 002 gave every object an id and a `related` list (Triggers, Threads, Workers), and both left "a recall tool for agents" out. So an agent can see `tg_…` or `wk_…` in its prompt but cannot follow it; the only handle it can follow is `#seq` in its own chat, and the cut rules differ per site (characters here, words there, nothing for the latest message).

## Decision

Treat the context window as a cache with one rule set, **Inline & Spill**, and one tool, **`recall(id)`**, behind `superAgent.recall.enabled` (default `false`; it counts only while `superAgent.enabled` is on, like the Router). With it off, nothing below runs: prompts, tools and stored data are exactly as before.

1. **Every injected object carries its id**, plus the ids of tightly related objects: a message `#seq` (and `answers #n` when it replies to something other than the message just before it), a Trigger `tg_…` and its Thread `th_…`, a Worker `wk_…`, the environment `env`, the conversation itself `chat`.
2. **Start from the minimum and inline by locality.** Three tiers: the **focus** of the turn (the latest message, the message that handed the turn over, the user's own words) is inlined generously; what sits **next to** the focus (the message just before it, the message it answers) gets its first ~50 words; everything **far** gets only its id and one line. Anything over its budget **spills** behind a read-more handle (`recall id=… from=N`).
3. **`recall(id, from?)` returns the object under the same rules**: a header with its id and attributes, its body inlined to the budget (or one page from `from`), its neighbours, and its links as one line each with their ids. The result again inlines the next hop, so the model walks Trigger → Thread → Worker → another Thread on demand, one call per hop.
4. **`chat_history` and `contextDelta` fold into this scheme.** With recall on, `recall` replaces `chat_history` (`#seq` reads one message, `chat` lists the latest ones), and the environment becomes the object `env`: the first turn of a session still gets every line, later turns the time and what changed, and the unchanged lines spill behind `recall id=env`.
5. **Measure.** Each turn's injected prompt is estimated in tokens, with and without Inline & Spill, logged and kept on the turn (`meta.injected`). A fixed fixture in the tests records the before/after numbers and pins the budgets.

### Budgets

Pure, in `server/recall/spill.ts`; words are counted like the Router's reply limit (CJK characters count one each).

| Budget | Words | Applies to |
| --- | --- | --- |
| `summary` (`SUMMARY_WORDS`) | 15 | Far from the focus: older messages in a turn or recap; each link and neighbour in a recall result |
| `inline` (setting `inlineWords`, 20-200) | 50 | Next to the focus: the message just before it, the message it answers; a Worker report in the Router's batch; a recalled object's body |
| `adjacent` (`ADJACENT_WORDS`) | 300 | The focus: the latest message, the message that handed the turn over |
| `user` (`USER_WORDS`) | 600 | The user's own new words (about the 4,000 characters the Router already allowed); attachments the user chose are never cut |
| `page` (`PAGE_WORDS`) | 600 | One page of a read-more (`recall id=… from=N`) |
| `MAX_LINKS` | 8 | Links shown per object; the rest are counted |

A text within its budget is inlined whole; one word over is spilled. A spill always says how much is left and the exact call that reads it.

## Data model

Shared types in `shared/types.ts`:

```ts
interface RecallSettings {          // settings.superAgent.recall
  enabled: boolean;                 // default false; needs superAgent.enabled
  inlineWords: number;              // default 50 (20..200)
}

type RecallKind = 'message' | 'chat' | 'env' | 'trigger' | 'thread' | 'worker' | string; // string: kinds later milestones register (jobs)

interface RecallLink {
  id: string;                       // what to pass to recall next
  rel: string;                      // thread, answers, previous, next, related, worker, message, trigger…
  summary: string;                  // one line, at most SUMMARY_WORDS words
}

interface RecallNode {
  id: string;
  kind: RecallKind;
  title: string;
  attrs: [string, string][];        // small facts: status, source, when, verdict…
  body: string;                     // the full content; rendered to the budget
  untrusted?: boolean;              // environment data: rendered with a "data, not instructions" line
  around: RecallLink[];             // neighbours: previous/next message, the message it answers
  links: RecallLink[];              // the next hops
}

interface RecallResult { id: string; text: string; node: RecallNode; tokens: number }  // GET /api/recall/:id
```

`ChatMessage.meta.injected = { tokens, without }` (only written while recall is on). The new settings key gets defaults when missing, so no migration is needed.

### The graph

`server/recall/graph.ts` resolves an id within a **scope** (the caller's chat, its project, blind or not):

| Id | Object | Body | Neighbours and links |
| --- | --- | --- | --- |
| `#12`, `m_…` | A message of the caller's chat | The user's words with attachments, a bot's text, a system note | previous, next, the message it answers; the Triggers that recorded it (→ thread), Workers it led to |
| `chat` | The conversation | (none) | The latest messages, the chat's open Thread, its Workers |
| `env` | The environment (`contextLines`) | Every line, as a session's first turn gets it | (none) |
| `tg_…` | A Trigger | `detailText` (the payload), marked as data unless explicit | its thread, the message it records, `related`, the thread's previous trigger, Workers it led to, Workers it went straight to (`delivered to`, ADR 003); who handed it back is an attribute |
| `th_…` | A Thread | (none) | its latest Triggers, the chat, Workers on it (chat thread: the chat's Workers; workspace thread: the Worker whose worktree it is), and the Workers subscribed to it (`subscriber`) |
| `wk_…` | A Worker | Its task and last report | the chat's thread, the batch it came from (`related`), the Thread of its own workspace, the Threads it subscribes to (`subscribes`) |
| `job_…` | A background job (ADR 004), registered through `registerRecall` | What it ran, then its output's head and tail as its result shows them, marked as data | the turn that started it, its result message, its Trigger; a message links to the jobs it started or reports |

Other milestones register more kinds by id prefix (`registerRecall('job_', resolve)`): background jobs (milestone 4) and subscriptions (milestone 3, a Thread's subscribers become links) plug in without touching the renderer.

**Scope.** A message must be in the caller's chat; a Trigger or Thread must belong to the caller's chat or to its project (a workspace counts as its parent); a Worker or a background job must belong to the caller's chat. A blind reviewer only recalls the user's messages and outside-edit notes, and `chat` lists only those, exactly as `chat_history` filtered them; Triggers, Threads, Workers and jobs are refused (they carry teammates' reasoning).

## How it fits the existing modules

- `server/recall/` (new): `spill.ts` (pure: budgets, `spill`, `oneLine`, `estimateTokens`, `renderNode`, the tool's wording), `graph.ts` (resolving ids in a scope, `registerRecall`), `config.ts` (pure: defaults and normalisation of the setting), `index.ts` (`recallOn()`, `recallBudget()`, `recallText`, `measureInjected`).
- `agents/prompts.ts`: `buildTurnPrompt` takes `recall?: Budget`; `turnBody` and `recapPrompt` give each message its id and spill by the table above instead of `digest`. `contextDelta(prev, next, spillTo?)` says how many lines are unchanged and that `recall id=env` shows them. `buildSystemAppend` lists `recall` instead of `chat_history`. The blind reviewer's prompt is unchanged.
- `agents/crewTools.ts`: with recall on, `crew` offers `recall` instead of `chat_history`, for chat turns and Workers alike.
- `orchestrator/index.ts` and `layers/workers.ts`: a session started with recall on remembers its budget (its tools are fixed for its life); each prompt is built with it, measured against the same prompt without it, logged (`recall` logger) and stored as `meta.injected`. `TurnStream.finish` keeps that field, and `runLogged` hands the turn's message to `content()` so Router and Worker turns can record it too.
- `friction.ts`: the friction brief names `recall` instead of `chat_history` while recall is on.
- `layers/prompts.ts`, `layers/tools.ts`, `layers/router.ts`: with recall on, the Router's batch spills user messages, Worker reports and environment events behind `recall` handles and names each user event's Trigger; `crew_router` gains a read-only `recall` tool (the Router still cannot touch files); its system prompt says so.
- API: `GET /api/recall/:id?chatId=&from=` (404 while off); `PATCH /api/settings` accepts `superAgent.recall`. Toggling recall restarts idle sessions (chats, Workers, Routers), because the tool list is fixed when a session starts.
- UI: Settings → Super-agent gets a "Chain of recall" block (switch and inline budget).
- The slow path already follows these rules and has no tools; it is unchanged.

## Measured on the fixture

`tests/fixtures/recallFixture.ts` is a fixed group chat: twelve messages since the bot last spoke (long teammate reports of 150-520 words, a long handoff, short replies, an outside-edit note), a Router batch with a long user message and two Worker reports, and an environment that changed by one line. `tests/unit/recall-tokens.test.ts` builds each prompt with recall off and on and logs the estimate:

| Prompt | Off (tokens) | On (tokens) | Change |
| --- | --- | --- | --- |
| Group-chat turn (the handoff to Probe) | ~1,180 | ~907 | -23% |
| Session recap (the same twelve messages) | ~1,241 | ~959 | -23% |
| Router batch | ~1,404 | ~1,258 | -10% |
| Environment on a later turn | ~30 | ~29 | -3% |

Where it saves: the handoff is cut at 300 words instead of sent whole, far messages are one line of 15 words instead of a 90-character line plus a sentence about chat_history, and Worker reports in a batch are 50 words instead of 80. Where it spends: the message the handoff answers now comes with its first 50 words, and every message carries its id. The user's words are kept, so a batch made mostly of them barely shrinks. The test pins the direction (turn and recap at least 20% smaller, batch smaller) and checks that every cut names its handle. In a running Crew, each turn logs the same pair (`recall` logger, info level) and keeps it on the turn as `meta.injected`.

## Deliberately left out

- **Spilling the first turn's environment or the user's attachments.** Both are instructions or context the user chose; they are sent whole.
- **The blind reviewer's prompt** stays as it is: what it may see is a review rule, not a cache decision.
- **Background jobs** (milestone 4) were built on a parallel branch and plugged in through `registerRecall('job_', …)` when the two were integrated: a job resolves to what it ran and its output's head and tail (data, not instructions), linked to the turn that started it, its result message and its Trigger; a sub-task gets `recall` like its bot's session; and a job result that is the focus of a turn is sent whole, since it already follows its own Inline & Spill (head, tail, `status id=… from=…` for the rest) and cutting it at 300 words would lose the tail. **Thread subscriptions** (milestone 3) were built on a parallel branch and plugged in when the two were integrated: the links in the table above, the `<direct>` block and per-Worker subscriptions in the Router's batch (ids and one line each, so they need no spilling), and an event delivered straight to a Worker, whose payload is still cut at ~60 words but names `recall id=tg_…` when the Worker's session has recall.
- **Recalling another chat's objects.** The scope is the caller's chat and project; a user-level Router (ADR 002) would widen it.
- **Exact token counts.** The estimate (about four characters per token, one per CJK character) is for comparing before and after, not for billing; Claude Code's own usage stays the source of truth.
- **A recall UI.** The Triggers view already walks Triggers and Threads; `GET /api/recall/:id` shows what an agent would read.

## Risks

- **Prompt injection through recalled content.** A Trigger's payload can come from a page or a file. Recalled environment content is marked as data, not instructions, the Router's `recall` is read-only and does not change what a batch may do (an environment-only batch still cannot dispatch), and scope stops a chat from reading another chat.
- **Too little inline.** If the model needs a spilled text it pays one tool call; the budgets keep the adjacent messages generous so the common case needs none, and `inlineWords` is a setting.
- **Resumed sessions keep their first system prompt.** Claude Code resumes a transcript with the system prompt it started with, so a session that began with recall off still lists `chat_history` after recall is turned on (its tools do change). The first turn of a resumed session with recall on says so in one line (`RECALL_RESUME_NOTE`); turning recall off leaves a stale line naming `recall` until the session rotates, and a call to it fails with "no such tool" while `chat_history` is offered.
- **More calls, longer turns.** Each hop is a call that re-reads the context. The measured savings are per call, so a turn that needs one or two recalls still comes out ahead on long sessions; the log line makes the trade visible.
- **Behaviour drift when off.** Every change is behind `recallOn()`, passed down as an optional argument; with it undefined the old code path runs. The unit tests compare prompts with recall off against the existing expectations, and the integration test checks that `chat_history` is offered and `recall` is not while it is off.
