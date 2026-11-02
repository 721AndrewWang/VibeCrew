# ADR 103: Channel norms: output shaped for the surface it goes to

Status: accepted (design notes section 3, "per-channel output")

## Context

The design notes ask for output that fits its channel: chat-like channels get short, low-interruption messages (a hard cap such as 100 words; only decisions and acceptance requests), asynchronous channels (pull requests, issues, docs) get structured, dense write-ups, and verbose reasoning stays inside Workers.

After milestones 1-7 and 9 (ADR 010) Crew had one piece of this: the Router's `reply` tool refuses more than 100 words (ADR 002). Everything else was left to the prompt:

- A 90-word reply could still be a pasted stack trace, a diff hunk, a fenced log, or an `<untrusted>` block copied from an event: the word cap does not see shape, and those are exactly the "details" that should stay inside Workers.
- Nothing said what a reply *is*. A question and a status line look the same in the chat, and nothing outside the chat could tell which messages need the user.
- A Worker's full report reaches only the Router (and the Workers bar). The Router's few words about it had no link back to it, so "the full report one click away" meant opening the Workers bar, finding the Worker and opening its transcript; and once the Worker was dismissed, the report was gone from the chat altogether.
- Drafts (ADR 007: pull requests, issues, comments, messages) took any body. A PR description written like a chat message ("Done, fixed it") or a 2,000-line pasted log went to the approval card as is.
- The only way to hear from a Router away from Crew was the desktop notification (and Bark, for approvals only). Teams that live in Slack or Feishu had no way to get "the Router needs you" there.

## Decision

A **channel profile** per output surface, enforced in code at the one place each surface is written, in a new module `server/channels/`. The profiles are data plus pure checks (`channels/profiles.ts`); the places that write to a surface call them.

### 1. The chat profile (in-app chat, Router replies)

| Rule | Value | Where it is enforced |
| --- | --- | --- |
| Word cap | 100 words (CJK characters count one each, as before) | `reply` (refused, the model rewrites) |
| Line cap | 6 non-empty lines | `reply` |
| Kinds | `decision` (what was decided or started, and what came of it), `question` (something only the user can answer; must contain a question mark), `acceptance` (finished work the user should check and accept) | `reply` takes `kind`, default `decision`; stored on the message |
| No tool output | refused: fenced code blocks, diff hunks (`diff --git`, `@@ … @@`, `+++ b/`), stack traces (`at f (file:1:2)`, `Traceback (most recent call last)`, `File "…", line N`), log output (two or more lines starting with a timestamp or a log level, or `npm ERR!`), shell transcripts (`$ cmd` lines), Crew's and Claude Code's prompt tags (`<untrusted`, `<event`, `<workers`, `<direct`, `<context`, `<job_output`, `<tool_use_error`, `<system-reminder`…), and unbroken tokens over 120 characters (minified code, base64; links may be longer). Each is also recognised flattened into one line (a fence, a stack frame, a hunk header or a timestamped log level in the middle of a line), because that is how a report reads once the Router's batch cuts it to its first words | `reply` |
| Details | Worker reports behind a "Details" expander | `reply` attaches them; the UI renders them collapsed |

Each refusal says what to drop and that the details are already attached, so the model's retry is shorter, not a paraphrase of the same log. Inline code (`npm test`, a file name) stays allowed: it names things, it does not paste them.

**Worker reports, summarised with the full report one click away.** A Router turn's batch knows which Worker reports it carries. `reply` takes an optional `about` (Worker ids); without it, the batch's reports not yet attached in this turn go on the first reply. Each becomes a `ReportDetail` on the message: the Worker's id, title, member, status, a deterministic **gist** (the report's first sentences, with code blocks and tool output removed, at most 30 words), the full report (capped at 20,000 characters) and what Crew did with its changes (the landing line). The chat shows the Router's ≤100 words; under them a collapsed "Details" row per Worker with its gist; one click opens the full report rendered as Markdown, and a second button opens the Worker's transcript while the Worker exists. The snapshot is kept on the message, so the report stays one click away after the Worker is dismissed and its record swept.

Details are UI only. Every prompt path that reads chat messages (the Router's recap, `chat_history`, recall, bots' context) reads `text` / `prompt`, never `channel`, so a report attached to a reply is not fed back into any model's context through the chat. That is what keeps "verbose reasoning stays inside Workers" true in both directions.

### 2. The asynchronous profiles (drafts)

Drafts made by agents through `draft_external_action` (ADR 007) are checked and shaped before they are saved. Drafts the user writes by hand (`POST /api/drafts`) are the user's words and are not touched.

