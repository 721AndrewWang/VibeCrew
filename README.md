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

## Requirements

- Node.js 22.12 or newer (Node 24 is used for development)
- On Linux you also need a C/C++ toolchain: the terminal component node-pty has no prebuilt binaries for Linux, so `npm install` compiles it on the spot (without the toolchain the whole install fails). Ubuntu: `sudo apt install build-essential python3`
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed: `npm i -g @anthropic-ai/claude-code`
  - and **logged in**: run `claude auth login` in a terminal (a subscription account or a Console account both work)
  - or switch to an Anthropic API key in Crew's "Settings", or to another model provider such as DeepSeek, Kimi or Zhipu GLM (see below)
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
- Agents run commands on your computer as your user. Set permission levels according to how much you trust them, and keep the "always ask" rules (by default: `git push`, `sudo`, `rm -rf`, `npm publish`, deploy commands).
- "Settings → Sandbox" is on by default: commands run by agents are confined to Claude Code's sandbox, can only write to the project directory, and can only reach localhost and domains you allow (you can add more in the project settings). Agents cannot turn it off themselves. "Blocked actions" match command text; they only prevent accidents and are not a security boundary. Commands inside the sandbox that reach local services (such as the dev server) need `env -u no_proxy -u NO_PROXY`; agents know this.
- The preview server never serves hidden files in the project (such as `.env`).

## Directory structure

```
desktop/           Desktop app: Electron main process, tray, loading page, packaging and install scripts, icon generation, AppArmor rule
server/            Node server (Express + WebSocket)
  agents/          Agent engine: sessions, streaming events, permissions, prompts, custom tools, change history
  orchestrator/    Queueing, group chat routing, @ handoffs, approvals
  preview.ts       Preview server (static / reverse proxy + injected script)
  inject/          Scripts injected into the preview page (element picking, console, recording, hot refresh)
  devserver.ts     Dev server management
  routines.ts      Routines and event triggers
  workspaces/      Isolated workspaces: git worktree, auto-commit, merge, sync
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
