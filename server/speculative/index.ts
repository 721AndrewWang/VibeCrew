// Speculative execution (ADR 008): Crew acts ahead of the user on environment signals. When a
// Trigger looks like a failing check, a preview console error or a user describing a problem,
// fixed rules decide whether to spend a background Worker on it; that Worker tries to reproduce the
// problem and find a small fix in a throwaway worktree. Crew then runs the project's checks itself:
// only a fix that passes them, and without which they fail, is surfaced (a card with the diff and a
// one-click merge). Anything else is discarded, worktree and branch included, without a word.
//
// Behind settings.superAgent.enabled (the Trigger bus) and each project's own switch: with either
// off, the listener returns at once, nothing is recorded and no folder is created.

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_PROJECT_SPECULATIVE } from '../../shared/defaults';
import { SPECULATION_IN_FLIGHT } from '../../shared/status';
import type { Chat, Project, Speculation, SpeculativeSignal, Trigger, Worker } from '../../shared/types';
import type { SpeculativeClaimArgs } from '../agents/crewTools';
import { parseNumstat } from '../autoChallenge';
import { bus, notify } from '../bus';
import { asyncRefusal, shapeAsync } from '../channels/profiles';
import { DATA, FAKE_AGENT } from '../config';
import { createDraft, discardDraft } from '../drafts';
import { asyncBody } from '../github/gates';
import { autoCommit, gitError } from '../gitops';
import { redactDeep } from '../hardening/redactor';
import { getJob } from '../jobs';
import { groupGone, reapOrphan } from '../jobs/orphans';
import { leadOf, routerEvent, routerMode } from '../layers';
import { dismissWorker, type SpeculativeHost, setSpeculativeHost, startWorker, stopWorker } from '../layers/workers';
import { logger } from '../log';
import { projectRunning, systemMessage, withChatLocked } from '../orchestrator';
import { deniedReason } from '../orchestrator/permissionGate';
import { agentEnv, contextLines, effectiveBot } from '../orchestrator/turnContext';
import { chatProjectId, configOf, gitIn, HttpError } from '../projects';
import { agentEnvOptions } from '../safety';
import { sandboxOptions } from '../sandbox';
import { skills } from '../skills';
import { bots, chats, drafts, messages, projects, settings, speculationLog, uid, workers } from '../store';
import { chatThread, detailText, onTrigger, publishTrigger, superAgentOn, targetChat } from '../triggers';
import { monthSpend } from '../usage';
import { checkGit, disposeWorkspace, type Workspace } from '../workspaces';
import { detectCheckCommand, normalizeProjectSpeculative } from './config';
import { speculativePrompt } from './prompts';
import { botRefusal, gateRefusal, judgeClaim, repoPath, SAME_SIGNAL_MS, type SignalInput, signalOf } from './rules';
import { spentToday } from './spend';
import { type CheckEnv, verifyFix } from './verify';

const log = logger('speculative');

/** A ready fix not merged within this long is discarded. */
const READY_MS = 24 * 3600_000;
/** The same refusal for the same signal is recorded once in this long (a noisy page repeats itself). */
const SKIP_REPEAT_MS = 3600_000;
const FAMILIES = ['triage', 'reproduce', 'draft-fix'] as const;

/** The signal's text a run is given: in memory, since a restart discards runs in flight anyway. */
const details = new Map<string, string>();
/** Why a run was stopped, by Crew's own timer. */
const stopReasons = new Map<string, string>();
const timers = new Map<string, NodeJS.Timeout>();

// ---------------------------------------------------------------- the ledger

function record(sp: Speculation, patch: Partial<Speculation> = {}): Speculation {
  Object.assign(sp, patch, { updatedAt: Date.now() });
  // Check output and the run's summary may quote a secret: the ledger never holds one (ADR 104 × 008).
  Object.assign(sp, redactDeep({ claim: sp.claim, checks: sp.checks, summary: sp.summary, why: sp.why }));
  speculationLog.append(sp);
  bus.emit({ t: 'speculation', speculation: sp });
  return sp;
}

export function getSpeculation(id: string): Speculation | undefined {
  return speculationLog.get(id);
}

