# ADR 105: Hardening Super-agent mode as one system

Status: accepted (hardening of milestones 1-7 and 9 after their integration, ADR 010)

## Context

ADR 010 wired the Super-agent milestones to each other seam by seam and tested each seam on its own. Nobody had yet walked the whole flow with **every switch on at once**, killed Crew in the middle of it, or checked what a newcomer needs to know to turn the parts on. This ADR does those three things and records what broke.

The walk: a user's message and a failing test run arrive as Triggers and pass the two-stage filter; the Router dispatches a Worker; the Worker subscribes to the folder's Thread and gets the failing test straight from the bus; a console error nobody listens for goes through the slow path to the Router (which may not start work from it); a long command starts and is stopped; recall walks the reference graph from the Worker; the Watchdog notices a stuck Worker and redirects it; the model gateway hands every role's calls on past an account that is out of quota. Then the same with Crew killed mid-run, and once more with every switch off.

What broke:

1. **Claude Code's tool search hid Crew's own tools.** Current Claude Code defers MCP tools behind its `ToolSearch` tool: a session is offered a placeholder and loads a tool by searching for it. So a bot's `chat_history`, a Worker's `recall`, `hand_back` and `unsubscribe_thread`, a full-duplex bot's `start`/`stop`/`status` were not in the tool list their prompts refer to, and the Router and the Watchdog, whose only tools are their own, were offered a placeholder tool besides. Eight tests that read the exact tool lists against the real CLI failed on the integrated branch for this reason alone.
2. **Summaries lost the ids they named.** `preview()` (the one-line form of a message used for Trigger summaries of turn results and Worker reports, notifications and the chat list) stripped every `_` as Markdown, so `job_TMddPdPj` became `jobTMddPdPj`: an id an agent reads in a Trigger's summary was a dead end for `recall`.
3. **A background command outlived Crew.** A full-duplex job's command runs in its own process group (`procs.ts`), so a crash of Crew does not take it down. A restart marked the job `stopped (Crew restarted)` while `npm test` or `sleep 120; touch …` went on running and writing, with nobody reading its output (the integration test for that restart left its `sleep 120` running).
4. **A Router turn cut off mid-batch lost the user's message.** The Router moves its cursor past a user's message when a turn takes it, so a restart does not hand it over twice. A restart during that turn, before it dispatched anything, therefore lost the message: never acted on, never handed over again, with no word to the user.
5. **A Worker's report waiting for the Router was lost.** Reports wait in the Router's in-memory inbox while it is busy. A restart then lost them: the Worker reads `done`, but the Router, and so the user, never heard what it did.
6. **A Watchdog tick cut off by a restart stayed half-done.** A tick that calls the model is recorded `ran` before its turn and gets its `messageId` after. Cut off in between, it stayed `ran` for good; since the next tick's window starts at the last tick that looked, whatever the cut-off tick was about to read (a failure, a refusal) was never looked at. A maintainer's question cut off the same way stayed unanswered without a word, and a watch on a Worker the restart cut off kept being re-checked until it gave up.
7. **The Watchdog could start work twice.** `restart_worker` accepted any stopped Worker: one a restart of Crew cut off (whose Router was just told and may resume it), one the user stopped, or one the Router had already replaced with a new Worker for the same request.
8. **The Watchdog's "stuck" rule could not be exercised end to end** without waiting `stuckMinutes` (at least 5) in a test, and no e2e test covered the Triggers view, the Watchdog page and drafts together (ADR 010 left the browser test out).

## Decision

Fix each break where it happens, in new modules where the fix is new code, behind the switches that already exist: **no new setting, no migration** (the new record fields are optional). Test the whole flow, the restart and the off state as one system.

