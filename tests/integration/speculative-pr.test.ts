// Speculative fixes on pull requests (ADR 110), end to end in demo mode with a fake `gh` and a
// local bare repository standing in for GitHub (at <tmp>/acme/shop.git, so the project's `origin`
// reaches acme/shop): a failing check whose head is not local is fetched read-only from the pull
// request's ref instead of being skipped; a verified fix is offered as a draft push to the pull
// request's branch, which pushes nothing until it is approved; a fork the user cannot push to gets no
// push; and discarding or merging the fix takes its pending push with it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeGh, fakeGh } from '../helpers/fakeGh';
import { type CrewServer, startServer, tempDir, waitFor } from '../helpers/server';

const REPO = 'acme/shop';
const CHECK = 'sh check.sh';

describe('speculative fixes on pull requests (demo mode, fake gh, a local stand-in for GitHub)', () => {
  const dir = tempDir('crew-spec-pr');
  const remotes = tempDir('crew-spec-pr-remotes');
  const bare = path.join(remotes, 'acme', 'shop.git');
  const scratch = tempDir('crew-spec-pr-clone');
  let gh: FakeGh;
  let crew: CrewServer;
  let group: any;
  let project: any;
  let checkId = 7000;

  const gitAt = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, ...crew.env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const git = (...args: string[]) => gitAt(project.path, ...args);
  const remoteHead = (branch: string) => gitAt(bare, 'rev-parse', `refs/heads/${branch}`);
  /**
   * Someone else's work on GitHub: a commit on `branch` (and the pull request ref `refs/pull/<n>/head`)
   * that the project's own repository has never fetched. Returns its sha.
   */
  const pullRequest = (n: number, branch: string, title: string) => {
    gitAt(scratch, 'fetch', '-q', 'origin', 'main');
    gitAt(scratch, 'checkout', '-q', '-B', branch, 'origin/main');
    fs.writeFileSync(path.join(scratch, 'app.txt'), `Title: ${title}\n`);
    gitAt(scratch, 'commit', '-qam', `work on ${branch}`);
    const sha = gitAt(scratch, 'rev-parse', 'HEAD');
    gitAt(scratch, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`, `HEAD:refs/pull/${n}/head`);
    return sha;
  };
  /** GitHub's answer for the pull request: where its branch lives and whether the user may push there. */
  const pullFacts = (n: number, branch: string, headRepo: string, push: boolean) =>
    gh.respond(`repos/${REPO}/pulls/${n}`, {
      number: n,
      state: 'open',
      maintainer_can_modify: false,
      head: { ref: branch, sha: 'x', repo: { full_name: headRepo, permissions: { push } } },
      base: { ref: 'main', repo: { full_name: REPO, permissions: { push: true } } },
    });
  /** GitHub reports that the check "test" failed at `head` on pull request `n`; the next poll reads it. */
  const failCheck = (n: number, head: string) => {
    gh.respond(`repos/${REPO}/pulls`, [{ number: n, head: { sha: head } }]);
    gh.respond(`repos/${REPO}/commits/${head}/check-runs`, {
      check_runs: [
        {
          id: ++checkId,
          name: 'test',
          status: 'completed',
          conclusion: 'failure',
          head_sha: head,
          html_url: `https://github.com/${REPO}/runs/${checkId}`,
          completed_at: new Date().toISOString(),
          output: { title: '1 test failed', summary: 'check.sh exited with 1.' },
        },
      ],
    });
  };
  const poll = () => crew.api('POST', '/github/poll', { projectId: project.id });
  const runs = async (): Promise<any[]> => (await crew.api('GET', `/speculations?projectId=${project.id}`)).speculations;
  const drafts = async (): Promise<any[]> => (await crew.api('GET', `/drafts?chatId=${group.id}`)).drafts;
  const runOn = (head: string, statuses: string[], ms = 60_000) =>
    waitFor(async () => {
      await poll();
      return (await runs()).find((s) => s.github?.head === head && statuses.includes(s.status));
    }, ms);
  /** The run once its pull request drafts are settled (the push is drafted after the comment). */
  const settled = (id: string) => waitFor(async () => (await runs()).find((s) => s.id === id && s.github?.push), 20_000);
  /** The user's own refs, Crew's throwaway branches left out. */
  const userRefs = () =>
    git('for-each-ref', '--format=%(refname)')
      .split('\n')
      .filter((r) => r && !r.startsWith('refs/heads/crew/'));

  beforeAll(async () => {
    gh = fakeGh();
    crew = await startServer({ dir, env: { PATH: gh.path } });
    const b = await crew.api('GET', '/bootstrap');
    group = b.chats.find((c: any) => c.kind === 'group');
    project = b.projects.find((p: any) => p.id === group.projectId);
    fs.writeFileSync(path.join(project.path, 'app.txt'), 'Title: OK\n');
    fs.writeFileSync(path.join(project.path, 'check.sh'), 'for f in repro/*.sh; do [ -e "$f" ] || continue; sh "$f" || exit 1; done\n');
    git('add', '-A');
    git('commit', '-qm', 'the app and its checks');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', bare], { env: { ...process.env, ...crew.env } });
    git('remote', 'add', 'origin', bare);
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    gitAt(scratch, 'init', '-q');
    gitAt(scratch, 'remote', 'add', 'origin', bare);
    await crew.api('PATCH', '/settings', { superAgent: { enabled: true, router: { enabled: true, subscriptions: true } } });
    const saved = await crew.api('PATCH', `/projects/${project.id}`, {
      speculative: { enabled: true, checkCommand: CHECK },
      github: { enabled: true, repos: [REPO], everyMinutes: 60, authors: [], events: { issues: true, comments: true, reviewComments: true, checks: true }, candidates: true },
    });
    expect(saved.status).toBe(200);
    // The first poll only sets the cursor.
    await poll();
  });
  afterAll(async () => {
    await crew?.stop();
    gh?.remove();
    for (const d of [dir, remotes, scratch]) fs.rmSync(d, { recursive: true, force: true });
  });

  it('fetches a pull request’s head that is not local, read-only, instead of skipping the run', async () => {
    const head = pullRequest(7, 'feature/login', 'BUG');
    expect(() => git('cat-file', '-e', `${head}^{commit}`)).toThrow();
    const refsBefore = userRefs();
    pullFacts(7, 'feature/login', REPO, true);
    failCheck(7, head);
    const sp = await runOn(head, ['ready', 'discarded', 'skipped']);
    expect(sp).toMatchObject({ status: 'ready', base: head, github: { repo: REPO, number: 7, head, fetch: { remote: 'origin', ref: 'refs/pull/7/head' } } });
    // The commit is local now; no ref of the user's moved or appeared, and no FETCH_HEAD was written.
    git('cat-file', '-e', `${head}^{commit}`);
    expect(userRefs()).toEqual(refsBefore);
    expect(fs.existsSync(path.join(project.path, '.git', 'FETCH_HEAD'))).toBe(false);
  });

  it('offers a verified fix as a draft push to the pull request’s branch, and pushes nothing until approved', async () => {
    const sp = await settled((await runs()).find((s) => s.github?.number === 7).id);
    expect(sp.github.push).toMatchObject({ remote: 'origin', branch: 'feature/login' });
    const d = (await drafts()).find((x) => x.id === sp.github.push.draftId);
    // The card shows the exact command, the remote and the branch; it runs from the fix's worktree.
    expect(d).toMatchObject({ kind: 'git-push', status: 'pending', chatId: group.id, target: 'origin → feature/login', remoteUrl: bare });
    expect(d.command).toEqual(['git', 'push', 'origin', 'HEAD:refs/heads/feature/login']);
    expect(gitAt(d.cwd, 'rev-parse', 'HEAD')).toBe(sp.head);
    expect(remoteHead('feature/login')).toBe(sp.base);
    // Crew itself only ever read from GitHub.
    expect(gh.calls().every((c) => c[0] === 'api' && c[c.indexOf('--method') + 1] === 'GET')).toBe(true);

    // Discarding the fix discards both its drafts, and the branch is untouched.
    await crew.api('POST', `/speculations/${sp.id}/discard`);
    const after = await drafts();
    expect(after.find((x) => x.id === d.id)).toMatchObject({ status: 'discarded' });
    expect(after.find((x) => x.id === sp.draftId)).toMatchObject({ status: 'discarded' });
    expect(remoteHead('feature/login')).toBe(sp.base);
  });

  it('pushes the fix to the pull request’s branch on one click, as a fast-forward', async () => {
    const head = pullRequest(9, 'feature/cart', 'BUG in the cart');
    pullFacts(9, 'feature/cart', REPO, true);
    failCheck(9, head);
    const ready = await runOn(head, ['ready', 'discarded', 'skipped']);
    expect(ready.status).toBe('ready');
    const sp = await settled(ready.id);
    const approved = await crew.api('POST', `/drafts/${sp.github.push.draftId}/approve`);
    expect(approved.draft).toMatchObject({ status: 'done', result: { exitCode: 0 } });
    expect(remoteHead('feature/cart')).toBe(sp.head);
    expect(gitAt(bare, 'rev-parse', `${sp.head}^`)).toBe(head);
    // How to undo it, as for any push.
    expect(approved.draft.reverse).toContain(`${head}:refs/heads/feature/cart`);
  });

  it('does not offer a push for a pull request from a fork the user cannot push to', async () => {
    const head = pullRequest(8, 'patch-1', 'BUG from a fork');
    pullFacts(8, 'patch-1', 'someone/shop', false);
    failCheck(8, head);
    const ready = await runOn(head, ['ready', 'discarded', 'skipped']);
    expect(ready.status).toBe('ready');
    const sp = await settled(ready.id);
    expect(sp.github.push).toEqual({ refused: `${REPO}#8 comes from a fork (someone/shop) you cannot push to` });
    expect((await drafts()).filter((x) => x.kind === 'git-push' && x.status === 'pending')).toEqual([]);
    await crew.api('POST', `/speculations/${sp.id}/discard`);
  });

  it('withdraws the pending push when the fix is merged into the folder instead', async () => {
    // The pull request's head is the local HEAD here, so the fix applies to the project folder.
    fs.writeFileSync(path.join(project.path, 'app.txt'), 'Title: BUG at home\n');
    git('commit', '-qam', 'the bug, locally');
    const head = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', `HEAD:refs/heads/fix/ten`, 'HEAD:refs/pull/10/head');
    pullFacts(10, 'fix/ten', REPO, true);
    failCheck(10, head);
    const ready = await runOn(head, ['ready', 'discarded', 'skipped']);
    expect(ready).toMatchObject({ status: 'ready' });
    expect(ready.github.fetch).toBeUndefined();
    const sp = await settled(ready.id);
    const merged = await crew.api('POST', `/speculations/${sp.id}/merge`);
    expect(merged.status).toBe(200);
    expect((await drafts()).find((x) => x.id === sp.github.push.draftId)).toMatchObject({ status: 'discarded' });
    expect(remoteHead('fix/ten')).toBe(head);
  });
});
