// Standing rules (ADR 108): candidates whose outcome a default policy line already decides, settled
// in code instead of by the cheap model. Each rule belongs to one line of the default policies and
// holds only while the user's policies still contain that line word for word: once the user edits
// or removes it, those events go to the model again, which reads the policy as the user wrote it.
// A rule only settles what the line states plainly; anything it is unsure of stays a candidate.
// Pure.

import { POLICY_LINES } from '../../shared/defaults';
import type { TriggerFilter } from '../../shared/types';
import { isTransient } from '../watchdog/signals';

/** The lines are defined with the other defaults (shared/defaults.ts); re-exported where the tests read them. */
export { POLICY_LINES };

/** The rule name every standing decision carries, in the Trigger log and the Triggers view. */
export const STANDING_RULE = 'standing-policy';

/** What a standing rule reads: the fast path's input (source, subjects, facts). */
export interface StandingInput {
  source: string;
  subjects: string[];
  facts: { status?: string };
}

/** Dependency manifests, lockfiles and build or framework config, by file name. */
const CONFIG_FILE =
  /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-(lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|Pipfile(\.lock)?|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|[jt]sconfig[^/]*\.json|(vite|vitest|next|nuxt|svelte|astro|remix|webpack|rollup|esbuild|babel|postcss|tailwind|eslint)\.config\.[cm]?[jt]s|\.babelrc|\.npmrc|\.nvmrc|Dockerfile|docker-compose\.ya?ml)$/i;

/** Console lines from browser extensions, ads and analytics: not the app's own code. */
const THIRD_PARTY =
  /chrome-extension:\/\/|moz-extension:\/\/|safari-web-extension:\/\/|googletagmanager\.com|google-analytics\.com|doubleclick\.net|googlesyndication\.com|connect\.facebook\.net|hotjar\.com|segment\.(io|com)|clarity\.ms/i;

const act = (reason: string): TriggerFilter => ({ verdict: 'act', stage: 'fast', rule: STANDING_RULE, reason });
const drop = (reason: string): TriggerFilter => ({ verdict: 'drop', stage: 'fast', rule: STANDING_RULE, reason });

/** The decision a default policy line makes for this candidate, or null: the model decides. */
export function standingRule(t: StandingInput, policies: string): TriggerFilter | null {
  const holds = (line: string) => policies.includes(line);
  if (t.source === 'github' && holds(POLICY_LINES.github)) {
    // A check run's subjects are [kind, name, conclusion, head] (github/events.ts); checks are read on open pull requests only.
    const [kind, name, conclusion] = t.subjects;
    if (kind === 'check' && (conclusion === 'failure' || conclusion === 'timed_out'))
      return act(`${name ? `The check ${name}` : 'A check'} failed on an open pull request; your GitHub policy says to act on that`);
    return null;
  }
  if (t.source === 'turn' && t.facts.status === 'error' && holds(POLICY_LINES.turn)) {
    // Only the quiet half: whether a failure needs the user (login, budget, setup) is the model's call.
    if (isTransient(t.subjects.join('\n'))) return drop('The turn failed on a passing network or provider error that a retry fixes; your policy says to stay quiet about that');
    return null;
  }
  if (t.source === 'outside-edit' && holds(POLICY_LINES.outsideEdit)) {
    const config = t.subjects.filter((p) => CONFIG_FILE.test(p));
    if (config.length) return act(`A dependency manifest or build config changed outside the chat (${config.slice(0, 3).join(', ')}); your policy says to act on that`);
    return null;
  }
  if (t.source === 'preview-console' && holds(POLICY_LINES.console)) {
    if (t.subjects.length && t.subjects.every((s) => THIRD_PARTY.test(s))) return drop('Only errors from browser extensions, ads or analytics; your policy says to stay quiet about those');
    return null;
  }
  return null;
}
