import { ArrowLeft, Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Bot, BotTemplate } from '../../../../../shared/types';
import { api } from '../../../api';
import { dmOf, openChat, setView, toast, useStore } from '../../../store';
import { cx, PERMISSION_INFO } from '../../../utils';
import { Avatar, Glyph, Modal } from '../../ui';
import { BOT_NAME_RE, ColorPicker, MonoAvatarHint } from './identity';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function firstLine(s: string) {
  return (s.split('\n').find((l) => l.trim()) || '').trim();
}

export function NewBotDialog({ onClose }: { onClose: () => void }) {
  const templates = useStore((s) => s.templates);
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
    toast(`已添加 ${bot.name}`, bot.title, 'success');
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
      toast('添加失败', (e as Error).message, 'error');
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
      toast('创建失败', (e as Error).message, 'error');
      setBusy(null);
    }
  };

  return (
    <Modal
      title="添加机器人"
      icon={<Sparkles size={20} className="modal-icon" />}
      onClose={onClose}
      wide
      footer={
        mode === 'blank' ? (
          <>
            <button className="btn foot-left" onClick={() => setMode('gallery')}>
              <ArrowLeft size={15} /> 返回模板
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button className="btn primary" disabled={!nameOk || !!busy} onClick={createBlank}>
              {busy ? <span className="spinner" /> : <Plus size={15} />} 创建
            </button>
          </>
        ) : undefined
      }
    >
      {mode === 'gallery' ? (
        <>
          <div className="hint" style={{ marginBottom: 12 }}>
            选一个角色模板，马上就能在单聊里和它对话；之后可以随时修改它的角色说明、权限和插件。
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
                    {usage[t.id] ? <span className="badge green">队伍里已有 {usage[t.id]} 位</span> : null}
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
                  <div className="tpl-name">空白机器人</div>
                  <div className="tpl-title">从零定义角色</div>
                </div>
              </div>
              <div className="tpl-desc">自己写名字、头像和角色说明，打造专属队友。</div>
            </button>
          </div>
        </>
      ) : (
        <div className="blank-form">
          <div className="identity-row">
            <Avatar bot={{ emoji: form.emoji || '🤖', color: form.color, name: form.name }} size={56} />
            <div className="field emoji-field">
              <label>头像</label>
              <input className="input emoji-input" value={form.emoji} maxLength={8} onChange={(e) => setForm({ ...form, emoji: e.target.value })} />
            </div>
            <div className="field grow">
              <label>名字</label>
              <input
                className="input"
                autoFocus
                value={form.name}
                placeholder="例如 Nova"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && void createBlank()}
              />
              <div className={cx('hint', form.name && !nameOk && 'error-text')}>用于 @提及，不能有空格（字母、数字、中文、_ 或 -，最多 24 个字符）</div>
            </div>
          </div>
          <div className="field">
            <label>颜色</label>
            <ColorPicker value={form.color} onChange={(color) => setForm({ ...form, color })} />
            <MonoAvatarHint />
          </div>
          <div className="field">
            <label>职位</label>
            <input className="input" value={form.title} placeholder="例如 动效工程师 · 过渡与微交互" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="field">
            <label>角色说明（会成为它的系统提示词）</label>
            <textarea
              className="textarea"
              rows={7}
              value={form.description}
              placeholder={'你是……，负责……\n工作方式：\n- 先……\n- 完成后……'}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
