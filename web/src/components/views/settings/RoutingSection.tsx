import { Route } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RoutingReport } from '../../../../../shared/types';
import { api } from '../../../api';
import { toast, useStore } from '../../../store';
import { Toggle } from '../../ui';
import { fmtUsd } from '../BotsView';
import { Section } from './Section';

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Shadow routing: what a cheap model would have picked for group messages, against what happened. */
export function RoutingSection() {
  const settings = useStore((s) => s.settings);
  const bots = useStore((s) => s.bots);
  const [report, setReport] = useState<RoutingReport | null>(null);
  useEffect(() => {
    api
      .routing()
      .then(setReport)
      .catch(() => {});
  }, []);
  const on = settings.routing.mode === 'shadow';
  const toggle = async (v: boolean) => {
    try {
      const r = await api.updateSettings({ routing: { mode: v ? 'shadow' : 'off' } });
      useStore.setState({ settings: r.settings });
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    }
  };
  const name = (id?: string | null) => (id === 'multi' ? 'Several' : id ? bots[id]?.name || '?' : 'No result yet');
  return (
    <Section icon={<Route size={18} />} title="Group chat routing (shadow mode)">
      <div className="setting-row">
        <div>
          <div className="sr-title">Log who a cheap model would route messages to</div>
          <div className="hint">
            Group chat messages without an @ still go to the lead as usual. Meanwhile Haiku guesses "who should take it" twice, in two orders, with a confidence, which is only logged, never acted on.
            About $0.002 per message. After 100 labeled records, it suggests a confidence threshold from a lower-bound estimate: messages above it could be routed directly, skipping the lead's turn.
          </div>
        </div>
        <Toggle on={on} onChange={toggle} />
      </div>
      {report && (
        <div className="routing-report">
          <div className="routing-totals">
            <span>
              Labeled <b>{report.labeled}</b>
            </span>
            <span>Agreement {report.agreement === null ? '—' : pct(report.agreement)}</span>
            <span>Cost {fmtUsd(report.costUsd)}</span>
            {report.avgRoutingTurnUsd !== null && <span>Avg lead routing-only turn {fmtUsd(report.avgRoutingTurnUsd)}</span>}
          </div>
          <div className="routing-totals">
            <span title="How well confidence tracks correctness: the chance that a random right guess has higher confidence than a random wrong one. 0.5 is a coin flip (confidence is useless); papers treat about 0.75+ as good enough for a first gate.">
              Confidence discrimination (AUROC) <b>{report.auroc === null ? '—' : report.auroc.toFixed(2)}</b>
              {report.auroc !== null && report.auroc < 0.65 ? ' (near random, confidence unreliable)' : ''}
            </span>
            <span title="Wrong guesses among those with confidence ≥ 0.9: the ones that would go to the wrong bot if routing were live.">
              Confident but wrong <b>{report.confident.n ? `${report.confident.wrong}/${report.confident.n}` : '—'}</b>
            </span>
          </div>
          <table className="routing-bins">
            <thead>
              <tr>
                <th>Confidence</th>
                {report.bins.map((b) => (
                  <th key={b.lo}>
                    {b.lo.toFixed(2)}–{b.hi >= 1 ? '1' : b.hi.toFixed(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Correct</td>
                {report.bins.map((b) => (
                  <td key={b.lo}>{b.n ? `${b.correct}/${b.n}` : '—'}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <div className="hint">
            {report.threshold
              ? `Suggested threshold ${report.threshold.tau}: covers ${pct(report.threshold.coverage)} of messages at ${pct(report.threshold.accuracy)} accuracy (95% lower bound ${pct(report.threshold.lower)}).`
              : report.needed > 0
                ? `Needs ${report.needed} more labeled record${report.needed === 1 ? '' : 's'} to suggest a threshold.`
                : 'No threshold gets the accuracy lower bound to 90%, so direct routing is not advised yet.'}
          </div>
          {report.recent.length > 0 && (
            <div className="routing-recent">
              {report.recent.slice(0, 8).map((r) => (
                <div key={r.id} className="routing-row">
                  <span className="mono">{r.invalid ? 'Invalid' : `${name(r.choice)} ${r.confidence !== undefined ? pct(r.confidence) : ''}`}</span>
                  <span className="muted">Actual {name(r.label)}</span>
                  <span className="routing-text">{r.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
