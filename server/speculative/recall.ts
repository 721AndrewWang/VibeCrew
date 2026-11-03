// Speculative runs in the chain of recall (ADR 005 × 008, ADR 110). The Router's event about a
// verified fix names its run (sp_…); recall resolves it in the compact Inline & Spill form: what it
// was for, the verdict Crew's checks reached, and the diff's size, with the full diff one recall
// further (sp_…/diff, paged like any long text). Scope: runs surfaced in the caller's chat or made
// for its project; a blind reviewer never gets here (resolve() refuses before the registry).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { Chat, RecallLink, RecallNode, Speculation } from '../../shared/types';
import { chatProjectId } from '../projects';
import { linkFor, type Resolved, registerRecall, rootOf } from '../recall/graph';
import { oneLine } from '../recall/spill';
import { chats, projects, speculationLog, workers } from '../store';
import { agoLong as ago } from '../time';

const DIFF = '/diff';
/** A diff larger than this is not read into a prompt; the user has it in the Speculative fixes bar. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function inScope(sp: Speculation, chat: Chat): boolean {
  if (sp.chatId === chat.id) return true;
  const root = rootOf(chatProjectId(chat));
  return !!root && rootOf(sp.projectId) === root;
}

/** What Crew's checks concluded, in words: facts Crew established, never the run's own claim. Short: recall shows a fact in 20 words. */
export function verdictOf(sp: Speculation): string {
  const cmd = sp.checkCommand ? `\`${sp.checkCommand}\`` : 'the checks';
  const proven = `${cmd} fails without the fix (exit ${sp.checks?.before?.exitCode ?? '?'}), passes with it (exit ${sp.checks?.after?.exitCode ?? '?'})`;
  switch (sp.status) {
    case 'ready':
    case 'merged':
      return `verified: ${proven}`;
    case 'running':
      return 'not yet: the run is still working';
    case 'verifying':
      return 'not yet: Crew is running the checks';
    case 'skipped':
      return `never ran: ${sp.why || 'refused by a gate'}`;
    default:
      return sp.checks?.after?.ok && sp.checks.before && !sp.checks.before.ok ? `verified, then discarded: ${sp.why || ''}` : `not verified: ${sp.why || ''}`;
  }
}

/** "2 files, +5 −1 (reproduction: 1 file)". */
export function diffStats(sp: Pick<Speculation, 'files'>): string {
  const files = sp.files || [];
  if (!files.length) return 'no changes recorded';
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const tests = files.filter((f) => f.test).length;
  return `${files.length} file${files.length === 1 ? '' : 's'}, +${added} −${removed}${tests ? ` (reproduction: ${tests} file${tests === 1 ? '' : 's'})` : ''}`;
}

/** The run's worktree, while it still exists (a ready fix keeps it; merging or discarding removes it). */
function worktreeOf(sp: Speculation): string | undefined {
  const wt = projects.get(workers.get(sp.workerId)?.projectId)?.workspace?.worktree;
  return wt && fs.existsSync(wt) ? wt : undefined;
}

export function speculationNode(sp: Speculation, chat: Chat): RecallNode {
  const attrs: [string, string][] = [
    ['signal', sp.signal],
    ['status', sp.status],
    ['verdict', verdictOf(sp)],
    ['diff', diffStats(sp)],
    ['when', ago(sp.at)],
  ];
  if (sp.github) attrs.push(['pull request', `${sp.github.repo}#${sp.github.number} (check "${sp.github.check}")`]);
  if (sp.github?.push) attrs.push(['push', 'draftId' in sp.github.push ? `drafted to ${sp.github.push.remote} → ${sp.github.push.branch}` : `not offered: ${sp.github.push.refused}`]);
  const files = (sp.files || []).map((f) => `- ${f.path} (+${f.added} −${f.removed})${f.test ? ', the reproduction' : ''}`);
  // The run's summary is a model's words written after reading outside input: data, not instructions.
  const body = [sp.claim?.summary ? `The run's summary: ${sp.claim.summary}` : '', files.length ? `Files:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n');
  const links: RecallLink[] = [];
  if (sp.base && sp.head)
    links.push({ id: `${sp.id}${DIFF}`, rel: 'full diff', summary: worktreeOf(sp) ? `git diff ${sp.base.slice(0, 7)} ${sp.head.slice(0, 7)}` : 'gone with its throwaway worktree' });
  for (const [id, rel] of [
    [sp.triggerId, 'signal'],
    [sp.workerId, 'run by'],
    [sp.triggerOut, 'surfaced as'],
  ] as const) {
    const l = id ? linkFor(id, rel, chat) : null;
    if (l) links.push(l);
  }
  return { id: sp.id, kind: 'speculation', title: `Speculative fix for ${oneLine(sp.summary, 20)}`, attrs, body, untrusted: !!body, around: [], links };
}

function diffNode(sp: Speculation): Resolved {
  const id = `${sp.id}${DIFF}`;
  const wt = worktreeOf(sp);
  if (!sp.base || !sp.head) return { error: `${sp.id} has no diff (${sp.status}${sp.why ? `: ${sp.why}` : ''}).` };
  if (!wt) return { error: `The diff of ${sp.id} is gone with its throwaway worktree (${sp.status}${sp.status === 'merged' ? ': it is in the folder now' : ''}).` };
  let text: string;
  try {
    text = execFileSync('git', ['diff', sp.base, sp.head], { cwd: wt, encoding: 'utf8', maxBuffer: MAX_DIFF_BYTES, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return { error: `Could not read the diff of ${sp.id}: ${(e as Error).message.split('\n')[0]}` };
  }
  return {
    node: {
      id,
      kind: 'diff',
      title: `The diff of ${sp.id}: ${diffStats(sp)}`,
      attrs: [['range', `${sp.base.slice(0, 12)}..${sp.head.slice(0, 12)}`]],
      // Code a model wrote: data to read, never instructions.
      body: text || '(empty diff)',
      untrusted: true,
      around: [],
      links: [{ id: sp.id, rel: 'run', summary: verdictOf(sp) }],
    },
  };
}

/** sp_… and sp_…/diff. */
export function resolveSpeculation(id: string, chatId: string): Resolved {
  const runId = id.endsWith(DIFF) ? id.slice(0, -DIFF.length) : id;
  const sp = speculationLog.get(runId);
  const chat = chats.get(chatId);
  if (!sp || !chat || !inScope(sp, chat)) return { error: `No speculative run ${runId} for this conversation's project.` };
  return id.endsWith(DIFF) ? diffNode(sp) : { node: speculationNode(sp, chat) };
}

registerRecall('sp_', (id, scope) => resolveSpeculation(id, scope.chatId));
