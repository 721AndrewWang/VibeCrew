// The lifecycle skill families (ADR 007), shared by the server (gates, prompts) and the UI.

import type { SkillFamily } from './types';

export interface FamilyInfo {
  id: SkillFamily;
  title: string;
  description: string;
  /** Workers on this family cannot edit files. */
  readOnly: boolean;
}

export const SKILL_FAMILIES: FamilyInfo[] = [
  { id: 'triage', title: 'Triage', description: 'Classify a report, find duplicates, ask for missing details', readOnly: true },
  { id: 'reproduce', title: 'Reproduce', description: 'Turn a report into a failing test', readOnly: false },
  { id: 'draft-fix', title: 'Draft fix', description: 'The smallest change that makes the failing test pass', readOnly: false },
  { id: 'review', title: 'Review', description: 'Structured self-review, and adversarial review by the Skeptic', readOnly: false },
  { id: 'release', title: 'Release', description: 'Changelog, version bump and release-notes draft', readOnly: false },
  { id: 'repo-health', title: 'Repo health', description: 'Read-only audits: dependencies, workflow security, flaky tests', readOnly: true },
];

export const FAMILY_IDS = SKILL_FAMILIES.map((f) => f.id);

export function isFamily(v: unknown): v is SkillFamily {
  return typeof v === 'string' && (FAMILY_IDS as string[]).includes(v);
}

export function familyInfo(id: SkillFamily): FamilyInfo {
  return SKILL_FAMILIES.find((f) => f.id === id) as FamilyInfo;
}
