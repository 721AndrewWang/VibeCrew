import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConsoleEntry } from '../../shared/types';
import { act, consoleCheck, debugTarget, screenshot } from '../browser';
import { notify } from '../bus';
import { asyncGuide, asyncProfileFor, asyncRefusal, shapeAsync } from '../channels/profiles';
import { devServer } from '../devserver';
import { createDraft, type DraftFields, showCommand } from '../drafts';
import { type JobHost, jobTools } from '../jobs/tools';
import { ANSI } from '../procs';
import { RECALL_TOOL, recallText } from '../recall';
import { bots, messages, projects } from '../store';
import { untrusted } from '../untrusted';
import { appendMemory } from './prompts';
import type { ToolHandler } from './toolResult';

export interface CrewContext {
  botId: string;
  botName: string;
  chatId: string;
  projectId: () => string | null;
  /** The page the user is looking at in the preview. */
  currentPage: () => string | undefined;
  /** A blind reviewer: chat_history shows it the user's messages only. */
  blind?: boolean;
  /** Keys its browser_act page; default chat:bot. A Worker has its own. */
  actKey?: string;
  /** A Worker (two-layer mode) never talks to the user, so it gets no notify_user. */
  worker?: boolean;
  /** A Worker with subscriptions on (ADR 003): leaving a thread, or giving an event back to the Router. Each returns what to tell the model, or throws. */
  threads?: { unsubscribe(threadId: string): string; handBack(threadId: string, triggerId?: string, note?: string): string };
  /** The chain of recall (ADR 005): recall(id) takes the place of chat_history. */
  recall?: boolean;
  /** Full duplex (ADR 004): the start/stop/status tools, for a bot with fullDuplex on. Workers and sub-tasks never get them. */
  jobs?: JobHost;
  /** The Worker's id, for drafts and the audit log (ADR 007). */
  workerId?: string;
  /**
   * A speculative run (ADR 008): it reports its claim through speculative_result, and gets no tool
   * that reaches the user, writes long-term memory or drafts anything in the user's name.
   */
  speculative?: { result(args: SpeculativeClaimArgs): string };
}

export interface SpeculativeClaimArgs {
  reproduced: boolean;
  testFiles: string[];
  summary: string;
}

/** draft_external_action's handler (also the demo agent's): saves a draft; nothing runs until the user clicks. */
export async function draftAction(ctx: Pick<CrewContext, 'botId' | 'chatId' | 'projectId' | 'workerId'>, args: DraftFields): Promise<{ text: string; isError?: boolean }> {
  const cwd = projects.get(ctx.projectId())?.path;
  if (!cwd && args.kind !== 'message') return { text: 'This conversation has no project folder to run that in.', isError: true };
  // The asynchronous profile (ADR 103): a draft is written for its surface, dense and structured.
  const profile = asyncProfileFor(args.kind, args.channel);
  if (profile && args.body?.trim()) {
    const refused = asyncRefusal(profile, args.body);
    if (refused) return { text: `The draft was not saved: ${refused}`, isError: true };
    args = { ...args, body: shapeAsync(profile, args.body) };
  }
  try {
    const d = await createDraft(args, { chatId: ctx.chatId, botId: ctx.botId, workerId: ctx.workerId, cwd: cwd || '' });
    return {
      text: [
        `Draft ${d.id} saved for the user: ${d.target}.`,
        d.command ? `Exact command it will run when approved: ${showCommand(d.command)}` : 'The user will post it themselves.',
        "It does not run until the user approves it in Crew, so don't wait for it and don't try to do it another way. Say in your reply that it is waiting for their approval.",
      ].join('\n'),
    };
  } catch (e) {
    return { text: `The draft was not saved: ${(e as Error).message}`, isError: true };
  }
}

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

function fail(t: string) {
  return { content: [{ type: 'text' as const, text: t }], isError: true };
}

function fmtLogs(logs: ConsoleEntry[], limit = 40): string {
  const order = { error: 0, warn: 1, info: 2, log: 3 } as const;
  const sorted = [...logs].sort((a, b) => order[a.level] - order[b.level]);
  const lines = sorted.slice(0, limit).map((l) => `[${l.level}] ${l.text}`);
  if (logs.length > limit) lines.push(`…and ${logs.length - limit} more`);
  return lines.join('\n');
}