| Profile | Draft kinds | Words | Structure required when the body is over 60 words | Shaping |
| --- | --- | --- | --- | --- |
| `pull-request` | `pr-open` | 1,500 | Markdown headings, at least two, one of them a test section (`Testing`, `Test plan`, `Tests`, `Verification`, `How to test`, `How I tested`) | Long output folded |
| `issue` | `issue-open` | 1,500 | At least one heading or list | Long output folded |
| `release-notes` | `message` whose channel names a release (`release`, `changelog`) | 1,200 | At least one list | Long output folded |
| `comment` | `pr-comment`, `issue-comment` | 600 | none | Long output folded |
| `message` | other `message` drafts (Slack, mail: chat-like surfaces) | 150 | none; no tool output at all (the chat rule) | none |

For every asynchronous profile except `message`, tool output is allowed but only **inside a fenced code block**: a stack trace, a diff or a log outside a fence is refused ("put it in a fenced block"). Shaping is deterministic: trailing spaces trimmed, three or more blank lines collapsed to one, Crew's prompt tags refused, and a fenced block longer than 15 lines folded into `<details><summary>Output (N lines)</summary> … </details>`, which GitHub renders collapsed: dense up top, the evidence one click away, the same pattern as the chat.

The tool's description carries the short version of the table, so the agent writes in the right shape the first time; the refusal names the missing section.

### 3. The webhook channel (optional, off by default)

A project can register one outgoing webhook for **Router notifications**: a Slack incoming webhook or a Feishu custom bot URL.

