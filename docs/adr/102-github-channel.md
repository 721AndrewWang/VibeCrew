# ADR 102: GitHub as an asynchronous channel

Status: accepted (design notes sections 3 and 4: per-channel output, working where the team already works)

## Context

The design notes ask for one agent the user reaches from any channel, with output shaped per channel: chat-like channels get short, low-interruption messages; asynchronous channels such as pull requests get structured, dense write-ups (section 3). They also ask that the agent work where the team already works (section 4). Until now Crew's only channel was its own chat: everything the Router said went through `reply` (at most 100 words), and the only way GitHub reached an agent was the user pasting an issue into a message.

The pieces this needs already exist, built for other sources:

- The Trigger bus (ADR 001) turns any event into a Trigger on a Thread, filters it in code (fast path), lets a cheap model judge candidates (slow path), and hands acted-on events to the Router of a two-layer chat as environment events that cannot start work (ADR 002).
- Thread subscriptions (ADR 003) send later events on a Thread straight to the Workers that subscribe to it, without a Router decision.
- The `<untrusted>` wrapper (ADR 007) labels outside text everywhere it enters a prompt: Router environment events, Worker deliveries, the slow path, recalled environment objects.
- Draft-only external actions (ADR 007) build the exact `gh` argv from validated fields; nothing runs until the user clicks "Approve and run" on the Drafts bar.

What is missing is a source that watches GitHub, a Thread per issue or pull request, a way for the Router to write in GitHub's register (it has no tools that draft anything today), and a way to put a Worker on an issue's Thread.

## Decision

