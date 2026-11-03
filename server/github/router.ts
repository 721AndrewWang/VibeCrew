// The Router's side of the GitHub channel (ADR 102): drafting for GitHub (draft_github) and
// putting a Worker on an issue's thread (dispatch_worker's github). The gates are in gates.ts.

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Bot, Chat, GithubChannel, Project } from '../../shared/types';
import type { ToolResult } from '../agents/toolResult';
import { asyncProfileFor, asyncRefusal, shapeAsync } from '../channels/profiles';
import { createDraft, showCommand } from '../drafts';
import { chatProjectId } from '../projects';
import { projects, settings } from '../store';
import { ensureThread } from '../triggers';
import { activeChannel, parseIssueRef } from './config';
import { asyncBody, canonicalRepo, GITHUB_DRAFT_KINDS, type GithubDraftArgs, githubDraftRefusal } from './gates';
import { githubThread } from './threads';

/** The chat's project (a workspace counts as its parent). */
function rootProject(chat: Chat): Project | undefined {
  const p = projects.get(chat.projectId);
  return p?.workspace ? projects.get(p.workspace.parentId) : p;
}

/** The chat's GitHub channel while its project polls, else null. */
export function githubChannelOf(chat: Chat): { project: Project; conf: GithubChannel } | null {
  const project = rootProject(chat);
  const conf = activeChannel(project, settings.get().superAgent);
  return project && conf ? { project, conf } : null;
}

/** The thread of the issue or pull request dispatch_worker's github names, opened if new; or why not. */
export function issueThread(chat: Chat, ref: string): { threadId: string; ref: string } | { error: string } {
  const ch = githubChannelOf(chat);
  if (!ch) return { error: "This chat's project does not watch GitHub (its project page has the GitHub channel). Name the issue in the task instead." };
  const r = parseIssueRef(ref, ch.conf.repos);
  if ('error' in r) return r;
  const th = ensureThread(githubThread(ch.project, r.repo, r.number));
  return { threadId: th.id, ref: `${r.repo}#${r.number}` };
}

/** draft_github's handler: a structured write-up stored as a draft; nothing is posted until the user approves it. */
export async function draftGithub(c: { chatId: string; lead: Bot; explicit: boolean }, chat: Chat, args: GithubDraftArgs): Promise<ToolResult> {
  const ch = githubChannelOf(chat);
  if (!ch) return { text: "This chat's project does not watch GitHub.", isError: true };
  const refused = githubDraftRefusal(args, { explicit: c.explicit, repos: ch.conf.repos });
  if (refused) return { text: refused, isError: true };
  const cwd = projects.get(chatProjectId(chat))?.path || ch.project.path;
  // GitHub is an asynchronous channel (ADR 103): the assembled body meets its surface's profile and is shaped like any agent's draft.
  const kind = args.kind as (typeof GITHUB_DRAFT_KINDS)[number];
  const profile = asyncProfileFor(kind);
  let body = asyncBody(args);
  if (profile) {
    const shapeRefused = asyncRefusal(profile, body);
    if (shapeRefused) return { text: `The draft was not saved: ${shapeRefused}`, isError: true };
    body = shapeAsync(profile, body);
  }
  try {
    const d = await createDraft(
      {
        kind,
        repo: canonicalRepo(args.repo, ch.conf.repos),
        number: args.number,
        comment: args.comment,
        title: args.title,
        head: args.head,
        base: args.base,
        body,
        why: args.why,
      },
      { chatId: chat.id, botId: c.lead.id, cwd },
    );
    return {
      text: [
        `Draft ${d.id} saved for the user: ${d.target}.`,
        `Exact command it will run when approved: ${showCommand(d.command)}`,
        'Nothing is posted until the user approves it in Crew. Tell them in one line that it waits for them.',
      ].join('\n'),
    };
  } catch (e) {
    return { text: `The draft was not saved: ${(e as Error).message}`, isError: true };
  }
}

type Wrap = (name: string) => (args: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;

/** draft_github as Claude Code sees it. */
export function draftGithubTool(wrap: Wrap) {
  return tool(
    'draft_github',
    "Draft a write-up for GitHub, an asynchronous channel: a pull request (its description), a comment on an issue or pull request, or a reply to a review comment. Crew assembles background, change and verification into one structured body, builds the exact gh command and shows both to the user, who approves or discards it with one click; it never posts on its own. Only when the user, a routine or a Worker's report asks for it.",
    {
      kind: z.enum(GITHUB_DRAFT_KINDS).describe('pr-open, pr-comment, issue-comment, or review-reply'),
      repo: z.string().describe('owner/name: one of the repositories this project watches'),
      number: z.number().int().optional().describe('The issue or pull request number (all but pr-open)'),
      comment: z.number().int().optional().describe('review-reply: the id of the review comment (the event names it)'),
      title: z.string().max(300).optional().describe('pr-open: the title'),
      head: z.string().max(200).optional().describe('pr-open: the pushed branch with the changes'),
      base: z.string().max(200).optional().describe('pr-open: the branch to merge into (default: the repository default)'),
      background: z.string().describe('Why: the issue, the report or the constraint behind it'),
      change: z.string().describe('What changed, file by file where it matters'),
      verification: z.string().describe('How it was checked: tests, commands, what was looked at, what was not'),
      why: z.string().max(1000).optional().describe('One sentence for the user: why this should go out'),
    },
    wrap('draft_github'),
  );
}
