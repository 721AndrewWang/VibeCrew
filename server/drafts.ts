// Draft-only external actions (ADR 007). Anything that leaves the machine in the user's name (a
// push, a pull request, an issue or a comment, a message) is drafted by an agent and run only when
// the user clicks: Crew builds the exact command from validated fields, so the card shows what will
// run, and records how to reverse it. There is no setting that makes a draft run by itself.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { DraftKind, ExternalDraft } from '../shared/types';
import { audit } from './audit';
import { bus, notify } from './bus';
import { cleanEnv } from './config';
import { draftRefusal, hookFreeEnv, riskyConfigKeys } from './hardening/draftChecks';
import { redact } from './hardening/redactor';
import { logger } from './log';
import { systemMessage } from './orchestrator/chatLog';
import { HttpError } from './projects';
import { bots, chats, drafts, uid } from './store';

const log = logger('drafts');

export interface DraftFields {
  kind: DraftKind;
  remote?: string;
  branch?: string;
  number?: number;
  /** review-reply: the id of the review comment it answers. */
  comment?: number;
  title?: string;
  body?: string;
  base?: string;
  head?: string;
  repo?: string;
  channel?: string;
  why?: string;
}

export interface DraftOrigin {
  chatId: string | null;
  botId: string | null;
  workerId?: string;
  /** The folder the command will run in (the project or workspace). */
  cwd: string;
}

/** A git ref or remote name that cannot be read as an option or a revision expression. */
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/+-]{1,200}$/;
const SAFE_REPO = /^[\w.-]+\/[\w.-]+$/;

function ref(v: string | undefined, what: string): string {
  const s = (v || '').trim();
  if (!SAFE_REF.test(s)) throw new Error(`${what} "${s}" is not a valid name (letters, digits, . _ / + -, not starting with -)`);
  return s;
}

function need(v: string | undefined, what: string, max: number): string {
  const s = (v || '').trim();
  if (!s) throw new Error(`${what} is required`);
  if (s.length > max) throw new Error(`${what} is too long (at most ${max} characters)`);
  return s;
}

/**
 * The draft for these fields: the exact argv and the target, in words. Pure; throws on fields that
 * are missing or could be read as something else. `branch` is the current branch when not given.
 */