export function listSpeculations(q: { chatId?: string; projectId?: string; limit?: number } = {}): Speculation[] {
  const limit = Math.max(1, Math.min(500, Math.round(q.limit || 100)));
  return speculationLog.recent(limit, (s) => (!q.chatId || s.chatId === q.chatId) && (!q.projectId || s.projectId === q.projectId));
}

/** For the UI's first load: ready fixes, and the latest others. */
export function bootSpeculations(): Speculation[] {
  const ready = speculationLog.all().filter((s) => s.status === 'ready');
  const recent = speculationLog.recent(50, (s) => s.status !== 'ready');
  return [...ready, ...recent];
}

const byWorker = (w: Pick<Worker, 'speculation'>) => speculationLog.get(w.speculation);

export { spentToday } from './spend';

// ---------------------------------------------------------------- deciding (ADR 008 §1)

/** The folder a chat works in: its workspace, else its project. */
function folderOf(chat: Chat | undefined, t: Pick<Trigger, 'projectId'>): Project | undefined {
  return projects.get(chat ? chatProjectId(chat) : t.projectId);
}

/** A project's check command: its own, else `npm test` when package.json has a real test script. */
function checkCommandOf(root: Project): string {
  const own = normalizeProjectSpeculative(root.speculative).checkCommand;
  if (own) return own;
  let pkg: string | null = null;
  try {
    pkg = fs.readFileSync(path.join(root.path, 'package.json'), 'utf8');
  } catch {
    /* none */
  }
  return detectCheckCommand(pkg);
}

/** The event as a signal's input, read from the stores; null for anything that is not one of the three. */
function inputOf(t: Trigger, checkCommand: string): SignalInput | null {
  if (t.source === 'job' && t.explicit) {
    const job = getJob(t.related[0]);
    if (job?.kind !== 'command') return null;
    return { source: 'job', failed: job.status === 'failed', command: job.command || '', checkCommand };
  }
  if (t.source === 'preview-console') {
    const errors = detailText(t)
      .split('\n')
      .filter((l) => l.startsWith('[error] '))
      .map((l) => l.slice(8));
    return { source: 'preview-console', filterRule: t.filter.rule, errors };
  }
  // A failing check GitHub reported on a pull request (ADR 102 × 008, ADR 011).
  if (t.source === 'github' && t.github?.kind === 'check' && t.github.check)
    return { source: 'github', check: t.github.check.name, conclusion: t.github.check.conclusion, ref: `${t.github.repo}#${t.github.number}` };
  if (t.source === 'user' && t.ref.kind === 'message') {
    const m = messages.get(t.ref.chatId, t.ref.messageId);
    return m && !m.skill ? { source: 'user', text: m.text } : null;
  }
  return null;
}

/** The text the run starts from: what ran and how it ended, the console lines, the user's words. */
function detailOf(t: Trigger, signal: SpeculativeSignal): string {
  if (signal === 'failing-check' && t.source !== 'github') {
    const job = getJob(t.related[0]);
    const m = t.ref.kind === 'message' ? messages.get(t.ref.chatId, t.ref.messageId) : undefined;
    return [`Command: ${job?.command || '(unknown)'}`, m?.text || detailText(t)].join('\n');
  }
  return detailText(t);
}

/** The Trigger bus calls this for every recorded Trigger: cheap checks first, the rest in the background. */
function consider(t: Trigger) {
  if (!superAgentOn() || (t.source !== 'job' && t.source !== 'preview-console' && t.source !== 'user' && t.source !== 'github')) return;
  const chat = targetChat(t);
  const folder = folderOf(chat, t);
  if (!folder) return;
  const root = configOf(folder);
  // Not opted in: nothing is recorded at all.
  if (!root.speculative?.enabled) return;
  void decide(t, chat, folder, root).catch((e) => log.warn(`could not decide on ${t.id}:`, e));
}

