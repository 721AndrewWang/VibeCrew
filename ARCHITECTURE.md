# Crew architecture

This document covers the parts Crew is made of, how a message becomes an agent's reply, and a few design decisions that are easy to trip over. For usage see the [README](README.md); for the development workflow see [CONTRIBUTING](CONTRIBUTING.md).

## Overview

```
┌──────────── Desktop app (Electron, desktop/main.cjs) ──────────────────┐
│  Tray, window, launch at login, icons; starts the server as a child    │
│  process and loads the UI                                              │
└───────────────┬────────────────────────────────────────────────────────┘
                │ spawn (ELECTRON_RUN_AS_NODE)
┌───────────────▼──────────── Server (server/, Node + Express) ──────────┐
│  api.ts        REST API (request shapes enforced by schemas.ts)        │
│  index.ts      HTTP + WebSocket entry point                            │
│  orchestrator/ Queueing, group chat routing, @ handoffs, approvals     │
│  agents/       Agent sessions: Claude Agent SDK query() -> system      │
│                claude                                                  │
│  workspaces/   Isolated git worktree workspaces: create, auto-commit,  │
│                merge                                                   │
│  preview       Preview server (static / reverse proxy + injected       │
│                script)                                                 │
│  store         JSON storage under ~/.crew                              │
│  bus ────────► WebSocket broadcast of ServerEvent                      │
└───────────────┬────────────────────────────────────────────────────────┘
                │ REST + WebSocket (same origin, 127.0.0.1 only by default)
┌───────────────▼──────────── UI (web/, React + Vite) ───────────────────┐
│  store.ts      Global state (useSyncExternalStore), handles server     │
│                events                                                  │
│  components/   Chat, composer, the right-hand "computer" (preview,     │
│                files, terminal, changes)                               │
└────────────────────────────────────────────────────────────────────────┘
shared/  Types (types.ts) and logo definitions (logos.ts) shared by server and UI
```

## The journey of a message