export function buildDraft(f: DraftFields, currentBranch?: string): Pick<ExternalDraft, 'kind' | 'target' | 'command' | 'title' | 'body' | 'why'> {
  const repoArgs = () => {
    if (!f.repo?.trim()) return [];
    if (!SAFE_REPO.test(f.repo.trim())) throw new Error(`repo "${f.repo}" should look like owner/name`);
    return ['--repo', f.repo.trim()];
  };
  const where = f.repo?.trim() ? ` in ${f.repo.trim()}` : '';
  const why = f.why?.trim().slice(0, 1000) || undefined;
  switch (f.kind) {
    case 'git-push': {
      const remote = ref(f.remote || 'origin', 'remote');
      const branch = ref(f.branch || currentBranch, 'branch');
      return { kind: f.kind, target: `${remote} → ${branch}`, command: ['git', 'push', remote, `HEAD:refs/heads/${branch}`], why };
    }
    case 'pr-open': {
      const title = need(f.title, 'title', 300);
      const body = (f.body || '').trim();
      const base = f.base ? ref(f.base, 'base') : undefined;
      const head = f.head ? ref(f.head, 'head') : undefined;
      return {
        kind: f.kind,
        target: `New pull request${where}${head ? ` from ${head}` : ''}${base ? ` into ${base}` : ''}`,
        command: ['gh', 'pr', 'create', '--title', title, '--body', body, ...(base ? ['--base', base] : []), ...(head ? ['--head', head] : []), ...repoArgs()],
        title,
        body,
        why,
      };
    }
    case 'pr-comment':
    case 'issue-comment': {
      const n = Number(f.number);
      if (!Number.isInteger(n) || n < 1) throw new Error('number (the pull request or issue number) is required');
      const body = need(f.body, 'body', 60_000);
      const what = f.kind === 'pr-comment' ? 'pr' : 'issue';
      return { kind: f.kind, target: `Comment on ${what === 'pr' ? 'PR' : 'issue'} #${n}${where}`, command: ['gh', what, 'comment', String(n), '--body', body, ...repoArgs()], body, why };
    }
    case 'review-reply': {
      // A reply in a pull request's review thread goes through the REST API: gh has no command for it.
      const n = Number(f.number);
      if (!Number.isInteger(n) || n < 1) throw new Error('number (the pull request number) is required');
      const c = Number(f.comment);
      if (!Number.isInteger(c) || c < 1) throw new Error('comment (the id of the review comment to reply to) is required');
      const repo = (f.repo || '').trim();
      if (!SAFE_REPO.test(repo)) throw new Error('repo (owner/name) is required for a review reply');
      const body = need(f.body, 'body', 60_000);
      return {
        kind: f.kind,
        target: `Reply to review comment ${c} on PR #${n} in ${repo}`,
        command: ['gh', 'api', '--method', 'POST', `repos/${repo}/pulls/${n}/comments/${c}/replies`, '-f', `body=${body}`, '--jq', '.html_url'],
        body,
        why,
      };
    }
    case 'issue-open': {
      const title = need(f.title, 'title', 300);
      const body = (f.body || '').trim();
      return { kind: f.kind, target: `New issue${where}`, command: ['gh', 'issue', 'create', '--title', title, '--body', body, ...repoArgs()], title, body, why };
    }
    case 'message': {
      const channel = need(f.channel, 'channel (where it goes: a person, a channel, a list)', 200);
      return { kind: f.kind, target: channel, command: null, body: need(f.body, 'body', 60_000), why };
    }
    default:
      throw new Error(`Unknown kind: ${String((f as { kind?: unknown }).kind)}`);
  }
}

/** How to undo a finished action, from what it printed and what was there before. */
export function reverseOf(d: Pick<ExternalDraft, 'kind' | 'command' | 'before'>, out: { url?: string; head?: string }): string | undefined {
  switch (d.kind) {
    case 'git-push': {
      const [, , remote, spec] = d.command || [];
      const branch = (spec || '').replace(/^HEAD:refs\/heads\//, '');
      if (d.before === undefined) return undefined;
      if (!d.before) return `git push ${remote} --delete ${branch}`;
      return `git push --force-with-lease=refs/heads/${branch}:${out.head || ''} ${remote} ${d.before}:refs/heads/${branch}`;
    }
    case 'pr-open':
      return out.url ? `gh pr close ${out.url}` : undefined;
    case 'issue-open':
      return out.url ? `gh issue close ${out.url}` : undefined;
    case 'pr-comment':
    case 'issue-comment':
    case 'review-reply':
      return out.url ? `Delete the comment at ${out.url}` : undefined;
    default:
      return undefined;
  }
}

/** Shows a command the way a shell would read it (for the card, the audit log and the system note). */
export function showCommand(argv: string[] | null): string {
  if (!argv) return '';
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** Runs a program of a draft: the user's environment, git hooks off (ADR 104), the output without secrets. */
function run(cmd: string, args: string[], cwd: string, timeout = 120_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env: hookFreeEnv(cleanEnv()), timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = redact(`${stdout || ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`.trim());
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ code, out: err && !out ? (err as Error).message : out });
    });
  });
}

function save(d: ExternalDraft) {
  drafts.set(d);
  bus.emit({ t: 'draft', draft: d });
}

const actorOf = (d: ExternalDraft) => ({ botId: d.botId || undefined, botName: bots.get(d.botId)?.name, chatId: d.chatId || undefined, workerId: d.workerId });

