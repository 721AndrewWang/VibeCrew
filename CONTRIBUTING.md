# Contributing

Start by reading [ARCHITECTURE.md](ARCHITECTURE.md) to see how the parts fit together.

## Setup

- Node 24 (see `.nvmrc`; minimum 22.12). On Linux you also need a C/C++ toolchain, because node-pty is compiled on install.
- Google Chrome installed: browser tests use it directly instead of downloading a browser. Point to Chrome in another location with `CREW_CHROME_PATH`.
- Optional: install the Claude Code CLI (`claude`). Without it, the few integration tests that drive the real CLI are skipped automatically.

```bash
npm install
npm run dev        # server + Vite, open http://localhost:5173
```

When working on the UI you can add `CREW_FAKE_AGENT=1` to have a script simulate the agents, with no model calls.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type check: server, UI, tests |
| `npm run lint` | Biome: check formatting and lint, without changing files |
| `npm run format` | Biome: format, and apply safe automatic fixes |
| `npm test` | Unit and integration tests (Vitest) |
| `npm run test:e2e` | Browser end-to-end tests (Playwright; builds the UI first) |
| `npm run test:desktop` | Package the desktop app, then test it (slow; only run when you changed `desktop/`) |
| `npm run check` | Type check + lint + `npm test`; run this before committing |
| `npm run ci` | `check` plus the end-to-end tests, the same as CI |

## Tests

```
tests/
  unit/         Pure functions: permission rules, logos, UI helpers, logging
  integration/  Start a real server (demo mode, or real claude + a local fake model API) and test over HTTP
  e2e/          Drive the UI in Chrome
  desktop/      Launch the packaged desktop app
  helpers/      startServer, fake model API, git helpers
```

- **Never touch real data.** `startServer()` gives each server a temporary `CREW_HOME` and clears the `CLAUDE*`, `ANTHROPIC_*` and `CREW_*` environment variables. Any new test you write must do the same.
- When you need model replies, use `tests/helpers/mockProvider.ts` to start a local Anthropic-compatible API and connect the real `claude` CLI to it. No account or key is needed, and it costs nothing.
- e2e tests use the `crew` fixture from `tests/e2e/fixtures.ts`, one separate server per test. Any error on the page fails the test. Use `openChat(page, crew, id)` to open a chat by URL, and `.chat-item[data-chat="<id>"]` to click a chat in the sidebar; don't match by title text (titles can contain each other).
- When fixing a bug, first write a test that reproduces it.

## Code style

- Formatting and lint are left to Biome (`biome.jsonc`): single quotes, two-space indentation, line width 200. Don't use Prettier; it reflows whole files to 80 columns.
- Disabling a rule needs a reason: rules disabled globally are documented in `biome.jsonc`; for a single spot use `// biome-ignore lint/<rule>: <reason>`.
- Few, precise comments: write "why", not "what".
- Server diagnostics go through `server/log.ts`: `const log = logger('module-name')`; don't use `console.*` directly. Verbosity is controlled by `CREW_LOG_LEVEL`.
- Everything is in English: user-facing UI text, code, comments and commit messages.
- The UI is black, white and gray: use line icons (lucide), not color emoji.

## Changing the storage format

The JSON stored under `~/.crew` is versioned (`schemaVersion` in `settings.json`). When you change the format:

1. Add an entry to `MIGRATIONS` in `server/migrations.ts`, with a `version` one higher than the previous entry; `run(home)` edits the files directly (at startup the stores have not read their files yet).
2. Write a unit test for it: prepare a directory in the old format, run `migrate`, and assert the new format.
3. Compatibility code that reads old fields can be deleted; the migration already guarantees the format.

JSON files are backed up to `~/.crew/backups/` automatically before migrating.

## Commits

- One commit does one thing. Commit messages are imperative English, with a subject of at most 72 characters; if needed, add a body after a blank line explaining why.
- Run `npm run check` before committing.
- Record user-visible changes under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Releasing

1. Move the "Unreleased" content in the CHANGELOG under the new version number, with the date.
2. `npm version <patch|minor|major> --no-git-tag-version`, commit, then create a `v<version>` tag and push it.
3. After the tag is pushed, the Release workflow in GitHub Actions builds the AppImage and attaches it to a GitHub Release, with the release notes taken from the matching CHANGELOG section (the tag must match the version in package.json).
4. To use the new version locally, run `npm run desktop:install`.
5. After release you can verify the package GitHub built: download `Crew-<version>.AppImage`, unpack it with `--appimage-extract`, then run `CREW_DESKTOP_EXE=<unpack dir>/squashfs-root/crew npx playwright test -c tests/desktop/playwright.config.ts`.