1. The UI calls `POST /api/chats/:id/messages`; `orchestrator.sendUserMessage` stores the message and decides who replies: the @-mentioned agents, or the lead when nobody is @-mentioned in a group chat.
2. Each chat has one queue, and only one turn runs at a time (`withChatLocked`). Until a new workspace's setup command finishes, messages wait in line (`holdTurns`).
3. `BotSession` in `agents/session.ts` keeps one Claude Agent SDK session per "chat x agent", so earlier context can be resumed. Agents with `freshSession` on (acceptance and review roles) start a new session every turn: a resumed session rereads the whole history on every call, which is wasted money for roles that only look at the current state. For the other agents, once a session exceeds `rotateAtTokens` (60k tokens by default), the next turn also switches to a new session, carrying the last 12 messages (`rotateSession` + `recapPrompt`). It calls the locally installed `claude` CLI (`vendor/sdk-binary-stub` replaces the SDK's bundled 240 MB binary).
4. The SDK's streaming events are turned by `agents/stream.ts` into the parts of a chat message (text, thinking, tool calls, approval cards) and broadcast through `bus`; `index.ts` pushes them to every WebSocket connection.
5. When a turn ends, Crew records which files it changed (undoable), which model it used, the context usage (the small ring next to the composer), and where the turn sits in the Claude Code session transcript (`meta.trace`: session id + time window). In an isolated workspace, the turn's changes are auto-committed to the branch.
6. "Trace" (`server/trace.ts`) reads `~/.claude/projects/<cwd>/<session>.jsonl` on demand and turns the lines inside the time window into a timeline: the lines of one API call (thinking, text, tool calls) are merged into one step with its token usage; tool results and sent prompts are one step each. Crew does not copy this transcript, so once it is cleaned up the trace is gone, and the UI says so plainly.
7. If an agent's reply @-mentions a teammate, the work is handed off to that teammate, with a cap on the count to prevent ping-pong.
8. Sessions are resumed, so anything sent stays in context; each turn therefore sends only what is new: environment info is sent in full the first time, after that only changes are sent, compared as "label: value" (`contextDelta`); older long messages in group chats are collapsed into one-line summaries, and agents fetch the full text by number with `chat_history`.

## Permissions

Permission levels are defined in `shared/types.ts`, the decision logic is in `agents/permissions.ts`, and the approval flow is in `orchestrator/permissionGate.ts`:

| Level | Claude Code mode | What Crew adds |
| --- | --- | --- |
| Read-only `plan` | plan | Chat-level settings cannot change it either |
| Ask every step `ask` | default | Every tool call pops an approval card in the chat |
| Auto-edit files `edits` | acceptEdits | Harmless commands (`cd`, `pwd`, `cat`...) are allowed straight away |
| AI reviewer `review` | auto | Claude Code's classifier decides |
| Full auto `auto` | default | `canUseTool` allows everything |

In addition, each agent can have "paths it may edit" (`editScope`, globs relative to the project): an Edit/Write outside that scope is rejected outright and the agent is told to @-mention a teammate. This is a hard constraint on the division of roles, not a prompt. The monthly budget (`monthlyBudgetUsd`) accumulates the per-turn cost reported by Claude Code (`server/usage.ts`); once it is used up, `runTurn` skips that agent's turns and says so once in the chat.

Whatever the level, the following three layers always apply:

- **Sandbox** (`server/sandbox.ts`): when on, every session gets Claude Code's `sandbox` option, commands run in bubblewrap, and the network reaches only localhost plus allowed domains (global list + project list). `allowUnsandboxedCommands: false`, so agents cannot escape with `dangerouslyDisableSandbox`; `autoAllowBashIfSandboxed: false`, so Crew's own approval logic still applies. This is the only layer that decides by "can it connect" rather than "what does the command look like", so it is also the only one that counts as a security boundary. All connections in the sandbox go through Claude Code's proxy (the proxy holds the allowlist; `strictAllowlist` makes hosts not on the list get rejected outright, rather than turning into a prompt that might be approved). But the sandbox's own `no_proxy` sends loopback and private addresses direct, and a direct connection reaches nothing inside the isolated network namespace, so to reach a service on this machine or the LAN, a command must be prefixed with `env -u no_proxy -u NO_PROXY` (the prompt already tells agents this). When the machine lacks the dependencies (bubblewrap and socat on Linux), the Settings page warns, and agents run without the sandbox.

- **Blocked actions** (`denyRules` in settings): written into the SDK's `permissions.deny` and also intercepted again by a PreToolUse hook without a matcher, so they cannot run even in full auto.
- **Actions that always need confirmation** (each agent's rules, plus the project's `askRules`): always pop an approval card. A compound command (`a && b`) is allowed only if every segment matches an "auto-allow" rule.

## Changes made outside the chat

Agents only know what was said in the chat. `server/outsideEdits.ts` watches project files: when a change happens while no agent is working in that project (`projectBusy`), Crew itself is not writing (`quietWrites.ts`: workspace git operations, setup commands and undoing a turn mark the project "quiet", plus 4 more seconds afterwards), and dependencies are not being installed, it waits 3 seconds and merges the batch of changes into one system message (`notice: 'outside-edit'`), sent to every chat on that project. For text files it says which lines changed: compared with the content Crew last saw, or with the last git commit if it never saw the file. Blind-review agents see these messages too.

## Adversarial review

Builders (Pixel and others), acceptance (Probe) and review (Lens) all look for supporting evidence, and each one sees the previous one's conclusion, so they tend to vouch for each other. Skeptic is the link dedicated to finding counter-evidence. Its design has these points (`server/review.ts`, `blindPrompt`):

- **Isolation** (both Skeptic and Lens): each turn a `blindReview` agent receives only the user's messages and the diff of the changes (all changes relative to the base in an isolated workspace; for a plain project, the uncommitted changes, or the last commit if there are none). It is told only how many messages teammates sent, and `chat_history` returns only the user's messages. Combined with a fresh session every turn, the author's reasoning cannot influence it.
- **Evidence only**: only a reproducible counterexample counts as a refutation; reasoning and guesses are recorded as "could not verify". Precision comes first.
- **Read-only**: it may only write `tests/challenge/**`; fixes go back to the author.
- **Can trigger automatically**: when a project has `autoChallenge` on, after a chain of turns ends and the chat is idle, fixed rules (which files changed, how many lines) decide whether to ask Skeptic; at most twice per request, and the same state is never reviewed twice (`server/autoChallenge.ts`).
- **Can act as a gate**: its verdict (the closing `Verdict: not refuted` or `Verdict: refuted N` line) is recorded on the isolated workspace, together with the commit it saw. When a project has `requireChallenge` on, merging requires a verdict for the current commit that refuted nothing.

The model follows the default (Opus 5.5). In the research, "models cannot fix their own mistakes" mostly comes from the author's reasoning staying in context, and isolation already cuts that off; changes Chief writes itself use the same model as Skeptic, so blind spots may overlap. This is a known trade-off.

## Group chat routing (shadow mode)

In a group chat, every message without an @ goes to the lead first (usually the most expensive model), even if it is just a small change. Following JEV-as-a-Judge (Li et al., 2026), `server/router.ts` prepares a cheap first pass that "accepts when confident, escalates when not", but for now it only records and does not act:

- **Cheap judgments are used only where the answer can be read off the text**: "who should take this" can be judged from the request itself; "is the code correct" requires reasoning, and in the paper cheap judges lose 7-28 points on that kind of question, so the router never judges code.
- **Average over two orders**: list the candidates once forwards and once backwards, align, and average the probabilities to cancel the position bias of "preferring the first one".
- **Labels come from real outcomes**: if the lead did the work itself, the label is the lead; if it handed off to one teammate, that teammate; if it handed off to several, the record does not count.
- **The threshold is chosen from local labels using a lower bound**: once 100 records with outcomes have accumulated, choose the smallest threshold such that the 95% lower bound (Wilson) of the accuracy of decisions above it is at least 90%. The paper shows that choosing the threshold by the lower bound rather than the point estimate cuts the risk of "dropping more than two points" from about 45% to about 5%.
- One-shot calls are all "bare": no tools, no Claude Code system prompt, no settings or MCP loaded.

## Improvement suggestions (lightweight self-improvement)

Full self-improvement needs an evaluation suite to judge whether a change is better; without one it manufactures "fake progress". Crew does not change itself automatically; instead it uses the human as the evaluation (`server/improve.ts`):

1. **Evidence pack**: the team's current settings, the last 60 turns (cost, model, status, approvals and their reasons, failing tools, refutation verdicts), the original text of refuted turns, the user's recent words, and earlier suggestions and decisions (the ledger).
2. **Proposal**: one `claude -p` call (Sonnet) returns JSON suggestions. The constraints follow the RRSI approach: at most 3 per run, each one field of one agent, a role description changes by at most 8 lines at a time, real turns must be cited, and proposing nothing is better than proposing badly.
3. **Checks**: the agent exists, the new value passes `BotPatch` validation, it differs from the current value, the evidence really exists, the evidence comes from at least two different user requests (added because on the first real run all three suggestions came from the same incident), and it does not duplicate a pending or rejected one. Suggestions that fail are dropped with the reason stated.
4. **Decision**: the user can edit first (the new value goes through the same `BotPatch` validation, and the model's original value is stored as `original`), then accept (applied to the agent; if the setting was changed by hand after the proposal, the suggestion is void), reject (optionally with a reason) or withdraw. Rejection reasons and "what the model proposed -> what the user changed it to" both go into the ledger for the next analysis.
5. **Effect**: after accepting, compare the average cost, refutation count and error count over the same number of turns before and after the change. This is only an observation, not a controlled experiment; different tasks introduce bias.

The ledger is stored in `~/.crew/improvements.json`.

## Learning from experience

Borrows the learning loop of Hermes Agent, but every step needs human approval (the paper Practice Makes Unsafe found that systems which automatically write skills from successful experience and apply them automatically all ended up writing unsafe skills):

- **Memory nudge**: when a turn makes 5 or more tool calls, the next turn's prompt in the same session ends with a reminder (`MEMORY_NUDGE`) to record only what the user said and what was verified first-hand. No reminder after switching to a new session or for blind-review roles.
- **Learned skills** (`server/learnSkills.ts`): candidates are turns that completed, made 5 or more tool calls, were not refuted afterwards and have not been drafted yet; listing them is free, drafting takes a click and one Sonnet call. A draft first goes through fixed safety checks (blocked rules and "ignore instructions"-style text are rejected outright; commands that need confirmation and addresses outside the sandbox are flagged), then shows up as a "new skill" suggestion in the improvement suggestions panel. It is written to the skills directory only when accepted, and deleted when withdrawn.

## Data

All data lives in `CREW_HOME` (default `~/.crew`):

```
settings.json  Settings (including model provider keys, stored only locally)
bots.json  chats.json  projects.json  routines.json
messages/      One message file per chat
turns/         Change snapshots for each turn (for undo)
memory/        Agents' long-term memory
skills/        Custom skills
worktrees/     git worktrees of isolated workspaces
uploads/       Uploaded images and attachments
logs/          Server log of the desktop app (server.log)
```

- All writes in `store.ts` are "write a temp file, then rename", and are batched and deferred; on exit `flushAll()` finishes any pending writes.
- `schemaVersion` in `settings.json` records the data format version. When the storage format changes, add a migration to `server/migrations.ts`; on startup missing migrations run in order, and the JSON files are backed up to `backups/` first. If the data is newer than the running Crew, it refuses to start rather than silently corrupting it.
- `migrateFromVibeCrew` in `config.ts` moves data under the old name (`~/.vibecrew`, `~/VibeCrewProjects`) over; it determines where the data directory is, so it runs before version migrations.
- An agent's progress in each turn is flushed to disk every 3 seconds. When Crew is restarted after being killed, that turn is marked "interrupted" and the half-written content is kept; uncommitted changes in an isolated workspace are committed to the branch first.
- Tests must point `CREW_HOME` and `CREW_PROJECTS` at temp directories and must never touch real data (`tests/helpers/server.ts` already does this).

## Isolated workspaces

A chat can work in its own git worktree, on a branch starting with `crew/`; agents, preview, files and terminal all use that copy.

- On creation it brings along local files that git does not track but that the work needs: `.env`, `CLAUDE.md`, settings and hooks in `.claude/`, and files listed in `.git/info/exclude`. Dependency directories, caches and tools' temporary state are not copied. Only files that `git check-ignore` confirms are ignored inside the worktree are copied, so `git status` stays clean.
- A project can configure a setup command, commit message requirements, no AI attribution, and actions that always need confirmation.
- Merging squashes the branch into one commit on the main branch. When the project has commit message requirements, the commit message must be written by hand (`claude -p` can generate a draft).

## Preview

`preview.ts` starts one preview server per project: static sites are served directly (hidden files are not served), and projects with a dev server are reverse-proxied to it. Returned HTML gets `inject/preview-inject.js` injected; it talks to the Crew window via postMessage and handles console capture, navigation tracking, element picking, demo recording and hot refresh. This script runs inside someone else's page, so it is deliberately written in a conservative `function` + `var` style (the lint rules are relaxed for it specifically).

## Desktop app

`desktop/main.cjs` is the Electron main process: it starts the bundled server (`dist-server/server.mjs`) with the login shell's environment variables, waits until it is ready, and loads the UI in a window; the tray, launch at login, and Dock and window icons (following the logo chosen in settings) also live here. `desktop/install.mjs` packages the AppImage, installs it into `~/Applications`, and writes the menu entry and icon.

## A few design decisions

- **Use the local `claude`, not the SDK's bundled binary**: saves 240 MB, and the version follows the user's own Claude Code upgrades.
- **Biome rather than ESLint**: the project uses TypeScript 7 (the native version), which has no JS API, so typescript-eslint cannot run.
- **Routing uses the address bar hash (`#/chat/<id>`)**: each chat gets its own history entry, the browser's back and forward switch between chats, and a link can open a specific chat directly.
- **Tests use the system Chrome**: Playwright does not download browsers; CI uses the Chrome that comes with the runner.
