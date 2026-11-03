// What a drafted action runs (ADR 007) must be what its card shows (ADR 104). An agent may have
// pointed the remote somewhere else, or planted a hook or a git setting that runs a program with
// the user's credentials when the user clicks. So: the push URL is recorded when the draft is made
// and checked again before it runs; a repository whose own config runs programs or redirects
// remotes is not run; and drafts run with git hooks turned off.

/** Repository settings that run a program or change where git connects, for a push or a gh call. */
const RISKY_KEY =
  /^(core\.(sshcommand|askpass|gitproxy|fsmonitor|hookspath)|credential\..*|url\..*\.(insteadof|pushinsteadof)|include\..*|includeif\..*|remote\..*\.(receivepack|uploadpack|proxy)|http\..*proxy|protocol\..*\.allow)$/i;

/** The risky keys in `git config --local --list` / `--worktree --list` output (key=value lines). */
export function riskyConfigKeys(listing: string): string[] {
  const keys: string[] = [];
  for (const line of listing.split('\n')) {
    const at = line.indexOf('=');
    const key = (at < 0 ? line : line.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? '' : line.slice(at + 1).trim();
    if (!key || !RISKY_KEY.test(key)) continue;
    // Git's built-in file monitor and an emptied helper list run nothing.
    if ((key === 'core.fsmonitor' && /^(true|false)$/i.test(value)) || (key === 'credential.helper' && !value)) continue;
    keys.push(key);
  }
  return [...new Set(keys)];
}

/** Why a draft must not run, from what is there now; null when it may. */
export function draftRefusal(d: { kind: string; remoteUrl?: string }, now: { pushUrl?: string | null; riskyKeys: string[] }): string | null {
  if (now.riskyKeys.length)
    return `Crew did not run it: this repository's own git config sets ${now.riskyKeys.join(', ')}, which can run a program or redirect where git connects, with your credentials. Check .git/config, then run it yourself if it is right.`;
  if (d.kind === 'git-push' && d.remoteUrl !== undefined && (now.pushUrl ?? '') !== d.remoteUrl)
    return `Crew did not run it: the remote now points to ${now.pushUrl || '(nothing)'}, not ${d.remoteUrl || '(nothing)'} as when it was drafted. Check the remote (git remote -v), then draft it again or push yourself.`;
  return null;
}

/** Environment for a draft's git: hooks off, appended to any command-line config already there. */
export function hookFreeEnv(env: Record<string, string>): Record<string, string> {
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: '/dev/null' };
}
