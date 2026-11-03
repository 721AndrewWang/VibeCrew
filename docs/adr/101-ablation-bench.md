# ADR 101: The Super-agent ablation bench

Status: accepted (evaluation harness for the Super-agent architecture)

## Context

The design notes make three quantitative claims about the Super-agent architecture, all taken from the essay's ablation experiment:

- **Batching** (design notes §1): events that arrive while the Router thinks pile up and go into its next call together; the work is long input and short output, so the cost per decision falls as load rises.
- **Direct routing** (§2): once a Worker subscribes to a Thread, later Triggers there go to it in code. In the essay, this cut Router decisions by about 30% and cached-read tokens by about 37% with the same completion time.
- **Two layers against one session** (§1): one session for everything is continuous but serial and slow; Router plus Workers keeps continuity and adds throughput.

The task brief asks for the experiment "following section 7 of the design notes" and for "Router batch size vs arrival rate (section 7.2)". `docs/superagent/design-notes.md` has sections 1-5 only; there is no section 7. This ADR reads those references as the essay's experiment that §1 (batching) and §2 (direct routing) quote, and treats "batch size vs arrival rate" as the measurement behind §1's batching claim.

Crew (ADRs 001-010) now implements all three ideas, but nothing measures them. Driving a real server is not an option for this: real Claude Code processes, real timers and real git make a 300-event run take hours, cost nothing only with the mock provider, and give different numbers on every run. The bench has to be **offline, deterministic and fast**, and it has to measure **scheduling and routing**, not how well a model writes code.

## Decision

Add `server/bench/`, a discrete-event simulation on a virtual clock that runs a generated workload through four configurations, using Crew's own rule modules wherever they are pure, and a scripted model in the shape of the mock model harness. `npm run bench` (`scripts/bench.ts`) writes a JSON result and a self-contained HTML report.

### Workload (`workload.ts`)

A seeded generator (`rng.ts`, mulberry32) produces a chat plus CI stream: by default 300 events over 180 simulated minutes, of which 20 are **work requests** and the rest **follow-ups** (extra work on a requested task), **stop requests**, **chatter** and **CI results** (per task branch; passed, or failed with failing test names). Arrivals follow a rate that rises and falls (a few bursts), so the Router sees a range of arrival rates within one run. Every time in the workload (gaps and amounts of work) is multiplied by `timeScale`; model latency is not, so a smaller scale means a busier chat. Message texts carry the task id (`(task T07)`, `For T07: …`, `Stop T07 …`), which is what the scripted model reads.

### Time and work

- `clock.ts`: a virtual clock. Timers are a heap ordered by time, then by insertion; between two timers the clock lets every pending promise settle (and waits for any model call in flight), so `async` code written in Crew's style runs unchanged and the run is deterministic.
- Work is a tool that only consumes time: `work({ task })` advances one step (2 simulated minutes, scaled) of the task's remaining work and returns a fixed-size filler output (300 tokens by default, standing in for file reads and test output) and how much is left.
- Every model call costs virtual time: a fixed overhead, plus per context token read (cached prefix), per new input token, and per output token, times a factor per role (the Router and the event filter run on lighter models). The constants are in `BenchOptions.latency`; they are assumptions, written into the result.

### Model calls (`model.ts`, `policies.ts`)

Every agent session (Router, Worker, lead, sub-task, event filter) keeps an Anthropic-shaped conversation (`system`, `messages` with `tool_use` / `tool_result` blocks, `tools`) and asks a `ModelClient` for the next step. The scripted policy is a pure function `(request) => Reply`, with `Reply` exactly the mock provider's (`{ text }` or `{ tool: { id, name, input } }`): it reads only what the request contains, the way a model would.

- `inProcessClient` calls the policy directly (the CLI and the unit tests).
- `httpClient(url, token)` posts the same request to an Anthropic-compatible endpoint, one call at a time. The integration test starts `tests/helpers/mockProvider.ts` with `reply: mockReply` (the policy, adapted to `MockRequest`), runs the reduced bench over HTTP, and checks the result equals the in-process run.

The policies:

- **Router**: parses `<workers>` lines (Worker id, status, `T07: …` title) and the batch's `<event>`s (Crew's real `renderBatch`). It plans the turn once from what it sees: `stop_worker` for stop requests, `message_worker` for follow-ups (or `dispatch_worker` again if that task's Worker was stopped), `dispatch_worker` for new requests while the system prompt's Worker limit allows, and one `reply` per batch with user messages or reports (acknowledgements, "T07 is done", and the queue). Requests over the limit are queued, and every reply restates the queue (`Queued: T09, T11.`): that is how the queue survives a session rotation, since the recap carries the latest chat messages. Environment events get no reply and no tool call.
- **Worker** / **sub-task**: calls `work` until the tool says the task is complete, then writes its report. Events delivered between steps are read and ignored (CI results never change the work; see what is left out).
- **Lead, neutral prompt**: does every requested task itself with `work`, oldest first, then replies.
- **Lead, delegate-first prompt**: starts each task as a sub-task (`start({ task })`), stops the sub-tasks of a stopped task (asking `status` first when a new session lost their ids), starts a follow-up as a sub-task of its own once the task's running sub-task has ended (two at once would edit the same folder, and Workers serialise follow-ups the same way), queues what is over the job limit it knows of (restated in every reply, as the Router does), and replies.
- **Event filter** (the slow path's cheap model): acts on CI failures for tasks it has not seen fail in this batch, stays quiet otherwise.

### The four configurations (`sim.ts`)

| | Router | Workers | Direct routing | Who executes | Parallelism cap |
| --- | --- | --- | --- | --- | --- |
| (a) `super-agent` | yes | yes | on | Workers | 4 Workers |
| (b) `no-direct` | yes | yes | off | Workers | 4 Workers |
| (c) `single-neutral` | no (the classic lead) | no | — | the lead, inline | 1 |
| (d) `single-delegate` | no (the classic lead, full duplex) | sub-tasks | — | background sub-tasks | 4 jobs |

The Workers limit is set to Crew's full-duplex job limit (`MAX_RUNNING`, 4) so that (a), (b) and (d) have the same parallelism; only the scheduling differs.

How events move, and which Crew code decides:

- **User messages** are `user` events. In (a)/(b) they go into the Router's `BatchQueue` (`layers/batch.ts`, the real class), which runs one turn at a time and splits explicit from environment events as `RouterSession` does. In (c)/(d) they go to the lead, one turn at a time with everything that arrived meanwhile; in (d) (full duplex) they are also injected after the lead's next tool call, in the `<new_input>` shape.
- **CI results** are environment Triggers on the chat's workspace thread. Crew has no CI source yet, so they go through `fastPath` (`triggers/fastPath.ts`) under the rules of the closest filtered source, preview console errors: a passing run has no errors and is dropped (`no-errors`); a failing one, in (a), goes straight to every active Worker subscribed to the thread (`receivers`, `pushInbox` from `layers/subscriptions.ts`), read between its steps (`deliveredNote`) and listed for the Router under `<direct>`. Without subscribers it is a candidate: cooldown, duplicate and hourly budget rules apply, then the slow path's batched cheap-model decision (at most 8 per call, one call at a time) and, if it acts, an environment event for the Router (b) or a line in the lead's next input (c)/(d).
- **Landings**: when a Worker's turn ends, a `landing` Trigger goes through `fastPath` to the other active subscribers (a) or is dropped (b), as in Crew.
- **Gates**: `dispatchRefusal` and `messageRefusal` (`layers/gates.ts`) and `startRefusal` (`jobs/gates.ts`) answer the tool calls; a refusal is the tool's error, as in Crew.
- **Prompts**: the Router's system prompt and batches are `routerSystemPrompt` and `renderBatch`, the recap `recapText`, Worker tasks `workerPrompt`, deliveries `deliveredNote`. The Worker's, lead's and sub-task's system prompts are short stand-ins: Crew's `buildSystemAppend` imports `server/config.ts`, which creates the data folder on import, and the bench must never touch `~/.crew`. Each stand-in is constant per session, so it costs every configuration the same per call.
- **Rotation**: the Router and the lead start a new session with a recap once their context passes `rotateAtTokens` (60k, Crew's default), as `RouterSession.measure` does.
- **Tokens** are estimated with Crew's `estimateTokens` (`recall/spill.ts`). Sessions that run on Claude Code (Workers, the lead, sub-tasks) also carry a stated harness overhead for Claude Code's own system prompt and tool schemas (8,000 tokens by default), the Router its MCP tool schemas (600); without it the stand-in prompts would make every Claude Code call look cheaper than the Router's.

### Metrics (`metrics.ts`)

Per configuration:

- **Completion time** per work request, p50 and p95: from the request to the moment the user-facing session (Router or lead) has seen that all of the task's work, follow-ups included, is finished (its next model call after the report). Stopped requests are counted apart, with their **stop latency** (request to the work actually stopping, or "too late" when it had already finished). Requests not finished when the run ends are counted as unfinished, never dropped.
- **Acknowledgement latency** p50/p95: from any user message to the first user-facing output after it.
- **Router decisions**: events the Router took in its turns (Crew's `Chat.router.decided`), Router turns and Router model calls; events that went straight to Workers (`direct`); for (c)/(d) the lead's turns and calls.
- **Tokens (estimated)**, per role: **injected** (new text put into a context: system prompts, prompts, tool results, deliveries), **context read** (the context length summed over every model call: the cached-read analogue), and output.
- **Router batch size vs arrival rate**: per Router turn, the batch size and the Router-bound arrival rate in the preceding window; and, across a sweep of time scales (reduced mode skips the sweep), each run's mean batch size and decisions per Router call against its mean arrival rate.

The result also holds the options, the seed, the workload's composition and every assumption, so a JSON file is enough to reproduce its numbers.

### Running it

- `npm run bench` runs the full workload and the sweep and writes `bench-results/bench.json` and `bench-results/report.html` (`--out`, `--seed`, `--messages`, `--requests`, `--time-scale`, `--configs`, `--no-sweep`).
- `npm run bench -- --reduced` runs a 60-event workload with 5 requests and no sweep, in well under a second; `tests/integration/bench.test.ts` runs the CLI in that mode.
- The report is one HTML file with inline SVG charts and no script or external resource.

## Fit with existing modules

- New code only lives in `server/bench/` and `scripts/bench.ts`. It imports pure modules: `triggers/fastPath`, `layers/{batch,gates,prompts,subscriptions,config}`, `jobs/gates`, `recall/spill`, `untrusted`. None of them reads settings or the store; nothing imports `server/config.ts`, so the bench starts no server, writes nothing under `CREW_HOME` and makes no network call unless `httpClient` is used.
- `package.json` gets one script (`bench`), `tsconfig.json` includes `scripts/`, `.gitignore` ignores `bench-results/`. No dependency is added.
- The bench does not change any runtime behaviour. It is a model of Crew's scheduling built from Crew's rules, so a change to those rules (a gate, the fast path, the batch prompt) changes the bench's numbers.

## What is left out

- **Coding ability and correctness.** Work only consumes time; a task is "done" when its time is used up. CI failures never create work and Workers ignore them, so the bench measures what routing costs, not whether direct routing catches more bugs.
- **The real orchestrator.** `RouterSession`, `layers/workers.ts` and `orchestrator/index.ts` are stateful and tied to the store, git and Claude Code processes; the bench re-implements their scheduling (one turn at a time, batches, delivery between steps, landing after a turn) on top of the pure parts. Worktrees, merges and conflicts take no time and never fail.
- **The Watchdog, recall, the model gateway and lifecycle skills**: off in every configuration.
- **Real model latency and token counts.** Both come from a stated linear model and a 4-characters-per-token estimate; the bench compares configurations with each other, not with a bill.
- **Per-task threads.** Crew subscribes every Worker to the chat's one workspace thread, so a CI result reaches every active Worker, not only the one on that branch. The bench keeps Crew's behaviour (and its token cost); the essay's per-thread routing would cost Workers less.

## Risks

- **Scripted policies flatter or hurt a configuration.** A real model is less tidy: it may reply more, dispatch less or forget a queued task. The policies are short, read only what the request holds, and are tested; their choices are listed above, so a reader can judge them.
- **Drift from Crew.** The re-implemented scheduling can drift from the orchestrator over time. The pure rules are imported, not copied, so the routing decisions cannot drift; the scheduling around them is small and documented here.
- **Assumed constants decide the outcome.** Step length, filler size and latency constants move the absolute numbers. They are options, recorded in every result, and the sweep shows how the Router's batching depends on load instead of reporting one point.
- **Determinism.** Everything runs on the virtual clock with a seeded generator and counter-based ids; the HTTP client serialises calls so their order is fixed. A test checks two runs and the HTTP run produce identical results.
