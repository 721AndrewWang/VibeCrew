import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConsoleEntry } from '../../shared/types';
import { act, consoleCheck, debugTarget, screenshot } from '../browser';
import { notify } from '../bus';
import { devServer } from '../devserver';
import { bots, messages } from '../store';
import { appendMemory } from './prompts';

export interface CrewContext {
  botId: string;
  botName: string;
  chatId: string;
  projectId: () => string | null;
  /** The page the user is looking at in the preview. */
  currentPage: () => string | undefined;
  /** A blind reviewer: chat_history shows it the user's messages only. */
  blind?: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

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

export function crewServer(ctx: CrewContext) {
  const projectId = () => {
    const id = ctx.projectId();
    if (!id) throw new Error('This conversation is not linked to a project');
    return id;
  };
  const pagePath = (p?: string) => p || ctx.currentPage() || '/';

  return createSdkMcpServer({
    name: 'crew',
    version: '1.0.0',
    tools: [
      tool(
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
            return text(`Page ${where} (HTTP ${r.status}, ${r.title || 'untitled'}), ${r.logs.length} log entr${r.logs.length === 1 ? 'y' : 'ies'}:\n${fmtLogs(r.logs, 60)}`);
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
              key: `${ctx.chatId}:${ctx.botId}`,
              projectId: projectId(),
              path: args.path,
              steps: args.steps,
              screenshot: args.screenshot,
              device: args.device,
              colorScheme: args.colorScheme,
            });
            const where = r.url.replace(/^https?:\/\/[^/]+/, '') || '/';
            const summary = [...r.lines, '', `Current page: ${where} (${r.title || 'untitled'})`, r.logs.length ? `Console logs meanwhile:\n${fmtLogs(r.logs)}` : 'No console logs meanwhile.'].join(
              '\n',
            );
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
            const r = await debugTarget({ key: `${ctx.chatId}:${ctx.botId}`, projectId: projectId(), path: args.path, device: args.device, colorScheme: args.colorScheme });
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
      tool(
        'remember',
        "Save something worth keeping to your long-term memory (kept across conversations), such as the user's preferences, project conventions, or pitfalls you hit. One note at a time, short and specific.",
        { note: z.string().describe('What to remember') },
        async ({ note }) => {
          appendMemory(ctx.botId, note);
          return text('Saved.');
        },
      ),
      tool(
        'notify_user',
        'Send the user a desktop or phone notification. Use it when a scheduled or long-running task finds something the user should look at.',
        { title: z.string(), body: z.string() },
        async ({ title, body }) => {
          notify(`${ctx.botName}: ${title}`, body, { chatId: ctx.chatId, level: 'info' });
          return text('Notification sent.');
        },
      ),
    ],
  });
}
