// A project's GitHub channel settings (ADR 102): defaults, normalization and the checks the API and
// the poller share. Pure.

import type { GithubChannel, Project, SuperAgentSettings } from '../../shared/types';

export const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** GitHub logins: letters, digits and single hyphens; apps end in [bot]. */
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

export const MAX_REPOS = 10;
export const MAX_AUTHORS = 100;

export const DEFAULT_GITHUB: GithubChannel = {
  enabled: false,
  repos: [],
  everyMinutes: 5,
  authors: [],
  events: { issues: true, comments: true, reviewComments: true, checks: true },
  candidates: true,
};

const list = (v: unknown, re: RegExp, max: number): string[] => {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().replace(/^@/, '');
    if (!re.test(s) || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.slice(0, max);
};

/** Fills in what a stored (or partial) value lacks and drops what is not a valid repository or login. */
export function normalizeGithub(raw: unknown): GithubChannel {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<GithubChannel>;
  const ev = (r.events && typeof r.events === 'object' ? r.events : {}) as Partial<GithubChannel['events']>;
  const every = Number(r.everyMinutes);
  const flag = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    enabled: r.enabled === true,
    repos: list(r.repos, REPO_RE, MAX_REPOS),
    everyMinutes: Number.isFinite(every) ? Math.max(1, Math.min(1440, Math.round(every))) : DEFAULT_GITHUB.everyMinutes,
    authors: list(r.authors, LOGIN_RE, MAX_AUTHORS),
    events: {
      issues: flag(ev.issues, true),
      comments: flag(ev.comments, true),
      reviewComments: flag(ev.reviewComments, true),
      checks: flag(ev.checks, true),
    },
    candidates: flag(r.candidates, true),
  };
}

/** The project's channel when it polls: the channel is on, it has a repository, and so is the Super-agent. */
export function activeChannel(project: Project | undefined, sa: SuperAgentSettings): GithubChannel | null {
  if (!project || project.workspace || !sa.enabled || !project.github) return null;
  const g = normalizeGithub(project.github);
  return g.enabled && g.repos.length ? g : null;
}

/** "owner/repo#12" or "#12" (when one repository is watched), as a repository and a number, or why it names neither. */
export function parseIssueRef(ref: string, repos: string[]): { repo: string; number: number } | { error: string } {
  const m = ref.trim().match(/^(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+))?#?(\d{1,9})$/);
  if (!m) return { error: `"${ref}" is not an issue or pull request: write owner/repo#12, or #12.` };
  const n = Number(m[2]);
  if (m[1]) {
    const repo = repos.find((r) => r.toLowerCase() === m[1].toLowerCase());
    return repo ? { repo, number: n } : { error: `${m[1]} is not a repository this project watches (${repos.join(', ') || 'none'}).` };
  }
  if (repos.length === 1) return { repo: repos[0], number: n };
  return { error: `This project watches ${repos.length} repositories (${repos.join(', ')}): name one, as owner/repo#${n}.` };
}