/** An agent drafts an action: validated, stored, shown to the user. It does not run. */
export async function createDraft(f: DraftFields, origin: DraftOrigin): Promise<ExternalDraft> {
  let current: string | undefined;
  if (f.kind === 'git-push' && !f.branch) {
    const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], origin.cwd, 10_000);
    if (r.code === 0 && r.out && r.out !== 'HEAD') current = r.out.trim();
  }
  const built = buildDraft(f, current);
  // The same draft, still waiting, in the same chat: a Router turn a restart cut off and handed over
  // again drafts it a second time (ADR 105 × 102). The user gets one card, not two (ADR 011).
  const twin = drafts
    .all()
    .find(
      (x) =>
        x.status === 'pending' && x.chatId === origin.chatId && x.kind === built.kind && x.target === built.target && x.body === built.body && showCommand(x.command) === showCommand(built.command),
    );
  if (twin) return twin;
  const d: ExternalDraft = { id: uid('dr_'), at: Date.now(), ...built, chatId: origin.chatId, botId: origin.botId, workerId: origin.workerId, cwd: origin.cwd, status: 'pending' };
  // Where the push goes, as the card shows it; checked again before it runs (ADR 104).
  if (d.kind === 'git-push' && d.command) d.remoteUrl = await pushUrl(d.command[2], d.cwd);
  save(d);
  audit({ event: 'drafted', actor: actorOf(d), kind: d.kind, target: d.target, command: showCommand(d.command) || undefined, cwd: d.cwd, detail: d.why, draftId: d.id });
  const who = bots.get(d.botId)?.name || 'A bot';
  notify(`${who} drafted an action for you`, d.target, { chatId: d.chatId || undefined, level: 'warn' });
  return d;
}

async function pushUrl(remote: string, cwd: string): Promise<string> {
  const r = await run('git', ['remote', 'get-url', '--push', remote], cwd, 10_000);
  return r.code === 0 ? r.out.trim() : '';
}

/** What is there now that the draft's run depends on: the push URL and the repository's own risky settings. */
async function currentState(d: ExternalDraft): Promise<{ pushUrl?: string | null; riskyKeys: string[] }> {
  if (!d.command || (d.command[0] !== 'git' && d.command[0] !== 'gh')) return { riskyKeys: [] };
  const listing = (await Promise.all([['--local'], ['--worktree']].map((scope) => run('git', ['config', ...scope, '--list'], d.cwd, 10_000))))
    .filter((r) => r.code === 0)
    .map((r) => r.out)
    .join('\n');
  return { pushUrl: d.kind === 'git-push' ? await pushUrl(d.command[2], d.cwd) : undefined, riskyKeys: riskyConfigKeys(listing) };
}

function pendingDraft(id: string): ExternalDraft {
  const d = drafts.get(id);
  if (!d) throw new HttpError(404, 'No such draft');
  if (d.status !== 'pending') throw new HttpError(409, `This draft is already ${d.status}`);
  return d;
}

function tellChat(d: ExternalDraft, text: string) {
  const chat = chats.get(d.chatId);
  if (chat) systemMessage(chat, text);
}

