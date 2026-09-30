import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { ArrowUp, Camera, ImagePlus, Mic, MicOff, MousePointerClick, Slash, Square } from 'lucide-react';
import type { Bot, Chat, Skill } from '../../../shared/types';
import { api, fileToBase64 } from '../api';
import { desktop } from '../desktop';
import { addAttachment, attachmentId, previewOf, removeAttachment, sendMessage, setComputer, setDraft, toast, updatePreview, useChatProject, useStore } from '../store';
import { cx } from '../utils';
import { AttachmentChips } from './Message';
import { Avatar, Glyph } from './ui';

type Popup =
  | { type: 'mention'; query: string; start: number; index: number }
  | { type: 'skill'; query: string; index: number };

const EMPTY = { text: '', attachments: [] };

export async function uploadImages(chatId: string, files: File[]) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) {
      toast('不支持的文件', `${f.name}：只能附加 PNG / JPEG / GIF / WebP 图片`, 'warn');
      continue;
    }
    try {
      const up = await api.upload({ name: f.name || 'image.png', mime: f.type, data: await fileToBase64(f) });
      addAttachment(chatId, { kind: 'image', id: attachmentId(), name: up.name, mime: up.mime, url: up.url });
    } catch (e) {
      toast('上传失败', (e as Error).message, 'error');
    }
  }
}

function useSpeech(onText: (text: string, final: boolean) => void) {
  const [on, setOn] = useState(false);
  const rec = useRef<any>(null);
  // Electron has no speech service behind webkitSpeechRecognition, so hide voice input there.
  const SR = desktop ? null : (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  const start = () => {
    if (!SR) return;
    const r = new SR();
    r.lang = 'zh-CN';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e: any) => {
      let text = '';
      let final = true;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
        if (!e.results[i].isFinal) final = false;
      }
      onText(text, final);
    };
    r.onerror = (e: any) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') toast('语音输入不可用', e.error === 'network' ? '浏览器的语音识别服务连不上（需要能访问 Google 语音服务）' : e.error, 'warn');
      setOn(false);
    };
    r.onend = () => setOn(false);
    r.start();
    rec.current = r;
    setOn(true);
  };
  const stop = () => {
    rec.current?.stop();
    setOn(false);
  };
  return { supported: !!SR, on, start, stop };
}

