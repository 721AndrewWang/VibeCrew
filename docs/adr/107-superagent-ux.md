# ADR 107: One product: the Super-agent's user experience

Status: accepted (UX polish of Super-agent mode after the second-wave integration, ADR 011)

## Context

The Super-agent views were built by separate milestones (ADRs 001-009, 101-105), each with the screen its milestone needed: the Triggers page (001), the Workers bar and transcripts (002, 003), the Background jobs bar (004), the Watchdog page (006), the Drafts bar (007), the Model gateway settings (009), the Speculative fixes bar and settings (008), Router notifications (103) and the GitHub channel (102). Integrated (ADRs 010, 011), they work as one system, but they did not read as one product. Walking through them with every switch on, in both themes and with the keyboard only, turned up the following.

**Onboarding**

1. Settings → Super-agent was one toggle; every other part (Router and Workers, Direct routing, Chain of recall, the Watchdog, the limits for speculative fixes) only appeared once that toggle was on, each with its own toggle inside a paragraph of 60-100 words. A newcomer could not see what the mode consists of before switching it on, nor which part depends on which.
2. Costs were in the prose of some hints (Haiku "about $0.002 per batch"), absent from others (the Router, Workers), and stated only as defaults where the user can change them (the Watchdog's budget, the speculative budget). ARCHITECTURE.md had the full table; the app did not.
3. The per-project parts (speculative fixes, the GitHub channel, Router notifications) and the per-bot one (full duplex) were not mentioned in Settings at all.
4. There was no short explanation of what a Router, a Worker or a Trigger is, anywhere in the app.

**Clarity**

5. What runs in the background was spread over three bars inside each chat (Workers, Background jobs, Speculative fixes), only for the chat that is open. No view listed what runs across chats, and the speculative runs in flight were not visible anywhere (only ready ones, as cards).
6. The cost of a running Worker was in its transcript dialog only (`$0.123`, three decimals), a job's in its log dialog, a speculative fix's on its card (two decimals), the Triggers' slow path in its own format (`fmtUsd`).
7. Why a Worker runs (which Trigger the Router dispatched it for) was not shown; `Worker.related` held the ids but no view used them.
8. A pending draft showed its command and folder, but its body (the text that would be posted on GitHub) was collapsed in the chat's bar, and nowhere did it say in words what approving it does: which remote and branch a push moves, that a comment posts under the user's own gh login, that discarding sends nothing.
9. A ready speculative fix said "Merge" without saying where it merges (the chat's branch or the project folder), how much it changes, that nothing is pushed, or that a pull request comment was drafted with it. Its proof (the check fails without the fix and passes with it) was hidden in the compact bar.

**Consistency**

10. One concept, several names: "Super-agent" / "Watch events and filter them" / "the bus" for the Trigger switch; "Speculative runs (silent reproduce-and-fix)" in Settings, "Speculative fixes (silent reproduce-and-fix)" in a project, "speculative fix" in the bar; "Needs the Super-agent (Settings → Super-agent)" for what is the Triggers switch.
11. Six status maps (Workers, jobs, drafts, speculative runs, trigger verdicts, Watchdog ticks), each with its own labels and colours. Orange meant "needs you" for a Worker or a draft, but "being decided by the cheap model" for a Trigger; the Watchdog's state badge printed the raw value (`idle`); a speculative run checking its fix read "Running the checks" while everything else in progress was one word.
12. Empty, loading and error states were each improvised: a bare spinner, "Loading…" text, `muted pad` text, a toast and nothing on the page (the Watchdog page, the Triggers list: a failed load spun for ever), a `card empty` on one page and a `muted` line on another.
13. `.link-btn` was styled only inside message footers, so "Router log", "View diff" and "Show more" rendered as default bordered browser buttons.

**Accessibility** (measured with a browser audit of the main pane and dialogs, demo agent, every switch on; numbers are light / dark)

14. Contrast: the muted grey `--text-3` measured 2.9-3.4:1 on light surfaces and 3.4-3.7:1 on dark ones, and the orange badge 3.7:1, against the 4.5:1 small text needs. 20 / 23 text elements failed in a chat with Super-agent bars, 7 / 7 on the Triggers page, 7 / 7 on the Watchdog page, 93 / 90 in Settings (30 in the Super-agent card alone). Decided Watchdog proposals were drawn at 70 % opacity on top of that.
15. Names: no switch had an accessible name (13 of 13 in Settings were announced as just "toggle button"); 24 of 41 controls in the Super-agent card, 9 of 15 in the Model gateway card and 4 of 9 in the Safety card had no name (labels not tied to their fields, placeholder-only inputs, icon-only Remove buttons); the Watchdog's question box had none; the Workers bar's Stop and Dismiss and the jobs bar's Stop relied on `title` alone.
16. Dialogs did not take focus when they opened, and Tab walked out of them into the page behind: 21 of 25 Tab presses from an open Trigger dialog landed outside it. Closing one left focus nowhere.
17. Filter buttons (Triggers' sources and verdicts, a source's mode) did not say which one was pressed; collapsible bars did not say whether they were expanded.

## Decision

One vocabulary, one set of building blocks, one place to see background work, and an onboarding that shows every part before it is on. No new setting, no migration, no server change, no new dependency.

| What | Decision | Where |
| --- | --- | --- |
| Names | Each part has one name, used in the UI, the settings and the docs: **Triggers** (the `superAgent.enabled` switch), **Router and Workers**, **Direct routing**, **Chain of recall**, **Watchdog**, **Speculative fixes** (a single attempt is a "run"), **GitHub channel**, **Router notifications**, **Background jobs** (the bot's "Full duplex" switch), **Model gateway**. Each part also says in one sentence what it does and, from the user's current limits, what it costs. | `web/src/superagent.ts` (`PARTS`) |
| Status tones | Five tones, one badge component: **active** (accent: Working, Running, Checking, Thinking, Looking, Deciding), **attention** (orange: Needs you, Waiting for you, Fix ready, and nothing else), **ok** (green: Done, Merged, Act), **failed** (red), **neutral** (grey: Stopped, Skipped, Discarded, Idle, Off). Every status map is in one file; a unit test pins that orange means "waits for the user". | `superagent.ts`, `SuperAgentUi.tsx` (`StatusBadge`), `tests/unit/superagent-ux.test.ts` |
| Money | One format everywhere: `$0.00`, `<$0.01` for the fractions of a cent most calls cost, whole dollars from $10. | `fmtCost` |
| States | `EmptyState` (what would appear and how to make it appear), `LoadingState` (a spinner with words, `role=status`), `ErrorState` (the reason and Try again, `role=alert`), and `OffNotice` ("Watchdog is off." with a button that opens Settings and focuses that part's switch). Used on the Triggers, Watchdog and Activity pages, in the transcript, job log and diff dialogs, and in the GitHub channel's settings. | `SuperAgentUi.tsx` |
| Look | One small stylesheet for the Super-agent views: a 4/8/12/16 px spacing scale, section titles at 13 px semibold as real headings, rows at 12.5 px, hints at 12 px; `.link-btn` styled once for every view. | `web/src/styles/superagent.css` |
| Onboarding | Settings → Super-agent opens with three lines on what the mode is, a collapsible "How it works" (Triggers, Router, Workers, the Watchdog in four short paragraphs; open while everything is off), and a list of all ten parts: each with its status, what it does, **Costs:** under the current limits, "Needs … on first" when a prerequisite is off (its switch is then disabled), and its switch, or a button to where its switch lives (Projects, Bots, the gateway card). **Turn on the core** turns on Triggers, Router and Workers, Direct routing and the Chain of recall after a confirmation that lists their costs; the Watchdog, speculative fixes and the GitHub channel stay off until chosen. **Turn everything off** turns every global switch off after a confirmation. Each part's own settings follow in a collapsible block with labelled fields. The defaults stay all off (the everything-off guarantee of ADR 010 and `super-agent-off.test.ts`). | `views/settings/SuperAgentSection.tsx` |
| Activity | A new **Activity** page lists, across chats, what runs in the background: Routers deciding, Workers working, speculative fixes in progress (not visible anywhere before), background jobs and the Watchdog. Each row says what it is (and opens its transcript or log), who and where, **why** (the Trigger it was dispatched for or started by, as a link that opens the Trigger), for how long, its cost so far, its status, and has a **Stop** button (the Watchdog's turns it off). Drafts and fixes waiting for the user are listed first, per chat, with Open chat. **Stop all** stops everything after a confirmation. A strip above the sidebar's navigation ("2 running · 1 waiting for you · $0.14") is always there while the mode is on or something runs, and opens the page; it is a strip, not a ninth navigation icon, because the navigation row already truncates its labels at eight. | `views/ActivityView.tsx`, `Sidebar.tsx` |
| Why | Any Trigger id can be opened from anywhere (`openModal({ kind: 'trigger' })`): the Activity page, a Worker's transcript and a speculative fix's card use it. | `store.ts`, `App.tsx`, `TriggersView.tsx` (`TriggerDialog` exported) |
| Drafts | A pending draft says **When you approve** in words before its command: what a push moves (remote, URL, whether the branch is created or moved from which commit) and that hooks do not run; that a pull request, issue or comment is posted on GitHub under the user's own gh login, with its target and title; that Crew never sends a message itself; and that discarding sends nothing. The text that would be posted is open while the draft waits. Approve and Discard name the draft. | `DraftsBar.tsx` (`draftEffect`) |
| Speculative fixes | A ready fix says **When you merge**: how many lines in how many files (the reproduction included) it applies, where (the chat's branch or the project folder), that nothing is pushed, the pull request comment drafted with it, and what Discard removes. Its proof and the Trigger that started it are shown in the bar too. | `SpeculativeBar.tsx` |
| Contrast | `--text-3` becomes #6b6b6b (light) and #8a8a8a (dark); green, orange and red are darkened in the light theme. Every muted text, hint and badge now measures at least 4.5:1 on the surfaces it sits on, in both themes (a unit test computes it from `base.css`). Decided Watchdog proposals recede by background colour, not opacity. | `styles/base.css`, `styles/views.css`, `tests/unit/superagent-ux.test.ts` |
| Names for assistive tech | `Toggle` is `role=switch` with `aria-checked` and takes a `label`; every switch on the Super-agent's settings pages, projects and the bot editor's full-duplex switch has one. `Field` ties a label and a hint to its control. Icon buttons, the Watchdog's question box, the gateway's provider, group and window rows and the safety command tester are named. Filters say `aria-pressed`; collapsible bars `aria-expanded`; the Router's status, the bars' counts and the Activity totals are polite live regions; the Watchdog's meters are `role=meter`. | `ui.tsx`, `SuperAgentUi.tsx` (`Field`), the views |
| Focus | A dialog takes focus when it opens (unless a field inside already did), keeps Tab and Shift+Tab inside, is named by its title, and gives focus back to whatever opened it when it closes. Row buttons in scrolling bars draw their focus ring inside. | `ui.tsx` (`Modal`), `superagent.css` |

### Measured after (same audit, same data, light / dark)

| | Before | After |
| --- | --- | --- |
| Text below AA contrast: chat with Super-agent bars | 20 / 23 | 0 / 0 |
| Triggers page | 7 / 7 | 0 / 0 |
| Watchdog page | 7 / 7 | 0 / 0 |
| Settings (all cards) | 93 / 90 | 0 / 0 |
| Unnamed controls: Super-agent card | 24 of 41 | 0 of 48 |
| Model gateway card | 9 of 15 | 0 of 15 |
| Safety card | 4 of 9 | 0 of 9 |
| Watchdog page | 1 of 4 | 0 of 4 |
| Switches without a name in Settings | 13 of 13 | 3 of 13 (outside the Super-agent's cards) |
| Tab presses that leave an open dialog (of 25) | 21 | 0 |
| Dialog focused when opened | no | yes |

The audit script walks the main pane and dialogs of each view with every switch on, computes each visible text's contrast against its real background, and counts visible controls without an accessible name; the remaining unnamed controls are in the Defaults, Sandbox and Notifications settings and the chat composer, outside this change.

## Tests

- `tests/e2e/super-agent-ux.spec.ts` (demo agent, offline): turning the mode on part by part from Settings with the keyboard only, the confirmation listing costs and taking focus, a part disabled until its prerequisite is on, everything off again; the Activity page showing a running Worker with its chat, its Trigger (which opens in a dialog that keeps and gives back focus), its cost and status, and stopping it in one click; a drafted comment saying what approving it does, its text open, listed as waiting for you on the Activity page, discarded from the keyboard; every Super-agent page with no unnamed control and its empty states.
- `tests/unit/superagent-ux.test.ts`: one name per part, costs from current limits, prerequisites, the core and off patches, orange only for waiting-for-you statuses, the cost format, and the WCAG contrast of the theme tokens in both themes (the test fails on the old colours).
- The existing e2e tests (`super-agent.spec.ts`, `two-layer.spec.ts` and the rest) pass unchanged.

## What did not change

- No setting, default, migration, server route or dependency. Defaults stay all off; the everything-off test is untouched.
- Every part's own settings (sources, policies, models, limits) are where they were, under the parts list, with the same `data-testid`s.
- Test-facing labels other tests use ("Working", "Done", "Stopped", "1 drafted action waiting for you", "Discard", "Tick now", `.sb-nav-item[title=…]`) are kept.

## Left for later

- The Defaults, Sandbox, Notifications and LAN settings cards and the chat composer still have unlabelled fields (12 controls in Settings, 3 in the composer); they are not Super-agent views.
- The sidebar's navigation truncates its labels with eight items ("Trig…", "Wat…"); it needs its own layout decision (icons only, or a second row).
- The Activity page shows what is running now and what waits; a history (what ran today and what it cost, per part) would need the server to keep per-day spend for Routers and Workers, which only speculative runs and the Watchdog have.
- A Router's own cost is not known to the UI (`RouterInfo` has no cost), so its Activity row shows none.
- Stopping a Watchdog tick in flight is not possible (no API); its Activity row turns the Watchdog off instead.
- Keyboard shortcuts (for example to open Activity) were not added.

## Risks

- **Darker muted text** changes the look of the whole app, not only the Super-agent views, since `--text-3` is shared; the hierarchy between `--text-2` and `--text-3` is smaller (1.5:1 between them in light). It is the price of readable hints.
- **Focus moving into dialogs** changes behaviour for every dialog. A dialog with a field that focuses itself keeps that focus; the focus trap only acts on Tab.
- **Stop all** stops several chats' work at once; it asks first and keeps drafts and fixes that wait for the user.