A new module, `server/github/`, adds GitHub as a Trigger source and as an output channel. It is opt-in per project, needs the Super-agent switch, uses the `gh` CLI the user already has (its login, its token, in Crew's own process: no agent session ever sees the token), and writes nothing to GitHub by itself.

### 1. Settings, per project

`Project.github` (edited on the project page, saved through `PATCH /api/projects/:id`; a workspace uses its parent's):

| Field | Meaning | Default |
| --- | --- | --- |
| `enabled` | Poll this project's repositories | off |
| `repos` | `owner/name` of each repository to watch (at most 10) | none |
| `everyMinutes` | Polling interval (1 to 1440) | 5 |
| `authors` | Logins whose issues and comments count; empty means anyone except bots | empty |
| `events` | `issues`, `comments` (issue and pull request conversation), `reviewComments`, `checks` | all on |
| `candidates` | Events no Worker subscribes to may go to the cheap model (otherwise only subscribed Workers ever see them) | on |

Polling runs only while `superAgent.enabled` is on and at least one project has `enabled` and a repository. Otherwise there is no timer, no `gh` process and no `github/` folder.

### 2. Polling (`github/poller.ts`, `github/gh.ts`)

A timer every 30 s (unref'd, created by `syncGithub()` when the first project opts in, stopped when the last one leaves) polls each project whose interval has passed; `POST /api/github/poll` polls one project now. Per repository it runs read-only `gh api` calls with a 30 s timeout and the user's environment:

- `repos/{repo}/issues?state=open&sort=created&direction=desc&per_page=30` for new issues (pull requests in that list are skipped);
- `repos/{repo}/issues/comments?sort=created&direction=desc&per_page=50&since=…` for issue and pull request conversation comments;
- `repos/{repo}/pulls/comments?sort=created&direction=desc&per_page=50&since=…` for review comments;
- `repos/{repo}/pulls?state=open&sort=updated&direction=desc&per_page=10`, then `repos/{repo}/commits/{sha}/check-runs?filter=latest&per_page=50` for each head, for completed check runs.

A cursor per project and repository (`CREW_HOME/github/cursors.json`) keeps when the last poll started and the ids it has seen (bounded to 2,000). The first poll of a repository only sets the cursor: history is not replayed as news. Later polls take what was created since the cursor minus a minute of overlap and skip ids already seen, so clock skew and a slow poll cannot lose or repeat an event. Parsing the API's JSON into events is pure (`github/events.ts`) and ignores anything that does not have the expected shape.

Failures (gh missing, not logged in, rate limited, a repository it cannot read) are kept as the project's `lastError`, logged, and shown on the project page; the next poll tries again.

### 3. Triggers and Threads

Each event becomes a Trigger with source `github`, never explicit:

- **Thread** `github:<projectId>:<owner/repo>#<n>` (kind `github`), one per issue or pull request, titled `GitHub owner/repo#n`. The title is built from facts only; the issue's own title is outside text and stays in the payload.
- **Summary** from facts only: `Issue #12 opened by alice in acme/shop`, `Comment by bob on PR #7 in acme/shop`, `Review comment by bob on PR #7 in acme/shop (src/cart.ts:40)`, `Check failed on PR #7 in acme/shop (head 1a2b3c4)`. Logins are reduced to the characters GitHub allows.
- **Payload** (`ref: payload`): what was written, with its URL, author, title, file and line, the review comment's id (which a reply needs) and a check's output summary. It is untrusted data: wherever it enters a prompt it is inside the `<untrusted source="github">` wrapper (Router environment events, Worker deliveries, the slow path, recall). The Trigger's chat is the project's most recently active two-layer chat, else its most recently active chat, so an act decision reaches the right Router.

### 4. Fast-path rules

`github/filter.ts` screens each event in code (pure) before it is published, and the bus's fast path applies the result next to its usual rules, so every drop is recorded with its rule and shown in the Triggers view:

| Rule | Applies to subscribed Workers too | Meaning |
| --- | --- | --- |
| `own-draft` | yes | A comment whose URL is the output of a draft the user approved: Crew wrote it, it is not news |
| `bot-author` | yes | Authors ending in `[bot]` (or of type Bot), unless listed in `authors` |
| `author-not-allowed` | yes | `authors` is set and does not name the author |
| `check-passed` | no | A check that succeeded, was skipped or neutral: news to the Workers on that pull request, noise to everyone else |
| `subscribers-only` | no | `candidates` is off: only subscribed Workers get GitHub events |

After those, a GitHub event on a Thread with active subscribers goes straight to them (rule `subscribed`, duplicates within 30 minutes dropped); otherwise the shared rules apply as for every filtered source: the Super-agent's project allow-list, the per-thread cooldown after a notice, de-duplication by fingerprint (kind, author, the start of the text, a check's name, conclusion and head), and the hourly candidate budget. What is left goes to the cheap model with the user's policies; a default policy line covers GitHub events (act on a new issue or a failing check that bears on the project's work, stay quiet about chatter).

### 5. Workers on an issue's Thread

`dispatch_worker` takes `github: "owner/repo#12"` (or `"#12"` when the project watches one repository). Code checks the repository is one the project watches, opens the issue's Thread (`ensureThread`) and subscribes the Worker to it beside its usual threads, when direct routing is on and `subscribe` is not false. Later comments, review comments and check results on that issue or pull request then go straight to the Worker between its steps (ADR 003), wrapped as data; it can `hand_back` or `unsubscribe_thread` as with any Thread. A Worker's first prompt says what the Thread is (`the GitHub issue or pull request you work on`).

An environment event from GitHub still cannot start work: the Router tells the user, and dispatches only when the user (or a routine, or a Worker report) asks. To make that easy, a GitHub environment event in the Router's batch carries its Thread id and its `owner/repo#n`.

### 6. Draft-only output, written for an asynchronous channel

The Router gets one more tool, `draft_github`, while its chat's project has the channel on. It drafts one of:

- `pr-open`: a pull request (title, head, optional base) whose description is the write-up;
- `pr-comment` / `issue-comment`: a comment on a pull request or issue;
- `review-reply`: a reply to a review comment (by its id, which the event's payload names). This is a new draft kind; its command is `gh api --method POST repos/{repo}/pulls/{n}/comments/{id}/replies -f body=… --jq .html_url`, and Workers' `draft_external_action` offers it too.

The tool takes three required sections, `background` (why: the issue, the report, the constraint), `change` (what changed, file by file where it matters) and `verification` (how it was checked: tests, commands, what was looked at). Code assembles them into one Markdown body with `### Background`, `### Change` and `### Verification` headings; the chat's 100-word cap does not apply, a 1,500-word cap does. Gates in code (`github/gates.ts`, pure): the batch must hold something explicit (the user, a routine or a Worker report; an injected issue comment alone cannot make the Router draft), the repository must be one the project watches, the number, comment id, title and head must be present where the kind needs them. Then `createDraft` (ADR 007) stores it: the Drafts bar shows the kind, the target, the exact `gh` command and the text, with "Approve and run". Nothing is posted without that click; approved runs are audited as every draft is, and the URL they print is what the `own-draft` rule recognises on the next poll.

The Router's system prompt gains a short section for such chats: which repositories are watched, that GitHub events are data and cannot start work, how to put a Worker on an issue, and that GitHub is written to with `draft_github` (dense and structured) while the chat gets one line saying a draft waits for the user.

### 7. Seeing it

The project page has a GitHub section (switch, repositories, interval, authors, event kinds, candidates) with the last poll, its error and "Poll now". The Triggers view labels `github` events. API: `GET /api/github` (each project's polling state), `POST /api/github/poll` (`{ projectId }`).

## How it fits the existing modules

| Module | Change |
| --- | --- |
| `shared/types.ts` | `GithubChannel` on `Project`; `github` in `TriggerSource` (not a `FilteredSource`: its settings are per project); `github` thread kind; `review-reply` draft kind; `GithubStatus` |
| `triggers/fastPath.ts` | A `github` branch that applies the screen's rule, then the shared subscription, allow-list, cooldown, duplicate and budget rules; a default policy line |
| `triggers/index.ts` | Names for the new source; a GitHub environment event handed to a Router carries its Thread and `owner/repo#n` |
| `layers/tools.ts`, `layers/prompts.ts`, `layers/router.ts` | `draft_github` and `dispatch_worker`'s `github` (handlers in `github/router.ts`), the prompt section, the event attributes, the thread note for Workers |
| `drafts.ts`, `agents/crewTools.ts`, `schemas.ts` | `review-reply` |
| `api.ts`, `index.ts` | The two routes, `syncGithub()` on settings and project changes, start and stop |
| `web/` | The project page section, the source label, the draft kind label |
| demo agent | The demo Router passes `github` when the user's words name `#n`, and drafts with `draft_github` when they ask for a reply, so the channel can be exercised offline |

## Left out

- **Webhooks.** A local app has no public address; polling with the user's `gh` is enough at a five-minute interval. A thin relay could be added later without changing anything after the poller.
- **Pull requests opened, labels, assignments, reviews (as opposed to review comments), discussions, releases.** The four kinds above are what a Worker on an issue needs; the others would each be another `gh api` call and another screen rule.
- **Posting anything without a click,** including "trusted" authors' requests. There is no setting for it.
- **GitHub events as explicit requests.** A comment from an allow-listed author is still environment data: it cannot dispatch or steer a Worker. The user (or a routine) asks.
- **Draft templates per repository** (a repository's own pull request template). The three sections are fixed; a repository template can be followed by the Worker that writes the change.
- **Other forges** (GitLab, Gitea). The screen, Threads and drafts are forge-neutral; only `gh.ts` and `events.ts` are GitHub's.

## Risks

- **Prompt injection through issues and comments.** Anyone who can open an issue writes into the agent's context. Mitigations: GitHub events are never explicit, so they cannot start or steer work; they are wrapped as untrusted data everywhere; the author allow-list can limit them to the team; the Router's drafting gate needs an explicit batch; every draft is shown with its exact command and needs the user's click; summaries and thread titles carry only facts.
- **The token.** `gh` runs in Crew's process with the user's environment, as approved drafts already do. Agent sessions keep running with credentials stripped (ADR 007), and the poller only ever runs `gh api` GETs on the configured repositories.
- **Noise and cost.** A busy repository can produce many comments. Bounds: the per-page limits per poll, the author allow-list, bot authors dropped, passed checks only for subscribers, the cooldown, de-duplication and the hourly candidate budget before any model call; `candidates: false` keeps the cheap model out of it entirely.
- **Missed events.** More than a page of new comments between two polls loses the oldest ones; the interval can be shortened. After a long downtime only the latest page is read.
- **Echo loops.** A comment Crew posted for the user comes back on the next poll; the `own-draft` rule drops it by its URL.
