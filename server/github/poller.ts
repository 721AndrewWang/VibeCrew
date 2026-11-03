// The GitHub Trigger source (ADR 102): polls each opted-in project's repositories with `gh api`
// and publishes every new issue, comment, review comment and completed check run as a Trigger on
// the Thread of its issue or pull request. Everything it reads is untrusted data; it never writes
// to GitHub (drafts do that, on the user's click).
//
// Behind settings.superAgent.enabled and Project.github.enabled: with no project polling there is
// no timer, no gh process and no github/ folder.

import path from 'node:path';
import type { GithubChannel, GithubStatus, Project, Trigger } from '../../shared/types';
import { HOME_DIR } from '../config';
import { routerMode } from '../layers';
import { logger } from '../log';
import { HttpError } from '../projects';
import { Collection, chats, drafts, projects, settings, triggerLog } from '../store';
import { publishTrigger } from '../triggers';
import { activeChannel } from './config';
import { freshEvents, type GithubCursor, OVERLAP_MS } from './cursor';
import { fingerprintParts, type GhEvent, parseCheckRuns, parseIssueComments, parseIssues, parsePulls, parseReviewComments, payloadText, summaryOf } from './events';
import { screenGithub } from './filter';
import { ghApi } from './gh';
import { githubThread } from './threads';

const log = logger('github');

/** How often the timer looks for a project whose interval has passed. */
const TICK_MS = 30_000;
/** Open pull requests whose checks are read per poll. */
const PULLS_PER_POLL = 10;

const cursors = new Collection<GithubCursor>(path.join(HOME_DIR, 'github', 'cursors.json'), { mkdir: true });

interface Live {
  lastPollAt?: number;
  lastError?: string;
  lastPublished?: number;
  published: number;
  running?: Promise<GithubStatus>;
}

const live = new Map<string, Live>();
const liveOf = (id: string) => {
  const l = live.get(id) ?? { published: 0 };
  live.set(id, l);
  return l;
};

let timer: NodeJS.Timeout | null = null;

const pollingProjects = (): { project: Project; conf: GithubChannel }[] => {
  const sa = settings.get().superAgent;
  return projects.all().flatMap((p) => {
    const conf = activeChannel(p, sa);
    return conf ? [{ project: p, conf }] : [];
  });
};

/** What one repository has had lately, as events (all of them; freshEvents picks the news). */
async function readRepo(repo: string, conf: GithubChannel, since: number | undefined, cwd: string): Promise<GhEvent[]> {
  const iso = new Date((since ?? Date.now()) - OVERLAP_MS).toISOString();
  const out: GhEvent[] = [];
  if (conf.events.issues) out.push(...parseIssues(await ghApi(`repos/${repo}/issues?state=open&sort=created&direction=desc&per_page=30`, cwd), repo));
  if (conf.events.comments) out.push(...parseIssueComments(await ghApi(`repos/${repo}/issues/comments?sort=created&direction=desc&per_page=50&since=${iso}`, cwd), repo));
  if (conf.events.reviewComments) out.push(...parseReviewComments(await ghApi(`repos/${repo}/pulls/comments?sort=created&direction=desc&per_page=50&since=${iso}`, cwd), repo));
  if (conf.events.checks) {
    const pulls = parsePulls(await ghApi(`repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${PULLS_PER_POLL}`, cwd)).slice(0, PULLS_PER_POLL);
    for (const pr of pulls) out.push(...parseCheckRuns(await ghApi(`repos/${repo}/commits/${pr.head}/check-runs?filter=latest&per_page=50`, cwd), repo, pr));
  }
  return out;
}

