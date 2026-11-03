# ADR 109: Consolidating the Super-agent code

Status: accepted (code polish of the whole Super-agent mode, on top of ADR 011)

## Context

The Super-agent mode was built in two waves of parallel branches (ADRs 001-009, 101-105) and wired together twice (ADR 010, ADR 011). Each branch wrote the small helpers it needed next to the code that used them, so the merged tree held several copies of the same logic: word counting in two modules with two copies of the CJK ranges, five "N min ago" formatters, four settings normalizers with their own clamp, six copies of the set of active Worker statuses, the same tool-result helpers in four tool files, the UI's placeholder settings restating every server default by hand, and server types re-declaring shapes `shared/types.ts` already had. Some modules also reached across boundaries for a helper (the channel profiles imported their word cap from the Router's prompts, three views imported a money formatter from the Bots view).

This ADR records what was duplicated and where each piece lives now. Behaviour does not change: no output string, limit or default changed, and every existing test passes unchanged.

## Decision

One home for each helper, type and default; move and delete rather than rewrite; keep diffs to shared files small. Where a copy differed in a way someone could observe, it was either kept or the shared helper takes an option that preserves both behaviours.

### New shared modules

| Module | What it holds | Replaces |
| --- | --- | --- |
| `server/text.ts` | `wordCount`, `wordEnds`, `CJK`, `firstWords`, `clip`, `modelJson` | `layers/prompts.ts` `wordCount`/`firstWords` and its CJK copy; `recall/spill.ts` `countWords`/`wordEnds` and its CJK copy; `triggers/slowPath.ts` `excerpt` body; `triggers/index.ts` `oneLine`; `speculative/rules.ts` `short`; the JSON extraction in `triggers/slowPath.ts` `parseDecisions` and `router.ts` `parseProbs` |
| `server/time.ts` | `HOUR`, `startOfDay`, `ago`, `agoLong` | `ago` in `layers/prompts.ts`, `layers/tools.ts`, `triggers/slowPath.ts`, `watchdog/snapshot.ts`, `watchdog/tools.ts`; `recall/graph.ts` `ago` (with days, now `agoLong`); `watchdog/index.ts` `startOfToday`; `speculative/rules.ts` `dayStart`; `HOUR` in `triggers/index.ts` and `watchdog/index.ts` |
| `server/normalize.ts` | `fields`, `flag`, `modelName`, `bounded` | `clamp` in `watchdog/config.ts`, `num` in `speculative/config.ts` and `gateway/config.ts`, `model` in `layers/config.ts`, `flag` in `github/config.ts`, and the inline `Number.isFinite` clamps and `typeof … === 'boolean'` reads in `layers/config.ts`, `recall/config.ts`, `github/config.ts`, `triggers/fastPath.ts`, `safetyConfig.ts`, `speculative/config.ts`. `bounded` keeps both readings of a blank value (`null`, `''`): as 0 then clamped (router, recall, GitHub, triggers, gateway) or as the default (Watchdog, speculative), so each normalizer returns what it did before |
| `server/agents/toolResult.ts` | `ToolResult`, `ToolHandler`, `ok`, `fail`, `str`, `num`, `mcpResult` | `Result`, `Handler`, `ok`, `fail`, `str` and the MCP wrapper in `layers/tools.ts` and `watchdog/tools.ts`; the same plus `num` and `JobHandler` in `jobs/tools.ts`; `Result` in `github/router.ts` |
| `shared/status.ts` | `WORKER_ACTIVE`, `isJobRunning`, `SPECULATION_IN_FLIGHT` | `ACTIVE` in `layers/subscriptions.ts`, `watchdog/index.ts`, `watchdog/gates.ts`, `watchdog/snapshot.ts`, `bench/policies.ts`; the inline list in `api.ts`; `WORKER_ACTIVE` in `web/src/store.ts`; `jobs/index.ts` `isRunning` and `JobsBar.tsx` `jobActive` (same body); `IN_FLIGHT` in `speculative/index.ts` and `speculative/spend.ts` |
| `shared/defaults.ts` (was `shared/speculative.ts`) | Every Super-agent default: `DEFAULT_ROUTER`, `DEFAULT_RECALL`, `DEFAULT_WATCHDOG`, `DEFAULT_SPECULATIVE`, `DEFAULT_PROJECT_SPECULATIVE`, `DEFAULT_POLICIES`, `DEFAULT_SUPER_AGENT`, `DEFAULT_SAFETY`, `DEFAULT_GITHUB` | The definitions in `layers/config.ts`, `recall/config.ts`, `watchdog/config.ts`, `safetyConfig.ts`, `github/config.ts`, `triggers/fastPath.ts`; the hand-written copies in `web/src/store.ts` (placeholder settings) and `GithubChannelSection.tsx` (`DEFAULT_GITHUB_CHANNEL`). The UI keeps an empty policy box until the server's settings arrive, as before |