const device = z.enum(['desktop', 'tablet', 'mobile']).optional().describe('Device size: desktop 1280×800, tablet 820×1180, mobile 390×844. Defaults to desktop.');
const colorScheme = z
  .enum(['light', 'dark'])
  .optional()
  .describe(
    'Color scheme: dark emulates the system dark mode (prefers-color-scheme: dark), so a page with a dark theme switches to it. Defaults to light. To check dark mode, always look with this; do not just infer it from the CSS.',
  );

const attempt = (fn: () => string) => {
  try {
    return text(fn());
  } catch (e) {
    return fail((e as Error).message);
  }
};

/** A Worker's way off a thread it was subscribed to when it was dispatched. */
function threadTools(t: NonNullable<CrewContext['threads']>) {
  return [
    tool(
      'unsubscribe_thread',
      'Stop receiving a thread\'s events (the thread id is on each <event> you get, thread="th_…"). Its later events go to the Router again.',
      { thread: z.string().describe('The thread id, th_…') },
      async ({ thread }) => attempt(() => t.unsubscribe(thread)),
    ),
    tool(
      'hand_back',
      'An event that came to you is outside your task: unsubscribe from its thread and give the event to the Router, which decides who handles it. Without event, the latest one you got from that thread goes back.',
      {
        thread: z.string().describe('The thread id, th_…'),
        event: z.string().optional().describe('The event id, tg_…'),
        note: z.string().max(500).optional().describe('For the Router, in a sentence: why it is not yours'),
      },
      async ({ thread, event, note }) => attempt(() => t.handBack(thread, event, note)),
    ),
  ];
}

