# ADR 108: Cost and latency of the Super-agent mode

Status: accepted (polish of the Super-agent mode, on top of ADR 011)

## Context

The Super-agent mode (ADRs 001-011, 101-105) was built for behaviour first. Nobody had measured what its model calls cost per role: how many calls the Router, the Workers, the Watchdog, recall and speculation make on a realistic stream, how big each prompt is, and which part of it repeats on every call. The ablation bench (ADR 101) counted tokens, but with stand-in system prompts for every session that runs on Claude Code, a flat guess for the tool definitions, and the Watchdog and recall off.

The brief: measure first, keep the measurement rerunnable, then cut tokens and latency without changing what the system does, and report before/after numbers per role.

## Measuring: `npm run bench:cost`

`scripts/cost.ts` (with `scripts/costInputs.ts`) and `server/bench/cost.ts`:

- **Static text, real.** For each role it builds what Crew sends besides the conversation with Crew's own code: the Router's system prompt and its MCP tool definitions, a Worker's system prompt (`buildSystemAppend`) and the crew tools, the same for a speculative run, the Watchdog's prompt and tools, and the slow path's fixed prompt with the default policies. Tool definitions are read the way Claude Code reads them: the in-process MCP server is connected over an in-memory transport and `listTools()` is serialised as `{ name, description, input_schema }`. The builders import the store, so the script runs them against a throwaway `CREW_HOME` it removes at the end.
- **Calls and context, on the bench.** The bench's scenarios run with that real text in place of its stand-ins (new opt-in `SimOptions.systemPrompts`, and `harnessTokens` set to the real tool definitions plus the bench's 8,000-token assumption for Claude Code's own prompt): (a) Super-agent, (b) no direct routing, (a) + speculative runs, (a) + GitHub channel, and (a) + chain of recall (new opt-in `SimOptions.recall`). The scripted model is the mock provider's policy, called in process (the bench's integration test already pins in-process and HTTP runs as equal).
- **The Watchdog** is replayed over each run's Worker timeline (new opt-in `SimOptions.timeline`): every 15 minutes, the Workers its snapshot would show (active, or ended since the last tick) go through its real fast path (`snapshotFlags`, `isQuiet`). A flagged tick costs one call; its size is measured on a flagged snapshot at the run's busiest moment (one active Worker made stuck). The bench's `work` tool repeats one call for many kinds of real work, so its repeats are not counted as looping.
- **Recall**: real `recallText` results for the run's Workers, its workspace thread and CI triggers, stored in the throwaway store, and the Router's injected text with the chain of recall on against off.
- **Per role** it reports calls, the static tokens of one call, injected tokens (new text added to a context), context read (the context summed over calls: the cached-read volume), output, the latency model's time (`RoleStats.modelMs`, new), and a cost estimate in input-token equivalents at Anthropic's price ratios (`costUnits`: cache write 1.25, cache read 0.1, output 5). `--compare <cost.json>` prints the change against an earlier result.

Tokens are Crew's `estimateTokens` (four characters per token); the numbers compare versions of Crew with each other, not with a bill.

### What it showed (seed 7, 300 events, before any change)

- **The Router's batches were mostly the `<workers>` list.** Of the ~85k tokens of conversation the Router took in on (a), ~70k (82%) were the list of Workers, re-sent on every turn: every Worker ever dispatched, finished ones included, each with the first line of its report and its thread titles.
- **Context re-read dominates the Router's cost** (12.5M tokens read against 104k injected on (a)), and is bounded by the session rotation at `rotateAtTokens` (60k): its mean prompt is set by that threshold more than by what each turn adds.
- **Each Router turn ends with a call that only writes a closing line** after `reply`: 517 calls for 232 turns.
- **Workers send ~2.5k tokens of crew tool definitions on every call**, about 2k more than Claude Code's own; the biggest were `draft_external_action` (617), `browser_act` (488), `preview_screenshot` (294) and `browser_debug_target` (269, useful only with the REA plugin). Their system prompt listed every tool again with a description.
- **The Watchdog never called its model on the bench**: 13 ticks, all "healthy" (the bench's Workers make progress every step). One flagged call would cost ~3.3k tokens.
- **The slow path** made 9 calls in (b) and 8 in the GitHub arm; in the GitHub arm all 8 were failing checks on pull requests, which the default GitHub policy line says to act on, word for word.

## Changes

| Change | Where | Effect |
| --- | --- | --- |
| Ended Workers listed briefly in the Router's batch: id, member, status, title. In full only in the turn their report arrives and on a new session's first turn (the recap); active Workers unchanged. | `layers/prompts.ts` (`workerLine`, `renderBatch`) | The largest cut: Router injected −36% on (a) |
| The Router's system prompt reordered: everything every Router reads first, the chat's name, role text, team, Worker limit and skill families last, so the common part is one cached prefix across chats and sessions. Lines that repeated the tools' own definitions (what `dispatch_worker`, `message_worker`, `stop_worker` and `list_workers` do) removed; `reply` and `dispatch_worker` descriptions no longer repeat the system prompt. | `layers/prompts.ts` (`routerSystemPrompt`), `layers/tools.ts` | Router static −7% |
| The bots' system prompt keeps only how to use each Crew tool well, not what it does (the definition says that). The workspace lines (directory, branch), which differ per Worker, move to the end: Workers of one bot share the prompt up to there. | `agents/prompts.ts` (`buildSystemAppend`) | Worker system −9% |
| Tool definitions trimmed: the `device` and `colorScheme` parameter texts (repeated in four tools), `preview_screenshot`, `browser_act`, `draft_external_action`; `browser_debug_target` only for a bot with a plugin or an MCP server that can attach to the page. `RECALL_PROMPT_LINE` no longer lists the id kinds `RECALL_TOOL` lists. | `agents/crewTools.ts`, `recall/spill.ts` | Worker tools −16%, speculative −22% |
| The note sent with every direct delivery to a Worker restates the rule in one line; its system prompt already explains events on its threads. | `layers/prompts.ts` (`deliveredNote`) | Worker injected −1% more |
| The Watchdog's snapshot shows a finished Worker flagged for nothing on one line (the rest behind `inspect`); stopped and failed Workers keep the full entry, since the Watchdog may restart them. | `watchdog/snapshot.ts` | A flagged call −11% |
| Recall of a Worker leads with its report: the task (the Router's own words) is a one-line reference, so the inline budget goes to the report the Router's event pointed it to. | `recall/graph.ts` (`workerNode`) | One Worker result −9% |
| **Standing rules**: a candidate whose outcome a default policy line states plainly is settled in code, without the cheap model. A failing check on a pull request and a changed dependency manifest or build config are acted on; a turn that failed on a passing network or provider error, and console errors that all come from extensions, ads or analytics, are dropped. Each rule holds only while the user's policies contain its line word for word; edit or remove the line and those events go to the model again. Anything a rule is unsure of (whether a turn failure needs the user, an ordinary file edit, an issue's text) stays a candidate. A standing decision comes after the cooldown and duplicate rules, takes no share of the hourly model budget, counts for the duplicate rule, and is delivered as a slow-path decision is (rule `standing-policy` in the Triggers view). | `triggers/standing.ts` (new), `triggers/fastPath.ts`, `triggers/index.ts`, `bench/sim.ts` | GitHub arm: slow-path calls 8 → 0 |

`DEFAULT_POLICIES` is now built from the standing rules' lines (`POLICY_LINES`); its text is unchanged, so no migration.

## Results

`npm run bench:cost` before (the first commit of this branch) and after. Seed 7, the default 300-event workload.

Static text of one call, estimated tokens:

| Role | System prompt | Tool definitions |
| --- | --- | --- |
| Router | 1,166 → 1,111 (−4.7%) | 794 → 704 (−11.3%) |
| Router, recall on | 1,252 → 1,197 (−4.4%) | 1,005 → 914 (−9.1%) |
| Worker | 1,129 → 1,036 (−8.2%) | 2,252 → 1,848 (−17.9%) |
| Worker, direct routing | 1,386 → 1,264 (−8.8%) | 2,498 → 2,094 (−16.2%) |
| Worker, recall on | 1,426 → 1,280 (−10.2%) | 2,531 → 2,127 (−16.0%) |
| Speculative run | 1,063 → 976 (−8.2%) | 1,769 → 1,372 (−22.4%) |
| Watchdog | 1,055 (=) | 977 (=) |
| Slow path | 496 (=) | none |

Per role and scenario (cost: input-token equivalents, see above):

| Scenario | Role | Calls | Injected | Context read | Cost | Model time (s) |
| --- | --- | --- | --- | --- | --- | --- |
| (a) Super-agent | Router | 517 = | 104,397 → 66,952 (−35.9%) | 12.52M → 12.35M (−1.3%) | 1.424M → 1.364M (−4.2%) | 463.0 → 456.6 |
| | Worker | 351 = | 357,950 → 344,483 (−3.8%) | 5.67M → 5.44M (−3.9%) | 1.009M → 0.971M (−3.7%) | 542.9 → 537.4 |
| (b) No direct routing | Router | 526 = | 80,223 → 58,614 (−26.9%) | 11.71M → 12.79M (+9.2%) | 1.316M → 1.399M (+6.3%) | 459.2 → 462.6 |
| | Worker | 351 = | 329,216 → 319,276 (−3.0%) | 5.24M → 5.07M (−3.3%) | 0.934M → 0.905M (−3.1%) | 531.7 → 527.6 |
| | Slow path | 9 = | 1,523 = | 1,523 = | 2,754 = | 3.3 = |
| (a) + speculative | Router | 521 = | 105,252 → 67,617 (−35.8%) | 12.68M → 12.42M (−2.1%) | 1.442M → 1.372M (−4.8%) | 467.0 → 460.0 |
| | Speculative | 8 = | 25,067 → 24,085 (−3.9%) | 98,432 → 94,504 (−4.0%) | 39,530 → 38,008 (−3.9%) | 16.9 → 16.6 |
| (a) + GitHub channel | Router | 525 = | 131,223 → 76,509 (−41.7%) | 12.88M → 12.53M (−2.8%) | 1.492M → 1.393M (−6.6%) | 473.1 → 463.1 |
| | Worker | 351 = | 350,916 → 338,511 (−3.5%) | 5.58M → 5.37M (−3.7%) | 0.992M → 0.957M (−3.5%) | 540.3 → 535.2 |
| | Slow path | 8 → 0 | 1,370 → 0 | 1,370 → 0 | 2,473 → 0 | 2.9 → 0 |
| (a) + recall | Router | 517 = | 104,994 → 67,557 (−35.7%) | 12.64M → 12.41M (−1.8%) | 1.437M → 1.371M (−4.6%) | 463.8 → 457.1 |
| | Worker | 351 = | 359,410 → 345,463 (−3.9%) | 5.69M → 5.46M (−4.0%) | 1.013M → 0.974M (−3.9%) | 543.5 → 537.8 |

- **Watchdog**: 13 ticks per scenario, all settled by its fast path before and after (0 model calls). One flagged call: 3,262 → 2,914 tokens (−10.7%).
- **Recall**: one Worker result 99 → 90 tokens; a thread 199 and a CI trigger 227, unchanged. With the chain of recall on, the Router injects 67,557 tokens against 66,952 off: the handles cost ~1% more text and are paid back only by recall calls a scripted model never makes.

**Quality.** On seed 7, every bench quality metric is equal in every configuration and arm (`npm run bench -- --arms all`): requests completed, stopped and unfinished, completion p50/p95/mean/max, Router decisions, reply words and reports under Details. Acknowledgement p50 improves (1.2 → 1.1 s on (a)); acknowledgement p95 moves by about ±0.1 s (2.53 → 2.64 s on (a), 2.69 → 2.53 s on (b)); stop latency is equal or better. Across seeds 1-8 the mean of ack p95 is 2.590 → 2.579 s on (a), 2.621 → 2.530 s on (b) and 2.603 → 2.619 s on the GitHub arm; completion p95 and completed counts are equal on every seed, and one seed's completion p50 moves by 0.1 minute. On a three-times longer workload (900 events, 60 requests) ack p95 improves on every configuration (2.89 → 2.79 s on (a)) and the Router's context read falls 3-4%.

**Why (b)'s Router context read rises.** The Router rotates its session at a fixed context size, so its cached re-reads are set by that threshold: the mean prompt is roughly half of it whatever each turn adds. Smaller batches make the session grow more slowly, so on this 3-hour run its one rotation comes later, and more of the run's calls are made near the ceiling. The same effect is behind the acknowledgement p95 movement. Over a run long enough for several rotations, smaller batches mean as many calls near the ceiling, and fewer rotations: the longer workload shows it.

## Trade-offs

- **The Router sees less about finished Workers each turn.** It read each report when it arrived, and `list_workers id=…` (or `recall`) reads it again; a new session's first turn lists everyone in full. A real model that relied on glancing at old reports in the list now has to ask.
- **Standing rules decide in code what the cheap model decided from the user's words.** They only apply lines the user left as Crew wrote them, only where the line is unambiguous, and the "needs the user" half of the turn rule stays with the model. A failing check is now always acted on when the default GitHub line is kept, where the model could in principle have stayed quiet on one.
- **Fewer tool descriptions in the system prompt** relies on the model reading the tool definitions, which Claude Code always sends.
- **`browser_debug_target` disappears** for bots without a plugin or MCP server; a bot that attached to the page with a script of its own through Bash loses it.

## What did not change

- No new setting and no migration; the default policies' text is the same.
- Every gate, the untrusted wrapper and `UNTRUSTED_RULE` everywhere it was, the channel norms, and what each role can do.
- The bench's default run is unchanged except for its numbers; the new options are opt-in.

## Left for later

- **The closing call of each Router turn.** After `reply`, the model makes one more call to end its turn (232 of the 517 Router calls on (a), each re-reading the whole context). Ending the turn in code after `reply` (a PostToolUse hook with `continue: false`) would remove most of them, but it changes the turn's protocol: anything the model meant to do after replying would be lost. It needs the Router's prompt to say so and a test with a real model.
- **Sending the `<workers>` list only when it changed** since the Router's last turn in the same session would cut the remaining ~39k tokens further, at the price of state in `RouterSession` and a model that must look back for the list.
- **A light target for the light roles in the model gateway.** With the gateway on and no role override, a Router or Watchdog asking for its lighter default model (not a gateway address) goes to `defaultTarget`, usually the strongest group. A `lightTarget` setting (or using `fastTarget` for them) would route those cheap decisions cheaply; it is a new setting and a quality choice, so it is left to a decision.
- **Rotation per role.** The Router and every bot share `rotateAtTokens`; the Router's context is mostly old batches and might rotate earlier at little loss, which would cut its cached re-reads directly.
- **The Watchdog's tools** (`propose_change` is offered on every tick though only a maintainer's question can use it) and its prompt were not trimmed: on the bench it never calls its model.
