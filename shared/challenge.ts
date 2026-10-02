// The fixed rules that call the adversarial reviewer by themselves, as a project starts with them.

import type { AutoChallenge } from './types';

export const DEFAULT_CHALLENGE_PATHS = [
  '**/*.css',
  '**/*.scss',
  '**/*.less',
  '**/auth/**',
  '**/*permission*',
  '**/*security*',
  '**/migrations/**',
  'package.json',
  '**/package.json',
  'Dockerfile',
  '.github/**',
];
export const DEFAULT_CHALLENGE_MIN_LINES = 150;

export function defaultAutoChallenge(): AutoChallenge {
  return { enabled: true, paths: [...DEFAULT_CHALLENGE_PATHS], minLines: DEFAULT_CHALLENGE_MIN_LINES };
}