async function decide(t: Trigger, chat: Chat | undefined, folder: Project, root: Project) {
  const rules = normalizeProjectSpeculative(root.speculative);
  const checkCommand = checkCommandOf(root);
  const input = inputOf(t, checkCommand);
  const match = input && signalOf(input);
  if (!match) return;
  const sa = settings.get().superAgent.speculative;
  const now = Date.now();
  const lead = chat ? leadOf(chat) : undefined;
  const level = chat && lead ? effectiveBot(chat, lead).permission : 'plan';
  const git = await checkGit(folder.path).then(
    () => true,
    () => false,
  );
  // A GitHub check failed at its pull request's head: that commit is the observed state (ADR 011).
  const gh = t.source === 'github' && t.github?.check ? { repo: t.github.repo, number: t.github.number, check: t.github.check.name, head: t.github.check.head } : undefined;
  const head =
    gh && git
      ? {
          sha: gh.head,
          present:
            /^[0-9a-f]{7,64}$/i.test(gh.head) &&
            (await gitIn(folder.path, ['cat-file', '-e', `${gh.head}^{commit}`]).then(
              () => true,
              () => false,
            )),
        }
      : undefined;
  const live = speculationLog.all().filter((s) => SPECULATION_IN_FLIGHT.has(s.status));
  const twin = speculationLog.recent(1, (s) => s.fingerprint === t.fingerprint && s.status !== 'skipped' && now - s.at < SAME_SIGNAL_MS)[0];
  const refused = gateRefusal({
    rules,
    settings: sa,
    signal: match.signal,
    checkCommand,
    subscribed: t.filter.rule === 'subscribed',
    chat: !!chat,
    bot: botRefusal(lead && { name: lead.name, blindReview: lead.blindReview, level, overBudget: !!lead.monthlyBudgetUsd && monthSpend(lead.id) >= lead.monthlyBudgetUsd }),
    git,
    head,
    duplicateOf: twin?.id,
    inFlight: live.length,
    inFlightHere: live.filter((s) => s.projectId === root.id).length,
    spentTodayUsd: spentToday(now),
  });
  const base: Speculation = {
    id: uid('sp_'),
    at: now,
    updatedAt: now,
    signal: match.signal,
    triggerId: t.id,
    fingerprint: t.fingerprint,
    summary: t.summary,
    reasons: match.reasons,
    projectId: root.id,
    chatId: chat?.id ?? null,
    status: 'skipped',
    costUsd: 0,
    ...(gh ? { github: gh } : {}),
  };
  if (refused) {
    const again = speculationLog.recent(1, (s) => s.status === 'skipped' && s.fingerprint === t.fingerprint && s.why === refused && now - s.at < SKIP_REPEAT_MS)[0];
    if (!again) record(base, { why: refused });
    log.debug(`${t.id}: not speculating: ${refused}`);
    return;
  }
  // The gates above passed, so there is a chat and a member.
  const c = chat as Chat;
  const bot = lead!;
  const sp = record(base, { status: 'running', botId: bot.id, target: folder.id, checkCommand });
  details.set(sp.id, detailOf(t, match.signal));
  const w = startWorker(c, bot, { title: `Speculative: ${t.summary}`, task: `Reproduce and fix: ${t.summary}`, related: [t.id], userMessageIds: [], speculation: sp.id });
  record(sp, { workerId: w.id });
  // Crew's own time limit: a run still going is stopped, and then discarded.
  const timer = setTimeout(() => {
    stopReasons.set(w.id, `It ran out of time (${sa.maxMinutes} min)`);
    void stopWorker(w.id, { quiet: true, why: 'The speculative run ran out of time' });
  }, sa.maxMinutes * 60_000);
  timer.unref();
  timers.set(w.id, timer);
  log.info(`${sp.id}: speculating on ${t.id} (${match.signal}) as ${w.id}`);
}

// ---------------------------------------------------------------- the run (ADR 008 §2)

