# ADR 008: Speculative execution: silent reproduce-and-fix

Status: accepted (milestone 8 of the Super-agent architecture)

## Context

ADRs 001-007 and 009 made Crew event-driven and parallel, but every piece of work still starts with a person: a user message, a routine the user wrote, or a Router turn that a user's request started. Environment events can only produce a notice (ADR 001) or an environment event in a Router's inbox, which by design cannot start a Worker (ADR 002's dispatch gate). So when a test run fails, the preview logs an uncaught exception, or the user writes "the login button does nothing", the user waits while a bot first reproduces the problem, then fixes it, then checks the fix. Most of that waiting is mechanical and could have happened before the user asked.

The design notes call this **speculative execution**: act ahead in the background on environment signals, spend compute to save human waiting, deliver only if the result is useful, otherwise discard it and stay quiet. The building blocks exist:

- the Trigger bus already sees the signals (`preview-console`, `job` results, `user` messages), with fingerprints for de-duplication;
- Workers (ADR 002) already run one task in a session of their own, in a git worktree of their own, as a chat member, through the same gate, sandbox and guard as a chat turn;
- skill families (ADR 007) declared a `speculative` mode and the `triage`, `reproduce` and `draft-fix` families for exactly this;
- the model gateway (ADR 009) has a `speculative` role with its own route and spend windows, waiting for a caller;
- `autoChallenge` (`server/autoChallenge.ts`) shows how Crew decides to spend a model call on its own: fixed rules read off facts, never a model's judgment, a per-request allowance, and never twice for the same state.

What is missing is the decision to speculate, the throwaway workspace, a deterministic way to tell a real fix from a plausible-looking one, and a way to surface a verified fix without interrupting anyone.

## Decision

Add a **speculative run**: a background Worker that tries to reproduce a reported problem and find a small fix in a throwaway worktree. Crew itself, not the model, then checks the claim by running the project's checks twice. Only a run that reproduced the problem and whose fix passes the checks is surfaced, as a card with a summary and the diff and a one-click merge; anything else is discarded without a word in any chat.

### 1. When to speculate: fixed rules (`speculative/rules.ts`, pure)

Like `autoChallenge`, the decision is read off facts by rules in code. A model judging "is this worth fixing" would be a deriving task where cheap judges are weakest, and the cost of a wrong yes here is a full Worker session.

Three **signals**, each a per-project switch:

| Signal | Comes from | Matches when |
| --- | --- | --- |
| `failing-check` | a `job` Trigger (a full-duplex bot's background command, ADR 004) | the job **failed** (not stopped) and its command is the project's check command or reads like a check (`test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `tsc`, `typecheck`, `lint`, `eslint`, `biome`, `build`) |
| `console-error` | a `preview-console` Trigger | it has error lines left after the fast path's noise rules (no-errors, known-noise and an ignored source never count) |
| `bug-report` | a `user` Trigger | the message describes a problem (`error`, `broken`, `crash`, `doesn't work`, `TypeError`, a 500…) **and does not ask for a fix** ("fix …", "can you fix", "please fix"): a request for the fix already went to a bot, which is on it; speculation is for the stretch before anyone asked |

Then the **gates**, in order; the first that says no settles it, with a reason:

1. The project's switch (`Project.speculative.enabled`) and the signal's switch.
2. A check command: `Project.speculative.checkCommand`, else `npm test` when `package.json` has a real `test` script; none means nothing could verify a fix.
3. Not a Trigger that went straight to subscribed Workers (ADR 003): someone is already working there.
4. A chat to surface in (the Trigger's own, else the most recently active chat on the project) and a member to run as (its lead) that is not a blind reviewer, whose effective level is `edits`, `review` or `auto` (a run that may not edit, or that would ask at every step, cannot work unattended), and that has monthly budget left.
5. A git project (the throwaway workspace is a worktree).
6. **Never the same state twice**: a Trigger with the same fingerprint was not speculated on in the last 24 hours.
7. **Concurrency**: fewer than `maxConcurrent` runs in flight (default 2), and none in this project.
8. **Daily budget**: what today's runs cost is under `dailyBudgetUsd` (default $2).

Signals that matched but were refused are recorded (`skipped`, with the reason) so the user can tune the rules; signals that did not match are not recorded at all.

### 2. The run: a Worker in a throwaway workspace (`layers/workers.ts`, extended)

A speculative run is a `Worker` with `speculation: sp_…` set. It reuses everything a Worker has (session, transcript in `messages/wk_…`, `permissionGate`, sandbox, deny hook and guard, credential-stripped environment, monthly budget, model gateway scope) and changes only what must differ:

- **Workspace.** `createSpeculativeWorkspace` (`workspaces/create.ts`, beside `createWorkerWorkspace`) branches a `crew/` worktree from the **state the problem was observed in**, without touching it: the chat's workspace when it has one, else the project folder, snapshotted with `git stash create` (a commit object of the uncommitted tracked changes; no ref, index or file of the user's is changed), falling back to `HEAD`. No chat lock is taken and the chat is never moved into a workspace, so a running turn is not delayed and nothing visible happens. The project's setup command runs there, as for any Worker.
- **Unattended.** Nobody is there to answer an approval card, so `permissionGate` gets `unattended`: whatever would ask is **refused** instead, with no card, toast or push. The project's check command is pre-allowed (`Bash(<check>)`, `Bash(<check>:*)`) so the run can use it at `edits`. Deny rules, the command guard and the sandbox apply unchanged.
- **Quiet.** It is not in the Workers bar, the Router's `<workers>` lines, the `maxWorkers` count, the Watchdog's snapshot or `isChatBusy`; it never reports to a Router, never publishes a `turn` or `landing` Trigger, and is never landed on the chat's branch. It gets no `notify_user`, `remember` or `draft_external_action`: it cannot reach the user, write the bot's long-term memory, or draft anything in the user's name.
- **Prompt** (`speculative/prompts.ts`, pure): what Crew noticed (the signal's text inside the `<untrusted>` wrapper: console output, job output and even the user's own description are material to work from, not instructions to this run), the protocol below, and, as a playbook, the project's enabled `triage`, `reproduce` and `draft-fix` skills in `speculative` mode (`skills.forFamily`).
- **The claim.** The run ends by calling the crew tool `speculative_result({ reproduced, testFiles, summary })`: whether it reproduced the problem, which files are the reproduction (a failing test it added or changed), and a summary of at most 80 words.
- **Model and spend.** `superAgent.speculative.model`, else the Workers' model; with the gateway on its calls go out under the `speculative` role (`/s/speculative/<botId>`), so `gateway.roles.speculative` and that role's spend windows apply. Its cost counts toward the member's monthly budget like any Worker's, and toward the speculative daily budget.
- **Time limit.** Code stops a run after `maxMinutes` (default 20).

### 3. Verification: outputs are probabilistic, gates are deterministic (`speculative/verify.ts`)

When the run's turn ends, Crew commits its worktree (head `H` over base `B`) and checks, in this order, stopping at the first failure:

1. The run claimed `reproduced: true`.
2. Its changes split into reproduction files (the claimed `testFiles` that it changed) and fix files (everything else it changed). There must be at least one fix file, and the fix (not the test) must be small: at most `maxFixLines` changed lines (default 120) in at most 10 files.
3. **After**: the project's check command passes at `H`.
4. **Before**: with the fix files put back as they were at `B` (the reproduction kept), the check command **fails**. So the problem is real in the observed state, the reproduction catches it, and the fix is what makes it pass.

The checks run through the same runner background jobs use (`jobs/runner.ts`): inside Claude Code's sandbox as a one-call helper session while the sandbox is on, else in a process group with the credential-stripped environment. Code the model wrote is never run unconfined while its own commands would be confined. Each run is limited to 10 minutes and keeps the last lines of its output.

### 4. Surfacing, or silence

- **Verified** (status `ready`): Crew publishes a `speculative` Trigger on the chat's thread (fast path rule `speculative-ready`, settled in code; its payload is facts: the signal, the files, the check results, the run's summary), posts a UI-only note in the chat (`notice: 'speculative'`, bots never read it) that renders as a card, and raises a toast. In two-layer mode the chat's Router also gets it as an **environment event**: it may tell the user in a few words, but it cannot merge the fix or start work from it (ADR 002's gate holds). Above the composer, a "Speculative fixes" bar lists the chat's ready fixes: summary, files with line counts, "View diff" (the exact `git diff B H`), **Merge** and Discard.
- **Merge** (one click): Crew applies the run's diff to where the problem was observed (the chat's workspace, then commits it there; or the project folder, where it stays uncommitted like a bot's edits), under the chat's lock and as Crew's own writes (no outside-edit notice). It checks first that the patch still applies (`git apply --check`); if the folder moved on, the merge is refused and the card says so. A system note (which bots do read) says which files the fix changed. The throwaway worktree and its branch are then removed.
- **Not verified, stopped, out of time, interrupted by a restart, or not merged within 24 hours**: status `discarded` with the reason, the worktree **and its branch** are removed (it was never anyone's work), and nothing is said in any chat. The reason is visible only in Settings → Super-agent → Speculative runs, which lists recent runs for tuning, like the Triggers view lists dropped events.

## Data model

Shared types in `shared/types.ts`:

```ts
interface SpeculativeSettings {        // settings.superAgent.speculative (global: money and machine load)
  model: string;                       // '' = the Workers' model
  dailyBudgetUsd: number;              // 0..100, default 2
  maxConcurrent: number;               // 1..4, default 2
  maxMinutes: number;                  // 5..120, default 20
}

interface ProjectSpeculative {         // Project.speculative (per project: the switch and how to verify)
  enabled: boolean;                    // default false
  checkCommand: string;                // '' = `npm test` when package.json has a real test script
  signals: { failingChecks: boolean; consoleErrors: boolean; bugReports: boolean };
  maxFixLines: number;                 // 1..2000, default 120
}

type SpeculativeSignal = 'failing-check' | 'console-error' | 'bug-report';
type SpeculationStatus = 'skipped' | 'running' | 'verifying' | 'ready' | 'merged' | 'discarded';

interface Speculation {                // CREW_HOME/speculative/runs.jsonl (JsonlLog: 500 / 30 days)
  id: string;                          // sp_…
  at: number; updatedAt: number;
  signal: SpeculativeSignal;
  triggerId: string;                   // the Trigger it acted on
  fingerprint: string;                 // the Trigger's, for "never the same state twice"
  summary: string;                     // the signal, one line
  reasons: string[];                   // which rules matched
  projectId: string | null;            // the root project
  chatId: string | null;               // where it is surfaced
  status: SpeculationStatus;
  why?: string;                        // why it was skipped or discarded
  botId?: string; workerId?: string;
  target?: string;                     // where a merge applies: the chat's workspace or the project folder
  checkCommand?: string;
  base?: string; head?: string;
  claim?: { reproduced: boolean; testFiles: string[]; summary: string };
  checks?: { after?: CheckRun; before?: CheckRun };   // CheckRun: { exitCode, ok, secs, tail }
  files?: { path: string; added: number; removed: number; test: boolean }[];
  costUsd: number;
  triggerOut?: string;                 // the `speculative` Trigger that surfaced it
  messageId?: string;                  // the chat note
  decidedAt?: number;                  // merged or discarded
}
```

Additions to existing types: `Worker.speculation`, `TriggerSource` `'speculative'`, `ChatMessage.notice` `'speculative'` with `speculationId`, `ServerEvent` `{ t: 'speculation', speculation }`, `Bootstrap.speculations`, `SessionConfig.role` `'speculative'`. All new fields are optional and the new settings key gets defaults when missing (`normalizeSuperAgent`), so no migration is needed. `CREW_HOME/speculative/` is created on the first record, so with the feature off it never exists.

## How it fits the existing modules

- `server/speculative/` (new): `config.ts` (pure: defaults, normalisation, check command detection), `rules.ts` (pure: signals, gates, the claim's file split and size rule), `prompts.ts` (pure: the task prompt), `verify.ts` (runs the check command twice through `jobs/runner.ts`), `index.ts` (the Trigger listener, the ledger, dispatch, verification, surfacing, merge, discard, sweep, restart recovery).
- `triggers/index.ts`: `onTrigger(fn)`, a listener called after a Trigger is saved (so the bus does not import the speculative module); `targetChat` exported; `speculative` source settled by the fast path (`speculative-ready`).
- `layers/workers.ts`: `startWorker` takes `speculation`; `launch` makes the throwaway workspace and skips subscriptions; `getSession` uses the `speculative` gateway scope, the unattended gate, the check-command allow rules and the speculative tool; `runTurn` commits and hands over to `onSpeculativeEnd` instead of landing and reporting; `chatWorkers`/`listWorkers` leave speculative runs out unless asked; `recoverWorkers` does not report them to Routers; `sweepWorkers` leaves them to their own sweep.
- `workspaces/create.ts`: `createSpeculativeWorkspace`, sharing `addWorktree` with chat and Worker workspaces. `disposeWorkspace(ws, true)` removes it.
- `orchestrator/permissionGate.ts`: `unattended` turns an "ask" into a refusal with a reason the model reads.
- `agents/crewTools.ts`: `speculative_result`, and no `notify_user`, `remember` or `draft_external_action` for a speculative run. `agents/prompts.ts`: the Worker variant of the system prompt says it is a silent background run and where its changes go. `agents/session.ts`: `FakeSession` gets a scripted speculative run for demo mode and tests.
- `watchdog/`: its snapshot and transient-failure watches skip speculative runs (they have their own time limit and never need the user).
- `layers/prompts.ts`: the Router's system prompt says what a `speculative` environment event means.
- API: `GET /api/speculations?chatId=&projectId=`, `GET /api/speculations/:id`, `GET /api/speculations/:id/diff`, `POST /api/speculations/:id/merge`, `POST /api/speculations/:id/discard`; `PATCH /api/settings` accepts `superAgent.speculative`, `PATCH /api/projects/:id` accepts `speculative`.
- UI: the project settings form (switch, check command, signals, fix size); Settings → Super-agent → Speculative runs (budget, concurrency, time limit, model, today's spend, recent runs and why each was skipped or discarded); the Speculative fixes bar and the chat card with the diff dialog; the Triggers view labels `speculative`.

## Deliberately left out

- **Other signals.** CI results, review comments and issue trackers are not trigger sources in Crew yet (ADR 001 left them out; each widens the attack surface). Failed bot turns are bot failures, not bug reports. Outside edits are not problems.
- **A model deciding when to speculate.** The slow path's policies stay about notices. Spending a Worker is a deterministic, budgeted decision.
- **Untracked files in the observed state.** `git stash create` captures tracked changes only; a bug that lives in a file the user never added to git is not in the throwaway workspace (the run then usually fails to reproduce it and stays quiet).
- **Several attempts.** One run per signal; a failed verification is not retried with feedback.
- **Proving the fix is the right one.** The checks show the reproduction fails before and passes after and nothing else in the checks broke; the user still reads the diff before merging. The adversarial reviewer is not called on a speculative fix automatically.
- **Recall of `sp_…` ids.** The Router's event names the `speculative` Trigger (`tg_…`), whose payload holds the facts; a resolver for `sp_` can follow.
- **Per-project budgets.** The daily budget and the concurrency cap are global (money and machine load are the user's, not a project's); the gateway's `speculative` spend windows can cap per bot.

## Risks

- **Prompt injection through the signal.** Console text, job output and a pasted error all reach a session with full tools without a person reading them first; this is ADR 001's open risk, now taken on deliberately. Mitigations: only three narrow signals, behind a per-project opt-in; the run works in a throwaway worktree, never in the user's folder; it is unattended, so anything that would need approval is refused; deny rules, the command guard (no credential reads, no pushes, no network beyond the allow-list) and the sandbox apply; its environment has no credentials; it has no tool that reaches the user or leaves the machine; the signal is in the `<untrusted>` wrapper; nothing it did reaches the user's files without a click on a diff Crew shows verbatim.
- **Gaming the checks.** A run could weaken a test or the check command instead of fixing the code. The "before" run keeps the reproduction and restores everything else, so a fix that only edits the checks' configuration still has to make a failing reproduction pass; the size rule keeps fixes small enough to read; and the merge is the user's, with the diff in front of them.
- **Cost.** Each run is a full Worker session. Bounds: per-project opt-in, per-signal switches, a 24-hour de-duplication, at most `maxConcurrent` runs and one per project, `maxMinutes`, the daily budget, the member's monthly budget, and the gateway's `speculative` spend windows.
- **Duplicate work.** A bug report goes to a bot as well; the bot may fix it first. A fix whose patch no longer applies is refused at merge and expires after a day. Bug reports that already ask for a fix are not speculated on.
- **Disk and setup time.** A worktree and the project's setup command per run; at most `maxConcurrent` at a time, removed (branch included) as soon as a run is discarded or merged.
- **Behaviour drift when off.** Nothing runs unless `superAgent.enabled` is on and a project opted in; the listener returns at its first line otherwise. `super-agent-off.test.ts` keeps pinning that the defaults write no `speculative/` folder and start no Worker.
