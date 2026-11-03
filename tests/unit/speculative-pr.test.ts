// Speculative fixes on pull requests (ADR 110): the pure rules for fetching a pull request's head
// and for offering a verified fix as a push to its branch.
import { describe, expect, it } from 'vitest';
import { parsePull, parseRemotes, pullHeadRef, pushPlan, remoteFor, repoOfUrl } from '../../server/speculative/pr';
import { gateRefusal } from '../../server/speculative/rules';
import type { ProjectSpeculative } from '../../shared/types';

describe('remotes that reach a pull request’s repository', () => {
  it('reads owner/name from https, ssh, scp-like and local mirror URLs', () => {
    expect(repoOfUrl('https://github.com/acme/shop.git')).toBe('acme/shop');
    expect(repoOfUrl('https://github.com/acme/shop')).toBe('acme/shop');
    expect(repoOfUrl('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(repoOfUrl('ssh://git@ghe.example.com/acme/shop.git/')).toBe('acme/shop');
    expect(repoOfUrl('/srv/mirrors/acme/shop.git')).toBe('acme/shop');
    expect(repoOfUrl('shop')).toBeUndefined();
  });

  it('lists each remote once and picks the one for the repository, origin first, ignoring case', () => {
    const remotes = parseRemotes(
      [
        'fork\tgit@github.com:me/shop.git (fetch)',
        'fork\tgit@github.com:me/shop.git (push)',
        'upstream\thttps://github.com/Acme/Shop.git (fetch)',
        'origin\thttps://github.com/acme/shop (fetch)',
        'origin\thttps://github.com/acme/shop (push)',
      ].join('\n'),
    );
    expect(remotes.map((r) => r.name)).toEqual(['fork', 'upstream', 'origin']);
    expect(remoteFor(remotes, 'ACME/shop')).toBe('origin');
    expect(remoteFor(remotes, 'me/shop')).toBe('fork');
    expect(remoteFor(remotes, 'someone/shop')).toBeUndefined();
    expect(pullHeadRef(7)).toBe('refs/pull/7/head');
  });
});

describe('fetching a pull request’s head that is not local (the gate)', () => {
  const rules: ProjectSpeculative = { enabled: true, checkCommand: 'npm test', signals: { failingChecks: true, consoleErrors: true, bugReports: true }, maxFixLines: 120 };
  const gate = {
    rules,
    settings: { model: '', dailyBudgetUsd: 2, maxConcurrent: 2, maxMinutes: 20 },
    signal: 'failing-check' as const,
    checkCommand: 'npm test',
    subscribed: false,
    chat: true,
    bot: null,
    git: true,
    inFlight: 0,
    inFlightHere: 0,
    spentTodayUsd: 0,
  };

  it('lets the run start when a remote can fetch the head, and still skips it when none can', () => {
    expect(gateRefusal({ ...gate, head: { sha: 'abcdef1234567', present: false, fetchFrom: 'origin' } })).toBeNull();
    expect(gateRefusal({ ...gate, head: { sha: 'abcdef1234567', present: false } })).toMatch(/not in the local repository \(fetch it\)/);
  });

  it('checks the cheaper gates first: a fetchable head does not get past the budget', () => {
    expect(gateRefusal({ ...gate, head: { sha: 'abcdef1234567', present: false, fetchFrom: 'origin' }, spentTodayUsd: 5 })).toMatch(/budget/);
  });
});

describe('pushing a verified fix to the pull request’s branch', () => {
  const remotes = [
    { name: 'origin', url: 'git@github.com:acme/shop.git' },
    { name: 'fork', url: 'https://github.com/me/shop.git' },
  ];
  const pull = (o: Record<string, unknown> = {}) =>
    parsePull({
      number: 7,
      state: 'open',
      maintainer_can_modify: false,
      head: { ref: 'feature/login', repo: { full_name: 'acme/shop', permissions: { push: true } } },
      base: { ref: 'main', repo: { full_name: 'acme/shop', permissions: { push: true } } },
      ...o,
    });

  it('reads the branch, the repository it lives in and the user’s rights from GitHub’s answer', () => {
    expect(pull()).toEqual({ branch: 'feature/login', headRepo: 'acme/shop', headPush: true, basePush: true, maintainerCanModify: false, state: 'open' });
    expect(parsePull({ head: {} })).toBeNull();
    expect(parsePull('nonsense')).toBeNull();
    expect(pull({ head: { ref: 'x', repo: null } })?.headRepo).toBe('');
  });

  it('pushes a branch of the same repository through the remote that reaches it', () => {
    expect(pushPlan('acme/shop', 7, pull(), remotes)).toEqual({ remote: 'origin', branch: 'feature/login' });
  });

  it('refuses a fork the user cannot push to, or when GitHub does not say', () => {
    const fork = { ref: 'patch-1', repo: { full_name: 'someone/shop', permissions: { push: false } } };
    expect(pushPlan('acme/shop', 7, pull({ head: fork }), remotes)).toEqual({ refused: 'acme/shop#7 comes from a fork (someone/shop) you cannot push to' });
    expect(pushPlan('acme/shop', 7, pull({ head: { ...fork, repo: { full_name: 'someone/shop' } } }), remotes)).toMatchObject({ refused: expect.stringContaining('fork') });
  });

  it('pushes to a fork the user may push to, own or opened to maintainers, when a remote reaches it', () => {
    const mine = { ref: 'fix', repo: { full_name: 'me/shop', permissions: { push: true } } };
    expect(pushPlan('acme/shop', 7, pull({ head: mine }), remotes)).toEqual({ remote: 'fork', branch: 'fix' });
    const theirs = { ref: 'patch-1', repo: { full_name: 'someone/shop', permissions: { push: false } } };
    expect(pushPlan('acme/shop', 7, pull({ head: theirs, maintainer_can_modify: true }), remotes)).toEqual({
      refused: 'No remote in this repository points at someone/shop (the fork the pull request comes from)',
    });
    expect(pushPlan('acme/shop', 7, pull({ head: theirs, maintainer_can_modify: true }), [...remotes, { name: 'someone', url: 'https://github.com/someone/shop' }])).toEqual({
      remote: 'someone',
      branch: 'patch-1',
    });
  });

  it('refuses a closed pull request, a deleted source repository, no push rights, no answer and no remote', () => {
    expect(pushPlan('acme/shop', 7, pull({ state: 'closed' }), remotes)).toEqual({ refused: 'acme/shop#7 is closed' });
    expect(pushPlan('acme/shop', 7, pull({ head: { ref: 'x', repo: null } }), remotes)).toMatchObject({ refused: expect.stringContaining('no longer exists') });
    expect(pushPlan('acme/shop', 7, pull({ base: { repo: { full_name: 'acme/shop', permissions: { push: false } } } }), remotes)).toEqual({ refused: 'You cannot push to acme/shop' });
    expect(pushPlan('acme/shop', 7, null, remotes)).toMatchObject({ refused: expect.stringContaining('did not say') });
    expect(pushPlan('acme/shop', 7, pull(), [])).toEqual({ refused: 'No remote in this repository points at acme/shop' });
  });
});
