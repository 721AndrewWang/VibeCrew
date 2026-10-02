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
      toast('保存失败', (e as Error).message, 'error');
    }
  };
  const name = (id?: string | null) => (id === 'multi' ? '多人' : id ? bots[id]?.name || '?' : '还没结果');
  return (
    <Section icon={<Route size={18} />} title="群聊路由（影子模式）">
      <div className="setting-row">
        <div>
          <div className="sr-title">记录便宜模型会把消息派给谁</div>
          <div className="hint">
            群聊里没 @ 人的消息照常交给负责人；同时让 Haiku 按两种顺序各猜一次「该谁接」并给出把握，只记录、不执行。每条大约 $0.002。攒够 100
            条有结果的记录后，会按下限估计建议一个把握门槛：超过门槛的就可以直接派，省掉负责人那一轮。
          </div>
        </div>
        <Toggle on={on} onChange={toggle} />
      </div>
      {report && (
        <div className="routing-report">
          <div className="routing-totals">
            <span>
              有结果 <b>{report.labeled}</b> 条
            </span>
            <span>一致率 {report.agreement === null ? '—' : pct(report.agreement)}</span>
            <span>花费 {fmtUsd(report.costUsd)}</span>
            {report.avgRoutingTurnUsd !== null && <span>负责人只派活的一轮平均 {fmtUsd(report.avgRoutingTurnUsd)}</span>}
          </div>
          <table className="routing-bins">
            <thead>
              <tr>
                <th>把握</th>
                {report.bins.map((b) => (
                  <th key={b.lo}>
                    {b.lo.toFixed(2)}–{b.hi >= 1 ? '1' : b.hi.toFixed(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>猜对</td>
                {report.bins.map((b) => (
                  <td key={b.lo}>{b.n ? `${b.correct}/${b.n}` : '—'}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <div className="hint">
            {report.threshold
              ? `建议门槛 ${report.threshold.tau}：覆盖 ${pct(report.threshold.coverage)} 的消息，准确率 ${pct(report.threshold.accuracy)}（95% 下限 ${pct(report.threshold.lower)}）。`
              : report.needed > 0
                ? `还要 ${report.needed} 条有结果的记录才能建议门槛。`
                : '没有哪个门槛能让准确率的下限达到 90%，暂时不建议直接派。'}
          </div>
          {report.recent.length > 0 && (
            <div className="routing-recent">
              {report.recent.slice(0, 8).map((r) => (
                <div key={r.id} className="routing-row">
                  <span className="mono">{r.invalid ? '无效' : `${name(r.choice)} ${r.confidence !== undefined ? pct(r.confidence) : ''}`}</span>
                  <span className="muted">实际 {name(r.label)}</span>
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