### Helpers moved into the module that owns them

| Helper | Now in | Was |
| --- | --- | --- |
| `REPLY_WORDS` (the chat's word cap) | `channels/profiles.ts`, beside the chat profile that enforces it | `layers/prompts.ts`; `channels/` no longer imports from `layers/` |
| `attr`, `tagDefuser` | `untrusted.ts` | `attr` in `layers/prompts.ts`, `triggers/slowPath.ts`, `watchdog/snapshot.ts` (identical); `defuse`, `fenceSafe`, `defuseSnap` keep their names and tag lists, built with `tagDefuser`. `defuseUntrusted` (lower-cases the tag) and `jobs/spill.ts` `defuse` (inserts a space) differ and stay |
| `expandHome`, `within`, `deny` | `hardening/paths.ts`, `hardening/commands.ts` | private copies in `guard.ts` |
| `canonicalRepo` | `github/config.ts` | `github/gates.ts`, plus inline copies in `githubDraftRefusal` and `parseIssueRef` |
| `isReplyKind` | `channels/profiles.ts` | a second private copy in `channels/webhookConfig.ts` |
| `overMonthlyBudget` | `usage.ts`, next to `monthSpend` | inline in `layers/workers.ts`, `layers/router.ts`, `speculative/index.ts` |
| `IDLE_CLOSE_MS` | `orchestrator/index.ts` (exported) | a second 15-minute constant in `layers/workers.ts` |
| `fmtUsd`, `toggled` | `web/src/utils.ts` | `fmtUsd` in `BotsView.tsx` (imported by the Triggers, Watchdog, routing and improvements views); the add-or-remove expression in `ProjectsView.tsx`, `SuperAgentSection.tsx`, `ProjectWebhook.tsx` |

### Types

| Type | Now | Was |
| --- | --- | --- |
| `GatewayTest`, `GatewayWindowState` | `shared/types.ts` | `gateway/index.ts` and inline in `web/src/api.ts`; `gateway/windows.ts` `WindowState` and inline in `GatewayReport` |
| `WebhookPatch` | `shared/types.ts` | `channels/webhook.ts`, inline in `web/src/api.ts` and `ProjectWebhook.tsx` |
| `WorkerOutcome` | `shared/types.ts` | `'done' \| 'error' \| 'stopped'` written out in `Worker.report`, `ReportDetail`, `RouterEvent`, `SpeculativeHost.ended` and `finish()` |
| `GhKind`, `DraftOrigin`, `SpeculativeClaimArgs`, speculative `ChangedFile`, the Watchdog's `record`/`propose` arguments, `Snapshot.speculative`, the gateway form's `auth` | derived from the shared type they restated (`TriggerGithub['kind']`, `Pick<ExternalDraft, …>`, `Speculation['claim']`, `Speculation['files']`, `WatchdogAction`, `WatchdogProposal`, `SpeculativeSpend`, `GatewayProvider['auth']`) | hand-written copies |
| `any` | `gateway/index.ts` (the test reply) and `gateway/proxy.ts` (stream events) read through the fields they use; `web/src/api.ts` parses into `unknown` | `Record<string, any>`, `any` |

### Dead code and exports

- Removed: `gateway/index.ts` `gatewayUrl` and `watchdog/index.ts` `watchdogInfo` (no callers); `watchdog/gates.ts`'s re-export of `NOTE_WORDS`; barrel re-exports nothing imports through the barrel (`github/index.ts`: the config names; `channels/index.ts`: all but `channelRoutes`; `recall/index.ts`: `registerRecall`, `RecallResolver`, `RecallScope`, `budgetOf`, `estimateTokens`, `RECALL_PROMPT_LINE`; `orchestrator/index.ts`: `parseMentions`, `effectiveBot`).
- No longer exported (used only in their own file): `sweepJobs`, `sweepSpeculations`, `checkCommandOf`, `pruneTriggers`, `housekeepWatches`, `gatherSnapshot`, `watchdogOn`, `scopeToken`, `plannedNotification`, `WEBHOOK_WORDS`, `defuseSnap`; in the UI `fmtElapsed`, `shellLine`, `SpeculationCard`, `SOURCE_LABEL`.
- Kept as forwards because the existing tests import them from there: `wordCount` from `layers/prompts.ts`, `countWords` from `recall/spill.ts`, `excerpt` and `fenceSafe` from `triggers/slowPath.ts`, the defaults from `triggers/fastPath.ts`, `watchdog/config.ts`, `safetyConfig.ts`, `github/config.ts` and `speculative/config.ts`, and `replyRefusal` (the Router's gate, a call to `chatRefusal`).

## Size

Line counts of the Super-agent modules, before (`superagent-wave2`) and after:

| Module | Before | After |
| --- | ---: | ---: |
| `server/triggers/` | 1075 | 1037 |
| `server/layers/` | 2566 | 2522 |
| `server/recall/` | 543 | 526 |
| `server/watchdog/` | 1822 | 1785 |
| `server/speculative/` | 971 | 954 |
| `server/github/` | 799 | 794 |
| `server/channels/` | 571 | 563 |
| `server/jobs/` | 876 | 869 |
| `server/gateway/` | 1246 | 1232 |
| `server/guard.ts`, `drafts.ts`, `router.ts` | 1371 | 1354 |
| New shared modules (`server/text.ts`, `time.ts`, `normalize.ts`, `agents/toolResult.ts`, `shared/status.ts`, `shared/defaults.ts` minus `shared/speculative.ts`) | 18 | 190 |
| `shared/types.ts` | 1673 | 1703 |
| Super-agent UI (bars, Triggers and Watchdog views, settings sections, `store.ts`, `utils.ts`, `api.ts`, the Bots view) | 4291 | 4278 |

The feature modules and the UI lost about 220 lines; the shared modules and types that replace the copies, with their comments, are about as long, so the total is flat (24,003 lines against 23,999). What changed is the number of copies: each helper above now has one definition to change.

## Left for later

- **The UI's chat bars.** The Workers, Background jobs, Drafts and Speculative fixes bars repeat the same header, row, card and log-dialog markup, the same live-list selector and the same "act, toast on failure" helper; the settings sections repeat the save row and the clamped number field. Folding them into shared components is a rewrite of files the UX polish is changing, so it is left for after those branches merge.
- **Helpers that look alike but differ.** The four "root project of a workspace" lookups (`channels/webhook.ts`, `recall/graph.ts`, `github/router.ts`, `triggers/index.ts`) walk different depths and fall back differently; the guard's `short` cuts one character later than `clip`; the string-list normalizers of the gateway, the triggers and GitHub slice and de-duplicate in different orders; `friction.ts` appends JSONL without `JsonlLog`'s pruning. Merging any of them changes output.
- **Inline plurals and whitespace clipping** (`n === 1 ? '' : 's'`, `replace(/\s+/g, ' ').slice(0, n)`) stay inline: a helper per expression would not make them clearer.
- **Exports used only inside their module** that are pure and worth unit-testing (`outputLine`, `signalOn`, `bareModel`, the gates' limits) stay exported, so tests can reach them.
- **`any` outside the Super-agent modules** (`agents/stream.ts`, `agents/permissions.ts`, `ToolPart.input`) is plain Crew's and out of this ADR's scope.
