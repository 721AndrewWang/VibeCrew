---
title: Crew development log
markmap:
  color: '#555555'
  initialExpandLevel: 2
  maxWidth: 360
---

# Crew development log (2026-09-29 → 10-02)

## Look and name
- Black, white and gray UI, line icons (`655b5f4` `2c2cf75`)
- 6 selectable logos; Dock / tray / window follow
- VibeCrew renamed to Crew, data moved from `~/.vibecrew` to `~/.crew` (`4900080`)

## Boundaries with the outside
- Used Crew to develop BioBuddy (frontend preview only)
- Decoupled from zero1 / zero3: blocked rules
- Removed the BioBuddy project from Crew; the repository itself untouched
- Removed project and server names from tests (`088a588`)

## Composer and visibility
- Per-chat permission / model / thinking effort toggles
- Context usage ring; replies show the actual model
- "Always allow" adds rules per segment of compound commands
- Address bar follows the chat; back / forward switch chats (`a224fd9`)

## Engineering
- Tests: Vitest (unit, integration) + Playwright (browser, desktop app) (`7d74e7d`)
- Biome formatting and lint, server logging, split up large files (`eff6fbe`)
- GitHub Actions CI, nightly run against the latest Claude Code
- Docs: ARCHITECTURE / CONTRIBUTING / CHANGELOG, version 0.2.0 (`983b861`)
- Pushing a tag builds and releases the AppImage (`f74632e`)

## First principles: safe, explainable, recoverable
- Every approval explains why it asks (`7ec74c7`)
- Crashes lose no work: progress flushed every 3 seconds, interrupted turns kept (`2fcc337`)
- Data format version and migrations, automatic backup before migrating
- API validates parameters at the entry point (zod) (`aafb2c6`)
- Sandbox: commands confined to bubblewrap, network only to the allowlist (`b550fb2` `5a85d59`)
  - Found in testing: hosts not on the list were only "asked about"; changed to reject outright
  - Reaching localhost from the sandbox needs `env -u no_proxy -u NO_PROXY`

## Roles and cost
- Roles tied to model tier, paths they may edit, monthly budget (`bf147f8`)
- Per-turn trace: reads Claude Code's own transcript, shows tokens per call (`42f179c`)
  - The first real use caught a parsing bug: parallel tool calls counted as several calls (`ab18bad`)
- Each turn sends only new content: long messages become summaries, `chat_history` for full text (`8a87253`)
- Acceptance and review roles get a new session every turn: a Probe turn dropped from $0.32 to $0.19 (`94d3e4b`)
- Finding: the money goes mainly to rereading context, not to writing output
- Sessions over 60k tokens switch to a new session, carrying the last 12 messages (`1978cce`)
  - Absolute token count: the window is 1M, so a percentage would never trigger

## Adversarial review (refutation)
- Skeptic: sees only the request and the diff, accepts only reproducible counterexamples (`5b63708`)
  - Refuted on the first run: dark mode button contrast 2.87:1
  - Can act as a merge gate (`/challenge`)
- Browser tools support dark mode (`625bb46`)
- Lens reviews blind too (`f3f5130`)
  - Caught that Pixel's fix never took effect: CSS cascade order
  - Also, because I edited files outside the chat, it saw outdated requirements
- File changes made outside the chat are announced in the chat automatically; blind review sees them too
- Rules automatically ask Skeptic: touching styles / permissions / dependencies and similar files, or over 150 lines; at most twice per request

## Self-improvement (lightweight RSI)
- Improvement suggestions: evidence pack → at most 3 → checks → the human decides (`2ff363c`)
- Evidence must come from at least 2 different requests; one incident is not a pattern (`901293a`)
- First real run: accepted Pixel's 2, rejected Lens's 1 (with a reason)
- Borrowed from Hermes: memory nudge after complex tasks; successful approaches drafted into skills, safety-checked, saved only with your approval
  - Based on the paper Practice Makes Unsafe: every system that wrote skills automatically wrote unsafe ones
  - The first real draft, /review-fix, made "do whatever the reviewer says" a rule → rejected; drafting now considers rejection reasons
  - Skill drafts and settings suggestions can both be edited before accepting, and your edits inform the next round

## Routing (the JEV-as-a-Judge paper)
- Shadow routing: Haiku guesses once in each of two orders and averages, records only, does not act (`66b9410`)
- Collect 100 local labels, choose the threshold by the accuracy lower bound
- Report adds AUROC and "confident but wrong" (`f3f5130`)
- One-shot calls drop Claude Code's built-in 29k tokens: $0.06 → $0.001
- Lessons from the paper
  - Cheap judges can "read" but not "reason": judging whether code is right takes execution
  - The more confidently something is written, the more it sways the reviewer → blind review
  - Set the threshold per workload
- Jev postponed: let Haiku collect data first

## Sample site
- "Contact us" section (`d67a409`)
- Dark button contrast 2.87 → 6.65, plus a contrast check script (`01a83a0`)

## To do
- Send more group chat messages without an @ to collect routing data → check AUROC → decide whether to adopt Jev
- Make my changes through the chat, not by editing files outside it
