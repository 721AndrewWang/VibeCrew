# Crew architecture

This document covers the parts Crew is made of, how a message becomes an agent's reply, and a few design decisions that are easy to trip over. For usage see the [README](README.md); for the development workflow see [CONTRIBUTING](CONTRIBUTING.md).

## Overview

```
┌──────────── Desktop app (Electron, desktop/main.cjs) ──────────────────┐
│  Tray, window, launch at login, icons; starts the server as a child    │
│  process and loads the UI                                              │
└───────────────┬────────────────────────────────────────────────────────┘
                │ spawn (ELECTRON_RUN_AS_NODE)
┌───────────────▼──────────── Server (server/, Node + Express) ──────────┐
│  api.ts        REST API (request shapes enforced by schemas.ts)        │
│  index.ts      HTTP + WebSocket entry point                            │
│  orchestrator/ Queueing, group chat routing, @ handoffs, approvals     │
│  agents/       Agent sessions: Claude Agent SDK query() -> system      │
│                claude                                                  │
│  workspaces/   Isolated git worktree workspaces: create, auto-commit,  │
│                merge                                                   │
│  triggers/     Trigger bus: events -> threads -> fast path (rules) ->  │
│                slow path (cheap model); off unless superAgent.enabled  │
│  layers/       Two-layer mode: a resident Router per group chat and    │
│                isolated Workers; off unless superAgent.router.enabled; │
│                Workers' thread subscriptions (direct routing)          │
│  recall/       Inline & Spill budgets and the recall tool (chain of    │
│                recall); off unless superAgent.recall.enabled           │
│  watchdog/     Timer-driven control loop over Workers and errors;      │
│                off unless superAgent.watchdog.enabled                  │
│  gateway/      Local model gateway (127.0.0.1): provider/model groups, │
│                failover, spend windows, masking; off unless enabled    │
│  preview       Preview server (static / reverse proxy + injected       │
│                script)                                                 │
│  store         JSON storage under ~/.crew                              │
│  bus ────────► WebSocket broadcast of ServerEvent                      │
└───────────────┬────────────────────────────────────────────────────────┘
                │ REST + WebSocket (same origin, 127.0.0.1 only by default)
┌───────────────▼──────────── UI (web/, React + Vite) ───────────────────┐
│  store.ts      Global state (useSyncExternalStore), handles server     │
│                events                                                  │
│  components/   Chat, composer, the right-hand "computer" (preview,     │
│                files, terminal, changes)                               │
└────────────────────────────────────────────────────────────────────────┘
shared/  Types (types.ts) and logo definitions (logos.ts) shared by server and UI
```

## The journey of a message

