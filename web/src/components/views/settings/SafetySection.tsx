// Settings → Safety (ADR 007): the command guard, the credential-stripped environment and the audit
// log; a box to see what the guard makes of a command; every drafted action; the audit log itself.

import { FlaskConical, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AuditEntry, GuardRule, GuardVerdict, SafetySettings } from '../../../../../shared/types';
import { api } from '../../../api';
import { listProjects, toast, useStore } from '../../../store';
import { cx, fmtRelative } from '../../../utils';
import { DRAFT_KIND, DraftCard } from '../../DraftsBar';
import { Toggle } from '../../ui';
import { Section } from './Section';

const EVENT: Record<AuditEntry['event'], { label: string; cls: string }> = {
  drafted: { label: 'Drafted', cls: '' },
  approved: { label: 'Approved', cls: 'accent' },
  discarded: { label: 'Discarded', cls: '' },
  ran: { label: 'Ran', cls: 'green' },
  failed: { label: 'Failed', cls: 'red' },
  blocked: { label: 'Blocked', cls: 'orange' },
};

const RULE: Record<GuardRule, string> = {
  credentials: 'credentials',
  external: 'acts in your name',
  network: 'network',
  config: 'changes what runs later',
  'crew-api': "Crew's own API",
  opaque: "can't tell what runs",
};

