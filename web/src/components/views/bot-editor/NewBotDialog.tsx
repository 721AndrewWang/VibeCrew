import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Bot, BotTemplate } from '../../../../../shared/types';
import { api } from '../../../api';
import { dmOf, openChat, setView, toast, useStore } from '../../../store';
import { cx, PERMISSION_INFO } from '../../../utils';
import { Avatar, Glyph, Modal } from '../../ui';
import { modelLabel, tierMark, tierTitle } from '../BotsView';
import { BOT_NAME_RE, ColorPicker, MonoAvatarHint } from './identity';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstLine(s: string) {
  return (s.split('\n').find((l) => l.trim()) || '').trim();
}

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const templates = useStore((s) => s.templates);
  const models = useStore((s) => s.models);
  const bots = useStore((s) => s.bots);
  const [mode, setMode] = useState<'gallery' | 'blank'>('gallery');
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', emoji: '🤖', color: '#0a84ff', title: '', description: '' });

  const usage = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of Object.values(bots)) if (b.template) m[b.template] = (m[b.template] || 0) + 1;
    return m;
  }, [bots]);

  const nameOk = BOT_NAME_RE.test(form.name.trim());

  const afterCreate = async (bot: Bot) => {
    toast(`Added ${bot.name}`, bot.title, 'success');
    // The direct chat arrives over the websocket; give it a moment.
    for (let i = 0; i < 20; i++) {
      const dm = dmOf(bot.id);
      if (dm) {
        openChat(dm.id);
        onClose();
        return;
      }
      await sleep(100);
    }
    setView('bots');
    onClose();
  };

  const fromTemplate = async (t: BotTemplate) => {
    if (busy) return;
    setBusy(t.id);
    try {
      const bot = await api.createBot({ template: t.id });
      await afterCreate(bot);
    } catch (e) {
      toast('Could not add bot', (e as Error).message, 'error');
      setBusy(null);
    }
  };

  const createBlank = async () => {
    if (!nameOk || busy) return;
    setBusy('blank');
    try {
      const bot = await api.createBot({
        name: form.name.trim(),
        emoji: form.emoji.trim() || '🤖',
        color: form.color,
        title: form.title.trim(),
        description: form.description.trim(),
      });
      await afterCreate(bot);
    } catch (e) {
      toast('Could not create bot', (e as Error).message, 'error');
      setBusy(null);
    }
  };

  return (
    <Modal
      title="Add bot"
      icon={<Sparkles size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        mode === 'blank' ? (
          <>
            <button className="btn foot-left" onClick={() => setMode('gallery')}>
              <ArrowLeft size={15} /> Back to templates
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={!nameOk || !!busy} onClick={createBlank}>
              {busy ? <span className="spinner" /> : <Plus size={15} />} Create
            </button>
          </>
        ) : undefined
      }
    >
      {mode === 'gallery' ? (
        <>
          <div className="hint" style={{ marginBottom: 12 }}>
            Pick a role template and start chatting with it right away. You can change its role description, permissions and plugins any time.
          </div>
          <div className="tpl-grid">
            {templates.map((t) => {
              const perm = PERMISSION_INFO[t.permission];
              return (
                <button key={t.id} className={cx('tpl-card', busy === t.id && 'busy')} disabled={!!busy} onClick={() => fromTemplate(t)}>
                  <div className="tpl-top">
                    <Avatar bot={{ emoji: t.emoji, color: t.color, name: t.name }} size={40} />
                    <div className="tpl-id">
                      <div className="tpl-name">{t.name}</div>
                      <div className="tpl-title">{t.title}</div>
                    </div>
                    {busy === t.id && <span className="spinner" />}
                  </div>
                  <div className="tpl-desc">{firstLine(t.description)}</div>
                  <div className="tpl-foot">
                    <span className="badge" title={perm.desc}>
                      <Glyph emoji={perm.icon} size={11} /> {perm.label}
                    </span>
                    <span className="badge" title={tierTitle(models, t.model || '')}>
                      {modelLabel(models, t.model || '')}
                      {tierMark(models, t.model || '')}
                    </span>
                    {t.editScope?.length ? <span className="badge">Only edits {t.editScope[0]}…</span> : null}
                    {usage[t.id] ? <span className="badge green">{usage[t.id]} on team</span> : null}
                  </div>
                </button>
              );
            })}
            <button className="tpl-card blank" disabled={!!busy} onClick={() => setMode('blank')}>
              <div className="tpl-top">
                <span className="tpl-emoji blank">
                  <Plus size={22} />
                </span>
                <div className="tpl-id">
                  <div className="tpl-name">Blank bot</div>
                  <div className="tpl-title">Define a role from scratch</div>
                </div>
              </div>
              <div className="tpl-desc">Write your own name, avatar and role description to build a custom teammate.</div>
            </button>
          </div>
        </>
      ) : (
        <div className="blank-form">
          <div className="identity-row">
            <Avatar bot={{ emoji: form.emoji || '🤖', color: form.color, name: form.name }} size={56} />
            <div className="field emoji-field">
              <label>Avatar</label>
              <input className="input emoji-input" value={form.emoji} maxLength={8} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
            </div>
            <div className="field grow">
              <label>Name</label>
              <input
                className="input"
                autoFocus
                value={form.name}
                placeholder="e.g. Nova"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && void createBlank()}
              />
              <div className={cx('hint', form.name && !nameOk && 'error-text')}>Used for @mentions, no spaces (letters, digits, _ or -, up to 24 characters)</div>
            </div>
          </div>
          <div className="field">
            <label>Color</label>
            <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
            <MonoAvatarHint />
          </div>
          <div className="field">
            <label>Title</label>
            <input className="input" value={form.title} placeholder="e.g. Motion engineer · transitions and micro-interactions" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Role description (becomes its system prompt)</label>
            <textarea
              className="textarea"
              rows={7}
              value={form.description}
              placeholder={'You are ..., responsible for ...\nHow you work:\n- First ...\n- When done ...'}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
