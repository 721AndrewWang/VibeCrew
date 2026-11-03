// A project's GitHub channel (ADR 102): which repositories Crew polls for issues, comments, review
// comments and check results, and whose events count. Saved with the rest of the project's settings.

import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GithubChannel, GithubStatus } from '../../../../shared/types';
import { api } from '../../api';
import { toast, useStore } from '../../store';
import { PART } from '../../superagent';
import { fmtRelative } from '../../utils';
import { Field, OffNotice } from '../SuperAgentUi';
import { Toggle } from '../ui';

const EVENT_LABELS: [keyof GithubChannel['events'], string][] = [
  ['issues', 'New issues'],
  ['comments', 'Comments'],
  ['reviewComments', 'Review comments'],
  ['checks', 'Check results'],
];

const lines = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim().replace(/^@/, ''))
    .filter(Boolean);

export function GithubChannelSection({ projectId, value, onChange }: { projectId: string; value: GithubChannel; onChange: (v: GithubChannel) => void }) {
  const settings = useStore((s) => s.settings);
  const superAgent = settings.superAgent.enabled;
  const [repos, setRepos] = useState(value.repos.join('\n'));
  const [authors, setAuthors] = useState(value.authors.join('\n'));
  const [status, setStatus] = useState<GithubStatus | undefined>();
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    api
      .githubStatus()
      .then((r) => setStatus(r.projects.find((p) => p.projectId === projectId)))
      .catch(() => {});
  }, [projectId]);

  const pollNow = async () => {
    setPolling(true);
    try {
      const { poll } = await api.pollGithub(projectId);
      setStatus(poll);
      toast(poll.lastError ? 'GitHub poll failed' : 'Polled GitHub', poll.lastError || `${poll.lastPublished ?? 0} new event(s)`, poll.lastError ? 'error' : 'success');
    } catch (e) {
      toast("Couldn't poll GitHub", (e as Error).message, 'error');
    } finally {
      setPolling(false);
    }
  };

  return (
    <div className="field span-all" data-testid="github-channel">
      <div className="setting-row">
        <div>
          <div className="sr-title">{PART.github.name}</div>
          <div className="hint">
            {PART.github.does} New issues, comments, review comments and check results become Triggers; their text is treated as data, never as instructions. Costs: {PART.github.cost(settings)}
          </div>
        </div>
        <Toggle label={PART.github.name} on={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
      </div>
      {value.enabled && !superAgent && <OffNotice part="triggers">The GitHub channel polls only while Triggers are on.</OffNotice>}
      {value.enabled && (
        <div className="form-grid">
          <Field label="Repositories (owner/name, one per line)">
            <textarea
              className="input mono"
              rows={2}
              value={repos}
              placeholder="acme/shop"
              onChange={(e) => {
                setRepos(e.target.value);
                onChange({ ...value, repos: lines(e.target.value) });
              }}
            />
          </Field>
          <Field label="Only these authors (logins, one per line)">
            <textarea
              className="input mono"
              rows={2}
              value={authors}
              placeholder="Empty: anyone except bots"
              onChange={(e) => {
                setAuthors(e.target.value);
                onChange({ ...value, authors: lines(e.target.value) });
              }}
            />
          </Field>
          <Field label="Poll every (minutes)" hint="Each poll is a few read-only gh calls per repository.">
            <input
              className="input num-input"
              type="number"
              min={1}
              max={1440}
              value={value.everyMinutes}
              onChange={(e) => onChange({ ...value, everyMinutes: Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 1))) })}
            />
          </Field>
          <div className="field">
            <span className="field-label">Events</span>
            <div className="family-chips">
              {EVENT_LABELS.map(([k, label]) => (
                <label key={k} className="check-row">
                  <input type="checkbox" checked={value.events[k]} onChange={() => onChange({ ...value, events: { ...value.events, [k]: !value.events[k] } })} /> {label}
                </label>
              ))}
            </div>
          </div>
          <div className="field span-all">
            <label className="check-row">
              <input type="checkbox" checked={value.candidates} onChange={() => onChange({ ...value, candidates: !value.candidates })} /> Let the cheap model decide whether to tell you about events no
              Worker is subscribed to
            </label>
            <div className="hint">Off: only Workers working on an issue or pull request hear about it.</div>
          </div>
          <div className="field span-all">
            <div className="row">
              <span className="hint" role="status">
                {status?.lastPollAt ? `Last polled ${fmtRelative(status.lastPollAt)}` : 'Not polled yet'}
                {status?.lastError ? ` · ${status.lastError}` : ''}
              </span>
              <span className="spacer" />
              <button className="btn sm" disabled={polling || !status?.active} onClick={pollNow} title={status?.active ? 'Poll now' : 'Save the settings first'}>
                <RefreshCw size={14} aria-hidden /> Poll now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
