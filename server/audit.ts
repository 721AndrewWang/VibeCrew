// The audit log (ADR 007): every agent-authored external action, its approval, and every refusal
// of the command guard, one JSON line each in CREW_HOME/audit.jsonl, with enough detail to reverse
// it where that is possible. Opt-in (settings.safety.audit): it writes commands and output to disk.

import type { AuditEntry } from '../shared/types';
import { bus } from './bus';
import { redactDeep } from './hardening/redactor';
import { auditLog, settings, uid } from './store';

/** Appends an entry when the log is on; returns it, or null when it is off. */
export function audit(e: Omit<AuditEntry, 'id' | 'at'>): AuditEntry | null {
  if (!settings.get().safety.audit) return null;
  // Commands and outputs may carry a secret; the log never does (ADR 104).
  const entry: AuditEntry = { id: uid('au_'), at: Date.now(), ...redactDeep(e) };
  auditLog.append(entry);
  bus.emit({ t: 'audit', entry });
  return entry;
}

/** The newest entries, newest first (kept even after the log is switched off, until they age out). */
export function auditEntries(limit = 200, filter?: { chatId?: string; event?: AuditEntry['event'] }): AuditEntry[] {
  return auditLog.recent(Math.max(1, Math.min(2000, limit)), (e) => (!filter?.chatId || e.actor.chatId === filter.chatId) && (!filter?.event || e.event === filter.event));
}
