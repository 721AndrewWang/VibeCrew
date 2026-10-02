import { Check, ChevronRight, Lightbulb, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ImprovableField, Improvement, ImprovementEffect } from '../../../../shared/types';
import { api } from '../../api';
import { openChat, toast } from '../../store';
import { cx, fmtWhen } from '../../utils';
import { fmtUsd } from './BotsView';

const FIELD_LABEL: Record<ImprovableField, string> = {
  description: '角色说明',
  model: '模型',
  effort: '思考强度',
  permission: '权限级别',
  allowRules: '自动允许',
  askRules: '必须确认',
  editScope: '只能修改的路径',
  freshSession: '每轮新会话',
  monthlyBudgetUsd: '每月预算',
};

const STATUS_LABEL: Record<Improvement['status'], string> = { pending: '待定', accepted: '已接受', rejected: '已拒绝', reverted: '已撤回', stale: '已作废' };

const show = (v: unknown) => (v === null || v === undefined || v === '' ? '（默认）' : typeof v === 'string' ? v : JSON.stringify(v));

/** Proposed changes to the bots, backed by real turns: the user accepts or rejects each one. */
export function ImprovementsPanel() {
  const [items, setItems] = useState<Improvement[] | null>(null);
  const [effects, setEffects] = useState<Record<string, ImprovementEffect>>({});
  const [running, setRunning] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const load = useCallback(() => {
    api
      .improvements()
      .then((r) => {
        setItems(r.items);
        setEffects(r.effects);
      })
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  const run = async () => {
    setRunning(true);
    try {
      const r = await api.runImprovements();
      const cost = r.costUsd ? `（花了 ${fmtUsd(r.costUsd)}）` : '';
      if (r.added.length) toast(`有 ${r.added.length} 条新建议${cost}`, r.dropped.length ? `另有 ${r.dropped.length} 条没通过检查：${r.dropped.join('；')}` : undefined, 'success');
      else toast(`这次没有值得改的地方${cost}`, r.dropped.length ? `没通过检查的：${r.dropped.join('；')}` : '机器人最近的表现没有反复出现的问题。', 'info');
      load();
    } catch (e) {
      toast('分析失败', (e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const pending = (items || []).filter((i) => i.status === 'pending');
  const done = (items || []).filter((i) => i.status !== 'pending');
  return (
    <section className="card improve-card">
      <div className="sc-head">
        <span className="sc-icon">
          <Lightbulb size={18} />
        </span>
        <h2>改进建议</h2>
        <span className="spacer" />
        <button className="btn sm" disabled={running} onClick={run} title="读最近的轮次、费用、证伪结果和你的审批，提出最多 3 条小改动（用 Sonnet，大约 $0.05～0.15）">
          {running ? <span className="spinner tiny" /> : <Lightbulb size={13} />} 分析最近的表现
        </button>
      </div>
      <div className="hint improve-hint">每条只改一个机器人的一项设置，并附上真实发生过的轮次作为证据。由你决定接不接受；接受之后可以对比前后的表现，也可以撤回。</div>
      {pending.map((i) => (
        <ProposalCard key={i.id} item={i} onDone={load} />
      ))}
      {items && !pending.length && <div className="muted improve-empty">现在没有待定的建议。</div>}
      {done.length > 0 && (
        <>
          <button className="link-btn improve-toggle" onClick={() => setShowDone(!showDone)}>
            <ChevronRight size={12} className={cx('chev', showDone && 'open')} /> 处理过的 {done.length} 条
          </button>
          {showDone && done.map((i) => <DecidedRow key={i.id} item={i} effect={effects[i.id]} onDone={load} />)}
        </>
      )}
    </section>
  );
}

function Change({ item }: { item: Improvement }) {
  if (item.field === 'description') {
    const before = String(item.before || '').split('\n');
    const after = String(item.after || '').split('\n');
    const b = new Set(before);
    const a = new Set(after);
    return (
      <pre className="improve-diff">
        {before
          .filter((l) => !a.has(l))
          .map((l, k) => (
            <div key={`d${k}`} className="del">
              - {l}
            </div>
          ))}
        {after
          .filter((l) => !b.has(l))
          .map((l, k) => (
            <div key={`a${k}`} className="add">
              + {l}
            </div>
          ))}
      </pre>
    );
  }
  return (
    <div className="improve-change mono">
      <span className="del">{show(item.before)}</span> → <span className="add">{show(item.after)}</span>
    </div>
  );
}

function ProposalCard({ item, onDone }: { item: Improvement; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, undefined, 'success');
    } catch (e) {
      toast('操作失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="improve-item">
      <div className="improve-title">
        <b>{item.botName}</b> 的{FIELD_LABEL[item.field]}
      </div>
      <Change item={item} />
      <div className="improve-why">{item.rationale}</div>
      {item.expected && <div className="hint">期望：{item.expected}</div>}
      <div className="improve-evidence">
        {item.evidence.map((e) => (
          <button key={e.messageId} className="link-btn" onClick={() => openChat(e.chatId)} title="打开这个对话">
            {e.note || '查看这一轮'}
          </button>
        ))}
      </div>
      {rejecting ? (
        <div className="row">
          <input className="input" autoFocus placeholder="为什么不要（可选，下次分析会参考）" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn sm danger solid" disabled={busy} onClick={() => act(() => api.rejectImprovement(item.id, note), '已拒绝')}>
            拒绝
          </button>
          <button className="btn sm" onClick={() => setRejecting(false)}>
            返回
          </button>
        </div>
      ) : (
        <div className="row">
          <button className="btn sm primary" disabled={busy} onClick={() => act(() => api.acceptImprovement(item.id), `已应用到 ${item.botName}`)}>
            <Check size={13} /> 接受
          </button>
          <button className="btn sm" disabled={busy} onClick={() => setRejecting(true)}>
            <X size={13} /> 拒绝
          </button>
        </div>
      )}
    </div>
  );
}

function DecidedRow({ item, effect, onDone }: { item: Improvement; effect?: ImprovementEffect; onDone: () => void }) {
  const revert = async () => {
    try {
      await api.revertImprovement(item.id);
      toast(`已撤回 ${item.botName} 的这项改动`, undefined, 'success');
    } catch (e) {
      toast('撤回失败', (e as Error).message, 'error');
    }
    onDone();
  };
  return (
    <div className="improve-row">
      <span className={cx('badge', item.status === 'accepted' && 'accent')}>{STATUS_LABEL[item.status]}</span>
      <span>
        {item.botName} 的{FIELD_LABEL[item.field]}：{show(item.after).slice(0, 60)}
        {item.decidedAt ? ` · ${fmtWhen(item.decidedAt)}` : ''}
        {item.note ? ` · 你说：${item.note}` : ''}
      </span>
      <span className="spacer" />
      {effect && (
        <span className="muted improve-effect" title="和改动之前同样数量的轮次比较">
          {effect.after.turns
            ? `之后 ${effect.after.turns} 轮平均 ${fmtUsd(effect.after.avgCostUsd)}，之前 ${fmtUsd(effect.before.avgCostUsd)}${effect.after.refuted || effect.before.refuted ? `；被推翻 ${effect.before.refuted}→${effect.after.refuted}` : ''}`
            : '之后还没有轮次'}
        </span>
      )}
      {item.status === 'accepted' && (
        <button className="btn sm ghost" onClick={revert} title="把这项设置改回去">
          <RotateCcw size={12} /> 撤回
        </button>
      )}
    </div>
  );
}