| Break | Fix | Where | Test |
| --- | --- | --- | --- |
| 1. Tool search | Crew's own MCP servers (`crew`, `crew_router`, `crew_watchdog`) set `alwaysLoad`, so their tools are always in the prompt, as they were before tool search. The Router's and the Watchdog's sessions also get `ENABLE_TOOL_SEARCH=false`: they have no other tools, so their tool list is exactly their own. Users' plugins stay deferrable. | `agents/crewTools.ts`, `layers/tools.ts`, `watchdog/tools.ts`, `agents/toolSearch.ts` (new), `layers/router.ts`, `watchdog/index.ts` | the existing real-CLI tests (`two-layer`, `subscriptions`, `prompt-slimming`, `super-agent-off`, `browser-dark`) pass again; `tests/unit/hardening.test.ts` |
| 2. Ids in summaries | `preview()` drops Markdown marks but keeps an underscore inside a word. | `orchestrator/chatLog.ts` | `super-agent-flow.test.ts` (a turn's summary names its job); unit |
| 3. Orphan commands | A command Crew spawns records its process group (`BackgroundJob.pid`, flushed at once). On start, `reapOrphan` stops a group still alive (SIGTERM, SIGKILL after 3 s) before the job is reported, and the job's detail says so. A live leader must have started when the job did (`ps -o etime=`; its command line does not tell, since bash execs the last command), so a reused process id is never touched; a group whose leader is gone is the job's, since an id is not reused while a group uses it. | `jobs/orphans.ts` (new), `jobs/runner.ts`, `jobs/index.ts` | `restart.test.ts` (the process is gone, its late write never happens, one result note); `full-duplex.test.ts` (expectation updated); unit |
| 4, 5. Router redo | On start, `routerRedo` (pure) reads the Router's own log, where each turn names the events it took (`batch`) and a turn a restart cut off is marked `interrupted`, and the Workers' records. It hands the Router again (a) each user message or routine run a cut-off turn took **for which no Worker exists** and no later turn took, and (b) each Worker report **no finished turn took** (in a cut-off turn, or never read); both at most 6 hours old, so the first restart after an upgrade does not dig up a request from an old crash. A re-handed event carries a line (`resumed`): a cut-off one tells the Router to check `list_workers` before dispatching. Not handed again: anything a Worker was dispatched for (that Worker's interruption is reported, as before), reports of a chat the user stopped (`Chat.router.stoppedAt`, `Worker.report.quiet`: that inbox was dropped on purpose), environment events (stale after a restart). | `layers/recovery.ts` (new), `layers/router.ts` (`resumeRouters`, `stop`), `layers/prompts.ts` (`resumedLine`), `layers/workers.ts` (`report.quiet`) | `restart.test.ts` (killed during a held Router turn with a report waiting: one Worker for the held message, each event in exactly one finished batch); unit |
| 6. Watchdog ticks | On start, `recoverWatchdog` settles each tick left `ran` without a turn: a timer or manual tick becomes `skipped` (`interrupted: …`), so the next tick looks from where it would have; a maintainer's becomes `error`, and the Watchdog's log says the question went unanswered. Actions it took before the restart stay in the ledger and are counted. Open watches on Workers a restart cut off are resolved: their Router decides now. Writes nothing when there is nothing to settle. | `watchdog/recovery.ts` (new), `watchdog/index.ts` | `restart.test.ts`; unit |
| 7. Duplicate work | `restart_worker` is also refused (`restartConflict`, pure) for a Worker a restart cut off, one the user stopped, and one the Router replaced: another Worker of the chat, created after this one ended, for the same request (shared `related` ids). A sibling dispatched in the same batch does not count. | `watchdog/duplicates.ts` (new), `watchdog/tools.ts` | unit |
| 8. Test reach | A test-only clock (`tests/helpers/clock.ts`, preloaded with `startServer({ clock: true })`, `shiftClock(ms)`) moves the server's `Date.now()`; timers still run in real time. `startOutOfQuota()` joins the mock provider helpers. The demo Router "holds on" for up to 20 s when asked (so a test can kill Crew mid-turn) and acts at once on a re-handed event; the demo full-duplex bot answers a job's result only when nothing the user wrote comes after it. | `tests/helpers/`, `agents/session.ts` (demo agent only) | `super-agent-flow.test.ts`, `restart.test.ts`, `tests/e2e/super-agent.spec.ts` |

### The tests that pin it

- `tests/integration/super-agent-flow.test.ts`: the walk above in demo mode (the stuck Worker with the test clock; the recall walk asserts that every id a recall result offers resolves for that chat), and with the real Claude Code and a mock provider: one routing group whose first account answers 429 to everything, every role routed to it; every call of the Router, its Worker, the slow path and the Watchdog is logged as handed on, then answered, and no session sees an error.
- `tests/integration/restart.test.ts`: Crew killed while the Router thinks, with a Worker's report waiting and a long command running; then the recovery, and subscriptions for Workers dispatched after the restart.
- `tests/integration/super-agent-off.test.ts`: as before, plus a crash and restart with every switch off that recovers, writes and starts nothing new.
- `tests/e2e/super-agent.spec.ts`: in Chrome, every switch on: the Workers bar, a drafted push above the composer, the Triggers view (verdicts, a Trigger's detail), the Watchdog page (Tick now, the flag for an agent the guard refused twice, its notice), discarding the draft.

## How it fits the existing modules

- Recovery runs where each part already recovers: `recoverJobs` (jobs), `resumeRouters` (after `recoverWorkers`, before routines start), `startWatchdog` (before the timer). The order in `server/index.ts` is unchanged.
- All the new logic that decides something is pure (`routerRedo`, `restartConflict`, `settleInterruptedTicks`, `watchesOnCutOff`, `startedWithJob`, `etimeMs`) and unit-tested; the effectful parts are a few lines each.
- Nothing new runs with the switches off: the recovery only acts on records that exist only once a feature was on (a Router's log, a job with a `pid`, the Watchdog's ticks), and `alwaysLoad` restores the tool list bots had before Claude Code deferred MCP tools. `super-agent-off.test.ts` pins both.
- The Router's gate (an environment-only batch cannot dispatch) and the Workers' delivery rules are untouched; a re-handed user message is explicit, as it was the first time.

## Deliberately left out

- **Slow-path decisions on their way to a Router** (an environment event in its in-memory inbox at the crash) are not handed over again: they are stale by then, and the Trigger records the decision.
- **Sandboxed background commands** run inside a helper Claude Code session that ends with Crew; whether the sandboxed process survives is Claude Code's, and Crew has no process id to check.
- **The dev server** also runs in its own process group and can outlive a crash; it is not part of Super-agent mode and the next preview restarts it anyway.
- **A Router turn cut off after it replied** but before it dispatched: the re-handed message may get a second short reply. The Router is told to check its Workers first, so no work is started twice.
- **A Router that re-dispatches the same work under another request**: `restartConflict` matches requests by id, not by what the task says.
- **A model call in flight at the crash** is lost; the gateway's spend windows count only logged calls (ADR 009).
- **Speculative execution** (milestone 8) is still not built.

## Risks

- **A missed duplicate.** `routerRedo` decides "a Worker exists for this message" from `Worker.related`, which every dispatch fills. A Router turn cut off between a `dispatch_worker` returning and its Worker record being written cannot happen: the record is written before `dispatch_worker` returns.
- **Killing the wrong process.** Only a group whose leader started within 10 s of the job (or whose leader is gone while the group lives, which the kernel does not reuse) is signalled. A clock change between the job's start and the restart can make Crew leave an orphan running; it never makes it kill another process.
- **More prompt for every bot.** `alwaysLoad` puts Crew's own few tools back in every prompt, as before tool search; users' plugins with many tools are still deferred.
- **A Claude Code rename.** If `ENABLE_TOOL_SEARCH` changes, the Router and the Watchdog get a placeholder tool back (harmless: it cannot be called); the real-CLI tests that read their tool lists would catch it.
