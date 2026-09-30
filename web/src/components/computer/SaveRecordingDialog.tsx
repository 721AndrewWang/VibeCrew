import { useState } from 'react';
import { Film, Send, Trash2, Zap } from 'lucide-react';
import type { RecordedStep } from '../../../../shared/types';
import { api } from '../../api';
import { addAttachment, attachmentId, previewOf, setDraft, toast, updatePreview, useStore } from '../../store';
import { cx } from '../../utils';
import { Modal } from '../ui';

function describe(s: RecordedStep) {
  switch (s.type) {
    case 'click':
      return <>点击 {s.text ? <b>「{s.text}」</b> : <code>{s.selector}</code>}</>;
    case 'fill':
      return <>在 {s.text ? <b>「{s.text}」</b> : <code>{s.selector}</code>} 输入 <b>「{s.value}」</b></>;
    case 'select':
      return <>选择 <b>「{s.value}」</b></>;
    case 'check':
      return <>{s.value === 'true' ? '勾选' : '取消勾选'} {s.text ? <b>「{s.text}」</b> : <code>{s.selector}</code>}</>;
    case 'press':
      return <>按下 <kbd>{s.key}</kbd></>;
    case 'submit':
      return <>提交表单</>;
    case 'navigate':
      return <>跳转到 <code>{s.url}</code></>;
    default:
      return <>{s.type}</>;
  }
}

export function SaveRecordingDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const pv = useStore((s) => s.preview[projectId]);
  const chatId = useStore((s) => s.activeChatId);
  const [steps, setSteps] = useState<RecordedStep[]>(() => pv?.steps || []);
  const [mode, setMode] = useState<'skill' | 'send'>('skill');
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const page = previewOf(projectId).path || '/';

  const finish = () => {
    updatePreview(projectId, { steps: [] });
    onClose();
  };

  const saveSkill = async () => {
    setBusy(true);
    try {
      const skill = await api.skillFromRecording({ name: name.trim(), title: title.trim() || name.trim(), goal: goal.trim(), page, steps });
      toast('技能已保存', `以后输入 /${skill.name} 就能让机器人复现这段操作`, 'success');
      finish();
    } catch (e) {
      toast('保存失败', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!chatId) return toast('先打开一个对话', undefined, 'warn');
    addAttachment(chatId, { kind: 'recording', id: attachmentId(), page, steps });
    setDraft(chatId, { text: goal.trim() || '根据我录制的这段操作，写一个 Playwright 端到端测试并运行通过。' });
    toast('已附加到输入框', '检查一下文字后发送给机器人', 'success');
    finish();
  };

  return (
    <Modal
      title="保存录制的演示"
      icon={<Film size={18} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger" onClick={finish}>
            <Trash2 size={14} /> 丢弃
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {mode === 'skill' ? (
            <button className="btn primary" disabled={busy || !name.trim() || !steps.length} onClick={saveSkill}>
              <Zap size={14} /> 保存为技能
            </button>
          ) : (
            <button className="btn primary" disabled={!steps.length} onClick={send}>
              <Send size={14} /> 发给机器人
            </button>
          )}
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        在 <code>{page}</code> 上录制了 {steps.length} 步操作。可以把它保存成技能（以后一句 /命令 就让机器人复现并验证这个流程），或者直接发给机器人，让它写成自动化测试。
      </p>
      <ol className="rec-steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="rec-step">{describe(s)}</span>
            <button className="icon-btn sm" title="删除这一步" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ol>
      <div className="segmented" style={{ margin: '6px 0 14px' }}>
        <button className={cx(mode === 'skill' && 'on')} onClick={() => setMode('skill')}>
          <Zap size={13} /> 保存为技能
        </button>
        <button className={cx(mode === 'send' && 'on')} onClick={() => setMode('send')}>
          <Send size={13} /> 发给机器人
        </button>
      </div>
      {mode === 'skill' ? (
        <>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1 }}>
              <label>命令名</label>
              <input className="input mono" placeholder="例如 check-login" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
              <span className="hint">用法：/{name || 'check-login'}</span>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>显示名称</label>
              <input className="input" placeholder="例如 检查登录流程" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>这个流程要达到什么目的？</label>
            <textarea className="textarea" rows={2} placeholder="例如：确认用户能用测试账号登录并看到个人主页；任何一步失败都要截图说明" value={goal} onChange={(e) => setGoal(e.target.value)} />
          </div>
        </>
      ) : (
        <div className="field">
          <label>想让机器人做什么？</label>
          <textarea className="textarea" rows={2} placeholder="根据我录制的这段操作，写一个 Playwright 端到端测试并运行通过。" value={goal} onChange={(e) => setGoal(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}
