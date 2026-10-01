import { Bot, Download, FileText, Paperclip, Route, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { TraceStep, TraceUsage, TurnTrace } from '../../../shared/types';
import { api } from '../api';
import { cx, fmtDuration, modelLabel } from '../utils';
import { Modal } from './ui';

const fmtK = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtAt = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** Every token the model read this call, cached or not. */
const readTokens = (u: TraceUsage) => u.input + u.cacheRead + u.cacheWrite;

/** The trajectory of one bot turn: each model call with its tokens, each tool result, what was sent. */
export function TraceDialog({ chatId, msgId, onClose }: { chatId: string; msgId: string; onClose: () => void }) {
  const [trace, setTrace] = useState<TurnTrace | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api
      .trace(chatId, msgId)
      .then(setTrace)
      .catch((e) => setError((e as Error).message));
  }, [chatId, msgId]);

  const body =
    !trace && !error ? (
      <div className="empty">
        <div className="spinner" />
      </div>
    ) : error ? (
      <div className="muted">{error}</div>
    ) : !trace?.available ? (
      <div className="muted">{(trace as { reason: string }).reason}</div>
    ) : (
      <TraceBody trace={trace} />
    );

  return (
    <Modal
      title="这一轮的轨迹"
      icon={<Route size={18} />}
      onClose={onClose}
      wide
      footer={
        trace?.available ? (
          <>
            <span className="hint">来自 Claude Code 的会话记录，Crew 不另存一份。</span>
            <span className="spacer" />
            <a className="btn sm" href={api.traceRawUrl(chatId, msgId)} download>
              <Download size={14} /> 下载原始记录（JSONL）
            </a>
          </>
        ) : undefined
      }
    >
      {body}
    </Modal>
  );
}

function TraceBody({ trace }: { trace: Extract<TurnTrace, { available: true }> }) {
  const t = trace.totals;
  const read = t.input + t.cacheRead + t.cacheWrite;
  const hit = read ? Math.round((t.cacheRead / read) * 100) : 0;
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="trace">
      <div className="trace-totals">
        <span>
          <b>{t.calls}</b> 次模型调用
        </span>
        <span>
          <b>{t.tools}</b> 次工具
        </span>
        <span>
          读 <b>{fmtK(read)}</b>（缓存命中 {hit}%）
        </span>
        <span>
          写 <b>{fmtK(t.output)}</b>
          {t.thinking ? `（思考 ${fmtK(t.thinking)}）` : ''}
        </span>
        <span>用时 {fmtDuration(t.durationMs)}</span>
      </div>
      <div className="trace-steps">
        {trace.steps.map((s, i) => (
          <TraceRow
            key={i}
            step={s}
            open={open === i}
            onToggle={() => setOpen(open === i ? null : i)}
            maxRead={Math.max(1, ...trace.steps.map((x) => (x.kind === 'model' ? readTokens(x.usage) : 0)))}
          />
        ))}
      </div>
    </div>
  );
}

function TraceRow({ step, open, onToggle, maxRead }: { step: TraceStep; open: boolean; onToggle: () => void; maxRead: number }) {
  const icon = step.kind === 'model' ? <Bot size={14} /> : step.kind === 'tool_result' ? <Terminal size={14} /> : step.kind === 'prompt' ? <FileText size={14} /> : <Paperclip size={14} />;
  let title = '';
  let detail: string | null = null;
  let bar = 0;
  if (step.kind === 'model') {
    const tools = step.blocks.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.name : ''));
    const kinds = tools.length ? `调用 ${tools.join('、')}` : step.blocks.some((b) => b.type === 'text') ? '回复' : '思考';
    title = `${modelLabel(step.model) || step.model}${step.effort ? ` · ${step.effort}` : ''}${step.sidechain ? ' · 子代理' : ''} · ${kinds}`;
    detail = step.blocks
      .map((b) => (b.type === 'thinking' ? `【思考】\n${b.text}` : b.type === 'tool_use' ? `【${b.name}】\n${b.input}` : b.text))
      .filter(Boolean)
      .join('\n\n');
    bar = readTokens(step.usage) / maxRead;
  } else if (step.kind === 'tool_result') {
    title = step.isError ? '工具出错' : '工具结果';
    detail = step.text;
  } else if (step.kind === 'prompt') {
    title = step.sidechain ? '子代理收到的任务' : 'Crew 发给它的内容';
    detail = step.text;
  } else {
    title = `Claude Code 附加：${step.type}`;
  }
  return (
    <div className={cx('trace-row', step.kind, step.kind === 'tool_result' && step.isError && 'error', open && 'open')}>
      <button className="trace-head" onClick={detail ? onToggle : undefined} disabled={!detail}>
        <span className="trace-at mono">{fmtAt(step.at)}</span>
        <span className="trace-icon">{icon}</span>
        <span className="trace-title">{title}</span>
        {step.kind === 'model' && (
          <span className="trace-tokens mono" title="读（其中缓存命中）/ 写">
            {fmtK(readTokens(step.usage))}
            {step.usage.cacheRead ? ` (${Math.round((step.usage.cacheRead / readTokens(step.usage)) * 100)}%)` : ''} / {fmtK(step.usage.output)}
          </span>
        )}
        {'waitMs' in step && step.waitMs > 0 && <span className="trace-wait mono">{fmtAt(step.waitMs)}</span>}
      </button>
      {step.kind === 'model' && <div className="trace-bar" style={{ width: `${Math.max(2, bar * 100)}%` }} />}
      {open && detail && <pre className="trace-detail">{detail}</pre>}
    </div>
  );
}
