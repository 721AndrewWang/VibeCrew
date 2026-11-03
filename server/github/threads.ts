// The Thread of one GitHub issue or pull request of one project (ADR 102).

import type { Project } from '../../shared/types';
import type { ThreadSpec } from '../triggers';
import { threadKey, threadTitle } from './events';

export const githubThread = (project: Pick<Project, 'id'>, repo: string, number: number): ThreadSpec => ({
  key: threadKey(project.id, repo, number),
  kind: 'github',
  title: threadTitle(repo, number),
  projectId: project.id,
  chatId: null,
});
