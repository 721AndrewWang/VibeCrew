import { Film, Send, Trash2, Zap } from 'lucide-react';
import { useState } from 'react';
import type { RecordedStep } from '../../../../shared/types';
import { api } from '../../api';
import { addAttachment, attachmentId, previewOf, setDraft, toast, updatePreview, useStore } from '../../store';
import { cx } from '../../utils';
import { Modal } from '../ui';

function describe(s: RecordedStep) {
  switch (s.type) {
    case 'click':
      return <>Click {s.text ? <b>"{s.text}"</b> : <code>{s.selector}</code>}</>;
    case 'fill':
      return (
        <>
          Type <b>"{s.value}"</b> into {s.text ? <b>"{s.text}"</b> : <code>{s.selector}</code>}
        </>
      );
    case 'select':
      return (
        <>
          Select <b>"{s.value}"</b>
        </>
      );
    case 'check':
      return (
        <>
          {s.value === 'true' ? 'Check' : 'Uncheck'} {s.text ? <b>"{s.text}"</b> : <code>{s.selector}</code>}
        </>
      );
    case 'press':
      return (
        <>
          Press <kbd>{s.key}</kbd>
        </>
      );
    case 'submit':
      return <>Submit form</>;
    case 'navigate':
      return (
        <>
          Go to <code>{s.url}</code>
        </>
      );
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
      toast('Skill saved', `Type /${skill.name} to have a bot replay these steps`, 'success');
      finish();
    } catch (e) {
      toast('Save failed', (e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const send = () => {
    if (!chatId) return toast('Open a chat first', undefined, 'warn');
    addAttachment(chatId, { kind: 'recording', id: attachmentId(), page, steps });
    setDraft(chatId, { text: goal.trim() || 'Write a Playwright end-to-end test from the steps I recorded, and run it until it passes.' });
    toast('Attached to input', 'Check the text, then send it to the bot', 'success');
    finish();
  };

  return (
    <Modal
      title="Save recorded demo"
      icon={<Film size={18} />}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger" onClick={finish}>
            <Trash2 size={14} /> Discard
          </button>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          {mode === 'skill' ? (
            <button className="btn primary" disabled={busy || !name.trim() || !steps.length} onClick={saveSkill}>
              <Zap size={14} /> Save as skill
            </button>
          ) : (
            <button className="btn primary" disabled={!steps.length} onClick={send}>
              <Send size={14} /> Send to bot
            </button>
          )}
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        Recorded {steps.length} step{steps.length === 1 ? '' : 's'} on <code>{page}</code>. Save it as a skill (later, one /command has a bot replay and verify this flow), or send it straight to a bot
        to turn into an automated test.
      </p>
      <ol className="rec-steps">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="rec-step">{describe(s)}</span>
            <button className="icon-btn sm" title="Delete this step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ol>
      <div className="segmented" style={{ margin: '6px 0 14px' }}>
        <button className={cx(mode === 'skill' && 'on')} onClick={() => setMode('skill')}>
          <Zap size={13} /> Save as skill
        </button>
        <button className={cx(mode === 'send' && 'on')} onClick={() => setMode('send')}>
          <Send size={13} /> Send to bot
        </button>
      </div>
      {mode === 'skill' ? (
        <>
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Command name</label>
              <input className="input mono" placeholder="e.g. check-login" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
              <span className="hint">Usage: /{name || 'check-login'}</span>
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Display name</label>
              <input className="input" placeholder="e.g. Check login flow" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>What should this flow achieve?</label>
            <textarea
              className="textarea"
              rows={2}
              placeholder="e.g. Confirm a user can log in with the test account and see their profile page. Take a screenshot if any step fails."
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
          </div>
        </>
      ) : (
        <div className="field">
          <label>What should the bot do?</label>
          <textarea
            className="textarea"
            rows={2}
            placeholder="Write a Playwright end-to-end test from the steps I recorded, and run it until it passes."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>
      )}
    </Modal>
  );
}
