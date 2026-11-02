# ADR 004: Full-duplex sessions with async start/stop tools

Status: accepted (milestone 4 of the Super-agent architecture)

## Context

A bot's turn is a ReAct loop: the model calls a tool, waits for the result, reasons, calls the next one. Every tool call blocks the loop until it returns, and the chat runs one turn at a time (`orchestrator.pump`). So a long operation blocks everything behind it:

- `npm test`, a production build, an install or a migration holds the turn for minutes; Claude Code's Bash tool gives up after 10;
- a message the user sends meanwhile waits until the whole turn is over, however long the command takes;
- the only way to say "never mind, do X instead" is Stop, which throws away the turn;
- the model cannot do anything useful while it waits (read the next file, answer a question).

The design notes call for **full duplex**: long tool calls become asynchronous `start()`/`stop()`; `start` returns "Started" at once, the result arrives later as a new event, the model can stop work that runs too long, and new user input is handled after the current reasoning step. ADR 001 gave Crew an event stream (Triggers on Threads) and ADR 002 the idea of delivering results as events instead of tool returns (`dispatch_worker` already returns at once). This milestone brings the same shape to every bot turn.

## Decision

Add **background jobs** (`server/jobs/`) and three Crew tools for bots that opt in:

| Tool | What it does | Returns |
| --- | --- | --- |
| `start({ command } \| { task }, title?, timeoutMin?)` | Launches a shell command, or a sub-task (a background session of the same bot), and returns at once | `Started job_… (title).` plus how the result will arrive |
| `stop({ id })` | Terminates a running job (process group SIGTERM, SIGKILL after 3 s; a sub-task's session is interrupted and closed) | Its status and output so far, inline and spilled |
| `status({ id?, from?, lines? })` | No id: the chat's jobs, one line each. With an id: status plus the output's tail. With `from`/`lines`: that slice of the full log ("read more") | Text |

When a job ends (done, failed, stopped, timed out), its result is **delivered into the session as a new event**: a system message in the chat (`notice: 'job'`, visible to the bot, rendered as a compact card), a Trigger with source `job` on the chat's Thread (acted on by the fast path as an explicit request, since the bot itself asked for it), and a new turn for the bot that started it (`MessageTrigger { type: 'job', jobId }`). If that bot's turn is still running when the result lands, it is injected after the current step instead (below), and no extra turn runs.

**Opt-in per bot**: `Bot.fullDuplex` (default off, a toggle in the bot editor). With it off the bot's session has no `start`/`stop`/`status` tools, its system prompt does not mention them, nothing is injected mid-turn, `CREW_HOME/jobs/` is never created, and Crew behaves exactly as before. It does not depend on `superAgent.enabled`: the Trigger is recorded only when the Trigger bus is on (`publishTrigger` returns early otherwise), the rest works either way.

### New input after the current reasoning step

A full-duplex bot's turns have a **mid-turn inbox**. When the user writes in the chat while that bot's turn runs, and the message is for that bot (a direct chat, an @-mention, or the group's lead when nobody is mentioned), its text goes into the inbox as well as into the chat as usual; so does a job result for that bot. The session's `PostToolUse` hook (the one that already carries the wrap-up reminder) drains the inbox after every tool call of the main loop and hands it to the model as `additionalContext`:

```
<new_input>
[User · #42] also make the button blue
</new_input>
(These arrived while you were working. Take them into account now: adjust what you are doing, or answer briefly, then carry on.)
```

So the model reads new input after the step it is in, not after the turn. When the turn ends, Crew checks what the bot saw: if every message after the turn's start was injected (or is the bot's own), its cursor moves past them and the turn that had been queued for them is dropped; otherwise the queued turn runs as before, so nothing is lost when the model wrote its final answer without another tool call. Messages with images are never injected (`additionalContext` is text); they wait for the next turn as before.

### Inline & Spill for output

A command's output goes to `CREW_HOME/jobs/<id>.log` (ANSI codes stripped, capped at 5 MB with a marker). The result message and `stop`/`status` show it Inline & Spill:

- inline: an id line (`job_… · command · exit 0 · 2m 13s · 1,284 lines`), then the **head** (first 20 lines, at most 1,500 characters) and the **tail** (last 40 lines, at most 3,000 characters), with `… 1,224 lines omitted (status id=job_… from=21 lines=200) …` between them;
- spilled: the full log, read by slice with `status id=… from=… lines=…` (at most 400 lines / 16,000 characters per call), and in the UI.

A sub-task's result is its final text under the same budgets; its full transcript is a log of its own (`bg_<id>` in `messages/`), like a Worker's.

## Data model

Shared types in `shared/types.ts`:

```ts
type JobStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

interface BackgroundJob {         // CREW_HOME/jobs/jobs.json
  id: string;                     // job_…
  kind: 'command' | 'task';
  chatId: string; botId: string;
  projectId: string | null;       // where it runs (the chat's workspace or project)
  cwd: string;
  title: string;
  command?: string;               // kind command
  task?: string;                  // kind task
  status: JobStatus;              // waiting: a sub-task waits for an approval
  detail?: string;                // why it failed or stopped ("Timed out after 60 min", "Crew restarted")
  sandboxed: boolean;             // ran as a Bash call inside Claude Code's sandbox
  startedAt: number; endedAt?: number;
  exitCode?: number | null; signal?: string | null;
  timeoutMin: number;
  lines: number; bytes: number; truncated?: boolean;
  startedBy?: string;             // the turn message that called start
  resultMessageId?: string;       // the system message that delivered the result
  triggerId?: string;             // the Trigger on the chat's thread
  logFile?: string;               // command jobs: the full log on disk
  costUsd?: number;               // sub-tasks
}
```

Additions: `Bot.fullDuplex`, `MessageTrigger.type 'job'` (+ `jobId`), `ChatMessage.notice 'job'` (+ `jobId`), `TriggerSource 'job'` (not a filtered source: there is no setting for it), `ServerEvent` `job`, `Bootstrap.jobs`. All optional; no migration.

Storage: `CREW_HOME/jobs/` is created on the first job. `jobs.json` is a `Collection`; logs are `<id>.log`. The newest 200 jobs per chat and 14 days are kept; older records and their logs are removed hourly. On start, jobs a restart cut off are marked `stopped` (`Crew restarted`), and their result is delivered (as a note, without a new turn: the bot's process is gone too). On shutdown every running job is stopped (`stopAllJobs`, next to `stopAllDevServers`).

## Gates: exactly as a Bash call would

`start` is a Crew MCP tool, which Claude Code allows without asking (`mcp__crew` is on every bot's allow list). So the handler applies the gates itself, by asking the running turn's own `permissionGate` about a synthetic `Bash` call with the same command:

| Check | Where | Result |
| --- | --- | --- |
| Blocked actions (`denyRules`) | `permissionGate` → `deniedReason` | Refused, same message as for Bash |
| Read-only bots (`plan`) | `startRefusal` (pure) | Refused: a read-only role cannot start commands |
| The bot's and the project's must-ask rules, allow rules, the permission level (`ask`, `edits` → approval card unless allowed; `auto` → allowed; `review` → approval card, since Claude Code's classifier never sees an MCP call) | `permissionGate` → `decide` | An approval card in the turn, exactly as for Bash; denied means not started |
| At most 4 running jobs per chat, timeout 1-720 min (default 60) | `startRefusal` | Refused with the reason |
| **Sandbox** | `server/jobs/runner.ts` | When the sandbox is on and available, the command runs as a real Bash call inside Claude Code's sandbox (below); Crew never spawns it unconfined |

A sub-task needs no approval to start (it has no side effects by itself); each of its tool calls goes through the same `permissionGate` as a turn of that bot, with its approval cards in its own transcript, the job marked `waiting` and the usual notification.

### How the sandbox is kept

The sandbox is Claude Code's (bubblewrap plus its network proxy, configured by `sandboxOptions`); Crew has no way to confine a process itself, and building a second sandbox would be a weaker copy of what ARCHITECTURE.md calls the only layer that counts as a security boundary. So:

- **Sandbox off or unavailable**: Crew runs the command itself with the same process handling as the dev server (`server/procs.ts`, extracted from `devserver.ts`: `bash -c` in a new process group, the cleaned environment, group kill with SIGTERM then SIGKILL). Output streams to the log as it comes.
- **Sandbox on**: the command runs in a helper Claude Code session that has only the `Bash` tool, the bot's sandbox options and deny rules, the cheapest model and a two-line system prompt. Its `canUseTool` allows exactly one call: `Bash` with the approved command, rewritten in code (`updatedInput`: the command, the timeout capped at Claude Code's 10 minutes, no `run_in_background`). Anything else is denied. So the command *is* a Bash call, confined exactly like one; the helper model never sees anything but the command and its output. Costs: one small model call per job, output only at the end, at most 10 minutes. Stopping interrupts and closes the helper session.

## How it fits the existing modules

- `server/jobs/` (new): `index.ts` (the registry: start, stop, finish, recover, sweep, per-chat queries), `runner.ts` (the two command paths and sub-tasks), `spill.ts` (pure: head/tail inlining, log slices, result text), `gates.ts` (pure: `startRefusal`), `tools.ts` (handlers shared by the MCP server and the demo agent).
- `server/procs.ts` (new, extracted): process-group spawn and kill, now used by `devserver.ts` and jobs.
- `agents/crewTools.ts`: `CrewContext.jobs` adds `start`/`stop`/`status` to the `crew` MCP server; Workers and sub-tasks never get them (no recursion, and a Worker's turn end is when its work lands).
- `agents/session.ts`: `SessionConfig.midTurnNote` (read in the `PostToolUse` hook, joined with the wrap-up note); `FakeSession` gains a scripted full-duplex demo (`background`/`slow`).
- `agents/prompts.ts`: the tools and the rules of thumb in the system prompt of a full-duplex bot ("anything over ~30 s goes through start; do not poll status in a loop; end your turn if there is nothing else to do"); the prompt of a turn started by a job result.
- `orchestrator/`: `Running` keeps the turn's gate and inbox; `getSession` wires jobs and the inbox for full-duplex bots; `sendUserMessage` fills the inbox; `runTurn` settles injected input at its end; `deliverJob` posts the result, publishes the Trigger and queues the turn; `stopChat`, `resetChat` and `forgetChat` stop the chat's jobs; `projectRunning` counts running jobs, so their writes are not reported as outside edits.
- `triggers/`: source `job`, explicit on the fast path.
- `usage.ts`: sub-task logs count toward the bot's spend.
- API: `GET /api/jobs?chatId=`, `GET /api/jobs/:id/log?from=&lines=`, `POST /api/jobs/:id/stop`; `Bootstrap.jobs`; `PATCH /api/bots/:id` accepts `fullDuplex`.
- UI: a Jobs bar above the composer (title, bot, status, elapsed, Stop, Log); a log dialog (the full log, paged, with "Follow in terminal" that opens the Terminal tab on `tail -f` of the log, reusing `terminal.ts`), or a sub-task's transcript; job result cards in the chat; the bot editor toggle; `job` in the Triggers view.

## Deliberately left out

- **Workers (two-layer mode)** do not get the tools. A Worker's turn ending is when its work lands and its report goes to the Router; a job outliving it would have nowhere to deliver. The Router already has async dispatch.
- **Injecting into a turn without tool calls.** `additionalContext` rides on tool results; a turn that only writes text sees new input on its next turn, as today.
- **Interactive input to a running job** (stdin). The terminal is for that.
- **Jobs that survive a restart.** They are stopped on shutdown and marked stopped on start.
- **Long sandboxed commands** beyond Claude Code's 10-minute Bash limit, and live output for them.
- **Sub-tasks in their own worktree.** A sub-task works in the chat's folder, like the bot; the prompt tells the bot to use sub-tasks for investigation and checks, not for edits that overlap its own. Its edits are committed with the chat's next turn and are not part of a turn's undo.

## Risks

- **Escaping the sandbox.** The one path that spawns a process directly is taken only when the session itself would run unsandboxed (`sandboxOptions` returns undefined). The decision is made per job from the same function the session uses, at start time.
- **Escaping the approval gates.** `start` asks the turn's own gate about a `Bash` call with the same text, so deny rules, must-ask rules, allow rules and levels apply as for Bash; `plan` is refused. A unit test checks that a command the gate denies is not started, and an integration test that an `ask` bot gets an approval card.
- **Runaway processes.** A timeout per job (default 60 min), at most 4 running per chat, group kill on stop, on chat Stop/reset/delete and on shutdown; logs capped at 5 MB.
- **Prompt injection through output.** Output reaches the model as a system message, fenced as data, like any tool result today; the job's result can start a turn of the bot that asked for it, never of another bot, and only once per job.
- **Context growth.** The inline budget is ~4.5 k characters per result; everything else stays behind `status`.
- **Behaviour drift when off.** Every addition is behind `fullDuplex`; the integration test checks that a bot without it gets no tools and no `jobs/` folder.
