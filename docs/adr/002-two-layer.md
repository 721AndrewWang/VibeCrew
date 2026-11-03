# ADR 002: Two layers, a resident Router and isolated Workers

Status: accepted (milestone 2 of the Super-agent architecture)

## Context

In a group chat today the lead both routes and executes. Every message without an @ goes to the lead, which reads the code, edits files, hands steps to teammates by @-mention and checks their reports, all in one Claude Code session that keeps growing. The orchestrator runs one turn per chat at a time (`running` is keyed by chat id, `pump` takes the next `Job` only when the turn ends), and `withChatLocked` refuses git operations while any turn runs or waits. So:

- a new message waits behind whatever turn is running, however long it is;
- two independent tasks in one chat run one after the other, never side by side;
- the lead's context mixes routing (what the user wants, who does what) with execution (tool output, diffs), so it grows fast and rotates often;
- stopping a long turn to say something stops the work.

ADR 001 built the event stream (Triggers, Threads, the two-stage filter) and left "who acts on a decision" for this milestone. The Super-agent design splits continuity from execution: a resident **Router** that holds the conversation and coordinates, and **Workers** that each do one task in their own context.

## Decision

When `superAgent.enabled` **and** `superAgent.router.enabled` are on, every **group chat** runs in two layers:

- **Router layer.** One resident Router per group chat. It receives every event in the chat that needs a decision (user messages, routine runs, Worker reports, and environment Triggers the slow path decided to act on), keeps the chat's context, is the only thing that talks to the user, and dispatches work. It never executes anything: its Claude Code session has **no built-in tools** (`tools: []`: no Bash, Read, Edit, Write, WebFetch, Task), no settings files, and a short system prompt of its own instead of Claude Code's. Its only tools are Crew's `crew_router` MCP tools: `dispatch_worker`, `message_worker`, `stop_worker`, `list_workers`, `reply`. It speaks as the chat's lead bot and runs on `superAgent.router.model`, a lighter model by default (Sonnet).
- **Worker layer.** `dispatch_worker` starts a Worker: a new Claude Code session with full tools, one task, in its own git worktree, on the strongest configured model. It runs as a member of the chat (the "dispatching bot": the member the Router names, by default the lead) and inherits that member's role description, permission level (with the chat's switch applied, exactly as for a normal turn), `editScope`, allow/ask rules, plugins, and monthly budget. Workers never post in the chat: a Worker's last message is its report, delivered to the Router as an event; the Router decides what the user hears. Several Workers run at once; the Router stays free to answer while they work.

The rest of Crew is unchanged. Direct chats keep their single bot. With either switch off, group chats route to the lead exactly as before: the code paths that decide this are a single `routerMode(chat)` check in `sendUserMessage` and `runInChat`.

### Why one Router per chat, not per project

The brief allowed either. Per chat wins in Crew:

- **The chat is Crew's channel and the user's unit of attention.** A user keeps separate chats for separate topics on purpose. One Router per project would mix those topics in one context and would have to decide which chat each reply belongs in.
- **Everything the Router needs is already per chat**: the Trigger thread (`chat:<id>`), the lead bot (the Router's voice), the composer's permission/model switches (which Workers inherit), the isolated workspace (where Workers' changes land), and "Start new topic" (which resets the Router's context).
- **Chats without a project, and chats that switch projects,** have no sensible project-level Router.

What per-project would add (one agent coordinating two chats editing the same project) is rare in practice and is better done later with chats as channels of a user-level Router. The Router's state is keyed by chat id in one place (`layers/router.ts`), so widening its scope later does not touch Workers.

### Batching

Each Router has an inbox. When an event arrives and the Router is idle, it starts a turn with everything in the inbox; events that arrive while it is thinking wait and all go into the next turn together, as one prompt (`BatchQueue`, the same pattern as the slow path's `SlowQueue`). One LLM call makes several decisions; the work is long input and short output, so the cost per decision falls as load rises. The one exception: environment events never share a turn with explicit ones (a mixed batch becomes two turns, explicit first), so the dispatch gate below holds per event and injected text cannot ride along with the user's next "ok". Each turn records the ids of the events it handled (`ChatMessage.batch` on the Router's log). Every Router runs in one fixed folder (`CREW_HOME/router`): Claude Code keeps transcripts per folder, and a chat moving into its workspace must not cost the Router its session.

### Inline & Spill in the Router's prompt

A batch is rendered small: a `<workers>` line per active Worker (id, member, status, title, first line of its last report), then one `<event>` per item with its id. User messages are inlined in full (they are the user's words; cut at 4,000 characters with a pointer to `#seq`). A Worker report is inlined to its first ~80 words, with `list_workers id=wk_…` as the "read more" handle, plus what Crew did with its changes. Environment events carry their Trigger id, summary and the filter's reason, fenced and marked as data.

### Gates in code, not in the prompt

The Router's output is probabilistic; these checks are deterministic and live in the tool handlers:

| Gate | Where | Why |
| --- | --- | --- |
| No built-in tools; `canUseTool` denies anything that is not `mcp__crew_router__*` | Router session | The Router reads untrusted events; it cannot touch files, shells or the network. |
| A batch made only of environment events cannot dispatch or message Workers | `dispatch_worker`, `message_worker` | ADR 001's open risk: an event (console text, a file path) must not be able to start work with full tools. The Router can still tell the user; the user's next message can ask for the work. |
| `reply` refuses more than 100 words | `reply` | The chat is a low-interruption channel; detail stays in Worker transcripts. |
| Only chat members can be dispatched; at most `maxWorkers` active Workers per chat (default 3); a member over its monthly budget is refused | `dispatch_worker` | Budget and roles are the user's settings, not the model's choice. |
| Without an isolated workspace, only one Worker at a time may work in the shared folder | `dispatch_worker`, rechecked when the Worker starts | Two sessions editing one folder at once corrupt each other's work. |
| At most `maxHops` (the chat's relay limit) Workers per user message | `dispatch_worker` | Report -> dispatch -> report can loop without the user, as handoffs could. |
| A Worker without its workspace never runs (no fallback to another folder) | Worker turns | A failed start or a retired workspace must not turn into full tools in the home folder. |

## Data model

Shared types in `shared/types.ts`:

```ts
interface RouterSettings {      // settings.superAgent.router
  enabled: boolean;             // default false
  model: string;                // default 'claude-sonnet-5'
  workerModel: string;          // default '' = the chat's model switch, else Settings' default model
  maxWorkers: number;           // per chat, default 3 (1..8)
}

type WorkerStatus = 'starting' | 'running' | 'waiting' | 'done' | 'error' | 'stopped';

interface Worker {              // ~/.crew/workers.json
  id: string;                   // wk_…
  chatId: string;               // the chat whose Router dispatched it
  botId: string;                // the member it runs as
  title: string;                // short, from dispatch_worker
  task: string;                 // the brief the Router wrote
  status: WorkerStatus;
  detail?: string;              // what it waits for, why it failed
  createdAt: number; updatedAt: number;
  model?: string; sessionId?: string;
  projectId: string | null;     // its own workspace (a Project whose workspace.workerId is set), or the chat's folder
  shared?: string;              // why it works in the chat's folder instead
  base?: string;                // the commit its branch started from
  landedHead?: string;          // its last commit merged into the chat's branch
  report?: { at: number; status: 'done' | 'error' | 'stopped'; text: string };
  landing?: { at: number; files: string[]; commit?: string; conflicts?: string[]; error?: string };
  turns: number; costUsd: number;
  related: string[];            // the batch's trigger and message ids (chain of recall)
  pending?: string[];           // follow-ups waiting for the current turn to end
  dismissedAt?: number;
}

interface RouterInfo {          // live state, not stored
  chatId: string;
  state: 'idle' | 'thinking' | 'error';
  queued: number;               // events waiting for the next turn
  detail?: string; since: number;
}
```

Additions to existing types: `WorkspaceInfo.workerId` (a Worker's workspace), `Chat.router` (`{ sessionId, cursor }`: the Router's Claude Code session, and the last chat message it was given), `ChatMessage.router` (a reply the Router posted) and `ChatMessage.batch` (the event ids a Router turn handled), `ServerEvent` `worker`, `worker_deleted` and `router`, and `workers`/`routers` in `Bootstrap`. All new fields are optional and the new settings key gets defaults when missing, so no migration is needed.

**Transcripts.** A Worker's turns and a Router's turns are ordinary `ChatMessage`s, stored by the existing `MessageStore` under their own log id (`wk_…`, and `rt_<chatId>` for a Router) instead of a chat id. That reuses everything: `TurnStream` streams them (`msg_part`/`msg_text` events carry the log id), restarts mark interrupted turns, the approval cards inside them work, `Trace` reads their Claude Code transcript, and `usage.ts` counts their cost toward the bot they ran as.

## Life of a request

1. The user writes in a group chat in router mode. `sendUserMessage` stores the message, publishes the `user` Trigger (`action: "Sent to the Router"`) and pushes `{ kind: 'user', messageId, triggerId }` into the chat's Router inbox. No bot turn is queued.
2. The Router's turn renders the batch, and the model calls tools. `dispatch_worker({ title, task, bot })` checks the gates, creates the Worker, and returns `Started wk_… (Pixel)` at once (async start); `reply` posts a bot message as the lead (`router: true`).
3. The Worker starts. In a git project, the chat first moves into its isolated workspace if it has none (the existing `createWorkspace`, with its setup command and note), then the Worker gets its own worktree branched from the chat branch's head (`createWorkerWorkspace`, sharing `addWorktree` and local-file copying with chat workspaces; the project's setup command runs there before the first turn). Without a git project, the Worker works in the chat's folder (or home) and says why in `shared`.
4. The Worker's turn runs like a bot turn: `BotSession`, `permissionGate` (approval cards appear in its transcript; the Workers bar shows "waiting for you" and the usual notification fires), the sandbox, deny rules, the wrap-up reminder. Its prompt holds the task, the user's own words from the dispatching batch, and the environment lines.
5. When the turn ends, Crew commits the worktree to the Worker's branch and, if the turn finished, **lands** it: under the chat's lock, it merges the Worker's branch into the chat's branch (`git merge --no-ff` inside the chat's worktree, after committing anything pending there). On conflict it aborts the merge, leaves both branches as they were, and records the conflicted files. The user's project folder is never touched; merging the chat branch into the base branch stays the user's action, as before.
6. The report (final text, status, landing) goes to the Router as a `worker` event, and a `turn` Trigger is published on the chat's thread with rule `routed` (delivered directly, no model). The Router tells the user what matters.
7. `message_worker` on a finished Worker resumes its session for another turn; on a running one it queues the message for when the turn ends. After a conflict, Crew adds instructions to bring in the chat branch and resolve.

## How it fits the existing modules

- `server/layers/` (new): `router.ts` (inbox, Router session and turns), `tools.ts` (the `crew_router` MCP server; the same handlers drive the demo agent), `workers.ts` (dispatch, Worker sessions and turns, landing, stop, dismiss, restart recovery), `prompts.ts` (pure: the Router's system prompt, batch rendering, the Worker's task prompt), `batch.ts` (pure: `BatchQueue`), `config.ts` (pure: defaults and normalisation of the settings).
- `agents/session.ts`: `SessionConfig` gains `tools` (built-in tools; `[]` = none) and `systemPrompt` (replaces Claude Code's preset). `FakeSession` gains scripted Router and Worker behaviour for demo mode.
- `agents/prompts.ts`: `buildSystemAppend` gains a Worker variant (one task, report to the Router, no @-mentions, where its changes go).
- `agents/crewTools.ts`: a Worker's browser session is keyed by the Worker, and it gets no `notify_user` (Workers never talk to the user).
- `orchestrator/`: `sendUserMessage`/`runInChat` route to the Router in router mode; `stopChat` also stops the Router's turn and every Worker; `resetChat` starts the Router over and dismisses finished Workers; `forgetChat` stops and removes them; `isChatBusy` counts the Router and Workers; `whenChatFree` gives landings the chat lock (waiting instead of refusing); `withChatLocked` no longer has anything to wait for in router mode except a landing or a shared-folder Worker. `permissionGate` takes a status callback, so a Worker's approval updates the Worker rather than the bot.
- `workspaces/`: `addWorktree` and `checkGit` are shared by chat and Worker workspaces; `runSetup` is shared by both setup paths; `reconcileWorkspaces` keeps Worker workspaces whose Worker still exists; `disposeWorkspace` is reused to remove them.
- `triggers/`: an act decision for a chat in router mode goes to its Router as an environment event instead of a UI-only notice; Worker turn results are `turn` Triggers with fact `routed`, settled on the fast path.
- `usage.ts`: counts Worker and Router logs.
- API: `GET /api/workers?chatId=`, `GET /api/workers/:id/messages`, `POST /api/workers/:id/stop`, `POST /api/workers/:id/dismiss`, `GET /api/chats/:id/router/messages`; `PATCH /api/settings` accepts `superAgent.router`.
- UI: a Workers bar above the composer in router-mode chats (the Router's state and queue; each Worker's title, member, status and last report; Stop, Dismiss, and a transcript dialog that reuses the chat's message rendering, approval cards included); the chat header and the composer's Stop button count Router and Workers; Settings → Super-agent gets the switch, the two models and the Worker limit.

## Restart and cleanup

The Router's inbox is in memory. On start, for each group chat in router mode, user messages after `Chat.router.cursor` are put back into the inbox, and Workers that were starting, running or waiting are marked stopped (`Crew restarted`), their worktrees committed (`reconcileWorkspaces`), and reported to the Router so it can tell the user. Dismissed Workers lose their worktree at once (a branch with unlanded work is kept, like a closed chat workspace) and their record and transcript after 14 days. Finished Workers are dismissed automatically after 6 idle hours, by "Start new topic", or with the Dismiss button.

## Deliberately left out

- **Thread subscriptions and direct delivery** (the essay's fast path for follow-up events): every event in the chat still goes through the Router. Worker reports are the only direct route, because a Worker always belongs to one Router.
- **Mid-turn input.** New events wait for the Router's current turn to end (they are batched, not dropped); injecting them into a running turn is the full-duplex milestone.
- **A recall tool** walking Triggers and messages by id. `list_workers id=` is the only "read more" handle the Router gets now.
- **Speculative execution.** Environment events cannot start Workers at all (see the gates).
- **Direct chats** keep their single bot; a one-member chat has nothing to coordinate.
- **Auto adversarial review and the stall detector** belong to the old chain of turns and do not run in router mode; the Router can dispatch Skeptic or Lens as Workers (blind reviewers get their blind prompt with the chat branch's diff). A Worker's verdict is not recorded as the workspace's challenge result yet, so `requireChallenge` projects still need a review from a normal turn before merging.
- **Per-turn undo of a landing.** A landing is a merge commit on the chat's branch; git history is the record and the way back.
- **Aborting a Worker's setup command.** Stopping a Worker that is still preparing its workspace takes effect once the setup command ends (at most 15 minutes).
- **Watchdog, model gateway, credential masking**: later milestones.

## Risks

- **Prompt injection through events.** The Router reads untrusted text and has no tools that touch the environment; environment-only batches cannot start or steer Workers; Workers get tasks the Router wrote plus the user's own words, never raw event text. A Worker can still read untrusted content while it works (a page, a file), as any bot can today; the sandbox and the permission level are the boundaries there. Its report counts as explicit (it descends from a user's request), so text a Worker quotes reaches the Router in a batch that can dispatch; the relay limit caps how far that can go without the user.
- **Stale sessions.** A Worker's session is made with the chat's switches, the bot's rules and the sandbox setting of the moment; changing any of them closes idle Worker sessions (resumed with the new settings) and switches a running turn's permission mode at once, as for chat sessions. Idle Worker processes close after 15 minutes.
- **Cost.** Each Worker is a full session on the strongest model, and a parallel burst multiplies spend. `maxWorkers`, the members' monthly budgets (Worker and Router turns count toward them), and a cheaper Router offset it. The Router's context rotates like a bot's (`rotateAtTokens`), carrying the recent chat and the Worker list.
- **Merge conflicts between parallel Workers.** Landing is sequential and git does the merging; a conflict leaves both branches intact and goes to the Router, which can ask the Worker to bring in the chat branch. The Router is told to keep tasks that touch the same files in one Worker.
- **Disk and setup time.** Each Worker is a worktree, and a project's setup command (say `npm ci`) runs in each. Finished Workers are cleaned up after 6 idle hours.
- **Behaviour drift when off.** Router mode is one check at the two entry points; the integration test sends the same message with the switch off and checks that the lead answers as before and no Worker or workspace is created.