- **Where it lives.** `settings.webhooks[projectId]` in `settings.json`, not in `projects.json`: the URL is a credential (anyone holding it can post), and `settings.json` is the file the command guard already refuses to every agent (ADR 007, rule `credentials`). The API returns only the host and a masked path. A chat in a workspace (or a Worker's workspace) uses its root project's webhook.
- **Off by default, enabled only by the user.** Saving a URL never enables it. Enabling it is the approval: the user turns it on in the project page next to a preview of exactly what a notification looks like, with the kinds they approve. Changing the URL or the format turns it off again. A "Send test" button posts a fixed test line on the user's click.
- **Only what the user approved.** Only Router `reply` messages, only of the approved kinds (default: `question` and `acceptance`, the ones that need the user; `decision` is opt-in), only in chats bound to that project. Nothing else ever goes out through it: no Worker reports, no details, no system notes, no drafts, no Watchdog notices, no bot turns of chats outside two-layer mode.
- **Never file contents.** The payload is built from the reply's text, which already passed the chat profile's tool-output check, and is filtered again in the webhook module: code blocks dropped, inline code over 40 characters replaced by `…`, any line the tool-output check flags dropped, cut to 100 words. The payload has the chat's title, the speaker's name, the kind and that text: no `details`, no paths beyond what the user-facing sentence names, no attachments.
- **Formats.** Slack: `{ "text": "…" }` (mrkdwn). Feishu: `{ "msg_type": "text", "content": { "text": "…" } }`. Both are plain JSON POSTs; Crew sends them itself (5 s timeout, no retries), not through an agent, so the sandbox and the guard are not in the path, and a failure is logged and shown in the project page's recent deliveries (kept in memory, last 20). A failed delivery never affects the chat.

## Data model

```ts
type ReplyKind = 'decision' | 'question' | 'acceptance';

interface ReportDetail {        // a Worker report attached to a Router reply
  workerId: ID; title: string; bot: string;
  status: 'done' | 'error' | 'stopped';
  gist: string;                 // ≤30 words, no code or tool output
  report: string;               // full text, ≤20,000 characters
  landing?: string;             // what Crew did with its changes
  at: number;
}

interface ChatMessage { /* existing fields */ channel?: { kind: ReplyKind; details?: ReportDetail[] } }

type WebhookFormat = 'slack' | 'feishu';
interface WebhookConfig {       // settings.webhooks[projectId] (settings.json; never sent to the UI)
  url: string; format: WebhookFormat; enabled: boolean; kinds: ReplyKind[]; approvedAt?: number;
}
interface WebhookInfo {         // what the API shows
  projectId: ID; configured: boolean; host: string; masked: string;
  format: WebhookFormat; enabled: boolean; kinds: ReplyKind[]; approvedAt?: number;
  deliveries: WebhookDelivery[];
}
interface WebhookDelivery { at: number; kind: ReplyKind | 'test'; chatId?: ID; messageId?: ID; ok: boolean; status?: number; error?: string; text: string }
```

All fields are optional or get defaults when missing (`webhooks` defaults to `{}`), so no migration is needed.

API (registered by `channels/api.ts`): `GET /api/projects/:id/webhook`, `PUT /api/projects/:id/webhook` (`{ url?, format?, enabled?, kinds? }`), `DELETE /api/projects/:id/webhook`, `POST /api/projects/:id/webhook/test`, and `POST /api/channels/check` (dry run of a profile on a text, used by tests and the project page's preview).

## How it fits the existing modules

- `server/channels/` (new): `profiles.ts` (pure: the profiles, `toolOutputIn`, `chatRefusal`, `reportGist`, `asyncProfileFor`, `asyncRefusal`, `shapeAsync`, `webhookText`), `details.ts` (a Worker's `ReportDetail`), `webhook.ts` (config, payloads, delivery, the in-memory delivery log), `api.ts` (routes), `index.ts`.
- `server/layers/gates.ts`: `replyRefusal(text, kind?)` delegates to `chatRefusal`; its existing word-cap wording is unchanged.
- `server/layers/tools.ts`: `reply` takes `kind` and `about`, attaches details, and hands the posted message to the webhook. `TurnCtx` gains `reports` (the batch's Worker ids) and `attached`.
- `server/layers/router.ts`: fills `reports` from the batch.
- `server/layers/prompts.ts`: the Router's `reply` bullet names the kinds, the no-tool-output rule and the attached details.
- `server/agents/crewTools.ts`: `draftAction` runs the asynchronous profile before `createDraft`; the tool's description lists the shapes.
- `server/agents/session.ts`: the demo Router passes a kind (acceptance when a Worker finished, else decision), strips prompt tags from what it quotes, and retries once, shorter and plainer, when a reply is refused, as a model would.
- `server/store.ts`: `Settings.webhooks`, normalised at load.
- `shared/types.ts`: the types above.
- UI: `Message.tsx` shows a reply's kind (a "Question" or "Needs your OK" label; decisions show none) and `ReportDetails` (collapsed rows, the full report, "Open transcript"); the project page gets a "Router notifications" block (`ProjectWebhook.tsx`).

## How it is measured

`tests/integration/channel-norms.test.ts` runs a fixture conversation with the real Claude Code and the mock model (the harness the other integration tests use): the Worker reads a file with a tool and pastes the tool's output, a stack trace and a log into its report, then drafts a pull request twice (first unstructured with a loose stack trace, then in sections); the mock Router first passes the report on verbatim, later rambles past 100 words, and retries after each refusal. The test asserts that every message the chat shows fits the profile (word and line caps, `toolOutputIn` finds nothing, no byte of the file the tool read), that both bad replies were refused in the Router's log, that the full report (tool output included) is under Details of the acceptance request with a clean gist, that the webhook received exactly the approved kinds and no tool output, and that only the structured draft was saved, with its long output folded. Writing this test found a real gap in the first version: the Router's batch flattens a report onto one line, which hid a code fence and a stack trace from line-anchored checks; the checks now read flattened text too. `tests/integration/channels.test.ts` covers the same flow in demo mode (no CLI), and `tests/unit/channels.test.ts` the pure checks on both sides (what is refused, and what must pass: inline code, links, times, lists).

## What is left out

- **Other bots' output in normal chats.** Outside two-layer mode, bots still talk in the chat directly with their tool rows visible, as before; the chat profile applies to the Router, which is the only voice in two-layer mode. Applying it to direct chats would change Crew's default behaviour.
- **System notes Crew posts** (draft results, the Watchdog in chats without a Router) keep their current shape. They are short already; the draft-failure note's output tail is a candidate for a details row later.
- **Signed webhooks** (Feishu's signature secret, Slack apps with OAuth), threads, buttons that answer a question from Slack, and incoming webhooks (talking back to the Router from Slack). One-way notifications first; a reply path is a new trigger source with its own injection risk.
- **Per-chat webhooks** and several webhooks per project.
- **An audit entry per delivery.** Deliveries are in memory (last 20) and in the server log; the audit log stays about drafts and the guard.
- **A model-written summary** of a Worker report for the details row. The gist is deterministic (first sentences, cleaned) and costs nothing; the Router's own reply is the model-written summary.
- **A semantic leak check.** The tool-output check reads shape, not meaning: a model can still paraphrase a log in prose. The word and line caps bound that.

## Risks

- **False refusals in chat.** A reply that legitimately needs a command the user should run (`git push origin main`) is inline code and passes; a three-line shell snippet in a fence is refused. The refusal says to name the command inline or leave it in the report. The checks are unit-tested on both sides.
- **Retry loops.** A model that keeps pasting output keeps getting refused; each refusal costs a call. The Router's other bounds (the turn ends, the batch is not re-run) still apply, and the demo agent and the measured test show a single retry is enough with the refusal's wording.
- **Webhook URL exposure.** The URL is a secret and is kept where agents cannot read it; the UI and the API show only the host. A user who pastes it into a chat has shared it with the bots; nothing Crew can do about that.
- **Sending to a third party.** A Router reply goes to Slack or Feishu: chat titles and the reply's words leave the machine. It is off by default, per project, enabled only by the user, limited to the kinds they picked, and never carries file contents or reports.
- **Drafts the profile shapes.** Folding long output into `<details>` changes the body the agent wrote; the approval card shows the shaped body, which is what runs.
- **Prompt drift.** The Router's system prompt grows by one bullet (three sentences); the `reply` tool's description by two sentences and the draft tool's by one.