function VerdictLine({ v }: { v: GuardVerdict }) {
  if (v.kind === 'read') return <div className="guard-verdict">Read: runs without asking, at any permission level.</div>;
  if (v.kind === 'change')
    return (
      <div className="guard-verdict">
        A change: asks once (unless the permission level allows it), showing:
        <ul className="approval-effects">
          {v.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="guard-verdict">
      <span className="badge red">Refused · {RULE[v.rule] || v.rule}</span> {v.reason}
    </div>
  );
}

function AuditRow({ e }: { e: AuditEntry }) {
  const bots = useStore((s) => s.bots);
  const chats = useStore((s) => s.chats);
  const ev = EVENT[e.event];
  const who = e.actor.user ? 'You' : bots[e.actor.botId || '']?.name || e.actor.botName || 'A bot';
  const where = e.actor.chatId ? chats[e.actor.chatId]?.title : undefined;
  return (
    <div className="audit-row" data-audit={e.event}>
      <span className="muted" title={new Date(e.at).toLocaleString()}>
        {fmtRelative(e.at)}
      </span>
      <span>
        <span className={cx('badge', ev.cls)}>{ev.label}</span>
      </span>
      <div>
        <div>
          <b>{who}</b>
          {e.actor.workerId ? ' (Worker)' : ''}
          {e.actor.jobId ? ' (background job)' : ''}
          {where ? ` in "${where}"` : ''}
          {e.kind ? ` · ${DRAFT_KIND[e.kind]}` : ''}
          {e.rule ? ` · rule: ${RULE[e.rule] || e.rule}` : ''}
          {e.target ? ` · ${e.target}` : ''}
        </div>
        {e.command && <pre>{e.command}</pre>}
        {e.detail && <pre className="muted">{e.detail}</pre>}
        {e.reverse && (
          <div className="muted">
            To undo: <code>{e.reverse}</code>
          </div>
        )}
      </div>
    </div>
  );
}

export function SafetySection() {
  const safety = useStore((s) => s.settings.safety);
  const drafts = useStore((s) => s.actionDrafts);
  const audit = useStore((s) => s.audit);
  const projects = useStore((s) => s.projects);
  const [command, setCommand] = useState('git push origin main');
  const [projectId, setProjectId] = useState('');
  const [verdict, setVerdict] = useState<GuardVerdict | null>(null);
  const [loading, setLoading] = useState(false);

  const save = async (patch: Partial<SafetySettings>, done: string) => {
    try {
      const r = await api.updateSettings({ safety: patch });
      useStore.setState({ settings: r.settings });
      toast(done, 'New sessions start with it; running turns finish as they are', 'success');
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    }
  };
  const loadAudit = async () => {
    setLoading(true);
    try {
      const r = await api.audit(200);
      useStore.setState({ audit: { entries: r.entries, loaded: true } });
    } catch (e) {
      toast("Couldn't load the audit log", (e as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load once, then the socket keeps it live
  useEffect(() => {
    if (!audit.loaded) void loadAudit();
  }, []);
  const check = async () => {
    try {
      setVerdict((await api.guardCheck(command, projectId || null)).verdict);
    } catch (e) {
      toast("Couldn't check it", (e as Error).message, 'error');
    }
  };
  const list = useMemo(() => Object.values(drafts).sort((a, b) => b.at - a.at), [drafts]);
  const pending = list.filter((d) => d.status === 'pending');

  return (
    <Section icon={<ShieldAlert size={18} />} title="Safety">
      <div className="setting-row">
        <div>
          <div className="sr-title">Command guard</div>
          <div className="hint">
            Fixed rules checked before every tool call, in every permission mode (Full auto too): bots can't read credential files (~/.ssh, ~/.aws, tokens), can't push, publish or post in your name
            (they draft it, and you approve it with one click), and can't reach hosts outside the sandbox's allowed domains. Commands that only read never ask; a command that changes something asks
            once, listing what it changes.
          </div>
        </div>
        <Toggle label="Command guard" on={safety.guard} onChange={(v) => void save({ guard: v }, v ? 'Command guard on' : 'Command guard off')} />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">Keep my credentials out of bot sessions</div>
          <div className="hint">
            Tokens, keys and passwords in Crew's environment (GITHUB_TOKEN, AWS keys, NPM_TOKEN, the SSH agent…) don't reach bots. The model connection Crew is set up with still works. A project can
            pass a variable through by name in its settings.
          </div>
        </div>
        <Toggle
          label="Keep credentials out of agent sessions"
          on={safety.stripCredentials}
          onChange={(v) => void save({ stripCredentials: v }, v ? 'Credentials kept out' : 'Credentials passed through')}
        />
      </div>
      <div className="setting-row">
        <div>
          <div className="sr-title">Audit log</div>
          <div className="hint">Every drafted action, your decision, what ran (with how to undo it), and every refusal of the guard, appended to audit.jsonl in Crew's data folder.</div>
        </div>
        <Toggle label="Audit log" on={safety.audit} onChange={(v) => void save({ audit: v }, v ? 'Audit log on' : 'Audit log off')} />
      </div>

      <div className="field span-all">
        <label>
          <FlaskConical size={13} /> Try a command
        </label>
        <div className="row">
          <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void check()} />
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)} title="Whose allowed domains count">
            <option value="">No project</option>
            {listProjects(projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn sm" onClick={() => void check()}>
            Check
          </button>
        </div>
        {verdict && <VerdictLine v={verdict} />}
        {!safety.guard && <div className="hint">The guard is off, so nothing is refused; this shows what it would decide.</div>}
      </div>

      <div className="field span-all">
        <label>Drafted actions{pending.length ? ` (${pending.length} waiting)` : ''}</label>
        {list.length ? (
          <div className="drafts-list">
            {list.map((d) => (
              <DraftCard key={d.id} draft={d} />
            ))}
          </div>
        ) : (
          <div className="hint">Nothing yet. When a bot wants to push, open a pull request, comment or send a message, the draft shows up here and above that chat's composer.</div>
        )}
      </div>

      <div className="field span-all">
        <label>
          Audit log
          <button className="icon-btn sm" title="Reload" onClick={() => void loadAudit()} disabled={loading}>
            <RefreshCw size={12} />
          </button>
        </label>
        {!safety.audit && <div className="hint">Off: nothing new is recorded. Entries from before stay until they age out (180 days).</div>}
        <div className="audit-list">{audit.entries.length ? audit.entries.map((e) => <AuditRow key={e.id} e={e} />) : <div className="hint">{audit.loaded ? 'No entries.' : 'Loading…'}</div>}</div>
      </div>
    </Section>
  );
}
