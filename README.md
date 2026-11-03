# Crew — your AI crew for web development

Crew is an app that runs a team of AI agents on your own computer, built to speed up web development.
It is inspired by xAI's **Grokbot**: each agent has a name, a role and its own "computer". You chat with them like text messages, they hand work to each other with @-mentions in group chats, run on schedules, and stop to wait for your confirmation when a decision is yours.
The difference: in Crew, an agent's "computer" is your project folder. The right-hand panel shows a live web preview, files, a terminal and the changes. Agents are powered by the **Claude Code** CLI on your machine (via the Claude Agent SDK).

## Feature mapping to Grokbot

| Grokbot | Crew |
| --- | --- |
| Bots with a name and role (Name / Title / Description) | Agents: name (used for @), avatar, role description (system prompt), model (high / medium / cheap tiers), thinking effort, permission level, paths it may edit, monthly budget. Built-in roles are configured differently: the reviewer is read-only, the tester can only edit tests, the copywriter uses a cheap model |
| Each bot has its own cloud computer (browser, files, terminal) | Every chat is bound to a project: **live preview browser**, file tree + code editor, a real terminal, change history. A chat can also open an **isolated workspace** with its own git branch and working directory |
| iMessage-style chat | iMessage-style chat, streaming output, tool calls collapsed into "did N actions" |
| Group chats, @-mentions, bot-to-bot handoffs | Group chats: without an @, the lead replies; an agent that @-mentions a teammate in its reply hands off automatically (with a cap to prevent loops); @-mentioning an agent outside the group pulls it in |
| Routines (scheduled / event-triggered) | Routines: every N minutes, daily at a set time, cron, **after you save a file**, **after a git commit** |
| Skills / slash commands | Skills: type `/` to run one; 14 built-in web dev skills, customizable |
| Teach a task (screen recording) | **Record a demo**: click through a flow in the preview once, then save it as a skill or have an agent turn it into an E2E test |
| Approval gates, reviewer agent, allow / block lists | 5 permission levels (full auto / auto-edit files / ask every step / AI reviewer / read-only), plus "auto-allow" and "always ask" rules; when confirmation is needed, a card pops up in the chat |
| Plugins / MCP / multiple account connections | Plugin library (Context7 docs, Playwright, Chrome DevTools, shadcn/ui, Figma, GitHub) + custom MCP servers |
| Watch a bot's screen and take over from your phone | Mobile access: scan a QR code on the same LAN to watch progress and approve actions at any time |
| Long-term memory | Each agent has long-term memory, written with the `remember` tool and visible across chats |

## Productivity features built for web development

- **Pick an element**: click any element in the preview; its selector, styles, text and source location (React/Vue/Svelte in dev mode) are attached to your message automatically, so you can just say "make this button bigger".
- **One-click console fixes**: errors, warnings and failed network requests in the preview are captured; click "Send to agent to fix".
- **Agents can "see" the page**: agents take headless Chrome screenshots (desktop / tablet / phone) to check their own changes, and click and type through flows like a user to test them.
- **Undo every turn**: each agent turn records which files it changed; view the diff and undo in one click. You can also commit to git straight from the side panel.
- **Isolated workspaces (inspired by vibe-kanban)**: a chat can work on its own git branch (git worktree). Agents, preview, files and terminal all use that copy, so several chats can change the same project at the same time without stepping on each other. Each turn is auto-committed to the branch; see the diff against the main branch under "Changes" and merge it back in one click (squashed into a single commit). New commits on the main branch can be synced in, and conflicts can be handed to an agent to resolve.
  - Local files outside git are carried into a new workspace: `.env`, `CLAUDE.md` / `AGENTS.md`, settings, hooks and skills in `.claude/`, and files you list in `.git/info/exclude` (dependency directories and caches are not copied).
  - In the project's "Settings" you can configure: a **workspace setup command** (e.g. installing dependencies; agents start only after it finishes), **commit message requirements** (agents follow them; merge messages must follow them, and can be "Generated" in one click), **no AI attribution in commits**, and **actions that always need confirmation** (applies to every agent in this project).