1. The UI calls `POST /api/chats/:id/messages`; `orchestrator.sendUserMessage` stores the message and decides who replies: the @-mentioned agents, or the lead when nobody is @-mentioned in a group chat. (In two-layer mode a group chat's message goes to its Router instead, and steps 2-7 below happen in Workers; see [Router and Workers](#router-and-workers-super-agent-two-layers).)
2. Each chat has one queue, and only one turn runs at a time (`withChatLocked`). Until a new workspace's setup command finishes, messages wait in line (`holdTurns`).
3. `BotSession` in `agents/session.ts` keeps one Claude Agent SDK session per "chat x agent", so earlier context can be resumed. Agents with `freshSession` on (acceptance and review roles) start a new session every turn: a resumed session rereads the whole history on every call, which is wasted money for roles that only look at the current state. For the other agents, once a session exceeds `rotateAtTokens` (60k tokens by default), the next turn also switches to a new session, carrying the last 12 messages (`rotateSession` + `recapPrompt`). It calls the locally installed `claude` CLI (`vendor/sdk-binary-stub` replaces the SDK's bundled 240 MB binary).
4. The SDK's streaming events are turned by `agents/stream.ts` into the parts of a chat message (text, thinking, tool calls, approval cards) and broadcast through `bus`; `index.ts` pushes them to every WebSocket connection.
5. When a turn ends, Crew records which files it changed (undoable), which model it used, the context usage (the small ring next to the composer), and where the turn sits in the Claude Code session transcript (`meta.trace`: session id + time window). In an isolated workspace, the turn's changes are auto-committed to the branch.
6. "Trace" (`server/trace.ts`) reads `~/.claude/projects/<cwd>/<session>.jsonl` on demand and turns the lines inside the time window into a timeline: the lines of one API call (thinking, text, tool calls) are merged into one step with its token usage; tool results and sent prompts are one step each. Crew does not copy this transcript, so once it is cleaned up the trace is gone, and the UI says so plainly.
7. If an agent's reply @-mentions a teammate, the work is handed off to that teammate, with a cap on the count to prevent ping-pong.
8. Sessions are resumed, so anything sent stays in context; each turn therefore sends only what is new: environment info is sent in full the first time, after that only changes are sent, compared as "label: value" (`contextDelta`); older long messages in group chats are collapsed into one-line summaries, and agents fetch the full text by number with `chat_history`. (With the chain of recall on, these become one set of Inline & Spill rules and the `recall` tool; see [below](#chain-of-recall-super-agent-inline--spill).)

## Permissions

Permission levels are defined in `shared/types.ts`, the decision logic is in `agents/permissions.ts`, and the approval flow is in `orchestrator/permissionGate.ts`:

| Level | Claude Code mode | What Crew adds |
| --- | --- | --- |
| Read-only `plan` | plan | Chat-level settings cannot change it either |
| Ask every step `ask` | default | Every tool call pops an approval card in the chat |
| Auto-edit files `edits` | acceptEdits | Harmless commands (`cd`, `pwd`, `cat`...) are allowed straight away |
| AI reviewer `review` | auto | Claude Code's classifier decides |
| Full auto `auto` | default | `canUseTool` allows everything |

In addition, each agent can have "paths it may edit" (`editScope`, globs relative to the project): an Edit/Write outside that scope is rejected outright and the agent is told to @-mention a teammate. This is a hard constraint on the division of roles, not a prompt. The monthly budget (`monthlyBudgetUsd`) accumulates the per-turn cost reported by Claude Code (`server/usage.ts`); once it is used up, `runTurn` skips that agent's turns and says so once in the chat.

Whatever the level, the following three layers always apply:

- **Sandbox** (`server/sandbox.ts`): when on, every session gets Claude Code's `sandbox` option, commands run in bubblewrap, and the network reaches only localhost plus allowed domains (global list + project list). `allowUnsandboxedCommands: false`, so agents cannot escape with `dangerouslyDisableSandbox`; `autoAllowBashIfSandboxed: false`, so Crew's own approval logic still applies. This is the only layer that decides by "can it connect" rather than "what does the command look like", so it is also the only one that counts as a security boundary. All connections in the sandbox go through Claude Code's proxy (the proxy holds the allowlist; `strictAllowlist` makes hosts not on the list get rejected outright, rather than turning into a prompt that might be approved). But the sandbox's own `no_proxy` sends loopback and private addresses direct, and a direct connection reaches nothing inside the isolated network namespace, so to reach a service on this machine or the LAN, a command must be prefixed with `env -u no_proxy -u NO_PROXY` (the prompt already tells agents this). When the machine lacks the dependencies (bubblewrap and socat on Linux), the Settings page warns, and agents run without the sandbox.

- **Blocked actions** (`denyRules` in settings): written into the SDK's `permissions.deny` and also intercepted again by a PreToolUse hook without a matcher, so they cannot run even in full auto.
- **Actions that always need confirmation** (each agent's rules, plus the project's `askRules`): always pop an approval card. A compound command (`a && b`) is allowed only if every segment matches an "auto-allow" rule.

## Changes made outside the chat

Agents only know what was said in the chat. `server/outsideEdits.ts` watches project files: when a change happens while no agent is working in that project (`projectBusy`), Crew itself is not writing (`quietWrites.ts`: workspace git operations, setup commands and undoing a turn mark the project "quiet", plus 4 more seconds afterwards), and dependencies are not being installed, it waits 3 seconds and merges the batch of changes into one system message (`notice: 'outside-edit'`), sent to every chat on that project. For text files it says which lines changed: compared with the content Crew last saw, or with the last git commit if it never saw the file. Blind-review agents see these messages too.

## Triggers and threads (Super-agent, preview)

The first step towards one always-on agent that watches events and acts on them without being asked (design: [ADR 001](docs/adr/001-triggers.md)). Everything here is behind `superAgent.enabled` in settings, off by default; while it is off, `publishTrigger` returns at its first line, nothing is recorded and no folder is created.

- **One stream of events.** The paths that already handle Crew's inputs each publish a **Trigger** as the event happens: `sendUserMessage` (a user message), `runRoutine` (a routine run), the end of `runTurn` (a turn result), `outsideEdits.flush` (files changed outside the chat), and the preview's console errors, which the browser tab forwards to `POST /api/triggers/preview-console`. A Trigger is small: an id, a source, a one-line summary, the ids of related objects, and a `ref` to its full content (a chat message, a routine, or a payload file). They keep doing what they did before; the Trigger is a record of the event, plus a decision.
- **Threads.** Each Trigger joins a **Thread** by key: `chat:<id>` (one topic; "Start new topic" closes it), `routine:<id>`, or `workspace:<projectId>` (outside edits and console errors). A turn's result joins the thread of whatever started it and points back at that request.
- **Fast path** (`triggers/fastPath.ts`, pure): a Trigger on a thread that Workers subscribe to goes straight to them (rule `subscribed`; see [Thread subscriptions](#thread-subscriptions-and-direct-routing-super-agent)); otherwise explicit requests (user messages, routine runs, a bot handing off) are acted on by the chat as always; per-source rules drop the rest unless they are worth a look. Each filtered source (turn results, outside edits, console errors) has a mode (`candidate`, `explicit` only, or `ignore`, which records nothing), an allow-list, plus a project allow-list, noise patterns, a per-thread cooldown after a notice, de-duplication by fingerprint, and an hourly budget.
- **Slow path** (`triggers/slowPath.ts`): the candidates go to Haiku through the same bare `oneShot` call shadow routing uses, with the **policies** the user writes in Settings. One call runs at a time; candidates that arrive meanwhile are decided together in the next call (up to 8). Each event is inlined small (summary, first ~50 words, the thread's previous events by id) and fenced as data; an unusable answer means "stay quiet". Demo mode uses a deterministic stand-in.
- **Acting** is a short UI-only note in the related chat (`notice: 'trigger'`, at most 100 words) plus a toast. Bots never see it, and nothing runs on its own. A chat in two-layer mode gets the decision in its Router's inbox instead, as an environment event that cannot start work (below).
- **Seeing it**: the Triggers view (sidebar, only while the feature is on) lists events live (`ServerEvent` `trigger`), with filters by source and verdict; opening one shows its payload and links to related and same-thread triggers (`GET /api/triggers/:id`). `GET /api/triggers` is the debug endpoint.

## Router and Workers (Super-agent, two layers)

The second step (design: [ADR 002](docs/adr/002-two-layer.md)): global continuity and parallel execution are split. Behind `superAgent.router.enabled`, which only counts while `superAgent.enabled` is on; both are off by default. The one check is `routerMode(chat)` (group chats only) at the two entry points, `sendUserMessage` and `runInChat`; with it false, nothing below runs and group chats route to the lead as before. Direct chats are never affected.

- **Router** (`layers/router.ts`): one resident Claude Code session per group chat, speaking as the chat's lead, on `superAgent.router.model` (Sonnet by default). Every event in the chat that needs a decision goes into its inbox: the user's messages (with whom they @-mentioned), routine runs, Workers' reports, and Trigger decisions the slow path acted on (with direct routing on, events on threads its Workers subscribe to go to them instead; see [below](#thread-subscriptions-and-direct-routing-super-agent)). It runs one turn at a time; events that arrive meanwhile wait and all go into the next turn together (`BatchQueue`), so one call makes several decisions. It never executes: the session has no built-in tools (`tools: []`), a short system prompt of its own instead of Claude Code's, no settings files, and a `canUseTool` that refuses anything but its own tools. Those are `crew_router` MCP tools (`layers/tools.ts`): `dispatch_worker`, `message_worker`, `stop_worker`, `list_workers` and `reply`. Only `reply` reaches the chat, as a bot message from the lead marked `router`. The Router's turns are kept as messages in their own log (`rt_<chatId>` in `messages/`), with the ids of the events each turn handled (`batch`). Every Router runs in one fixed folder (`CREW_HOME/router`), so a chat moving into its workspace does not cost it its Claude Code session. Changing a chat's switches, a bot or the sandbox refreshes Worker sessions as it does chat sessions; idle ones close after 15 minutes.
- **The batch prompt** (`layers/prompts.ts`, pure) follows Inline & Spill: a `<workers>` line per Worker, then one `<event>` per item with its id. The user's words are inlined in full (cut at 4,000 characters), a Worker's report to its first ~80 words with `list_workers id=…` as the way to read the rest, and environment events as fenced data. A Router session that outgrows `rotateAtTokens` starts over with a recap of the chat's latest messages.
- **Gates in code** (`layers/gates.ts`): a batch made only of environment events cannot dispatch or message Workers (ADR 001's open risk: an event must not start work with full tools), and environment events are never batched with explicit ones, so the gate holds per event. `reply` refuses more than 100 words. Only chat members can be dispatched, not past their monthly budget; at most `maxWorkers` (3) Workers may be active per chat, and at most the chat's `maxHops` started per user message. Without a workspace of their own, only one Worker at a time may work in the chat's folder, and a Worker whose workspace is gone never runs elsewhere.
- **Workers** (`layers/workers.ts`): `dispatch_worker` returns at once with the Worker's id, and the Worker starts in the background. It runs as a member of the chat (the one the Router names, by default the lead), so it has that member's role description, permission level (with the chat's switch applied, as for any turn), `editScope`, allow/ask rules, plugins and budget, through the same `BotSession`, `permissionGate`, sandbox and deny rules as a chat turn. Its model is the chat's model switch, else `superAgent.router.workerModel`, else the default model. Its prompt holds the Router's task and the user's own messages from the dispatching batch (a blind reviewer gets its blind prompt with the chat branch's diff instead). Its system prompt says it reports to the Router and never @-mentions anyone, and it gets no `notify_user`. Its turns are kept in its own log (`wk_…` in `messages/`), and approval cards appear there; the Workers bar marks it "Needs you" and the usual notification fires. Several Workers run at once, and the chat stays free while they work.
- **Workspaces and landing.** In a git project, the first dispatch moves the chat into its isolated workspace if it has none (`doCreate`, with its note and setup command). Each Worker then gets a worktree of its own branched from the chat branch's current commit (`createWorkerWorkspace`, sharing `addWorktree` with chat workspaces; the project's setup command runs there too). When a turn ends, Crew commits the Worker's worktree, and if the turn finished it **lands** the work: under the chat's lock (`whenChatFree`, which waits rather than refusing), it runs `git merge --no-ff` of the Worker's branch inside the chat's worktree. On conflict it aborts, leaves both branches as they were, and tells the Router, which can ask the Worker to merge the chat branch in (Crew adds the instructions to that follow-up). The user's project folder is untouched until the user merges the chat branch, as before. Without git, a Worker works in the chat's folder and its record says why.
- **Reports.** When a Worker's turn ends, its final text (cut at 6,000 characters), status and landing go to the Router as an event. A `turn` Trigger is also published on the chat's thread, which the fast path settles with rule `routed` (delivered directly, no model).
- **Control.** `message_worker` resumes a finished Worker's session, or queues the message for when its current turn ends. The chat's Stop stops the Router's turn, drops its inbox and stops every Worker without the Router replying. "Start new topic" resets the Router's session and dismisses finished Workers. Dismissing a Worker removes its worktree; its branch is kept if its work never reached the chat branch. Finished Workers are dismissed after 6 idle hours. Deleting the chat removes everything. Closing the chat's workspace, switching its project or deleting it is refused while Workers are active (`isChatBusy` counts the Router and Workers).
- **Switching back.** A message the two layers take (the Router, or Workers subscribed to its thread) moves every member's read cursor past it, so a chat switched back to its lead does not hand the lead those messages again as new ones and have it redo the Workers' tasks; they stay readable with `chat_history` (or `recall`).
- **Restarts.** A Worker record is written at once when it is created and on every status change. On start, Workers cut off mid-turn are marked stopped (`Crew restarted`), their worktrees are committed (`reconcileWorkspaces` keeps Worker workspaces whose Worker still exists), and their Routers are told. User messages past `Chat.router.cursor` (written at once when a turn takes them) are handed to the Router again.
- **Seeing it**: in a router-mode chat, a Workers bar above the composer shows the Router's state and queue, and each Worker's title, member, status and last report or landing. Each row opens that Worker's transcript (the chat's own message rendering, approval cards included); the bar also offers Stop, Dismiss and the Router log. The chat header and the composer's Stop button count the Router and Workers. API: `GET /api/workers?chatId=`, `GET /api/workers/:id/messages`, `POST /api/workers/:id/stop`, `POST /api/workers/:id/dismiss`, `GET /api/chats/:id/router/messages`; `ServerEvent` `worker`, `worker_deleted`, `router`.

## Thread subscriptions and direct routing (Super-agent)

The third step (design: [ADR 003](docs/adr/003-subscriptions.md)) keeps the Router off the hot path. It sits behind `superAgent.router.subscriptions` (off by default), which only counts in two-layer mode. With it off, no Worker subscribes, no landing Trigger is published and no prompt changes.

- **Subscriptions** live on the Worker (`Worker.threads`, many-to-many with Threads). At dispatch, a Worker subscribes to the `routine:` thread of each routine run in the batch; once its workspace is ready, it also subscribes to the chat's `workspace:` thread, which it shares with the chat's other Workers. `dispatch_worker` takes `subscribe: false` for one-off tasks. Blind reviewers never subscribe. Chat threads cannot be subscribed: they are the Router's channel to the user. Pruning keeps any Thread a Worker still subscribes to.
- **Receivers** (`layers/subscriptions.ts`, pure). A Worker receives a Trigger on one of its threads when it is not dismissed, did not cause the Trigger, its chat is in two-layer mode with the switch on, and either it is active or the Trigger is explicit and the Worker is `done`. So a routine run wakes a finished Worker, but environment events only reach Workers that are already working; they never start work.
- **Delivery.** In `publishTrigger`, the bus looks up the receivers before the fast path. With any, the fast path settles the Trigger as `subscribed`; the noise rules, "ignore" and "explicit only" still apply first, and a duplicate already delivered within 30 minutes is dropped. The Trigger records `filter.direct` and goes into each receiver's inbox (`Worker.inbox`, at most 20 items, Inline & Spill: summary and first ~60 words, or a routine's prompt in full). Neither the cheap model nor the Router is called. For routine runs, `runInChat` takes a `publish` callback from `runRoutine` and skips the Router when the run went direct.
- **Into the session.** While a turn runs, the session's `PostToolUse` hook (`SessionConfig.deliveries`, beside the wrap-up note) takes the inbox at the next tool call of the main loop and adds it as `additionalContext`, fenced as `<event>` data. A new turn's prompt carries whatever is left, and the first turn lists the Worker's threads. When a Worker goes idle with unread items, an environment Trigger nobody else read goes back to the normal path (rules, cheap model, Router), and a routine run goes to the Router. A chat Stop drops them.
- **Landings.** After Crew merges a Worker's branch into the chat's branch, it publishes a `landing` Trigger on the chat's workspace thread. It is built from facts (Worker, title, files, commit), never from the Worker's words. It goes only to the other active subscribers, so a Worker editing the same files can merge the chat's branch early; with no subscriber it is dropped (`no-subscribers`).
- **Leaving.** Workers get two `crew` tools: `unsubscribe_thread`, and `hand_back`, which unsubscribes and sends the event to the Router (once per Trigger, as a routine event or an environment event that still cannot start work). The user can unsubscribe a Worker from its dialog (`POST /api/workers/:id/unsubscribe`).
- **The Router observes.** Triggers that went straight to a chat's Workers are listed in the Router's next batch under `<direct>`, with no environment text, and never start a turn on their own. `<workers>` lines show each Worker's subscriptions. `Chat.router.decided` counts the events Router turns took. `Chat.router.direct` counts events that went straight to Workers (Router decisions avoided); a hand-back or an unread reroute takes the count back. The Workers bar shows it, the Triggers view counts `stats.direct`, and a restart hands the Router any routine runs left unread in Workers' inboxes.

## Chain of recall (Super-agent, Inline & Spill)

The fifth step (design: [ADR 005](docs/adr/005-chain-of-recall.md)): the context window is treated as a cache. Behind `superAgent.recall.enabled`, which only counts while `superAgent.enabled` is on; both are off by default. The one check is `recallBudget()` (`recall/index.ts`), read when a session starts: undefined means every prompt builder and tool list takes its old path.

- **Ids everywhere.** Every injected object carries its id: messages `#seq` (plus `answers #n` when a reply answers something other than the message just before it), Triggers `tg_…` and their Threads `th_…`, Workers `wk_…`, the environment `env`, the conversation `chat`.
- **Budgets** (`recall/spill.ts`, pure). The focus of a turn (the latest message, the handoff) gets 300 words, the user's own words 600, what sits next to the focus (the message just before it, the one it answers) and a recalled object's body the setting `inlineWords` (50), everything else one line of 15 words. A text over its budget is cut at a word boundary and ends with `… (+N words: recall id=… from=M)`. Words are counted like the Router's reply limit (CJK characters count one each).
- **Where they apply.** `buildTurnPrompt` (group turns, direct chats, session recaps; the blind reviewer's prompt is unchanged), the Worker's prompt, and the Router's batch (user words, Worker reports to 50 words with `recall id=wk_…`, environment events with `recall id=tg_…`, and each user or routine event's Trigger id; the `<workers>` lines and the `<direct>` block of [direct routing](#thread-subscriptions-and-direct-routing-super-agent) already carry only ids and one line each). An event delivered straight to a subscribed Worker keeps its first ~60 words, and with recall on the cut names `recall id=tg_…`. `contextDelta` treats the environment as the object `env`: later turns say how many lines are unchanged and that `recall id=env` shows them.
- **The tool** (`recall/graph.ts`). `recall(id, from?)` resolves an id inside the caller's scope (its chat; Triggers and Threads of its chat or project, a workspace counting as its parent; Workers of its chat) and renders it under the same budgets: a header with its facts, the start of its body, its neighbours (previous, next, the message it answers) and its links (a message's Triggers, Threads and the Workers it led to; a Trigger's thread, the message it records, related ids, the Workers it led to and the Workers it was delivered to directly, and who handed it back; a Thread's latest Triggers, the Workers on it and its subscribers; a Worker's chat thread, the batch it came from, the Thread of its own workspace and the Threads it subscribes to). With `from` it returns one 600-word page. Environment content is marked as data. A blind reviewer only recalls the user's messages and outside-edit notes, as `chat_history` showed it. Other kinds plug in with `registerRecall(prefix, resolver)`.
- **Folded in.** Chat and Worker sessions get `recall` in place of `chat_history` (the `crew` MCP server, beside a subscribed Worker's `unsubscribe_thread` and `hand_back`); the Router gets a read-only `recall` in `crew_router`, which changes nothing about what a batch may do (an environment-only batch still cannot dispatch). Toggling the setting restarts idle sessions (chats, Workers, Routers), since a session's tools are fixed when it starts; Claude Code keeps a resumed session's first system prompt, so the first turn of a resumed session says recall replaced `chat_history`. A Worker the Watchdog restarts starts a new session, which reads the setting afresh. The friction brief names `recall` instead of `chat_history` while it is on. The Watchdog keeps its own read-only `inspect` for the ids in its snapshot, since it sits outside every chat's scope.
- **Measuring.** Each chat, Worker and Router turn builds its prompt with and without the rules, logs both estimates (`recall` logger, about four characters per token) and keeps them as `meta.injected`. `tests/unit/recall-tokens.test.ts` does the same on a fixed fixture (`tests/fixtures/recallFixture.ts`) and pins the direction.
- **Seeing it**: `GET /api/recall/:id?chatId=&from=` returns what an agent in that chat would read (404 while off). Settings → Super-agent → Chain of recall has the switch and the inline budget.

## Watchdog (Super-agent, external control loop)

The sixth step (design: [ADR 006](docs/adr/006-watchdog.md)): a control loop outside the chats it watches. Behind `superAgent.watchdog.enabled`, which only counts while `superAgent.enabled` is on; both are off by default, and off means no timer, no `watchdog/` folder and no model call (`syncWatchdog` stops the timer when the settings change).

- **Timer and fast path.** A croner job (`*/N * * * *`, `superAgent.watchdog.everyMinutes`) calls `tick()`. Each tick first settles watches in code (`housekeepWatches`), then gathers a **snapshot** (`gatherSnapshot`): Workers that are active or ended since the last look, with their progress read off their log (`signals.ts`: the last tool call's time, the latest calls with repeats collapsed), approvals waiting for the user (`openApprovals()` in `permissionGate.ts`), turn errors and other friction since the last look (`readFriction`), Routers in error and preview console errors (from the trigger log), and open watches. Rules in code (`snapshot.ts`) flag a Worker as `stuck` (no progress for `stuckMinutes`), `looping` (the same call 4 times among its latest), `failed` or `failed-transient`; an approval waiting 10 minutes; any new turn error, friction, interface error; a due watch. No flag, no model call: the tick is recorded as `quiet` or `healthy`. "Tick now" (`POST /api/watchdog/tick`) always looks, within the limits.
- **The session.** Like the Router's: one Claude Code session with no built-in tools (`tools: []`), its own system prompt (`prompts.ts`), no settings files, a `canUseTool` that refuses anything but `mcp__crew_watchdog__*`, working in `CREW_HOME/watchdog`, turns logged by `runLogged` under `watchdog` in `messages/`, one at a time through a `BatchQueue` (ticks coalesce). Its model and environment come from `botModel` and `agentEnv` with the `watchdog` scope, so with the [model gateway](#model-gateway-super-agent) on, its calls follow `gateway.roles.watchdog` and the spend windows for that role; a gateway change makes it start a new session at its next turn, never mid-turn (`invalidateWatchdog`). The snapshot follows Inline & Spill: ids everywhere, text cut to its first words, `inspect <id>` for the rest, all of it fenced and defused as data. A session past `rotateAtTokens` starts over with a recap of recent actions.
- **Tools and gates** (`tools.ts`, `gates.ts`): `nudge_worker` (a note queued with the Worker's follow-ups; `workerPrompt` renders it as the Watchdog's, which can only refocus), `stop_worker` (optionally with a `redirect` note it resumes with at once), `restart_worker` (`restartWorker` in `layers/workers.ts`: a failed or stopped Worker starts a new session from a recap of its task, last report and branch; it keeps its thread subscriptions, and once running it receives its threads' events again), `notify` (a Router gets an environment event, which cannot start or steer Workers; other chats a UI-only note), `watch`/`resolve_watch`, `propose_change` (maintainer turns only) and the free `inspect`. Every action, done or refused, is a line in `watchdog/actions.jsonl`. Hard limits from Settings: `maxTicksPerHour`, `maxActionsPerTick`, `dailyBudgetUsd` (ticks and questions together); constants cap nudges (2) and restarts (3) per Worker and notices (4) per chat per day.
- **Transient failures.** `isTransient` reads overloaded, rate limits, 429/5xx, timeouts and connection errors. A Worker failing that way gets a watch opened by code; a due watch flags the tick; checks back off from 5 minutes to at most 2 hours; code resolves the watch as soon as the Worker is running or done again, and gives up after 8 checks with a notice to the chat. (With the gateway's failover, most quota and outage errors are handed on to the next member before a Worker ever sees them; what still reaches it is what every member refused.)
- **Maintainers.** The Watchdog page has a chat: a message is a turn in the same session with the current snapshot attached. It can propose new trigger policies or a bot's role description (`watchdog/proposals.json`); accepting applies them through the settings store or `updateBot`, unless the value changed since (then the proposal is `stale`).
- **Seeing it**: the Watchdog page (sidebar, only while it is on) shows its state, next tick, ticks this hour, spend today and actions against the limits, pending proposals (Accept/Reject), open watches, recent actions and ticks, and the chat. API: `GET /api/watchdog`, `GET|POST /api/watchdog/messages`, `POST /api/watchdog/tick`, `POST /api/watchdog/proposals/:id/accept|reject`, `POST /api/watchdog/watches/:id/resolve`; `ServerEvent` `watchdog`.

## Model gateway (Super-agent)

The ninth step (design: [ADR 009](docs/adr/009-model-routing.md)) lets every agent use any model, with failover between providers and accounts. It sits behind `gateway.enabled`, off by default, and is independent of `superAgent.enabled`; off, `modelEnv()` and `botModel()` return what they always did, nothing listens and no file is created.

- **Where it sits.** `gateway/index.ts` runs an HTTP server on `127.0.0.1` (`gateway.port`, 0 = any free port), started in `index.ts` before anything can start a session and re-synced when the settings change. Every Claude Code session Crew starts gets `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/s/<role>/<botId>` and `ANTHROPIC_AUTH_TOKEN=<scope credential>` (an HMAC of the scope with a per-process secret), from `modelEnv(settings, scope)`: chat turns pass `bot`, Workers `worker`, the Router `router`, the Watchdog `watchdog`, `oneShot` `oneshot`; speculative Workers will pass theirs. The gateway refuses a credential that does not match its path, so an agent cannot spend under another role's window, and provider keys (`gatewayTokens` in `settings.json`) never reach an agent's environment.
- **Routing** (`gateway/config.ts`, pure). A target is a group (an ordered list of `provider/model` members) or a `provider/model`. `routeFor(scope, model)`: the gateway's role override (`gateway.roles`), else the model asked for when it is an address (this is how each bot picks, through its own model field and the chat's switch, how the two layers pick, through `superAgent.router.model` and `workerModel`, and how the Watchdog picks, through `superAgent.watchdog.model`), else `defaultTarget`. So the two-layer split is two settings: the Router (and the Watchdog) on a light group, Workers on the strongest one. The session's model and its tier variables are set to the target; Claude Code's haiku tier goes to `fastTarget` when set. A `provider/*` member passes the requested model through.
- **Failover** (`gateway/proxy.ts`). Members are asked in order; no connection, 429, 5xx, a 400/402/403 that says quota/balance/billing, or a stream whose first event is an overloaded/rate-limit/api error hands on to the next member. Nothing reaches the client until a member answered, and a stream's first event is held back until it is known not to be such an error, so failover is transparent for streams too. Other errors are final. When all refuse, the last refusal goes back (status, body, `retry-after`). Upstream requests go through `gateway/upstream.ts`, which honours `HTTPS_PROXY`/`NO_PROXY` (Node's http does not).
- **Spend windows** (`gateway/windows.ts`, pure): rolling per role (and optionally per bot) limits in USD and tokens, checked against the usage log before any provider is asked; a spent window answers 429 with `Retry-After` and `x-should-retry: false`, and the call is logged as `limited`.
- **Usage log**: one `GatewayCall` per call in `gateway/calls.jsonl` (`JsonlLog`, 20,000 / 35 days): scope, requested model, target, the provider and model that answered, every try, tokens (from the response's usage, `message_start` + `message_delta` for streams), estimated cost (`gateway/pricing.ts`: the provider's price, else Anthropic's list prices), latency. `GET /api/gateway` returns it with totals and window states; `POST /api/gateway/test` sends a tiny prompt through the real listener.
- **Masking** (`gateway/mask.ts`, pure, off by default): emails, common key shapes and assigned passwords in `system`, text, tool results and tool inputs become `CREW_MASKED_<KIND>_<hmac>` (stable per value, so resent history stays cacheable); replies are restored, streams per content block with a restorer that holds back a possible partial placeholder. Thinking blocks are never changed, so their signatures stay valid.

## Adversarial review

Builders (Pixel and others), acceptance (Probe) and review (Lens) all look for supporting evidence, and each one sees the previous one's conclusion, so they tend to vouch for each other. Skeptic is the link dedicated to finding counter-evidence. Its design has these points (`server/review.ts`, `blindPrompt`):

- **Isolation** (both Skeptic and Lens): each turn a `blindReview` agent receives only the user's messages and the diff of the changes (all changes relative to the base in an isolated workspace; for a plain project, the uncommitted changes, or the last commit if there are none). It is told only how many messages teammates sent, and `chat_history` returns only the user's messages. Combined with a fresh session every turn, the author's reasoning cannot influence it.
- **Evidence only**: only a reproducible counterexample counts as a refutation; reasoning and guesses are recorded as "could not verify". Precision comes first.
- **Read-only**: it may only write `tests/challenge/**`; fixes go back to the author.
- **Can trigger automatically**: when a project has `autoChallenge` on, after a chain of turns ends and the chat is idle, fixed rules (which files changed, how many lines) decide whether to ask Skeptic; at most twice per request, and the same state is never reviewed twice (`server/autoChallenge.ts`).
- **Can act as a gate**: its verdict (the closing `Verdict: not refuted` or `Verdict: refuted N` line) is recorded on the isolated workspace, together with the commit it saw. When a project has `requireChallenge` on, merging requires a verdict for the current commit that refuted nothing.

The model follows the default (Opus 5.5). In the research, "models cannot fix their own mistakes" mostly comes from the author's reasoning staying in context, and isolation already cuts that off; changes Chief writes itself use the same model as Skeptic, so blind spots may overlap. This is a known trade-off.

## Group chat routing (shadow mode)

In a group chat, every message without an @ goes to the lead first (usually the most expensive model), even if it is just a small change. Following JEV-as-a-Judge (Li et al., 2026), `server/router.ts` prepares a cheap first pass that "accepts when confident, escalates when not", but for now it only records and does not act:

- **Cheap judgments are used only where the answer can be read off the text**: "who should take this" can be judged from the request itself; "is the code correct" requires reasoning, and in the paper cheap judges lose 7-28 points on that kind of question, so the router never judges code.
- **Average over two orders**: list the candidates once forwards and once backwards, align, and average the probabilities to cancel the position bias of "preferring the first one".
- **Labels come from real outcomes**: if the lead did the work itself, the label is the lead; if it handed off to one teammate, that teammate; if it handed off to several, the record does not count.
- **The threshold is chosen from local labels using a lower bound**: once 100 records with outcomes have accumulated, choose the smallest threshold such that the 95% lower bound (Wilson) of the accuracy of decisions above it is at least 90%. The paper shows that choosing the threshold by the lower bound rather than the point estimate cuts the risk of "dropping more than two points" from about 45% to about 5%.
- One-shot calls are all "bare": no tools, no Claude Code system prompt, no settings or MCP loaded.

## Improvement suggestions (lightweight self-improvement)

Full self-improvement needs an evaluation suite to judge whether a change is better; without one it manufactures "fake progress". Crew does not change itself automatically; instead it uses the human as the evaluation (`server/improve.ts`):

1. **Evidence pack**: the team's current settings, the last 60 turns (cost, model, status, approvals and their reasons, failing tools, refutation verdicts), the original text of refuted turns, the user's recent words, and earlier suggestions and decisions (the ledger).
2. **Proposal**: one `claude -p` call (Sonnet) returns JSON suggestions. The constraints follow the RRSI approach: at most 3 per run, each one field of one agent, a role description changes by at most 8 lines at a time, real turns must be cited, and proposing nothing is better than proposing badly.
3. **Checks**: the agent exists, the new value passes `BotPatch` validation, it differs from the current value, the evidence really exists, the evidence comes from at least two different user requests (added because on the first real run all three suggestions came from the same incident), and it does not duplicate a pending or rejected one. Suggestions that fail are dropped with the reason stated.
4. **Decision**: the user can edit first (the new value goes through the same `BotPatch` validation, and the model's original value is stored as `original`), then accept (applied to the agent; if the setting was changed by hand after the proposal, the suggestion is void), reject (optionally with a reason) or withdraw. Rejection reasons and "what the model proposed -> what the user changed it to" both go into the ledger for the next analysis.
5. **Effect**: after accepting, compare the average cost, refutation count and error count over the same number of turns before and after the change. This is only an observation, not a controlled experiment; different tasks introduce bias.

The ledger is stored in `~/.crew/improvements.json`.

## Learning from experience

Borrows the learning loop of Hermes Agent, but every step needs human approval (the paper Practice Makes Unsafe found that systems which automatically write skills from successful experience and apply them automatically all ended up writing unsafe skills):

- **Memory nudge**: when a turn makes 5 or more tool calls, the next turn's prompt in the same session ends with a reminder (`MEMORY_NUDGE`) to record only what the user said and what was verified first-hand. No reminder after switching to a new session or for blind-review roles.
- **Learned skills** (`server/learnSkills.ts`): candidates are turns that completed, made 5 or more tool calls, were not refuted afterwards and have not been drafted yet; listing them is free, drafting takes a click and one Sonnet call. A draft first goes through fixed safety checks (blocked rules and "ignore instructions"-style text are rejected outright; commands that need confirmation and addresses outside the sandbox are flagged), then shows up as a "new skill" suggestion in the improvement suggestions panel. It is written to the skills directory only when accepted, and deleted when withdrawn.

## Data

All data lives in `CREW_HOME` (default `~/.crew`):

```
settings.json  Settings (including model provider keys, stored only locally)
bots.json  chats.json  projects.json  routines.json
messages/      One message file per chat
turns/         Change snapshots for each turn (for undo)
memory/        Agents' long-term memory
skills/        Custom skills
worktrees/     git worktrees of isolated workspaces
uploads/       Uploaded images and attachments
logs/          Server log of the desktop app (server.log)
triggers/      Only once the Super-agent is on: triggers.jsonl (append-only, at most
               2,000 triggers / 14 days), threads.json, payloads/
workers.json   Only once a Router has dispatched a Worker (with its thread subscriptions and
               inbox); the Workers' and Routers' turns are in messages/ under wk_<id> and rt_<chatId>
router/        Only once a Router has run: the empty folder its sessions work in
watchdog/      Only once the Watchdog is on: ticks.jsonl and actions.jsonl (the ledger, at most
               5,000 lines / 30 days each), watches.json, proposals.json; its session works here
               and its turns are in messages/watchdog.jsonl
gateway/       Only once the model gateway has answered a call: calls.jsonl (its usage log)
```

- All writes in `store.ts` are "write a temp file, then rename", and are batched and deferred; on exit `flushAll()` finishes any pending writes.
- `schemaVersion` in `settings.json` records the data format version. When the storage format changes, add a migration to `server/migrations.ts`; on startup missing migrations run in order, and the JSON files are backed up to `backups/` first. If the data is newer than the running Crew, it refuses to start rather than silently corrupting it.
- `migrateFromVibeCrew` in `config.ts` moves data under the old name (`~/.vibecrew`, `~/VibeCrewProjects`) over; it determines where the data directory is, so it runs before version migrations.
- An agent's progress in each turn is flushed to disk every 3 seconds. When Crew is restarted after being killed, that turn is marked "interrupted" and the half-written content is kept; uncommitted changes in an isolated workspace are committed to the branch first.
- Tests must point `CREW_HOME` and `CREW_PROJECTS` at temp directories and must never touch real data (`tests/helpers/server.ts` already does this).

## Isolated workspaces

A chat can work in its own git worktree, on a branch starting with `crew/`; agents, preview, files and terminal all use that copy.

- On creation it brings along local files that git does not track but that the work needs: `.env`, `CLAUDE.md`, settings and hooks in `.claude/`, and files listed in `.git/info/exclude`. Dependency directories, caches and tools' temporary state are not copied. Only files that `git check-ignore` confirms are ignored inside the worktree are copied, so `git status` stays clean.
- A project can configure a setup command, commit message requirements, no AI attribution, and actions that always need confirmation.
- Merging squashes the branch into one commit on the main branch. When the project has commit message requirements, the commit message must be written by hand (`claude -p` can generate a draft).

## Preview

`preview.ts` starts one preview server per project: static sites are served directly (hidden files are not served), and projects with a dev server are reverse-proxied to it. Returned HTML gets `inject/preview-inject.js` injected; it talks to the Crew window via postMessage and handles console capture, navigation tracking, element picking, demo recording and hot refresh. This script runs inside someone else's page, so it is deliberately written in a conservative `function` + `var` style (the lint rules are relaxed for it specifically).

## Desktop app

`desktop/main.cjs` is the Electron main process: it starts the bundled server (`dist-server/server.mjs`) with the login shell's environment variables, waits until it is ready, and loads the UI in a window; the tray, launch at login, and Dock and window icons (following the logo chosen in settings) also live here. `desktop/install.mjs` packages the AppImage, installs it into `~/Applications`, and writes the menu entry and icon.

## A few design decisions

- **Use the local `claude`, not the SDK's bundled binary**: saves 240 MB, and the version follows the user's own Claude Code upgrades.
- **Biome rather than ESLint**: the project uses TypeScript 7 (the native version), which has no JS API, so typescript-eslint cannot run.
- **Routing uses the address bar hash (`#/chat/<id>`)**: each chat gets its own history entry, the browser's back and forward switch between chats, and a link can open a specific chat directly.
- **Tests use the system Chrome**: Playwright does not download browsers; CI uses the Chrome that comes with the runner.
