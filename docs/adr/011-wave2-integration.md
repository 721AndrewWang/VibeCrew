# ADR 011: Integration notes: wiring the second wave together

Status: accepted (integration of ADRs 008, 101, 102, 103, 104 and 105 on top of ADR 010)

## Context

After the first integration (ADR 010), six branches were built in parallel from the same base, each with its own ADR:

| Branch | ADR | What it added |
| --- | --- | --- |
| `superagent-hardening` | [105](105-hardening.md) | The whole flow tested as one system; recovery after a crash (Router redo, orphan commands, the Watchdog's cut-off ticks, no duplicate restarts) |
| `superagent-security` | [104](104-injection-hardening.md) | Hardening against a compromised model: the agent fence, the key broker, the hardened guard, sandbox paths, hook-free drafts, redaction |
| `superagent-m8-speculative` | [008](008-speculative.md) | Speculative execution: silent reproduce-and-fix runs verified by the project's checks |
| `superagent-channels` | [103](103-channel-norms.md) | Channel norms: the chat profile, Details, draft profiles, the Router's webhook |
| `superagent-github-channel` | [102](102-github-channel.md) | GitHub as an asynchronous channel: polling, per-issue Threads, `draft_github`, `review-reply` |
| `superagent-bench` | [101](101-ablation-bench.md) | The offline ablation bench |

They were merged in that order (`git merge --no-ff`), and the full suite passed after each merge. Each branch was tested with the others absent, so every place where two of them meet was wired only as far as the later one happened to know about the earlier one, which was not at all. This ADR lists those places, how each is wired now and where it is tested.

## Merge conflicts and how they were resolved

| Merge | Conflict | Resolution |
| --- | --- | --- |
| security | none | |
| speculative | `layers/workers.ts`: hardening and security ran a Worker's setup command with the credential-free environment inline; speculation moved that code into `prepare()` | `prepare()` passes `agentEnvOptions(ws)`, so ordinary and speculative Workers both get it |
| channels | `agents/crewTools.ts` `draft_external_action`: speculation withholds the tool from speculative runs; channels added the profiles' guide to its description | both: no tool for speculative runs, the guide for everyone else |
| channels | `Message.tsx` imports, `chat.css` | both renderers and both style blocks |
| github | `TriggerSource` and its three label tables, the fast path | `speculative` and `github` both added; both are settled in code and excluded from `FilteredSource` |
| github | `RouterEvent` | restart's `resumed` and GitHub's `thread`/`github` on one type |
| github | `draft_external_action` | the above plus `review-reply` and its `comment` field |
| github | the demo Router | prompt tags stripped from what it quotes (channels) and GitHub drafts (github) |
| github | `server/index.ts` imports, the project settings form, the Triggers view | all of both |
| every merge | `ARCHITECTURE.md`, `README.md`, `CHANGELOG.md` | both kept at merge time; then rewritten as one text (below) |

One semantic conflict had no textual one: `review-reply` (GitHub) is a draft kind the channel profiles did not know, so it escaped them, and `draft_github` assembled its body without going through them at all. Fixed right after the merge (commit "Shape GitHub drafts and review replies with the channel profiles").

## Decision

Wire each seam in code, test it end to end with the demo agent and the mock model harness, and keep every addition behind the switches that already exist: **no new setting, no migration** (the new record fields are optional).

| Seam | What changed | Where | Test |
| --- | --- | --- | --- |
| Speculation × security (ADR 008 × 104) | A run's session already shared the Worker's deny hook, so the hardened guard, the agent fence and the brokered environment applied; now proven against the real CLI. Its verification checks get the hardened sandbox policy for their worktree (`sandboxOptions(…, ws.path)`; they had none), its setup command the stripped environment (merge), and the ledger (`speculative/runs.jsonl`) is redacted like every other sink (check output can print a secret). | `speculative/index.ts` (`checkEnv`, `record`), `layers/workers.ts` (`prepare`) | `wave2-seams.test.ts`: real Claude Code, a compromised mock model: a push, a credential read after `cd`, a `curl` to Crew's API and a hook planted in the main repository's shared hooks folder are refused by their rules and audited under the run's Worker; the run's environment holds the broker's token, no key, not the user's `GITHUB_TOKEN`; the signal arrived inside `<untrusted source="the user's description">`. Demo mode: both check runs dump an environment without the user's token; a settings secret the check printed is `[redacted]` in the ledger and the API |
| GitHub × speculation (ADR 102 × 008) | A failing check run is a `failing-check` signal (`signalOf` source `github`: conclusion `failure` or `timed_out`). Triggers keep their GitHub facts (`Trigger.github`). The run starts from the pull request's head commit (`createSpeculativeWorkspace(…, at)`), refused with a reason when that commit is not in the local repository. Its prompt labels the signal `<untrusted source="github">`. | `speculative/rules.ts`, `speculative/index.ts`, `speculative/prompts.ts`, `workspaces/create.ts`, `github/poller.ts`, `triggers/index.ts` | `wave2-seams.test.ts` (fake `gh`): the run's base is the head; unit: signals, the head gate, the label |
| Speculation × channels × GitHub (ADR 008 × 103 × 102) | A verified fix surfaces in each channel's format: the chat card (as before); an environment event naming the pull request (`thread`, `github`) that the Router answers as an **acceptance** reply (prompt line; the demo Router does), which an approved webhook carries; and, for a GitHub check, a `pr-comment` draft built by code from facts in the comment profile (Background, Change, Verification; the run's model-written summary dropped if it does not fit), discarded with the fix without a chat note. | `speculative/index.ts` (`githubComment`, `draftForGithub`), `layers/prompts.ts`, `drafts.ts` (`discardDraft(id, byCrew)`), demo Router | `wave2-seams.test.ts`: card, Router batch, acceptance reply ≤100 words, exactly one webhook delivery, the draft's command and body, the poller only ever ran `gh api` GETs, discarding the fix discards the draft quietly |
| Drafts × channels (ADR 102 × 103) | `review-reply` is a `comment`; `draft_github`'s body is checked and shaped by the profiles. | `channels/profiles.ts`, `github/router.ts` | unit `wave2-seams.test.ts`; `github-channel.test.ts` still passes |
| Speculation × restart (ADR 008 × 105) | `routerRedo` ignores speculative Workers: before, a run cut off by a restart (or a ready one) carried a report the Router was handed as `unread`, and its `related` ids could hide a lost user message. The Watchdog's `restartConflict` refuses a speculative run. A check command Crew runs records its process group (`Speculation.checking`); on start it is stopped (`reapOrphan`, then waited for) before the run's worktree is removed. The same signal is not speculated on again (its fingerprint). | `layers/recovery.ts`, `watchdog/duplicates.ts`, `speculative/verify.ts` (`onStart`/`onEnd`), `speculative/index.ts` (`recoverSpeculations`), `jobs/orphans.ts` (`groupGone`) | `wave2-seams.test.ts`: killed while a check sleeps; after the restart the run is discarded with "its check command was still running and was stopped", the command never finishes its late write, no branch is left, no Router turn takes the run's id, one run per head; unit: `routerRedo`, `restartConflict` |
| GitHub × restart (ADR 102 × 105) | The poller saved its cursor 300 ms after publishing (a debounced write): a crash in between published the same events again. It now skips events whose key is already in the Trigger log (`Trigger.github.key`) and flushes the cursor after each repository. A GitHub-channel Worker cut off by a restart is stopped and its Router told once (ADR 105, unchanged); its issue's later events are no longer delivered straight to it. A Router turn re-handed after a restart that drafts the same thing again gets the pending draft back instead of a second card (`createDraft`). | `github/poller.ts`, `drafts.ts` | `wave2-seams.test.ts`: the cursor rolled back to before the poll, then a poll publishes nothing twice; a Worker on `acme/shop#12` killed mid-turn is stopped, its Router told in exactly one turn, nothing dispatched twice for the message, the issue's next comment not `subscribed`; the same draft made twice is one card |
| Watchdog × speculation (ADR 006 × 008) | Speculative runs are in the snapshot (`speculative="true"`), flagged only when stuck or looping (a failed one is Crew's to discard), with a `<speculative>` line of runs in flight and today's spend against their budget. The Watchdog may stop one (quietly: the run is discarded with "The Watchdog stopped it: …"), never nudge, redirect or restart it, and its prompt says never to mention one in a chat. `WatchdogInfo.speculative` puts their daily spend next to the Watchdog's own on its page. | `watchdog/index.ts`, `watchdog/snapshot.ts`, `watchdog/tools.ts`, `watchdog/prompts.ts`, `speculative/spend.ts`, `layers/workers.ts` (`Live.why`), `WatchdogView.tsx`, demo Watchdog | `wave2-seams.test.ts` (test clock): a stuck run is flagged and stopped with no note and no chat message; `GET /watchdog` shows the spend; unit: flags, rendering, the tools' refusals |
| Model routing × speculation (ADR 009 × 008) | Already wired by the speculative branch: the run's session goes out under the gateway's `speculative` role and its checks' helper sessions too. | none | `speculative.test.ts` (real Claude Code, a gateway with a `speculative` route) |
| Bench × wave 2 (ADR 101) | `--arms speculative,github,no-channels` (or `all`) runs (a) again with one feature switched each, through the same pure rules: failing CI as a speculative signal (`signalOf`, `gateRefusal`, a `speculative` session, verification time, the Router's acceptance reply); CI as GitHub check events on each task's pull request thread (`screenGithub`, the `github` fast path, Workers subscribed to their task's thread); the Router without channel norms (the word cap alone, no kinds or Details, reports relayed). Off by default. Since Crew now always applies the chat profile, (a) and (b) run with it, so their reply kinds show up in the requests. | `bench/sim.ts`, `bench/policies.ts`, `bench/index.ts`, `bench/metrics.ts`, `bench/report.ts`, `bench/cli.ts` | `bench.test.ts` (unit: each arm's effect, determinism, the CLI flag; integration: the CLI with `--arms all`, and the speculative arm over HTTP equal to in-process) |
| Everything off (all) | No change needed; the test now covers the second wave: a `gh` on PATH that logs every call is never run, no project polls, no webhook is set, no reply carries a channel shape, a bug report starts no run, no `github/` or `speculative/` folder appears, a restart logs nothing from those modules, and the real CLI is never offered `speculative_result`. | none | `super-agent-off.test.ts` |

What the reduced bench shows with the arms (seed 7, 60 events): of 4 failing CI results, speculation started 1 run and skipped 3 because Workers subscribed to the folder already had them; the GitHub arm delivered failing checks only to the Workers on the task's pull request and passed checks only to them (`check-passed`); without channel norms the Router's replies grew from 114 to 198 words in all and no report went under Details.

The demo agent learned what the tests need: the demo Router answers a speculative fix as an acceptance request, and the demo Watchdog stops a speculative run without a redirect.

## What did not change

- No new setting and no migration. `Trigger.github`, `Speculation.github`, `.draftId`, `.checking` and `WatchdogInfo.speculative` are optional.
- A GitHub event is still never explicit: it can start a speculative run (fixed rules, a project's opt-in, as a console error can), never a Worker through the Router.
- Speculative runs still cannot reach the user, draft or ask; the pull request comment is drafted by Crew from verified facts, and posts only on the user's click.
- The Watchdog still cannot start work; for a speculative run it can do less than for any other Worker.

## Deferred

- **Speculation from other GitHub events.** Only failing check runs are signals; an issue that describes a bug is not (its author is outside, and the bug-report signal is meant for the user's own words).
- **Fetching a pull request's head.** When the head commit is not local, the run is skipped with that reason; Crew does not fetch for it (a fetch is a network action on the user's behalf).
- **Pushing a speculative fix to the pull request.** The fix merges into the local folder; the drafted comment says it is not pushed. A push draft for the pull request's branch could follow.
- **Recall of `sp_…` ids** (ADR 008 left it out): the Router's event names the `speculative` Trigger, and the Watchdog reads a run through its Worker.
- **The Watchdog's view of speculative checks.** It sees the run's session, not the verification commands (those have their own 10-minute limit).
- **Sandboxed speculative checks across a crash.** With the sandbox on, the check runs inside a helper Claude Code session; as for sandboxed background jobs (ADR 105), whether that process survives is Claude Code's, and Crew has no process id to stop.
- **Speculative spend in the gateway's windows.** The run's model calls count in the gateway's `speculative` windows; its daily budget is still Crew's own estimate from its sessions' cost.
- **The bench's channel arm** measures shape (reply words, Details, refusals) with a scripted Router that writes short replies anyway; how much a real model's replies grow without the norms is not something a scripted model can show.
- **Browser tests** of the Speculative fixes bar with a GitHub draft and of the Watchdog page's second meter; the integration tests drive the same APIs.

## Risks

- **A failing check from someone else's pull request starts work on this machine.** Bounded as every speculative run is (the project's opt-in and the failing-checks switch, the head must already be local, concurrency, the daily budget, a throwaway worktree, no credentials, unattended), and GitHub's text is untrusted data in the run's prompt.
- **A drafted comment on every verified fix** may be more than a team wants on its pull requests. It is a draft: discarding it costs one click, and discarding the fix discards it.
- **Skipping published keys** reads up to 2,000 recent Triggers per repository per poll; cheap at the poll interval, and bounded by the Trigger log's own limit.
- **The Watchdog seeing more Workers** could flag more ticks: speculative runs are flagged only when stuck or looping, which their own time limit (20 minutes) usually ends first.