const host: SpeculativeHost = {
  source: (w) => projects.get(byWorker(w)?.target),
  baseCommit: (w) => byWorker(w)?.github?.head,
  checkCommand: (w) => byWorker(w)?.checkCommand || '',
  model: (_w, chat) => settings.get().superAgent.speculative.model || (chat.model !== undefined ? chat.model : settings.get().superAgent.router.workerModel),
  prompt(w, project, context) {
    const sp = byWorker(w);
    return speculativePrompt({
      signal: sp?.signal || 'bug-report',
      origin: sp?.github ? 'github' : undefined,
      detail: (sp && details.get(sp.id)) || sp?.summary || '',
      checkCommand: sp?.checkCommand || '',
      playbook: FAMILIES.flatMap((f) => skills.forFamily(project, f, 'speculative')).map((s) => ({ name: s.name, title: s.title, body: s.body })),
      context: context.length ? context : contextLines(project),
    });
  },
  claim(w, args: SpeculativeClaimArgs) {
    const sp = byWorker(w);
    if (sp?.status !== 'running') throw new Error('This run is over.');
    const testFiles = (Array.isArray(args.testFiles) ? args.testFiles : [])
      .filter((f): f is string => typeof f === 'string' && !!f.trim())
      .map((f) => f.trim().slice(0, 500))
      .slice(0, 20);
    const words = String(args.summary || '')
      .split(/\s+/)
      .filter(Boolean);
    const summary = words.length > 80 ? `${words.slice(0, 80).join(' ')}…` : words.join(' ');
    record(sp, { claim: { reproduced: args.reproduced === true, testFiles, summary } });
    return args.reproduced === true
      ? "Recorded. When your turn ends, Crew runs the project's checks with and without your fix. End your turn now."
      : 'Recorded: not reproduced. The run is discarded quietly. End your turn now.';
  },
  launched(w, _ws, base) {
    const sp = byWorker(w);
    if (sp) record(sp, { base });
  },
  ended(w, outcome, detail) {
    const sp = byWorker(w);
    clearTimeout(timers.get(w.id));
    timers.delete(w.id);
    const stopped = stopReasons.get(w.id);
    stopReasons.delete(w.id);
    if (sp?.status !== 'running') return;
    record(sp, { costUsd: w.costUsd });
    if (outcome === 'stopped') return void discard(sp, stopped || (detail?.startsWith('The Watchdog') ? detail : 'It was stopped'));
    if (outcome === 'error') return void discard(sp, `It failed: ${detail || 'unknown error'}`);
    void verify(sp, w).catch((e) => discard(sp, `Verification failed: ${(e as Error).message}`));
  },
};
setSpeculativeHost(host);

// ---------------------------------------------------------------- verification (ADR 008 §3)

function checkEnv(w: Worker, ws: Project, sp: Speculation): CheckEnv {
  const s = settings.get();
  const bot = bots.get(w.botId);
  const conf = configOf(ws);
  return {
    // The demo agent has no Claude Code to run a sandboxed Bash call in. The worktree's folder gives the
    // sandbox the hardened filesystem rules every agent session gets (ADR 104 × 008).
    sandbox: FAKE_AGENT ? undefined : sandboxOptions(s.sandbox.enabled, s.sandbox.allowedDomains, conf.allowedDomains, ws.path),
    denyRules: s.denyRules || [],
    deniedReason: (tool, input) => deniedReason(tool, input, ws.path, { project: ws, actor: { botId: w.botId, botName: bot?.name, chatId: w.chatId, workerId: w.id } }),
    env: { CREW_SPECULATIVE: '1' },
    envOptions: agentEnvOptions(ws),
    agentEnv: agentEnv({ role: 'speculative', botId: w.botId }, undefined, ws),
    onStart: (pid, startedAt) => void record(sp, { checking: { pid, startedAt } }),
    onEnd: () => void record(sp, { checking: undefined }),
  };
}