/** The user's click: runs the exact command (with the user's own environment) and records the outcome. */
export async function approveDraft(id: string): Promise<ExternalDraft> {
  const d = pendingDraft(id);
  d.status = 'running';
  d.decidedAt = Date.now();
  save(d);
  audit({ event: 'approved', actor: { ...actorOf(d), user: true }, kind: d.kind, target: d.target, command: showCommand(d.command) || undefined, cwd: d.cwd, draftId: d.id });
  if (!d.command) {
    d.status = 'done';
    d.result = { exitCode: 0, output: 'Marked as posted by you.' };
    save(d);
    tellChat(d, `You posted the drafted message to ${d.target}.`);
    return d;
  }
  if (!fs.existsSync(d.cwd)) {
    d.status = 'failed';
    d.result = { exitCode: 1, output: `The folder ${d.cwd} no longer exists.` };
    save(d);
    audit({ event: 'failed', actor: { user: true, chatId: d.chatId || undefined }, kind: d.kind, target: d.target, cwd: d.cwd, detail: d.result.output, draftId: d.id });
    return d;
  }
  const refused = draftRefusal(d, await currentState(d));
  if (refused) {
    d.status = 'failed';
    d.result = { exitCode: 1, output: refused };
    save(d);
    audit({ event: 'failed', actor: { user: true, chatId: d.chatId || undefined }, kind: d.kind, target: d.target, cwd: d.cwd, detail: refused, draftId: d.id });
    tellChat(d, `The drafted action was not run (${d.target}): ${refused}`);
    return d;
  }
  let head: string | undefined;
  if (d.kind === 'git-push') {
    const [, , remote, spec] = d.command;
    const branch = spec.replace(/^HEAD:/, '');
    const h = await run('git', ['rev-parse', 'HEAD'], d.cwd, 10_000);
    head = h.code === 0 ? h.out.trim() : undefined;
    // What the remote had, so the push can be undone: its old head, or '' when the branch is new.
    const before = await run('git', ['ls-remote', remote, branch], d.cwd, 30_000);
    if (before.code === 0) d.before = before.out.split(/\s+/)[0] || '';
  }
  const [cmd, ...args] = d.command;
  log.info(`running draft ${d.id}: ${showCommand(d.command)} in ${d.cwd}`);
  const r = await run(cmd, args, d.cwd);
  const url = r.out.match(/https?:\/\/\S+/)?.[0];
  d.result = { exitCode: r.code, output: r.out.slice(-4000), url };
  d.status = r.code === 0 ? 'done' : 'failed';
  d.reverse = r.code === 0 ? reverseOf(d, { url, head }) : undefined;
  save(d);
  audit({
    event: r.code === 0 ? 'ran' : 'failed',
    actor: { user: true, chatId: d.chatId || undefined },
    kind: d.kind,
    target: d.target,
    command: showCommand(d.command),
    cwd: d.cwd,
    detail: `exit ${r.code}${url ? ` · ${url}` : ''}\n${r.out.slice(-1500)}`,
    reverse: d.reverse,
    draftId: d.id,
  });
  tellChat(d, r.code === 0 ? `You approved and ran the drafted action: ${d.target}${url ? ` (${url})` : ''}.` : `The drafted action failed (${d.target}): ${r.out.slice(-300) || `exit ${r.code}`}`);
  return d;
}

/** The user's Discard; or Crew's own, with why (a speculative fix that is gone, ADR 011). */
export function discardDraft(id: string, byCrew?: string): ExternalDraft {
  const d = pendingDraft(id);
  d.status = 'discarded';
  d.decidedAt = Date.now();
  save(d);
  audit({ event: 'discarded', actor: { ...actorOf(d), user: !byCrew }, kind: d.kind, target: d.target, command: showCommand(d.command) || undefined, draftId: d.id, detail: byCrew });
  if (!byCrew) tellChat(d, `You discarded the drafted action: ${d.target}.`);
  return d;
}

/** Pending drafts and the latest decided ones, newest first; optionally one chat's. */
export function listDrafts(chatId?: string, decided = 30): ExternalDraft[] {
  const all = drafts
    .all()
    .filter((d) => !chatId || d.chatId === chatId)
    .sort((a, b) => b.at - a.at);
  return [...all.filter((d) => d.status === 'pending' || d.status === 'running'), ...all.filter((d) => d.status !== 'pending' && d.status !== 'running').slice(0, decided)];
}

/** A draft cut off by a restart while running: it may or may not have run. */
export function recoverDrafts() {
  for (const d of drafts.all()) {
    if (d.status !== 'running') continue;
    d.status = 'failed';
    d.result = { exitCode: -1, output: 'Crew restarted while this was running: check the target to see whether it went through.' };
    save(d);
  }
}
