// Where the command guard and the credential-stripped environment meet the running sessions
// (ADR 007): the guard's context for a folder, its refusals (audited), its read/change verdict
// for the approval gate, and the environment options for an agent session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GuardVerdict, Project } from '../shared/types';
import { describeAction } from './agents/permissions';
import { audit } from './audit';
import { type CleanEnvOptions, DATA, HOME_DIR } from './config';
import { type GuardContext, guardTool } from './guard';
import { configOf } from './projects';
import { ALWAYS_ALLOWED, cleanDomains } from './sandbox';
import { settings } from './store';

/** Who made a tool call, for the audit log. */
export interface Actor {
  botId?: string;
  botName?: string;
  chatId?: string;
  workerId?: string;
  /** A full-duplex bot's background sub-task (ADR 004). */
  jobId?: string;
}

/** The guard's view of a folder: the user's home, the sandbox allow-list with the project's own, and Crew's secrets. */
export function guardContext(cwd: string, project: Project | null): GuardContext {
  const s = settings.get();
  const conf = project ? configOf(project) : null;
  return {
    cwd,
    home: os.homedir(),
    allowedHosts: [...ALWAYS_ALLOWED, ...cleanDomains(s.sandbox?.allowedDomains || []), ...cleanDomains(conf?.allowedDomains || [])],
    secretFiles: [DATA.settings],
    // ADR 104: Crew's own data, its server's port, and where symbolic links lead.
    crewHome: HOME_DIR,
    worktrees: DATA.worktrees,
    crewPorts: s.port ? [s.port] : [],
    realpath,
  };
}

/** Where a path really leads: its deepest existing folder resolved, the rest appended. */
function realpath(abs: string): string | null {
  let dir = abs;
  const rest: string[] = [];
  for (let i = 0; i < 64 && dir !== path.dirname(dir); i++) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest.reverse());
    } catch {
      rest.push(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  return null;
}

/** What the guard makes of a call, or null while it is off. */
export function guardVerdict(toolName: string, input: unknown, cwd: string, project: Project | null): GuardVerdict | null {
  if (!settings.get().safety.guard) return null;
  return guardTool(toolName, input, guardContext(cwd, project));
}

/** Why the guard refuses a call (null: it does not), recorded in the audit log. */
export function guardRefusal(toolName: string, input: unknown, cwd: string, project: Project | null, actor: Actor = {}): string | null {
  const v = guardVerdict(toolName, input, cwd, project);
  if (v?.kind !== 'deny') return null;
  const i = (input || {}) as Record<string, unknown>;
  audit({
    event: 'blocked',
    rule: v.rule,
    actor,
    cwd,
    command: toolName === 'Bash' ? String(i.command || '').slice(0, 4000) : `${toolName} ${String(i.file_path || i.path || i.pattern || '')}`.trim(),
    detail: describeAction(toolName, input, cwd).title,
  });
  return v.reason;
}

/** How an agent session's environment is cleaned: the user's credentials stripped, unless a project passes one through. */
export function agentEnvOptions(project: Project | null): CleanEnvOptions {
  const conf = project ? configOf(project) : null;
  return { stripCredentials: settings.get().safety.stripCredentials, passEnv: conf?.passEnv || [] };
}