- **Dev server management**: detects `npm run dev` and similar commands, installs missing dependencies automatically, and wires hot reload into the preview; static sites refresh on save.
- **Screenshots / pasted images / voice input**: paste a design and have an agent rebuild it (`/clone-ui`), or just talk.
- **Super-agent mode (preview, every part off by default)**: turn a group chat into one agent that works like a team lead with a crew behind it. It takes events from anywhere (your messages, routine runs, test runs, preview console errors, files you edit by hand), settles most of them with rules and stays quiet about the rest, answers you in a few words, runs several tasks at once without them stepping on each other, watches its own progress and picks up where it left off after a crash. Each part is a switch; with all of them off Crew behaves exactly as without them (no extra process, file or model call). What each part does, where to turn it on, and what it costs:
  - **Triggers** (Settings → Super-agent → Watch events and filter them): every event becomes a trigger in a thread; rules settle most of them and a cheap model decides the rest from policies you write, telling you in a short note when something deserves your attention. Nothing runs on its own. The Triggers page shows every event and what was decided. *Costs*: a cheap model call per batch of up to 8 events that rules could not settle, at most 30 per hour. Design: [ADR 001](docs/adr/001-triggers.md).
  - **Router and Workers** (… → Router and Workers; needs Triggers): each group chat gets a Router that reads every message and event, answers you in at most 100 words and dispatches Workers. Each Worker does one task in its own session and git worktree, as one of the chat's members (with its permissions and editable paths), on the strongest model, and reports back; its changes are merged into the chat's branch. The Workers bar above the composer shows each one; open it to read its transcript, approve its actions or stop it. *Costs*: one resident Claude Code process per two-layer chat and one per working Worker (closed after 15 idle minutes), a git worktree per Worker, and the Workers' own turns. Design: [ADR 002](docs/adr/002-two-layer.md).
  - **Channel norms** (with Router and Workers; no switch): the chat stays short. Every Router reply is at most 100 words and 6 lines, marked as a decision, a question or a request to accept finished work, and never carries code, logs or other tool output; the Workers' full reports sit under a collapsed "Details" row below it, one click away, even after the Worker is gone. Pull requests, issues and release notes the bots draft are checked for structure (a PR needs a test section) and long output is folded. Optionally, a project can send the Router's questions and acceptance requests to a Slack or Feishu webhook (project settings → Router notifications): off until you turn it on, only the kinds you pick, only the reply's words (never reports or file contents). *Costs*: nothing; a refused reply costs the Router one retry. Design: [ADR 103](docs/adr/103-channel-norms.md).
  - **Direct routing to Workers** (… → Direct routing to Workers; needs Router and Workers): a Worker subscribes to the threads it works on (its folder, its routine) and later events there reach it between its steps without the Router: the routine's next run, another Worker's merge, a failing test run in the same folder, a console error. Events from the environment never start work. *Costs*: nothing; it saves Router decisions, and the Workers bar counts them. Design: [ADR 003](docs/adr/003-subscriptions.md).
  - **Full duplex** (bot editor → Full duplex, per bot; works without the other switches): the bot runs long work in the background instead of making you wait: a build, a test suite or an install starts with its `start` tool, its turn ends at once, and the result (first and last lines, the full log one click away) comes back as a new message it acts on. It can also start a sub-task, a background session of itself. Messages you send while it works reach it after its current step. A bar above the composer lists the chat's background jobs. *Costs*: up to 4 background processes per chat; sub-tasks are the bot's own spend. Design: [ADR 004](docs/adr/004-full-duplex.md).
  - **Chain of recall** (… → Chain of recall; needs Triggers): prompts carry the id of every message, trigger, thread, Worker and background job they mention, send what is next to the current turn generously and the rest as a line, and bots, Workers and Routers read more with a `recall` tool that also lists related ids. *Costs*: usually fewer tokens per call, sometimes one extra lookup; each turn records both numbers. Design: [ADR 005](docs/adr/005-chain-of-recall.md).
  - **Watchdog** (… → Watchdog; needs Triggers): a separate session on a timer checks whether Workers make progress, loop or failed, and whether approvals, errors or friction pile up. Rules decide first, so a healthy tick costs nothing; when something is flagged it can nudge, stop or restart a Worker, tell a chat, and keep re-checking a transient failure. It never restarts work the Router or you already own. Ask it on the Watchdog page why something failed. *Costs*: at most 4 model turns per hour and $1 per day by default, on a light model. Design: [ADR 006](docs/adr/006-watchdog.md).
  - **Speculative fixes** (project settings → Speculative fixes, per project; needs Triggers, a git project and a check command such as `npm test`): when a background check fails, the preview logs an error, or you describe a problem without asking for the fix yet, fixed rules may start a silent background run in a throwaway worktree that tries to reproduce it with a failing test and find a small fix. Crew then runs the check command itself: only a fix that passes it, and without which it fails, shows up in the chat, as a card with the summary, the files, the diff and a one-click Merge (in two-layer mode the Router hears of it too). Anything else is thrown away, worktree and branch included, without a word. A run cannot ask for approvals (what would ask is refused), cannot draft anything in your name and has no credentials. Settings → Super-agent → Speculative runs lists recent runs and why each was skipped or discarded. *Costs*: a Worker session and a worktree per run, at most 2 at once, 20 minutes each and $2 per day by default. Design: [ADR 008](docs/adr/008-speculative.md).
  - **Model gateway** and **Safety** work with or without the rest: see [below](#several-providers-at-once-the-model-gateway-preview) and [Security notes](#security-notes).
  - **After a crash** nothing is lost silently and nothing is done twice: Workers that were cut off are stopped and their Routers told, a message the Router was handling when Crew died is handed to it again, a background command that kept running is stopped, and the Watchdog settles what it was doing. Design: [ADR 105](docs/adr/105-hardening.md), which also records how the whole mode was tested as one system.

## Requirements

- Node.js 22.12 or newer (Node 24 is used for development)
- On Linux you also need a C/C++ toolchain: the terminal component node-pty has no prebuilt binaries for Linux, so `npm install` compiles it on the spot (without the toolchain the whole install fails). Ubuntu: `sudo apt install build-essential python3`
- Google Chrome or Chromium (used for agent screenshots and browser tests; Crew works without it, only those two features are unavailable)
- The sandbox (recommended to keep on) needs `bubblewrap` and `socat` on Linux: `sudo apt install bubblewrap socat`. Without them agents still work, but their commands are not isolated, and the Settings page warns you
- The desktop app (AppImage) also needs FUSE 2: `libfuse2t64` on Ubuntu 24.04
- Linux / macOS (Windows is untested)

### Using other model providers

Agents always run through Claude Code, but the model behind it can come from another provider: in "Settings → Model connection", choose "Use another model provider", pick one, enter a key, click "Test connection" to make sure it works, then save.

| Provider | Notes |
| --- | --- |
| DeepSeek, Kimi, Zhipu GLM, Qwen (Alibaba Cloud Model Studio), MiniMax | Pay-as-you-go at each provider's prices |
| OpenRouter | One key for hundreds of models (Claude, GPT, Gemini...) |
| Ollama | Run open models on your own computer, no key needed (requires Ollama 0.14 or newer) |
| Custom | Any endpoint compatible with the Anthropic Messages API, e.g. LiteLLM or an internal company gateway |

- Endpoints and recommended models come from each provider's Claude Code integration guide, and can all be changed; each agent can also pick its own model in its settings.
- Keys are stored only in `~/.crew/settings.json` on your machine and are sent only to the provider you chose; in this mode Claude Code also stops sending telemetry to Anthropic.
- Claude Code is optimized for Claude models. With other models, quality and stability depend on that model (features such as web search may not work).

### Several providers at once: the model gateway (preview)

"Settings → Model gateway" (off by default) puts a small gateway inside Crew between every agent and the providers. It listens on `127.0.0.1` only and speaks the Anthropic Messages API, so providers still need an Anthropic-compatible endpoint (no translation).

- **Providers and accounts**: add as many as you like, each with its own address and key ("Copy current connection" brings over the one above). Models are addressed as `provider/model`, e.g. `deepseek/deepseek-v4-pro`; two accounts at one provider are two providers (`deepseek`, `deepseek-2`).
- **Routing groups**: an ordered list of members, e.g. `strong` = `anthropic/claude-opus-5-5`, `deepseek/deepseek-v4-pro`. When a member answers with a rate limit (429), an outage (5xx) or a quota/balance error, the next one answers instead, streams included; the agent never sees the refusal, and the usage log records the try as "handed on".
- **Per role**: each bot picks a group or `provider/model` in its own model setting (and the chat's model switch); the Router, Workers, Watchdog, speculative Workers and background calls can be routed in the gateway settings, e.g. a light group for the Router and the strongest for Workers.
- **Spend windows**: rolling limits in dollars or tokens for a role or one bot, e.g. $5 per 5 hours and $30 per week for Workers. A used-up window answers 429 with `Retry-After` before any provider is asked. Bots' monthly budgets still apply.
- **Usage log**: every call, with the provider and model that actually answered, tokens, estimated cost (from the prices you enter, or Anthropic's list prices for Claude models) and latency.
- **Masking** (off by default): keys, passwords and email addresses in prompts are replaced with placeholders before they leave the machine and put back in the replies. Best effort, not a security boundary.
- Keys stay in `~/.crew/settings.json`; agents' environments hold only a credential for the gateway, scoped to their role. Turning the gateway off goes back to the connection above at the next turn. Design: [ADR 009](docs/adr/009-model-routing.md).

## Install and run

```bash
npm install
npm run app
```

`npm run app` builds the UI, starts the server and then opens <http://localhost:4321>. Afterwards, `npm start` is enough (the UI is already built).

On first launch Crew automatically creates: a sample project (`~/CrewProjects/my-first-site`), a default four-agent crew (Chief / Pixel / Probe / Lens) and a "Web team" group chat.

Development mode (for working on Crew's own code):

```bash
npm run dev
```

Then open <http://localhost:5173>.

## Desktop app (recommended)

Crew can be packaged as a standalone desktop app (Electron + AppImage) that sits in your app list and opens with a double-click like any other program:

```bash
npm run desktop:install
```

This builds `~/Applications/Crew.AppImage` and registers the app menu entry and icon. Then search for **Crew** in "Show Applications"; right-click it to "Pin to Dock".

- **Closing the window does not quit**: the window hides to the tray, and agents and routines keep working in the background. Quit for real from the tray menu or with `Ctrl+Q` (this stops all agents).
- **Launch at login**: turn it on from the tray menu or in "Settings → Desktop app"; after login Crew runs in the background, only in the tray.
- **Shared with the command line**: all data lives in `~/.crew`. If you already started the server with `npm start`, the desktop app connects to it directly, and quitting the app does not stop that server.
- **Updating**: after changing the code, run `npm run desktop:install` again. If Crew is running in the tray, "Quit" from the tray first and reopen it to pick up the new version (the installer reminds you).
- **Uninstalling**: `npm run desktop:uninstall` (keeps the data in `~/.crew` and your projects).
- **Logs**: `~/.crew/logs/server.log`, which you can also open from the tray menu.
- **Changing the icon**: "Settings → Appearance → App icon" offers 6 logos; the icon in the window, tray and Dock changes with it (the Dock sometimes refreshes only after reopening the app or logging in again).
- **Other commands**: `npm run desktop` runs the desktop app straight from source; `npm run desktop:pack` only packages into `release/`; logo shapes are defined in `shared/logos.ts`, and after changing them run `npm run icons` to regenerate icons in every size.

### About the sandbox

Since Ubuntu 23.10, the user namespaces that the Chromium sandbox needs are restricted by default, so like most Electron apps, the AppImage build of Crew runs with `--no-sandbox`.

To turn the sandbox on, use a system install instead: put the app in `/opt/Crew`, owned by root, and add an AppArmor rule scoped to that path only (the same approach Ubuntu uses for Google Chrome). Package first, then install with sudo:

```bash
npm run desktop:pack
```

```bash
sudo desktop/install-system.sh
```

```bash
npm run desktop:install
```

After that the menu launches `/opt/Crew/crew`, and "Settings → Desktop app" shows "Sandbox enabled". Run `sudo desktop/install-system.sh` again after every code update. Undo it with `sudo desktop/install-system.sh --remove`.

### FAQ

- **Nothing happens on double-click**: the AppImage needs FUSE 2. On Ubuntu 24.04 install `libfuse2t64` (`sudo apt install libfuse2t64`); the install script tells you when it is missing.
- **Viewing logs**: `~/.crew/logs/server.log`, or tray menu → "View server log".

## Usage tips

- **Reach the right agent**: just state what you need in a group chat, and Chief breaks it down and @-mentions teammates; to pick someone, use `@Pixel`; `@all` (or `@everyone`) makes everyone reply.
- **New topic**: when switching to an unrelated task, click ↻ "Start new topic" in the title bar. The agent forgets the old context, which is faster and uses less quota.
- **Permissions**: start with the default "Auto-edit files"; clicking "Always allow" on an approval card adds the rule to the agent's allowlist.
- **Undo**: "Changed N files" under each agent message lets you view and undo the changes; changes made by commands (such as `npm install`) cannot be undone automatically.
- **Several things in parallel**: turn on "Work on a separate branch" when creating a group chat, or enable it with the project button at the top right of a chat. Each chat gets a `vc/...` branch; when done, merge it back into the main branch under "Changes" on the right. Merging never overwrites uncommitted changes in the main directory (you are asked to deal with them first).
  - Requirements: the project is a git repository (new projects are one automatically), Git 2.38 or newer, and a git user name and email are set (`git config --global user.name` / `user.email`).
  - Workspaces live in `~/.crew/worktrees/`; dependencies are installed automatically on the first preview, and git-ignored `.env` files are copied over.
  - When you close a workspace, unmerged changes stay on its branch and are not lost; the same goes for deleting the chat.
- **Skills**: `/landing coffee shop`, `/responsive`, `/fix-console`, `/polish`, `/review`, `/commit`... You can edit or add skills on the "Skills" page.
- **Lifecycle skill families**: `/triage`, `/reproduce`, `/draft-fix`, `/self-review`, `/adversarial-review`, `/changelog`, `/release-notes`, `/audit-deps`, `/audit-workflows`, `/flaky-tests` belong to families (triage, reproduce, draft-fix, review, release, repo-health). Turn a family on in a project's settings and its bots see those skills, and the Router can hand them to Workers; off, they cost no context there (the slash commands still work anywhere).
- **Drafted actions**: bots never push, open or comment on pull requests and issues, or send messages themselves. They draft it; the draft appears above the composer (and in Settings → Safety) with the exact command and target, and runs only when you click "Approve and run".
- **GitHub channel** (preview, needs the Super-agent): in a project's settings, list repositories to watch. With your own `gh` CLI, Crew polls them for new issues, comments, review comments and check results, filters them by rules you set (authors, event kinds) and tells you about the ones that matter; their text is treated as data, never as instructions. Ask the Router to work on an issue (`fix issue acme/shop#12`) and the Worker gets that issue's later comments directly. The Router writes for GitHub as drafts (a pull request description, a comment, a reply to a review comment) structured as background, change and verification, which post only when you click "Approve and run". Design: [ADR 102](docs/adr/102-github-channel.md).
- **Routines**: e.g. "every day at 9:00, have Probe run `/fix-console`", or "after every git commit, have Lens run `/review`".
- **Browser only**: you can also click "Install Crew" at the right end of Chrome's address bar to get a standalone window (the desktop app above is still recommended, since it has the tray and launch at login).

## Configuration

| Environment variable | Meaning |
| --- | --- |
| `CREW_PORT` | Server port, default 4321 |
| `CREW_HOME` | Data directory, default `~/.crew` (settings, chat history, skills, memory, change snapshots) |
| `CREW_PROJECTS` | Default parent directory for new projects, default `~/CrewProjects` |
| `CREW_CLAUDE_PATH` | Path to the `claude` executable |
| `CREW_CHROME_PATH` | Path to the Chrome/Chromium executable |
| `CREW_FAKE_AGENT=1` | Demo mode: no model calls, agents are simulated by a script (for UI development) |

On first run or when packaging, the desktop build downloads Electron (about 110 MB) and the AppImage tools from their official sources. To use a mirror instead, set the `ELECTRON_MIRROR` and `ELECTRON_BUILDER_BINARIES_MIRROR` environment variables.

### About the Claude Code executable

By default the Claude Agent SDK downloads a bundled Claude Code binary of about 240 MB. To skip that download, `package.json` uses `overrides` to replace it with an empty placeholder package, and Crew calls the `claude` command you already installed (its version follows your own updates).
If you would rather use the SDK's bundled binary, remove `overrides` from `package.json` and run `npm install` again (this only affects `npm start`; the desktop app does not bundle the 240 MB binary and always uses the local `claude`).

## Security notes

- The server listens on `127.0.0.1` only by default. Only same-origin pages on this machine can call the API; once "Mobile access" is on, other devices need a link with an access token (the QR code contains it).
- Agents run commands on your computer as your user. Set permission levels according to how much you trust them, and keep the "always ask" rules (by default: `git push`, `sudo`, `rm -rf`, `npm publish`, deploy commands; with the command guard on, pushing and publishing are refused outright and drafted instead).
- "Settings → Sandbox" is on by default: commands run by agents are confined to Claude Code's sandbox, can only write to the project directory, and can only reach localhost and domains you allow (you can add more in the project settings). Agents cannot turn it off themselves. "Blocked actions" match command text; they only prevent accidents and are not a security boundary. Commands inside the sandbox that reach local services (such as the dev server) need `env -u no_proxy -u NO_PROXY`; agents know this.
- "Settings → Safety" (on by default): a **command guard** checks every tool call before it runs, in every permission mode, Full auto included. Bots cannot read credential files (`~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.netrc`, Crew's own settings…), cannot push, publish or post in your name (they draft it instead), and cannot reach hosts outside the sandbox's allowed domains with `curl`, `wget`, `ssh` and the like. Commands that only read never ask; a command that changes something asks once and lists what it changes. Tokens and keys from Crew's environment (`GITHUB_TOKEN`, AWS keys, `NPM_TOKEN`, the SSH agent…) are kept out of bot sessions; a project can pass one through by name. An optional **audit log** records every drafted action, your decision, what ran and how to undo it, and every refusal. Design: `docs/adr/007-lifecycle-skills.md`.
- Prompt injection is assumed to succeed sometimes, so the gates do not depend on the model: processes Crew starts (agents, their commands, background jobs, dev servers) cannot call Crew's own API, so they cannot change settings, approve their own drafts or answer approval cards (on Linux); a model key or provider token you saved in Crew is never put into an agent's environment (a local key broker adds it to each request); the guard also refuses writes to git hooks and config, `.claude/`, `.vscode/`, Crew's own data and shell start-up files, and the sandbox enforces the same paths for every command; your dev server and workspace setup commands run without your credentials; a drafted push re-checks where it pushes and runs without the repository's hooks; and secrets from Crew's settings are redacted from logs, the audit log, triggers and the UI. Design and remaining risks: `docs/adr/104-injection-hardening.md`.
- The preview server never serves hidden files in the project (such as `.env`).
- The model gateway, when on, always listens on `127.0.0.1` (whatever "Mobile access" says) and refuses calls without a credential Crew gave one of its own sessions.

## Directory structure

```
desktop/           Desktop app: Electron main process, tray, loading page, packaging and install scripts, icon generation, AppArmor rule
server/            Node server (Express + WebSocket)
  agents/          Agent engine: sessions, streaming events, permissions, prompts, custom tools, change history
  orchestrator/    Queueing, group chat routing, @ handoffs, approvals
  preview.ts       Preview server (static / reverse proxy + injected script)
  inject/          Scripts injected into the preview page (element picking, console, recording, hot refresh)
  devserver.ts     Dev server management
  procs.ts         Process groups for long-running commands (dev server, background jobs)
  jobs/            Full duplex: background jobs (start/stop/status), their logs and results
  routines.ts      Routines and event triggers
  workspaces/      Isolated workspaces: git worktree, auto-commit, merge, sync
  triggers/        Super-agent trigger bus: threads, fast path (rules), slow path (cheap model)
  layers/          Super-agent two-layer mode: a resident Router per group chat, isolated Workers
  recall/          Super-agent chain of recall: Inline & Spill budgets, ids -> objects, the recall tool
  watchdog/        Super-agent Watchdog: a timer-driven control loop over Workers and errors
  speculative/     Super-agent speculative execution: silent reproduce-and-fix runs, verified by the project's checks
  gateway/         Local model gateway: provider/model routing groups, failover, spend windows, masking
  browser.ts       Headless Chrome (screenshots, console, page actions)
  log.ts           Server logging
web/               React UI (Vite)
shared/            Types and logo definitions shared by server and client
tests/             Unit, integration, browser and desktop app tests
```

## Contributing

See [ARCHITECTURE.md](ARCHITECTURE.md) for the architecture, [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, tests and code style, and [CHANGELOG.md](CHANGELOG.md) for version history. Before committing, run:

```bash
npm run check
```

## License

[MIT](LICENSE)
