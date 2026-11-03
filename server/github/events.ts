// GitHub's REST answers, as events (ADR 102). Pure: what `gh api` printed comes in, events come out.
// Anything that does not have the expected shape is skipped rather than trusted. Summaries and
// thread titles are built from facts only (kind, number, login, file); everything people wrote stays
// in the payload, which every prompt shows inside the <untrusted> wrapper.

export type GhKind = 'issue' | 'comment' | 'review-comment' | 'check';

export interface GhCheck {
  name: string;
  conclusion: string;
  head: string;
  detailsUrl?: string;
}

export interface GhEvent {
  kind: GhKind;
  repo: string;
  /** The issue or pull request it belongs to. */
  number: number;
  pr: boolean;
  /** Unique per repository: `<kind>:<GitHub id>`. */
  key: string;
  /** When it was created (a check: when it completed). */
  at: number;
  author?: string;
  /** GitHub's user type: User, Bot, Organization. */
  authorType?: string;
  url: string;
  title?: string;
  body: string;
  path?: string;
  line?: number;
  /** A review comment's id: what a reply is addressed to. */
  commentId?: number;
  inReplyTo?: number;
  check?: GhCheck;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const numberAtEnd = (url: string, part: string): number | undefined => {
  const m = url.match(new RegExp(`/${part}/(\\d+)$`));
  return m ? Number(m[1]) : undefined;
};

/** A login as it may appear in a summary: only the characters GitHub allows in one. */
export function safeLogin(login: string | undefined): string {
  return (login || 'someone').replace(/[^A-Za-z0-9\-[\]]/g, '').slice(0, 50) || 'someone';
}

const user = (v: unknown) => {
  const u = obj(v);
  return { author: str(u?.login) || undefined, authorType: str(u?.type) || undefined };
};

/** New issues (pull requests in the same list are skipped: the endpoint returns both). */
export function parseIssues(json: unknown, repo: string): GhEvent[] {
  const out: GhEvent[] = [];
  for (const raw of arr(json)) {
    const i = obj(raw);
    const id = num(i?.id);
    const n = num(i?.number);
    const at = time(i?.created_at);
    if (!i || id === undefined || n === undefined || at === undefined || i.pull_request) continue;
    out.push({ kind: 'issue', repo, number: n, pr: false, key: `issue:${id}`, at, ...user(i.user), url: str(i.html_url), title: str(i.title), body: str(i.body) });
  }
  return out;
}

/** Comments in an issue's or a pull request's conversation. */
export function parseIssueComments(json: unknown, repo: string): GhEvent[] {
  const out: GhEvent[] = [];
  for (const raw of arr(json)) {
    const c = obj(raw);
    const id = num(c?.id);
    const at = time(c?.created_at);
    const n = numberAtEnd(str(c?.issue_url), 'issues');
    if (!c || id === undefined || at === undefined || n === undefined) continue;
    const url = str(c.html_url);
    out.push({ kind: 'comment', repo, number: n, pr: url.includes('/pull/'), key: `comment:${id}`, at, ...user(c.user), url, body: str(c.body) });
  }
  return out;
}

/** Review comments on pull requests' diffs. */
export function parseReviewComments(json: unknown, repo: string): GhEvent[] {
  const out: GhEvent[] = [];
  for (const raw of arr(json)) {
    const c = obj(raw);
    const id = num(c?.id);
    const at = time(c?.created_at);
    const n = numberAtEnd(str(c?.pull_request_url), 'pulls');
    if (!c || id === undefined || at === undefined || n === undefined) continue;
    out.push({
      kind: 'review-comment',
      repo,
      number: n,
      pr: true,
      key: `review-comment:${id}`,
      at,
      ...user(c.user),
      url: str(c.html_url),
      body: str(c.body),
      path: str(c.path) || undefined,
      line: num(c.line) ?? num(c.original_line),
      commentId: id,
      inReplyTo: num(c.in_reply_to_id),
    });
  }
  return out;
}

/** Open pull requests and the commit at their head. */
export function parsePulls(json: unknown): { number: number; head: string }[] {
  const out: { number: number; head: string }[] = [];
  for (const raw of arr(json)) {
    const p = obj(raw);
    const n = num(p?.number);
    const head = str(obj(p?.head)?.sha);
    if (n !== undefined && /^[0-9a-f]{7,64}$/i.test(head)) out.push({ number: n, head });
  }
  return out;
}

/** Completed check runs on a pull request's head. */
export function parseCheckRuns(json: unknown, repo: string, pr: { number: number; head: string }): GhEvent[] {
  const out: GhEvent[] = [];
  for (const raw of arr(obj(json)?.check_runs)) {
    const c = obj(raw);
    const id = num(c?.id);
    const at = time(c?.completed_at);
    if (!c || id === undefined || at === undefined || str(c.status) !== 'completed') continue;
    const output = obj(c.output);
    const text = [str(output?.title), str(output?.summary)].filter(Boolean).join('\n');
    out.push({
      kind: 'check',
      repo,
      number: pr.number,
      pr: true,
      key: `check:${id}`,
      at,
      url: str(c.html_url) || str(c.details_url),
      body: text,
      check: { name: str(c.name) || 'check', conclusion: str(c.conclusion) || 'unknown', head: str(c.head_sha) || pr.head, detailsUrl: str(c.details_url) || undefined },
    });
  }
  return out;
}

const PASSED = new Set(['success', 'neutral', 'skipped']);

/** A check that did not fail: news for the Workers on its pull request only. */
export const checkPassed = (e: GhEvent) => e.kind === 'check' && PASSED.has(e.check?.conclusion || '');

const what = (e: GhEvent) => `${e.pr ? 'PR' : 'issue'} #${e.number} in ${e.repo}`;

/** One line of facts: no title, no text anyone wrote. */
export function summaryOf(e: GhEvent): string {
  const by = safeLogin(e.author);
  switch (e.kind) {
    case 'issue':
      return `Issue #${e.number} opened by ${by} in ${e.repo}`;
    case 'comment':
      return `Comment by ${by} on ${what(e)}`;
    case 'review-comment':
      return `Review comment by ${by} on ${what(e)}${e.path ? ` (${e.path.replace(/[^\w./-]/g, '').slice(0, 120)}${e.line ? `:${e.line}` : ''})` : ''}`;
    case 'check': {
      const c = e.check?.conclusion || 'unknown';
      const verb = c === 'success' ? 'passed' : c === 'failure' ? 'failed' : c.replace(/[^a-z_]/g, '');
      return `Check ${verb} on ${what(e)} (head ${(e.check?.head || '').slice(0, 7)})`;
    }
  }
}

/** Everything the event says, with where to find it: the payload agents read inside the untrusted wrapper. */
export function payloadText(e: GhEvent, maxChars = 6000): string {
  const head: string[] = [];
  const by = e.author ? `${safeLogin(e.author)}${e.authorType && e.authorType !== 'User' ? ` (${e.authorType})` : ''}` : undefined;
  if (e.kind === 'issue') head.push(`GitHub issue ${e.repo}#${e.number}, opened by ${by}`, `Title: ${e.title || '(none)'}`);
  if (e.kind === 'comment') head.push(`GitHub comment on ${e.pr ? 'pull request' : 'issue'} ${e.repo}#${e.number}, by ${by}`);
  if (e.kind === 'review-comment')
    head.push(
      `GitHub review comment ${e.commentId} on pull request ${e.repo}#${e.number}, by ${by}`,
      ...(e.path ? [`File: ${e.path}${e.line ? `, line ${e.line}` : ''}`] : []),
      ...(e.inReplyTo ? [`In reply to review comment ${e.inReplyTo}`] : []),
      `(A reply to it is a review-reply draft with comment ${e.commentId}.)`,
    );
  if (e.kind === 'check' && e.check)
    head.push(
      `GitHub check "${e.check.name}" on pull request ${e.repo}#${e.number}: ${e.check.conclusion}`,
      `Head commit: ${e.check.head}`,
      ...(e.check.detailsUrl ? [`Details: ${e.check.detailsUrl}`] : []),
    );
  if (e.url) head.push(`URL: ${e.url}`);
  head.push(`When: ${new Date(e.at).toISOString()}`);
  const body = e.body.trim();
  const text = body.length > maxChars ? `${body.slice(0, maxChars)}\n… (cut; the rest is at the URL)` : body;
  return `${head.join('\n')}\n\n${text || '(no text)'}`;
}

/** The thread of one issue or pull request of one project. */
export const threadKey = (projectId: string, repo: string, number: number) => `github:${projectId}:${repo}#${number}`;

/** The issue or pull request a thread key names, as "owner/repo#12". */
export function issueRefOfKey(key: string): string | undefined {
  return key.match(/^github:[^:]+:([^#\s]+#\d+)$/)?.[1];
}
export const threadTitle = (repo: string, number: number) => `GitHub ${repo}#${number}`;

/** What de-duplication compares: the kind, the author and the start of the text; a check's name, outcome and head. */
export function fingerprintParts(e: GhEvent): string[] {
  if (e.kind === 'check') return [e.kind, e.check?.name || '', e.check?.conclusion || '', e.check?.head || ''];
  return [e.kind, (e.author || '').toLowerCase(), e.body.replace(/\s+/g, ' ').trim().slice(0, 300) || e.key];
}