export function Composer({ chat }: { chat: Chat }) {
  const draft = useStore((s) => s.drafts[chat.id]) || EMPTY;
  const bots = useStore((s) => s.bots);
  const skills = useStore((s) => s.skills);
  const statuses = useStore((s) => s.statuses);
  // Element picking and screenshots use the preview the chat works in (its workspace, if any).
  const project = useChatProject(chat);
  const auth = useStore((s) => s.auth);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [popup, setPopup] = useState<Popup | null>(null);
  const [dragging, setDragging] = useState(false);
  const [shooting, setShooting] = useState(false);
  const speechBase = useRef('');

  const members = chat.botIds.map((id) => bots[id]).filter(Boolean);
  const busy = members.some((b) => statuses[b.id]?.chatId === chat.id && ['thinking', 'tool', 'waiting', 'queued'].includes(statuses[b.id]?.state || ''));

  const speech = useSpeech((text, final) => {
    const next = speechBase.current + text;
    setDraft(chat.id, { text: next });
    if (final) speechBase.current = next;
  });

  // Autosize.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  }, [draft.text]);

  useEffect(() => {
    if (window.innerWidth > 760) ta.current?.focus();
    setPopup(null);
  }, [chat.id]);

  const mentionItems = useMemo(() => {
    if (popup?.type !== 'mention') return [] as { bot?: Bot; all?: boolean; invite?: boolean }[];
    const q = popup.query.toLowerCase();
    const inChat = members.filter((b) => b.name.toLowerCase().includes(q) || b.title.includes(popup.query));
    const others = Object.values(bots).filter((b) => !chat.botIds.includes(b.id) && b.name.toLowerCase().includes(q));
    const out: { bot?: Bot; all?: boolean; invite?: boolean }[] = inChat.map((bot) => ({ bot }));
    if (members.length > 1 && ('所有人'.includes(popup.query) || 'all'.includes(q))) out.push({ all: true });
    out.push(...others.map((bot) => ({ bot, invite: true })));
    return out.slice(0, 8);
  }, [popup, bots, chat.botIds]);

  const skillItems = useMemo(() => {
    if (popup?.type !== 'skill') return [] as Skill[];
    const q = popup.query.toLowerCase();
    return skills
      .filter((s) => s.name.includes(q) || s.title.toLowerCase().includes(q))
      .sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
      .slice(0, 10);
  }, [popup, skills]);

  const items = popup?.type === 'mention' ? mentionItems : skillItems;

  const detect = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const skill = before.match(/^\/([a-z0-9-]*)$/);
    if (skill) return setPopup({ type: 'skill', query: skill[1], index: 0 });
    const m = before.match(/(^|[\s，。,.!?！？:：])@([\p{L}\p{N}_-]*)$/u);
    if (m && chat.kind === 'group') return setPopup({ type: 'mention', query: m[2], start: caret - m[2].length - 1, index: 0 });
    setPopup(null);
  };

  const choose = (i: number) => {
    if (!popup) return;
    const el = ta.current!;
    if (popup.type === 'skill') {
      const s = skillItems[i];
      if (!s) return;
      const text = `/${s.name} `;
      setDraft(chat.id, { text: text + draft.text.replace(/^\/[a-z0-9-]*\s?/, '') });
      setPopup(null);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
      return;
    }
    const it = mentionItems[i];
    if (!it) return;
    const name = it.all ? '所有人' : it.bot!.name;
    const caret = el.selectionStart;
    const text = draft.text.slice(0, popup.start) + `@${name} ` + draft.text.slice(caret);
    setDraft(chat.id, { text });
    setPopup(null);
    const pos = popup.start + name.length + 2;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const send = () => {
    if (!draft.text.trim() && !draft.attachments.length) return;
    if (speech.on) speech.stop();
    speechBase.current = '';
    setPopup(null);
    void sendMessage(chat.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (popup && items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPopup({ ...popup, index: (popup.index + 1) % items.length });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPopup({ ...popup, index: (popup.index - 1 + items.length) % items.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(popup.index);
        return;
      }
    }
    if (e.key === 'Escape' && popup) {
      setPopup(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      void uploadImages(chat.id, files);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length) void uploadImages(chat.id, files);
  };

  const pickElement = () => {
    if (!project) return toast('先给对话绑定一个项目', '点右上角的项目按钮选择或新建项目', 'warn');
    setComputer({ open: true, tab: 'browser' });
    useStore.setState({ mobilePane: 'computer' });
    updatePreview(project.id, { picking: true });
  };

  const screenshot = async () => {
    if (!project) return toast('先给对话绑定一个项目', undefined, 'warn');
    setShooting(true);
    try {
      const pv = previewOf(project.id);
      const device = pv.device === 'fill' ? 'desktop' : pv.device;
      const up = await api.screenshot(project.id, pv.path || '/', device);
      addAttachment(chat.id, { kind: 'image', id: attachmentId(), name: up.name, mime: up.mime, url: up.url });
    } catch (e) {
      toast('截图失败', (e as Error).message, 'error');
    } finally {
      setShooting(false);
    }
  };

  const narrow = window.innerWidth < 600;
  const placeholder = narrow
    ? `发消息${chat.kind === 'group' ? '，@ 队友' : ''}，/ 技能`
    : chat.kind === 'group'
      ? `发消息给群聊，@ 指定队友，/ 使用技能${auth.ready ? '' : '（模型未连接）'}`
      : `发消息给 ${members[0]?.name || ''}，/ 使用技能${auth.ready ? '' : '（模型未连接）'}`;

  return (
    <div className={cx('composer', dragging && 'dragging')} onDragOver={(e) => (e.preventDefault(), setDragging(true))} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      {popup && items.length > 0 && (
        <div className="popup">
          {popup.type === 'skill'
            ? skillItems.map((s, i) => (
                <button key={s.name} className={cx('popup-item', i === popup.index && 'active')} onMouseDown={(e) => (e.preventDefault(), choose(i))} onMouseEnter={() => setPopup({ ...popup, index: i })}>
                  <span className="pi-icon">
                    <Glyph emoji={s.icon} />
                  </span>
                  <span className="pi-main">
                    <b>/{s.name}</b> {s.title}
                    {s.argsHint && <span className="pi-hint"> · {s.argsHint}</span>}
                  </span>
                </button>
              ))
            : mentionItems.map((it, i) => (
                <button key={it.bot?.id || 'all'} className={cx('popup-item', i === popup.index && 'active')} onMouseDown={(e) => (e.preventDefault(), choose(i))} onMouseEnter={() => setPopup({ ...popup, index: i })}>
                  {it.all ? (
                    <span className="pi-icon">
                      <Glyph emoji="👥" />
                    </span>
                  ) : <Avatar bot={it.bot} size={22} />}
                  <span className="pi-main">
                    <b>{it.all ? '所有人' : it.bot!.name}</b> <span className="pi-hint">{it.all ? '群里每个机器人都会回复' : it.bot!.title}</span>
                  </span>
                  {it.invite && <span className="badge">邀请进群</span>}
                </button>
              ))}
        </div>
      )}
      <AttachmentChips items={draft.attachments} onRemove={(id) => removeAttachment(chat.id, id)} projectId={project?.id ?? null} />
      <div className="composer-box">
        <textarea
          ref={ta}
          rows={1}
          value={draft.text}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(chat.id, { text: e.target.value });
            detect(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setPopup(null), 150)}
        />
        <div className="composer-tools">
          <button className="icon-btn" title="使用技能（/）" onClick={() => {
            setDraft(chat.id, { text: '/' });
            setPopup({ type: 'skill', query: '', index: 0 });
            ta.current?.focus();
          }}>
            <Slash size={17} />
          </button>
          <button className="icon-btn" title="附加图片（也可以直接粘贴或拖进来）" onClick={() => fileInput.current?.click()}>
            <ImagePlus size={17} />
          </button>
          <button className="icon-btn" title="在预览中圈选元素，发给机器人" onClick={pickElement}>
            <MousePointerClick size={17} />
          </button>
          <button className="icon-btn" title="截取当前预览页面" onClick={screenshot} disabled={shooting}>
            {shooting ? <span className="spinner" /> : <Camera size={17} />}
          </button>
          {speech.supported && (
            <button
              className={cx('icon-btn', speech.on && 'active rec')}
              title={speech.on ? '停止语音输入' : '语音输入'}
              onClick={() => {
                if (speech.on) speech.stop();
                else {
                  speechBase.current = draft.text ? draft.text + ' ' : '';
                  speech.start();
                }
              }}
            >
              {speech.on ? <MicOff size={17} /> : <Mic size={17} />}
            </button>
          )}
          <span className="spacer" />
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          {busy && !draft.text.trim() && !draft.attachments.length ? (
            <button className="send-btn stop" title="停止" onClick={() => void api.stop(chat.id)}>
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button className="send-btn" title="发送" disabled={!draft.text.trim() && !draft.attachments.length} onClick={send}>
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          void uploadImages(chat.id, files);
        }}
      />
    </div>
  );
}
