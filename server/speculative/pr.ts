// A speculative run on a pull request (ADR 110): which local remote reaches the pull request's
// repository (to fetch its head read-only when it is not local), and whether a verified fix may be
// offered as a push back to the pull request's branch. Pure: the callers run git and gh.

/** A local remote, as `git remote -v` lists it. */
export interface Remote {
  name: string;
  url: string;
}

/** `git remote -v` output: each remote once, with its fetch URL. */
export function parseRemotes(out: string): Remote[] {
  const seen = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen].map(([name, url]) => ({ name, url }));
}

/**
 * The owner/name a remote URL points at, by its last two path segments: `https://github.com/o/r.git`,
 * `git@github.com:o/r.git`, `ssh://git@host/o/r`, or a local mirror at `/srv/git/o/r.git`.
 */
export function repoOfUrl(url: string): string | undefined {
  const m = /[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The remote that reaches `repo` (case-insensitive), `origin` first when several do. */
export function remoteFor(remotes: Remote[], repo: string): string | undefined {
  const want = repo.trim().toLowerCase();
  const matching = remotes.filter((r) => repoOfUrl(r.url)?.toLowerCase() === want);
  return (matching.find((r) => r.name === 'origin') ?? matching[0])?.name;
}

/** The ref GitHub keeps a pull request's head under, in its base repository. */
export const pullHeadRef = (n: number) => `refs/pull/${n}/head`;

/** What `gh api repos/<repo>/pulls/<n>` says about where the pull request's commits live. */
export interface PullFacts {
  /** The branch the pull request is made from. */
  branch: string;
  /** owner/name of the repository that branch lives in; '' when that repository was deleted. */
  headRepo: string;
  /** Whether the user may push to it, when GitHub says. */
  headPush?: boolean;
  basePush?: boolean;
  /** The author lets the base repository's maintainers push to their fork's branch. */
  maintainerCanModify: boolean;
  state: string;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);

export function parsePull(json: unknown): PullFacts | null {
  const p = obj(json);
  const head = obj(p?.head);
  const base = obj(p?.base);
  const branch = typeof head?.ref === 'string' ? head.ref : '';
  if (!p || !branch) return null;
  const headRepo = obj(head?.repo);
  return {
    branch,
    headRepo: typeof headRepo?.full_name === 'string' ? headRepo.full_name : '',
    headPush: bool(obj(headRepo?.permissions)?.push),
    basePush: bool(obj(obj(base?.repo)?.permissions)?.push),
    maintainerCanModify: p.maintainer_can_modify === true,
    state: typeof p.state === 'string' ? p.state : 'open',
  };
}

export type PushPlan = { remote: string; branch: string } | { refused: string };

/**
 * Where a verified fix for pull request `repo#n` would be pushed: its own branch, through a local
 * remote. Refused for a closed pull request, a fork the user cannot push to (GitHub says so, or
 * says nothing), and when no local remote reaches the repository the branch lives in.
 */
export function pushPlan(repo: string, n: number, pull: PullFacts | null, remotes: Remote[]): PushPlan {
  if (!pull) return { refused: `GitHub did not say which branch ${repo}#${n} is made from` };
  if (pull.state !== 'open') return { refused: `${repo}#${n} is ${pull.state}` };
  if (!pull.headRepo) return { refused: `The repository ${repo}#${n} is made from no longer exists` };
  const fork = pull.headRepo.toLowerCase() !== repo.toLowerCase();
  if (fork && !(pull.headPush === true || (pull.maintainerCanModify && pull.basePush === true))) return { refused: `${repo}#${n} comes from a fork (${pull.headRepo}) you cannot push to` };
  if (!fork && pull.basePush === false) return { refused: `You cannot push to ${repo}` };
  const remote = remoteFor(remotes, pull.headRepo);
  if (!remote) return { refused: `No remote in this repository points at ${pull.headRepo}${fork ? ' (the fork the pull request comes from)' : ''}` };
  return { remote, branch: pull.branch };
}