export function crewServer(ctx: CrewContext) {
  const projectId = () => {
    const id = ctx.projectId();
    if (!id) throw new Error('This conversation is not linked to a project');
    return id;
  };
  const pagePath = (p?: string) => p || ctx.currentPage() || '/';

  const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
  const call = (h: ToolHandler) => async (args: Record<string, unknown>) => {
    const r = await h(args);
    return r.isError ? fail(r.text) : text(r.text);
  };

  return createSdkMcpServer({
    name: 'crew',
    version: '1.0.0',
    // Crew's own tools are few and its prompts name them: never deferred behind Claude Code's tool search.
    alwaysLoad: true,
    tools: [
      ctx.recall
        ? tool(
            'recall',
            RECALL_TOOL,
            {
              id: z.string().max(200).describe('The id to read: #12, chat, env, tg_…, th_…, wk_… or job_…'),
              from: z.number().int().min(0).optional().describe('Read on from this word, as a cut text says (from=N)'),
            },
            async ({ id, from }) => {
              const r = recallText(id, { chatId: ctx.chatId, blind: ctx.blind }, from);
              return 'error' in r ? fail(r.error) : text(r.text);
            },
            { annotations: { readOnlyHint: true } },
          )
        : tool(
            'chat_history',
            'Read messages in this conversation in full. In a group chat, older teammate messages that have little to do with this turn are shown only as a one-line summary (with a #number); use this to look up the details. It can also show the latest few messages.',
            {
              seqs: z.array(z.number().int()).max(20).optional().describe('Numbers of the messages to read (the number after # in a summary)'),
              last: z.number().int().min(1).max(20).optional().describe('Read this many of the latest messages'),
            },
            async ({ seqs, last }) => {
              const all = messages.sorted(ctx.chatId).filter((m) => !m.uiOnly && m.status !== 'streaming' && (!ctx.blind || m.role === 'user' || m.notice === 'outside-edit'));
              const picked = seqs?.length ? all.filter((m) => seqs.includes(m.seq)) : all.slice(-(last || 5));
              if (!picked.length) return fail('No such messages found.');
              const who = (m: (typeof all)[number]) => (m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : `@${bots.get(m.botId || '')?.name || 'teammate'}`);
              return text(picked.map((m) => `[${who(m)} · #${m.seq}]\n${(m.prompt || m.text).trim() || '(no text)'}`).join('\n\n'));
            },
            { annotations: { readOnlyHint: true } },
          ),
      tool(
        'preview_screenshot',
        'Open the project preview in a real browser and take a screenshot. Returns the image and a summary of console errors. Use it after changing the UI to check how it really looks. You can pick the page, the device size, a full-page shot, or just one element.',
        {
          path: z.string().optional().describe('Page path, such as / or /about. Defaults to the page the user is looking at.'),
          device,
          fullPage: z.boolean().optional().describe('Capture the full page (up to 3 screens tall)'),
          selector: z.string().optional().describe('Capture only the element matching this CSS selector'),
          colorScheme,
        },
        async (args) => {
          try {
            const r = await screenshot({ projectId: projectId(), path: pagePath(args.path), device: args.device, fullPage: args.fullPage, selector: args.selector, colorScheme: args.colorScheme });
            const issues = r.logs.filter((l) => l.level === 'error' || l.level === 'warn');
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            return {
              content: [
                { type: 'image' as const, data: r.png.toString('base64'), mimeType: 'image/png' },
                {
                  type: 'text' as const,
                  text: `Page ${where} (${r.title || 'untitled'}), ${args.device || 'desktop'}${args.colorScheme === 'dark' ? ', dark mode' : ''}${r.truncated ? ', long page so only the first 3 screens were captured' : ''}.\n${issues.length ? `Console issues:\n${fmtLogs(issues)}` : 'No console errors or warnings.'}`,
                },
              ],
            };
          } catch (e) {
            return fail(`Screenshot failed: ${(e as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'preview_console',
        'Open a project preview page in the browser and collect console logs, uncaught exceptions, and failed network requests.',
        {
          path: z.string().optional().describe('Page path. Defaults to the page the user is looking at.'),
          waitMs: z.number().optional().describe('How many milliseconds to keep collecting logs after the page loads. Defaults to 1500.'),
          colorScheme,
        },
        async (args) => {
          try {
            const r = await consoleCheck({ projectId: projectId(), path: pagePath(args.path), waitMs: args.waitMs, colorScheme: args.colorScheme });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            if (!r.logs.length) return text(`Page ${where} (HTTP ${r.status}, ${r.title || 'untitled'}): console is clean, no logs.`);
            return text(
              `Page ${where} (HTTP ${r.status}, ${r.title || 'untitled'}), ${r.logs.length} log entr${r.logs.length === 1 ? 'y' : 'ies'}:\n${untrusted('preview-console', fmtLogs(r.logs, 60), { page: where })}`,
            );
          } catch (e) {
            return fail(`Could not open the page: ${(e as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'browser_act',
        'Use the project preview like a real user: open pages, click, type, press keys, select, check, hover, wait, scroll, run scripts, and confirm the page contains some text. The page and login state are kept between calls. On a failure it stops and attaches a screenshot.',
        {
          path: z.string().optional().describe('Open this page path first. If empty, continue on the current page (the first call opens the page the user is looking at).'),
          steps: z
            .array(
              z.object({
                action: z.enum(['goto', 'click', 'fill', 'press', 'select', 'check', 'hover', 'wait', 'scroll', 'eval', 'expect_text']),
                selector: z.string().optional().describe('CSS selector'),
                text: z.string().optional().describe('Find the element by visible text, label, or placeholder (instead of selector). For expect_text, the text to confirm.'),
                value: z.string().optional().describe('The text for fill, the option for select, the path for goto, top/bottom/pixels for scroll, the JS expression for eval, true/false for check'),
                key: z.string().optional().describe('The key for press, such as Enter, Escape, Tab'),
                ms: z.number().optional().describe('Milliseconds to wait, or the timeout'),
              }),
            )
            .describe('Actions to run in order'),
          screenshot: z.boolean().optional().describe('Attach a screenshot when done'),
          device,
          colorScheme,
        },
        async (args) => {
          try {
            const r = await act({
              key: ctx.actKey ?? `${ctx.chatId}:${ctx.botId}`,
              projectId: projectId(),
              path: args.path,
              steps: args.steps,
              screenshot: args.screenshot,
              device: args.device,
              colorScheme: args.colorScheme,
            });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            // The steps' results quote the page (texts, eval output): outside content, wrapped (ADR 007).
            const summary = [
              untrusted('browser-page', r.lines.join('\n'), { page: where }),
              '',
              `Current page: ${where} (${r.title || 'untitled'})`,
              r.logs.length ? `Console logs meanwhile:\n${untrusted('preview-console', fmtLogs(r.logs), { page: where })}` : 'No console logs meanwhile.',
            ].join('\n');
            const content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] = [];
            if (r.png) content.push({ type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' });
            content.push({ type: 'text', text: summary });
            return { content, isError: r.failed || undefined };
          } catch (e) {
            return fail(`Browser action failed: ${(e as Error).message}`);
          }
        },
      ),
      tool(
        'browser_debug_target',
        'Get a DevTools protocol (CDP) endpoint and target id for your browser_act page, so analysis tools such as REA (mcp__rea__inspect_web_page, analyze_web_bundle, observe_web_session) can attach to it. It is the same page and state browser_act left; use browser_act first to get the page where you want it.',
        {
          path: z.string().optional().describe('Open this page path first. If empty, keep the current browser_act page (or open the page the user is looking at).'),
          device,
          colorScheme,
        },
        async (args) => {
          try {
            const r = await debugTarget({ key: ctx.actKey ?? `${ctx.chatId}:${ctx.botId}`, projectId: projectId(), path: args.path, device: args.device, colorScheme: args.colorScheme });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            return text(
              `cdp_endpoint: ${r.endpoint}\ntarget_id: ${r.targetId}\nPage: ${where} (${r.title || 'untitled'})\nScripts and requests under /__crew/ (such as /__crew/inject.js) are Crew's preview helper, not the project's code: leave them out of your analysis.\nThe endpoint changes if the browser restarts (it closes after 10 idle minutes); call this again if attaching fails.`,
            );
          } catch (e) {
            return fail(`Could not open the page: ${(e as Error).message}`);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        'dev_server',
        "Manage the project's dev server (the preview depends on it): start (installs missing dependencies automatically), stop, restart, status, or logs for recent output.",
        { action: z.enum(['start', 'stop', 'restart', 'status', 'logs']) },
        async ({ action }) => {
          try {
            const ds = devServer(projectId());
            if (action === 'stop') {
              await ds.stop();
              return text('Dev server stopped.');
            }
            if (action === 'start' || action === 'restart') {
              if (action === 'restart') await ds.restart();
              else await ds.start();
              const deadline = Date.now() + 120_000;
              while (Date.now() < deadline && (ds.state.status === 'installing' || (ds.state.status === 'starting' && !ds.state.url))) {
                await new Promise((r) => setTimeout(r, 500));
              }
            }
            const s = ds.state;
            const tail = ds
              .logs(action === 'logs' ? 6000 : 1500)
              .replace(ANSI, '')
              .replace(/\r/g, '');
            const status = { stopped: 'not running', installing: 'installing dependencies', starting: 'starting', running: 'running', error: 'error' }[s.status];
            return text(
              `Status: ${status}${s.command ? `\nCommand: ${s.command}` : ''}${s.url ? `\nURL: ${s.url}` : ''}${s.error ? `\nError: ${s.error}` : ''}${tail.trim() ? `\n\nRecent logs:\n${tail.trim()}` : ''}`,
            );
          } catch (e) {
            return fail((e as Error).message);
          }
        },
      ),
      ...(ctx.speculative
        ? [
            tool(
              'speculative_result',
              "Report how your speculative run went; call it once, at the end. Crew then checks it in code: the project's check command must pass with your fix, and must fail with your fix taken out and your reproduction kept. Only then does the user see your fix; otherwise it is discarded without a word.",
              {
                reproduced: z.boolean().describe('Whether you reproduced the problem (a check that fails because of it)'),
                testFiles: z
                  .array(z.string())
                  .describe('The files of your reproduction: the failing test you added or changed (paths relative to your working directory). Everything else you changed counts as the fix.'),
                summary: z.string().describe('For the user, at most 80 words: the cause, and what the fix changes'),
              },
              async (args) => {
                try {
                  return text(ctx.speculative!.result(args as SpeculativeClaimArgs));
                } catch (e) {
                  return fail((e as Error).message);
                }
              },
            ),
          ]
        : []),
      ...(ctx.speculative
        ? []
        : [
            tool(
              'remember',
              "Save something worth keeping to your long-term memory (kept across conversations), such as the user's preferences, project conventions, or pitfalls you hit. One note at a time, short and specific.",
              { note: z.string().describe('What to remember') },
              async ({ note }) => {
                appendMemory(ctx.botId, note);
                return text('Saved.');
              },
            ),
          ]),
      ...(ctx.threads ? threadTools(ctx.threads) : []),
      ...(jobs
        ? [
            tool(
              'start',
              'Start a long-running shell command (a build, a test suite, an install, a migration) or a sub-task in the background, and return at once with its job id. Its result arrives later as a new message: the first and last lines of the output, with the full log readable through status. Use it for anything that may take more than about 30 seconds, instead of Bash. A command runs in your working directory under the same rules as Bash (blocked actions, approval, sandbox). Not for dev servers: use dev_server.',
              {
                command: z.string().optional().describe('The shell command to run (bash -c). Give command or task, not both.'),
                task: z
                  .string()
                  .optional()
                  .describe(
                    'A sub-task for a background session of you, with the same tools and rules (it cannot start jobs itself): investigation or a check you do not need to watch. It shares your folder, so do not give it edits that overlap yours.',
                  ),
                title: z.string().optional().describe('A few words saying what it is, shown to the user'),
                timeoutMin: z.number().optional().describe('Stop it after this many minutes (default 60, at most 720; a sandboxed command at most 10)'),
              },
              call(jobs.start),
            ),
            tool(
              'stop',
              'Stop a background job you started (a command is terminated with its child processes). Returns its output so far.',
              { id: z.string().describe('The job id (job_…)') },
              call(jobs.stop),
            ),
            tool(
              'status',
              "List this chat's background jobs, or show one job's status and output (head and tail). With from/lines, read that slice of its full log.",
              {
                id: z.string().optional().describe('A job id; leave empty to list the jobs'),
                from: z.number().int().optional().describe('First line to read (1-based)'),
                lines: z.number().int().optional().describe('How many lines to read (at most 400)'),
              },
              call(jobs.status),
              { annotations: { readOnlyHint: true } },
            ),
          ]
        : []),
      ...(ctx.speculative
        ? []
        : [
            tool(
              'draft_external_action',
              `Draft an action that would leave this machine in the user's name: push a branch, open a pull request or issue, comment on one, or send a message. Crew builds the exact command from these fields and shows it to the user, who approves or discards it with one click; it never runs on its own. This is the only way to do these things: Crew's command guard refuses git push, gh pr create and the like. ${asyncGuide()}`,
              {
                kind: z.enum(['git-push', 'pr-open', 'pr-comment', 'issue-open', 'issue-comment', 'review-reply', 'message']).describe('What to do'),
                remote: z.string().optional().describe('git-push: the remote (default origin)'),
                branch: z.string().optional().describe('git-push: the branch on the remote to push HEAD to (default: the current branch)'),
                number: z.number().int().optional().describe('pr-comment / issue-comment / review-reply: the number'),
                comment: z.number().int().optional().describe('review-reply: the id of the review comment to reply to'),
                title: z.string().optional().describe('pr-open / issue-open: the title'),
                body: z.string().optional().describe('The text: PR description, issue body, comment, or message'),
                base: z.string().optional().describe('pr-open: the branch to merge into'),
                head: z.string().optional().describe('pr-open: the branch with the changes'),
                repo: z.string().optional().describe('owner/name, when it is not the current repository (required for review-reply)'),
                channel: z.string().optional().describe('message: where it goes (a person, a channel, a mailing list)'),
                why: z.string().optional().describe('One sentence for the user: why this should go out'),
              },
              async (args) => {
                const r = await draftAction(ctx, args as DraftFields);
                return r.isError ? fail(r.text) : text(r.text);
              },
            ),
          ]),
      ...(ctx.worker
        ? []
        : [
            tool(
              'notify_user',
              'Send the user a desktop or phone notification. Use it when a scheduled or long-running task finds something the user should look at.',
              { title: z.string(), body: z.string() },
              async ({ title, body }) => {
                notify(`${ctx.botName}: ${title}`, body, { chatId: ctx.chatId, level: 'info' });
                return text('Notification sent.');
              },
            ),
          ]),
    ],
  });
}
