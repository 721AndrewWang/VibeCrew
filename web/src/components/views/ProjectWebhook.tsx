// A project's Router notifications (ADR 103): an outgoing Slack- or Feishu-compatible webhook. Off
// by default; turning it on is the user's approval of that target and of the kinds listed, next to
// a preview of exactly what a notification carries. The URL is never shown again once saved.

import { Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Project, ReplyKind, WebhookFormat, WebhookInfo, WebhookPatch } from '../../../../shared/types';
import { api } from '../../api';
import { toast } from '../../store';
import { fmtRelative, toggled } from '../../utils';
import { confirmDialog, Toggle } from '../ui';

const KINDS: { id: ReplyKind; label: string; hint: string }[] = [
  { id: 'question', label: 'Questions', hint: 'The Router needs an answer' },
  { id: 'acceptance', label: 'Acceptance requests', hint: 'Finished work for you to check' },
  { id: 'decision', label: 'Updates', hint: 'What the Router decided or started' },
];

const SAMPLE = 'Question · Chief in "Landing page" (PROJECT):\nShould the pricing table show yearly prices too?';

export function ProjectWebhook({ project }: { project: Project }) {
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .projectWebhook(project.id)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [project.id]);

  const run = async (fn: () => Promise<WebhookInfo>, done?: string) => {
    setBusy(true);
    try {
      setInfo(await fn());
      if (done) toast(done, undefined, 'success');
    } catch (e) {
      toast("Couldn't save the webhook", (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  const save = (body: WebhookPatch) => run(() => api.saveProjectWebhook(project.id, body));
  const toggleKind = (k: ReplyKind) => void save({ kinds: toggled(info.kinds, k) });

  return (
    <div className="field span-all webhook-block" data-testid="project-webhook">
      <label>Router notifications (webhook)</label>
      <div className="hint">
        Sends the chat's Router replies of the kinds you pick to a Slack incoming webhook or a Feishu bot. Only the reply's words go out: never Workers' reports, code, tool output or file contents.
        Off until you turn it on.
      </div>
      <div className="wh-row">
        <input
          className="input mono"
          style={{ flex: 1, minWidth: 220 }}
          value={url}
          placeholder={info.configured ? `Saved: ${info.masked} (paste a new URL to replace it)` : 'https://hooks.slack.com/services/…'}
          onChange={(e) => setUrl(e.target.value)}
        />
        <select
          className="input"
          value={info.format}
          disabled={!info.configured && !url.trim()}
          onChange={(e) => void save({ ...(url.trim() ? { url: url.trim() } : {}), format: e.target.value as WebhookFormat })}
        >
          <option value="slack">Slack</option>
          <option value="feishu">Feishu</option>
        </select>
        <button className="btn sm" disabled={busy || !url.trim()} onClick={() => void save({ url: url.trim() }).then(() => setUrl(''))}>
          Save URL
        </button>
      </div>
      {info.configured && (
        <>
          <div className="setting-row">
            <div>
              <div className="sr-title">Send Router notifications to {info.host}</div>
              <div className="hint">{info.enabled && info.approvedAt ? `On since ${fmtRelative(info.approvedAt)}. ` : ''}A new URL or format turns this off again until you approve it.</div>
            </div>
            <Toggle on={info.enabled} disabled={busy} onChange={(enabled) => void save({ enabled })} />
          </div>
          <div className="family-chips">
            {KINDS.map((k) => (
              <label key={k.id} className="check-row" title={k.hint}>
                <input type="checkbox" checked={info.kinds.includes(k.id)} disabled={busy} onChange={() => toggleKind(k.id)} /> {k.label}
              </label>
            ))}
          </div>
          <div className="hint">What a notification looks like:</div>
          <div className="wh-preview">{SAMPLE.replace('PROJECT', project.name)}</div>
          <div className="wh-row">
            <button
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { delivery } = await api.testProjectWebhook(project.id);
                  toast(delivery.ok ? 'Test sent' : "The test wasn't delivered", delivery.error, delivery.ok ? 'success' : 'error');
                  setInfo(await api.projectWebhook(project.id));
                } catch (e) {
                  toast("The test wasn't sent", (e as Error).message, 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Send size={13} /> Send test
            </button>
            <button
              className="btn sm ghost"
              disabled={busy}
              onClick={async () => {
                if (await confirmDialog({ title: 'Remove this webhook?', body: 'Router notifications stop going there.', ok: 'Remove', danger: true }))
                  void run(() => api.deleteProjectWebhook(project.id), 'Webhook removed');
              }}
            >
              <Trash2 size={13} /> Remove
            </button>
          </div>
          {info.deliveries.length > 0 && (
            <ul className="wh-deliveries muted">
              {info.deliveries.slice(0, 5).map((d) => (
                <li key={`${d.at}-${d.kind}`}>
                  {fmtRelative(d.at)} · {d.kind} · {d.ok ? 'delivered' : `failed: ${d.error || d.status}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