async function verify(sp: Speculation, w: Worker) {
  record(sp, { status: 'verifying' });
  const ws = projects.get(w.projectId);
  const info = ws?.workspace;
  if (!ws || !info || info.workerId !== w.id || !sp.base) return discard(sp, 'Its workspace is gone');
  const head = (await gitIn(info.worktree, ['rev-parse', 'HEAD'])).trim();
  const changed = parseNumstat(await gitIn(info.worktree, ['diff', '--numstat', sp.base, head]));
  const rel = path.relative(info.worktree, ws.path);
  const prefix = rel ? `${rel.split(path.sep).join('/')}/` : '';
  const rules = normalizeProjectSpeculative(projects.get(sp.projectId)?.speculative ?? DEFAULT_PROJECT_SPECULATIVE);
  const claim = judgeClaim(sp.claim, changed, rules.maxFixLines, (p) => repoPath(p, prefix, info.worktree));
  const tests = new Set(claim.ok ? claim.testFiles : []);
  record(sp, { head, files: changed.map((f) => ({ ...f, test: tests.has(f.path) })) });
  if (!claim.ok) return discard(sp, claim.why);
  const r = await verifyFix({ worktree: info.worktree, cwd: ws.path, base: sp.base, head, fixFiles: claim.fixFiles, checkCommand: sp.checkCommand || '', env: checkEnv(w, ws, sp) });
  record(sp, { checks: { after: r.after, before: r.before } });
  if (!r.ok) return discard(sp, r.why);
  surface(sp, w);
}

// ---------------------------------------------------------------- surfacing (ADR 008 §4)

const SIGNAL_NAME: Record<SpeculativeSignal, string> = {
  'failing-check': 'a failing check',
  'console-error': 'a preview console error',
  'bug-report': 'the problem you described',
};

function fileList(sp: Speculation, tests: boolean): string {
  const files = (sp.files || []).filter((f) => f.test === tests);
  return files.length ? files.map((f) => `${f.path} (+${f.added} −${f.removed})`).join(', ') : 'none';
}

/** The facts of a verified fix, as the Trigger's payload and the Router's event: never the run's own words alone. */
function factsText(sp: Speculation): string {
  return [
    `Signal: ${sp.summary}`,
    `Fix: ${fileList(sp, false)}`,
    `Reproduction: ${fileList(sp, true)}`,
    `Checks (${sp.checkCommand}): fail without the fix (exit code ${sp.checks?.before?.exitCode ?? '?'}), pass with it`,
    sp.claim?.summary ? `The run's summary: ${sp.claim.summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function surface(sp: Speculation, w: Worker) {
  const chat = chats.get(sp.chatId);
  if (!chat) return discard(sp, 'Its chat is gone');
  const t = publishTrigger({
    source: 'speculative',
    summary: `Speculative fix ready for ${SIGNAL_NAME[sp.signal]}: ${sp.summary}`,
    thread: chatThread(chat),
    ref: { kind: 'payload' },
    payload: { text: factsText(sp) },
    chatId: chat.id,
    projectId: sp.target ?? sp.projectId,
    related: [sp.triggerId, w.id],
    action: `Shown in "${chat.title}" to merge or discard`,
  });
  const msg = systemMessage(chat, `Crew reproduced ${SIGNAL_NAME[sp.signal]} in the background and found a fix that passes the project's checks (${sp.checkCommand}): ${sp.summary}`, {
    uiOnly: true,
    notice: 'speculative',
    speculationId: sp.id,
  });
  record(sp, { status: 'ready', triggerOut: t?.id, messageId: msg.id });
  notify('Crew found a fix', sp.summary.slice(0, 140), { chatId: chat.id, level: 'success' });
  // From a GitHub check: the pull request hears of it in GitHub's register, as a draft the user posts (ADR 011).
  if (sp.github) void draftForGithub(sp, chat).catch((e) => log.warn(`${sp.id}: could not draft the pull request comment:`, e));
  // The Router may mention it; as an environment event it cannot merge it or start work from it.
  if (routerMode(chat))
    routerEvent(chat.id, {
      kind: 'environment',
      id: t?.id || sp.id,
      at: Date.now(),
      source: 'speculative',
      summary: `A fix is ready (${sp.id}) for ${sp.summary}. ${fileList(sp, false)}.`,
      reason: "Crew reproduced the problem in a throwaway workspace and the fix passed the project's checks; the user merges or discards it with one click in the chat",
      ...(sp.github && t ? { thread: t.threadId, github: `${sp.github.repo}#${sp.github.number}` } : {}),
    });
  log.info(`${sp.id}: fix ready in ${chat.id}`);
}

/**
 * The comment a fix for a failing GitHub check gets on its pull request: built by code from the
 * verified facts, in the GitHub channel's three sections and the comment profile (ADR 102 × 103),
 * and saved as a draft. Nothing is posted until the user approves it.
 */
