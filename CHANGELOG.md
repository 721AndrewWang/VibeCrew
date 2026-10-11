# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **REA reverse engineering plugin** in the plugin library: see how a feature on a website or in a JavaScript/Electron app works without its source. A new `browser_debug_target` tool gives the bot the DevTools endpoint and target id of its `browser_act` page, so REA's web tools can inspect that page. Crew's headless Chrome now listens on a loopback-only debugging port for this.

### Changed

- The project is now English-only: UI, agent prompts, docs and code comments. The default UI language is English, and `@all` (or `@everyone`) mentions everyone in a group chat.
- The desktop build downloads Electron and the AppImage tools from their official sources; set `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` to use a mirror.

### Fixed

- On macOS, the Chromium that `npx playwright install` puts in `~/Library/Caches/ms-playwright` is found for screenshots and browser tests (only the Linux cache was searched), as is a Chrome in `~/Applications`; Playwright's headless shell serves as a last resort.

## [0.2.0] - 2026-10-02

The first official release. Renamed to Crew, with isolated workspaces, a sandbox, adversarial review and a set of "improve from use" mechanisms, plus the engineering groundwork.

### How you work

- **Isolated workspaces**: a chat can work in its own git worktree and branch. Each turn is auto-committed; see the diff against the main branch under "Changes" and squash it into one commit to merge back in one click. New commits on the main branch can be synced in, and conflicts can be handed to an agent to resolve. A new workspace brings along local files that git does not track but the work needs (`.env`, `CLAUDE.md`, settings and hooks in `.claude/`, files in `.git/info/exclude`). Projects can configure a setup command, commit message requirements, no AI attribution, and actions that always need confirmation.
- **Composer toggles** (like Claude Code): switch the permission mode, model and thinking effort per chat; switching the permission mode takes effect immediately on the turn in progress. A small ring shows context usage; the bottom of each reply shows the model actually used.
- **Other model providers**: DeepSeek, Kimi, Zhipu GLM, Qwen, MiniMax, OpenRouter, Ollama, or any endpoint compatible with the Anthropic API.
- **File changes made outside the chat are announced in the chat**: when project files are changed by hand, by another editor, by git operations or by Crew's code editor, the chat gets a message saying which files and which lines changed; blind-review agents see it too.
- The browser's back / forward buttons switch between chats, and `#/chat/<id>` links open a specific chat directly.

### Security

- **Sandbox** (on by default): commands run by agents are confined to Claude Code's sandbox (bubblewrap); they can only write to the project directory, the network can only reach localhost and allowed domains, and hosts not on the list are rejected outright. Agents cannot turn it off themselves. Requires bubblewrap and socat on Linux.
- **Blocked actions**: enforced at every permission level, including full auto (they match command text and only prevent accidents; the real boundary is the sandbox).
- Approval cards explain why they ask: which "always ask" rule (the agent's or the project's) and which permission level. "Always allow" adds a rule for every segment of a compound command, and read-only commands such as `cd`, `cat` and `grep` no longer need confirmation.
- The API validates requests at the entry point; invalid ones get a 400 that names the field.

### Roles and cost

- **Roles tied to cost and permissions**: Pixel / Forge / Muse use Sonnet, Quill uses Haiku, Lens is read-only, Probe can only edit test files, Chief uses the strongest model. Each agent can have "paths it may edit" and a "monthly budget"; the agents page shows how much each role spent this month.
- **Per-turn trace**: click "Trace" at the bottom of a reply to see, for each model call, how many tokens were read, how many were cache hits, how many were written, and which tools were called. The data is read from Claude Code's own session transcripts.
- **Saving money**: each turn sends only new content (older long messages are shrunk to one line, with `chat_history` for the full text; environment info is sent once per session); acceptance and review roles use a new session every turn; other sessions switch to a new session past 60k tokens, carrying the last 12 messages; one-shot model calls no longer carry Claude Code's built-in 29k tokens.

### Checking and refutation

- **Skeptic adversarial review**: receives only the user's request and the diff of the changes, never the teammates' explanations; its job is to try hard to refute the change, and only reproducible counterexamples count. Invoked with `/challenge`; can be used as a gate before merging; can also trigger automatically by fixed rules (changes to styles, permissions, dependencies and similar files, or more than 150 lines; at most twice per request).
- **Lens reviews blind too**: it cannot see teammates' explanations or acceptance verdicts; where real testing is needed it writes "needs real testing".
- **Browser tools support dark mode** (`colorScheme: dark`), and colors are read from real computed styles.

### Improving from use (every step needs your approval)

- **Improvement suggestions**: reads recent turns, costs, refutation results and your earlier decisions, and proposes at most 3 small changes to agent settings, each of which must cite things that really happened in at least two different requests. You can edit before accepting, reject (with a reason) or withdraw; after accepting, performance before and after is compared.
- **Learned skills** (inspired by Hermes Agent): turns that did a fair amount of work, completed smoothly and were not refuted can be drafted into skills. Drafts go through fixed safety checks first and are saved only when you accept; drafting takes your earlier rejection reasons and edits into account.
- **Memory nudge**: after a complex turn, the agent is reminded to write down experience that will be useful later, recording only what the user said and what it verified first-hand.
- **Group chat routing (shadow mode)**: for messages without an @, Haiku guesses who should take them, once in each of two orders, and only records the guess without acting on it; once enough data accumulates, an accuracy lower bound and AUROC decide whether it can be trusted.

### Changed

- Renamed to **Crew**. The first launch moves `~/.vibecrew` to `~/.crew` and `~/VibeCrewProjects` to `~/CrewProjects`.
- The UI and icons are now black, white and gray with line icons; Settings → Appearance offers 6 logos, and the Dock, tray and window icons follow.
- In auto mode, agents no longer ask for consent in the chat for routine work.

### Reliability and engineering

- When Crew is restarted after being killed, the interrupted turn keeps its half-written content; the data directory has a format version and migrations, with an automatic backup before migrating.
- Tests: Vitest (unit and integration, including real Claude Code against a local fake model) and Playwright (browser and desktop app), over 200 in total; tests never touch real Crew data or the Claude login.
- Biome formatting and lint; GitHub Actions CI (also runs nightly against the latest Claude Code); pushing a `v*` tag publishes the AppImage automatically.
- Unified server logging; ARCHITECTURE and CONTRIBUTING docs; a `docs/mindmap.md` mind map of the development history.

## [0.1.0] - 2026-09-29

The first version (then called VibeCrew): an agent team, group chats and @ handoffs, live preview, files, terminal, change history and undo, routines, skills, demo recording, plugins and MCP, mobile access, desktop app.

[Unreleased]: https://github.com/krukteresa413-ops/VibeCrew/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/krukteresa413-ops/VibeCrew/releases/tag/v0.2.0
[0.1.0]: https://github.com/krukteresa413-ops/VibeCrew/commit/5981c6b