/** The chat to tell about the project's GitHub events: its latest two-layer chat, else its latest chat. */
function chatFor(project: Project): string | null {
  const mine = chats
    .all()
    .filter((c) => c.projectId === project.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return (mine.find((c) => routerMode(c)) ?? mine[0])?.id ?? null;
}

/** URLs approved drafts printed: what Crew posted for the user, so the next poll does not report it back. */
function ownUrls(): Set<string> {
  return new Set(drafts.all().flatMap((d) => (d.status === 'done' && d.result?.url ? [d.result.url] : [])));
}

/** Keys of this repository's events already in the Trigger log. */
function publishedKeys(projectId: string, repo: string): Set<string> {
  const keys = new Set<string>();
  for (const t of triggerLog.recent(2000, (x) => x.source === 'github' && x.projectId === projectId && x.github?.repo === repo)) if (t.github) keys.add(t.github.key);
  return keys;
}

function publishEvent(project: Project, conf: GithubChannel, e: GhEvent, own: Set<string>, chatId: string | null): Trigger | null {
  const screen = screenGithub(e, conf, { ownUrls: own });
  return publishTrigger({
    source: 'github',
    summary: summaryOf(e),
    thread: githubThread(project, e.repo, e.number),
    ref: { kind: 'payload' },
    payload: { text: payloadText(e) },
    projectId: project.id,
    chatId,
    subjects: fingerprintParts(e),
    facts: screen ? { screen } : {},
    github: { kind: e.kind, key: e.key, repo: e.repo, number: e.number, pr: e.pr, ...(e.check ? { check: { name: e.check.name, conclusion: e.check.conclusion, head: e.check.head } } : {}) },
  });
}

async function pollNow(project: Project, conf: GithubChannel): Promise<GithubStatus> {
  const l = liveOf(project.id);
  const startedAt = Date.now();
  l.lastPollAt = startedAt;
  const errors: string[] = [];
  let published = 0;
  for (const repo of conf.repos) {
    const id = `${project.id}|${repo}`;
    const cursor = cursors.get(id);
    try {
      const events = cursor ? await readRepo(repo, conf, cursor.since, project.path) : [];
      const r = freshEvents(events, cursor, id, startedAt);
      // The settings may have changed while gh ran: publish only while this project still polls.
      const still = activeChannel(projects.get(project.id), settings.get().superAgent);
      if (!still) break;
      const own = ownUrls();
      const chatId = chatFor(project);
      // The cursor is saved a moment after the Triggers: a poll a crash cut off in between reads the same
      // events again, and those already published are not published twice (ADR 011).
      const done = publishedKeys(project.id, repo);
      for (const e of r.fresh) if (!done.has(e.key) && publishEvent(project, still, e, own, chatId)) published++;
      cursors.set(r.cursor);
      cursors.flush();
    } catch (e) {
      errors.push(`${repo}: ${(e as Error).message}`);
    }
  }
  l.lastError = errors.length ? errors.join('; ').slice(0, 1000) : undefined;
  if (errors.length) log.warn(`polling ${project.name}: ${l.lastError}`);
  l.lastPublished = published;
  l.published += published;
  return statusOf(project);
}

/** Polls one project now (or joins the poll already running). */
export async function pollGithub(projectId: string): Promise<GithubStatus> {
  const project = projects.get(projectId);
  if (!project) throw new HttpError(404, 'No such project');
  const conf = activeChannel(project, settings.get().superAgent);
  if (!conf) throw new HttpError(409, settings.get().superAgent.enabled ? "This project's GitHub channel is off or has no repository" : 'The Super-agent is off (Settings → Super-agent)');
  const l = liveOf(project.id);
  if (!l.running) l.running = pollNow(project, conf).finally(() => (l.running = undefined));
  return l.running;
}

function statusOf(project: Project): GithubStatus {
  const conf = activeChannel(project, settings.get().superAgent);
  const l = liveOf(project.id);
  return {
    projectId: project.id,
    active: !!conf,
    repos: conf?.repos ?? project.github?.repos ?? [],
    lastPollAt: l.lastPollAt,
    nextPollAt: conf ? (l.lastPollAt ? l.lastPollAt + conf.everyMinutes * 60_000 : Date.now()) : undefined,
    lastError: l.lastError,
    lastPublished: l.lastPublished,
    published: l.published,
  };
}

/** Every project that has GitHub settings, polling or not. */
export function githubStatuses(): GithubStatus[] {
  return projects
    .all()
    .filter((p) => !p.workspace && p.github)
    .map(statusOf);
}

function tick(now = Date.now()) {
  for (const { project, conf } of pollingProjects()) {
    const l = liveOf(project.id);
    if (l.running || (l.lastPollAt && now - l.lastPollAt < conf.everyMinutes * 60_000)) continue;
    void pollGithub(project.id).catch((e) => log.warn(`polling ${project.name}:`, e));
  }
}

/** Settings or a project changed: the timer runs only while some project polls. */
export function syncGithub() {
  const any = pollingProjects().length > 0;
  if (any && !timer) {
    timer = setInterval(() => tick(), TICK_MS);
    timer.unref();
    // The first poll of each repository only sets its cursor; do it now rather than in 30 s.
    setTimeout(() => tick(), 1000).unref();
    log.info('polling GitHub');
  } else if (!any && timer) {
    clearInterval(timer);
    timer = null;
    log.info('stopped polling GitHub');
  }
}

export function startGithub() {
  syncGithub();
}

export function closeGithub() {
  if (timer) clearInterval(timer);
  timer = null;
}