export function githubComment(sp: Pick<Speculation, 'github' | 'files' | 'checkCommand' | 'checks' | 'claim' | 'id'>, withSummary = true): string {
  const gh = sp.github;
  const files = (sp.files || []).map((f) => `- \`${f.path}\` (+${f.added} −${f.removed})${f.test ? ', the reproduction' : ''}`);
  return asyncBody({
    background: `The check "${gh?.check}" failed on this pull request at ${gh?.head.slice(0, 12)}. Crew reproduced the failure locally on that commit in a throwaway worktree.`,
    change: [withSummary && sp.claim?.summary ? sp.claim.summary : '', ...files].filter(Boolean).join('\n'),
    verification: [
      `\`${sp.checkCommand}\` fails without the fix (exit code ${sp.checks?.before?.exitCode ?? '?'}) and passes with it (exit code ${sp.checks?.after?.exitCode ?? '?'}), the reproduction kept both times.`,
      `The fix is not pushed: it waits in Crew (${sp.id}) to be merged.`,
    ].join('\n'),
  });
}

async function draftForGithub(sp: Speculation, chat: Chat) {
  const gh = sp.github;
  if (!gh) return;
  // The run's summary is model text written after reading outside input: dropped if it does not fit the profile.
  let body = githubComment(sp);
  if (asyncRefusal('comment', body)) body = githubComment(sp, false);
  if (asyncRefusal('comment', body)) return;
  const cwd = projects.get(sp.target)?.path || projects.get(sp.projectId)?.path || '';
  const d = await createDraft(
    { kind: 'pr-comment', repo: gh.repo, number: gh.number, body: shapeAsync('comment', body), why: `A verified fix for the failing check "${gh.check}"` },
    { chatId: chat.id, botId: sp.botId ?? null, workerId: sp.workerId, cwd },
  );
  record(sp, { draftId: d.id });
}

// ---------------------------------------------------------------- merging and discarding

/** Removes the run's worktree and branch (it was never anyone's work) and dismisses its Worker. */
async function dispose(sp: Speculation) {
  const w = workers.get(sp.workerId);
  if (!w) return;
  const ws = projects.get(w.projectId);
  if (ws?.workspace?.workerId === w.id) await disposeWorkspace(ws as Workspace, true).catch((e) => log.warn(`${sp.id}: remove workspace:`, gitError(e)));
  if (w.status !== 'running' && w.status !== 'starting' && w.status !== 'waiting') await dismissWorker(w).catch((e) => log.warn(`${sp.id}: dismiss:`, e));
}

/** Not surfaced, or no longer wanted: the record says why; no chat hears of it. */
export async function discard(sp: Speculation, why: string) {
  if (sp.status === 'merged' || sp.status === 'discarded' || sp.status === 'skipped') return sp;
  details.delete(sp.id);
  record(sp, { status: 'discarded', why, decidedAt: Date.now() });
  // Its pull request comment speaks of a fix that is gone now.
  if (sp.draftId && drafts.get(sp.draftId)?.status === 'pending') discardDraft(sp.draftId, `The speculative fix ${sp.id} was discarded: ${why}`);
  await dispose(sp);
  log.info(`${sp.id}: discarded: ${why}`);
  return sp;
}

/** The user's Discard on a ready fix. */
export async function discardSpeculation(id: string): Promise<Speculation> {
  const sp = speculationLog.get(id);
  if (!sp) throw new HttpError(404, 'No such speculative run');
  if (sp.status !== 'ready') throw new HttpError(409, `This run is ${sp.status}, not waiting for you`);
  return discard(sp, 'Discarded by you');
}

/** The run's change as a patch: exactly what the user saw. */
async function patchOf(sp: Speculation, binary: boolean): Promise<string> {
  const w = workers.get(sp.workerId);
  const info = projects.get(w?.projectId)?.workspace;
  if (!info || !sp.base || !sp.head || !fs.existsSync(info.worktree)) throw new HttpError(410, "This run's workspace is gone");
  return gitIn(info.worktree, ['diff', ...(binary ? ['--binary'] : []), sp.base, sp.head]);
}

export async function speculationDiff(id: string): Promise<string> {
  const sp = speculationLog.get(id);
  if (!sp) throw new HttpError(404, 'No such speculative run');
  return patchOf(sp, false);
}

/**
 * One click: the run's diff is applied where the problem was seen (the chat's workspace, committed
 * there; or the project folder, left uncommitted like a bot's edits), under the chat's lock and as
 * Crew's own writes. Refused when it no longer applies cleanly.
 */
export async function mergeSpeculation(id: string): Promise<Speculation> {
  const sp = speculationLog.get(id);
  if (!sp) throw new HttpError(404, 'No such speculative run');
  if (sp.status !== 'ready') throw new HttpError(409, `This run is ${sp.status}, not waiting for you`);
  const chat = chats.get(sp.chatId);
  const target = projects.get(sp.target);
  if (!chat || !target) throw new HttpError(410, 'The chat or the folder this fix was made for is gone');
  const patch = await patchOf(sp, true);
  const file = path.join(DATA.speculative, `${sp.id}.patch`);
  fs.mkdirSync(DATA.speculative, { recursive: true });
  fs.writeFileSync(file, patch);
  try {
    await withChatLocked(chat.id, 'merging a speculative fix', async () => {
      if (projectRunning(target.id)) throw new HttpError(409, 'A bot is working in that folder; merge once it is done');
      const top = (await gitIn(target.path, ['rev-parse', '--show-toplevel'])).trim();
      try {
        await gitIn(top, ['apply', '--check', '--whitespace=nowarn', file]);
      } catch (e) {
        throw new HttpError(409, `The fix no longer applies cleanly, since the files changed after it was made: ${gitError(e)}`);
      }
      await gitIn(top, ['apply', '--whitespace=nowarn', file]);
      if (target.workspace) await autoCommit(target.workspace.worktree, `Speculative fix: ${sp.summary}`.slice(0, 72));
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
  const where = target.workspace ? `branch ${target.workspace.branch}` : 'the project folder (not committed)';
  // Bots read this one: their files changed.
  systemMessage(chat, `Merged a speculative fix (${sp.id}) into ${where}. Changed: ${(sp.files || []).map((f) => f.path).join(', ')}. It was made for: ${sp.summary}`);
  record(sp, { status: 'merged', decidedAt: Date.now() });
  details.delete(sp.id);
  await dispose(sp);
  return sp;
}

// ---------------------------------------------------------------- lifetime

/** Hourly: ready fixes nobody merged expire, and runs whose Worker or chat is gone are let go. */
async function sweepSpeculations(now = Date.now()) {
  speculationLog.prune(now);
  for (const sp of speculationLog.all()) {
    if (sp.status === 'ready' && now - sp.updatedAt > READY_MS) await discard(sp, 'Not merged within a day');
    else if ((sp.status === 'ready' || SPECULATION_IN_FLIGHT.has(sp.status)) && (!workers.get(sp.workerId) || !chats.get(sp.chatId))) await discard(sp, 'Its chat or Worker is gone');
  }
}

/**
 * On start, before workspaces are reconciled: runs a restart cut off are discarded (worktree and
 * branch removed); ready fixes stay, with their Worker and workspace.
 */
export async function recoverSpeculations() {
  for (const sp of speculationLog.all()) {
    if (!SPECULATION_IN_FLIGHT.has(sp.status)) continue;
    // A check command Crew was running lives in its own process group and outlives a crash: stop it
    // before its worktree is removed, as for a background job (ADR 105 × 008, ADR 011).
    const reaped = sp.checking ? reapOrphan({ id: sp.id, pid: sp.checking.pid, startedAt: sp.checking.startedAt }) : false;
    if (reaped && sp.checking) await groupGone(sp.checking.pid);
    await discard(sp, reaped ? 'Crew restarted; its check command was still running and was stopped' : 'Crew restarted');
  }
  setInterval(() => void sweepSpeculations().catch((e) => log.warn('sweep:', e)), 3600_000).unref();
}

onTrigger(consider);
